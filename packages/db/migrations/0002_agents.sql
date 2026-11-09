-- Migration 0002: agent runtime, tasks, runs, approvals, schedules, incidents, budgets,
-- notifications, questions and the minimal Knowledge Vault documents needed for Milestone 1.
-- Role keys renamed per ADR-017.

-- Role renames ----------------------------------------------------------------------------
INSERT INTO roles (key, scope, description) VALUES
  ('superadmin',         'agency', 'Manages tenants, roles, policies, budgets; approves break-glass; MFA mandatory'),
  ('client_admin',       'client', 'CEO: all tenant content, approvals, delegation, invites'),
  ('department_manager', 'client', 'Department content, answers questions, proposes actions'),
  ('agent_service',      'client', 'Non-interactive service identity for one agent instance')
ON CONFLICT (key) DO NOTHING;
-- Data fix across all tenants: the migration role has no RLS policy, so lift FORCE for the owner during the fix.
ALTER TABLE memberships NO FORCE ROW LEVEL SECURITY;
UPDATE memberships SET role_key = 'superadmin'         WHERE role_key = 'agency_superadmin';
UPDATE memberships SET role_key = 'client_admin'       WHERE role_key = 'client_ceo';
UPDATE memberships SET role_key = 'department_manager' WHERE role_key = 'client_manager';
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
DELETE FROM roles WHERE key IN ('agency_superadmin', 'client_ceo', 'client_manager');
UPDATE roles SET description = 'Mission Control metadata for all clients; content only via break-glass grant; MFA mandatory' WHERE key = 'agency_operator';

-- Enums -----------------------------------------------------------------------------------
CREATE TYPE authority_tier AS ENUM ('t1', 't2', 't3');
CREATE TYPE definition_status AS ENUM ('draft', 'active', 'deprecated');
CREATE TYPE release_channel AS ENUM ('draft', 'beta', 'stable', 'deprecated');
CREATE TYPE agent_state AS ENUM ('active', 'idle', 'running', 'paused', 'blocked', 'error', 'disabled');
CREATE TYPE task_state AS ENUM ('draft', 'open', 'assigned', 'in_progress', 'waiting_input', 'waiting_approval', 'done', 'cancelled', 'failed');
CREATE TYPE task_priority AS ENUM ('critical', 'high', 'medium', 'low');
CREATE TYPE run_trigger AS ENUM ('schedule', 'event', 'command', 'resume', 'recovery');
CREATE TYPE run_state AS ENUM ('queued', 'running', 'waiting_for_input', 'waiting_for_approval', 'paused', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted');
CREATE TYPE run_event_kind AS ENUM ('state_change', 'step_started', 'step_finished', 'tool_call', 'tool_denied', 'model_call', 'question_created', 'approval_requested', 'approval_decided', 'output_written', 'checkpoint', 'help_request', 'error', 'note');
CREATE TYPE classification AS ENUM ('public', 'internal', 'confidential', 'restricted');
CREATE TYPE approval_state AS ENUM ('pending', 'approved', 'rejected', 'expired', 'withdrawn');
CREATE TYPE risk_level AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE misfire_policy AS ENUM ('skip', 'run_once_late');
CREATE TYPE incident_kind AS ENUM ('run_failed', 'dead_letter', 'missed_schedule', 'budget_exceeded', 'credential_invalid', 'worker_error', 'notification_failed', 'lease_expired', 'tool_denied', 'admission_refused');
CREATE TYPE incident_state AS ENUM ('open', 'acknowledged', 'resolved');
CREATE TYPE budget_scope AS ENUM ('platform', 'tenant', 'agent_instance');
CREATE TYPE notification_channel AS ENUM ('email', 'pumble');
CREATE TYPE notification_state AS ENUM ('queued', 'sent', 'failed');
CREATE TYPE question_state AS ENUM ('draft', 'open', 'answered', 'skipped', 'superseded');
CREATE TYPE verification_status AS ENUM ('unconfirmed', 'hypothesis', 'evidence_backed', 'verified', 'approved_policy', 'deprecated');
CREATE TYPE feedback_kind AS ENUM ('correction', 'approval', 'rejection', 'clarification', 'instruction');

-- Agency-level catalogues (no tenant_id) --------------------------------------------------
CREATE TABLE skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  description text NOT NULL,
  status definition_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER skills_updated_at BEFORE UPDATE ON skills FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE skill_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version text NOT NULL,
  skill_md text NOT NULL,
  contracts text[] NOT NULL DEFAULT '{}'::text[],
  allowed_tools text[] NOT NULL DEFAULT '{}'::text[],
  release_channel release_channel NOT NULL DEFAULT 'draft',
  checksum text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_id, version)
);

