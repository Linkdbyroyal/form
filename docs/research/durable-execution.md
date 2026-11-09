# Durable Execution Backbone: options verified 2026-11-09

Companion to `github-assessment.md`. Sources were the GitHub repos, official docs and pricing pages listed at the end. "Could not verify" marks statements the pages did not make.

| Option | License | Self-host footprint | Scheduling / approval primitives | Fit for us (1–2 engineers, <10 tenants) |
|---|---|---|---|---|
| **pg-boss 12.38.1** | MIT | Postgres only | cron + RRULE, retries with backoff, dead-letter, transactional enqueue (Drizzle adapter), group concurrency; approval = our `approvals` row + resume job | **Chosen for phase 1** |
| **Mastra workflows 1.82** | Apache-2.0 core | uses our Postgres (`@mastra/pg`) | `suspend()/resume()` with schemas, snapshots survive restarts, `.sleep()/.sleepUntil()` | **Chosen** for in-run durability and approval suspension |
| **Temporal 1.32.2 server / TS SDK** | MIT (server and SDK) | 4 services (frontend, history, matching, worker) + Postgres/MySQL/Cassandra, Elasticsearch optional since 1.20; dev server is one binary | Schedules with backfill, Signals/Updates for approvals, timers for months, retries, namespaces; Worker Versioning in preview | Upgrade path. Temporal Cloud: $50 per million actions pay-as-you-go, $150 credits for 90 days; "Small" workloads under $50/month by vendor estimate |
| **Trigger.dev 4.8.3** | Apache-2.0 | Postgres + Redis + ClickHouse 25.8+ + registry + object storage + worker fleet | cron, `wait.*`, waitpoints incl. webhook waiters, retries, idempotency | Rejected for MVP (ops weight); cloud is an option later |
| **Inngest** | Server: SSPL with delayed Apache-2.0 (DOSP); SDKs Apache-2.0 | single binary (SQLite dev) or Postgres 17 + Redis 7; no guaranteed support for self-host | cron, `waitForEvent`, steps, retries | License (SSPL) makes self-hosting inside a commercial SaaS a legal review item; cloud is viable |
| **Hatchet** | MIT | API + engine + Postgres (+ RabbitMQ in Compose), "Lite" single image for low throughput | durable tasks, cron, durable sleep, event waits, multi-tenancy by default | Lightest self-hosted alternative to Temporal if pg-boss is outgrown |
| **Anthropic Managed Agents (beta)** | n/a (service) | none; optional self-hosted sandbox worker (`ant beta:worker poll`) | cron scheduled deployments with jitter up to 15%, max 1,000 per org, missed triggers not backfilled, webhooks for lifecycle; no verified approval or inbound-event primitive; not ZDR/HIPAA eligible; pricing could not verify | Not the backbone. Possible later as an execution sandbox for individual tasks |
| **LangGraph Agent Server** | MIT library; server needs LangSmith license key | Postgres + Redis + license beacon | interrupts, checkpointers | Rejected (ADR-003) |

## Decision summary (ADR-013)

Phase 1 uses pg-boss and Mastra on one PostgreSQL. The `JobBackend` interface in `packages/core` (enqueue, schedule, cancel, lease, dead-letter) is the only place that knows about pg-boss; `AgentRuntime` is the only place that knows about Mastra. Review the decision when any of these occurs: more than 10 active tenants, workflows longer than 7 days that need code versioning, more than one worker pool, or a client requiring a vendor-supported workflow engine. Candidates at that point: Temporal Cloud, self-hosted Hatchet.

## Sources
Temporal: github.com/temporalio/temporal (+ releases/latest), github.com/temporalio/sdk-typescript, docs.temporal.io/temporal-service/temporal-server.md, docs.temporal.io/temporal-service/persistence.md, temporal.io/pricing, docs.temporal.io/cloud/pricing.md. Anthropic: platform.claude.com/docs/en/managed-agents/overview, /scheduled-deployments, /self-hosted-sandboxes. Inngest: github.com/inngest/inngest, inngest.com/docs/self-hosting. Hatchet: github.com/hatchet-dev/hatchet, docs.hatchet.run/self-hosting. pg-boss, Trigger.dev, Mastra, LangGraph: see github-assessment.md.
