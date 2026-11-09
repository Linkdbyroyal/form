import type { Connector, ConnectorContext, ConnectorDescriptor, MetricReading, Provider, SourceObject, TestConnectionResult } from "./types";
import { PhaseViolationError } from "./types";

/**
 * Sandbox connectors (M5-01): deterministic synthetic fixtures per provider, no network, no secrets. They
 * exist so the whole pipeline (consent, phases, sync runs, lineage, stale states, dashboards) can be exercised
 * before any client grants read access. Every reading they produce is labelled `simulated` by the sync run.
 * The fixtures describe a synthetic event-rental company (tenant A) and a synthetic hotel (tenant B) and are
 * seeded from the tenant id so the two tenants never share numbers.
 */
const DAY = 86_400_000;

function seedFrom(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) % 1000;
}

function iso(d: Date): string {
  return d.toISOString();
}

function guardPhase(ctx: ConnectorContext, what: string): void {
  if (ctx.phase === "metadata") throw new PhaseViolationError(`${what} is not allowed in the metadata phase; only describe() is`);
  if (ctx.phase === "write") throw new PhaseViolationError("the write phase has no implementation");
}

export const DESCRIPTORS: Record<Provider, ConnectorDescriptor> = {
  rentman: {
    provider: "rentman",
    displayName: "Rentman",
    vendor: "Rentman",
    objects: [
      { kind: "projects", fields: ["id", "name", "status", "planperiod_end", "usageperiod_end", "modified"], excluded: "customer contact details, prices per line and crew personal data are not read" },
      { kind: "invoices", fields: ["id", "project", "status", "date", "modified"] }
    ],
    metrics: [
      { key: "closed_projects_not_invoiced", name: "Closed projects not invoiced", unit: "count", formula: "count(projects where status in (returned, closed) and no invoice with status sent or paid)", sourceField: "projects.status, invoices.project", direction: "lower_is_better" },
      { key: "quote_to_invoice_days", name: "Quote to invoice lead time", unit: "days", formula: "median(invoices.date - projects.usageperiod_end) over invoices in period", sourceField: "invoices.date, projects.usageperiod_end", direction: "lower_is_better" }
    ],
    scopes: {
      metadata: [{ scope: "none", gloss: "No access. Only the system's name, function and the fields we would read are recorded." }],
      read_only: [{ scope: "projects:read", gloss: "Read project names, statuses and dates." }, { scope: "invoices:read", gloss: "Read invoice status and dates per project (no amounts in this phase)." }],
      sandbox: [{ scope: "projects:read", gloss: "Same as read-only, against a Rentman sandbox account." }]
    },
    secretRefs: ["env:RENTMAN_API_TOKEN"],
    docsUrl: "https://api.rentman.net/"
  },
  quickbooks: {
    provider: "quickbooks",
    displayName: "QuickBooks Online",
    vendor: "Intuit",
    objects: [{ kind: "invoices", fields: ["Id", "DocNumber", "TxnDate", "DueDate", "Balance", "TotalAmt", "MetaData.LastUpdatedTime"], excluded: "customer addresses, line items and attachments are not read" }],
    metrics: [
      { key: "overdue_receivables_eur", name: "Overdue receivables", unit: "EUR", formula: "sum(Invoice.Balance where DueDate < today and Balance > 0)", sourceField: "Invoice.Balance, Invoice.DueDate", direction: "lower_is_better" },
      { key: "open_invoices_count", name: "Open invoices", unit: "count", formula: "count(Invoice where Balance > 0)", sourceField: "Invoice.Balance", direction: "lower_is_better" }
    ],
    scopes: {
      metadata: [{ scope: "none", gloss: "No access." }],
      read_only: [{ scope: "com.intuit.quickbooks.accounting (read)", gloss: "Read invoices: number, dates, balance. Never payments, payroll or bank feeds." }],
      sandbox: [{ scope: "com.intuit.quickbooks.accounting (read)", gloss: "Same scope against an Intuit sandbox company." }]
    },
    secretRefs: ["env:QUICKBOOKS_REFRESH_TOKEN", "env:QUICKBOOKS_REALM_ID"],
    docsUrl: "https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice"
  },
  trengo: {
    provider: "trengo",
    displayName: "Trengo",
    vendor: "Trengo",
    objects: [{ kind: "tickets", fields: ["id", "status", "channel", "created_at", "closed_at"], excluded: "message bodies, contact names and phone numbers are never read" }],
    metrics: [
      { key: "open_conversations", name: "Open customer conversations", unit: "count", formula: "count(tickets where status = OPEN)", sourceField: "tickets.status", direction: "lower_is_better" },
      { key: "median_first_response_hours", name: "Median first response time", unit: "hours", formula: "median(first_reply_at - created_at) over tickets created in period", sourceField: "tickets.created_at, tickets.first_reply_at", direction: "lower_is_better" }
    ],
    scopes: {
      metadata: [{ scope: "none", gloss: "No access." }],
      read_only: [{ scope: "tickets:read (metadata)", gloss: "Read ticket status, channel and timestamps only." }],
      sandbox: [{ scope: "tickets:read (metadata)", gloss: "Same against a Trengo test inbox." }]
    },
    secretRefs: ["env:TRENGO_API_TOKEN"],
    docsUrl: "https://developers.trengo.com/"
  },
  dropbox: {
    provider: "dropbox",
    displayName: "Dropbox",
    vendor: "Dropbox",
    objects: [{ kind: "files", fields: ["id", "name", "path_lower", "client_modified", "size"], excluded: "file contents are never downloaded in this release" }],
    metrics: [{ key: "documents_modified_30d", name: "Documents modified in the last 30 days", unit: "count", formula: "count(files where client_modified >= today - 30 days) in the agreed folders", sourceField: "files.client_modified", direction: "higher_is_better" }],
    scopes: {
      metadata: [{ scope: "none", gloss: "No access." }],
      read_only: [{ scope: "files.metadata.read", gloss: "List file names, folders and modification dates in agreed folders. No downloads." }],
      sandbox: [{ scope: "files.metadata.read", gloss: "Same against a test folder." }]
    },
    secretRefs: ["env:DROPBOX_REFRESH_TOKEN"],
    docsUrl: "https://www.dropbox.com/developers/documentation/http/documentation"
  }
};

