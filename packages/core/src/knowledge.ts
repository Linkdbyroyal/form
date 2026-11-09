import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, writeAudit, type RequestContext, type Tx } from "@sbos/db";
import { writeVaultDocument } from "./vault";
import { AuthorizationError } from "./errors";

const { questions, answers, sources, vaultFacts, vaultFactRevisions, factVerificationRequests, vaultDocuments, vaultRevisions, vaultLinks, vaultChangeProposals, retrievalAudit, tenantPolicies } = schema;

export type VerificationStatus = (typeof schema.verificationStatus.enumValues)[number];
export type AnswerValue = string | number | boolean | string[];

export function answerToText(value: AnswerValue): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

// Answers -------------------------------------------------------------------------------------

export interface AnswerQuestionInput {
  tenantId: string;
  questionId: string;
  value: AnswerValue;
  notes?: string | null;
  /** Role of the answering user, used as `responsible_role` on the fact. */
  role: string;
}

/**
 * Stores an answer, closes the question and records the answer as an `unconfirmed` fact with an
 * interview source. Nothing here is treated as truth: the fact waits for evidence or a reviewer.
 */
export async function answerQuestion(tx: Tx, ctx: RequestContext, input: AnswerQuestionInput): Promise<{ answerId: string; factId: string; sourceId: string }> {
  const [q] = await tx.select().from(questions).where(and(eq(questions.id, input.questionId), eq(questions.tenantId, input.tenantId)));
  if (!q) throw new Error("question not found");
  if (q.state !== "open" && q.state !== "answered") throw new Error(`question is ${q.state}, not open`);
  const text = answerToText(input.value);

  const [src] = await tx
    .insert(sources)
    .values({ tenantId: input.tenantId, system: "interview", locator: `question:${q.id}`, retrievedAt: new Date(), createdByActorType: ctx.actorType, createdByActorId: ctx.actorId })
    .returning({ id: sources.id });
  const [fact] = await tx
    .insert(vaultFacts)
    .values({
      tenantId: input.tenantId,
      statement: `${q.recipientRole} answered "${q.questionText}": ${text}`,
      subjectType: "department",
      subjectKey: q.department,
      sourceIds: [src!.id],
      originSystem: "interview",
      responsibleRole: input.role,
      verification: "unconfirmed",
      confidence: "0.50",
      createdByActorType: ctx.actorType,
      createdByActorId: ctx.actorId,
      updatedByActorId: ctx.actorId
    })
    .returning({ id: vaultFacts.id });
  await tx.insert(vaultFactRevisions).values({ tenantId: input.tenantId, factId: fact!.id, version: 1, statement: `${q.recipientRole} answered "${q.questionText}": ${text}`, verification: "unconfirmed", confidence: "0.50", sourceIds: [src!.id], changedByActorType: ctx.actorType, changedByActorId: ctx.actorId, changeNote: "answer recorded" });

  const previous = await tx.select({ id: answers.id }).from(answers).where(eq(answers.questionId, q.id)).orderBy(desc(answers.answeredAt)).limit(1);
  const [ans] = await tx
    .insert(answers)
    .values({
      tenantId: input.tenantId,
      questionId: q.id,
      answerValue: input.value,
      answerText: text,
      answeredByActorType: ctx.actorType,
      answeredByActorId: ctx.actorId,
      answeredByRole: input.role,
      sourceId: src!.id,
      factId: fact!.id,
      notes: input.notes ?? null,
      supersedesAnswerId: previous[0]?.id ?? null
    })
    .returning({ id: answers.id });
  await tx.update(questions).set({ state: "answered" }).where(eq(questions.id, q.id));
  await writeAudit(tx, ctx, { action: "question.answered", entityType: "question", entityId: q.id, after: { answerId: ans!.id, factId: fact!.id } });
  return { answerId: ans!.id, factId: fact!.id, sourceId: src!.id };
}

// Facts ----------------------------------------------------------------------------------------

export interface CreateFactInput {
  tenantId: string;
  statement: string;
  subjectType?: string | null;
  subjectKey?: string | null;
  sourceIds: string[];
  originSystem: string;
  responsibleRole?: string | null;
  verification?: VerificationStatus;
  confidence?: number;
  classification?: "public" | "internal" | "confidential" | "restricted";
  runId?: string | null;
}

