import Link from "next/link";
import { Card, Empty, Stat, Status } from "@/components/ui";
import { StateBadge } from "@/components/agent-ui";
import { fmtUsd } from "@/lib/format";
import { getMissionControlSummary, listApprovals, listIncidents } from "@/lib/mission-control/queries";
import { getOperatorOverview } from "@/lib/queries";
import { requireOperatorContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

export default async function MissionControlOverview() {
  await requireOperatorContext();
  const [o, s, approvals, openIncidents] = await Promise.all([getOperatorOverview(), getMissionControlSummary(), listApprovals(), listIncidents("open")]);
  const running = s.instancesByState.find((x) => x.state === "running")?.n ?? 0;
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="text-sm text-muted">Cross-client operational metadata. Counters come from the database through the operator role, which cannot read content columns.</p>
      </header>
      <div className="grid gap-4 md:grid-cols-4">
        <Stat label="Tenants" value={o.tenants} hint="incl. agency tenant" />
        <Stat label="Client workspaces" value={o.clientTenants} hint="synthetic demo tenants" />
        <Stat label="Audit events (24h)" value={o.auditEvents24h} hint="append-only table" />
        <Stat label="Agents running" value={running} hint={`${s.instances} instances, ${s.runsActive} open runs`} />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Agent activity" footer="Instances by state (written by the worker on every run transition) and run outcomes in the last 24 hours. Every run carries its trigger: schedule, event or command; no 24/7 claim.">
          {s.instances === 0 ? (
            <Empty>No agent instances yet. Run the seed to create one Discovery agent per demo tenant.</Empty>
          ) : (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap gap-2">
                {s.instancesByState.map((x) => (
                  <span key={x.state} className="flex items-center gap-1"><StateBadge kind="agent" value={x.state} /><span className="text-muted">{x.n}</span></span>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-md border border-border p-2"><div className="text-xs text-faint">succeeded (24h)</div><div className="text-lg font-semibold text-success">{s.runsLast24h.succeeded}</div></div>
                <div className="rounded-md border border-border p-2"><div className="text-xs text-faint">failed (24h)</div><div className="text-lg font-semibold text-danger">{s.runsLast24h.failed}</div></div>
                <div className="rounded-md border border-border p-2"><div className="text-xs text-faint">other (24h)</div><div className="text-lg font-semibold">{s.runsLast24h.other}</div></div>
              </div>
              <div className="flex justify-between text-xs text-muted">
                <span>Month-to-date cost {fmtUsd(s.monthToDateUsd)} ({fmtUsd(s.monthToDateSimulatedUsd)} simulated)</span>
                <span><Link href="/mission-control/agents" className="underline">Agents</Link> · <Link href="/mission-control/runs" className="underline">Runs</Link> · <Link href="/mission-control/costs" className="underline">Costs</Link></span>
              </div>
            </div>
          )}
        </Card>
        <Card title="Approvals pending" footer="Operators decide agency-role approvals here; client-role approvals are decided in the client workspace (ADR-018).">
          {approvals.pending.length === 0 ? (
            <Empty>No pending approvals. <Status state="implemented" /></Empty>
          ) : (
            <ul className="space-y-2 text-sm">
              {approvals.pending.slice(0, 5).map((a) => (
                <li key={a.id} className="flex items-start justify-between gap-2">
                  <span><span className="font-medium">{a.tenantName}</span>: {a.summary}</span>
                  <span className="shrink-0 text-xs text-muted">{a.approverRole}</span>
                </li>
              ))}
              {approvals.pending.length > 5 ? <li className="text-xs text-muted">and {approvals.pending.length - 5} more</li> : null}
              <li className="pt-1 text-xs"><Link href="/mission-control/approvals" className="underline">Open approvals ({s.pendingApprovals})</Link></li>
            </ul>
          )}
        </Card>
      </div>
      <Card title={`Open incidents (${s.openIncidents})`} footer="Raised by the worker for failed runs, dead-letter jobs, missed schedules, budget stops and lease expiry.">
        {openIncidents.length === 0 ? (
          <Empty>No open incidents. Silence is only meaningful while the worker is running (health endpoint on the worker).</Empty>
        ) : (
          <ul className="space-y-1 text-sm">
            {openIncidents.slice(0, 5).map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-2">
                <span><StateBadge kind="risk" value={i.severity} /> <span className="text-muted">{i.kind.replaceAll("_", " ")}</span> {i.title}</span>
                <span className="text-xs text-faint">{i.tenantName ?? "platform"}</span>
              </li>
            ))}
            <li className="pt-1 text-xs"><Link href="/mission-control/errors" className="underline">Errors &amp; Incidents</Link></li>
          </ul>
        )}
      </Card>
      <Card title="Implementation status">
        <ul className="space-y-1 text-sm">
          <li><Status state="implemented" /> PostgreSQL schema with Row-Level Security, two synthetic tenants, isolation tests</li>
          <li><Status state="implemented" /> Operator role with metadata-only access; audit trail append-only</li>
          <li><Status state="implemented" /> <Link className="underline" href="/mission-control/clients">Client Workspaces</Link> list and drill-down</li>
          <li><Status state="implemented" /> Authentication: Better Auth sessions, e-mail verification, invitation-only onboarding, TOTP required for operators (M1-01)</li>
          <li><Status state="implemented" /> Agent runtime: definitions, instances, tasks, runs with checkpoints, run events, approvals, schedules, incidents, budgets; pg-boss worker (M1-03 to M1-07)</li>
          <li><Status state="implemented" /> Mission Control modules: <Link className="underline" href="/mission-control/agents">Agents</Link>, <Link className="underline" href="/mission-control/tasks">Tasks</Link>, <Link className="underline" href="/mission-control/runs">Runs &amp; Traces</Link>, <Link className="underline" href="/mission-control/approvals">Approvals</Link>, <Link className="underline" href="/mission-control/schedules">Schedules</Link>, <Link className="underline" href="/mission-control/costs">Costs</Link>, <Link className="underline" href="/mission-control/errors">Errors &amp; Incidents</Link> (M1-08)</li>
          <li><Status state="implemented" /> Knowledge Vault metadata per client: <Link className="underline" href="/mission-control/vaults">Knowledge Vaults</Link> (counts and verification state only, M2-11)</li>
          <li><Status state="simulated" /> Model calls run through the deterministic SimulatedModel when the worker has no ANTHROPIC_API_KEY; such runs and cost events are labelled simulated</li>
          <li><Status state="planned" /> Agent Skills &amp; Versions UI, Connected Tools (M5), Agency Intelligence Vault (M4)</li>
          <li><Status state="not_connected" /> Any client system (Rentman, QuickBooks, Trengo, Dropbox)</li>
        </ul>
      </Card>
    </div>
  );
}
