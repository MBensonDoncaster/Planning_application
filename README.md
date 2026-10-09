# Planning application

The Planning application starts from a provider-independent template: React, Material UI and TypeScript in the browser; a Fastify API; and PostgreSQL accessed through Prisma. Frontend and API share one origin in the container. Use Node.js 24.21.0 (`.nvmrc`) and npm 11.19.0 (`packageManager`) for host development, matching the pinned Docker image. The supported engine ranges remain Node.js 24 and npm 11.

Shared storage now includes `users`, `integrations`, `api_keys`, `audit_events`, `idempotency_records` and `rate_limit_buckets`. Prisma also maintains its migration-history table. Transactional auditing covers the implemented session and user-access workflows. Integration/replay/throttling services and audit review are implemented in subsequent tasks; there are currently no business submission tables or cloud-provider dependencies.

## Included behaviour

- Microsoft Entra SSO using a single tenant in Microsoft's public cloud.
- The session endpoint (`GET /api/v1/auth/me`) creates a `USER` / `PENDING` account on first sign-in, keyed by `entra:<tenant-id>:<object-id>`, and refreshes profile/login details on later calls without replacing local access or approval metadata. It returns `{ user, capabilities }`; unapproved accounts have no capabilities. Other protected requests read current local access without refreshing the profile or login timestamp.
- Pending accounts see an awaiting-approval screen. Rejected and disabled accounts see an explanation. None can use protected application functions.
- Approved users land on Call for Sites at `/call-for-sites`. Browse, search, details, file upload and administrator deletion routes currently display a shell while their workflows are implemented. Approved administrators also get user administration at `/admin/users`, plus the confirmed integrations and audit route shells.
- User administration supports search, status filtering, pagination, approval, rejection, role assignment, disabling and reopening access requests. Reopening a rejected or disabled account returns it to `PENDING`; an administrator must approve it again.
- Approval records the administrator and timestamp. Role assignment is separate from approval. Entra directory roles do not grant local permissions.
- The API checks local role and status on every protected request. Database transactions serialize administrative changes so concurrent requests cannot disable or demote the last approved administrator.
- Session synchronisation and user-access changes commit their audit records atomically with data changes. Protected reads record an audit before returning; an audit persistence failure blocks success with 503. Failed requests record a separate failure/denial event where possible and preserve the original error when audit storage is unavailable.
- Audit metadata uses action-specific safe fields. User searches record a hash/length rather than search text; profiles, request bodies and credentials are excluded. Automatic request logging is disabled to avoid retaining query strings and network sources; operational fallback logs contain safe action/status/request identifiers.
- Liveness (`/health`), database readiness (`/health/ready`), request IDs, JSON logs, token redaction, security headers and request limits.

## Quick start: local containers

This explicit development override bypasses SSO for one local identity. Both the application and database ports are bound to localhost. Do not expose this mode to a shared network.

```powershell
Copy-Item .env.example .env
docker compose -f compose.yaml -f compose.dev.yaml up --build -d
```

Open `http://localhost:3000`. This registers `local:developer` as pending. After that first visit, bootstrap the administrator:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml run --rm migrate npm run admin:bootstrap -- local:developer
```

Click **Refresh access**. You will see the Call for Sites shell and the admin users page. The bootstrap command only works before any approved administrator exists.

Stop with `docker compose -f compose.yaml -f compose.dev.yaml down`. The database volume persists. Use a unique `COMPOSE_PROJECT_NAME` for each copied template so applications do not share a volume.

## Host development

```powershell
Copy-Item .env.example .env
Copy-Item apps/backend/.env.example apps/backend/.env
docker compose up -d --wait postgres
npm.cmd ci
npm.cmd run migrate:deploy
npm.cmd run dev:backend
```

In a second terminal, run `npm.cmd run dev:frontend` and open `http://localhost:5173`. Vite proxies API and health requests to port 3000. On macOS/Linux, use `npm` instead of `npm.cmd` and `cp` instead of `Copy-Item`.

Visit the application once, then run `npm.cmd run admin:bootstrap -- local:developer` in another terminal. Refresh access in the browser. Local mode always uses the configured test identity; use real Entra SSO to test multiple identities.

The backend reads `apps/backend/.env` because root npm scripts execute in that workspace. Root `.env` is for Docker Compose. The database URL in the backend example uses `localhost`; the root example uses the Compose service name `postgres`. If changing database credentials or ports, update both URLs. URL-encode reserved characters in passwords. Changing PostgreSQL variables does not change credentials in an already initialized volume.

## Configure Entra SSO

See [Entra setup](docs/entra.md). Supply your own tenant, SPA registration, API registration and delegated scope. Switch `AUTH_MODE` to `ENTRA` for host development. The standard container configuration always uses `ENTRA`; production rejects `TEST_USER` and non-HTTPS public origins.

Configuration comes from the server at runtime, so the same built image can be promoted through environments without rebuilding browser assets. No secrets are sent to the browser.