export async function createFact(tx: Tx, ctx: RequestContext, input: CreateFactInput): Promise<string> {
  if (input.sourceIds.length === 0) throw new Error("a fact needs at least one source");
  const verification = input.verification ?? "unconfirmed";
  const confidence = String(input.confidence ?? 0.5);
  const [fact] = await tx
    .insert(vaultFacts)
    .values({
      tenantId: input.tenantId,
      statement: input.statement,
      subjectType: input.subjectType ?? null,
      subjectKey: input.subjectKey ?? null,
      sourceIds: input.sourceIds,
      originSystem: input.originSystem,
      responsibleRole: input.responsibleRole ?? null,
      verification,
      confidence,
      classification: input.classification ?? "confidential",
      createdByActorType: ctx.actorType,
      createdByActorId: ctx.actorId,
      updatedByActorId: ctx.actorId
    })
    .returning({ id: vaultFacts.id });
  await tx.insert(vaultFactRevisions).values({ tenantId: input.tenantId, factId: fact!.id, version: 1, statement: input.statement, verification, confidence, sourceIds: input.sourceIds, changedByActorType: ctx.actorType, changedByActorId: ctx.actorId, changeNote: "created", runId: input.runId ?? null });
  await writeAudit(tx, ctx, { action: "fact.created", entityType: "vault_fact", entityId: fact!.id, after: { verification, originSystem: input.originSystem } });
  return fact!.id;
}

/** Changes a fact's verification status. The database trigger enforces who may promote to verified or approved_policy. */
export async function setFactVerification(tx: Tx, ctx: RequestContext, input: { tenantId: string; factId: string; verification: VerificationStatus; note?: string; confidence?: number; runId?: string | null }): Promise<void> {
  const [fact] = await tx.select().from(vaultFacts).where(and(eq(vaultFacts.id, input.factId), eq(vaultFacts.tenantId, input.tenantId)));
  if (!fact) throw new Error("fact not found");
  const version = fact.version + 1;
  const confidence = input.confidence !== undefined ? String(input.confidence) : fact.confidence;
  await tx.update(vaultFacts).set({ verification: input.verification, confidence, version, updatedByActorId: ctx.actorId }).where(eq(vaultFacts.id, fact.id));
  await tx.insert(vaultFactRevisions).values({ tenantId: input.tenantId, factId: fact.id, version, statement: fact.statement, verification: input.verification, confidence, sourceIds: fact.sourceIds, changedByActorType: ctx.actorType, changedByActorId: ctx.actorId, changeNote: input.note ?? `verification -> ${input.verification}`, runId: input.runId ?? null });
  await writeAudit(tx, ctx, { action: "fact.verification_changed", entityType: "vault_fact", entityId: fact.id, before: { verification: fact.verification }, after: { verification: input.verification } });
}

// Verification requests --------------------------------------------------------------------------

export async function requestFactVerification(tx: Tx, ctx: RequestContext, input: { tenantId: string; factId: string; conflictingFactIds?: string[]; reason: string; evidenceIds?: string[]; reviewerRole?: string; runId?: string | null }): Promise<string> {
  const open = await tx.select({ id: factVerificationRequests.id }).from(factVerificationRequests).where(and(eq(factVerificationRequests.factId, input.factId), eq(factVerificationRequests.state, "open")));
  if (open[0]) return open[0].id; // one open request per fact
  const [row] = await tx
    .insert(factVerificationRequests)
    .values({
      tenantId: input.tenantId,
      factId: input.factId,
      conflictingFactIds: input.conflictingFactIds ?? [],
      raisedByActorType: ctx.actorType,
      raisedByActorId: ctx.actorId,
      reason: input.reason,
      evidenceIds: input.evidenceIds ?? [],
      requestedReviewerRole: input.reviewerRole ?? "client_admin",
      runId: input.runId ?? null
    })
    .returning({ id: factVerificationRequests.id });
  if (input.conflictingFactIds?.length) {
    await tx.update(vaultFacts).set({ contradicts: input.conflictingFactIds, updatedByActorId: ctx.actorId }).where(eq(vaultFacts.id, input.factId));
    await tx.update(vaultFacts).set({ verification: "hypothesis", updatedByActorId: ctx.actorId }).where(and(eq(vaultFacts.id, input.factId), eq(vaultFacts.verification, "unconfirmed")));
  }
  await writeAudit(tx, ctx, { action: "fact.verification_requested", entityType: "fact_verification_request", entityId: row!.id, after: { factId: input.factId, conflicts: input.conflictingFactIds?.length ?? 0 } });
  return row!.id;
}

