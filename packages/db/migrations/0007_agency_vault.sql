-- Migration 0007 (Milestone 4): Agency Intelligence Vault (spec 4H).
--
-- Agency knowledge lives in the same database but has no tenant_id: it belongs to the agency and is
-- readable and writable only in agency scope (app_actor_scope() = 'agency'). Tenant scope never reads
-- these tables. Client content enters only through a reviewed promotion request; publication is never
-- automatic. Adoptions pin a version per tenant; deprecating or rolling back a record never changes an
-- adoption (acceptance 5).

CREATE TYPE knowledge_record_state AS ENUM ('draft', 'in_review', 'approved', 'published', 'deprecated', 'archived');
CREATE TYPE knowledge_record_kind AS ENUM ('method_template', 'process_pattern', 'interview_set', 'sop', 'dashboard_template', 'kpi_definition', 'skill_note', 'blueprint', 'reusable_insight', 'research_note', 'decision', 'other');
CREATE TYPE knowledge_origin AS ENUM ('own', 'public_license', 'abstracted_from_client');
CREATE TYPE promotion_state AS ENUM ('nominated', 'in_review', 'approved', 'rejected', 'withdrawn', 'published');
CREATE TYPE promotion_decision AS ENUM ('approve', 'reject', 'needs_changes');
CREATE TYPE adoption_state AS ENUM ('active', 'superseded', 'rolled_back', 'revoked');
CREATE TYPE deprecation_kind AS ENUM ('release', 'deprecate', 'rollback', 'reinstate', 'archive', 'consent_review');

