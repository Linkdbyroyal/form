import { describe, expect, it } from "vitest";
import { DEFAULT_CLOSED_STATUS_NAMES, RentmanLiveConnector, rentmanConfig } from "../src/rentman";
import { getConnector } from "../src/registry";
import type { ConnectorContext, SecretReader } from "../src/types";

/**
 * Live Rentman connector against a fake API (no network): phase guard, bearer token, pagination, status mapping
 * with tenant-specific Dutch names, invoice status derivation, both metrics, and error handling without leaking
 * the token. Shapes mirror the real API as observed on 2026-11-10 (links as "/statuses/1", offset dates).
 */
const TOKEN = "rentman-test-token-0123456789abcdefghijklmnopqrstuvwxyz";
const secrets: SecretReader = { read: async (ref) => (ref === "env:RENTMAN_API_TOKEN_TEST" ? TOKEN : null) };
const now = () => new Date("2026-11-10T12:00:00Z");

const statuses = [{ id: 1, name: "Optie" }, { id: 2, name: "Geannuleerd" }, { id: 6, name: "Retour" }, { id: 1003, name: "Afgerond" }];
const subprojects = [
  { id: 1, project: "/projects/100", status: "/statuses/6", planperiod_end: "2026-10-20T18:00:00-04:00", usageperiod_end: "2026-10-20T18:00:00-04:00", modified: "2026-10-21T10:00:00-04:00" },
  { id: 2, project: "/projects/100", status: "/statuses/1003", planperiod_end: "2026-10-22T18:00:00-04:00", usageperiod_end: "2026-10-22T18:00:00-04:00", modified: "2026-10-23T10:00:00-04:00" },
  { id: 3, project: "/projects/101", status: "/statuses/6", planperiod_end: "2026-10-25T18:00:00-04:00", usageperiod_end: "2026-10-25T18:00:00-04:00", modified: "2026-10-26T10:00:00-04:00" },
  { id: 4, project: "/projects/102", status: "/statuses/1", planperiod_end: "2026-11-30T18:00:00-04:00", usageperiod_end: "2026-11-30T18:00:00-04:00", modified: "2026-11-01T10:00:00-04:00" },
  { id: 5, project: "/projects/103", status: "/statuses/6", planperiod_end: "2026-10-01T18:00:00-04:00", usageperiod_end: "2026-10-01T18:00:00-04:00", modified: "2026-10-02T10:00:00-04:00" },
  { id: 6, project: "/projects/103", status: "/statuses/1", planperiod_end: "2026-12-01T18:00:00-04:00", usageperiod_end: "2026-12-01T18:00:00-04:00", modified: "2026-10-02T10:00:00-04:00" },
  { id: 7, project: "/projects/104", status: "/statuses/2", planperiod_end: "2026-10-05T18:00:00-04:00", usageperiod_end: "2026-10-05T18:00:00-04:00", modified: "2026-10-05T10:00:00-04:00" }
];
const projects = [100, 101, 102, 103, 104].map((id) => ({ id, name: `Project ${id}`, modified: "2026-10-26T10:00:00-04:00" }));
const invoices = [
  { id: 900, project: "/projects/100", date: "2026-10-27T00:00:00-04:00", date_sent: null, is_paid: true, modified: "2026-10-27T10:00:00-04:00" },
  { id: 901, project: "/projects/103", date: "2026-10-04T00:00:00-04:00", date_sent: "2026-10-04T00:00:00-04:00", is_paid: false, modified: "2026-10-04T10:00:00-04:00" }
];

function fakeApi(opts: { pageSize?: number; status?: number; calls?: Array<{ url: string; auth: string | null }> } = {}): typeof globalThis.fetch {
  const tables: Record<string, unknown[]> = { "/statuses": statuses, "/subprojects": subprojects, "/projects": projects, "/invoices": invoices };
  return async (input, init) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization");
    opts.calls?.push({ url: url.pathname + url.search, auth });
    if (opts.status) return new Response("nope", { status: opts.status });
    if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
    const rows = tables[url.pathname] ?? [];
    const limit = Number(url.searchParams.get("limit"));
    const offset = Number(url.searchParams.get("offset"));
    return Response.json({ data: rows.slice(offset, offset + limit), itemCount: rows.length, limit, offset });
  };
}

function ctx(over: Partial<ConnectorContext> = {}): ConnectorContext {
  return { tenantId: "11111111-1111-1111-1111-111111111111", connectionId: "22222222-2222-2222-2222-222222222222", phase: "read_only", mode: "live", config: { credentialRef: "env:RENTMAN_API_TOKEN_TEST", pageSize: 50 }, secrets, fetch: fakeApi(), now, ...over };
}

