# Handoff

Last updated: 2026-11-10 (Milestone 5 sandbox part delivered; Milestone 4 delivered; Milestone 3 delivered; Milestone 2 delivery, branch `claude/second-brain-os-architecture-ovfky3`, pushed to GitHub).

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

## Milestone 3 client UI and onboarding wizard (2026-11-09)

Implemented in `apps/web` only. Committed in two parts: `061f1f2` (work in progress) and the M3 UI commit that follows it. All UI text is English.

- Dashboard renderer `components/dashboard/`: `spec.ts` validates the stored `DashboardSpecification` with the contract and refuses anything else (error card, never a partial dashboard); `widgets.tsx` holds `WIDGET_RENDERERS`, a map with exactly the nine contract widget types (kpi_tile, trend_line, bar, table, action_list, briefing, risk_list, data_gap_list, text_note); `charts.tsx` is the only client code (shadcn-style wrappers on Recharts 3.10.1, pinned, `accessibilityLayer`, colours from the CSS tokens); `dashboard-renderer.tsx` sorts by priority and renders through the map. Every widget shows its `reason` as a footnote. States: Missing data, Stale data, Error (badges, never a number), "Not enough data" for charts with fewer than two ok observations, "unreviewed specification" badge on the dashboard header. `lib/client/kpi-state.ts` holds `deriveKpiState` (threshold colouring by direction) and `maturityScore`.
- Pages: `/c/[slug]/dashboard` (header with version, generated by, review status; Regenerate for client_admin queues a CEO Intelligence run through `createTask` + `createRun` in tenant context; honest empty state when no dashboard exists), `/c/[slug]/dashboard/kpi/[kpiId]` (definition, observation history with lineage json, audit events with entity_type kpi), `/c/[slug]/briefing` (eight sections, priorities, source ids linked to findings, opportunities and tasks, earlier briefings with `?id=`), `/c/[slug]/x-ray` (snapshot, systems register, maturity scorecard with the rule printed on the page and uncertainty low/medium/high, AS-IS and TO-BE step tables with intervention labels, issues and evidence register, open questions and pending decisions, opportunity backlog with estimate labels), `/c/[slug]/actions` (approve or reject proposed opportunities via `decideApproval` + `setOpportunityState`, create an action task on an approved opportunity via `createActionTask` + `activateActionTask` with the Performance agent instance, owner marks in progress, client_admin closes with a verification note or escalates). Reads in `lib/client/xray-queries.ts`, writes in `lib/client/action-actions.ts`, JSON readers in `lib/client/xray-helpers.ts`, badges in `components/xray-ui.tsx`.
- Onboarding wizard `/mission-control/clients/new` (button on `/mission-control/clients`): `lib/mission-control/onboarding.ts` creates in one transaction (agency scope, `app.tenant_id` set after the tenant insert) the tenant (client, onboarding), departments, systems (stated), tenant budget USD 10, one agent instance per active definition pinned to the stable skill release with its budget, schedules (Discovery weekdays 07:00 UTC enabled, others disabled), then writes the Better Auth organisation row directly through the auth pool, links it with `linkOrganizationToTenant`, inserts a pending owner invitation (72 h) and mails the accept link through the mailer (`[mail:dev]` without RESEND_API_KEY). Better Auth's own `createOrganization` and `createInvitation` were not used because they would make the operator a member of the client organisation (ADR-017 forbids that). Every step writes an audit row. Parsers in `lib/mission-control/onboarding-parse.ts`.
- Tests: `apps/web/test/dashboard.test.ts` (19: widget map equals the contract enum, specification refusals, KPI state and threshold colouring, maturity score determinism and uncertainty, wizard parsers, server-rendered widget states including sanitised markdown). `vitest.config.ts` now compiles JSX (`oxc.jsx.runtime = automatic`). Web suite 68 tests, typecheck green.
- Verified against `sbos_m1` on port 3400 (demo users and superadmin created there, `two_factor_enabled` toggled on the auth row for the curl session): dashboard, two KPI lineage pages, briefing, X-Ray and actions return 200 as client admin; `/mission-control/clients/new` 200 and one submission created tenant `demo-wizard-test` (2 departments, 2 systems, 7 instances, 4 schedules, 8 budgets, 10 audit rows, organisation linked, invitation pending, accept page renders).
- Open: visual regression snapshots per widget state (Playwright); owner notification on task assignment; task detail page; operator editing of departments and systems after creation; resend or revoke an invitation; pain points per process step are not shown (table is empty on the demo tenant); the maturity "evidence" component uses tenant-wide facts because facts have no department column.

