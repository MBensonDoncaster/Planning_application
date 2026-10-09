import type { PrismaClient, User as DatabaseUser } from '../../generated/prisma/client.js';
import { AppError, applyChange, requireAdmin } from './service.js';
import type { Identity, User, UserChange, UserRepository } from './types.js';
import { createAuditService, type AuditService } from '../../shared/audit.js';

function toUser(row: DatabaseUser): User {
  const { ssoSubject, ...rest } = row;
  return { ...rest, subject: ssoSubject };
}

export function createUserRepository(db: PrismaClient, audit: AuditService = createAuditService(db)): UserRepository {
  return {
    async authenticate(identity: Identity, auditContext) {
      const { subject, ...profile } = identity;
      return db.$transaction(async tx => {
        const user = toUser(await tx.user.upsert({
          where: { ssoSubject: subject },
          create: { ssoSubject: subject, ...profile, lastLoginAt: new Date() },
          update: { ...profile, lastLoginAt: new Date() },
        }));
        if (auditContext) await audit.record({
          requestId: auditContext.requestId, actor: { type: 'USER', user }, module: 'shared',
          action: 'SESSION_SYNC', outcome: 'SUCCESS', target: { type: 'user', id: user.id },
        }, tx);
        return user;
      });
    },
    async list({ page, pageSize, search, status }) {
      const where = {
        ...(status ? { status } : {}),
        ...(search ? { OR: [
          { email: { contains: search, mode: 'insensitive' as const } },
          { displayName: { contains: search, mode: 'insensitive' as const } },
        ] } : {}),
      };
      const [rows, total] = await db.$transaction([
        db.user.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }),
        db.user.count({ where }),
      ]);
      return { users: rows.map(toUser), total };
    },
    async findBySubject(subject) {
      const row = await db.user.findUnique({ where: { ssoSubject: subject } });
      return row ? toUser(row) : null;
    },
    async change(actorId: string, targetId: string, change: UserChange, auditContext) {
      return db.$transaction(async (tx) => {
        // Serialize account administration, including simultaneous demotions.
        // This lock adds no tables and also coordinates with the bootstrap tool.
        await tx.$executeRaw`LOCK TABLE "users" IN SHARE ROW EXCLUSIVE MODE`;
        const actor = await tx.user.findUnique({ where: { id: actorId } });
        if (!actor) throw new AppError(403, 'FORBIDDEN', 'Administrator access is required.');
        requireAdmin(toUser(actor));
        const target = await tx.user.findUnique({ where: { id: targetId } });
        if (!target) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
        const count = await tx.user.count({ where: { role: 'ADMIN', status: 'APPROVED' } });
        const patch = applyChange(toUser(target), change, count, actorId);
        const updated = toUser(await tx.user.update({ where: { id: targetId }, data: patch }));
        if (auditContext) await audit.record({
          requestId: auditContext.requestId, actor: { type: 'USER', user: toUser(actor) }, module: 'shared',
          action: 'USER_CHANGE', outcome: 'SUCCESS', target: { type: 'user', id: targetId },
          metadata: { change: change.action, role: updated.role, status: updated.status },
        }, tx);
        return updated;
      });
    },
    async ready() { await db.$queryRaw`SELECT 1`; },
    async close() { await db.$disconnect(); },
  };
}
