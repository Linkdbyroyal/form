"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { agencyContext, schema, type AgencyContext, type Tx } from "@sbos/db";
import {
  addKnowledgeVersion,
  adoptTemplate,
  createKnowledgeRecord,
  createMethodologyTemplate,
  deprecateKnowledgeRecord,
  publishPromotion,
  recordEvaluationResult,
  reviewPromotion,
  revokeAdoption,
  rollbackAdoption,
  setCurrentVersion,
  transitionKnowledgeRecord,
  upsertEvaluationCase
} from "@sbos/core";
import { getDb } from "../db";
import { errorMessage, withNotice } from "../format";
import { parseFrontmatterInput } from "../client/vault-helpers";
import { requireAgencyContext } from "../request-context";
import { buildRecordPath, CLASSIFICATIONS, collectParameterValues, CONSENT_STATUSES, CREATABLE_ORIGINS, isClientFolder, parseJsonObject, parseTemplateParameters, PROMOTION_DECISIONS, RECORD_KINDS, recordHref, splitList } from "./agency-vault-helpers";

/**
 * Agency Intelligence Vault write actions (spec 4H). Each action resolves the agency context from the session
 * (`requireAgencyContext`: any agency role, MFA rule unchanged), validates the form, and calls the @sbos/core
 * service inside `withContext()` in AGENCY scope. The database triggers are the real gate (lifecycle,
 * reviewer roles, no self-approval, promotion checks, adoption pin); their error text is shown through
 * `?error=` on the redirect. Adoption, rollback and revocation run in agency scope pinned to the target tenant
 * (`agencyContext({ tenantId })`), the only way RLS lets one transaction read the agency record and write the
 * client's copy.
 */
const { methodologyTemplates, templateAdoptions } = schema;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEMPLATE_KEY_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const BASE = "/mission-control/agency-vault";

function field(form: FormData, name: string, options: { required?: boolean; max?: number } = {}): string {
  const raw = form.get(name);
  const value = typeof raw === "string" ? raw.trim() : "";
  if (options.required && value.length === 0) throw new Error(`${name} is required`);
  if (options.max && value.length > options.max) throw new Error(`${name} is longer than ${options.max} characters`);
  return value;
}