-- Knowledge records and immutable versions -----------------------------------------------------
CREATE TABLE agency_knowledge_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder text NOT NULL CHECK (folder ~ '^[0-9]{2}_[a-z0-9_]+$'),
  path text NOT NULL UNIQUE CHECK (path ~ '^[0-9]{2}_[a-z0-9_]+/[A-Za-z0-9._/-]+\.md$'),
  title text NOT NULL,
  kind knowledge_record_kind NOT NULL DEFAULT 'other',
  state knowledge_record_state NOT NULL DEFAULT 'draft',
  current_version_id uuid,
  owner_actor_id text NOT NULL,
  classification classification NOT NULL DEFAULT 'internal',
  origin knowledge_origin NOT NULL DEFAULT 'own',
  license text,
  allowed_uses text[] NOT NULL DEFAULT '{}'::text[],
  source_version text,
  review_due_at date,
  confidence numeric(3,2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  promotion_request_id uuid,
  related_skill_keys text[] NOT NULL DEFAULT '{}'::text[],
  created_by_actor_type actor_type NOT NULL,
  created_by_actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Knowledge abstracted from a client must name its rights basis through the promotion request.
  CHECK (origin <> 'abstracted_from_client' OR promotion_request_id IS NOT NULL)
);
CREATE INDEX agency_knowledge_records_folder_idx ON agency_knowledge_records (folder, state);
CREATE TRIGGER agency_knowledge_records_updated_at BEFORE UPDATE ON agency_knowledge_records FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE agency_knowledge_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id uuid NOT NULL REFERENCES agency_knowledge_records(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  frontmatter jsonb NOT NULL DEFAULT '{}'::jsonb,
  body_markdown text NOT NULL,
  changelog text NOT NULL,
  checksum text NOT NULL,
  evidence_link text,
  created_by_actor_type actor_type NOT NULL,
  created_by_actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  search tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(body_markdown, ''))) STORED,
  UNIQUE (record_id, version)
);
CREATE INDEX agency_knowledge_versions_search_idx ON agency_knowledge_versions USING gin (search);
ALTER TABLE agency_knowledge_records ADD CONSTRAINT agency_knowledge_records_current_version_fk FOREIGN KEY (current_version_id) REFERENCES agency_knowledge_versions(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION refuse_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'agency_knowledge_versions are immutable; add a new version instead' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER agency_knowledge_versions_immutable BEFORE UPDATE OR DELETE ON agency_knowledge_versions FOR EACH ROW EXECUTE FUNCTION refuse_version_mutation();

CREATE TABLE agency_knowledge_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id uuid NOT NULL REFERENCES agency_knowledge_records(id) ON DELETE CASCADE,
  from_state knowledge_record_state,
  to_state knowledge_record_state NOT NULL,
  actor_type actor_type NOT NULL,
  actor_id text NOT NULL,
  roles text[] NOT NULL DEFAULT '{}'::text[],
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agency_knowledge_transitions_record_idx ON agency_knowledge_transitions (record_id, created_at);

-- Lifecycle: draft -> in_review -> approved -> published -> deprecated -> archived, reviewer recorded.
CREATE OR REPLACE FUNCTION enforce_knowledge_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed boolean;
  actor text := app_actor_id();
  actor_t text := coalesce(nullif(current_setting('app.actor_type', true), ''), 'system');
BEGIN
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  allowed := (OLD.state, NEW.state) IN (
    ('draft', 'in_review'), ('in_review', 'draft'), ('in_review', 'approved'), ('approved', 'draft'),
    ('approved', 'published'), ('published', 'deprecated'), ('deprecated', 'published'), ('deprecated', 'archived'));
  IF NOT allowed THEN
    RAISE EXCEPTION 'knowledge record transition % -> % is not allowed', OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
  IF actor_t = 'agent' AND NEW.state IN ('approved', 'published', 'deprecated', 'archived') THEN
    RAISE EXCEPTION 'agents cannot approve, publish, deprecate or archive agency knowledge' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.state IN ('approved', 'published', 'deprecated', 'archived') THEN
    IF NOT app_has_any_role(ARRAY['agency_reviewer', 'superadmin']) THEN
      RAISE EXCEPTION 'transition to % requires the agency_reviewer or superadmin role', NEW.state USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  -- No self-approval: the author needs a second person unless they are the superadmin (recorded on the transition).
  -- A record published from an approved promotion request was already reviewed on the request; its
  -- approval is the publication act of the same reviewer, so the rule does not apply there.
  IF NEW.state = 'approved' AND NEW.promotion_request_id IS NULL AND actor = OLD.owner_actor_id AND NOT app_has_any_role(ARRAY['superadmin']) THEN
    RAISE EXCEPTION 'the author cannot approve their own knowledge record' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.state = 'published' AND NEW.current_version_id IS NULL THEN
    RAISE EXCEPTION 'a knowledge record needs a current version before it is published' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = 'approved' AND NEW.promotion_request_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM knowledge_promotion_requests r WHERE r.id = NEW.promotion_request_id AND r.state IN ('approved', 'published')) THEN
      RAISE EXCEPTION 'a record abstracted from client knowledge needs an approved promotion request first' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION log_knowledge_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.state <> OLD.state THEN
    INSERT INTO agency_knowledge_transitions (record_id, from_state, to_state, actor_type, actor_id, roles, note)
    VALUES (NEW.id, CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.state END, NEW.state,
            coalesce(nullif(current_setting('app.actor_type', true), ''), 'system')::actor_type, app_actor_id(),
            string_to_array(coalesce(nullif(current_setting('app.roles', true), ''), ''), ','),
            CASE WHEN NEW.state = 'approved' AND app_actor_id() = NEW.owner_actor_id THEN 'self_approved_by_superadmin' END);
  END IF;
  RETURN NEW;
END $$;

