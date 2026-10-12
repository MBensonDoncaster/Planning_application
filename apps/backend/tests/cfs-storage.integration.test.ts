import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient } from '../src/generated/prisma/client.js';
import { createTestDatabase, requireTestDatabase, type TestDatabase } from '../test/support/database.js';

const testUrl = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_TEST_DATABASE === '1') requireTestDatabase(testUrl);
let database: TestDatabase;
let db: PrismaClient;
let userId: string;
let integrationId: string;
let keyId: string;
const runtimeRole = `planning_test_cfs_${randomUUID().replaceAll('-', '')}`;
let roleCreated = false;
const tables = ['cfs_submissions', 'cfs_properties', 'cfs_proposals', 'cfs_responses', 'cfs_designations',
  'cfs_boundaries', 'cfs_pre_assessments', 'cfs_reporting_fields', 'cfs_search_documents'];

describe.skipIf(!testUrl)('Call for Sites PostgreSQL migration ownership and provenance', () => {
  beforeAll(async () => {
    database = await createTestDatabase(testUrl); db = database.createClient();
    await database.pool.query(`CREATE ROLE "${runtimeRole}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    roleCreated = true;
    const grants = await readFile(new URL('../prisma/runtime-grants.sql', import.meta.url), 'utf8');
    await database.pool.query(grants.replaceAll(':"app_schema"', `"${database.schema}"`).replaceAll(':"runtime_role"', `"${runtimeRole}"`));
  }, 60_000);
  beforeEach(async () => {
    await database.pool.query('TRUNCATE users, integrations, api_keys, audit_events, idempotency_records CASCADE');
    userId = (await db.user.create({ data: { ssoSubject: 'local:cfs-storage', email: 'storage@example.test', displayName: 'Storage', status: 'APPROVED' } })).id;
    integrationId = (await db.integration.create({ data: { name: 'Storage integration', createdByUserId: userId } })).id;
    keyId = (await db.apiKey.create({ data: { integrationId, label: 'Storage key', publicPrefix: randomUUID(),
      secretDigest: createHash('sha256').update(randomUUID()).digest('hex'), capabilities: ['call-for-sites.submit'],
      createdByUserId: userId, expiresAt: new Date(Date.now() + 86400000) } })).id;
  });
  afterAll(async () => {
    await db?.$disconnect();
    if (database && roleCreated) {
      await database.pool.query(`DROP OWNED BY "${runtimeRole}"`);
      await database.pool.query(`DROP ROLE "${runtimeRole}"`);
    }
    await database?.cleanup();
  });

  const submission = () => db.cfsSubmission.create({ data: { actorType: 'USER', submittedByUserId: userId,
    ingestionChannel: 'FILE_JSON', rawJson: { unknown: ['preserved', 1] }, inputFormatVersion: 'planx-v1', mappingVersion: 'cfs-reporting-v1' } });

  it('deploys exactly all nine module tables empty with no production sample records', async () => {
    const rows = await database.pool.query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE $2 ORDER BY table_name', [database.schema, 'cfs_%']);
    expect(rows.rows.map(row => row.table_name)).toEqual([...tables].sort());
    expect(await db.cfsSubmission.count()).toBe(0);
  });

  it('roundtrips complete canonical property/reporting fields and JSON arrays through the generated client', async () => {
    const row = await submission();
    expect(row.id).toMatch(/^[a-f0-9-]{14}4[a-f0-9-]{4}[89ab]/);
    expect(row.receivedAt.getTime()).toBeGreaterThan(Date.now() - 10000);
    expect(row.submittedAt).toBeNull(); expect(row.referenceNumber).toBe('');
    await db.cfsProperty.create({ data: { submissionId: row.id, propertyIndex: 0, address: '1 Test Street', postcode: 'AB1 2CD',
      postcodeArea: 'AB1', uprn: '000123', usrn: '000456', ward: 'Ward', region: 'Region', localAuthorityDistrict: 'District',
      propertyType: 'land', propertyTypeDescription: 'Land', latitude: 53.5, longitude: -1.2, x: 450000, y: 400000, town: 'Town', street: 'Street' } });
    await db.cfsProposal.create({ data: { submissionId: row.id, proposalIndex: 0, projectTypes: ['residential', 'employment'] } });
    await db.cfsReportingFields.create({ data: { submissionId: row.id, siteName: 'Test site', currentUse: 'Unused', applicantRole: 'Agent',
      ownerCount: 2, previouslyDeveloped: true, previouslyPromoted: false, previousPlanningHistory: true, proposedUses: ['Housing'],
      mixedUse: false, publicHighwayAccess: true, accessDetails: 'Road', developmentStart: 'Soon', developerInterest: 'Yes',
      viabilityIssues: false, abnormalCosts: true, constraintsInvestigation: 'Survey', otherInformation: 'Other', contactDetails: 'Synthetic', declarationConfirmed: true } });
    const read = await db.cfsSubmission.findUniqueOrThrow({ where: { id: row.id }, include: { properties: true, proposals: true, reportingFields: true } });
    expect(read.rawJson).toEqual({ unknown: ['preserved', 1] });
    expect(read.properties[0]).toMatchObject({ uprn: '000123', longitude: -1.2, propertyTypeDescription: 'Land' });
    expect(read.proposals[0].projectTypes).toEqual(['residential', 'employment']);
    expect(read.reportingFields).toMatchObject({ ownerCount: 2, proposedUses: ['Housing'], previouslyPromoted: false, anticipatedScale: null });
  });

  it('accepts only complete human/file and integration/API provenance combinations', async () => {
    const row = await submission();
    await database.pool.query("UPDATE cfs_submissions SET ingestion_channel='FILE_ZIP' WHERE id=$1", [row.id]);
    for (const values of [
      ['USER', null, null, null, 'FILE_JSON'], ['USER', userId, integrationId, null, 'FILE_JSON'],
      ['USER', userId, null, keyId, 'FILE_JSON'], ['USER', userId, null, null, 'INTEGRATION_API'],
      ['INTEGRATION', null, integrationId, null, 'INTEGRATION_API'], ['INTEGRATION', userId, integrationId, keyId, 'INTEGRATION_API'],
      ['INTEGRATION', null, integrationId, keyId, 'FILE_ZIP'],
    ]) await expect(database.pool.query('UPDATE cfs_submissions SET actor_type=$1,submitted_by_user_id=$2,integration_id=$3,api_key_id=$4,ingestion_channel=$5 WHERE id=$6', [...values, row.id])).rejects.toMatchObject({ code: '23514' });
    await database.pool.query("UPDATE cfs_submissions SET actor_type='INTEGRATION',submitted_by_user_id=NULL,integration_id=$1,api_key_id=$2,ingestion_channel='INTEGRATION_API' WHERE id=$3", [integrationId, keyId, row.id]);
    expect((await db.cfsSubmission.findUniqueOrThrow({ where: { id: row.id } })).apiKeyId).toBe(keyId);
    await expect(db.apiKey.delete({ where: { id: keyId } })).rejects.toMatchObject({ code: 'P2003' });
    await expect(db.integration.delete({ where: { id: integrationId } })).rejects.toMatchObject({ code: 'P2003' });
  });

  it('rejects missing actors and a key attributed to another integration', async () => {
    const row = await submission();
    await expect(database.pool.query('UPDATE cfs_submissions SET submitted_by_user_id=$1 WHERE id=$2', [randomUUID(), row.id])).rejects.toMatchObject({ code: '23503' });
    const other = await db.integration.create({ data: { name: 'Other', createdByUserId: userId } });
    await expect(database.pool.query("UPDATE cfs_submissions SET actor_type='INTEGRATION',submitted_by_user_id=NULL,integration_id=$1,api_key_id=$2,ingestion_channel='INTEGRATION_API' WHERE id=$3", [other.id, keyId, row.id])).rejects.toMatchObject({ code: '23503' });
    await expect(database.pool.query('DELETE FROM users WHERE id=$1', [userId])).rejects.toMatchObject({ code: '23503' });
  });

  it('allows identical references and payloads as deliberate distinct submissions', async () => {
    const a = await submission(); const b = await submission();
    expect(a.rawJson).toEqual(b.rawJson); expect(a.referenceNumber).toBe(b.referenceNumber); expect(a.id).not.toBe(b.id);
    expect(await db.cfsSubmission.count()).toBe(2);
  });

  it('rejects non-v4 submission IDs and malformed JSON containers without restricting version names', async () => {
    const row = await submission();
    await expect(database.pool.query('UPDATE cfs_submissions SET id=$1 WHERE id=$2', ['11111111-1111-1111-8111-111111111111', row.id])).rejects.toMatchObject({ code: '23514' });
    for (const column of ['raw_json', 'warnings']) {
      await expect(database.pool.query(`UPDATE cfs_submissions SET ${column}=$1::jsonb WHERE id=$2`, [column === 'raw_json' ? '[]' : '{}', row.id])).rejects.toMatchObject({ code: '23514' });
    }
    await database.pool.query('UPDATE cfs_submissions SET input_format_version=$1,mapping_version=$2 WHERE id=$3', ['future-adapter-v7', 'future-mapping-v9', row.id]);
    expect((await db.cfsSubmission.findUniqueOrThrow({ where: { id: row.id } })).mappingVersion).toBe('future-mapping-v9');
  });

  it('enforces source ordering while answer indices restart independently for each question', async () => {
    const row = await submission();
    const data = { submissionId: row.id, question: '__proto__', answer: 'Preserved', metadataId: 'unknown', questionIndex: 0, responseIndex: 0 };
    await db.cfsResponse.create({ data });
    await db.cfsResponse.create({ data: { ...data, responseIndex: 1 } });
    await db.cfsResponse.create({ data: { ...data, questionIndex: 1 } });
    await expect(db.cfsResponse.create({ data })).rejects.toMatchObject({ code: 'P2002' });
    await expect(db.cfsResponse.create({ data: { ...data, questionIndex: -1 } })).rejects.toThrow();
    await db.cfsProperty.create({ data: { submissionId: row.id, propertyIndex: 0 } });
    await db.cfsProperty.create({ data: { submissionId: row.id, propertyIndex: 1 } });
    await expect(db.cfsProperty.create({ data: { submissionId: row.id, propertyIndex: 0 } })).rejects.toMatchObject({ code: 'P2002' });
    await db.cfsReportingFields.create({ data: { submissionId: row.id } });
    await expect(db.cfsReportingFields.create({ data: { submissionId: row.id } })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('prevents cross-submission designation/boundary owners and invalid boundary types', async () => {
    const a = await submission(); const b = await submission();
    const property = await db.cfsProperty.create({ data: { submissionId: a.id, propertyIndex: 0 } });
    const proposal = await db.cfsProposal.create({ data: { submissionId: a.id, proposalIndex: 0 } });
    await expect(db.cfsDesignation.create({ data: { submissionId: b.id, propertyId: property.id, designationIndex: 0 } })).rejects.toMatchObject({ code: 'P2003' });
    const boundary = { submissionId: b.id, propertyId: property.id, boundaryIndex: 0, boundaryType: 'property_title_boundary', rawGeoJson: { type: 'Polygon', coordinates: [] } };
    await expect(db.cfsBoundary.create({ data: boundary })).rejects.toMatchObject({ code: 'P2003' });
    await expect(db.cfsBoundary.create({ data: { ...boundary, submissionId: a.id, proposalId: proposal.id } })).rejects.toThrow();
    await expect(db.cfsBoundary.create({ data: { ...boundary, submissionId: a.id, boundaryType: 'unknown' } })).rejects.toThrow();
  });

  it('scopes source indices to each parent for future multi-property and multi-proposal submissions', async () => {
    const row = await submission();
    for (const index of [0, 1]) {
      const property = await db.cfsProperty.create({ data: { submissionId: row.id, propertyIndex: index } });
      const proposal = await db.cfsProposal.create({ data: { submissionId: row.id, proposalIndex: index } });
      const designation = { submissionId: row.id, propertyId: property.id, designationIndex: 0 };
      await db.cfsDesignation.create({ data: designation });
      await expect(db.cfsDesignation.create({ data: designation })).rejects.toMatchObject({ code: 'P2002' });
      for (const owner of [
        { propertyId: property.id, boundaryType: 'property_title_boundary' },
        { proposalId: proposal.id, boundaryType: 'proposal_site_boundary' },
      ]) {
        const boundary = { submissionId: row.id, boundaryIndex: 0, rawGeoJson: Prisma.JsonNull, ...owner };
        await db.cfsBoundary.create({ data: boundary });
        await expect(db.cfsBoundary.create({ data: boundary })).rejects.toMatchObject({ code: 'P2002' });
      }
    }
    await db.cfsDesignation.create({ data: { submissionId: row.id, designationIndex: 0 } });
    await expect(db.cfsDesignation.create({ data: { submissionId: row.id, designationIndex: 0 } })).rejects.toMatchObject({ code: 'P2002' });
    expect(await db.cfsBoundary.count()).toBe(4);
    expect(await db.cfsDesignation.count()).toBe(3);
  });

  it('generates indexed English/simple vectors per independently ordered search chunk', async () => {
    const row = await submission();
    await db.cfsSearchDocument.create({ data: { submissionId: row.id, chunkIndex: 0, searchText: 'Developments unusualidentifier' } });
    await db.cfsSearchDocument.create({ data: { submissionId: row.id, chunkIndex: 1, searchText: 'Further text' } });
    expect(await db.cfsSearchDocument.count()).toBe(2);
    await expect(db.cfsSearchDocument.create({ data: { submissionId: row.id, chunkIndex: 0, searchText: 'Duplicate' } })).rejects.toMatchObject({ code: 'P2002' });
    const vectors = await database.pool.query("SELECT english_vector @@ plainto_tsquery('english','development') AS english, simple_vector @@ plainto_tsquery('simple','unusualidentifier') AS simple FROM cfs_search_documents WHERE submission_id=$1 AND chunk_index=0", [row.id]);
    expect(vectors.rows).toEqual([{ english: true, simple: true }]);
    const indexes = await database.pool.query('SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename=$2', [database.schema, 'cfs_search_documents']);
    expect(indexes.rows.filter(row => row.indexdef.includes('USING gin')).map(row => row.indexname).sort()).toEqual(['cfs_search_documents_english_idx', 'cfs_search_documents_simple_idx']);
  });

  it('cascades every module-owned table while preserving shared actors/audit/replay history', async () => {
    const row = await submission();
    const property = await db.cfsProperty.create({ data: { submissionId: row.id, propertyIndex: 0 } });
    const proposal = await db.cfsProposal.create({ data: { submissionId: row.id, proposalIndex: 0 } });
    await db.cfsResponse.create({ data: { submissionId: row.id, questionIndex: 0, responseIndex: 0, question: 'Q', answer: 'A' } });
    await db.cfsDesignation.create({ data: { submissionId: row.id, propertyId: property.id, designationIndex: 0, entities: [] } });
    await db.cfsBoundary.createMany({ data: [
      { submissionId: row.id, propertyId: property.id, boundaryIndex: 0, boundaryType: 'property_title_boundary', rawGeoJson: { type: 'Polygon', coordinates: [] } },
      { submissionId: row.id, proposalId: proposal.id, boundaryIndex: 0, boundaryType: 'proposal_site_boundary', rawGeoJson: Prisma.JsonNull },
    ] });
    await db.cfsPreAssessment.create({ data: { submissionId: row.id, assessmentIndex: 0 } });
    await db.cfsReportingFields.create({ data: { submissionId: row.id } });
    await db.cfsSearchDocument.create({ data: { submissionId: row.id, chunkIndex: 0, searchText: 'Owned' } });
    await db.auditEvent.create({ data: { actorType: 'USER', actorUserId: userId, requestId: 'storage', module: 'call-for-sites', action: 'TEST', outcome: 'SUCCESS', targetType: 'submission', targetId: row.id } });
    await db.idempotencyRecord.create({ data: { actorType: 'USER', actorId: userId, operation: 'call-for-sites.submit', key: randomUUID(), payloadDigest: 'a'.repeat(64), submissionId: row.id, response: {}, expiresAt: new Date(Date.now() + 86400000) } });
    await db.cfsSubmission.delete({ where: { id: row.id } });
    for (const table of tables) expect((await database.pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count).toBe(0);
    expect(await db.user.count()).toBe(1); expect(await db.integration.count()).toBe(1); expect(await db.apiKey.count()).toBe(1);
    expect(await db.auditEvent.count()).toBe(1); expect(await db.idempotencyRecord.count()).toBe(1);
  });

  it('grants runtime module CRUD without permitting schema changes or retained-history deletion', async () => {
    const row = await submission();
    const client = await database.pool.connect();
    try {
      await client.query(`SET ROLE "${runtimeRole}"`);
      for (const table of tables) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          const result = await client.query('SELECT has_table_privilege(current_user,$1,$2) AS allowed', [table, privilege]);
          expect(result.rows[0].allowed).toBe(true);
        }
      }
      await client.query('INSERT INTO cfs_properties(id,submission_id,property_index) VALUES ($1,$2,0)', [randomUUID(), row.id]);
      await client.query('UPDATE cfs_submissions SET description=$1 WHERE id=$2', ['Runtime change', row.id]);
      await expect(client.query('ALTER TABLE cfs_submissions ADD COLUMN forbidden TEXT')).rejects.toMatchObject({ code: '42501' });
      await expect(client.query('DELETE FROM audit_events')).rejects.toMatchObject({ code: '42501' });
      await expect(client.query('DELETE FROM api_keys')).rejects.toMatchObject({ code: '42501' });
      await client.query('DELETE FROM cfs_submissions WHERE id=$1', [row.id]);
    } finally { await client.query('RESET ROLE'); client.release(); }
    expect(await db.cfsProperty.count()).toBe(0);
  });
});
