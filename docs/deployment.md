# Provider-independent deployment

The application runs as a non-root Node.js process in a Linux OCI image. Its frontend and API share a single origin. You can use a VM, Docker Compose, Kubernetes or another container platform. No AWS services or cloud SDKs are required.

You supply a PostgreSQL 17 database, persistent storage and backups, runtime configuration, and an HTTPS hostname/entry point. The sample Compose stack is a single-host starting point, not a highly available production platform.

## Build immutable images

```powershell
npm.cmd ci
npm.cmd run verify
docker build --target runtime -t your-registry/your-app:VERSION .
docker build --target migrator -t your-registry/your-app-migrations:VERSION .
```

The runtime image includes compiled frontend/backend code, the generated Prisma client and locked runtime dependencies. Optional peers are omitted so the Prisma CLI remains in the separate migrator image, which includes the source needed for migration and bootstrap commands. Neither image contains `.env` files. Use a compatible target architecture for your host. For reproducible base layers, pin an approved Node image digest in your copied template and update it as part of your maintenance process.

## Configure the host

- Supply environment variables from the host's secret/configuration facility. Use the settings in [README](../README.md) and complete [Entra setup](entra.md). `APP_ORIGIN` is the external HTTPS origin; the app container can listen on HTTP behind a TLS-terminating proxy.
- Route the hostname to the container's `PORT` and preserve browser/API paths on the same origin. Avoid a subpath mount. Register this exact hostname/origin in Entra.
- Only enable `TRUST_PROXY=true` if the app is reachable solely through a controlled proxy that overwrites forwarded headers. Otherwise leave it false. Per-process rate limits are not a cluster-wide quota; put a shared limit at your entry point if required.
- Set a private PostgreSQL connection in `DATABASE_URL`. For a remote database, use verified TLS, for example `sslmode=verify-full&sslrootcert=/run/certs/postgres-ca.pem`, and mount the trusted CA at that path in both runtime and migration jobs. The local Compose database uses plain transport inside its local/private network.
- Use separate migration-owner and runtime database credentials. Apply the explicit runtime grant script below after migrating. Runtime needs SELECT/INSERT/UPDATE on users, integrations and keys; audit INSERT/SELECT only; and CRUD on expiring idempotency/rate storage. Runtime must not own the schema/tables or inherit an owner/privileged role. The API's administration path uses `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`; the supplied UPDATE permission supports that lock. Keep migration credentials out of the running application.
- Configure persistent database storage, backup retention, log retention, resource limits, monitoring and a controlled migration runner. Default Compose database credentials are for local development and must be replaced for deployment.

An independently hosted database can be used without Compose's `postgres` service: run the two images directly with your host's environment injection, networking and service controls. The application requires no mounted application volume and stores persistent data only in PostgreSQL.

## Release sequence

1. Verify an immutable build and test it in staging with your actual Entra tenant. Verify a recoverable backup and migration compatibility before production.
2. Run one migration job with migration-owner credentials:

   ```powershell
   docker run --rm --env-file migration.env your-registry/your-app-migrations:VERSION
   ```

   `migration.env` is an untracked, operator-supplied environment file containing the migration `DATABASE_URL`. Prefer the platform's secret injection where available. The default command is `npm run migrate:deploy`. Do not run migrations from every application instance or give runtime instances migration credentials.
3. Start the runtime image with production variables and runtime credentials. In plain Docker, publish the port on a private/loopback interface behind your HTTPS proxy:

   ```powershell
   docker run -d --name your-app --restart unless-stopped --env-file runtime.env -p 127.0.0.1:3000:3000 your-registry/your-app:VERSION
   ```

4. For the first release, sign in with the intended administrator, independently verify their Entra identity, and run the bootstrap command from the migration image. Supply the full app/Entra configuration along with operator database credentials for this command:

   ```powershell
   docker run --rm --env-file bootstrap.env your-registry/your-app-migrations:VERSION node apps/backend/dist/scripts/bootstrap-admin.js entra:<tenant-id>:<object-id>
   ```

5. Verify HTTPS, `/health`, `/health/ready`, direct navigation to `/admin/users`, sign-in, pending-user blocking, admin approval and role changes before declaring success. `/health` is process liveness; readiness checks database connectivity. Migration success and a real database-backed operation must also be checked.

For the bundled database, `docker compose up --build -d` starts PostgreSQL, applies migrations through a separate service and then starts the app. Configure real credentials and Entra values first. Place an HTTPS proxy in front of localhost port 3000. Do not use `compose.dev.yaml` for deployed environments.

## Database permissions example

Create a database owned by a migration role and give a separate runtime role database connectivity. Use a non-superuser runtime login with no CREATEDB/CREATEROLE privileges and no memberships granting ownership or wider access. After applying all committed migrations as the owner, apply the supplied script through the operator's PostgreSQL client:

```powershell
psql --set=ON_ERROR_STOP=1 --set=app_schema=public --set=runtime_role=planning_runtime --file=apps/backend/prisma/runtime-grants.sql
```

Supply operator connectivity through the normal secure PostgreSQL environment/secret procedure. The script revokes schema creation and blanket table privileges for the selected runtime role, grants only the current table permissions, and excludes `_prisma_migrations`. It grants no audit UPDATE/DELETE/TRUNCATE and no hard deletion of users, integrations or keys. Reapply it when current-table grants change, and explicitly extend it when a later migration adds business tables. Do not grant CRUD on ALL TABLES or apply blanket default grants that would include audit events. The script is packaged in the migrator source tree; the PostgreSQL client runs in the operator environment.

Audit IDs intentionally have no domain foreign keys, so controlled domain deletion cannot cascade into history. Revoked key metadata stays in `api_keys`; ordinary application roles cannot delete it. Idempotency submission IDs have no FK and support a deletion timestamp for retained replay tombstones. The migration bounds audit metadata to a JSON object of at most 64 KiB in its PostgreSQL JSONB text representation. Service-level metadata allowlisting/redaction follows in the audit-service task. Append-only permissions protect against the application role; controlled database owners can perform schema/retention maintenance.

The local development Compose stack still uses its original operator account. Runtime credential separation, secret injection and real database TLS must be configured for deployed environments; permission tests use a separate temporary non-owner test role.

## Operations and rollback

Monitor readiness failures, 5xx/429 rates, restarts and database capacity. Current administrative actions are logged with actor ID, target ID and action; approval metadata is stored on the user record. Shared audit storage is present; transactional audit instrumentation and its review workflow are subsequent implementation tasks. Do not treat storage alone as complete application auditing. No automatic audit deletion is configured; record the organisation's retention policy before production. Rate rows accept subject digests rather than raw credential/IP strings; their bounded expiry/cleanup is implemented with the shared throttling service.

Restore backups into an isolated non-production database and verify user records and recovery time before launch. Record the deployed version, migration outcome, smoke-test result, owner and recovery procedure for each release.

Retain the previous image and verify schema compatibility before rolling back. If incompatible schema changes have been applied, use a reviewed migration or restore plan. Database migrations are not automatically reversed. Prefer backward-compatible changes when old and new instances overlap.
