# Second Brain Business OS

Multi-tenant business transformation platform: specialised AI agents that diagnose a company, ask only the questions that close an evidence gap, redesign processes, build approved automations and monitor results. Three sealed workspaces: **Mission Control** (operators), **Client Workspace + Knowledge Vault** (per client), **Agency Intelligence Vault** (our methods and skills).

Status: **Milestone 1 in delivery.** Synthetic data only. No client system is connected. Agents run in the autonomous worker (`apps/worker`); without an `ANTHROPIC_API_KEY` they run in a clearly labelled simulated mode. See `docs/HANDOFF.md` for the exact implemented / simulated / not connected list.

## Quick start

```
cp .env.example .env
docker compose up -d postgres        # or use a local PostgreSQL 16 with role sbos/sbos and databases sbos_dev, sbos_test
pnpm install
pnpm db:migrate && pnpm db:seed
SBOS_ADMIN_EMAIL=you@example.com SBOS_ADMIN_PASSWORD='choose-a-long-password' pnpm bootstrap-admin   # first superadmin
pnpm --filter @sbos/web dev           # http://localhost:3000 (sign in, then enable TOTP under Account > Security)
pnpm worker:dev                       # autonomous worker: schedules, runs, approvals, notifications; /healthz on :8080
pnpm test                             # contracts, database isolation, core services, agents, web auth tests
pnpm autonomy:check                   # Autonomy Acceptance Test (needs the worker running)
```

## Repository map

| Path | What |
|---|---|
| `apps/web` | Next.js 16 app: Mission Control, Client Workspace, Agency Vault shells |
| `apps/worker` | Autonomous agent worker: pg-boss schedules and jobs, run executor with checkpoints, approval suspension, stall alarm, dead-letter, notifications, `/healthz` |
| `packages/core` | Domain services: runs and state machine, approvals, budgets and pricing, incidents, notifications, tasks, vault writes, `JobBackend` |
| `packages/agents` | `AgentRuntime` interface, Mastra adapter (Anthropic), simulated runtime, tool gateway, Discovery step |
| `packages/db` | Drizzle schema, SQL migrations with Row-Level Security, seed, isolation tests |
| `packages/contracts` | Zod 4 contracts (QuestionRequest, Finding, KpiDefinition, DashboardSpecification, …) + JSON Schema export |
| `docs/` | Architecture, ADRs, roadmap, milestones, agent runtime, security, research, cases |
| `legacy/lbr-intake` | Previous intake form, kept for reference, not deployed |

## Key documents

- `docs/PRODUCT_VISION.md`: what this is and is not
- `docs/ARCHITECTURE.md`: stack, tenancy model, agent model, vaults, surfaces
- `docs/agent-runtime.md`: autonomous worker design and the Autonomy Acceptance Test; latest report in `docs/reports/`
- `docs/auth.md`: sign-in, verification, invitations, MFA gate, break-glass
- `docs/deployment.md`: Railway setup, variables, backups, Docker Compose alternative
- `docs/DECISIONS.md`: ADR-001 … ADR-013
- `docs/research/github-assessment.md`: Build / Adopt / Integrate / Reject matrix with license warnings
- `docs/ROADMAP.md` and `docs/milestones/M1.md`: milestones, tickets, acceptance criteria
- `docs/cases/`: event rental, hospitality, professional services scenarios (synthetic)

## Principles

Default deny and database-level tenant isolation. Agents propose; humans approve risky actions. Every number has a source or shows "missing data". Claude Code is the development environment, never the runtime.
