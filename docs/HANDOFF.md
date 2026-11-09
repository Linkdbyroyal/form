# Handoff

Last updated: 2026-11-09 (Milestone 0 delivery, branch `claude/second-brain-os-architecture-ovfky3`).

## Implemented and verified

| Item | Evidence |
|---|---|
| Monorepo (pnpm 10, Turborepo, TypeScript strict) with `apps/web`, `packages/db`, `packages/contracts` | `pnpm install`, `pnpm -r typecheck` green |
| Migration 0001: tenants, users, roles, memberships, client_content_grants, audit_events, departments, systems; RLS enabled and forced on every tenant table and on users; NOLOGIN roles `sbos_app` and `sbos_operator`; column-level grants hide `systems.notes` from operators; audit table append-only | `packages/db/migrations/0001_core.sql`; 12 isolation tests green (`packages/db/test/isolation.test.ts`) |
| `withContext()` transaction wrapper with `SET LOCAL ROLE` and `set_config` per request; fail-closed when context missing; no context leak across pooled connections | tests `fail closed`, `does not leak` |
| Seed: agency tenant + two synthetic demo tenants (Northline Events, Harbour View Hotel), four users, departments, claimed systems | `pnpm db:seed` |
| Contracts package: 17 Zod 4 contracts with agent output envelope, JSON Schema export | 35 tests green |
| Web: landing, Mission Control shell (Overview with live counters, Client Workspaces, operator drill-down), Client Workspace page in tenant context with audit write, Agency Vault placeholder, `/api/health` | `next build` green; smoke test: all routes 200, unknown tenant 404, operator page contains no `notes`, tenant A page contains no tenant B systems |
| Design tokens (Second Brain palette) in `apps/web/app/globals.css` | rendered pages |
| CI workflow (GitHub Actions with pgvector Postgres service) | `.github/workflows/ci.yml` (not yet executed on GitHub at time of writing) |
| Documentation: vision, architecture, 13 ADRs, roadmap, M1 plan with 15 tickets, data model, agent registry, security, agent runtime design, research matrix, durable execution comparison, three cases | `docs/` |

## Simulated or placeholder

| Item | Note |
|---|---|
| Authentication | none; every request is the development operator (`apps/web/lib/request-context.ts`); banner shown; replaced in M1-01 |
| Mission Control modules Agents, Tasks, Runs, Approvals, Skills, Schedules, Costs, Errors, Tools, Agency Vault | placeholder pages stating the milestone; no mock data |
| Client Workspace sub-pages (dashboard, x-ray, inbox, actions, agents, integrations, vault) | navigation only; routes not created yet |

## Not connected

Rentman, QuickBooks, Trengo, Pumble, Dropbox, Make, Google Sheets, any LLM call. `systems.claim_status` is `stated` for every seeded row.

## Not yet built (next)

`apps/worker`, `packages/core`, `packages/agents`, migration 0002, Mastra adapter, pg-boss scheduler, approvals, incidents, notifications, Autonomy Acceptance Test script. All in `docs/milestones/M1.md`.

## Tests run in this session

- `pnpm -r typecheck`: 3 packages pass.
- `packages/db`: 12/12 pass against local PostgreSQL 16.15 (`sbos_test`).
- `packages/contracts`: 35/35 pass.
- `apps/web`: production build passes; HTTP smoke test of 10 routes passes.

## Known gaps and risks

- pgvector is not installed in the sandbox Postgres (apt package unavailable, source build denied); Docker image `pgvector/pgvector:pg16` covers local and CI. Needed from M2.
- `legacy/lbr-intake/server.js` has a hard-coded admin token fallback; not deployed, fix before any reuse.
- Better Auth not yet verified (spike M1-01).
- CI workflow has not run on GitHub yet; first push will show.

## How to resume

1. `cp .env.example .env`, start Postgres, `pnpm install`, `pnpm db:migrate && pnpm db:seed`, `pnpm --filter @sbos/web dev`.
2. Read `docs/milestones/M1.md`, start with M1-03 (migration 0002) and M1-06 (worker) in parallel with M1-01 (auth).
