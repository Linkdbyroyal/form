import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type TenantContext } from "@sbos/db";
import { backlinks as backlinksOf, searchVault, type SearchHit } from "@sbos/core";
import { getDb } from "../db";
import { buildFolderTree, canSeeDrafts, type FolderNode } from "./vault-helpers";

/**
 * Knowledge Vault reads for the Client Workspace (M2-03, M2-05, M2-06, M2-07, M2-11). Every function runs in
 * TENANT context, so RLS pins the rows to the caller's tenant and the restrictive policy hides `restricted`
 * documents and facts from roles other than client_admin, agency_reviewer and superadmin. Content columns are
 * visible on purpose: this is the client's own data.
 */
const { questions, answers, interviewRounds, vaultDocuments, vaultRevisions, vaultLinks, vaultFacts, factVerificationRequests, vaultChangeProposals, tenantPolicies, evidence } = schema;

const num = (expr: ReturnType<typeof sql>) => sql<number>`${expr}`.mapWith(Number);

// Inbox ----------------------------------------------------------------------------------------------

export interface InboxQuestion {
  id: string;
  roundId: string | null;
  department: string;
  recipientRole: string;
  questionText: string;
  reason: string;
  evidenceGap: string;
  priority: string;
  answerType: string;
  options: string[];
  state: string;
  confidence: number;
  createdAt: Date;
  /** Latest answer, when the question is answered. */
  answer: { id: string; text: string; role: string; answeredAt: Date; notes: string | null; factId: string | null; factVerification: string | null } | null;
}

export interface InboxRoundView {
  round: { id: string; roundNumber: number; department: string | null; rationale: string; createdAt: Date } | null;
  questions: InboxQuestion[];
}

export interface InboxView {
  rounds: InboxRoundView[];
  counts: { open: number; draft: number; answered: number };
  /** True when drafts were hidden because the caller is not a client admin. */
  draftsHidden: boolean;
}

/** Open, answered and (for client admins) draft questions grouped by round, newest round first, with their latest answer. */
export async function listInboxView(ctx: TenantContext): Promise<InboxView> {
  const showDrafts = canSeeDrafts(ctx.roles);
  return getDb().withContext(ctx, async (tx) => {
    const states: Array<"open" | "draft" | "answered"> = showDrafts ? ["open", "draft", "answered"] : ["open", "answered"];
    const rows = await tx
      .select({
        id: questions.id,
        roundId: questions.roundId,
        department: questions.department,
        recipientRole: questions.recipientRole,
        questionText: questions.questionText,
        reason: questions.reason,
        evidenceGap: questions.evidenceGap,
        priority: questions.priority,
        answerType: questions.answerType,
        options: questions.options,
        state: questions.state,
        confidence: num(sql`${questions.confidence}`),
        createdAt: questions.createdAt
      })
      .from(questions)
      .where(inArray(questions.state, states))
      .orderBy(desc(questions.createdAt));
    const countRows = await tx.select({ state: questions.state, n: num(sql`count(*)`) }).from(questions).groupBy(questions.state);
    const counts = { open: 0, draft: 0, answered: 0 };
    for (const c of countRows) {
      if (c.state === "open") counts.open = c.n;
      else if (c.state === "draft") counts.draft = c.n;
      else if (c.state === "answered") counts.answered = c.n;
    }
    const questionIds = rows.map((r) => r.id);
    const answerRows = questionIds.length
      ? await tx
          .select({ id: answers.id, questionId: answers.questionId, text: answers.answerText, role: answers.answeredByRole, answeredAt: answers.answeredAt, notes: answers.notes, factId: answers.factId, factVerification: vaultFacts.verification })
          .from(answers)
          .leftJoin(vaultFacts, eq(vaultFacts.id, answers.factId))
          .where(inArray(answers.questionId, questionIds))
          .orderBy(desc(answers.answeredAt))
      : [];
    const latestAnswer = new Map<string, InboxQuestion["answer"]>();
    for (const a of answerRows) {
      if (!latestAnswer.has(a.questionId)) latestAnswer.set(a.questionId, { id: a.id, text: a.text, role: a.role, answeredAt: a.answeredAt, notes: a.notes, factId: a.factId, factVerification: a.factVerification ?? null });
    }
    const roundIds = [...new Set(rows.map((r) => r.roundId).filter((x): x is string => x !== null))];
    const roundRows = roundIds.length
      ? await tx
          .select({ id: interviewRounds.id, roundNumber: interviewRounds.roundNumber, department: interviewRounds.department, rationale: interviewRounds.rationale, createdAt: interviewRounds.createdAt })
          .from(interviewRounds)
          .where(inArray(interviewRounds.id, roundIds))
          .orderBy(desc(interviewRounds.roundNumber))
      : [];
    const byRound = new Map<string | null, InboxQuestion[]>();
    for (const q of rows) {
      const list = byRound.get(q.roundId) ?? [];
      list.push({ ...q, answer: latestAnswer.get(q.id) ?? null });
      byRound.set(q.roundId, list);
    }
    const rounds: InboxRoundView[] = roundRows.map((r) => ({ round: r, questions: byRound.get(r.id) ?? [] }));
    const orphan = byRound.get(null);
    if (orphan && orphan.length > 0) rounds.push({ round: null, questions: orphan });
    return { rounds, counts, draftsHidden: !showDrafts && counts.draft > 0 };
  });
}

