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
