# Authentication and authorisation (M1-01)

Status: implemented in `apps/web` with Better Auth 1.7.18 (ADR-015, ADR-017), including break-glass grants (M1-18). Mail delivery is
implemented through Resend when `RESEND_API_KEY` is set and otherwise simulated on the server
console (`[mail:dev]`). Google and Microsoft sign-in are not connected until their variables are set.

## Pieces

| Piece | Where | Note |
|---|---|---|
| Better Auth server | `apps/web/lib/auth.ts` | Drizzle adapter on a dedicated owner pool (`lib/auth-db.ts`), plugins organization, twoFactor, admin, nextCookies; all ids are UUIDs |
| Tables | schema `auth` (`packages/db/migrations/0003_auth.sql`, `0004_break_glass.sql`, `packages/db/src/schema/auth.ts`) | identity data, no RLS, no grants to `sbos_app` / `sbos_operator`; 0004 adds `auth.break_glass_totp_replay` |
| Identity bridge | `apps/web/lib/auth-bridge.ts` | mirrors users, links organisations to tenants, reconciles memberships, writes `audit_events` (actor `auth-bridge`) |
| Rules | `apps/web/lib/auth-policy.ts`, `apps/web/lib/break-glass-policy.ts` | pure functions: role mapping, MFA gate, operator and tenant access decisions; break-glass validation, replay and revocation rules |
| Break-glass | `apps/web/lib/break-glass.ts` (server actions), `apps/web/lib/break-glass-service.ts`, `apps/web/lib/content-access.ts` | grant request with fresh TOTP, revocation, grant listing, `knowledge_access_logs` writer (M1-18) |
| Request context | `apps/web/lib/request-context.ts` | `getSession`, `getPrincipal`, `requireOperatorContext`, `requireTenantContext`, sync wrappers `getOperatorContext` / `getTenantContext` |
| Edge guard | `apps/web/proxy.ts` | redirects cookie-less requests to `/mission-control/*`, `/c/*`, `/account/*`; forwards the pathname |
| Mail | `apps/web/lib/mailer.ts` | Resend or console |
| Bootstrap | `apps/web/scripts/bootstrap-admin.ts` | first superadmin, agency organisation, owner membership |
| Tests | `apps/web/test/auth.test.ts`, `apps/web/test/break-glass.test.ts` | unit + integration (own databases `<DATABASE_URL_TEST>_web` and `_web_bg`) |

## Flows

### Sign-in
`/sign-in` posts to Better Auth (`/api/auth/*`). Rules: public sign-up disabled; e-mail must be
verified (a sign-in attempt with an unverified address sends a fresh verification link and answers
403, the page explains this); users with TOTP enabled continue at `/two-factor`. After a session is
created, `databaseHooks.session.create.after` runs `syncMemberships(userId)` so memberships converge
even if an organisation hook was missed. `/sign-out` (POST) revokes the session and clears cookies.

### E-mail verification
`emailVerification.sendOnSignUp` plus `requireEmailVerification`. Links expire after one hour;
`/verify-email` shows status and offers a resend. The verification link for an invited user returns
to the invitation page.

### Invitation (the only onboarding path)
1. A member with permission invites an address into an organisation (Better Auth `inviteMember`);
   the mail links to `/accept-invitation/<id>` (72 h).
2. The page reads the invitation through the auth pool. No account yet: a server action creates the
   account for exactly the invited address (`auth.api.createUser`, no password reuse, 12+ characters)
   and sends the verification mail. Existing account: sign in and return.
3. Signed in with the invited address: Accept. `organizationHooks.afterAcceptInvitation` runs the
   membership sync. Invitations require a verified e-mail (`requireEmailVerificationOnInvitation`).

Mission Control has no invite UI yet (M1-08); invitations can be created through the Better Auth API
or client (`authClient.organization.inviteMember`).

### Organisations and tenants
Organisations map 1:1 to tenants by slug. `beforeCreateOrganization` refuses a slug without a tenant
or with an already linked tenant; `afterCreateOrganization` sets `tenants.auth_org_id`. Only
superadmins (or system calls with `userId`) may create organisations.

Role mapping (`mapOrgRoleToMembership`):

| Organisation role | client / demo tenant | agency tenant |
|---|---|---|
| owner | client_admin | superadmin |
| admin | department_manager | agency_operator |
| member | client_employee | agency_consultant |

The sync owns exactly these six role keys; other memberships (for example `client_auditor`) are never
touched. A user holds one bridge-managed role per tenant; comma-separated Better Auth roles collapse
to the highest.

### MFA gate (ADR-015/017)
`mfaGate`: a user holding `superadmin` or `agency_operator` with `twoFactorEnabled = false` is treated
as unauthenticated for operator surfaces. `requireOperatorContext()` (Mission Control layout and
pages) redirects such a session to `/account/security?reason=mfa_required`, which runs the Better Auth
TOTP enrolment (password, TOTP URI as text and QR, first code verifies). Non-operators may enable TOTP
voluntarily. Social-only accounts without a password cannot enrol through this page yet (limitation).