// Browser ---------------------------------------------------------------------------------------------

export interface VaultDocumentRow {
  id: string;
  path: string;
  title: string;
  classification: string;
  verification: string;
  version: number;
  updatedAt: Date;
  updatedByActorId: string;
}

export interface VaultBrowserView {
  folders: FolderNode[];
  documents: VaultDocumentRow[];
  totalDocuments: number;
  hits: SearchHit[] | null;
}

const documentColumns = {
  id: vaultDocuments.id,
  path: vaultDocuments.path,
  title: vaultDocuments.title,
  classification: vaultDocuments.classification,
  verification: vaultDocuments.verification,
  version: vaultDocuments.version,
  updatedAt: vaultDocuments.updatedAt,
  updatedByActorId: vaultDocuments.updatedByActorId
};

/**
 * Folder tree with counts, documents of the selected folder, and search hits when `query` is set. The search
 * goes through `searchVault`, which logs a `retrieval_audit` row for the signed-in user.
 */
export async function getVaultBrowser(ctx: TenantContext, input: { folder: string | null; query: string | null }): Promise<VaultBrowserView> {
  return getDb().withContext(ctx, async (tx) => {
    const all = await tx.select(documentColumns).from(vaultDocuments).orderBy(vaultDocuments.path);
    const folders = buildFolderTree(all.map((d) => d.path));
    const documents = input.folder ? all.filter((d) => d.path.startsWith(`${input.folder}/`)) : [];
    const hits = input.query ? await searchVault(tx, ctx, { tenantId: ctx.tenantId, query: input.query, limit: 30 }) : null;
    return { folders, documents, totalDocuments: all.length, hits };
  });
}

export interface VaultRevisionRow {
  id: string;
  version: number;
  changedByActorType: string;
  changedByActorId: string;
  changeNote: string | null;
  runId: string | null;
  createdAt: Date;
}

export interface VaultDocumentView {
  document: VaultDocumentRow & { frontmatter: Record<string, unknown>; bodyMarkdown: string; createdAt: Date; createdByActorId: string; checksum: string };
  revisions: VaultRevisionRow[];
  backlinks: Array<{ fromDocumentId: string; path: string; title: string; linkText: string | null }>;
  outgoing: Array<{ toPath: string; toDocumentId: string | null; linkText: string | null }>;
  /** Body of the revision selected for comparison, when `compareVersion` was requested and exists. */
  compare: { version: number; bodyMarkdown: string; frontmatter: Record<string, unknown> } | null;
}