-- Promotion requests must exist before the record trigger can reference them.
CREATE TABLE knowledge_promotion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nominated_by_actor_type actor_type NOT NULL,
  nominated_by_actor_id text NOT NULL,
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  title text NOT NULL,
  proposed_generic_statement text NOT NULL,
  rationale text NOT NULL,
  classification classification NOT NULL DEFAULT 'internal',
  confidentiality text NOT NULL DEFAULT 'confidential' CHECK (confidentiality IN ('public', 'internal', 'confidential')),
  identifiability_risk text NOT NULL DEFAULT 'medium' CHECK (identifiability_risk IN ('low', 'medium', 'high')),
  rights_basis text,
  consent_status consent_status NOT NULL DEFAULT 'pending',
  owner_role text NOT NULL DEFAULT 'agency_reviewer',
  reviewer_role text NOT NULL DEFAULT 'agency_reviewer',
  source_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  state promotion_state NOT NULL DEFAULT 'nominated',
  reviewer_actor_id text,
  decided_at timestamptz,
  published_record_id uuid REFERENCES agency_knowledge_records(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_promotion_requests_state_idx ON knowledge_promotion_requests (state, created_at);
CREATE TRIGGER knowledge_promotion_requests_updated_at BEFORE UPDATE ON knowledge_promotion_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE agency_knowledge_records ADD CONSTRAINT agency_knowledge_records_promotion_fk FOREIGN KEY (promotion_request_id) REFERENCES knowledge_promotion_requests(id) ON DELETE RESTRICT;

CREATE TRIGGER agency_knowledge_records_transition BEFORE UPDATE OF state ON agency_knowledge_records FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_transition();
CREATE TRIGGER agency_knowledge_records_log AFTER INSERT OR UPDATE OF state ON agency_knowledge_records FOR EACH ROW EXECUTE FUNCTION log_knowledge_transition();

CREATE TABLE knowledge_promotion_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES knowledge_promotion_requests(id) ON DELETE CASCADE,
  reviewer_actor_type actor_type NOT NULL,
  reviewer_actor_id text NOT NULL,
  roles text[] NOT NULL DEFAULT '{}'::text[],
  decision promotion_decision NOT NULL,
  rights_check boolean NOT NULL DEFAULT false,
  security_check boolean NOT NULL DEFAULT false,
  identifiability_check boolean NOT NULL DEFAULT false,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_promotion_reviews_request_idx ON knowledge_promotion_reviews (request_id, created_at);

-- Promotion gate: an agent may only nominate; a reviewer decides; approval needs a review with all three checks.
CREATE OR REPLACE FUNCTION enforce_promotion_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'nominated' THEN
    RAISE EXCEPTION 'a promotion request starts as nominated; publication is never automatic' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_promotion_requests_insert BEFORE INSERT ON knowledge_promotion_requests FOR EACH ROW EXECUTE FUNCTION enforce_promotion_insert();

CREATE OR REPLACE FUNCTION enforce_promotion_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor_t text := coalesce(nullif(current_setting('app.actor_type', true), ''), 'system');
  is_reviewer boolean := app_has_any_role(ARRAY['agency_reviewer', 'superadmin']) AND app_actor_scope() = 'agency';
BEGIN
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  IF actor_t = 'agent' THEN
    RAISE EXCEPTION 'agents cannot change the state of a promotion request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT ((OLD.state, NEW.state) IN (('nominated', 'in_review'), ('nominated', 'withdrawn'), ('nominated', 'rejected'), ('in_review', 'approved'), ('in_review', 'rejected'), ('in_review', 'nominated'), ('approved', 'published'), ('approved', 'rejected'))) THEN
    RAISE EXCEPTION 'promotion request transition % -> % is not allowed', OLD.state, NEW.state USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = 'withdrawn' THEN
    IF NOT (app_has_any_role(ARRAY['client_admin']) OR is_reviewer) THEN
      RAISE EXCEPTION 'only the client admin or a reviewer can withdraw a nomination' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT is_reviewer THEN
    RAISE EXCEPTION 'transition to % requires the agency_reviewer or superadmin role in agency scope', NEW.state USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.state = 'approved' THEN
    IF NOT EXISTS (
      SELECT 1 FROM knowledge_promotion_reviews rv
      WHERE rv.request_id = NEW.id AND rv.decision = 'approve' AND rv.rights_check AND rv.security_check AND rv.identifiability_check
        AND rv.reviewer_actor_type <> 'agent') THEN
      RAISE EXCEPTION 'approval needs a review with rights, security and identifiability checks passed' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.consent_status NOT IN ('granted', 'not_required') THEN
      RAISE EXCEPTION 'approval needs consent_status granted or not_required (rights basis recorded)' USING ERRCODE = 'check_violation';
    END IF;
    NEW.reviewer_actor_id := app_actor_id();
    NEW.decided_at := now();
  END IF;
  IF NEW.state = 'rejected' THEN
    NEW.reviewer_actor_id := app_actor_id();
    NEW.decided_at := now();
  END IF;
  IF NEW.state = 'published' AND NEW.published_record_id IS NULL THEN
    RAISE EXCEPTION 'published promotion requests must reference the agency knowledge record' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_promotion_requests_transition BEFORE UPDATE ON knowledge_promotion_requests FOR EACH ROW EXECUTE FUNCTION enforce_promotion_transition();

-- Methodology templates and per-tenant adoptions ---------------------------------------------
CREATE TABLE methodology_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  record_id uuid NOT NULL REFERENCES agency_knowledge_records(id) ON DELETE RESTRICT,
  name text NOT NULL,
  description text NOT NULL,
  target_folder text NOT NULL CHECK (target_folder ~ '^[0-9]{2}_[a-z0-9_]+$'),
  parameters jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER methodology_templates_updated_at BEFORE UPDATE ON methodology_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE template_adoptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES methodology_templates(id) ON DELETE RESTRICT,
  record_version_id uuid NOT NULL REFERENCES agency_knowledge_versions(id) ON DELETE RESTRICT,
  version integer NOT NULL,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  state adoption_state NOT NULL DEFAULT 'active',
  vault_document_id uuid REFERENCES vault_documents(id) ON DELETE SET NULL,
  previous_adoption_id uuid REFERENCES template_adoptions(id) ON DELETE SET NULL,
  adopted_by_actor_id text NOT NULL,
  adopted_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  note text
);
CREATE INDEX template_adoptions_tenant_idx ON template_adoptions (tenant_id, template_id, state);
CREATE UNIQUE INDEX template_adoptions_one_active ON template_adoptions (tenant_id, template_id) WHERE state = 'active';

