import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config/env.js';
import { createUserRepository } from '../src/modules/users/repository.js';
import { createTestDatabase } from './support/database.js';
import { requireSyntheticSeed, seedSyntheticUsers } from './support/synthetic-users.js';

const config = readConfig({ ...process.env, APP_ORIGIN: 'http://127.0.0.1:4174', HOST: '127.0.0.1', PORT: '4174',
  DATABASE_URL: process.env.TEST_DATABASE_URL, TEST_USER_SUBJECT: 'local:synthetic-admin',
  TEST_USER_EMAIL: 'synthetic-admin@example.test', TEST_USER_NAME: 'Synthetic administrator',
  SERVE_FRONTEND: 'true', FRONTEND_DIST_DIR: fileURLToPath(new URL('../../frontend/dist/', import.meta.url)),
  RATE_LIMIT_MAX: '10000', LOG_LEVEL: 'silent' });
requireSyntheticSeed(config, process.env.TEST_DATABASE_URL);
let stopRequested = false;
let readyToStop: (() => Promise<void>) | undefined;
function requestStop() {
  stopRequested = true;
  if (readyToStop) void readyToStop();
}
// Track parent failure even while the migration CLI is still starting.
process.on('message', message => { if (message === 'stop') requestStop(); });
process.on('SIGTERM', requestStop);
process.on('SIGINT', requestStop);
process.on('disconnect', requestStop);
const database = await createTestDatabase();
const client = database.createClient();
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { if (app) await app.close(); else await client.$disconnect(); }
  finally { await database.cleanup(); }
  process.exitCode = 0;
  if (process.connected) process.disconnect();
}
try {
  if (!stopRequested) await seedSyntheticUsers(client);
  if (!stopRequested) {
    app = await createApp(config, createUserRepository(client));
    await app.listen({ host: config.HOST, port: config.PORT });
  }
  readyToStop = stop;
  if (stopRequested) await stop(); else process.send?.('ready');
} catch (error) { await stop(); throw error; }
