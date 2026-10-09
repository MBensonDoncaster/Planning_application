# Entra configuration

The template implements single-tenant, Microsoft public-cloud authentication with separate SPA and API registrations. Supply these registrations for each new application. It does not reuse identities, directory roles or registrations from the source application.

1. Register an API application in the intended tenant with single-tenant access. Set its application ID URI to `api://<API-client-id>` and expose a delegated scope, for example `access_as_user`. Configure who can consent according to your organisation's policy.
2. Set the API's requested access-token version to **2** (`api.requestedAccessTokenVersion` in the manifest). This template validates v2 access tokens with the API client UUID as audience.
3. Register a separate single-tenant SPA. Add `APP_ORIGIN` as an exact **Single-page application** redirect URI (for example `http://localhost:5173` in host development, or `https://app.example.com` when deployed). Configure logout for the same URI. Do not create a client secret for the browser or enable the legacy implicit flow.
4. Add the API's delegated permission to the SPA registration and grant required consent. The app uses MSAL's authorization-code flow with PKCE, requesting the configured API scope.
5. Set `ENTRA_TENANT_ID`, `ENTRA_API_CLIENT_ID`, `ENTRA_SPA_CLIENT_ID`, `ENTRA_SCOPE` and `APP_ORIGIN` in the backend environment. `ENTRA_SCOPE` is the full scope URI, such as `api://<API-client-id>/access_as_user`.
6. Apply enterprise-application assignment restrictions, eligible groups/guests, MFA and Conditional Access according to your organisation's requirements. Entra authentication alone does not approve application access.

The browser receives public settings from `/api/v1/auth/config`. It stores its MSAL session in session storage and requests a fresh access token as necessary. The API checks signature against the tenant's published keys, expiry, not-before, issuer, API audience, tenant, object ID, permitted SPA client and delegated scope. It never accepts browser ID tokens or app-only tokens as user authentication.

The database identity is `entra:<tid>:<oid>`. Email and display name are profile fields; email is not a unique identifier and may be empty if neither an email nor username claim is supplied. Local role and status are authoritative on every protected request. The shared capability registry grants approved USER accounts Call for Sites read/search/submit/export access; approved ADMIN accounts also receive deletion and shared administration capabilities. Unapproved accounts receive none. Future application permissions must be added explicitly on the server.

`GET /api/v1/auth/me` registers the account on first sign-in and refreshes profile/login data while preserving local access and approval metadata. It returns `{ user, capabilities }`, including the access state for unapproved accounts. Other protected endpoints look up the current local account without updating its profile or login timestamp. A valid identity without a local account must call the session endpoint first. Existing tokens cannot bypass subsequent local disablement or demotion.

## Initial administrator

First sign in with the intended administrator's account. It will be registered as `PENDING` / `USER`. An authorised deployment/database operator must independently verify the tenant and object ID against the intended Entra identity; do not select the record by email alone.

Run the one-time bootstrap command using the exact subject and a database role permitted to update users. For host development:

```powershell
npm.cmd run admin:bootstrap -- entra:<tenant-id>:<object-id>
```

For containers, use the migration image as described in [deployment](deployment.md). It promotes an existing pending record only, refuses if an approved admin already exists, and holds the same administrative lock as the API. The initial record has an approval timestamp and no approving-user ID because the approval was performed by an operator. Record the operator, verified subject and time in your deployment audit log.

After bootstrap, all other approvals and role assignments happen through `/admin/users`. Reopening a disabled or rejected account returns it to pending, requiring a new approval. The last approved admin cannot be disabled or demoted.

## Acceptance checks with your tenant

- Missing, expired, wrong-audience, wrong-tenant and wrong-scope access tokens fail with HTTP 401.
- First sign-in creates exactly one pending record; subsequent sign-ins preserve its role and status.
- A pending account assigned `ADMIN` still cannot access protected functions.
- An approved `USER` can access the homepage but direct admin API requests fail with HTTP 403.
- An approved `ADMIN` can review and approve accounts, change roles and disable access.
- Disabled and rejected users cannot use protected functions even with an unexpired Entra token.
- Concurrent attempts cannot disable or demote every approved administrator.
- Sign-out, token renewal, approved/denied identities, guests and your Conditional Access requirements behave as agreed.

Official references: [SPA registration and authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-spa-app-registration), [exposing an API scope](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-configure-app-expose-web-apis), and [API claims validation](https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation).
