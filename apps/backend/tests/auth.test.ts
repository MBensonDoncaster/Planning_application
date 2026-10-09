import { syntheticAudit } from './support/audit.js';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import { readConfig } from '../src/config/env.js';
import { createIdentityVerifier } from '../src/plugins/auth.js';
import { createApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';
import type { UserRepository } from '../src/modules/users/types.js';
import type { User } from '../src/modules/users/types.js';
import { randomUUID } from 'node:crypto';

const tenant = '11111111-1111-4111-8111-111111111111';
const api = '22222222-2222-4222-8222-222222222222';
const spa = '33333333-3333-4333-8333-333333333333';
const oid = '44444444-4444-4444-8444-444444444444';
const config = readConfig({ NODE_ENV: 'test', AUTH_MODE: 'ENTRA', DATABASE_URL: 'postgresql://test:test@localhost/test', ENTRA_TENANT_ID: tenant, ENTRA_API_CLIENT_ID: api, ENTRA_SPA_CLIENT_ID: spa, ENTRA_SCOPE: `api://${api}/access_as_user` });
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let verify: ReturnType<typeof createIdentityVerifier>;
let app: FastifyInstance | undefined;
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  const jwk = await exportJWK(keys.publicKey);
  verify = createIdentityVerifier(config, createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256' }] }));
});
afterEach(async () => { await app?.close(); app = undefined; });
async function token(overrides: Record<string, unknown> = {}, privateKey = keys.privateKey) {
  return new SignJWT({ ver: '2.0', tid: tenant, oid, azp: spa, scp: 'access_as_user', preferred_username: 'ada@example.test', name: 'Ada', ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(`https://login.microsoftonline.com/${tenant}/v2.0`)
    .setAudience(api).setIssuedAt().setNotBefore('0s').setExpirationTime('5m').sign(privateKey);
}

function localRepository() {
  const records = new Map<string, User>();
  let refreshes = 0;
  const repo: UserRepository = {
    async authenticate(identity) {
      refreshes++;
      const existing = records.get(identity.subject);
      const now = new Date();
      const user = existing ?? { ...identity, id: randomUUID(), role: 'USER', status: 'PENDING', createdAt: now, updatedAt: now,
        lastLoginAt: null, approvedAt: null, approvedByUserId: null } satisfies User;
      Object.assign(user, identity, { lastLoginAt: now, updatedAt: now });
      records.set(identity.subject, user);
      return user;
    },
    async findBySubject(subject) { return records.get(subject) ?? null; },
    async list() { return { users: [...records.values()], total: records.size }; },
    async change() { throw new Error('Unexpected user change'); },
    async ready() {}, async close() {},
  };
  return { repo, records, refreshes: () => refreshes };
}

describe('Entra token validation', () => {
  it('keys identity by immutable tenant and object ID', async () => {
    expect(await verify(await token())).toEqual({ subject: `entra:${tenant}:${oid}`, email: 'ada@example.test', displayName: 'Ada' });
  });
  it.each([
    { tid: spa }, { azp: api }, { scp: 'different_scope' }, { scp: undefined }, { oid: undefined }, { ver: '1.0' },
    { aud: spa }, { iss: 'https://attacker.example' }, { exp: 1 },
  ])('rejects incompatible or expired claims: %j', async claims => {
    // Override standard registered claims after constructing the normal token.
    const signed = await new SignJWT({ ver: '2.0', tid: tenant, oid, azp: spa, scp: 'access_as_user', iss: `https://login.microsoftonline.com/${tenant}/v2.0`, aud: api, iat: Math.floor(Date.now() / 1000), nbf: 0, exp: Math.floor(Date.now() / 1000) + 300, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(keys.privateKey);
    await expect(verify(signed)).rejects.toMatchObject({ statusCode: 401 });
  });
  it('rejects a forged signature', async () => {
    const attacker = await generateKeyPair('RS256');
    await expect(verify(await token({}, attacker.privateKey))).rejects.toMatchObject({ statusCode: 401 });
  });
  it('rejects missing and invalid credentials before creating a database user', async () => {
    let creations = 0;
    const repo = { authenticate: async () => { creations++; throw new Error('Unexpected DB access'); }, close: async () => {} } as unknown as UserRepository;
    app = await createApp(config, repo, verify, syntheticAudit().audit);
    expect((await app.inject('/api/v1/auth/config')).statusCode).toBe(200);
    expect((await app.inject('/api/v1/auth/me')).statusCode).toBe(401);
    const invalid = await app.inject({ url: '/api/v1/auth/me', headers: { authorization: 'Bearer invalid' } });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json().error.code).toBe('INVALID_CREDENTIALS');
    expect(invalid.json().error.requestId).toBe(invalid.headers['x-request-id']);
    expect(creations).toBe(0);
  });

  it('registers and refreshes profiles only through the session endpoint', async () => {
    const fixture = localRepository();
    app = await createApp(config, fixture.repo, verify, syntheticAudit().audit);
    const bearer = await token();
    const headers = { authorization: `Bearer ${bearer}` };
    const denied = await app.inject({ url: '/api/v1/home', headers });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('USER_NOT_APPROVED');
    expect(fixture.records.size).toBe(0);
    expect(fixture.refreshes()).toBe(0);

    const initial = await app.inject({ url: '/api/v1/auth/me', headers });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ user: { subject: `entra:${tenant}:${oid}`, role: 'USER', status: 'PENDING', displayName: 'Ada' }, capabilities: [] });
    const user = fixture.records.get(`entra:${tenant}:${oid}`)!;
    user.role = 'ADMIN'; user.status = 'APPROVED';
    user.approvedAt = new Date('2026-10-01T12:00:00.000Z');
    user.approvedByUserId = randomUUID();
    const previousLogin = user.lastLoginAt;
    const previousUpdated = user.updatedAt;
    const renamedHeaders = { authorization: `Bearer ${await token({ name: 'Ada Updated', preferred_username: 'updated@example.test' })}` };
    for (const url of ['/api/v1/home', '/api/v1/app/config', '/api/v1/admin/users']) {
      expect((await app.inject({ url, headers: renamedHeaders })).statusCode).toBe(200);
    }
    expect(fixture.refreshes()).toBe(1);
    expect(user.displayName).toBe('Ada');
    expect(user.email).toBe('ada@example.test');
    expect(user.lastLoginAt).toBe(previousLogin);
    expect(user.updatedAt).toBe(previousUpdated);

    const refreshed = await app.inject({ url: '/api/v1/auth/me', headers: renamedHeaders });
    expect(refreshed.json()).toMatchObject({ user: { id: user.id, role: 'ADMIN', status: 'APPROVED', displayName: 'Ada Updated', email: 'updated@example.test',
      approvedAt: '2026-10-01T12:00:00.000Z', approvedByUserId: user.approvedByUserId } });
    expect(fixture.refreshes()).toBe(2);
    expect(fixture.records.size).toBe(1);
  });

  it('immediately applies local disablement and demotion to the same signed token', async () => {
    const fixture = localRepository();
    app = await createApp(config, fixture.repo, verify, syntheticAudit().audit);
    const headers = { authorization: `Bearer ${await token({ roles: ['ADMIN'], groups: ['administrators'] })}` };
    const session = await app.inject({ url: '/api/v1/auth/me', headers });
    expect(session.json().user).toMatchObject({ role: 'USER', status: 'PENDING' });
    const user = fixture.records.get(`entra:${tenant}:${oid}`)!;
    user.role = 'ADMIN'; user.status = 'APPROVED';
    expect((await app.inject({ url: '/api/v1/admin/users', headers })).statusCode).toBe(200);
    user.role = 'USER';
    expect((await app.inject({ url: '/api/v1/admin/users', headers })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/v1/home', headers })).statusCode).toBe(200);
    user.status = 'DISABLED';
    for (const url of ['/api/v1/home', '/api/v1/app/config', '/api/v1/admin/users']) {
      const response = await app.inject({ url, headers });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('USER_DISABLED');
    }
    const disabledSession = await app.inject({ url: '/api/v1/auth/me', headers });
    expect(disabledSession.json()).toMatchObject({ user: { status: 'DISABLED' }, capabilities: [] });
  });

  it('rejects API keys as credentials on existing human routes', async () => {
    const fixture = localRepository();
    app = await createApp(config, fixture.repo, verify, syntheticAudit().audit);
    for (const url of ['/api/v1/auth/me', '/api/v1/home', '/api/v1/app/config', '/api/v1/admin/users']) {
      const response = await app.inject({ url, headers: { 'x-api-key': 'synthetic-integration-key' } });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('AUTHENTICATION_REQUIRED');
    }
    expect(fixture.records.size).toBe(0);
    expect(fixture.refreshes()).toBe(0);
  });
});