/** One document by path with its revisions, links and (optionally) an older revision body for the diff view. Null when hidden or missing. */
export async function getVaultDocumentView(ctx: TenantContext, path: string, compareVersion: number | null): Promise<VaultDocumentView | null> {
  return getDb().withContext(ctx, async (tx) => {
    const [doc] = await tx
      .select({ ...documentColumns, frontmatter: vaultDocuments.frontmatter, bodyMarkdown: vaultDocuments.bodyMarkdown, createdAt: vaultDocuments.createdAt, createdByActorId: vaultDocuments.createdByActorId, checksum: vaultDocuments.checksum })
      .from(vaultDocuments)
      .where(eq(vaultDocuments.path, path));
    if (!doc) return null;
    const revisions = await tx
      .select({ id: vaultRevisions.id, version: vaultRevisions.version, changedByActorType: vaultRevisions.changedByActorType, changedByActorId: vaultRevisions.changedByActorId, changeNote: vaultRevisions.changeNote, runId: vaultRevisions.runId, createdAt: vaultRevisions.createdAt })
      .from(vaultRevisions)
      .where(eq(vaultRevisions.documentId, doc.id))
      .orderBy(desc(vaultRevisions.version));
    const back = await backlinksOf(tx, ctx.tenantId, doc.id);
    const outgoing = await tx.select({ toPath: vaultLinks.toPath, toDocumentId: vaultLinks.toDocumentId, linkText: vaultLinks.linkText }).from(vaultLinks).where(eq(vaultLinks.fromDocumentId, doc.id)).orderBy(vaultLinks.toPath);
    let compare: VaultDocumentView["compare"] = null;
    if (compareVersion !== null) {
      const [rev] = await tx.select({ version: vaultRevisions.version, bodyMarkdown: vaultRevisions.bodyMarkdown, frontmatter: vaultRevisions.frontmatter }).from(vaultRevisions).where(and(eq(vaultRevisions.documentId, doc.id), eq(vaultRevisions.version, compareVersion)));
      if (rev) compare = { version: rev.version, bodyMarkdown: rev.bodyMarkdown, frontmatter: (rev.frontmatter ?? {}) as Record<string, unknown> };
    }
    return { document: { ...doc, frontmatter: (doc.frontmatter ?? {}) as Record<string, unknown> }, revisions, backlinks: back, outgoing, compare };
  });
}

// Review queue ----------------------------------------------------------------------------------------

export interface VerificationRequestRow {
  id: string;
  factId: string;
  factStatement: string | null;
  factVerification: string | null;
  factConfidence: number | null;
  conflicting: Array<{ id: string; statement: string; verification: string }>;
  reason: string;
  raisedByActorType: string;
  raisedByActorId: string;
  evidenceCount: number;
  requestedReviewerRole: string;
  state: string;
  resolvedByActorId: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  createdAt: Date;
}

export interface ProposalRow {
  id: string;
  documentId: string | null;
  path: string;
  title: string;
  bodyPreview: string;
  bodyLength: number;
  changeNote: string | null;
  proposedByActorType: string;
  proposedByActorId: string;
  state: string;
  decidedByActorId: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  createdAt: Date;
}

export interface ReviewQueueView {
  openRequests: VerificationRequestRow[];
  decidedRequests: VerificationRequestRow[];
  pendingProposals: ProposalRow[];
  decidedProposals: ProposalRow[];
}

