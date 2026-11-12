"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Badge, Empty, Status, inputClass, type Tone } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { ShortId, SimulatedBadge, StateBadge, TriggerBadge, selectClass, smallButtonClass, smallDangerClass, smallPrimaryClass } from "@/components/agent-ui";
import { fmtDate, fmtDuration, fmtInt, fmtUsd } from "@/lib/format";
import { decideApprovalAction, incidentAction, instructRunAction, runNowAction, stopRunAction } from "@/lib/mission-control/actions";
import {
  EVENT_FILTERS,
  eventKindTone,
  eventMatchesFilter,
  fmtAgo,
  fmtClockSeconds,
  fmtRunDuration,
  isEventFilter,
  isTerminalRunState,
  parseRunDetail,
  type EventFilter,
  type LiveRunDetail,
  type LiveRunStep
} from "@/lib/live/helpers";

/**
 * Run Inspector drawer (ADR-024 composite D, slice 2). Reads `/api/mission-control/runs/{id}` (operator view: no
 * checkpoint, result or event payloads) on selection and again, debounced 500 ms, whenever the board receives a new
 * snapshot while the drawer is open. Every control posts to an existing audited server action and returns to
 * `returnTo`, which carries the tab and the selected run so the drawer reopens after the redirect.
 */
const REFRESH_DEBOUNCE_MS = 500;

type LoadStatus = "loading" | "ready" | "error";

