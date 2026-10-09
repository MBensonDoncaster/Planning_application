import { syntheticAudit } from './support/audit.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ROLE_CAPABILITIES } from '@planning/contracts';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config/env.js';
import { applyChange, requireAdmin, AppError } from '../src/modules/users/service.js';
import type { User, UserRepository } from '../src/modules/users/types.js';

const baseUser = (): User => ({
  id: randomUUID(), subject: 'local:developer', email: 'dev@example.test', displayName: 'Developer',
  role: 'USER', status: 'PENDING', createdAt: new Date(), updatedAt: new Date(),
  lastLoginAt: null, approvedAt: null, approvedByUserId: null,
});
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(a => a.close())); });

function fixture(user = baseUser()) {
  const records = new Map([[user.id, user]]);
  const repo: UserRepository = {
    async authenticate(identity) { const existing = records.get(user.id)!; Object.assign(existing, identity); return existing; },
    async findBySubject(subject) { return [...records.values()].find(record => record.subject === subject) ?? null; },
    async list() { return { users: [...records.values()], total: records.size }; },
    async change(actorId, targetId, change) {
      requireAdmin(records.get(actorId)!);
      const target = records.get(targetId);
      if (!target) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
      const count = [...records.values()].filter(u => u.status === 'APPROVED' && u.role === 'ADMIN').length;
      Object.assign(target, applyChange(target, change, count, actorId));
      return target;
    },
    async ready() {}, async close() {},
  };
  return { user, records, repo };
}
async function start(repo: UserRepository) {
  const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/test', AUTH_MODE: 'TEST_USER' });
  const app = await createApp(config, repo, undefined, syntheticAudit().audit);
  apps.push(app);
  return app;
}