## Milestone 4 backend and agent nomination (2026-11-09)

Committed as `e746e2c` (migration 0007, schema, services, tests, seed) and `79e9a9c` (nomination step, demo flow step 10).

- Migration `0007_agency_vault.sql`: agency tables without tenant_id (agency scope only, operator metadata grants), `knowledge_promotion_requests` as tenant rows readable by reviewers in agency scope, triggers `enforce_knowledge_transition` (+ `log_knowledge_transition`), `enforce_promotion_insert`, `enforce_promotion_transition`, `enforce_adoption`, immutable versions. Drizzle schema in `packages/db/src/schema/agency.ts`.
- `packages/core/src/agency-knowledge.ts`: record lifecycle, versions, release and rollback (`setCurrentVersion`), deprecation with impact count, `searchAgencyVault` (agency tables only, logged in `audit_events`), templates with `{{parameter}}` rendering, `adoptTemplate` (agency scope pinned to the tenant, writes the client document, pins the version, supersedes the previous adoption), `rollbackAdoption`, `revokeAdoption`, `nominateReusableInsight`, `reviewPromotion`, `publishPromotion`, evaluation cases. Tests: `packages/core/test/agency-knowledge.test.ts` (spec 4H acceptance 1 to 6).
- Seed `seedAgencyKnowledge`: two published records, one draft, template `project-closure-invoice-readiness`. Seed actor holds superadmin, so self-approval is allowed and recorded.
- Process Redesign agent: optional `reusable_insight` in the draft, written as a nomination through tool `knowledge.nominate` (SKILL.md 0.2.0). Instances pinned to 0.1.0 skip and log. `demo-flow-check.ts` step 10 verifies nomination only.
- Decisions: ADR-020. Plan and status: `docs/milestones/M4.md`. Next milestone plan: `docs/milestones/M5.md` (owner decisions listed at the end).
- Inspecting RLS tables with psql: the owner role sees nothing under FORCE RLS; use `SET ROLE sbos_app` plus `set_config('app.actor_scope','agency',false)` and `set_config('app.roles','superadmin',false)`.
- Shared test database: suites in one package run sequentially but share `sbos_test`; assertions must judge only their own rows (fixed in `knowledge.test.ts` after CI run 17).

## Milestone 4 Agency Vault UI (2026-11-09)

Implemented in `apps/web` only (no changes to `packages/db` migrations or `packages/core` services); uncommitted at the time of writing. All UI text is English.

### Files

