"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { schema, type TenantContext } from "@sbos/db";
import { answerQuestion, decideFactVerification, decideProposal, revertDocument, setFactVerification, setTenantPolicy, syncDocumentLinks, writeVaultDocument, type VerificationStatus } from "@sbos/core";
import { getDb } from "../db";
import { errorMessage, withNotice } from "../format";
import { requireTenantContext, type ResolvedTenant } from "../request-context";
import { buildWriteModePolicy, canAnswerQuestion, canDecideProposals, canEditDocuments, canManageVaultSettings, canReviewFacts, clientRole, DOC_PATH_RE, parseAnswerValue, parseFrontmatterInput, VAULT_FOLDERS } from "./vault-helpers";

/**
 * Knowledge Vault write actions for the Client Workspace. Each action resolves the tenant context from the
 * session, checks the UI-level role rule, and calls the @sbos/core service inside `withContext()`. The
 * database enforces the hard rules (RLS, the fact-verification trigger, the vault path rule); a refusal
 * from Postgres is shown to the user through `?error=` on the redirect.
 */
const { questions, vaultDocuments } = schema;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9-]{1,64}$/;

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
}

function texts(form: FormData, name: string): string[] {
  return form.getAll(name).filter((v): v is string => typeof v === "string");
}

function uuid(form: FormData, name: string): string {
  const v = text(form, name);
  if (!UUID_RE.test(v)) throw new Error(`${name} must be a UUID`);
  return v;
}

interface Resolved {
  slug: string;
  access: ResolvedTenant;
  ctx: TenantContext;
}

/** Resolves slug and tenant context; break-glass grants are read-only for every vault write. */
async function resolveWrite(form: FormData): Promise<Resolved> {
  const slug = text(form, "slug");
  if (!SLUG_RE.test(slug)) throw new Error("invalid workspace");
  const access = await requireTenantContext(slug);
  if (!access) throw new Error("workspace not found");
  if (access.viaGrant) throw new Error("a break-glass grant is read-only; vault changes are made by the client's own roles");
  return { slug, access, ctx: access.ctx };
}

function safeReturn(form: FormData, fallback: string): string {
  const requested = text(form, "returnTo");
  return requested.startsWith("/") && !requested.startsWith("//") ? requested : fallback;
}

function finish(slug: string | null, returnTo: string, outcome: { ok?: string; error?: string }, extraPaths: string[] = []): never {
  revalidatePath(returnTo.split("?")[0] ?? returnTo);
  if (slug) for (const p of extraPaths) revalidatePath(`/c/${slug}${p}`);
  redirect(withNotice(returnTo, outcome));
}

// Inbox: answer a question ---------------------------------------------------------------------------

