# Autonomy Acceptance Test report

Date: 2026-11-09. Environment: local sandbox, PostgreSQL 16.15, worker started as its own process (`apps/worker`, `tsx src/main.ts`), mode `simulated` (no `ANTHROPIC_API_KEY` in the sandbox). Script: `apps/worker/src/cli/autonomy-check.ts`. Database: scratch database reset, migrated (0001 to 0003) and seeded before the run.

| Step | Requirement (docs/agent-runtime.md section 9) | Result | Evidence |
|---|---|---|---|
| 1 | Agent scheduled through the platform | PASS | schedule row created in agency-tenant context (every minute, Northline Events) |
| 2 | Application stores task and schedule | PASS | row readable by operator role, `enabled = true` |
| 3 | Claude Code closed / no developer session | PASS (by construction) | the script only writes rows and polls; the worker process executes. In the sandbox Claude Code itself ran the script, so the formal "close Claude Code" step is an operations checklist item for the first Railway deploy |
| 4 | Task starts independently on the backend | PASS | run created by the worker's pg-boss cron tick, `trigger = schedule`, within 60 s of reconciliation |
| 5 | Agent retrieves authorised client information | PASS | run event: "read 4 departments, 4 systems, 0 prior questions" under the agent's tenant context |
| 6 | Agent performs its task | PASS | 5 `QuestionRequest`s drafted (contract-validated), 0 visible from tenant B, `simulated = true`, cost 0 |
| 7 | Results saved in the correct client's Knowledge Vault | PASS | `13_interviews_and_open_questions/round-001.md` v1 in tenant A, nothing in tenant B |
| 8 | Mission Control displays execution history | PASS | 21 run events readable by the operator role (content payloads masked); client admin approved, run resumed, questions published, approved action executed |
| 9 | Failed executions logged and handled safely | PASS | tenant B cap set to 0: run `failed` with `budget_exceeded`, incident `budget_exceeded/high`, no model call |
| 9b | Stall alarm | PASS | schedule window passed without run: `missed_schedule` incident raised |
| 10 | System keeps operating without a developer session | PASS | `/healthz` ok after the whole sequence; 4 notifications queued (2 e-mail approval requests, 1 Pumble, 2 e-mail published) and logged because no Resend/Pumble credentials are configured locally |

Score: 11/11 checks passed (two runs earlier in the session exposed two defects that were fixed: pg-boss rejects `undefined` option values; operator role lacked `SELECT` on `notifications`).

## Not covered in this run
- Real model call (no API key in the sandbox). The Mastra adapter is typechecked, not executed. First live run must be done on staging with the USD 25 cap in place.
- Worker restart mid-run (recovery path) was unit-level only: `recoverExpiredLeases()` runs at startup and in the stall check; an induced kill test is part of the staging checklist.
- Actual e-mail and Pumble delivery (credentials absent). The sender code paths for Resend and the Pumble webhook are implemented but unexercised.
- The formal "Claude Code completely closed" observation: to be recorded with timestamps on the first Railway staging deploy (M1-16 open item: Docker daemon unavailable in the sandbox, images not built).

## Second run from a clean database (same day)

Database reset, migrated, seeded and bootstrapped (`pnpm bootstrap-admin`), worker and production web build started as separate processes. Result: 11/11 again. Browser verification with Playwright afterwards: sign in as the bootstrapped superadmin, Mission Control refused with `mfa_required`, TOTP enrolled on `/account/security` (secret read from the displayed otpauth URI, code computed locally), Mission Control overview, agents, runs, run detail, approvals, costs, errors and schedules all rendered (HTTP 200) with the data produced by the worker; a fresh session was sent to `/two-factor` and admitted after a valid code; a superadmin without a content grant received HTTP 403 on a client workspace. One defect found and fixed during this pass: the sign-in form navigated to the target page before the two-factor redirect, which produced a redirect loop for TOTP users.

## Third run, extended with the Vault MVP flow (same day, after Milestone 2 services)

Clean database, migrations 0001 to 0005, worker as its own process. 14/14 checks passed. New steps:

