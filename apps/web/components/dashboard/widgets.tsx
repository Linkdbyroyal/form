import Link from "next/link";
import type { ReactNode } from "react";
import type { DashboardWidget, WidgetType } from "@sbos/contracts";
import { Badge, Empty } from "@/components/ui";
import { Table, Td, Tr } from "@/components/agent-ui";
import { ActionTaskStateBadge, BRIEFING_SECTIONS, ClaimBadge, KpiStateBadge, SeverityBadge } from "@/components/xray-ui";
import { deriveKpiState, formatKpiValue } from "@/lib/client/kpi-state";
import { renderMarkdown } from "@/lib/client/vault-helpers";
import { fmtDate } from "@/lib/format";
import { KpiBarChart, KpiTrendChart, type ChartPoint } from "./charts";
import type { DashboardData, KpiLatestRow } from "./types";

/**
 * Widget whitelist renderer (M3-03). `WIDGET_RENDERERS` maps every type of the contract's
 * `WidgetTypeSchema` to a server component; nothing outside this map renders. Widget `config`
 * holds primitives only (contract), so no agent-authored markup or code reaches the browser.
 */
export interface WidgetProps {
  widget: DashboardWidget;
  data: DashboardData;
}

type Renderer = (props: WidgetProps) => ReactNode;

const sizeClass: Record<DashboardWidget["size"], string> = { s: "md:col-span-1", m: "md:col-span-2", l: "md:col-span-3" };

export function WidgetFrame({ widget, title, badge, children }: { widget: DashboardWidget; title: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <section className={`sb-card flex flex-col p-5 ${sizeClass[widget.size]}`} aria-label={title}>
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">{title}</h3>
        <div className="flex items-center gap-2">
          {badge}
          <Badge>{widget.type.replaceAll("_", " ")}</Badge>
        </div>
      </header>
      <div className="flex-1">{children}</div>
      <footer className="mt-4 border-t border-border pt-3 text-xs text-faint">
        <span className="text-muted">Why on this dashboard:</span> {widget.reason}
      </footer>
    </section>
  );
}

