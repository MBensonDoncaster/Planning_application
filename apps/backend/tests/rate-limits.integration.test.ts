import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createApp } from '../src/app.js';
import type { User, UserRepository } from '../src/modules/users/types.js';
import { createIntegrationService, type IntegrationService } from '../src/modules/integrations/service.js';
import { syntheticAudit } from './support/audit.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { readConfig } from '../src/config/env.js';
import { createPostgresRateLimiter } from '../src/shared/rate-limits.js';
import { createTestDatabase, requireTestDatabase, type TestDatabase } from '../test/support/database.js';

const testUrl = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_TEST_DATABASE === '1') requireTestDatabase(testUrl);
let database: TestDatabase, first: PrismaClient, second: PrismaClient;
const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/test', AUTH_MODE: 'TEST_USER',
  RATE_LIMIT_WINDOW_MS: '86400000', RATE_LIMIT_USER_MAX: '7', RATE_LIMIT_WRITE_MAX: '3', RATE_LIMIT_KEY_MAX: '4', RATE_LIMIT_INTEGRATION_IP_MAX: '6' });

describe.skipIf(!testUrl)('shared PostgreSQL rate-limit buckets', () => {
  beforeAll(async () => { database = await createTestDatabase(testUrl); first = database.createClient(); second = database.createClient(); }, 60_000);
  beforeEach(async () => { await first.rateLimitBucket.deleteMany(); });
  afterAll(async () => { await first?.$disconnect(); await second?.$disconnect(); await database?.cleanup(); });

  it('enforces one atomic limit across two independent application connections', async () => {
    const a = createPostgresRateLimiter(first, config), b = createPostgresRateLimiter(second, config);
    const subject = randomUUID();
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? a : b).consume('USER', subject)));
    expect(results.filter(result => result.allowed)).toHaveLength(7);
    expect(results.filter(result => !result.allowed)).toHaveLength(13);
    for (const result of results.filter(result => !result.allowed)) {
      expect(result.retryAfter).toBeGreaterThan(0);
      expect(result.retryAfter).toBeLessThanOrEqual(86400);
      expect(Number.isInteger(result.retryAfter)).toBe(true);
    }
    expect(await first.rateLimitBucket.count()).toBe(1);
  });
  it.each([['USER', 7], ['USER_WRITE', 3], ['API_KEY', 4], ['INTEGRATION_IP', 6]] as const)(
    'enforces the configured %s limit of %s', async (scope, limit) => {
      const limiter = createPostgresRateLimiter(first, config);
      const subject = randomUUID();
      for (let index = 0; index < limit; index++) expect((await limiter.consume(scope, subject)).allowed).toBe(true);
      expect((await limiter.consume(scope, subject)).allowed).toBe(false);
    },
  );
  it('isolates principals and scopes and stores only digests of identifiers', async () => {
    const limiter = createPostgresRateLimiter(first, config);
    const privateAddress = '203.0.113.42';
    const privateKeyId = randomUUID();
    await limiter.consume('INTEGRATION_IP', privateAddress);
    await limiter.consume('API_KEY', privateKeyId);
    await limiter.consume('USER', privateKeyId);
    await limiter.consume('API_KEY', randomUUID());
    const buckets = await first.rateLimitBucket.findMany();
    expect(buckets).toHaveLength(4);
    for (const bucket of buckets) expect(bucket.subjectDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(buckets, (_key, value) => typeof value === 'bigint' ? value.toString() : value)).not.toContain(privateAddress);
    expect(JSON.stringify(buckets, (_key, value) => typeof value === 'bigint' ? value.toString() : value)).not.toContain(privateKeyId);
  });
  it('opens a fresh persisted budget at the next database-clock window', async () => {
    const limiter = createPostgresRateLimiter(first, { ...config, RATE_LIMIT_WINDOW_MS: 100, RATE_LIMIT_USER_MAX: 1 });
    const subject = randomUUID();
    expect((await limiter.consume('USER', subject)).allowed).toBe(true);
    const bucket = await first.rateLimitBucket.findFirstOrThrow();
    // Wait past the database-selected boundary rather than relying on the application clock.
    const clock = await database.pool.query<{ remaining: number }>('SELECT GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp())) * 1000)::integer AS remaining', [bucket.expiresAt]);
    await new Promise(resolve => setTimeout(resolve, clock.rows[0].remaining + 20));
    expect((await limiter.consume('USER', subject)).allowed).toBe(true);
    const newest = await first.rateLimitBucket.findFirstOrThrow({ orderBy: { windowStart: 'desc' } });
    expect(newest.windowStart.getTime()).toBeGreaterThan(bucket.windowStart.getTime());
    expect(newest.count).toBe(1n);
  });
  it('fails closed when PostgreSQL bucket access fails', async () => {
    const limiter = createPostgresRateLimiter(second, config);
    await database.pool.query('ALTER TABLE rate_limit_buckets RENAME TO rate_limit_buckets_unavailable');
    try {
      await expect(limiter.consume('USER', randomUUID())).rejects.toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
    } finally { await database.pool.query('ALTER TABLE rate_limit_buckets_unavailable RENAME TO rate_limit_buckets'); }
  });
  it.each(['INTEGRATION_IP', 'API_KEY', 'USER', 'USER_WRITE'] as const)('shares the %s HTTP budget across two app instances and blocks excess dispatch', async scope => {
    const user: User = { id: randomUUID(), subject: 'local:developer', email: 'synthetic@example.test', displayName: 'Synthetic', role: 'ADMIN', status: 'APPROVED', createdAt: new Date(), updatedAt: new Date(), lastLoginAt: null, approvedAt: null, approvedByUserId: null };
    let dispatched = 0;
    const users: UserRepository = { async authenticate() { return user; }, async findBySubject() { return user; }, async list() { dispatched++; return { users: [], total: 0 }; }, async change() { dispatched++; return user; }, async ready() {}, async close() {} };
    const keyId = randomUUID(), integrationId = randomUUID();
    const integrations = { async authenticateKey() { return { type: 'INTEGRATION' as const, keyId, integrationId, capabilities: ['call-for-sites.submit'] }; } } as unknown as IntegrationService;
    const selected = { ...config, RATE_LIMIT_USER_MAX: scope === 'USER' ? 3 : 100, RATE_LIMIT_WRITE_MAX: scope === 'USER_WRITE' ? 3 : 100,
      RATE_LIMIT_KEY_MAX: scope === 'API_KEY' ? 3 : 100, RATE_LIMIT_INTEGRATION_IP_MAX: scope === 'INTEGRATION_IP' ? 3 : 100 };
    const externalSubmission = async (_request: FastifyRequest, reply: FastifyReply) => { dispatched++; return reply.code(202).send({ accepted: true }); };
    const a = await createApp(selected, users, undefined, syntheticAudit().audit, integrations, { rateLimiter: createPostgresRateLimiter(first, selected), externalSubmission });
    const b = await createApp(selected, users, undefined, syntheticAudit().audit, integrations, { rateLimiter: createPostgresRateLimiter(second, selected), externalSubmission });
    try {
      const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => {
        const app = index % 2 ? a : b;
        if (scope === 'USER') return app.inject('/api/v1/admin/users');
        if (scope === 'USER_WRITE') return app.inject({ method: 'POST', url: `/api/v1/admin/users/${randomUUID()}/approve` });
        return app.inject({ method: 'POST', url: '/api/v1/integrations/call-for-sites/submissions', headers: { 'x-api-key': 'synthetic-key', 'idempotency-key': randomUUID() }, payload: {} });
      }));
      expect(responses.filter(response => response.statusCode < 300)).toHaveLength(3);
      const denied = responses.filter(response => response.statusCode === 429);
      expect(denied).toHaveLength(17);
      expect(dispatched).toBe(3);
      for (const response of denied) {
        expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
        expect(response.json().error.code).toBe('RATE_LIMITED');
      }
    } finally { await a.close(); await b.close(); }
  });
  it('persists real key authentication before malformed JSON is rejected', async () => {
    const { ssoSubject, ...stored } = await first.user.create({ data: { ssoSubject: `local:${randomUUID()}`, email: 'synthetic@example.test', displayName: 'Synthetic', role: 'ADMIN', status: 'APPROVED' } });
    const user: User = { ...stored, subject: ssoSubject };
    const service = createIntegrationService(first, config);
    const administrator = { type: 'USER' as const, user };
    const integration = await service.create(administrator, { name: `Synthetic ${randomUUID()}` }, { requestId: randomUUID() });
    const key = await service.createKey(administrator, integration.id, { label: 'Synthetic', capabilities: ['call-for-sites.submit'] }, { requestId: randomUUID() });
    const users: UserRepository = { async authenticate() { return user; }, async findBySubject() { return user; }, async list() { return { users: [], total: 0 }; }, async change() { return user; }, async ready() {}, async close() {} };
    let dispatched = false;
    const app = await createApp(config, users, undefined, syntheticAudit().audit, service, { rateLimiter: createPostgresRateLimiter(first, config), externalSubmission: async () => { dispatched = true; } });
    try {
      expect((await first.apiKey.findUniqueOrThrow({ where: { id: key.key.id } })).lastUsedAt).toBeNull();
      const response = await app.inject({ method: 'POST', url: '/api/v1/integrations/call-for-sites/submissions', headers: { 'x-api-key': key.secret, 'idempotency-key': randomUUID(), 'content-type': 'application/json' }, payload: '{invalid' });
      expect(response.statusCode).toBe(400);
      expect(dispatched).toBe(false);
      expect((await first.apiKey.findUniqueOrThrow({ where: { id: key.key.id } })).lastUsedAt).toBeInstanceOf(Date);
      expect(response.body).not.toContain(key.secret);
    } finally { await app.close(); }
  });
});
