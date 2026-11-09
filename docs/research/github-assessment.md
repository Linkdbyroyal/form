# GitHub Assessment: Build / Adopt / Integrate / Reject

Verification date: **2026-11-09**. All facts below were read from the linked GitHub pages (README, LICENSE, releases, commits, issues) and the official docs named per row. Where a value could not be read it says *could not verify*. Star counts and issue counts are approximate snapshots. This document is an engineering assessment, not legal advice; license verdicts marked **(legal review)** must be confirmed by counsel before commercial launch.

Legend for the verdict column:

- **Adopt**: use as a dependency / core component.
- **Integrate**: use at arm's length (adapter, export, optional), not as a foundation.
- **Pattern**: do not use the code; reuse the documented design pattern.
- **Spike**: test in an isolated spike before deciding.
- **Reject**: do not use for this product (reason given).

## 1. Summary matrix

| Project | License (verified) | Latest release / activity | Relevance | Isolation / multi-tenant | Maintenance risk | Verdict |
|---|---|---|---|---|---|---|
| **Mastra** (`mastra-ai/mastra`) | Apache-2.0 core; `ee/` dirs under Mastra Enterprise License (`@mastra/core/auth/ee`, `agent-builder/ee`, `@mastra/editor/ee`) | `@mastra/core@1.82.0` on 2026-11-04; ~10 minor releases in 5 weeks; ~29.4k stars; 465 open issues | Agent + workflow core, `suspend()/resume()` for human approval, `PostgresStore`, memory, scorers/evals, Langfuse/OTel exporters, MCP | Storage keyed by `resourceId`; docs state memory "doesn't enforce access control" → tenant scoping must be enforced by our middleware | Breaking changes ship in minor versions (1.78–1.82 each removed APIs). Pin exact versions, wrap behind our own adapter | **Adopt** as the single orchestration framework (ADR-003) |
| **LangGraph** (Python) / **LangGraph.js** | MIT (library). Agent Server self-host requires a LangSmith license key and egress to `beacon.langchain.com`; control plane is Enterprise plan | `langgraph==1.2.20` (2026-11-05); `@langchain/langgraph@1.7.2` (2026-11-07); Python ~44.7k stars, JS ~3.4k stars | Durable graphs, interrupts, checkpointers | Thread-scoped; app responsibility | Python-first; JS line is small; tracing/evals tied to LangSmith; server license-gated | **Reject** as core (TS monorepo, server licensing). Keep as fallback path (b) in ADR-003 |
| **CopilotKit** | MIT (SDKs + TS runtime). "Intelligence" (saved threads, memories, analytics, channels) is commercial | v1.85.0 (2026-11-06); ~38.6k stars; 123 open issues | Agent UI over AG-UI, shared state, `useHumanInTheLoop`, generative UI; `@ag-ui/mastra` adapter | Demo code hard-codes `resourceId`; must inject authenticated tenant/user | Breaking changes in minors (A2UI 1.0 in v1.84) | **Integrate** later (Milestone 3) for Interview Inbox / Action Center chat surfaces. Not needed for M0–M2 |
| **shadcn/ui** | MIT | `shadcn@4.23.0` (2026-10-27); ~127.7k stars | Copy-in components, Tailwind v4 + React 19 ready, charts on Recharts v3 with `accessibilityLayer` | n/a | Zod 4 since 4.22; components are copied so upgrades are manual | **Adopt** (components copied into `apps/web`, reviewed and versioned by us) |
| **Trigger.dev** | Apache-2.0; paid Cloud tiers | v4.8.3 (2026-10-30); ~16.7k stars; 199 open issues | Cron, durable waits, waitpoints for approvals, retries, tracing | Environments/queues; no per-tenant model documented | Self-host needs Postgres + Redis + ClickHouse 25.8+ + registry + object storage + worker fleet; docs say the guide "is unlikely to result in a production-ready deployment" | **Reject for MVP** (operational weight). Revisit at >10 tenants if pg-boss limits are hit |
| **pg-boss** (`timgit/pg-boss`) | MIT | 12.38.1 (2026-11-05); ~4.1k stars; 12 open issues | Cron/RRULE schedules, retries with backoff, dead-letter queues, jobs inside our own DB transaction (Drizzle adapter), OTel, `groupConcurrency` | Postgres-only; group concurrency usable per tenant | Single maintainer (stated in README); breaking list-limit in 12.38.0 | **Adopt** as scheduler/queue for Milestones 1–4 (ADR-005) |
| **BullMQ** | MIT (Pro features paid) | v6.7.2 (2026-11-07) | Redis queue | needs Redis | adds a stateful service | **Reject** (we stay Postgres-only until proven necessary) |
| **Langfuse** | MIT core; `ee/` folders enterprise (Organization Creators, Instance Mgmt API, UI customization, external media storage since v4.77.0) | v4.77.0 (2026-11-09); ~37.2k stars; owned by ClickHouse since Jan 2026 | LLM tracing (OTel), prompt versions, evals, cost; Mastra has `@mastra/langfuse` exporter; v4.77.0 removed automatic tokenization (usage must be sent explicitly) | Organizations/projects; `project_id` filters injected | Self-host needs Postgres + ClickHouse + Redis/Valkey + S3 | **Integrate** (Milestone 5): optional exporter. Our own `agent_runs`/`run_events` tables remain the auditable source of truth |
| **Composio** | MIT (SDK); hosted control plane with API key; Pro plan for private toolkits | CLI 0.6.0 (2026-11-01); ~31k stars | 1000+ toolkits, triggers, per-user sessions | Per-user sessions map to tenants | Self-hosting not documented; OAuth token storage location *could not verify*; pricing *could not verify* | **Reject for MVP**. Client credentials must stay under our control (spec 6B). Build thin connectors on official APIs/MCP servers; re-evaluate when DPA and token storage are verified |
| **Anthropic Skills** (`anthropics/skills`) | README: many skills Apache-2.0; no root LICENSE file; "demonstration and educational purposes" | no releases; ~190k stars | `SKILL.md` = YAML frontmatter (`name`, `description`) + Markdown instructions + optional scripts | n/a | Format is stable; spec at agentskills.io *not fetched* | **Adopt the format** for `skills` / `skill_versions` (ADR-007). Do not vendor the skills themselves |
| **Paperclip** (`paperclipai/paperclip`) | MIT (LICENSE: "Paperclip AI"; README footer names "Paperclip Labs, Inc." – attribution inconsistency to confirm) | v2026.1106.0 (2026-11-06); commit 2026-11-09; ~112.6k stars; **3,605 open issues**, ~3k open PRs; breaking changes in most releases | Org chart, heartbeats with coalescing, budgets with hard stops, routines (cron/webhook), approvals, activity feed, plugin system, 20+ runtime adapters, REST + MCP | README claims multi-organization with "company-scoped access checks" (application level). DB-level isolation not documented; **not verified** | Very high churn; fresh regressions in 2026.1106.0 (#20304, #20305, #20303); Rust runner; vendor sells Paperclip Cloud | **Reject as base; Pattern** for heartbeat queue, budget hard-stop, break-glass audit (`?breakGlass=true` writes audit row), routines → tasks. Re-assess in Q2 2027 once isolation can be read in code |
| **Blank Collar Agentic OS** | MIT | no releases; last commit on read branch 2026-06-15; 14 stars | Goal-first UX, policy engine `allow/approve/deny`, claimed RLS | Claims "RLS strict-by-default" but repo marks `apps/auth` as "placeholder"; **unverified / inconsistent** | Single author, stale 5 months, 6+ services (Neo4j, Qdrant, Portkey required) | **Reject**. Pattern only: per-skill-call policy decision |
| **Company OS** (`gquthier/company-os`) | MIT | 1 commit (2026-08-29); 16 stars | Markdown/Bash template: decisions registry, autonomy tiers T1/T2/T3, "two failures = stop" | none (one folder per company) | not a platform | **Reject as software; Pattern** for autonomy tiers and decision registry (we implement as `decisions`, `approvals`, `policies`) |
| **SilverBullet** | MIT | 2.12.1 (2026-10-12); commit 2026-11-09; 6.5k stars; 358 open issues | Markdown space, Space Lua, Git-backed history | Single space per server; no document-level permissions found; Runtime API experimental (docs returned 503) | Single maintainer | **Reject as server**. Pattern: Markdown-first UX, frontmatter + backlinks |
| **Outline** | **BSL 1.1**; Additional Use Grant forbids a "Document Service" (commercial offering where third parties create teams and documents they control); Change Date 2030-10-23 → Apache-2.0 | v1.12.0 (2026-10-23); 41.2k stars; 28 open issues | Mature KB, REST API, revisions, permissions, MCP server | Teams per subdomain | Multi-service (Node, Postgres, Redis, S3, collab service) | **Reject (legal review)**: our Client Vault is exactly a Document Service. Would need a commercial license from General Outline, Inc. |
| **AppFlowy** | AGPL-3.0; no commercial license found | v0.15.0 (2026-11-02); 78.6k stars; 952 open issues | Notion-style editor; Flutter + Rust; AppFlowy Cloud for self-host | Workspaces; isolation *could not verify*; API *could not verify* | AGPL §13 network clause if modified; Notion-style, not Markdown-first | **Reject** |
| **pgvector** | PostgreSQL License | v0.8.7 (release page empty, version from README); 23.6k stars; 9 open issues | HNSW/IVFFlat, hybrid with Postgres FTS; README recommends list partitioning or separate tables per tenant for isolation and recall | Per-tenant partitions | Not in the official `postgres` image; use `pgvector/pgvector:pg16` or build | **Adopt** (Milestone 2 RAG). Embeddings stored per tenant partition, retrieval filtered server-side |
| **Dify** | Apache-2.0 + additional conditions: no multi-tenant operation without written authorization; no removal of logo/copyright in frontend | 1.19.0 (2026-11-04); ~160.8k stars | Workflow UI, RAG | Multi-tenant forbidden without commercial license (Enterprise, custom price) | n/a | **Reject** |
| **n8n** | Sustainable Use License 1.0 (internal business use only; distribution only free and non-commercial; notices may not be removed) + Enterprise License for `.ee` files; embed/OEM license *could not verify* (license FAQ page 404) | n8n@2.46.7 (2026-11-09); ~209.9k stars | Automations | Hosting for customers/white-label not covered | n/a | **Reject** for embedded/white-label use. Note: a client that already runs its own n8n or Make can be integrated through webhooks (that is the client's license, not ours) |
| **Metabase** | AGPL-3.0 (OSS) / Metabase Commercial License; "Multi-tenant embedded analytics" and "Whitelabel ready" are Pro ($575/mo + $12/user/mo) or Enterprise (from $20k/yr) | 65.3 (2026-11-06); ~50.3k stars; ~4k open issues | BI | Paid for our use case | n/a | **Reject**. Dashboards are rendered by our Design System from `DashboardSpecification` JSON (spec 4B) |

## 2. Components not in the original list, chosen by us

| Component | License | Version checked (npm, 2026-11-09) | Why | Status |
|---|---|---|---|---|
| Next.js | MIT | 16.4.5 | Named in both architecture paths of the spec | Adopt |
| Drizzle ORM | Apache-2.0 | 0.45.4 | SQL-first, works with RLS and `SET LOCAL`, pg-boss adapter exists | Adopt |
| Tailwind CSS | MIT | 4.3.5 | Design tokens as CSS variables, shadcn compatible | Adopt |
| Zod | MIT | 4.6.7 | Contracts shared between agents, API and UI (shadcn 4.22+ and Mastra both on Zod 4) | Adopt |
| Vercel AI SDK (`ai`, `@ai-sdk/anthropic`) | Apache-2.0 | 7.0.166 / 4.0.99 | Provider abstraction used by Mastra | Adopt via Mastra |
| Better Auth | MIT | 1.7.18 | TS-native auth with Postgres adapter and organizations plugin | **Spike** in Milestone 1 (not yet verified in this assessment; fallback Auth.js) |
| Vitest, Turborepo, pnpm | MIT | 4.0.99 / 2.11.10 / 10.28.0 | Tooling | Adopt |

## 3. Architecture path comparison (spec 6A)

| Criterion | (a) Next.js + LangGraph + Postgres + CopilotKit + scheduler | (b) Next.js + Mastra + Postgres + CopilotKit + scheduler |
|---|---|---|
| Language | Python core (best) or small JS port | TypeScript end-to-end, shared Zod contracts |
| Durable HITL | `interrupt()` + checkpointer; strict resume mode in 1.2.20 | `suspend()/resume()` with schemas, snapshots in `PostgresStore` |
| Persistence | Postgres checkpointer (library); Agent Server license-gated | `@mastra/pg` storage, composite storage |
| Observability | LangSmith (paid) or OTel work | `MastraStorageExporter`, `LangfuseExporter`, OTel |
| Evals | LangSmith | built-in scorers/datasets |
| Self-host cost | Agent Server needs license key + Redis | none beyond Postgres |
| License risk | MIT library; server/platform commercial | Apache-2.0 core; `ee/` auth and agent-builder paid |
| Churn | weekly patches, 1.x | ~2 minors/week, breaking in minors |
| Team fit | second language in the stack | one language, one package manager |

**Decision**: path **(b)**, Mastra. Mitigation for churn: exact version pins, `packages/agents` exposes our own `AgentRuntime` interface; Mastra is referenced only inside that package. CopilotKit deferred to Milestone 3. Scheduler: pg-boss.

## 4. Verification checklist still open

- [ ] Read Mastra `ee/LICENSE` text and confirm nothing in our dependency tree pulls `@mastra/core/auth/ee`.
- [ ] Read Paperclip `server/` scoping queries before any future "Integrate" decision.
- [ ] Confirm Better Auth organizations plugin behaviour with RLS (spike ticket M1-02).
- [ ] Legal review of the Outline BSL interpretation only if we ever reconsider Outline.
- [ ] Composio DPA and token storage, only if connector breadth becomes a bottleneck.
- [ ] Langfuse `ee` license text before self-hosting Langfuse.
- [ ] Agent Skills spec (`anthropics/skills/spec`, agentskills.io) for frontmatter fields beyond `name`/`description`.

## 5. Source URLs fetched (2026-11-09)

Paperclip: repo, LICENSE, releases, commits, issues. Blank Collar: repo (branch `claude/blank-collar-agentic-os-pHTOO`), LICENSE, releases, commits, issues. Company OS: repo, LICENSE, releases, commits, issues. Mastra: repo, releases, LICENSE.md, mastra.ai/docs (workflows/suspend-and-resume, server-db/storage, observability/overview, memory/conversation-history). LangGraph: langgraph repo + releases, langgraphjs repo + releases, docs.langchain.com (langsmith/deployments, deploy-standalone-server, durable-execution). CopilotKit: repo, releases, docs (oss-vs-enterprise, ag-ui, mastra, langgraph-python, human-in-the-loop). Trigger.dev: repo, releases, docs/self-hosting/docker, pricing. Langfuse: repo, releases, langfuse.com/self-hosting. Composio: repo, releases. Anthropic Skills: repo, releases. pg-boss: repo, releases. BullMQ: repo, releases. SilverBullet: repo, releases, commits, LICENSE.md, docs Runtime API (503). Outline: repo, releases, LICENSE. AppFlowy: repo, releases, LICENSE. shadcn/ui: repo, releases, docs/tailwind-v4, docs/components/chart. pgvector: repo, releases, LICENSE. Dify: repo, LICENSE, releases, commits, dify.ai/pricing. n8n: repo, LICENSE.md, LICENSE_EE.md, releases, commits, docs.n8n.io (SUL page 404). Metabase: repo, LICENSE.txt, LICENSE-EMBEDDING.txt, releases, commits, metabase.com/license/commercial, metabase.com/pricing.
