# Validation

Use the pinned Node.js 24.21.0/npm 11.19.0 toolchain. `npm run verify` generates Prisma, checks application and browser-test TypeScript, runs backend/frontend tests, lints and builds. Unit/API tests use synthetic repositories or locally signed JWTs; they need no Entra credentials. Without `TEST_DATABASE_URL`, database tests are skipped for this unit-only command.

## Complete isolated Docker checks

```powershell
docker compose -p planning-verification -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from verify
# Run even when verification fails:
docker compose -p planning-verification -f compose.test.yaml down --remove-orphans
```

This separate stack publishes no ports, uses temporary PostgreSQL storage and runs type checks, all unit/HTTP/database tests, lint, builds and Chromium browser checks. It does not connect to the development application's volume. The verification image uses the pinned application toolchain and locked Playwright browser version; the first build downloads Chromium and its system dependencies. Database coverage is mandatory in this image. A final check verifies that no temporary test schemas remain.

The GitHub workflow runs these same commands for feature/test pushes and PRs targeting test/main, saves browser reports for seven days and always removes the containers. A failed test or missing database input fails the job. CI needs no production secrets. The verification image runs build/test tools as root; the application's runtime image continues to run as the node user.

## Database checks on the host

Create a disposable PostgreSQL database ending in `_test` with a test operator allowed to create/drop schemas, deploy migrations, create/drop temporary test roles and SET ROLE for permission checks. The synthetic PostgreSQL operator in the Docker test stack supplies these permissions. Never use an application database or production runtime credentials.

```powershell
$env:TEST_DATABASE_URL = 'postgresql://planning_test:synthetic-test-only@localhost:5432/planning_test'
npm.cmd run test:database
```

This command requires its input and fails instead of silently skipping database tests. Each suite creates a unique `planning_test_<random hex>` schema, runs **the complete committed Prisma migration chain**, connects Prisma with that schema and removes it afterward. Failed migration setup also removes its schema. Caller-supplied schema/search-path overrides are rejected. Tests exercise profile refresh, approval metadata, concurrent last-admin protection, migration repeatability, parallel schema isolation and seed idempotency. Adding a committed migration automatically includes it in these checks.

Set `REQUIRE_TEST_DATABASE=1` when using `npm run verify` if database skips must be treated as failures. Do not share the same test database across concurrent complete CI runs: the final cleanup check deliberately detects any remaining generated test schemas.

The focused database command discovers every `.integration.test.ts` file. User lookup checks prove protected reads preserve profile/login timestamps while observing current database access state. Shared-storage tests also cover initial-schema upgrades with existing approved users, active-name/key uniqueness, digest/scope/expiry constraints, retained audit/replay IDs, concurrent PostgreSQL rate counters and the committed runtime grant script. A separate non-owner role (selected with SET ROLE on the test connection) proves audit INSERT/SELECT succeeds while UPDATE/DELETE/TRUNCATE, schema alteration and migration-table access fail. Generated schemas and temporary roles are removed; the complete CI command asserts both cleanups. Database login/TLS configuration remains a deployment check.

HTTP and actor tests cover every USER/ADMIN status combination, all declared capabilities, session-only registration/profile refresh, and unchanged signed tokens after local disablement or demotion. Frontend checks use server-supplied capabilities and exercise permission revocation, failed refreshes and overlapping responses. Integration actor scope intersection is tested independently; real API-key authentication arrives with the integration services.

Audit checks inject PostgreSQL insert failures and prove registration, profile/login updates and user approvals roll back with their audit writes. They also prove a later transaction failure rolls back both data and audit. HTTP fault injection verifies protected reads return 503 without successful payloads when auditing fails, while original authentication/permission/server errors survive failed failure-audit attempts. Metadata, validated targets, UNKNOWN attribution, search hashes and safe operational fallback output have focused regression coverage. Synthetic HTTP repositories explicitly supply a test-only audit collector; runtime and browser fixtures use the real PostgreSQL service.

## Browser checks on the host

```powershell
npm.cmd ci
npx.cmd playwright install chromium
# Linux hosts additionally need: npx playwright install --with-deps chromium
$env:TEST_DATABASE_URL = 'postgresql://planning_test:synthetic-test-only@localhost:5432/planning_test'
npm.cmd run test:browser
```

The command builds the application, starts a loopback-only API serving the built frontend at port 4174, applies all migrations in a fresh isolated schema and seeds synthetic actors. Playwright closes the server and removes its schema through an IPC teardown that also works on Windows. It refuses to reuse an existing server. Reports and failure traces go to ignored `playwright-report/` and `test-results/`.

Current checks cover real shell navigation/reload, database-backed user administration, public configuration and API error contracts. Blocked-account and USER deletion UI checks mock only the session response; backend permission enforcement is tested separately. Business ingestion/search/export acceptance will expand this suite with their implementation tasks. Actual Entra sign-in/logout requires staging checks in [Entra setup](entra.md).

## Synthetic fixtures and explicit seeding

The exact specification fixture is committed at `apps/backend/test/fixtures/call-for-sites/application.json`. It contains only synthetic applicant/site data. Use this common fixture for upcoming extraction, ingestion and export tests.

```powershell
$env:NODE_ENV = 'development'
$env:DEPLOYMENT_PROFILE = 'local'
$env:AUTH_MODE = 'TEST_USER'
$env:APP_ORIGIN = 'http://localhost:5173'
$env:DATABASE_URL = 'postgresql://planning_test:synthetic-test-only@localhost:5432/planning_test'
$env:TEST_DATABASE_URL = $env:DATABASE_URL
npm.cmd run seed:synthetic
```

Seeding is an explicit test command, never a startup step. It deploys committed migrations and upserts five `local:synthetic-*` users covering APPROVED ADMIN/USER and PENDING/REJECTED/DISABLED states into the separate test database. Repeating it resets these synthetic users to their fixture states. It refuses production/staging, Entra mode, missing test URLs and non-test database names before connecting. It never falls back to `DATABASE_URL` as the seed destination. Submission seeding will be connected to the ingestion service when that service exists; no business rows are currently created.
