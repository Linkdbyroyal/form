-- Migration 0008 (Milestone 5): integrations in phases, consent per phase, sync runs with lineage.
--
-- A connection moves metadata -> read_only -> sandbox -> write one step at a time (ADR-011). Consent is a
-- client decision recorded with who, when and which scopes; the security review is an agency decision
-- recorded before read_only becomes active. Agents never change a phase or a consent. The write phase has
-- no implementation in this milestone and is refused by the database. Credentials never live in these tables:
-- `credentials_metadata.secret_ref` and `webhook_endpoints.secret_ref` are references into the worker's
-- secret store.

CREATE TYPE sync_run_status AS ENUM ('running', 'succeeded', 'failed', 'skipped');
CREATE TYPE sync_trigger AS ENUM ('schedule', 'manual', 'test');

CREATE TABLE connection_phase_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  from_phase connection_phase,
  to_phase connection_phase NOT NULL,
  kind text NOT NULL CHECK (kind IN ('proposed', 'consent_granted', 'consent_revoked', 'security_review', 'phase_advanced', 'paused', 'resumed')),
  consent consent_status,
  scopes text[] NOT NULL DEFAULT '{}'::text[],
  actor_type actor_type NOT NULL,
  actor_id text NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  roles text[] NOT NULL DEFAULT '{}'::text[],
  reason text NOT NULL,
  review_outcome text CHECK (review_outcome IS NULL OR review_outcome IN ('approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connection_phase_changes_connection_idx ON connection_phase_changes (connection_id, created_at);

CREATE TABLE sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  trigger sync_trigger NOT NULL,
  phase connection_phase NOT NULL,
  mode text NOT NULL CHECK (mode IN ('sandbox', 'live')),
  status sync_run_status NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  objects_read integer NOT NULL DEFAULT 0,
  observations_written integer NOT NULL DEFAULT 0,
  error_class text,
  error_message text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK ((status = 'running' AND finished_at IS NULL) OR (status <> 'running' AND finished_at IS NOT NULL)),
  -- Error text is masked by the worker; a token-looking value is refused outright.
  CHECK (error_message IS NULL OR (error_message !~ '(sk-[A-Za-z0-9]{8,}|Bearer [A-Za-z0-9._-]{16,}|[A-Za-z0-9_-]{40,})'))
);
CREATE INDEX sync_runs_connection_idx ON sync_runs (connection_id, started_at DESC);

CREATE TABLE webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  path_token text NOT NULL UNIQUE,
  secret_ref text NOT NULL CHECK (secret_ref NOT LIKE 'sk-%' AND length(secret_ref) < 200),
  signature_state text NOT NULL DEFAULT 'unverified' CHECK (signature_state IN ('unverified', 'verified', 'failed')),
  last_received_at timestamptz,
  created_by_actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE kpi_observations ADD COLUMN sync_run_id uuid REFERENCES sync_runs(id) ON DELETE SET NULL;
ALTER TABLE connections ADD COLUMN sync_interval_minutes integer NOT NULL DEFAULT 60 CHECK (sync_interval_minutes >= 5 AND sync_interval_minutes <= 1440);
ALTER TABLE connections ADD COLUMN security_reviewed_at timestamptz;
ALTER TABLE connections ADD COLUMN security_reviewed_by text;
ALTER TABLE connections ADD COLUMN paused_reason text;

-- Phase and consent rules ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION phase_rank(p connection_phase) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p WHEN 'metadata' THEN 0 WHEN 'read_only' THEN 1 WHEN 'sandbox' THEN 2 WHEN 'write' THEN 3 END
$$;

CREATE OR REPLACE FUNCTION enforce_connection_phase() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor_t text := coalesce(nullif(current_setting('app.actor_type', true), ''), 'system');
BEGIN
  -- Agents and service identities never change phase, consent or status.
  IF (NEW.phase <> OLD.phase OR NEW.consent <> OLD.consent OR NEW.status <> OLD.status) AND (actor_t = 'agent' OR app_has_any_role(ARRAY['agent_service'])) THEN
    RAISE EXCEPTION 'agents cannot change the phase, consent or status of a connection' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Consent is a client admin decision made by a user (a superadmin may record it on the client''s written instruction).
  IF NEW.consent <> OLD.consent AND NEW.consent = 'granted' THEN
    IF actor_t <> 'user' OR NOT app_has_any_role(ARRAY['client_admin', 'superadmin']) THEN
      RAISE EXCEPTION 'consent can only be granted by a signed-in client admin (or superadmin on written instruction)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.consent_given_at := now();
  END IF;
  IF NEW.phase <> OLD.phase THEN
    IF NEW.phase = 'write' THEN
      RAISE EXCEPTION 'the write phase has no implementation in this release and is refused' USING ERRCODE = 'feature_not_supported';
    END IF;
    IF phase_rank(NEW.phase) > phase_rank(OLD.phase) + 1 THEN
      RAISE EXCEPTION 'connection phases advance one step at a time (% -> % refused)', OLD.phase, NEW.phase USING ERRCODE = 'check_violation';
    END IF;
    IF phase_rank(NEW.phase) > 0 THEN
      IF NEW.consent <> 'granted' THEN
        RAISE EXCEPTION 'phase % requires consent granted by the client admin', NEW.phase USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.security_reviewed_at IS NULL THEN
        RAISE EXCEPTION 'phase % requires a recorded security review', NEW.phase USING ERRCODE = 'check_violation';
      END IF;
      IF NOT app_has_any_role(ARRAY['superadmin', 'agency_operator', 'agency_reviewer']) THEN
        RAISE EXCEPTION 'advancing a connection phase is an agency decision (superadmin, agency_operator or agency_reviewer)' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
  END IF;
  -- Revoked consent pauses the connection and drops it back to metadata.
  IF NEW.consent = 'revoked' AND OLD.consent <> 'revoked' THEN
    NEW.phase := 'metadata';
    NEW.status := 'paused';
    NEW.paused_reason := coalesce(NEW.paused_reason, 'consent revoked');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connections_phase BEFORE UPDATE ON connections FOR EACH ROW EXECUTE FUNCTION enforce_connection_phase();

CREATE OR REPLACE FUNCTION enforce_connection_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.phase <> 'metadata' OR NEW.consent = 'granted' THEN
    RAISE EXCEPTION 'a connection starts in phase metadata without consent; consent and phases are recorded step by step' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connections_insert BEFORE INSERT ON connections FOR EACH ROW EXECUTE FUNCTION enforce_connection_insert();

-- Row-Level Security --------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['connection_phase_changes','sync_runs','webhook_endpoints']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO sbos_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t || '_app', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO sbos_operator USING (true)', t || '_operator_select', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON connection_phase_changes TO sbos_app;
GRANT SELECT, INSERT, UPDATE ON sync_runs, webhook_endpoints TO sbos_app;

-- Operator: health and lineage metadata, never config, secrets or error text that could carry data.
GRANT SELECT (id, tenant_id, connection_id, from_phase, to_phase, kind, consent, scopes, actor_type, actor_id, roles, review_outcome, created_at) ON connection_phase_changes TO sbos_operator;
GRANT SELECT (id, tenant_id, connection_id, trigger, phase, mode, status, started_at, finished_at, objects_read, observations_written, error_class) ON sync_runs TO sbos_operator;
GRANT SELECT (id, tenant_id, connection_id, signature_state, last_received_at, created_at) ON webhook_endpoints TO sbos_operator;
GRANT SELECT (sync_interval_minutes, security_reviewed_at, security_reviewed_by, paused_reason) ON connections TO sbos_operator;
GRANT SELECT (sync_run_id) ON kpi_observations TO sbos_operator;