describe('server-side access control', () => {
  it.each((['USER', 'ADMIN'] as const).flatMap(role =>
    (['PENDING', 'APPROVED', 'REJECTED', 'DISABLED'] as const).map(status => ({ role, status }))))(
    'returns current capabilities and enforces all existing protected routes for $role/$status', async ({ role, status }) => {
      const { user, repo } = fixture({ ...baseUser(), role, status });
      const app = await start(repo);
      const session = await app.inject('/api/v1/auth/me');
      expect(session.statusCode).toBe(200);
      expect(session.json()).toMatchObject({ user: { id: user.id, role, status }, capabilities: status === 'APPROVED' ? ROLE_CAPABILITIES[role] : [] });
      for (const url of ['/api/v1/home', '/api/v1/app/config']) {
        expect((await app.inject(url)).statusCode).toBe(status === 'APPROVED' ? 200 : 403);
      }
      const adminAllowed = role === 'ADMIN' && status === 'APPROVED';
      expect((await app.inject('/api/v1/admin/users')).statusCode).toBe(adminAllowed ? 200 : 403);
      // A valid UUID with no local target distinguishes an authorised write (404)
      // from a denied request (403), without changing access state.
      const write = await app.inject({ method: 'POST', url: `/api/v1/admin/users/${randomUUID()}/approve` });
      expect(write.statusCode).toBe(adminAllowed ? 404 : 403);
    },
  );

  it('reads current local access without refreshing the profile or login timestamp', async () => {
    const { user, repo } = fixture({ ...baseUser(), role: 'ADMIN', status: 'APPROVED' });
    let refreshes = 0;
    const authenticate = repo.authenticate;
    repo.authenticate = async identity => { refreshes++; return authenticate(identity); };
    const app = await start(repo);
    for (const url of ['/api/v1/home', '/api/v1/app/config', '/api/v1/admin/users']) {
      expect((await app.inject(url)).statusCode).toBe(200);
    }
    expect(refreshes).toBe(0);
    expect(user.lastLoginAt).toBeNull();
    expect((await app.inject('/api/v1/auth/me')).statusCode).toBe(200);
    expect(refreshes).toBe(1);
  });

  it('does not register an unknown local identity on protected requests', async () => {
    const { repo, records } = fixture();
    records.clear();
    repo.authenticate = async () => { throw new Error('Protected reads must not register a user'); };
    const app = await start(repo);
    for (const url of ['/api/v1/home', '/api/v1/app/config', '/api/v1/admin/users']) {
      const response = await app.inject(url);
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('USER_NOT_APPROVED');
    }
    expect(records.size).toBe(0);
  });
  it.each(['PENDING', 'REJECTED', 'DISABLED'] as const)('blocks %s accounts even when they have ADMIN role', async status => {
    const { repo } = fixture({ ...baseUser(), role: 'ADMIN', status });
    const app = await start(repo);
    expect((await app.inject('/api/v1/auth/me')).statusCode).toBe(200);
    expect((await app.inject('/api/v1/home')).statusCode).toBe(403);
    expect((await app.inject('/api/v1/admin/users')).statusCode).toBe(403);
  });
  it('allows an approved USER onto the homepage but rejects direct admin API calls', async () => {
    const { repo } = fixture({ ...baseUser(), status: 'APPROVED' });
    const app = await start(repo);
    expect((await app.inject('/api/v1/home')).statusCode).toBe(200);
    expect((await app.inject('/api/v1/admin/users')).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/users/${randomUUID()}/approve` })).statusCode).toBe(403);
  });
  it('assigns a role separately from approval and records the approving admin', async () => {
    const { user, repo, records } = fixture({ ...baseUser(), role: 'ADMIN', status: 'APPROVED' });
    const target = baseUser(); records.set(target.id, target);
    const app = await start(repo);
    const change = (payload: { action: string; role?: string }) => app.inject({ method: payload.action === 'role' ? 'PATCH' : 'POST', url: `/api/v1/admin/users/${target.id}/${payload.action}`, ...(payload.action === 'role' ? { payload: { role: payload.role } } : {}) });
    expect((await change({ action: 'role', role: 'ADMIN' })).json().status).toBe('PENDING');
    const approved = (await change({ action: 'approve' })).json();
    expect(approved.status).toBe('APPROVED');
    expect(approved.approvedByUserId).toBe(user.id);
    expect(approved.approvedAt).toBeTruthy();
    expect((await change({ action: 'reject' })).statusCode).toBe(409);
    expect((await change({ action: 'disable' })).json().status).toBe('DISABLED');
    expect((await change({ action: 'enable' })).json().status).toBe('PENDING');
  });
  it('protects the last approved administrator', async () => {
    const { user, repo } = fixture({ ...baseUser(), role: 'ADMIN', status: 'APPROVED' });
    const app = await start(repo);
    for (const payload of [{ action: 'disable' }, { action: 'role', role: 'USER' }]) {
      const result = await app.inject({ method: payload.action === 'role' ? 'PATCH' : 'POST', url: `/api/v1/admin/users/${user.id}/${payload.action}`, ...(payload.action === 'role' ? { payload: { role: payload.role } } : {}) });
      expect(result.statusCode).toBe(409);
      expect(result.json().error.code).toBe('LAST_APPROVED_ADMIN');
    }
  });
  it('uses the current database status on subsequent requests', async () => {
    const { user, repo } = fixture({ ...baseUser(), role: 'ADMIN', status: 'APPROVED' });
    const app = await start(repo);
    expect((await app.inject('/api/v1/admin/users')).statusCode).toBe(200);
    user.status = 'DISABLED';
    expect((await app.inject('/api/v1/admin/users')).statusCode).toBe(403);
  });
  it('validates the explicit action contracts and fixed pagination before writes', async () => {
    const { user, repo, records } = fixture({ ...baseUser(), role: 'ADMIN', status: 'APPROVED' });
    const target = baseUser(); records.set(target.id, target);
    const app = await start(repo);
    const listing = await app.inject('/api/v1/admin/users?page=2&status=PENDING&role=USER&text=developer');
    expect(listing.json()).toMatchObject({ page: 2, pageSize: 50 });
    for (const query of ['pageSize=20', 'search=legacy', 'role=OWNER', `text=${'a'.repeat(201)}`]) {
      expect((await app.inject(`/api/v1/admin/users?${query}`)).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/users/${target.id}/approve`, payload: {} })).statusCode).toBe(400);
    expect(target.status).toBe('PENDING');
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${target.id}`, payload: { action: 'approve' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${target.id}/role`, payload: { role: 'ADMIN', status: 'APPROVED' } })).statusCode).toBe(400);
    expect(user.status).toBe('APPROVED');
  });
  it('rejects invalid changes and returns readiness failures without database details', async () => {
    const { user, repo } = fixture({ ...baseUser(), role: 'ADMIN', status: 'APPROVED' });
    repo.ready = async () => { throw new Error('database credentials'); };
    const app = await start(repo);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${user.id}/role`, payload: { role: 'SUPERADMIN' } })).statusCode).toBe(400);
    const result = await app.inject('/health/ready');
    expect(result.statusCode).toBe(503);
    expect(result.body).not.toContain('credentials');
    expect((await app.inject('/health')).statusCode).toBe(200);
  });
});

describe('configuration', () => {
  it('rejects production test identities', () => {
    expect(() => readConfig({ NODE_ENV: 'production', AUTH_MODE: 'TEST_USER', DATABASE_URL: 'postgresql://test:test@localhost/test' })).toThrow('Production requires AUTH_MODE=ENTRA');
  });
  it('requires per-app Entra identifiers', () => {
    expect(() => readConfig({ AUTH_MODE: 'ENTRA', DATABASE_URL: 'postgresql://test:test@localhost/test' })).toThrow('ENTRA_TENANT_ID');
  });
});

describe('user transition rules', () => {
  it.each(['DISABLED', 'REJECTED'] as const)('reopens %s to pending and requires fresh separate approval', status => {
    const target = { ...baseUser(), role: 'ADMIN' as const, status, approvedAt: new Date(), approvedByUserId: randomUUID() };
    expect(() => applyChange(target, { action: 'approve' }, 2, 'actor')).toThrow('not available');
    const reopened = { ...target, ...applyChange(target, { action: 'enable' }, 2, 'actor') };
    expect(reopened).toMatchObject({ role: 'ADMIN', status: 'PENDING', approvedAt: null, approvedByUserId: null });
    expect(() => requireAdmin(reopened)).toThrow();
    expect(applyChange(reopened, { action: 'approve' }, 2, 'fresh-actor')).toMatchObject({ status: 'APPROVED', approvedByUserId: 'fresh-actor', approvedAt: expect.any(Date) });
  });
  it('role changes preserve status and approval history while last-admin demotion is blocked', () => {
    const target = { ...baseUser(), status: 'APPROVED' as const, approvedAt: new Date(), approvedByUserId: randomUUID() };
    expect(applyChange(target, { action: 'role', role: 'ADMIN' }, 1, 'actor')).toEqual({ role: 'ADMIN' });
    expect(() => applyChange({ ...target, role: 'ADMIN' }, { action: 'role', role: 'USER' }, 1, 'actor')).toThrow('last approved');
  });
});
