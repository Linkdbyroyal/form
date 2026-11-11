# Live Agent Mission Control: visual proposals (first deliverable, 2026-11-11)

Three interactive prototypes on one synthetic simulation (`sim.js`): 3 synthetic clients, 21 agent instances, at least six runs active at once, scripted failures (model timeout with retries, denied tool call, budget cap), approvals, questions, incidents, pg-boss queues and schedules. The vocabulary is the real schema (`run_state`, `run_event_kind`, `task_state`, `approval_state`, `incident_kind`). No client content, no real company.

| Proposal | File | Published | Direction |
|---|---|---|---|
| A · Operations Deck | `A.html` | https://claude.ai/artifact/EYQV89TdyY9Qttw6hUcdS1 | dense, table-first, existing sidebar navigation |
| B · Flight Map | `B.html` | https://claude.ai/artifact/LmvTvcTjtgYPmpw7hG2mFb | the live agent map is the hero; top bar; inspector drawer |
| C · Command Queue | `C.html` | https://claude.ai/artifact/UtoCtk3c9nEiVD1SVPnTc7 | human intervention first; three lanes; per-agent timeline; map as overlay |
| **D · Composite (approved, ADR-024)** | `D.html` | https://claude.ai/artifact/KhTLnnzzPbmHzupXQ1DVBG | Queue (C) as landing tab, Map (B), Deck (A), Runs; shared inspector drawer; cyan live, amber attention, indigo structure |
| Comparison | `compare.html` | https://claude.ai/artifact/WUfjz3Agff2HFmuGvyiNpY | screenshots desktop and phone, tokens, decision table |

Local viewing: the pages are artifact fragments (no document skeleton); wrap them in `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>…</body></html>` or open the published links. Screenshots in `shots/` were taken with Playwright at 1280 px and 390 px (dark theme); checks: no horizontal overflow at either width, no console errors, approve and pause actions change the state.

Status wording: everything here is **simulated** (synthetic data) and **planned** (no change to the running architecture). Research and the recommended integration approach: `docs/research/live-mission-control.md`. Decision taken 2026-11-11: a combination of all three, recorded as ADR-024 and shown as `D.html`.
