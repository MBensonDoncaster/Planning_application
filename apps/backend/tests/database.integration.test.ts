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
  beforeEach(async () => { await database.pool.query('TRUNCATE TABLE "users" CASCADE'); });
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
