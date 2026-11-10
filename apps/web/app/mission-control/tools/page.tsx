import Link from "next/link";
import { Badge, Card, Empty, Stat, Status } from "@/components/ui";
import { FilterBar, Notice, PageHeader, ShortId, Table, Td, Tr } from "@/components/agent-ui";
import { ConnectionStatusBadge, ConsentBadge, IntegrationStatusCard, PhaseBadge } from "@/components/integration-ui";
import { fmtInterval, isOverdue, syncHealth } from "@/lib/client/integration-helpers";
import { firstParam, fmtDate } from "@/lib/format";
import { listAllConnections, PHASE_VALUES, STATUS_VALUES, type ConnectionStatus, type Phase } from "@/lib/mission-control/tools-queries";
import { requireOperatorContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

export default async function ConnectedToolsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOperatorContext();
  const sp = await searchParams;
  const phaseRaw = firstParam(sp.phase);
  const statusRaw = firstParam(sp.status);
  const phase = phaseRaw && (PHASE_VALUES as readonly string[]).includes(phaseRaw) ? (phaseRaw as Phase) : null;
  const status = statusRaw && (STATUS_VALUES as readonly string[]).includes(statusRaw) ? (statusRaw as ConnectionStatus) : null;
  const all = await listAllConnections();
  const rows = all.filter((c) => (!phase || c.phase === phase) && (!status || c.status === status));
  const health = syncHealth(all);
  const now = new Date();
  const base = "/mission-control/tools";
  const phaseQs = phase ? `phase=${phase}` : "";
  const statusQs = status ? `status=${status}` : "";

  return (
    <div className="space-y-6">
      <PageHeader title="Connected Tools">
        Every connection across tenants with phase, consent and sync health. Reads use the operator role: metadata columns only, never a connection's config or a sync run's error text. Decisions (security review, phase advance, pause, references, manual sync) live on the detail page and run in agency scope pinned to the tenant. <Status state="implemented" />
      </PageHeader>
      <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />
      <div className="rounded-card border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
        Live connectors are not implemented yet: every sync in this release runs against sandbox fixtures and is labelled simulated (packages/connectors/src/registry.ts). Asking a connector for live mode is an explicit error, never a silent fallback.
      </div>
      <div className="grid gap-4 md:grid-cols-4 lg:grid-cols-8">
        <Stat label="Connections" value={health.total} />
        <Stat label="Active" value={health.active} hint="syncing on interval" />
        <Stat label="Paused" value={health.paused} />
        <Stat label="Error" value={health.error} hint="last sync failed" />
        <Stat label="Awaiting consent" value={health.awaitingConsent} hint="client decision" />
        <Stat label="Awaiting review" value={health.awaitingReview} hint="agency decision" />
        <Stat label="Never synced" value={health.neverSynced} hint="active, no run yet" />
        <Stat label="Overdue" value={health.overdue} hint="missed two intervals" />
      </div>
      <div className="space-y-2">
        <FilterBar basePath={`${base}${statusQs ? `?${statusQs}` : ""}`} param="phase" current={phase} options={[{ value: null, label: `all phases (${all.length})` }, ...PHASE_VALUES.map((p) => ({ value: p, label: `${p.replaceAll("_", " ")} (${all.filter((c) => c.phase === p).length})` }))]} />
        <FilterBar basePath={`${base}${phaseQs ? `?${phaseQs}` : ""}`} param="status" current={status} options={[{ value: null, label: "all statuses" }, ...STATUS_VALUES.map((s) => ({ value: s, label: `${s.replaceAll("_", " ")} (${all.filter((c) => c.status === s).length})` }))]} />
        <p className="text-xs text-faint">A filter link replaces the other filter; combine them by editing the query string (`?phase=read_only&status=active`).</p>
      </div>
      <Card title={`Connections: ${rows.length}`} footer="Open incidents counts incidents the sync service raised for this connection (dedupe key connector:<id>:<class>) that are still open. Overdue means an active read-only or sandbox connection missed more than two intervals.">
        <Table head={["Tenant", "System", "Provider", "Phase", "Consent", "Status", "Security review", "Last sync", "Interval", "Incidents", ""]} empty={rows.length === 0 ? <Empty>No connections match. Connections are proposed by client admins (or agency staff) in the client's Integration Center.</Empty> : null}>
          {rows.map((c) => (
            <Tr key={c.id}>
              <Td><Link href={`/mission-control/clients/${c.tenantSlug}`} className="underline">{c.tenantName}</Link></Td>
              <Td className="text-muted">{c.systemName ?? <span className="text-faint">none</span>}</Td>
              <Td>{c.displayName} <span className="font-mono text-xs text-faint">{c.provider}</span></Td>
              <Td><PhaseBadge phase={c.phase} /></Td>
              <Td><ConsentBadge consent={c.consent} />{c.consentGivenAt ? <div className="text-xs text-faint">{fmtDate(c.consentGivenAt)}</div> : null}</Td>
              <Td><ConnectionStatusBadge status={c.status} />{isOverdue(c, now) ? <div><Badge tone="warning">overdue</Badge></div> : null}</Td>
              <Td className="text-xs text-muted">{c.securityReviewedAt ? `${fmtDate(c.securityReviewedAt)} by ${c.securityReviewedBy ?? "agency"}` : <span className="text-faint">not recorded</span>}</Td>
              <Td className="text-xs text-muted">{c.lastSyncAt ? fmtDate(c.lastSyncAt) : <span className="text-faint">never</span>}</Td>
              <Td className="text-xs text-muted">{fmtInterval(c.syncIntervalMinutes)}</Td>
              <Td>{c.openIncidents > 0 ? <Link href="/mission-control/errors" className="underline"><Badge tone="danger">{c.openIncidents} open</Badge></Link> : <span className="text-faint">0</span>}</Td>
              <Td><Link href={`${base}/${c.id}`} className="underline"><ShortId id={c.id} /> detail</Link></Td>
            </Tr>
          ))}
        </Table>
      </Card>
      <IntegrationStatusCard implemented={["Cross-tenant connection list with phase and status filters, sync health counters and open connector incidents (operator role, metadata columns only).", "Per-connection detail page with timeline, sync runs, references and the agency actions (security review, phase advance one step, pause and resume, credential and webhook references, run sync now, test connection) in agency scope pinned to the tenant."]} />
    </div>
  );
}
