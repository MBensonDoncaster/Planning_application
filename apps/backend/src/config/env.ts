import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
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
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(200),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  SERVE_FRONTEND: z.enum(['true', 'false']).optional(),
  FRONTEND_DIST_DIR: z.string().optional(),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
});

export type Config = z.infer<typeof schema>;

export function readConfig(input: Record<string, unknown> = process.env): Config {
  const config = schema.parse(input);
  const origin = new URL(config.APP_ORIGIN);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.origin !== config.APP_ORIGIN) {
    throw new Error('APP_ORIGIN must be an HTTP(S) origin without a path or trailing slash');
  }
  if (config.NODE_ENV === 'production' && config.AUTH_MODE !== 'ENTRA') {
    throw new Error('Production requires AUTH_MODE=ENTRA');
  }
  if (config.NODE_ENV === 'production' && origin.protocol !== 'https:') {
    throw new Error('Production requires an HTTPS APP_ORIGIN');
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
