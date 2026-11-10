import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { schema, writeAudit, type AgencyContext, type RequestContext, type Tx } from "@sbos/db";
import { AuthorizationError } from "./errors";

/**
 * Technology Intelligence Center (spec 4D, Milestone 6). Approved sources are checked by the worker on a
 * schedule; every detected item becomes a `tech_updates` row that carries the UpgradeProposal fields. The
 * lifecycle detected -> assessed -> approved -> applied (or rejected, rolled_back) is enforced by the database
 * trigger `enforce_upgrade_transition`: agents may detect and assess, only reviewers approve, apply or roll back;
 * a code update needs a pull request, a skill update a new immutable skill version, a knowledge update a
 * published agency record; applying needs a recorded test result. Nothing here touches production systems:
 * applying a skill update moves the stable release channel, applying a code update only records the merged
 * pull request, applying a knowledge update only records the published record.
 */
const { techSources, techUpdates, techWatchRuns, skillReleaseChannels, skillVersions } = schema;

export type UpgradeKind = (typeof schema.upgradeKind.enumValues)[number];
export type UpgradeStatus = (typeof schema.upgradeStatus.enumValues)[number];
export type SecurityRisk = (typeof schema.securityRisk.enumValues)[number];

const REVIEWERS = ["agency_reviewer", "superadmin"] as const;

function assertAgency(ctx: RequestContext, what: string): asserts ctx is AgencyContext {
  if (ctx.kind !== "agency") throw new AuthorizationError(`${what} runs in agency scope only`);
}
function hasRole(ctx: RequestContext, roles: readonly string[]): boolean {
  return ctx.roles.some((r) => roles.includes(r));
}

// Sources ------------------------------------------------------------------------------------------

export interface RegisterTechSourceInput {
  key: string;
  name: string;
  kind: (typeof schema.techSourceKind.enumValues)[number];
  fetchKind?: (typeof schema.techFetchKind.enumValues)[number];
  url: string;
  relevantAgentKeys?: string[];
  checkIntervalHours?: number;
}

export async function registerTechSource(tx: Tx, ctx: RequestContext, input: RegisterTechSourceInput): Promise<string> {
  assertAgency(ctx, "registering a technology source");
  if (ctx.actorType === "agent") throw new AuthorizationError("agents cannot register sources; they may only propose them in a note");
  const [row] = await tx
    .insert(techSources)
    .values({ key: input.key, name: input.name, kind: input.kind, fetchKind: input.fetchKind ?? "manual", url: input.url, relevantAgentKeys: input.relevantAgentKeys ?? [], checkIntervalHours: input.checkIntervalHours ?? 24, createdByActorId: ctx.actorId })
    .onConflictDoNothing({ target: techSources.key })
    .returning({ id: techSources.id });
  const id = row?.id ?? (await tx.select({ id: techSources.id }).from(techSources).where(eq(techSources.key, input.key)))[0]!.id;
  if (row) await writeAudit(tx, ctx, { action: "tech_source.registered", entityType: "tech_source", entityId: id, after: { key: input.key, url: input.url } });
  return id;
}

/** Only an approved source is ever fetched. Approval is a reviewer decision recorded with actor and time. */
export async function setTechSourceApproval(tx: Tx, ctx: RequestContext, input: { sourceId: string; approved: boolean; note: string }): Promise<void> {
  assertAgency(ctx, "approving a technology source");
  if (!hasRole(ctx, REVIEWERS) || ctx.actorType === "agent") throw new AuthorizationError("approving a source requires agency_reviewer or superadmin");
  await tx.update(techSources).set(input.approved ? { approved: true, approvedBy: ctx.actorId, approvedAt: new Date() } : { approved: false, approvedBy: null, approvedAt: null }).where(eq(techSources.id, input.sourceId));
  await writeAudit(tx, ctx, { action: input.approved ? "tech_source.approved" : "tech_source.unapproved", entityType: "tech_source", entityId: input.sourceId, metadata: { note: input.note } });
}

