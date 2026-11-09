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
| agency_superadmin | agency | manage tenants, roles, policies; cross-client operational metadata; grant content access (logged) |
| agency_operator | agency | Mission Control metadata for all clients; content only with a grant |
| agency_consultant | agency + assigned tenants | content of assigned tenants via grant |
| agency_reviewer | agency | review knowledge promotions and skill releases |
| client_ceo | tenant | all tenant content, approvals, delegations |
| client_manager | tenant + department | department content, answer questions, propose actions |
| client_employee | tenant + department | answer assigned questions, view assigned tasks |
| client_auditor | tenant | read-only including audit trails |

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
