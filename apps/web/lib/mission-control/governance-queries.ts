import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { agencyContext, operatorContext, schema, type AgencyContext, type OperatorContext, type Tx } from "@sbos/db";
import { DATA_CLASSES, effectiveRetention, pinnedInstanceCount, type DataClass } from "@sbos/core";
import { getDb } from "../db";
import { hasOperatorRole } from "./agency-vault-helpers";
import { UPGRADE_STATUSES, type UpgradeStatus } from "./governance-helpers";

/**
 * Technology Intelligence Center and data governance reads (Milestone 6).
 *
 * Tech Watch and the Upgrade Center run in AGENCY scope (`requireAgencyContext`): the tech tables are agency
 * knowledge and RLS returns them to agency scope only (migration 0009). Pinned instance counts are an operator
 * view across tenants (`pinnedInstanceCount`), so they are read with the operator context when the signed-in
 * user has an operator role, and shown as "operator role required" otherwise, like the Skills Registry.
 *
 * Deletion requests across tenants are listed through the operator role, whose column grant excludes
 * `subject_ref`, `reason`, `review_note` and `summary`: those are read in agency scope pinned to the tenant on
 * the detail page only. Platform retention defaults are agency-scope rows with tenant_id NULL.
 */
const { techSources, techUpdates, techUpdateTransitions, techWatchRuns, skills, skillVersions, skillReleaseChannels, agencyKnowledgeRecords, retentionPolicies, deletionRequests, tenants, users } = schema;

const num = (expr: SQL) => sql<number>`${expr}`.mapWith(Number);

function agencyRead<T>(ctx: AgencyContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().withContext(ctx, fn);
}

// Sources -------------------------------------------------------------------------------------------

export interface WatchRunView {
  id: string;
  mode: string;
  status: string;
  startedAt: Date;
  finishedAt: Date;
  itemsSeen: number;
  updatesNew: number;
  errorMessage: string | null;
}

export interface TechSourceRow {
  source: typeof techSources.$inferSelect;
  latestRun: WatchRunView | null;
  updates: number;
}

export async function listTechSources(ctx: AgencyContext): Promise<TechSourceRow[]> {
  return agencyRead(ctx, async (tx) => {
    const sources = await tx.select().from(techSources).orderBy(desc(techSources.approved), techSources.name);
    if (sources.length === 0) return [];
    const ids = sources.map((s) => s.id);
    const runs = await tx.select().from(techWatchRuns).where(inArray(techWatchRuns.sourceId, ids)).orderBy(desc(techWatchRuns.startedAt));
    const counts = await tx.select({ sourceId: techUpdates.sourceId, n: num(sql`count(*)`) }).from(techUpdates).where(inArray(techUpdates.sourceId, ids)).groupBy(techUpdates.sourceId);
    const countBySource = new Map(counts.map((c) => [c.sourceId, c.n]));
    const latest = new Map<string, WatchRunView>();
    for (const r of runs) if (!latest.has(r.sourceId)) latest.set(r.sourceId, r);
    return sources.map((s) => ({ source: s, latestRun: latest.get(s.id) ?? null, updates: countBySource.get(s.id) ?? 0 }));
  });
}

export async function listRecentWatchRuns(ctx: AgencyContext, limit = 20): Promise<Array<WatchRunView & { sourceName: string; sourceKey: string }>> {
  return agencyRead(ctx, (tx) =>
    tx
      .select({ id: techWatchRuns.id, mode: techWatchRuns.mode, status: techWatchRuns.status, startedAt: techWatchRuns.startedAt, finishedAt: techWatchRuns.finishedAt, itemsSeen: techWatchRuns.itemsSeen, updatesNew: techWatchRuns.updatesNew, errorMessage: techWatchRuns.errorMessage, sourceName: techSources.name, sourceKey: techSources.key })
      .from(techWatchRuns)
      .innerJoin(techSources, eq(techSources.id, techWatchRuns.sourceId))
      .orderBy(desc(techWatchRuns.startedAt))
      .limit(limit)
  );
}

// Updates -------------------------------------------------------------------------------------------

export interface TechUpdateRow {
  update: typeof techUpdates.$inferSelect;
  sourceName: string;
  sourceKey: string;
}

export interface UpdatesView {
  rows: TechUpdateRow[];
  counts: Map<UpgradeStatus, number>;
  total: number;
}

export async function listUpdates(ctx: AgencyContext, filter: { status?: string | null; limit?: number }): Promise<UpdatesView> {
  return agencyRead(ctx, async (tx) => {
    const byStatus = await tx.select({ status: techUpdates.status, n: num(sql`count(*)`) }).from(techUpdates).groupBy(techUpdates.status);
    const counts = new Map<UpgradeStatus, number>(UPGRADE_STATUSES.map((s) => [s, 0]));
    for (const r of byStatus) counts.set(r.status, r.n);
    const status = filter.status && (UPGRADE_STATUSES as readonly string[]).includes(filter.status) ? (filter.status as UpgradeStatus) : null;
    const base = tx.select({ update: techUpdates, sourceName: techSources.name, sourceKey: techSources.key }).from(techUpdates).innerJoin(techSources, eq(techSources.id, techUpdates.sourceId)).orderBy(desc(techUpdates.detectedAt)).limit(Math.min(200, filter.limit ?? 100));
    const rows = status ? await base.where(eq(techUpdates.status, status)) : await base;
    return { rows, counts, total: byStatus.reduce((a, b) => a + b.n, 0) };
  });
}

