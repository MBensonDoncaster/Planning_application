import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { IntegrationService } from '../modules/integrations/service.js';
import { requireCapability } from '../shared/actors.js';
import { AppError } from '../shared/errors.js';
import type { RateLimiter, RateScope } from '../shared/rate-limits.js';

export type ExternalSubmissionHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
export async function consumeRequestBudget(limiter: RateLimiter, scope: RateScope, subject: string, reply: FastifyReply): Promise<void> {
  const result = await limiter.consume(scope, subject);
  if (!result.allowed) {
    reply.header('Retry-After', result.retryAfter);
    throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again later.');
  }
}

export async function registerExternalSubmissionRoute(app: FastifyInstance, integrations: IntegrationService | undefined, limiter: RateLimiter, handler?: ExternalSubmissionHandler): Promise<void> {
  await app.register(async external => {
    external.addHook('onRequest', async (request, reply) => {
      await consumeRequestBudget(limiter, 'INTEGRATION_IP', request.ip, reply);
      if (request.headers.authorization !== undefined && request.headers['x-api-key'] !== undefined) throw new AppError(400, 'AMBIGUOUS_AUTHENTICATION', 'Supply only one credential method.');
      const secret = request.headers['x-api-key'];
      if (typeof secret !== 'string' || !secret) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'An API key is required.');
      if (!integrations) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable. Try again later.');
      request.actor = await integrations.authenticateKey(secret);
      requireCapability(request.actor, 'call-for-sites.submit');
      await consumeRequestBudget(limiter, 'API_KEY', request.actor.keyId, reply);
      // Check before parsing so text, multipart and compressed bodies cannot enter the ingestion seam.
      if (request.headers['content-encoding'] !== undefined && request.headers['content-encoding'] !== 'identity') throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Compressed request bodies are not supported.');
      if (typeof request.headers['content-type'] !== 'string' || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(request.headers['content-type'])) {
        throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json with UTF-8 encoding.');
      }
    });
    external.post('/api/v1/integrations/call-for-sites/submissions', async (request, reply) => {
      if (request.headers['idempotency-key'] === undefined) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Supply an Idempotency-Key header.');
      z.uuid({ version: 'v4' }).parse(request.headers['idempotency-key']);
      if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new AppError(400, 'VALIDATION_ERROR', 'Supply one JSON object.');
      if (!handler) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Submission ingestion is not yet available.');
      return handler(request, reply);
    });
  });
}
