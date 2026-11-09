import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, tenantContext, runMigrations, schema, type DbHandle } from "@sbos/db";
import { seed } from "@sbos/db/seed";
import { answerQuestion, createFact, decideFactVerification, extractLinks, requestFactVerification, revertDocument, searchVault, setFactVerification, setTenantPolicy, agentWriteDocument, decideProposal, readFactsForAgent, backlinks, writeVaultDocument, syncDocumentLinks } from "../src/index";

const url = process.env.DATABASE_URL_TEST ?? "postgres://sbos:sbos@localhost:5432/sbos_test";
let handle: DbHandle;
let tenantA: string;
let tenantB: string;
const agentA = { actorType: "agent" as const, actorId: "agent:discovery:northline", roles: ["agent_service"] };
const manager = { actorType: "user" as const, actorId: "manager-a", roles: ["department_manager"] };
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
  const seeded = await seed(handle);
  tenantA = seeded.tenantIds["northline-events"]!;
  tenantB = seeded.tenantIds["harbour-view-hotel"]!;
});
afterAll(async () => handle.close());

describe("Vault MVP flow (spec 4G)", () => {
  it("answer -> provisional fact -> contradiction -> verification request -> reviewer promotes -> agent retrieves with source", async () => {
    const ctxAgent = tenantContext({ tenantId: tenantA, ...agentA });
    const ctxManager = tenantContext({ tenantId: tenantA, ...manager });
    const ctxCeo = tenantContext({ tenantId: tenantA, ...ceo });

    // An open discovery question (normally created by the agent run).
    const questionId = await handle.withContext(ctxAgent, async (tx) => {
      const [q] = await tx.insert(schema.questions).values({ tenantId: tenantA, department: "finance", recipientRole: "department_manager", questionText: "Is invoice data from Rentman transferred manually into QuickBooks?", reason: "r", evidenceGap: "g", priority: "high", answerType: "text", state: "open" }).returning({ id: schema.questions.id });
      return q!.id;
    });

    // Employee answers: stored as an unconfirmed fact with an interview source.
    const answered = await handle.withContext(ctxManager, (tx) => answerQuestion(tx, ctxManager, { tenantId: tenantA, questionId, value: "No, QuickBooks is not used anymore; everything is in Rentman.", role: "department_manager" }));
    const fact = await handle.withContext(ctxManager, async (tx) => (await tx.select().from(schema.vaultFacts).where(sql`id = ${answered.factId}`))[0]!);
    expect(fact.verification).toBe("unconfirmed");
    expect(fact.sourceIds).toEqual([answered.sourceId]);

    // The systems register says QuickBooks is used: the agent records that as an evidence-backed fact and flags the contradiction.
    const registerFactId = await handle.withContext(ctxAgent, (tx) =>
      createFact(tx, ctxAgent, { tenantId: tenantA, statement: "Systems register lists QuickBooks Online as accounting system (claim_status stated)", subjectType: "system", subjectKey: "QuickBooks Online", sourceIds: [answered.sourceId], originSystem: "agent", verification: "hypothesis", confidence: 0.4 })
    );
    // Agents may not promote facts.
    await expectDbError(handle.withContext(ctxAgent, (tx) => setFactVerification(tx, ctxAgent, { tenantId: tenantA, factId: registerFactId, verification: "verified" })), /reviewer role|agents cannot/);

    const requestId = await handle.withContext(ctxAgent, (tx) => requestFactVerification(tx, ctxAgent, { tenantId: tenantA, factId: answered.factId, conflictingFactIds: [registerFactId], reason: "Answer contradicts the systems register entry for QuickBooks Online." }));
    const flagged = await handle.withContext(ctxManager, async (tx) => (await tx.select().from(schema.vaultFacts).where(sql`id = ${answered.factId}`))[0]!);
    expect(flagged.verification).toBe("hypothesis");
    expect(flagged.contradicts).toEqual([registerFactId]);

    // A department manager is not a reviewer.
    await expectDbError(handle.withContext(ctxManager, (tx) => decideFactVerification(tx, ctxManager, { tenantId: tenantA, requestId, decision: "verified" })), /reviewer role/);
    // The client admin is.
    await handle.withContext(ctxCeo, (tx) => decideFactVerification(tx, ctxCeo, { tenantId: tenantA, requestId, decision: "verified", note: "Confirmed with finance: QuickBooks was retired in Q2." }));
    const verified = await handle.withContext(ctxCeo, async (tx) => (await tx.select().from(schema.vaultFacts).where(sql`id = ${answered.factId}`))[0]!);
    expect(verified.verification).toBe("verified");
    expect(verified.version).toBe(2);
    const revisions = await handle.withContext(ctxCeo, (tx) => tx.select().from(schema.vaultFactRevisions).where(sql`fact_id = ${answered.factId}`));
    expect(revisions.map((r) => r.verification)).toEqual(["unconfirmed", "verified"]);

    // Another agent later retrieves the verified fact with its source and the retrieval is audited.
    const ctxAgent2 = tenantContext({ tenantId: tenantA, actorType: "agent", actorId: "agent:finance:northline", roles: ["agent_service"] });
    const facts = await handle.withContext(ctxAgent2, (tx) => readFactsForAgent(tx, ctxAgent2, { tenantId: tenantA }));
    const hit = facts.find((f) => f.id === answered.factId);
    expect(hit?.verification).toBe("verified");
    expect(hit?.sourceIds).toEqual([answered.sourceId]);
    const audit = await handle.withContext(ctxAgent2, (tx) => tx.select().from(schema.retrievalAudit).where(sql`actor_id = 'agent:finance:northline'`));
    expect(audit.length).toBe(1);
    expect(audit[0]!.resultIds).toContain(answered.factId);

    // Tenant B sees none of it.
    const ctxB = tenantContext({ tenantId: tenantB, ...ceo });
    const leak = await handle.withContext(ctxB, (tx) => tx.select().from(schema.vaultFacts));
    expect(leak.find((f) => f.id === answered.factId)).toBeUndefined();
  });
});

