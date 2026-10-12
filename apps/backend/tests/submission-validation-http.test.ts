import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config/env.js';
import type { IntegrationService } from '../src/modules/integrations/service.js';
import type { UserRepository } from '../src/modules/users/types.js';
import { validateParsedSubmissionBody } from '../src/shared/submission-validation.js';
import { syntheticAudit } from './support/audit.js';

async function fixture(extra: Record<string, unknown> = {}) {
  const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/test', AUTH_MODE: 'TEST_USER', ...extra });
  const users = { close: vi.fn() } as unknown as UserRepository;
  const integrations = { authenticateKey: vi.fn().mockResolvedValue({ type: 'INTEGRATION', integrationId: randomUUID(), keyId: randomUUID(), capabilities: ['call-for-sites.submit'] }) } as unknown as IntegrationService;
  const app = await createApp(config, users, undefined, syntheticAudit().audit, integrations, {
    externalSubmission: async (request, reply) => {
      const result = validateParsedSubmissionBody(request.body, config.JSON_MAX_DEPTH);
      return reply.code(202).send(result);
    },
  });
  const headers = { 'x-api-key': 'synthetic-key', 'idempotency-key': randomUUID(), 'content-type': 'application/json' };
  return { app, headers, url: '/api/v1/integrations/call-for-sites/submissions' };
}
describe('strict JSON HTTP parser and reusable submission adapter', () => {
  it('preserves prototype-like keys and accepts JSON above the former 100 KiB ceiling', async () => {
    const f = await fixture();
    try {
      const source = '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"extension":"' + 'x'.repeat(110_000) + '"}';
      const response = await f.app.inject({ method: 'POST', url: f.url, headers: f.headers, payload: source });
      expect(response.statusCode).toBe(202);
      expect(JSON.stringify(response.json().rawJson)).toBe(source);
      expect(Object.prototype).not.toHaveProperty('polluted');
    } finally { await f.app.close(); }
  });
  it.each([
    ['{"private-contact":"\\u0000"}', '$.members[0]'],
    ['{"\\ud800":"secret"}', '$.members[0]'],
    ['{"metadata":{"submittedAt":"2026-02-30T00:00:00Z"}}', 'metadata.submittedAt'],
    ['{"data":{"property":{"address":{"latitude":"51.5secret"}}}}', 'data.property.address.latitude'],
  ])('returns safe validation envelopes with actionable paths', async (payload, path) => {
    const f = await fixture();
    try {
      const response = await f.app.inject({ method: 'POST', url: f.url, headers: f.headers, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatchObject({ code: 'VALIDATION_ERROR', requestId: response.headers['x-request-id'], details: [{ path, message: expect.any(String) }] });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toMatch(/private-contact|secret/);
    } finally { await f.app.close(); }
  });
  it('accepts BOM and refuses raw invalid UTF-8 rather than replacing characters', async () => {
    const f = await fixture();
    try {
      expect((await f.app.inject({ method: 'POST', url: f.url, headers: f.headers, payload: Buffer.from([0xef, 0xbb, 0xbf, 123, 125]) })).statusCode).toBe(202);
      const response = await f.app.inject({ method: 'POST', url: f.url, headers: f.headers, payload: Buffer.from([123, 34, 120, 34, 58, 34, 0xc3, 0x28, 34, 125]) });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.details[0].path).toBe('$');
    } finally { await f.app.close(); }
  });
  it('enforces configured inclusive byte limits and returns 400 for excessive container depth', async () => {
    const f = await fixture({ INGESTION_MAX_BODY_BYTES: 64, JSON_MAX_DEPTH: 2 });
    try {
      const payload = '{"x":"' + 'x'.repeat(56) + '"}';
      expect(Buffer.byteLength(payload)).toBe(64);
      expect((await f.app.inject({ method: 'POST', url: f.url, headers: f.headers, payload })).statusCode).toBe(202);
      const exponent = '{"number":1e20,"x":"' + 'x'.repeat(42) + '"}';
      expect(Buffer.byteLength(exponent)).toBe(64);
      expect((await f.app.inject({ method: 'POST', url: f.url, headers: f.headers, payload: exponent })).statusCode).toBe(202);
      const overflow = await f.app.inject({ method: 'POST', url: f.url, headers: f.headers, payload: payload + ' ' });
      expect(overflow.statusCode).toBe(413);
      expect(overflow.json().error.code).toBe('PAYLOAD_TOO_LARGE');
      const depth = await f.app.inject({ method: 'POST', url: f.url, headers: f.headers, payload: '{"x":{"y":{}}}' });
      expect(depth.statusCode).toBe(400);
      expect(depth.json().error.details[0].path).toBe('$');
    } finally { await f.app.close(); }
  });
});
