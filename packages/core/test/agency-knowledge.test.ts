import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agencyContext, createDb, runMigrations, schema, tenantContext, type DbHandle } from "@sbos/db";
import { seed } from "@sbos/db/seed";
import {
  addKnowledgeVersion,
  adoptTemplate,
  createKnowledgeRecord,
  createMethodologyTemplate,
  deprecateKnowledgeRecord,
  nominateReusableInsight,
  publishPromotion,
  renderTemplate,
  reviewPromotion,
  rollbackAdoption,
  searchAgencyVault,
  setCurrentVersion,
  transitionKnowledgeRecord,
  writeVaultDocument
} from "../src/index";

/**
 * Spec 4H MVP acceptance criteria 1 to 6 for the Agency Intelligence Vault, exercised against Postgres with RLS.
 */
const url = process.env.DATABASE_URL_TEST ?? "postgres://sbos:sbos@localhost:5432/sbos_test";
let handle: DbHandle;
let tenantA: string;
let tenantB: string;

const author = { actorType: "user" as const, actorId: "agency-author", roles: ["agency_consultant"] };
const reviewer = { actorType: "user" as const, actorId: "agency-reviewer", roles: ["agency_reviewer"] };
const admin = { actorType: "user" as const, actorId: "agency-superadmin", roles: ["superadmin"] };
const agentA = { actorType: "agent" as const, actorId: "agent:process-redesign:northline", roles: ["agent_service"] };
const ceoA = { actorType: "user" as const, actorId: "ceo-a", roles: ["client_admin"] };
const ceoB = { actorType: "user" as const, actorId: "ceo-b", roles: ["client_admin"] };
const uniq = Date.now().toString(36);

async function expectDbError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown = null;
  try { await promise; } catch (err) { caught = err; }
  expect(caught, "expected failure").not.toBeNull();
  const e = caught as { message?: string; cause?: { message?: string } };
  expect(`${e.message ?? ""} :: ${e.cause?.message ?? ""}`).toMatch(pattern);
}

const agency = (actor: typeof author) => agencyContext({ tenantId: null, ...actor });
const agencyFor = (tenantId: string, actor: typeof author) => agencyContext({ tenantId, ...actor });

beforeAll(async () => {
  await runMigrations(url);
  handle = createDb({ connectionString: url, max: 4 });
  const seeded = await seed(handle);
  tenantA = seeded.tenantIds["northline-events"]!;
  tenantB = seeded.tenantIds["harbour-view-hotel"]!;
});
afterAll(async () => handle.close());

const TEMPLATE_BODY = `# Project closure to invoice readiness check

Trigger: a project in {{project_system}} reaches the state "{{closure_state}}".

1. All returns registered in {{project_system}}.
2. Automatic closure check: returns, extra costs, damages.
3. Exceptions routed to {{finance_owner}} for review.
4. Invoice lines prepared from the project record in {{accounting_system}}.
5. Invoice reviewed and sent within {{invoice_days}} working days.`;

