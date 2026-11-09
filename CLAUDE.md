# Working agreements for this repository

- Product spec: Second Brain Masterprompt V3 (owner-provided). Architecture: `docs/ARCHITECTURE.md`. Decisions: `docs/DECISIONS.md` (append ADRs, never rewrite history).
- Communicate with the owner in Dutch. Code, UI labels, file names and technical docs are English. No em dashes in prose.
- Never present mock data as a working feature. Every UI surface and every delivery states: implemented, simulated, not connected or planned.
- Tenant isolation is enforced in PostgreSQL (RLS). All data access goes through `withContext()` from `@sbos/db`. New tables need RLS policies and an isolation test; the schema guard test fails otherwise.
- Claude Code is the development environment, never the runtime (ADR-012). Agents run in `apps/worker`.
- Pinned dependencies; upgrades go through an `UpgradeProposal` with tests. Never import `@mastra/core/*/ee`.
- Synthetic data only until a tenant's `connections.consent_status` is `granted` (ADR-011).
- Commands: `pnpm typecheck`, `pnpm test` (needs Postgres), `pnpm --filter @sbos/web build`.
- Keep `docs/HANDOFF.md` current at the end of every work session.