-- Only published versions can be adopted; the adopted version is pinned and never changes afterwards.
CREATE OR REPLACE FUNCTION enforce_adoption() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rec_state knowledge_record_state; rec_id uuid; tpl_rec uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.record_version_id <> OLD.record_version_id OR NEW.template_id <> OLD.template_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.version <> OLD.version THEN
      RAISE EXCEPTION 'an adoption pins its version; adopt a new version instead of changing this one' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT r.state, r.id INTO rec_state, rec_id FROM agency_knowledge_versions v JOIN agency_knowledge_records r ON r.id = v.record_id WHERE v.id = NEW.record_version_id;
  IF rec_id IS NULL THEN
    RAISE EXCEPTION 'adoption refers to an unknown or invisible knowledge version' USING ERRCODE = 'check_violation';
  END IF;
  SELECT record_id INTO tpl_rec FROM methodology_templates WHERE id = NEW.template_id;
  IF tpl_rec IS DISTINCT FROM rec_id THEN
    RAISE EXCEPTION 'the version does not belong to the template''s knowledge record' USING ERRCODE = 'check_violation';
  END IF;
  IF rec_state <> 'published' THEN
    RAISE EXCEPTION 'only a published knowledge record can be adopted (record is %)', rec_state USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER template_adoptions_enforce BEFORE INSERT OR UPDATE ON template_adoptions FOR EACH ROW EXECUTE FUNCTION enforce_adoption();

-- Evaluation cases and deprecation events ----------------------------------------------------
CREATE TABLE evaluation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id uuid NOT NULL REFERENCES agency_knowledge_records(id) ON DELETE CASCADE,
  name text NOT NULL,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  expected jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_result text NOT NULL DEFAULT 'not_run' CHECK (last_result IN ('pass', 'fail', 'not_run')),
  last_run_at timestamptz,
  last_version_id uuid REFERENCES agency_knowledge_versions(id) ON DELETE SET NULL,
  created_by_actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (record_id, name)
);

CREATE TABLE knowledge_deprecation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id uuid NOT NULL REFERENCES agency_knowledge_records(id) ON DELETE CASCADE,
  version_id uuid REFERENCES agency_knowledge_versions(id) ON DELETE SET NULL,
  kind deprecation_kind NOT NULL,
  reason text NOT NULL,
  affected_adoptions integer NOT NULL DEFAULT 0,
  actor_type actor_type NOT NULL,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_deprecation_events_record_idx ON knowledge_deprecation_events (record_id, created_at);

-- Row-Level Security --------------------------------------------------------------------------
-- Agency-only tables (no tenant_id): agency scope reads and writes, operator reads metadata, tenant scope sees nothing.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agency_knowledge_records','agency_knowledge_versions','agency_knowledge_transitions','methodology_templates','evaluation_cases','knowledge_deprecation_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO sbos_app USING (app_actor_scope() = ''agency'') WITH CHECK (app_actor_scope() = ''agency'')', t || '_agency', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO sbos_operator USING (true)', t || '_operator_select', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO sbos_app', t);
  END LOOP;
END $$;

