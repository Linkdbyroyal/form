-- Migration 0001: core tenancy, identity, audit, organisation map.
-- Runs as the schema owner (migration role). Application traffic uses the NOLOGIN roles
-- sbos_app (tenant-scoped) and sbos_operator (cross-client metadata only) via SET LOCAL ROLE.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Roles are cluster-wide; create once, idempotently, and grant them to the migration role so it can SET ROLE.
DO $$
BEGIN
  -- The migration role needs CREATEROLE, or an administrator pre-creates both roles and grants
  -- them to the migration role (see packages/db/README.md, "Production roles").
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sbos_app') THEN
    BEGIN
      CREATE ROLE sbos_app NOLOGIN NOINHERIT;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'role sbos_app does not exist and % may not create roles. Pre-create: CREATE ROLE sbos_app NOLOGIN NOINHERIT; GRANT sbos_app TO %;', current_user, current_user;
    END;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sbos_operator') THEN
    BEGIN
      CREATE ROLE sbos_operator NOLOGIN NOINHERIT;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'role sbos_operator does not exist and % may not create roles. Pre-create: CREATE ROLE sbos_operator NOLOGIN NOINHERIT; GRANT sbos_operator TO %;', current_user, current_user;
    END;
  END IF;
  -- PostgreSQL 16: the creator gets membership with SET FALSE by default, so grant SET explicitly.
  -- INHERIT FALSE keeps the migration role from silently inheriting app privileges.
  EXECUTE format('GRANT sbos_app TO %I WITH SET TRUE, INHERIT FALSE', current_user);
  EXECUTE format('GRANT sbos_operator TO %I WITH SET TRUE, INHERIT FALSE', current_user);
END $$;

GRANT USAGE ON SCHEMA public TO sbos_app, sbos_operator;

-- Helper functions reading the per-transaction context. Fail closed: NULL when unset.
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_actor_id() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.actor_id', true), '')
$$;

CREATE OR REPLACE FUNCTION app_actor_scope() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.actor_scope', true), ''), 'tenant')
$$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

-- Enums -------------------------------------------------------------------------------------
CREATE TYPE tenant_kind AS ENUM ('client', 'agency', 'demo');
CREATE TYPE tenant_status AS ENUM ('onboarding', 'active', 'paused', 'offboarded');
CREATE TYPE user_status AS ENUM ('invited', 'active', 'disabled');
CREATE TYPE role_scope AS ENUM ('agency', 'client');
CREATE TYPE actor_type AS ENUM ('user', 'agent', 'system');
CREATE TYPE api_capability AS ENUM ('api', 'mcp', 'webhook', 'export', 'none');
CREATE TYPE system_claim_status AS ENUM ('stated', 'verified_exists', 'connected');

-- Tables ------------------------------------------------------------------------------------
CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  name text NOT NULL,
  kind tenant_kind NOT NULL DEFAULT 'client',
  status tenant_status NOT NULL DEFAULT 'onboarding',
  locale text NOT NULL DEFAULT 'en',
  industry text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tenants_slug_idx ON tenants (slug);
CREATE UNIQUE INDEX tenants_single_agency_idx ON tenants (kind) WHERE kind = 'agency';
CREATE TRIGGER tenants_updated_at BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text NOT NULL,
  status user_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_idx ON users (lower(email));
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE roles (
  key text PRIMARY KEY,
  scope role_scope NOT NULL,
  description text NOT NULL
);

INSERT INTO roles (key, scope, description) VALUES
  ('agency_superadmin', 'agency', 'Manages tenants, roles, policies; cross-client operational metadata; grants content access'),
  ('agency_operator',   'agency', 'Mission Control operational metadata for all clients; content only with a grant'),
  ('agency_consultant', 'agency', 'Works on assigned client tenants through content grants'),
  ('agency_reviewer',   'agency', 'Reviews knowledge promotions and skill releases'),
  ('client_ceo',        'client', 'Full tenant content, approvals and delegation'),
  ('client_manager',    'client', 'Department content, answers questions, proposes actions'),
  ('client_employee',   'client', 'Answers assigned questions, sees assigned tasks'),
  ('client_auditor',    'client', 'Read-only including audit trails');

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_key text NOT NULL REFERENCES roles(key),
  department_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX memberships_unique_idx ON memberships (tenant_id, user_id, role_key);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE client_content_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX client_content_grants_user_tenant_idx ON client_content_grants (user_id, tenant_id);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_type actor_type NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  before_hash text,
  after_hash text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_tenant_time_idx ON audit_events (tenant_id, occurred_at);

CREATE TABLE departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  head_role text,
  parent_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX departments_tenant_key_idx ON departments (tenant_id, key);

