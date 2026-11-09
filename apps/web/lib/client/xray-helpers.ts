/** Defensive readers for the JSON columns of opportunities (business case, priority score). Pure functions. */

export interface BusinessCaseView {
  effort: string | null;
  dependencies: string[];
  risks: string[];
  cost: { amount: number; currency: string } | null;
  saving: { amount: number; currency: string } | null;
  kpiChanges: Array<{ kpi: string; direction: string; magnitude: string }>;
}

/** Every money figure in a business case is an estimate by contract (`is_estimate: true`); the UI labels it so. */
export function businessCaseView(raw: unknown): BusinessCaseView {
  const bc = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const money = (v: unknown) => (v && typeof v === "object" && typeof (v as { amount?: unknown }).amount === "number" ? { amount: (v as { amount: number }).amount, currency: String((v as { currency?: unknown }).currency ?? "") } : null);
  const strs = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const changes = Array.isArray(bc.expected_kpi_changes) ? (bc.expected_kpi_changes as Array<Record<string, unknown>>).map((c) => ({ kpi: String(c.kpi_key ?? c.kpi_id ?? "kpi"), direction: String(c.direction ?? ""), magnitude: String(c.magnitude ?? "") })) : [];
  return { effort: typeof bc.effort === "string" ? bc.effort : null, dependencies: strs(bc.dependencies), risks: strs(bc.risks), cost: money(bc.estimated_cost), saving: money(bc.estimated_saving), kpiChanges: changes };
}

export interface PriorityView {
  impact: number | null;
  feasibility: number | null;
  risk: number | null;
  timeToValue: number | null;
  composite: number | null;
}

export function priorityView(raw: unknown): PriorityView {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const n = (k: string) => (typeof p[k] === "number" ? (p[k] as number) : null);
  return { impact: n("impact"), feasibility: n("feasibility"), risk: n("risk"), timeToValue: n("time_to_value"), composite: n("composite") };
}
