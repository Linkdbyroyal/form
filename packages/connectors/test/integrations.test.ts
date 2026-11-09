import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agencyContext, createDb, operatorContext, runMigrations, schema, tenantContext, type DbHandle } from "@sbos/db";
import { seed } from "@sbos/db/seed";
import { MemoryJobBackend, advancePhase, dueConnections, grantConsent, proposeConnection, recordSecurityReview, registerCredentialReference, revokeConsent } from "@sbos/core";
import { DESCRIPTORS, SandboxConnector, maskSecrets, parseSecretRef, runConnectionSync, getConnector } from "../src/index";

/** Milestone 5 acceptance: phases with consent, no network in metadata, lineage, isolation, secrets by reference. */
const url = process.env.DATABASE_URL_TEST ?? "postgres://sbos:sbos@localhost:5432/sbos_test";
let handle: DbHandle;
let tenantA: string;
let tenantB: string;
let ceoUserId: string;
const ceo = { actorType: "user" as const, actorId: "ceo-a", roles: ["client_admin"] };
const manager = { actorType: "user" as const, actorId: "manager-a", roles: ["department_manager"] };
const agent = { actorType: "agent" as const, actorId: "agent:finance:northline", roles: ["agent_service"] };
const reviewer = { actorType: "user" as const, actorId: "agency-reviewer", roles: ["agency_reviewer"] };
const jobs = new MemoryJobBackend();

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
  const seeded = await seed(handle);
  tenantA = seeded.tenantIds["northline-events"]!;
  tenantB = seeded.tenantIds["harbour-view-hotel"]!;
  ceoUserId = seeded.userIds["ceo@northline.test"]!;
});
afterAll(async () => handle.close());

describe("sandbox connectors (unit)", () => {
  it("describe every provider with objects, metrics with formula and source field, and scopes per phase", () => {
    for (const p of ["rentman", "quickbooks", "trengo", "dropbox"] as const) {
      const d = new SandboxConnector(p).describe();
      expect(d.metrics.length).toBeGreaterThan(0);
      for (const m of d.metrics) {
        expect(m.formula.length).toBeGreaterThan(10);
        expect(m.sourceField.length).toBeGreaterThan(3);
      }
      expect(d.scopes.metadata[0]!.scope).toBe("none");
      expect(d.secretRefs.every((r) => r.startsWith("env:"))).toBe(true);
    }
    expect(DESCRIPTORS.rentman.objects.map((o) => o.kind)).toEqual(["projects", "invoices"]);
  });

  it("serves deterministic fixtures per tenant and refuses every call in the metadata phase", async () => {
    const c = new SandboxConnector("rentman");
    const base = { connectionId: "c1", mode: "sandbox" as const, config: {}, secrets: { read: async () => null }, fetch: (() => { throw new Error("no network"); }) as unknown as typeof fetch, now: () => new Date("2026-11-09T12:00:00Z") };
    const a1 = await c.readMetrics({ ...base, tenantId: "tenant-a", phase: "read_only" }, ["closed_projects_not_invoiced"], { start: new Date("2026-10-10"), end: new Date("2026-11-09") });
    const a2 = await c.readMetrics({ ...base, tenantId: "tenant-a", phase: "read_only" }, ["closed_projects_not_invoiced"], { start: new Date("2026-10-10"), end: new Date("2026-11-09") });
    const b = await c.readMetrics({ ...base, tenantId: "tenant-b", phase: "read_only" }, ["closed_projects_not_invoiced"], { start: new Date("2026-10-10"), end: new Date("2026-11-09") });
    expect(a1[0]!.value).toBe(a2[0]!.value);
    expect(a1[0]!.status).toBe("ok");
    expect(a1[0]!.sourceRecordIds.length).toBe(a1[0]!.value);
    expect(a1[0]!.sourceRecordIds[0]).not.toBe(b[0]!.sourceRecordIds[0]);
    await expect(c.readMetrics({ ...base, tenantId: "tenant-a", phase: "metadata" }, ["closed_projects_not_invoiced"], { start: new Date(), end: new Date() })).rejects.toThrow(/metadata phase/);
    await expect(c.testConnection({ ...base, tenantId: "tenant-a", phase: "metadata" })).rejects.toThrow(/metadata phase/);
    const unknown = await c.readMetrics({ ...base, tenantId: "tenant-a", phase: "read_only" }, ["not_a_metric"], { start: new Date(), end: new Date() });
    expect(unknown[0]!.status).toBe("error");
    expect(unknown[0]!.value).toBeNull();
  });

  it("live connectors are an explicit 'not connected' error, never a silent fixture; secrets are references and masked", () => {
    expect(() => getConnector("rentman", "live")).toThrow(/not implemented.*not connected/);
    expect(parseSecretRef("env:RENTMAN_API_TOKEN")).toEqual({ kind: "env", name: "RENTMAN_API_TOKEN" });
    expect(() => parseSecretRef("sk-live-abcdefghijklmnop")).toThrow(/env:VARIABLE_NAME/);
    const masked = maskSecrets("request failed with Bearer abcdefghijklmnopqrstuvwxyz0123456789 and token sk-abcdefgh1234 and secret hunter2-long-value", ["hunter2-long-value"]);
    expect(masked).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(masked).not.toContain("sk-abcdefgh1234");
    expect(masked).not.toContain("hunter2");
  });
});

