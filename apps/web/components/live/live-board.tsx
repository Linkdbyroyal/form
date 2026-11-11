"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { Badge, Empty, Status, inputClass, type Tone } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { Notice, ShortId, SimulatedBadge, StateBadge, TriggerBadge, selectClass, smallButtonClass, smallDangerClass, smallPrimaryClass } from "@/components/agent-ui";
import { fmtInt, fmtUsd } from "@/lib/format";
import { decideApprovalAction, incidentAction, instructRunAction, stopRunAction } from "@/lib/mission-control/actions";
import {
  EMPTY_FILTERS,
  RUN_STATES,
  buildTimeline,
  connectionLabel,
  filterOptions,
  fmtAgo,
  fmtClock,
  groupRuns,
  isRunState,
  type LaneFilters,
  type LiveRun,
  type LiveRunState,
  type LiveSnapshot
} from "@/lib/live/helpers";
import { useLiveSnapshot } from "@/lib/live/use-live";

/**
 * Command Queue (ADR-024 composite D, tab 1). Three lanes, a per-agent timeline and a status strip. Every control posts
 * to an existing audited server action; the board itself only reads the operator snapshot. Cyan = live activity,
 * amber (warning) = needs a human, indigo = structure and selection.
 */
const RETURN_TO = "/mission-control/live";

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

export function LiveBoard({ initial, ok, error, operatorRoles }: { initial: LiveSnapshot; ok: string | null; error: string | null; operatorRoles: string[] }) {
  const { snapshot, connection, lastUpdate, retryInMs } = useLiveSnapshot(initial);
  const [filters, setFilters] = useState<LaneFilters>(EMPTY_FILTERS);
  // "now" is the snapshot time, so server and client render the same relative times (no hydration drift).
  const now = useMemo(() => new Date(snapshot.generatedAt), [snapshot.generatedAt]);
  const options = useMemo(() => filterOptions(snapshot), [snapshot]);
  const lanes = useMemo(() => groupRuns(snapshot, filters), [snapshot, filters]);
  const timeline = useMemo(() => buildTimeline(snapshot.timeline, now), [snapshot.timeline, now]);
  const approvals = snapshot.needsYou.approvals.filter((a) => !filters.tenantId || a.tenantId === filters.tenantId);
  const incidents = snapshot.needsYou.incidents;
  const questions = snapshot.needsYou.questions.filter((q) => !filters.tenantId || q.tenantId === filters.tenantId);
  const needsCount = approvals.length + incidents.length + lanes.failed.length + questions.length;
  const s = snapshot.summary.runs;
  const waiting = s.waiting_for_approval + s.waiting_for_input;
  const filtered = filters.tenantId !== null || filters.definitionKey !== null || filters.state !== null;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Live</h1>
          <p className="text-sm text-muted">
            Command Queue across clients: what needs you, what is running, what finished today. Snapshot first, then a server-sent event stream fed by PostgreSQL notifications; RLS and the operator column grants decide what is shown. <Status state="implemented" />
          </p>
        </div>
        <ConnectionPill connection={connection} lastUpdate={lastUpdate} retryInMs={retryInMs} mode={snapshot.platform.mode} now={now} />
      </header>

      <Notice ok={ok} error={error} />

      <nav aria-label="Live tabs" className="flex flex-wrap gap-1 text-sm">
        <span className="rounded-full bg-indigo/30 px-3 py-1.5 font-medium text-fg" aria-current="page">
          Queue {needsCount > 0 ? <span className="ml-1 font-mono text-[11px] text-warning">{needsCount}</span> : null}
        </span>
        {["Map", "Deck", "Runs"].map((label) => (
          <Link key={label} href="/mission-control/runs" className="rounded-full px-3 py-1.5 text-muted hover:bg-surface-2 hover:text-fg" title="Planned for slice 2; opens Runs & Traces for now">
            {label} <span className="ml-1 text-[10px] uppercase tracking-wide text-faint">planned (slice 2)</span>
          </Link>
        ))}
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
        <span className="text-faint">Filters apply to runs; incidents are platform-wide.</span>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
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
                  <input type="hidden" name="returnTo" value={RETURN_TO} />
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
              <CardFooter>{a.runId ? <Link href={`/mission-control/runs/${a.runId}`} className="underline">run <ShortId id={a.runId} /></Link> : "no run"}</CardFooter>
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
                <Link href={`/mission-control/runs/${r.id}`} className={smallButtonClass}>Open run</Link>
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
                <input type="hidden" name="returnTo" value={RETURN_TO} />
                {i.state === "open" ? <button type="submit" name="action" value="acknowledge" className={smallButtonClass}>Acknowledge</button> : null}
                <ConfirmButton name="action" value="resolve" message="Resolve this incident?" className={smallPrimaryClass}>Resolve</ConfirmButton>
                {i.runId ? <Link href={`/mission-control/runs/${i.runId}`} className={smallButtonClass}>Open run</Link> : null}
              </form>
            </LaneCard>
          ))}
        </Lane>

        <Lane title="Running" count={lanes.running.length} tone="cyan">
          {lanes.running.length === 0 ? <Empty>No active runs{filtered ? " match the filters" : ""}. Runs start from schedules, Run now or an assigned task.</Empty> : null}
          {lanes.running.map((r) => (
            <RunCard key={r.id} run={r} now={now} />
          ))}
        </Lane>

        <Lane title="Done today" count={lanes.done.length} tone="success">
          {lanes.done.length === 0 ? <Empty>Nothing finished in the last 24 hours{filtered ? " for these filters" : ""}.</Empty> : null}
          {lanes.done.map((r) => (
            <LaneCard key={r.id} accent={r.state === "succeeded" ? "success" : "neutral"} title={r.summary ?? `${r.agentName} run ${r.state}`}>
              <div className="text-xs text-muted">
                <StateBadge kind="run" value={r.state} /> · {r.agentName} for {r.tenantName} · {fmtAgo(r.finishedAt, now)} · {fmtUsd(r.costUsd)} · <SimulatedBadge simulated={r.simulated} />
              </div>
              <CardFooter><Link href={`/mission-control/runs/${r.id}`} className="underline">review events</Link></CardFooter>
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
              <TrackRow key={t.agentInstanceId} label={t.label} segments={t.segments} />
            ))}
            <div />
            <div className="flex justify-between text-[11px] text-faint">
              <span>{fmtClock(timeline.start)}</span>
              <span>now {fmtClock(timeline.end)}</span>
            </div>
          </div>
        )}
        <p className="mt-3 text-[11px] text-faint">Segments come from state_change events; the state of an earlier event is read from its summary because event payloads are content the operator role cannot read.</p>
      </section>
    </div>
  );
}

