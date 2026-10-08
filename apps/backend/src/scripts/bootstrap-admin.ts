import { readConfig } from '../config/env.js';
import { createDatabase } from '../database/prisma.js';

const config = readConfig();
const [subject] = process.argv.slice(2);
if (!subject || process.argv.length !== 3) throw new Error('Usage: npm run admin:bootstrap -- <exact-sso-subject>');
if (config.AUTH_MODE === 'ENTRA' && !subject.startsWith(`entra:${config.ENTRA_TENANT_ID}:`)) {
  throw new Error('The subject must belong to the configured Entra tenant.');
}
const db = createDatabase(config.DATABASE_URL);
try {
  const user = await db.$transaction(async tx => {
    await tx.$executeRaw`LOCK TABLE "users" IN SHARE ROW EXCLUSIVE MODE`;
    if (await tx.user.count({ where: { status: 'APPROVED', role: 'ADMIN' } })) {
      throw new Error('An approved administrator already exists. Use the user-management page.');
    }
    const existing = await tx.user.findUnique({ where: { ssoSubject: subject } });
    if (!existing || existing.status !== 'PENDING') throw new Error('The exact user must first sign in and have PENDING status.');
    return tx.user.update({ where: { id: existing.id }, data: { role: 'ADMIN', status: 'APPROVED', approvedAt: new Date(), approvedByUserId: null } });
  });
  console.info(`Initial administrator approved: ${user.id} (${user.ssoSubject}). Record the operator and identity verification in your deployment log.`);
} finally { await db.$disconnect(); }
