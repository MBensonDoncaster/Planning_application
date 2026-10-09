import type { Prisma } from '../generated/prisma/client.js';
import type { Actor } from './actors.js';
import { AppError } from './errors.js';

export interface AuditContext { requestId: string }
export type AuditAction = 'SESSION_SYNC' | 'APP_CONFIG_READ' | 'HOME_READ' | 'USERS_LIST' | 'USER_CHANGE' | 'REQUEST_FAILED'
  | 'USER_CREATED' | 'USER_SIGNED_IN' | 'USER_APPROVED' | 'USER_REJECTED' | 'USER_DISABLED'
  | 'USER_REOPENED' | 'USER_ROLE_CHANGED' | 'ADMIN_BOOTSTRAPPED'
  | 'INTEGRATIONS_LIST' | 'INTEGRATION_CREATED' | 'INTEGRATION_UPDATED'
  | 'API_KEY_CREATED' | 'API_KEY_ROTATED' | 'API_KEY_REVOKED' | 'EXTERNAL_SUBMISSION';
export interface AuditEventInput extends AuditContext {
  actor: Actor | null;
  module: 'shared' | 'call-for-sites';
  action: AuditAction;
  outcome: 'SUCCESS' | 'FAILURE' | 'DENIED';
  target?: { type: 'user' | 'submission' | 'integration' | 'api-key'; id: string };
  channel?: 'FILE_JSON' | 'FILE_ZIP' | 'INTEGRATION_API';
  errorCode?: string;
  metadata?: unknown;
}
export interface AuditWriter {
  auditEvent: { create(args: { data: Prisma.AuditEventUncheckedCreateInput }): Promise<unknown> };
}
export interface AuditService { record(event: AuditEventInput, writer?: AuditWriter): Promise<void> }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const actions: readonly AuditAction[] = [
  'SESSION_SYNC', 'APP_CONFIG_READ', 'HOME_READ', 'USERS_LIST', 'USER_CHANGE', 'REQUEST_FAILED',
  'USER_CREATED', 'USER_SIGNED_IN', 'USER_APPROVED', 'USER_REJECTED', 'USER_DISABLED',
  'USER_REOPENED', 'USER_ROLE_CHANGED', 'ADMIN_BOOTSTRAPPED',
  'INTEGRATIONS_LIST', 'INTEGRATION_CREATED', 'INTEGRATION_UPDATED',
  'API_KEY_CREATED', 'API_KEY_ROTATED', 'API_KEY_REVOKED', 'EXTERNAL_SUBMISSION',
];
const safeErrorCodes = new Set([
  'AUTHENTICATION_REQUIRED', 'INVALID_CREDENTIALS', 'USER_DISABLED', 'USER_NOT_APPROVED', 'FORBIDDEN',
  'NOT_FOUND', 'USER_NOT_FOUND', 'INVALID_TRANSITION', 'LAST_APPROVED_ADMIN', 'UNSUPPORTED_MEDIA_TYPE',
  'BAD_REQUEST', 'VALIDATION_ERROR', 'PAYLOAD_TOO_LARGE', 'REQUEST_CONFLICT', 'SUBMISSION_DELETED',
  'RATE_LIMITED', 'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE', 'AMBIGUOUS_AUTHENTICATION', 'IDEMPOTENCY_KEY_REQUIRED',
]);
const unavailable = () => new AppError(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable. Try again later.');
export function safeAuditErrorCode(code: string): string { return safeErrorCodes.has(code) ? code : 'INTERNAL_ERROR'; }

// Audit metadata is a purpose-built projection, never a copy of a request or payload.
function metadataFor(event: AuditEventInput): Prisma.InputJsonObject {
  const input = event.metadata;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const source = input as Record<string, unknown>;
  const metadata: Record<string, string | number | boolean> = {};
  const integer = (key: string, minimum: number, maximum: number) => {
    const value = source[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum) metadata[key] = value;
  };
  const choice = (key: string, values: readonly string[]) => {
    const value = source[key];
    if (typeof value === 'string' && values.includes(value)) metadata[key] = value;
  };
  const timestamp = (key: string) => {
    const value = source[key];
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
      const parsed = new Date(value);
      if (Number.isFinite(parsed.getTime()) && parsed.toISOString() === value) metadata[key] = value;
    }
  };
  if (['USER_CHANGE', 'USER_CREATED', 'USER_SIGNED_IN', 'USER_APPROVED', 'USER_REJECTED', 'USER_DISABLED', 'USER_REOPENED', 'USER_ROLE_CHANGED', 'ADMIN_BOOTSTRAPPED'].includes(event.action)) {
    choice('change', ['approve', 'reject', 'disable', 'enable', 'role']);
    choice('role', ['USER', 'ADMIN']);
    choice('status', ['PENDING', 'APPROVED', 'REJECTED', 'DISABLED']);
  } else if (event.action === 'USERS_LIST') {
    integer('page', 1, Number.MAX_SAFE_INTEGER);
    integer('pageSize', 1, 100);
    integer('resultCount', 0, Number.MAX_SAFE_INTEGER);
    integer('queryLength', 0, Number.MAX_SAFE_INTEGER);
    choice('status', ['PENDING', 'APPROVED', 'REJECTED', 'DISABLED']);
    choice('role', ['USER', 'ADMIN']);
    if (typeof source.queryHash === 'string' && /^[a-f0-9]{64}$/.test(source.queryHash)) metadata.queryHash = source.queryHash;
  } else if (event.action === 'REQUEST_FAILED') {
    integer('statusCode', 400, 599);
  } else if (event.action === 'INTEGRATIONS_LIST') {
    integer('page', 1, Number.MAX_SAFE_INTEGER);
    integer('pageSize', 1, 50);
    integer('resultCount', 0, 50);
  } else if (['INTEGRATION_CREATED', 'INTEGRATION_UPDATED', 'API_KEY_CREATED', 'API_KEY_ROTATED', 'API_KEY_REVOKED'].includes(event.action)) {
    if (typeof source.enabled === 'boolean') metadata.enabled = source.enabled;
    integer('capabilityCount', 0, 8);
    if (typeof source.overlapHours === 'number' && Number.isFinite(source.overlapHours) && source.overlapHours >= 0 && source.overlapHours <= 24) metadata.overlapHours = source.overlapHours;
    timestamp('expiresAt');
    timestamp('revokesAt');
  }
  if (event.outcome === 'FAILURE' || event.outcome === 'DENIED') integer('statusCode', 400, 599);
  if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 2048) throw unavailable();
  return metadata;
}

