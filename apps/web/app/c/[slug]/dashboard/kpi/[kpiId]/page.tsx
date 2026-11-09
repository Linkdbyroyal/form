import Link from "next/link";
import { notFound } from "next/navigation";
import { clientNav, Shell } from "@/components/shell";
import { Badge, Card, Empty, Status } from "@/components/ui";
import { Mono, PageHeader, ShortId, Table, Td, Tr } from "@/components/agent-ui";
import { KpiStateBadge, ReliabilityBadge } from "@/components/xray-ui";
import { getTenantHeader } from "@/lib/client/queries";
import { getKpiLineage } from "@/lib/client/xray-queries";
import { deriveKpiState, formatKpiValue } from "@/lib/client/kpi-state";
import { fmtDate } from "@/lib/format";
import { requireTenantContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function lineageView(lineage: unknown): { query: string | null; records: string[] } {
  const l = (lineage && typeof lineage === "object" ? lineage : {}) as { query_or_formula?: unknown; source_record_ids?: unknown };
  return { query: typeof l.query_or_formula === "string" ? l.query_or_formula : null, records: Array.isArray(l.source_record_ids) ? l.source_record_ids.map(String) : [] };
}

export default async function KpiLineagePage({ params }: { params: Promise<{ slug: string; kpiId: string }> }) {
  const { slug, kpiId } = await params;
  if (!UUID_RE.test(kpiId)) notFound();
  const access = await requireTenantContext(slug);
  if (!access) notFound();
  const [tenant, lineage] = await Promise.all([getTenantHeader(access.ctx), getKpiLineage(access.ctx, kpiId)]);
  if (!tenant || !lineage) notFound();
  const { kpi, latest, observations, audit } = lineage;
  const derived = latest ? deriveKpiState(latest) : deriveKpiState({ status: null, value: null, direction: kpi.direction, warningThreshold: kpi.warningThreshold, criticalThreshold: kpi.criticalThreshold });
  const filters = Object.entries((kpi.filters ?? {}) as Record<string, unknown>);
  return (
    <Shell title={tenant.name} subtitle="Client workspace" nav={clientNav(slug)}>
      <div className="space-y-6">
        <PageHeader title={kpi.name} crumbs={[{ href: `/c/${slug}/dashboard`, label: "CEO Dashboard" }, { label: "KPI lineage" }]}>
          Definition, observation history with lineage, and the audit trail of this KPI. A value is stored only for an observation with status <code>ok</code>; the database refuses a number next to missing or stale data. <Status state="implemented" />
        </PageHeader>

        <div className="grid gap-4 md:grid-cols-[1fr_280px]">
          <Card title="Definition">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-faint">Key</dt><dd><Mono>{kpi.key}</Mono></dd>
              <dt className="text-faint">Business question</dt><dd>{kpi.businessQuestion}</dd>
              <dt className="text-faint">Formula</dt><dd><code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">{kpi.formula}</code></dd>
              <dt className="text-faint">Unit</dt><dd>{kpi.unit}</dd>
              <dt className="text-faint">Source system</dt><dd>{kpi.sourceSystem}</dd>
              <dt className="text-faint">Source field</dt><dd><Mono>{kpi.sourceField}</Mono></dd>
              <dt className="text-faint">Filters</dt><dd>{filters.length === 0 ? <span className="text-faint">none</span> : filters.map(([k, v]) => <span key={k} className="mr-2"><Mono>{k}={String(v)}</Mono></span>)}</dd>
              <dt className="text-faint">Owner</dt><dd>{kpi.ownerRole}</dd>
              <dt className="text-faint">Refresh</dt><dd>{kpi.refresh}</dd>
              <dt className="text-faint">Direction</dt><dd>{kpi.direction.replaceAll("_", " ")}</dd>
              <dt className="text-faint">Thresholds</dt><dd>warning {kpi.warningThreshold ?? "n/a"} · critical {kpi.criticalThreshold ?? "n/a"} <span className="text-faint">({kpi.direction === "lower_is_better" ? "crossed at or above" : "crossed at or below"})</span></dd>
              <dt className="text-faint">Reliability</dt><dd><ReliabilityBadge value={kpi.reliability} /></dd>
              <dt className="text-faint">Permission scope</dt><dd>{kpi.permissionScope.join(", ") || "n/a"}</dd>
              <dt className="text-faint">History retention</dt><dd>{kpi.historyRetentionDays} days</dd>
              <dt className="text-faint">Registry status</dt><dd><Badge tone={kpi.status === "active" ? "success" : kpi.status === "retired" ? "neutral" : "warning"}>{kpi.status.replaceAll("_", " ")}</Badge></dd>
              <dt className="text-faint">Defined by</dt><dd>{kpi.createdByActorType}:{kpi.createdByActorId} · {fmtDate(kpi.createdAt)}</dd>
            </dl>
          </Card>
          <Card title="Latest">
            <div className="flex items-center gap-2"><KpiStateBadge derived={derived} /></div>
            <div className="mt-2 text-3xl font-semibold text-fg">{derived.state === "ok" && derived.value !== null ? formatKpiValue(derived.value, kpi.unit) : <span className="text-muted">{derived.label}</span>}</div>
            <dl className="mt-3 space-y-1 text-xs text-faint">
              <div><dt className="inline">Observed </dt><dd className="inline text-muted">{latest?.observedAt ? fmtDate(latest.observedAt) : "never"}</dd></div>
              <div><dt className="inline">Last successful sync </dt><dd className="inline text-muted">{kpi.lastSuccessfulSyncAt ? fmtDate(kpi.lastSuccessfulSyncAt) : "never"}</dd></div>
              <div><dt className="inline">Observations </dt><dd className="inline text-muted">{observations.length}</dd></div>
            </dl>
          </Card>
        </div>

        <Card title={`Observation history (${observations.length})`} footer="computed_by is the agent or user that produced the observation; the lineage holds the query or formula and the source record ids it read. The contract and a CHECK constraint forbid a value for a non-ok status.">
          <Table head={["Observed", "Period", "Status", "Value", "Computed by", "Run", "Lineage"]} empty={observations.length === 0 ? <Empty>No observation yet. The CEO Intelligence agent records one per run.</Empty> : null}>
            {observations.map((o) => {
              const d = deriveKpiState({ status: o.status, value: o.value, direction: kpi.direction, warningThreshold: kpi.warningThreshold, criticalThreshold: kpi.criticalThreshold });
              const l = lineageView(o.lineage);
              return (
                <Tr key={o.id}>
                  <Td className="text-muted">{fmtDate(o.observedAt)}</Td>
                  <Td className="text-xs text-muted">{fmtDate(o.periodStart)}<br />{fmtDate(o.periodEnd)}</Td>
                  <Td><KpiStateBadge derived={d} /></Td>
                  <Td className="font-medium">{o.value !== null ? formatKpiValue(Number(o.value), kpi.unit) : <span className="text-faint">null</span>}</Td>
                  <Td className="text-xs text-muted">{o.computedByActorType}:{o.computedByActorId}</Td>
                  <Td>{o.runId ? <ShortId id={o.runId} /> : <span className="text-faint">n/a</span>}</Td>
                  <Td className="max-w-md text-xs">
                    {l.query ? <code className="block rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px]">{l.query}</code> : <span className="text-faint">no query recorded</span>}
                    <div className="mt-1 text-faint">{l.records.length} source record{l.records.length === 1 ? "" : "s"}{l.records.length > 0 ? `: ${l.records.slice(0, 6).map((r) => r.slice(0, 8)).join(", ")}${l.records.length > 6 ? ", ..." : ""}` : ""}</div>
                  </Td>
                </Tr>
              );
            })}
          </Table>
        </Card>

        <Card title={`Audit events (${audit.length})`} footer="audit_events rows with entity_type kpi for this KPI; append-only, hashes instead of content.">
          <Table head={["Occurred", "Action", "Actor", "After hash", "Metadata"]} empty={audit.length === 0 ? <Empty>No audit events reference this KPI.</Empty> : null}>
            {audit.map((a) => (
              <Tr key={a.id}>
                <Td className="text-muted">{fmtDate(a.occurredAt)}</Td>
                <Td><Mono>{a.action}</Mono></Td>
                <Td className="text-xs text-muted">{a.actorType}:{a.actorId}</Td>
                <Td>{a.afterHash ? <Mono>{a.afterHash.slice(0, 12)}</Mono> : <span className="text-faint">n/a</span>}</Td>
                <Td className="text-xs text-muted">{JSON.stringify(a.metadata).slice(0, 160)}</Td>
              </Tr>
            ))}
          </Table>
        </Card>
        <div className="text-xs"><Link href={`/c/${slug}/dashboard`} className="underline">Back to the dashboard</Link></div>
      </div>
    </Shell>
  );
}
