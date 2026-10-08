import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createUserRepository } from '../src/modules/users/repository.js';
import type { UserRepository } from '../src/modules/users/types.js';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';

const testUrl = process.env.TEST_DATABASE_URL;
const schema = `template_test_${randomUUID().replaceAll('-', '')}`;
let pool: Pool;
let repository: UserRepository;

describe.skipIf(!testUrl)('PostgreSQL repository integration', () => {
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!url.pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL must point to an isolated database ending in _test.');
    pool = new Pool({ connectionString: testUrl });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const setup = new Pool({ connectionString: url.toString() });
    try {
      const sql = await readFile(new URL('../prisma/migrations/20261008000000_initial_users/migration.sql', import.meta.url), 'utf8');
      await setup.query(sql);
    } finally { await setup.end(); }
    repository = createUserRepository(new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }, { schema }) }));
  });
  beforeEach(async () => { await pool.query(`TRUNCATE TABLE "${schema}"."users" CASCADE`); });
  afterAll(async () => {
    await repository?.close();
    if (pool) {
      // schema is generated locally above and restricted to a fixed prefix + hex.
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
  async function admin(subject: string) {
    const user = await repository.authenticate({ subject, email: `${subject}@example.test`, displayName: subject });
    await pool.query(`UPDATE "${schema}"."users" SET role='ADMIN', status='APPROVED', approved_at=NOW() WHERE id=$1`, [user.id]);
    return user;
  }
  it('registers once and preserves local access during subsequent profile updates', async () => {
    const identity = { subject: 'entra:tenant:object', email: 'ada@example.test', displayName: 'Ada' };
    const first = await repository.authenticate(identity);
    expect(first.status).toBe('PENDING'); expect(first.role).toBe('USER');
    await pool.query(`UPDATE "${schema}"."users" SET role='ADMIN', status='DISABLED' WHERE id=$1`, [first.id]);
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
    const count = await pool.query(`SELECT COUNT(*)::int AS count FROM "${schema}"."users" WHERE role='ADMIN' AND status='APPROVED'`);
    expect(count.rows[0].count).toBe(1);
  });
});