function uuidField(form: FormData, name: string): string {
  const v = field(form, name, { required: true });
  if (!UUID_RE.test(v)) throw new Error(`${name} must be a UUID`);
  return v;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${label} must be one of ${allowed.join(", ")}`);
}

function returnPath(form: FormData, fallback: string): string {
  const v = field(form, "returnTo");
  return v.startsWith("/") && !v.startsWith("//") ? v : fallback;
}

function isRedirect(err: unknown): boolean {
  return typeof err === "object" && err !== null && "digest" in err && typeof (err as { digest?: unknown }).digest === "string" && (err as { digest: string }).digest.startsWith("NEXT_REDIRECT");
}

/** Common tail: revalidate the vault pages and redirect with the outcome. Called outside try/catch because redirect() throws. */
function finish(returnTo: string, outcome: { ok?: string; error?: string }): never {
  revalidatePath(returnTo.split("?")[0] ?? returnTo);
  revalidatePath(BASE);
  revalidatePath(`${BASE}/templates`);
  revalidatePath(`${BASE}/reviews`);
  revalidatePath(`${BASE}/history`);
  revalidatePath("/agency");
  redirect(withNotice(returnTo, outcome));
}

/** Runs `fn` as the signed-in agency user in agency scope without a tenant. */
async function agencyWrite<T>(fn: (tx: Tx, ctx: AgencyContext) => Promise<T>): Promise<T> {
  const ctx = await requireAgencyContext();
  return getDb().withContext(ctx, (tx) => fn(tx, ctx));
}

/** Runs `fn` as the signed-in agency user in agency scope pinned to one tenant (adoptions). */
async function tenantPinnedWrite<T>(tenantId: string, fn: (tx: Tx, ctx: AgencyContext) => Promise<T>): Promise<T> {
  const base = await requireAgencyContext();
  const ctx = agencyContext({ tenantId, actorType: "user", actorId: base.actorId, roles: base.roles });
  return getDb().withContext(ctx, (tx) => fn(tx, ctx));
}

// Records -------------------------------------------------------------------------------------------

export async function createRecordAction(form: FormData): Promise<void> {
  const returnTo = returnPath(form, `${BASE}/new`);
  let outcome: { ok?: string; error?: string };
  try {
    const folder = field(form, "folder", { required: true });
    const path = buildRecordPath(folder, field(form, "fileName", { required: true, max: 200 }));
    const title = field(form, "title", { required: true, max: 200 });
    const kind = oneOf(field(form, "kind") || "other", RECORD_KINDS, "kind");
    const classification = oneOf(field(form, "classification") || "internal", CLASSIFICATIONS, "classification");
    const origin = oneOf(field(form, "origin") || "own", CREATABLE_ORIGINS, "origin");
    const license = field(form, "license", { max: 200 }) || null;
    const allowedUses = splitList(field(form, "allowedUses", { max: 1000 }));
    const relatedSkillKeys = splitList(field(form, "relatedSkillKeys", { max: 1000 }));
    const bodyMarkdown = field(form, "body", { required: true, max: 200_000 });
    const frontmatter = parseFrontmatterInput(field(form, "frontmatter", { max: 20_000 }));
    const changelog = field(form, "changelog", { max: 500 }) || "initial version";
    const evidenceLink = field(form, "evidenceLink", { max: 1000 }) || null;
    if (origin === "public_license" && !license) throw new Error("a public_license record must name its license");
    const created = await agencyWrite((tx, ctx) => createKnowledgeRecord(tx, ctx, { path, title, kind, bodyMarkdown, frontmatter, changelog, classification, origin, license, allowedUses, relatedSkillKeys, evidenceLink }));
    return finish(recordHref(created.recordId), { ok: `Record created as draft at ${path} (version 1).` });
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

export async function addVersionAction(form: FormData): Promise<void> {
  const recordIdGuess = field(form, "recordId");
  const returnTo = returnPath(form, UUID_RE.test(recordIdGuess) ? recordHref(recordIdGuess) : BASE);
  let outcome: { ok?: string; error?: string };
  try {
    const recordId = uuidField(form, "recordId");
    const bodyMarkdown = field(form, "body", { required: true, max: 200_000 });
    const changelog = field(form, "changelog", { required: true, max: 500 });
    const evidenceLink = field(form, "evidenceLink", { max: 1000 }) || null;
    const frontmatter = parseFrontmatterInput(field(form, "frontmatter", { max: 20_000 }));
    const r = await agencyWrite((tx, ctx) => addKnowledgeVersion(tx, ctx, { recordId, bodyMarkdown, frontmatter, changelog, evidenceLink }));
    outcome = { ok: r.current ? `Version ${r.version} added and made current (record is still ${"draft or in review"}).` : `Version ${r.version} stored. It is not released: a reviewer releases it with "Make current" so adopters never see an unauthorised change.` };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

const TRANSITIONS = ["in_review", "draft", "approved", "published"] as const;
const DEPRECATIONS = ["deprecate", "reinstate", "archive"] as const;

export async function recordLifecycleAction(form: FormData): Promise<void> {
  const recordIdGuess = field(form, "recordId");
  const returnTo = returnPath(form, UUID_RE.test(recordIdGuess) ? recordHref(recordIdGuess) : BASE);
  let outcome: { ok?: string; error?: string };
  try {
    const recordId = uuidField(form, "recordId");
    const action = field(form, "action", { required: true });
    const note = field(form, "note", { max: 1000 });
    if ((TRANSITIONS as readonly string[]).includes(action)) {
      const to = action as (typeof TRANSITIONS)[number];
      await agencyWrite((tx, ctx) => transitionKnowledgeRecord(tx, ctx, { recordId, to, ...(note ? { note } : {}) }));
      outcome = { ok: `Record is now ${to.replaceAll("_", " ")}. The transition and its actor are logged.` };
    } else if ((DEPRECATIONS as readonly string[]).includes(action)) {
      const kind = action as (typeof DEPRECATIONS)[number];
      if (!note) throw new Error(`${kind} needs a reason`);
      const r = await agencyWrite((tx, ctx) => deprecateKnowledgeRecord(tx, ctx, { recordId, reason: note, kind }));
      outcome = { ok: `${kind} recorded. ${r.affectedAdoptions} active adoption(s) keep their pinned version; nothing changed in any client vault.` };
    } else {
      throw new Error("unknown lifecycle action");
    }
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

export async function setCurrentVersionAction(form: FormData): Promise<void> {
  const recordIdGuess = field(form, "recordId");
  const returnTo = returnPath(form, UUID_RE.test(recordIdGuess) ? recordHref(recordIdGuess) : BASE);
  let outcome: { ok?: string; error?: string };
  try {
    const recordId = uuidField(form, "recordId");
    const versionId = uuidField(form, "versionId");
    const reason = field(form, "reason", { required: true, max: 1000 });
    const r = await agencyWrite((tx, ctx) => setCurrentVersion(tx, ctx, { recordId, versionId, reason }));
    outcome = { ok: `${r.kind === "rollback" ? "Rollback" : "Release"} recorded. ${r.affectedAdoptions} active adoption(s) still run another version; adopt again per tenant to move them.` };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

// Evaluation cases ------------------------------------------------------------------------------------

export async function upsertEvaluationCaseAction(form: FormData): Promise<void> {
  const recordIdGuess = field(form, "recordId");
  const returnTo = returnPath(form, UUID_RE.test(recordIdGuess) ? recordHref(recordIdGuess) : BASE);
  let outcome: { ok?: string; error?: string };
  try {
    const recordId = uuidField(form, "recordId");
    const name = field(form, "name", { required: true, max: 120 });
    const input = parseJsonObject(field(form, "input", { max: 20_000 }), "input");
    const expected = parseJsonObject(field(form, "expected", { max: 20_000 }), "expected");
    await agencyWrite((tx, ctx) => upsertEvaluationCase(tx, ctx, { recordId, name, input, expected }));
    outcome = { ok: `Evaluation case "${name}" saved (result: not run).` };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

export async function recordEvaluationResultAction(form: FormData): Promise<void> {
  const recordIdGuess = field(form, "recordId");
  const returnTo = returnPath(form, UUID_RE.test(recordIdGuess) ? recordHref(recordIdGuess) : BASE);
  let outcome: { ok?: string; error?: string };
  try {
    const caseId = uuidField(form, "caseId");
    const versionId = uuidField(form, "versionId");
    const result = oneOf(field(form, "result", { required: true }), ["pass", "fail"] as const, "result");
    await agencyWrite((tx, ctx) => recordEvaluationResult(tx, ctx, { caseId, versionId, result }));
    outcome = { ok: `Evaluation result ${result} recorded against the chosen version (manual run; the Agency Knowledge Curator Agent that would run cases is planned).` };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

// Templates and adoptions -----------------------------------------------------------------------------

export async function createTemplateAction(form: FormData): Promise<void> {
  const returnTo = returnPath(form, `${BASE}/templates`);
  let outcome: { ok?: string; error?: string };
  try {
    const recordId = uuidField(form, "recordId");
    const key = field(form, "key", { required: true, max: 64 });
    if (!TEMPLATE_KEY_RE.test(key)) throw new Error("key must be 2 to 64 lowercase letters, digits or dashes");
    const name = field(form, "name", { required: true, max: 200 });
    const description = field(form, "description", { required: true, max: 2000 });
    const targetFolder = field(form, "targetFolder", { required: true });
    if (!isClientFolder(targetFolder)) throw new Error(`target folder "${targetFolder}" is not a client vault folder`);
    const parameters = parseTemplateParameters(field(form, "parameters", { max: 20_000 }));
    await agencyWrite((tx, ctx) => createMethodologyTemplate(tx, ctx, { key, recordId, name, description, targetFolder, parameters }));
    outcome = { ok: `Template ${key} created with ${parameters.length} parameter(s). It can be adopted once its record is published.` };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

export async function adoptTemplateAction(form: FormData): Promise<void> {
  const returnTo = returnPath(form, `${BASE}/templates`);
  let outcome: { ok?: string; error?: string };
  try {
    const tenantId = uuidField(form, "tenantId");
    const templateKey = field(form, "templateKey", { required: true, max: 64 });
    const versionRaw = field(form, "versionId");
    const versionId = versionRaw ? uuidField(form, "versionId") : undefined;
    const note = field(form, "note", { max: 500 }) || undefined;
    const r = await tenantPinnedWrite(tenantId, async (tx, ctx) => {
      const [tpl] = await tx.select({ parameters: methodologyTemplates.parameters }).from(methodologyTemplates).where(eq(methodologyTemplates.key, templateKey));
      if (!tpl) throw new Error(`template "${templateKey}" not found`);
      const parameters = collectParameterValues(tpl.parameters, (name) => field(form, name, { max: 2000 }));
      return adoptTemplate(tx, ctx, { tenantId, templateKey, parameters, ...(versionId ? { versionId } : {}), ...(note ? { note } : {}) });
    });
    outcome = { ok: `Adopted ${templateKey} v${r.version} into the tenant at ${r.path}; the client's copy carries the tenant's own values. Adoption ${r.adoptionId.slice(0, 8)} is pinned to v${r.version}.` };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

export async function rollbackAdoptionAction(form: FormData): Promise<void> {
  const returnTo = returnPath(form, `${BASE}/templates`);
  let outcome: { ok?: string; error?: string };
  try {
    const tenantId = uuidField(form, "tenantId");
    const adoptionId = uuidField(form, "adoptionId");
    const reason = field(form, "reason", { required: true, max: 500 });
    const r = await tenantPinnedWrite(tenantId, async (tx, ctx) => {
      const [a] = await tx.select({ id: templateAdoptions.id }).from(templateAdoptions).where(eq(templateAdoptions.id, adoptionId));
      if (!a) throw new Error("adoption not found in this tenant");
      return rollbackAdoption(tx, ctx, { tenantId, adoptionId, reason });
    });
    outcome = { ok: `Rolled back to v${r.version}: the client document got a new revision with the earlier version's text and values; adoption ${r.adoptionId.slice(0, 8)} is now active.` };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

export async function revokeAdoptionAction(form: FormData): Promise<void> {
  const returnTo = returnPath(form, `${BASE}/templates`);
  let outcome: { ok?: string; error?: string };
  try {
    const tenantId = uuidField(form, "tenantId");
    const adoptionId = uuidField(form, "adoptionId");
    const reason = field(form, "reason", { required: true, max: 500 });
    await tenantPinnedWrite(tenantId, (tx, ctx) => revokeAdoption(tx, ctx, { tenantId, adoptionId, reason }));
    outcome = { ok: "Adoption revoked. The client's document stays in its vault, marked sbos_template_revoked_at in its frontmatter." };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

// Promotion reviews -----------------------------------------------------------------------------------

export async function reviewPromotionAction(form: FormData): Promise<void> {
  const returnTo = returnPath(form, `${BASE}/reviews`);
  let outcome: { ok?: string; error?: string };
  try {
    const requestId = uuidField(form, "requestId");
    const decision = oneOf(field(form, "decision", { required: true }), PROMOTION_DECISIONS, "decision");
    const note = field(form, "note", { required: true, max: 2000 });
    const consentRaw = field(form, "consentStatus");
    const consentStatus = consentRaw ? oneOf(consentRaw, CONSENT_STATUSES, "consent status") : undefined;
    const rightsBasis = field(form, "rightsBasis", { max: 500 }) || undefined;
    const state = await agencyWrite((tx, ctx) =>
      reviewPromotion(tx, ctx, {
        requestId,
        decision,
        rightsCheck: form.get("rightsCheck") === "on",
        securityCheck: form.get("securityCheck") === "on",
        identifiabilityCheck: form.get("identifiabilityCheck") === "on",
        note,
        ...(consentStatus ? { consentStatus } : {}),
        ...(rightsBasis ? { rightsBasis } : {})
      })
    );
    outcome = { ok: state === "approved" ? "Review recorded; the request is approved. Nothing is published yet: use the publish form to create the agency record." : state === "rejected" ? "Review recorded; the request is rejected." : "Review recorded; the request goes back to nominated for changes." };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

export async function publishPromotionAction(form: FormData): Promise<void> {
  const returnTo = returnPath(form, `${BASE}/reviews`);
  let outcome: { ok?: string; error?: string };
  try {
    const requestId = uuidField(form, "requestId");
    const folder = field(form, "folder", { required: true });
    const path = buildRecordPath(folder, field(form, "fileName", { required: true, max: 200 }));
    const kind = oneOf(field(form, "kind") || "reusable_insight", RECORD_KINDS, "kind");
    const title = field(form, "title", { max: 200 }) || undefined;
    const bodyMarkdown = field(form, "body", { max: 200_000 }) || undefined;
    const license = field(form, "license", { max: 200 }) || null;
    const allowedUses = splitList(field(form, "allowedUses", { max: 1000 }));
    const relatedSkillKeys = splitList(field(form, "relatedSkillKeys", { max: 1000 }));
    const r = await agencyWrite((tx, ctx) => publishPromotion(tx, ctx, { requestId, path, kind, ...(title ? { title } : {}), ...(bodyMarkdown ? { bodyMarkdown } : {}), license, ...(allowedUses.length > 0 ? { allowedUses } : {}), relatedSkillKeys }));
    return finish(recordHref(r.recordId), { ok: `Published as ${path}. The record carries the rights basis and the request id, no tenant identifier and no source references.` });
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}
