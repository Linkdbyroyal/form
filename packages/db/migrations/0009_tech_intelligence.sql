-- Migration 0009 (Milestone 6): Technology Intelligence Center (spec 4D) and data retention.
--
-- Technology intelligence is agency knowledge: approved sources, detected updates with the UpgradeProposal
-- fields, and watch runs live in agency scope only (no tenant_id, like the agency vault). Nothing is
-- applied automatically: a code update needs a pull request and human approval, a skill update a new
-- SKILL.md version with a test result, a knowledge update a published agency record. Retention policies
-- have a platform default (tenant_id NULL) and per-tenant overrides; deletion requests are tenant rows that
-- an agency reviewer approves before the worker executes them. Audit events are never deleted.

CREATE TYPE tech_source_kind AS ENUM ('official_docs', 'changelog', 'github_releases', 'security_advisory', 'standard', 'regulation', 'test_results');
CREATE TYPE tech_fetch_kind AS ENUM ('github_releases', 'rss', 'json', 'manual');
CREATE TYPE upgrade_kind AS ENUM ('knowledge_update', 'skill_update', 'code_update');
CREATE TYPE upgrade_status AS ENUM ('detected', 'assessed', 'approved', 'applied', 'rolled_back', 'rejected');
CREATE TYPE security_risk AS ENUM ('none', 'low', 'medium', 'high', 'critical');
CREATE TYPE deletion_kind AS ENUM ('document', 'connection_data', 'subject_data', 'tenant_offboarding');
CREATE TYPE deletion_state AS ENUM ('requested', 'approved', 'rejected', 'executing', 'completed');

-- Approved sources ----------------------------------------------------------------------------
CREATE TABLE tech_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  name text NOT NULL,
  kind tech_source_kind NOT NULL,
  fetch_kind tech_fetch_kind NOT NULL DEFAULT 'manual',
  url text NOT NULL CHECK (url ~ '^https://'),
  approved boolean NOT NULL DEFAULT false,
  approved_by text,
  approved_at timestamptz,
  relevant_agent_keys text[] NOT NULL DEFAULT '{}'::text[],
  check_interval_hours integer NOT NULL DEFAULT 24 CHECK (check_interval_hours BETWEEN 1 AND 720),
  last_checked_at timestamptz,
  last_error text,
  created_by_actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER tech_sources_updated_at BEFORE UPDATE ON tech_sources FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Detected updates carrying the UpgradeProposal fields ----------------------------------------