/** Reviewer decision. `verified` promotes the fact (trigger checks the role); `rejected` deprecates it. */
export async function decideFactVerification(tx: Tx, ctx: RequestContext, input: { tenantId: string; requestId: string; decision: "verified" | "rejected"; note?: string }): Promise<void> {
  const [req] = await tx.select().from(factVerificationRequests).where(and(eq(factVerificationRequests.id, input.requestId), eq(factVerificationRequests.tenantId, input.tenantId)));
  if (!req) throw new Error("verification request not found");
  if (req.state !== "open") throw new Error(`request already ${req.state}`);
  await setFactVerification(tx, ctx, { tenantId: input.tenantId, factId: req.factId, verification: input.decision === "verified" ? "verified" : "deprecated", note: input.note ?? `review: ${input.decision}`, confidence: input.decision === "verified" ? 0.9 : 0.1 });
  await tx.update(factVerificationRequests).set({ state: input.decision, resolvedByActorId: ctx.actorId, resolvedAt: new Date(), resolutionNote: input.note ?? null }).where(eq(factVerificationRequests.id, req.id));
  await writeAudit(tx, ctx, { action: `fact_verification.${input.decision}`, entityType: "fact_verification_request", entityId: req.id, after: { factId: req.factId } });
}

// Links ------------------------------------------------------------------------------------------

