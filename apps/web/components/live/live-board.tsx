"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge, Empty, Status, inputClass, type Tone } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { Notice, ShortId, SimulatedBadge, StateBadge, TriggerBadge, selectClass, smallButtonClass, smallDangerClass, smallPrimaryClass } from "@/components/agent-ui";
import { fmtInt, fmtUsd } from "@/lib/format";
import { decideApprovalAction, incidentAction, instructRunAction, stopRunAction } from "@/lib/mission-control/actions";
import {
  EMPTY_FILTERS,
  RUN_STATES,
  buildRunList,
  buildTimeline,
  connectionLabel,
  filterOptions,
  fmtAgo,
  fmtClock,
  fmtClockSeconds,
  fmtRunDuration,
  groupRuns,
  isRunState,
  liveReturnTo,
  parseLiveTab,
  type LaneFilters,
  type LiveRun,
  type LiveRunState,
  type LiveSnapshot,
  type LiveTab,
  type RunListRow
} from "@/lib/live/helpers";
import type { GraphNode } from "@/lib/live/graph";
import { communicationRows, latestRunForAgent, mapCounts } from "@/lib/live/map";
import { agentsForDepartment, approvalMatchesDepartment } from "@/lib/live/deck";
import { useLiveSnapshot } from "@/lib/live/use-live";
import { FlightMap, FlightMapLegend, useFlightMapModel } from "./flight-map";
import { OperationsDeck } from "./operations-deck";
import { RunInspector } from "./run-inspector";

/**
 * Live board (ADR-024 composite D). Tab 1 Command Queue (slice 1): three lanes, a per-agent timeline and a status
 * strip. Tab 2 Flight Map (slice 3): the agent graph with the same drawer. Tab 3 Operations Deck (slice 4): agents
 * table, event ticker, workers and schedules. Tab 4 Runs (slice 2): run list plus the shared inspector drawer. The
 * filter strip (client, department, definition, state) applies on every tab; the department travels in the URL.
 * Every control posts to an existing audited server action; the board itself only reads the operator snapshot.
 * Cyan = live activity, amber (warning) = needs a human, indigo = structure and selection.
 */
const SEGMENT_CLASS: Record<LiveRunState, string> = {
  running: "bg-cyan",
  queued: "bg-indigo",
  waiting_for_approval: "bg-warning",
  waiting_for_input: "bg-warning",
  paused: "bg-muted",
  interrupted: "bg-warning",
  succeeded: "bg-success",
  failed: "bg-danger",
  timed_out: "bg-danger",
  cancelled: "bg-faint"
};

