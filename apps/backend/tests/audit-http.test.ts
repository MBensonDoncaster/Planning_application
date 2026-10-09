import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { auditFailureLog } from '../src/plugins/audit.js';
import { readConfig } from '../src/config/env.js';
import type { User, UserRepository } from '../src/modules/users/types.js';
import type { AuditService } from '../src/shared/audit.js';
import { AppError } from '../src/shared/errors.js';
import { syntheticAudit } from './support/audit.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.restoreAllMocks(); });
function fixture(role: User['role'] = 'ADMIN', status: User['status'] = 'APPROVED') {
  const user: User = { id: randomUUID(), subject: 'local:developer', email: 'private@example.test', displayName: 'Private name', role, status,
    createdAt: new Date(), updatedAt: new Date(), lastLoginAt: null, approvedAt: null, approvedByUserId: null };
  const repo: UserRepository = {
    async authenticate() { return user; }, async findBySubject() { return user; },
    async list() { return { users: [user], total: 1 }; }, async change() { return user; }, async ready() {}, async close() {},
  };
  return { user, repo };
}
async function start(repo: UserRepository, audit?: AuditService, extra: Record<string, unknown> = {}) {
  const app = await createApp(readConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/test', AUTH_MODE: 'TEST_USER', ...extra }), repo, undefined, audit);
  apps.push(app);
  return app;
}
const failingAudit: AuditService = { async record() { throw new AppError(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable. Try again later.'); } };

describe('audited HTTP operations', () => {
  it.each([
    ['/api/v1/app/config', 'APP_CONFIG_READ'], ['/api/v1/home', 'HOME_READ'], ['/api/v1/admin/users', 'USERS_LIST'],
  ])('does not return a successful %s response when audit persistence fails', async (url) => {
    const app = await start(fixture().repo, failingAudit);
    const response = await app.inject(url);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: expect.objectContaining({ code: 'SERVICE_UNAVAILABLE', requestId: response.headers['x-request-id'] }) });
    expect(response.body).not.toContain('private@example.test');
    expect(response.json()).not.toHaveProperty('enabledModules');
    expect(response.json()).not.toHaveProperty('users');
    expect(response.json()).not.toHaveProperty('message');
  });
  it('fails closed when no audit dependency is supplied', async () => {
    const response = await (await start(fixture().repo)).inject('/api/v1/home');
    expect(response.statusCode).toBe(503);
  });
  it('records successful read attribution and request correlation before returning', async () => {
    const { user, repo } = fixture(); const { audit, events } = syntheticAudit();
    const response = await (await start(repo, audit)).inject('/api/v1/home');
    expect(response.statusCode).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ requestId: response.headers['x-request-id'], action: 'HOME_READ', module: 'shared', outcome: 'SUCCESS', actor: { type: 'USER', user: { id: user.id } } });
  });
  it('records denied permissions with the known local actor and attempted action', async () => {
    const { user, repo } = fixture('USER'); const { audit, events } = syntheticAudit();
    const response = await (await start(repo, audit)).inject('/api/v1/admin/users');
    expect(response.statusCode).toBe(403);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ requestId: response.headers['x-request-id'], action: 'USERS_LIST', outcome: 'DENIED', errorCode: 'FORBIDDEN', actor: { type: 'USER', user: { id: user.id } } });
  });
  it('retains a validated user target on failed changes and omits malformed targets', async () => {
    const { repo } = fixture();
    repo.change = async () => { throw new AppError(409, 'LAST_APPROVED_ADMIN', 'The last approved administrator cannot be disabled or demoted.'); };
    const { audit, events } = syntheticAudit();
    const app = await start(repo, audit);
    const targetId = randomUUID();
    const failed = await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${targetId}`, payload: { action: 'disable' } });
    expect(failed.statusCode).toBe(409);
    expect(events[0]).toMatchObject({ action: 'USER_CHANGE', outcome: 'FAILURE', errorCode: 'LAST_APPROVED_ADMIN', target: { type: 'user', id: targetId } });
    const invalid = await app.inject({ method: 'PATCH', url: '/api/v1/admin/users/private-contact', payload: { action: 'disable' } });
    expect(invalid.statusCode).toBe(400);
    expect(events[1]).not.toHaveProperty('target');
    expect(JSON.stringify(events)).not.toContain('private-contact');
  });
  it('does not replace the original permission error when failure auditing is unavailable', async () => {
    const response = await (await start(fixture('USER').repo, failingAudit)).inject('/api/v1/admin/users');
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });
  it('does not replace an original server error when failure auditing is unavailable', async () => {
    const { repo } = fixture(); repo.list = async () => { throw new Error('password=private applicant@example.test'); };
    const response = await (await start(repo, failingAudit)).inject('/api/v1/admin/users');
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toMatch(/password|applicant/);
  });
  it('uses UNKNOWN attribution for parsing failures before authentication and omits raw payloads', async () => {
    const { audit, events } = syntheticAudit();
    const app = await start(fixture().repo, audit);
    const response = await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${randomUUID()}`, headers: { 'content-type': 'application/json' }, payload: '{"contact":"private@example.test",' });
    expect(response.statusCode).toBe(400);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: null, outcome: 'FAILURE', errorCode: 'VALIDATION_ERROR', requestId: response.headers['x-request-id'] });
    expect(JSON.stringify(events)).not.toContain('private@example.test');
  });
  it('projects an operational fallback without profile attributes, payloads or unsafe exception text', () => {
    const { user } = fixture();
    const log = auditFailureLog({ requestId: 'safe-request', actor: { type: 'USER', user }, module: 'shared', action: 'USER_CHANGE', outcome: 'FAILURE', target: { type: 'user', id: randomUUID() }, errorCode: 'password=private-secret', metadata: { authorization: 'Bearer secret-token', url: '/secret?contact=private@example.test', rawPayload: 'private-contact' } }, 500);
    expect(log).toEqual({ requestId: 'safe-request', actorType: 'USER', module: 'shared', action: 'USER_CHANGE', outcome: 'FAILURE', errorCode: 'INTERNAL_ERROR', statusCode: 500, auditPersistence: 'unavailable' });
    expect(JSON.stringify(log)).not.toMatch(/private|secret|email|authorization|target|rawPayload|url/);
  });
  it('actually emits only the safe fallback projection when a failure cannot be audited', async () => {
    const app = await start(fixture('USER').repo, failingAudit);
    const warnings: unknown[][] = [];
    app.addHook('onRequest', async request => {
      vi.spyOn(request.log, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args); });
    });
    const response = await app.inject({ url: '/api/v1/admin/users?search=secret-contact', headers: { authorization: 'Bearer secret-token', 'x-api-key': 'secret-key' } });
    expect(response.statusCode).toBe(403);
    expect(warnings).toEqual([[{
      requestId: response.headers['x-request-id'], actorType: 'USER', module: 'shared', action: 'USERS_LIST', outcome: 'DENIED', errorCode: 'FORBIDDEN', statusCode: 403, auditPersistence: 'unavailable',
    }, 'Security event could not be persisted']]);
    expect(JSON.stringify(warnings)).not.toMatch(/secret-contact|secret-token|secret-key|private@example/);
  });
  it('records bounded search metadata without persisting the users search text', async () => {
    const { audit, events } = syntheticAudit();
    const response = await (await start(fixture().repo, audit)).inject('/api/v1/admin/users?search=secret-contact&page=2&pageSize=10&status=APPROVED');
    expect(response.statusCode).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'USERS_LIST', outcome: 'SUCCESS', metadata: { page: 2, pageSize: 10, status: 'APPROVED', resultCount: 1, queryLength: 14, queryHash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(JSON.stringify(events)).not.toContain('secret-contact');
  });
  it('records an authentication denial without inventing a user actor', async () => {
    const { audit, events } = syntheticAudit();
    const tenant = randomUUID(), api = randomUUID();
    const app = await start(fixture().repo, audit, { AUTH_MODE: 'ENTRA', ENTRA_TENANT_ID: tenant, ENTRA_API_CLIENT_ID: api, ENTRA_SPA_CLIENT_ID: randomUUID(), ENTRA_SCOPE: `api://${api}/access_as_user` });
    const response = await app.inject('/api/v1/home');
    expect(response.statusCode).toBe(401);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: null, action: 'HOME_READ', outcome: 'DENIED', errorCode: 'AUTHENTICATION_REQUIRED' });
  });
});
