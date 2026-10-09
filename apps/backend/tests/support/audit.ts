import type { AuditEventInput, AuditService } from '../../src/shared/audit.js';

// Explicit dependency for synthetic HTTP repositories; production never uses this collector.
export function syntheticAudit() {
  const events: AuditEventInput[] = [];
  const audit: AuditService = { async record(event) { events.push(structuredClone(event)); } };
  return { audit, events };
}
