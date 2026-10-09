import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client.js';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const backendDirectory = fileURLToPath(new URL('../../', import.meta.url));
const schemaPattern = /^planning_test_[a-f0-9]{32}$/;

export function requireTestDatabase(value: string | undefined): URL {
  if (!value) throw new Error('Supply TEST_DATABASE_URL for an isolated PostgreSQL database ending in _test.');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !/^\/[A-Za-z0-9_]+_test$/.test(url.pathname)) {
    throw new Error('TEST_DATABASE_URL must point to an isolated PostgreSQL database ending in _test.');
  }
  // Callers choose a database, never an existing schema or search path.
  if (url.searchParams.has('schema') || url.searchParams.has('options')) {
    throw new Error('TEST_DATABASE_URL must not supply schema or search-path options.');
  }
  return url;
}

export async function runPrismaMigration(connectionString: string, args: string[]) {
  await execute(process.execPath, [require.resolve('prisma/build/index.js'), ...args], {
    cwd: backendDirectory, env: { ...process.env, DATABASE_URL: connectionString }, timeout: 60_000,
  });
}

export async function deployMigrations(connectionString: string) {
  await runPrismaMigration(connectionString, ['migrate', 'deploy']);
}

export async function createTestDatabase(value = process.env.TEST_DATABASE_URL, migrate = deployMigrations) {
  const url = requireTestDatabase(value);
  const schema = `planning_test_${randomUUID().replaceAll('-', '')}`;
  const control = new Pool({ connectionString: url.toString() });
  let pool: Pool | undefined;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      await pool?.end();
      if (!schemaPattern.test(schema)) throw new Error('Invalid generated test schema.');
      await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally { await control.end(); }
  };
  try {
    await control.query(`CREATE SCHEMA "${schema}"`);
    const migrationUrl = new URL(url);
    migrationUrl.searchParams.set('schema', schema);
    await migrate(migrationUrl.toString());
    url.searchParams.set('options', `-c search_path=${schema}`);
    pool = new Pool({ connectionString: url.toString() });
    return {
      schema, pool, connectionString: url.toString(), migrationUrl: migrationUrl.toString(), cleanup,
      createClient: () => new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }, { schema }) }),
    };
  } catch (error) { await cleanup(); throw error; }
}
export type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;
