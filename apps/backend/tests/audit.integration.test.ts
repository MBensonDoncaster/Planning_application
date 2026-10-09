import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { createAuditService, type AuditEventInput } from '../src/shared/audit.js';
import { createTestDatabase, requireTestDatabase, type TestDatabase } from '../test/support/database.js';

const testUrl = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_TEST_DATABASE === '1') requireTestDatabase(testUrl);
let database: TestDatabase;
let db: PrismaClient;
const event = (overrides: Partial<AuditEventInput> = {}): AuditEventInput => ({ requestId: randomUUID(), actor: null, module: 'shared', action: 'USER_CHANGE', outcome: 'SUCCESS', ...overrides });

describe.skipIf(!testUrl)('shared PostgreSQL audit service', () => {
  beforeAll(async () => { database = await createTestDatabase(testUrl); db = database.createClient(); }, 60_000);
  beforeEach(async () => { await database.pool.query('TRUNCATE audit_events, users CASCADE'); });
  afterAll(async () => { await db?.$disconnect(); await database?.cleanup(); });

  it('persists independently generated IDs, UTC timestamps and sanitised metadata', async () => {
    const requestId = randomUUID(), targetId = randomUUID();
    const before = Date.now();
    await createAuditService(db).record(event({ requestId, target: { type: 'user', id: targetId }, metadata: { change: 'approve', status: 'APPROVED', rawJson: 'private' } }));
    const row = await db.auditEvent.findFirstOrThrow();
    expect(row).toMatchObject({ requestId, actorType: 'UNKNOWN', actorUserId: null, actorIntegrationId: null, actorKeyId: null, targetId, targetType: 'user', metadata: { change: 'approve', status: 'APPROVED' } });
    expect(row.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(row.occurredAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.occurredAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('commits the mutation and its audit event together using the transaction client', async () => {
    const service = createAuditService(db);
    const id = await db.$transaction(async transaction => {
      const user = await transaction.user.create({ data: { ssoSubject: 'local:atomic', email: 'atomic@example.test', displayName: 'Synthetic' } });
      await service.record(event({ target: { type: 'user', id: user.id } }), transaction);
      return user.id;
    });
    expect(await db.user.findUnique({ where: { id } })).not.toBeNull();
    expect(await db.auditEvent.findFirst({ where: { targetId: id } })).not.toBeNull();
  });

  it('rolls back both writes when a later transactional operation fails', async () => {
    const service = createAuditService(db);
    await expect(db.$transaction(async transaction => {
      const user = await transaction.user.create({ data: { ssoSubject: 'local:rollback', email: 'rollback@example.test', displayName: 'Synthetic' } });
      await service.record(event({ target: { type: 'user', id: user.id } }), transaction);
      throw new Error('Synthetic failure after both writes');
    })).rejects.toThrow('Synthetic failure');
    expect(await db.user.count()).toBe(0);
    expect(await db.auditEvent.count()).toBe(0);
  });

  it('rolls back an earlier mutation when PostgreSQL rejects the audit insert', async () => {
    await database.pool.query("ALTER TABLE audit_events ADD CONSTRAINT synthetic_audit_failure CHECK (action <> 'USER_CHANGE')");
    try {
      await expect(db.$transaction(async transaction => {
        await transaction.user.create({ data: { ssoSubject: 'local:fail-audit', email: 'fail@example.test', displayName: 'Synthetic' } });
        await createAuditService(db).record(event(), transaction);
      })).rejects.toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE', message: 'The service is temporarily unavailable. Try again later.' });
      expect(await db.user.count()).toBe(0);
      expect(await db.auditEvent.count()).toBe(0);
    } finally { await database.pool.query('ALTER TABLE audit_events DROP CONSTRAINT synthetic_audit_failure'); }
  });
});
