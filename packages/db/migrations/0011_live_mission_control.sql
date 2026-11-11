-- Live Agent Mission Control (ADR-024): delegation lineage, operator instructions at checkpoints, and
-- LISTEN/NOTIFY so the web stream learns about changes without polling. Payloads carry identifiers only.

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS parent_run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS agent_runs_parent_idx ON agent_runs (parent_run_id) WHERE parent_run_id IS NOT NULL;
GRANT SELECT (parent_run_id) ON agent_runs TO sbos_operator;

-- Operator instructions for a run, applied by the worker at its next checkpoint. Humans (and the system) write
-- them; agents never do. Consumption only sets consumed_at and consumed_at_step.
CREATE TABLE run_instructions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  created_by_actor_type actor_type NOT NULL,
  created_by_actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  consumed_at_step text
);
CREATE INDEX run_instructions_run_idx ON run_instructions (run_id, created_at) WHERE consumed_at IS NULL;
ALTER TABLE run_instructions ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_instructions FORCE ROW LEVEL SECURITY;
CREATE POLICY run_instructions_tenant_select ON run_instructions FOR SELECT TO sbos_app USING (tenant_id = app_tenant_id());
CREATE POLICY run_instructions_tenant_insert ON run_instructions FOR INSERT TO sbos_app WITH CHECK (tenant_id = app_tenant_id() AND app_actor_type() <> 'agent');
CREATE POLICY run_instructions_tenant_update ON run_instructions FOR UPDATE TO sbos_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY run_instructions_operator_select ON run_instructions FOR SELECT TO sbos_operator USING (true);
GRANT SELECT, INSERT, UPDATE ON run_instructions TO sbos_app;
GRANT SELECT ON run_instructions TO sbos_operator;

CREATE OR REPLACE FUNCTION enforce_run_instruction() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE run_state text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app_actor_type() = 'agent' OR app_has_any_role(ARRAY['agent_service']) THEN
      RAISE EXCEPTION 'agents cannot instruct runs' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT state::text INTO run_state FROM agent_runs WHERE id = NEW.run_id AND tenant_id = NEW.tenant_id;
    IF run_state IS NULL THEN RAISE EXCEPTION 'run not found in this tenant' USING ERRCODE = 'foreign_key_violation'; END IF;
    IF run_state IN ('succeeded', 'failed', 'cancelled', 'timed_out') THEN
      RAISE EXCEPTION 'run % is % and takes no more instructions', NEW.run_id, run_state USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: only consumption fields may change, and only once.
  IF NEW.text <> OLD.text OR NEW.run_id <> OLD.run_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.created_by_actor_id <> OLD.created_by_actor_id THEN
    RAISE EXCEPTION 'run instructions are immutable except for consumption' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND (NEW.consumed_at IS DISTINCT FROM OLD.consumed_at OR NEW.consumed_at_step IS DISTINCT FROM OLD.consumed_at_step) THEN
    RAISE EXCEPTION 'instruction already consumed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER run_instructions_enforce BEFORE INSERT OR UPDATE ON run_instructions FOR EACH ROW EXECUTE FUNCTION enforce_run_instruction();

-- Live notifications: identifiers only (table, operation, id, tenant). Readers re-read through RLS.
CREATE OR REPLACE FUNCTION notify_live_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE payload text;
BEGIN
  payload := json_build_object('table', TG_TABLE_NAME, 'op', TG_OP, 'id', NEW.id, 'tenantId', NEW.tenant_id, 'at', now())::text;
  PERFORM pg_notify('sbos_live', payload);
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_runs','run_events','approvals','incidents','questions','agent_instances','sync_runs','run_instructions','agent_tasks']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_notify_live', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION notify_live_change()', t || '_notify_live', t);
  END LOOP;
END $$;