export async function answerQuestionAction(form: FormData): Promise<void> {
  const slugGuess = text(form, "slug");
  const fallback = SLUG_RE.test(slugGuess) ? `/c/${slugGuess}/inbox` : "/";
  const returnTo = safeReturn(form, fallback);
  let outcome: { ok?: string; error?: string };
  try {
    const { slug, ctx } = await resolveWrite(form);
    const questionId = uuid(form, "questionId");
    const notes = text(form, "notes").slice(0, 2000) || null;
    const role = clientRole(ctx.roles);
    if (!role) throw new Error("answering requires a client role (client_admin, department_manager or client_employee)");
    await getDb().withContext(ctx, async (tx) => {
      const [q] = await tx.select({ recipientRole: questions.recipientRole, answerType: questions.answerType, options: questions.options, state: questions.state }).from(questions).where(and(eq(questions.id, questionId), eq(questions.tenantId, ctx.tenantId)));
      if (!q) throw new Error("question not found in this workspace");
      if (q.state !== "open") throw new Error(`question is ${q.state}; only open questions can be answered`);
      if (!canAnswerQuestion(ctx.roles, q.recipientRole)) throw new Error(`this question is addressed to ${q.recipientRole}; your roles: ${ctx.roles.join(", ")}`);
      const value = parseAnswerValue(q.answerType, { values: texts(form, "value") }, q.options);
      await answerQuestion(tx, ctx, { tenantId: ctx.tenantId, questionId, value, notes, role });
    });
    outcome = { ok: "Answer stored as an unconfirmed fact with an interview source. A reviewer or evidence promotes it later." };
    return finish(slug, returnTo, outcome, ["/inbox", "/vault/facts", "/vault"]);
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(null, returnTo, outcome);
}

// Review queue -----------------------------------------------------------------------------------------

export async function decideVerificationRequestAction(form: FormData): Promise<void> {
  const slugGuess = text(form, "slug");
  const fallback = SLUG_RE.test(slugGuess) ? `/c/${slugGuess}/vault/review` : "/";
  const returnTo = safeReturn(form, fallback);
  let outcome: { ok?: string; error?: string };
  try {
    const { slug, ctx } = await resolveWrite(form);
    const requestId = uuid(form, "requestId");
    const decisionRaw = text(form, "decision");
    if (decisionRaw !== "verified" && decisionRaw !== "rejected") throw new Error("decision must be verified or rejected");
    const note = text(form, "note").slice(0, 1000) || undefined;
    if (!canReviewFacts(ctx.roles)) throw new Error(`fact verification requires the client_admin role; your roles: ${ctx.roles.join(", ")}`);
    await getDb().withContext(ctx, (tx) => decideFactVerification(tx, ctx, { tenantId: ctx.tenantId, requestId, decision: decisionRaw, note }));
    outcome = { ok: decisionRaw === "verified" ? "Fact promoted to verified (confidence 0.90). The decision and a fact revision were written to the audit trail." : "Request rejected: the fact is now deprecated and leaves search results." };
    return finish(slug, returnTo, outcome, ["/vault/review", "/vault/facts", "/inbox"]);
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(null, returnTo, outcome);
}

export async function decideProposalAction(form: FormData): Promise<void> {
  const slugGuess = text(form, "slug");
  const fallback = SLUG_RE.test(slugGuess) ? `/c/${slugGuess}/vault/review` : "/";
  const returnTo = safeReturn(form, fallback);
  let outcome: { ok?: string; error?: string };
  try {
    const { slug, ctx } = await resolveWrite(form);
    const proposalId = uuid(form, "proposalId");
    const decisionRaw = text(form, "decision");
    if (decisionRaw !== "approved" && decisionRaw !== "rejected") throw new Error("decision must be approved or rejected");
    const note = text(form, "note").slice(0, 1000) || undefined;
    if (!canDecideProposals(ctx.roles)) throw new Error(`deciding a proposal requires client_admin or department_manager; your roles: ${ctx.roles.join(", ")}`);
    const r = await getDb().withContext(ctx, (tx) => decideProposal(tx, ctx, { tenantId: ctx.tenantId, proposalId, decision: decisionRaw, note }));
    outcome = { ok: decisionRaw === "approved" ? `Proposal approved and written as a new document revision${r.documentId ? "" : ""}.` : "Proposal rejected; the document is unchanged." };
    return finish(slug, returnTo, outcome, ["/vault/review", "/vault"]);
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(null, returnTo, outcome);
}

// Facts ------------------------------------------------------------------------------------------------

const PROMOTABLE_FROM: readonly string[] = ["unconfirmed", "hypothesis", "evidence_backed"];
const TARGETS: readonly VerificationStatus[] = ["verified", "deprecated"];

export async function setFactVerificationAction(form: FormData): Promise<void> {
  const slugGuess = text(form, "slug");
  const fallback = SLUG_RE.test(slugGuess) ? `/c/${slugGuess}/vault/facts` : "/";
  const returnTo = safeReturn(form, fallback);
  let outcome: { ok?: string; error?: string };
  try {
    const { slug, ctx } = await resolveWrite(form);
    const factId = uuid(form, "factId");
    const target = text(form, "verification") as VerificationStatus;
    if (!TARGETS.includes(target)) throw new Error("verification must be verified or deprecated");
    const note = text(form, "note").slice(0, 1000) || undefined;
    if (!canReviewFacts(ctx.roles)) throw new Error(`changing a fact's verification requires the client_admin role; your roles: ${ctx.roles.join(", ")}`);
    await getDb().withContext(ctx, async (tx) => {
      const [fact] = await tx.select({ verification: schema.vaultFacts.verification }).from(schema.vaultFacts).where(eq(schema.vaultFacts.id, factId));
      if (!fact) throw new Error("fact not found in this workspace");
      if (target === "verified" && !PROMOTABLE_FROM.includes(fact.verification)) throw new Error(`a ${fact.verification} fact cannot be promoted to verified from here`);
      if (target === "deprecated" && fact.verification === "deprecated") throw new Error("fact is already deprecated");
      await setFactVerification(tx, ctx, { tenantId: ctx.tenantId, factId, verification: target, note: note ?? (target === "verified" ? "promoted by client admin" : "deprecated by client admin"), confidence: target === "verified" ? 0.9 : 0.1 });
    });
    outcome = { ok: target === "verified" ? "Fact promoted to verified; a new fact revision was recorded." : "Fact marked deprecated; it no longer appears in search or agent context." };
    return finish(slug, returnTo, outcome, ["/vault/facts", "/vault/review", "/inbox"]);
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(null, returnTo, outcome);
}

// Documents --------------------------------------------------------------------------------------------

function docRoute(slug: string, path: string): string {
  return `/c/${slug}/vault/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export async function revertDocumentAction(form: FormData): Promise<void> {
  const slugGuess = text(form, "slug");
  const pathGuess = text(form, "path");
  const fallback = SLUG_RE.test(slugGuess) ? (DOC_PATH_RE.test(pathGuess) ? docRoute(slugGuess, pathGuess) : `/c/${slugGuess}/vault`) : "/";
  const returnTo = safeReturn(form, fallback);
  let outcome: { ok?: string; error?: string };
  try {
    const { slug, ctx } = await resolveWrite(form);
    const documentId = uuid(form, "documentId");
    const toVersion = Number(text(form, "toVersion"));
    if (!Number.isInteger(toVersion) || toVersion < 1) throw new Error("toVersion must be a positive integer");
    if (!canEditDocuments(ctx.roles)) throw new Error(`restoring a revision requires client_admin or department_manager; your roles: ${ctx.roles.join(", ")}`);
    const r = await getDb().withContext(ctx, (tx) => revertDocument(tx, ctx, { tenantId: ctx.tenantId, documentId, toVersion, note: text(form, "note").slice(0, 500) || undefined }));
    outcome = { ok: `Version ${toVersion} restored as new version ${r.version}. History is kept; nothing was rewritten.` };
    return finish(slug, returnTo, outcome, ["/vault"]);
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(null, returnTo, outcome);
}

export async function saveDocumentAction(form: FormData): Promise<void> {
  const slugGuess = text(form, "slug");
  const pathGuess = text(form, "path");
  const fallback = SLUG_RE.test(slugGuess) ? (DOC_PATH_RE.test(pathGuess) ? docRoute(slugGuess, pathGuess) : `/c/${slugGuess}/vault`) : "/";
  const returnTo = safeReturn(form, fallback);
  let outcome: { ok?: string; error?: string };
  try {
    const { slug, ctx } = await resolveWrite(form);
    if (!canEditDocuments(ctx.roles)) throw new Error(`editing requires client_admin or department_manager; your roles: ${ctx.roles.join(", ")}`);
    const path = pathGuess;
    if (!DOC_PATH_RE.test(path) || path.includes("..")) throw new Error("path must be <NN_folder>/<name>.md");
    if (!VAULT_FOLDERS.includes(path.split("/")[0]!)) throw new Error(`folder ${path.split("/")[0]} is not one of the 20 standard vault folders`);
    const title = text(form, "title").slice(0, 200);
    if (!title) throw new Error("title is required");
    const frontmatter = parseFrontmatterInput(text(form, "frontmatter"));
    const body = form.get("body");
    const bodyMarkdown = typeof body === "string" ? body.replace(/\r\n/g, "\n") : "";
    if (bodyMarkdown.length > 200_000) throw new Error("body is too long (max 200000 characters)");
    const changeNote = text(form, "changeNote").slice(0, 500) || "edited in the vault browser";
    const classificationRaw = text(form, "classification");
    const classification = (["public", "internal", "confidential", "restricted"] as const).find((c) => c === classificationRaw);
    const isNew = text(form, "mode") === "create";
    const r = await getDb().withContext(ctx, async (tx) => {
      const [existing] = await tx.select({ id: vaultDocuments.id, classification: vaultDocuments.classification, verification: vaultDocuments.verification }).from(vaultDocuments).where(eq(vaultDocuments.path, path));
      if (isNew && existing) throw new Error(`a document already exists at ${path}`);
      if (!isNew && !existing) throw new Error("document not found (it may be restricted or was removed)");
      // Keep the current classification and verification unless the editor sets a classification explicitly;
      // only client admins may mark a document restricted.
      const nextClassification = classification ?? existing?.classification ?? "confidential";
      if (nextClassification === "restricted" && !ctx.roles.includes("client_admin")) throw new Error("only the client admin may classify a document as restricted");
      const written = await writeVaultDocument(tx, ctx, { tenantId: ctx.tenantId, path, title, frontmatter, bodyMarkdown, classification: nextClassification, verification: existing?.verification === "deprecated" ? "unconfirmed" : (existing?.verification ?? "unconfirmed"), changeNote });
      await syncDocumentLinks(tx, ctx.tenantId, written.documentId, bodyMarkdown);
      return written;
    });
    outcome = { ok: isNew ? `Document created (version ${r.version}). Links were indexed.` : `Saved as version ${r.version}. Links were re-indexed; the previous version stays in the revision list.` };
    return finish(slug, docRoute(slug, path), outcome, ["/vault"]);
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(null, returnTo, outcome);
}

// Settings ---------------------------------------------------------------------------------------------

export async function saveWriteModePolicyAction(form: FormData): Promise<void> {
  const slugGuess = text(form, "slug");
  const fallback = SLUG_RE.test(slugGuess) ? `/c/${slugGuess}/vault/settings` : "/";
  const returnTo = safeReturn(form, fallback);
  let outcome: { ok?: string; error?: string };
  try {
    const { slug, ctx } = await resolveWrite(form);
    if (!canManageVaultSettings(ctx.roles)) throw new Error(`vault settings require the client_admin role; your roles: ${ctx.roles.join(", ")}`);
    const folders: Record<string, string> = {};
    for (const folder of VAULT_FOLDERS) folders[folder] = text(form, `folder:${folder}`);
    const value = buildWriteModePolicy({ default: text(form, "default"), folders });
    await getDb().withContext(ctx, (tx) => setTenantPolicy(tx, ctx, { tenantId: ctx.tenantId, key: "vault.agent_write_mode", value }));
    const overrides = Object.keys(value).length - 1;
    outcome = { ok: `Agent write mode saved: default ${value.default}, ${overrides} folder override${overrides === 1 ? "" : "s"}. Agents read this policy on their next write.` };
    return finish(slug, returnTo, outcome);
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(null, returnTo, outcome);
}

/** Next.js implements redirect() by throwing; never swallow that into an `?error=` notice. */
function isRedirect(err: unknown): boolean {
  return typeof err === "object" && err !== null && "digest" in err && typeof (err as { digest?: unknown }).digest === "string" && (err as { digest: string }).digest.startsWith("NEXT_REDIRECT");
}