CREATE TABLE skill_release_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  channel release_channel NOT NULL,
  skill_version_id uuid NOT NULL REFERENCES skill_versions(id),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_id, channel)
);

CREATE TABLE agent_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  mission text NOT NULL,
  department text,
  skill_id uuid REFERENCES skills(id),
  default_model text NOT NULL DEFAULT 'claude-sonnet-5-5',
  model_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  allowed_tools text[] NOT NULL DEFAULT '{}'::text[],
  required_data text[] NOT NULL DEFAULT '{}'::text[],
  authority authority_tier NOT NULL DEFAULT 't1',
  default_schedule_cron text,
  escalation_role text,
  default_budget_usd_month numeric(10,2) NOT NULL DEFAULT 5.00,
  default_run_cap_usd numeric(10,4) NOT NULL DEFAULT 0.50,
  input_contracts text[] NOT NULL DEFAULT '{}'::text[],
  output_contracts text[] NOT NULL DEFAULT '{}'::text[],
  quality_criteria text[] NOT NULL DEFAULT '{}'::text[],
  owner_role text NOT NULL DEFAULT 'superadmin',
  status definition_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER agent_definitions_updated_at BEFORE UPDATE ON agent_definitions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Tenant-scoped runtime tables ------------------------------------------------------------
CREATE TABLE budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,          -- NULL for platform scope
  scope budget_scope NOT NULL,
  agent_instance_id uuid,                                            -- set for agent_instance scope (FK added below)
  cap_usd_month numeric(10,2) NOT NULL,
  run_cap_usd numeric(10,4) NOT NULL DEFAULT 0.50,
  warn_ratio numeric(3,2) NOT NULL DEFAULT 0.80,
  hard_stop boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'platform' AND tenant_id IS NULL AND agent_instance_id IS NULL)
      OR (scope = 'tenant' AND tenant_id IS NOT NULL AND agent_instance_id IS NULL)
      OR (scope = 'agent_instance' AND tenant_id IS NOT NULL AND agent_instance_id IS NOT NULL))
);
CREATE UNIQUE INDEX budgets_platform_idx ON budgets (scope) WHERE scope = 'platform';
CREATE UNIQUE INDEX budgets_tenant_idx ON budgets (tenant_id) WHERE scope = 'tenant';
CREATE UNIQUE INDEX budgets_instance_idx ON budgets (agent_instance_id) WHERE scope = 'agent_instance';
CREATE TRIGGER budgets_updated_at BEFORE UPDATE ON budgets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE agent_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  definition_id uuid NOT NULL REFERENCES agent_definitions(id),
  skill_version_id uuid REFERENCES skill_versions(id),
  name text NOT NULL,
  state agent_state NOT NULL DEFAULT 'idle',
  service_identity text NOT NULL,                                    -- actor_id used by the agent (agent_service role)
  model text,                                                        -- overrides definition.default_model
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_run_at timestamptz,
  next_scheduled_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, service_identity)
);
CREATE INDEX agent_instances_tenant_idx ON agent_instances (tenant_id);
CREATE TRIGGER agent_instances_updated_at BEFORE UPDATE ON agent_instances FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE budgets ADD CONSTRAINT budgets_instance_fk FOREIGN KEY (agent_instance_id) REFERENCES agent_instances(id) ON DELETE CASCADE;

CREATE TABLE agent_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_instance_id uuid REFERENCES agent_instances(id) ON DELETE SET NULL,
  parent_task_id uuid REFERENCES agent_tasks(id) ON DELETE SET NULL,
  title text NOT NULL,
  instruction text NOT NULL,                                         -- may contain client content; hidden from operators
  department text,
  priority task_priority NOT NULL DEFAULT 'medium',
  state task_state NOT NULL DEFAULT 'open',
  owner_role text,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_actor_type actor_type NOT NULL,
  created_by_actor_id text NOT NULL,
  due_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_tasks_tenant_state_idx ON agent_tasks (tenant_id, state);
