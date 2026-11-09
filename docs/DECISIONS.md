# Architecture Decision Records

Format: context, decision, consequences, status. Dates are decision dates. Supersede, never edit history.

## ADR-001: Monorepo with pnpm + Turborepo, TypeScript end to end (2026-11-09, accepted)
Context: spec requires Next.js UI; agent core candidates are TS (Mastra) or Python (LangGraph). One language lowers hiring, tooling and contract drift.
Decision: single pnpm workspace, Turborepo for task graph, strict TypeScript, shared Zod contracts.
Consequences: Python-only libraries need a sidecar service if ever required; accepted.

## ADR-002: PostgreSQL with Row-Level Security as the tenant isolation boundary (2026-11-09, accepted)
Context: spec 6B demands isolation in backend, DB, storage, search and logs, not in prompts or UI filters.
Decision: every tenant-scoped table has `tenant_id` + RLS + `FORCE ROW LEVEL SECURITY`; the app role is not table owner; context via `SET LOCAL app.*`; operator role sees metadata tables only; embeddings partitioned per tenant; agency vault rows have `tenant_id IS NULL` and separate policies.
Consequences: all data access goes through `withTenant()`; migrations run with a separate owner role; every new table needs a policy (enforced by a test that scans `pg_tables` for tenant tables without RLS).

## ADR-003: Mastra as the single agent framework, wrapped behind `AgentRuntime` (2026-11-09, accepted, verify in M1 spike)
Context: compared LangGraph (MIT library, Agent Server license-gated, Python-first, LangSmith coupling) and Mastra (Apache-2.0 core, TS, `suspend()/resume()`, PostgresStore, Langfuse/OTel exporters, evals). Evidence in `docs/research/github-assessment.md`.
Decision: Mastra, pinned exact version, imported only inside `packages/agents`. Our `AgentRuntime` interface (start, resume, cancel, stream events) is what core and UI depend on. Tenant scoping enforced in our tool gateway and `resourceId = tenant:<id>:...`; Mastra memory is never trusted for access control.
Consequences: minor-version churn in Mastra is absorbed in one package; never use `@mastra/core/*/ee` paths (enterprise license).

## ADR-004: Build the Knowledge Vault ourselves on Markdown + Postgres + pgvector (2026-11-09, accepted)
Context: Outline is BSL 1.1 and forbids a "Document Service" (third parties creating teams and documents), which is exactly a client vault; AppFlowy is AGPL and Notion-style; SilverBullet is single-space, file-based, no document permissions, experimental API.
Decision: `vault_documents`, `vault_revisions`, `vault_facts`, `vault_links`, FTS + pgvector; Obsidian-compatible Markdown import/export (frontmatter, `[[wikilinks]]`).
Consequences: we own editor, graph view and search; start with Markdown textarea + preview, graph view later.

## ADR-005: pg-boss for schedules and jobs; Trigger.dev rejected for MVP (2026-11-09, accepted)
Context: Trigger.dev self-host needs Postgres, Redis, ClickHouse, registry, object storage and a worker fleet; its own docs say the guide is "unlikely to result in a production-ready deployment". pg-boss is MIT, Postgres-only, has cron, retries, dead-letter, transactional enqueue.
Decision: pg-boss in `apps/worker`. Revisit when >10 tenants or when run fan-out exceeds what one worker pool handles.
Consequences: single maintainer risk; pin version; our run tables, not pg-boss tables, are the audit record.

## ADR-006: Do not adopt Paperclip, Blank Collar or Company OS as a base; reuse patterns (2026-11-09, accepted)
Context: Paperclip (MIT) has the closest feature overlap but 3.6k open issues, breaking changes most releases, app-level company scoping not verifiable without a code audit, and a competing cloud offering. Blank Collar is stale and its RLS claims contradict its own repo layout. Company OS is a Bash/Markdown template.
Decision: build Mission Control on our own schema. Patterns adopted: heartbeat queue with coalescing, budget hard-stops, break-glass reads that write audit rows, routines that create tracked tasks, autonomy tiers T1/T2/T3, decisions registry.
Consequences: more code to write in M1; full control over isolation.

## ADR-007: SKILL.md as the skill packaging format (2026-11-09, accepted)
Context: Anthropic's `anthropics/skills` defines SKILL.md with YAML frontmatter and Markdown instructions; Langfuse and Claude tooling understand it.
Decision: skills are folders with SKILL.md; our frontmatter adds `version`, `contracts`, `allowed_tools`, `eval_cases`, `release_channel`. Stored in `skills`/`skill_versions`, immutable per version.
Consequences: skills are reviewable text; evals run per version before promotion to `stable`.