export async function getReviewQueue(ctx: TenantContext): Promise<ReviewQueueView> {
  return getDb().withContext(ctx, async (tx) => {
    const reqRows = await tx
      .select({
        id: factVerificationRequests.id,
        factId: factVerificationRequests.factId,
        conflictingFactIds: factVerificationRequests.conflictingFactIds,
        reason: factVerificationRequests.reason,
        raisedByActorType: factVerificationRequests.raisedByActorType,
        raisedByActorId: factVerificationRequests.raisedByActorId,
        evidenceIds: factVerificationRequests.evidenceIds,
        requestedReviewerRole: factVerificationRequests.requestedReviewerRole,
        state: factVerificationRequests.state,
        resolvedByActorId: factVerificationRequests.resolvedByActorId,
        resolvedAt: factVerificationRequests.resolvedAt,
        resolutionNote: factVerificationRequests.resolutionNote,
        createdAt: factVerificationRequests.createdAt,
        factStatement: vaultFacts.statement,
        factVerification: vaultFacts.verification,
        factConfidence: num(sql`${vaultFacts.confidence}`)
      })
      .from(factVerificationRequests)
      .leftJoin(vaultFacts, eq(vaultFacts.id, factVerificationRequests.factId))
      .orderBy(desc(factVerificationRequests.createdAt))
      .limit(100);
    const conflictIds = [...new Set(reqRows.flatMap((r) => r.conflictingFactIds))];
    const conflictRows = conflictIds.length ? await tx.select({ id: vaultFacts.id, statement: vaultFacts.statement, verification: vaultFacts.verification }).from(vaultFacts).where(inArray(vaultFacts.id, conflictIds)) : [];
    const conflictById = new Map<string, { id: string; statement: string; verification: string }>(conflictRows.map((c) => [c.id, { id: c.id, statement: c.statement, verification: c.verification }]));
    const requests: VerificationRequestRow[] = reqRows.map((r) => ({
      id: r.id,
      factId: r.factId,
      factStatement: r.factStatement,
      factVerification: r.factVerification,
      factConfidence: r.factStatement === null ? null : r.factConfidence,
      conflicting: r.conflictingFactIds.flatMap((id) => { const c = conflictById.get(id); return c ? [c] : []; }),
      reason: r.reason,
      raisedByActorType: r.raisedByActorType,
      raisedByActorId: r.raisedByActorId,
      evidenceCount: r.evidenceIds.length,
      requestedReviewerRole: r.requestedReviewerRole,
      state: r.state,
      resolvedByActorId: r.resolvedByActorId,
      resolvedAt: r.resolvedAt,
      resolutionNote: r.resolutionNote,
      createdAt: r.createdAt
    }));
    const propRows = await tx
      .select({
        id: vaultChangeProposals.id,
        documentId: vaultChangeProposals.documentId,
        path: vaultChangeProposals.path,
        title: vaultChangeProposals.title,
        body: sql<string>`left(${vaultChangeProposals.bodyMarkdown}, 400)`,
        bodyLength: num(sql`length(${vaultChangeProposals.bodyMarkdown})`),
        changeNote: vaultChangeProposals.changeNote,
        proposedByActorType: vaultChangeProposals.proposedByActorType,
        proposedByActorId: vaultChangeProposals.proposedByActorId,
        state: vaultChangeProposals.state,
        decidedByActorId: vaultChangeProposals.decidedByActorId,
        decidedAt: vaultChangeProposals.decidedAt,
        decisionNote: vaultChangeProposals.decisionNote,
        createdAt: vaultChangeProposals.createdAt
      })
      .from(vaultChangeProposals)
      .orderBy(desc(vaultChangeProposals.createdAt))
      .limit(100);
    const proposals: ProposalRow[] = propRows.map((p) => ({ ...p, bodyPreview: p.body }));
    return {
      openRequests: requests.filter((r) => r.state === "open"),
      decidedRequests: requests.filter((r) => r.state !== "open").slice(0, 20),
      pendingProposals: proposals.filter((p) => p.state === "pending"),
      decidedProposals: proposals.filter((p) => p.state !== "pending").slice(0, 20)
    };
  });
}

// Facts -----------------------------------------------------------------------------------------------

