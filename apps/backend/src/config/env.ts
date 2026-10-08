import 'dotenv/config';
import { z } from 'zod';

const positiveInteger = () => z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
function validTimezone(value: string): boolean {
  if (!/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(value)) return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: value }).format(); return true; }
  catch { return false; }
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DEPLOYMENT_PROFILE: z.enum(['local', 'test', 'staging', 'production']).default('local'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_NAME: z.string().min(1).max(100).default('Planning'),
  APP_ORIGIN: z.url().default('http://localhost:5173'),
  DATABASE_URL: z.string().regex(/^postgres(?:ql)?:\/\//),
  AUTH_MODE: z.enum(['TEST_USER', 'ENTRA']).default('ENTRA'),
  ENTRA_TENANT_ID: z.string().default(''),
  ENTRA_API_CLIENT_ID: z.string().default(''),
  ENTRA_SPA_CLIENT_ID: z.string().default(''),
  ENTRA_SCOPE: z.string().default(''),
  TEST_USER_SUBJECT: z.string().min(1).max(255).default('local:developer'),
  TEST_USER_EMAIL: z.email().max(320).default('developer@example.test'),
  TEST_USER_NAME: z.string().min(1).max(200).default('Local Developer'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  BUSINESS_TIMEZONE: z.string().refine(validTimezone, 'Use a valid IANA timezone.').default('Europe/London'),
  INGESTION_MAX_BODY_BYTES: positiveInteger().default(10_485_760),
  UPLOAD_MAX_FILE_BYTES: positiveInteger().default(5_242_880),
  ZIP_MAX_ENTRIES: positiveInteger().default(1_000),
  JSON_MAX_DEPTH: positiveInteger().default(100),
  GEOJSON_MAX_POSITIONS: positiveInteger().default(100_000),
  EXPORT_MAX_SELECTION: positiveInteger().max(500).default(500),
  EXPORT_MAX_BYTES: positiveInteger().default(104_857_600),
  EXPORT_GENERATION_TIMEOUT_MS: positiveInteger().default(30_000),
  EXPORT_DOWNLOAD_TIMEOUT_MS: positiveInteger().default(120_000),
  IDEMPOTENCY_RETENTION_DAYS: positiveInteger().default(30),
  API_KEY_DEFAULT_EXPIRY_DAYS: positiveInteger().default(90),
  API_KEY_MAX_EXPIRY_DAYS: positiveInteger().max(365).default(365),
  RATE_LIMIT_MAX: positiveInteger().default(120),
  RATE_LIMIT_WINDOW_MS: positiveInteger().default(60_000),
  RATE_LIMIT_USER_MAX: positiveInteger().default(120),
  RATE_LIMIT_WRITE_MAX: positiveInteger().default(30),
  RATE_LIMIT_KEY_MAX: positiveInteger().default(30),
  RATE_LIMIT_INTEGRATION_IP_MAX: positiveInteger().default(120),
  SERVE_FRONTEND: z.enum(['true', 'false']).optional(),
  FRONTEND_DIST_DIR: z.string().optional(),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
});

export type Config = z.infer<typeof schema>;

export function isDeployed(config: Config): boolean {
  return config.NODE_ENV === 'production' || config.DEPLOYMENT_PROFILE === 'staging' || config.DEPLOYMENT_PROFILE === 'production';
}

export function readConfig(input: Record<string, unknown> = process.env): Config {
  const config = schema.parse({
    ...input,
    DEPLOYMENT_PROFILE: input.DEPLOYMENT_PROFILE ?? (input.NODE_ENV === 'production' ? 'production' : input.NODE_ENV === 'test' ? 'test' : 'local'),
  });
  const origin = new URL(config.APP_ORIGIN);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.origin !== config.APP_ORIGIN) {
    throw new Error('APP_ORIGIN must be an HTTP(S) origin without a path or trailing slash');
  }
  if (config.NODE_ENV === 'production' && config.AUTH_MODE !== 'ENTRA') {
    throw new Error('Production requires AUTH_MODE=ENTRA');
  }
  if (isDeployed(config) && config.AUTH_MODE !== 'ENTRA') {
    throw new Error('Deployed staging/production profiles require AUTH_MODE=ENTRA');
  }
  if (isDeployed(config) && origin.protocol !== 'https:') {
    throw new Error('Deployed staging/production profiles require an HTTPS APP_ORIGIN');
  }
  if (config.AUTH_MODE === 'TEST_USER' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
    throw new Error('TEST_USER requires a localhost APP_ORIGIN');
  }
  if (config.API_KEY_DEFAULT_EXPIRY_DAYS > config.API_KEY_MAX_EXPIRY_DAYS) {
    throw new Error('API_KEY_DEFAULT_EXPIRY_DAYS must not exceed API_KEY_MAX_EXPIRY_DAYS');
  }
  if (config.EXPORT_GENERATION_TIMEOUT_MS > config.EXPORT_DOWNLOAD_TIMEOUT_MS) {
    throw new Error('EXPORT_GENERATION_TIMEOUT_MS must not exceed EXPORT_DOWNLOAD_TIMEOUT_MS');
  }
  if (config.AUTH_MODE === 'ENTRA') {
    for (const name of ['ENTRA_TENANT_ID', 'ENTRA_API_CLIENT_ID', 'ENTRA_SPA_CLIENT_ID'] as const) {
      if (!z.uuid().safeParse(config[name]).success) throw new Error(`${name} must be a UUID`);
    }
    const scopePrefix = `api://${config.ENTRA_API_CLIENT_ID}/`;
    if (!config.ENTRA_SCOPE.startsWith(scopePrefix) || !/^[\w.-]+$/.test(config.ENTRA_SCOPE.slice(scopePrefix.length))) {
      throw new Error('ENTRA_SCOPE must be api://<ENTRA_API_CLIENT_ID>/<delegated-scope-name>');
    }
  }
  return config;
}
