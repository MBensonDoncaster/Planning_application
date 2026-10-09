import type { FastifyRequest } from 'fastify';
import type { AuditEventInput, AuditService } from '../shared/audit.js';
import { safeAuditErrorCode } from '../shared/audit.js';
import { z } from 'zod';

const operations = {
  'GET /api/v1/auth/me': { module: 'shared', action: 'USER_SIGNED_IN' },
  'GET /api/v1/app/config': { module: 'shared', action: 'APP_CONFIG_READ' },
  'GET /api/v1/home': { module: 'shared', action: 'HOME_READ' },
  'GET /api/v1/admin/users': { module: 'shared', action: 'USERS_LIST' },
  'POST /api/v1/admin/users/:id/approve': { module: 'shared', action: 'USER_APPROVED' },
  'POST /api/v1/admin/users/:id/reject': { module: 'shared', action: 'USER_REJECTED' },
  'POST /api/v1/admin/users/:id/disable': { module: 'shared', action: 'USER_DISABLED' },
  'POST /api/v1/admin/users/:id/enable': { module: 'shared', action: 'USER_REOPENED' },
  'PATCH /api/v1/admin/users/:id/role': { module: 'shared', action: 'USER_ROLE_CHANGED' },
} as const;

export function requestAuditEvent(request: FastifyRequest): AuditEventInput {
  const key = `${request.method} ${request.routeOptions.url}`;
  const operation = operations[key as keyof typeof operations] ?? { module: 'shared', action: 'REQUEST_FAILED' };
  const event: AuditEventInput = { requestId: request.id, actor: request.actor, ...operation, outcome: 'SUCCESS' };
  if (['USER_APPROVED', 'USER_REJECTED', 'USER_DISABLED', 'USER_REOPENED', 'USER_ROLE_CHANGED'].includes(operation.action)) {
    const params = request.params as { id?: unknown } | undefined;
    const target = z.uuid().safeParse(params?.id);
    if (target.success) event.target = { type: 'user', id: target.data };
  }
  return event;
}

export function auditFailureLog(event: AuditEventInput, statusCode: number) {
  // Never include exception text, headers, payloads, URL/query, source IP or profile attributes.
  return {
    requestId: event.requestId,
    actorType: event.actor?.type ?? 'UNKNOWN',
    module: event.module,
    action: event.action,
    outcome: event.outcome,
    errorCode: safeAuditErrorCode(event.errorCode ?? 'INTERNAL_ERROR'),
    statusCode,
    auditPersistence: 'unavailable',
  };
}

export async function auditRequestFailure(audit: AuditService, request: FastifyRequest, status: number, code: string): Promise<void> {
  if (!request.url.startsWith('/api/')) return;
  const event: AuditEventInput = {
    ...requestAuditEvent(request),
    outcome: status === 401 || status === 403 || code === 'LAST_APPROVED_ADMIN' ? 'DENIED' : 'FAILURE',
    errorCode: safeAuditErrorCode(code),
    metadata: { statusCode: status },
  };
  try { await audit.record(event); }
  catch { request.log.warn(auditFailureLog(event, status), 'Security event could not be persisted'); }
}