export function LiveBoard({
  initial,
  ok,
  error,
  operatorRoles,
  initialTab = "queue",
  initialRunId = null,
  initialDepartment = null
}: {
  initial: LiveSnapshot;
  ok: string | null;
  error: string | null;
  operatorRoles: string[];
  initialTab?: LiveTab;
  initialRunId?: string | null;
  initialDepartment?: string | null;
}) {
  const { snapshot, connection, lastUpdate, retryInMs } = useLiveSnapshot(initial);
  const [filters, setFilters] = useState<LaneFilters>({ ...EMPTY_FILTERS, department: initialDepartment });
  const [tab, setTab] = useState<LiveTab>(initialTab);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialRunId);
  // "now" is the snapshot time, so server and client render the same relative times (no hydration drift).
  const now = useMemo(() => new Date(snapshot.generatedAt), [snapshot.generatedAt]);
  const options = useMemo(() => filterOptions(snapshot), [snapshot]);
  const lanes = useMemo(() => groupRuns(snapshot, filters), [snapshot, filters]);
  const runList = useMemo(() => buildRunList(snapshot, filters), [snapshot, filters]);
  const timeline = useMemo(() => buildTimeline(snapshot.timeline, now), [snapshot.timeline, now]);
  const approvals = snapshot.needsYou.approvals.filter((a) => (!filters.tenantId || a.tenantId === filters.tenantId) && approvalMatchesDepartment(a, filters.department, snapshot.agents));
  const incidents = snapshot.needsYou.incidents;
  // Questions carry their own department (granted column); the filter narrows the per-department counts.
  const questions = snapshot.needsYou.questions
    .filter((q) => !filters.tenantId || q.tenantId === filters.tenantId)
    .map((q) => (filters.department ? { ...q, byDepartment: q.byDepartment.filter((d) => d.department === filters.department), count: q.byDepartment.filter((d) => d.department === filters.department).reduce((n, d) => n + d.count, 0) } : q))
    .filter((q) => q.count > 0);
  const needsCount = approvals.length + incidents.length + lanes.failed.length + questions.length;
  const s = snapshot.summary.runs;
  const waiting = s.waiting_for_approval + s.waiting_for_input;
  const filtered = filters.tenantId !== null || filters.definitionKey !== null || filters.state !== null || filters.department !== null;
  const deckAgents = agentsForDepartment(snapshot.agents, filters.department).filter((a) => (!filters.tenantId || a.tenantId === filters.tenantId) && (!filters.definitionKey || a.definitionKey === filters.definitionKey)).length;
  const returnTo = liveReturnTo(tab, selectedRunId, filters.department);
  const drawerOpen = selectedRunId !== null || tab === "runs";

  // `#runs` in the address bar (the composite's deep link) selects the tab on first paint.
  useEffect(() => {
    if (window.location.hash) {
      const fromHash = parseLiveTab(window.location.hash);
      if (fromHash !== "queue") setTab(fromHash);
    }
  }, []);

  // Keep the address bar in step with the tab and the open drawer, so a reload or a server action redirect lands here again.
  // A notice (`ok=`, `error=`) is dropped from the URL on purpose: it is already rendered and should not survive a reload.
  useEffect(() => {
    const target = liveReturnTo(tab, selectedRunId, filters.department);
    const current = `${window.location.pathname}${window.location.search}`;
    if (current !== target) window.history.replaceState(window.history.state, "", target);
  }, [tab, selectedRunId, filters.department]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedRunId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openRun = useCallback((id: string) => setSelectedRunId(id), []);
  const closeRun = useCallback(() => setSelectedRunId(null), []);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Live</h1>
          <p className="text-sm text-muted">
            Agents across clients in real time: what needs you, what is running, what finished today, and the inspector for any run. Snapshot first, then a server-sent event stream fed by PostgreSQL notifications; RLS and the operator column grants decide what is shown. <Status state="implemented" />
          </p>
        </div>
        <ConnectionPill connection={connection} lastUpdate={lastUpdate} retryInMs={retryInMs} mode={snapshot.platform.mode} now={now} />
      </header>

      <Notice ok={ok} error={error} />

      <nav aria-label="Live tabs" className="flex flex-wrap gap-1 text-sm">
        <TabButton active={tab === "queue"} onClick={() => setTab("queue")}>
          Queue {needsCount > 0 ? <span className="ml-1 font-mono text-[11px] text-warning">{needsCount}</span> : null}
        </TabButton>
        <TabButton active={tab === "map"} onClick={() => setTab("map")}>
          Map {s.running > 0 ? <span className="ml-1 font-mono text-[11px] text-cyan">{s.running}</span> : null}
        </TabButton>
        <TabButton active={tab === "deck"} onClick={() => setTab("deck")}>
          Deck <span className="ml-1 font-mono text-[11px] text-muted">{deckAgents}</span>
        </TabButton>
        <TabButton active={tab === "runs"} onClick={() => setTab("runs")}>
          Runs <span className="ml-1 font-mono text-[11px] text-muted">{runList.length}</span>
        </TabButton>
      </nav>

      <div className="flex flex-wrap gap-2" aria-label="Counts">
        <Stat label="running" value={s.running} tone="cyan" />
        <Stat label="queued" value={s.queued} />
        <Stat label="waiting for a human" value={waiting} tone={waiting > 0 ? "warning" : "neutral"} />
        <Stat label="paused" value={s.paused} />
        <Stat label="failed, 24 h" value={s.failed + s.timed_out} tone={s.failed + s.timed_out > 0 ? "danger" : "neutral"} />
        <Stat label="succeeded, 24 h" value={s.succeeded} tone="success" />
        <Stat label="open approvals" value={snapshot.summary.pendingApprovals} tone={snapshot.summary.pendingApprovals > 0 ? "warning" : "neutral"} />
        <Stat label="open questions" value={snapshot.summary.openQuestions} tone={snapshot.summary.openQuestions > 0 ? "warning" : "neutral"} />
        <Stat label="incidents" value={snapshot.summary.openIncidents} tone={snapshot.summary.openIncidents > 0 ? "danger" : "neutral"} />
        <Stat label="agents" value={snapshot.agents.length} />
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1 text-muted">
          <span className="sr-only">Client</span>
          <select aria-label="Client" className={selectClass} value={filters.tenantId ?? ""} onChange={(e) => setFilters({ ...filters, tenantId: e.target.value || null })}>
            <option value="">All clients</option>
            {options.tenants.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>
        <select aria-label="Department" className={selectClass} value={filters.department ?? ""} onChange={(e) => setFilters({ ...filters, department: e.target.value || null })}>
          <option value="">All departments</option>
          {options.departments.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <select aria-label="Agent definition" className={selectClass} value={filters.definitionKey ?? ""} onChange={(e) => setFilters({ ...filters, definitionKey: e.target.value || null })}>
          <option value="">All agent definitions</option>
          {options.definitions.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <select aria-label="Run state" className={selectClass} value={filters.state ?? ""} onChange={(e) => setFilters({ ...filters, state: isRunState(e.target.value) ? e.target.value : null })}>
          <option value="">All states</option>
          {RUN_STATES.map((st) => (
            <option key={st} value={st}>{st.replaceAll("_", " ")}</option>
          ))}
        </select>
        {filtered ? (
          <button type="button" className={smallButtonClass} onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</button>
        ) : null}
        <span className="text-faint">Filters apply on every tab: runs and schedules through the agent definition's department, approvals through their run's agent; incidents are platform-wide.</span>
      </div>

      <div className={drawerOpen ? "grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]" : ""}>
        <div className="min-w-0 space-y-5">
          {tab === "queue" ? (
            <>
              <div className={`grid gap-4 ${drawerOpen ? "xl:grid-cols-3" : "lg:grid-cols-3"}`}>
                <Lane title="Needs you" count={needsCount} tone="warning">
                  {needsCount === 0 ? <Empty>Nothing needs you. Agents keep working.</Empty> : null}
                  {approvals.map((a) => (
                    <LaneCard key={a.id} accent="warning" title={`Approve: ${a.summary}`}>
                      <div className="text-xs text-muted">
                        {a.agentName ?? "agent"} for {a.tenantName} · <StateBadge kind="risk" value={a.risk} /> · needs {a.approverRole} · waiting since {fmtAgo(a.createdAt, now)}
                        {a.blocking ? <> · <Badge tone="warning">blocking</Badge></> : null}
                      </div>
                      {a.operatorMayDecide ? (
                        <form action={decideApprovalAction} className="flex flex-wrap items-center gap-1">
                          <input type="hidden" name="tenantId" value={a.tenantId} />
                          <input type="hidden" name="approvalId" value={a.id} />
                          <input type="hidden" name="returnTo" value={returnTo} />
                          <input name="note" placeholder="note (optional)" maxLength={1000} className={`${inputClass} w-40 py-1 text-xs`} />
                          <button type="submit" name="decision" value="approved" className={smallPrimaryClass}>Approve</button>
                          <ConfirmButton name="decision" value="rejected" message="Reject this approval? The suspended run will be cancelled." className={smallDangerClass}>Reject</ConfirmButton>
                          {!operatorRoles.includes(a.approverRole) && !operatorRoles.includes("superadmin") ? <span className="text-[11px] text-faint">your roles do not include {a.approverRole}</span> : null}
                        </form>
                      ) : (
                        <div className="text-xs text-muted">
                          Client decision ({a.approverRole}): <Link href={`/c/${a.tenantSlug}/approvals/${a.id}`} className="underline">open in client workspace</Link>
                        </div>
                      )}
                      <CardFooter>
                        {a.runId ? (
                          <button type="button" className="underline" onClick={() => openRun(a.runId!)}>inspect run <ShortId id={a.runId} /></button>
                        ) : (
                          "no run"
                        )}
                      </CardFooter>
                    </LaneCard>
                  ))}
                  {questions.map((q) => (
                    <LaneCard key={q.tenantId} accent="warning" title={`${q.count} open question${q.count === 1 ? "" : "s"} for ${q.tenantName}`}>
                      <div className="text-xs text-muted">
                        {q.byDepartment.map((d) => `${d.department}: ${d.count}`).join(" · ")}
                      </div>
                      <div className="text-xs text-faint">Question text is client content; client staff answer in their Interview Inbox.</div>
                      <CardFooter><Link href={`/mission-control/clients/${q.tenantSlug}`} className="underline">open client</Link></CardFooter>
                    </LaneCard>
                  ))}
                  {lanes.failed.map((r) => (
                    <LaneCard key={r.id} accent="danger" title={`Run ${r.state.replaceAll("_", " ")}: ${r.errorCode ?? "unknown error"}`}>
                      <div className="text-xs text-muted">{r.agentName} for {r.tenantName} · {fmtAgo(r.finishedAt, now)}</div>
                      {r.summary ? <div className="text-xs text-muted">{r.summary}</div> : null}
                      <div className="flex gap-2">
                        <button type="button" className={smallButtonClass} onClick={() => openRun(r.id)} aria-pressed={selectedRunId === r.id}>Inspect</button>
                      </div>
                    </LaneCard>
                  ))}
                  {incidents.map((i) => (
                    <LaneCard key={i.id} accent="danger" title={`Incident: ${i.kind.replaceAll("_", " ")}`}>
                      <div className="text-sm">{i.title}</div>
                      <div className="text-xs text-muted">
                        {i.tenantName ?? "platform"} · <StateBadge kind="incident" value={i.state} /> · {i.severity} · {fmtAgo(i.createdAt, now)}
                      </div>
                      <form action={incidentAction} className="flex flex-wrap gap-1">
                        <input type="hidden" name="incidentId" value={i.id} />
                        <input type="hidden" name="returnTo" value={returnTo} />
                        {i.state === "open" ? <button type="submit" name="action" value="acknowledge" className={smallButtonClass}>Acknowledge</button> : null}
                        <ConfirmButton name="action" value="resolve" message="Resolve this incident?" className={smallPrimaryClass}>Resolve</ConfirmButton>
                        {i.runId ? <button type="button" className={smallButtonClass} onClick={() => openRun(i.runId!)}>Inspect run</button> : null}
                      </form>
                    </LaneCard>
                  ))}
                </Lane>

                <Lane title="Running" count={lanes.running.length} tone="cyan">
                  {lanes.running.length === 0 ? <Empty>No active runs{filtered ? " match the filters" : ""}. Runs start from schedules, Run now or an assigned task.</Empty> : null}
                  {lanes.running.map((r) => (
                    <RunCard key={r.id} run={r} now={now} returnTo={returnTo} selected={selectedRunId === r.id} onInspect={openRun} />
                  ))}
                </Lane>

                <Lane title="Done today" count={lanes.done.length} tone="success">
                  {lanes.done.length === 0 ? <Empty>Nothing finished in the last 24 hours{filtered ? " for these filters" : ""}.</Empty> : null}
                  {lanes.done.map((r) => (
                    <LaneCard key={r.id} accent={r.state === "succeeded" ? "success" : "neutral"} title={r.summary ?? `${r.agentName} run ${r.state}`}>
                      <div className="text-xs text-muted">
                        <StateBadge kind="run" value={r.state} /> · {r.agentName} for {r.tenantName} · {fmtAgo(r.finishedAt, now)} · {fmtUsd(r.costUsd)} · <SimulatedBadge simulated={r.simulated} />
                      </div>
                      <CardFooter>
                        <button type="button" className="underline" onClick={() => openRun(r.id)} aria-pressed={selectedRunId === r.id}>inspect</button>
                      </CardFooter>
                    </LaneCard>
                  ))}
                </Lane>
              </div>

              <section className="sb-card p-4">
                <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold">Last 45 minutes, per agent</h2>
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                    <Legend className="bg-cyan" label="running" /><Legend className="bg-indigo" label="queued" /><Legend className="bg-warning" label="waiting" /><Legend className="bg-success" label="done" /><Legend className="bg-danger" label="failed" />
                    <Status state="implemented" />
                  </div>
                </header>
                {timeline.tracks.length === 0 ? (
                  <Empty>No state changes in the last 45 minutes.</Empty>
                ) : (
                  <div className="grid grid-cols-[minmax(0,120px)_1fr] gap-x-3 gap-y-1.5 text-xs sm:grid-cols-[minmax(0,200px)_1fr]">
                    {timeline.tracks.map((t) => (
                      <TrackRow key={t.agentInstanceId} label={t.label} segments={t.segments} onInspect={openRun} />
                    ))}
                    <div />
                    <div className="flex justify-between text-[11px] text-faint">
                      <span>{fmtClock(timeline.start)}</span>
                      <span>now {fmtClock(timeline.end)}</span>
                    </div>
                  </div>
                )}
                <p className="mt-3 text-[11px] text-faint">Segments come from state_change events; the state of an earlier event is read from its summary because event payloads are content the operator role cannot read. Click a segment to inspect its run.</p>
              </section>
            </>
          ) : null}

          {tab === "runs" ? <RunsPanel rows={runList} now={now} selectedRunId={selectedRunId} onSelect={openRun} filtered={filtered} stateFilter={filters.state} /> : null}

          {tab === "map" ? <MapPanel snapshot={snapshot} filters={filters} now={now} selectedRunId={selectedRunId} onSelect={openRun} /> : null}
          {tab === "deck" ? <OperationsDeck snapshot={snapshot} filters={filters} now={now} selectedRunId={selectedRunId} onSelect={openRun} returnTo={returnTo} /> : null}
        </div>

        {drawerOpen ? (
          selectedRunId ? (
            <RunInspector key={selectedRunId} runId={selectedRunId} refreshKey={snapshot.generatedAt} now={now} returnTo={returnTo} operatorRoles={operatorRoles} onClose={closeRun} onSelectRun={openRun} />
          ) : (
            <aside className="sb-card p-4 lg:sticky lg:top-4 lg:self-start" aria-label="Run inspector">
              <header className="mb-2 flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">Inspector</h2>
                <Status state="implemented" />
              </header>
              <p className="text-sm text-muted">Click a run in the list, an Inspect button on the Queue, a timeline segment, an agent on the Map or a run or event on the Deck to open it here: steps, metadata, controls, instructions and the event feed.</p>
              <p className="mt-2 text-[11px] text-faint">The drawer re-reads the run whenever a new snapshot arrives. Escape closes it.</p>
            </aside>
          )
        ) : null}
      </div>
    </div>
  );
}

// Runs tab ------------------------------------------------------------------------------------

function RunsPanel({ rows, now, selectedRunId, onSelect, filtered, stateFilter }: { rows: RunListRow[]; now: Date; selectedRunId: string | null; onSelect: (id: string) => void; filtered: boolean; stateFilter: LiveRunState | null }) {
  const note = stateFilter === "failed" || stateFilter === "timed_out" ? "Failed and timed out runs of the last 24 hours." : "Alive runs and runs finished in the last 24 hours. Choose state failed or timed out to list failures.";
  return (
    <section className="sb-card min-w-0 overflow-hidden" aria-label="Runs">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">Runs</h2>
        <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted">{rows.length}</span>
        <span className="hidden text-[11px] text-faint sm:inline">{note}</span>
        <span className="ml-auto"><Status state="implemented" /></span>
      </header>
      {rows.length === 0 ? (
        <div className="p-3"><Empty>No runs{filtered ? " match the filters" : " in the last 24 hours"}.</Empty></div>
      ) : (
        <>
          <div className="hidden max-h-[70vh] overflow-auto md:block">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-surface text-left text-[11px] uppercase tracking-wide text-faint">
                <tr>
                  <th className="px-3 py-2 font-medium">Run</th>
                  <th className="py-2 pr-2 font-medium">Agent</th>
                  <th className="py-2 pr-2 font-medium">Client</th>
                  <th className="hidden py-2 pr-2 font-medium 2xl:table-cell">Trigger</th>
                  <th className="py-2 pr-2 font-medium">State</th>
                  <th className="py-2 pr-2 text-right font-medium">Tools</th>
                  <th className="py-2 pr-2 text-right font-medium">Model</th>
                  <th className="py-2 pr-2 text-right font-medium">Cost</th>
                  <th className="py-2 pr-2 text-right font-medium">Duration</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const selected = r.id === selectedRunId;
                  return (
                    <tr
                      key={r.id}
                      tabIndex={0}
                      role="button"
                      aria-pressed={selected}
                      onClick={() => onSelect(r.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSelect(r.id);
                        }
                      }}
                      className={`cursor-pointer border-t border-border align-middle outline-none hover:bg-cyan/5 focus-visible:bg-cyan/10 ${selected ? "bg-indigo/20" : ""}`}
                    >
                      <td className="whitespace-nowrap px-3 py-2"><ShortId id={r.id} /> {r.simulated ? null : <Badge tone="success">live</Badge>}</td>
                      <td className="py-2 pr-2">{r.agentName}</td>
                      <td className="py-2 pr-2 text-muted">{r.tenantName}</td>
                      <td className="hidden py-2 pr-2 2xl:table-cell"><TriggerBadge trigger={r.trigger} /></td>
                      <td className="py-2 pr-2"><StateBadge kind="run" value={r.state} />{r.errorCode ? <span className="ml-1 font-mono text-[11px] text-danger">{r.errorCode}</span> : null}</td>
                      <td className="py-2 pr-2 text-right font-mono tabular-nums">{fmtInt(r.toolCalls)}</td>
                      <td className="py-2 pr-2 text-right font-mono tabular-nums">{fmtInt(r.modelCalls)}</td>
                      <td className="whitespace-nowrap py-2 pr-2 text-right font-mono tabular-nums">{fmtUsd(r.costUsd)}</td>
                      <td className="whitespace-nowrap py-2 pr-2 text-right font-mono tabular-nums" title={r.startedAt ? `started ${fmtAgo(r.startedAt, now)}` : "not started"}>{fmtRunDuration(r.startedAt, r.finishedAt, now)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="flex flex-col gap-2 p-3 md:hidden" aria-label="Runs">
            {rows.map((r) => {
              const selected = r.id === selectedRunId;
              return (
                <li key={r.id}>
                  <button type="button" onClick={() => onSelect(r.id)} aria-pressed={selected} className={`w-full rounded-lg border border-border border-l-4 px-3 py-2 text-left ${selected ? "border-l-indigo bg-indigo/20" : "border-l-faint bg-surface-2"}`}>
                    <div className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
                      {r.agentName} <span className="font-normal text-muted">· {r.tenantName}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                      <StateBadge kind="run" value={r.state} /> <ShortId id={r.id} /> <TriggerBadge trigger={r.trigger} />
                      {r.errorCode ? <span className="font-mono text-danger">{r.errorCode}</span> : null}
                    </div>
                    <div className="mt-1 font-mono text-[11px] tabular-nums text-muted">{fmtInt(r.toolCalls)} tools · {fmtInt(r.modelCalls)} model · {fmtUsd(r.costUsd)} · {fmtRunDuration(r.startedAt, r.finishedAt, now)}</div>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <p className="border-t border-border px-4 py-2 text-[11px] text-faint">Tools and model columns count run_events of kind tool_call and model_call; cost and tokens come from the run row. Up to 100 alive and 50 finished runs; the full history is on Runs & Traces.</p>
    </section>
  );
}

// Map tab -------------------------------------------------------------------------------------

function MapPanel({ snapshot, filters, now, selectedRunId, onSelect }: { snapshot: LiveSnapshot; filters: LaneFilters; now: Date; selectedRunId: string | null; onSelect: (id: string) => void }) {
  const [hint, setHint] = useState<{ agentId: string; name: string } | null>(null);
  // The client filter decides the sectors; the definition filter narrows the agents inside them. The state filter is a run filter and does not hide agents.
  const agents = useMemo(() => agentsForDepartment(snapshot.agents, filters.department).filter((a) => !filters.definitionKey || a.definitionKey === filters.definitionKey), [snapshot.agents, filters.definitionKey, filters.department]);
  const model = useFlightMapModel({ agents, runs: snapshot.running, communications: snapshot.communications, connectors: snapshot.connectors, tenantFilter: filters.tenantId, now });
  const counts = useMemo(() => mapCounts(model), [model]);
  const agentIds = useMemo(() => new Set(agents.filter((a) => !filters.tenantId || a.tenantId === filters.tenantId).map((a) => a.id)), [agents, filters.tenantId]);
  const rows = useMemo(() => communicationRows(snapshot.communications.filter((c) => !c.agentInstanceId || agentIds.has(c.agentInstanceId)), snapshot.agents, { limit: 30, tenantFilter: filters.tenantId }), [snapshot.communications, snapshot.agents, agentIds, filters.tenantId]);

  const selectAgent = useCallback(
    (node: GraphNode) => {
      const runId = latestRunForAgent(snapshot, node.id, node.runId);
      if (runId) {
        setHint(null);
        onSelect(runId);
      } else {
        setHint({ agentId: node.id, name: node.label });
      }
    },
    [snapshot, onSelect]
  );

  return (
    <>
      <section className="sb-card min-w-0 overflow-hidden" aria-label="Flight Map">
        <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold">Flight Map</h2>
          <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px]"><b className="text-cyan">{fmtInt(counts.running)}</b> <span className="text-muted">running</span></span>
          <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px]"><b className={counts.waiting > 0 ? "text-warning" : "text-fg"}>{fmtInt(counts.waiting)}</b> <span className="text-muted">waiting</span></span>
          <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px]"><b className={counts.hotEdges > 0 ? "text-cyan" : "text-fg"}>{fmtInt(counts.hotEdges)}</b> <span className="text-muted">edges, last 2 min</span></span>
          <span className="hidden text-[11px] text-faint sm:inline">{fmtInt(counts.agents)} agents · {fmtInt(counts.edges)} edges in 20 min</span>
          <span className="ml-auto"><Status state="implemented" /></span>
        </header>
        {counts.agents === 0 ? (
          <div className="p-3"><Empty>No agents match the filters.</Empty></div>
        ) : (
          <FlightMap model={model} now={now} selectedRunId={selectedRunId} onSelectAgent={selectAgent} />
        )}
        <div className="space-y-2 border-t border-border px-4 py-2.5">
          {hint ? (
            <p className="text-xs text-warning" role="status">
              {hint.name} has no run in this snapshot. <Link href={`/mission-control/agents/${hint.agentId}`} className="underline">Open the agent</Link> to run it now or see its history.
            </p>
          ) : null}
          <FlightMapLegend />
          <p className="text-[11px] text-faint">Edges come from run_events summaries of the last 20 minutes (tool calls, model calls, approvals, questions, operator instructions and dispatches); event payloads are content the operator role cannot read. Connectors show connections in read_only or sandbox phase; a sector reads "live" when its latest sync ran in live mode. Click an agent to open its run.</p>
        </div>
      </section>

      <section className="sb-card min-w-0 overflow-hidden" aria-label="Recent communications">
        <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold">Recent communications</h2>
          <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted">{rows.length}</span>
          <span className="hidden text-[11px] text-faint sm:inline">newest first, last 20 minutes, up to 30 rows</span>
          <span className="ml-auto"><Status state="implemented" /></span>
        </header>
        {rows.length === 0 ? (
          <div className="p-3"><Empty>No communications in the last 20 minutes{filters.tenantId ? " for this client" : ""}. Start a run (Run now on an agent, or Run again in the inspector) to see edges appear.</Empty></div>
        ) : (
          <ul className="divide-y divide-border text-xs" aria-label="Communications">
            {rows.map((r) => {
              const tone = r.human ? "text-warning" : r.kind === "model_call" ? "text-indigo" : r.kind === "dispatch" ? "text-muted" : "text-cyan";
              const inner = (
                <>
                  <span className="w-20 shrink-0 font-mono tabular-nums text-faint" title={r.at}>{fmtClockSeconds(r.at)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-fg">{r.from}</span> <span className="text-faint">→</span> <span className="font-medium text-fg">{r.to}</span>
                    <span className={`ml-2 ${tone}`}>{r.kind.replaceAll("_", " ")}</span>
                    <span className="ml-2 text-muted">{r.label}</span>
                  </span>
                  <span className="hidden shrink-0 font-mono text-[11px] text-faint sm:inline">{fmtAgo(r.at, now)}</span>
                </>
              );
              return (
                <li key={r.key}>
                  {r.runId ? (
                    <button type="button" onClick={() => onSelect(r.runId!)} aria-pressed={selectedRunId === r.runId} className={`flex w-full items-baseline gap-2 px-4 py-1.5 text-left hover:bg-cyan/5 focus-visible:bg-cyan/10 focus-visible:outline-none ${selectedRunId === r.runId ? "bg-indigo/20" : ""}`}>
                      {inner}
                    </button>
                  ) : (
                    <div className="flex items-baseline gap-2 px-4 py-1.5">{inner}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

// Pieces --------------------------------------------------------------------------------------

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-current={active ? "page" : undefined} className={active ? "rounded-full bg-indigo/30 px-3 py-1.5 font-medium text-fg" : "rounded-full px-3 py-1.5 text-muted hover:bg-surface-2 hover:text-fg"}>
      {children}
    </button>
  );
}

function ConnectionPill({ connection, lastUpdate, retryInMs, mode, now }: { connection: ReturnType<typeof useLiveSnapshot>["connection"]; lastUpdate: string | null; retryInMs: number | null; mode: "live" | "simulated"; now: Date }) {
  const dot = connection === "connected" ? "bg-success shadow-[0_0_8px_var(--sb-success)]" : connection === "polling" ? "bg-warning" : "bg-muted";
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted" role="status" aria-live="polite">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1">
        <i className={`inline-block h-2 w-2 rounded-full ${dot}`} aria-hidden />
        {connectionLabel(connection)}
        {retryInMs !== null && connection !== "connected" ? <span className="text-faint">· retry in {Math.round(retryInMs / 1000)} s</span> : null}
      </span>
      <span className="font-mono text-[11px] text-faint" title={lastUpdate ?? ""}>updated {fmtAgo(lastUpdate, now)}</span>
      <Badge tone={mode === "live" ? "success" : "warning"}>{mode === "live" ? "live" : "simulated"}</Badge>
    </div>
  );
}

function Stat({ label, value, tone = "neutral" }: { label: string; value: number; tone?: Tone }) {
  const color: Record<Tone, string> = { neutral: "text-fg", cyan: "text-cyan", success: "text-success", warning: "text-warning", danger: "text-danger", indigo: "text-indigo" };
  return (
    <div className="flex items-baseline gap-1.5 rounded-full border border-border bg-surface px-3 py-1">
      <b className={`font-mono text-sm font-semibold tabular-nums ${color[tone]}`}>{fmtInt(value)}</b>
      <span className="text-[11px] text-muted">{label}</span>
    </div>
  );
}

function Lane({ title, count, tone, children }: { title: string; count: number; tone: Tone; children: ReactNode }) {
  const heading: Record<Tone, string> = { neutral: "text-fg", cyan: "text-cyan", success: "text-success", warning: "text-warning", danger: "text-danger", indigo: "text-indigo" };
  return (
    <section className="sb-card min-w-0 overflow-hidden" aria-label={title}>
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className={`text-sm font-semibold ${heading[tone]}`}>{title}</h2>
        <span className="ml-auto rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted">{count}</span>
        <Status state="implemented" />
      </header>
      <div className="flex max-h-[62vh] flex-col gap-2 overflow-y-auto p-3">{children}</div>
    </section>
  );
}

const ACCENT: Record<"warning" | "danger" | "cyan" | "success" | "neutral" | "indigo", string> = {
  warning: "border-l-warning",
  danger: "border-l-danger",
  cyan: "border-l-cyan",
  success: "border-l-success",
  neutral: "border-l-faint",
  indigo: "border-l-indigo"
};

function LaneCard({ accent, title, children, selected = false }: { accent: keyof typeof ACCENT; title: string; children: ReactNode; selected?: boolean }) {
  return (
    <article className={`flex flex-col gap-1.5 rounded-lg border border-l-4 px-3 py-2.5 ${selected ? "border-indigo/60 bg-indigo/10" : "border-border bg-surface-2"} ${ACCENT[selected ? "indigo" : accent]}`}>
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {children}
    </article>
  );
}

function CardFooter({ children }: { children: ReactNode }) {
  return <div className="border-t border-dashed border-border pt-1.5 text-[11px] text-muted">{children}</div>;
}

function RunCard({ run, now, returnTo, selected, onInspect }: { run: LiveRun; now: Date; returnTo: string; selected: boolean; onInspect: (id: string) => void }) {
  const accent = run.state === "running" ? "cyan" : run.state === "paused" ? "neutral" : run.state === "queued" ? "neutral" : "warning";
  return (
    <LaneCard accent={accent} title={`${run.agentName} · ${run.tenantName}`} selected={selected}>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <StateBadge kind="run" value={run.state} />
        <ShortId id={run.id} />
        <TriggerBadge trigger={run.trigger} />
        <span>attempt {run.attempt}</span>
        <span>· {run.startedAt ? `started ${fmtAgo(run.startedAt, now)}` : `created ${fmtAgo(run.createdAt, now)}`}</span>
        <SimulatedBadge simulated={run.simulated} />
      </div>
      {run.steps.length > 0 ? (
        <ol className="flex flex-wrap gap-1" aria-label="Checkpoints">
          {run.steps.map((step, i) => (
            <li key={`${step}-${i}`} className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${i === run.steps.length - 1 ? "border-cyan text-cyan" : "border-success/50 text-success"}`}>{step}</li>
          ))}
        </ol>
      ) : (
        <div className="text-[11px] text-faint">no checkpoint yet</div>
      )}
      <div className="text-xs text-muted">
        {fmtInt(run.toolCalls)} tools · {fmtInt(run.modelCalls)} model · {fmtInt(run.tokensInput)} in / {fmtInt(run.tokensOutput)} out · {fmtUsd(run.costUsd)}
        {run.lastEventSummary ? <> · last event {fmtAgo(run.lastEventAt, now)}: <span className="text-fg">{run.lastEventKind}</span> {run.lastEventSummary.slice(0, 120)}</> : null}
      </div>
      <form action={instructRunAction} className="flex flex-wrap items-center gap-1">
        <input type="hidden" name="tenantId" value={run.tenantId} />
        <input type="hidden" name="runId" value={run.id} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <input name="text" required minLength={3} maxLength={2000} placeholder="Instruction for the next checkpoint" className={`${inputClass} min-w-40 flex-1 py-1 text-xs`} />
        <button type="submit" className={smallPrimaryClass}>Instruct</button>
      </form>
      <div className="flex flex-wrap gap-1">
        <button type="button" className={smallButtonClass} onClick={() => onInspect(run.id)} aria-pressed={selected}>Inspect</button>
        <form action={stopRunAction} className="contents">
          <input type="hidden" name="tenantId" value={run.tenantId} />
          <input type="hidden" name="runId" value={run.id} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <ConfirmButton message={`Stop run ${run.id.slice(0, 8)}? A worker already executing it stops at its next checkpoint.`} className={smallDangerClass}>Stop</ConfirmButton>
        </form>
        <Link href={`/mission-control/agents/${run.agentInstanceId}`} className={smallButtonClass}>Agent</Link>
      </div>
    </LaneCard>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <i className={`inline-block h-2 w-2 rounded-sm ${className}`} aria-hidden />
      {label}
    </span>
  );
}

function TrackRow({ label, segments, onInspect }: { label: string; segments: ReturnType<typeof buildTimeline>["tracks"][number]["segments"]; onInspect: (id: string) => void }) {
  return (
    <>
      <div className="truncate text-muted" title={label}>{label}</div>
      <div className="relative h-4 rounded bg-surface-2">
        {segments.map((seg, i) => (
          <button
            type="button"
            key={`${seg.runId}-${i}`}
            onClick={() => onInspect(seg.runId)}
            className={`absolute bottom-0.5 top-0.5 rounded-sm ${SEGMENT_CLASS[seg.state]}`}
            style={{ left: `${seg.leftPct}%`, width: `${seg.widthPct}%` }}
            title={`${seg.state.replaceAll("_", " ")} · ${fmtClock(seg.from)} to ${fmtClock(seg.to)} · run ${seg.runId.slice(0, 8)}`}
            aria-label={`Inspect run ${seg.runId.slice(0, 8)} (${seg.state.replaceAll("_", " ")})`}
          />
        ))}
      </div>
    </>
  );
}
