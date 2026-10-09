import { readdir } from 'node:fs/promises';
import { createUserRepository } from '../src/modules/users/repository.js';
import type { UserRepository } from '../src/modules/users/types.js';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { createTestDatabase, deployMigrations, requireTestDatabase, type TestDatabase } from '../test/support/database.js';
import { seedSyntheticUsers, SYNTHETIC_USERS } from '../test/support/synthetic-users.js';

const testUrl = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_TEST_DATABASE === '1') requireTestDatabase(testUrl);
let database: TestDatabase;
let repository: UserRepository;

describe.skipIf(!testUrl)('PostgreSQL repository integration', () => {
  beforeAll(async () => {
    database = await createTestDatabase(testUrl);
    repository = createUserRepository(database.createClient());
  }, 60_000);
  beforeEach(async () => { await database.pool.query('TRUNCATE TABLE "users", "audit_events" CASCADE'); });
  afterAll(async () => {
    await repository?.close();
    await database?.cleanup();
  });
  async function admin(subject: string) {
    const user = await repository.authenticate({ subject, email: `${subject}@example.test`, displayName: subject });
    await database.pool.query(`UPDATE "users" SET role='ADMIN', status='APPROVED', approved_at=NOW() WHERE id=$1`, [user.id]);
    return user;
  }
  it('registers once and preserves local access during subsequent profile updates', async () => {
    const identity = { subject: 'entra:tenant:object', email: 'ada@example.test', displayName: 'Ada' };
    const first = await repository.authenticate(identity);
    expect(first.status).toBe('PENDING'); expect(first.role).toBe('USER');
    await database.pool.query(`UPDATE "users" SET role='ADMIN', status='DISABLED' WHERE id=$1`, [first.id]);
    const again = await repository.authenticate({ ...identity, displayName: 'Ada Updated' });
    expect(again.id).toBe(first.id); expect(again.displayName).toBe('Ada Updated');
    expect(again.status).toBe('DISABLED'); expect(again.role).toBe('ADMIN');
    expect((await repository.list({ page: 1, pageSize: 20, search: '' })).total).toBe(1);
  });
  it('records approval metadata and supports status/search filtering', async () => {
    const actor = await admin('owner');
    const target = await repository.authenticate({ subject: 'second', email: 'second@example.test', displayName: 'Second' });
    const result = await repository.change(actor.id, target.id, { action: 'approve' });
    expect(result.approvedByUserId).toBe(actor.id); expect(result.approvedAt).toBeInstanceOf(Date);
    expect((await repository.list({ page: 1, pageSize: 20, search: 'SECOND', status: 'APPROVED' })).users.map(u => u.id)).toEqual([target.id]);
  });
  it('serializes concurrent self-demotions and preserves one approved admin', async () => {
    const a = await admin('a'); const b = await admin('b');
    const results = await Promise.allSettled([
      repository.change(a.id, a.id, { action: 'role', role: 'USER' }),
      repository.change(b.id, b.id, { action: 'role', role: 'USER' }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const count = await database.pool.query(`SELECT COUNT(*)::int AS count FROM "users" WHERE role='ADMIN' AND status='APPROVED'`);
    expect(count.rows[0].count).toBe(1);
  });
  it('looks up immutable subjects without changing profiles, login timestamps or access', async () => {
    const user = await repository.authenticate({ subject: 'entra:read-only:object', email: 'reader@example.test', displayName: 'Reader' });
    await database.pool.query(`UPDATE "users" SET role='ADMIN', status='APPROVED', approved_at=NOW() WHERE id=$1`, [user.id]);
    const before = await database.pool.query('SELECT * FROM "users" WHERE id=$1', [user.id]);
    expect(await repository.findBySubject(user.subject)).toMatchObject({ id: user.id, subject: user.subject, role: 'ADMIN', status: 'APPROVED' });
    expect(await repository.findBySubject('entra:unknown:object')).toBeNull();
    expect((await database.pool.query('SELECT * FROM "users" WHERE id=$1', [user.id])).rows).toEqual(before.rows);
    expect((await database.pool.query('SELECT COUNT(*)::int AS count FROM "users"')).rows[0].count).toBe(1);
    await database.pool.query(`UPDATE "users" SET status='DISABLED' WHERE id=$1`, [user.id]);
    expect(await repository.findBySubject(user.subject)).toMatchObject({ status: 'DISABLED' });
  });
  async function rejectAuditWrites(run: () => Promise<void>) {
    await database.pool.query("CREATE FUNCTION reject_audit_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected audit storage failure'; END $$");
    await database.pool.query('CREATE TRIGGER reject_audit_write BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit_write()');
    try { await run(); }
    finally {
      await database.pool.query('DROP TRIGGER reject_audit_write ON audit_events');
      await database.pool.query('DROP FUNCTION reject_audit_write()');
    }
  }
  it('commits session synchronization and user access changes with their attributed audit records', async () => {
    const actor = await admin('audit-owner');
    const target = await repository.authenticate({ subject: 'audited-target', email: 'target@example.test', displayName: 'Target' }, { requestId: 'session-integration' });
    await repository.change(actor.id, target.id, { action: 'approve' }, { requestId: 'change-integration' });
    const events = await database.pool.query('SELECT request_id, actor_type, actor_user_id, action, outcome, target_type, target_id, metadata FROM audit_events ORDER BY request_id');
    expect(events.rows).toEqual([
      expect.objectContaining({ request_id: 'change-integration', actor_type: 'USER', actor_user_id: actor.id, action: 'USER_CHANGE', outcome: 'SUCCESS', target_type: 'user', target_id: target.id, metadata: expect.objectContaining({ change: 'approve', status: 'APPROVED' }) }),
      expect.objectContaining({ request_id: 'session-integration', actor_type: 'USER', actor_user_id: target.id, action: 'SESSION_SYNC', outcome: 'SUCCESS' }),
    ]);
  });
  it('rolls back initial registration and subsequent profile/login updates when session auditing fails', async () => {
    const identity = { subject: 'rollback-profile', email: 'original@example.test', displayName: 'Original' };
    const existing = await repository.authenticate(identity);
    const before = (await database.pool.query('SELECT * FROM users WHERE id=$1', [existing.id])).rows;
    await rejectAuditWrites(async () => {
      await expect(repository.authenticate({ ...identity, subject: 'new-failed-registration' }, { requestId: 'failed-registration' })).rejects.toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
      await expect(repository.authenticate({ ...identity, email: 'changed@example.test', displayName: 'Changed' }, { requestId: 'failed-refresh' })).rejects.toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
    });
    expect(await repository.findBySubject('new-failed-registration')).toBeNull();
    expect((await database.pool.query('SELECT * FROM users WHERE id=$1', [existing.id])).rows).toEqual(before);
    expect((await database.pool.query('SELECT COUNT(*)::int AS count FROM audit_events')).rows[0].count).toBe(0);
  });
  it('rolls back status and approval metadata when the associated audit insert fails', async () => {
    const actor = await admin('rollback-owner');
    const target = await repository.authenticate({ subject: 'rollback-target', email: 'target@example.test', displayName: 'Target' });
    const before = (await database.pool.query('SELECT * FROM users WHERE id=$1', [target.id])).rows;
    await rejectAuditWrites(async () => {
      await expect(repository.change(actor.id, target.id, { action: 'approve' }, { requestId: 'failed-change' })).rejects.toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
    });
    expect((await database.pool.query('SELECT * FROM users WHERE id=$1', [target.id])).rows).toEqual(before);
    expect((await database.pool.query('SELECT COUNT(*)::int AS count FROM audit_events')).rows[0].count).toBe(0);
  });
  it('deploys the complete committed migration chain and safely repeats deploy', async () => {
    const directories = await readdir(new URL('../prisma/migrations/', import.meta.url), { withFileTypes: true });
    const expected = directories.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    await deployMigrations(database.migrationUrl);
    const migrations = await database.pool.query('SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name');
    expect(migrations.rows.map(row => row.migration_name)).toEqual(expected);
    expect(migrations.rows.every(row => row.finished_at && !row.rolled_back_at)).toBe(true);
  }, 60_000);
  it('isolates simultaneous schemas and removes the temporary schema on cleanup', async () => {
    const other = await createTestDatabase(testUrl);
    try {
      await repository.authenticate({ subject: 'isolated', email: '', displayName: 'Isolated' });
      expect((await other.pool.query('SELECT COUNT(*)::int AS count FROM "users"')).rows[0].count).toBe(0);
    } finally { await other.cleanup(); }
    const result = await database.pool.query('SELECT schema_name FROM information_schema.schemata WHERE schema_name=$1', [other.schema]);
    expect(result.rows).toEqual([]);
  }, 60_000);
  it('seeds synthetic actors idempotently without creating business records', async () => {
    const client = database.createClient();
    try { await seedSyntheticUsers(client); await seedSyntheticUsers(client); }
    finally { await client.$disconnect(); }
    const actors = await database.pool.query('SELECT sso_subject, role, status FROM "users" ORDER BY sso_subject');
    expect(actors.rows).toEqual([...SYNTHETIC_USERS].sort((a, b) => a.subject.localeCompare(b.subject)).map(actor => ({ sso_subject: actor.subject, role: actor.role, status: actor.status })));
  });
  it('removes the temporary schema when migration setup fails', async () => {
    let failedSchema = '';
    await expect(createTestDatabase(testUrl, async url => {
      failedSchema = new URL(url).searchParams.get('schema')!;
      throw new Error('Injected migration failure');
    })).rejects.toThrow('Injected migration failure');
    expect(failedSchema).toMatch(/^planning_test_[a-f0-9]{32}$/);
    expect((await database.pool.query('SELECT schema_name FROM information_schema.schemata WHERE schema_name=$1', [failedSchema])).rows).toEqual([]);
  });
});