/** Extracts [[wikilinks]] and relative markdown links to .md files. Returns normalised vault paths. */
export function extractLinks(markdown: string): Array<{ path: string; text: string | null }> {
  const out = new Map<string, string | null>();
  for (const m of markdown.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g)) {
    const raw = m[1]!.trim();
    out.set(raw.endsWith(".md") ? raw : `${raw}.md`, m[2]?.trim() ?? null);
  }
  for (const m of markdown.matchAll(/\[([^\]]*)\]\(([^)\s]+\.md)(?:#[^)]*)?\)/g)) {
    const raw = m[2]!.replace(/^\.\//, "");
    if (!/^https?:/i.test(raw)) out.set(raw, m[1] ?? null);
  }
  return [...out.entries()].map(([path, text]) => ({ path, text }));
}

export async function syncDocumentLinks(tx: Tx, tenantId: string, documentId: string, markdown: string): Promise<number> {
  const links = extractLinks(markdown);
  // Resolve dangling links from other documents that point at this document's path (also when this document has no links).
  const [doc] = await tx.select({ path: vaultDocuments.path }).from(vaultDocuments).where(eq(vaultDocuments.id, documentId));
  if (doc) await tx.update(vaultLinks).set({ toDocumentId: documentId }).where(and(eq(vaultLinks.tenantId, tenantId), eq(vaultLinks.toPath, doc.path), sql`${vaultLinks.toDocumentId} is null`));
  await tx.delete(vaultLinks).where(and(eq(vaultLinks.fromDocumentId, documentId), eq(vaultLinks.tenantId, tenantId)));
  if (links.length === 0) return 0;
  const targets = await tx.select({ id: vaultDocuments.id, path: vaultDocuments.path }).from(vaultDocuments).where(and(eq(vaultDocuments.tenantId, tenantId), inArray(vaultDocuments.path, links.map((l) => l.path))));
  const byPath = new Map(targets.map((t) => [t.path, t.id]));
  await tx.insert(vaultLinks).values(links.map((l) => ({ tenantId, fromDocumentId: documentId, toPath: l.path, toDocumentId: byPath.get(l.path) ?? null, linkText: l.text })));
  return links.length;
}

export async function backlinks(tx: Tx, tenantId: string, documentId: string) {
  return tx
    .select({ fromDocumentId: vaultLinks.fromDocumentId, path: vaultDocuments.path, title: vaultDocuments.title, linkText: vaultLinks.linkText })
    .from(vaultLinks)
    .innerJoin(vaultDocuments, eq(vaultDocuments.id, vaultLinks.fromDocumentId))
    .where(and(eq(vaultLinks.tenantId, tenantId), eq(vaultLinks.toDocumentId, documentId)));
}

// Documents: write mode, revert ------------------------------------------------------------------

export type WriteMode = "auto_draft" | "proposal_required";

/** Reads the tenant policy `vault.agent_write_mode`: { default, "<folder prefix>": mode }. */
export async function resolveWriteMode(tx: Tx, tenantId: string, path: string): Promise<WriteMode> {
  const [row] = await tx.select({ value: tenantPolicies.value }).from(tenantPolicies).where(and(eq(tenantPolicies.tenantId, tenantId), eq(tenantPolicies.key, "vault.agent_write_mode")));
  const value = (row?.value ?? {}) as Record<string, string>;
  const folder = path.split("/")[0] ?? "";
  const mode = value[folder] ?? value.default ?? "auto_draft";
  return mode === "proposal_required" ? "proposal_required" : "auto_draft";
}

export async function setTenantPolicy(tx: Tx, ctx: RequestContext, input: { tenantId: string; key: string; value: Record<string, unknown> }): Promise<void> {
  await tx
    .insert(tenantPolicies)
    .values({ tenantId: input.tenantId, key: input.key, value: input.value, updatedByActorId: ctx.actorId })
    .onConflictDoUpdate({ target: [tenantPolicies.tenantId, tenantPolicies.key], set: { value: input.value, updatedByActorId: ctx.actorId, updatedAt: new Date() } });
  await writeAudit(tx, ctx, { action: "tenant_policy.set", entityType: "tenant_policy", entityId: input.key, after: input.value });
}

export interface AgentWriteInput {
  tenantId: string;
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  bodyMarkdown: string;
  changeNote?: string;
  runId?: string | null;
}

/** Agents write through this: either a draft document (auto_draft) or a change proposal (proposal_required). */
export async function agentWriteDocument(tx: Tx, ctx: RequestContext, input: AgentWriteInput): Promise<{ mode: WriteMode; documentId?: string; proposalId?: string; version?: number }> {
  const mode = await resolveWriteMode(tx, input.tenantId, input.path);
  if (mode === "auto_draft") {
    const r = await writeVaultDocument(tx, ctx, { ...input, classification: "confidential", verification: "unconfirmed", changeNote: input.changeNote ?? "agent draft", runId: input.runId ?? null });
    await syncDocumentLinks(tx, input.tenantId, r.documentId, input.bodyMarkdown);
    return { mode, documentId: r.documentId, version: r.version };
  }
  const [existing] = await tx.select({ id: vaultDocuments.id }).from(vaultDocuments).where(and(eq(vaultDocuments.tenantId, input.tenantId), eq(vaultDocuments.path, input.path)));
  const [p] = await tx
    .insert(vaultChangeProposals)
    .values({ tenantId: input.tenantId, documentId: existing?.id ?? null, path: input.path, title: input.title, frontmatter: input.frontmatter, bodyMarkdown: input.bodyMarkdown, changeNote: input.changeNote ?? null, proposedByActorType: ctx.actorType, proposedByActorId: ctx.actorId, runId: input.runId ?? null })
    .returning({ id: vaultChangeProposals.id });
  await writeAudit(tx, ctx, { action: "vault.proposal_created", entityType: "vault_change_proposal", entityId: p!.id, after: { path: input.path } });
  return { mode, proposalId: p!.id };
}

export async function decideProposal(tx: Tx, ctx: RequestContext, input: { tenantId: string; proposalId: string; decision: "approved" | "rejected"; note?: string }): Promise<{ documentId?: string }> {
  const [p] = await tx.select().from(vaultChangeProposals).where(and(eq(vaultChangeProposals.id, input.proposalId), eq(vaultChangeProposals.tenantId, input.tenantId)));
  if (!p) throw new Error("proposal not found");
  if (p.state !== "pending") throw new Error(`proposal already ${p.state}`);
  await tx.update(vaultChangeProposals).set({ state: input.decision, decidedByActorId: ctx.actorId, decidedAt: new Date(), decisionNote: input.note ?? null }).where(eq(vaultChangeProposals.id, p.id));
  await writeAudit(tx, ctx, { action: `vault.proposal_${input.decision}`, entityType: "vault_change_proposal", entityId: p.id });
  if (input.decision === "rejected") return {};
  const r = await writeVaultDocument(tx, ctx, { tenantId: input.tenantId, path: p.path, title: p.title, frontmatter: p.frontmatter as Record<string, unknown>, bodyMarkdown: p.bodyMarkdown, changeNote: `proposal ${p.id} approved`, runId: p.runId });
  await syncDocumentLinks(tx, input.tenantId, r.documentId, p.bodyMarkdown);
  return { documentId: r.documentId };
}

/** Restores an earlier revision as a NEW revision (history is never rewritten). */
export async function revertDocument(tx: Tx, ctx: RequestContext, input: { tenantId: string; documentId: string; toVersion: number; note?: string }): Promise<{ version: number }> {
  const [rev] = await tx.select().from(vaultRevisions).where(and(eq(vaultRevisions.documentId, input.documentId), eq(vaultRevisions.version, input.toVersion), eq(vaultRevisions.tenantId, input.tenantId)));
  if (!rev) throw new Error(`revision ${input.toVersion} not found`);
  const [doc] = await tx.select({ path: vaultDocuments.path, title: vaultDocuments.title }).from(vaultDocuments).where(eq(vaultDocuments.id, input.documentId));
  if (!doc) throw new Error("document not found");
  const r = await writeVaultDocument(tx, ctx, { tenantId: input.tenantId, path: doc.path, title: doc.title, frontmatter: rev.frontmatter as Record<string, unknown>, bodyMarkdown: rev.bodyMarkdown, changeNote: input.note ?? `reverted to version ${input.toVersion}` });
  await syncDocumentLinks(tx, input.tenantId, r.documentId, rev.bodyMarkdown);
  await writeAudit(tx, ctx, { action: "vault.document_reverted", entityType: "vault_document", entityId: input.documentId, after: { toVersion: input.toVersion, newVersion: r.version } });
  return { version: r.version };
}

// Search -------------------------------------------------------------------------------------------

export interface SearchHit {
  kind: "document" | "fact";
  id: string;
  title: string;
  snippet: string;
  path?: string;
  verification?: string;
  classification: string;
  rank: number;
}

/**
 * Full-text search over documents and facts of the current tenant. RLS limits the rows; the restrictive
 * policy hides `restricted` rows from non-reviewer roles. Every call is logged in retrieval_audit.
 */
export async function searchVault(tx: Tx, ctx: RequestContext, input: { tenantId: string; query: string; limit?: number; runId?: string | null; kind?: "fts" | "agent_context" }): Promise<SearchHit[]> {
  if (ctx.kind === "operator" || ctx.tenantId !== input.tenantId) {
    throw new AuthorizationError("search runs only inside the tenant context it targets");
  }
  const limit = Math.min(input.limit ?? 20, 100);
  const q = input.query.trim();
  if (!q) return [];
  const docs = await tx.execute<{ id: string; title: string; path: string; classification: string; verification: string; snippet: string; rank: number }>(sql`
    SELECT id, title, path, classification::text AS classification, verification::text AS verification,
           ts_headline('english', body_markdown, websearch_to_tsquery('english', ${q}), 'MaxFragments=1, MaxWords=30, MinWords=10') AS snippet,
           ts_rank(search, websearch_to_tsquery('english', ${q})) AS rank
    FROM vault_documents
    WHERE tenant_id = ${input.tenantId} AND (search @@ websearch_to_tsquery('english', ${q}) OR title ILIKE ${"%" + q + "%"})
    ORDER BY rank DESC, updated_at DESC LIMIT ${limit}`);
  const facts = await tx.execute<{ id: string; statement: string; classification: string; verification: string; rank: number }>(sql`
    SELECT id, statement, classification::text AS classification, verification::text AS verification,
           ts_rank(search, websearch_to_tsquery('english', ${q})) AS rank
    FROM vault_facts
    WHERE tenant_id = ${input.tenantId} AND verification <> 'deprecated' AND (search @@ websearch_to_tsquery('english', ${q}) OR statement ILIKE ${"%" + q + "%"})
    ORDER BY rank DESC, updated_at DESC LIMIT ${limit}`);
  const hits: SearchHit[] = [
    ...docs.rows.map((d) => ({ kind: "document" as const, id: d.id, title: d.title, path: d.path, snippet: d.snippet, verification: d.verification, classification: d.classification, rank: Number(d.rank) })),
    ...facts.rows.map((f) => ({ kind: "fact" as const, id: f.id, title: f.statement.slice(0, 80), snippet: f.statement, verification: f.verification, classification: f.classification, rank: Number(f.rank) }))
  ]
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit);
  await tx.insert(retrievalAudit).values({ tenantId: input.tenantId, actorType: ctx.actorType, actorId: ctx.actorId, runId: input.runId ?? null, kind: input.kind ?? "fts", query: q, resultIds: hits.map((h) => h.id), resultCount: hits.length });
  return hits;
}

/** Facts for agent context (non-deprecated), logged in retrieval_audit. */
export async function readFactsForAgent(tx: Tx, ctx: RequestContext, input: { tenantId: string; runId?: string | null; limit?: number }) {
  const rows = await tx
    .select({ id: vaultFacts.id, statement: vaultFacts.statement, verification: vaultFacts.verification, confidence: vaultFacts.confidence, subjectType: vaultFacts.subjectType, subjectKey: vaultFacts.subjectKey, sourceIds: vaultFacts.sourceIds })
    .from(vaultFacts)
    .where(and(eq(vaultFacts.tenantId, input.tenantId), sql`${vaultFacts.verification} <> 'deprecated'`))
    .orderBy(desc(vaultFacts.updatedAt))
    .limit(input.limit ?? 100);
  await tx.insert(retrievalAudit).values({ tenantId: input.tenantId, actorType: ctx.actorType, actorId: ctx.actorId, runId: input.runId ?? null, kind: "agent_context", query: null, resultIds: rows.map((r) => r.id), resultCount: rows.length });
  return rows;
}
