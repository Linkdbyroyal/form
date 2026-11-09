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

## Legacy note
`legacy/lbr-intake/server.js` contains a hard-coded admin token fallback. It is not deployed from this repository and must be fixed before any reuse (ADR-010).
