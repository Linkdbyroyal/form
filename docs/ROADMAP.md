# Roadmap and Milestones

Each milestone ends with a demo, a test gate and a go/no-go. Effort ranges are engineering estimates for one senior engineer plus Claude Code; they are **estimates**, not commitments. Cost bands cover LLM usage during development with synthetic data (Anthropic API) and exclude salaries and hosting (~€20–60/month for a single VM + Postgres during pilot).

| # | Milestone | Outcome (demo) | Test gate | Depends on real client access? | Effort | LLM dev cost band |
|---|---|---|---|---|---|---|
| M0 | **Foundation** (this delivery) | Monorepo boots; two synthetic tenants seeded; Mission Control shell lists client workspaces from the DB; health endpoint | RLS isolation tests pass; `pnpm typecheck && pnpm test` green in CI | No | 1 week | €0 |
| M1 | **Mission Control core + autonomous worker + first agent flow** | Operator schedules the Discovery agent from Mission Control; the worker runs it with Claude Code closed; run, trace, source and cost appear in Runs & Traces; operator sends feedback, reschedules, sees a failed schedule as an incident, decides an approval that resumes a suspended run | M1 acceptance list in `docs/milestones/M1.md` **plus the Autonomy Acceptance Test** (`docs/agent-runtime.md` §9); tenant A sees nothing of tenant B via UI, API, worker or logs | No | 4 weeks | €20–80 |
| M2 | **Client Workspace + Knowledge Vault** | Client user answers a discovery question in the Interview Inbox; answer becomes provisional fact with source; agent detects a contradiction and raises a verification request; reviewer promotes to verified; another agent retrieves the fact with source link; revision revert works; forbidden documents are unfindable via search | Vault MVP acceptance (spec 4G) | No | 3 weeks | €30–100 |
| M3 | **Business X-Ray + CEO Dashboard + Action Center** | Systems register, AS-IS process map, Finding/Opportunity with business case, KPI Registry, `DashboardSpecification` rendered, Executive Briefing, action approved → task → scheduled verification → dashboard updated with source and status | Spec 11 demo flow end to end on synthetic data; missing KPI source renders "Missing data" | No | 4 weeks | €50–150 |
| M4 (backend delivered 2026-11-09, UI in progress) | **Agency Intelligence Vault + promotion workflow** | Admin creates/reviews/publishes a method template, adopts a version into two tenants; agent nominates a reusable insight, blocked until reviewer + rights check; rollback without touching running tenant workflows | Spec 4H acceptance 1–6; search tests prove no client rows leak into agency search | No | 3 weeks | €20–60 |
| M5 (backend on sandbox fixtures delivered 2026-11-09, UI in progress, live connectors need owner decisions) | **Integrations (read-only) + observability** | Rentman, QuickBooks, Trengo, Dropbox connectors in metadata → read-only phase on a sandbox or consented pilot tenant; KPI observations from real sources with lineage; Langfuse exporter; pgvector RAG with retrieval audit | Consent recorded per connection; credentials never in logs; stale-data states visible | **Yes** (pilot consent) | 4 weeks | €50–150 + connector sandbox costs |
| M6 | **Hardening + Tech Intelligence + pilot** | Technology Intelligence Center with scheduled source checks and `UpgradeProposal`s; budget caps; retention/deletion jobs; security evaluation suite (prompt injection, wrong tenant scope, expired credentials); pilot go-live with Royal Events | External review of RLS and secrets handling; eval suite green | Yes | 4 weeks | €100–300 |

Total to pilot: roughly 23 weeks of focused work. Parallelisation is possible from M2 onward (vault and dashboard work are independent).

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Worker not truly autonomous (hidden dependency on a developer session) | requirement failure | Autonomy Acceptance Test scripted and re-run after every deploy; worker container has no developer tooling; no Claude Code hooks in production images |
| Mastra breaking changes in minors | rework | exact pins, `AgentRuntime` wrapper, upgrade only via `UpgradeProposal` + tests |
| RLS bypass through a service role or job | data leak | single `withTenant()` entry point, operator role without content grants, CI test scanning all tables for RLS |
| Scope creep (17 agents, 13 modules) | no demo | activate agents per milestone; M1 ships exactly one agent flow |
| Real client data arrives before consent flow exists | compliance | ADR-011: synthetic until `connections.consent_status = granted` |
| LLM cost runaway in scheduled runs | budget | per-tenant and per-run caps enforced by worker before start |
| Single-maintainer dependencies (pg-boss) | maintenance | pinned, small API surface, replaceable by Trigger.dev later |
| Knowledge promotion leaks client details | legal | mandatory reviewer, rights check, no back-reference, default deny |

## What can be built now versus what needs real connections

Now (synthetic): everything in M0–M4, including the full spec 11 demo flow. Needs real access: KPI values from Rentman/QuickBooks/Trengo/Dropbox, process evidence from real documents, baseline measurements for ROI.
