# Handoff

Last updated: 2026-11-09 (Milestone 1 delivery, branch `claude/second-brain-os-architecture-ovfky3`). Push to GitHub is blocked until the Claude GitHub App has write access to `Linkdbyroyal/form`; all work is committed locally.

## Implemented and verified

| Area | What | Evidence |
|---|---|---|
| Tenancy foundation (M0) | Migration 0001, RLS forced on all tenant tables, roles `sbos_app`/`sbos_operator`, append-only audit | `packages/db` 14 tests |
| Agent runtime schema (M1-03) | Migration 0002: skills, skill versions, agent definitions/instances, tasks, runs, run events, approvals, approved actions, schedules, incidents, budgets, cost events, feedback, notifications, access logs, interview rounds, questions, vault documents/revisions; run state machine trigger; approval gate trigger; operator column grants | core tests 6, generic cross-tenant guard over all tenant tables, operator content-column guard |
| Core services (M1) | `packages/core`: createRun/transitionRun/appendRunEvent/checkpoints, requestApproval/decideApproval/registerAction/markActionExecuted, raiseIncident, queueNotification (payload allow-list), checkBudget/recordCost/pricing, tasks, feedback, vault write with revisions, `JobBackend` | tests |
| Agent runtime (M1-04/05) | `packages/agents`: `AgentRuntime`, Mastra adapter on `@ai-sdk/anthropic`, `SimulatedRuntime`, `ToolGateway`, Discovery prompt with untrusted-content wrapping, contract validation of every question; SKILL.md `discovery-interview` 0.1.0 seeded as immutable version | 3 tests; Mastra path typechecked only |
| Autonomous worker (M1-06/07/14/17) | `apps/worker`: pg-boss queues with retries, backoff, dead-letter consumer; checkpointed executor (assemble, generate, persist, request approval, suspend, publish on approval); budget admission and pre-call cap; cron reconciliation from `schedules`; stall alarm; lease heartbeat and crash recovery; Resend and Pumble senders; `/healthz` | Autonomy Acceptance Test 11/11 (`docs/reports/autonomy-acceptance-2026-11-09.md`) |
| Authentication (M1-01/02/19) | Better Auth 1.7.18: email/password + verification, organizations mapped to tenants, Google/Microsoft optional, TOTP required for superadmin/agency_operator, invitation-only, membership bridge into `memberships`, bootstrap script, request context resolving from session, break-glass rule in `requireTenantContext` | 16 web tests; bootstrap verified; browser flow verified with Playwright: MFA gate, TOTP enrolment, two-factor sign-in, 403 without content grant |
| Break-glass (M1-18) | Operator requests content access per client in Mission Control (reason, 15 min to 8 h, fresh TOTP via `auth.api.verifyTOTP` plus replay guard `auth.break_glass_totp_replay`), grant + audit `break_glass.granted` + Pumble notice in one agency-scoped transaction, redirect to `/c/<slug>` with expiry badge, revoke by holder or superadmin (migration 0004 UPDATE policy), `knowledge_access_logs` row per request under a grant and `logContentAccess()` helper. `decideTenantAccess` now admits agency_operator with a grant | 16 tests in `apps/web/test/break-glass.test.ts` (validation, replay rule, real TOTP against an enrolled secret, grant/audit/notification rows, access log, revocation, expiry) |
| Deployment artefacts (M1-15/16) | Dockerfiles (web standalone, worker without dev tooling), `railway.json` per service, `docker-compose.prod.yml` with backup sidecar and Caddy, `docs/deployment.md` | Dockerfile steps executed with pnpm in a clean copy; no Docker daemon in sandbox |
| Contracts | 17 Zod contracts + JSON Schema | 35 tests |

## Simulated

- Model calls: without `ANTHROPIC_API_KEY` the worker runs `SimulatedRuntime` (deterministic fixture, labelled `simulated` on runs, events, cost events and vault notes). First live call must happen on staging under the USD 25 cap.
- Notification delivery: without `RESEND_API_KEY` / `PUMBLE_WEBHOOK_URL` the sender logs `[mail:dev]` / `[pumble:dev]` and marks the row `sent` with `delivery: "logged"`.

## Not connected

Rentman, QuickBooks, Trengo, Pumble (as data source), Dropbox, Make, Google Sheets. Systems register rows remain `claim_status = stated`.

## Mission Control modules (M1-08)

Implemented and verified against the live worker: Overview with real counters, Agents list, Agent Detail (assign task, feedback, pause/resume, run now, stop runs), Tasks with state filter, Runs & Traces with event timeline (payload masked), Approvals (operator decides agency-level approvals; client-level approvals link to the client workspace), Schedules (enable/disable), Costs (platform cap bar, per tenant, per agent, last 50 cost events), Errors & Incidents (acknowledge, resolve). Client workspace: Approvals list and detail with Approve/Reject, Interview Inbox (questions per round, answering planned for M2), Client Agent Center. Reads use the operator database role (content columns are not granted); writes run in an agency-scoped tenant transaction with an audit row per action. Placeholders remain only for Agent Skills & Versions, Connected Tools and Agency Intelligence Vault (M4/M5). Known gap: stopping a run cancels the database run but not the queued pg-boss job (the worker skips terminal runs).

## Open (M1)

- M1-10 isolation tests: generic read guard exists; add per-table write attempts for the new tables.
- M1-11 CI: workflow exists, never executed (push blocked).
- First Railway staging deploy; formal "Claude Code closed" observation with timestamps; induced worker kill test.
- Mastra adapter live verification; shadcn/Recharts components (M3).
- `apps/web/lib/queries.ts` still exports `getTenantDetail` and an `authStatus` string that are no longer used.

## Tests run (this session)

| Package | Tests |
|---|---|
| contracts | 35 |
| db | 14 |
| core | 6 |
| agents | 3 |
| web | 32 (auth 16, break-glass 16) |
| worker | Autonomy Acceptance Test 11/11 against a live worker (twice, second time from a clean database) |
| browser | Playwright: sign-in, MFA gate, TOTP enrolment, two-factor sign-in, 8 Mission Control pages, 403 on client workspace without grant |

## Known risks

- Mastra 1.82 and `ai` 7.0 differ in one LanguageModelV4 type detail; the adapter casts. Verify on first live run.
- pgvector not installed in the sandbox Postgres (needed from M2; the Docker image covers it).
- Legacy intake form has a hard-coded admin token fallback; not deployed.

## How to resume

```
pnpm install
pnpm db:migrate && pnpm db:seed
SBOS_ADMIN_EMAIL=... SBOS_ADMIN_PASSWORD=... pnpm bootstrap-admin
pnpm --filter @sbos/web dev      # :3000
pnpm worker:dev                  # :8080/healthz
pnpm autonomy:check              # 11 checks
```