## ADR-008: Reject Dify, n8n, Metabase, Composio for embedding (2026-11-09, accepted)
Context: Dify forbids multi-tenant operation without written authorization; n8n Sustainable Use License covers internal use only; Metabase multi-tenant embedding requires Pro/Enterprise; Composio requires its hosted control plane and token storage could not be verified.
Decision: no embedding. Clients' own n8n/Make instances may be integrated via webhooks under the client's license. Dashboards rendered by our Design System from `DashboardSpecification`.
Consequences: more UI work; no license exposure.

## ADR-009: Agents produce specifications, never executable frontend code (2026-11-09, accepted)
Context: spec 4B/4C.
Decision: `DashboardSpecification` with a widget-type whitelist validated by Zod; renderer maps types to reviewed components.
Consequences: new widget types require a code change and visual regression test.

## ADR-010: Legacy intake form moved to `legacy/lbr-intake` (2026-11-09, accepted)
Context: repository `linkdbyroyal/form` contained a Node/Express intake form with a hard-coded admin token fallback in `server.js`.
Decision: keep for reference under `legacy/`, exclude from workspace builds, do not deploy. The hard-coded token fallback must be removed before any reuse.
Consequences: repository history preserved; no coupling.

## ADR-011: Synthetic data only until written client consent per system (2026-11-09, accepted)
Context: spec 4A, 11.
Decision: connectors ship in phases metadata → read-only → sandbox → write; each phase requires a `connections.consent_status` change by a tenant admin and a Security agent check. Demo tenants are synthetic.
Consequences: Milestones 0 to 4 run without any real client credentials.

## ADR-012: Claude Code is the development environment, never the runtime (2026-11-09, accepted, mandatory)
Context: owner requirement. The platform must operate with Claude Code closed, the developer machine off, nobody logged in and no dashboard open.
Decision: agents run only in `apps/worker` on our infrastructure, triggered by schedules, events or operator commands, calling the Anthropic API with server-side keys, persisting all state in PostgreSQL. No agent may be implemented as a Claude Code session, skill, hook or manual prompt procedure. The Autonomy Acceptance Test (`docs/agent-runtime.md` §9) gates M1 and the pilot.
Consequences: `apps/worker` moves into M1 scope with recovery, stall alarm and dead-letter; deployment target must host a long-running worker (no serverless-only hosting for the worker).

## ADR-013: Durable execution backbone: pg-boss + Mastra on PostgreSQL in phase 1, `JobBackend` abstraction for Temporal or Hatchet later (2026-11-09, accepted)
Context: evaluated Temporal (MIT, four services + DB; Cloud at $50 per million actions), Trigger.dev (Apache-2.0, heavy self-host), Inngest (SSPL server), Hatchet (MIT, Postgres + RabbitMQ), Anthropic Managed Agents (beta, cron deployments with jitter, 1,000 per org, no verified approval primitive, not ZDR eligible), pg-boss (MIT, Postgres only), Mastra suspend/resume snapshots. Details in `docs/research/durable-execution.md`.
Decision: phase 1 uses pg-boss for queues, cron and retries and Mastra workflows for in-run durability and approval suspension, both on the single PostgreSQL. `JobBackend` (packages/core) and `AgentRuntime` (packages/agents) are the only modules aware of these libraries. Re-evaluate at >10 tenants, multi-week versioned workflows, or more than one worker pool.
Consequences: one stateful dependency and one backup; a future move to Temporal Cloud or Hatchet is a contained change; Managed Agents may later be added as an optional sandbox, never as the scheduler of record.

## ADR-014: Hosting on Railway for the pilot, portable by construction (2026-11-09, accepted, owner decision)
Context: owner decision on the five open questions. Pilot needs a permanently running worker, Postgres, backups and staging/production separation with minimal ops.
Decision: Railway with separate services `web`, `worker`, `postgres` (Railway Postgres with pgvector image or plugin), private networking, environment-scoped secrets, daily backups. Staging and production are two Railway environments from the same repo. Every service is a plain Dockerfile with no Railway-specific code; the only Railway artefacts are `railway.json` files and documented variables, so a move to Hetzner (Docker Compose) or another provider is configuration, not code. The marketing site stays on Vercel.
Consequences: the queue is pg-boss inside Postgres, so no separate queue service is needed; object storage for attachments (M2) will be an S3-compatible bucket outside Railway or a Railway volume behind MinIO.

## ADR-015: Better Auth with organizations, email verification, optional Google/Microsoft, MFA for administrators (2026-11-09, accepted, owner decision)
Context: owner decision. Spike M1-01 confirmed Better Auth 1.7 ships a Drizzle adapter, `organization`, `twoFactor` and `admin` plugins, and social providers.
Decision: Better Auth in `apps/web`. Email/password with mandatory email verification (Resend). Google and Microsoft as optional social providers (enabled by environment variables, disabled when unset). `twoFactor` plugin; the application refuses to activate `superadmin` and `agency_operator` memberships for accounts without a verified second factor. Better Auth organizations map 1:1 to `tenants` (organization id stored in `tenants.auth_org_id`); Better Auth roles are mirrored into `memberships` by a server-side sync so that RLS keeps working from our own tables. Onboarding is invitation-only; public sign-up is disabled.
Consequences: Better Auth tables live in the same database under the `auth` schema, owned by the migration role and not tenant-scoped (they hold identities, not client content); session lookups go through Better Auth, authorisation through `memberships` and RLS.

