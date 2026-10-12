import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient, Prisma } from '../src/generated/prisma/client.js';
import { createAuditReviewService, type AuditReviewService } from '../src/modules/audit/service.js';
import type { UserActor } from '../src/shared/actors.js';
import { createAuditService, type AuditService } from '../src/shared/audit.js';
import { createTestDatabase, requireTestDatabase, type TestDatabase } from '../test/support/database.js';

const testUrl = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_TEST_DATABASE === '1') requireTestDatabase(testUrl);
const context = () => ({ requestId: randomUUID() });
let database: TestDatabase, db: PrismaClient, service: AuditReviewService, actor: UserActor;
const instant = new Date('2026-01-01T09:00:00.000Z');

describe.skipIf(!testUrl)('audit review in PostgreSQL', () => {
  beforeAll(async () => { database = await createTestDatabase(testUrl); db = database.createClient(); service = createAuditReviewService(db); }, 60_000);
  beforeEach(async () => {
    await database.pool.query('TRUNCATE users, audit_events CASCADE');
    const { ssoSubject, ...user } = await db.user.create({ data: { ssoSubject: 'local:audit-admin', email: 'admin@example.test', displayName: 'Synthetic audit administrator', role: 'ADMIN', status: 'APPROVED' } });
    actor = { type: 'USER', user: { ...user, subject: ssoSubject } };
  });
  afterAll(async () => { await db?.$disconnect(); await database?.cleanup(); });
  const event = (data: Partial<Prisma.AuditEventUncheckedCreateInput> = {}) => db.auditEvent.create({ data: {
    requestId: randomUUID(), actorType: 'SYSTEM', module: 'shared', action: 'HOME_READ', outcome: 'SUCCESS', occurredAt: instant, ...data,
  } });

  it('returns all retained audit fields without joining domain profiles or secrets', async () => {
    const integrationId = randomUUID(), keyId = randomUUID(), targetId = randomUUID();
    const row = await event({ actorType: 'INTEGRATION', actorIntegrationId: integrationId, actorKeyId: keyId,
      module: 'call-for-sites', action: 'EXTERNAL_SUBMISSION', targetType: 'submission', targetId, outcome: 'FAILURE',
      errorCode: 'VALIDATION_ERROR', channel: 'INTEGRATION_API', metadata: { statusCode: 400, secret: 'plaintext-secret', rawPayload: 'contact-details' } });
    const result = await service.list(actor, {}, context());
    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 50, events: [{ ...row, occurredAt: instant.toISOString(), metadata: { statusCode: 400 } }] });
    expect(JSON.stringify(result)).not.toContain('plaintext-secret');
    expect(JSON.stringify(result)).not.toContain('contact-details');
    expect(JSON.stringify(result)).not.toContain('admin@example.test');
    expect(Object.keys(result.events[0]).sort()).toEqual(['id', 'occurredAt', 'requestId', 'actorType', 'actorUserId', 'actorIntegrationId', 'actorKeyId', 'module', 'action', 'targetType', 'targetId', 'outcome', 'errorCode', 'channel', 'metadata'].sort());
  });
  it('filters all selectors together and records safe review criteria before returning', async () => {
    const actorId = randomUUID(), targetId = randomUUID();
    const matching = await event({ actorType: 'USER', actorUserId: actorId, action: 'USER_DISABLED', targetId, targetType: 'user', outcome: 'DENIED', metadata: { statusCode: 403 } });
    await event({ actorType: 'USER', actorUserId: actorId, action: 'USER_DISABLED', targetId, targetType: 'user', outcome: 'SUCCESS' });
    const request = context();
    const result = await service.list(actor, { actorType: 'USER', actorId, module: 'shared', action: 'USER_DISABLED', outcome: 'DENIED', targetId,
      dateFrom: '2026-01-01T10:00:00+01:00', dateTo: '2026-01-01T09:00:01Z' }, request);
    expect(result.total).toBe(1); expect(result.events.map(row => row.id)).toEqual([matching.id]);
    const recorded = await db.auditEvent.findFirstOrThrow({ where: { requestId: request.requestId } });
    expect(recorded).toMatchObject({ actorType: 'USER', actorUserId: actor.user.id, module: 'shared', action: 'AUDIT_EVENTS_LIST', outcome: 'SUCCESS', metadata: {
      page: 1, pageSize: 50, resultCount: 1, actorType: 'USER', module: 'shared', outcome: 'DENIED',
      dateFrom: instant.toISOString(), dateTo: '2026-01-01T09:00:01.000Z', hasDateFrom: true, hasDateTo: true, hasActorId: true, hasAction: true, hasTargetId: true,
    } });
    expect(JSON.stringify(recorded.metadata)).not.toContain(actorId);
    expect(JSON.stringify(recorded.metadata)).not.toContain(targetId);
  });
  it.each(['actorUserId', 'actorIntegrationId', 'actorKeyId'] as const)('finds retained actor IDs through %s', async field => {
    const actorId = randomUUID();
    const match = await event(field === 'actorUserId' ? { actorType: 'USER', actorUserId: actorId } : {
      actorType: 'INTEGRATION', actorIntegrationId: field === 'actorIntegrationId' ? actorId : randomUUID(),
      actorKeyId: field === 'actorKeyId' ? actorId : randomUUID(),
    });
    await event();
    const result = await service.list(actor, { actorId }, context());
    expect(result.total).toBe(1); expect(result.events.map(row => row.id)).toEqual([match.id]);
  });
  it('uses inclusive lower and exclusive upper time bounds after offset conversion', async () => {
    await event({ occurredAt: new Date(instant.getTime() - 1) });
    const lower = await event(), middle = await event({ occurredAt: new Date(instant.getTime() + 1) });
    await event({ occurredAt: new Date(instant.getTime() + 2) });
    const result = await service.list(actor, { dateFrom: '2026-01-01T10:00:00+01:00', dateTo: '2026-01-01T10:00:00.002+01:00' }, context());
    expect(result.total).toBe(2); expect(result.events.map(row => row.id)).toEqual([middle.id, lower.id]);
  });
  it('supports either open time boundary independently', async () => {
    await event(); await event({ occurredAt: new Date(instant.getTime() + 1) });
    expect((await service.list(actor, { action: 'HOME_READ', dateFrom: '2026-01-01T09:00:00.001Z' }, context())).total).toBe(1);
    expect((await service.list(actor, { action: 'HOME_READ', dateTo: '2026-01-01T09:00:00.001Z' }, context())).total).toBe(1);
  });
  it('orders tied timestamps by descending UUID and counts the complete filtered set across pages', async () => {
    const ids = Array.from({ length: 103 }, () => randomUUID()).sort().reverse();
    await db.auditEvent.createMany({ data: ids.map(id => ({ id, requestId: randomUUID(), actorType: 'SYSTEM', module: 'shared', action: 'HOME_READ', outcome: 'SUCCESS', occurredAt: instant })) });
    const pages = await Promise.all([1, 2, 3].map(page => service.list(actor, { page, action: 'HOME_READ' }, context())));
    expect(pages.map(page => page.total)).toEqual([103, 103, 103]);
    expect(pages.map(page => page.events.length)).toEqual([50, 50, 3]);
    expect(pages.flatMap(page => page.events.map(row => row.id))).toEqual(ids);
    expect((await service.list(actor, { page: 4, action: 'HOME_READ' }, context())).events).toEqual([]);
  });
  it('does not include its own review event or inflate its returned total', async () => {
    await event(); const request = context();
    const result = await service.list(actor, {}, request);
    expect(result.total).toBe(1); expect(result.events).toHaveLength(1);
    expect(result.events.some(row => row.requestId === request.requestId)).toBe(false);
    expect(await db.auditEvent.count()).toBe(2);
  });
  it('keeps count and page in one snapshot when an event arrives between their queries', async () => {
    const original = await event();
    let concurrentId: string | undefined;
    const observing = db.$extends({ query: { auditEvent: { count: async ({ args, query }) => {
      const count = await query(args);
      concurrentId = (await event({ occurredAt: new Date(instant.getTime() + 1) })).id;
      return count;
    } } } });
    const result = await createAuditReviewService(observing as unknown as PrismaClient).list(actor, { action: 'HOME_READ' }, context());
    expect(concurrentId).toBeDefined();
    expect(result.total).toBe(1);
    expect(result.events.map(row => row.id)).toEqual([original.id]);
    expect(await db.auditEvent.count({ where: { action: 'HOME_READ' } })).toBe(2);
  });
  it('does not expose unknown future action metadata', async () => {
    await event({ action: 'FUTURE_ACTION', outcome: 'FAILURE', metadata: { secret: 'hidden', statusCode: 500 } });
    const result = await service.list(actor, { action: 'FUTURE_ACTION' }, context());
    expect(result.events[0]).toMatchObject({ action: 'FUTURE_ACTION', metadata: {} });
  });
  it('bounds oversized legacy action text while suppressing its metadata', async () => {
    await event({ action: 'LEGACY_' + 'A'.repeat(500), metadata: { secret: 'hidden' } });
    const result = await service.list(actor, {}, context());
    expect(result.events[0].action).toHaveLength(100);
    expect(result.events[0].metadata).toEqual({});
  });
  it('denies service callers lacking review capability', async () => {
    await expect(service.list({ ...actor, user: { ...actor.user, role: 'USER' } }, {}, context())).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(await db.auditEvent.count()).toBe(0);
  });
  it('rejects successful data delivery and rolls back review insertion when audit persistence fails', async () => {
    await event();
    const realAudit = createAuditService(db);
    const failingAudit: AuditService = { async record(input, transaction) {
      await realAudit.record(input, transaction);
      throw new Error('Synthetic audit failure');
    } };
    await expect(createAuditReviewService(db, failingAudit).list(actor, {}, context())).rejects.toThrow('Synthetic audit failure');
    expect(await db.auditEvent.count()).toBe(1);
  });
  it('returns 503 when a real database constraint prevents the read audit', async () => {
    await event();
    await database.pool.query("ALTER TABLE audit_events ADD CONSTRAINT synthetic_audit_review_failure CHECK (action <> 'AUDIT_EVENTS_LIST')");
    try {
      await expect(service.list(actor, {}, context())).rejects.toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
      expect(await db.auditEvent.count()).toBe(1);
    } finally { await database.pool.query('ALTER TABLE audit_events DROP CONSTRAINT synthetic_audit_review_failure'); }
  });
});