- `lib/auth-policy.ts`: `AGENCY_ROLES` and `decideAgencyAccess` (any agency role on the agency tenant; client roles rejected; the MFA rule for superadmin and agency_operator is applied exactly as `decideOperatorAccess` does, reviewers and consultants pass without TOTP).
- `lib/request-context.ts`: `requireAgencyContext()` returns an `AgencyContext` (`sbos_app`, `app.actor_scope = 'agency'`, no tenant) with the principal's agency roles; cached per request like the operator context.
- `lib/format.ts`: `errorMessage` now prefers the Postgres `cause` when drizzle wraps a trigger error as "Failed query: ...", so the trigger text reaches the `?error=` notice.
- `lib/mission-control/agency-vault-helpers.ts`: pure helpers (state tones, `recordActionsFor` mirroring `enforce_knowledge_transition`, `buildAgencyFolderTree` over the 18 folders, `AGENCY_MODULES` for Interview Library 04, Industry Blueprints 05, Design System 08, Tech Watch 13, `buildRecordPath`, `parseTemplateParameters` for `key | label | required | default` lines, `collectParameterValues`, `sourceRefCounts`, `sanitizeSnippet`).
- `lib/mission-control/agency-vault-queries.ts`: all reads in agency scope (summary, library with folder and state counts and `searchAgencyVault`, record detail, skills registry, promotion requests, templates view with adoption matrix metadata, cross-record history). Pin counts for the Skills Registry come from `agent_instances` through the operator role and only when the caller holds an operator role.
- `lib/mission-control/agency-vault-actions.ts`: server actions (create record, add version, lifecycle transitions and deprecate/reinstate/archive, make current (release or rollback), evaluation case upsert and result, create template, adopt, roll back, revoke, review promotion, publish promotion). Adoption, rollback and revoke run in agency scope pinned to the target tenant.
- `components/agency-vault-ui.tsx`: sub-navigation, state badges, the shared "Implementation status" card.
- Pages: `app/mission-control/agency-vault/page.tsx` (Knowledge Library with 18 folders, module tabs, state filters, search, Skills Registry view), `records/[id]/page.tsx`, `new/page.tsx`, `reviews/page.tsx`, `templates/page.tsx`, `history/page.tsx`; `app/agency/page.tsx` is now a real landing page for agency staff; the `agency-vault` placeholder was removed from `app/mission-control/[module]/page.tsx`.
- `app/mission-control/layout.tsx`: for paths under `/mission-control/agency-vault` the layout resolves `requireAgencyContext()` (every agency role, operator MFA rule unchanged) and shows `AGENCY_STAFF_NAV` to staff without an operator role; every other Mission Control path still requires the operator context. The pathname comes from the `x-sbos-pathname` header that `proxy.ts` sets on every `/mission-control` request (it overwrites any client value); without the header the layout falls back to the operator rule.
- `components/shell.tsx`: `AGENCY_STAFF_NAV`.
- `app/c/[slug]/vault/[...path]/page.tsx`: "Adopted from agency template <key> v<version>" badge when the frontmatter carries `sbos_template_key` (marked "adoption ended" after a revoke); no link into the agency vault.
- Tests: `test/agency-vault.test.ts` (17 unit tests: access rule and MFA, folder tree, modules, record paths, lifecycle buttons, parameter line parser round trip, parameter collection, placeholders, list and JSON parsers, source ref counts, snippet sanitiser, errorMessage cause).

### Decisions

- Reviewer-only buttons (approve, publish, deprecate, reinstate, archive, make current, promotion review and publish) are rendered for `agency_reviewer` and `superadmin` only; the database triggers remain the gate and their text is shown through `?error=`.
- Promotion requests are visible to reviewers and superadmin only (RLS); the reviews page tells other agency roles so instead of showing an empty queue. Source references are rendered as counts per key, the source tenant by name and slug only.
- The adoption matrix shows version, state and time per tenant and template; `template_adoptions.parameters` is never selected for it (acceptance 6). Adoptions stay untouched by releases, rollbacks and deprecations (acceptance 5); the UI reports the number of active adoptions on each event.
- Evaluation results are recorded by hand; the Agency Knowledge Curator Agent is marked planned on every page. Semantic search stays deferred to M5 (ADR-019); the library search is lexical and logged in `audit_events`.
- `agency_consultant` is a bridge-managed role: a membership inserted directly is removed by `syncMemberships` at the next sign-in. Agency staff must be organisation members (role `member`) of the agency organisation; `agency_reviewer` is not bridge-managed and is granted directly in `memberships`.

### Verification

