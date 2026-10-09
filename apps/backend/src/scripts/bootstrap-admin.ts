import { readConfig } from '../config/env.js';
import { createDatabase } from '../database/prisma.js';
import { bootstrapAdministrator } from '../modules/users/bootstrap.js';
import { randomUUID } from 'node:crypto';

const config = readConfig();
const [subject] = process.argv.slice(2);
if (!subject || process.argv.length !== 3) throw new Error('Usage: npm run admin:bootstrap -- <exact-sso-subject>');
const db = createDatabase(config.DATABASE_URL);
try {
  const user = await bootstrapAdministrator(db, subject, config, randomUUID());
  console.info(`Initial administrator approved: ${user.id} (${user.ssoSubject}). Record the operator and identity verification in your deployment log.`);
} finally { await db.$disconnect(); }
