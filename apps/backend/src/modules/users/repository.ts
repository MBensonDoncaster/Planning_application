import type { PrismaClient, User as DatabaseUser } from '../../generated/prisma/client.js';
import { AppError, applyChange, requireAdmin } from './service.js';
import type { Identity, User, UserChange, UserRepository } from './types.js';

function toUser(row: DatabaseUser): User {
  const { ssoSubject, ...rest } = row;
  return { ...rest, subject: ssoSubject };
}

export function createUserRepository(db: PrismaClient): UserRepository {
  return {
    async authenticate(identity: Identity) {
      const { subject, ...profile } = identity;
      return toUser(await db.user.upsert({
        where: { ssoSubject: subject },
        create: { ssoSubject: subject, ...profile, lastLoginAt: new Date() },
        update: { ...profile, lastLoginAt: new Date() },
      }));
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
    async change(actorId: string, targetId: string, change: UserChange) {
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
        return toUser(await tx.user.update({ where: { id: targetId }, data: patch }));
      });
    },
    async ready() { await db.$queryRaw`SELECT 1`; },
    async close() { await db.$disconnect(); },
  };
}