-- Adoptions: tenant rows; agency scope pinned to the tenant writes them, the tenant reads its own.
ALTER TABLE template_adoptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE template_adoptions FORCE ROW LEVEL SECURITY;
CREATE POLICY template_adoptions_app ON template_adoptions FOR ALL TO sbos_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
-- Agency staff see which versions are installed where (needed for release and deprecation impact counts).
CREATE POLICY template_adoptions_agency_select ON template_adoptions FOR SELECT TO sbos_app USING (app_actor_scope() = 'agency');
CREATE POLICY template_adoptions_operator_select ON template_adoptions FOR SELECT TO sbos_operator USING (true);
GRANT SELECT, INSERT, UPDATE ON template_adoptions TO sbos_app;

-- Promotion requests: the source tenant sees and withdraws its own; reviewers in agency scope see and decide all.
ALTER TABLE knowledge_promotion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_promotion_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_promotion_requests_tenant ON knowledge_promotion_requests FOR ALL TO sbos_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY knowledge_promotion_requests_reviewer ON knowledge_promotion_requests FOR ALL TO sbos_app
  USING (app_actor_scope() = 'agency' AND app_has_any_role(ARRAY['agency_reviewer', 'superadmin']))
  WITH CHECK (app_actor_scope() = 'agency' AND app_has_any_role(ARRAY['agency_reviewer', 'superadmin']));
CREATE POLICY knowledge_promotion_requests_operator_select ON knowledge_promotion_requests FOR SELECT TO sbos_operator USING (true);
GRANT SELECT, INSERT, UPDATE ON knowledge_promotion_requests TO sbos_app;

ALTER TABLE knowledge_promotion_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_promotion_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_promotion_reviews_reviewer ON knowledge_promotion_reviews FOR ALL TO sbos_app
  USING (app_actor_scope() = 'agency' AND app_has_any_role(ARRAY['agency_reviewer', 'superadmin']))
  WITH CHECK (app_actor_scope() = 'agency' AND app_has_any_role(ARRAY['agency_reviewer', 'superadmin']) AND reviewer_actor_type <> 'agent');
CREATE POLICY knowledge_promotion_reviews_tenant_select ON knowledge_promotion_reviews FOR SELECT TO sbos_app
  USING (EXISTS (SELECT 1 FROM knowledge_promotion_requests r WHERE r.id = request_id AND r.tenant_id = app_tenant_id()));
CREATE POLICY knowledge_promotion_reviews_operator_select ON knowledge_promotion_reviews FOR SELECT TO sbos_operator USING (true);
GRANT SELECT, INSERT ON knowledge_promotion_reviews TO sbos_app;

-- Operator (Mission Control metadata role): which versions are installed where, never content or parameters.
GRANT SELECT (id, folder, path, title, kind, state, current_version_id, owner_actor_id, classification, origin, license, review_due_at, promotion_request_id, related_skill_keys, created_at, updated_at) ON agency_knowledge_records TO sbos_operator;
GRANT SELECT (id, record_id, version, changelog, checksum, evidence_link, created_by_actor_type, created_by_actor_id, created_at) ON agency_knowledge_versions TO sbos_operator;
GRANT SELECT (id, record_id, from_state, to_state, actor_type, actor_id, roles, note, created_at) ON agency_knowledge_transitions TO sbos_operator;
GRANT SELECT (id, key, record_id, name, description, target_folder, active, created_at, updated_at) ON methodology_templates TO sbos_operator;
GRANT SELECT (id, tenant_id, template_id, record_version_id, version, state, previous_adoption_id, adopted_by_actor_id, adopted_at, ended_at) ON template_adoptions TO sbos_operator;
GRANT SELECT (id, tenant_id, nominated_by_actor_type, nominated_by_actor_id, run_id, classification, confidentiality, identifiability_risk, consent_status, owner_role, reviewer_role, state, reviewer_actor_id, decided_at, published_record_id, created_at, updated_at) ON knowledge_promotion_requests TO sbos_operator;
GRANT SELECT (id, request_id, reviewer_actor_type, reviewer_actor_id, roles, decision, rights_check, security_check, identifiability_check, created_at) ON knowledge_promotion_reviews TO sbos_operator;
GRANT SELECT (id, record_id, name, last_result, last_run_at, last_version_id, created_at) ON evaluation_cases TO sbos_operator;
GRANT SELECT (id, record_id, version_id, kind, reason, affected_adoptions, actor_type, actor_id, created_at) ON knowledge_deprecation_events TO sbos_operator;
