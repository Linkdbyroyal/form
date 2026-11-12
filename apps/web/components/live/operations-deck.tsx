"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Badge, Empty, Status, type Tone } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { ShortId, StateBadge, smallButtonClass, smallPrimaryClass } from "@/components/agent-ui";
import { fmtInt, fmtUsd } from "@/lib/format";
import { runNowAction, setAgentStateAction, toggleScheduleAction } from "@/lib/mission-control/actions";
import { canRunNow, deckAgentRows, filterEvents, filterSchedules, fmtWorkerCount, pauseOrResume, scheduleOutcomeTone, type DeckAgentRow } from "@/lib/live/deck";
import { eventKindTone, fmtAgo, fmtClockSeconds, isRunState, type LaneFilters, type LiveEvent, type LiveSchedule, type LiveSnapshot, type LiveWorker } from "@/lib/live/helpers";

/**
 * Operations Deck (ADR-024 composite D, proposal A; slice 4): the dense agents table, the live event ticker, the
 * background worker rows and the schedules table. Reads the operator snapshot only; every control posts to an existing
 * audited server action (`runNowAction`, `setAgentStateAction`, `toggleScheduleAction`) and redirects back to
 * `returnTo`, which keeps the tab, the open drawer and the department filter.
 */
const EVENT_TONE: Record<ReturnType<typeof eventKindTone>, Tone> = { cyan: "cyan", indigo: "indigo", warning: "warning", danger: "danger", neutral: "neutral" };

const TICKER_LIMIT = 120;

export function OperationsDeck({ snapshot, filters, now, selectedRunId, onSelect, returnTo }: { snapshot: LiveSnapshot; filters: LaneFilters; now: Date; selectedRunId: string | null; onSelect: (id: string) => void; returnTo: string }) {
  const rows = useMemo(() => deckAgentRows(snapshot, filters), [snapshot, filters]);
  const events = useMemo(() => filterEvents(snapshot, filters, TICKER_LIMIT), [snapshot, filters]);
  const schedules = useMemo(() => filterSchedules(snapshot, filters), [snapshot, filters]);
  const filtered = filters.tenantId !== null || filters.definitionKey !== null || filters.state !== null || filters.department !== null;

  return (
    <>
      <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <AgentsPanel rows={rows} total={snapshot.agents.length} now={now} selectedRunId={selectedRunId} onSelect={onSelect} returnTo={returnTo} filtered={filtered} />
        <TickerPanel events={events} now={now} selectedRunId={selectedRunId} onSelect={onSelect} filtered={filtered} />
      </div>
      <div className="grid gap-4 2xl:grid-cols-2">
        <WorkersPanel workers={snapshot.workers} now={now} />
        <SchedulesPanel schedules={schedules} total={snapshot.schedules.length} now={now} returnTo={returnTo} filtered={filtered} />
      </div>
    </>
  );
}

// Agents ----------------------------------------------------------------------------------------

function EffectiveState({ state }: { state: string }) {
  return <StateBadge kind={isRunState(state) ? "run" : "agent"} value={state} />;
}

function ProgressCell({ row }: { row: DeckAgentRow }) {
  if (!row.progress) return <span className="text-faint">no run</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <span className="relative hidden h-1.5 w-14 overflow-hidden rounded bg-surface-2 sm:inline-block" aria-hidden>
        <i className="absolute inset-y-0 left-0 rounded bg-cyan" style={{ width: `${row.progress.pct}%` }} />
      </span>
      <span className="whitespace-nowrap font-mono text-[11px] tabular-nums">{row.progress.label}</span>
    </span>
  );
}

