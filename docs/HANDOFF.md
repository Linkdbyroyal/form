# Handoff

Last updated: 2026-11-09 (Milestone 3 backend and flows delivered, client UI in progress; Milestone 2 delivery, branch `claude/second-brain-os-architecture-ovfky3`, pushed to GitHub).

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

## Milestone 2 client UI (M2-03, M2-05, M2-06, M2-07, M2-11), session 2026-11-09

Implemented in `apps/web` only (no changes to `packages/core` or `packages/db`); uncommitted at the time of writing.

- Interview Inbox answer flow: `app/c/[slug]/inbox/page.tsx` renders a form per open question by `answer_type` (text, number, boolean, single_choice, multi_choice, date; file and system_reference as text with a note), posts to `answerQuestionAction` which calls `answerQuestion` from `@sbos/core` inside `withContext`. Recipient role or client_admin may answer; others see the question read-only. Drafts are visible to client_admin only. Answered questions show the answer, role, time and the fact's verification badge.
- Vault browser `app/c/[slug]/vault/page.tsx`: 20 standard folders with counts (`VAULT_FOLDERS` in `lib/client/vault-helpers.ts`; names 04, 05, 06, 13 and 17 match existing paths, the other 15 labels follow the spec order and should be confirmed against the Masterprompt), document list per folder (`?folder=`), full-text search (`?q=`) through `searchVault` (retrieval audit written).
- Document page `app/c/[slug]/vault/[...path]/page.tsx`: frontmatter table, Markdown rendered with `marked` 15.0.12 plus `sanitize-html` 2.18.1 allow-list (script, event handlers, javascript: URLs stripped; wikilinks resolve to document routes), backlinks, outgoing links with resolved/dangling state, revision list with Compare (own LCS line diff) and Restore (calls `revertDocument`), Edit and Create forms (`writeVaultDocument` + `syncDocumentLinks`). client_employee reads only; a 404 shows the restricted-document hint.
- Review queue `app/c/[slug]/vault/review/page.tsx`: open verification requests with fact, contradicting facts, reason, raiser, evidence count; verified/rejected through `decideFactVerification` (UI gate client_admin, trigger enforces too). Pending change proposals with preview; approve/reject through `decideProposal` (client_admin, department_manager).
- Facts `app/c/[slug]/vault/facts/page.tsx`: list with verification filter; client_admin promotes to verified or marks deprecated through `setFactVerification`.
- Settings `app/c/[slug]/vault/settings/page.tsx`: `vault.agent_write_mode` default plus 20 folder overrides through `setTenantPolicy` (client_admin only).
- Mission Control `/mission-control/vaults` (`listVaultMetadata`, `getVaultMetadata` in `lib/mission-control/queries.ts`): per-tenant counts through operator-granted columns only; linked from the Overview implementation-status card.
- Tests: `apps/web/test/vault-ui.test.ts` (17 unit tests: folder tree, role rules, answer parsing per type, frontmatter, line diff, sanitiser, policy builder). `pnpm --filter @sbos/web typecheck` and `pnpm --filter @sbos/web test` (49 tests) green.
- Verified against a dev server on port 3300 and database `sbos_m2` (seeded; auth users `owner@secondbrain.test` superadmin, `ceo@northline.test` client_admin, `finance@northline.test` department_manager, `staff@northline.test` client_employee, password `Local-Dev-Only-Password-2026!`, dev only): all routes 200 for the three client roles; the no-JS form path exercised every action (answers per type, refusals for the wrong role, verification decision, proposal approval creating a revision, restore v1 as v5, edit as v6 with link re-indexing and script stripped, policy save, fact promotion).
- Open: the 15 folder labels without existing usage need owner confirmation; attachments for file answers (M5); fact detail page; proposal diff against the current document; agency reviewer grants (M4).


## Milestone 2 summary (2026-11-09)