CREATE TRIGGER agent_tasks_updated_at BEFORE UPDATE ON agent_tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_instance_id uuid NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE,
  name text NOT NULL,
  cron text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  enabled boolean NOT NULL DEFAULT true,
  expected_by_seconds integer NOT NULL DEFAULT 900,                  -- stall alarm window after next_run_at
  misfire misfire_policy NOT NULL DEFAULT 'skip',
  instruction text,                                                  -- task instruction created on each tick
  last_run_at timestamptz,
  next_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX schedules_tenant_idx ON schedules (tenant_id);
CREATE INDEX schedules_enabled_next_idx ON schedules (enabled, next_run_at);
CREATE TRIGGER schedules_updated_at BEFORE UPDATE ON schedules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_instance_id uuid NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE,
  task_id uuid REFERENCES agent_tasks(id) ON DELETE SET NULL,
  schedule_id uuid REFERENCES schedules(id) ON DELETE SET NULL,
  skill_version_id uuid REFERENCES skill_versions(id),
  trigger run_trigger NOT NULL,
  trigger_ref text,
  state run_state NOT NULL DEFAULT 'queued',
  attempt integer NOT NULL DEFAULT 1,
  job_id text,
  lease_expires_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  summary text,                                                      -- agent-written, must not contain client specifics
  error jsonb,
  tokens_input integer NOT NULL DEFAULT 0,
  tokens_output integer NOT NULL DEFAULT 0,
  cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  simulated boolean NOT NULL DEFAULT false,
  checkpoint jsonb,                                                  -- resumable step state; hidden from operators
  result jsonb,                                                      -- AgentRunResult; hidden from operators
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_runs_tenant_state_idx ON agent_runs (tenant_id, state);
CREATE INDEX agent_runs_instance_idx ON agent_runs (agent_instance_id, created_at DESC);
CREATE INDEX agent_runs_lease_idx ON agent_runs (state, lease_expires_at) WHERE state = 'running';
CREATE TRIGGER agent_runs_updated_at BEFORE UPDATE ON agent_runs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Run state machine: enforced in the database so no code path can skip it.
CREATE OR REPLACE FUNCTION enforce_run_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed boolean := false;
BEGIN
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  IF OLD.state IN ('succeeded', 'failed', 'cancelled', 'timed_out') THEN
    RAISE EXCEPTION 'run % is terminal (%), cannot move to %', OLD.id, OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
  allowed := CASE OLD.state
    WHEN 'queued' THEN NEW.state IN ('running', 'cancelled', 'failed')
    WHEN 'running' THEN NEW.state IN ('waiting_for_input', 'waiting_for_approval', 'paused', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted')
    WHEN 'waiting_for_input' THEN NEW.state IN ('queued', 'running', 'cancelled', 'timed_out')
    WHEN 'waiting_for_approval' THEN NEW.state IN ('queued', 'running', 'cancelled', 'timed_out')
    WHEN 'paused' THEN NEW.state IN ('queued', 'running', 'cancelled')
    WHEN 'interrupted' THEN NEW.state IN ('queued', 'running', 'failed', 'cancelled')
    ELSE false END;
  IF NOT allowed THEN
    RAISE EXCEPTION 'invalid run transition % -> % for run %', OLD.state, NEW.state, OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IN ('succeeded', 'failed', 'cancelled', 'timed_out') AND NEW.finished_at IS NULL THEN
    NEW.finished_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_runs_transition BEFORE UPDATE OF state ON agent_runs FOR EACH ROW EXECUTE FUNCTION enforce_run_transition();

CREATE TABLE run_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  kind run_event_kind NOT NULL,
  classification classification NOT NULL DEFAULT 'internal',
  summary text NOT NULL,                                             -- neutral one-liner, visible to operators
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,                        -- detail, hidden from operators
  tokens_input integer NOT NULL DEFAULT 0,
  tokens_output integer NOT NULL DEFAULT 0,
  cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  duration_ms integer,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);
