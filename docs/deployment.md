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
- Use separate migration-owner and runtime database credentials. Runtime needs CRUD access to `users`, not schema modification or access to `_prisma_migrations`. The API's administration path uses `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`; ensure the runtime role's UPDATE permission supports that lock. Keep migration credentials out of the running application.
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

Create a database owned by a migration role, revoke public schema creation and give a separate runtime role database connectivity and schema usage. After applying the initial migration as the owner:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.users TO app_runtime;
REVOKE ALL ON TABLE public._prisma_migrations FROM app_runtime;
```

Use your operator's secure password/secret procedure; do not embed live credentials in committed SQL. Only `users` needs runtime access for this template. Future migrations should deliberately grant permissions for future tables.

## Operations and rollback

Monitor readiness failures, 5xx/429 rates, restarts and database capacity. Administrative actions are logged with actor ID, target ID and action; approval metadata is stored on the user record. This template does not contain a separate audit-history table. Configure your log retention/export if a durable history of role/status changes is required.

Restore backups into an isolated non-production database and verify user records and recovery time before launch. Record the deployed version, migration outcome, smoke-test result, owner and recovery procedure for each release.

Retain the previous image and verify schema compatibility before rolling back. If incompatible schema changes have been applied, use a reviewed migration or restore plan. Database migrations are not automatically reversed. Prefer backward-compatible changes when old and new instances overlap.