| Step | Requirement (spec 4G) | Result | Evidence |
|---|---|---|---|
| 11 | Employee answers a published question; answer stored as provisional knowledge with source | PASS | `vault_facts` row `unconfirmed` with one interview source, created from the department manager's answer |
| 12 | An agent discovers a contradiction and asks for verification | PASS | round 2 run read 5 prior questions, 1 answer and 1 fact (retrieval audited); the answer negating QuickBooks Online versus the systems register produced one `fact_verification_requests` row and a `help_request` run event; the fact moved to `hypothesis`, not to a verdict |
| 13 | A reviewer promotes the fact; another agent retrieves it with its source; tenant B cannot see it | PASS | client admin decision set `verified` (database trigger enforces the reviewer role); a second agent identity read the fact with its source id; tenant B query returned nothing |

Covered separately by `packages/core/test/knowledge.test.ts`: forbidden documents (other tenant, or `restricted` classification for non-reviewers) are not returned by search; revision history reverts as a new revision; agent writes follow the tenant write-mode policy (draft or proposal).

## Fourth run: spec 11 demo flow (same day, after Milestone 3 services and flows)

Database `sbos_m1` migrated (0001 to 0006) and seeded; worker as its own process in simulated mode (no API key). Script: `apps/worker/src/cli/demo-flow-check.ts`, run through `pnpm demo:check`. The script only writes rows the way the UI would (answers as CEO, approval decisions as CEO) and polls; every agent step is executed by the worker through pg-boss. 9/9 checks passed.

| Step | Requirement (spec 11) | Result | Evidence |
|---|---|---|---|
| 1 | CEO answers the intake questions; departments and applications known | PASS | 5 intake questions answered as client_admin, 4 departments and 4 systems in the register |
| 2 | Finance and Operations agents produce findings and follow-up questions | PASS | `finance-agent` and `operations-agent` runs: findings with `claim_type` and source ids, 2 follow-up questions each as drafts |
| 3 | Follow-up questions published after CEO approval | PASS | approvals decided as CEO; runs resumed and published the questions to the inbox |
| 4 | Agent delivers pain point (AS-IS), proposed workflow (TO-BE) and an opportunity | PASS | `process-redesign` run stored the process with AS-IS and TO-BE steps (intervention labels) and an opportunity with a labelled business case and an open approval |
| 5 | CEO approves; risky change blocked before approval; owner receives a task with a verification schedule | PASS | activating the opportunity before the decision failed at the database trigger; after approval `activateActionTask` created the task and a verification schedule for `performance-agent` |
| 6 | Verification does not assume completion | PASS | `action-verification` run set the task to `verifying` and drafted a question for the owner awaiting publication |
| 7 | KPI registry with sources; external KPIs show missing data; dashboard spec validated | PASS | `ceo-intelligence` run defined KPIs with formula, source system and field; observations for unconnected systems carry `status = missing_data` and `value = null`; `DashboardSpecification` validated and versioned |
| 8 | Executive briefing with eight sections and 5 to 7 priorities; vault holds the artefacts | PASS | `executive-briefing` run; vault documents for processes, findings, KPI registry and briefing in the standard folders |
| 9 | Tenant isolation | PASS | tenant B context sees none of tenant A's findings, opportunities, KPIs, briefings or action tasks |

Not covered: real model calls (simulated fixtures), semantic search (deferred, ADR-019), the client UI for dashboard, X-Ray and action center (built after this run and verified separately in the browser).

## Fifth run: spec 11 demo flow with the Agency Vault nomination (same day, after Milestone 4 services)

Fresh database `sbos_m4flow` (migrations 0001 to 0007, seed with skill `process-redesign` 0.2.0), worker as its own process in simulated mode. `pnpm autonomy:check` 14/14, then `pnpm demo:check` 10/10. New step:

| Step | Requirement (spec 4H) | Result | Evidence |
|---|---|---|---|
| 10 | An agent may nominate a reusable insight from a client scenario; it is never published without a reviewer and a rights check | PASS | the process-redesign run wrote one `knowledge_promotion_requests` row in tenant A (`nominated`, identifiability risk low); zero agency records with origin `abstracted_from_client`; tenant B sees no request |

Spec 4H acceptance criteria 1 to 6 are covered by `packages/core/test/agency-knowledge.test.ts` (5 tests against Postgres with RLS, see `docs/milestones/M4.md`).