CREATE TABLE tech_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES tech_sources(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  subject text NOT NULL,
  current_version text,
  proposed_version text NOT NULL,
  source_url text NOT NULL CHECK (source_url ~ '^https://'),
  published_at timestamptz NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  summary text NOT NULL DEFAULT '',
  kind upgrade_kind,
  relevant_agent_keys text[] NOT NULL DEFAULT '{}'::text[],
  potential_benefit text,
  compatibility_notes text,
  security_risk security_risk,
  migration_plan text,
  test_result text,
  rollback_plan text,
  pull_request_url text CHECK (pull_request_url IS NULL OR pull_request_url ~ '^https://github\.com/'),
  skill_version_id uuid REFERENCES skill_versions(id) ON DELETE SET NULL,
  previous_skill_version_id uuid REFERENCES skill_versions(id) ON DELETE SET NULL,
  knowledge_record_id uuid REFERENCES agency_knowledge_records(id) ON DELETE SET NULL,
  reviewer_actor_id text,
  decided_at timestamptz,
  applied_at timestamptz,
  status upgrade_status NOT NULL DEFAULT 'detected',
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, external_id)
);
CREATE INDEX tech_updates_status_idx ON tech_updates (status, detected_at DESC);
CREATE TRIGGER tech_updates_updated_at BEFORE UPDATE ON tech_updates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE tech_update_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  update_id uuid NOT NULL REFERENCES tech_updates(id) ON DELETE CASCADE,
  from_status upgrade_status,
  to_status upgrade_status NOT NULL,
  actor_type actor_type NOT NULL,
  actor_id text NOT NULL,
  roles text[] NOT NULL DEFAULT '{}'::text[],
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION enforce_upgrade_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor_t text := coalesce(nullif(current_setting('app.actor_type', true), ''), 'system');
  reviewer boolean := app_has_any_role(ARRAY['agency_reviewer', 'superadmin']);
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT ((OLD.status, NEW.status) IN (('detected', 'assessed'), ('detected', 'rejected'), ('assessed', 'approved'), ('assessed', 'rejected'), ('assessed', 'detected'),
                                        ('approved', 'applied'), ('approved', 'rejected'), ('applied', 'rolled_back'))) THEN
    RAISE EXCEPTION 'upgrade transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IN ('approved', 'applied', 'rolled_back') THEN
    IF actor_t = 'agent' THEN
      RAISE EXCEPTION 'agents cannot approve, apply or roll back upgrades' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT reviewer THEN
      RAISE EXCEPTION 'transition to % requires the agency_reviewer or superadmin role', NEW.status USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NEW.status = 'assessed' THEN
    IF NEW.kind IS NULL OR NEW.security_risk IS NULL OR coalesce(NEW.potential_benefit, '') = '' OR coalesce(NEW.compatibility_notes, '') = '' OR coalesce(NEW.migration_plan, '') = '' OR coalesce(NEW.rollback_plan, '') = '' THEN
      RAISE EXCEPTION 'an assessed update needs kind, security risk, potential benefit, compatibility notes, migration plan and rollback plan' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.status = 'approved' THEN
    IF NEW.kind = 'code_update' AND NEW.pull_request_url IS NULL THEN
      RAISE EXCEPTION 'a code update is approved only with a pull request (tests run there, a human merges)' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.kind = 'skill_update' AND NEW.skill_version_id IS NULL THEN
      RAISE EXCEPTION 'a skill update is approved only with a new immutable skill version' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.kind = 'knowledge_update' AND NEW.knowledge_record_id IS NULL THEN
      RAISE EXCEPTION 'a knowledge update is approved only with an agency knowledge record' USING ERRCODE = 'check_violation';
    END IF;
    NEW.reviewer_actor_id := app_actor_id();
    NEW.decided_at := now();
  END IF;
  IF NEW.status = 'applied' THEN
    IF coalesce(NEW.test_result, '') = '' THEN
      RAISE EXCEPTION 'an upgrade is applied only with a recorded test result' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.kind = 'knowledge_update' AND NOT EXISTS (SELECT 1 FROM agency_knowledge_records r WHERE r.id = NEW.knowledge_record_id AND r.state = 'published') THEN
      RAISE EXCEPTION 'a knowledge update is applied only when its record is published' USING ERRCODE = 'check_violation';
    END IF;
    NEW.applied_at := now();
  END IF;
  IF NEW.status = 'rejected' THEN
    NEW.reviewer_actor_id := app_actor_id();
    NEW.decided_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tech_updates_transition BEFORE UPDATE OF status ON tech_updates FOR EACH ROW EXECUTE FUNCTION enforce_upgrade_transition();

CREATE OR REPLACE FUNCTION log_upgrade_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status <> OLD.status THEN
    INSERT INTO tech_update_transitions (update_id, from_status, to_status, actor_type, actor_id, roles)
    VALUES (NEW.id, CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END, NEW.status,
            coalesce(nullif(current_setting('app.actor_type', true), ''), 'system')::actor_type, coalesce(app_actor_id(), 'unknown'),
            string_to_array(coalesce(nullif(current_setting('app.roles', true), ''), ''), ','));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tech_updates_log AFTER INSERT OR UPDATE OF status ON tech_updates FOR EACH ROW EXECUTE FUNCTION log_upgrade_transition();

