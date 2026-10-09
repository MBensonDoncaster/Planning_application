import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { ApiErrorEnvelope, ErrorDetail } from '@planning/contracts';
import { AppError } from '../shared/errors.js';
import { safeAuditErrorCode } from '../shared/audit.js';

const safeErrors: Record<number, [string, string]> = {
  400: ['VALIDATION_ERROR', 'Invalid request.'],
  401: ['AUTHENTICATION_REQUIRED', 'Sign in to continue.'],
  403: ['FORBIDDEN', 'You do not have permission to perform this action.'],
  404: ['NOT_FOUND', 'Not found.'],
  409: ['REQUEST_CONFLICT', 'The request conflicts with the current state.'],
  410: ['SUBMISSION_DELETED', 'The submission has been permanently deleted.'],
  413: ['PAYLOAD_TOO_LARGE', 'The request exceeds the permitted size.'],
  415: ['UNSUPPORTED_MEDIA_TYPE', 'The request content type or encoding is not supported.'],
  422: ['VALIDATION_ERROR', 'The request could not be processed.'],
  429: ['RATE_LIMITED', 'Too many requests. Try again later.'],
  500: ['INTERNAL_ERROR', 'The request could not be completed.'],
  503: ['SERVICE_UNAVAILABLE', 'The service is temporarily unavailable. Try again later.'],
};

function validationDetails(error: ZodError): ErrorDetail[] {
  return error.issues.slice(0, 20).map(issue => ({
    path: Array.from(issue.path.map(String).join('.'))
      .filter(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join('').slice(0, 256),
    // Do not echo values or unrecognised keys from validation messages.
    message: issue.code === 'invalid_type' ? 'Use the expected value type.' :
      issue.code === 'too_big' ? 'The value exceeds the permitted limit.' :
      issue.code === 'too_small' ? 'The value is below the required minimum.' :
      issue.code === 'invalid_format' ? 'Use the required format.' : 'Invalid value.',
  }));
}

export function installErrorHandler(app: FastifyInstance, onFailure?: (request: FastifyRequest, status: number, code: string) => Promise<void>): void {
  app.setErrorHandler(async (error, request, reply) => {
    let status = 500;
    let code: string;
    let message: string;
    let details: ErrorDetail[] | undefined;
    if (error instanceof ZodError) {
      status = 400;
      [code, message] = safeErrors[status];
      details = validationDetails(error);
    } else if (error instanceof AppError) {
      status = error.statusCode;
      code = error.code;
      message = error.message;
      details = error.details;
    } else {
      const candidate = error as { statusCode?: unknown };
      if (typeof candidate?.statusCode === 'number' && Number.isInteger(candidate.statusCode) && safeErrors[candidate.statusCode]) {
        status = candidate.statusCode;
      }
      [code, message] = safeErrors[status];
    }
    if (status >= 500) request.log.error({ statusCode: status, errorCode: safeAuditErrorCode(code) }, 'Request failed');
    if (onFailure) await onFailure(request, status, code);
    const body: ApiErrorEnvelope = { error: { code, message, requestId: request.id, ...(details ? { details } : {}) } };
    // A failed download must be JSON, even if the route already set file headers.
    reply.removeHeader('Content-Disposition');
    reply.removeHeader('Content-Length');
    reply.header('X-Request-Id', request.id).header('Cache-Control', 'no-store');
    return reply.code(status).type('application/json').send(body);
  });
}
