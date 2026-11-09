-- 0004_break_glass: break-glass client content access (ADR-017, ticket M1-18).
--
-- 1. client_content_grants gets an UPDATE policy so a grant can be revoked early (revoked_at). Revocation
--    runs in agency scope pinned to the grant's tenant, like grant creation; the holder-or-superadmin rule
--    is enforced by the application before the UPDATE. Only revoked_at is meant to change.
-- 2. auth.break_glass_totp_replay remembers the last TOTP time counter a user verified for a break-glass
--    request, so a code cannot be replayed inside its validity window. Identity data: schema auth, no RLS,
--    no grants to sbos_app / sbos_operator (same rule as the other auth tables).

CREATE POLICY grants_app_update ON client_content_grants FOR UPDATE TO sbos_app
  USING (app_actor_scope() = 'agency' AND tenant_id = app_tenant_id())
  WITH CHECK (app_actor_scope() = 'agency' AND tenant_id = app_tenant_id());

CREATE INDEX client_content_grants_tenant_created_idx ON client_content_grants (tenant_id, created_at DESC);

CREATE TABLE auth.break_glass_totp_replay (
  user_id text PRIMARY KEY REFERENCES auth."user"(id) ON DELETE CASCADE,
  last_counter bigint NOT NULL,
  used_at timestamptz NOT NULL DEFAULT now()
);
