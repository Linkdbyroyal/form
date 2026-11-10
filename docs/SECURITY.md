# Security and Tenant Governance

## Principles
1. Default deny. Access exists only through a membership, a content grant or a tenant-scoped agent instance.
2. Isolation at the database (RLS), object storage (per-tenant prefix, signed URLs), search index (per-tenant partition), logs (tenant tag + masking) and jobs (tenant in payload, context per transaction).
3. No secrets in prompts, logs, frontend or repository. Connector credentials encrypted at rest; only metadata (`credentials_metadata`) is queryable.
4. Untrusted input: documents, e-mails, web pages and connector payloads are data, never instructions. They are wrapped with provenance before entering a prompt; tool authorisation happens server-side regardless of model output.
5. Human authority: payments, bank data, hiring/firing, legal commitments and binding customer communication are outside any agent's authority. Risky actions are blocked by database constraints until an approval exists.
6. Audit everything: append-only `audit_events`, `run_events`, `knowledge_access_logs`, `retrieval_audit`.
7. Silence is not success: missed schedules raise incidents.
8. Runtime independence: agents run only in the backend worker with server-side API keys; no production path depends on a developer session, Claude Code hook or personal machine (ADR-012).

## Roles
| Role | Scope | Can |
|---|---|---|
| superadmin | agency | manage tenants, roles, policies, budgets; cross-client operational metadata; approve break-glass; MFA mandatory |
| agency_operator | agency | Mission Control metadata for all clients; content only via break-glass grant; MFA mandatory |
| agency_consultant | agency + assigned tenants | content of assigned tenants via grant (later milestone) |
| agency_reviewer | agency | review knowledge promotions and skill releases (M4) |
| client_admin | tenant | CEO: all tenant content, approvals, delegations, invites |
| department_manager | tenant + department | department content, answer questions, propose actions |
| agent_service | tenant + agent instance | non-interactive service identity for one agent instance; tools authorised per skill version |
| client_employee | tenant + department | answer assigned questions, view assigned tasks |
| client_auditor | tenant | read-only including audit trails |

## Break-glass (ADR-017)
Operator requests content access to one tenant with a reason → fresh MFA verification → `client_content_grants` row (max 8 h) → audit event + Pumble notice → every content read logged in `knowledge_access_logs` → automatic expiry, revocable by superadmin.

## Budget and model access (ADR-016)
`ANTHROPIC_API_KEY` only in the worker. Caps per platform, tenant and agent instance; hard stop creates an incident. Costs recorded per call.

## Policy register (to be filled per tenant)
Data minimisation, consent per system, retention and deletion schedule, audit log retention, incident procedure, regional/privacy requirements (Curaçao, NL/EU where applicable), sub-processor list (Anthropic, hosting).

## Required tests (run in CI from M0 onward)
- Every table with `tenant_id` has RLS enabled and forced (schema scan).
- Tenant A cannot read or write tenant B rows through the app role.
- Operator role cannot read content columns.
- Audit table rejects UPDATE/DELETE from the app role.
- From M1: approval constraint blocks execution without approval; worker job with wrong tenant payload cannot cross; prompt-injection fixtures do not produce unauthorised tool calls; expired credential produces an incident, not a silent skip.

## Security evaluation suite (M6-08, implemented)

`packages/core/test/security-eval.test.ts` runs in CI against Postgres with RLS and fails the build when any boundary weakens:

1. Prompt injection in an answer and in a document is stored verbatim, returned to agents as data inside `<untrusted>` wrappers, and produces no approval decision, no agency record and no membership.
2. Wrong tenant scope: an agent of tenant A cannot search, read or write tenant B through the service (refused) or through SQL (RLS returns nothing, inserts fail).
3. Expired credential references are reported; a live sync with one refuses to run and raises an incident; token-looking values are refused by the CHECK on `secret_ref`.
4. Agent escalation: an agent service identity cannot decide approvals (trigger), raise budgets, create or enable schedules, change memberships, grants or tenants (restrictive policies, zero rows), write to the agency vault or technology intelligence tables (RLS), or delete audit-class rows (restrictive DELETE policy; `audit_events` has no DELETE grant at all).

Complementary guards: `enforce_connection_phase` (phases, consent, no agent changes, write refused), `enforce_knowledge_transition` and `enforce_promotion_transition` (agency vault), `enforce_upgrade_transition` (no automatic upgrades), `enforce_fact_verification` (agents capped at evidence_backed), the ToolGateway (intersection of definition and pinned skill tools).

## External review checklist (M6-09)

For an independent reviewer before the pilot. Each item names where to look.