describe("rentman live connector", () => {
  it("is the registered live connector for rentman only", () => {
    expect(getConnector("rentman", "live")).toBeInstanceOf(RentmanLiveConnector);
    expect(() => getConnector("quickbooks", "live")).toThrow(/not implemented/);
  });
  it("reads configuration with safe defaults and refuses a non-https base url", () => {
    const cfg = rentmanConfig({});
    expect(cfg).toMatchObject({ baseUrl: "https://api.rentman.net", secretRef: "env:RENTMAN_API_TOKEN", pageSize: 300, lookbackDays: 90, closedStatusNames: DEFAULT_CLOSED_STATUS_NAMES });
    expect(rentmanConfig({ closedStatusNames: [" Afgerond ", "Retour"], pageSize: 5000 }).closedStatusNames).toEqual(["afgerond", "retour"]);
    expect(() => rentmanConfig({ baseUrl: "http://api.rentman.net" })).toThrow(/https/);
  });
  it("never calls the network in the metadata phase or in sandbox mode", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const c = new RentmanLiveConnector();
    await expect(c.testConnection(ctx({ phase: "metadata", fetch: fakeApi({ calls }) }))).rejects.toThrow(/metadata phase/);
    await expect(c.readMetrics(ctx({ mode: "sandbox", fetch: fakeApi({ calls }) }), ["closed_projects_not_invoiced"], { start: now(), end: now() })).rejects.toThrow(/live mode/);
    expect(calls).toHaveLength(0);
  });
  it("tests the connection with the bearer token and recognises the account's closed statuses", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const r = await new RentmanLiveConnector().testConnection(ctx({ fetch: fakeApi({ calls }) }));
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("live");
    expect(r.message).toContain("Retour, Afgerond");
    expect(r.objectsVisible).toEqual({ statuses: 4, projects: 7, invoices: 2 });
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(calls.map((c) => c.url.split("?")[0]).sort()).toEqual(["/invoices", "/statuses", "/subprojects"]);
    expect(calls.find((c) => c.url.startsWith("/subprojects"))?.url).toContain("fields=id&");
  });
  it("reports a clear result when no closed status name matches", async () => {
    const r = await new RentmanLiveConnector().testConnection(ctx({ config: { credentialRef: "env:RENTMAN_API_TOKEN_TEST", closedStatusNames: ["Done"] } }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("closedStatusNames");
  });
  it("paginates with offset and reads only the declared fields", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const rows = await new RentmanLiveConnector().listObjects(ctx({ config: { credentialRef: "env:RENTMAN_API_TOKEN_TEST", pageSize: 50 }, fetch: fakeApi({ calls }) }), "invoices", null);
    expect(rows).toHaveLength(2);
    const inv = calls.filter((c) => c.url.startsWith("/invoices"));
    expect(inv.map((c) => new URL(`https://x${c.url}`).searchParams.get("offset"))).toEqual(["0"]);
    expect(new URL(`https://x${inv[0]!.url}`).searchParams.get("fields")).toBe("id,project,date,date_sent,is_paid,modified");
    expect(Object.keys(rows[0]!.fields).sort()).toEqual(["date", "modified", "project", "status"]);
    expect(rows.map((r) => r.fields.status)).toEqual(["paid", "sent"]);
  });
  it("derives project status from all subprojects with tenant-specific names", async () => {
    const rows = await new RentmanLiveConnector().listObjects(ctx(), "projects", null);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.fields]));
    expect(byId["100"]!.status).toBe("closed"); // Retour + Afgerond
    expect(byId["101"]!.status).toBe("closed");
    expect(byId["102"]!.status).toBe("open"); // Optie
    expect(byId["103"]!.status).toBe("open"); // one subproject still Optie
    expect(byId["104"]!.status).toBe("cancelled");
    expect(byId["100"]!.usageperiod_end).toBe("2026-10-22T22:00:00.000Z"); // latest subproject, offset applied
    expect(byId["100"]!.name).toBe("Project 100");
  });
  it("computes both metrics with lineage to the source records", async () => {
    const period = { start: new Date("2026-10-11T00:00:00Z"), end: now() };
    const readings = await new RentmanLiveConnector().readMetrics(ctx(), ["closed_projects_not_invoiced", "quote_to_invoice_days", "nope"], period);
    const notInvoiced = readings.find((r) => r.key === "closed_projects_not_invoiced")!;
    expect(notInvoiced.status).toBe("ok");
    expect(notInvoiced.value).toBe(1); // 101 closed without invoice; 100 invoiced; 103 still open
    expect(notInvoiced.sourceRecordIds).toEqual(["101"]);
    const lead = readings.find((r) => r.key === "quote_to_invoice_days")!;
    expect(lead.status).toBe("ok");
    expect(lead.value).toBe(4.3); // invoice 900 (27 Oct 04:00Z) minus usage end of project 100 (22 Oct 22:00Z) = 4.25 days, rounded to one decimal
    expect(lead.sourceRecordIds).toEqual(["900"]); // invoice 901 is before the period
    expect(readings.find((r) => r.key === "nope")!.status).toBe("error");
  });
  it("fails clearly on a missing secret and on rejected credentials, without the token in the message", async () => {
    const c = new RentmanLiveConnector();
    await expect(c.testConnection(ctx({ config: { credentialRef: "env:RENTMAN_API_TOKEN_MISSING" } }))).rejects.toThrow(/env:RENTMAN_API_TOKEN_MISSING is not configured/);
    await expect(c.testConnection(ctx({ fetch: fakeApi({ status: 401 }) }))).rejects.toThrow(/credentials rejected \(401\)/);
    try {
      await c.testConnection(ctx({ fetch: fakeApi({ status: 401 }) }));
    } catch (err) {
      expect((err as Error).message).not.toContain(TOKEN);
    }
  });
});
