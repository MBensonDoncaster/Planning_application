import Fastify, { LogController } from 'fastify';
import helmet from '@fastify/helmet';
import { createMemoryRateLimiter, unavailableRateLimiter, type RateLimiter } from './shared/rate-limits.js';
import { consumeRequestBudget, registerExternalSubmissionRoute, type ExternalSubmissionHandler } from './plugins/external-auth.js';
import staticFiles from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Config } from './config/env.js';
import type { Identity, User, UserRepository } from './modules/users/types.js';
import { AppError, requireApproved } from './modules/users/service.js';
import { createIdentityVerifier, type VerifyIdentity } from './plugins/auth.js';
import { installErrorHandler } from './plugins/errors.js';
import { isDeployed } from './config/env.js';
import { publicAppConfig } from './config/public.js';
import { requireCapability, type Actor } from './shared/actors.js';
import { sessionForUser } from './shared/session.js';
import { unavailableAuditService, type AuditService } from './shared/audit.js';
import { auditRequestFailure, requestAuditEvent } from './plugins/audit.js';
import { createHash } from 'node:crypto';
import type { IntegrationService } from './modules/integrations/service.js';
import { registerIntegrationRoutes } from './modules/integrations/routes.js';

declare module 'fastify' {
  interface FastifyRequest { user: User | null; actor: Actor | null }
}