function eventData(event: AuditEventInput): Prisma.AuditEventUncheckedCreateInput {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(event.requestId) || !actions.includes(event.action)
    || !['shared', 'call-for-sites'].includes(event.module) || !['SUCCESS', 'FAILURE', 'DENIED'].includes(event.outcome)) throw unavailable();
  const data: Prisma.AuditEventUncheckedCreateInput = {
    requestId: event.requestId, actorType: 'UNKNOWN', module: event.module, action: event.action,
    outcome: event.outcome, metadata: metadataFor(event),
  };
  const actor = event.actor;
  if (actor?.type === 'USER') {
    if (!uuid.test(actor.user.id)) throw unavailable();
    data.actorType = 'USER'; data.actorUserId = actor.user.id;
  } else if (actor?.type === 'INTEGRATION') {
    if (!uuid.test(actor.integrationId) || !uuid.test(actor.keyId)) throw unavailable();
    data.actorType = 'INTEGRATION'; data.actorIntegrationId = actor.integrationId; data.actorKeyId = actor.keyId;
  } else if (actor?.type === 'SYSTEM') data.actorType = 'SYSTEM';
  else if (actor !== null) throw unavailable();
  if (event.target) {
    if (!uuid.test(event.target.id) || !['user', 'submission', 'integration', 'api-key'].includes(event.target.type)) throw unavailable();
    data.targetType = event.target.type; data.targetId = event.target.id;
  }
  if (event.channel) {
    if (!['FILE_JSON', 'FILE_ZIP', 'INTEGRATION_API'].includes(event.channel)) throw unavailable();
    data.channel = event.channel;
  }
  if (event.errorCode) data.errorCode = safeAuditErrorCode(event.errorCode);
  return data;
}

export function createAuditService(writer: AuditWriter): AuditService {
  return {
    async record(event, transaction = writer) {
      try { await transaction.auditEvent.create({ data: eventData(event) }); }
      catch { throw unavailable(); }
    },
  };
}

// A missing audit dependency must never turn audited operations into successful responses.
export const unavailableAuditService: AuditService = { async record() { throw unavailable(); } };
