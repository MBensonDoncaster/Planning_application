import type { FastifyInstance } from 'fastify';
import { parseJsonBytes, type SubmissionLimits } from '@planning/contracts';
import { submissionValidationError } from '../shared/submission-validation.js';
import { AppError } from '../shared/errors.js';

export function installJsonParser(app: FastifyInstance, limits: SubmissionLimits): void {
  app.removeContentTypeParser('application/json');
  // Buffer parsing preserves strict UTF-8 checks; Fastify checks stream size and
  // Content-Length before invoking us. JSON.parse retains __proto__/constructor
  // as data. Never merge this source into configuration/prototype-bearing maps.
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: limits.maxBytes }, (_request, body, done) => {
    try {
      if (!Buffer.isBuffer(body)) throw new AppError(400, 'VALIDATION_ERROR', 'Use valid UTF-8 JSON.');
      done(null, parseJsonBytes(body, limits));
    }
    catch (error) { done(submissionValidationError(error), undefined); }
  });
}