CREATE INDEX run_events_tenant_run_idx ON run_events (tenant_id, run_id, seq);

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  task_id uuid REFERENCES agent_tasks(id) ON DELETE SET NULL,
  subject_type text NOT NULL,
  subject_id uuid,
  requested_by_actor_type actor_type NOT NULL,
  requested_by_actor_id text NOT NULL,
  approver_role text NOT NULL,
  risk risk_level NOT NULL,
  summary text NOT NULL,
  rationale text NOT NULL,
  evidence_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  blocking boolean NOT NULL DEFAULT true,
  state approval_state NOT NULL DEFAULT 'pending',
  decided_by_user_id uuid REFERENCES users(id),
  decided_by_actor_id text,
  decided_at timestamptz,
  decision_note text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state = 'pending' OR decided_at IS NOT NULL OR state = 'expired')
);
CREATE INDEX approvals_tenant_state_idx ON approvals (tenant_id, state);
CREATE TRIGGER approvals_updated_at BEFORE UPDATE ON approvals FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION enforce_approval_decision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'pending' AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'approval % already decided (%)', OLD.id, OLD.state USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IN ('approved', 'rejected') AND NEW.decided_by_actor_id IS NULL THEN
    RAISE EXCEPTION 'approval decision requires decided_by_actor_id' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IN ('approved', 'rejected') AND NEW.requested_by_actor_type = 'user' AND NEW.decided_by_actor_id = NEW.requested_by_actor_id THEN
    RAISE EXCEPTION 'requester cannot approve their own request' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approvals_decision BEFORE UPDATE OF state ON approvals FOR EACH ROW EXECUTE FUNCTION enforce_approval_decision();

-- Actions that must not execute without an approved approval. The trigger is the technical block.
CREATE TABLE approved_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  action_type text NOT NULL,
  risk risk_level NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  approval_id uuid REFERENCES approvals(id),
  executed_at timestamptz,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approved_actions_tenant_idx ON approved_actions (tenant_id, created_at DESC);

CREATE OR REPLACE FUNCTION enforce_action_approval() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  a_state approval_state;
  a_tenant uuid;
BEGIN
  IF NEW.executed_at IS NULL THEN RETURN NEW; END IF;
  IF NEW.risk IN ('low') AND NEW.approval_id IS NULL THEN RETURN NEW; END IF;  -- low risk may execute under T2 policy
  IF NEW.approval_id IS NULL THEN
    RAISE EXCEPTION 'action % (%) requires an approval before execution', NEW.id, NEW.action_type USING ERRCODE = 'check_violation';
  END IF;
  SELECT state, tenant_id INTO a_state, a_tenant FROM approvals WHERE id = NEW.approval_id;
  IF a_state IS DISTINCT FROM 'approved' OR a_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'action % cannot execute: approval % is % (tenant match: %)', NEW.id, NEW.approval_id, COALESCE(a_state::text, 'missing'), (a_tenant = NEW.tenant_id) USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approved_actions_gate BEFORE INSERT OR UPDATE OF executed_at ON approved_actions FOR EACH ROW EXECUTE FUNCTION enforce_action_approval();

CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,          -- NULL for platform incidents
  kind incident_kind NOT NULL,
  severity risk_level NOT NULL DEFAULT 'medium',
  title text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,                        -- identifiers only, never secrets or content
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  schedule_id uuid REFERENCES schedules(id) ON DELETE SET NULL,
  agent_instance_id uuid REFERENCES agent_instances(id) ON DELETE SET NULL,
  state incident_state NOT NULL DEFAULT 'open',
  acknowledged_by text,
  resolved_at timestamptz,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incidents_state_idx ON incidents (state, created_at DESC);
CREATE UNIQUE INDEX incidents_dedupe_idx ON incidents (dedupe_key) WHERE dedupe_key IS NOT NULL AND state = 'open';
CREATE TRIGGER incidents_updated_at BEFORE UPDATE ON incidents FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE cost_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  agent_instance_id uuid REFERENCES agent_instances(id) ON DELETE SET NULL,
  task_id uuid REFERENCES agent_tasks(id) ON DELETE SET NULL,
  model text NOT NULL,
  tokens_input integer NOT NULL,
  tokens_output integer NOT NULL,
  cost_usd numeric(12,6) NOT NULL,
  simulated boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cost_events_tenant_time_idx ON cost_events (tenant_id, occurred_at DESC);
CREATE INDEX cost_events_instance_time_idx ON cost_events (agent_instance_id, occurred_at DESC);