- `pnpm --filter @sbos/web typecheck` green; `pnpm --filter @sbos/web test` 85 tests (68 existing + 17 new) green.
- Dev server on port 3500 against `sbos_m4`; superadmin created with `pnpm bootstrap-admin`; the TOTP gate was satisfied by toggling `two_factor_enabled` on the auth user row after a curl sign-in (dev database only). All vault routes return 200 for superadmin and agency_reviewer; `/mission-control` redirects a reviewer and a consultant to sign-in (`not_operator`); a client admin is redirected from `/agency` and `/mission-control/agency-vault`.
- Playwright (chromium) through the real forms, twice: create record (06), submit for review, approve (self-approval by superadmin recorded on the transition), publish, add v2 (stored, not released), evaluation case saved and marked pass, template created from the record (3 parameters), adopted into northline-events (Rentman, finance, 2 days) and harbour-view-hotel (Mews PMS, hotel controller, 1 day), northline upgraded to v2 then rolled back (client document revision 3 holds the v1 text), record deprecated with both adoptions still active (`affected_adoptions = 2`), adoption of the deprecated record refused with the trigger text, nomination made programmatically as an agent in tenant context, approval without checks refused with the trigger text, approval with all checks and consent granted plus rights basis, publication to `15_approved_reusable_insights` whose body contains neither the tenant name nor the finding ids. Client documents verified in each tenant's context; tenant scope sees 0 agency records and 0 of the other tenant's documents. Client admin sees the adopted-template badge on the document page.
- Screenshots: `m4_library.png`, `m4_record_detail.png`, `m4_reviews.png`, `m4_templates.png`, `m4_history.png`, `m4_agency_landing.png` in the session scratchpad.

### Open items

- Nominating an insight from the client workspace (client admin UI) is planned; `nominateReusableInsight` exists and agents use it.
- Agent Skills & Versions management (editing, release channels) stays a placeholder; the Skills Registry is read-only.
- A separate route group for the agency vault (instead of the pathname check in the Mission Control layout) would be cleaner once more non-operator agency surfaces exist.
- The templates page renders every template's adopt form; with many templates it should become a per-template page.
- `/mission-control/agency-vault?view=skills` pin counts require an operator role; a metadata grant for reviewers could replace that.

## Milestone 5 integrations backend (2026-11-09)

Committed as `3be21bd` (migration 0008, connectors package, services, worker jobs), `4b9c407` (order-independent tests) and the stale-data commit.

- Migration `0008_integrations.sql`: `connection_phase_changes`, `sync_runs`, `webhook_endpoints`, `kpi_observations.sync_run_id`, new `connections` columns (`sync_interval_minutes`, `security_reviewed_at/by`, `paused_reason`); triggers `enforce_connection_insert` and `enforce_connection_phase` (rules in ADR-021). Drizzle schema `packages/db/src/schema/integrations.ts`.
- `packages/connectors`: `types.ts` (read-only contract), `sandbox.ts` (descriptors and deterministic fixtures for rentman, quickbooks, trengo, dropbox), `registry.ts` (live mode is an explicit not-connected error), `secrets.ts` (`env:NAME` references, `maskSecrets`), `sync.ts` (`runConnectionSync`: skipped in metadata, sandbox never calls fetch, sync_runs row per outcome, incident on failure), `stale.ts` (`markStaleData`). Tests `packages/connectors/test/integrations.test.ts` (8).
- `packages/core/src/integrations.ts`: propose, grant and revoke consent, security review, advance phase, pause/resume, credential and webhook references, sync run lifecycle, `recordMetricObservations` (defines a missing KPI from the descriptor), `dueConnections`, `markStaleConnections`.
- Worker: `connector.sync` (payload `{ tenantId, connectionId, trigger }`), `sync.tick` every 5 minutes (due syncs deduplicated per connection, then stale marking), dead-letter incident for connector jobs, `/healthz` has `syncsRun`. `apps/worker/src/connectors.ts`.
- Demo flow step 11 (`pnpm demo:check` 11/11) runs the whole chain through the worker.
- Not done: live connectors, Langfuse exporter, semantic search, pilot run; see `docs/milestones/M5.md` for the owner decisions they need.