CREATE TABLE tech_watch_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES tech_sources(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('live', 'fixture')),
  status text NOT NULL CHECK (status IN ('succeeded', 'failed', 'skipped')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NOT NULL DEFAULT now(),
  items_seen integer NOT NULL DEFAULT 0,
  updates_new integer NOT NULL DEFAULT 0,
  error_message text
);
CREATE INDEX tech_watch_runs_source_idx ON tech_watch_runs (source_id, started_at DESC);

-- Retention policies and deletion requests ----------------------------------------------------
CREATE OR REPLACE FUNCTION retention_minimum_days(data_class text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE data_class
    WHEN 'knowledge_access_logs' THEN 365
    WHEN 'sync_runs' THEN 30
    WHEN 'run_events' THEN 30
    WHEN 'retrieval_audit' THEN 90
    WHEN 'notifications' THEN 30
    WHEN 'cost_events' THEN 400
    ELSE NULL END
$$;

CREATE TABLE retention_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  data_class text NOT NULL CHECK (data_class IN ('run_events', 'retrieval_audit', 'notifications', 'sync_runs', 'knowledge_access_logs', 'cost_events')),
  retention_days integer NOT NULL CHECK (retention_days >= 1 AND retention_days <= 3650),
  reason text NOT NULL,
  set_by_actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (retention_days >= retention_minimum_days(data_class)),
  UNIQUE NULLS NOT DISTINCT (tenant_id, data_class)
);
CREATE TRIGGER retention_policies_updated_at BEFORE UPDATE ON retention_policies FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO retention_policies (tenant_id, data_class, retention_days, reason, set_by_actor_id) VALUES
  (NULL, 'run_events', 180, 'platform default: run traces kept half a year for incident analysis', 'migration'),
  (NULL, 'retrieval_audit', 365, 'platform default: retrieval audit kept one year', 'migration'),
  (NULL, 'notifications', 90, 'platform default', 'migration'),
  (NULL, 'sync_runs', 180, 'platform default', 'migration'),
  (NULL, 'knowledge_access_logs', 730, 'platform default: break-glass access history kept two years', 'migration'),
  (NULL, 'cost_events', 800, 'platform default: cost history kept for two financial years', 'migration');

CREATE TABLE retention_sweeps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  data_class text NOT NULL,
  cutoff timestamptz NOT NULL,
  deleted_count integer NOT NULL,
  ran_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind deletion_kind NOT NULL,
  subject_ref text NOT NULL,
  reason text NOT NULL,
  requested_by_actor_type actor_type NOT NULL,
  requested_by_actor_id text NOT NULL,
  requested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  state deletion_state NOT NULL DEFAULT 'requested',
  legal_hold boolean NOT NULL DEFAULT false,
  reviewer_actor_id text,
  review_note text,
  decided_at timestamptz,
  executed_at timestamptz,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deletion_requests_tenant_idx ON deletion_requests (tenant_id, state);
CREATE TRIGGER deletion_requests_updated_at BEFORE UPDATE ON deletion_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION enforce_deletion_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor_t text := coalesce(nullif(current_setting('app.actor_type', true), ''), 'system');
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'requested' THEN
      RAISE EXCEPTION 'a deletion request starts as requested' USING ERRCODE = 'check_violation';
    END IF;
    IF actor_t = 'agent' THEN
      RAISE EXCEPTION 'agents cannot request deletions' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  IF actor_t = 'agent' THEN
    RAISE EXCEPTION 'agents cannot change deletion requests' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT ((OLD.state, NEW.state) IN (('requested', 'approved'), ('requested', 'rejected'), ('approved', 'executing'), ('executing', 'completed'), ('approved', 'rejected'))) THEN
    RAISE EXCEPTION 'deletion request transition % -> % is not allowed', OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IN ('approved', 'rejected') THEN
    IF NOT (app_actor_scope() = 'agency' AND app_has_any_role(ARRAY['agency_reviewer', 'superadmin'])) THEN
      RAISE EXCEPTION 'deciding a deletion request is an agency reviewer or superadmin decision' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.state = 'approved' AND NEW.legal_hold THEN
      RAISE EXCEPTION 'a request under legal hold cannot be approved' USING ERRCODE = 'check_violation';
    END IF;
    NEW.reviewer_actor_id := app_actor_id();
    NEW.decided_at := now();
  END IF;
  IF NEW.state = 'completed' THEN
    NEW.executed_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deletion_requests_enforce BEFORE INSERT OR UPDATE ON deletion_requests FOR EACH ROW EXECUTE FUNCTION enforce_deletion_request();