export async function dueTechSources(tx: Tx, ctx: RequestContext, now = new Date()) {
  assertAgency(ctx, "listing due sources");
  return tx
    .select({ id: techSources.id, key: techSources.key, name: techSources.name, kind: techSources.kind, fetchKind: techSources.fetchKind, url: techSources.url, relevantAgentKeys: techSources.relevantAgentKeys })
    .from(techSources)
    .where(and(eq(techSources.approved, true), sql`${techSources.fetchKind} <> 'manual'`, or(isNull(techSources.lastCheckedAt), lt(techSources.lastCheckedAt, sql`${now.toISOString()}::timestamptz - make_interval(hours => ${techSources.checkIntervalHours})`))));
}

export interface DetectedItem {
  externalId: string;
  subject: string;
  proposedVersion: string;
  sourceUrl: string;
  publishedAt: Date;
  summary?: string;
  raw?: Record<string, unknown>;
}

/** Records what a watch run found; known items are ignored (unique per source and external id). */
export async function recordDetectedUpdates(tx: Tx, ctx: RequestContext, input: { sourceId: string; items: DetectedItem[]; mode: "live" | "fixture"; status: "succeeded" | "failed" | "skipped"; errorMessage?: string | null }): Promise<{ newUpdates: number }> {
  assertAgency(ctx, "recording detected updates");
  const [source] = await tx.select({ approved: techSources.approved, relevantAgentKeys: techSources.relevantAgentKeys }).from(techSources).where(eq(techSources.id, input.sourceId));
  if (!source) throw new Error("source not found");
  if (!source.approved) throw new Error("updates are recorded for approved sources only");
  let newUpdates = 0;
  for (const item of input.items) {
    const [row] = await tx
      .insert(techUpdates)
      .values({ sourceId: input.sourceId, externalId: item.externalId.slice(0, 300), subject: item.subject.slice(0, 200), proposedVersion: item.proposedVersion.slice(0, 80), sourceUrl: item.sourceUrl, publishedAt: item.publishedAt, summary: (item.summary ?? "").slice(0, 4000), relevantAgentKeys: source.relevantAgentKeys, raw: item.raw ?? {} })
      .onConflictDoNothing({ target: [techUpdates.sourceId, techUpdates.externalId] })
      .returning({ id: techUpdates.id });
    if (row) newUpdates++;
  }
  await tx.insert(techWatchRuns).values({ sourceId: input.sourceId, mode: input.mode, status: input.status, itemsSeen: input.items.length, updatesNew: newUpdates, errorMessage: input.errorMessage ? input.errorMessage.slice(0, 500) : null });
  await tx.update(techSources).set({ lastCheckedAt: new Date(), lastError: input.errorMessage ? input.errorMessage.slice(0, 500) : null }).where(eq(techSources.id, input.sourceId));
  return { newUpdates };
}

// Update lifecycle ---------------------------------------------------------------------------------

export interface AssessUpdateInput {
  updateId: string;
  kind: UpgradeKind;
  securityRisk: SecurityRisk;
  potentialBenefit: string;
  compatibilityNotes: string;
  migrationPlan: string;
  rollbackPlan: string;
  currentVersion?: string | null;
  relevantAgentKeys?: string[];
  pullRequestUrl?: string | null;
  skillVersionId?: string | null;
  knowledgeRecordId?: string | null;
  note?: string;
}

/** Fills the UpgradeProposal fields and moves the update to `assessed`. The Technology Intelligence agent may do this. */
export async function assessUpdate(tx: Tx, ctx: RequestContext, input: AssessUpdateInput): Promise<void> {
  assertAgency(ctx, "assessing an update");
  await tx
    .update(techUpdates)
    .set({ kind: input.kind, securityRisk: input.securityRisk, potentialBenefit: input.potentialBenefit, compatibilityNotes: input.compatibilityNotes, migrationPlan: input.migrationPlan, rollbackPlan: input.rollbackPlan, currentVersion: input.currentVersion ?? undefined, relevantAgentKeys: input.relevantAgentKeys ?? undefined, pullRequestUrl: input.pullRequestUrl ?? undefined, skillVersionId: input.skillVersionId ?? undefined, knowledgeRecordId: input.knowledgeRecordId ?? undefined })
    .where(eq(techUpdates.id, input.updateId));
  await tx.update(techUpdates).set({ status: "assessed" }).where(eq(techUpdates.id, input.updateId));
  await annotateLastTransition(tx, input.updateId, input.note);
  await writeAudit(tx, ctx, { action: "tech_update.assessed", entityType: "tech_update", entityId: input.updateId, after: { kind: input.kind, securityRisk: input.securityRisk } });
}

