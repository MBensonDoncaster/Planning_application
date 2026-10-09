import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
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

declare module 'fastify' {
  interface FastifyRequest { user: User | null; actor: Actor | null }
}

const changeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('role'), role: z.enum(['USER', 'ADMIN']) }).strict(),
  ...(['approve', 'reject', 'disable', 'enable'] as const).map(action => z.object({ action: z.literal(action) }).strict()),
]);

export async function createApp(config: Config, users: UserRepository, verifier?: VerifyIdentity) {
  const app = Fastify({
    trustProxy: config.TRUST_PROXY === 'true',
    bodyLimit: config.INGESTION_MAX_BODY_BYTES,
    logger: config.NODE_ENV === 'test' ? false : {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    },
  });
  app.decorateRequest('user', null);
  app.decorateRequest('actor', null);
  installErrorHandler(app);
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
  await app.register(rateLimit, { max: config.RATE_LIMIT_MAX, timeWindow: config.RATE_LIMIT_WINDOW_MS });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
    if (request.url.startsWith('/api/') || request.url.startsWith('/health')) reply.header('Cache-Control', 'no-store');
    if (request.headers['content-encoding'] !== undefined && request.headers['content-encoding'] !== 'identity') {
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
    protectedRoutes.addHook('preHandler', async request => {
      let identity: Identity;
      if (config.AUTH_MODE === 'TEST_USER') {
        identity = { subject: config.TEST_USER_SUBJECT, email: config.TEST_USER_EMAIL, displayName: config.TEST_USER_NAME };
      } else {
        const authorization = request.headers.authorization;
        if (!authorization || !/^Bearer \S+$/i.test(authorization)) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Sign in to continue.');
        identity = await verify!(authorization.slice(7));
      }
      // Every protected read consults current local access; only the session endpoint writes profile/login data.
      request.user = request.routeOptions.url === '/api/v1/auth/me'
        ? await users.authenticate(identity)
        : await users.findBySubject(identity.subject);
      if (!request.user) throw new AppError(403, 'USER_NOT_APPROVED', 'Your account does not have approved access.');
      request.actor = { type: 'USER', user: request.user };
    });
    protectedRoutes.get('/api/v1/auth/me', async request => sessionForUser(request.user!));
    protectedRoutes.get('/api/v1/app/config', async request => {
      requireApproved(request.user!);
      return publicAppConfig(config);
    });
    protectedRoutes.get('/api/v1/home', async request => {
      requireCapability(request.actor, 'call-for-sites.read');
      return { message: `Welcome to ${config.APP_NAME}` };
    });
    await protectedRoutes.register(async admin => {
      admin.addHook('preHandler', async request => { requireCapability(request.actor, 'users.manage'); });
      admin.get('/api/v1/admin/users', async request => {
        const query = z.object({
          page: z.coerce.number().int().min(1).max(100_000).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(20),
          search: z.string().max(200).default(''),
          status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'DISABLED']).optional(),
        }).strict().parse(request.query);
        return { ...await users.list(query), page: query.page, pageSize: query.pageSize };
      });
      admin.patch('/api/v1/admin/users/:id', async request => {
        const { id } = z.object({ id: z.uuid() }).parse(request.params);
        const change = changeSchema.parse(request.body);
        const updated = await users.change(request.user!.id, id, change);
        request.log.info({ actorId: request.user!.id, targetId: id, action: change.action, role: updated.role, status: updated.status }, 'User access changed');
        return updated;
      });
    });
  });
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
