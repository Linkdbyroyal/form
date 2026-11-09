# Authentication and authorisation (M1-01)

Status: implemented in `apps/web` with Better Auth 1.7.18 (ADR-015, ADR-017). Mail delivery is
implemented through Resend when `RESEND_API_KEY` is set and otherwise simulated on the server
console (`[mail:dev]`). Google and Microsoft sign-in are not connected until their variables are set.

## Pieces

| Piece | Where | Note |
|---|---|---|
| Better Auth server | `apps/web/lib/auth.ts` | Drizzle adapter on a dedicated owner pool (`lib/auth-db.ts`), plugins organization, twoFactor, admin, nextCookies; all ids are UUIDs |
| Tables | schema `auth` (`packages/db/migrations/0003_auth.sql`, `packages/db/src/schema/auth.ts`) | identity data, no RLS, no grants to `sbos_app` / `sbos_operator` |
| Identity bridge | `apps/web/lib/auth-bridge.ts` | mirrors users, links organisations to tenants, reconciles memberships, writes `audit_events` (actor `auth-bridge`) |
| Rules | `apps/web/lib/auth-policy.ts` | pure functions: role mapping, MFA gate, operator and tenant access decisions |
| Request context | `apps/web/lib/request-context.ts` | `getSession`, `getPrincipal`, `requireOperatorContext`, `requireTenantContext`, sync wrappers `getOperatorContext` / `getTenantContext` |
| Edge guard | `apps/web/proxy.ts` | redirects cookie-less requests to `/mission-control/*`, `/c/*`, `/account/*`; forwards the pathname |
| Mail | `apps/web/lib/mailer.ts` | Resend or console |
| Bootstrap | `apps/web/scripts/bootstrap-admin.ts` | first superadmin, agency organisation, owner membership |
| Tests | `apps/web/test/auth.test.ts` | unit + integration (own database `<DATABASE_URL_TEST>_web`) |

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

### Tenant access and break-glass (ADR-017)
`requireTenantContext(slug)`: a membership on the tenant gives tenant context with those roles. A
superadmin without membership gets tenant context only with an unexpired, unrevoked
`client_content_grants` row (`viaGrant`, audit action `workspace.viewed.break_glass`); without one
the page renders the 403 (`app/forbidden.tsx`). Agency operators never get tenant content this way.
Creating grants (reason, fresh MFA, 8 h, Pumble notice) is ticket M1-18.

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
