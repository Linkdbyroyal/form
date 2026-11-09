import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, tenantContext, runMigrations, schema, type DbHandle } from "@sbos/db";
import { seed } from "@sbos/db/seed";
import { MemoryJobBackend, activateActionTask, createActionTask, createFinding, currentDashboard, decideApproval, defineKpi, latestObservations, observeKpi, proposeOpportunity, publishDashboard, setOpportunityState, storeBriefing, upsertProcess } from "../src/index";

const url = process.env.DATABASE_URL_TEST ?? "postgres://sbos:sbos@localhost:5432/sbos_test";
let handle: DbHandle;
let tenantA: string;
let tenantB: string;
const jobs = new MemoryJobBackend();
const agent = { actorType: "agent" as const, actorId: "agent:ceo-intel:northline", roles: ["agent_service"] };
const ceo = { actorType: "user" as const, actorId: "ceo-a", roles: ["client_admin"] };

async function expectDbError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown = null;
  try { await promise; } catch (err) { caught = err; }
  expect(caught, "expected failure").not.toBeNull();
  const e = caught as { message?: string; cause?: { message?: string } };
  expect(`${e.message ?? ""} :: ${e.cause?.message ?? ""}`).toMatch(pattern);
}

beforeAll(async () => {
  await runMigrations(url);
  handle = createDb({ connectionString: url, max: 4 });
  const s = await seed(handle);
  tenantA = s.tenantIds["northline-events"]!;
  tenantB = s.tenantIds["harbour-view-hotel"]!;
});
afterAll(async () => handle.close());

describe("KPI registry", () => {
  it("refuses a KPI without source or formula and never stores a number for missing data", async () => {
    const ctx = tenantContext({ tenantId: tenantA, ...agent });
    await expectDbError(handle.withContext(ctx, (tx) => defineKpi(tx, ctx, { tenantId: tenantA, key: "bad", name: "Bad", businessQuestion: "?", formula: " ", unit: "EUR", sourceSystem: "quickbooks", sourceField: "x", ownerRole: "client_admin" })), /check constraint|violates/);
    const kpiId = await handle.withContext(ctx, (tx) => defineKpi(tx, ctx, { tenantId: tenantA, key: "ar_overdue", name: "Overdue receivables", businessQuestion: "How much invoiced revenue is overdue?", formula: "sum(invoice.balance) where due_date < today", unit: "EUR", sourceSystem: "quickbooks", sourceField: "Invoice.Balance", ownerRole: "department_manager", direction: "lower_is_better", warningThreshold: 10000, criticalThreshold: 25000 }));
    await expect(handle.withContext(ctx, (tx) => observeKpi(tx, ctx, { tenantId: tenantA, kpiId, periodStart: new Date("2026-11-01"), periodEnd: new Date("2026-11-08"), status: "missing_data", value: 123, lineage: { query_or_formula: "n/a", source_record_ids: [] } }))).resolves.toBeDefined();
    const rows = await handle.withContext(ctx, (tx) => latestObservations(tx, tenantA));
    const ar = rows.rows.find((r) => r.key === "ar_overdue");
    expect(ar?.status).toBe("missing_data");
    expect(ar?.value).toBeNull();
    expect(ar?.kpi_status).toBe("missing_source");
    // Direct insert of a value with a non-ok status is blocked by the CHECK constraint.
    await expectDbError(handle.withContext(ctx, (tx) => tx.insert(schema.kpiObservations).values({ tenantId: tenantA, kpiId, periodStart: new Date(), periodEnd: new Date(), value: "5", status: "stale_data", computedByActorType: "agent", computedByActorId: "x", lineage: {} })), /check constraint|violates/);
    await handle.withContext(ctx, (tx) => observeKpi(tx, ctx, { tenantId: tenantA, kpiId, periodStart: new Date("2026-11-01"), periodEnd: new Date("2026-11-08"), status: "ok", value: 8400.5, lineage: { query_or_formula: "sum(Invoice.Balance)", source_record_ids: ["inv-1", "inv-2"] } }));
    const after = await handle.withContext(ctx, (tx) => latestObservations(tx, tenantA));
    expect(after.rows.find((r) => r.key === "ar_overdue")?.value).toBe("8400.5");
    expect(after.rows.find((r) => r.key === "ar_overdue")?.kpi_status).toBe("active");
  });
});

