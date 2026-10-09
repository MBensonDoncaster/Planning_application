import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { User } from '../src/modules/users/types.js';
import { createAuditService, unavailableAuditService, type AuditEventInput } from '../src/shared/audit.js';

const event = (overrides: Partial<AuditEventInput> = {}): AuditEventInput => ({
  requestId: randomUUID(), actor: null, module: 'shared', action: 'REQUEST_FAILED', outcome: 'FAILURE', ...overrides,
});
function fixture() {
  const create = vi.fn().mockResolvedValue({});
  return { create, service: createAuditService({ auditEvent: { create } }) };
}

describe('shared audit service', () => {
  it('records only verified actor IDs and leaves unknown/system names out', async () => {
    const { create, service } = fixture();
    const userId = randomUUID(), integrationId = randomUUID(), keyId = randomUUID();
    const user: User = { id: userId, subject: 'private-subject', email: 'private@example.test', displayName: 'Private name', role: 'ADMIN', status: 'APPROVED', createdAt: new Date(), updatedAt: new Date(), lastLoginAt: null, approvedAt: null, approvedByUserId: null };
    for (const actor of [null, { type: 'USER' as const, user }, { type: 'INTEGRATION' as const, integrationId, keyId, capabilities: [] }, { type: 'SYSTEM' as const, name: 'private-job-name', capabilities: [] }]) await service.record(event({ actor }));
    expect(create.mock.calls.map(([args]) => args.data.actorType)).toEqual(['UNKNOWN', 'USER', 'INTEGRATION', 'SYSTEM']);
    expect(create.mock.calls[1][0].data.actorUserId).toBe(userId);
    expect(create.mock.calls[2][0].data).toMatchObject({ actorIntegrationId: integrationId, actorKeyId: keyId });
    expect(JSON.stringify(create.mock.calls)).not.toMatch(/private/);
    expect(create.mock.calls[0][0].data).not.toHaveProperty('actorUserId');
    expect(create.mock.calls[3][0].data).not.toHaveProperty('actorUserId');
  });

  it('projects bounded filter metadata and drops requests, tokens, raw JSON and unknown fields', async () => {
    const { create, service } = fixture();
    const digest = 'a'.repeat(64);
    const metadata = { page: 2, pageSize: 20, status: 'PENDING', resultCount: 5, queryHash: digest, queryLength: 42, query: 'private search', headers: { authorization: 'Bearer private-token' }, rawJson: 'private payload', unknown: 'private'.repeat(100_000) };
    await service.record(event({ action: 'USERS_LIST', metadata }));
    const stored = create.mock.calls[0][0].data.metadata;
    expect(stored).toEqual({ page: 2, pageSize: 20, status: 'PENDING', resultCount: 5, queryHash: digest, queryLength: 42 });
    expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThan(2048);
    expect(JSON.stringify(create.mock.calls)).not.toContain('private');
  });

  it('validates every allowed metadata value without stringifying arbitrary objects', async () => {
    const { create, service } = fixture();
    const circular: Record<string, unknown> = { page: -1, pageSize: 101, resultCount: Infinity, queryLength: 1.5, status: 'private', queryHash: 'private', toJSON: () => { throw new Error('Must not be serialized'); } };
    circular.self = circular;
    await service.record(event({ action: 'USERS_LIST', metadata: circular }));
    await service.record(event({ action: 'USER_CHANGE', metadata: { change: 'role', role: 'ADMIN', status: 'APPROVED', email: 'private@example.test' } }));
    await service.record(event({ action: 'REQUEST_FAILED', errorCode: 'private-secret', metadata: { statusCode: 403, page: 2 } }));
    await service.record(event({ action: 'HOME_READ', metadata: { statusCode: 200 } }));
    expect(create.mock.calls.map(([args]) => args.data.metadata)).toEqual([{}, { change: 'role', role: 'ADMIN', status: 'APPROVED' }, { statusCode: 403 }, {}]);
    expect(create.mock.calls[2][0].data.errorCode).toBe('INTERNAL_ERROR');
  });

  it('records safe target, channel and error code without a supplied timestamp', async () => {
    const { create, service } = fixture();
    const id = randomUUID();
    await service.record(event({ target: { type: 'submission', id }, channel: 'FILE_JSON', errorCode: 'FORBIDDEN' }));
    expect(create.mock.calls[0][0].data).toMatchObject({ targetType: 'submission', targetId: id, channel: 'FILE_JSON', errorCode: 'FORBIDDEN' });
    expect(create.mock.calls[0][0].data).not.toHaveProperty('occurredAt');
  });

  it('keeps only the safe failure status for a known action', async () => {
    const { create, service } = fixture();
    await service.record(event({ action: 'HOME_READ', outcome: 'DENIED', metadata: { statusCode: 403, message: 'private details', headers: 'private token', rawJson: 'private payload' } }));
    expect(create.mock.calls[0][0].data.metadata).toEqual({ statusCode: 403 });
    expect(JSON.stringify(create.mock.calls)).not.toContain('private');
  });

  it('uses the supplied transaction writer exclusively', async () => {
    const { create, service } = fixture();
    const transactionalCreate = vi.fn().mockResolvedValue({});
    await service.record(event(), { auditEvent: { create: transactionalCreate } });
    expect(transactionalCreate).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it('fails closed with a safe 503 when audit persistence is unavailable', async () => {
    const { create, service } = fixture();
    create.mockRejectedValue(new Error('postgres://secret:password@private-host'));
    await expect(service.record(event())).rejects.toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE', message: 'The service is temporarily unavailable. Try again later.' });
    await expect(unavailableAuditService.record(event())).rejects.toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
  });

  it('rejects invalid UUID targets and unsafe correlation IDs before persistence', async () => {
    const { create, service } = fixture();
    await expect(service.record(event({ target: { type: 'user', id: 'private-secret' } }))).rejects.toMatchObject({ statusCode: 503 });
    await expect(service.record(event({ requestId: 'Bearer private-secret' }))).rejects.toMatchObject({ statusCode: 503 });
    expect(create).not.toHaveBeenCalled();
  });
});
