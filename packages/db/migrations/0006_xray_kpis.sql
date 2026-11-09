-- Migration 0006 (Milestone 3): Business X-Ray, KPI Registry, dashboards, management action center,
-- executive briefings, connections and credential metadata.

CREATE TYPE process_step_kind AS ENUM ('trigger', 'input', 'activity', 'handoff', 'decision', 'control', 'output');
CREATE TYPE intervention_type AS ENUM ('stop', 'simplify', 'standardize', 'integrate', 'automate', 'keep_human');
CREATE TYPE claim_type AS ENUM ('client_statement', 'data_observation', 'hypothesis');
CREATE TYPE finding_severity AS ENUM ('critical', 'high', 'medium', 'low', 'info');
CREATE TYPE finding_state AS ENUM ('open', 'validated', 'dismissed', 'resolved');
CREATE TYPE opportunity_state AS ENUM ('proposed', 'approved', 'rejected', 'in_progress', 'delivered', 'verified');
CREATE TYPE refresh_frequency AS ENUM ('realtime', 'hourly', 'daily', 'weekly', 'monthly', 'manual');
CREATE TYPE kpi_direction AS ENUM ('higher_is_better', 'lower_is_better');
CREATE TYPE kpi_reliability AS ENUM ('high', 'medium', 'low', 'unknown');
CREATE TYPE kpi_status AS ENUM ('draft', 'active', 'stale', 'missing_source', 'retired');
CREATE TYPE observation_status AS ENUM ('ok', 'missing_data', 'stale_data', 'error');
CREATE TYPE dashboard_audience AS ENUM ('ceo', 'cfo', 'coo', 'team_lead', 'consultant', 'auditor', 'custom');
CREATE TYPE widget_type AS ENUM ('kpi_tile', 'trend_line', 'bar', 'table', 'action_list', 'briefing', 'risk_list', 'data_gap_list', 'text_note');
CREATE TYPE action_task_state AS ENUM ('proposed', 'awaiting_approval', 'approved', 'assigned', 'in_progress', 'verifying', 'closed', 'escalated', 'rejected');
CREATE TYPE connection_phase AS ENUM ('metadata', 'read_only', 'sandbox', 'write');
CREATE TYPE connection_status AS ENUM ('proposed', 'consent_pending', 'active', 'paused', 'revoked', 'error');

-- Processes (AS-IS and TO-BE) --------------------------------------------------------------
CREATE TABLE processes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  department text,
  variant text NOT NULL DEFAULT 'as_is' CHECK (variant IN ('as_is', 'to_be')),
  owner_role text,
  description text,
  source_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  verification verification_status NOT NULL DEFAULT 'unconfirmed',
  vault_document_id uuid REFERENCES vault_documents(id) ON DELETE SET NULL,
  created_by_actor_type actor_type NOT NULL,
  created_by_actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key, variant)
);
CREATE TRIGGER processes_updated_at BEFORE UPDATE ON processes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE process_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  process_id uuid NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  kind process_step_kind NOT NULL DEFAULT 'activity',
  name text NOT NULL,
  owner_role text,
  system_name text,
  input text,
  output text,
  wait_time_hint text,
  exceptions text,
  control text,
  intervention intervention_type,                     -- TO-BE only: what changes compared to AS-IS
  source_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  UNIQUE (process_id, seq)
);

CREATE TABLE pain_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  process_id uuid REFERENCES processes(id) ON DELETE SET NULL,
  step_id uuid REFERENCES process_steps(id) ON DELETE SET NULL,
  description text NOT NULL,
  claim claim_type NOT NULL,
  evidence_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  created_by_actor_type actor_type NOT NULL,
  created_by_actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Findings and opportunities ---------------------------------------------------------------
