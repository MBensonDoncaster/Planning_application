import { syntheticAudit } from './support/audit.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { MODULE_REGISTRY } from '@planning/contracts';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config/env.js';
import type { User, UserRepository } from '../src/modules/users/types.js';

const local = { NODE_ENV: 'test', AUTH_MODE: 'TEST_USER', DATABASE_URL: 'postgresql://test:private-password@localhost/test' };
const entra = { AUTH_MODE: 'ENTRA', ENTRA_TENANT_ID: randomUUID(), ENTRA_API_CLIENT_ID: randomUUID(), ENTRA_SPA_CLIENT_ID: randomUUID() };
const entraInput = { ...entra, ENTRA_SCOPE: `api://${entra.ENTRA_API_CLIENT_ID}/access_as_user` };
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

async function start(status: User['status'] = 'APPROVED', role: User['role'] = 'USER', extra: Record<string, unknown> = {}) {
  const user: User = { id: randomUUID(), subject: 'local:developer', email: 'dev@example.test', displayName: 'Developer', role, status,
    createdAt: new Date(), updatedAt: new Date(), lastLoginAt: null, approvedAt: null, approvedByUserId: null };
  const repo: UserRepository = { async authenticate() { return user; }, async findBySubject(subject) { return subject === user.subject ? user : null; }, async list() { return { users: [user], total: 1 }; }, async change() { return user; }, async ready() {}, async close() {} };
  const app = await createApp(readConfig({ ...local, ...extra }), repo, undefined, syntheticAudit().audit);
  apps.push(app);
  return app;
}

describe('runtime configuration', () => {
  it('uses the specified bounded defaults and only the Call for Sites module', async () => {
    const response = await (await start()).inject('/api/v1/app/config');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ appName: 'Planning', businessTimezone: 'Europe/London', limits: {
      ingestionMaxBodyBytes: 10485760, uploadMaxFileBytes: 5242880, zipMaxEntries: 1000, jsonMaxDepth: 100,
      geojsonMaxPositions: 100000, exportMaxSelection: 500, exportMaxBytes: 104857600,
      exportGenerationTimeoutMs: 30000, exportDownloadTimeoutMs: 120000, idempotencyRetentionDays: 30,
      apiKeyDefaultExpiryDays: 90, apiKeyMaxExpiryDays: 365,
    } });
    expect(response.json().enabledModules).toEqual(MODULE_REGISTRY);
    expect(MODULE_REGISTRY.map(module => module.id)).toEqual(['call-for-sites']);
    expect(MODULE_REGISTRY[0].integrationSafeCapabilities).toEqual(['call-for-sites.submit']);
    expect(Object.keys(response.json()).sort()).toEqual(['appName', 'businessTimezone', 'enabledModules', 'limits']);
    expect(response.body).not.toMatch(/private-password|DATABASE_URL|TEST_USER|ENTRA_|RATE_LIMIT/);
  });

  it.each(['PENDING', 'REJECTED', 'DISABLED'] as const)('denies configuration to %s even with ADMIN role', async status => {
    const response = await (await start(status, 'ADMIN')).inject('/api/v1/app/config');
    expect(response.statusCode).toBe(403);
    expect(response.json()).toHaveProperty('error.requestId');
    expect(response.json()).not.toHaveProperty('enabledModules');
  });

  it('requires authentication in Entra mode', async () => {
    expect((await (await start('APPROVED', 'ADMIN', entraInput)).inject('/api/v1/app/config')).statusCode).toBe(401);
  });

  it.each([0, -1, 1.5, '', 'not-a-number', Infinity])('rejects invalid numeric limits: %s', value => {
    expect(() => readConfig({ ...local, ZIP_MAX_ENTRIES: value })).toThrow();
  });
  it.each([
    { BUSINESS_TIMEZONE: 'Europe/Imaginary' }, { BUSINESS_TIMEZONE: '+01:00' },
    { EXPORT_MAX_SELECTION: 501 }, { API_KEY_MAX_EXPIRY_DAYS: 366 },
    { API_KEY_DEFAULT_EXPIRY_DAYS: 91, API_KEY_MAX_EXPIRY_DAYS: 90 },
    { EXPORT_GENERATION_TIMEOUT_MS: 121000 },
    { DEPLOYMENT_PROFILE: 'staging' }, { DEPLOYMENT_PROFILE: 'production' },
    { NODE_ENV: 'production', DEPLOYMENT_PROFILE: 'local' },
    { APP_ORIGIN: 'http://shared.example.test' },
    { ...entraInput, DEPLOYMENT_PROFILE: 'staging', APP_ORIGIN: 'http://shared.example.test' },
  ])('rejects invalid or insecure settings: %j', extra => {
    expect(() => readConfig({ ...local, ...extra })).toThrow();
  });

  it('never falls back to a test user when Entra values are missing', () => {
    expect(() => readConfig({ DATABASE_URL: local.DATABASE_URL })).toThrow('ENTRA_TENANT_ID');
  });

  it('changes public limits and identity configuration at runtime using the same app code', async () => {
    for (const [index, timezone] of ['Europe/London', 'America/New_York'].entries()) {
      const origin = `https://planning-${index}.example.test`;
      const clientId = randomUUID();
      const app = await start('APPROVED', 'ADMIN', { APP_NAME: `Planning ${index}`, BUSINESS_TIMEZONE: timezone, ZIP_MAX_ENTRIES: '25' });
      const response = await app.inject('/api/v1/app/config');
      expect(response.json()).toMatchObject({ appName: `Planning ${index}`, businessTimezone: timezone, limits: { zipMaxEntries: 25 } });
      const deployed = await start('APPROVED', 'ADMIN', { ...entraInput, ENTRA_SPA_CLIENT_ID: clientId, DEPLOYMENT_PROFILE: 'staging', APP_ORIGIN: origin, SERVE_FRONTEND: 'false' });
      expect((await deployed.inject('/api/v1/auth/config')).json()).toMatchObject({ clientId, redirectUri: origin });
    }
  });

  it('enforces the configured parser limit rather than the old 16 KiB default', async () => {
    const payload = JSON.stringify({ text: 'a'.repeat(20000) });
    for (const [limit, expected] of [[16384, 413], [30000, 400]]) {
      const app = await start('APPROVED', 'ADMIN', { INGESTION_MAX_BODY_BYTES: limit });
      expect((await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${randomUUID()}`, payload, headers: { 'content-type': 'application/json' } })).statusCode).toBe(expected);
    }
  });
});
