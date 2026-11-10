import { DESCRIPTORS } from "./sandbox";
import { PhaseViolationError, type Connector, type ConnectorContext, type ConnectorDescriptor, type MetricReading, type SourceObject, type TestConnectionResult } from "./types";

/**
 * Live, read-only Rentman connector (M5-05, ADR-023). Reads only the fields the descriptor declares, over the
 * public API (https://api.rentman.net) with a bearer token taken from the connection's secret reference.
 * Never writes. Facts about the API that shape this implementation (verified 2026-11-10 against a real account
 * through the vendor's own tooling, metadata only):
 * - A project's status lives on its subprojects as a link `/statuses/<id>`; status names are tenant specific
 *   (for example "Retour", "Afgerond"), so the set of names that mean "closed" is configuration.
 * - Invoices have no status field; `date`, `date_sent` and the generated `is_paid` exist. An invoice with a date
 *   counts as issued; `is_paid` or `date_sent` refine the reported status.
 * - Lists are paged with `limit` and `offset`; generated fields (planperiod_*, usageperiod_*) cannot be filtered.
 * Connection config keys: `credentialRef` (env:NAME of the token, default env:RENTMAN_API_TOKEN), `closedStatusNames`,
 * `baseUrl`, `pageSize`, `lookbackDays`. The key is not called secretRef because connections.config refuses keys that
 * look like credentials; the value is a reference, the token itself lives only in the worker environment.
 */
export interface RentmanConfig {
  baseUrl: string;
  secretRef: string;
  closedStatusNames: string[];
  pageSize: number;
  /** How far before the period start closed projects and invoices are read (lead times span periods). */
  lookbackDays: number;
}

export const DEFAULT_CLOSED_STATUS_NAMES = ["retour", "afgerond", "returned", "closed", "completed", "geretourneerd", "afgesloten"];
const DAY = 86_400_000;
const MAX_PAGES = 40;

