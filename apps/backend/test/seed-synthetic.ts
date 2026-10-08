import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { readConfig } from '../src/config/env.js';
import { requireSyntheticSeed, seedSyntheticUsers } from './support/synthetic-users.js';
import { deployMigrations, requireTestDatabase } from './support/database.js';

// TEST_DATABASE_URL is mandatory; never seed DATABASE_URL by accident.
const config = readConfig();
requireSyntheticSeed(config, process.env.TEST_DATABASE_URL);
const url = requireTestDatabase(process.env.TEST_DATABASE_URL).toString();
await deployMigrations(url);
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
try {
  await seedSyntheticUsers(db);
  console.info('Seeded five synthetic test users. Submission seeding will be added with domain ingestion support.');
} finally { await db.$disconnect(); }
