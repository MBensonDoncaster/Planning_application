import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { MODULE_REGISTRY, type Capability, type ApiKeySummary, type IntegrationSummary, type IntegrationListing, type KeyCreatedResponse, type KeyRotatedResponse } from '@planning/contracts';
import { z } from 'zod';
import type { ApiKey, Integration, Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type { Config } from '../../config/env.js';
import { requireCapability, type IntegrationActor, type UserActor } from '../../shared/actors.js';
import { createAuditService, type AuditContext, type AuditService, type AuditAction } from '../../shared/audit.js';
import { AppError } from '../../shared/errors.js';

const text = z.string().trim().min(1).max(200);
export const integrationCreateSchema = z.object({ name: text, description: z.string().trim().max(2000).optional() }).strict();
export const integrationUpdateSchema = z.object({ name: text.optional(), description: z.string().trim().max(2000).nullable().optional(), enabled: z.boolean().optional() }).strict().refine(value => Object.keys(value).length > 0);
const expiry = z.iso.datetime({ offset: true }).optional();
export const keyCreateSchema = z.object({ label: text, capabilities: z.array(z.string()).min(1), expiresAt: expiry }).strict();
export const keyRotateSchema = z.object({ expiresAt: expiry, overlapHours: z.number().min(0).max(24).default(0) }).strict();
const integrationSafe = () => [...new Set(MODULE_REGISTRY.flatMap(module => module.integrationSafeCapabilities))];
const missing = () => new AppError(404, 'NOT_FOUND', 'The administrative target was not found.');
const conflict = () => new AppError(409, 'REQUEST_CONFLICT', 'The requested change conflicts with the current state.');
const invalidKey = () => new AppError(401, 'INVALID_CREDENTIALS', 'The API key is invalid or inactive.');
type ExpiryConfig = Pick<Config, 'API_KEY_DEFAULT_EXPIRY_DAYS' | 'API_KEY_MAX_EXPIRY_DAYS'>;

function effectiveExpiry(row: ApiKey): Date { return row.revokedAt && row.revokedAt < row.expiresAt ? row.revokedAt : row.expiresAt; }
function safeKey(row: ApiKey, enabled: boolean, now: Date): ApiKeySummary {
  const capabilities = row.capabilities.filter((scope): scope is Capability => integrationSafe().includes(scope as Capability));
  const status = row.revokedAt && row.revokedAt <= now ? 'REVOKED' : row.expiresAt <= now ? 'EXPIRED' : !enabled ? 'DISABLED' : row.revokedAt ? 'SCHEDULED_REVOCATION' : 'ACTIVE';
  return {
    id: row.id, integrationId: row.integrationId, label: row.label, publicPrefix: row.publicPrefix,
    capabilities: row.capabilities, effectiveCapabilities: status === 'ACTIVE' || status === 'SCHEDULED_REVOCATION' ? capabilities : [],
    status, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
    effectiveExpiresAt: effectiveExpiry(row).toISOString(), revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null, createdByUserId: row.createdByUserId, revokedByUserId: row.revokedByUserId,
  };
}
function safeIntegration(row: Integration): IntegrationSummary {
  return { id: row.id, name: row.name, description: row.description, enabled: row.enabled,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), createdByUserId: row.createdByUserId };
}