export function RunInspector({
  runId,
  refreshKey,
  now,
  returnTo,
  operatorRoles,
  onClose,
  onSelectRun
}: {
  runId: string;
  /** Changes whenever a new snapshot arrives (its generatedAt); triggers a debounced re-read of the detail. */
  refreshKey: string;
  now: Date;
  returnTo: string;
  operatorRoles: string[];
  onClose: () => void;
  onSelectRun: (id: string) => void;
}) {
  const [detail, setDetail] = useState<LiveRunDetail | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [filter, setFilter] = useState<EventFilter>("all");
  const generation = useRef(0);
  const runIdRef = useRef(runId);
  runIdRef.current = runId;

  const load = useCallback(async (id: string, silent: boolean) => {
    const gen = ++generation.current;
    if (!silent) setStatus("loading");
    try {
      const res = await fetch(`/api/mission-control/runs/${encodeURIComponent(id)}`, { cache: "no-store", credentials: "same-origin" });
      if (gen !== generation.current) return;
      if (!res.ok) {
        setErrorText(res.status === 404 ? "Run not found. It may have been removed or belongs to a tenant outside this view." : res.status === 401 ? "Operator session with MFA required. Sign in again." : `The detail request failed (${res.status}).`);
        setStatus("error");
        return;
      }
      const parsed = parseRunDetail(await res.json());
      if (gen !== generation.current) return;
      if (!parsed) {
        setErrorText("The detail response had an unexpected shape.");
        setStatus("error");
        return;
      }
      setDetail(parsed);
      setErrorText(null);
      setStatus("ready");
    } catch {
      if (gen === generation.current) {
        setErrorText("Network error while reading the run. The next snapshot retries.");
        setStatus("error");
      }
    }
  }, []);

  // New selection: reset and read right away.
  useEffect(() => {
    setDetail(null);
    setFilter("all");
    void load(runId, false);
  }, [runId, load]);

  // New snapshot while open: re-read quietly after a short debounce (several notifications arrive in bursts).
  const firstRefresh = useRef(true);
  useEffect(() => {
    if (firstRefresh.current) {
      firstRefresh.current = false;
      return;
    }
    const t = setTimeout(() => void load(runIdRef.current, true), REFRESH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [refreshKey, load]);

  return (
    <aside className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto" aria-label="Run inspector" aria-busy={status === "loading"}>
      {status === "loading" && !detail ? (
        <Panel title="Inspector" onClose={onClose}>
          <div className="text-sm text-muted">Reading run <ShortId id={runId} />...</div>
        </Panel>
      ) : null}
      {status === "error" && !detail ? (
        <Panel title="Inspector" onClose={onClose}>
          <div role="alert" className="text-sm text-danger">{errorText}</div>
          <div className="text-xs text-faint">Run <ShortId id={runId} /></div>
        </Panel>
      ) : null}
      {detail ? <Detail detail={detail} now={now} returnTo={returnTo} operatorRoles={operatorRoles} filter={filter} onFilter={setFilter} stale={status !== "ready"} onClose={onClose} onSelectRun={onSelectRun} /> : null}
    </aside>
  );
}

// Pieces --------------------------------------------------------------------------------------

function Panel({ title, onClose, children, right }: { title: ReactNode; onClose?: () => void; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="sb-card p-4">
      <header className="mb-2 flex items-start justify-between gap-2">
        <h2 className="min-w-0 text-sm font-semibold">{title}</h2>
        <div className="flex shrink-0 items-center gap-2">
          {right}
          {onClose ? (
            <button type="button" onClick={onClose} className={smallButtonClass} aria-label="Close inspector">Close</button>
          ) : null}
        </div>
      </header>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

const STEP_CLASS: Record<LiveRunStep["status"], string> = {
  done: "border-success/50 text-success",
  now: "border-cyan text-cyan shadow-[0_0_6px_var(--sb-cyan)]",
  pending: "border-dashed border-border text-faint"
};

function Steps({ steps }: { steps: LiveRunStep[] }) {
  if (steps.length === 0) return <div className="text-[11px] text-faint">no checkpoint yet</div>;
  return (
    <ol className="flex flex-wrap gap-1" aria-label="Steps">
      {steps.map((s, i) => (
        <li key={`${s.name}-${i}`} className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${STEP_CLASS[s.status]}`} title={`${s.name}: ${s.status}`}>
          {s.name}
        </li>
      ))}
    </ol>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-faint">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

const EVENT_TONE: Record<ReturnType<typeof eventKindTone>, Tone> = { cyan: "cyan", indigo: "indigo", warning: "warning", danger: "danger", neutral: "neutral" };

function Detail({
  detail,
  now,
  returnTo,
  operatorRoles,
  filter,
  onFilter,
  stale,
  onClose,
  onSelectRun
}: {
  detail: LiveRunDetail;
  now: Date;
  returnTo: string;
  operatorRoles: string[];
  filter: EventFilter;
  onFilter: (f: EventFilter) => void;
  stale: boolean;
  onClose: () => void;
  onSelectRun: (id: string) => void;
}) {
  const { run } = detail;
  const terminal = isTerminalRunState(run.state);
  const currentStep = detail.steps.find((s) => s.status === "now")?.name ?? (terminal ? detail.steps[detail.steps.length - 1]?.name ?? null : null);
  const events = detail.events.filter((e) => eventMatchesFilter(e.kind, filter));
  const pendingApprovals = detail.approvals.filter((a) => a.state === "pending");
  const openIncidents = detail.incidents.filter((i) => i.state !== "resolved");

  return (
    <>
      <Panel
        title={
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="truncate">{run.agentName}</span>
            <StateBadge kind="run" value={run.state} />
            <SimulatedBadge simulated={run.simulated} />
          </span>
        }
        onClose={onClose}
        right={<Status state="implemented" />}
      >
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span>{run.tenantName}</span>
          <span>· {run.definitionKey}</span>
          <span>· run <ShortId id={run.id} /></span>
          {stale ? <span className="text-faint">· refreshing</span> : null}
        </div>
        <Steps steps={detail.steps} />
        <dl className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <Row label="Trigger">
            <TriggerBadge trigger={run.trigger} />
            {run.triggerRef ? <span className="ml-1 font-mono text-[11px] text-faint" title={run.triggerRef}>{run.triggerRef.length > 28 ? `${run.triggerRef.slice(0, 28)}...` : run.triggerRef}</span> : null}
          </Row>
          <Row label="Attempt">{run.attempt}</Row>
          <Row label="Started">{run.startedAt ? <span title={fmtDate(run.startedAt)}>{fmtDate(run.startedAt)} <span className="text-faint">({fmtAgo(run.startedAt, now)})</span></span> : <span className="text-faint">not started (created {fmtAgo(run.createdAt, now)})</span>}</Row>
          {run.finishedAt ? <Row label="Finished">{fmtDate(run.finishedAt)}</Row> : null}
          <Row label="Duration"><span className="font-mono tabular-nums">{fmtRunDuration(run.startedAt, run.finishedAt, now)}</span>{!terminal && run.startedAt ? <span className="text-faint"> so far</span> : null}</Row>
          <Row label="Model calls"><span className="font-mono tabular-nums">{fmtInt(run.modelCalls)}</span> <span className="text-faint">· {fmtInt(run.tokensInput)} in / {fmtInt(run.tokensOutput)} out tokens</span></Row>
          <Row label="Tool calls"><span className="font-mono tabular-nums">{fmtInt(run.toolCalls)}</span></Row>
          <Row label="Cost"><span className="font-mono tabular-nums">{fmtUsd(run.costUsd)}</span></Row>
          <Row label="Checkpoint">{currentStep ? <span className="font-mono">{currentStep}</span> : <span className="text-faint">none</span>} <span className="text-faint">(step names from checkpoint events; the checkpoint body is content)</span></Row>
          <Row label="Task">{detail.task ? <span>{detail.task.title} <StateBadge kind="task" value={detail.task.state} /> <span className="text-faint">· {detail.task.priority}</span></span> : <span className="text-faint">no task</span>}</Row>
          <Row label="Parent run">{run.parentRunId ? <button type="button" className="underline" onClick={() => onSelectRun(run.parentRunId!)}><ShortId id={run.parentRunId} /></button> : <span className="text-faint">none</span>}</Row>
          <Row label="Child runs">
            {detail.childRuns.length === 0 ? (
              <span className="text-faint">none</span>
            ) : (
              <span className="flex flex-wrap gap-1">
                {detail.childRuns.map((c) => (
                  <button key={c.id} type="button" className={`${smallButtonClass} py-0.5`} onClick={() => onSelectRun(c.id)} title={`${c.agentName}: ${c.state}`}>
                    <ShortId id={c.id} /> <span className="ml-1">{c.agentName}</span> <span className="ml-1"><StateBadge kind="run" value={c.state} /></span>
                  </button>
                ))}
              </span>
            )}
          </Row>
          {run.errorCode ? <Row label="Error"><span className="font-mono text-danger">{run.errorCode}</span></Row> : null}
          {run.summary ? <Row label="Summary">{run.summary}</Row> : null}
        </dl>

        <div className="flex flex-wrap items-center gap-1.5 pt-1" aria-label="Controls">
          {!terminal ? (
            <form action={stopRunAction} className="contents">
              <input type="hidden" name="tenantId" value={run.tenantId} />
              <input type="hidden" name="runId" value={run.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <ConfirmButton message={`Stop run ${run.id.slice(0, 8)}? A worker already executing it stops at its next checkpoint.`} className={smallDangerClass}>Stop</ConfirmButton>
            </form>
          ) : (
            <form action={runNowAction} className="contents">
              <input type="hidden" name="tenantId" value={run.tenantId} />
              <input type="hidden" name="agentInstanceId" value={run.agentInstanceId} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <ConfirmButton message={`Queue a new run for ${run.agentName} (trigger: command)?`} className={smallPrimaryClass}>Run again</ConfirmButton>
            </form>
          )}
          <Link href={`/mission-control/runs/${run.id}`} className={smallButtonClass}>Full trace</Link>
          <Link href={`/mission-control/agents/${run.agentInstanceId}`} className={smallButtonClass}>Agent</Link>
        </div>
        {!terminal ? (
          <form action={instructRunAction} className="flex flex-wrap items-center gap-1" aria-label="Instruct">
            <input type="hidden" name="tenantId" value={run.tenantId} />
            <input type="hidden" name="runId" value={run.id} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <input name="text" required minLength={3} maxLength={2000} placeholder="Instruction at the next checkpoint" className={`${inputClass} min-w-40 flex-1 py-1 text-xs`} />
            <button type="submit" className={smallPrimaryClass}>Instruct</button>
          </form>
        ) : null}
      </Panel>

      {detail.approvals.length > 0 ? (
        <Panel title={<>Approvals <span className="ml-1 font-mono text-[11px] text-muted">{detail.approvals.length}</span></>}>
          {detail.approvals.map((a) => (
            <article key={a.id} className={`rounded-lg border border-border border-l-4 bg-surface-2 px-3 py-2 ${a.state === "pending" ? "border-l-warning" : "border-l-faint"}`}>
              <div className="text-sm">{a.summary}</div>
              <div className="flex flex-wrap items-center gap-1 text-xs text-muted">
                <StateBadge kind="approval" value={a.state} /> <StateBadge kind="risk" value={a.risk} /> · needs {a.approverRole} · {fmtAgo(a.createdAt, now)}
              </div>
              {a.state === "pending" ? (
                a.operatorMayDecide ? (
                  <form action={decideApprovalAction} className="mt-1 flex flex-wrap items-center gap-1">
                    <input type="hidden" name="tenantId" value={run.tenantId} />
                    <input type="hidden" name="approvalId" value={a.id} />
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <input name="note" placeholder="note (optional)" maxLength={1000} className={`${inputClass} w-36 py-1 text-xs`} />
                    <button type="submit" name="decision" value="approved" className={smallPrimaryClass}>Approve</button>
                    <ConfirmButton name="decision" value="rejected" message="Reject this approval? The suspended run will be cancelled." className={smallDangerClass}>Reject</ConfirmButton>
                    {!operatorRoles.includes(a.approverRole) && !operatorRoles.includes("superadmin") ? <span className="text-[11px] text-faint">your roles do not include {a.approverRole}</span> : null}
                  </form>
                ) : (
                  <div className="mt-1 text-xs text-muted">
                    Client decision ({a.approverRole}): <Link href={`/c/${run.tenantSlug}/approvals/${a.id}`} className="underline">open in client workspace</Link>
                  </div>
                )
              ) : null}
            </article>
          ))}
          {pendingApprovals.length === 0 ? <div className="text-[11px] text-faint">No pending approval on this run.</div> : null}
        </Panel>
      ) : null}

      {detail.incidents.length > 0 ? (
        <Panel title={<>Incidents <span className="ml-1 font-mono text-[11px] text-muted">{detail.incidents.length}</span></>}>
          {detail.incidents.map((i) => (
            <article key={i.id} className={`rounded-lg border border-border border-l-4 bg-surface-2 px-3 py-2 ${i.state === "resolved" ? "border-l-faint" : "border-l-danger"}`}>
              <div className="text-sm">{i.title}</div>
              <div className="flex flex-wrap items-center gap-1 text-xs text-muted">
                {i.kind.replaceAll("_", " ")} · <StateBadge kind="incident" value={i.state} /> · {i.severity} · {fmtAgo(i.createdAt, now)}
              </div>
              {i.state !== "resolved" ? (
                <form action={incidentAction} className="mt-1 flex flex-wrap gap-1">
                  <input type="hidden" name="incidentId" value={i.id} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  {i.state === "open" ? <button type="submit" name="action" value="acknowledge" className={smallButtonClass}>Acknowledge</button> : null}
                  <ConfirmButton name="action" value="resolve" message="Resolve this incident?" className={smallPrimaryClass}>Resolve</ConfirmButton>
                </form>
              ) : null}
            </article>
          ))}
          {openIncidents.length === 0 ? <div className="text-[11px] text-faint">All incidents on this run are resolved.</div> : null}
        </Panel>
      ) : null}

      <Panel title={<>Instructions <span className="ml-1 font-mono text-[11px] text-muted">{detail.instructions.length}</span></>}>
        {detail.instructions.length === 0 ? (
          <div className="text-[11px] text-faint">No operator instruction queued for this run{terminal ? "" : "; use Instruct above"}.</div>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {detail.instructions.map((i) => (
              <li key={i.id} className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs">
                <div className="text-fg">{i.text}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted">
                  by <span className="font-mono" title={i.createdByActorId}>{i.createdByActorId.slice(0, 8)}</span> · {fmtAgo(i.createdAt, now)} ·
                  {i.consumedAt ? <Badge tone="success">applied at step {i.consumedAtStep ?? "?"}</Badge> : <Badge tone="warning">pending next checkpoint</Badge>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <Panel
        title={<>Events <span className="ml-1 font-mono text-[11px] text-muted">{events.length}{filter !== "all" ? ` of ${detail.events.length}` : ""}</span></>}
        right={
          <select aria-label="Event kind filter" className={`${selectClass} py-1 text-xs`} value={filter} onChange={(e) => onFilter(isEventFilter(e.target.value) ? e.target.value : "all")}>
            {EVENT_FILTERS.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        }
      >
        {events.length === 0 ? (
          <Empty>{detail.events.length === 0 ? "No events recorded yet." : "No events of this kind."}</Empty>
        ) : (
          <ol className="max-h-[50vh] overflow-y-auto divide-y divide-border text-xs" aria-label="Event feed, newest first">
            {events.map((e) => (
              <li key={e.id} className="grid grid-cols-[64px_minmax(0,1fr)] gap-2 py-1.5">
                <span className="font-mono text-[11px] text-faint" title={fmtDate(e.occurredAt)}>{fmtClockSeconds(e.occurredAt)}</span>
                <span className="min-w-0">
                  <Badge tone={EVENT_TONE[eventKindTone(e.kind)]}>{e.kind.replaceAll("_", " ")}</Badge>
                  <span className="ml-1.5 text-fg">{e.summary}</span>
                  <span className="ml-1 text-faint">
                    #{e.seq}
                    {e.classification !== "internal" && e.classification !== "public" ? ` · ${e.classification}` : ""}
                    {e.tokensInput || e.tokensOutput ? ` · ${fmtInt(e.tokensInput)}/${fmtInt(e.tokensOutput)} tokens` : ""}
                    {e.costUsd ? ` · ${fmtUsd(e.costUsd)}` : ""}
                    {e.durationMs ? ` · ${fmtDuration(e.durationMs)}` : ""}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
        <p className="text-[11px] text-faint">
          {detail.eventsTotal > detail.events.length ? `Newest ${detail.events.length} of ${detail.eventsTotal} events; ` : ""}
          payloads are content the operator role cannot read; summaries only.
        </p>
      </Panel>
    </>
  );
}
