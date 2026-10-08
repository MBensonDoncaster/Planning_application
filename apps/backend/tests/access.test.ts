import { randomUUID } from 'node:crypto';
import { describe, expect, it, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
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
  const app = await createApp(config, repo);
  apps.push(app);
  return app;
}

describe('server-side access control', () => {
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
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${randomUUID()}`, payload: { action: 'approve' } })).statusCode).toBe(403);
  });
  it('assigns a role separately from approval and records the approving admin', async () => {
    const { user, repo, records } = fixture({ ...baseUser(), role: 'ADMIN', status: 'APPROVED' });
    const target = baseUser(); records.set(target.id, target);
    const app = await start(repo);
    const change = (payload: unknown) => app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${target.id}`, payload: payload as object });
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
      const result = await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${user.id}`, payload });
      expect(result.statusCode).toBe(409);
      expect(result.json().code).toBe('LAST_ADMIN');
    }
  });
  it('uses the current database status on subsequent requests', async () => {
    const { user, repo } = fixture({ ...baseUser(), role: 'ADMIN', status: 'APPROVED' });
    const app = await start(repo);
    expect((await app.inject('/api/v1/admin/users')).statusCode).toBe(200);
    user.status = 'DISABLED';
    expect((await app.inject('/api/v1/admin/users')).statusCode).toBe(403);
  });
  it('rejects invalid changes and returns readiness failures without database details', async () => {
    const { user, repo } = fixture({ ...baseUser(), role: 'ADMIN', status: 'APPROVED' });
    repo.ready = async () => { throw new Error('database credentials'); };
    const app = await start(repo);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${user.id}`, payload: { action: 'role', role: 'SUPERADMIN' } })).statusCode).toBe(400);
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
