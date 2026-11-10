# Handoff

Last updated: 2026-11-10 (Railway staging live: web and worker deployed, worker in live mode; Milestone 6 delivered on synthetic data; Milestone 5 sandbox part delivered; Milestone 4 delivered; Milestone 3 delivered; Milestone 2 delivery, branch `claude/second-brain-os-architecture-ovfky3`, pushed to GitHub).

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
- Formal "Claude Code closed" observation with timestamps on staging; induced worker kill test. (First Railway staging deploy: done 2026-11-10, see "Railway staging go-live".)
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


## Milestone 6 backend: Technology Intelligence Center, retention, notification fix (2026-11-10)

- Migration `0009_tech_intelligence.sql` (see ADR-022): agency-scope tables `tech_sources`, `tech_updates`, `tech_update_transitions`, `tech_watch_runs`; nullable-tenant `retention_policies` (defaults seeded) and `retention_sweeps`; tenant `deletion_requests`; restrictive DELETE policies on `run_events`, `retrieval_audit`, `notifications`, `sync_runs`, `knowledge_access_logs`, `cost_events`, `vault_documents`, `vault_revisions`, `kpi_observations` (agency scope with system or superadmin only); operator UPDATE on notification delivery columns (defect since M1: the worker could never mark a notification sent, jobs retried to the dead-letter queue; `autonomy-check` step 10 now requires a sent notification). Drizzle schema `packages/db/src/schema/governance.ts`.
- `packages/core/src/tech-intelligence.ts`: `registerTechSource`, `setTechSourceApproval`, `dueTechSources`, `recordDetectedUpdates`, `assessUpdate`, `decideUpdate`, `applyUpdate` (skill update moves the stable channel), `rollbackUpdate`, `pinnedInstanceCount` (operator view), `listTechUpdates`. `packages/core/src/retention.ts`: `effectiveRetention`, `setRetentionPolicy`, `sweepRetention`, `requestDeletion`, `decideDeletion`, `executeDeletionRequest`, `completeDeletionManually`, `approvedDeletionRequests`. Tests: `packages/core/test/governance.test.ts` (4).
- Worker: `tech.watch` daily 06:00 UTC (`apps/worker/src/tech-watch.ts`, parsers in `tech-watch-parsers.ts` with unit tests; `SBOS_TECH_WATCH_OFFLINE=1` records fixture items, set in CI), `retention.sweep` Sundays 03:00 UTC (`apps/worker/src/retention.ts`). Verified on `sbos_m6flow`: a live run through the sandbox proxy gets 403 from api.github.com and is recorded as `failed` with the message on the source; the offline run records five `detected` updates.
- Seed: seven approved sources (Mastra, pg-boss, Better Auth, Next.js, Drizzle releases; Anthropic docs and OWASP LLM Top 10 as manual sources).
- Inspecting agency tables with psql: `SET ROLE sbos_app` plus `set_config('app.actor_scope','agency',false)` and `set_config('app.roles','superadmin',false)`.
- Open: Mission Control UI for Tech Watch and Upgrade Center, retention and deletion UI, security evaluation suite, external review and pilot checklists (`docs/milestones/M6.md`).

## Milestone 6 UI (2026-11-10)

Implemented in `apps/web` only (no changes to `packages/*` or `apps/worker`); uncommitted at the time of writing. Tickets M6-06 (Tech Watch and Upgrade Center) and M6-07 (retention and deletion UI). All UI text is English; every page carries the implementation-status card with the four standard rows (Technology Intelligence agent planned, live source fetching not connected in the sandbox, subject data and tenant off-boarding by manual runbook, automatic production upgrades refused by design).

### Files