CREATE TABLE agent_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_instance_id uuid NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE,
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  task_id uuid REFERENCES agent_tasks(id) ON DELETE SET NULL,
  given_by_actor_id text NOT NULL,
  kind feedback_kind NOT NULL,
  message text NOT NULL,
  applies_to jsonb,
  should_update_skill boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_feedback_tenant_idx ON agent_feedback (tenant_id, created_at DESC);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  channel notification_channel NOT NULL,
  template text NOT NULL,
  recipient_role text,
  recipient_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  subject text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,                        -- identifiers and deep link only
  state notification_state NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_state_idx ON notifications (state, created_at);

CREATE TABLE knowledge_access_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_type actor_type NOT NULL,
  actor_id text NOT NULL,
  grant_id uuid REFERENCES client_content_grants(id) ON DELETE SET NULL,
  resource_type text NOT NULL,
  resource_id text,
  purpose text,
  accessed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_access_logs_tenant_idx ON knowledge_access_logs (tenant_id, accessed_at DESC);

-- Discovery output and minimal Knowledge Vault documents (extended in M2) ------------------
CREATE TABLE interview_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  round_number integer NOT NULL,
  department text,
  rationale text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, round_number)
);

CREATE TABLE questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  round_id uuid REFERENCES interview_rounds(id) ON DELETE SET NULL,
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  department text NOT NULL,
  recipient_role text NOT NULL,
  question_text text NOT NULL,
  reason text NOT NULL,
  evidence_gap text NOT NULL,
  priority task_priority NOT NULL,
  answer_type text NOT NULL,
  options text[] NOT NULL DEFAULT '{}'::text[],
  state question_state NOT NULL DEFAULT 'draft',
  confidence numeric(3,2) NOT NULL DEFAULT 0.5,
  asked_by_agent_instance_id uuid REFERENCES agent_instances(id) ON DELETE SET NULL,
  depends_on uuid[] NOT NULL DEFAULT '{}'::uuid[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX questions_tenant_state_idx ON questions (tenant_id, state);
CREATE TRIGGER questions_updated_at BEFORE UPDATE ON questions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE vault_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  path text NOT NULL,
  title text NOT NULL,
  frontmatter jsonb NOT NULL DEFAULT '{}'::jsonb,
  body_markdown text NOT NULL,
  classification classification NOT NULL DEFAULT 'confidential',
  verification verification_status NOT NULL DEFAULT 'unconfirmed',
  version integer NOT NULL DEFAULT 1,
  checksum text NOT NULL,
  created_by_actor_type actor_type NOT NULL,
  created_by_actor_id text NOT NULL,
  updated_by_actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, path)
);
CREATE TRIGGER vault_documents_updated_at BEFORE UPDATE ON vault_documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE vault_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES vault_documents(id) ON DELETE CASCADE,
  version integer NOT NULL,
  frontmatter jsonb NOT NULL,
  body_markdown text NOT NULL,
  checksum text NOT NULL,
  changed_by_actor_type actor_type NOT NULL,
  changed_by_actor_id text NOT NULL,
  change_note text,
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version)
);

-- Row-Level Security ----------------------------------------------------------------------
-- Agency catalogues: readable by every app context, writable only in agency scope.
ALTER TABLE skills ENABLE ROW LEVEL SECURITY;                 ALTER TABLE skills FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_versions ENABLE ROW LEVEL SECURITY;         ALTER TABLE skill_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_release_channels ENABLE ROW LEVEL SECURITY; ALTER TABLE skill_release_channels FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_definitions ENABLE ROW LEVEL SECURITY;      ALTER TABLE agent_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY skills_read ON skills FOR SELECT TO sbos_app, sbos_operator USING (true);
CREATE POLICY skills_write ON skills FOR ALL TO sbos_app USING (app_actor_scope() = 'agency') WITH CHECK (app_actor_scope() = 'agency');
CREATE POLICY skill_versions_read ON skill_versions FOR SELECT TO sbos_app, sbos_operator USING (true);
CREATE POLICY skill_versions_write ON skill_versions FOR ALL TO sbos_app USING (app_actor_scope() = 'agency') WITH CHECK (app_actor_scope() = 'agency');
CREATE POLICY skill_channels_read ON skill_release_channels FOR SELECT TO sbos_app, sbos_operator USING (true);
CREATE POLICY skill_channels_write ON skill_release_channels FOR ALL TO sbos_app USING (app_actor_scope() = 'agency') WITH CHECK (app_actor_scope() = 'agency');
CREATE POLICY agent_definitions_read ON agent_definitions FOR SELECT TO sbos_app, sbos_operator USING (true);
CREATE POLICY agent_definitions_write ON agent_definitions FOR ALL TO sbos_app USING (app_actor_scope() = 'agency') WITH CHECK (app_actor_scope() = 'agency');