export interface FactRow {
  id: string;
  statement: string;
  subjectType: string | null;
  subjectKey: string | null;
  originSystem: string;
  responsibleRole: string | null;
  verification: string;
  confidence: number;
  classification: string;
  version: number;
  sourcesCount: number;
  contradictsCount: number;
  observedAt: Date;
  updatedAt: Date;
}

export const FACT_FILTERS = ["unconfirmed", "hypothesis", "evidence_backed", "verified", "approved_policy", "deprecated"] as const;

export async function listFacts(ctx: TenantContext, filter: string | null): Promise<{ facts: FactRow[]; counts: Record<string, number> }> {
  return getDb().withContext(ctx, async (tx) => {
    const where = filter && (FACT_FILTERS as readonly string[]).includes(filter) ? eq(vaultFacts.verification, filter as (typeof FACT_FILTERS)[number]) : undefined;
    const rows = await tx
      .select({
        id: vaultFacts.id,
        statement: vaultFacts.statement,
        subjectType: vaultFacts.subjectType,
        subjectKey: vaultFacts.subjectKey,
        originSystem: vaultFacts.originSystem,
        responsibleRole: vaultFacts.responsibleRole,
        verification: vaultFacts.verification,
        confidence: num(sql`${vaultFacts.confidence}`),
        classification: vaultFacts.classification,
        version: vaultFacts.version,
        sourcesCount: num(sql`coalesce(array_length(${vaultFacts.sourceIds}, 1), 0)`),
        contradictsCount: num(sql`coalesce(array_length(${vaultFacts.contradicts}, 1), 0)`),
        observedAt: vaultFacts.observedAt,
        updatedAt: vaultFacts.updatedAt
      })
      .from(vaultFacts)
      .where(where)
      .orderBy(desc(vaultFacts.updatedAt))
      .limit(100);
    const countRows = await tx.select({ verification: vaultFacts.verification, n: num(sql`count(*)`) }).from(vaultFacts).groupBy(vaultFacts.verification);
    const counts: Record<string, number> = {};
    for (const c of countRows) counts[c.verification] = c.n;
    return { facts: rows, counts };
  });
}

// Settings --------------------------------------------------------------------------------------------

export interface WriteModePolicyView {
  value: Record<string, string>;
  updatedByActorId: string | null;
  updatedAt: Date | null;
}

export async function getWriteModePolicy(ctx: TenantContext): Promise<WriteModePolicyView> {
  return getDb().withContext(ctx, async (tx) => {
    const [row] = await tx.select({ value: tenantPolicies.value, updatedByActorId: tenantPolicies.updatedByActorId, updatedAt: tenantPolicies.updatedAt }).from(tenantPolicies).where(eq(tenantPolicies.key, "vault.agent_write_mode"));
    const value = row && row.value && typeof row.value === "object" && !Array.isArray(row.value) ? (row.value as Record<string, string>) : {};
    return { value, updatedByActorId: row?.updatedByActorId ?? null, updatedAt: row?.updatedAt ?? null };
  });
}

/** Small counters for the vault landing page header. */
export async function getVaultCounters(ctx: TenantContext): Promise<{ openRequests: number; pendingProposals: number; facts: number; evidence: number }> {
  return getDb().withContext(ctx, async (tx) => {
    const [r] = await tx.select({ n: num(sql`count(*)`) }).from(factVerificationRequests).where(eq(factVerificationRequests.state, "open"));
    const [p] = await tx.select({ n: num(sql`count(*)`) }).from(vaultChangeProposals).where(eq(vaultChangeProposals.state, "pending"));
    const [f] = await tx.select({ n: num(sql`count(*)`) }).from(vaultFacts);
    const [e] = await tx.select({ n: num(sql`count(*)`) }).from(evidence);
    return { openRequests: r?.n ?? 0, pendingProposals: p?.n ?? 0, facts: f?.n ?? 0, evidence: e?.n ?? 0 };
  });
}
