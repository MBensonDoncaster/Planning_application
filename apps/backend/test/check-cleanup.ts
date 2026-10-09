import { Pool } from 'pg';
import { requireTestDatabase } from './support/database.js';

const pool = new Pool({ connectionString: requireTestDatabase(process.env.TEST_DATABASE_URL).toString() });
try {
  const schemas = await pool.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name ~ '^planning_test_[a-f0-9]{32}$'");
  if (schemas.rows.length) throw new Error('Verification left temporary test schemas behind.');
  const roles = await pool.query("SELECT rolname FROM pg_roles WHERE rolname ~ '^planning_test_runtime_[a-f0-9]{32}$'");
  if (roles.rows.length) throw new Error('Verification left temporary runtime test roles behind.');
  console.info('Verified database and browser test schema cleanup.');
} finally { await pool.end(); }