describe("findings, opportunities and the action center", () => {
  it("opportunity and action task cannot advance without an approved approval; approval unlocks assignment and schedules verification", async () => {
    const ctx = tenantContext({ tenantId: tenantA, ...agent });
    const ceoCtx = tenantContext({ tenantId: tenantA, ...ceo });
    const [src] = await handle.withContext(ctx, (tx) => tx.insert(schema.sources).values({ tenantId: tenantA, system: "interview", locator: "question:test", createdByActorType: "agent", createdByActorId: agent.actorId }).returning({ id: schema.sources.id }));
    const findingId = await handle.withContext(ctx, (tx) => createFinding(tx, ctx, { tenantId: tenantA, title: "Projects closed late before invoicing", description: "Finance waits for warehouse confirmation", department: "finance", severity: "high", urgency: "short_term", impact: { description: "Invoices leave 9 days late", estimated_annual_cost: { amount: 12000, currency: "EUR", is_estimate: true } }, ownerRole: "department_manager", claim: "hypothesis", sourceIds: [src!.id], confidence: 0.45 }));
    const processId = await handle.withContext(ctx, (tx) => upsertProcess(tx, ctx, { tenantId: tenantA, key: "project-closure", name: "Project closure to invoice", department: "finance", variant: "to_be", sourceIds: [src!.id], steps: [{ kind: "trigger", name: "Return registered in Rentman" }, { kind: "activity", name: "Automatic closure check", intervention: "automate" }, { kind: "control", name: "Finance reviews exceptions", intervention: "keep_human" }] }));
    const { opportunityId, approvalId } = await handle.withContext(ctx, (tx) => proposeOpportunity(tx, ctx, { tenantId: tenantA, title: "Project closure to invoice readiness check", description: "Trigger invoice preparation when all returns are registered", findingIds: [findingId], intervention: "automate", businessCase: { effort: "m", estimated_saving: { amount: 9000, currency: "EUR", is_estimate: true } }, priorityScore: { impact: 4, feasibility: 4, risk: 2, time_to_value: 4 }, sourceIds: [src!.id], confidence: 0.5, toBeProcessId: processId }));
    await expectDbError(handle.withContext(ctx, (tx) => setOpportunityState(tx, ctx, { tenantId: tenantA, opportunityId, state: "approved" })), /approval .* is pending|requires an approval/);

    const { taskId } = await handle.withContext(ctx, (tx) => createActionTask(tx, ctx, { tenantId: tenantA, title: "Introduce closure checklist", issue: "Late invoices", proposedAction: "Warehouse confirms returns daily; finance invoices within 2 days", opportunityId, ownerRole: "department_manager", sourceIds: [src!.id], approvalId }));
    await expectDbError(handle.withContext(ctx, (tx) => activateActionTask(tx, ctx, jobs, { tenantId: tenantA, taskId })), /approval .* is pending|needs an approval/);

    await handle.withContext(ceoCtx, (tx) => decideApproval(tx, ceoCtx, jobs, { tenantId: tenantA, approvalId, decision: "approved", decidedBy: { actorId: ceo.actorId } }));
    await handle.withContext(ceoCtx, (tx) => setOpportunityState(tx, ceoCtx, { tenantId: tenantA, opportunityId, state: "approved" }));
    const [inst] = await handle.withContext(ctx, (tx) => tx.select({ id: schema.agentInstances.id }).from(schema.agentInstances));
    const { scheduleId } = await handle.withContext(ceoCtx, (tx) => activateActionTask(tx, ceoCtx, jobs, { tenantId: tenantA, taskId, verifyAfterDays: 7, verificationAgentInstanceId: inst!.id }));
    expect(scheduleId).not.toBeNull();
    const [task] = await handle.withContext(ctx, (tx) => tx.select().from(schema.actionTasks).where(sql`id = ${taskId}`));
    expect(task?.state).toBe("assigned");
    const [sched] = await handle.withContext(ctx, (tx) => tx.select().from(schema.schedules).where(sql`id = ${scheduleId}`));
    expect(sched?.enabled).toBe(true);
    // Tenant B sees none of this.
    const ctxB = tenantContext({ tenantId: tenantB, ...ceo });
    expect((await handle.withContext(ctxB, (tx) => tx.select().from(schema.opportunities))).length).toBe(0);
  });
});

