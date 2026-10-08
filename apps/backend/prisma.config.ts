import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Generation needs no connection; migration commands must receive a real URL.
  datasource: { url: process.env.DATABASE_URL ?? 'postgresql://build:build@localhost:5432/build' },
});
