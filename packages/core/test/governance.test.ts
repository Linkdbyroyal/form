import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agencyContext, createDb, operatorContext, runMigrations, schema, tenantContext, type DbHandle } from "@sbos/db";
import { seed } from "@sbos/db/seed";
import { applyUpdate, assessUpdate, pinnedInstanceCount, completeDeletionManually, decideDeletion, decideUpdate, dueTechSources, effectiveRetention, executeDeletionRequest, recordDetectedUpdates, registerTechSource, requestDeletion, rollbackUpdate, setRetentionPolicy, setTechSourceApproval, sweepRetention, writeVaultDocument } from "../src/index";

const url = process.env.DATABASE_URL_TEST ?? "postgres://sbos:sbos@localhost:5432/sbos_test";
let handle: DbHandle;
let tenantA: string;
let tenantB: string;
const uniq = Date.now().toString(36);
const admin = agencyContext({ tenantId: null, actorType: "user", actorId: "gov-superadmin", roles: ["superadmin"] });
const reviewer = agencyContext({ tenantId: null, actorType: "user", actorId: "gov-reviewer", roles: ["agency_reviewer"] });
const consultant = agencyContext({ tenantId: null, actorType: "user", actorId: "gov-consultant", roles: ["agency_consultant"] });
const tiAgent = agencyContext({ tenantId: null, actorType: "agent", actorId: "agent:tech-intelligence:platform", roles: ["agent_service"] });
const system = agencyContext({ tenantId: null, actorType: "system", actorId: "worker:tech-watch", roles: ["system"] });

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
});
afterAll(async () => handle.close());

