import { syntheticAudit } from './support/audit.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { isApiErrorEnvelope } from '@planning/contracts';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config/env.js';
import { AppError } from '../src/shared/errors.js';
import { installErrorHandler } from '../src/plugins/errors.js';
import type { User, UserRepository } from '../src/modules/users/types.js';

const apps: FastifyInstance[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function repository(): UserRepository {
  const user: User = {
    id: randomUUID(), subject: 'local:developer', email: 'dev@example.test', displayName: 'Developer',
    role: 'ADMIN', status: 'APPROVED', createdAt: new Date(), updatedAt: new Date(),
    lastLoginAt: null, approvedAt: new Date(), approvedByUserId: null,
  };
  return {
    async authenticate() { return user; },
    async findBySubject(subject) { return subject === user.subject ? user : null; },
    async list() { return { users: [user], total: 1 }; },
    async change() { return user; },
    async ready() {}, async close() {},
  };
}

async function start(repo = repository(), extra: Record<string, unknown> = {}) {
  const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/test', AUTH_MODE: 'TEST_USER', ...extra });
  const app = await createApp(config, repo, undefined, syntheticAudit().audit);
  apps.push(app);
  return app;
}

function expectError(response: Awaited<ReturnType<FastifyInstance['inject']>>, status: number, code: string) {
  expect(response.statusCode).toBe(status);
  expect(response.headers['content-type']).toContain('application/json');
  expect(response.headers['cache-control']).toBe('no-store');
  const body = response.json();
  expect(isApiErrorEnvelope(body)).toBe(true);
  expect(body.error.code).toBe(code);
  expect(body.error.requestId).toBeTruthy();
  expect(body.error.requestId).toBe(response.headers['x-request-id']);
  expect(body).not.toHaveProperty('code');
  return body.error;
}

describe('shared HTTP error contract', () => {
  it('returns safe parser errors for invalid and empty JSON', async () => {
    const app = await start();
    for (const payload of ['{"private-contact":', '']) {
      const response = await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${randomUUID()}/role`, headers: { 'content-type': 'application/json' }, payload });
      expectError(response, 400, 'VALIDATION_ERROR');
      expect(response.body).not.toContain('private-contact');
    }
  });

  it('returns bounded field details without echoing unknown keys or invalid values', async () => {
    const app = await start();
    const response = await app.inject('/api/v1/admin/users?page=-1&private-contact=secret');
    const error = expectError(response, 400, 'VALIDATION_ERROR');
    expect(error.details).toContainEqual({ path: 'page', message: 'The value is below the required minimum.' });
    expect(response.body).not.toContain('private-contact');
    expect(response.body).not.toContain('secret');
  });

  it('wraps authentication and access denials in the same contract', async () => {
    const app = await start(repository(), {
      AUTH_MODE: 'ENTRA', ENTRA_TENANT_ID: randomUUID(), ENTRA_API_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
      ENTRA_SPA_CLIENT_ID: randomUUID(), ENTRA_SCOPE: 'api://22222222-2222-4222-8222-222222222222/access_as_user',
    });
    expectError(await app.inject('/api/v1/auth/me'), 401, 'AUTHENTICATION_REQUIRED');
    const repo = repository();
    const user = await repo.authenticate({ subject: '', email: '', displayName: '' });
    user.status = 'DISABLED';
    const disabled = await start(repo);
    expectError(await disabled.inject('/api/v1/home'), 403, 'USER_DISABLED');
  });

  it('returns JSON 404s even without frontend serving', async () => {
    const app = await start();
    expectError(await app.inject({ url: '/api/v1/not-a-route', headers: { accept: 'text/html' } }), 404, 'NOT_FOUND');
  });

  it('normalises parser size, media type and content encoding failures', async () => {
    const app = await start(repository(), { INGESTION_MAX_BODY_BYTES: 16_384 });
    const url = `/api/v1/admin/users/${randomUUID()}/role`;
    expectError(await app.inject({ method: 'PATCH', url, headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ text: 'a'.repeat(16_384) }) }), 413, 'PAYLOAD_TOO_LARGE');
    expectError(await app.inject({ method: 'PATCH', url, headers: { 'content-type': 'application/xml' }, payload: '<secret/>' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
    expectError(await app.inject({ method: 'PATCH', url, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, payload: '{}' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  });

  it.each([
    [422, 'NO_EXPORTABLE_GEOMETRY', 'No exportable polygons were found.'],
    [503, 'EXPORT_TIMEOUT', 'Export generation timed out.'],
  ] as const)('preserves intentional %s errors and removes attachment headers', async (status, code, message) => {
    const app = Fastify({ logger: false });
    apps.push(app);
    installErrorHandler(app);
    app.get('/download', async (_request, reply) => {
      reply.type('application/zip').header('Content-Disposition', 'attachment; filename="boundaries.zip"').header('Content-Length', '999');
      throw new AppError(status, code, message, [{ path: 'ids', message: 'Check the selected records.' }]);
    });
    const response = await app.inject('/download');
    expect(expectError(response, status, code).message).toBe(message);
    expect(response.headers).not.toHaveProperty('content-disposition');
    expect(Number(response.headers['content-length'])).toBe(Buffer.byteLength(response.body));
  });

  it('hides unexpected errors and preserves safe service-unavailable responses', async () => {
    const repo = repository();
    repo.list = async () => { throw new Error('SQL password=secret applicant@example.test'); };
    repo.ready = async () => { throw new Error('Database credentials'); };
    const app = await start(repo);
    const failure = await app.inject('/api/v1/admin/users');
    expectError(failure, 500, 'INTERNAL_ERROR');
    expect(failure.body).not.toMatch(/SQL|password|secret|applicant|stack/);
    expectError(await app.inject('/health/ready'), 503, 'SERVICE_UNAVAILABLE');
    expect((await app.inject('/health')).statusCode).toBe(200);
  });

  it('does not echo arbitrary framework exception messages', async () => {
    const repo = repository();
    repo.list = async () => { throw Object.assign(new Error('private token and contact'), { statusCode: 400 }); };
    const app = await start(repo);
    const response = await app.inject('/api/v1/admin/users');
    expectError(response, 400, 'VALIDATION_ERROR');
    expect(response.body).not.toContain('private');
  });

  it('normalises throttling errors and retains Retry-After', async () => {
    const app = await start(repository(), { RATE_LIMIT_MAX: 1 });
    expect((await app.inject('/health')).statusCode).toBe(200);
    const response = await app.inject('/health');
    expectError(response, 429, 'RATE_LIMITED');
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('serves browser deep links while API, health and asset misses stay JSON', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'planning-frontend-'));
    directories.push(directory);
    await writeFile(join(directory, 'index.html'), '<html><body>Planning frontend</body></html>');
    const app = await start(repository(), { SERVE_FRONTEND: 'true', FRONTEND_DIST_DIR: directory });
    expect((await app.inject({ url: '/admin/users', headers: { accept: 'text/html' } })).body).toContain('Planning frontend');
    for (const url of ['/api', '/api/v1/missing', '/health/missing', '/assets/missing.js']) {
      expectError(await app.inject({ url, headers: { accept: 'text/html' } }), 404, 'NOT_FOUND');
    }
    expectError(await app.inject({ method: 'POST', url: '/admin/users', headers: { accept: 'text/html' } }), 404, 'NOT_FOUND');
  });
});