export async function createApp(config: Config, users: UserRepository, verifier?: VerifyIdentity, audit: AuditService = unavailableAuditService, integrations?: IntegrationService, options: { rateLimiter?: RateLimiter; externalSubmission?: ExternalSubmissionHandler } = {}) {
  const app = Fastify({
    trustProxy: config.TRUST_PROXY === 'true',
    bodyLimit: config.INGESTION_MAX_BODY_BYTES,
    logController: new LogController({ disableRequestLogging: true }),
    logger: config.NODE_ENV === 'test' ? false : {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    },
  });
  app.decorateRequest('user', null);
  app.decorateRequest('actor', null);
  installErrorHandler(app, (request, status, code) => auditRequestFailure(audit, request, status, code));
  await app.register(helmet, {
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", 'https://login.microsoftonline.com'],
      frameSrc: ['https://login.microsoftonline.com'],
      imgSrc: ["'self'", 'data:'], objectSrc: ["'none'"],
      // Local HTTP remains usable; deployed entry points must terminate TLS.
      upgradeInsecureRequests: isDeployed(config) ? [] : null,
    } },
  });
  const limiter = options.rateLimiter ?? (config.NODE_ENV === 'test' ? createMemoryRateLimiter(config) : unavailableRateLimiter);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
    if (request.url.startsWith('/api/') || request.url.startsWith('/health')) reply.header('Cache-Control', 'no-store');
    if (request.routeOptions.url !== '/api/v1/integrations/call-for-sites/submissions' && request.headers.authorization !== undefined && request.headers['x-api-key'] !== undefined) throw new AppError(400, 'AMBIGUOUS_AUTHENTICATION', 'Supply only one credential method.');
    if (request.routeOptions.url !== '/api/v1/integrations/call-for-sites/submissions' && request.headers['content-encoding'] !== undefined && request.headers['content-encoding'] !== 'identity') {
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Compressed request bodies are not supported.');
    }
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => {
    try { await users.ready(); return { status: 'ready' }; }
    catch { throw new AppError(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable. Try again later.'); }
  });
  app.get('/api/v1/auth/config', async () => ({
    appName: config.APP_NAME, mode: config.AUTH_MODE,
    ...(config.AUTH_MODE === 'ENTRA' ? {
      tenantId: config.ENTRA_TENANT_ID, clientId: config.ENTRA_SPA_CLIENT_ID,
      scope: config.ENTRA_SCOPE, redirectUri: config.APP_ORIGIN,
    } : {}),
  }));
  const verify = config.AUTH_MODE === 'ENTRA' ? verifier ?? createIdentityVerifier(config) : undefined;
  await app.register(async protectedRoutes => {
    protectedRoutes.addHook('onRequest', async (request, reply) => {
      if (request.headers['x-api-key'] !== undefined) throw new AppError(401, 'INVALID_CREDENTIALS', 'API keys cannot access human endpoints.');
      let identity: Identity;
      if (config.AUTH_MODE === 'TEST_USER') {
        identity = { subject: config.TEST_USER_SUBJECT, email: config.TEST_USER_EMAIL, displayName: config.TEST_USER_NAME };
      } else {
        const authorization = request.headers.authorization;
        if (!authorization || !/^Bearer \S+$/i.test(authorization)) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Sign in to continue.');
        identity = await verify!(authorization.slice(7));
      }
      // Every protected read consults current local access; only the session endpoint writes profile/login data.
      request.user = await users.findBySubject(identity.subject);
      if (request.user) {
        request.actor = { type: 'USER', user: request.user };
        await consumeRequestBudget(limiter, 'USER', request.user.id, reply);
        if (request.user.status === 'APPROVED') {
          const writes = ['PATCH', 'PUT', 'DELETE'].includes(request.method) || (request.method === 'POST' &&
            (request.routeOptions.url?.startsWith('/api/v1/admin/') || request.routeOptions.url === '/api/v1/call-for-sites/submissions'));
          if (writes) await consumeRequestBudget(limiter, 'USER_WRITE', request.user.id, reply);
        }
      }
      if (request.routeOptions.url === '/api/v1/auth/me') {
        request.user = await users.authenticate(identity, { requestId: request.id });
        request.actor = { type: 'USER', user: request.user };
      }
      if (!request.user) throw new AppError(403, 'USER_NOT_APPROVED', 'Your account does not have approved access.');
    });
    protectedRoutes.get('/api/v1/auth/me', async request => sessionForUser(request.user!));
    protectedRoutes.get('/api/v1/app/config', async request => {
      requireApproved(request.user!);
      await audit.record(requestAuditEvent(request));
      return publicAppConfig(config);
    });
    protectedRoutes.get('/api/v1/home', async request => {
      requireCapability(request.actor, 'call-for-sites.read');
      await audit.record(requestAuditEvent(request));
      return { message: `Welcome to ${config.APP_NAME}` };
    });
    await protectedRoutes.register(async admin => {
      admin.addHook('preHandler', async request => { requireCapability(request.actor, 'users.manage'); });
      admin.get('/api/v1/admin/users', async request => {
        const query = z.object({
          page: z.coerce.number().int().min(1).max(100_000).default(1),
          pageSize: z.coerce.number().int().refine(value => value === 50).default(50),
          text: z.string().max(200).default(''),
          status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'DISABLED']).optional(),
          role: z.enum(['USER', 'ADMIN']).optional(),
        }).strict().parse(request.query);
        const result = await users.list({ ...query, search: query.text });
        await audit.record({ ...requestAuditEvent(request), metadata: {
          page: query.page, pageSize: query.pageSize, status: query.status,
          role: query.role, resultCount: result.users.length, queryHash: createHash('sha256').update(query.text).digest('hex'),
          queryLength: Array.from(query.text).length,
        } });
        return { ...result, page: query.page, pageSize: query.pageSize };
      });
      for (const action of ['approve', 'reject', 'disable', 'enable'] as const) admin.post(`/api/v1/admin/users/:id/${action}`, async request => {
        const { id } = z.object({ id: z.uuid() }).parse(request.params);
        if (request.body !== undefined) throw new AppError(400, 'VALIDATION_ERROR', 'This action does not accept a request body.');
        return users.change(request.user!.id, id, { action }, { requestId: request.id });
      });
      admin.patch('/api/v1/admin/users/:id/role', async request => {
        const { id } = z.object({ id: z.uuid() }).parse(request.params);
        const { role } = z.object({ role: z.enum(['USER', 'ADMIN']) }).strict().parse(request.body);
        return users.change(request.user!.id, id, { action: 'role', role }, { requestId: request.id });
      });
    });
    if (integrations) await registerIntegrationRoutes(protectedRoutes, integrations);
  });
  await registerExternalSubmissionRoute(app, integrations, limiter, options.externalSubmission);
  if (config.SERVE_FRONTEND === 'true' || (config.SERVE_FRONTEND !== 'false' && isDeployed(config))) {
    const root = config.FRONTEND_DIST_DIR ?? fileURLToPath(new URL('../../frontend/dist/', import.meta.url));
    await app.register(staticFiles, { root });
    app.setNotFoundHandler(async (request, reply) => {
      const pathname = request.url.split('?')[0];
      if (request.method !== 'GET' || /^\/(api|health)(\/|$)/.test(pathname) || pathname.includes('.') || !request.headers.accept?.includes('text/html')) {
        throw new AppError(404, 'NOT_FOUND', 'Not found.');
      }
      reply.header('Cache-Control', 'no-store');
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler(async () => { throw new AppError(404, 'NOT_FOUND', 'Not found.'); });
  }
  app.addHook('onClose', async () => { await users.close(); });
  return app;
}
