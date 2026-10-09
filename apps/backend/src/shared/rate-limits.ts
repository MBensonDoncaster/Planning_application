import { createHash } from 'node:crypto';
import type { Config } from '../config/env.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { AppError } from './errors.js';

export type RateScope = 'USER' | 'USER_WRITE' | 'API_KEY' | 'INTEGRATION_IP';
export interface RateResult { allowed: boolean; retryAfter: number }
export interface RateLimiter { consume(scope: RateScope, subject: string): Promise<RateResult> }
type RateConfig = Pick<Config, 'RATE_LIMIT_WINDOW_MS' | 'RATE_LIMIT_USER_MAX' | 'RATE_LIMIT_WRITE_MAX' | 'RATE_LIMIT_KEY_MAX' | 'RATE_LIMIT_INTEGRATION_IP_MAX'>;
function maximum(config: RateConfig, scope: RateScope): number {
  return { USER: config.RATE_LIMIT_USER_MAX, USER_WRITE: config.RATE_LIMIT_WRITE_MAX,
    API_KEY: config.RATE_LIMIT_KEY_MAX, INTEGRATION_IP: config.RATE_LIMIT_INTEGRATION_IP_MAX }[scope];
}
const unavailable = () => new AppError(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable. Try again later.');

// The database clock and atomic UPSERT coordinate all application instances.
export function createPostgresRateLimiter(db: PrismaClient, config: RateConfig): RateLimiter {
  return { async consume(scope, subject) {
    const digest = createHash('sha256').update(`${scope}:${subject}`).digest('hex');
    const limit = maximum(config, scope);
    try {
      const result = await db.$queryRaw<{ count: bigint; retryAfter: number }[]>`
        WITH moment AS (SELECT clock_timestamp() AS now), boundary AS (
          SELECT now, to_timestamp(floor(extract(epoch FROM now) * 1000 / ${config.RATE_LIMIT_WINDOW_MS}) * ${config.RATE_LIMIT_WINDOW_MS} / 1000) AS start FROM moment
        ), consumed AS (
          INSERT INTO rate_limit_buckets (scope, subject_digest, window_start, expires_at, count)
          SELECT ${scope}::"RateLimitScope", ${digest}, start, start + ${config.RATE_LIMIT_WINDOW_MS} * interval '1 millisecond', 1 FROM boundary
          ON CONFLICT (scope, subject_digest, window_start)
          DO UPDATE SET count = LEAST(rate_limit_buckets.count + 1, ${limit}::bigint + 1)
          RETURNING count, expires_at
        ) SELECT count, GREATEST(1, ceil(extract(epoch FROM (expires_at - boundary.now))))::integer AS "retryAfter" FROM consumed, boundary`;
      if (result.length !== 1) throw unavailable();
      // Keep expiry cleanup bounded; a failure must not grant requests without a persisted budget.
      await db.$executeRaw`DELETE FROM rate_limit_buckets WHERE (scope, subject_digest, window_start) IN
        (SELECT scope, subject_digest, window_start FROM rate_limit_buckets WHERE expires_at < clock_timestamp() - ${config.RATE_LIMIT_WINDOW_MS} * interval '1 millisecond' LIMIT 100)`;
      return { allowed: result[0].count <= BigInt(limit), retryAfter: result[0].retryAfter };
    } catch { throw unavailable(); }
  } };
}

// Only explicitly local test harnesses may omit PostgreSQL wiring.
export function createMemoryRateLimiter(config: RateConfig): RateLimiter {
  const buckets = new Map<string, { start: number; count: number }>();
  return { async consume(scope, subject) {
    const now = Date.now(), start = Math.floor(now / config.RATE_LIMIT_WINDOW_MS) * config.RATE_LIMIT_WINDOW_MS;
    const digest = createHash('sha256').update(`${scope}:${subject}`).digest('hex');
    const previous = buckets.get(digest);
    const bucket = previous?.start === start ? previous : { start, count: 0 };
    bucket.count = Math.min(bucket.count + 1, maximum(config, scope) + 1);
    buckets.set(digest, bucket);
    if (buckets.size > 1000) for (const [key, value] of buckets) if (value.start < start) buckets.delete(key);
    return { allowed: bucket.count <= maximum(config, scope), retryAfter: Math.max(1, Math.ceil((start + config.RATE_LIMIT_WINDOW_MS - now) / 1000)) };
  } };
}

export const unavailableRateLimiter: RateLimiter = { consume: async () => { throw unavailable(); } };