| Area | What to verify | Where |
|---|---|---|
| Tenant isolation | Every tenant table has RLS enabled and forced; the app role is not the owner; policies compare `tenant_id` with `app_tenant_id()`; nullable-tenant tables allow NULL rows in agency scope only | `packages/db/migrations/0001` to `0010`, `packages/db/test/isolation.test.ts` (schema guard, generic cross-tenant read guard) |
| Operator role | `sbos_operator` has column-level SELECT only on metadata columns; content columns (`body_markdown`, `payload`, `instruction`, `checkpoint`, `result`, `question_text`, `parameters`, `proposed_generic_statement`, `config`, `error_message`) are not granted | `isolation.test.ts` "operator role cannot read any designated content column"; grants in each migration |
| Break-glass | Content access for operators only through a time-limited grant with a fresh TOTP; every read logged | `apps/web/lib/break-glass*.ts`, `apps/web/test/break-glass.test.ts`, `knowledge_access_logs` |
| Secrets | No secret value in the database, logs, prompts or the web app: `credentials_metadata.secret_ref` and `webhook_endpoints.secret_ref` are `env:NAME` references resolved only in the worker; `maskSecrets` and the CHECK on `sync_runs.error_message` | `packages/connectors/src/secrets.ts`, `packages/core/src/integrations.ts`, migration 0008; grep a staging database dump and the worker log for a known test token |
| Model access | `ANTHROPIC_API_KEY` only in the worker service; budget admission before every run and model call; cost events per call | `apps/worker/src/env.ts`, `packages/core/src/budgets.ts`, ADR-016 |
| Approvals | Database triggers block execution without approval, agent decisions, deciders without the approver role and self-approval | `enforce_action_approval`, `enforce_opportunity_approval`, `enforce_action_task_approval`, `enforce_approval_decision` (migration 0010) |
| Agency vault | Tenant scope sees no agency table; promotion needs a human review with rights, security and identifiability checks; published records carry no tenant identifiers | migration 0007, `packages/core/test/agency-knowledge.test.ts` |
| Integrations | Phases one step at a time, consent by a client admin user, security review before read-only, write phase refused; metadata phase makes no network call | migration 0008, `packages/connectors/test/integrations.test.ts`, demo flow step 11 |
| Upgrades | No automatic production upgrade: code needs a pull request merged by a human, skills an immutable version with a test result, knowledge a published record; rollback keeps the previous version | migration 0009, `packages/core/test/governance.test.ts` |
| Retention and deletion | Floors per data class; tenant contexts cannot delete; deletion requests decided by a reviewer and executed by the worker with an audit event; audit events never deleted | migration 0009, `packages/core/src/retention.ts` |
| Authentication | Better Auth with email verification, invitation-only sign-up, TOTP required for superadmin and agency operators, organisation membership mirrored into `memberships` by the bridge | `apps/web/lib/auth*.ts`, `apps/web/test/auth.test.ts` |
| Supply chain | Pinned dependencies; upgrades only through the Upgrade Center; no `@mastra/core/*/ee` imports | `package.json` files, `pnpm-lock.yaml`, CLAUDE.md |
| Legacy | `legacy/lbr-intake` is not deployed and keeps a hard-coded admin token fallback until removed | ADR-010 |

## Pilot go-live checklist (M6-09)

Prerequisites outside this repository: Railway project with `web`, `worker` and `postgres` services (pgvector image), a dedicated Anthropic API key for the worker, Resend and Pumble credentials, the owner decisions listed in `docs/milestones/M5.md`.

1. Staging deploy from this branch; run `pnpm db:migrate` and `pnpm db:seed` against the staging database; `pnpm bootstrap-admin` for the owner; enrol TOTP.
2. Set `ANTHROPIC_API_KEY` on the worker only; confirm `/healthz` reports `mode: live`; run `pnpm autonomy:check` and `pnpm demo:check` against staging; record the first live model call, its cost event and the platform cap state in `docs/reports/`.
3. The formal "Claude Code closed" observation: no developer session for at least 24 hours while the Discovery schedule fires; record timestamps of runs, notifications and incidents.
4. Induced worker kill during a run; confirm lease recovery re-queues from the checkpoint.
5. Real notification delivery: one approval request by e-mail (Resend) and one Pumble update; confirm `sent` state and that the messages carry identifiers and links only.
6. First connector in read-only phase (owner decision 1 and 2): consent recorded by the client admin in the Integration Center, security review recorded, phase advanced, one scheduled sync with lineage, stale state after a paused sync.
7. External review of the checklist above by someone who did not build the system; findings tracked as incidents or backlog items.
8. Retention policy confirmed per tenant with the client; deletion runbook (subject data, tenant off-boarding) agreed in writing.
9. Go-live only when the security evaluation suite, the acceptance scripts and the external review are green and the pilot client's written consent for the read-only phase exists.

## Legacy note
`legacy/lbr-intake/server.js` contains a hard-coded admin token fallback. It is not deployed from this repository and must be fixed before any reuse (ADR-010).
