import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerIntegrationRoutes } from '../src/modules/integrations/routes.js';
import type { IntegrationService } from '../src/modules/integrations/service.js';
import { installErrorHandler } from '../src/plugins/errors.js';
import type { Actor } from '../src/shared/actors.js';
import type { User } from '../src/modules/users/types.js';

const user = (role: User['role'] = 'ADMIN', status: User['status'] = 'APPROVED'): User => ({
  id: randomUUID(), subject: 'local:synthetic-admin', email: 'admin@example.test', displayName: 'Synthetic', role, status,
  createdAt: new Date(), updatedAt: new Date(), lastLoginAt: null, approvedAt: null, approvedByUserId: null,
});
function fixture() {
  return { list: vi.fn().mockResolvedValue({ integrations: [], total: 0, page: 1, pageSize: 50 }),
    create: vi.fn().mockResolvedValue({ id: randomUUID() }), update: vi.fn().mockResolvedValue({ enabled: false }),
    createKey: vi.fn().mockResolvedValue({ key: { id: randomUUID() }, secret: 'one-time-synthetic' }),
    rotateKey: vi.fn().mockResolvedValue({ key: { id: randomUUID() }, secret: 'rotated-synthetic', previousKeyRevokesAt: new Date().toISOString() }),
    revokeKey: vi.fn().mockResolvedValue({ status: 'REVOKED' }), authenticateKey: vi.fn() };
}
async function appFor(actor: Actor | null, service: IntegrationService) {
  const app = Fastify();
  app.decorateRequest('actor', null);
  app.addHook('preHandler', async request => { request.actor = actor; });
  installErrorHandler(app);
  await registerIntegrationRoutes(app, service);
  return app;
}
describe('integration administration HTTP contracts', () => {
  it.each([null, { type: 'USER', user: user('USER') }, { type: 'USER', user: user('ADMIN', 'PENDING') }, { type: 'INTEGRATION', integrationId: randomUUID(), keyId: randomUUID(), capabilities: ['call-for-sites.submit'] }] as (Actor | null)[])('denies non-administrator actors on every route (%j)', async actor => {
    const service = fixture(), app = await appFor(actor, service);
    try {
      for (const [method, url, payload] of [
        ['GET', '/api/v1/admin/integrations', undefined], ['POST', '/api/v1/admin/integrations', { name: 'test' }],
        ['PATCH', `/api/v1/admin/integrations/${randomUUID()}`, { enabled: false }],
        ['POST', `/api/v1/admin/integrations/${randomUUID()}/keys`, { label: 'test', capabilities: ['call-for-sites.submit'] }],
        ['POST', `/api/v1/admin/api-keys/${randomUUID()}/rotate`, {}], ['POST', `/api/v1/admin/api-keys/${randomUUID()}/revoke`, undefined],
      ] as const) {
        const response = await app.inject({ method, url, payload });
        expect(response.statusCode).toBe(actor ? 403 : 401);
      }
      for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('uses the authenticated actor, fixed page size and bounded pagination', async () => {
    const actor: Actor = { type: 'USER', user: user() }, service = fixture(), app = await appFor(actor, service);
    try {
      expect((await app.inject('/api/v1/admin/integrations?page=2')).statusCode).toBe(200);
      expect(service.list).toHaveBeenCalledWith(actor, 2, { requestId: expect.any(String) });
      expect((await app.inject('/api/v1/admin/integrations?page=0')).statusCode).toBe(400);
      expect((await app.inject('/api/v1/admin/integrations?pageSize=1000')).statusCode).toBe(400);
    } finally { await app.close(); }
  });
  it('returns no-store secrets only on successful creation and rotation', async () => {
    const service = fixture(), app = await appFor({ type: 'USER', user: user() }, service);
    try {
      const created = await app.inject({ method: 'POST', url: `/api/v1/admin/integrations/${randomUUID()}/keys`, payload: { label: 'test', capabilities: ['call-for-sites.submit'] } });
      expect(created.statusCode).toBe(201);
      expect(created.headers['cache-control']).toBe('no-store');
      expect(created.json().secret).toBe('one-time-synthetic');
      const rotated = await app.inject({ method: 'POST', url: `/api/v1/admin/api-keys/${randomUUID()}/rotate`, payload: {} });
      expect(rotated.statusCode).toBe(201);
      expect(rotated.headers['cache-control']).toBe('no-store');
      expect(rotated.json().secret).toBe('rotated-synthetic');
    } finally { await app.close(); }
  });
  it('rejects forged creators, invalid target IDs and business bodies on revoke', async () => {
    const service = fixture(), app = await appFor({ type: 'USER', user: user() }, service);
    try {
      const forged = await app.inject({ method: 'POST', url: '/api/v1/admin/integrations', payload: { name: 'valid', createdByUserId: randomUUID() } });
      expect(forged.statusCode).toBe(400);
      expect((await app.inject({ method: 'PATCH', url: '/api/v1/admin/integrations/not-a-uuid', payload: { enabled: false } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: `/api/v1/admin/api-keys/${randomUUID()}/revoke`, payload: { secret: 'do-not-echo' } })).statusCode).toBe(400);
      expect(service.create).not.toHaveBeenCalled();
      expect(service.update).not.toHaveBeenCalled();
      expect(service.revokeKey).not.toHaveBeenCalled();
      expect(forged.body).not.toContain('createdByUserId');
    } finally { await app.close(); }
  });
});
