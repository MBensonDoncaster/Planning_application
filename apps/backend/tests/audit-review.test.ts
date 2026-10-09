import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerAuditReviewRoutes } from '../src/modules/audit/routes.js';
import { auditQuerySchema } from '../src/modules/audit/service.js';
import { installErrorHandler } from '../src/plugins/errors.js';
import type { Actor } from '../src/shared/actors.js';
import type { User } from '../src/modules/users/types.js';
import { safeAuditMetadata } from '../src/shared/audit.js';

const user = (role: User['role'] = 'ADMIN', status: User['status'] = 'APPROVED'): User => ({
  id: randomUUID(), subject: 'local:audit-admin', email: 'admin@example.test', displayName: 'Synthetic', role, status,
  createdAt: new Date(), updatedAt: new Date(), lastLoginAt: null, approvedAt: null, approvedByUserId: null,
});
async function appFor(actor: Actor | null) {
  const app = Fastify(), list = vi.fn().mockResolvedValue({ events: [], total: 0, page: 1, pageSize: 50 });
  app.decorateRequest('actor', null);
  app.addHook('preHandler', async request => { request.actor = actor; });
  installErrorHandler(app);
  await registerAuditReviewRoutes(app, { list });
  return { app, list };
}

describe('read-only audit review HTTP contract', () => {
  it.each([null, { type: 'USER', user: user('USER') }, { type: 'USER', user: user('ADMIN', 'PENDING') },
    { type: 'USER', user: user('ADMIN', 'DISABLED') }, { type: 'USER', user: user('ADMIN', 'REJECTED') },
    { type: 'INTEGRATION', integrationId: randomUUID(), keyId: randomUUID(), capabilities: ['call-for-sites.submit'] },
    { type: 'SYSTEM', name: 'job', capabilities: [] }] as (Actor | null)[])('denies actors without audit.read (%j)', async actor => {
    const { app, list } = await appFor(actor);
    try {
      expect((await app.inject('/api/v1/admin/audit-events')).statusCode).toBe(actor ? 403 : 401);
      expect(list).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('uses server actor/context and fixed pages of 50', async () => {
    const actor: Actor = { type: 'USER', user: user() }, { app, list } = await appFor(actor);
    try {
      expect((await app.inject('/api/v1/admin/audit-events?page=2&pageSize=50')).statusCode).toBe(200);
      expect(list).toHaveBeenCalledWith(actor, { page: 2, pageSize: 50 }, { requestId: expect.any(String) });
    } finally { await app.close(); }
  });
  it.each(['page=0', 'page=100001', 'page=1.5', 'pageSize=100', 'actorId=bad', 'targetId=bad', 'actorType=OTHER',
    'module=other', 'outcome=ERROR', 'unknown=secret', 'action=profile%40example.test', 'dateFrom=2026-02-30T00:00:00Z',
    'dateFrom=2026-01-01', 'dateFrom=2026-01-01T00:00:00', 'dateFrom=2026-01-02T00:00:00Z&dateTo=2026-01-01T00:00:00Z',
    'dateFrom=2026-01-01T00:00:00Z&dateTo=2026-01-01T00:00:00Z'])('rejects invalid query %s', async query => {
    const { app, list } = await appFor({ type: 'USER', user: user() });
    try {
      const response = await app.inject(`/api/v1/admin/audit-events?${query}`);
      expect(response.statusCode).toBe(400);
      expect(list).not.toHaveBeenCalled();
      expect(response.body).not.toContain('profile@example.test');
    } finally { await app.close(); }
  });
  it('offers no create, edit or deletion endpoints', async () => {
    const { app, list } = await appFor({ type: 'USER', user: user() });
    try {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        expect((await app.inject({ method, url: '/api/v1/admin/audit-events' })).statusCode).toBe(404);
        expect((await app.inject({ method, url: `/api/v1/admin/audit-events/${randomUUID()}` })).statusCode).toBe(404);
      }
      expect(list).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('accepts offset time bounds and future bounded action identifiers', () => {
    expect(auditQuerySchema.parse({ dateFrom: '2026-01-01T10:00:00+01:00', dateTo: '2026-01-01T09:00:01Z', action: 'FUTURE_ACTION' }).action).toBe('FUTURE_ACTION');
  });
  it('projects safe metadata at read time and suppresses unknown-action metadata', () => {
    expect(safeAuditMetadata({ action: 'API_KEY_ROTATED', outcome: 'SUCCESS', metadata: { capabilityCount: 1, secret: 'sensitive', secretDigest: 'digest', label: 'contact', nested: { secret: 'sensitive' } } })).toEqual({ capabilityCount: 1 });
    expect(safeAuditMetadata({ action: 'FUTURE_ACTION', outcome: 'FAILURE', metadata: { statusCode: 500, secret: 'sensitive' } })).toEqual({});
    expect(safeAuditMetadata({ action: 'AUDIT_EVENTS_LIST', outcome: 'SUCCESS', metadata: { page: 1, pageSize: 50, resultCount: 3, actorType: 'USER', module: 'shared', outcome: 'SUCCESS', hasActorId: true, dateFrom: '2026-01-01T00:00:00.000Z', actorId: randomUUID(), action: 'USER_SIGNED_IN', rawQuery: 'contact' } })).toEqual({ page: 1, pageSize: 50, resultCount: 3, actorType: 'USER', module: 'shared', outcome: 'SUCCESS', hasActorId: true, dateFrom: '2026-01-01T00:00:00.000Z' });
  });
});