### Tenant access and break-glass (ADR-017, M1-18)
`requireTenantContext(slug)`: a membership on the tenant gives tenant context with those roles. An
operator (superadmin or agency_operator, MFA satisfied) without membership gets tenant context only with
an unexpired, unrevoked `client_content_grants` row (`viaGrant`, roles = the operator roles, audit action
`workspace.viewed.break_glass`); without one the page renders the 403 (`app/forbidden.tsx`). Other roles
(for example agency_consultant) never get tenant content this way. Under a grant the first resolution in a
request writes a `knowledge_access_logs` row (resource_type `page`, resource_id = `x-sbos-pathname`,
purpose `break_glass`); `lib/content-access.ts` exposes `logContentAccess(ctx, grantId, resourceType,
resourceId)` for queries that read specific content later. `/c/<slug>` shows the grant's expiry in the
break-glass badge.

Requesting a grant (Mission Control, `/mission-control/clients/<slug>`, card "Client content access"):

| Step | Where | Note |
|---|---|---|
| Validation | `lib/break-glass-policy.ts` (zod) | reason 10 to 1000 characters, duration 15 to 480 minutes (default 120), 6-digit code, slug |
| Actor | `lib/break-glass.ts` (server actions) | `requireOperatorContext()`; `publicUserId` from the principal for the `users` foreign keys |
| Fresh second factor | `lib/break-glass-service.ts` `verifyFreshTotp` | see below |
| Grant | `createBreakGlassGrant` | one agency-scoped transaction (`agencyContext({ tenantId })`, RLS allows the INSERT only in agency scope): grant row (`user_id` = `granted_by` = requester, `expires_at` = now + duration), audit `break_glass.granted`, Pumble notice `break_glass.granted` via `queueNotification` (payload: grantId, tenantSlug, userId, expiresAt, durationMinutes, reason, link) |
| Redirect | `requestBreakGlass` | to `/c/<slug>` on success, `?error=` on the client page otherwise |
| Revoke | `revokeBreakGlassGrant` | holder or superadmin; sets `revoked_at`, audit `break_glass.revoked`, notice `break_glass.revoked`. Needs the UPDATE policy from migration 0004 |

One active grant per user and tenant at a time; a second request is refused until the first is revoked
or expired. Grants on the agency tenant are refused.

#### Fresh TOTP verification: approach and reasons
Better Auth 1.7.18 exposes `auth.api.verifyTOTP({ body: { code }, headers })`. Its `verifyTwoFactor`
helper has two branches: without a session it completes the sign-in challenge (two-factor cookie); WITH a
session cookie it validates the code against the user's stored secret and returns `{ token, user }`
without creating a session or touching cookies. We use that signed-in branch, so the plugin keeps
ownership of secret decryption (`symmetricDecrypt` with the auth secret, `base32:` prefix handling) and of
the TOTP primitive (`@better-auth/utils/otp`, 6 digits, 30 s, window 1). An invalid code raises
`APIError` (`INVALID_CODE`), which the service turns into a refusal.

What the plugin does not do in that branch: it keeps no record of used codes, and it applies no failure
lockout. The service therefore adds a replay guard in `auth.break_glass_totp_replay` (migration 0004,
identity data, no app-role grants): the RFC 6238 time counter of a successful verification is stored per
user, and a new verification needs a counter at least two windows past the stored one. Two, not one,
because the plugin accepts the neighbouring window: a code accepted in window c would still pass in c+1.
The counter is claimed with a conditional upsert, so two concurrent requests with the same code cannot
both succeed. Cost: a second break-glass request by the same user is refused for up to 60 seconds after a
successful one, with an explicit message. Not implemented: our own lockout for repeated wrong codes under
a signed-in session (the Better Auth account lockout only applies to the sign-in challenge); the operator
session itself is already MFA-gated and every attempt is a server action under that session.

The check is a replaceable function (`setTotpVerifierForTests`) so the grant tests stub it, while one test
runs the real path: enrol TOTP through `auth.api.enableTwoFactor`, mint a code from the enrolment secret
with the plugin's own `auth.api.generateTOTP`, verify once, then show that a replay and a wrong code are
refused (`apps/web/test/break-glass.test.ts`).

## Running locally
```
pnpm db:migrate && pnpm db:seed
SBOS_ADMIN_EMAIL=you@example.com SBOS_ADMIN_PASSWORD='twelve-or-more-chars' pnpm --filter @sbos/web bootstrap-admin
pnpm --filter @sbos/web dev    # sign in, then enable TOTP at /account/security
pnpm --filter @sbos/web test   # needs Postgres; creates <DATABASE_URL_TEST>_web
```

## Known limitations
- `lib/queries.ts` was not changed (ticket M1-02). `getTenantDetail()` there still resolves the slug
  through the operator role; the client workspace page uses `lib/workspace-queries.ts` instead, and
  `getOperatorOverview().authStatus` still returns the string `dev-mode-no-auth`.
- Auth mail is sent directly by the web app (ADR-018 foresees queuing through the worker; M1-14).
- Better Auth's `removeMember` / `updateMemberRole` endpoints need a session; the bootstrap script
  and the tests change `auth.member` rows directly and call `syncMemberships`.
- Migration 0003 does not depend on 0002: both insert the ADR-017 role keys idempotently, so either
  order applies cleanly.