describe("Technology Intelligence Center (spec 4D)", () => {
  it("only approved sources are due; detection records items once; agents assess but never approve or apply; a skill update moves the stable channel and rolls back", async () => {
    const sourceId = await handle.withContext(consultant, (tx) => registerTechSource(tx, consultant, { key: `pg-boss-${uniq}`, name: "pg-boss releases", kind: "github_releases", fetchKind: "github_releases", url: "https://github.com/timgit/pg-boss/releases", relevantAgentKeys: ["worker"], checkIntervalHours: 24 }));
    await expectDbError(handle.withContext(tiAgent, (tx) => registerTechSource(tx, tiAgent, { key: `x-${uniq}`, name: "x", kind: "changelog", url: "https://example.com" })), /agents cannot register/);
    const dueBefore = await handle.withContext(system, (tx) => dueTechSources(tx, system));
    expect(dueBefore.some((s) => s.id === sourceId)).toBe(false);
    await expectDbError(handle.withContext(system, (tx) => recordDetectedUpdates(tx, system, { sourceId, items: [], mode: "fixture", status: "succeeded" })), /approved sources only/);
    await expectDbError(handle.withContext(consultant, (tx) => setTechSourceApproval(tx, consultant, { sourceId, approved: true, note: "x" })), /agency_reviewer or superadmin/);
    await handle.withContext(reviewer, (tx) => setTechSourceApproval(tx, reviewer, { sourceId, approved: true, note: "official releases page of a pinned dependency" }));
    const due = await handle.withContext(system, (tx) => dueTechSources(tx, system));
    expect(due.some((s) => s.id === sourceId)).toBe(true);

    const item = { externalId: "release:v12.39.0", subject: "pg-boss", proposedVersion: "12.39.0", sourceUrl: "https://github.com/timgit/pg-boss/releases/tag/v12.39.0", publishedAt: new Date("2026-11-01T00:00:00Z"), summary: "Adds a retention option for completed jobs." };
    const first = await handle.withContext(system, (tx) => recordDetectedUpdates(tx, system, { sourceId, items: [item], mode: "live", status: "succeeded" }));
    const second = await handle.withContext(system, (tx) => recordDetectedUpdates(tx, system, { sourceId, items: [item], mode: "live", status: "succeeded" }));
    expect(first.newUpdates).toBe(1);
    expect(second.newUpdates).toBe(0);
    const notDue = await handle.withContext(system, (tx) => dueTechSources(tx, system));
    expect(notDue.some((s) => s.id === sourceId)).toBe(false);
    const [update] = await handle.withContext(reviewer, (tx) => tx.select().from(schema.techUpdates).where(sql`source_id = ${sourceId}`));
    expect(update!.status).toBe("detected");

    // Assessing needs the full UpgradeProposal fields; approval needs the artefact of its kind.
    await expectDbError(handle.withContext(tiAgent, (tx) => tx.update(schema.techUpdates).set({ status: "assessed" }).where(sql`id = ${update!.id}`)), /needs kind, security risk/);
    await expectDbError(handle.withContext(tiAgent, (tx) => tx.update(schema.techUpdates).set({ status: "approved" }).where(sql`id = ${update!.id}`)), /not allowed|agents cannot/);
    // The skill update references a new immutable skill version of the process-redesign skill.
    const [skill] = await handle.withContext(admin, (tx) => tx.select({ id: schema.skills.id }).from(schema.skills).where(sql`key = 'process-redesign'`));
    const [stable] = await handle.withContext(admin, (tx) => tx.select({ skillVersionId: schema.skillReleaseChannels.skillVersionId }).from(schema.skillReleaseChannels).where(sql`skill_id = ${skill!.id} and channel = 'stable'`));
    const [newVersion] = await handle.withContext(admin, (tx) => tx.insert(schema.skillVersions).values({ skillId: skill!.id, version: `0.3.0-${uniq}`, skillMd: "# process-redesign 0.3.0 (test)", contracts: ["Opportunity"], allowedTools: ["vault.read"], releaseChannel: "draft", checksum: `sha-${uniq}`, createdBy: "test" }).returning({ id: schema.skillVersions.id }));
    await handle.withContext(tiAgent, (tx) => assessUpdate(tx, tiAgent, { updateId: update!.id, kind: "skill_update", securityRisk: "low", potentialBenefit: "Uses the new retention option to bound queue growth.", compatibilityNotes: "No breaking API changes listed in the release notes.", migrationPlan: "Bump the pinned version, run the worker tests and the acceptance script on staging.", rollbackPlan: "Pin the previous version; the stable channel keeps the previous skill version.", skillVersionId: newVersion!.id, note: "assessed by the Technology Intelligence agent" }));
    const assessed = await handle.withContext(reviewer, async (tx) => (await tx.select({ status: schema.techUpdates.status }).from(schema.techUpdates).where(sql`id = ${update!.id}`))[0]!);
    expect(assessed.status).toBe("assessed");
    await expectDbError(handle.withContext(tiAgent, (tx) => decideUpdate(tx, tiAgent, { updateId: update!.id, decision: "approved", note: "x" })), /requires agency_reviewer/);
    await expectDbError(handle.withContext(consultant, (tx) => decideUpdate(tx, consultant, { updateId: update!.id, decision: "approved", note: "x" })), /requires agency_reviewer/);
    await handle.withContext(reviewer, (tx) => decideUpdate(tx, reviewer, { updateId: update!.id, decision: "approved", note: "evaluation cases pass on the new version" }));
    // Applying needs a test result; a skill update moves the stable channel; pinned instances untouched.
    await expectDbError(handle.withContext(reviewer, (tx) => tx.update(schema.techUpdates).set({ status: "applied" }).where(sql`id = ${update!.id}`)), /recorded test result/);
    const applied = await handle.withContext(reviewer, (tx) => applyUpdate(tx, reviewer, { updateId: update!.id, testResult: "pnpm test green, demo flow 11/11 on staging" }));
    expect(applied.channelMoved).toBe(true);
    const op = operatorContext({ actorType: "user", actorId: "op", roles: ["agency_operator"] });
    const pinned = await handle.withContext(op, (tx) => pinnedInstanceCount(tx, op, newVersion!.id));
    expect(pinned.onThisVersion).toBe(0);
    expect(pinned.onOtherVersions).toBeGreaterThan(0);
    const [channelAfter] = await handle.withContext(admin, (tx) => tx.select({ skillVersionId: schema.skillReleaseChannels.skillVersionId }).from(schema.skillReleaseChannels).where(sql`skill_id = ${skill!.id} and channel = 'stable'`));
    expect(channelAfter!.skillVersionId).toBe(newVersion!.id);
    const instances = await handle.withContext(operatorContext({ actorType: "user", actorId: "op", roles: ["agency_operator"] }), (tx) => tx.select({ v: schema.agentInstances.skillVersionId }).from(schema.agentInstances).where(sql`skill_version_id = ${stable!.skillVersionId}`));
    expect(instances.length).toBeGreaterThan(0);
    const rb = await handle.withContext(reviewer, (tx) => rollbackUpdate(tx, reviewer, { updateId: update!.id, note: "regression in the exception report" }));
    expect(rb.channelRestored).toBe(true);
    const [channelBack] = await handle.withContext(admin, (tx) => tx.select({ skillVersionId: schema.skillReleaseChannels.skillVersionId }).from(schema.skillReleaseChannels).where(sql`skill_id = ${skill!.id} and channel = 'stable'`));
    expect(channelBack!.skillVersionId).toBe(stable!.skillVersionId);
    const transitions = await handle.withContext(reviewer, (tx) => tx.select({ to: schema.techUpdateTransitions.toStatus, actor: schema.techUpdateTransitions.actorId }).from(schema.techUpdateTransitions).where(sql`update_id = ${update!.id}`).orderBy(schema.techUpdateTransitions.createdAt));
    expect(transitions.map((t) => t.to)).toEqual(["detected", "assessed", "approved", "applied", "rolled_back"]);
    expect(transitions[1]!.actor).toBe(tiAgent.actorId);
    expect(transitions[2]!.actor).toBe(reviewer.actorId);
    // Tenant scope never sees technology intelligence tables.
    const tenantView = await handle.withContext(tenantContext({ tenantId: tenantA, actorType: "user", actorId: "ceo-a", roles: ["client_admin"] }), (tx) => tx.select({ id: schema.techUpdates.id }).from(schema.techUpdates));
    expect(tenantView).toHaveLength(0);
  });

  it("a code update is approved only with a pull request; a knowledge update applies only when the record is published", async () => {
    const sourceId = await handle.withContext(admin, (tx) => registerTechSource(tx, admin, { key: `nextjs-${uniq}`, name: "Next.js releases", kind: "github_releases", fetchKind: "github_releases", url: "https://github.com/vercel/next.js/releases" }));
    await handle.withContext(admin, (tx) => setTechSourceApproval(tx, admin, { sourceId, approved: true, note: "pinned framework" }));
    await handle.withContext(system, (tx) => recordDetectedUpdates(tx, system, { sourceId, items: [{ externalId: "release:v16.1.0", subject: "Next.js", proposedVersion: "16.1.0", sourceUrl: "https://github.com/vercel/next.js/releases/tag/v16.1.0", publishedAt: new Date("2026-11-02T00:00:00Z") }], mode: "live", status: "succeeded" }));
    const [u] = await handle.withContext(admin, (tx) => tx.select({ id: schema.techUpdates.id }).from(schema.techUpdates).where(sql`source_id = ${sourceId}`));
    const base = { updateId: u!.id, securityRisk: "medium" as const, potentialBenefit: "Security fix in the image optimiser.", compatibilityNotes: "Minor; proxy.ts unchanged.", migrationPlan: "Bump in a pull request, CI must pass, deploy to staging first.", rollbackPlan: "Revert the pull request." };
    await handle.withContext(admin, (tx) => assessUpdate(tx, admin, { ...base, kind: "code_update" }));
    await expectDbError(handle.withContext(admin, (tx) => decideUpdate(tx, admin, { updateId: u!.id, decision: "approved", note: "x" })), /only with a pull request/);
    await handle.withContext(admin, (tx) => tx.update(schema.techUpdates).set({ pullRequestUrl: "https://github.com/Linkdbyroyal/form/pull/1" }).where(sql`id = ${u!.id}`));
    await handle.withContext(admin, (tx) => decideUpdate(tx, admin, { updateId: u!.id, decision: "approved", note: "PR reviewed" }));
    const applied = await handle.withContext(admin, (tx) => applyUpdate(tx, admin, { updateId: u!.id, testResult: "CI green on the pull request, merged by a human" }));
    expect(applied.channelMoved).toBe(false);
  });
});

