# Backlog

Prioritised. Ticket detail for the active milestone lives in `docs/milestones/`. Status: `todo`, `doing`, `done`, `blocked`.

## M0 Foundation (doing)
- [x] Research matrix (`docs/research/github-assessment.md`)
- [x] Architecture, ADRs, roadmap, M1 plan
- [x] Monorepo scaffold, CI workflow
- [x] Migration 0001 + RLS + seed (two synthetic tenants)
- [x] Isolation tests (12)
- [x] Mission Control shell: Client Workspaces from DB, operator drill-down, client workspace page
- [x] Contracts package with tests (35)
- [x] Case documents A/B/C
- [x] Autonomous runtime requirement integrated (ADR-012, ADR-013, docs/agent-runtime.md)

## M1 Mission Control core (todo, awaiting approval)
See `docs/milestones/M1.md` tickets M1-01 … M1-15, including the autonomous worker and the Autonomy Acceptance Test.

## M2 Client Workspace + Knowledge Vault (todo)
- Migration 0003, Markdown editor with frontmatter, revisions and revert, backlinks, FTS, fact promotion flow, Interview Inbox, retrieval audit, forbidden-document search tests, Obsidian import/export.

## M3 Business X-Ray + CEO Dashboard (todo)
- Migration 0004, systems register UI, AS-IS/TO-BE maps, findings/opportunities with business case, KPI registry, dashboard renderer with widget whitelist, Executive Briefing, Management Action Center, CopilotKit spike.

## M4 Agency Intelligence Vault (backend done, UI in progress)
- Done: migration 0007, knowledge lifecycle with triggers, promotion requests/reviews gate, template adoptions with pinned versions and rollback, agency search isolation tests, agent nomination. Open: Mission Control module and /agency landing (in progress), Agency Knowledge Curator Agent (optional), consent-withdrawal review tooling.

## M5 Integrations + observability (in progress)
- Done: connection phases with consent and security review (trigger), sandbox connectors for Rentman, QuickBooks Online, Trengo and Dropbox, sync runs with lineage, secret references with masking, worker sync jobs. Open: Integration Center and Connected Tools UI (in progress), live read-only connectors (owner decisions: first system, sandbox vs pilot consent), Langfuse exporter (owner decision), pgvector RAG (ADR-019), pilot read-only run and acceptance report.

## M6 Hardening + Tech Intelligence + pilot (delivered except go-live)
- Done: Technology Intelligence Center (backend and UI), retention and deletion requests (backend and UI), security evaluation suite with agent boundary hardening (migration 0010), notification delivery fix, review and go-live checklists. Open: staging deploy and pilot go-live (needs Railway, API key, M5 owner decisions), reviewer-only deletion queue, Technology Intelligence agent for automatic assessment, pagination.

## Parking lot
- Graph view for the vault; Papiamentu locale; mobile layouts; CopilotKit Intelligence (paid) evaluation; Trigger.dev migration if pg-boss limits are hit; Paperclip re-assessment after code audit.
