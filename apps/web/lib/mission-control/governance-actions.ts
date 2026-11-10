"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { agencyContext, schema, writeAudit, type AgencyContext, type Tx } from "@sbos/db";
import { applyUpdate, assessUpdate, completeDeletionManually, decideDeletion, decideUpdate, registerTechSource, rollbackUpdate, setRetentionPolicy, setTechSourceApproval } from "@sbos/core";
import { getDb } from "../db";
import { errorMessage, withNotice } from "../format";
import { requireAgencyContext, requireOperatorContext } from "../request-context";
import { CHECK_INTERVAL_MAX, CHECK_INTERVAL_MIN, GOVERNANCE_BASE, isDataClass, isGithubPullRequestUrl, isHttpsUrl, isSourceKey, isValidCheckInterval, parseAgentKeys, SECURITY_RISKS, TECH_FETCH_KINDS, TECH_SOURCE_KINDS, TECH_WATCH_BASE, UPGRADE_KINDS, updateHref, deletionRequestHref, validateRetentionDays } from "./governance-helpers";

/**
 * Technology Intelligence Center and data governance write actions (Milestone 6, ADR-022).
 *
 * Tech Watch and Upgrade Center actions resolve the agency context from the session (`requireAgencyContext`,
 * any agency role) and call the @sbos/core service inside `withContext()` in AGENCY scope. The database trigger
 * `enforce_upgrade_transition` is the real gate (transition table, reviewer roles, artefact per kind, test
 * result before applying); its text is shown through `?error=` on the redirect. Nothing here touches a
 * production system: applying a skill update moves the stable release channel, applying a code update only
 * records the merged pull request.
 *
 * Deletion decisions run as the signed-in operator in agency scope pinned to the request's tenant
 * (`agencyContext({ tenantId })`), the pattern of `tools-actions.ts`; the trigger `enforce_deletion_request`
 * demands the reviewer or superadmin role there. Platform retention defaults are set by a superadmin in agency
 * scope with tenantId null. The web app never executes a deletion or a sweep: the worker does.
 */
const { techSources, skills, skillVersions, deletionRequests } = schema;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

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

/** Common tail: revalidate the governance pages and redirect with the outcome. Called outside try/catch because redirect() throws. */
function finish(returnTo: string, outcome: { ok?: string; error?: string }): never {
  revalidatePath(returnTo.split("?")[0] ?? returnTo);
  revalidatePath(TECH_WATCH_BASE);
  revalidatePath(GOVERNANCE_BASE);
  revalidatePath("/mission-control/agency-vault");
  redirect(withNotice(returnTo, outcome));
}

/** Runs `fn` as the signed-in agency user in agency scope without a tenant. */
async function agencyWrite<T>(fn: (tx: Tx, ctx: AgencyContext) => Promise<T>): Promise<T> {
  const ctx = await requireAgencyContext();
  return getDb().withContext(ctx, (tx) => fn(tx, ctx));
}

/** Runs `fn` as the signed-in operator in agency scope pinned to one tenant (deletion decisions). */
async function tenantPinnedWrite<T>(tenantId: string, fn: (tx: Tx, ctx: AgencyContext) => Promise<T>): Promise<T> {
  const op = await requireOperatorContext();
  const ctx = agencyContext({ tenantId, actorType: "user", actorId: op.actorId, roles: op.roles });
  return getDb().withContext(ctx, (tx) => fn(tx, ctx));
}

function updateReturn(form: FormData): string {
  const id = field(form, "updateId");
  return returnPath(form, UUID_RE.test(id) ? updateHref(id) : TECH_WATCH_BASE);
}

// Sources -------------------------------------------------------------------------------------------

