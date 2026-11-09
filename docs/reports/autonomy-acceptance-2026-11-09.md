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
