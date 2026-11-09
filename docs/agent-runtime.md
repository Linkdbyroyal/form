# Autonomous Agent Runtime

Status: **design, mandatory requirement** (added 2026-11-09 on the owner's instruction). Implementation starts in Milestone 1 (`apps/worker`). Nothing in this document is implemented yet except the database foundation it builds on.

## 1. Principle

Claude Code is the development environment. It is never the runtime. Every agent runs as a process on Second Brain's own infrastructure, reaches the model through the Anthropic API with a server-side key, and keeps its state in our PostgreSQL. The platform keeps working when Claude Code is closed, the developer's computer is off, no administrator is logged in and no client has a dashboard open.

Anti-patterns this rules out: agents implemented as Claude Code sessions, skills or hooks; cron jobs on a developer laptop; state kept in a chat transcript; any "run this prompt manually every morning" procedure.

## 2. Runtime topology

```
                        ┌──────────────────────────────────────────────────────┐
  schedules (cron) ───► │ apps/worker  (long-running Node process, N replicas)  │
  events (webhooks,     │                                                      │
   KPI thresholds,      │  pg-boss queues: agent.run, agent.resume,            │
   new answers,         │  schedule.tick, stall.check, notify, connector.sync  │
   operator commands)   │                                                      │
                        │  RunExecutor ──► AgentRuntime (Mastra adapter)       │
                        │     │              │  tools via ToolGateway (authz)   │
                        │     │              │  model via Anthropic API         │
                        │     ▼              ▼                                 │
                        │  withTenant(ctx) ── PostgreSQL (RLS)                 │
                        │     agent_runs, run_events, checkpoints, approvals,  │
                        │     vault_*, kpi_observations, incidents, costs      │
                        └──────────────────────────────────────────────────────┘
                                   ▲                         │
                                   │ reads state             │ notifications (e-mail/Pumble/webhook)
                        ┌──────────┴───────────┐             ▼
                        │ apps/web (Next.js)    │   operators, client owners
                        │ Mission Control, API  │
                        └──────────────────────┘
```

- **apps/web** only writes intents (tasks, schedules, approvals, commands) to the database and enqueues jobs in the same transaction (pg-boss transactional enqueue). It never executes agents.
- **apps/worker** is the only process that executes agents. It is deployed as its own container with restart policy `always`, health endpoint, graceful shutdown and a lease per run.
- **PostgreSQL** holds everything: queue, schedules, run state, Mastra workflow snapshots, vault, KPIs, audit. One backup covers the whole system state.

## 3. Execution lifecycle

1. **Trigger**: a schedule tick (pg-boss cron per `schedules` row), an event (webhook endpoint in apps/web validates signature, stores `events` row, enqueues), or an operator command (Mission Control action). Every trigger is recorded on the run (`trigger_type`, `trigger_ref`).
2. **Admission**: the worker loads the `agent_instances` row inside `withTenant`, checks state (`active`), budget caps (tenant, instance, run), credential validity and policy. Failure to admit creates an `incidents` row and a notification; it never silently skips.
3. **Context assembly**: only authorised client context is loaded: vault facts and documents the instance's `allowed_paths` and classification permit, previous findings, task thread, connected-system metadata. Retrieval is logged in `retrieval_audit`.
4. **Execution**: the Mastra workflow runs step by step. Each tool call passes `ToolGateway.authorize(ctx, instance, tool, args)`; each step writes a `run_events` row (tool, input ref, output ref, tokens, cost, duration, `simulated` flag). A heartbeat updates `agent_runs.lease_expires_at` every 30 s.
5. **Questions and approvals**: missing information creates `questions` (Interview Inbox) and a help request; a high-impact action creates an `approvals` row. The workflow calls `suspend()`; the snapshot is persisted; the run moves to `waiting_for_input` or `waiting_for_approval`. The worker process holds nothing in memory for it.
6. **Resume**: answering the question or deciding the approval enqueues `agent.resume` with the run id; any worker replica picks it up and calls `resume()` with the decision as `resumeData`. Rejection ends the run as `cancelled` with reason.
7. **Completion**: outputs are validated against the contracts, written to the tenant's Knowledge Vault (as proposals or drafts per policy) and to domain tables; `AgentRunResult` is stored; Mission Control shows the run in Runs & Traces.
8. **Failure**: exceptions are classified (`retryable`, `credential`, `policy`, `model`, `bug`). Retryable failures use exponential backoff with jitter (pg-boss), bounded attempts; exhausted retries go to the dead-letter queue and create an incident. Non-retryable failures create an incident immediately. Partial writes are inside transactions; checkpoints make re-execution idempotent (`idempotency_key` per step).
9. **Recovery after crash or deploy**: on start, each worker scans `agent_runs` in `running` with `lease_expires_at < now()`, marks them `interrupted`, and re-enqueues from the last checkpoint. Snapshots live in Postgres, so a redeploy loses no state.
10. **Stall alarm**: a `stall.check` job runs every 5 minutes: any schedule with `expected_by < now()` and no run, or any run in `running` past its lease, becomes an incident. Silence is never success.

## 4. Scheduling model

`schedules(tenant_id, agent_instance_id, cron, timezone, enabled, expected_by_offset, last_run_at, next_run_at, misfire_policy)`. The worker registers one pg-boss cron per enabled schedule and reconciles on change (Mission Control edit → DB row → `schedule.reconcile` job). Defaults per agent are configurable, not fixed product claims (Finance daily, Operations hourly in working hours, Sales daily, HR weekly, CEO briefing each working day, Quality weekly, Technology Intelligence twice weekly). Misfire policy: `skip` (default) or `run_once_late`; never backfill blindly.

## 5. Inter-agent communication

Agents do not call each other in-process. An agent emits a `hand_off` output (contract: `Finding`, `QuestionRequest`, `Opportunity` with `target_agent`), the orchestrator agent or a routing rule creates an `agent_tasks` row for the target instance, and the target runs under its own authorisation. Every hand-off is a row with sources, uncertainties and decisions, visible in Mission Control.

## 6. Technology decision for the backbone

Evaluated (details and sources in `docs/research/github-assessment.md` and `docs/research/durable-execution.md`): Temporal, Trigger.dev, Inngest, Hatchet, Mastra workflows, LangGraph, pg-boss, Anthropic Managed Agents.

Decision (ADR-013): **Phase 1 (M1–M4): pg-boss + Mastra workflows on PostgreSQL**, behind a `JobBackend` interface. Reasons: one stateful dependency; transactional enqueue with our domain writes; cron, retries, dead-letter and group concurrency; Mastra provides durable suspend/resume snapshots in the same database; MIT/Apache licenses; a two-person team can operate it.

**Upgrade path**: if we need multi-week workflows with code versioning across many workflow types, or throughput beyond a single worker pool, we move the `JobBackend` to Temporal Cloud (MIT SDK, consumption pricing) or self-hosted Hatchet (MIT, Postgres + RabbitMQ). Anthropic Managed Agents (beta) are not the backbone: no verified approval-gate or event-trigger primitive, 1,000 scheduled deployments per organisation, not eligible for zero-data-retention; they may later serve as an optional execution sandbox for individual tool-heavy tasks.

## 7. Production infrastructure (pilot)

| Component | Pilot | Later |
|---|---|---|
| Compute | one VM (4 vCPU/8 GB) running Docker Compose: `web`, `worker` (2 replicas), `postgres`, `minio`, `caddy` | Fly.io / Railway / Kubernetes with separate worker pool |
| Database | PostgreSQL 16 + pgvector, daily base backup + WAL archiving, PITR tested quarterly | managed Postgres |
| Secrets | Docker secrets / SOPS-encrypted env; connector credentials sealed with libsodium, key outside the DB | cloud secret manager |
| Monitoring | `/api/health` (web), `/healthz` (worker), pg-boss metrics, incidents table, uptime ping from outside, alert on missed stall-check | OTel → Langfuse / Grafana |
| Logging | structured JSON with `tenant_id`, `run_id`; secrets and confidential payloads masked at the logger | central log store with tenant tagging |
| Notifications | e-mail (Resend) and optional chat webhook for critical incidents and pending approvals | per-tenant channels |

## 8. Mission Control requirements covered

View all registered agents and their state; running / waiting / completed / failed; tasks across clients; assign instructions; pause, resume, cancel permitted tasks; execution history and results; approve proposed actions; usage and costs; notifications for critical issues. These map to tickets M1-06 to M1-09 and to the `MissionControlSummary` contract.

## 9. Autonomy Acceptance Test (mandatory, runs at the end of M1 and again before pilot)

1. In Mission Control, schedule the Discovery agent for tenant A (synthetic) to run in 2 minutes.
2. Verify the `schedules` and `agent_tasks` rows exist.
3. Close Claude Code and the developer session completely. Only the production containers run.
4. The worker starts the run on time (trigger recorded as `schedule`).
5. The run loads only tenant A context (`retrieval_audit` shows tenant A rows only).
6. The agent produces `QuestionRequest`s validated against the contract.
7. Results are written to tenant A's Knowledge Vault (`13_interviews_and_open_questions/`), not to tenant B or the agency vault.
8. Mission Control shows the run, its trace and cost in Runs & Traces.
9. A deliberately failing schedule (invalid credential fixture) ends in dead-letter and an incident with a notification.
10. Restart the worker container mid-run; the run resumes from its checkpoint; the system continues without any developer session.

The test is scripted (`scripts/autonomy-check.ts`, M1-13) so it can be re-run after every deploy. Steps 3 and 10 are recorded as an operations checklist with timestamps.
