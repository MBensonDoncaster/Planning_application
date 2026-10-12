import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma, PrismaClient } from '../src/generated/prisma/client.js';
import { createTestDatabase, deployMigrations, requireTestDatabase, runPrismaMigration, type TestDatabase } from '../test/support/database.js';

const testUrl = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_TEST_DATABASE === '1') requireTestDatabase(testUrl);
const createdAt = new Date('2026-09-01T10:00:00Z');
const expiresAt = new Date('2026-11-30T10:00:00Z');
const digest = () => createHash('sha256').update(randomUUID()).digest('hex');
let database: TestDatabase;
let db: PrismaClient;
let adminId: string;
let roleCreated = false;
const runtimeRole = `planning_test_runtime_${randomUUID().replaceAll('-', '')}`;

describe.skipIf(!testUrl)('shared PostgreSQL storage and runtime privileges', () => {
  beforeAll(async () => {
    database = await createTestDatabase(testUrl);
    db = database.createClient();
    // Test role is a separate non-owner; no privileged inherited memberships.
    await database.pool.query(`CREATE ROLE "${runtimeRole}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    roleCreated = true;
    const grants = await readFile(new URL('../prisma/runtime-grants.sql', import.meta.url), 'utf8');
    await database.pool.query(grants.replaceAll(':"app_schema"', `"${database.schema}"`).replaceAll(':"runtime_role"', `"${runtimeRole}"`));
  }, 60_000);
  beforeEach(async () => {
    await database.pool.query('TRUNCATE "users", "integrations", "api_keys", "audit_events", "idempotency_records", "rate_limit_buckets" CASCADE');
    adminId = (await db.user.create({ data: { ssoSubject: 'local:storage-admin', email: 'storage@example.test', displayName: 'Storage admin', role: 'ADMIN', status: 'APPROVED' } })).id;
  });
  afterAll(async () => {
    await db?.$disconnect();
    if (database && roleCreated) {
      await database.pool.query(`DROP OWNED BY "${runtimeRole}"`);
      await database.pool.query(`DROP ROLE "${runtimeRole}"`);
    }
    await database?.cleanup();
  });

  const integration = (data: Partial<Prisma.IntegrationUncheckedCreateInput> = {}) => db.integration.create({ data: { name: 'Synthetic integration', createdByUserId: adminId, ...data } });
  const key = (integrationId: string, data: Partial<Prisma.ApiKeyUncheckedCreateInput> = {}) => db.apiKey.create({ data: {
    integrationId, label: 'Synthetic key', publicPrefix: `pln_${randomUUID()}`, secretDigest: digest(),
    capabilities: ['call-for-sites.submit'], createdByUserId: adminId, createdAt, expiresAt, ...data,
  } });
  const audit = (data: Partial<Prisma.AuditEventUncheckedCreateInput> = {}) => db.auditEvent.create({ data: {
    requestId: 'synthetic-request', actorType: 'USER', actorUserId: adminId, module: 'shared', action: 'TEST', outcome: 'SUCCESS', ...data,
  } });
  const replay = (data: Partial<Prisma.IdempotencyRecordUncheckedCreateInput> = {}) => db.idempotencyRecord.create({ data: {
    actorType: 'USER', actorId: adminId, operation: 'call-for-sites.submit', key: randomUUID(), payloadDigest: digest(),
    submissionId: randomUUID(), response: { warnings: [] }, createdAt, expiresAt, ...data,
  } });
  async function asRuntime(work: (client: PoolClient) => Promise<void>) {
    const client = await database.pool.connect();
    try { await client.query(`SET ROLE "${runtimeRole}"`); await work(client); }
    finally { await client.query('RESET ROLE'); client.release(); }
  }

  it('deploys the specified shared tables and stores no plaintext secret column', async () => {
    const tables = await database.pool.query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name', [database.schema]);
    expect(tables.rows.map(row => row.table_name)).toEqual(['_prisma_migrations', 'api_keys', 'audit_events',
      'cfs_boundaries', 'cfs_designations', 'cfs_pre_assessments', 'cfs_properties', 'cfs_proposals',
      'cfs_reporting_fields', 'cfs_responses', 'cfs_search_documents', 'cfs_submissions',
      'idempotency_records', 'integrations', 'rate_limit_buckets', 'users']);
    const columns = await database.pool.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2', [database.schema, 'api_keys']);
    expect(columns.rows.map(row => row.column_name)).toContain('secret_digest');
    expect(columns.rows.map(row => row.column_name)).not.toContain('secret');
  });

  it('upgrades the initial users schema without altering existing access or approval data', async () => {
    const id = randomUUID();
    const upgraded = await createTestDatabase(testUrl, async url => {
      const connection = new URL(url);
      const schema = connection.searchParams.get('schema')!;
      connection.searchParams.delete('schema'); connection.searchParams.set('options', `-c search_path=${schema}`);
      const pool = new Pool({ connectionString: connection.toString() });
      try {
        await pool.query(await readFile(new URL('../prisma/migrations/20261008000000_initial_users/migration.sql', import.meta.url), 'utf8'));
        await pool.query('INSERT INTO users(id,sso_subject,email,display_name,role,status,updated_at,approved_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)', [id, 'local:existing', 'existing@example.test', 'Existing', 'ADMIN', 'APPROVED', createdAt]);
      } finally { await pool.end(); }
      await runPrismaMigration(url, ['migrate', 'resolve', '--applied', '20261008000000_initial_users']);
      await deployMigrations(url);
    });
    try {
      expect((await upgraded.pool.query('SELECT id, role, status, approved_at FROM users')).rows).toEqual([{ id, role: 'ADMIN', status: 'APPROVED', approved_at: createdAt }]);
      const entries = await readdir(new URL('../prisma/migrations/', import.meta.url), { withFileTypes: true });
      expect((await upgraded.pool.query('SELECT COUNT(*)::int AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL')).rows[0].count).toBe(entries.filter(entry => entry.isDirectory()).length);
    } finally { await upgraded.cleanup(); }
  }, 60_000);

  it('removes the paste channel without losing audit history and rejects legacy paste rows safely', async () => {
    const ids = Array.from({ length: 4 }, () => randomUUID());
    const upgraded = await createTestDatabase(testUrl, async url => {
      const connection = new URL(url);
      const schema = connection.searchParams.get('schema')!;
      connection.searchParams.delete('schema'); connection.searchParams.set('options', `-c search_path=${schema}`);
      const pool = new Pool({ connectionString: connection.toString() });
      const previous = ['20261008000000_initial_users', '20261008010000_shared_storage'];
      try {
        for (const migration of previous) {
          await pool.query(await readFile(new URL(`../prisma/migrations/${migration}/migration.sql`, import.meta.url), 'utf8'));
        }
        for (const [index, channel] of ['FILE_JSON', 'FILE_ZIP', 'INTEGRATION_API', null].entries()) {
          await pool.query('INSERT INTO audit_events(id,request_id,actor_type,module,action,outcome,channel) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [ids[index], 'synthetic-request', 'SYSTEM', 'call-for-sites', 'TEST', 'SUCCESS', channel]);
        }
        const legacyId = randomUUID();
        await pool.query('INSERT INTO audit_events(id,request_id,actor_type,module,action,outcome,channel) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [legacyId, 'synthetic-legacy', 'SYSTEM', 'call-for-sites', 'TEST', 'SUCCESS', 'PASTE']);
        const migration = await readFile(new URL('../prisma/migrations/20261008020000_remove_paste_channel/migration.sql', import.meta.url), 'utf8');
        await expect(pool.query(migration)).rejects.toThrow('Cannot remove PASTE channel');
        await pool.query('ROLLBACK');
        expect((await pool.query('SELECT channel FROM audit_events WHERE id=$1', [legacyId])).rows[0].channel).toBe('PASTE');
        // Remove only this test's synthetic legacy row before testing the supported upgrade.
        await pool.query('DELETE FROM audit_events WHERE id=$1', [legacyId]);
      } finally { await pool.end(); }
      for (const migration of previous) await runPrismaMigration(url, ['migrate', 'resolve', '--applied', migration]);
      await deployMigrations(url);
    });
    try {
      const rows = await upgraded.pool.query('SELECT id, channel FROM audit_events');
      expect(rows.rows).toEqual(expect.arrayContaining(ids.map((id, index) => ({ id, channel: ['FILE_JSON', 'FILE_ZIP', 'INTEGRATION_API', null][index] }))));
      expect(rows.rowCount).toBe(4);
      await expect(upgraded.pool.query('UPDATE audit_events SET channel=$1 WHERE id=$2', ['PASTE', ids[0]])).rejects.toMatchObject({ code: '22P02' });
    } finally { await upgraded.cleanup(); }
  }, 60_000);

  it('requires unique active integration names and allows retained disabled names', async () => {
    const original = await integration();
    await expect(integration()).rejects.toMatchObject({ code: 'P2002' });
    await db.integration.update({ where: { id: original.id }, data: { enabled: false } });
    const replacement = await integration();
    expect(replacement.id).not.toBe(original.id);
    await expect(db.integration.update({ where: { id: original.id }, data: { enabled: true } })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('stores only digests, rejects unsupported key scopes and protects retained references', async () => {
    const actor = await integration();
    const credential = await key(actor.id);
    expect(credential.secretDigest).toMatch(/^[a-f0-9]{64}$/);
    await expect(key(actor.id, { publicPrefix: credential.publicPrefix })).rejects.toMatchObject({ code: 'P2002' });
    await expect(key(actor.id, { secretDigest: credential.secretDigest })).rejects.toMatchObject({ code: 'P2002' });
    for (const capabilities of [[], ['users.manage'], ['call-for-sites.submit', 'call-for-sites.read']]) {
      await expect(database.pool.query('UPDATE api_keys SET capabilities=$1 WHERE id=$2', [capabilities, credential.id])).rejects.toMatchObject({ code: '23514' });
    }
    await expect(database.pool.query('UPDATE api_keys SET capabilities=ARRAY[NULL]::text[] WHERE id=$1', [credential.id])).rejects.toMatchObject({ code: '23514' });
    await expect(db.integration.delete({ where: { id: actor.id } })).rejects.toMatchObject({ code: 'P2003' });
    await expect(db.user.delete({ where: { id: adminId } })).rejects.toMatchObject({ code: 'P2003' });
  });

  it('rejects malformed digests, expiry and incomplete revocation metadata', async () => {
    const credential = await key((await integration()).id);
    for (const [clause, values] of [
      ['secret_digest=$1', ['plaintext']], ['expires_at=$1', [createdAt]],
      ['expires_at=$1', [new Date(createdAt.getTime() + 366 * 86400000)]],
      ['revoked_at=$1', [expiresAt]], ['revoked_by_user_id=$1', [adminId]],
      ['last_used_at=$1', [new Date('2026-08-01T00:00:00Z')]],
    ] as const) {
      await expect(database.pool.query(`UPDATE api_keys SET ${clause} WHERE id=$2`, [...values, credential.id])).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('validates actor attribution and bounds audit metadata while accommodating export selections', async () => {
    const event = await audit();
    for (const [type, userId, integrationId, keyId] of [
      ['USER', null, null, null], ['USER', adminId, null, randomUUID()],
      ['INTEGRATION', null, randomUUID(), null], ['UNKNOWN', adminId, null, null], ['SYSTEM', adminId, null, null],
    ]) await expect(database.pool.query('UPDATE audit_events SET actor_type=$1,actor_user_id=$2,actor_integration_id=$3,actor_key_id=$4 WHERE id=$5', [type, userId, integrationId, keyId, event.id])).rejects.toMatchObject({ code: '23514' });
    await audit({ actorType: 'UNKNOWN', actorUserId: null, outcome: 'FAILURE' });
    await audit({ actorType: 'SYSTEM', actorUserId: null });
    await audit({ metadata: { ids: Array.from({ length: 500 }, () => randomUUID()) } });
    for (const metadata of [{ text: 'x'.repeat(65536) }, []]) {
      await expect(database.pool.query('UPDATE audit_events SET metadata=$1::jsonb WHERE id=$2', [JSON.stringify(metadata), event.id])).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('retains audit history and integration-scoped replay metadata through revocation and operator deletion', async () => {
    const actor = await integration(); const credential = await key(actor.id);
    const event = await audit({ actorType: 'INTEGRATION', actorUserId: null, actorIntegrationId: actor.id, actorKeyId: credential.id,
      module: 'call-for-sites', channel: 'INTEGRATION_API', targetType: 'submission', targetId: randomUUID() });
    const result = await replay({ actorType: 'INTEGRATION', actorId: actor.id, submissionId: event.targetId! });
    await db.apiKey.update({ where: { id: credential.id }, data: { revokedAt: expiresAt, revokedByUserId: adminId } });
    expect((await db.apiKey.findUniqueOrThrow({ where: { id: credential.id } })).revokedAt).toEqual(expiresAt);
    // Controlled owner operations, never application delete endpoints.
    await db.apiKey.delete({ where: { id: credential.id } }); await db.integration.delete({ where: { id: actor.id } });
    expect(await db.auditEvent.findUnique({ where: { id: event.id } })).toEqual(event);
    await db.idempotencyRecord.update({ where: { id: result.id }, data: { deletedAt: expiresAt } });
    expect((await db.idempotencyRecord.findUniqueOrThrow({ where: { id: result.id } })).submissionId).toBe(event.targetId);
  });

  it('uniquely scopes idempotency by actor type, actor ID, operation and UUID v4 key', async () => {
    const original = await replay();
    const tuple = { actorType: original.actorType, actorId: original.actorId, operation: original.operation, key: original.key };
    await expect(replay(tuple)).rejects.toMatchObject({ code: 'P2002' });
    await replay({ ...tuple, actorType: 'INTEGRATION' });
    await replay({ ...tuple, actorId: randomUUID() });
    await replay({ ...tuple, operation: 'other.submit' });
    await expect(database.pool.query('UPDATE idempotency_records SET key=$1 WHERE id=$2', ['11111111-1111-1111-8111-111111111111', original.id])).rejects.toMatchObject({ code: '23514' });
    await expect(database.pool.query('UPDATE idempotency_records SET expires_at=created_at WHERE id=$1', [original.id])).rejects.toMatchObject({ code: '23514' });
    await expect(database.pool.query("UPDATE idempotency_records SET response='[]'::jsonb WHERE id=$1", [original.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('supports shared atomic rate counters with independent scopes and windows', async () => {
    const subject = digest(); const start = createdAt; const end = new Date(start.getTime() + 60000);
    await Promise.all(Array.from({ length: 20 }, () => database.pool.query(
      `INSERT INTO rate_limit_buckets(scope,subject_digest,window_start,expires_at,count) VALUES ('USER',$1,$2,$3,1)
       ON CONFLICT (scope,subject_digest,window_start) DO UPDATE SET count=rate_limit_buckets.count+1`, [subject, start, end],
    )));
    expect((await db.rateLimitBucket.findMany())[0].count).toBe(20n);
    await db.rateLimitBucket.create({ data: { scope: 'USER_WRITE', subjectDigest: subject, windowStart: start, expiresAt: end, count: 1 } });
    await expect(database.pool.query("UPDATE rate_limit_buckets SET count=-1 WHERE scope='USER'")).rejects.toMatchObject({ code: '23514' });
    expect(await db.rateLimitBucket.count()).toBe(2);
  });

  it('allows runtime audit INSERT/SELECT and refuses UPDATE/DELETE/TRUNCATE and migration access', async () => {
    const id = randomUUID();
    await asRuntime(async client => {
      expect((await client.query('SELECT current_user')).rows[0].current_user).toBe(runtimeRole);
      await client.query("INSERT INTO audit_events(id,request_id,actor_type,module,action,outcome) VALUES ($1,'runtime-test','SYSTEM','shared','TEST','SUCCESS')", [id]);
      expect((await client.query('SELECT id FROM audit_events WHERE id=$1', [id])).rows).toEqual([{ id }]);
      for (const sql of ['UPDATE audit_events SET action=action', 'DELETE FROM audit_events', 'TRUNCATE audit_events', 'SELECT * FROM _prisma_migrations', 'ALTER TABLE audit_events ADD COLUMN changed BOOLEAN', 'CREATE TABLE forbidden(id UUID)', 'DELETE FROM api_keys', 'DELETE FROM integrations', 'DELETE FROM users']) {
        await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
      }
    });
    expect(await db.auditEvent.count()).toBe(1);
  });

  it('grants runtime mutations for operational storage without schema ownership', async () => {
    const actor = await integration(); const credential = await key(actor.id); const record = await replay();
    await asRuntime(async client => {
      await client.query('BEGIN');
      await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
      await client.query('COMMIT');
      await client.query('UPDATE users SET display_name=$1 WHERE id=$2', ['Runtime profile', adminId]);
      await client.query('UPDATE integrations SET enabled=false WHERE id=$1', [actor.id]);
      await client.query('UPDATE api_keys SET revoked_at=$1, revoked_by_user_id=$2 WHERE id=$3', [expiresAt, adminId, credential.id]);
      await client.query('UPDATE idempotency_records SET deleted_at=$1 WHERE id=$2', [expiresAt, record.id]);
      await client.query('DELETE FROM idempotency_records WHERE id=$1', [record.id]);
      await client.query("INSERT INTO rate_limit_buckets(scope,subject_digest,window_start,expires_at,count) VALUES ('API_KEY',$1,$2,$3,1)", [digest(), createdAt, expiresAt]);
      await client.query('UPDATE rate_limit_buckets SET count=count+1');
      await client.query('DELETE FROM rate_limit_buckets');
    });
    expect(await db.idempotencyRecord.count()).toBe(0);
    expect((await db.integration.findUniqueOrThrow({ where: { id: actor.id } })).enabled).toBe(false);
  });
});
