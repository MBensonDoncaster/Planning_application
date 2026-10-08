import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { requireTestDatabase } from './support/database.js';

requireTestDatabase(process.env.TEST_DATABASE_URL);
const cli = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
const result = spawnSync(process.execPath, [cli, 'run', 'tests/database.integration.test.ts'], {
  stdio: 'inherit', env: process.env,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