function AgentActions({ row, returnTo }: { row: DeckAgentRow; returnTo: string }) {
  const a = row.agent;
  const toggle = pauseOrResume(a);
  return (
    <div className="flex flex-wrap gap-1">
      {canRunNow(a) ? (
        <form action={runNowAction} className="contents">
          <input type="hidden" name="tenantId" value={a.tenantId} />
          <input type="hidden" name="agentInstanceId" value={a.id} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <ConfirmButton message={`Queue a new run for ${a.name} (${a.tenantName}, trigger: command)?`} className={smallPrimaryClass}>Run now</ConfirmButton>
        </form>
      ) : null}
      {toggle ? (
        <form action={setAgentStateAction} className="contents">
          <input type="hidden" name="tenantId" value={a.tenantId} />
          <input type="hidden" name="agentInstanceId" value={a.id} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <input type="hidden" name="state" value={toggle === "pause" ? "paused" : "idle"} />
          {toggle === "pause" ? (
            <ConfirmButton message={`Pause ${a.name}? New runs are refused by the worker until it is resumed; an alive run keeps going.`} className={smallButtonClass}>Pause</ConfirmButton>
          ) : (
            <button type="submit" className={smallButtonClass}>Resume</button>
          )}
        </form>
      ) : (
        <span className="text-[11px] text-faint">disabled</span>
      )}
      <Link href={`/mission-control/agents/${a.id}`} className={smallButtonClass}>Agent</Link>
    </div>
  );
}

