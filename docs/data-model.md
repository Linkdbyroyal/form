# Data Model

Conventions: UUID v7 primary keys (`id`), `tenant_id uuid` on every tenant-scoped table (NULL only on agency-scope rows where stated), `created_at`/`updated_at timestamptz`, soft delete only where retention requires (`deleted_at`). All tenant-scoped tables have RLS (ADR-002). Enum values live in Postgres enums so invalid states fail at the database.

Migration status: **0001 implemented (M0)**; the rest are designed and listed per milestone.

## Migration 0001 (M0, implemented)

| Table | Purpose | Key columns |
|---|---|---|
| `tenants` | one row per client company and one `kind = 'agency'` row for Second Brain itself | `slug`, `name`, `kind` (client, agency, demo), `status`, `settings jsonb`, `locale` |
| `users` | global identities (auth provider maps here) | `email` unique, `display_name`, `status` |
| `roles` | role catalogue (global, not tenant-scoped) | `key` (`agency_superadmin`, `agency_operator`, `agency_consultant`, `agency_reviewer`, `client_ceo`, `client_manager`, `client_employee`, `client_auditor`), `scope` (agency, client), `description` |
| `memberships` | user × tenant × role | unique `(tenant_id, user_id, role_key)` |
| `client_content_grants` | explicit, time-boxed permission for an agency user to see a client's content | `tenant_id`, `user_id`, `granted_by`, `reason`, `expires_at` |
| `audit_events` | append-only audit trail | `tenant_id` nullable (agency events), `actor_type`, `actor_id`, `action`, `entity_type`, `entity_id`, `before_hash`, `after_hash`, `metadata jsonb`, `occurred_at` |
| `departments` | tenant org map | `tenant_id`, `key`, `name`, `head_role`, `parent_id` |
| `systems` | software register (what the client says they use) | `tenant_id`, `name`, `vendor`, `function`, `department_id`, `administrator_role`, `is_source_of_truth_for text[]`, `data_types text[]`, `api_capabilities` (api, mcp, webhook, export, none), `claim_status` (`stated`, `verified_exists`, `connected`) |

RLS summary: `tenants` readable by members and agency roles; all other tenant tables filtered by `app.tenant_id`; `audit_events` INSERT-only for app role.

## Migration 0002 (M1): agents and runs

`agent_definitions` (agency templates), `agent_instances` (tenant activation, pinned `skill_version_id`, `budget_id`, `state`), `skills`, `skill_versions` (immutable `skill_md`, `contracts text[]`, `allowed_tools text[]`, `release_channel`), `skill_release_channels`, `agent_tasks`, `agent_runs`, `run_events`, `agent_run_traces` (large payload refs, masked), `agent_task_threads`, `agent_feedback`, `approvals`, `decisions`, `schedules`, `incidents`, `budgets`, `cost_events`, `policies` (autonomy tiers per action type).

### State machines

**AgentTask**: `draft → open → assigned → in_progress → waiting (input|approval) → done | cancelled | failed`. `in_progress` requires an `agent_runs` row in `running`.

**AgentRun**: `queued → running → (waiting_for_input | waiting_for_approval | paused) → running → succeeded | failed | cancelled | timed_out`. Terminal states are final (trigger blocks updates). Every transition writes `run_events.kind = 'state_change'`. `failed` with `retryable = true` and attempts < max re-queues; otherwise dead-letter + incident.

**Approval**: `pending → approved | rejected | expired | withdrawn`. Subjects reference `(subject_type, subject_id)`; the subject table carries `approval_id` and a CHECK that `executed_at IS NULL OR approval_id IS NOT NULL`, plus a trigger verifying the approval is `approved` before `executed_at` can be set.

**Schedule**: `active | paused | disabled`; each tick records `last_run_at`, `expected_by`; the stall-alarm job compares `expected_by < now()` without a run → incident.

## Migration 0003 (M2): discovery and vault

`interviews`, `interview_rounds`, `questions`, `answers`, `sources`, `evidence`, `vault_documents`, `vault_revisions`, `vault_links`, `vault_facts`, `vault_change_proposals`, `fact_verification_requests`, `knowledge_sources`, `knowledge_embeddings` (pgvector, partition per tenant; agency partition is a separate table `agency_knowledge_embeddings`), `retrieval_audit`, `knowledge_access_logs`, `attachments` (object key, checksum, immutable).

**Fact verification**: `unconfirmed → hypothesis | evidence_backed → verified → approved_policy`; `deprecated` from any state; promotion to `verified` requires a reviewer membership and writes `audit_events`.

## Migration 0004 (M3): processes, findings, KPIs, dashboards

`processes`, `process_steps`, `pain_points`, `findings`, `opportunities`, `kpis`, `kpi_observations`, `dashboards`, `dashboard_widgets`, `tasks` (management action center), `briefings`, `connections`, `credentials_metadata`.

## Migration 0007 (M4, delivered): agency intelligence vault

`agency_knowledge_records` (no tenant_id, agency scope only), `agency_knowledge_versions` (immutable), `agency_knowledge_transitions` (actor, roles, note per state change), `methodology_templates` (parameters as `{{key}}` placeholders, target client folder), `template_adoptions` (tenant row, pinned `record_version_id`, parameters, state active/superseded/rolled_back/revoked, link to the client `vault_documents` copy), `knowledge_promotion_requests` (tenant row; reviewers read all in agency scope), `knowledge_promotion_reviews`, `evaluation_cases`, `knowledge_deprecation_events` (release, deprecate, rollback, reinstate, archive, consent_review with affected adoption count). Actual migration numbers differ from the early plan: 0004 break-glass, 0005 vault, 0006 X-Ray and KPIs, 0007 agency vault.

**Knowledge record lifecycle**: `draft → in_review → approved → published → deprecated → archived`, reviewer recorded on every transition (trigger), no self-approval except superadmin, no agent approvals. **Promotion lifecycle**: `nominated → in_review → approved → published` (or rejected, withdrawn); approval requires a human review with rights, security and identifiability checks and consent `granted` or `not_required`.

## Migrations 0008 and 0009 (M5, M6, delivered): integrations, technology intelligence, retention

0008: `connection_phase_changes`, `sync_runs`, `webhook_endpoints`, lineage column on `kpi_observations`, phase trigger on `connections` (one step at a time, consent and security review before read_only, write refused). 0009: `tech_sources`, `tech_updates` (UpgradeProposal fields, lifecycle trigger), `tech_update_transitions`, `tech_watch_runs`, `retention_policies` (platform default and tenant override, floors), `retention_sweeps`, `deletion_requests` (reviewer decision, worker execution), restrictive DELETE policies on audit-class tables, operator UPDATE on notification delivery columns.

## Identity columns on every relevant action (spec 6B)

`workspace_id` is `tenant_id`; actions carry `tenant_id`, `user_id` or `agent_id`, `run_id`, `source_id` where applicable. These are present in `audit_events.metadata` and in `run_events` as columns.
