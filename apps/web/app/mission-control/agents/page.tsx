import Link from "next/link";
import { Card, Empty, Status } from "@/components/ui";
import { Masked, PageHeader, StateBadge, Table, Td, Tr } from "@/components/agent-ui";
import { fmtDate, fmtUsd } from "@/lib/format";
import { listAgentInstances } from "@/lib/mission-control/queries";
import { requireOperatorContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  await requireOperatorContext();
  const rows = await listAgentInstances();
  return (
    <div className="space-y-6">
      <PageHeader title="Agents">
        Agent instances across all client tenants, read through the operator role (metadata only). Month-to-date cost comes from <code>cost_events</code>. <Status state="implemented" />
      </PageHeader>
      <Card title={`Instances (${rows.length})`} footer="State is written by the worker on every run transition. Next run comes from the schedule reconcile loop. Instance configuration (config jsonb) is metadata and readable; task instructions and run payloads are not.">
        <Table head={["Tenant", "Agent", "Definition", "State", "Skill", "Model", "Last run", "Next scheduled", "Cost MTD", ""]} empty={rows.length === 0 ? <Empty>No agent instances. Run the seed to create one Discovery agent per demo tenant.</Empty> : null}>
          {rows.map((r) => (
            <Tr key={r.id}>
              <Td><Link href={`/mission-control/clients/${r.tenantSlug}`} className="underline">{r.tenantName}</Link></Td>
              <Td className="font-medium"><Link href={`/mission-control/agents/${r.id}`} className="underline">{r.name}</Link></Td>
              <Td className="text-muted">{r.definitionKey}</Td>
              <Td><StateBadge kind="agent" value={r.state} /></Td>
              <Td className="text-muted">{r.skillVersion ?? "n/a"}</Td>
              <Td className="text-muted">{r.model ?? r.defaultModel}</Td>
              <Td className="text-muted">{fmtDate(r.lastRunAt)}</Td>
              <Td className="text-muted">{fmtDate(r.nextScheduledRunAt)}</Td>
              <Td>{fmtUsd(r.monthToDateUsd)}</Td>
              <Td><Link href={`/mission-control/agents/${r.id}`} className="text-xs underline">detail</Link></Td>
            </Tr>
          ))}
        </Table>
      </Card>
      <Card title="What you can and cannot see here">
        <ul className="space-y-1 text-sm">
          <li><Status state="implemented" /> Instance state, schedule, cost and run metadata per tenant</li>
          <li><Status state="implemented" /> Actions on the detail page: assign task, give feedback, pause, resume, run now, stop run (each writes an audit event)</li>
          <li><Masked what="task instruction, run checkpoint and result, run event payload" /> content columns are not granted to the operator role; break-glass grants (M1-18) are the only way to read them</li>
          <li><Status state="planned" /> Agent definitions catalogue and skill version management (Agent Skills &amp; Versions)</li>
        </ul>
      </Card>
    </div>
  );
}
