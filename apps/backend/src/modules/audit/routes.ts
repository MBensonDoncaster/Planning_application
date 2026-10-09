import type { FastifyInstance } from 'fastify';
import { requireCapability, type UserActor } from '../../shared/actors.js';
import { auditQuerySchema, type AuditReviewService } from './service.js';

export async function registerAuditReviewRoutes(app: FastifyInstance, service: AuditReviewService) {
  await app.register(async routes => {
    routes.addHook('preHandler', async request => { requireCapability(request.actor, 'audit.read'); });
    routes.get('/api/v1/admin/audit-events', async request => service.list(request.actor as UserActor,
      auditQuerySchema.parse(request.query), { requestId: request.id }));
  });
}
