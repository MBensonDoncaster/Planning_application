import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config/env.js';
import { requireTestDatabase } from '../test/support/database.js';
import { requireSyntheticSeed } from '../test/support/synthetic-users.js';

const config = readConfig({ NODE_ENV: 'test', AUTH_MODE: 'TEST_USER', DATABASE_URL: 'postgresql://test:test@localhost/planning_test' });
const execute = promisify(execFile);
describe('synthetic verification safety', () => {
  it.each([undefined, 'postgresql://test:test@localhost/planning', 'postgresql://test:test@localhost/planning_test/other', 'https://localhost/planning_test', 'postgresql://test:test@localhost/planning_test?schema=public', 'postgresql://test:test@localhost/planning_test?options=-csearch_path=public'])('refuses unsafe test destinations: %s', url => {
    expect(() => requireTestDatabase(url)).toThrow();
  });
  it.each([
    { NODE_ENV: 'production' }, { DEPLOYMENT_PROFILE: 'staging' }, { DEPLOYMENT_PROFILE: 'production' }, { AUTH_MODE: 'ENTRA' },
  ] as const)('refuses synthetic seeding before database access: %j', extra => {
    expect(() => requireSyntheticSeed({ ...config, ...extra }, config.DATABASE_URL)).toThrow();
  });
  it('allows explicit local test seeding only against a separate test database', () => {
    expect(() => requireSyntheticSeed(config, config.DATABASE_URL)).not.toThrow();
    expect(() => requireSyntheticSeed(config, undefined)).toThrow();
  });
  it.each(['production', 'staging'])('the actual seed CLI refuses %s before connecting', async profile => {
    const api = '22222222-2222-4222-8222-222222222222';
    await expect(execute(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../test/seed-synthetic.ts', import.meta.url))], {
      env: { ...process.env, NODE_ENV: 'production', DEPLOYMENT_PROFILE: profile, AUTH_MODE: 'ENTRA',
        APP_ORIGIN: 'https://synthetic.example.test', DATABASE_URL: 'postgresql://test:test@localhost:1/planning_test',
        TEST_DATABASE_URL: 'postgresql://test:test@localhost:1/planning_test', ENTRA_API_CLIENT_ID: api,
        ENTRA_TENANT_ID: api, ENTRA_SPA_CLIENT_ID: api, ENTRA_SCOPE: `api://${api}/access_as_user` }, timeout: 10_000,
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Synthetic seeding requires local development/test') });
  }, 15_000);
  it('the database CLI fails instead of skipping when its destination is missing', async () => {
    // An explicit empty value also prevents a host .env file from supplying it.
    const env = { ...process.env, TEST_DATABASE_URL: '' };
    await expect(execute(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../test/run-database-tests.ts', import.meta.url))], {
      env, timeout: 10_000,
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Supply TEST_DATABASE_URL') });
  }, 15_000);
  it('loads the specified synthetic fixture with raw extensions and ordered answers intact', async () => {
    const fixture = JSON.parse(await readFile(new URL('../test/fixtures/call-for-sites/application.json', import.meta.url), 'utf8'));
    expect(fixture.metadata.id).toBe('SYNTHETIC-001');
    expect(fixture.responses.map((response: { metadata: { id: string } }) => response.metadata.id)).toEqual(['oIOYDlVlbm', 'use.proposed', 'ERacz5TYhW', 'synthetic.additional']);
    expect(fixture.data.proposal.boundary.site.properties).toEqual({ exampleOnly: true });
    expect(fixture.exampleExtension).toEqual({ purpose: 'Verify preservation of unknown fields', synthetic: true });
  });
});
