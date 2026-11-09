-- Migration 0005: Knowledge Vault (Milestone 2). Answers, sources, evidence, facts with verification
-- lifecycle, links, verification requests, change proposals, retrieval audit, tenant policies, full-text search.

CREATE TYPE consent_status AS ENUM ('not_required', 'pending', 'granted', 'revoked');
CREATE TYPE evidence_kind AS ENUM ('document', 'system_record', 'interview_answer', 'screenshot', 'metric', 'observation');
CREATE TYPE verification_request_state AS ENUM ('open', 'verified', 'rejected', 'merged');
CREATE TYPE proposal_state AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE retrieval_kind AS ENUM ('fts', 'facts', 'document', 'agent_context');

-- Role helper: does the current request context carry any of the given roles? --------------
CREATE OR REPLACE FUNCTION app_has_any_role(required text[]) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(string_to_array(NULLIF(current_setting('app.roles', true), ''), ',') && required, false)
$$;

-- Sources: where a piece of knowledge came from ----------------------------------------------
CREATE TABLE sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  system text NOT NULL,                              -- interview, document, rentman, quickbooks, ...
  locator text,                                      -- record id, path, URL; may be sensitive
  retrieved_at timestamptz,
  checksum text,
  classification classification NOT NULL DEFAULT 'confidential',
  consent consent_status NOT NULL DEFAULT 'not_required',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_actor_type actor_type NOT NULL,
  created_by_actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sources_tenant_idx ON sources (tenant_id, system);

CREATE TABLE answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  answer_value jsonb NOT NULL,                       -- string | number | boolean | string[]
  answer_text text NOT NULL,                         -- normalised text for display and search
  answered_by_actor_type actor_type NOT NULL,
  answered_by_actor_id text NOT NULL,
  answered_by_role text NOT NULL,
  answered_at timestamptz NOT NULL DEFAULT now(),
  source_id uuid REFERENCES sources(id) ON DELETE SET NULL,
  fact_id uuid,                                      -- FK added after vault_facts exists
  verification verification_status NOT NULL DEFAULT 'unconfirmed',
  notes text,
  supersedes_answer_id uuid REFERENCES answers(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX answers_tenant_question_idx ON answers (tenant_id, question_id);

CREATE TABLE evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind evidence_kind NOT NULL,
  summary text NOT NULL,
  source_id uuid REFERENCES sources(id) ON DELETE SET NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  classification classification NOT NULL DEFAULT 'confidential',
  verification verification_status NOT NULL DEFAULT 'unconfirmed',
  checksum text,
  related_entity_type text,
  related_entity_id uuid,
  created_by_actor_type actor_type NOT NULL,
  created_by_actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_tenant_idx ON evidence (tenant_id, kind);

-- Facts: atomic statements with provenance and an epistemic status --------------------------
CREATE TABLE vault_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  statement text NOT NULL,
  subject_type text,                                 -- system, department, process, company, person_role
  subject_key text,                                  -- e.g. system name or department key, used for contradiction grouping
  source_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  origin_system text NOT NULL,                       -- interview, agent, document, connector:<name>
  observed_at timestamptz NOT NULL DEFAULT now(),
  responsible_role text,
  verification verification_status NOT NULL DEFAULT 'unconfirmed',
  confidence numeric(3,2) NOT NULL DEFAULT 0.50,
  classification classification NOT NULL DEFAULT 'confidential',
  version integer NOT NULL DEFAULT 1,
  access_policy text[] NOT NULL DEFAULT '{}'::text[],
  superseded_by uuid REFERENCES vault_facts(id) ON DELETE SET NULL,
  contradicts uuid[] NOT NULL DEFAULT '{}'::uuid[],
  created_by_actor_type actor_type NOT NULL,
  created_by_actor_id text NOT NULL,
  updated_by_actor_id text NOT NULL,
  search tsvector GENERATED ALWAYS AS (to_tsvector('english', statement)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vault_facts_tenant_idx ON vault_facts (tenant_id, verification);
CREATE INDEX vault_facts_subject_idx ON vault_facts (tenant_id, subject_type, subject_key);
CREATE INDEX vault_facts_search_idx ON vault_facts USING GIN (search);
CREATE TRIGGER vault_facts_updated_at BEFORE UPDATE ON vault_facts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE answers ADD CONSTRAINT answers_fact_fk FOREIGN KEY (fact_id) REFERENCES vault_facts(id) ON DELETE SET NULL;

-- Only reviewer roles may promote a fact to verified or approved_policy; agents may at most reach evidence_backed.
CREATE OR REPLACE FUNCTION enforce_fact_verification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.verification = OLD.verification THEN RETURN NEW; END IF;
  IF NEW.verification IN ('verified', 'approved_policy') AND NOT app_has_any_role(ARRAY['client_admin', 'agency_reviewer', 'superadmin']) THEN
    RAISE EXCEPTION 'promoting a fact to % requires a reviewer role', NEW.verification USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.verification = 'approved_policy' AND NOT app_has_any_role(ARRAY['client_admin']) THEN
    RAISE EXCEPTION 'approved_policy can only be set by the client admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF current_setting('app.actor_type', true) = 'agent' AND NEW.verification NOT IN ('unconfirmed', 'hypothesis', 'evidence_backed') THEN
    RAISE EXCEPTION 'agents cannot set verification %', NEW.verification USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vault_facts_verification BEFORE INSERT OR UPDATE OF verification ON vault_facts FOR EACH ROW EXECUTE FUNCTION enforce_fact_verification();

CREATE TABLE vault_fact_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  fact_id uuid NOT NULL REFERENCES vault_facts(id) ON DELETE CASCADE,
  version integer NOT NULL,
  statement text NOT NULL,
  verification verification_status NOT NULL,
  confidence numeric(3,2) NOT NULL,
  source_ids uuid[] NOT NULL,
  changed_by_actor_type actor_type NOT NULL,
  changed_by_actor_id text NOT NULL,
  change_note text,
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fact_id, version)
);