function configString(widget: DashboardWidget, key: string): string | null {
  const v = widget.config?.[key];
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function kpisFor(widget: DashboardWidget, data: DashboardData): KpiLatestRow[] {
  const byId = new Map(data.kpis.map((k) => [k.kpiId, k]));
  return widget.kpi_ids.map((id) => byId.get(id)).filter((k): k is KpiLatestRow => Boolean(k));
}

/** Only `ok` observations become chart points; a state is never plotted as a number. */
function chartPoints(data: DashboardData, kpiId: string): ChartPoint[] {
  return (data.history[kpiId] ?? [])
    .filter((o) => o.status === "ok" && o.value !== null && Number.isFinite(Number(o.value)))
    .map((o) => ({ label: o.periodEnd.slice(0, 10), value: Number(o.value) }));
}

function MissingKpiRefs({ widget, found }: { widget: DashboardWidget; found: number }) {
  const missing = widget.kpi_ids.length - found;
  if (missing <= 0) return null;
  return <p className="mt-2 text-xs text-warning">{missing} referenced KPI id{missing === 1 ? "" : "s"} not found in the registry (retired or removed).</p>;
}

function KpiTile({ kpi, slug }: { kpi: KpiLatestRow; slug: string }) {
  const derived = deriveKpiState(kpi);
  const valueClass = derived.level === "critical" ? "text-danger" : derived.level === "warning" ? "text-warning" : "text-fg";
  return (
    <Link href={`/c/${slug}/dashboard/kpi/${kpi.kpiId}`} className="block rounded-md border border-border p-3 hover:bg-surface-2" aria-label={`${kpi.name}: open lineage`}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium text-fg">{kpi.name}</div>
        <KpiStateBadge derived={derived} />
      </div>
      {derived.state === "ok" && derived.value !== null ? (
        <div className={`mt-2 text-3xl font-semibold ${valueClass}`}>{formatKpiValue(derived.value, kpi.unit)}</div>
      ) : (
        <div className="mt-2 text-2xl font-semibold text-muted">{derived.label}</div>
      )}
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-faint">
        <dt>Source</dt><dd className="text-muted">{kpi.sourceSystem}</dd>
        <dt>Last sync</dt><dd className="text-muted">{kpi.lastSuccessfulSyncAt ? fmtDate(kpi.lastSuccessfulSyncAt) : "never"}</dd>
        <dt>Owner</dt><dd className="text-muted">{kpi.ownerRole}</dd>
        <dt>Observed</dt><dd className="text-muted">{kpi.observedAt ? fmtDate(kpi.observedAt) : "n/a"}</dd>
      </dl>
    </Link>
  );
}

const kpiTile: Renderer = ({ widget, data }) => {
  const kpis = kpisFor(widget, data);
  return (
    <WidgetFrame widget={widget} title={configString(widget, "title") ?? (kpis.length === 1 ? "KPI" : "KPIs")}>
      {kpis.length === 0 ? <Empty>No KPI linked to this tile.</Empty> : <div className={`grid gap-3 ${kpis.length > 1 ? "sm:grid-cols-2" : ""}`}>{kpis.map((k) => <KpiTile key={k.kpiId} kpi={k} slug={data.slug} />)}</div>}
      <MissingKpiRefs widget={widget} found={kpis.length} />
    </WidgetFrame>
  );
};

function chartWidget(kind: "trend_line" | "bar"): Renderer {
  return ({ widget, data }) => {
    const kpis = kpisFor(widget, data);
    return (
      <WidgetFrame widget={widget} title={configString(widget, "title") ?? (kind === "trend_line" ? "Trend" : "Comparison")}>
        {kpis.length === 0 ? <Empty>No KPI linked to this chart.</Empty> : null}
        <div className="space-y-4">
          {kpis.map((k) => {
            const points = chartPoints(data, k.kpiId);
            const derived = deriveKpiState(k);
            return (
              <div key={k.kpiId}>
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <Link href={`/c/${data.slug}/dashboard/kpi/${k.kpiId}`} className="font-medium text-fg underline">{k.name}</Link>
                  <span className="flex items-center gap-2 text-faint"><KpiStateBadge derived={derived} /> source {k.sourceSystem} · {points.length} ok observation{points.length === 1 ? "" : "s"}</span>
                </div>
                {points.length < 2 ? (
                  <Empty>Not enough data: a {kind === "trend_line" ? "trend" : "bar chart"} needs at least 2 ok observations; {points.length} available.</Empty>
                ) : kind === "trend_line" ? (
                  <KpiTrendChart data={points} config={{ label: k.name, unit: k.unit }} />
                ) : (
                  <KpiBarChart data={points} config={{ label: k.name, unit: k.unit, color: "var(--sb-blue)" }} />
                )}
              </div>
            );
          })}
        </div>
        <MissingKpiRefs widget={widget} found={kpis.length} />
      </WidgetFrame>
    );
  };
}

const table: Renderer = ({ widget, data }) => {
  const kpis = widget.kpi_ids.length > 0 ? kpisFor(widget, data) : data.kpis;
  return (
    <WidgetFrame widget={widget} title={configString(widget, "title") ?? "KPI observations"}>
      <Table head={["KPI", "State", "Latest value", "Observed", "Source", "Owner"]} empty={kpis.length === 0 ? <Empty>No KPIs in the registry yet.</Empty> : null}>
        {kpis.map((k) => {
          const d = deriveKpiState(k);
          return (
            <Tr key={k.kpiId}>
              <Td><Link href={`/c/${data.slug}/dashboard/kpi/${k.kpiId}`} className="underline">{k.name}</Link></Td>
              <Td><KpiStateBadge derived={d} /></Td>
              <Td className="font-medium">{d.state === "ok" && d.value !== null ? formatKpiValue(d.value, k.unit) : <span className="text-muted">{d.label}</span>}</Td>
              <Td className="text-muted">{k.observedAt ? fmtDate(k.observedAt) : "n/a"}</Td>
              <Td className="text-muted">{k.sourceSystem}</Td>
              <Td className="text-muted">{k.ownerRole}</Td>
            </Tr>
          );
        })}
      </Table>
      {widget.kpi_ids.length > 0 ? <MissingKpiRefs widget={widget} found={kpis.length} /> : null}
    </WidgetFrame>
  );
};

const actionList: Renderer = ({ widget, data }) => (
  <WidgetFrame widget={widget} title={configString(widget, "title") ?? "Actions"} badge={<Link href={`/c/${data.slug}/actions`} className="text-xs underline">Action Center</Link>}>
    {data.tasks.length === 0 ? (
      <Empty>No action tasks yet. Tasks are created from approved opportunities in the Action Center.</Empty>
    ) : (
      <ul className="divide-y divide-border text-sm">
        {data.tasks.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div>
              <div className="font-medium text-fg">{t.title}</div>
              <div className="text-xs text-faint">owner {t.ownerName ?? t.ownerRole ?? "unassigned"}{t.dueAt ? ` · due ${fmtDate(t.dueAt)}` : ""}</div>
            </div>
            <ActionTaskStateBadge value={t.state} />
          </li>
        ))}
      </ul>
    )}
  </WidgetFrame>
);