describe("connection phases with consent (ADR-011)", () => {
  let connectionId: string;
  const ctxCeo = () => tenantContext({ tenantId: tenantA, ...ceo });
  const ctxManager = () => tenantContext({ tenantId: tenantA, ...manager });
  const ctxAgent = () => tenantContext({ tenantId: tenantA, ...agent });
  const ctxReviewer = () => agencyContext({ tenantId: tenantA, ...reviewer });

  it("starts in metadata without consent and refuses shortcuts", async () => {
    const [rentman] = await handle.withContext(ctxCeo(), (tx) => tx.select({ id: schema.systems.id }).from(schema.systems).where(sql`name = 'Rentman'`));
    connectionId = await handle.withContext(ctxCeo(), (tx) => proposeConnection(tx, ctxCeo(), { tenantId: tenantA, provider: "rentman", systemId: rentman!.id, syncIntervalMinutes: 30, reason: "pilot: closed projects not invoiced" }));
    // Credentials never in config.
    await expectDbError(handle.withContext(ctxCeo(), (tx) => proposeConnection(tx, ctxCeo(), { tenantId: tenantA, provider: "trengo", config: { api_token: "abc" } })), /looks like a credential/);
    // Inserting with consent or a later phase is refused by the trigger.
    await expectDbError(handle.withContext(ctxCeo(), (tx) => tx.insert(schema.connections).values({ tenantId: tenantA, provider: "dropbox", phase: "read_only", consent: "pending" })), /starts in phase metadata/);
    // Agents cannot change anything about a connection's phase or consent.
    await expectDbError(handle.withContext(ctxAgent(), (tx) => tx.update(schema.connections).set({ consent: "granted" }).where(sql`id = ${connectionId}`)), /agents cannot change/);
    // Advancing without consent is refused; a department manager cannot grant consent.
    await expectDbError(handle.withContext(ctxReviewer(), (tx) => advancePhase(tx, ctxReviewer(), { tenantId: tenantA, connectionId, to: "read_only", reason: "x" })), /requires consent granted/);
    await expectDbError(handle.withContext(ctxManager(), (tx) => grantConsent(tx, ctxManager(), { tenantId: tenantA, connectionId, scopes: ["projects:read"], reason: "manager tries", userId: ceoUserId })), /client admin/);
    // A sync in the metadata phase is skipped and makes no network call.
    const spy = { calls: 0 };
    const fetchSpy: typeof fetch = (async () => { spy.calls++; return new Response("{}"); }) as unknown as typeof fetch;
    const skipped = await runConnectionSync(handle, jobs, { tenantId: tenantA, connectionId, trigger: "manual", fetch: fetchSpy });
    expect(skipped.status).toBe("skipped");
    expect(skipped.note).toMatch(/metadata phase/);
    expect(skipped.networkCalls).toBe(0);
    expect(spy.calls).toBe(0);
  });

  it("client admin grants consent with scopes, agency reviews security, phase advances one step; write is refused", async () => {
    await handle.withContext(ctxCeo(), (tx) => grantConsent(tx, ctxCeo(), { tenantId: tenantA, connectionId, scopes: ["projects:read", "invoices:read"], reason: "CEO agreed in the kick-off on 2026-11-09; read-only, no amounts", userId: ceoUserId }));
    const afterConsent = await handle.withContext(ctxCeo(), async (tx) => (await tx.select().from(schema.connections).where(sql`id = ${connectionId}`))[0]!);
    expect(afterConsent.consent).toBe("granted");
    expect(afterConsent.consentGivenByUserId).toBe(ceoUserId);
    expect(afterConsent.consentGivenAt).not.toBeNull();
    expect(afterConsent.scopes).toEqual(["projects:read", "invoices:read"]);
    // Still refused: no security review yet; and the client admin cannot advance the phase.
    await expectDbError(handle.withContext(ctxReviewer(), (tx) => advancePhase(tx, ctxReviewer(), { tenantId: tenantA, connectionId, to: "read_only", reason: "x" })), /recorded security review/);
    await expectDbError(handle.withContext(ctxCeo(), (tx) => advancePhase(tx, ctxCeo(), { tenantId: tenantA, connectionId, to: "read_only", reason: "x" })), /agency decision/);
    await handle.withContext(ctxReviewer(), (tx) => recordSecurityReview(tx, ctxReviewer(), { tenantId: tenantA, connectionId, outcome: "approved", note: "scopes limited to project and invoice status; no personal data; token held in worker env" }));
    // Skipping a phase is refused; one step is fine.
    await expectDbError(handle.withContext(ctxReviewer(), (tx) => advancePhase(tx, ctxReviewer(), { tenantId: tenantA, connectionId, to: "sandbox", reason: "skip" })), /one step at a time/);
    await handle.withContext(ctxReviewer(), (tx) => advancePhase(tx, ctxReviewer(), { tenantId: tenantA, connectionId, to: "read_only", reason: "pilot read-only on sandbox fixtures" }));
    const active = await handle.withContext(ctxCeo(), async (tx) => (await tx.select().from(schema.connections).where(sql`id = ${connectionId}`))[0]!);
    expect(active.phase).toBe("read_only");
    expect(active.status).toBe("active");
    // The write phase does not exist in this release.
    await expectDbError(handle.withContext(ctxReviewer(), (tx) => tx.update(schema.connections).set({ phase: "sandbox" }).where(sql`id = ${connectionId}`).then(() => tx.update(schema.connections).set({ phase: "write" }).where(sql`id = ${connectionId}`))), /write phase has no implementation/);
    const changes = await handle.withContext(ctxCeo(), (tx) => tx.select({ kind: schema.connectionPhaseChanges.kind, actorId: schema.connectionPhaseChanges.actorId, outcome: schema.connectionPhaseChanges.reviewOutcome }).from(schema.connectionPhaseChanges).where(sql`connection_id = ${connectionId}`).orderBy(schema.connectionPhaseChanges.createdAt));
    expect(changes.map((c) => c.kind)).toEqual(["proposed", "consent_granted", "security_review", "phase_advanced"]);
    expect(changes[2]!.actorId).toBe(reviewer.actorId);
    expect(changes[2]!.outcome).toBe("approved");
    // Credential references only.
    await expectDbError(handle.withContext(ctxReviewer(), (tx) => registerCredentialReference(tx, ctxReviewer(), { tenantId: tenantA, connectionId, kind: "api_key", secretRef: "sk-live-1234567890abcdef" })), /never paste the secret/);
    await handle.withContext(ctxReviewer(), (tx) => registerCredentialReference(tx, ctxReviewer(), { tenantId: tenantA, connectionId, kind: "api_key", secretRef: "env:RENTMAN_API_TOKEN_NORTHLINE" }));
  });

  it("a sandbox sync writes observations with lineage and sync run; KPIs come from the descriptor; tenant B sees nothing; no network", async () => {
    const spy = { calls: 0 };
    const fetchSpy: typeof fetch = (async () => { spy.calls++; return new Response("{}"); }) as unknown as typeof fetch;
    const result = await runConnectionSync(handle, jobs, { tenantId: tenantA, connectionId, trigger: "manual", fetch: fetchSpy, now: () => new Date("2026-11-09T12:00:00Z") });
    expect(result.status).toBe("succeeded");
    expect(result.mode).toBe("sandbox");
    expect(result.observationsWritten).toBe(2);
    expect(result.networkCalls).toBe(0);
    expect(spy.calls).toBe(0);
    const obs = await handle.withContext(ctxCeo(), (tx) => tx.select({ status: schema.kpiObservations.status, value: schema.kpiObservations.value, lineage: schema.kpiObservations.lineage, syncRunId: schema.kpiObservations.syncRunId, kpiId: schema.kpiObservations.kpiId }).from(schema.kpiObservations).where(sql`sync_run_id = ${result.syncRunId}`));
    expect(obs).toHaveLength(2);
    for (const o of obs) {
      expect(o.syncRunId).toBe(result.syncRunId);
      const lineage = o.lineage as { query_or_formula: string; source_record_ids: string[] };
      expect(lineage.query_or_formula).toContain("Rentman.");
      if (o.status === "ok") expect(lineage.source_record_ids.length).toBeGreaterThan(0);
      if (o.status !== "ok") expect(o.value).toBeNull();
    }
    const kpiRows = await handle.withContext(ctxCeo(), (tx) => tx.select({ key: schema.kpis.key, formula: schema.kpis.formula, sourceSystem: schema.kpis.sourceSystem, sourceField: schema.kpis.sourceField, status: schema.kpis.status }).from(schema.kpis).where(sql`key in ('closed_projects_not_invoiced', 'quote_to_invoice_days')`));
    expect(kpiRows).toHaveLength(2);
    expect(kpiRows.every((k) => k.sourceSystem === "Rentman" && k.formula.length > 10 && k.sourceField.length > 3)).toBe(true);
    const run = await handle.withContext(ctxCeo(), async (tx) => (await tx.select().from(schema.syncRuns).where(sql`id = ${result.syncRunId}`))[0]!);
    expect(run.status).toBe("succeeded");
    expect(run.mode).toBe("sandbox");
    expect((run.details as { note: string }).note).toMatch(/simulated/);
    const conn = await handle.withContext(ctxCeo(), async (tx) => (await tx.select({ lastSyncAt: schema.connections.lastSyncAt }).from(schema.connections).where(sql`id = ${connectionId}`))[0]!);
    expect(conn.lastSyncAt).not.toBeNull();
    // Tenant B sees no connection, sync run, observation or phase change of tenant A.
    const ctxB = tenantContext({ tenantId: tenantB, actorType: "user", actorId: "ceo-b", roles: ["client_admin"] });
    const leaks = await handle.withContext(ctxB, async (tx) => ({
      c: (await tx.select({ id: schema.connections.id }).from(schema.connections)).length,
      r: (await tx.select({ id: schema.syncRuns.id }).from(schema.syncRuns)).length,
      o: (await tx.select({ id: schema.kpiObservations.id }).from(schema.kpiObservations).where(sql`sync_run_id is not null`)).length,
      p: (await tx.select({ id: schema.connectionPhaseChanges.id }).from(schema.connectionPhaseChanges)).length
    }));
    expect(leaks).toEqual({ c: 0, r: 0, o: 0, p: 0 });
    // Operator sees health metadata but not config or error text; due list works across tenants.
    const op = operatorContext({ actorType: "user", actorId: "op", roles: ["agency_operator"] });
    await expectDbError(handle.withContext(op, (tx) => tx.execute(sql`SELECT config FROM connections LIMIT 1`)), /permission denied/);
    await expectDbError(handle.withContext(op, (tx) => tx.execute(sql`SELECT error_message FROM sync_runs LIMIT 1`)), /permission denied/);
    const due = await handle.withContext(op, (tx) => dueConnections(tx, op, new Date(Date.now() + 31 * 60_000)));
    expect(due.some((d) => d.id === connectionId)).toBe(true);
    const notDue = await handle.withContext(op, (tx) => dueConnections(tx, op, new Date()));
    expect(notDue.some((d) => d.id === connectionId)).toBe(false);
  });

  it("revoking consent drops the connection to metadata, pauses it and marks dependent KPIs missing_source; syncs then skip", async () => {
    const r = await handle.withContext(ctxCeo(), (tx) => revokeConsent(tx, ctxCeo(), { tenantId: tenantA, connectionId, reason: "pilot paused by the CEO" }));
    expect(r.kpisMarked).toBe(2);
    const conn = await handle.withContext(ctxCeo(), async (tx) => (await tx.select().from(schema.connections).where(sql`id = ${connectionId}`))[0]!);
    expect(conn.phase).toBe("metadata");
    expect(conn.status).toBe("paused");
    expect(conn.consent).toBe("revoked");
    const kpiStatus = await handle.withContext(ctxCeo(), (tx) => tx.select({ status: schema.kpis.status }).from(schema.kpis).where(sql`key = 'closed_projects_not_invoiced'`));
    expect(kpiStatus[0]!.status).toBe("missing_source");
    const skipped = await runConnectionSync(handle, jobs, { tenantId: tenantA, connectionId, trigger: "schedule" });
    expect(skipped.status).toBe("skipped");
  });
});