// Pieces --------------------------------------------------------------------------------------

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

const ACCENT: Record<"warning" | "danger" | "cyan" | "success" | "neutral", string> = {
  warning: "border-l-warning",
  danger: "border-l-danger",
  cyan: "border-l-cyan",
  success: "border-l-success",
  neutral: "border-l-faint"
};

function LaneCard({ accent, title, children }: { accent: keyof typeof ACCENT; title: string; children: ReactNode }) {
  return (
    <article className={`flex flex-col gap-1.5 rounded-lg border border-border border-l-4 bg-surface-2 px-3 py-2.5 ${ACCENT[accent]}`}>
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {children}
    </article>
  );
}

function CardFooter({ children }: { children: ReactNode }) {
  return <div className="border-t border-dashed border-border pt-1.5 text-[11px] text-muted">{children}</div>;
}

function RunCard({ run, now }: { run: LiveRun; now: Date }) {
  const accent = run.state === "running" ? "cyan" : run.state === "paused" ? "neutral" : run.state === "queued" ? "neutral" : "warning";
  return (
    <LaneCard accent={accent} title={`${run.agentName} · ${run.tenantName}`}>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <StateBadge kind="run" value={run.state} />
        <Link href={`/mission-control/runs/${run.id}`} className="underline"><ShortId id={run.id} /></Link>
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
        {fmtInt(run.tokensInput)} in / {fmtInt(run.tokensOutput)} out · {fmtUsd(run.costUsd)}
        {run.lastEventSummary ? <> · last event {fmtAgo(run.lastEventAt, now)}: <span className="text-fg">{run.lastEventKind}</span> {run.lastEventSummary.slice(0, 120)}</> : null}
      </div>
      <form action={instructRunAction} className="flex flex-wrap items-center gap-1">
        <input type="hidden" name="tenantId" value={run.tenantId} />
        <input type="hidden" name="runId" value={run.id} />
        <input type="hidden" name="returnTo" value={RETURN_TO} />
        <input name="text" required minLength={3} maxLength={2000} placeholder="Instruction for the next checkpoint" className={`${inputClass} min-w-40 flex-1 py-1 text-xs`} />
        <button type="submit" className={smallPrimaryClass}>Instruct</button>
      </form>
      <form action={stopRunAction} className="flex gap-1">
        <input type="hidden" name="tenantId" value={run.tenantId} />
        <input type="hidden" name="runId" value={run.id} />
        <input type="hidden" name="returnTo" value={RETURN_TO} />
        <ConfirmButton message={`Stop run ${run.id.slice(0, 8)}? A worker already executing it stops at its next checkpoint.`} className={smallDangerClass}>Stop</ConfirmButton>
        <Link href={`/mission-control/agents/${run.agentInstanceId}`} className={smallButtonClass}>Agent</Link>
      </form>
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

function TrackRow({ label, segments }: { label: string; segments: ReturnType<typeof buildTimeline>["tracks"][number]["segments"] }) {
  return (
    <>
      <div className="truncate text-muted" title={label}>{label}</div>
      <div className="relative h-4 rounded bg-surface-2">
        {segments.map((seg, i) => (
          <Link
            key={`${seg.runId}-${i}`}
            href={`/mission-control/runs/${seg.runId}`}
            className={`absolute bottom-0.5 top-0.5 rounded-sm ${SEGMENT_CLASS[seg.state]}`}
            style={{ left: `${seg.leftPct}%`, width: `${seg.widthPct}%` }}
            title={`${seg.state.replaceAll("_", " ")} · ${fmtClock(seg.from)} to ${fmtClock(seg.to)} · run ${seg.runId.slice(0, 8)}`}
          />
        ))}
      </div>
    </>
  );
}
