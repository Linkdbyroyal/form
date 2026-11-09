import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, Empty, Status } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { Masked, Notice, PageHeader, ShortId, SimulatedBadge, StateBadge, Table, Td, Tr, TriggerBadge, smallDangerClass } from "@/components/agent-ui";
import { firstParam, fmtDate, fmtDuration, fmtInt, fmtUsd } from "@/lib/format";
import { stopRunAction } from "@/lib/mission-control/actions";
import { STOPPABLE_RUN_STATES, getRunDetail } from "@/lib/mission-control/queries";
import { requireOperatorContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

export default async function RunDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  await requireOperatorContext();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await getRunDetail(id);
  if (!d) notFound();
  const { run } = d;
  const returnTo = `/mission-control/runs/${id}`;
  const stoppable = (STOPPABLE_RUN_STATES as readonly string[]).includes(run.state);
  const error = run.error && typeof run.error === "object" ? (run.error as Record<string, unknown>) : null;
  return (
    <div className="space-y-6">
      <PageHeader title={`Run ${id.slice(0, 8)}`} crumbs={[{ href: "/mission-control/runs", label: "Runs & Traces" }, { label: id.slice(0, 8) }]}>
        {run.agentName} for <Link href={`/mission-control/clients/${run.tenantSlug}`} className="underline">{run.tenantName}</Link>. Timeline of <code>run_events</code> with neutral summaries; payloads are masked for operators (M1-09). <Status state="implemented" />
      </PageHeader>
      <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />

      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Run">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-faint">State</dt><dd><StateBadge kind="run" value={run.state} /></dd></div>
            <div className="flex justify-between"><dt className="text-faint">Trigger</dt><dd><TriggerBadge trigger={run.trigger} /> {run.triggerRef ? <span className="font-mono text-xs text-faint">{run.triggerRef.length > 24 ? `${run.triggerRef.slice(0, 24)}…` : run.triggerRef}</span> : null}</dd></div>
            <div className="flex justify-between"><dt className="text-faint">Attempt</dt><dd>{run.attempt}</dd></div>
            <div className="flex justify-between"><dt className="text-faint">Mode</dt><dd><SimulatedBadge simulated={run.simulated} /></dd></div>
            <div className="flex justify-between"><dt className="text-faint">Agent</dt><dd><Link href={`/mission-control/agents/${run.agentInstanceId}`} className="underline">{run.agentName}</Link></dd></div>
            <div className="flex justify-between"><dt className="text-faint">Job id</dt><dd className="font-mono text-xs">{run.jobId ? run.jobId.slice(0, 8) : "n/a"}</dd></div>
          </dl>
        </Card>
        <Card title="Timing and cost">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-faint">Created</dt><dd>{fmtDate(run.createdAt)}</dd></div>
            <div className="flex justify-between"><dt className="text-faint">Started</dt><dd>{fmtDate(run.startedAt)}</dd></div>
            <div className="flex justify-between"><dt className="text-faint">Finished</dt><dd>{fmtDate(run.finishedAt)}</dd></div>
            <div className="flex justify-between"><dt className="text-faint">Lease expires</dt><dd>{fmtDate(run.leaseExpiresAt)}</dd></div>
            <div className="flex justify-between"><dt className="text-faint">Tokens in / out</dt><dd>{fmtInt(run.tokensInput)} / {fmtInt(run.tokensOutput)}</dd></div>
            <div className="flex justify-between"><dt className="text-faint">Cost</dt><dd>{fmtUsd(run.costUsd)}</dd></div>
          </dl>
        </Card>
        <Card title="Context">
          <dl className="space-y-2 text-sm">
            <div><dt className="text-faint">Summary (agent-written, neutral)</dt><dd>{run.summary ?? <span className="text-faint">none yet</span>}</dd></div>
            <div><dt className="text-faint">Task</dt><dd>{d.task ? <span>{d.task.title} <StateBadge kind="task" value={d.task.state} /></span> : <span className="text-faint">no task</span>}</dd></div>
            <div><dt className="text-faint">Checkpoint / result</dt><dd><Masked what="checkpoint and result" /></dd></div>
            {stoppable ? (
              <form action={stopRunAction} className="pt-2">
                <input type="hidden" name="tenantId" value={run.tenantId} /><input type="hidden" name="runId" value={run.id} /><input type="hidden" name="returnTo" value={returnTo} />
                <ConfirmButton message={`Stop run ${run.id.slice(0, 8)}?`} className={smallDangerClass}>Stop run</ConfirmButton>
              </form>
            ) : null}
          </dl>
        </Card>
      </div>

      {error ? (
        <Card title="Error (metadata column)" footer="agent_runs.error holds the failure class and a message written by the worker; it is metadata and therefore readable here.">
          <pre className="overflow-x-auto rounded-md bg-surface-2 p-3 text-xs text-danger">{JSON.stringify(error, null, 2)}</pre>
        </Card>
      ) : null}

      <Card title={`Timeline (${d.events.length} events)`} footer="Each event has a sequence number, a kind, a classification and a one-line summary. The payload column is never selected by the operator view; it appears as Masked whatever its classification.">
        <Table head={["Seq", "Kind", "Classification", "Summary", "Payload", "Tokens in/out", "Cost", "Duration", "At"]} empty={d.events.length === 0 ? <Empty>No events recorded yet.</Empty> : null}>
          {d.events.map((e) => (
            <Tr key={e.id}>
              <Td className="text-muted">{e.seq}</Td>
              <Td><Badge tone={e.kind === "error" || e.kind === "tool_denied" ? "danger" : e.kind === "model_call" ? "cyan" : e.kind === "state_change" ? "indigo" : "neutral"}>{e.kind.replaceAll("_", " ")}</Badge></Td>
              <Td><StateBadge kind="classification" value={e.classification} /></Td>
              <Td>{e.summary}</Td>
              <Td><Masked what="payload" /></Td>
              <Td className="text-muted">{e.tokensInput || e.tokensOutput ? `${fmtInt(e.tokensInput)} / ${fmtInt(e.tokensOutput)}` : ""}</Td>
              <Td className="text-muted">{e.costUsd ? fmtUsd(e.costUsd) : ""}</Td>
              <Td className="text-muted">{fmtDuration(e.durationMs)}</Td>
              <Td className="text-muted">{fmtDate(e.occurredAt)}</Td>
            </Tr>
          ))}
        </Table>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Approvals linked to this run">
          <Table head={["Approval", "State", "Risk", "Approver role", "Summary", "Created"]} empty={d.approvals.length === 0 ? <Empty>No approval requested by this run.</Empty> : null}>
            {d.approvals.map((a) => (
              <Tr key={a.id}>
                <Td><Link href="/mission-control/approvals" className="underline"><ShortId id={a.id} /></Link></Td>
                <Td><StateBadge kind="approval" value={a.state} /></Td>
                <Td><StateBadge kind="risk" value={a.risk} /></Td>
                <Td className="text-muted">{a.approverRole}</Td>
                <Td>{a.summary}</Td>
                <Td className="text-muted">{fmtDate(a.createdAt)}</Td>
              </Tr>
            ))}
          </Table>
        </Card>
        <Card title="Incidents linked to this run">
          <Table head={["Incident", "Kind", "Severity", "State", "Title", "Created"]} empty={d.incidents.length === 0 ? <Empty>No incidents for this run.</Empty> : null}>
            {d.incidents.map((i) => (
              <Tr key={i.id}>
                <Td><Link href="/mission-control/errors" className="underline"><ShortId id={i.id} /></Link></Td>
                <Td className="text-muted">{i.kind.replaceAll("_", " ")}</Td>
                <Td><StateBadge kind="risk" value={i.severity} /></Td>
                <Td><StateBadge kind="incident" value={i.state} /></Td>
                <Td>{i.title}</Td>
                <Td className="text-muted">{fmtDate(i.createdAt)}</Td>
              </Tr>
            ))}
          </Table>
        </Card>
      </div>
    </div>
  );
}