## ADR-016: Real Anthropic API from M1 with a hard application-level budget (2026-11-09, accepted, owner decision)
Context: owner decision. Synthetic business data, real model calls, pilot target USD 25 per month.
Decision: `ANTHROPIC_API_KEY` exists only in the worker service. Every model call is recorded in `cost_events` (tenant, agent instance, task, run, model, input/output tokens, USD). `budgets` rows define monthly caps at platform, tenant and agent-instance level with warning (80%) and hard-stop (100%) thresholds; the worker checks the cap before every run and before every model call and refuses with an incident when exceeded. Default platform cap USD 25/month, default per-run cap USD 0.50. Alerts via Resend and Pumble. Model per agent is configured in `agent_definitions.model_policy` (default `claude-sonnet-5-5`, Haiku for classification steps).
Consequences: pricing table maintained in `packages/core/src/pricing.ts` and reviewed with every model change; no agent can write to an external business system (ADR-011 phases, approval gate).

## ADR-017: Operator roles and break-glass (2026-11-09, accepted, owner decision)
Context: owner is the initial and only superadmin.
Decision: roles `superadmin`, `agency_operator`, `client_admin` (CEO), `department_manager`, `agent_service` (AI Agent Service Identity, one per agent instance, never interactive), plus the existing `client_employee`, `client_auditor`, `agency_reviewer`, `agency_consultant` kept for later milestones. Agency operators see operational metadata by default. Break-glass: an operator requests access to a tenant's content with a reason; it requires a fresh MFA verification, creates a `client_content_grants` row with a maximum duration of 8 hours, writes an audit event and a Pumble notification, and every content read under the grant writes `knowledge_access_logs`. Grants are revocable by the superadmin and expire automatically.
Consequences: role keys in `roles` are renamed in migration 0002; `agency_superadmin` becomes `superadmin`, `client_ceo` becomes `client_admin`, `client_manager` becomes `department_manager`.

Amendment 2026-11-09 (ADR-017, M1-18): "operator" means superadmin and agency_operator; both can request a grant and both get tenant content only through an active grant. The fresh MFA verification is a TOTP code checked at request time through Better Auth's `verifyTOTP` for the signed-in session, with a replay guard in `auth.break_glass_totp_replay` (a code is refused for two 30-second windows after a successful one). Grants are revocable early by the holder as well as by a superadmin; revocation writes audit and Pumble notice like creation.

## ADR-018: Notifications via Resend (external, formal) and Pumble (internal, operational) (2026-11-09, accepted, owner decision)
Context: owner decision.
Decision: Resend for invitations, email verification, executive reports, approval requests and critical incident alerts to clients and administrators. Pumble webhook for internal operational updates, agent activity and incident coordination. Notifications carry identifiers, state and a deep link into the authenticated platform; they never carry client content, amounts or personal data. Approvals are decided only inside the authenticated platform; a notification link opens the approval, it never approves by itself. Every notification is recorded in `notifications` with channel, template, recipient role and delivery status; failures are retried by pg-boss and surfaced as incidents after exhaustion.
Consequences: `RESEND_API_KEY` and `PUMBLE_WEBHOOK_URL` live only in the worker; the web app enqueues notification jobs.

Amendment 2026-11-09 (ADR-018): authentication e-mails (verification, password reset, invitations) are sent directly by the web app through Resend because they must be delivered synchronously with the request and contain no client content. All other notifications are queued and sent by the worker as decided.

## ADR-019: Semantic search (pgvector) deferred from M3 to M5 (2026-11-09, accepted)
Context: M3-11 planned pgvector embeddings for facts and documents. The development sandbox runs PostgreSQL 16 without the `vector` extension and cannot install it (no package source, no build toolchain allowed), so the feature could not be tested here. The spec 11 demo flow does not need semantic retrieval: Postgres full-text search with `pg_trgm` serves every retrieval in M3 and every retrieval is already logged in `retrieval_audit`.
Decision: ship M3 without embeddings. `knowledge_embeddings` (per-tenant partitions, agency partition as a separate table) and the semantic retrieval path move to M5 together with the Langfuse exporter and the first real connector data, where they are developed against the `pgvector/pgvector:pg16` image used by CI and Docker Compose. Embedding calls will go through the same budget admission as model calls.
Consequences: Vault search stays lexical (websearch syntax) in M3 and M4; the forbidden-document test for semantic search (M3-11 acceptance) is added in M5; `docs/ARCHITECTURE.md` section 7 keeps pgvector as the target and this ADR records the timing.