CREATE TABLE systems (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  vendor text,
  function text NOT NULL,
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  administrator_role text,
  source_of_truth_for text[] NOT NULL DEFAULT '{}'::text[],
  data_types text[] NOT NULL DEFAULT '{}'::text[],
  api_capabilities api_capability[] NOT NULL DEFAULT '{none}'::api_capability[],
  claim_status system_claim_status NOT NULL DEFAULT 'stated',
  notes text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX systems_tenant_idx ON systems (tenant_id);
CREATE TRIGGER systems_updated_at BEFORE UPDATE ON systems FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Row-Level Security ------------------------------------------------------------------------
-- FORCE makes the table owner subject to policies as well. Only BYPASSRLS/superuser skip them.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;              ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;          ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE client_content_grants ENABLE ROW LEVEL SECURITY; ALTER TABLE client_content_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;         ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;          ALTER TABLE departments FORCE ROW LEVEL SECURITY;
ALTER TABLE systems ENABLE ROW LEVEL SECURITY;              ALTER TABLE systems FORCE ROW LEVEL SECURITY;

-- tenants: tenant scope sees its own row; agency scope (operators) sees every tenant header.
CREATE POLICY tenants_app_select ON tenants FOR SELECT TO sbos_app
  USING (id = app_tenant_id() OR app_actor_scope() = 'agency');
CREATE POLICY tenants_app_update ON tenants FOR UPDATE TO sbos_app
  USING (id = app_tenant_id()) WITH CHECK (id = app_tenant_id());
CREATE POLICY tenants_app_insert ON tenants FOR INSERT TO sbos_app
  WITH CHECK (app_actor_scope() = 'agency');
CREATE POLICY tenants_operator_select ON tenants FOR SELECT TO sbos_operator USING (true);

-- memberships: own tenant, or the actor's own memberships (needed before a tenant is chosen).
CREATE POLICY memberships_app ON memberships FOR ALL TO sbos_app
  USING (tenant_id = app_tenant_id() OR user_id::text = app_actor_id())
  WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY memberships_operator_select ON memberships FOR SELECT TO sbos_operator USING (true);

-- content grants: visible to the grantee and within the tenant; created only in agency scope.
CREATE POLICY grants_app_select ON client_content_grants FOR SELECT TO sbos_app
  USING (tenant_id = app_tenant_id() OR user_id::text = app_actor_id());
CREATE POLICY grants_app_insert ON client_content_grants FOR INSERT TO sbos_app
  WITH CHECK (app_actor_scope() = 'agency');
CREATE POLICY grants_operator_select ON client_content_grants FOR SELECT TO sbos_operator USING (true);

-- audit: append-only. Tenant rows need the matching context; agency rows (NULL tenant) need agency scope.
CREATE POLICY audit_app_insert ON audit_events FOR INSERT TO sbos_app
  WITH CHECK (
    (tenant_id IS NOT NULL AND tenant_id = app_tenant_id())
    OR (tenant_id IS NULL AND app_actor_scope() = 'agency')
  );
CREATE POLICY audit_app_select ON audit_events FOR SELECT TO sbos_app
  USING (tenant_id = app_tenant_id() OR (tenant_id IS NULL AND app_actor_scope() = 'agency'));
CREATE POLICY audit_operator_select ON audit_events FOR SELECT TO sbos_operator USING (true);
CREATE POLICY audit_operator_insert ON audit_events FOR INSERT TO sbos_operator WITH CHECK (true);

-- plain tenant tables
CREATE POLICY departments_app ON departments FOR ALL TO sbos_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY departments_operator_select ON departments FOR SELECT TO sbos_operator USING (true);

CREATE POLICY systems_app ON systems FOR ALL TO sbos_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY systems_operator_select ON systems FOR SELECT TO sbos_operator USING (true);

-- users: not tenant scoped, but still default deny. A tenant actor sees members of its own tenant and itself;
-- agency scope sees everyone. New users are created in agency scope (invite flow) only.
ALTER TABLE users ENABLE ROW LEVEL SECURITY; ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_app_select ON users FOR SELECT TO sbos_app
  USING (
    id::text = app_actor_id()
    OR app_actor_scope() = 'agency'
    OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.tenant_id = app_tenant_id())
  );
CREATE POLICY users_app_insert ON users FOR INSERT TO sbos_app WITH CHECK (app_actor_scope() = 'agency');
CREATE POLICY users_app_update ON users FOR UPDATE TO sbos_app
  USING (id::text = app_actor_id() OR app_actor_scope() = 'agency')
  WITH CHECK (id::text = app_actor_id() OR app_actor_scope() = 'agency');
CREATE POLICY users_operator_select ON users FOR SELECT TO sbos_operator USING (true);

-- Grants ------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON users TO sbos_app;
GRANT SELECT (id, display_name, status, created_at) ON users TO sbos_operator;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, memberships, client_content_grants, departments, systems TO sbos_app;
GRANT SELECT ON roles TO sbos_app, sbos_operator;
GRANT SELECT, INSERT ON audit_events TO sbos_app;          -- no UPDATE/DELETE: append-only
GRANT SELECT, INSERT ON audit_events TO sbos_operator;

-- Operator: cross-client metadata only. Column-level SELECT on systems excludes `notes` and `metadata`.
GRANT SELECT ON tenants, memberships, client_content_grants, departments TO sbos_operator;
GRANT SELECT (id, tenant_id, name, vendor, function, department_id, administrator_role,
              source_of_truth_for, data_types, api_capabilities, claim_status, created_at, updated_at)
  ON systems TO sbos_operator;
GRANT UPDATE (status, settings, updated_at) ON tenants TO sbos_operator;
