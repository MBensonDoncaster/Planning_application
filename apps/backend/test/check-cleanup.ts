import { Pool } from 'pg';
import { requireTestDatabase } from './support/database.js';

const pool = new Pool({ connectionString: requireTestDatabase(process.env.TEST_DATABASE_URL).toString() });
try {
  const schemas = await pool.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name ~ '^planning_test_[a-f0-9]{32}$'");
  if (schemas.rows.length) throw new Error('Verification left temporary test schemas behind.');
  console.info('Verified database and browser test schema cleanup.');
} finally { await pool.end(); }