CREATE TABLE findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL,
  department text NOT NULL,
  process_id uuid REFERENCES processes(id) ON DELETE SET NULL,
  severity finding_severity NOT NULL,
  urgency text NOT NULL,
  impact jsonb NOT NULL DEFAULT '{}'::jsonb,           -- { description, estimated_annual_cost?: { amount, currency, is_estimate: true } }
  owner_role text NOT NULL,
  evidence_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  source_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  claim claim_type NOT NULL,
  confidence numeric(3,2) NOT NULL DEFAULT 0.50,
  state finding_state NOT NULL DEFAULT 'open',
  review_status text NOT NULL DEFAULT 'unreviewed',
  agent_instance_id uuid REFERENCES agent_instances(id) ON DELETE SET NULL,
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX findings_tenant_state_idx ON findings (tenant_id, state);
CREATE TRIGGER findings_updated_at BEFORE UPDATE ON findings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL,
  finding_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  intervention intervention_type NOT NULL,
  business_case jsonb NOT NULL DEFAULT '{}'::jsonb,    -- Opportunity.business_case contract (all estimates labelled)
  priority_score jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { impact, feasibility, risk, time_to_value, composite }
  to_be_process_id uuid REFERENCES processes(id) ON DELETE SET NULL,
  state opportunity_state NOT NULL DEFAULT 'proposed',
  requires_approval boolean NOT NULL DEFAULT true,
  approval_id uuid REFERENCES approvals(id),
  source_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  confidence numeric(3,2) NOT NULL DEFAULT 0.50,
  review_status text NOT NULL DEFAULT 'unreviewed',
  agent_instance_id uuid REFERENCES agent_instances(id) ON DELETE SET NULL,
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX opportunities_tenant_state_idx ON opportunities (tenant_id, state);
CREATE TRIGGER opportunities_updated_at BEFORE UPDATE ON opportunities FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- An opportunity that requires approval cannot leave `proposed` without an approved approval.
CREATE OR REPLACE FUNCTION enforce_opportunity_approval() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE a_state approval_state;
BEGIN
  IF NEW.state IN ('approved', 'in_progress', 'delivered', 'verified') AND NEW.requires_approval THEN
    IF NEW.approval_id IS NULL THEN
      RAISE EXCEPTION 'opportunity % requires an approval before state %', NEW.id, NEW.state USING ERRCODE = 'check_violation';
    END IF;
    SELECT state INTO a_state FROM approvals WHERE id = NEW.approval_id AND tenant_id = NEW.tenant_id;
    IF a_state IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'opportunity %: approval % is % ', NEW.id, NEW.approval_id, COALESCE(a_state::text, 'missing') USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opportunities_approval BEFORE INSERT OR UPDATE OF state ON opportunities FOR EACH ROW EXECUTE FUNCTION enforce_opportunity_approval();

-- KPI Registry ------------------------------------------------------------------------------
CREATE TABLE kpis (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  business_question text NOT NULL,
  formula text NOT NULL,
  unit text NOT NULL,
  source_system text NOT NULL,
  source_field text NOT NULL,
  owner_role text NOT NULL,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  refresh refresh_frequency NOT NULL DEFAULT 'daily',
  direction kpi_direction NOT NULL DEFAULT 'higher_is_better',
  warning_threshold numeric,
  critical_threshold numeric,
  reliability kpi_reliability NOT NULL DEFAULT 'unknown',
  permission_scope text[] NOT NULL DEFAULT '{}'::text[],
  history_retention_days integer NOT NULL DEFAULT 730,
  last_successful_sync_at timestamptz,
  status kpi_status NOT NULL DEFAULT 'draft',
  created_by_actor_type actor_type NOT NULL,
  created_by_actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key),
  -- "No KPI without a defined source and calculation" (spec 4B).
  CHECK (length(trim(formula)) > 0 AND length(trim(source_system)) > 0 AND length(trim(source_field)) > 0)
);
CREATE TRIGGER kpis_updated_at BEFORE UPDATE ON kpis FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE kpi_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kpi_id uuid NOT NULL REFERENCES kpis(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL DEFAULT now(),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  value numeric,
  status observation_status NOT NULL,
  source_id uuid REFERENCES sources(id) ON DELETE SET NULL,
  computed_by_actor_type actor_type NOT NULL,
  computed_by_actor_id text NOT NULL,
  lineage jsonb NOT NULL DEFAULT '{}'::jsonb,          -- { query_or_formula, source_record_ids[] }
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  -- Never invent numbers: a value exists only when the observation is ok.
  CHECK ((status = 'ok' AND value IS NOT NULL) OR (status <> 'ok' AND value IS NULL))
);
CREATE INDEX kpi_observations_kpi_time_idx ON kpi_observations (kpi_id, observed_at DESC);

