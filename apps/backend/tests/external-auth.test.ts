import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config/env.js';
import type { IntegrationService } from '../src/modules/integrations/service.js';
import type { User, UserRepository } from '../src/modules/users/types.js';
import type { IntegrationActor } from '../src/shared/actors.js';
import { AppError } from '../src/shared/errors.js';
import { syntheticAudit } from './support/audit.js';

const path = '/api/v1/integrations/call-for-sites/submissions';
const secret = `pln_${randomUUID()}.${'a'.repeat(43)}`;
const actor: IntegrationActor = { type: 'INTEGRATION', integrationId: randomUUID(), keyId: randomUUID(), capabilities: ['call-for-sites.submit'] };
async function fixture(options: { status?: User['status']; handler?: boolean; actor?: IntegrationActor } = {}) {
  const user: User = { id: randomUUID(), subject: 'local:developer', email: 'synthetic@example.test', displayName: 'Synthetic', role: 'ADMIN', status: options.status ?? 'APPROVED', createdAt: new Date(), updatedAt: new Date(), lastLoginAt: null, approvedAt: null, approvedByUserId: null };
  const users: UserRepository = { authenticate: vi.fn().mockResolvedValue(user), findBySubject: vi.fn().mockResolvedValue(user), list: vi.fn().mockResolvedValue({ users: [], total: 0 }), change: vi.fn().mockResolvedValue(user), ready: vi.fn(), close: vi.fn() };
  const authenticateKey = vi.fn().mockResolvedValue(options.actor ?? actor);
  const consume = vi.fn().mockResolvedValue({ allowed: true, retryAfter: 0 });
  const externalSubmission = vi.fn(async (_request: FastifyRequest, reply: FastifyReply) => reply.code(202).send({ accepted: true }));
  const { audit, events } = syntheticAudit();
  const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/test', AUTH_MODE: 'TEST_USER' });
  const app = await createApp(config, users, undefined, audit, { authenticateKey } as unknown as IntegrationService,
    { rateLimiter: { consume }, ...(options.handler === false ? {} : { externalSubmission }) });
  return { app, users, authenticateKey, consume, externalSubmission, events, user };
}