-- Links between documents ([[wikilinks]] and relative markdown links), resolved when possible ----
CREATE TABLE vault_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_document_id uuid NOT NULL REFERENCES vault_documents(id) ON DELETE CASCADE,
  to_path text NOT NULL,
  to_document_id uuid REFERENCES vault_documents(id) ON DELETE SET NULL,
  link_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_document_id, to_path)
);
CREATE INDEX vault_links_to_idx ON vault_links (tenant_id, to_document_id);

CREATE TABLE fact_verification_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  fact_id uuid NOT NULL REFERENCES vault_facts(id) ON DELETE CASCADE,
  conflicting_fact_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  raised_by_actor_type actor_type NOT NULL,
  raised_by_actor_id text NOT NULL,
  reason text NOT NULL,
  evidence_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  requested_reviewer_role text NOT NULL DEFAULT 'client_admin',
  state verification_request_state NOT NULL DEFAULT 'open',
  resolved_by_actor_id text,
  resolved_at timestamptz,
  resolution_note text,
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fvr_tenant_state_idx ON fact_verification_requests (tenant_id, state);
CREATE TRIGGER fvr_updated_at BEFORE UPDATE ON fact_verification_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE vault_change_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id uuid REFERENCES vault_documents(id) ON DELETE SET NULL,
  path text NOT NULL,
  title text NOT NULL,
  frontmatter jsonb NOT NULL DEFAULT '{}'::jsonb,
  body_markdown text NOT NULL,
  change_note text,
  proposed_by_actor_type actor_type NOT NULL,
  proposed_by_actor_id text NOT NULL,
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  state proposal_state NOT NULL DEFAULT 'pending',
  decided_by_actor_id text,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vcp_tenant_state_idx ON vault_change_proposals (tenant_id, state);

CREATE TABLE retrieval_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_type actor_type NOT NULL,
  actor_id text NOT NULL,
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  kind retrieval_kind NOT NULL,
  query text,
  result_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  result_count integer NOT NULL DEFAULT 0,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX retrieval_audit_tenant_idx ON retrieval_audit (tenant_id, occurred_at DESC);

CREATE TABLE tenant_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_by_actor_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

-- Full-text search on documents and a trigram index on titles ------------------------------
ALTER TABLE vault_documents ADD COLUMN search tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || body_markdown)) STORED;
CREATE INDEX vault_documents_search_idx ON vault_documents USING GIN (search);
CREATE INDEX vault_documents_title_trgm_idx ON vault_documents USING GIN (title gin_trgm_ops);

-- Row-Level Security ----------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sources','answers','evidence','vault_facts','vault_fact_revisions','vault_links','fact_verification_requests',
                           'vault_change_proposals','retrieval_audit','tenant_policies']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO sbos_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t || '_app', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO sbos_operator USING (true)', t || '_operator_select', t);
  END LOOP;
END $$;

-- Restricted documents and facts additionally require the client_admin, agency_reviewer or superadmin role.
CREATE POLICY vault_documents_restricted ON vault_documents AS RESTRICTIVE FOR SELECT TO sbos_app
  USING (classification <> 'restricted' OR app_has_any_role(ARRAY['client_admin', 'agency_reviewer', 'superadmin']));
CREATE POLICY vault_facts_restricted ON vault_facts AS RESTRICTIVE FOR SELECT TO sbos_app
  USING (classification <> 'restricted' OR app_has_any_role(ARRAY['client_admin', 'agency_reviewer', 'superadmin']));

-- Grants ------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON sources, answers, evidence, vault_facts, fact_verification_requests, vault_change_proposals, tenant_policies TO sbos_app;
GRANT SELECT, INSERT ON vault_fact_revisions, retrieval_audit TO sbos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON vault_links TO sbos_app;

-- Operator: metadata only.
GRANT SELECT (id, tenant_id, system, retrieved_at, checksum, classification, consent, created_at) ON sources TO sbos_operator;
GRANT SELECT (id, tenant_id, question_id, answered_by_role, answered_at, verification, fact_id, created_at) ON answers TO sbos_operator;
GRANT SELECT (id, tenant_id, kind, captured_at, classification, verification, created_at) ON evidence TO sbos_operator;
GRANT SELECT (id, tenant_id, subject_type, origin_system, observed_at, responsible_role, verification, confidence, classification, version, created_at, updated_at) ON vault_facts TO sbos_operator;
GRANT SELECT (id, tenant_id, fact_id, version, verification, confidence, changed_by_actor_type, changed_by_actor_id, run_id, created_at) ON vault_fact_revisions TO sbos_operator;
GRANT SELECT (id, tenant_id, from_document_id, to_document_id, created_at) ON vault_links TO sbos_operator;
GRANT SELECT (id, tenant_id, fact_id, raised_by_actor_type, raised_by_actor_id, requested_reviewer_role, state, resolved_by_actor_id, resolved_at, run_id, created_at) ON fact_verification_requests TO sbos_operator;
GRANT SELECT (id, tenant_id, document_id, path, proposed_by_actor_type, proposed_by_actor_id, run_id, state, decided_at, created_at) ON vault_change_proposals TO sbos_operator;
GRANT SELECT (id, tenant_id, actor_type, actor_id, run_id, kind, result_count, occurred_at) ON retrieval_audit TO sbos_operator;
GRANT SELECT ON tenant_policies TO sbos_operator;