-- Dashboards (specifications rendered by the whitelist renderer) ----------------------------
CREATE TABLE dashboards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  audience dashboard_audience NOT NULL,
  title text NOT NULL,
  locale text NOT NULL DEFAULT 'en',
  version integer NOT NULL DEFAULT 1,
  specification jsonb NOT NULL,                        -- DashboardSpecification contract, validated before insert
  review_status text NOT NULL DEFAULT 'unreviewed',
  generated_by_agent_instance_id uuid REFERENCES agent_instances(id) ON DELETE SET NULL,
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX dashboards_current_idx ON dashboards (tenant_id, audience) WHERE is_current;

CREATE TABLE dashboard_widgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  dashboard_id uuid NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  widget_key text NOT NULL,
  type widget_type NOT NULL,
  kpi_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  priority integer NOT NULL DEFAULT 100,
  reason text NOT NULL,
  size text NOT NULL DEFAULT 'm',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (dashboard_id, widget_key)
);

-- Management Action Center ------------------------------------------------------------------
CREATE TABLE action_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title text NOT NULL,
  issue text NOT NULL,                                  -- the problem
  proposed_action text NOT NULL,
  opportunity_id uuid REFERENCES opportunities(id) ON DELETE SET NULL,
  finding_id uuid REFERENCES findings(id) ON DELETE SET NULL,
  owner_role text,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  approval_id uuid REFERENCES approvals(id),
  state action_task_state NOT NULL DEFAULT 'proposed',
  due_at timestamptz,
  verification_schedule_id uuid REFERENCES schedules(id) ON DELETE SET NULL,
  verification_note text,
  closed_at timestamptz,
  source_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  created_by_actor_type actor_type NOT NULL,
  created_by_actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX action_tasks_tenant_state_idx ON action_tasks (tenant_id, state);
CREATE TRIGGER action_tasks_updated_at BEFORE UPDATE ON action_tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION enforce_action_task_approval() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE a_state approval_state;
BEGIN
  IF NEW.state IN ('approved', 'assigned', 'in_progress', 'verifying', 'closed') THEN
    IF NEW.approval_id IS NULL THEN
      RAISE EXCEPTION 'action task % needs an approval before state %', NEW.id, NEW.state USING ERRCODE = 'check_violation';
    END IF;
    SELECT state INTO a_state FROM approvals WHERE id = NEW.approval_id AND tenant_id = NEW.tenant_id;
    IF a_state IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'action task %: approval % is %', NEW.id, NEW.approval_id, COALESCE(a_state::text, 'missing') USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER action_tasks_approval BEFORE INSERT OR UPDATE OF state ON action_tasks FOR EACH ROW EXECUTE FUNCTION enforce_action_task_approval();

-- Executive briefings -----------------------------------------------------------------------
CREATE TABLE briefings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  briefing_date date NOT NULL,
  audience dashboard_audience NOT NULL DEFAULT 'ceo',
  content jsonb NOT NULL,                               -- ExecutiveBriefing contract
  vault_document_id uuid REFERENCES vault_documents(id) ON DELETE SET NULL,
  agent_instance_id uuid REFERENCES agent_instances(id) ON DELETE SET NULL,
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  simulated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, briefing_date, audience)
);