function AgentsPanel({ rows, total, now, selectedRunId, onSelect, returnTo, filtered }: { rows: DeckAgentRow[]; total: number; now: Date; selectedRunId: string | null; onSelect: (id: string) => void; returnTo: string; filtered: boolean }) {
  return (
    <section className="sb-card min-w-0 overflow-hidden" aria-label="Agents">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">Agents</h2>
        <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted">{rows.length} of {total}</span>
        <span className="hidden text-[11px] text-faint sm:inline">sorted by state, then last activity</span>
        <span className="ml-auto"><Status state="implemented" /></span>
      </header>
      {rows.length === 0 ? (
        <div className="p-3"><Empty>No agents{filtered ? " match the filters" : ""}.</Empty></div>
      ) : (
        <>
          <div className="hidden max-h-[60vh] overflow-auto md:block">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-surface text-left text-[11px] uppercase tracking-wide text-faint">
                <tr>
                  <th className="px-3 py-2 font-medium">Agent</th>
                  <th className="py-2 pr-2 font-medium">Client</th>
                  <th className="hidden py-2 pr-2 font-medium xl:table-cell">Department</th>
                  <th className="py-2 pr-2 font-medium">State</th>
                  <th className="py-2 pr-2 font-medium">Run</th>
                  <th className="hidden py-2 pr-2 font-medium 2xl:table-cell">Step</th>
                  <th className="py-2 pr-2 font-medium">Progress</th>
                  <th className="py-2 pr-2 font-medium">Last activity</th>
                  <th className="py-2 pr-2 text-right font-medium">Month cost</th>
                  <th className="hidden py-2 pr-2 text-right font-medium xl:table-cell">Runs 24 h</th>
                  <th className="py-2 pr-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const a = row.agent;
                  const selected = row.run !== null && row.run.id === selectedRunId;
                  return (
                    <tr key={a.id} className={`border-t border-border align-middle ${selected ? "bg-indigo/20" : ""}`}>
                      <td className="min-w-[180px] px-3 py-2">
                        <div className="font-semibold text-fg">{a.name}</div>
                        <div className="font-mono text-[11px] text-faint">{a.definitionKey} · {a.tier}</div>
                      </td>
                      <td className="py-2 pr-2 text-muted">{a.tenantName}</td>
                      <td className="hidden py-2 pr-2 text-muted xl:table-cell">{a.department ?? <span className="text-faint">none</span>}</td>
                      <td className="py-2 pr-2"><EffectiveState state={row.state} /></td>
                      <td className="whitespace-nowrap py-2 pr-2">
                        {row.run ? (
                          <button type="button" className="underline decoration-dotted hover:text-cyan" onClick={() => onSelect(row.run!.id)} aria-pressed={selected} aria-label={`Inspect run ${row.run.id.slice(0, 8)}`}>
                            <ShortId id={row.run.id} />
                          </button>
                        ) : (
                          <span className="text-faint">none</span>
                        )}
                      </td>
                      <td className="hidden py-2 pr-2 font-mono text-[11px] 2xl:table-cell">{row.step ?? <span className="text-faint">{row.run ? "no checkpoint" : ""}</span>}</td>
                      <td className="py-2 pr-2"><ProgressCell row={row} /></td>
                      <td className="whitespace-nowrap py-2 pr-2 font-mono text-[11px] tabular-nums text-muted" title={row.lastActivityAt ?? "never"}>{row.lastActivityAt ? fmtAgo(row.lastActivityAt, now) : "never"}</td>
                      <td className="whitespace-nowrap py-2 pr-2 text-right font-mono tabular-nums">{fmtUsd(a.monthCostUsd)}</td>
                      <td className="hidden py-2 pr-2 text-right font-mono tabular-nums xl:table-cell">{fmtInt(a.runsToday)}</td>
                      <td className="py-2 pr-3"><AgentActions row={row} returnTo={returnTo} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="flex flex-col gap-2 p-3 md:hidden" aria-label="Agents">
            {rows.map((row) => {
              const a = row.agent;
              const selected = row.run !== null && row.run.id === selectedRunId;
              return (
                <li key={a.id} className={`rounded-lg border border-border border-l-4 px-3 py-2 ${selected ? "border-l-indigo bg-indigo/20" : "border-l-faint bg-surface-2"}`}>
                  <div className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
                    {a.name} <span className="font-normal text-muted">· {a.tenantName}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <EffectiveState state={row.state} />
                    <span className="font-mono text-[11px]">{a.definitionKey} · {a.tier}</span>
                    {a.department ? <span>· {a.department}</span> : null}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                    {row.run ? (
                      <button type="button" className="underline decoration-dotted" onClick={() => onSelect(row.run!.id)} aria-pressed={selected}>run <ShortId id={row.run.id} /></button>
                    ) : (
                      <span className="text-faint">no run</span>
                    )}
                    {row.step ? <span className="font-mono text-[11px]">step {row.step}</span> : null}
                    <ProgressCell row={row} />
                  </div>
                  <div className="mt-1 font-mono text-[11px] tabular-nums text-muted">
                    {row.lastActivityAt ? fmtAgo(row.lastActivityAt, now) : "never"} · {fmtUsd(a.monthCostUsd)} this month · {fmtInt(a.runsToday)} runs 24 h
                  </div>
                  <div className="mt-2"><AgentActions row={row} returnTo={returnTo} /></div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <p className="border-t border-border px-4 py-2 text-[11px] text-faint">State shows the alive run's state when there is one, else the instance state. Progress counts the checkpoints seen so far plus the step the run will resume at; later step names are not knowable from event summaries. Month cost sums cost_events of this UTC calendar month. Run now and Pause/Resume post to the audited agent actions.</p>
    </section>
  );
}

// Event ticker ----------------------------------------------------------------------------------

function TickerPanel({ events, now, selectedRunId, onSelect, filtered }: { events: LiveEvent[]; now: Date; selectedRunId: string | null; onSelect: (id: string) => void; filtered: boolean }) {
  return (
    <section className="sb-card min-w-0 overflow-hidden" aria-label="Live events">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">Live events</h2>
        <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted">{events.length}</span>
        <span className="hidden text-[11px] text-faint sm:inline">newest first, up to {TICKER_LIMIT}</span>
        <span className="ml-auto"><Status state="implemented" /></span>
      </header>
      {events.length === 0 ? (
        <div className="p-3"><Empty>No events{filtered ? " match the filters" : " yet"}.</Empty></div>
      ) : (
        <ul className="max-h-[48vh] divide-y divide-border overflow-auto text-xs 2xl:max-h-[60vh]" aria-label="Events">
          {events.map((e) => {
            const selected = e.runId === selectedRunId;
            return (
              <li key={e.id}>
                <button type="button" onClick={() => onSelect(e.runId)} aria-pressed={selected} className={`grid w-full grid-cols-[64px_minmax(0,1fr)] gap-2 px-4 py-1.5 text-left hover:bg-cyan/5 focus-visible:bg-cyan/10 focus-visible:outline-none ${selected ? "bg-indigo/20" : ""}`}>
                  <span className="font-mono text-[11px] tabular-nums text-faint" title={e.occurredAt}>{fmtClockSeconds(e.occurredAt)}</span>
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <ShortId id={e.runId} />
                      <Badge tone={EVENT_TONE[eventKindTone(e.kind)]}>{e.kind.replaceAll("_", " ")}</Badge>
                      <span className="text-muted">{e.agentName} · {e.tenantName}</span>
                      {e.classification === "internal" ? <Badge tone="neutral">internal</Badge> : null}
                      <span className="ml-auto font-mono text-[11px] text-faint">{fmtAgo(e.occurredAt, now)}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-fg" title={e.summary}>{e.summary}</span>
                    {e.tokens > 0 || e.costUsd > 0 ? <span className="font-mono text-[11px] tabular-nums text-faint">{fmtInt(e.tokens)} tokens · {fmtUsd(e.costUsd)}</span> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="border-t border-border px-4 py-2 text-[11px] text-faint">run_events with classification public or internal; summaries only, payloads are content the operator role cannot read. Click a row to open its run in the inspector.</p>
    </section>
  );
}

// Background workers ----------------------------------------------------------------------------

function WorkersPanel({ workers, now }: { workers: LiveWorker[]; now: Date }) {
  const unreadable = workers.filter((w) => !w.readable);
  return (
    <section className="sb-card min-w-0 overflow-hidden" aria-label="Background workers">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">Background workers (pg-boss)</h2>
        <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted">{workers.length} queues</span>
        <span className="ml-auto"><Status state="implemented" /></span>
      </header>
      <div className="overflow-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-[11px] uppercase tracking-wide text-faint">
            <tr>
              <th className="px-3 py-2 font-medium">Queue</th>
              <th className="py-2 pr-2 text-right font-medium">Active</th>
              <th className="py-2 pr-2 text-right font-medium">Queued</th>
              <th className="py-2 pr-2 text-right font-medium">Done 24 h</th>
              <th className="py-2 pr-2 text-right font-medium">Failed 24 h</th>
              <th className="py-2 pr-3 font-medium">Last</th>
            </tr>
          </thead>
          <tbody>
            {workers.map((w) => (
              <tr key={w.queue} className="border-t border-border align-top">
                <td className="px-3 py-2">
                  <div className="font-mono font-medium text-fg">{w.queue}</div>
                  <div className="text-[11px] text-faint">{w.label}</div>
                  {w.note ? <div className={`text-[11px] ${w.readable ? "text-faint" : "text-warning"}`}>{w.note}</div> : null}
                </td>
                {w.readable ? (
                  <>
                    <td className="py-2 pr-2 text-right font-mono tabular-nums">{fmtWorkerCount(w.active)}</td>
                    <td className="py-2 pr-2 text-right font-mono tabular-nums">{fmtWorkerCount(w.queued)}</td>
                    <td className="py-2 pr-2 text-right font-mono tabular-nums text-success">{fmtWorkerCount(w.done24h)}</td>
                    <td className={`py-2 pr-2 text-right font-mono tabular-nums ${w.failed24h ? "text-danger" : ""}`}>{fmtWorkerCount(w.failed24h)}</td>
                    <td className="whitespace-nowrap py-2 pr-3 font-mono text-[11px] tabular-nums text-muted" title={w.lastAt ?? "never"}>{w.lastAt ? fmtAgo(w.lastAt, now) : "never"}</td>
                  </>
                ) : (
                  <td colSpan={5} className="py-2 pr-3 text-warning">not readable by the operator role</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-border px-4 py-2 text-[11px] text-faint">
        pg-boss keeps its queue tables in its own schema, which the operator role cannot read; every number is derived from the domain tables the worker writes (source per row: {workers.map((w) => `${w.queue} from ${w.source}`).join("; ")}). "n/a" means the source does not track that number.
        {unreadable.length > 0 ? ` ${unreadable.length} queue(s) are not readable by the operator role.` : ""}
      </p>
    </section>
  );
}

// Schedules -------------------------------------------------------------------------------------

function SchedulesPanel({ schedules, total, now, returnTo, filtered }: { schedules: LiveSchedule[]; total: number; now: Date; returnTo: string; filtered: boolean }) {
  return (
    <section className="sb-card min-w-0 overflow-hidden" aria-label="Schedules">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">Schedules</h2>
        <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted">{schedules.length} of {total}</span>
        <span className="ml-auto"><Status state="implemented" /></span>
      </header>
      {schedules.length === 0 ? (
        <div className="p-3"><Empty>No schedules{filtered ? " match the filters" : ""}.</Empty></div>
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-[11px] uppercase tracking-wide text-faint">
              <tr>
                <th className="px-3 py-2 font-medium">Client</th>
                <th className="py-2 pr-2 font-medium">Agent</th>
                <th className="hidden py-2 pr-2 font-medium sm:table-cell">Cron</th>
                <th className="py-2 pr-2 font-medium">Next</th>
                <th className="py-2 pr-2 font-medium">Last</th>
                <th className="py-2 pr-3 font-medium">Enabled</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => (
                <tr key={s.id} className="border-t border-border align-top">
                  <td className="px-3 py-2 text-muted">{s.tenantName}</td>
                  <td className="py-2 pr-2">
                    <div className="text-fg">{s.agentName}</div>
                    <div className="font-mono text-[11px] text-faint">{s.definitionKey}</div>
                    <div className="font-mono text-[11px] text-faint sm:hidden">{s.cron} {s.timezone}</div>
                  </td>
                  <td className="hidden whitespace-nowrap py-2 pr-2 font-mono text-[11px] sm:table-cell">{s.cron} <span className="text-faint">{s.timezone}</span></td>
                  <td className="whitespace-nowrap py-2 pr-2 font-mono text-[11px] tabular-nums" title={s.nextRunAt ?? ""}>{s.enabled ? (s.nextRunAt ? fmtNext(s.nextRunAt, now) : "pending reconcile") : <span className="text-faint">off</span>}</td>
                  <td className="py-2 pr-2">
                    <div className="flex flex-wrap items-center gap-1">
                      {s.lastOutcome ? <Badge tone={scheduleOutcomeTone(s.lastOutcome)}>{s.lastOutcome.replaceAll("_", " ")}</Badge> : <span className="text-faint">never ran</span>}
                      {s.lastRunAt ? <span className="font-mono text-[11px] text-muted">{fmtAgo(s.lastRunAt, now)}</span> : null}
                    </div>
                  </td>
                  <td className="py-2 pr-3">
                    <form action={toggleScheduleAction} className="flex flex-wrap items-center gap-1.5">
                      <input type="hidden" name="tenantId" value={s.tenantId} />
                      <input type="hidden" name="scheduleId" value={s.id} />
                      <input type="hidden" name="enabled" value={s.enabled ? "false" : "true"} />
                      <input type="hidden" name="returnTo" value={returnTo} />
                      <Badge tone={s.enabled ? "success" : "neutral"}>{s.enabled ? "enabled" : "disabled"}</Badge>
                      {s.enabled ? (
                        <ConfirmButton message={`Disable the schedule of ${s.agentName} for ${s.tenantName}? The worker removes it from pg-boss within one minute.`} className={smallButtonClass}>Disable</ConfirmButton>
                      ) : (
                        <button type="submit" className={smallButtonClass}>Enable</button>
                      )}
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="border-t border-border px-4 py-2 text-[11px] text-faint">Next run is the worker's next_run_at; after Enable it reads "pending reconcile" until the worker recomputes it (within one minute). Last outcome is the state of the newest run started by the schedule. Enable and Disable post to the audited schedule action.</p>
    </section>
  );
}

/** "in 12 min", "in 3 h", or "due" when the time has passed (the worker's tick is pending). */
function fmtNext(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "n/a";
  const diff = t - now.getTime();
  if (diff <= 0) return "due";
  if (diff < 3_600_000) return `in ${Math.max(1, Math.round(diff / 60_000))} min`;
  if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)} h`;
  return `in ${Math.round(diff / 86_400_000)} d`;
}