export function rentmanConfig(config: Record<string, unknown>): RentmanConfig {
  const str = (k: string, d: string) => (typeof config[k] === "string" && (config[k] as string).length > 0 ? (config[k] as string) : d);
  const names = Array.isArray(config.closedStatusNames) ? (config.closedStatusNames as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const baseUrl = str("baseUrl", "https://api.rentman.net").replace(/\/+$/, "");
  if (!/^https:\/\//.test(baseUrl)) throw new Error("rentman: baseUrl must use https");
  const pageSize = Math.min(1500, Math.max(50, Number(config.pageSize) || 300));
  const lookbackDays = Math.min(365, Math.max(0, Number(config.lookbackDays) || 90));
  return { baseUrl, secretRef: str("credentialRef", DESCRIPTORS.rentman.secretRefs[0]!), closedStatusNames: (names.length ? names : DEFAULT_CLOSED_STATUS_NAMES).map((n) => n.trim().toLowerCase()), pageSize, lookbackDays };
}

function guardPhase(ctx: ConnectorContext, what: string): void {
  if (ctx.phase === "metadata") throw new PhaseViolationError(`${what} is not allowed in the metadata phase; only describe() is`);
  if (ctx.phase === "write") throw new PhaseViolationError("the write phase has no implementation");
  if (ctx.mode !== "live") throw new PhaseViolationError("the live Rentman connector only runs in live mode");
}

interface Page<T> {
  data: T[];
  itemCount?: number;
}

/** Rentman timestamps carry an offset ("2026-11-10T10:08:26.000-04:00"); Date parses them. */
const iso = (v: unknown): string | null => {
  if (typeof v !== "string" || v.length === 0) return null;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};
const linkId = (v: unknown): string | null => (typeof v === "string" ? (/\/(\d+)$/.exec(v)?.[1] ?? null) : null);

export class RentmanLiveConnector implements Connector {
  describe(): ConnectorDescriptor {
    return DESCRIPTORS.rentman;
  }

  private async token(ctx: ConnectorContext, cfg: RentmanConfig): Promise<string> {
    const value = await ctx.secrets.read(cfg.secretRef);
    if (!value) throw new Error(`rentman: secret reference ${cfg.secretRef} is not configured in the worker environment`);
    return value;
  }

  /** One GET against the API; reads only `fields`, paginates with offset, never follows anything else. */
  private async list<T>(ctx: ConnectorContext, cfg: RentmanConfig, token: string, path: string, params: Record<string, string>, max = MAX_PAGES): Promise<T[]> {
    const out: T[] = [];
    for (let page = 0; page < max; page++) {
      const qs = new URLSearchParams({ ...params, limit: String(cfg.pageSize), offset: String(page * cfg.pageSize) });
      const res = await ctx.fetch(`${cfg.baseUrl}${path}?${qs.toString()}`, { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 401 || res.status === 403) throw new Error(`rentman: credentials rejected (${res.status}) for ${path}; check the token and its read permissions`);
      if (!res.ok) throw new Error(`rentman: ${path} responded ${res.status}`);
      const body = (await res.json()) as Page<T>;
      const rows = Array.isArray(body.data) ? body.data : [];
      out.push(...rows);
      if (rows.length < cfg.pageSize) break;
    }
    return out;
  }

  async testConnection(ctx: ConnectorContext): Promise<TestConnectionResult> {
    guardPhase(ctx, "testConnection");
    const cfg = rentmanConfig(ctx.config);
    const token = await this.token(ctx, cfg);
    const small = { ...cfg, pageSize: 50 };
    const [statuses, subprojects, invoices] = await Promise.all([
      this.list<{ id: number; name: string }>(ctx, small, token, "/statuses", { fields: "id,name" }, 1),
      this.list<{ id: number }>(ctx, small, token, "/subprojects", { fields: "id", sort: "-modified" }, 1),
      this.list<{ id: number }>(ctx, small, token, "/invoices", { fields: "id", sort: "-modified" }, 1)
    ]);
    const known = statuses.filter((s) => cfg.closedStatusNames.includes(String(s.name).trim().toLowerCase())).map((s) => s.name);
    const ok = known.length > 0;
    return {
      ok,
      mode: "live",
      message: ok
        ? `Rentman API reachable; read access to statuses, subprojects and invoices verified. Closed statuses recognised: ${known.join(", ")}.`
        : `Rentman API reachable, but none of the account's status names (${statuses.map((s) => s.name).join(", ")}) matches the configured closed statuses; set closedStatusNames in the connection config.`,
      objectsVisible: { statuses: statuses.length, projects: subprojects.length, invoices: invoices.length }
    };
  }

  async listObjects(ctx: ConnectorContext, kind: string, since: Date | null): Promise<SourceObject[]> {
    guardPhase(ctx, "listObjects");
    const cfg = rentmanConfig(ctx.config);
    const token = await this.token(ctx, cfg);
    const sinceFilter: Record<string, string> = since ? { "modified[gte]": since.toISOString() } : {};
    if (kind === "projects") {
      const [statuses, subprojects, projects] = await Promise.all([
        this.list<{ id: number; name: string }>(ctx, cfg, token, "/statuses", { fields: "id,name" }, 2),
        this.list<Record<string, unknown>>(ctx, cfg, token, "/subprojects", { fields: "id,project,status,planperiod_end,usageperiod_end,modified", ...sinceFilter }),
        this.list<Record<string, unknown>>(ctx, cfg, token, "/projects", { fields: "id,name,modified", ...sinceFilter })
      ]);
      const statusName = new Map(statuses.map((s) => [String(s.id), String(s.name)]));
      const byProject = new Map<string, { statuses: string[]; planEnd: string | null; useEnd: string | null; modified: string | null }>();
      for (const sp of subprojects) {
        const pid = linkId(sp.project);
        if (!pid) continue;
        const agg = byProject.get(pid) ?? { statuses: [], planEnd: null, useEnd: null, modified: null };
        const sid = linkId(sp.status);
        agg.statuses.push((sid && statusName.get(sid)) || "unknown");
        for (const [k, f] of [["planEnd", "planperiod_end"], ["useEnd", "usageperiod_end"], ["modified", "modified"]] as const) {
          const v = iso(sp[f]);
          if (v && (!agg[k] || v > agg[k]!)) agg[k] = v;
        }
        byProject.set(pid, agg);
      }
      const names = new Map(projects.map((p) => [String(p.id), { name: typeof p.name === "string" ? p.name : "", modified: iso(p.modified) }]));
      return [...byProject.entries()].map(([id, agg]) => {
        const closed = agg.statuses.length > 0 && agg.statuses.every((s) => cfg.closedStatusNames.includes(s.toLowerCase()));
        const cancelled = agg.statuses.every((s) => /geannuleerd|cancel/i.test(s));
        const status = closed ? "closed" : cancelled ? "cancelled" : "open";
        const modified = [agg.modified, names.get(id)?.modified].filter((x): x is string => Boolean(x)).sort().pop() ?? ctx.now().toISOString();
        return { kind: "projects", id, updatedAt: modified, fields: { name: names.get(id)?.name ?? "", status, planperiod_end: agg.planEnd, usageperiod_end: agg.useEnd, modified, rentman_statuses: agg.statuses.join("|") } };
      });
    }
    if (kind === "invoices") {
      const invoices = await this.list<Record<string, unknown>>(ctx, cfg, token, "/invoices", { fields: "id,project,date,date_sent,is_paid,modified", ...sinceFilter });
      return invoices
        .filter((inv) => linkId(inv.project))
        .map((inv) => ({ kind: "invoices", id: String(inv.id), updatedAt: iso(inv.modified) ?? ctx.now().toISOString(), fields: { project: linkId(inv.project), status: inv.is_paid === true ? "paid" : iso(inv.date_sent) ? "sent" : iso(inv.date) ? "issued" : "draft", date: iso(inv.date), modified: iso(inv.modified) } }));
    }
    throw new Error(`object kind "${kind}" is not declared for rentman`);
  }

  async readMetrics(ctx: ConnectorContext, keys: string[], period: { start: Date; end: Date }): Promise<MetricReading[]> {
    guardPhase(ctx, "readMetrics");
    const cfg = rentmanConfig(ctx.config);
    const since = new Date(period.start.getTime() - cfg.lookbackDays * DAY);
    const [projects, invoices] = await Promise.all([this.listObjects(ctx, "projects", since), this.listObjects(ctx, "invoices", since)]);
    const desc = this.describe();
    const out: MetricReading[] = [];
    for (const key of keys) {
      const m = desc.metrics.find((x) => x.key === key);
      if (!m) {
        out.push({ key, status: "error", value: null, periodStart: period.start, periodEnd: period.end, sourceField: "", formula: "", sourceRecordIds: [], note: `metric ${key} is not provided by rentman` });
        continue;
      }
      const reading = (value: number | null, ids: string[], note?: string): MetricReading => ({ key, status: value === null ? "missing_data" : "ok", value, periodStart: period.start, periodEnd: period.end, sourceField: m.sourceField, formula: m.formula, sourceRecordIds: ids, note });
      if (key === "closed_projects_not_invoiced") {
        const invoiced = new Set(invoices.filter((i) => i.fields.status !== "draft").map((i) => String(i.fields.project)));
        const open = projects.filter((p) => p.fields.status === "closed" && !invoiced.has(p.id));
        out.push(reading(open.length, open.map((p) => p.id), `closed = every subproject in one of: ${cfg.closedStatusNames.join(", ")}`));
      } else if (key === "quote_to_invoice_days") {
        const byId = new Map(projects.map((p) => [p.id, p]));
        const days: number[] = [];
        const ids: string[] = [];
        for (const inv of invoices) {
          const p = byId.get(String(inv.fields.project));
          const date = inv.fields.date ? new Date(String(inv.fields.date)) : null;
          if (!p || !date || !p.fields.usageperiod_end || date < period.start || date > period.end) continue;
          days.push(Math.round(Math.max(0, (date.getTime() - new Date(String(p.fields.usageperiod_end)).getTime()) / DAY) * 10) / 10);
          ids.push(inv.id);
        }
        out.push(reading(median(days), ids));
      } else {
        out.push(reading(null, [], `metric ${key} has no live implementation yet`));
      }
    }
    return out;
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