- `lib/mission-control/governance-helpers.ts`: pure helpers. Enum lists; tones for upgrade status, security risk, deletion state, watch run; `allowedUpgradeTransitions` and `isAllowedUpgradeTransition` (the exact table of `enforce_upgrade_transition`); `upgradeActionsFor` and `upgradeActionsForRoles` (assess for every agency role, approve, reject, apply and rollback reviewer-only); `artefactRequirement` per kind with the trigger's rule text and the effect of applying; `missingAssessmentFields`; `parseAgentKeys`, `isSourceKey`, `isHttpsUrl`, `isGithubPullRequestUrl`, `isValidCheckInterval`; `validateRetentionDays` (floor from `RETENTION_MINIMUM_DAYS`, maximum 3650, whole numbers) and `retentionFloor`; `DATA_CLASS_LABELS`; `DELETION_KIND_INFO`, `subjectRefHelp`, `isAutomatedDeletion`, `deletionDecisionsFor` (mirrors `enforce_deletion_request`), `summaryRows`, `executionNote`.
- `lib/mission-control/governance-queries.ts`: `listTechSources` (with latest watch run and update count), `listRecentWatchRuns`, `listUpdates` (counts per status), `getUpdateDetail` (update, source, transitions, skill version and previous version, knowledge record, skills with versions and stable channel, published agency records for the forms), all in agency scope; `getPinnedInstances` (operator context when the user has an operator role, else "operator role required"); `getPlatformRetention` (agency scope, tenant_id NULL); `listAllDeletionRequests` (operator role, granted metadata columns only, counts per state); `getDeletionRequestDetail` (operator context resolves the tenant, then the full row, requester name and the tenant's effective retention in agency scope pinned to the tenant).
- `lib/mission-control/governance-actions.ts`: `registerSourceAction`, `setSourceApprovalAction`, `createSkillVersionAction` (tiny form: immutable draft `skill_versions` row with sha256 checksum, contracts and tools copied from the latest version, audit row `skill_version.created`), `assessUpdateAction` (stores only the artefact of the chosen kind), `decideUpdateAction`, `applyUpdateAction`, `rollbackUpdateAction` (agency scope via `requireAgencyContext`); `setPlatformRetentionAction` (superadmin, tenantId null); `decideDeletionAction` and `completeDeletionManuallyAction` (operator in agency scope pinned to the tenant, pattern of `tools-actions.ts`). Same `withNotice`, `isRedirect`, `errorMessage`, `finish` pattern as `agency-vault-actions.ts`.
- `lib/client/retention-queries.ts`: `getRetentionCenter` in tenant context (effective policy per class with floor, override row and platform default; the tenant's deletion requests with requester names, review notes, execution time and summary; `retention_sweeps` for the tenant).
- `lib/client/retention-actions.ts`: `setTenantRetentionAction` and `requestDeletionAction` (client_admin only, never under a break-glass grant, `userId = principal.data.publicUserId`; connection ids must be UUIDs, an off-boarding request must repeat the workspace slug).
- `components/governance-ui.tsx`: badges, `TechWatchNav`, `TechWatchSandboxNote`, `GovernanceStatusCard`.
- Pages: `app/mission-control/tech-watch/page.tsx` (sources and watch runs, register and approve or unapprove, `?view=updates` list with status filter and counts), `app/mission-control/tech-watch/updates/[id]/page.tsx` (Upgrade Center), `app/mission-control/governance/page.tsx` (platform defaults with edit form, deletion requests across tenants with Masked content columns), `app/mission-control/governance/requests/[id]/page.tsx` (decide with legal hold, complete manually for subject data and off-boarding), `app/c/[slug]/retention/page.tsx` (Data & Retention).
- Modified: `components/shell.tsx` (Tech Watch and Data governance in `MISSION_CONTROL_NAV`, Tech Watch in `AGENCY_STAFF_NAV`, Data & Retention in `clientNav`, all M6), `app/mission-control/layout.tsx` (`/mission-control/tech-watch` joins the agency-scope prefixes so every agency role may open it; `/mission-control/governance` stays an operator surface), `app/mission-control/agency-vault/page.tsx` (Tech Watch module card links to `/mission-control/tech-watch`), `app/mission-control/[module]/page.tsx` (the `skills` placeholder now points to the Upgrade Center for releases).
- Tests: `test/governance.test.ts` (11 unit tests: transition table, actions per status and role, artefact per kind, assessment fields, tones, agent key and url parsing, retention floors, deletion decisions, help text, summary rows).

### Decisions

- The Upgrade Center hides reviewer buttons for non-reviewer roles and offers only the transitions the trigger allows, but never pre-checks the artefact: the trigger is the gate and its text ("a code update is approved only with a pull request (tests run there, a human merges)") is shown through `?error=`. The artefact card shows "missing: approval will be refused" before that happens.
- `assessed -> detected` is allowed by the trigger but has no core service; the page offers "Re-assess" instead (same state, fields overwritten, no transition row).
- A skill update needs an immutable skill version; a small form on the Upgrade Center stores one as draft (no management UI exists yet). Agents are refused; the audit row records skill key, version and checksum.
- Data governance (list of all requests, platform defaults) is an operator surface: the list uses the operator role and therefore shows `subject_ref`, `reason`, `review_note` and `summary` as Masked; the detail page reads the full row in agency scope pinned to the tenant, the scope the decision runs in. `agency_reviewer` without an operator role cannot open Mission Control (ADR-015); deciding from the agency-staff navigation is therefore superadmin-only in practice (open item).
- Retention floors are validated three times: the `min` attribute on the input, `validateRetentionDays` in the action, and the database CHECK. The Playwright check removed the `min` attribute to exercise the action's refusal ("Knowledge access logs must be kept at least 365 days (platform floor)").
- The web app never executes a deletion or a sweep. Every page states "executed by the worker on its weekly schedule (Sundays 03:00 UTC)" and shows the current state and, after execution, the counts.

### Verification

- `pnpm --filter @sbos/web typecheck` green; `pnpm --filter @sbos/web test` 111 tests (100 existing + 11 new) green against `sbos_test`.
- Dev server on port 3700 against `sbos_m6flow` (rebuilt by the coordinator with migrations 0001 to 0010, seeded, seven approved sources, five fixture `tech_updates` in `detected`, five failed live watch runs). Demo users recreated with `create-demo-users` and `bootstrap-admin`; the TOTP gate was satisfied by signing in through `/api/auth/sign-in/email` and then setting `two_factor_enabled = true` (dev database only; the flag must be false again before the next password sign-in or Better Auth asks for TOTP).
- Playwright (chromium) through the real forms, superadmin: registered source `tailwind-releases-*` (github_releases, 48 h, agents web and process-redesign) and approved it with a note (`approved`, `approved_by`, `approved_at` set); on the pg-boss fixture update stored skill version `process-redesign 0.3.0-m6ui*` as draft, assessed as skill_update (risk low, all plan fields, new version selected), approved, applied with "pnpm test green, demo flow 11/11 on staging" (`skill_release_channels.stable` moved from 0.2.0 to the new version; pinned counts "0 instance(s) on this version, 1 on other versions"), rolled back ("regression in the exception report"; stable restored to 0.2.0); transitions `detected > assessed > approved > applied > rolled_back` with actor, roles and notes. Next.js fixture update assessed as code_update without a pull request; approval refused with the trigger text in the notice. Client admin (Northline): override `run_events` to 60 days ok; `knowledge_access_logs` 30 days refused by the action ("at least 365 days (platform floor)"); filed a document deletion request for `19_history_and_archive/m6-ui-deletion-test.md` (created beforehand with `writeVaultDocument`). Superadmin: platform default for `notifications` set to 100 and back to 90; request detail: approve with legal hold refused by the trigger ("a request under legal hold cannot be approved"), then approved. Worker started once (`SBOS_TECH_WATCH_OFFLINE=1`, port 8087, simulated mode) and `retention.sweep` enqueued through a temporary script in `apps/worker/src/cli/` (deleted afterwards): the request completed with `vault_documents 1, vault_revisions 1, vault_links 0`, shown on the Mission Control detail page and in the client's list with the reviewer note and execution time. Department manager sees no override or request forms; a client user at `/mission-control/tech-watch` is redirected to sign-in (307). Audit rows: `tech_source.registered`, `tech_source.approved`, `skill_version.created`, `tech_update.assessed` (3), `tech_update.approved`, `tech_update.applied`, `tech_update.rolled_back`, `retention_policy.set` (tenant and platform), `deletion_request.created`, `deletion_request.approved`, `deletion_request.executed`.
- Screenshots in the session scratchpad: `m6_tech_watch.png`, `m6_upgrade_detail.png` (applied state with pinned counts), `m6_retention.png`, `m6_governance.png`.
- The dev log shows three hydration-attribute warnings (`style={{caret-color:"transparent"}}` on forms): injected by Playwright's screenshot capture, not page code. Dev server and worker stopped; `next-env.d.ts` restored.
- Left behind in `sbos_m6flow`: the tailwind test source (approved), two draft skill versions `0.3.0-m6ui*`, the pg-boss update in `rolled_back`, the Next.js update in `assessed` (code_update, no pull request), the Northline `run_events` override (60 days), the platform `notifications` row with a new reason (still 90 days), one completed deletion request, and the test vault document deleted by the worker.

### Open items

- Deciding deletion requests from the agency-staff navigation: `agency_reviewer` without an operator role cannot reach `/mission-control/governance` (operator surface, ADR-015). Either add a reviewer-only review queue under the agency prefixes or accept superadmin-only decisions.
- Tech Watch offers no "check this source now" button: the worker runs `tech.watch` daily; a manual enqueue would need a `tech.watch` job payload per source (the job currently checks all due sources).
- The Upgrade Center's assessment form shows all three artefact fields; the action keeps only the one of the chosen kind. A client-side kind switch would hide the others (no client JavaScript on these pages by design).
- No pagination on the updates list (200 rows) and on the deletion request lists (200 and 100 rows).
- Skill versions cannot be deleted through the app role (no DELETE grant); draft versions created by mistake stay in the registry.


## First live model call (2026-11-10)

Verified in the sandbox with the owner's key in the worker environment: a Discovery run with Claude Sonnet produced five contract-valid questions, flagged the QuickBooks contradiction and suspended for approval; cost USD 0.038778 (3501 in, 1885 out), recorded with `simulated = false`. The Mastra adapter and the `LanguageModelV4` cast work at runtime. The pasted key must be rotated; on Railway it belongs to the worker service only. Details in `docs/reports/autonomy-acceptance-2026-11-09.md` (seventh run).

## Railway staging go-live (2026-11-10)

Implemented and verified on `second-brain-os` / `staging` (details and identifiers in `docs/deployment.md` 3.10 and 3.11):

- Both images build on Railway from the branch. Two build fixes were needed and are in the Dockerfiles: the worker's legacy `pnpm deploy` needs registry metadata that `pnpm fetch` does not cache (now `--prefer-offline`), and `next build` needs placeholder values for `BETTER_AUTH_SECRET` and `DATABASE_URL` during page-data collection (runtime values come from the service variables).
- Worker pre-deploy command ran the migrations on the private Postgres (`applied 10 migration(s)`) and created the application login role `sbos_web`. The first worker start then failed with `permission denied for database sbos`: pg-boss creates its own schema, so the migrate CLI now also grants CREATE on the database to that role (verified locally: pg-boss starts as the role and owns `pgboss`).
- Worker runs in live mode (`mode: live`, model `claude-sonnet-5-5`, concurrency 2, health on `/healthz`); web answers `/api/health` with `database: reachable, migrations: 10`.
- First start of the fresh database: `SBOS_SEED_ON_START=1` on the worker (idempotent synthetic seed) and `POST /api/setup` on web behind a one-time `SBOS_SETUP_TOKEN` (closes once an admin exists). Both switches were removed after use and both services redeployed; the route now answers 404. Staging result: seed executed (agency plus two synthetic demo tenants), superadmin `owner@secondbrain.test` created with membership `second-brain-agency=superadmin`, sign-in verified with Playwright and stopped by the MFA gate at `/account/security` as designed. The password was handed to the owner in the session and must be changed; TOTP must be enrolled before Mission Control opens.
- Not done yet on staging: Resend and Pumble credentials (delivery is logged), TOTP enrolment of the superadmin (owner action), a client tenant with real consent, the formal "Claude Code closed" observation with timestamps, the induced worker kill test.

## Agency Team page and password change (2026-11-10)

Needed for the staging walkthrough: there was no way to invite agency colleagues (only the client onboarding wizard invites a CEO) and no way to change a password (only the e-mail reset flow, which needs Resend).

- `/mission-control/team` (nav "Agency Team"): members of the agency organisation with role and MFA state, pending and past invitations, invite form (superadmin only; roles owner = superadmin, admin = agency_operator, member = agency_consultant), revoke. The invitation row has Better Auth's shape, so the existing `/accept-invitation/[id]` page and the auth bridge do the rest. Without `RESEND_API_KEY` the mail is only logged and the accept link is shown on the page to the superadmin who created it (status implemented, delivery not connected). Audit `auth.invitation.created` / `auth.invitation.revoked` with `scope: agency_team`. Files: `apps/web/lib/mission-control/team-{helpers,queries,actions}.ts`, `apps/web/app/mission-control/team/page.tsx`, `apps/web/test/team.test.ts`.
- Invitations table shows the account state of the invited address (not created, e-mail not verified, verified). Because the verification mail is only logged without a mail provider, a superadmin can attest the address of an account created from a pending invitation ("Mark e-mail verified", audit `auth.email.attested`); the invitee still signs in with their own password and accepts the invitation. Verified end to end locally: sign-in 403 while unverified, attestation, sign-in, accept, member listed as agency_operator, invitation accepted.
- `/account/security` gained a "Change password" form (Better Auth `changePassword`, 12+ characters, other sessions revoked): `apps/web/app/account/security/change-password.tsx`.
- Verified locally with Playwright as the superadmin with freshly enrolled TOTP: invitation created with the accept link in the notice, accept page 200, revoke to `canceled`, refusal for an existing member, password changed and restored. Web suite 121 tests.
- Lesson: `getOperatorContext()` (request cache) is not available inside a server action; queries used by both pages and actions take the resolved `OperatorContext` as a parameter.

## Account menu, no-access page, mobile bar (2026-11-10)

Owner feedback during the staging walkthrough: no visible sign-out, no account switching, and "Mission Control hangs". Findings and changes:

- The hang was a redirect loop: a signed-in account without an operator role (the owner's new address before accepting the invitation) was sent from `/mission-control` to `/sign-in`, which sends a signed-in user straight back to `next`. Authenticated users without the role now land on `/no-access?area=...` (`apps/web/app/no-access/page.tsx`): shows the account, its roles, pending invitations for the address with an "Accept invitation" button, the areas it can open, and "Switch account". Unauthenticated users still go to sign-in. Helper `noAccessPath` in `apps/web/lib/account-helpers.ts` (tested).
- Account menu on every surface (`apps/web/components/account-menu.tsx`, native details/summary): avatar (profile image or initials), name, e-mail, membership badges, MFA state, "Account security (TOTP, password)", "Switch account" (sign-out carrying `next` so the next user returns to the same page) and "Sign out". Used in the Mission Control and client sidebars, the new mobile top bar of the shell (the sidebar was hidden below the md breakpoint, so phones had no navigation and no sign-out at all), the auth pages (via the `account` slot of `AuthLayout`; client-rendered auth pages have no menu) and the landing page (now rendered per request).
- `/sign-out` accepts a `next` form field (same-site path only). Better Auth now reads the client IP from `x-forwarded-for` (`advanced.ipAddress`), which removes the "shared per-path bucket" rate-limit warning seen in the Railway logs.
- Verified locally with Playwright: client admin opening `/mission-control` lands on `/no-access` (200, no loop) and switches account from there; landing page menu shows roles and actions; mobile viewport shows the top bar and the menu on the security page; sign-out with `next` redirects to `/sign-in?signed_out=1&next=...` and clears the session.

## E-mail delivery on staging (2026-11-10)

Resend connected: sending-only API key restricted to the verified domain `sbaa.io` (created through the Resend connector, never pasted in chat), set as `RESEND_API_KEY` on worker and web, sender `Second Brain OS <noreply@sbaa.io>` (`RESEND_FROM_EMAIL` on the worker, `MAIL_FROM` on web). Verified: a password-reset request on staging produced a Resend message with status `delivered` to the owner's address; no `[mail:dev]` fallback line in the web log. Invitations and verification mails now arrive by e-mail; the "Mark e-mail verified" attestation on the Agency Team page stays available as a fallback. Open: Pumble incoming webhook (`PUMBLE_WEBHOOK_URL` on the worker; owner action), M5 decisions (first connector, pilot consent, Langfuse).
