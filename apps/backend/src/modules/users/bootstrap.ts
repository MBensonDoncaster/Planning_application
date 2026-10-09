import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Config } from '../../config/env.js';
import { createAuditService, type AuditService } from '../../shared/audit.js';

export async function bootstrapAdministrator(db: PrismaClient, subject: string, config: Pick<Config, 'AUTH_MODE' | 'ENTRA_TENANT_ID' | 'TEST_USER_SUBJECT'>, requestId: string, audit: AuditService = createAuditService(db)) {
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  if (config.AUTH_MODE === 'ENTRA'
    ? !new RegExp(`^entra:${config.ENTRA_TENANT_ID}:${uuid}$`, 'i').test(subject)
    : subject !== config.TEST_USER_SUBJECT) {
    throw new Error('The exact subject must match the configured tenant/object identity or explicit local test identity.');
  }
  return db.$transaction(async tx => {
    await tx.$executeRaw`LOCK TABLE "users" IN SHARE ROW EXCLUSIVE MODE`;
    if (await tx.user.count({ where: { status: 'APPROVED', role: 'ADMIN' } })) {
      throw new Error('An approved administrator already exists. Use the user-management page.');
    }
    const existing = await tx.user.findUnique({ where: { ssoSubject: subject } });
    if (!existing || existing.status !== 'PENDING') throw new Error('The exact user must first sign in and have PENDING status.');
    const user = await tx.user.update({ where: { id: existing.id }, data: { role: 'ADMIN', status: 'APPROVED', approvedAt: new Date(), approvedByUserId: null } });
    await audit.record({ requestId, actor: { type: 'SYSTEM', name: 'admin-bootstrap', capabilities: [] }, module: 'shared', action: 'ADMIN_BOOTSTRAPPED', outcome: 'SUCCESS', target: { type: 'user', id: user.id }, metadata: { role: user.role, status: user.status } }, tx);
    return user;
  });
}