function fixtures(provider: Provider, ctx: ConnectorContext): Record<string, SourceObject[]> {
  const base = seedFrom(ctx.tenantId);
  const now = ctx.now();
  const d = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY);
  switch (provider) {
    case "rentman": {
      const projects: SourceObject[] = Array.from({ length: 12 }, (_, i) => {
        const status = i < 7 ? "returned" : i < 10 ? "in_progress" : "quoted";
        return { kind: "projects", id: `P-${base}-${i + 1}`, updatedAt: iso(d(i)), fields: { name: `Synthetic event ${i + 1}`, status, planperiod_end: iso(d(i + 3)), usageperiod_end: iso(d(i + 2)), modified: iso(d(i)) } };
      });
      // Of the 7 returned projects, (base % 3) + 2 have no sent invoice yet.
      const notInvoiced = (base % 3) + 2;
      const invoices: SourceObject[] = projects
        .filter((p) => p.fields.status === "returned")
        .slice(notInvoiced)
        .map((p, i) => ({ kind: "invoices", id: `I-${base}-${i + 1}`, updatedAt: iso(d(i)), fields: { project: p.id, status: i % 4 === 0 ? "paid" : "sent", date: iso(d(i + 2 - ((base + i) % 5))), modified: iso(d(i)) } }));
      return { projects, invoices };
    }
    case "quickbooks": {
      const invoices: SourceObject[] = Array.from({ length: 9 }, (_, i) => {
        const total = 1200 + ((base * 7 + i * 313) % 4800);
        const overdue = i % 3 === 0;
        const balance = i % 4 === 3 ? 0 : overdue ? total : Math.round(total / 2);
        return { kind: "invoices", id: `QB-${base}-${i + 1}`, updatedAt: iso(d(i)), fields: { DocNumber: `${1000 + base + i}`, TxnDate: iso(d(20 + i)), DueDate: iso(overdue ? d(5 + i) : new Date(now.getTime() + (10 + i) * DAY)), Balance: balance, TotalAmt: total, "MetaData.LastUpdatedTime": iso(d(i)) } };
      });
      return { invoices };
    }
    case "trengo": {
      const tickets: SourceObject[] = Array.from({ length: 15 }, (_, i) => ({ kind: "tickets", id: `T-${base}-${i + 1}`, updatedAt: iso(d(i % 6)), fields: { status: i % 4 === 0 ? "OPEN" : "CLOSED", channel: i % 2 === 0 ? "whatsapp" : "email", created_at: iso(d(i % 6 + 1)), closed_at: i % 4 === 0 ? null : iso(d(i % 6)), first_reply_at: iso(new Date(d(i % 6 + 1).getTime() + ((base % 5) + 1 + (i % 3)) * 3_600_000)) } }));
      return { tickets };
    }
    case "dropbox": {
      const files: SourceObject[] = Array.from({ length: 20 }, (_, i) => ({ kind: "files", id: `id:${base}${i}`, updatedAt: iso(d(i * 3)), fields: { name: `document-${i + 1}.pdf`, path_lower: `/contracts/document-${i + 1}.pdf`, client_modified: iso(d(i * 3)), size: 10_000 + i * 777 } }));
      return { files };
    }
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export class SandboxConnector implements Connector {
  constructor(private readonly provider: Provider) {}

  describe(): ConnectorDescriptor {
    return DESCRIPTORS[this.provider];
  }

  async testConnection(ctx: ConnectorContext): Promise<TestConnectionResult> {
    guardPhase(ctx, "testConnection");
    const fx = fixtures(this.provider, ctx);
    return { ok: true, mode: "sandbox", message: "Sandbox fixtures served; no external system was contacted (simulated).", objectsVisible: Object.fromEntries(Object.entries(fx).map(([k, v]) => [k, v.length])) };
  }

  async listObjects(ctx: ConnectorContext, kind: string, since: Date | null): Promise<SourceObject[]> {
    guardPhase(ctx, "listObjects");
    const rows = fixtures(this.provider, ctx)[kind];
    if (!rows) throw new Error(`object kind "${kind}" is not declared for ${this.provider}`);
    return since ? rows.filter((r) => new Date(r.updatedAt) >= since) : rows;
  }

  async readMetrics(ctx: ConnectorContext, keys: string[], period: { start: Date; end: Date }): Promise<MetricReading[]> {
    guardPhase(ctx, "readMetrics");
    const fx = fixtures(this.provider, ctx);
    const desc = this.describe();
    const out: MetricReading[] = [];
    for (const key of keys) {
      const m = desc.metrics.find((x) => x.key === key);
      if (!m) {
        out.push({ key, status: "error", value: null, periodStart: period.start, periodEnd: period.end, sourceField: "", formula: "", sourceRecordIds: [], note: `metric ${key} is not provided by ${this.provider}` });
        continue;
      }
      const reading = (value: number | null, ids: string[], note?: string): MetricReading => ({ key, status: value === null ? "missing_data" : "ok", value, periodStart: period.start, periodEnd: period.end, sourceField: m.sourceField, formula: m.formula, sourceRecordIds: ids, note });
      switch (key) {
        case "closed_projects_not_invoiced": {
          const invoiced = new Set((fx.invoices ?? []).filter((i) => i.fields.status === "sent" || i.fields.status === "paid").map((i) => String(i.fields.project)));
          const closed = (fx.projects ?? []).filter((p) => p.fields.status === "returned" || p.fields.status === "closed");
          const open = closed.filter((p) => !invoiced.has(p.id));
          out.push(reading(open.length, open.map((p) => p.id)));
          break;
        }
        case "quote_to_invoice_days": {
          const byId = new Map((fx.projects ?? []).map((p) => [p.id, p]));
          const days: number[] = [];
          const ids: string[] = [];
          for (const inv of fx.invoices ?? []) {
            const p = byId.get(String(inv.fields.project));
            if (!p) continue;
            days.push(Math.max(0, (new Date(String(inv.fields.date)).getTime() - new Date(String(p.fields.usageperiod_end)).getTime()) / DAY));
            ids.push(inv.id);
          }
          out.push(reading(median(days.map((x) => Math.round(x * 10) / 10)), ids));
          break;
        }
        case "overdue_receivables_eur": {
          const now = ctx.now();
          const overdue = (fx.invoices ?? []).filter((i) => Number(i.fields.Balance) > 0 && new Date(String(i.fields.DueDate)) < now);
          out.push(reading(overdue.reduce((s, i) => s + Number(i.fields.Balance), 0), overdue.map((i) => i.id)));
          break;
        }
        case "open_invoices_count": {
          const open = (fx.invoices ?? []).filter((i) => Number(i.fields.Balance) > 0);
          out.push(reading(open.length, open.map((i) => i.id)));
          break;
        }
        case "open_conversations": {
          const open = (fx.tickets ?? []).filter((t) => t.fields.status === "OPEN");
          out.push(reading(open.length, open.map((t) => t.id)));
          break;
        }
        case "median_first_response_hours": {
          const hours = (fx.tickets ?? []).map((t) => (new Date(String(t.fields.first_reply_at)).getTime() - new Date(String(t.fields.created_at)).getTime()) / 3_600_000);
          out.push(reading(median(hours), (fx.tickets ?? []).map((t) => t.id)));
          break;
        }
        case "documents_modified_30d": {
          const cutoff = ctx.now().getTime() - 30 * DAY;
          const recent = (fx.files ?? []).filter((f) => new Date(String(f.fields.client_modified)).getTime() >= cutoff);
          out.push(reading(recent.length, recent.map((f) => f.id)));
          break;
        }
        default:
          out.push(reading(null, [], "no computation defined"));
      }
    }
    return out;
  }
}