describe("Agency Intelligence Vault (spec 4H)", () => {
  it("1. admin creates, reviews, publishes a method template and makes one version available to two tenants with their own values", async () => {
    const path = `06_process_patterns_and_sops/project-closure-invoice-readiness-${uniq}.md`;
    const { recordId, versionId } = await handle.withContext(agency(author), (tx) => createKnowledgeRecord(tx, agency(author), { path, title: "Project closure to invoice readiness check", kind: "method_template", bodyMarkdown: TEMPLATE_BODY, changelog: "first draft", license: "Second Brain internal", allowedUses: ["client_delivery"], relatedSkillKeys: ["process-redesign"] }));

    // Not adoptable while draft, and the author cannot approve their own record.
    await handle.withContext(agency(author), (tx) => transitionKnowledgeRecord(tx, agency(author), { recordId, to: "in_review" }));
    await expectDbError(handle.withContext(agency(author), (tx) => transitionKnowledgeRecord(tx, agency(author), { recordId, to: "approved" })), /requires the agency_reviewer|cannot approve their own/);
    const reviewerAsAuthor = agencyContext({ tenantId: null, actorType: "user", actorId: author.actorId, roles: ["agency_reviewer"] });
    await expectDbError(handle.withContext(reviewerAsAuthor, (tx) => transitionKnowledgeRecord(tx, reviewerAsAuthor, { recordId, to: "approved" })), /cannot approve their own/);
    await expectDbError(handle.withContext(agency(reviewer), (tx) => transitionKnowledgeRecord(tx, agency(reviewer), { recordId, to: "published" })), /not allowed/);

    await handle.withContext(agency(reviewer), (tx) => transitionKnowledgeRecord(tx, agency(reviewer), { recordId, to: "approved", note: "method reviewed against the methodology handbook" }));
    await handle.withContext(agency(reviewer), (tx) => transitionKnowledgeRecord(tx, agency(reviewer), { recordId, to: "published" }));
    const transitions = await handle.withContext(agency(reviewer), (tx) => tx.select().from(schema.agencyKnowledgeTransitions).where(sql`record_id = ${recordId}`).orderBy(schema.agencyKnowledgeTransitions.createdAt));
    expect(transitions.map((t) => `${t.fromState ?? "new"}>${t.toState}`)).toEqual(["new>draft", "draft>in_review", "in_review>approved", "approved>published"]);
    expect(transitions[2]!.actorId).toBe(reviewer.actorId);
    expect(transitions[2]!.note).toContain("methodology handbook");

    const templateKey = `project-closure-invoice-readiness-${uniq}`;
    await handle.withContext(agency(admin), (tx) => createMethodologyTemplate(tx, agency(admin), { key: templateKey, recordId, name: "Project closure to invoice readiness check", description: "Closure check before invoicing", targetFolder: "05_processes_to_be", parameters: [
      { key: "project_system", label: "Project system", required: true },
      { key: "closure_state", label: "Closure state", required: true },
      { key: "finance_owner", label: "Finance owner", required: true, default: "finance" },
      { key: "accounting_system", label: "Accounting system", required: true },
      { key: "invoice_days", label: "Invoice within (working days)", required: false, default: "2" }
    ] }));

    // Tenant A: event rental values. Tenant B: a second simulated industry (hotel) with its own systems (acceptance 3).
    const a = await handle.withContext(agencyFor(tenantA, admin), (tx) => adoptTemplate(tx, agencyFor(tenantA, admin), { tenantId: tenantA, templateKey, parameters: { project_system: "Rentman", closure_state: "returned", finance_owner: "finance", accounting_system: "QuickBooks Online" } }));
    const b = await handle.withContext(agencyFor(tenantB, admin), (tx) => adoptTemplate(tx, agencyFor(tenantB, admin), { tenantId: tenantB, templateKey, parameters: { project_system: "Mews PMS", closure_state: "checked out", finance_owner: "hotel controller", accounting_system: "Exact Online", invoice_days: "1" } }));
    expect(a.version).toBe(1);
    expect(b.version).toBe(1);
    expect(a.path).toBe(`05_processes_to_be/${templateKey}.md`);

    const docA = await handle.withContext(tenantContext({ tenantId: tenantA, ...ceoA }), async (tx) => (await tx.select().from(schema.vaultDocuments).where(sql`id = ${a.documentId}`))[0]!);
    const docB = await handle.withContext(tenantContext({ tenantId: tenantB, ...ceoB }), async (tx) => (await tx.select().from(schema.vaultDocuments).where(sql`id = ${b.documentId}`))[0]!);
    expect(docA.bodyMarkdown).toContain("Rentman");
    expect(docA.bodyMarkdown).toContain("QuickBooks Online");
    expect(docA.bodyMarkdown).not.toContain("{{");
    expect(docB.bodyMarkdown).toContain("Mews PMS");
    expect(docB.bodyMarkdown).toContain("within 1 working days");
    expect(docB.bodyMarkdown).not.toContain("Rentman");
    expect((docA.frontmatter as Record<string, unknown>).sbos_template_version).toBe(1);
    // A client admin cannot read the other tenant's copy.
    const crossRead = await handle.withContext(tenantContext({ tenantId: tenantB, ...ceoB }), (tx) => tx.select({ id: schema.vaultDocuments.id }).from(schema.vaultDocuments).where(sql`id = ${a.documentId}`));
    expect(crossRead).toHaveLength(0);

    // Missing required parameter is refused before anything is written.
    await expectDbError(handle.withContext(agencyFor(tenantB, admin), (tx) => adoptTemplate(tx, agencyFor(tenantB, admin), { tenantId: tenantB, templateKey, parameters: { project_system: "x", closure_state: "y" } })), /accounting_system.*required/);
    expect(renderTemplate("a {{x}} b", [{ key: "x", label: "X", required: true }], { x: "1" })).toBe("a 1 b");
    expect(() => renderTemplate("a {{y}} b", [{ key: "x", label: "X", required: false }], {})).toThrow(/not declared/);

    // Store for the later tests.
    shared.recordId = recordId;
    shared.versionId = versionId;
    shared.templateKey = templateKey;
    shared.adoptionA = a.adoptionId;
    shared.adoptionB = b.adoptionId;
    shared.docA = a.documentId;
  });

  it("5. a published method can be replaced, rolled back and deprecated without changing running client adoptions", async () => {
    const { recordId, templateKey } = shared;
    // A new version of a published record is stored but not released.
    const v2 = await handle.withContext(agency(author), (tx) => addKnowledgeVersion(tx, agency(author), { recordId, bodyMarkdown: `${TEMPLATE_BODY}\n\n6. Weekly exception report to {{finance_owner}}.`, changelog: "added weekly exception report" }));
    expect(v2.version).toBe(2);
    expect(v2.current).toBe(false);
    const recBefore = await handle.withContext(agency(author), async (tx) => (await tx.select().from(schema.agencyKnowledgeRecords).where(sql`id = ${recordId}`))[0]!);
    expect(recBefore.currentVersionId).toBe(shared.versionId);
    // Versions are immutable.
    await expectDbError(handle.withContext(agency(admin), (tx) => tx.update(schema.agencyKnowledgeVersions).set({ changelog: "edited" }).where(sql`id = ${v2.versionId}`)), /immutable/);

    // Consultants cannot release; a reviewer can. Both adoptions stay on v1.
    await expectDbError(handle.withContext(agency(author), (tx) => setCurrentVersion(tx, agency(author), { recordId, versionId: v2.versionId, reason: "x" })), /requires agency_reviewer/);
    const release = await handle.withContext(agency(reviewer), (tx) => setCurrentVersion(tx, agency(reviewer), { recordId, versionId: v2.versionId, reason: "evaluation cases pass; release v2" }));
    expect(release.kind).toBe("release");
    expect(release.affectedAdoptions).toBe(2);
    const adoptionsAfterRelease = await handle.withContext(tenantContext({ tenantId: tenantA, ...ceoA }), (tx) => tx.select().from(schema.templateAdoptions).where(sql`tenant_id = ${tenantA}`));
    expect(adoptionsAfterRelease.filter((x) => x.state === "active").map((x) => x.version)).toEqual([1]);

    // Tenant A moves to v2 explicitly; tenant B stays on v1.
    const a2 = await handle.withContext(agencyFor(tenantA, admin), (tx) => adoptTemplate(tx, agencyFor(tenantA, admin), { tenantId: tenantA, templateKey, parameters: { project_system: "Rentman", closure_state: "returned", finance_owner: "finance", accounting_system: "QuickBooks Online" }, note: "upgrade to v2" }));
    expect(a2.version).toBe(2);
    expect(a2.documentId).toBe(shared.docA);
    const docA2 = await handle.withContext(tenantContext({ tenantId: tenantA, ...ceoA }), async (tx) => (await tx.select().from(schema.vaultDocuments).where(sql`id = ${shared.docA}`))[0]!);
    expect(docA2.version).toBe(2);
    expect(docA2.bodyMarkdown).toContain("Weekly exception report");
    const stateA = await handle.withContext(tenantContext({ tenantId: tenantA, ...ceoA }), (tx) => tx.select({ state: schema.templateAdoptions.state, version: schema.templateAdoptions.version }).from(schema.templateAdoptions).where(sql`tenant_id = ${tenantA}`).orderBy(schema.templateAdoptions.adoptedAt));
    expect(stateA).toEqual([{ state: "superseded", version: 1 }, { state: "active", version: 2 }]);
    // The pinned version of an adoption cannot be edited in place.
    await expectDbError(handle.withContext(agencyFor(tenantA, admin), (tx) => tx.update(schema.templateAdoptions).set({ recordVersionId: shared.versionId }).where(sql`id = ${a2.adoptionId}`)), /pins its version/);

    // Rollback tenant A to v1: the client document returns to the v1 text as a new revision.
    const rb = await handle.withContext(agencyFor(tenantA, admin), (tx) => rollbackAdoption(tx, agencyFor(tenantA, admin), { tenantId: tenantA, adoptionId: a2.adoptionId, reason: "finance team not ready for the weekly report" }));
    expect(rb.version).toBe(1);
    const docA3 = await handle.withContext(tenantContext({ tenantId: tenantA, ...ceoA }), async (tx) => (await tx.select().from(schema.vaultDocuments).where(sql`id = ${shared.docA}`))[0]!);
    expect(docA3.version).toBe(3);
    expect(docA3.bodyMarkdown).not.toContain("Weekly exception report");
    expect(docA3.bodyMarkdown).toContain("Rentman");

    // Rolling the record itself back to v1 is a logged rollback; deprecating it leaves both adoptions active.
    const back = await handle.withContext(agency(reviewer), (tx) => setCurrentVersion(tx, agency(reviewer), { recordId, versionId: shared.versionId, reason: "v2 withdrawn pending evaluation" }));
    expect(back.kind).toBe("rollback");
    const dep = await handle.withContext(agency(reviewer), (tx) => deprecateKnowledgeRecord(tx, agency(reviewer), { recordId, reason: "superseded by the closure checklist v3 programme" }));
    expect(dep.affectedAdoptions).toBe(2);
    const activeB = await handle.withContext(tenantContext({ tenantId: tenantB, ...ceoB }), (tx) => tx.select({ state: schema.templateAdoptions.state, version: schema.templateAdoptions.version }).from(schema.templateAdoptions).where(sql`tenant_id = ${tenantB}`));
    expect(activeB).toEqual([{ state: "active", version: 1 }]);
    // A deprecated record cannot be adopted anew; reinstating it can.
    await expectDbError(handle.withContext(agencyFor(tenantB, admin), (tx) => adoptTemplate(tx, agencyFor(tenantB, admin), { tenantId: tenantB, templateKey, parameters: { project_system: "a", closure_state: "b", accounting_system: "c" } })), /deprecated/);
    await handle.withContext(agency(reviewer), (tx) => deprecateKnowledgeRecord(tx, agency(reviewer), { recordId, reason: "reinstated after review", kind: "reinstate" }));
    const events = await handle.withContext(agency(reviewer), (tx) => tx.select({ kind: schema.knowledgeDeprecationEvents.kind }).from(schema.knowledgeDeprecationEvents).where(sql`record_id = ${recordId}`).orderBy(schema.knowledgeDeprecationEvents.createdAt));
    expect(events.map((e) => e.kind)).toEqual(["release", "rollback", "deprecate", "reinstate"]);
  });

  it("2. an agent nominates a reusable insight from a client scenario; nothing is published without a reviewer and a rights check", async () => {
    const ctxAgent = tenantContext({ tenantId: tenantA, ...agentA });
    // Nothing but `nominated` is accepted at insert time, even from a reviewer.
    await expectDbError(handle.withContext(agency(reviewer), (tx) => tx.insert(schema.knowledgePromotionRequests).values({ tenantId: tenantA, nominatedByActorType: "user", nominatedByActorId: "x", title: "t", proposedGenericStatement: "s", rationale: "r", state: "approved" })), /starts as nominated/);
    const requestId = await handle.withContext(ctxAgent, (tx) => nominateReusableInsight(tx, ctxAgent, { tenantId: tenantA, title: "Closure gate before invoicing", proposedGenericStatement: "Companies that invoice from a project system benefit from an explicit closure check (returns, extra costs, damages) before invoice preparation.", rationale: "Observed as an open finding with a client statement; the pattern is industry-neutral.", identifiabilityRisk: "low", sourceRefs: { finding_count: 1 }, consentStatus: "pending" }));
    // The agent cannot move it anywhere.
    await expectDbError(handle.withContext(ctxAgent, (tx) => tx.update(schema.knowledgePromotionRequests).set({ state: "approved" }).where(sql`id = ${requestId}`)), /agents cannot change/);
    // A client admin of the source tenant sees it; tenant B does not; a reviewer in agency scope does.
    const seenA = await handle.withContext(tenantContext({ tenantId: tenantA, ...ceoA }), (tx) => tx.select({ id: schema.knowledgePromotionRequests.id }).from(schema.knowledgePromotionRequests).where(sql`id = ${requestId}`));
    const seenB = await handle.withContext(tenantContext({ tenantId: tenantB, ...ceoB }), (tx) => tx.select({ id: schema.knowledgePromotionRequests.id }).from(schema.knowledgePromotionRequests).where(sql`id = ${requestId}`));
    const seenR = await handle.withContext(agency(reviewer), (tx) => tx.select({ id: schema.knowledgePromotionRequests.id }).from(schema.knowledgePromotionRequests).where(sql`id = ${requestId}`));
    const seenC = await handle.withContext(agency(author), (tx) => tx.select({ id: schema.knowledgePromotionRequests.id }).from(schema.knowledgePromotionRequests).where(sql`id = ${requestId}`));
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(0);
    expect(seenR).toHaveLength(1);
    expect(seenC).toHaveLength(0);

    // Publishing before approval is refused; approval without a rights check is refused by the trigger.
    await expectDbError(handle.withContext(agency(reviewer), (tx) => publishPromotion(tx, agency(reviewer), { requestId, path: `15_approved_reusable_insights/closure-gate-${uniq}.md` })), /only approved requests/);
    await expectDbError(handle.withContext(agency(reviewer), (tx) => reviewPromotion(tx, agency(reviewer), { requestId, decision: "approve", rightsCheck: false, securityCheck: true, identifiabilityCheck: true, note: "rights not checked yet" })), /rights, security and identifiability checks/);
    // Consent must be recorded.
    await expectDbError(handle.withContext(agency(reviewer), (tx) => reviewPromotion(tx, agency(reviewer), { requestId, decision: "approve", rightsCheck: true, securityCheck: true, identifiabilityCheck: true, note: "all checks pass" })), /consent_status granted or not_required/);
    const state = await handle.withContext(agency(reviewer), (tx) => reviewPromotion(tx, agency(reviewer), { requestId, decision: "approve", rightsCheck: true, securityCheck: true, identifiabilityCheck: true, note: "generic pattern, no names or amounts; consultancy agreement clause 7 allows abstracted method reuse", consentStatus: "granted", rightsBasis: "consultancy agreement clause 7" }));
    expect(state).toBe("approved");

    const published = await handle.withContext(agency(reviewer), (tx) => publishPromotion(tx, agency(reviewer), { requestId, path: `15_approved_reusable_insights/closure-gate-${uniq}.md`, kind: "process_pattern" }));
    const rec = await handle.withContext(agency(reviewer), async (tx) => (await tx.select().from(schema.agencyKnowledgeRecords).where(sql`id = ${published.recordId}`))[0]!);
    const ver = await handle.withContext(agency(reviewer), async (tx) => (await tx.select().from(schema.agencyKnowledgeVersions).where(sql`id = ${published.versionId}`))[0]!);
    expect(rec.state).toBe("published");
    expect(rec.origin).toBe("abstracted_from_client");
    // No back-reference to the source tenant or its records in the published knowledge.
    const serialised = JSON.stringify({ rec: { ...rec, promotionRequestId: null }, ver });
    expect(serialised).not.toContain(tenantA);
    expect(serialised).not.toContain("northline");
    expect(serialised).not.toContain("finding_count");
    const req = await handle.withContext(agency(reviewer), async (tx) => (await tx.select().from(schema.knowledgePromotionRequests).where(sql`id = ${requestId}`))[0]!);
    expect(req.state).toBe("published");
    expect(req.publishedRecordId).toBe(published.recordId);
    expect(req.reviewerActorId).toBe(reviewer.actorId);
    // A record born from a promotion cannot be created with origin abstracted_from_client without the request.
    await expectDbError(handle.withContext(agency(reviewer), (tx) => createKnowledgeRecord(tx, agency(reviewer), { path: `15_approved_reusable_insights/orphan-${uniq}.md`, title: "x", bodyMarkdown: "y", origin: "abstracted_from_client" })), /needs its promotion request/);
  });

  it("4. rights and search tests: agency scope and agency search never return client documents, facts, embeddings or run traces; tenant scope never reads agency tables", async () => {
    const marker = `zebra-confidential-${uniq}`;
    await handle.withContext(tenantContext({ tenantId: tenantA, ...ceoA }), (tx) => writeVaultDocument(tx, tenantContext({ tenantId: tenantA, ...ceoA }), { tenantId: tenantA, path: `03_finance_and_cashflow/secret-${uniq}.md`, title: "Confidential finance note", frontmatter: {}, bodyMarkdown: `The ${marker} payment terms with the bank are confidential.`, classification: "restricted" }));
    const hits = await handle.withContext(agency(reviewer), (tx) => searchAgencyVault(tx, agency(reviewer), { query: marker }));
    expect(hits).toHaveLength(0);
    const own = await handle.withContext(agency(reviewer), (tx) => searchAgencyVault(tx, agency(reviewer), { query: "closure check invoice" }));
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((h) => h.path.startsWith("06_") || h.path.startsWith("15_"))).toBe(true);
    // Agency scope without a tenant sees no client rows in any tenant table (RLS), including documents, facts and run events.
    for (const table of ["vault_documents", "vault_facts", "run_events", "agent_runs", "answers"]) {
      const rows = await handle.withContext(agency(admin), (tx) => tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`).then((r) => r.rows));
      expect(rows[0]!.n, table).toBe(0);
    }
    // Tenant scope sees no agency knowledge at all, and cannot write any.
    for (const table of ["agency_knowledge_records", "agency_knowledge_versions", "methodology_templates", "agency_knowledge_transitions", "knowledge_deprecation_events"]) {
      const rows = await handle.withContext(tenantContext({ tenantId: tenantA, ...ceoA }), (tx) => tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`).then((r) => r.rows));
      expect(rows[0]!.n, table).toBe(0);
    }
    await expectDbError(handle.withContext(tenantContext({ tenantId: tenantA, ...ceoA }), (tx) => createKnowledgeRecord(tx, tenantContext({ tenantId: tenantA, ...ceoA }), { path: `00_second_brain_strategy/x-${uniq}.md`, title: "x", bodyMarkdown: "y" })), /agency scope only/);
    await expectDbError(handle.withContext(tenantContext({ tenantId: tenantA, ...ceoA }), (tx) => tx.insert(schema.agencyKnowledgeRecords).values({ folder: "00_second_brain_strategy", path: `00_second_brain_strategy/rls-${uniq}.md`, title: "x", ownerActorId: "x", createdByActorType: "user", createdByActorId: "x" })), /row-level security|permission denied/);
    // A tenant sees reviews of its own promotion requests only; tenant B sees none.
    const reviewsA = await handle.withContext(tenantContext({ tenantId: tenantA, ...ceoA }), (tx) => tx.select({ id: schema.knowledgePromotionReviews.id }).from(schema.knowledgePromotionReviews));
    const reviewsB = await handle.withContext(tenantContext({ tenantId: tenantB, ...ceoB }), (tx) => tx.select({ id: schema.knowledgePromotionReviews.id }).from(schema.knowledgePromotionReviews));
    expect(reviewsA.length).toBeGreaterThan(0);
    expect(reviewsB).toHaveLength(0);
    // The agent that nominated cannot read agency knowledge either (tenant scope).
    const agentRows = await handle.withContext(tenantContext({ tenantId: tenantA, ...agentA }), (tx) => tx.select({ id: schema.agencyKnowledgeRecords.id }).from(schema.agencyKnowledgeRecords));
    expect(agentRows).toHaveLength(0);
  });

  it("6. the operator view lists installed template versions per tenant without parameters or content", async () => {
    const op = { kind: "operator" as const, actorType: "user" as const, actorId: "op", roles: ["agency_operator"] };
    const rows = await handle.withContext(op, (tx) => tx.execute<{ tenant_id: string; key: string; version: number; state: string }>(sql`SELECT a.tenant_id, t.key, a.version, a.state::text FROM template_adoptions a JOIN methodology_templates t ON t.id = a.template_id WHERE t.key = ${shared.templateKey} ORDER BY a.adopted_at`).then((r) => r.rows));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(new Set(rows.map((r) => r.tenant_id))).toEqual(new Set([tenantA, tenantB]));
    for (const column of ["parameters"]) {
      await expectDbError(handle.withContext(op, (tx) => tx.execute(sql`SELECT ${sql.identifier(column)} FROM template_adoptions LIMIT 1`)), /permission denied/);
    }
    await expectDbError(handle.withContext(op, (tx) => tx.execute(sql`SELECT body_markdown FROM agency_knowledge_versions LIMIT 1`)), /permission denied/);
    await expectDbError(handle.withContext(op, (tx) => tx.execute(sql`SELECT proposed_generic_statement FROM knowledge_promotion_requests LIMIT 1`)), /permission denied/);
  });
});

const shared: { recordId: string; versionId: string; templateKey: string; adoptionA: string; adoptionB: string; docA: string } = { recordId: "", versionId: "", templateKey: "", adoptionA: "", adoptionB: "", docA: "" };
