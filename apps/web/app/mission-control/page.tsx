import Link from "next/link";
import { Card, Empty, Stat, Status } from "@/components/ui";
import { getOperatorOverview } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function MissionControlOverview() {
  const o = await getOperatorOverview();
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
        <Stat label="Agents running" value="n/a" hint="agent runtime lands in M1" />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Agent activity">
          <Empty>No agent runtime yet. Milestone 1 adds agents, tasks, runs, approvals and the autonomous worker. <Status state="planned" /></Empty>
        </Card>
        <Card title="Approvals pending">
          <Empty>Approval queue lands in Milestone 1. <Status state="planned" /></Empty>
        </Card>
      </div>
      <Card title="Implementation status (Milestone 0)">
        <ul className="space-y-1 text-sm">
          <li><Status state="implemented" /> PostgreSQL schema with Row-Level Security, two synthetic tenants, isolation tests</li>
          <li><Status state="implemented" /> Operator role with metadata-only access; audit trail append-only</li>
          <li><Status state="implemented" /> <Link className="underline" href="/mission-control/clients">Client Workspaces</Link> list and drill-down</li>
          <li><Status state="simulated" /> Authentication: development operator, no login (M1-01)</li>
          <li><Status state="not_connected" /> Any client system (Rentman, QuickBooks, Trengo, Dropbox)</li>
        </ul>
      </Card>
    </div>
  );
}