Implemented and verified: Knowledge Vault schema (migration 0005) and services; Discovery round 2 with answers, facts and contradiction detection; client UI for inbox answers, vault browser, document view with sanitised Markdown, backlinks, revisions, compare and restore, review queue, facts, settings (write-mode policy); Obsidian-compatible export (`/c/[slug]/vault/export`) and import (`/c/[slug]/vault/import`); Mission Control `/mission-control/vaults` with counts only; break-glass access (M1-18). Acceptance: 14/14 steps of the extended acceptance script against the live worker; 120 automated tests across six packages; Playwright as client admin: vault browser, search, document, review, facts, inbox all render, export returns a zip with the tenant's documents.

Dev tooling added: `pnpm demo-users` (`SBOS_DEMO_TENANT`, `SBOS_DEMO_PASSWORD`) creates or resets three demo client users (admin, department manager, employee) with organisation memberships; refuses in production. The auth pool now falls back to `DATABASE_URL` only (not `DATABASE_URL_MIGRATE`), so auth and tenant data always live in the same database unless `DATABASE_URL_AUTH` is set explicitly.

Open after M2: semantic search with pgvector (M3), file attachments for answers (M5), fact detail page, proposal diff view, agency reviewer grants (M4), skip or delegate a question, graph view. CI: the workflow runs tests serially and the acceptance script; check the latest run on GitHub after each push.


## Milestone 3 backend and agent flows (2026-11-09)

Committed as `bc95b59` (migration 0006 and core services) and `0b0a2e7` (flow executor and six flows).

- Migration `0006_xray_kpis.sql`: `processes`, `process_steps`, `pain_points`, `findings`, `opportunities` (+ `enforce_opportunity_approval`), `kpis` (formula, source system and field required), `kpi_observations` (CHECK: value only when status `ok`), `dashboards`, `dashboard_widgets` (whitelist enum), `action_tasks` (+ `enforce_action_task_approval`), `briefings`, `connections`, `credentials_metadata` (secret reference only). RLS forced, operator metadata grants, Drizzle schema in `packages/db/src/schema/xray.ts`.
- `packages/core/src/xray.ts`: `defineKpi`, `observeKpi`, `latestObservations`, `createFinding`, `proposeOpportunity` (creates its approval), `setOpportunityState`, `createActionTask`, `activateActionTask` (schedules verification), `setActionTaskState`, `publishDashboard` (contract-validated, versioned), `currentDashboard`, `storeBriefing` (eight sections, 5 to 7 priorities), `upsertProcess`. 4 integration tests.
- Worker `apps/worker/src/executor.ts` is now a generic flow runner: load run, budget admission, `flowFor(definition.key)`, step loop with a checkpoint per step and suspend/resume on approval, finalize. Flows in `apps/worker/src/flows/`: discovery, department-review (Finance and Operations), process-redesign, ceo-intelligence, executive-briefing, action-verification; registry in `flows/index.ts`. Shared helpers: tenant snapshot with retrieval audit, question drafts with contract validation, publication approval, vault notes through the write-mode policy.
- `packages/agents`: prompt builder, draft schema and simulated fixture per flow (`department-review.ts`, `process-redesign.ts`, `ceo-intelligence.ts`, `executive-briefing.ts`, `action-verification.ts`); 5 tests.
- Seed: seven agent definitions read from `packages/db/seed-data/skills/<key>/SKILL.md`; full instance pool for `northline-events`, Discovery only for `harbour-view-hotel`; schedules disabled except Discovery.
- `pnpm demo:check` (`apps/worker/src/cli/demo-flow-check.ts`): nine checks of the spec 11 flow against the live worker, 9/9 locally, added to CI after the autonomy check (CI job `timeout-minutes: 20`).
- Semantic search (M3-11) deferred to M5: ADR-019.

Stale local processes: after changing worker code stop the old worker with `pkill -f "src/main.ts"`; an old process keeps consuming pg-boss jobs with old code.