export interface SkillOption {
  id: string;
  key: string;
  name: string;
  stableVersionId: string | null;
  versions: Array<{ id: string; version: string; releaseChannel: string; createdAt: Date }>;
}

export interface UpdateDetail {
  update: typeof techUpdates.$inferSelect;
  source: typeof techSources.$inferSelect;
  transitions: Array<typeof techUpdateTransitions.$inferSelect>;
  skillVersion: { id: string; version: string; skillKey: string; skillName: string; releaseChannel: string } | null;
  previousSkillVersion: { id: string; version: string } | null;
  knowledgeRecord: { id: string; path: string; title: string; state: string } | null;
  /** Options for the assessment form. */
  skills: SkillOption[];
  publishedRecords: Array<{ id: string; path: string; title: string }>;
}

export async function getUpdateDetail(ctx: AgencyContext, id: string): Promise<UpdateDetail | null> {
  return agencyRead(ctx, async (tx) => {
    const [update] = await tx.select().from(techUpdates).where(eq(techUpdates.id, id));
    if (!update) return null;
    const [source] = await tx.select().from(techSources).where(eq(techSources.id, update.sourceId));
    if (!source) return null;
    const transitions = await tx.select().from(techUpdateTransitions).where(eq(techUpdateTransitions.updateId, id)).orderBy(techUpdateTransitions.createdAt);
    const sk = await tx.select().from(skills).orderBy(skills.key);
    const vs = await tx.select({ id: skillVersions.id, skillId: skillVersions.skillId, version: skillVersions.version, releaseChannel: skillVersions.releaseChannel, createdAt: skillVersions.createdAt }).from(skillVersions).orderBy(desc(skillVersions.createdAt));
    const ch = await tx.select({ skillId: skillReleaseChannels.skillId, skillVersionId: skillReleaseChannels.skillVersionId }).from(skillReleaseChannels).where(eq(skillReleaseChannels.channel, "stable"));
    const stable = new Map(ch.map((c) => [c.skillId, c.skillVersionId]));
    const skillOptions: SkillOption[] = sk.map((s) => ({ id: s.id, key: s.key, name: s.name, stableVersionId: stable.get(s.id) ?? null, versions: vs.filter((v) => v.skillId === s.id).map((v) => ({ id: v.id, version: v.version, releaseChannel: v.releaseChannel, createdAt: v.createdAt })) }));
    const publishedRecords = await tx.select({ id: agencyKnowledgeRecords.id, path: agencyKnowledgeRecords.path, title: agencyKnowledgeRecords.title }).from(agencyKnowledgeRecords).where(eq(agencyKnowledgeRecords.state, "published")).orderBy(agencyKnowledgeRecords.path);
    let skillVersion: UpdateDetail["skillVersion"] = null;
    if (update.skillVersionId) {
      const v = vs.find((x) => x.id === update.skillVersionId);
      const s = v ? sk.find((x) => x.id === v.skillId) : undefined;
      if (v && s) skillVersion = { id: v.id, version: v.version, skillKey: s.key, skillName: s.name, releaseChannel: v.releaseChannel };
    }
    let previousSkillVersion: UpdateDetail["previousSkillVersion"] = null;
    if (update.previousSkillVersionId) {
      const v = vs.find((x) => x.id === update.previousSkillVersionId);
      if (v) previousSkillVersion = { id: v.id, version: v.version };
    }
    let knowledgeRecord: UpdateDetail["knowledgeRecord"] = null;
    if (update.knowledgeRecordId) {
      const [r] = await tx.select({ id: agencyKnowledgeRecords.id, path: agencyKnowledgeRecords.path, title: agencyKnowledgeRecords.title, state: agencyKnowledgeRecords.state }).from(agencyKnowledgeRecords).where(eq(agencyKnowledgeRecords.id, update.knowledgeRecordId));
      knowledgeRecord = r ?? null;
    }
    return { update, source, transitions, skillVersion, previousSkillVersion, knowledgeRecord, skills: skillOptions, publishedRecords };
  });
}

export interface PinnedView {
  available: boolean;
  onThisVersion: number;
  onOtherVersions: number;
}