describe("search, classification and revisions", () => {
  it("finds own documents, never another tenant's, and hides restricted documents from non-reviewers", async () => {
    const ctxCeoA = tenantContext({ tenantId: tenantA, ...ceo });
    const ctxManagerA = tenantContext({ tenantId: tenantA, ...manager });
    const ctxCeoB = tenantContext({ tenantId: tenantB, ...ceo });
    await handle.withContext(ctxCeoA, (tx) => writeVaultDocument(tx, ctxCeoA, { tenantId: tenantA, path: "04_processes_as_is/quote-to-cash.md", title: "Quote to cash", frontmatter: {}, bodyMarkdown: "Quotes are created in Rentman and invoices are exported weekly. See [[06_finance/invoicing]]." }));
    await handle.withContext(ctxCeoA, (tx) => writeVaultDocument(tx, ctxCeoA, { tenantId: tenantA, path: "17_policies_and_security/salary-bands.md", title: "Salary bands", frontmatter: {}, bodyMarkdown: "Restricted salary band table for invoices department.", classification: "restricted" }));
    await handle.withContext(ctxCeoB, (tx) => writeVaultDocument(tx, ctxCeoB, { tenantId: tenantB, path: "04_processes_as_is/check-in.md", title: "Check-in", frontmatter: {}, bodyMarkdown: "Invoices for group bookings are issued at check-out." }));

    const hitsA = await handle.withContext(ctxCeoA, (tx) => searchVault(tx, ctxCeoA, { tenantId: tenantA, query: "invoices" }));
    // Other suites share this database and may have written documents that also mention invoices; judge only the three documents written here.
    const ownPaths = ["04_processes_as_is/quote-to-cash.md", "17_policies_and_security/salary-bands.md", "04_processes_as_is/check-in.md"];
    expect(hitsA.map((h) => h.path).filter((p): p is string => !!p && ownPaths.includes(p)).sort()).toEqual(["04_processes_as_is/quote-to-cash.md", "17_policies_and_security/salary-bands.md"]);
    expect(hitsA.some((h) => h.path === "04_processes_as_is/check-in.md")).toBe(false);

    const hitsManager = await handle.withContext(ctxManagerA, (tx) => searchVault(tx, ctxManagerA, { tenantId: tenantA, query: "invoices" }));
    expect(hitsManager.some((h) => h.path === "17_policies_and_security/salary-bands.md")).toBe(false);
    expect(hitsManager.some((h) => h.path === "04_processes_as_is/quote-to-cash.md")).toBe(true);

    const hitsB = await handle.withContext(ctxCeoB, (tx) => searchVault(tx, ctxCeoB, { tenantId: tenantB, query: "invoices" }));
    expect(hitsB.map((h) => h.path).filter((p): p is string => !!p && ownPaths.includes(p))).toEqual(["04_processes_as_is/check-in.md"]);
    expect(hitsB.some((h) => h.path === "04_processes_as_is/quote-to-cash.md" || h.path === "17_policies_and_security/salary-bands.md")).toBe(false);
    // A search that targets another tenant than the request context is refused outright.
    await expect(handle.withContext(ctxCeoB, (tx) => searchVault(tx, ctxCeoB, { tenantId: tenantA, query: "invoices" }))).rejects.toThrow(/tenant context/);
    const audit = await handle.withContext(ctxCeoA, (tx) => tx.select().from(schema.retrievalAudit).where(sql`kind = 'fts'`));
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it("extracts links, resolves backlinks when the target appears, and reverts documents as new revisions", async () => {
    const ctx = tenantContext({ tenantId: tenantA, ...ceo });
    expect(extractLinks("See [[06_finance/invoicing]] and [[06_finance/dunning.md|dunning]] plus [spec](../04_processes_as_is/quote-to-cash.md).").map((l) => l.path)).toEqual(["06_finance/invoicing.md", "06_finance/dunning.md", "../04_processes_as_is/quote-to-cash.md"]);
    const q2c = await handle.withContext(ctx, async (tx) => (await tx.select({ id: schema.vaultDocuments.id }).from(schema.vaultDocuments).where(sql`path = '04_processes_as_is/quote-to-cash.md'`))[0]!);
    await handle.withContext(ctx, (tx) => syncDocumentLinks(tx, tenantA, q2c.id, "See [[06_finance/invoicing]]."));
    const target = await handle.withContext(ctx, (tx) => writeVaultDocument(tx, ctx, { tenantId: tenantA, path: "06_finance/invoicing.md", title: "Invoicing", frontmatter: {}, bodyMarkdown: "v1" }));
    await handle.withContext(ctx, (tx) => syncDocumentLinks(tx, tenantA, target.documentId, "v1"));
    const back = await handle.withContext(ctx, (tx) => backlinks(tx, tenantA, target.documentId));
    expect(back.map((b) => b.path)).toEqual(["04_processes_as_is/quote-to-cash.md"]);

    await handle.withContext(ctx, (tx) => writeVaultDocument(tx, ctx, { tenantId: tenantA, path: "06_finance/invoicing.md", title: "Invoicing", frontmatter: {}, bodyMarkdown: "v2 wrong edit" }));
    const reverted = await handle.withContext(ctx, (tx) => revertDocument(tx, ctx, { tenantId: tenantA, documentId: target.documentId, toVersion: 1 }));
    expect(reverted.version).toBe(3);
    const doc = await handle.withContext(ctx, async (tx) => (await tx.select({ body: schema.vaultDocuments.bodyMarkdown, version: schema.vaultDocuments.version }).from(schema.vaultDocuments).where(sql`id = ${target.documentId}`))[0]!);
    expect(doc).toEqual({ body: "v1", version: 3 });
    const revs = await handle.withContext(ctx, (tx) => tx.select({ v: schema.vaultRevisions.version }).from(schema.vaultRevisions).where(sql`document_id = ${target.documentId}`));
    expect(revs.length).toBe(3);
  });

  it("agent writes become proposals where the tenant policy requires review", async () => {
    const ctxCeo = tenantContext({ tenantId: tenantA, ...ceo });
    const ctxAgent = tenantContext({ tenantId: tenantA, ...agentA });
    await handle.withContext(ctxCeo, (tx) => setTenantPolicy(tx, ctxCeo, { tenantId: tenantA, key: "vault.agent_write_mode", value: { default: "auto_draft", "05_processes_to_be": "proposal_required" } }));
    const draft = await handle.withContext(ctxAgent, (tx) => agentWriteDocument(tx, ctxAgent, { tenantId: tenantA, path: "13_interviews_and_open_questions/notes.md", title: "Notes", frontmatter: {}, bodyMarkdown: "draft" }));
    expect(draft.mode).toBe("auto_draft");
    const proposal = await handle.withContext(ctxAgent, (tx) => agentWriteDocument(tx, ctxAgent, { tenantId: tenantA, path: "05_processes_to_be/quote-to-cash.md", title: "Quote to cash (target)", frontmatter: {}, bodyMarkdown: "proposed redesign" }));
    expect(proposal.mode).toBe("proposal_required");
    const before = await handle.withContext(ctxCeo, (tx) => tx.select().from(schema.vaultDocuments).where(sql`path = '05_processes_to_be/quote-to-cash.md'`));
    expect(before.length).toBe(0);
    const decided = await handle.withContext(ctxCeo, (tx) => decideProposal(tx, ctxCeo, { tenantId: tenantA, proposalId: proposal.proposalId!, decision: "approved" }));
    expect(decided.documentId).toBeDefined();
  });
});
