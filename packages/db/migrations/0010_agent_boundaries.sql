-- Migration 0010 (Milestone 6, security hardening): agent service identities never change governance rows.
--
-- Agents (actor type `agent`) may read within their tenant, write their own outputs (runs, events, questions,
-- facts, documents through the write-mode policy, findings, KPIs, nominations) and request approvals. They
-- never decide approvals, change budgets, schedules, memberships, content grants or tenants. Restrictive policies
-- make such writes affect zero rows or fail the WITH CHECK; the approval trigger refuses agent decisions and
-- deciders without the approver role.

CREATE OR REPLACE FUNCTION app_actor_type() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.actor_type', true), ''), 'system')
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['budgets','schedules','memberships','client_content_grants','tenants']
  LOOP
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR INSERT TO sbos_app WITH CHECK (app_actor_type() <> ''agent'')', t || '_no_agent_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR UPDATE TO sbos_app USING (app_actor_type() <> ''agent'') WITH CHECK (app_actor_type() <> ''agent'')', t || '_no_agent_update', t);
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR DELETE TO sbos_app USING (app_actor_type() <> ''agent'')', t || '_no_agent_delete', t);
  END LOOP;
END $$;

-- Approval decisions: never by an agent, only by a holder of the approver role (or a superadmin).
CREATE OR REPLACE FUNCTION enforce_approval_decision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'pending' AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'approval % already decided (%)', OLD.id, OLD.state USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IN ('approved', 'rejected') AND NEW.decided_by_actor_id IS NULL THEN
    RAISE EXCEPTION 'approval decision requires decided_by_actor_id' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state IN ('approved', 'rejected') AND NEW.state <> OLD.state THEN
    IF app_actor_type() = 'agent' OR app_has_any_role(ARRAY['agent_service']) THEN
      RAISE EXCEPTION 'agents never decide approvals' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT app_has_any_role(ARRAY[NEW.approver_role, 'superadmin']) THEN
      RAISE EXCEPTION 'deciding this approval requires the % role', NEW.approver_role USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NEW.state IN ('approved', 'rejected') AND NEW.requested_by_actor_type = 'user' AND NEW.decided_by_actor_id = NEW.requested_by_actor_id THEN
    RAISE EXCEPTION 'requester cannot approve their own request' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