/** Operator view across tenants: counts only, never tenant content. Unavailable for agency roles without an operator role. */
export async function getPinnedInstances(ctx: AgencyContext, skillVersionId: string): Promise<PinnedView> {
  if (!hasOperatorRole(ctx.roles)) return { available: false, onThisVersion: 0, onOtherVersions: 0 };
  const op = operatorContext({ actorType: ctx.actorType, actorId: ctx.actorId, roles: ctx.roles });
  const r = await getDb().withContext(op, (tx) => pinnedInstanceCount(tx, op, skillVersionId));
  return { available: true, ...r };
}

// Platform retention defaults -----------------------------------------------------------------------

export interface PlatformRetentionRow {
  dataClass: DataClass;
  days: number;
  reason: string;
  setByActorId: string | null;
  updatedAt: Date | null;
  /** False when no row exists and the floor applies. */
  hasRow: boolean;
}

export async function getPlatformRetention(ctx: AgencyContext): Promise<PlatformRetentionRow[]> {
  return agencyRead(ctx, async (tx) => {
    const effective = await effectiveRetention(tx, ctx, null);
    const rows = await tx.select().from(retentionPolicies).where(sql`${retentionPolicies.tenantId} IS NULL`);
    return DATA_CLASSES.map((dc) => {
      const row = rows.find((r) => r.dataClass === dc);
      return { dataClass: dc, days: effective[dc].days, reason: effective[dc].reason, setByActorId: row?.setByActorId ?? null, updatedAt: row?.updatedAt ?? null, hasRow: Boolean(row) };
    });
  });
}

// Deletion requests across tenants ------------------------------------------------------------------

export interface DeletionRequestRow {
  id: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  kind: string;
  state: string;
  legalHold: boolean;
  reviewerActorId: string | null;
  decidedAt: Date | null;
  executedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Operator role: the granted metadata columns only (migration 0009). Never selects subject_ref, reason, review_note or summary. */
export async function listAllDeletionRequests(op: OperatorContext, filter: { state?: string | null } = {}): Promise<{ rows: DeletionRequestRow[]; counts: Map<string, number> }> {
  return getDb().withContext(op, async (tx) => {
    const byState = await tx.select({ state: deletionRequests.state, n: num(sql`count(*)`) }).from(deletionRequests).groupBy(deletionRequests.state);
    const counts = new Map<string, number>(byState.map((r) => [r.state, r.n]));
    const cols = { id: deletionRequests.id, tenantId: deletionRequests.tenantId, tenantSlug: tenants.slug, tenantName: tenants.name, kind: deletionRequests.kind, state: deletionRequests.state, legalHold: deletionRequests.legalHold, reviewerActorId: deletionRequests.reviewerActorId, decidedAt: deletionRequests.decidedAt, executedAt: deletionRequests.executedAt, createdAt: deletionRequests.createdAt, updatedAt: deletionRequests.updatedAt };
    const base = tx.select(cols).from(deletionRequests).innerJoin(tenants, eq(tenants.id, deletionRequests.tenantId)).orderBy(desc(deletionRequests.createdAt)).limit(200);
    const state = filter.state && (schema.deletionState.enumValues as readonly string[]).includes(filter.state) ? (filter.state as (typeof schema.deletionState.enumValues)[number]) : null;
    const rows = state ? await base.where(eq(deletionRequests.state, state)) : await base;
    return { rows, counts };
  });
}

export interface DeletionRequestDetail {
  request: typeof deletionRequests.$inferSelect;
  tenantSlug: string;
  tenantName: string;
  requestedByName: string | null;
  tenantRetention: Record<DataClass, { days: number; source: "default" | "tenant"; reason: string }>;
}

/**
 * Operator context resolves the tenant (metadata), then the full row (subject reference, reason, review note,
 * summary) is read in agency scope pinned to that tenant, the scope the decision runs in.
 */
export async function getDeletionRequestDetail(op: OperatorContext, id: string): Promise<DeletionRequestDetail | null> {
  const meta = await getDb().withContext(op, async (tx) => {
    const [r] = await tx.select({ tenantId: deletionRequests.tenantId, tenantSlug: tenants.slug, tenantName: tenants.name }).from(deletionRequests).innerJoin(tenants, eq(tenants.id, deletionRequests.tenantId)).where(eq(deletionRequests.id, id));
    return r ?? null;
  });
  if (!meta) return null;
  const pinned = agencyContext({ tenantId: meta.tenantId, actorType: op.actorType, actorId: op.actorId, roles: op.roles });
  return getDb().withContext(pinned, async (tx) => {
    const [request] = await tx.select().from(deletionRequests).where(and(eq(deletionRequests.id, id), eq(deletionRequests.tenantId, meta.tenantId)));
    if (!request) return null;
    let requestedByName: string | null = null;
    if (request.requestedByUserId) {
      const [u] = await tx.select({ displayName: users.displayName }).from(users).where(eq(users.id, request.requestedByUserId));
      requestedByName = u?.displayName ?? null;
    }
    const tenantRetention = await effectiveRetention(tx, pinned, meta.tenantId);
    return { request, tenantSlug: meta.tenantSlug, tenantName: meta.tenantName, requestedByName, tenantRetention };
  });
}