-- Plain tenant tables: same pattern as 0001.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_instances','agent_tasks','schedules','agent_runs','run_events','approvals','approved_actions',
                           'cost_events','agent_feedback','knowledge_access_logs','interview_rounds','questions','vault_documents','vault_revisions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO sbos_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t || '_app', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO sbos_operator USING (true)', t || '_operator_select', t);
  END LOOP;
END $$;

-- Nullable-tenant tables: tenant rows in tenant scope, platform rows (NULL) in agency scope, operator reads all.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['budgets','incidents','notifications']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO sbos_app USING ((tenant_id IS NOT NULL AND tenant_id = app_tenant_id()) OR (tenant_id IS NULL AND app_actor_scope() = ''agency'')) WITH CHECK ((tenant_id IS NOT NULL AND tenant_id = app_tenant_id()) OR (tenant_id IS NULL AND app_actor_scope() = ''agency''))', t || '_app', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO sbos_operator USING (true)', t || '_operator_select', t);
  END LOOP;
END $$;
-- Operators may acknowledge incidents and create platform notifications; both are metadata.
CREATE POLICY incidents_operator_update ON incidents FOR UPDATE TO sbos_operator USING (true) WITH CHECK (true);
CREATE POLICY notifications_operator_insert ON notifications FOR INSERT TO sbos_operator WITH CHECK (true);

-- Grants ----------------------------------------------------------------------------------
GRANT SELECT ON skills, skill_versions, skill_release_channels, agent_definitions TO sbos_app, sbos_operator;
GRANT INSERT, UPDATE ON skills, skill_versions, skill_release_channels, agent_definitions TO sbos_app;

GRANT SELECT, INSERT, UPDATE ON agent_instances, agent_tasks, schedules, agent_runs, approvals, approved_actions, budgets,
  incidents, cost_events, agent_feedback, notifications, knowledge_access_logs, interview_rounds, questions,
  vault_documents, vault_revisions TO sbos_app;
GRANT INSERT ON run_events TO sbos_app;
GRANT SELECT ON run_events TO sbos_app;
GRANT DELETE ON schedules, agent_tasks TO sbos_app;

-- Operator: metadata columns only. Content columns are excluded explicitly.
GRANT SELECT ON agent_instances, schedules, approvals, budgets, incidents, cost_events, agent_feedback, knowledge_access_logs, interview_rounds, notifications TO sbos_operator;  -- notification payloads hold identifiers only (ADR-018)
GRANT SELECT (id, tenant_id, agent_instance_id, parent_task_id, title, department, priority, state, owner_role, owner_user_id,
              created_by_actor_type, created_by_actor_id, due_at, created_at, updated_at) ON agent_tasks TO sbos_operator;
GRANT SELECT (id, tenant_id, agent_instance_id, task_id, schedule_id, skill_version_id, trigger, trigger_ref, state, attempt, job_id,
              lease_expires_at, started_at, finished_at, summary, error, tokens_input, tokens_output, cost_usd, simulated, created_at, updated_at)
  ON agent_runs TO sbos_operator;
GRANT SELECT (id, tenant_id, run_id, seq, kind, classification, summary, tokens_input, tokens_output, cost_usd, duration_ms, occurred_at)
  ON run_events TO sbos_operator;
GRANT SELECT (id, tenant_id, run_id, action_type, risk, approval_id, executed_at, created_at) ON approved_actions TO sbos_operator;
GRANT SELECT (id, tenant_id, round_id, run_id, department, recipient_role, priority, answer_type, state, confidence, created_at) ON questions TO sbos_operator;
GRANT SELECT (id, tenant_id, path, title, classification, verification, version, checksum, created_at, updated_at) ON vault_documents TO sbos_operator;
GRANT SELECT (id, tenant_id, document_id, version, checksum, changed_by_actor_type, changed_by_actor_id, run_id, created_at) ON vault_revisions TO sbos_operator;
GRANT UPDATE (state, acknowledged_by, resolved_at, updated_at) ON incidents TO sbos_operator;
GRANT INSERT ON notifications TO sbos_operator;
