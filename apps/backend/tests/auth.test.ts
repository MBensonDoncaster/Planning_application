import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import { readConfig } from '../src/config/env.js';
import { createIdentityVerifier } from '../src/plugins/auth.js';
import { createApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';
import type { UserRepository } from '../src/modules/users/types.js';

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
    app = await createApp(config, repo, verify);
    expect((await app.inject('/api/v1/auth/config')).statusCode).toBe(200);
    expect((await app.inject('/api/v1/auth/me')).statusCode).toBe(401);
    const invalid = await app.inject({ url: '/api/v1/auth/me', headers: { authorization: 'Bearer invalid' } });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json().error.code).toBe('INVALID_CREDENTIALS');
    expect(invalid.json().error.requestId).toBe(invalid.headers['x-request-id']);
    expect(creations).toBe(0);
  });
});
