# Second Brain Business OS: Architecture

Status: **v0.1, proposed for approval** (2026-11-09). Everything in this document is a design unless a section says "implemented". Implementation status per component is tracked in `docs/HANDOFF.md`.

## 1. Product in one paragraph

A multi-tenant platform in which a small pool of specialised AI agents diagnoses a client company, asks only the questions that close an evidence gap, redesigns processes, builds approved automations and then monitors KPIs. Three strictly separated workspaces: **Mission Control** (our operators manage clients, agents, runs, approvals and costs), **Client Workspace + Client Knowledge Vault** (the client's CEO and staff see dashboards, questions, actions and their own knowledge), and the **Agency Intelligence Vault** (our methods, skills and templates). Client data never crosses tenant boundaries; agency knowledge reaches clients only as versioned, read-only templates.

What it is not: a chatbot, a BI tool with AI sprinkled on, a self-driving company. Agents run on schedule, event or operator command, propose rather than decide, and every risky action is technically blocked until a human with the right role approves.

## 2. Architecture path chosen

Spec 6A asked for a comparison of (a) Next.js + LangGraph and (b) Next.js + Mastra. We choose **(b)**. Rationale and evidence: `docs/research/github-assessment.md` section 3 and `docs/DECISIONS.md` ADR-003.

```
                  ┌────────────────────────────────────────────────────────────────┐
                  │                     apps/web  (Next.js 16, React 19)           │
                  │  /mission-control/*     /c/[tenant]/*        /agency/*         │
                  │  operators              client users         agency team       │
                  │  server actions + route handlers = the ONLY entry to the DB    │
                  └───────────────┬────────────────────────────┬───────────────────┘
                                  │ authz (role + tenant)      │
                  ┌───────────────▼───────────────┐   ┌────────▼─────────────────┐
                  │ packages/core  (domain services)│   │ packages/agents          │
                  │ tenancy, audit, approvals,      │   │ AgentRuntime interface   │
                  │ tasks/runs state machines,      │◄──┤ Mastra adapter, skills,  │
                  │ vault, discovery engine, KPIs   │   │ tool gateway (authz)     │
                  └───────────────┬───────────────┘   └────────┬─────────────────┘
                                  │                             │
                  ┌───────────────▼─────────────────────────────▼─────────────────┐
                  │ packages/db  (Drizzle + SQL migrations)                        │
                  │ PostgreSQL 16 + pgvector, Row-Level Security on every          │
                  │ tenant-scoped table, app.tenant_id / app.actor_id GUCs          │
                  └───────────────┬────────────────────────────────────────────────┘
                                  │
          ┌───────────────────────┼──────────────────────────────┐
   ┌──────▼──────┐        ┌───────▼────────┐             ┌───────▼────────┐
   │ apps/worker │        │ object storage │             │ connectors     │
   │ pg-boss     │        │ S3-compatible, │             │ read-only first│
   │ schedules,  │        │ per-tenant     │             │ Rentman, QBO,  │
   │ retries,    │        │ prefix, check- │             │ Trengo, Dropbox│
   │ dead-letter │        │ sums           │             │ (Milestone 5)  │
   └─────────────┘        └────────────────┘             └────────────────┘
```

### 2.1 Stack

| Layer | Choice | Pinned version (2026-11-09) | Why |
|---|---|---|---|
| Web | Next.js (App Router), React 19, TypeScript | 16.4.5 | Required by spec; server components keep data access server-side |
| UI | Tailwind CSS v4 + shadcn/ui (copied components) + Recharts via shadcn chart | 4.3.5 / shadcn 4.23 | Design tokens as CSS variables; accessible primitives |
| Agents | Mastra core (Apache-2.0) behind our `AgentRuntime` interface | `@mastra/core` 1.82.0 | TS-native, `suspend()/resume()` for approvals, Postgres storage, Langfuse exporter |
| LLM | Anthropic Claude through Mastra's model router; model per task configured in `agent_definitions.model_policy` | SDK via Mastra | Spec 4D: choose per task on quality, latency, privacy, cost |
| Database | PostgreSQL 16 + pgvector + pg_trgm, Drizzle ORM, SQL migrations | pg 16 / drizzle 0.45 | RLS is the isolation boundary; pgvector per-tenant partitions |
| Jobs | pg-boss | 12.38.1 | Cron, retries, dead-letter, transactional enqueue, Postgres-only |
| Auth | Better Auth (spike M1) with organizations mapped to tenants | 1.7.18 | TS-native, Postgres adapter; fallback Auth.js |
| Contracts | Zod 4 schemas in `packages/contracts`, exported as JSON Schema | 4.6.7 | One definition for agents, API and UI |
| Observability | Our own `agent_runs`/`run_events` (source of truth) + optional Langfuse exporter (M5) | | Auditable without a second system |
| Storage | S3-compatible (MinIO locally) with per-tenant prefixes and SHA-256 checksums (M2) | | Original documents immutable |
| Deploy | Docker Compose (dev) → single VM or Fly/Railway (pilot) → Kubernetes only if needed | | Start simple |

### 2.2 Monorepo layout

```
apps/web                 Next.js app: three route groups, server actions, API routes
apps/worker              pg-boss worker: schedules, agent runs, stall alarm (M1)
packages/db              Drizzle schema, SQL migrations, RLS policies, seed, isolation tests
packages/contracts       Zod contracts + JSON Schema export
packages/core            Domain services (tenancy, audit, approvals, discovery, vault, kpi) (M1+)
packages/agents          AgentRuntime, Mastra adapter, skill loader, tool gateway (M1+)
packages/ui              Design tokens + shared components (M1; M0 keeps them in apps/web)
docs/                    Architecture, ADRs, roadmap, milestones, research, cases
legacy/lbr-intake        Previous intake form (kept for reference, not part of the build)
```

## 3. Tenancy and security model (spec 6B)

1. **Every tenant-scoped table carries `tenant_id`** and has RLS enabled with `FORCE ROW LEVEL SECURITY`. Policies compare against `current_setting('app.tenant_id', true)`. The application role `sbos_app` is not the table owner and cannot bypass RLS.
2. **Request context** is set once per transaction: `SET LOCAL app.tenant_id`, `app.actor_id`, `app.actor_type`, `app.roles`. All queries run inside `withTenant(ctx, fn)` from `packages/db`. There is no code path that runs tenant data queries outside it.
3. **Operator cross-client views** (Mission Control) use a separate connection role `sbos_operator` whose policies allow reading *operational metadata tables only* (`agent_runs`, `run_events` with content masked, `approvals` headers, `schedules`, `incidents`, `costs`). Document content, answers, facts and embeddings are never exposed to that role. Reading client content requires an explicit `client_content_grants` row (user, tenant, expiry, reason) and writes a `knowledge_access_logs` row.
4. **Background jobs** receive `tenant_id` in the job payload and open the same `withTenant` context; the worker never uses a superuser connection.
5. **Agency Vault** lives in the same database under `vault_scope = 'agency'` with `tenant_id IS NULL`, protected by its own policies (agency roles only). Agency search indexes contain no client rows; the embeddings table is partitioned by tenant and the agency partition is a separate table.
6. **Secrets**: connector credentials are stored encrypted (libsodium sealed box, key from environment / secret manager), referenced by `credentials_metadata`; the plaintext never enters prompts, logs or the frontend. Prompt inputs from documents, e-mails and web pages are wrapped as untrusted content and tool calls are authorised server-side against the agent's `allowed_tools` and the actor's role, not by the model.
7. **Audit**: `audit_events` is append-only (no UPDATE/DELETE grants). Every mutation through core services writes one event with actor, tenant, entity, before/after hash.
8. **Tests that must stay green**: two seeded tenants; a query as tenant A never returns tenant B rows across REST, server actions, worker jobs, search and embeddings; the operator role cannot read `vault_documents.body_markdown`; a risky mutation without approval fails at the database constraint, not only in the UI.

## 4. Agent model (spec 3, 4E, 4F)

- **Agent definition** (`agent_definitions`): mission, allowed tools, required data, tenant scope, authority level, cost budget, escalation policy, eval cases, input/output contracts, triggers, owner, quality criteria. Definitions are agency templates; a tenant *activates* a definition (creates `agent_instances`) only when needed.
- **Skills** follow the `SKILL.md` format (frontmatter `name`, `description`, plus our fields `version`, `contracts`, `allowed_tools`, `eval_cases`). `skill_versions` are immutable; an instance pins a version; `skill_release_channels` (stable/beta) control rollout.
- **Tasks and runs**: `agent_tasks` (what to do, owner, priority, due) → `agent_runs` (one execution) → `run_events` (step-level trace: tool, input ref, output ref, tokens, cost, duration). State machines are in `docs/data-model.md`. Runs are triggered by schedule (pg-boss cron), event (webhook, KPI threshold, new answer) or operator command. No run is "always on".
- **Human in the loop**: a run that needs a decision writes an `approvals` row and goes to `waiting_for_approval`; the Mastra workflow is suspended and resumed when the approval row is decided. Help requests (missing data, contradiction, connection error, policy decision) create `tasks` in the Management Inbox with owner and deadline.
- **Budgets**: per tenant, per agent instance and per run; the worker refuses to start a run when the hard cap is reached and raises an incident (pattern from Paperclip).
- **Stall alarm**: every schedule has `expected_by`; a worker heartbeat job marks a missed schedule as `incidents.kind = 'missed_schedule'`. Silence is never success.

## 5. Knowledge Vaults (spec 4G, 4H)

- Markdown documents with frontmatter, stored in `vault_documents` (current) and `vault_revisions` (every version, diff-able, revertable). Links are extracted into `vault_links` (bidirectional); tags into frontmatter. The folder taxonomy of the spec (00_company_profile … 19_history_and_archive; 00_second_brain_strategy … 17_archive) is the `path` prefix.
- **Facts** (`vault_facts`) are atomic statements with source, origin system, timestamp, responsible role, verification status (`unconfirmed → hypothesis → evidence_backed → verified → approved_policy`), classification, version and access policy. Documents cite facts; agents reason over facts, not over prose.
- **Search**: Postgres full-text (`tsvector`, `pg_trgm`) in M2; pgvector embeddings in M2/M3 with retrieval filtered by the same RLS context; every retrieval writes `retrieval_audit`.
- **Agent writes** are proposals (`vault_change_proposals`) unless the tenant policy marks the path as auto-draft. Reviewers promote facts; history is revertible.
- **Agency ↔ Client flow**: `knowledge_promotion_requests` → `knowledge_promotion_reviews` → new `agency_knowledge_records` (no back-reference to source tenant data) → `template_adoptions` per tenant with pinned version. Default deny, no automatic publication.

## 6. CEO Intelligence and dashboards (spec 4B)

KPI Registry (`kpis`) → observations (`kpi_observations` with status ok/missing_data/stale_data/error) → `DashboardSpecification` JSON produced by the CEO Intelligence agent → rendered by a fixed widget whitelist in the Design System (no agent-authored code reaches the browser) → Management Action Center (issue → action → owner → approval → task → verification → closure). Every number is clickable to source, owner, timestamp, formula and audit trail. Missing or stale data is rendered as a state, never as a number.

## 7. Surfaces and navigation

**Mission Control** (`/mission-control`): Overview, Client Workspaces, Agents (Agent Detail), Tasks, Runs & Traces, Approvals, Agent Skills & Versions, Schedules, Costs, Errors & Incidents, Connected Tools, Agency Intelligence Vault (Knowledge Library, Skills Registry, Interview Library, Industry Blueprints, Design System, Tech Watch, Pending Knowledge Reviews, Version History).

**Client Workspace** (`/c/[tenant]`): CEO Dashboard, Business X-Ray, Interview Inbox, Action Center / Approvals, Client Agent Center, Integration Center, Knowledge Vault.

**Agency** (`/agency`): same Agency Vault modules for agency staff who are not operators.

## 8. Non-goals for the first three milestones

No live client integrations (synthetic data only), no payments or bank changes ever, no HR or legal decisions by agents, no self-training on client data, no agent-generated frontend code.

## 9. Autonomous Agent Runtime (mandatory requirement, added 2026-11-09)

Claude Code is the development environment, not the runtime. All agents execute inside `apps/worker`, a long-running process on Second Brain's own infrastructure, triggered by schedules, events or operator commands, using the Anthropic API with server-side keys and persisting every piece of state (runs, events, checkpoints, workflow snapshots, approvals, vault writes) in PostgreSQL. The platform keeps operating when Claude Code is closed, the developer's machine is off, nobody is logged in and no dashboard is open.

Design, lifecycle, recovery, scheduling model, infrastructure and the ten-step Autonomy Acceptance Test are in `docs/agent-runtime.md`. The technology evaluation (Temporal, Trigger.dev, Inngest, Hatchet, Mastra, LangGraph, pg-boss, Anthropic Managed Agents) is in `docs/research/durable-execution.md`; the decision is ADR-013. The acceptance test is a gate for Milestone 1 and again before the pilot go-live; the platform is not called production-ready until it passes with Claude Code closed.