describe("retention and deletion requests", () => {
  it("effective policy merges defaults and tenant overrides with floors; the sweep deletes only old rows in agency scope", async () => {
    const ceo = tenantContext({ tenantId: tenantA, actorType: "user", actorId: "ceo-a", roles: ["client_admin"] });
    const before = await handle.withContext(ceo, (tx) => effectiveRetention(tx, ceo, tenantA));
    expect(before.run_events.source).toBe("default");
    expect(before.run_events.days).toBe(180);
    await expectDbError(handle.withContext(ceo, (tx) => setRetentionPolicy(tx, ceo, { tenantId: tenantA, dataClass: "knowledge_access_logs", retentionDays: 30, reason: "too short" })), /at least 365/);
    await handle.withContext(ceo, (tx) => setRetentionPolicy(tx, ceo, { tenantId: tenantA, dataClass: "run_events", retentionDays: 60, reason: "pilot: short trace retention" }));
    const after = await handle.withContext(ceo, (tx) => effectiveRetention(tx, ceo, tenantA));
    expect(after.run_events).toMatchObject({ days: 60, source: "tenant" });
    // Tenant B keeps the default.
    const ceoB = tenantContext({ tenantId: tenantB, actorType: "user", actorId: "ceo-b", roles: ["client_admin"] });
    const b = await handle.withContext(ceoB, (tx) => effectiveRetention(tx, ceoB, tenantB));
    expect(b.run_events.source).toBe("default");
    // Old and fresh run events in tenant A.
    const [inst] = await handle.withContext(ceo, (tx) => tx.select({ id: schema.agentInstances.id }).from(schema.agentInstances).limit(1));
    const [run] = await handle.withContext(ceo, (tx) => tx.insert(schema.agentRuns).values({ tenantId: tenantA, agentInstanceId: inst!.id, trigger: "command", state: "queued" }).returning({ id: schema.agentRuns.id }));
    await handle.withContext(ceo, (tx) => tx.insert(schema.runEvents).values([
      { tenantId: tenantA, runId: run!.id, seq: 1, kind: "note", summary: "old", payload: {}, classification: "internal", occurredAt: new Date(Date.now() - 100 * 86_400_000) },
      { tenantId: tenantA, runId: run!.id, seq: 2, kind: "note", summary: "fresh", payload: {}, classification: "internal" }
    ]));
    // A tenant context cannot delete: the restrictive policy hides every row from DELETE (zero rows affected, nothing gone).
    const tenantDelete = await handle.withContext(ceo, (tx) => tx.delete(schema.runEvents).where(sql`run_id = ${run!.id}`).returning({ id: schema.runEvents.id }));
    expect(tenantDelete).toHaveLength(0);
    const stillThere = await handle.withContext(ceo, (tx) => tx.select({ id: schema.runEvents.id }).from(schema.runEvents).where(sql`run_id = ${run!.id}`));
    expect(stillThere).toHaveLength(2);
    const sweeper = agencyContext({ tenantId: tenantA, actorType: "system", actorId: "worker:retention", roles: ["system"] });
    const counts = await handle.withContext(sweeper, (tx) => sweepRetention(tx, sweeper, { tenantId: tenantA }));
    expect(counts.run_events).toBe(1);
    const left = await handle.withContext(ceo, (tx) => tx.select({ summary: schema.runEvents.summary }).from(schema.runEvents).where(sql`run_id = ${run!.id}`));
    expect(left.map((r) => r.summary)).toEqual(["fresh"]);
    const sweeps = await handle.withContext(ceo, (tx) => tx.select().from(schema.retentionSweeps).where(sql`tenant_id = ${tenantA}`));
    expect(sweeps.some((s) => s.dataClass === "run_events" && s.deletedCount === 1)).toBe(true);
    // Audit events are never swept.
    const audit = await handle.withContext(ceo, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from audit_events where action = 'retention.swept' and tenant_id = ${tenantA}`).then((r) => r.rows));
    expect(audit[0]!.n).toBeGreaterThan(0);
  });

  it("a deletion request is decided by an agency reviewer and executed by the platform; audit stays; manual kinds need a written summary", async () => {
    const ceo = tenantContext({ tenantId: tenantA, actorType: "user", actorId: "ceo-a", roles: ["client_admin"] });
    const path = `19_history_and_archive/to-delete-${uniq}.md`;
    await handle.withContext(ceo, (tx) => writeVaultDocument(tx, ceo, { tenantId: tenantA, path, title: "To delete", frontmatter: {}, bodyMarkdown: "Contains a former employee's details. See [[00_company_profile/profile]]." }));
    const requestId = await handle.withContext(ceo, (tx) => requestDeletion(tx, ceo, { tenantId: tenantA, kind: "document", subjectRef: path, reason: "former employee asked for erasure (GDPR article 17)" }));
    const agent = tenantContext({ tenantId: tenantA, actorType: "agent", actorId: "agent:x:northline", roles: ["agent_service"] });
    await expectDbError(handle.withContext(agent, (tx) => requestDeletion(tx, agent, { tenantId: tenantA, kind: "document", subjectRef: path, reason: "agent tries to delete things" })), /agents cannot/);
    // The client admin cannot approve; execution before approval is refused; a reviewer approves in agency scope pinned to the tenant.
    await expectDbError(handle.withContext(ceo, (tx) => tx.update(schema.deletionRequests).set({ state: "approved" }).where(sql`id = ${requestId}`)), /agency reviewer or superadmin/);
    const executor = agencyContext({ tenantId: tenantA, actorType: "system", actorId: "worker:retention", roles: ["system"] });
    await expectDbError(handle.withContext(executor, (tx) => executeDeletionRequest(tx, executor, { tenantId: tenantA, requestId })), /only approved requests/);
    const rev = agencyContext({ tenantId: tenantA, actorType: "user", actorId: "gov-reviewer", roles: ["agency_reviewer"] });
    await handle.withContext(rev, (tx) => decideDeletion(tx, rev, { tenantId: tenantA, requestId, decision: "approved", note: "erasure obligation confirmed; no legal hold" }));
    const summary = await handle.withContext(executor, (tx) => executeDeletionRequest(tx, executor, { tenantId: tenantA, requestId }));
    expect(summary.vault_documents).toBe(1);
    expect(summary.vault_revisions).toBe(1);
    const gone = await handle.withContext(ceo, (tx) => tx.select({ id: schema.vaultDocuments.id }).from(schema.vaultDocuments).where(sql`path = ${path}`));
    expect(gone).toHaveLength(0);
    const [req] = await handle.withContext(ceo, (tx) => tx.select({ state: schema.deletionRequests.state, executedAt: schema.deletionRequests.executedAt }).from(schema.deletionRequests).where(sql`id = ${requestId}`));
    expect(req!.state).toBe("completed");
    expect(req!.executedAt).not.toBeNull();
    const audit = await handle.withContext(ceo, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from audit_events where entity_id = ${requestId} and action = 'deletion_request.executed'`).then((r) => r.rows));
    expect(audit[0]!.n).toBe(1);
    // Tenant B cannot see the request; manual kinds are completed with a summary by a superadmin only.
    const ceoB = tenantContext({ tenantId: tenantB, actorType: "user", actorId: "ceo-b", roles: ["client_admin"] });
    const leak = await handle.withContext(ceoB, (tx) => tx.select({ id: schema.deletionRequests.id }).from(schema.deletionRequests));
    expect(leak).toHaveLength(0);
    const subjectReq = await handle.withContext(ceo, (tx) => requestDeletion(tx, ceo, { tenantId: tenantA, kind: "subject_data", subjectRef: "former employee J.", reason: "erasure request received by mail" }));
    await handle.withContext(rev, (tx) => decideDeletion(tx, rev, { tenantId: tenantA, requestId: subjectReq, decision: "approved", note: "runbook: search answers, facts and documents" }));
    await expectDbError(handle.withContext(executor, (tx) => executeDeletionRequest(tx, executor, { tenantId: tenantA, requestId: subjectReq })), /not automated/);
    const sa = agencyContext({ tenantId: tenantA, actorType: "user", actorId: "gov-superadmin", roles: ["superadmin"] });
    await handle.withContext(sa, (tx) => completeDeletionManually(tx, sa, { tenantId: tenantA, requestId: subjectReq, summary: "Searched answers, facts and documents for the subject; two facts corrected, no documents found." }));
    const [done] = await handle.withContext(ceo, (tx) => tx.select({ state: schema.deletionRequests.state, summary: schema.deletionRequests.summary }).from(schema.deletionRequests).where(sql`id = ${subjectReq}`));
    expect(done!.state).toBe("completed");
    expect((done!.summary as { manual: boolean }).manual).toBe(true);
  });
});