export async function registerSourceAction(form: FormData): Promise<void> {
  const returnTo = returnPath(form, TECH_WATCH_BASE);
  let outcome: { ok?: string; error?: string };
  try {
    const key = field(form, "key", { required: true, max: 64 }).toLowerCase();
    if (!isSourceKey(key)) throw new Error("key must be 2 to 64 lowercase letters, digits or dashes");
    const name = field(form, "name", { required: true, max: 200 });
    const kind = oneOf(field(form, "kind", { required: true }), TECH_SOURCE_KINDS, "kind");
    const fetchKind = oneOf(field(form, "fetchKind") || "manual", TECH_FETCH_KINDS, "fetch kind");
    const url = field(form, "url", { required: true, max: 1000 });
    if (!isHttpsUrl(url)) throw new Error("url must start with https://");
    const relevantAgentKeys = parseAgentKeys(field(form, "relevantAgentKeys", { max: 1000 }));
    const intervalRaw = field(form, "checkIntervalHours") || "24";
    const checkIntervalHours = Number(intervalRaw);
    if (!isValidCheckInterval(checkIntervalHours)) throw new Error(`check interval must be a whole number of hours between ${CHECK_INTERVAL_MIN} and ${CHECK_INTERVAL_MAX}`);
    const id = await agencyWrite(async (tx, ctx) => {
      const [existing] = await tx.select({ id: techSources.id }).from(techSources).where(eq(techSources.key, key));
      if (existing) throw new Error(`a source with key ${key} already exists`);
      return registerTechSource(tx, ctx, { key, name, kind, fetchKind, url, relevantAgentKeys, checkIntervalHours });
    });
    outcome = { ok: `Source ${key} registered (${id.slice(0, 8)}), not approved. Only an approved source is ever fetched; a reviewer approves it below.` };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

export async function setSourceApprovalAction(form: FormData): Promise<void> {
  const returnTo = returnPath(form, TECH_WATCH_BASE);
  let outcome: { ok?: string; error?: string };
  try {
    const sourceId = uuidField(form, "sourceId");
    const approved = field(form, "approved", { required: true }) === "true";
    const note = field(form, "note", { required: true, max: 1000 });
    const key = await agencyWrite(async (tx, ctx) => {
      const [s] = await tx.select({ key: techSources.key }).from(techSources).where(eq(techSources.id, sourceId));
      if (!s) throw new Error("source not found");
      await setTechSourceApproval(tx, ctx, { sourceId, approved, note });
      return s.key;
    });
    outcome = { ok: approved ? `Source ${key} approved; the worker fetches it on its interval (fixture mode in this sandbox). Approval is recorded with your actor id and the time.` : `Source ${key} unapproved; the worker skips it from now on. Existing detected updates stay.` };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

// Skill versions (tiny helper so a skill update can reference a new immutable version) -----------------

export async function createSkillVersionAction(form: FormData): Promise<void> {
  const returnTo = updateReturn(form);
  let outcome: { ok?: string; error?: string };
  try {
    const skillId = uuidField(form, "skillId");
    const version = field(form, "version", { required: true, max: 80 });
    if (!SEMVER_RE.test(version)) throw new Error("version must be semantic (for example 0.3.0 or 0.3.0-rc1)");
    const skillMd = field(form, "skillMd", { required: true, max: 200_000 });
    const r = await agencyWrite(async (tx, ctx) => {
      if (ctx.actorType === "agent") throw new Error("agents cannot create skill versions");
      const [s] = await tx.select({ id: skills.id, key: skills.key }).from(skills).where(eq(skills.id, skillId));
      if (!s) throw new Error("skill not found");
      const [current] = await tx.select({ contracts: skillVersions.contracts, allowedTools: skillVersions.allowedTools }).from(skillVersions).where(eq(skillVersions.skillId, skillId)).limit(1);
      const checksum = `sha256:${createHash("sha256").update(skillMd).digest("hex")}`;
      const [row] = await tx
        .insert(skillVersions)
        .values({ skillId, version, skillMd, contracts: current?.contracts ?? [], allowedTools: current?.allowedTools ?? [], releaseChannel: "draft", checksum, createdBy: ctx.actorId })
        .returning({ id: skillVersions.id });
      if (!row) throw new Error("skill version insert returned nothing");
      await writeAudit(tx, ctx, { action: "skill_version.created", entityType: "skill_version", entityId: row.id, after: { skillKey: s.key, version, checksum } });
      return { id: row.id, key: s.key };
    });
    outcome = { ok: `Skill version ${r.key} ${version} stored as draft (${r.id.slice(0, 8)}). It is immutable; select it in the assessment as the new skill version. Nothing is released until the update is applied.` };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

// Update lifecycle ----------------------------------------------------------------------------------

export async function assessUpdateAction(form: FormData): Promise<void> {
  const returnTo = updateReturn(form);
  let outcome: { ok?: string; error?: string };
  try {
    const updateId = uuidField(form, "updateId");
    const kind = oneOf(field(form, "kind", { required: true }), UPGRADE_KINDS, "kind");
    const securityRisk = oneOf(field(form, "securityRisk", { required: true }), SECURITY_RISKS, "security risk");
    const potentialBenefit = field(form, "potentialBenefit", { required: true, max: 4000 });
    const compatibilityNotes = field(form, "compatibilityNotes", { required: true, max: 4000 });
    const migrationPlan = field(form, "migrationPlan", { required: true, max: 4000 });
    const rollbackPlan = field(form, "rollbackPlan", { required: true, max: 4000 });
    const currentVersion = field(form, "currentVersion", { max: 80 }) || null;
    const relevantAgentKeys = parseAgentKeys(field(form, "relevantAgentKeys", { max: 1000 }));
    const pullRequestUrl = field(form, "pullRequestUrl", { max: 1000 }) || null;
    if (pullRequestUrl && !isGithubPullRequestUrl(pullRequestUrl)) throw new Error("pull request url must look like https://github.com/<owner>/<repo>/pull/<number>");
    const skillVersionRaw = field(form, "skillVersionId");
    const skillVersionId = skillVersionRaw ? uuidField(form, "skillVersionId") : null;
    const knowledgeRecordRaw = field(form, "knowledgeRecordId");
    const knowledgeRecordId = knowledgeRecordRaw ? uuidField(form, "knowledgeRecordId") : null;
    const note = field(form, "note", { max: 1000 }) || undefined;
    await agencyWrite((tx, ctx) =>
      assessUpdate(tx, ctx, {
        updateId,
        kind,
        securityRisk,
        potentialBenefit,
        compatibilityNotes,
        migrationPlan,
        rollbackPlan,
        currentVersion,
        relevantAgentKeys,
        // Only the artefact of the chosen kind is stored; the others are left as they are.
        pullRequestUrl: kind === "code_update" ? pullRequestUrl : undefined,
        skillVersionId: kind === "skill_update" ? skillVersionId : undefined,
        knowledgeRecordId: kind === "knowledge_update" ? knowledgeRecordId : undefined,
        ...(note ? { note } : {})
      })
    );
    outcome = { ok: `Assessment recorded as ${kind.replaceAll("_", " ")} with security risk ${securityRisk}; the update is assessed. A reviewer approves or rejects it; approval needs the artefact of its kind.` };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

export async function decideUpdateAction(form: FormData): Promise<void> {
  const returnTo = updateReturn(form);
  let outcome: { ok?: string; error?: string };
  try {
    const updateId = uuidField(form, "updateId");
    const decision = oneOf(field(form, "decision", { required: true }), ["approved", "rejected"] as const, "decision");
    const note = field(form, "note", { required: true, max: 2000 });
    await agencyWrite((tx, ctx) => decideUpdate(tx, ctx, { updateId, decision, note }));
    outcome = { ok: decision === "approved" ? "Update approved. Nothing is applied yet: record the test result with Apply once the tests have run (a code update is merged by a human through its pull request)." : "Update rejected. The decision, your actor id and the note are in the timeline." };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

export async function applyUpdateAction(form: FormData): Promise<void> {
  const returnTo = updateReturn(form);
  let outcome: { ok?: string; error?: string };
  try {
    const updateId = uuidField(form, "updateId");
    const testResult = field(form, "testResult", { required: true, max: 4000 });
    const note = field(form, "note", { max: 1000 }) || undefined;
    const r = await agencyWrite((tx, ctx) => applyUpdate(tx, ctx, { updateId, testResult, ...(note ? { note } : {}) }));
    outcome = { ok: r.channelMoved ? "Applied: the stable release channel of the skill now points at the new version; the previous version is kept for rollback. Running agent instances stay pinned to their version." : "Applied: the update is recorded as applied with its test result. The platform executed nothing (code is merged by a human, knowledge is the published record)." };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

export async function rollbackUpdateAction(form: FormData): Promise<void> {
  const returnTo = updateReturn(form);
  let outcome: { ok?: string; error?: string };
  try {
    const updateId = uuidField(form, "updateId");
    const note = field(form, "note", { required: true, max: 2000 });
    const r = await agencyWrite((tx, ctx) => rollbackUpdate(tx, ctx, { updateId, note }));
    outcome = { ok: r.channelRestored ? "Rolled back: the stable release channel points at the previous skill version again." : "Rolled back: recorded in the timeline. For a code update the pull request is reverted by a human; for a knowledge update the record is deprecated in the agency vault." };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

// Platform retention defaults -----------------------------------------------------------------------

export async function setPlatformRetentionAction(form: FormData): Promise<void> {
  const returnTo = returnPath(form, GOVERNANCE_BASE);
  let outcome: { ok?: string; error?: string };
  try {
    const dataClass = field(form, "dataClass", { required: true });
    if (!isDataClass(dataClass)) throw new Error("unknown data class");
    const retentionDays = Number(field(form, "retentionDays", { required: true }));
    const invalid = validateRetentionDays(dataClass, retentionDays);
    if (invalid) throw new Error(invalid);
    const reason = field(form, "reason", { required: true, max: 1000 });
    await agencyWrite((tx, ctx) => setRetentionPolicy(tx, ctx, { tenantId: null, dataClass, retentionDays, reason }));
    outcome = { ok: `Platform default for ${dataClass.replaceAll("_", " ")} set to ${retentionDays} days. Tenants without an override follow it from the next sweep (Sundays 03:00 UTC).` };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

// Deletion requests ---------------------------------------------------------------------------------

function requestReturn(form: FormData): string {
  const id = field(form, "requestId");
  return returnPath(form, UUID_RE.test(id) ? deletionRequestHref(id) : GOVERNANCE_BASE);
}

export async function decideDeletionAction(form: FormData): Promise<void> {
  const returnTo = requestReturn(form);
  let outcome: { ok?: string; error?: string };
  try {
    const requestId = uuidField(form, "requestId");
    const tenantId = uuidField(form, "tenantId");
    const decision = oneOf(field(form, "decision", { required: true }), ["approved", "rejected"] as const, "decision");
    const note = field(form, "note", { required: true, max: 2000 });
    const legalHold = form.get("legalHold") === "on";
    const kind = await tenantPinnedWrite(tenantId, async (tx, ctx) => {
      const [r] = await tx.select({ kind: deletionRequests.kind }).from(deletionRequests).where(and(eq(deletionRequests.id, requestId), eq(deletionRequests.tenantId, tenantId)));
      if (!r) throw new Error("deletion request not found in that tenant");
      await decideDeletion(tx, ctx, { tenantId, requestId, decision, note, legalHold });
      return r.kind;
    });
    const automated = kind === "document" || kind === "connection_data";
    outcome = { ok: decision === "approved" ? (automated ? "Request approved. It is executed by the worker on its weekly schedule (Sundays 03:00 UTC); the counts appear here and in the client's workspace afterwards." : "Request approved. This kind is not automated: follow the runbook and record the outcome with Complete manually (superadmin).") : legalHold ? "Request rejected and marked legal hold; nothing is deleted." : "Request rejected; nothing is deleted. The note is visible to the client." };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}

export async function completeDeletionManuallyAction(form: FormData): Promise<void> {
  const returnTo = requestReturn(form);
  let outcome: { ok?: string; error?: string };
  try {
    const requestId = uuidField(form, "requestId");
    const tenantId = uuidField(form, "tenantId");
    const summary = field(form, "summary", { required: true, max: 4000 });
    await tenantPinnedWrite(tenantId, (tx, ctx) => completeDeletionManually(tx, ctx, { tenantId, requestId, summary }));
    outcome = { ok: "Request completed manually; the summary is stored on the request and an audit event records it. The client sees the summary in its workspace." };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(returnTo, outcome);
}