const briefing: Renderer = ({ widget, data }) => {
  const b = data.briefing;
  return (
    <WidgetFrame widget={widget} title={configString(widget, "title") ?? "Executive briefing"} badge={b ? <Badge tone={b.simulated ? "warning" : "success"}>{b.simulated ? "simulated" : "live"}</Badge> : null}>
      {!b ? (
        <Empty>No briefing stored yet. The Executive Briefing agent writes one per day (weekdays 06:30 UTC when its schedule is enabled).</Empty>
      ) : (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2 text-xs text-faint">
            <span>{b.briefingDate}</span>
            <span>confidence {b.content.confidence.toFixed(2)}</span>
            <Link href={`/c/${data.slug}/briefing`} className="underline">Open full briefing</Link>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-faint">Top priorities</div>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5">{b.content.top_priorities.map((p, i) => <li key={i}>{p}</li>)}</ol>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {BRIEFING_SECTIONS.map((s) => {
              const items = b.content.sections[s.key];
              return (
                <div key={s.key} className="rounded-md border border-border p-2">
                  <div className="text-xs font-medium text-muted">{s.label} <span className="text-faint">({items.length})</span></div>
                  {items.length === 0 ? <div className="text-xs text-faint">nothing recorded</div> : <ul className="mt-1 space-y-0.5 text-xs">{items.slice(0, 3).map((it, i) => <li key={i}>{it.text}</li>)}{items.length > 3 ? <li className="text-faint">and {items.length - 3} more</li> : null}</ul>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </WidgetFrame>
  );
};

const riskList: Renderer = ({ widget, data }) => {
  const risks = data.findings.filter((f) => f.state === "open" && (f.severity === "critical" || f.severity === "high"));
  return (
    <WidgetFrame widget={widget} title={configString(widget, "title") ?? "Risks"} badge={<Link href={`/c/${data.slug}/x-ray`} className="text-xs underline">X-Ray</Link>}>
      {risks.length === 0 ? (
        <Empty>No open critical or high findings.</Empty>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {risks.map((f) => (
            <li key={f.id} className="py-2">
              <div className="flex flex-wrap items-center gap-2"><SeverityBadge value={f.severity} /><ClaimBadge value={f.claim} /><span className="text-xs text-faint">{f.department} · owner {f.ownerRole}</span></div>
              <div className="mt-1 font-medium text-fg">{f.title}</div>
            </li>
          ))}
        </ul>
      )}
    </WidgetFrame>
  );
};

const dataGapList: Renderer = ({ widget, data }) => {
  const scope = widget.kpi_ids.length > 0 ? kpisFor(widget, data) : data.kpis;
  const gaps = scope.filter((k) => deriveKpiState(k).state !== "ok");
  return (
    <WidgetFrame widget={widget} title={configString(widget, "title") ?? "Data gaps"}>
      {gaps.length === 0 ? (
        <Empty>Every KPI in scope has an ok observation.</Empty>
      ) : (
        <Table head={["KPI", "State", "Source system", "Field", "What is needed"]}>
          {gaps.map((k) => {
            const d = deriveKpiState(k);
            return (
              <Tr key={k.kpiId}>
                <Td><Link href={`/c/${data.slug}/dashboard/kpi/${k.kpiId}`} className="underline">{k.name}</Link></Td>
                <Td><KpiStateBadge derived={d} /></Td>
                <Td className="text-muted">{k.sourceSystem}</Td>
                <Td className="font-mono text-xs text-muted">{k.sourceField}</Td>
                <Td className="text-xs text-muted">{d.state === "missing" ? `Read-only connection to ${k.sourceSystem} with consent; until then the value is not computed.` : d.state === "stale" ? `A fresh sync of ${k.sourceSystem}; the last successful sync was ${k.lastSuccessfulSyncAt ? fmtDate(k.lastSuccessfulSyncAt) : "never"}.` : "The last computation failed; see the lineage page for the query and the run."}</Td>
              </Tr>
            );
          })}
        </Table>
      )}
      {widget.kpi_ids.length > 0 ? <MissingKpiRefs widget={widget} found={scope.length} /> : null}
    </WidgetFrame>
  );
};

const textNote: Renderer = ({ widget }) => {
  const text = configString(widget, "text");
  const markdown = widget.config?.markdown === true;
  return (
    <WidgetFrame widget={widget} title={configString(widget, "title") ?? "Note"}>
      {!text ? <Empty>This note has no text (config.text is empty).</Empty> : markdown ? <div className="sb-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} /> : <p className="whitespace-pre-wrap text-sm text-fg">{text}</p>}
    </WidgetFrame>
  );
};

/** The whitelist: exactly the contract's widget types. The test asserts the keys equal `WidgetTypeSchema.options`. */
export const WIDGET_RENDERERS: Record<WidgetType, Renderer> = {
  kpi_tile: kpiTile,
  trend_line: chartWidget("trend_line"),
  bar: chartWidget("bar"),
  table,
  action_list: actionList,
  briefing,
  risk_list: riskList,
  data_gap_list: dataGapList,
  text_note: textNote
};
