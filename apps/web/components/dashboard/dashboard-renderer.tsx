import type { DashboardSpecification } from "@sbos/contracts";
import { Badge } from "@/components/ui";
import { parseDashboardSpecification } from "./spec";
import type { DashboardData } from "./types";
import { WIDGET_RENDERERS } from "./widgets";

/**
 * Renders a stored `DashboardSpecification` through the widget whitelist (M3-03). The specification is
 * validated here again, even though `publishDashboard` validated it on insert: the renderer refuses
 * anything that fails the contract and shows an error card instead of a partial dashboard.
 * Server rendered, so there is no loading state; `missing`, `stale`, `error` and `awaiting approval`
 * are explicit cards or badges inside the widgets.
 */
export function DashboardRenderer({ specification, data }: { specification: unknown; data: DashboardData }) {
  const parsed = parseDashboardSpecification(specification);
  if (!parsed.ok) return <SpecificationError message={parsed.message} issues={parsed.issues} />;
  return <ValidDashboard spec={parsed.spec} data={data} />;
}

export function SpecificationError({ message, issues }: { message: string; issues: string[] }) {
  return (
    <section role="alert" className="rounded-card border border-danger/40 bg-danger/10 p-5 text-sm text-danger">
      <div className="flex items-center gap-2"><Badge tone="danger">error</Badge><span className="font-medium">Dashboard specification refused</span></div>
      <p className="mt-2">{message}</p>
      <ul className="mt-2 list-disc space-y-0.5 pl-5 font-mono text-xs">{issues.slice(0, 20).map((i, n) => <li key={n}>{i}</li>)}</ul>
      <p className="mt-2 text-xs text-muted">Ask the CEO Intelligence agent to regenerate the dashboard; the refusal is logged with the specification version.</p>
    </section>
  );
}

function ValidDashboard({ spec, data }: { spec: DashboardSpecification; data: DashboardData }) {
  const widgets = [...spec.widgets].sort((a, b) => a.priority - b.priority);
  if (widgets.length === 0) {
    return <div className="rounded-card border border-dashed border-border p-6 text-center text-sm text-muted">The specification contains no widgets.</div>;
  }
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {widgets.map((w) => {
        const Renderer = WIDGET_RENDERERS[w.type];
        return <div key={w.widget_id} className={`contents`}>{Renderer({ widget: w, data })}</div>;
      })}
    </div>
  );
}