## Milestone 5 Integration UI (2026-11-09)

Implemented in `apps/web` only (no changes to `packages/db` migrations, `packages/core` or `packages/connectors`); uncommitted at the time of writing. All UI text is English. The web app imports only descriptors (`DESCRIPTORS`, `isProvider`) from `@sbos/connectors`; it never calls `runConnectionSync` and never constructs a secret reader. "Run sync now" and "Test connection" only enqueue the `connector.sync` job.

### Files

- `lib/client/integration-helpers.ts`: pure helpers (phase order and `nextPhase`, never offering `write`; badge tones; `scopesForPhase`, `describeScopes`, `readSummary` from the descriptor; `isValidSecretRef` and `isValidPathToken` mirroring the core rules; `pathTokenFromUuids` for the 32 character webhook token; `fmtSyncDuration`, `fmtInterval`; `isOverdue` and `syncHealth`; `agencyActionsFor` and `clientActionsFor` mirroring `enforce_connection_phase`; `suggestProvider`, `kpiSourceNames`).
- `lib/client/integration-queries.ts`: `getIntegrationCenter` in tenant context (systems with their connections, consent user name, scopes, masked last error, last 10 sync runs with note or masked error text, phase change timeline with user names, KPIs whose `source_system` is the system name, the provider display name or the provider key).
- `lib/client/integration-actions.ts`: `proposeConnectionAction`, `grantConsentAction` (checkbox scopes validated against the descriptor's read_only scopes, reason of at least 10 characters, explicit acknowledgement), `revokeConsentAction`; client_admin only, never under a break-glass grant; `userId = principal.data.publicUserId`.
- `lib/mission-control/tools-queries.ts`: `listConnections` and `getConnectionDetail`. List, timeline, sync runs and observation counts through the operator role (metadata columns only; `reason`, `error_message`, `config`, `last_error` are shown as Masked). Credential and webhook references are read in agency scope pinned to the tenant, because the operator grant excludes `secret_ref` and `path_token` and the operator who registered them must see the reference to configure the vendor.
- `lib/mission-control/tools-actions.ts`: `securityReviewAction`, `advancePhaseAction`, `pauseResumeAction`, `registerCredentialAction`, `registerWebhookAction`, `enqueueSyncAction` (trigger manual or test, with an audit row `connection.sync_requested` / `connection.test_requested`). All run as the signed-in operator in `agencyContext({ tenantId })`, like `lib/mission-control/actions.ts`.
- `components/integration-ui.tsx`: phase, status, consent, sync status, kind, review and mode badges; `PhaseLadder`; `PhaseExplainer` (phases in plain language, what a provider reads and never reads, scopes per phase with gloss, derived metrics with formula); `IntegrationStatusCard`.
- Pages: `app/c/[slug]/integrations/page.tsx` (Integration Center), `app/mission-control/tools/page.tsx` (Connected Tools list with phase and status filters and eight health counters), `app/mission-control/tools/[id]/page.tsx` (detail with all agency actions). The `tools` placeholder was removed from `app/mission-control/[module]/page.tsx` (`skills` stays).
- Tests: `test/integrations.test.ts` (15 unit tests: phase order, tones, scope rendering, provider suggestion, KPI source names, secret reference and path token validation, interval bounds, durations, overdue and health counters, actions offered per state).

### Decisions

- The database trigger is the only gate for phase advances: the action does not pre-check the step, so a tampered request shows the Postgres text ("connection phases advance one step at a time (metadata -> sandbox refused)", "the write phase has no implementation in this release and is refused") through `?error=`. The form itself only offers the next phase and never `write`.
- Manual sync is offered only for an active read_only or sandbox connection; a test connection is also offered while paused (the sync service allows it). The metadata phase offers neither; the action refuses with the reason before enqueueing anything.
- The webhook path token is generated server-side from two `crypto.randomUUID()` values (32 hex characters) and shown once in the notice and in the references table (agency scope). No inbound webhook handler exists in this release; the page says so.
- The client sees the consent reason, review notes and masked error text (its own data); Mission Control shows those columns as Masked, as the operator grants in migration 0008 intend.
- KPIs are linked to a connection by `source_system` in {system name, provider display name, provider key}, the same set `revokeConsent` uses to mark `missing_source`.

### Verification

- `pnpm --filter @sbos/web typecheck` green; `pnpm --filter @sbos/web test` 100 tests (85 existing + 15 new) green against `sbos_test`.
- Dev server on port 3600 against `sbos_m5flow` (8 migrations, seeded, demo flow output with the Rentman connection in read_only). Demo client users created with `create-demo-users`; superadmin with `bootstrap-admin`; the TOTP gate was satisfied by signing in through `/api/auth/sign-in/email` and then setting `two_factor_enabled = true` on the auth user row (dev database only).
- Next dev's Fast Refresh reloaded every page in a loop in this environment (type generation on each request rewrites `.next/dev/types`, which `next-env.d.ts` imports); the Playwright context blocked the HMR websocket for the checks. `next-env.d.ts` was restored afterwards.
- Playwright (chromium) through the real forms: client admin proposed a QuickBooks Online connection for the QuickBooks Online system (phase metadata, consent pending) and granted consent for `com.intuit.quickbooks.accounting (read)` (recorded as "granted by Nora Northline at 2026-11-10 00:07Z"); a department manager sees no consent forms and a client user is redirected from `/mission-control/tools` (307 to sign-in). Superadmin: list and detail 200; advance refused before the review ("requires a recorded, approved security review" shown instead of the form); review approved; tampered advance to sandbox and to write refused by the trigger with the Postgres text in the notice; advance to read_only ok; credential form invalid client-side for an `sk-` value and valid for `env:QUICKBOOKS_REFRESH_TOKEN_NORTHLINE`, reference registered; webhook endpoint registered with a 32 character token; Run sync now and Test connection queued jobs. Worker started with `ANTHROPIC_API_KEY` unset and port 8085: the manual sync succeeded (7 objects, 2 observations, sandbox, 0 network calls), the test run succeeded (9 objects visible, 0 observations), and the sync tick queued one scheduled run; all three appear on the detail page (observation counts 2, 0, 2) and in the client's Integration Center with the simulated note. KPI links (Open invoices, Overdue receivables) resolve to `/c/northline-events/dashboard/kpi/[id]` (200). Client admin revoked consent: notice "2 KPI(s) ... marked missing_source", card shows consent revoked, phase metadata, status paused, KPIs missing source. Audit rows: consent_granted, security_review_approved, phase_advanced, sync_requested, test_requested, credential_reference.registered, webhook_endpoint.registered, consent_revoked. Worker and dev server stopped afterwards.
- Screenshots in the session scratchpad: `m5_integration_center.png` (after the sync, before the revoke), `m5_integration_center_revoked.png`, `m5_tools.png`, `m5_tool_detail.png`.

### Open items

- Connected Tools filters are single-valued links; combining phase and status needs the query string by hand.
- Open incidents per connection are counted through the `connector:<id>:<class>` dedupe key; a `connection_id` column on incidents would be cleaner.
- The Integration Center shows the last 10 sync runs per connection and no pagination.
- `app/mission-control/[module]/page.tsx` now only serves `skills`; it can be replaced by a real page in M6.
- The phase change timeline shows agency actors by actor id (auth user id); a display name lookup for agency staff is not in the operator grants.
- Dev-only: the Fast Refresh reload loop on this machine should be checked once with a clean `.next` directory; it is unrelated to the new code (the Action Center looped the same way).
