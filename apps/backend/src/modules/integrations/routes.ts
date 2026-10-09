import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCapability, type UserActor } from '../../shared/actors.js';
import type { IntegrationService } from './service.js';
import { integrationCreateSchema, integrationUpdateSchema, keyCreateSchema, keyRotateSchema } from './service.js';

export async function registerIntegrationRoutes(app: FastifyInstance, service: IntegrationService) {
  await app.register(async routes => {
    routes.addHook('preHandler', async request => { requireCapability(request.actor, 'integrations.manage'); });
    const actor = (value: unknown) => value as UserActor;
    const target = (params: unknown) => z.object({ id: z.uuid() }).parse(params).id;
    routes.get('/api/v1/admin/integrations', async request => {
      const { page } = z.object({ page: z.coerce.number().int().min(1).max(100_000).default(1) }).strict().parse(request.query);
      return service.list(actor(request.actor), page, { requestId: request.id });
    });
    routes.post('/api/v1/admin/integrations', async (request, reply) => {
      const result = await service.create(actor(request.actor), integrationCreateSchema.parse(request.body), { requestId: request.id });
      return reply.code(201).send(result);
    });
    routes.patch('/api/v1/admin/integrations/:id', async request => service.update(actor(request.actor), target(request.params), integrationUpdateSchema.parse(request.body), { requestId: request.id }));
    routes.post('/api/v1/admin/integrations/:id/keys', async (request, reply) => {
      const result = await service.createKey(actor(request.actor), target(request.params), keyCreateSchema.parse(request.body), { requestId: request.id });
      return reply.header('Cache-Control', 'no-store').code(201).send(result);
    });
    routes.post('/api/v1/admin/api-keys/:id/rotate', async (request, reply) => {
      const result = await service.rotateKey(actor(request.actor), target(request.params), keyRotateSchema.parse(request.body), { requestId: request.id });
      return reply.header('Cache-Control', 'no-store').code(201).send(result);
    });
    routes.post('/api/v1/admin/api-keys/:id/revoke', async request => {
      z.undefined().parse(request.body);
      return service.revokeKey(actor(request.actor), target(request.params), { requestId: request.id });
    });
  });
}
