import Link from "next/link";
import { Badge, Card, Empty, Stat, Status } from "@/components/ui";
import { PageHeader, ShortId, SimulatedBadge, Table, Td, Tr } from "@/components/agent-ui";
import { fmtDate, fmtInt, fmtUsd } from "@/lib/format";
import { getCostsView } from "@/lib/mission-control/queries";
import { requireOperatorContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

function Bar({ spent, cap, warnRatio = 0.8 }: { spent: number; cap: number | null; warnRatio?: number }) {
  if (cap === null || cap <= 0) return <span className="text-xs text-faint">no cap row</span>;
  const ratio = Math.min(1, spent / cap);
  const tone = ratio >= 1 ? "bg-danger" : ratio >= warnRatio ? "bg-warning" : "bg-cyan";
  return (
    <div className="min-w-32">
      <div className="h-1.5 w-full rounded bg-surface-2"><div className={`h-1.5 rounded ${tone}`} style={{ width: `${Math.round(ratio * 100)}%` }} /></div>
      <div className="mt-1 text-xs text-faint">{Math.round(ratio * 100)}% of {fmtUsd(cap, 2)}</div>
    </div>
  );
}

export default async function CostsPage() {
  await requireOperatorContext();
  const v = await getCostsView();
  const p = v.platform;
  const ratio = p && p.capUsdMonth > 0 ? Math.min(1, p.spentUsdMonth / p.capUsdMonth) : 0;
  return (
    <div className="space-y-6">
      <PageHeader title="Costs">
        Model spend recorded per call in <code>cost_events</code> (ADR-016), aggregated since {fmtDate(v.monthStart).slice(0, 10)} UTC. Numbers are read through the operator role; the platform cap is read with <code>readPlatformBudget</code>. <Status state="implemented" />
      </PageHeader>

      <div className="grid gap-4 md:grid-cols-4">
        <Stat label="Platform cap" value={p ? fmtUsd(p.capUsdMonth, 2) : "none"} hint={p ? (p.hardStop ? "hard stop at 100%" : "soft cap") : "no platform budget row"} />
        <Stat label="Spent month to date" value={fmtUsd(v.perTenant.reduce((a, t) => a + t.spentUsdMonth, 0), 4)} hint={p ? `${Math.round(ratio * 100)}% of cap` : "all tenants"} />
        <Stat label="Of which simulated" value={fmtUsd(v.perTenant.reduce((a, t) => a + t.simulatedUsd, 0), 4)} hint="estimated price of SimulatedModel calls, no real spend" />
        <Stat label="Run cap" value={p ? fmtUsd(p.runCapUsd, 2) : "n/a"} hint="per run, platform default" />
      </div>

      {p ? (
        <Card title="Platform budget" footer="The worker refuses a run when the platform, tenant or agent cap is reached (hard stop) and raises a budget_exceeded incident. 80% produces a warning event on the run.">
          <div className="h-3 w-full rounded bg-surface-2"><div className={`h-3 rounded ${ratio >= 1 ? "bg-danger" : ratio >= 0.8 ? "bg-warning" : "sb-gradient-bar"}`} style={{ width: `${Math.round(ratio * 100)}%` }} /></div>
          <div className="mt-2 flex justify-between text-sm"><span>{fmtUsd(p.spentUsdMonth, 4)} spent</span><span className="text-muted">{fmtUsd(p.capUsdMonth, 2)} cap</span></div>
        </Card>
      ) : (
        <Card title="Platform budget"><Empty>No platform budget row. The seed inserts one (USD 25 per month).</Empty></Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Per tenant (month to date)">
          <Table head={["Tenant", "Spent", "Simulated", "Calls", "Cap"]} empty={v.perTenant.length === 0 ? <Empty>No client tenants.</Empty> : null}>
            {v.perTenant.map((t) => (
              <Tr key={t.tenantId}>
                <Td><Link href={`/mission-control/clients/${t.tenantSlug}`} className="underline">{t.tenantName}</Link></Td>
                <Td>{fmtUsd(t.spentUsdMonth)}</Td>
                <Td className="text-muted">{fmtUsd(t.simulatedUsd)}</Td>
                <Td className="text-muted">{fmtInt(t.events)}</Td>
                <Td><Bar spent={t.spentUsdMonth} cap={t.capUsdMonth} /></Td>
              </Tr>
            ))}
          </Table>
        </Card>
        <Card title="Per agent instance (month to date)">
          <Table head={["Agent", "Tenant", "Spent", "Calls", "Cap"]} empty={v.perAgent.length === 0 ? <Empty>No agent instances.</Empty> : null}>
            {v.perAgent.map((a) => (
              <Tr key={a.agentInstanceId}>
                <Td><Link href={`/mission-control/agents/${a.agentInstanceId}`} className="underline">{a.agentName}</Link></Td>
                <Td className="text-muted">{a.tenantName}</Td>
                <Td>{fmtUsd(a.spentUsdMonth)}</Td>
                <Td className="text-muted">{fmtInt(a.events)}</Td>
                <Td><Bar spent={a.spentUsdMonth} cap={a.capUsdMonth} /></Td>
              </Tr>
            ))}
          </Table>
        </Card>
      </div>

      <Card title="Last 50 cost events" footer="One row per model call. Simulated rows carry the price the call would have had; they are labelled so no simulated spend is mistaken for real spend.">
        <Table head={["At", "Tenant", "Agent", "Run", "Model", "Tokens in/out", "Cost", "Mode"]} empty={v.recent.length === 0 ? <Empty>No model calls recorded yet. Start a run from an Agent Detail page; the worker records one cost event per call.</Empty> : null}>
          {v.recent.map((c) => (
            <Tr key={c.id}>
              <Td className="text-muted">{fmtDate(c.occurredAt)}</Td>
              <Td>{c.tenantName}</Td>
              <Td className="text-muted">{c.agentName ?? "n/a"}</Td>
              <Td>{c.runId ? <Link href={`/mission-control/runs/${c.runId}`} className="underline"><ShortId id={c.runId} /></Link> : <span className="text-faint">n/a</span>}</Td>
              <Td><Badge>{c.model}</Badge></Td>
              <Td className="text-muted">{fmtInt(c.tokensInput)} / {fmtInt(c.tokensOutput)}</Td>
              <Td>{fmtUsd(c.costUsd)}</Td>
              <Td><SimulatedBadge simulated={c.simulated} /></Td>
            </Tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