describe('external submission authentication and shared limit boundaries', () => {
  it.each([{}, { authorization: 'Bearer synthetic' }])('requires an API key independently of human test-user authentication: %j', async headers => {
    const f = await fixture();
    try {
      const response = await f.app.inject({ method: 'POST', url: path, headers, payload: {} });
      expect(response.statusCode).toBe(401);
      expect(f.authenticateKey).not.toHaveBeenCalled();
      expect(f.users.authenticate).not.toHaveBeenCalled();
      expect(f.externalSubmission).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it('rejects mixed credentials before authenticating or dispatching', async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject({ method: 'POST', url: path, headers: { 'x-api-key': secret, 'idempotency-key': randomUUID(), authorization: 'Bearer synthetic' }, payload: {} });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('AMBIGUOUS_AUTHENTICATION');
      expect(f.authenticateKey).not.toHaveBeenCalled();
      expect(f.externalSubmission).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it('uses integration identity and consumes IP and key buckets before dispatch', async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject({ method: 'POST', url: path, headers: { 'x-api-key': secret, 'idempotency-key': randomUUID() }, payload: {} });
      expect(response.statusCode).toBe(202);
      expect(f.authenticateKey).toHaveBeenCalledWith(secret);
      expect(f.consume).toHaveBeenCalledWith('INTEGRATION_IP', expect.any(String));
      expect(f.consume).toHaveBeenCalledWith('API_KEY', actor.keyId);
      expect(f.consume).not.toHaveBeenCalledWith('USER', expect.anything());
      expect(f.users.findBySubject).not.toHaveBeenCalled();
      expect(f.externalSubmission.mock.calls[0][0].actor).toEqual(actor);
    } finally { await f.app.close(); }
  });
  it('charges mixed credentials to the pre-authentication IP budget and stops excess attempts', async () => {
    const f = await fixture();
    f.consume.mockResolvedValueOnce({ allowed: true, retryAfter: 0 }).mockResolvedValue({ allowed: false, retryAfter: 9 });
    try {
      const request = { method: 'POST' as const, url: path, headers: { 'x-api-key': secret, authorization: 'Bearer synthetic' }, payload: {} };
      const first = await f.app.inject(request);
      expect(first.statusCode).toBe(400);
      expect(first.json().error.code).toBe('AMBIGUOUS_AUTHENTICATION');
      const second = await f.app.inject(request);
      expect(second.statusCode).toBe(429);
      expect(second.headers['retry-after']).toBe('9');
      expect(f.consume.mock.calls.every(call => call[0] === 'INTEGRATION_IP')).toBe(true);
      expect(f.authenticateKey).not.toHaveBeenCalled();
      expect(f.externalSubmission).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it('requires the submission scope', async () => {
    const f = await fixture({ actor: { ...actor, capabilities: [] } });
    try {
      const response = await f.app.inject({ method: 'POST', url: path, headers: { 'x-api-key': secret, 'idempotency-key': randomUUID() }, payload: {} });
      expect(response.statusCode).toBe(403);
      expect(f.externalSubmission).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it.each([
    { headers: { 'content-type': 'text/plain' }, payload: '{}' , status: 415 },
    { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, payload: '{}', status: 415 },
    { headers: { 'content-type': 'application/json' }, payload: '{invalid', status: 400 },
  ])('rejects invalid media or syntax before dispatch: $status', async ({ headers, payload, status }) => {
    const f = await fixture();
    try {
      const response = await f.app.inject({ method: 'POST', url: path, headers: { ...headers, 'x-api-key': secret, 'idempotency-key': randomUUID() }, payload });
      expect(response.statusCode).toBe(status);
      expect(f.externalSubmission).not.toHaveBeenCalled();
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json().error.requestId).toBe(response.headers['x-request-id']);
      expect(response.body).not.toContain(secret);
    } finally { await f.app.close(); }
  });
  it('authenticates before JSON parsing so successful authentication records use even for invalid JSON', async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject({ method: 'POST', url: path, headers: { 'x-api-key': secret, 'idempotency-key': randomUUID(), 'content-type': 'application/json' }, payload: '{invalid' });
      expect(response.statusCode).toBe(400);
      expect(f.authenticateKey).toHaveBeenCalledWith(secret);
      expect(f.externalSubmission).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it('denies invalid credentials and never exposes the submitted secret', async () => {
    const f = await fixture();
    f.authenticateKey.mockRejectedValue(new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials.'));
    try {
      const response = await f.app.inject({ method: 'POST', url: path, headers: { 'x-api-key': secret, 'idempotency-key': randomUUID() }, payload: {} });
      expect(response.statusCode).toBe(401);
      expect(f.externalSubmission).not.toHaveBeenCalled();
      expect(JSON.stringify(f.events)).not.toContain(secret);
      expect(response.body).not.toContain(secret);
    } finally { await f.app.close(); }
  });
  it.each(['INTEGRATION_IP', 'API_KEY'] as const)('returns Retry-After and stops dispatch when %s is exhausted', async scope => {
    const f = await fixture();
    f.consume.mockImplementation(async current => ({ allowed: current !== scope, retryAfter: current === scope ? 37 : 0 }));
    try {
      const response = await f.app.inject({ method: 'POST', url: path, headers: { 'x-api-key': secret, 'idempotency-key': randomUUID() }, payload: {} });
      expect(response.statusCode).toBe(429);
      expect(response.headers['retry-after']).toBe('37');
      expect(response.json().error.code).toBe('RATE_LIMITED');
      expect(f.externalSubmission).not.toHaveBeenCalled();
      if (scope === 'INTEGRATION_IP') expect(f.authenticateKey).not.toHaveBeenCalled();
      expect(f.events.at(-1)).toMatchObject({ action: 'EXTERNAL_SUBMISSION', module: 'call-for-sites', channel: 'INTEGRATION_API', outcome: 'DENIED', errorCode: 'RATE_LIMITED', actor: scope === 'API_KEY' ? actor : null });
    } finally { await f.app.close(); }
  });
  it('fails closed when the shared limiter is unavailable', async () => {
    const f = await fixture();
    f.consume.mockRejectedValue(new AppError(503, 'SERVICE_UNAVAILABLE', 'Temporarily unavailable.'));
    try {
      const response = await f.app.inject({ method: 'POST', url: path, headers: { 'x-api-key': secret, 'idempotency-key': randomUUID() }, payload: {} });
      expect(response.statusCode).toBe(503);
      expect(f.authenticateKey).not.toHaveBeenCalled();
      expect(f.externalSubmission).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it('returns unavailable until a domain submission handler is installed', async () => {
    const f = await fixture({ handler: false });
    try {
      const response = await f.app.inject({ method: 'POST', url: path, headers: { 'x-api-key': secret, 'idempotency-key': randomUUID() }, payload: {} });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('SERVICE_UNAVAILABLE');
      expect(f.authenticateKey).toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it.each([undefined, 'bad', '00000000-0000-1000-8000-000000000001'])('requires a UUID v4 idempotency key: %s', async value => {
    const f = await fixture();
    try {
      const response = await f.app.inject({ method: 'POST', url: path, headers: { 'x-api-key': secret, ...(value ? { 'idempotency-key': value } : {}) }, payload: {} });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe(value ? 'VALIDATION_ERROR' : 'IDEMPOTENCY_KEY_REQUIRED');
      expect(f.authenticateKey).toHaveBeenCalled();
      expect(f.externalSubmission).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it.each(['[]', 'null', '42', '"text"'])('requires one JSON object rather than %s', async payload => {
    const f = await fixture();
    try {
      const response = await f.app.inject({ method: 'POST', url: path,
        headers: { 'x-api-key': secret, 'idempotency-key': randomUUID(), 'content-type': 'application/json' }, payload });
      expect(response.statusCode).toBe(400);
      expect(f.authenticateKey).toHaveBeenCalled();
      expect(f.externalSubmission).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it('rejects mixed credentials before checking compressed encoding', async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject({ method: 'POST', url: path,
        headers: { 'x-api-key': secret, authorization: 'Bearer synthetic', 'content-type': 'application/json', 'content-encoding': 'gzip' }, payload: '{}' });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('AMBIGUOUS_AUTHENTICATION');
      expect(f.authenticateKey).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it('rejects API keys on human-only routes', async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject({ url: '/api/v1/admin/users', headers: { 'x-api-key': secret, 'idempotency-key': randomUUID() } });
      expect(response.statusCode).toBe(401);
      expect(f.users.list).not.toHaveBeenCalled();
      expect(f.authenticateKey).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it('applies the user bucket after approved authentication and the write bucket before mutations', async () => {
    const f = await fixture();
    try {
      expect((await f.app.inject('/api/v1/admin/users')).statusCode).toBe(200);
      expect(f.consume).toHaveBeenCalledWith('USER', f.user.id);
      f.consume.mockClear();
      await f.app.inject({ method: 'POST', url: `/api/v1/admin/users/${randomUUID()}/approve` });
      expect(f.consume).toHaveBeenCalledWith('USER', f.user.id);
      expect(f.consume).toHaveBeenCalledWith('USER_WRITE', f.user.id);
    } finally { await f.app.close(); }
  });
  it('limits known unapproved accounts without granting access or consuming a write budget', async () => {
    const f = await fixture({ status: 'PENDING' });
    try {
      expect((await f.app.inject('/api/v1/admin/users')).statusCode).toBe(403);
      expect(f.consume).toHaveBeenCalledExactlyOnceWith('USER', f.user.id);
      expect(f.users.list).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });
  it('audits a denied user write budget with the current human actor before invoking a mutation', async () => {
    const f = await fixture();
    f.consume.mockImplementation(async scope => ({ allowed: scope !== 'USER_WRITE', retryAfter: 5 }));
    try {
      const response = await f.app.inject({ method: 'POST', url: `/api/v1/admin/users/${randomUUID()}/approve` });
      expect(response.statusCode).toBe(429);
      expect(response.headers['retry-after']).toBe('5');
      expect(f.users.change).not.toHaveBeenCalled();
      expect(f.events.at(-1)).toMatchObject({ action: 'USER_APPROVED', outcome: 'DENIED', errorCode: 'RATE_LIMITED', actor: { type: 'USER', user: f.user } });
    } finally { await f.app.close(); }
  });
});
