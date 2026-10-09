import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config/env.js';
import type { User, UserRepository } from '../src/modules/users/types.js';
import { AppError } from '../src/shared/errors.js';
import { syntheticAudit } from './support/audit.js';

function fixture() {
  const user: User = { id: randomUUID(), subject: 'local:developer', email: 'private@example.test', displayName: 'Private name', role: 'ADMIN', status: 'APPROVED',
    createdAt: new Date(), updatedAt: new Date(), lastLoginAt: null, approvedAt: null, approvedByUserId: null };
  const repo: UserRepository = { authenticate: vi.fn(), findBySubject: vi.fn(async () => ({ ...user })), list: vi.fn(), change: vi.fn(), ready: vi.fn(), close: vi.fn() };
  const list = vi.fn().mockResolvedValue({ events: [], total: 0, page: 1, pageSize: 50 });
  const { audit, events } = syntheticAudit();
  const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/test', AUTH_MODE: 'TEST_USER' });
  return { user, repo, list, audit, events, config };
}

describe('audit review in the application authentication boundary', () => {
  it('consults current local access and denies a demoted or disabled administrator on the next read', async () => {
    const { user, repo, list, audit, events, config } = fixture();
    const app = await createApp(config, repo, undefined, audit, undefined, { auditReview: { list } });
    try {
      expect((await app.inject('/api/v1/admin/audit-events')).statusCode).toBe(200);
      user.role = 'USER';
      expect((await app.inject('/api/v1/admin/audit-events')).statusCode).toBe(403);
      user.role = 'ADMIN'; user.status = 'DISABLED';
      expect((await app.inject('/api/v1/admin/audit-events')).statusCode).toBe(403);
      expect(list).toHaveBeenCalledTimes(1);
      expect(repo.findBySubject).toHaveBeenCalledTimes(3);
      expect(repo.authenticate).not.toHaveBeenCalled();
      expect(events.map(event => [event.action, event.outcome, event.errorCode])).toEqual([
        ['AUDIT_EVENTS_LIST', 'DENIED', 'FORBIDDEN'], ['AUDIT_EVENTS_LIST', 'DENIED', 'USER_DISABLED'],
      ]);
    } finally { await app.close(); }
  });
  it('rejects API keys before audit data or current human identity is read', async () => {
    const { repo, list, audit, events, config } = fixture();
    const app = await createApp(config, repo, undefined, audit, undefined, { auditReview: { list } });
    try {
      const response = await app.inject({ url: '/api/v1/admin/audit-events', headers: { 'x-api-key': 'private-secret' } });
      expect(response.statusCode).toBe(401);
      expect(list).not.toHaveBeenCalled(); expect(repo.findBySubject).not.toHaveBeenCalled();
      expect(events[0]).toMatchObject({ action: 'AUDIT_EVENTS_LIST', outcome: 'DENIED', actor: null, errorCode: 'INVALID_CREDENTIALS' });
      expect(JSON.stringify(events)).not.toContain('private-secret');
    } finally { await app.close(); }
  });
  it('returns 503 without audit rows if protected read auditing fails', async () => {
    const { repo, list, audit, events, config } = fixture();
    list.mockRejectedValue(new AppError(503, 'SERVICE_UNAVAILABLE', 'Try again later.'));
    const app = await createApp(config, repo, undefined, audit, undefined, { auditReview: { list } });
    try {
      const response = await app.inject('/api/v1/admin/audit-events');
      expect(response.statusCode).toBe(503);
      expect(response.json()).not.toHaveProperty('events');
      expect(events[0]).toMatchObject({ action: 'AUDIT_EVENTS_LIST', outcome: 'FAILURE', errorCode: 'SERVICE_UNAVAILABLE', actor: { type: 'USER' } });
    } finally { await app.close(); }
  });
});
