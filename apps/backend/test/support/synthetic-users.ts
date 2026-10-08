import type { Config } from '../../src/config/env.js';
import { isDeployed } from '../../src/config/env.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { requireTestDatabase } from './database.js';

export function requireSyntheticSeed(config: Config, testUrl: string | undefined) {
  if (isDeployed(config) || config.AUTH_MODE !== 'TEST_USER' || !['development', 'test'].includes(config.NODE_ENV)) {
    throw new Error('Synthetic seeding requires local development/test with explicit AUTH_MODE=TEST_USER.');
  }
  requireTestDatabase(testUrl);
}

export const SYNTHETIC_USERS = [
  { subject: 'local:synthetic-admin', role: 'ADMIN', status: 'APPROVED' },
  { subject: 'local:synthetic-user', role: 'USER', status: 'APPROVED' },
  { subject: 'local:synthetic-pending', role: 'USER', status: 'PENDING' },
  { subject: 'local:synthetic-rejected', role: 'USER', status: 'REJECTED' },
  { subject: 'local:synthetic-disabled', role: 'USER', status: 'DISABLED' },
] as const;

// Only callers that passed requireSyntheticSeed may connect and call this helper.
export async function seedSyntheticUsers(db: PrismaClient) {
  await db.$transaction(async tx => {
    for (const actor of SYNTHETIC_USERS) {
      const data = { email: `${actor.subject.slice(6)}@example.test`, displayName: actor.subject.slice(6),
        role: actor.role, status: actor.status, approvedAt: actor.status === 'APPROVED' ? new Date('2026-09-01T10:00:00Z') : null,
        approvedByUserId: null };
      await tx.user.upsert({ where: { ssoSubject: actor.subject }, create: { ssoSubject: actor.subject, ...data }, update: data });
    }
  });
}
