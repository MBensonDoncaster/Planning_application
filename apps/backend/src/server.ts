import { createPostgresRateLimiter } from './shared/rate-limits.js';
import { readConfig } from './config/env.js';
import { createDatabase } from './database/prisma.js';
import { createUserRepository } from './modules/users/repository.js';
import { createApp } from './app.js';
import { createAuditService } from './shared/audit.js';
import { createIntegrationService } from './modules/integrations/service.js';

const config = readConfig();
const database = createDatabase(config.DATABASE_URL);
const audit = createAuditService(database);
const integrations = createIntegrationService(database, config, audit);
const app = await createApp(config, createUserRepository(database, audit), undefined, audit, integrations, { rateLimiter: createPostgresRateLimiter(database, config) });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    const deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
    void app.close().then(() => { clearTimeout(deadline); process.exit(0); }).catch(() => process.exit(1));
  });
}
try { await app.listen({ host: config.HOST, port: config.PORT }); }
catch { app.log.error({ errorCode: 'STARTUP_FAILED' }, 'Application could not start'); await app.close(); process.exitCode = 1; }