-- Connections and credential metadata (no secret values; the secret lives in the secret store) ---
CREATE TABLE connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  system_id uuid REFERENCES systems(id) ON DELETE SET NULL,
  provider text NOT NULL,                               -- rentman, quickbooks, trengo, dropbox, pumble, ...
  phase connection_phase NOT NULL DEFAULT 'metadata',
  status connection_status NOT NULL DEFAULT 'proposed',
  consent consent_status NOT NULL DEFAULT 'pending',
  consent_given_by_user_id uuid REFERENCES users(id),
  consent_given_at timestamptz,
  scopes text[] NOT NULL DEFAULT '{}'::text[],
  last_sync_at timestamptz,
  last_error text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,            -- non-secret settings only
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connections_tenant_idx ON connections (tenant_id, provider);
CREATE TRIGGER connections_updated_at BEFORE UPDATE ON connections FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE credentials_metadata (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  kind text NOT NULL,                                   -- api_key, oauth_refresh_token, basic
  secret_ref text NOT NULL,                             -- reference into the secret store, never the value
  rotated_at timestamptz,
  expires_at timestamptz,
  created_by_actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (secret_ref NOT LIKE 'sk-%' AND length(secret_ref) < 200)
);

-- Row-Level Security ----------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['processes','process_steps','pain_points','findings','opportunities','kpis','kpi_observations','dashboards',
                           'dashboard_widgets','action_tasks','briefings','connections','credentials_metadata']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO sbos_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t || '_app', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO sbos_operator USING (true)', t || '_operator_select', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON processes, process_steps, pain_points, findings, opportunities, kpis, dashboards, dashboard_widgets, action_tasks, briefings, connections, credentials_metadata TO sbos_app;
GRANT SELECT, INSERT ON kpi_observations TO sbos_app;
GRANT DELETE ON process_steps, dashboard_widgets TO sbos_app;

-- Operator: metadata only (no descriptions, formulas, impact, business cases, briefing content or configs).
GRANT SELECT (id, tenant_id, key, name, department, variant, owner_role, verification, created_at, updated_at) ON processes TO sbos_operator;
GRANT SELECT (id, tenant_id, process_id, seq, kind, owner_role, system_name, intervention) ON process_steps TO sbos_operator;
GRANT SELECT (id, tenant_id, process_id, step_id, claim, created_at) ON pain_points TO sbos_operator;
GRANT SELECT (id, tenant_id, department, severity, urgency, owner_role, claim, confidence, state, review_status, agent_instance_id, run_id, created_at) ON findings TO sbos_operator;
GRANT SELECT (id, tenant_id, intervention, state, requires_approval, approval_id, confidence, review_status, agent_instance_id, run_id, created_at) ON opportunities TO sbos_operator;
GRANT SELECT (id, tenant_id, key, name, unit, source_system, owner_role, refresh, reliability, status, last_successful_sync_at, created_at) ON kpis TO sbos_operator;
GRANT SELECT (id, tenant_id, kpi_id, observed_at, status, computed_by_actor_type, run_id) ON kpi_observations TO sbos_operator;
GRANT SELECT (id, tenant_id, audience, version, review_status, generated_by_agent_instance_id, run_id, is_current, created_at) ON dashboards TO sbos_operator;
GRANT SELECT (id, tenant_id, dashboard_id, widget_key, type, priority, size) ON dashboard_widgets TO sbos_operator;
GRANT SELECT (id, tenant_id, owner_role, approval_id, state, due_at, verification_schedule_id, closed_at, created_at) ON action_tasks TO sbos_operator;
GRANT SELECT (id, tenant_id, briefing_date, audience, agent_instance_id, run_id, simulated, created_at) ON briefings TO sbos_operator;
GRANT SELECT (id, tenant_id, system_id, provider, phase, status, consent, consent_given_at, scopes, last_sync_at, last_error, created_at, updated_at) ON connections TO sbos_operator;
GRANT SELECT (id, tenant_id, connection_id, kind, rotated_at, expires_at, created_at) ON credentials_metadata TO sbos_operator;
