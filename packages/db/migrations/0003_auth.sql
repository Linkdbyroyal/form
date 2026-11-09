-- Migration 0003: authentication (Better Auth, ADR-015) and the identity bridge.
--
-- Better Auth tables live in schema `auth`. They hold identities, sessions, credentials,
-- organisations and invitations: identity data, not client content, and not tenant-scoped.
-- They therefore have no RLS and NO grants to sbos_app or sbos_operator. The only principals that
-- touch them are the owner/migration role and the web app's dedicated auth pool, which in dev
-- connects as the same DB user as migrations (DATABASE_URL_AUTH, falling back to DATABASE_URL_MIGRATE).
-- In production the auth pool connects as the owner of schema auth or as a role granted on it.
--
-- The bridge (apps/web/lib/auth-bridge.ts) mirrors the minimum into public.users, public.memberships
-- and tenants.auth_org_id through withContext(), so RLS and the operator column grants keep working
-- from our own tables.
--
-- Independence: this migration does not depend on 0002. It inserts the role keys the bridge maps to
-- (superadmin, client_admin, department_manager) with ON CONFLICT DO NOTHING. 0002 inserts the same
-- keys the same way and moves memberships off the 0001 keys, so both application orders work.

CREATE SCHEMA IF NOT EXISTS auth;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;

-- Core -------------------------------------------------------------------------------------
CREATE TABLE auth."user" (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- twoFactor plugin
  two_factor_enabled boolean DEFAULT false,
  -- admin plugin
  role text,
  banned boolean DEFAULT false,
  ban_reason text,
  ban_expires timestamptz
);
CREATE UNIQUE INDEX user_email_uidx ON auth."user" (email);

CREATE TABLE auth.session (
  id text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  user_id text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  -- organization plugin
  active_organization_id text,
  -- admin plugin
  impersonated_by text
);
CREATE UNIQUE INDEX session_token_uidx ON auth.session (token);
CREATE INDEX session_user_id_idx ON auth.session (user_id);

CREATE TABLE auth.account (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_user_id_idx ON auth.account (user_id);

CREATE TABLE auth.verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_identifier_idx ON auth.verification (identifier);

-- organization plugin -----------------------------------------------------------------------
CREATE TABLE auth.organization (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL,
  logo text,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata text
);
CREATE UNIQUE INDEX organization_slug_uidx ON auth.organization (slug);

CREATE TABLE auth.member (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX member_organization_id_idx ON auth.member (organization_id);
CREATE INDEX member_user_id_idx ON auth.member (user_id);

CREATE TABLE auth.invitation (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  inviter_id text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE
);
CREATE INDEX invitation_organization_id_idx ON auth.invitation (organization_id);
CREATE INDEX invitation_email_idx ON auth.invitation (email);

-- twoFactor plugin ----------------------------------------------------------------------------
CREATE TABLE auth.two_factor (
  id text PRIMARY KEY,
  secret text NOT NULL,
  backup_codes text NOT NULL,
  user_id text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  verified boolean DEFAULT true,
  failed_verification_count integer DEFAULT 0,
  locked_until timestamptz
);
CREATE INDEX two_factor_secret_idx ON auth.two_factor (secret);
CREATE INDEX two_factor_user_id_idx ON auth.two_factor (user_id);

-- Bridge to our own tables --------------------------------------------------------------------
-- One Better Auth organization per tenant (ADR-015). NULL until the organisation is created.
ALTER TABLE tenants ADD COLUMN auth_org_id text UNIQUE;

-- Role keys the bridge maps Better Auth organisation roles onto (ADR-017 names). No-op when 0002 ran first.
INSERT INTO roles (key, scope, description) VALUES
  ('superadmin',         'agency', 'Manages tenants, roles, policies, budgets; cross-client operational metadata; approves break-glass; MFA mandatory'),
  ('client_admin',       'client', 'CEO: all tenant content, approvals, delegations, invites'),
  ('department_manager', 'client', 'Department content, answers questions, proposes actions')
ON CONFLICT (key) DO NOTHING;
