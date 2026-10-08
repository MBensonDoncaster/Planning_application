# Validation

Run `npm run verify` on Node.js 24/npm 11. The backend tests exercise HTTP authorization, status transitions, role assignment separate from approval, approval metadata, current-user revocation, last-admin protection and signed JWT validation. Frontend tests cover blocked-account screens.

Database integration tests are separately gated by `TEST_DATABASE_URL`. Use a disposable database whose name ends with `_test`, for example `template_test`; never supply an application database. Tests create an isolated schema, apply the initial user SQL inside it, test the Prisma repository, and remove that schema afterward.

```powershell
$env:TEST_DATABASE_URL = 'postgresql://template:local-development-only@localhost:5432/template_test'
npm.cmd test
```

You must create that isolated test database first using an authorised local PostgreSQL connection. Its account needs schema creation and deletion privileges. Without the variable, integration tests are skipped. They verify first-registration defaults, profile refresh preserving access, approval metadata and simultaneous demotions against a real PostgreSQL server.

Before deployment also build/run the Docker images and execute the acceptance checks in [Entra setup](entra.md). Local test mode and signed test JWTs cannot validate your registration settings, consent policy, Conditional Access or live sign-in/logout flow.