async function annotateLastTransition(tx: Tx, updateId: string, note?: string): Promise<void> {
  if (!note) return;
  await tx.execute(sql`UPDATE tech_update_transitions SET note = ${note} WHERE id = (SELECT id FROM tech_update_transitions WHERE update_id = ${updateId} ORDER BY created_at DESC LIMIT 1)`);
}

export async function decideUpdate(tx: Tx, ctx: RequestContext, input: { updateId: string; decision: "approved" | "rejected"; note: string }): Promise<void> {
  assertAgency(ctx, "deciding an update");
  if (!hasRole(ctx, REVIEWERS) || ctx.actorType === "agent") throw new AuthorizationError("deciding an upgrade requires agency_reviewer or superadmin");
  await tx.update(techUpdates).set({ status: input.decision }).where(eq(techUpdates.id, input.updateId));
  await annotateLastTransition(tx, input.updateId, input.note);
  await writeAudit(tx, ctx, { action: `tech_update.${input.decision}`, entityType: "tech_update", entityId: input.updateId, metadata: { note: input.note } });
}

/**
 * Applies an approved update with its test result. A skill update moves the stable release channel to the new
 * immutable version (previous version kept for rollback); agent instances that pin the old version are untouched
 * and listed in the result. Code and knowledge updates are recorded, not executed.
 */
export async function applyUpdate(tx: Tx, ctx: RequestContext, input: { updateId: string; testResult: string; note?: string }): Promise<{ channelMoved: boolean }> {
  assertAgency(ctx, "applying an update");
  if (!hasRole(ctx, REVIEWERS) || ctx.actorType === "agent") throw new AuthorizationError("applying an upgrade requires agency_reviewer or superadmin");
  if (input.testResult.trim().length < 5) throw new Error("a test result is required (what was run and the outcome)");
  const [u] = await tx.select({ kind: techUpdates.kind, status: techUpdates.status, skillVersionId: techUpdates.skillVersionId }).from(techUpdates).where(eq(techUpdates.id, input.updateId));
  if (!u) throw new Error("update not found");
  if (u.status !== "approved") throw new Error(`update is ${u.status}; only approved updates are applied`);
  let channelMoved = false;
  if (u.kind === "skill_update") {
    if (!u.skillVersionId) throw new Error("skill update has no skill version");
    const [ver] = await tx.select({ id: skillVersions.id, skillId: skillVersions.skillId }).from(skillVersions).where(eq(skillVersions.id, u.skillVersionId));
    if (!ver) throw new Error("skill version not found");
    const [channel] = await tx.select({ skillVersionId: skillReleaseChannels.skillVersionId }).from(skillReleaseChannels).where(and(eq(skillReleaseChannels.skillId, ver.skillId), eq(skillReleaseChannels.channel, "stable")));
    await tx.update(techUpdates).set({ previousSkillVersionId: channel?.skillVersionId ?? null }).where(eq(techUpdates.id, input.updateId));
    await tx
      .insert(skillReleaseChannels)
      .values({ skillId: ver.skillId, channel: "stable", skillVersionId: ver.id, updatedBy: ctx.actorId })
      .onConflictDoUpdate({ target: [skillReleaseChannels.skillId, skillReleaseChannels.channel], set: { skillVersionId: ver.id, updatedBy: ctx.actorId, updatedAt: new Date() } });
    await tx.update(skillVersions).set({ releaseChannel: "stable" }).where(eq(skillVersions.id, ver.id));
    channelMoved = true;
  }
  await tx.update(techUpdates).set({ testResult: input.testResult }).where(eq(techUpdates.id, input.updateId));
  await tx.update(techUpdates).set({ status: "applied" }).where(eq(techUpdates.id, input.updateId));
  await annotateLastTransition(tx, input.updateId, input.note ?? `test result: ${input.testResult.slice(0, 200)}`);
  await writeAudit(tx, ctx, { action: "tech_update.applied", entityType: "tech_update", entityId: input.updateId, after: { kind: u.kind, channelMoved }, metadata: { testResult: input.testResult.slice(0, 500) } });
  return { channelMoved };
}

