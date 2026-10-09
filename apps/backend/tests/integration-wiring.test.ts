import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config/env.js';
import type { User, UserRepository } from '../src/modules/users/types.js';
import type { IntegrationService } from '../src/modules/integrations/service.js';
import { createAuditService } from '../src/shared/audit.js';
import { syntheticAudit } from './support/audit.js';

describe('integration routes within the application authentication boundary', () => {
  it.each((['USER', 'ADMIN'] as const).flatMap(role =>
    (['PENDING', 'APPROVED', 'REJECTED', 'DISABLED'] as const).map(status => ({ role, status }))))(
    'uses current local access for $role/$status', async ({ role, status }) => {
      const user: User = { id: randomUUID(), subject: 'local:developer', email: 'synthetic@example.test', displayName: 'Synthetic', role, status,
        createdAt: new Date(), updatedAt: new Date(), lastLoginAt: null, approvedAt: null, approvedByUserId: null };
      const findBySubject = vi.fn().mockResolvedValue(user);
      const repo: UserRepository = { authenticate: vi.fn(), findBySubject, list: vi.fn(), change: vi.fn(), ready: vi.fn(), close: vi.fn() };
      const list = vi.fn().mockResolvedValue({ integrations: [], total: 0, page: 1, pageSize: 50 });
      const service = { list } as unknown as IntegrationService;
      const { audit, events } = syntheticAudit();
      const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/test', AUTH_MODE: 'TEST_USER' });
      const app = await createApp(config, repo, undefined, audit, service);
      try {
        const response = await app.inject('/api/v1/admin/integrations');
        expect(findBySubject).toHaveBeenCalledWith(config.TEST_USER_SUBJECT);
        expect(repo.authenticate).not.toHaveBeenCalled();
        if (role === 'ADMIN' && status === 'APPROVED') {
          expect(response.statusCode).toBe(200);
          expect(list).toHaveBeenCalledWith({ type: 'USER', user }, 1, { requestId: response.headers['x-request-id'] });
        } else {
          expect(response.statusCode).toBe(403);
          expect(list).not.toHaveBeenCalled();
          expect(events[0]).toMatchObject({ action: 'INTEGRATIONS_LIST', outcome: 'DENIED', actor: { type: 'USER', user: { id: user.id } } });
        }
      } finally { await app.close(); }
    },
  );

  it('stores only safe integration/key audit fields and rejects secret-bearing metadata', async () => {
    const create = vi.fn().mockResolvedValue({});
    const audit = createAuditService({ auditEvent: { create } });
    await audit.record({ requestId: randomUUID(), actor: null, module: 'shared', action: 'API_KEY_ROTATED', outcome: 'SUCCESS',
      metadata: { overlapHours: 1.5, expiresAt: '2026-11-01T00:00:00.000Z', revokesAt: '2026-10-10T00:00:00.000Z', capabilityCount: 1,
        secret: 'pln_private.private-secret', secretDigest: 'private-digest', label: 'private-contact', capabilities: ['private-token'] } });
    expect(create.mock.calls[0][0].data.metadata).toEqual({ overlapHours: 1.5, expiresAt: '2026-11-01T00:00:00.000Z', revokesAt: '2026-10-10T00:00:00.000Z', capabilityCount: 1 });
    expect(JSON.stringify(create.mock.calls)).not.toContain('private');
  });
});
