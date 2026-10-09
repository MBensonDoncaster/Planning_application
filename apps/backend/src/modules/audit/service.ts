import type { AuditEventListing, AuditEventSummary } from '@planning/contracts';
import { z } from 'zod';
import type { AuditEvent, Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { requireCapability, type UserActor } from '../../shared/actors.js';
import { createAuditService, safeAuditMetadata, type AuditContext, type AuditService } from '../../shared/audit.js';

export const auditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().refine(value => value === 50).default(50),
  dateFrom: z.iso.datetime({ offset: true }).optional(),
  dateTo: z.iso.datetime({ offset: true }).optional(),
  actorType: z.enum(['USER', 'INTEGRATION', 'SYSTEM', 'UNKNOWN']).optional(),
  actorId: z.uuid().optional(),
  module: z.enum(['shared', 'call-for-sites']).optional(),
  action: z.string().min(1).max(100).regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  outcome: z.enum(['SUCCESS', 'FAILURE', 'DENIED']).optional(),
  targetId: z.uuid().optional(),
}).strict().refine(value => !value.dateFrom || !value.dateTo || new Date(value.dateFrom) < new Date(value.dateTo), {
  path: ['dateTo'], message: 'The upper time bound must be later than the lower time bound.',
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;
export interface AuditReviewService {
  list(actor: UserActor, input: unknown, context: AuditContext): Promise<AuditEventListing>;
}

function summary(row: AuditEvent): AuditEventSummary {
  return {
    id: row.id, occurredAt: row.occurredAt.toISOString(), requestId: row.requestId,
    actorType: row.actorType, actorUserId: row.actorUserId, actorIntegrationId: row.actorIntegrationId,
    actorKeyId: row.actorKeyId, module: row.module, action: row.action.slice(0, 100),
    targetType: row.targetType, targetId: row.targetId, outcome: row.outcome,
    errorCode: row.errorCode, channel: row.channel, metadata: safeAuditMetadata(row),
  };
}

export function createAuditReviewService(database: PrismaClient, audit: AuditService = createAuditService(database)): AuditReviewService {
  return {
    async list(actor, input, context) {
      requireCapability(actor, 'audit.read');
      const query = auditQuerySchema.parse(input);
      const where: Prisma.AuditEventWhereInput = {
        actorType: query.actorType, module: query.module, action: query.action,
        outcome: query.outcome, targetId: query.targetId,
        ...(query.actorId ? { OR: [{ actorUserId: query.actorId }, { actorIntegrationId: query.actorId }, { actorKeyId: query.actorId }] } : {}),
        ...(query.dateFrom || query.dateTo ? { occurredAt: {
          ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
          ...(query.dateTo ? { lt: new Date(query.dateTo) } : {}),
        } } : {}),
      };
      return database.$transaction(async transaction => {
        const total = await transaction.auditEvent.count({ where });
        const rows = await transaction.auditEvent.findMany({ where, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * 50, take: 50 });
        const result: AuditEventListing = { events: rows.map(summary), total, page: query.page, pageSize: 50 };
        await audit.record({ ...context, actor, module: 'shared', action: 'AUDIT_EVENTS_LIST', outcome: 'SUCCESS', metadata: {
          page: query.page, pageSize: 50, resultCount: rows.length,
          actorType: query.actorType, module: query.module, outcome: query.outcome,
          dateFrom: query.dateFrom ? new Date(query.dateFrom).toISOString() : undefined,
          dateTo: query.dateTo ? new Date(query.dateTo).toISOString() : undefined,
          hasDateFrom: Boolean(query.dateFrom), hasDateTo: Boolean(query.dateTo),
          hasActorId: Boolean(query.actorId), hasAction: Boolean(query.action), hasTargetId: Boolean(query.targetId),
        } }, transaction);
        return result;
      }, { isolationLevel: 'RepeatableRead' });
    },
  };
}