export function createIntegrationService(db: PrismaClient, config: ExpiryConfig, audit: AuditService = createAuditService(db)) {
  async function administrator(tx: Prisma.TransactionClient, actor: UserActor): Promise<UserActor> {
    // Coordinate with user administration so a permission change cannot race a write.
    await tx.$executeRaw`LOCK TABLE "users" IN SHARE ROW EXCLUSIVE MODE`;
    const current = await tx.user.findUnique({ where: { id: actor.user.id } });
    if (!current) throw new AppError(403, 'FORBIDDEN', 'Administrator access is required.');
    const { ssoSubject, ...user } = current;
    const fresh: UserActor = { type: 'USER', user: { ...user, subject: ssoSubject } };
    requireCapability(fresh, 'integrations.manage');
    return fresh;
  }
  async function lockIntegration(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT "id" FROM "integrations" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const row = await tx.integration.findUnique({ where: { id } });
    if (!row) throw missing();
    return row;
  }
  async function keyAndIntegration(tx: Prisma.TransactionClient, id: string) {
    const found = await tx.apiKey.findUnique({ where: { id } });
    if (!found) throw missing();
    const integration = await lockIntegration(tx, found.integrationId);
    const key = await tx.apiKey.findUnique({ where: { id } });
    if (!key) throw missing();
    return { key, integration };
  }
  function expiresAt(value: string | undefined, now: Date) {
    const result = value ? new Date(value) : new Date(now.getTime() + config.API_KEY_DEFAULT_EXPIRY_DAYS * 86400000);
    if (!Number.isFinite(result.getTime()) || result <= now || result.getTime() > now.getTime() + config.API_KEY_MAX_EXPIRY_DAYS * 86400000) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Key expiry must be in the future and within the configured maximum.');
    }
    return result;
  }
  function scopes(values: string[]) {
    if (!values.length || values.some(value => !integrationSafe().includes(value as Capability))) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Only integration submission capabilities may be granted.');
    }
    return [...new Set(values)];
  }
  async function generate(tx: Prisma.TransactionClient, actor: UserActor, integrationId: string, label: string, capabilities: string[], expiryValue: string | undefined, now: Date) {
    const id = randomUUID();
    const publicPrefix = `pln_${id}`;
    const secret = `${publicPrefix}.${randomBytes(32).toString('base64url')}`;
    const key = await tx.apiKey.create({ data: { id, integrationId, label, capabilities: scopes(capabilities),
      publicPrefix, secretDigest: createHash('sha256').update(secret).digest('hex'), createdAt: now,
      expiresAt: expiresAt(expiryValue, now), createdByUserId: actor.user.id } });
    return { key, secret };
  }
  async function record(tx: Prisma.TransactionClient, actor: UserActor, context: AuditContext, action: AuditAction, target: { type: 'integration' | 'api-key'; id: string }, metadata: unknown = {}) {
    await audit.record({ ...context, actor, module: 'shared', action, target, outcome: 'SUCCESS', metadata }, tx);
  }
  async function write<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try { return await db.$transaction(operation); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') throw conflict();
      throw error;
    }
  }
  return {
    async list(actor: UserActor, page: number, context: AuditContext): Promise<IntegrationListing> {
      requireCapability(actor, 'integrations.manage');
      const [rows, total] = await db.$transaction([
        db.integration.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * 50, take: 50,
          include: { keys: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] } } }), db.integration.count(),
      ]);
      const now = new Date();
      await audit.record({ ...context, actor, module: 'shared', action: 'INTEGRATIONS_LIST', outcome: 'SUCCESS', metadata: { page, pageSize: 50, resultCount: rows.length } });
      return { integrations: rows.map(row => ({ ...safeIntegration(row), keys: row.keys.map(key => safeKey(key, row.enabled, now)) })), total, page, pageSize: 50 };
    },
    async create(actor: UserActor, input: z.input<typeof integrationCreateSchema>, context: AuditContext): Promise<IntegrationSummary> {
      const body = integrationCreateSchema.parse(input);
      return write(async tx => {
        const fresh = await administrator(tx, actor);
        const row = await tx.integration.create({ data: { ...body, createdByUserId: fresh.user.id } });
        await record(tx, fresh, context, 'INTEGRATION_CREATED', { type: 'integration', id: row.id }, { enabled: row.enabled });
        return safeIntegration(row);
      });
    },
    async update(actor: UserActor, id: string, input: z.input<typeof integrationUpdateSchema>, context: AuditContext): Promise<IntegrationSummary> {
      const body = integrationUpdateSchema.parse(input);
      return write(async tx => {
        const fresh = await administrator(tx, actor);
        await lockIntegration(tx, id);
        const row = await tx.integration.update({ where: { id }, data: body });
        await record(tx, fresh, context, 'INTEGRATION_UPDATED', { type: 'integration', id }, { enabled: row.enabled });
        return safeIntegration(row);
      });
    },
    async createKey(actor: UserActor, id: string, input: z.input<typeof keyCreateSchema>, context: AuditContext): Promise<KeyCreatedResponse> {
      const body = keyCreateSchema.parse(input);
      return write(async tx => {
        const fresh = await administrator(tx, actor);
        const integration = await lockIntegration(tx, id);
        const now = new Date();
        const { key, secret } = await generate(tx, fresh, id, body.label, body.capabilities, body.expiresAt, now);
        await record(tx, fresh, context, 'API_KEY_CREATED', { type: 'api-key', id: key.id }, { capabilityCount: key.capabilities.length, expiresAt: key.expiresAt.toISOString() });
        return { key: safeKey(key, integration.enabled, now), secret };
      });
    },
    async rotateKey(actor: UserActor, id: string, input: z.input<typeof keyRotateSchema>, context: AuditContext): Promise<KeyRotatedResponse> {
      const body = keyRotateSchema.parse(input);
      return write(async tx => {
        const fresh = await administrator(tx, actor);
        const { key: previous, integration } = await keyAndIntegration(tx, id);
        const now = new Date();
        if (previous.revokedAt || previous.expiresAt <= now) throw conflict();
        const { key, secret } = await generate(tx, fresh, integration.id, previous.label, previous.capabilities, body.expiresAt, now);
        const revokesAt = new Date(Math.min(previous.expiresAt.getTime(), now.getTime() + body.overlapHours * 3600000));
        await tx.apiKey.update({ where: { id }, data: { revokedAt: revokesAt, revokedByUserId: fresh.user.id } });
        await record(tx, fresh, context, 'API_KEY_ROTATED', { type: 'api-key', id }, { overlapHours: body.overlapHours, expiresAt: key.expiresAt.toISOString(), revokesAt: revokesAt.toISOString(), capabilityCount: key.capabilities.length });
        return { key: safeKey(key, integration.enabled, now), secret, previousKeyRevokesAt: revokesAt.toISOString() };
      });
    },
    async revokeKey(actor: UserActor, id: string, context: AuditContext): Promise<ApiKeySummary> {
      return write(async tx => {
        const fresh = await administrator(tx, actor);
        const { key, integration } = await keyAndIntegration(tx, id);
        const now = new Date();
        const revoked = key.revokedAt && key.revokedAt <= now ? key : await tx.apiKey.update({ where: { id }, data: { revokedAt: now, revokedByUserId: fresh.user.id } });
        await record(tx, fresh, context, 'API_KEY_REVOKED', { type: 'api-key', id }, { revokesAt: revoked.revokedAt!.toISOString() });
        return safeKey(revoked, integration.enabled, now);
      });
    },
    async authenticateKey(secret: string): Promise<IntegrationActor> {
      // Bound and validate input before looking up a public identifier; never echo a credential.
      const match = /^pln_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/.exec(secret);
      if (!match) throw invalidKey();
      return db.$transaction(async tx => {
        const found = await tx.apiKey.findUnique({ where: { id: match[1] } });
        if (!found) throw invalidKey();
        await tx.$queryRaw`SELECT "id" FROM "integrations" WHERE "id" = ${found.integrationId}::uuid FOR UPDATE`;
        const integration = await tx.integration.findUnique({ where: { id: found.integrationId } });
        const key = await tx.apiKey.findUnique({ where: { id: found.id } });
        const now = new Date();
        if (!integration?.enabled || !key || effectiveExpiry(key) <= now) throw invalidKey();
        const stored = Buffer.from(key.secretDigest, 'hex');
        const digest = createHash('sha256').update(secret).digest();
        if (stored.length !== digest.length || !timingSafeEqual(stored, digest)) throw invalidKey();
        const capabilities = key.capabilities.filter((scope): scope is Capability => integrationSafe().includes(scope as Capability));
        if (!capabilities.length) throw invalidKey();
        await tx.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: now } });
        return { type: 'INTEGRATION', integrationId: integration.id, keyId: key.id, capabilities };
      });
    },
  };
}
export type IntegrationService = ReturnType<typeof createIntegrationService>;