/** Operator view: how many agent instances (across tenants) still pin another version of the same skill. Instances are never re-pinned by an upgrade. */
export async function pinnedInstanceCount(tx: Tx, ctx: RequestContext, skillVersionId: string): Promise<{ onThisVersion: number; onOtherVersions: number }> {
  if (ctx.kind === "tenant") throw new AuthorizationError("pinned instance counts are an operator view across tenants");
  const [row] = await tx
    .execute<{ this_version: number; other_versions: number }>(sql`SELECT count(*) FILTER (WHERE i.skill_version_id = ${skillVersionId})::int AS this_version, count(*) FILTER (WHERE i.skill_version_id <> ${skillVersionId})::int AS other_versions FROM agent_instances i JOIN skill_versions v ON v.id = i.skill_version_id WHERE v.skill_id = (SELECT skill_id FROM skill_versions WHERE id = ${skillVersionId})`)
    .then((r) => r.rows);
  return { onThisVersion: row?.this_version ?? 0, onOtherVersions: row?.other_versions ?? 0 };
}

/** Rolls an applied update back; a skill update restores the previous stable version. */
export async function rollbackUpdate(tx: Tx, ctx: RequestContext, input: { updateId: string; note: string }): Promise<{ channelRestored: boolean }> {
  assertAgency(ctx, "rolling back an update");
  if (!hasRole(ctx, REVIEWERS) || ctx.actorType === "agent") throw new AuthorizationError("rolling back requires agency_reviewer or superadmin");
  const [u] = await tx.select({ kind: techUpdates.kind, status: techUpdates.status, skillVersionId: techUpdates.skillVersionId, previousSkillVersionId: techUpdates.previousSkillVersionId }).from(techUpdates).where(eq(techUpdates.id, input.updateId));
  if (!u) throw new Error("update not found");
  let channelRestored = false;
  if (u.kind === "skill_update" && u.previousSkillVersionId && u.skillVersionId) {
    const [ver] = await tx.select({ skillId: skillVersions.skillId }).from(skillVersions).where(eq(skillVersions.id, u.skillVersionId));
    if (ver) {
      await tx.update(skillReleaseChannels).set({ skillVersionId: u.previousSkillVersionId, updatedBy: ctx.actorId, updatedAt: new Date() }).where(and(eq(skillReleaseChannels.skillId, ver.skillId), eq(skillReleaseChannels.channel, "stable")));
      channelRestored = true;
    }
  }
  await tx.update(techUpdates).set({ status: "rolled_back" }).where(eq(techUpdates.id, input.updateId));
  await annotateLastTransition(tx, input.updateId, input.note);
  await writeAudit(tx, ctx, { action: "tech_update.rolled_back", entityType: "tech_update", entityId: input.updateId, after: { channelRestored }, metadata: { note: input.note } });
  return { channelRestored };
}

export async function listTechUpdates(tx: Tx, ctx: RequestContext, input: { status?: UpgradeStatus; limit?: number } = {}) {
  assertAgency(ctx, "listing updates");
  const q = tx.select().from(techUpdates).orderBy(desc(techUpdates.detectedAt)).limit(Math.min(200, input.limit ?? 50));
  return input.status ? q.where(eq(techUpdates.status, input.status)) : q;
}