-- Row-Level Security --------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tech_sources','tech_updates','tech_update_transitions','tech_watch_runs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO sbos_app USING (app_actor_scope() = ''agency'') WITH CHECK (app_actor_scope() = ''agency'')', t || '_agency', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO sbos_operator USING (true)', t || '_operator_select', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO sbos_app', t);
    EXECUTE format('GRANT SELECT ON %I TO sbos_operator', t);
  END LOOP;
END $$;

-- Nullable tenant: platform defaults in agency scope, tenant rows in tenant scope; operator reads all.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['retention_policies','retention_sweeps']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO sbos_app USING ((tenant_id IS NOT NULL AND tenant_id = app_tenant_id()) OR (tenant_id IS NULL AND app_actor_scope() = ''agency'')) WITH CHECK ((tenant_id IS NOT NULL AND tenant_id = app_tenant_id()) OR (tenant_id IS NULL AND app_actor_scope() = ''agency''))', t || '_app', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO sbos_operator USING (true)', t || '_operator_select', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO sbos_app', t);
    EXECUTE format('GRANT SELECT ON %I TO sbos_operator', t);
  END LOOP;
END $$;
-- Tenant contexts may read the platform defaults (needed to show the effective policy).
CREATE POLICY retention_policies_defaults_read ON retention_policies FOR SELECT TO sbos_app USING (tenant_id IS NULL);

ALTER TABLE deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE deletion_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY deletion_requests_app ON deletion_requests FOR ALL TO sbos_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY deletion_requests_reviewer ON deletion_requests FOR SELECT TO sbos_app USING (app_actor_scope() = 'agency' AND app_has_any_role(ARRAY['agency_reviewer', 'superadmin']));
CREATE POLICY deletion_requests_operator_select ON deletion_requests FOR SELECT TO sbos_operator USING (true);
GRANT SELECT, INSERT, UPDATE ON deletion_requests TO sbos_app;
GRANT SELECT (id, tenant_id, kind, state, legal_hold, reviewer_actor_id, decided_at, executed_at, created_at, updated_at) ON deletion_requests TO sbos_operator;

-- Deletions by the platform only: agency scope (the worker's sweep and approved deletion requests), never a tenant user.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['run_events','retrieval_audit','notifications','sync_runs','knowledge_access_logs','cost_events','vault_documents','vault_revisions','kpi_observations']
  LOOP
    EXECUTE format('GRANT DELETE ON %I TO sbos_app', t);
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR DELETE TO sbos_app USING (app_actor_scope() = ''agency'' AND app_has_any_role(ARRAY[''system'', ''superadmin'']))', t || '_delete_agency_only', t);
  END LOOP;
END $$;

-- Fix (M1 defect found in M6): the worker marks notifications sent or failed with the operator role, which only had
-- SELECT and INSERT. Every delivery attempt therefore failed after sending and the job was retried until the
-- dead-letter queue. Operator may now update the delivery columns, never the subject or recipient.
CREATE POLICY notifications_operator_update ON notifications FOR UPDATE TO sbos_operator USING (true) WITH CHECK (true);
GRANT UPDATE (state, sent_at, attempts, last_error, payload) ON notifications TO sbos_operator;
