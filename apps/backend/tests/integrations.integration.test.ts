import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { createIntegrationService, type IntegrationService } from '../src/modules/integrations/service.js';
import type { UserActor } from '../src/shared/actors.js';
import { createTestDatabase, requireTestDatabase, type TestDatabase } from '../test/support/database.js';

const testUrl = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_TEST_DATABASE === '1') requireTestDatabase(testUrl);
const context = () => ({ requestId: randomUUID() });
const config = { API_KEY_DEFAULT_EXPIRY_DAYS: 90, API_KEY_MAX_EXPIRY_DAYS: 365 };
let database: TestDatabase, db: PrismaClient, service: IntegrationService, actor: UserActor;
const grant = { label: 'Synthetic RPA', capabilities: ['call-for-sites.submit'] };
const future = (hours: number) => new Date(Date.now() + hours * 3600000).toISOString();

describe.skipIf(!testUrl)('integration administration and key authentication in PostgreSQL', () => {
  beforeAll(async () => { database = await createTestDatabase(testUrl); db = database.createClient(); service = createIntegrationService(db, config); }, 60_000);
  beforeEach(async () => {
    await database.pool.query('TRUNCATE users, integrations, api_keys, audit_events CASCADE');
    const { ssoSubject, ...user } = await db.user.create({ data: { ssoSubject: 'local:key-admin', email: 'keys@example.test', displayName: 'Keys administrator', role: 'ADMIN', status: 'APPROVED' } });
    actor = { type: 'USER', user: { ...user, subject: ssoSubject } };
  });
  afterAll(async () => { await db?.$disconnect(); await database?.cleanup(); });
  const integration = () => service.create(actor, { name: 'Synthetic RPA' }, context());
  const generated = async () => { const owner = await integration(); return service.createKey(actor, owner.id, grant, context()); };

  it('creates trimmed metadata and derives its creator from the current administrator', async () => {
    const result = await service.create(actor, { name: '  Synthetic  ', description: '  test  ' }, context());
    expect(result).toMatchObject({ name: 'Synthetic', description: 'test', enabled: true, createdByUserId: actor.user.id });
    expect(await db.auditEvent.findFirstOrThrow()).toMatchObject({ action: 'INTEGRATION_CREATED', actorUserId: actor.user.id, targetId: result.id, metadata: { enabled: true } });
  });
  it('rejects unknown fields, empty names and oversized names/descriptions', async () => {
    for (const input of [{ name: ' ' }, { name: 'x'.repeat(201) }, { name: 'n', description: 'x'.repeat(2001) }, { name: 'n', createdByUserId: randomUUID() }]) {
      await expect(service.create(actor, input, context())).rejects.toThrow();
    }
    expect(await db.integration.count()).toBe(0);
  });
  it('serialises duplicate active-name creation and returns one conflict', async () => {
    const result = await Promise.allSettled([integration(), integration()]);
    expect(result.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    const failed = result.find(value => value.status === 'rejected');
    expect(failed?.status === 'rejected' && failed.reason).toMatchObject({ statusCode: 409, code: 'REQUEST_CONFLICT' });
    expect(await db.integration.count()).toBe(1);
    expect(await db.auditEvent.count()).toBe(1);
  });
  it('allows disabled duplicate names but rejects conflicting re-enablement', async () => {
    const first = await integration();
    await service.update(actor, first.id, { enabled: false }, context());
    await integration();
    await expect(service.update(actor, first.id, { enabled: true }, context())).rejects.toMatchObject({ statusCode: 409 });
    expect((await db.integration.findUniqueOrThrow({ where: { id: first.id } })).enabled).toBe(false);
  });
  it('checks current database administrator permissions rather than a stale actor', async () => {
    await db.user.update({ where: { id: actor.user.id }, data: { role: 'USER' } });
    await expect(integration()).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(await db.integration.count()).toBe(0);
  });
  it('returns a 32-byte one-time secret, storing only its full SHA-256 digest', async () => {
    const result = await generated();
    expect(result.secret).toMatch(/^pln_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(result.secret.split('.')[1], 'base64url')).toHaveLength(32);
    const stored = await db.apiKey.findUniqueOrThrow({ where: { id: result.key.id } });
    expect(stored.secretDigest).toBe(createHash('sha256').update(result.secret).digest('hex'));
    expect(JSON.stringify(result.key)).not.toContain(stored.secretDigest);
    const listed = await service.list(actor, 1, context());
    expect(JSON.stringify(listed)).not.toContain(result.secret);
    expect(JSON.stringify(listed)).not.toContain(stored.secretDigest);
    expect(JSON.stringify(await db.auditEvent.findMany())).not.toContain(result.secret);
  });
  it('uses default expiry and rejects expired, excessive and non-submission grants', async () => {
    const owner = await integration();
    const first = await service.createKey(actor, owner.id, grant, context());
    expect(new Date(first.key.expiresAt).getTime() - new Date(first.key.createdAt).getTime()).toBe(90 * 86400000);
    for (const input of [ { ...grant, expiresAt: future(-1) }, { ...grant, expiresAt: future(366 * 24) }, { ...grant, capabilities: [] }, { ...grant, capabilities: ['users.manage'] }, { ...grant, capabilities: ['call-for-sites.submit', 'call-for-sites.read'] } ]) {
      await expect(service.createKey(actor, owner.id, input, context())).rejects.toThrow();
    }
    expect(await db.apiKey.count()).toBe(1);
  });
  it('rejects invalid credentials without changing last authenticated use', async () => {
    const result = await generated();
    for (const secret of ['bad', result.secret + 'x', result.secret.slice(0, -1) + (result.secret.endsWith('a') ? 'b' : 'a'), `pln_${randomUUID()}.${'x'.repeat(43)}`]) {
      await expect(service.authenticateKey(secret)).rejects.toMatchObject({ statusCode: 401, code: 'INVALID_CREDENTIALS' });
    }
    expect((await db.apiKey.findUniqueOrThrow({ where: { id: result.key.id } })).lastUsedAt).toBeNull();
  });
  it('attributes authentication to both IDs and persists last-use before later payload work', async () => {
    const result = await generated();
    expect(await service.authenticateKey(result.secret)).toEqual({ type: 'INTEGRATION', integrationId: result.key.integrationId, keyId: result.key.id, capabilities: ['call-for-sites.submit'] });
    expect((await db.apiKey.findUniqueOrThrow({ where: { id: result.key.id } })).lastUsedAt).toBeInstanceOf(Date);
    expect((await service.list(actor, 1, context())).integrations[0].keys[0].lastUsedAt).not.toBeNull();
  });
  it('consults integration state on the next request and re-enablement does not revive revoked keys', async () => {
    const result = await generated();
    await service.update(actor, result.key.integrationId, { enabled: false }, context());
    await expect(service.authenticateKey(result.secret)).rejects.toMatchObject({ statusCode: 401 });
    expect((await service.list(actor, 1, context())).integrations[0].keys[0]).toMatchObject({ status: 'DISABLED', effectiveCapabilities: [] });
    await service.update(actor, result.key.integrationId, { enabled: true }, context());
    await service.authenticateKey(result.secret);
    await service.revokeKey(actor, result.key.id, context());
    await service.update(actor, result.key.integrationId, { enabled: false }, context());
    await service.update(actor, result.key.integrationId, { enabled: true }, context());
    await expect(service.authenticateKey(result.secret)).rejects.toMatchObject({ statusCode: 401 });
  });
  it('rejects an expired stored key while retaining its metadata', async () => {
    const result = await generated();
    await db.apiKey.update({ where: { id: result.key.id }, data: { createdAt: new Date(Date.now() - 2 * 86400000), expiresAt: new Date(Date.now() - 86400000) } });
    await expect(service.authenticateKey(result.secret)).rejects.toMatchObject({ statusCode: 401 });
    expect((await service.list(actor, 1, context())).integrations[0].keys[0]).toMatchObject({ status: 'EXPIRED', effectiveCapabilities: [] });
    await service.update(actor, result.key.integrationId, { enabled: false }, context());
    await service.update(actor, result.key.integrationId, { enabled: true }, context());
    await expect(service.authenticateKey(result.secret)).rejects.toMatchObject({ statusCode: 401 });
  });
  it('automatically rejects a key once its scheduled revocation takes effect', async () => {
    const result = await generated();
    await db.apiKey.update({ where: { id: result.key.id }, data: {
      createdAt: new Date(Date.now() - 2 * 3600000), revokedAt: new Date(Date.now() - 3600000), revokedByUserId: actor.user.id,
    } });
    await expect(service.authenticateKey(result.secret)).rejects.toMatchObject({ statusCode: 401, code: 'INVALID_CREDENTIALS' });
    expect((await service.list(actor, 1, context())).integrations[0].keys[0]).toMatchObject({ status: 'REVOKED', effectiveCapabilities: [] });
    expect((await db.apiKey.findUniqueOrThrow({ where: { id: result.key.id } })).lastUsedAt).toBeNull();
  });
  it('atomically rotates immediately, keeping scopes and selecting new expiry', async () => {
    const previous = await generated();
    const selectedExpiry = future(12);
    const next = await service.rotateKey(actor, previous.key.id, { expiresAt: selectedExpiry }, context());
    expect(next.key).toMatchObject({ integrationId: previous.key.integrationId, capabilities: previous.key.capabilities, expiresAt: selectedExpiry });
    expect(next.key.id).not.toBe(previous.key.id);
    await expect(service.authenticateKey(previous.secret)).rejects.toMatchObject({ statusCode: 401 });
    await service.authenticateKey(next.secret);
    expect(await db.apiKey.count()).toBe(2);
  });
  it('bounds overlap by original expiry and permits immediate revocation during overlap', async () => {
    const owner = await integration();
    const original = await service.createKey(actor, owner.id, { ...grant, expiresAt: future(1) }, context());
    const next = await service.rotateKey(actor, original.key.id, { overlapHours: 24 }, context());
    expect(next.previousKeyRevokesAt).toBe(original.key.expiresAt);
    await service.authenticateKey(original.secret);
    await service.authenticateKey(next.secret);
    const listed = (await service.list(actor, 1, context())).integrations[0].keys.find(key => key.id === original.key.id);
    expect(listed).toMatchObject({ status: 'SCHEDULED_REVOCATION', effectiveExpiresAt: original.key.expiresAt });
    const revoked = await service.revokeKey(actor, original.key.id, context());
    expect(revoked.status).toBe('REVOKED');
    await expect(service.authenticateKey(original.secret)).rejects.toMatchObject({ statusCode: 401 });
  });
  it('rejects excessive overlap and stale/concurrent rotation without creating extra keys', async () => {
    const original = await generated();
    await expect(service.rotateKey(actor, original.key.id, { overlapHours: 25 }, context())).rejects.toThrow();
    const result = await Promise.allSettled([service.rotateKey(actor, original.key.id, {}, context()), service.rotateKey(actor, original.key.id, {}, context())]);
    expect(result.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    const failure = result.find(value => value.status === 'rejected');
    expect(failure?.status === 'rejected' && failure.reason).toMatchObject({ statusCode: 409 });
    expect(await db.apiKey.count()).toBe(2);
  });
  it('repeated revocation preserves the first revocation actor/time and metadata', async () => {
    const key = await generated();
    const first = await service.revokeKey(actor, key.key.id, context());
    const again = await service.revokeKey(actor, key.key.id, context());
    expect(again).toEqual(first);
    expect(await db.apiKey.count()).toBe(1);
    expect(await db.auditEvent.count({ where: { action: 'API_KEY_REVOKED' } })).toBe(2);
  });
  it('rolls back integration and key changes when their audit cannot be stored', async () => {
    const owner = await integration();
    const key = await service.createKey(actor, owner.id, grant, context());
    const failing = createIntegrationService(db, config, { async record() { throw new Error('Synthetic audit failure'); } });
    await expect(failing.create(actor, { name: 'rollback' }, context())).rejects.toThrow('Synthetic audit failure');
    await expect(failing.update(actor, owner.id, { enabled: false }, context())).rejects.toThrow('Synthetic audit failure');
    await expect(failing.createKey(actor, owner.id, grant, context())).rejects.toThrow('Synthetic audit failure');
    await expect(failing.rotateKey(actor, key.key.id, {}, context())).rejects.toThrow('Synthetic audit failure');
    await expect(failing.revokeKey(actor, key.key.id, context())).rejects.toThrow('Synthetic audit failure');
    expect(await db.integration.count()).toBe(1);
    expect((await db.integration.findUniqueOrThrow({ where: { id: owner.id } })).enabled).toBe(true);
    expect(await db.apiKey.count()).toBe(1);
    expect((await db.apiKey.findUniqueOrThrow({ where: { id: key.key.id } })).revokedAt).toBeNull();
  });
  it('blocks list data when the read audit fails', async () => {
    await generated();
    const failing = createIntegrationService(db, config, { async record() { throw new Error('Synthetic read audit failure'); } });
    await expect(failing.list(actor, 1, context())).rejects.toThrow('Synthetic read audit failure');
  });
  it('rolls back both sides of rotation when PostgreSQL rejects its audit insert', async () => {
    const original = await generated();
    await database.pool.query("ALTER TABLE audit_events ADD CONSTRAINT synthetic_rotation_audit_failure CHECK (action <> 'API_KEY_ROTATED')");
    try {
      await expect(service.rotateKey(actor, original.key.id, { overlapHours: 1 }, context())).rejects.toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
      expect(await db.apiKey.count()).toBe(1);
      expect((await db.apiKey.findUniqueOrThrow({ where: { id: original.key.id } })).revokedAt).toBeNull();
      await service.authenticateKey(original.secret);
    } finally { await database.pool.query('ALTER TABLE audit_events DROP CONSTRAINT synthetic_rotation_audit_failure'); }
  });
  it('paginates integration metadata at 50 with stable sorting', async () => {
    await db.integration.createMany({ data: Array.from({ length: 51 }, (_, index) => ({ name: `Synthetic ${index}`, createdByUserId: actor.user.id, createdAt: new Date('2026-01-01Z') })) });
    const first = await service.list(actor, 1, context());
    const second = await service.list(actor, 2, context());
    expect(first).toMatchObject({ total: 51, pageSize: 50 });
    expect(first.integrations).toHaveLength(50);
    expect(second.integrations).toHaveLength(1);
    expect(new Set([...first.integrations, ...second.integrations].map(row => row.id)).size).toBe(51);
  });
  it('returns missing-target errors without domain writes', async () => {
    const id = randomUUID();
    await expect(service.update(actor, id, { enabled: false }, context())).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.createKey(actor, id, grant, context())).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.rotateKey(actor, id, {}, context())).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.revokeKey(actor, id, context())).rejects.toMatchObject({ statusCode: 404 });
  });
});
