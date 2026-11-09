import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, Empty, Status, buttonClass, buttonSecondaryClass, inputClass } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { Masked, Notice, PageHeader, ShortId, SimulatedBadge, StateBadge, Table, Td, Tr, TriggerBadge, selectClass, smallButtonClass, smallDangerClass } from "@/components/agent-ui";
import { firstParam, fmtDate, fmtInt, fmtUsd } from "@/lib/format";
import { assignTaskAction, cancelOpenRunsAction, giveFeedbackAction, runNowAction, setAgentStateAction, stopRunAction } from "@/lib/mission-control/actions";
import { STOPPABLE_RUN_STATES, getAgentDetail } from "@/lib/mission-control/queries";
import { requireOperatorContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function AgentDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Search }) {
  const { id } = await params;
  const sp = await searchParams;
  await requireOperatorContext();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await getAgentDetail(id);
  if (!d) notFound();
  const returnTo = `/mission-control/agents/${id}`;
  const paused = d.instance.state === "paused" || d.instance.state === "disabled";
  const openRuns = d.runs.filter((r) => (STOPPABLE_RUN_STATES as readonly string[]).includes(r.state));

  return (
    <div className="space-y-6">
      <PageHeader title={d.instance.name} crumbs={[{ href: "/mission-control/agents", label: "Agents" }, { label: d.instance.name }]}>
        {d.definition.name} for <Link href={`/mission-control/clients/${d.instance.tenantSlug}`} className="underline">{d.instance.tenantName}</Link>. Metadata and actions are real; content columns stay masked for operators. <Status state="implemented" />
      </PageHeader>
      <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />

      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Instance">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-faint">State</dt><dd><StateBadge kind="agent" value={d.instance.state} /></dd></div>
            <div className="flex justify-between"><dt className="text-faint">Service identity</dt><dd className="font-mono text-xs">{d.instance.serviceIdentity}</dd></div>
            <div className="flex justify-between"><dt className="text-faint">Model</dt><dd>{d.instance.model ?? d.definition.defaultModel}{d.instance.model ? "" : " (definition default)"}</dd></div>
            <div className="flex justify-between"><dt className="text-faint">Skill version</dt><dd>{d.skillVersion ? `${d.skillVersion.version} (${d.skillVersion.releaseChannel})` : "none pinned"}</dd></div>
            <div className="flex justify-between"><dt className="text-faint">Last run</dt><dd>{fmtDate(d.instance.lastRunAt)}</dd></div>
            <div className="flex justify-between"><dt className="text-faint">Next scheduled</dt><dd>{fmtDate(d.instance.nextScheduledRunAt)}</dd></div>
            <div className="flex justify-between"><dt className="text-faint">Created</dt><dd>{fmtDate(d.instance.createdAt)}</dd></div>
          </dl>
        </Card>
        <Card title="Definition">
          <dl className="space-y-2 text-sm">
            <div><dt className="text-faint">Key</dt><dd className="font-mono text-xs">{d.definition.key}</dd></div>
            <div><dt className="text-faint">Mission</dt><dd>{d.definition.mission}</dd></div>
            <div className="flex justify-between"><dt className="text-faint">Authority</dt><dd><Badge tone="indigo">{d.definition.authority}</Badge></dd></div>
            <div className="flex justify-between"><dt className="text-faint">Escalates to</dt><dd>{d.definition.escalationRole ?? "n/a"}</dd></div>
            <div><dt className="text-faint">Allowed tools</dt><dd className="mt-1 flex flex-wrap gap-1">{d.definition.allowedTools.map((t) => <Badge key={t}>{t}</Badge>)}</dd></div>
          </dl>
        </Card>
        <Card title="Budgets (month to date)" footer="Caps are enforced by the worker before every run and model call (ADR-016). Spend is the sum of cost_events since the first of the month, UTC.">
          {d.budgets.length === 0 ? <Empty>No budget rows for this tenant or instance. The platform cap still applies.</Empty> : (
            <ul className="space-y-3 text-sm">
              {d.budgets.map((b) => {
                const ratio = b.capUsdMonth > 0 ? Math.min(1, b.spentUsdMonth / b.capUsdMonth) : 0;
                const tone = ratio >= 1 ? "bg-danger" : ratio >= b.warnRatio ? "bg-warning" : "bg-cyan";
                return (
                  <li key={b.id}>
                    <div className="flex justify-between"><span>{b.scope.replace("_", " ")}</span><span>{fmtUsd(b.spentUsdMonth, 2)} / {fmtUsd(b.capUsdMonth, 2)}</span></div>
                    <div className="mt-1 h-1.5 w-full rounded bg-surface-2"><div className={`h-1.5 rounded ${tone}`} style={{ width: `${Math.round(ratio * 100)}%` }} /></div>
                    <div className="mt-1 text-xs text-faint">run cap {fmtUsd(b.runCapUsd, 2)} · warn at {Math.round(b.warnRatio * 100)}% · {b.hardStop ? "hard stop" : "soft"}</div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Assign task" footer="Creates an agent_tasks row (state assigned) and a run with trigger command, then enqueues the job for the worker. The instruction is stored as content: after submit it is masked for operators.">
          <form action={assignTaskAction} className="space-y-3">
            <input type="hidden" name="tenantId" value={d.instance.tenantId} />
            <input type="hidden" name="agentInstanceId" value={d.instance.id} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <label className="block text-xs text-muted">Title<input name="title" required maxLength={200} className={`${inputClass} mt-1`} placeholder="Discovery round: finance evidence gaps" /></label>
            <label className="block text-xs text-muted">Instruction<textarea name="instruction" required maxLength={4000} rows={4} className={`${inputClass} mt-1`} placeholder="What the agent should do this run. Stored as task content." /></label>
            <label className="block text-xs text-muted">Priority
              <select name="priority" defaultValue="medium" className={`${selectClass} mt-1 w-full`}>
                <option value="critical">critical</option><option value="high">high</option><option value="medium">medium</option><option value="low">low</option>
              </select>
            </label>
            <button type="submit" className={buttonClass} disabled={paused}>Assign and queue run</button>
            {paused ? <span className="ml-2 text-xs text-warning">agent is {d.instance.state}; resume first</span> : null}
          </form>
        </Card>
        <Card title="Give feedback" footer="Stored in agent_feedback with your actor id. Feedback does not change the skill by itself; the flag marks it for the skill review queue (M4).">
          <form action={giveFeedbackAction} className="space-y-3">
            <input type="hidden" name="tenantId" value={d.instance.tenantId} />
            <input type="hidden" name="agentInstanceId" value={d.instance.id} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <label className="block text-xs text-muted">Kind
              <select name="kind" defaultValue="instruction" className={`${selectClass} mt-1 w-full`}>
                <option value="correction">correction</option><option value="approval">approval</option><option value="rejection">rejection</option><option value="clarification">clarification</option><option value="instruction">instruction</option>
              </select>
            </label>
            <label className="block text-xs text-muted">Run (optional)
              <select name="runId" defaultValue="" className={`${selectClass} mt-1 w-full`}>
                <option value="">not tied to a run</option>
                {d.runs.slice(0, 10).map((r) => <option key={r.id} value={r.id}>{r.id.slice(0, 8)} · {r.state} · {fmtDate(r.createdAt)}</option>)}
              </select>
            </label>
            <label className="block text-xs text-muted">Message<textarea name="message" required maxLength={2000} rows={3} className={`${inputClass} mt-1`} /></label>
            <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" name="shouldUpdateSkill" /> propose a skill update from this feedback</label>
            <button type="submit" className={buttonClass}>Record feedback</button>
          </form>
        </Card>
      </div>

      <Card title="Controls" footer="Pause sets agent_instances.state = paused: the worker cancels any run it picks up for a paused agent and raises a low-severity admission_refused incident. Resume sets idle. Run now creates a run with trigger command.">
        <div className="flex flex-wrap gap-3">
          <form action={runNowAction}>
            <input type="hidden" name="tenantId" value={d.instance.tenantId} /><input type="hidden" name="agentInstanceId" value={d.instance.id} /><input type="hidden" name="returnTo" value={returnTo} />
            <button type="submit" className={buttonClass} disabled={paused}>Run now</button>
          </form>
          {paused ? (
            <form action={setAgentStateAction}>
              <input type="hidden" name="tenantId" value={d.instance.tenantId} /><input type="hidden" name="agentInstanceId" value={d.instance.id} /><input type="hidden" name="returnTo" value={returnTo} /><input type="hidden" name="state" value="idle" />
              <button type="submit" className={buttonSecondaryClass}>Resume</button>
            </form>
          ) : (
            <form action={setAgentStateAction}>
              <input type="hidden" name="tenantId" value={d.instance.tenantId} /><input type="hidden" name="agentInstanceId" value={d.instance.id} /><input type="hidden" name="returnTo" value={returnTo} /><input type="hidden" name="state" value="paused" />
              <ConfirmButton message="Pause this agent? New runs will be refused until it is resumed." className={buttonSecondaryClass}>Pause</ConfirmButton>
            </form>
          )}
          {openRuns.length > 0 ? (
            <form action={cancelOpenRunsAction}>
              <input type="hidden" name="tenantId" value={d.instance.tenantId} /><input type="hidden" name="agentInstanceId" value={d.instance.id} /><input type="hidden" name="returnTo" value={returnTo} />
              <ConfirmButton message={`Cancel ${openRuns.length} open run(s) of this agent?`} className={smallDangerClass}>Stop all open runs ({openRuns.length})</ConfirmButton>
            </form>
          ) : null}
        </div>
      </Card>

      <Card title="Last 20 runs" footer="Every run shows its trigger: schedule, event, command, resume or recovery. There is no claim of 24/7 activity. Stop is available for queued, running, waiting, paused and interrupted runs.">
        <Table head={["Run", "Trigger", "State", "Attempt", "Tokens in/out", "Cost", "Mode", "Started", "Finished", "Summary", ""]} empty={d.runs.length === 0 ? <Empty>No runs yet for this agent. Use Run now or assign a task.</Empty> : null}>
          {d.runs.map((r) => (
            <Tr key={r.id}>
              <Td><Link href={`/mission-control/runs/${r.id}`} className="underline"><ShortId id={r.id} /></Link></Td>
              <Td><TriggerBadge trigger={r.trigger} /></Td>
              <Td><StateBadge kind="run" value={r.state} /></Td>
              <Td className="text-muted">{r.attempt}</Td>
              <Td className="text-muted">{fmtInt(r.tokensInput)} / {fmtInt(r.tokensOutput)}</Td>
              <Td>{fmtUsd(r.costUsd)}</Td>
              <Td><SimulatedBadge simulated={r.simulated} /></Td>
              <Td className="text-muted">{fmtDate(r.startedAt)}</Td>
              <Td className="text-muted">{fmtDate(r.finishedAt)}</Td>
              <Td className="max-w-xs truncate text-muted" >{r.summary ?? ""}</Td>
              <Td>
                {(STOPPABLE_RUN_STATES as readonly string[]).includes(r.state) ? (
                  <form action={stopRunAction}>
                    <input type="hidden" name="tenantId" value={r.tenantId} /><input type="hidden" name="runId" value={r.id} /><input type="hidden" name="returnTo" value={returnTo} />
                    <ConfirmButton message={`Stop run ${r.id.slice(0, 8)}?`} className={smallDangerClass}>Stop</ConfirmButton>
                  </form>
                ) : null}
              </Td>
            </Tr>
          ))}
        </Table>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Open tasks" footer="Title, priority and state only. The instruction column is not granted to the operator role.">
          <Table head={["Task", "Title", "Priority", "State", "Instruction", "Due", "Created"]} empty={d.openTasks.length === 0 ? <Empty>No open tasks.</Empty> : null}>
            {d.openTasks.map((t) => (
              <Tr key={t.id}>
                <Td><ShortId id={t.id} /></Td>
                <Td className="font-medium">{t.title}</Td>
                <Td><Badge tone={t.priority === "critical" ? "danger" : t.priority === "high" ? "warning" : "neutral"}>{t.priority}</Badge></Td>
                <Td><StateBadge kind="task" value={t.state} /></Td>
                <Td><Masked what="instruction" /></Td>
                <Td className="text-muted">{fmtDate(t.dueAt)}</Td>
                <Td className="text-muted">{fmtDate(t.createdAt)}</Td>
              </Tr>
            ))}
          </Table>
        </Card>
        <Card title="Schedules" footer="Managed on the Schedules page. pg-boss is the clock; this table is the truth the worker reconciles every minute.">
          <Table head={["Name", "Cron", "TZ", "Enabled", "Last", "Next"]} empty={d.schedules.length === 0 ? <Empty>No schedules. This agent runs only on command or event.</Empty> : null}>
            {d.schedules.map((s) => (
              <Tr key={s.id}>
                <Td className="font-medium"><Link href="/mission-control/schedules" className="underline">{s.name}</Link></Td>
                <Td className="font-mono text-xs">{s.cron}</Td>
                <Td className="text-muted">{s.timezone}</Td>
                <Td><Badge tone={s.enabled ? "success" : "neutral"}>{s.enabled ? "enabled" : "disabled"}</Badge></Td>
                <Td className="text-muted">{fmtDate(s.lastRunAt)}</Td>
                <Td className="text-muted">{fmtDate(s.nextRunAt)}</Td>
              </Tr>
            ))}
          </Table>
        </Card>
      </div>

      <Card title="Recent feedback" footer="Written by operators or client users; the given_by actor id is the user id from the session.">
        <Table head={["When", "Kind", "By", "Run", "Message"]} empty={d.feedback.length === 0 ? <Empty>No feedback recorded for this agent.</Empty> : null}>
          {d.feedback.map((f) => (
            <Tr key={f.id}>
              <Td className="text-muted">{fmtDate(f.createdAt)}</Td>
              <Td><Badge tone="cyan">{f.kind}</Badge></Td>
              <Td><ShortId id={f.givenByActorId.length >= 8 ? f.givenByActorId : f.givenByActorId.padEnd(8)} /></Td>
              <Td>{f.runId ? <Link href={`/mission-control/runs/${f.runId}`} className="underline"><ShortId id={f.runId} /></Link> : <span className="text-faint">n/a</span>}</Td>
              <Td>{f.message}</Td>
            </Tr>
          ))}
        </Table>
        <div className="mt-3 text-xs text-faint"><Link href="/mission-control/agents" className={smallButtonClass}>Back to agents</Link></div>
      </Card>
    </div>
  );
}
