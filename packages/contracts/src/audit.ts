export type AuditActorType = 'USER' | 'INTEGRATION' | 'SYSTEM' | 'UNKNOWN';
export type AuditOutcome = 'SUCCESS' | 'FAILURE' | 'DENIED';
export type AuditChannel = 'FILE_JSON' | 'FILE_ZIP' | 'INTEGRATION_API';

export interface AuditEventSummary {
  id: string;
  occurredAt: string;
  requestId: string;
  actorType: AuditActorType;
  actorUserId: string | null;
  actorIntegrationId: string | null;
  actorKeyId: string | null;
  module: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  outcome: AuditOutcome;
  errorCode: string | null;
  channel: AuditChannel | null;
  metadata: Record<string, string | number | boolean>;
}

export interface AuditEventListing {
  events: AuditEventSummary[];
  total: number;
  page: number;
  pageSize: 50;
}
