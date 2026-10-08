import { readConfig } from './config/env.js';
import { createDatabase } from './database/prisma.js';
import { createUserRepository } from './modules/users/repository.js';
import { createApp } from './app.js';

const config = readConfig();
const app = await createApp(config, createUserRepository(createDatabase(config.DATABASE_URL)));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    const deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
    void app.close().then(() => { clearTimeout(deadline); process.exit(0); }).catch(() => process.exit(1));
  });
}
try { await app.listen({ host: config.HOST, port: config.PORT }); }
catch (error) { app.log.error(error); await app.close(); process.exitCode = 1; }