describe("dashboards and briefings", () => {
  it("rejects a specification with an unknown widget type and versions published dashboards", async () => {
    const ctx = tenantContext({ tenantId: tenantA, ...agent });
    const kpiId = await handle.withContext(ctx, (tx) => defineKpi(tx, ctx, { tenantId: tenantA, key: "quote_to_invoice_days", name: "Quote to invoice lead time", businessQuestion: "How long from quote to invoice?", formula: "avg(invoice.date - quote.date)", unit: "days", sourceSystem: "rentman", sourceField: "projects.invoice_date", ownerRole: "client_admin" }));
    const base = { dashboard_id: crypto.randomUUID(), tenant_id: tenantA, audience_role: "ceo", title: "CEO Dashboard", locale: "en", version: 1, review_status: "unreviewed" };
    await expect(handle.withContext(ctx, (tx) => publishDashboard(tx, ctx, { tenantId: tenantA, specification: { ...base, widgets: [{ widget_id: crypto.randomUUID(), type: "iframe", kpi_ids: [], priority: 1, reason: "x", size: "m" }] } }))).rejects.toThrow();
    const first = await handle.withContext(ctx, (tx) => publishDashboard(tx, ctx, { tenantId: tenantA, specification: { ...base, widgets: [{ widget_id: crypto.randomUUID(), type: "kpi_tile", kpi_ids: [kpiId], priority: 1, reason: "Cash conversion speed", size: "s" }, { widget_id: crypto.randomUUID(), type: "data_gap_list", kpi_ids: [], priority: 2, reason: "Show what is missing instead of guessing", size: "m" }] } }));
    const second = await handle.withContext(ctx, (tx) => publishDashboard(tx, ctx, { tenantId: tenantA, specification: { ...base, dashboard_id: crypto.randomUUID(), version: 2, widgets: [{ widget_id: crypto.randomUUID(), type: "kpi_tile", kpi_ids: [kpiId], priority: 1, reason: "Cash conversion speed", size: "s" }] } }));
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    const current = await handle.withContext(ctx, (tx) => currentDashboard(tx, tenantA, "ceo"));
    expect(current?.id).toBe(second.dashboardId);
    await expect(handle.withContext(ctx, (tx) => publishDashboard(tx, ctx, { tenantId: tenantA, specification: { ...base, tenant_id: tenantB, widgets: [] } }))).rejects.toThrow(/tenant mismatch|at least/);
  });

  it("stores a briefing only with exactly the eight sections and 5 to 7 priorities", async () => {
    const ctx = tenantContext({ tenantId: tenantA, ...agent });
    const item = (text: string) => [{ text, source_ids: [], confidence: 0.5 }];
    const envelope = { tenant_id: tenantA, source_ids: [], confidence: 0.5, generated_at: new Date().toISOString(), review_status: "unreviewed", permissions_context: { tenant_id: tenantA, actor_type: "agent", actor_id: agent.actorId, roles: ["agent_service"], scopes: [], cross_tenant_content_authorized: false } };
    const sections = { what_changed: item("a"), what_matters_today: item("b"), decisions_needed: item("c"), tasks_delegated: item("d"), risks: item("e"), opportunities: item("f"), data_gaps: item("g"), impact_of_prior_improvements: item("h") };
    await expect(handle.withContext(ctx, (tx) => storeBriefing(tx, ctx, { tenantId: tenantA, simulated: true, briefing: { ...envelope, briefing_id: crypto.randomUUID(), briefing_date: "2026-11-09", sections, top_priorities: ["1", "2", "3", "4", "5", "6", "7", "8"] } }))).rejects.toThrow();
    const ok = await handle.withContext(ctx, (tx) => storeBriefing(tx, ctx, { tenantId: tenantA, simulated: true, briefing: { ...envelope, briefing_id: crypto.randomUUID(), briefing_date: "2026-11-09", sections, top_priorities: ["Close project P-1", "Decide on checklist", "Review overdue AR", "Confirm QuickBooks status", "Data gap: Trengo"] } }));
    expect(ok.briefing.top_priorities.length).toBe(5);
  });
});