| Variable | Purpose |
| --- | --- |
| `APP_NAME` | Application title and welcome text |
| `APP_ORIGIN` | Exact browser origin, without path or trailing slash; also the SPA redirect/logout URI |
| `DATABASE_URL` | PostgreSQL connection URL; runtime and migration jobs can use different roles |
| `AUTH_MODE` | `ENTRA`, or local-only `TEST_USER` |
| `DEPLOYMENT_PROFILE` | `local`, `test`, `staging` or `production`; staging/production require Entra and HTTPS, regardless of `NODE_ENV` |
| `ENTRA_TENANT_ID` | Single tenant UUID |
| `ENTRA_API_CLIENT_ID` | API application UUID; validated token audience |
| `ENTRA_SPA_CLIENT_ID` | Browser application UUID; permitted calling application |
| `ENTRA_SCOPE` | Full delegated scope: `api://<API-client-id>/access_as_user` |
| `HOST`, `PORT` | Listener address and port; containers default to `0.0.0.0:3000` |
| `LOG_LEVEL` | Log verbosity; defaults to `info` |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` | Per-process, per-client-IP request limit; defaults to 120 per minute |
| `TRUST_PROXY` | Defaults to `false`; enable only behind a controlled proxy that replaces forwarded headers |
| `SERVE_FRONTEND` | Defaults to enabled in deployed staging/production profiles; use `true` for the container development override |
| `FRONTEND_DIST_DIR` | Optional absolute path for compiled frontend assets |
| `TEST_USER_SUBJECT`, `TEST_USER_EMAIL`, `TEST_USER_NAME` | Identity used only in explicit local development mode |

Approved users fetch `/api/v1/app/config` for the Call for Sites registry, public limits and business timezone. Unapproved accounts cannot fetch it. Browser assets contain no environment-specific hostnames or Entra IDs. Local TEST_USER mode requires a localhost application origin.

Runtime processing settings are listed in both server `.env.example` files and injected by Compose. Defaults are 10 MiB decoded request bodies, 5 MiB selected files, 1,000 ZIP entries, JSON depth 100, 100,000 geometry positions, 500 export selections, 100 MiB export output, 30-second generation and 120-second browser download deadlines. `BUSINESS_TIMEZONE` defaults to `Europe/London`; invalid IANA zones fail startup. Export selections cannot exceed 500. Key expiry defaults to 90 days with a maximum of 365; idempotency retention defaults to 30 days. Positive integer settings and deadline/expiry relationships are validated at startup.

The request-body limit is enforced now. ZIP, geometry, export, key and idempotency settings will be enforced by their respective workflows as they are implemented. Actor rate budgets default to 120 human reads, 30 human writes, 30 requests per integration key and 120 integration requests per IP each minute; shared enforcement is a later implementation task. The existing generic limiter remains per-process.

## Checks and schema changes

The `@planning/contracts` workspace supplies shared API error DTOs, module routes, capabilities and public configuration types. Root build, test, typecheck and development commands build it before starting the application workspaces; `npm.cmd run build:contracts` also builds it independently.

```powershell
npm.cmd run verify
```

This generates Prisma types, checks TypeScript, runs tests, lints and builds both applications. Unit/API tests use an in-memory repository and locally signed JWTs; they do not need Entra credentials or a database. For full PostgreSQL migration/integration and Chromium checks, run `docker compose -p planning-verification -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from verify`, then remove the temporary stack with `docker compose -p planning-verification -f compose.test.yaml down --remove-orphans`. The same checks run in CI without production secrets. See [testing](docs/testing.md) for focused commands, the synthetic fixture and guarded test-user seeding.

Check dependency security with `npm.cmd run audit:security` (requires access to the npm registry). The root package overrides Prisma's `deepmerge-ts` and `mysql2` dependencies to patched versions. Keep these overrides until Prisma supplies patched versions itself. After any dependency refresh, inspect the lockfile and run the security audit and `npm.cmd run verify`; npm workspace updates can ignore overrides and select vulnerable versions. Use `npm.cmd ci` to install the reviewed lockfile. A passing audit covers known npm advisories at the time of the check; container base images need separate updates and scanning.

The committed migration chain defines users and the shared integration/key/audit/idempotency/rate storage. It preserves existing user access data when upgrading. Apply committed migrations using `npm.cmd run migrate:deploy`; inspect them using `npm.cmd run migrate:status`. PostgreSQL check constraints and the partial active-integration-name index are maintained in the migration SQL alongside Prisma models. For a deliberate schema change, edit `apps/backend/prisma/schema.prisma`, then run:

```powershell
npm.cmd run prisma:migrate:dev --workspace=@planning/backend -- --name describe_change
```

Commit both the schema and migration SQL. Never run development migrations or `db push` against production.

## Reuse and deployment

The root package is `planning-application`, with `@planning/backend` and `@planning/frontend` workspaces. The example Compose project is `planning-application` and the display name is Planning. Set your own Entra values for deployed environments. Add future features under `apps/frontend/src/features` and `apps/backend/src/modules`; keep HTTP calls behind the shared browser client and protect new API routes on the server.

The shared visual theme is defined in `apps/frontend/src/theme.ts`: charcoal navigation, a teal divider, magenta gradient page banners and white cards on a warm background. The header places the bundled council logo beside the primary navigation; it is implemented in `apps/frontend/src/components/AppHeader.tsx`, with the logo in `apps/frontend/public/branding/`. Reuse `PageBanner` for new page headings and change the shared theme tokens and branding assets to rebrand a copied template. Reference screenshots remain local in the ignored source-documentation folder; the application does not require them at runtime.

To apply this design to an existing application, use [the standalone theme bundle](theme-bundle/README.md), also packaged as `exports/doncaster-theme.zip`. It includes configurable React/Material UI components, scoped CSS for other frameworks, the logo, integration examples and previews.

[Deployment instructions](docs/deployment.md) describe the runtime and migration image targets, external PostgreSQL, HTTPS entry points, administrator bootstrap, backups and rollback. The runtime image can run on any host or service that supports Linux OCI containers and network access to PostgreSQL and Microsoft Entra.

The original specification and user workflow notes are kept locally in `API_Creation_Documentation/`, which is excluded from Git and Docker builds. This README and `docs/` contain the maintained documentation for this template's implemented, provider-independent behaviour.
