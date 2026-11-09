import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { operatorContext, schema, type AgencyContext, type Tx } from "@sbos/db";
import { searchAgencyVault, type AgencySearchHit } from "@sbos/core";
import { getDb } from "../db";
import { hasOperatorRole } from "./agency-vault-helpers";

/**
 * Agency Intelligence Vault reads (spec 4H). Every function runs in AGENCY scope (`sbos_app`,
 * `app.actor_scope = 'agency'`, no tenant), the only scope with the column grants and RLS policies that
 * return agency knowledge bodies (migration 0007). Tenant tables are invisible in this scope, so no query here
 * can return a client document, fact or run trace; adoptions are visible as metadata through
 * `template_adoptions_agency_select` and we never select their `parameters` column for the matrix.
 * Promotion requests are visible to agency_reviewer and superadmin only (RLS), so the review queries return
 * nothing for other agency roles; the pages say so.
 */
const { agencyKnowledgeRecords, agencyKnowledgeVersions, agencyKnowledgeTransitions, knowledgePromotionRequests, knowledgePromotionReviews, methodologyTemplates, templateAdoptions, evaluationCases, knowledgeDeprecationEvents, tenants, skills, skillVersions, skillReleaseChannels, agentInstances } = schema;

const num = (expr: ReturnType<typeof sql>) => sql<number>`${expr}`.mapWith(Number);

function agencyRead<T>(ctx: AgencyContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().withContext(ctx, fn);
}

export type KnowledgeRecordState = (typeof schema.knowledgeRecordState.enumValues)[number];
export type KnowledgeRecordKind = (typeof schema.knowledgeRecordKind.enumValues)[number];

// Summary ---------------------------------------------------------------------------------------------

export interface AgencyVaultSummary {
  recordsByState: Array<{ state: KnowledgeRecordState; n: number }>;
  records: number;
  pendingReviews: number;
  approvedAwaitingPublication: number;
  templates: number;
  activeAdoptions: number;
  /** False when the caller's roles cannot see promotion requests at all (RLS), so the review counts are not meaningful. */
  canSeePromotions: boolean;
}

export async function getAgencyVaultSummary(ctx: AgencyContext): Promise<AgencyVaultSummary> {
  return agencyRead(ctx, async (tx) => {
    const byState = await tx.select({ state: agencyKnowledgeRecords.state, n: num(sql`count(*)`) }).from(agencyKnowledgeRecords).groupBy(agencyKnowledgeRecords.state);
    const [pending] = await tx.select({ n: num(sql`count(*)`) }).from(knowledgePromotionRequests).where(inArray(knowledgePromotionRequests.state, ["nominated", "in_review"]));
    const [approved] = await tx.select({ n: num(sql`count(*)`) }).from(knowledgePromotionRequests).where(eq(knowledgePromotionRequests.state, "approved"));
    const [tpl] = await tx.select({ n: num(sql`count(*)`) }).from(methodologyTemplates).where(eq(methodologyTemplates.active, true));
    const [adopt] = await tx.select({ n: num(sql`count(*)`) }).from(templateAdoptions).where(eq(templateAdoptions.state, "active"));
    return {
      recordsByState: byState,
      records: byState.reduce((a, b) => a + b.n, 0),
      pendingReviews: pending?.n ?? 0,
      approvedAwaitingPublication: approved?.n ?? 0,
      templates: tpl?.n ?? 0,
      activeAdoptions: adopt?.n ?? 0,
      canSeePromotions: ctx.roles.includes("agency_reviewer") || ctx.roles.includes("superadmin")
    };
  });
}

// Library ---------------------------------------------------------------------------------------------

export interface KnowledgeRecordRow {
  id: string;
  folder: string;
  path: string;
  title: string;
  kind: KnowledgeRecordKind;
  state: KnowledgeRecordState;
  origin: string;
  classification: string;
  currentVersion: number | null;
  ownerActorId: string;
  updatedAt: Date;
  /** Search mode only. */
  rank?: number;
  snippet?: string;
}

export interface LibraryView {
  rows: KnowledgeRecordRow[];
  folderCounts: Map<string, number>;
  stateCounts: Map<string, number>;
  searched: boolean;
}

/** Records filtered by folder and state, or a full-text search (`searchAgencyVault`, logged in audit_events). */
export async function listKnowledgeRecords(ctx: AgencyContext, filter: { folder?: string | null; state?: string | null; q?: string | null }): Promise<LibraryView> {
  return agencyRead(ctx, async (tx) => {
    const folderRows = await tx.select({ folder: agencyKnowledgeRecords.folder, n: num(sql`count(*)`) }).from(agencyKnowledgeRecords).groupBy(agencyKnowledgeRecords.folder);
    const stateRows = await tx.select({ state: agencyKnowledgeRecords.state, n: num(sql`count(*)`) }).from(agencyKnowledgeRecords).groupBy(agencyKnowledgeRecords.state);
    const folderCounts = new Map(folderRows.map((r) => [r.folder, r.n]));
    const stateCounts = new Map(stateRows.map((r) => [r.state, r.n]));
    const base = tx
      .select({
        id: agencyKnowledgeRecords.id,
        folder: agencyKnowledgeRecords.folder,
        path: agencyKnowledgeRecords.path,
        title: agencyKnowledgeRecords.title,
        kind: agencyKnowledgeRecords.kind,
        state: agencyKnowledgeRecords.state,
        origin: agencyKnowledgeRecords.origin,
        classification: agencyKnowledgeRecords.classification,
        currentVersion: agencyKnowledgeVersions.version,
        ownerActorId: agencyKnowledgeRecords.ownerActorId,
        updatedAt: agencyKnowledgeRecords.updatedAt
      })
      .from(agencyKnowledgeRecords)
      .leftJoin(agencyKnowledgeVersions, eq(agencyKnowledgeVersions.id, agencyKnowledgeRecords.currentVersionId));
    const q = filter.q?.trim() ?? "";
    if (q) {
      const states = filter.state && (schema.knowledgeRecordState.enumValues as readonly string[]).includes(filter.state) ? [filter.state as KnowledgeRecordState] : undefined;
      const hits: AgencySearchHit[] = await searchAgencyVault(tx, ctx, { query: q, limit: 50, ...(states ? { states } : {}) });
      const ids = hits.map((h) => h.recordId);
      if (ids.length === 0) return { rows: [], folderCounts, stateCounts, searched: true };
      const rows = await base.where(inArray(agencyKnowledgeRecords.id, ids));
      const byId = new Map(rows.map((r) => [r.id, r]));
      const out: KnowledgeRecordRow[] = [];
      for (const h of hits) {
        const r = byId.get(h.recordId);
        if (!r) continue;
        if (filter.folder && r.folder !== filter.folder) continue;
        out.push({ ...r, rank: h.rank, snippet: h.snippet });
      }
      return { rows: out, folderCounts, stateCounts, searched: true };
    }
    const conds = [];
    if (filter.folder) conds.push(eq(agencyKnowledgeRecords.folder, filter.folder));
    if (filter.state && (schema.knowledgeRecordState.enumValues as readonly string[]).includes(filter.state)) conds.push(eq(agencyKnowledgeRecords.state, filter.state as KnowledgeRecordState));
    const rows = await (conds.length > 0 ? base.where(and(...conds)) : base).orderBy(agencyKnowledgeRecords.folder, desc(agencyKnowledgeRecords.updatedAt));
    return { rows, folderCounts, stateCounts, searched: false };
  });
}

// Record detail ---------------------------------------------------------------------------------------

export interface VersionRow {
  id: string;
  version: number;
  changelog: string;
  checksum: string;
  evidenceLink: string | null;
  createdByActorType: string;
  createdByActorId: string;
  createdAt: Date;
}

export interface RecordDetail {
  record: typeof agencyKnowledgeRecords.$inferSelect;
  current: { id: string; version: number; frontmatter: Record<string, unknown>; bodyMarkdown: string; checksum: string } | null;
  versions: VersionRow[];
  transitions: Array<typeof agencyKnowledgeTransitions.$inferSelect>;
  events: Array<typeof knowledgeDeprecationEvents.$inferSelect>;
  evaluationCases: Array<typeof evaluationCases.$inferSelect & { lastVersion: number | null }>;
  template: (typeof methodologyTemplates.$inferSelect) | null;
  /** Adoption metadata (no parameters, no document content): tenant name and slug, version, state, timestamps. */
  adoptions: AdoptionRow[];
  promotion: { id: string; state: string; tenantName: string; tenantSlug: string; consentStatus: string; rightsBasis: string | null; decidedAt: Date | null } | null;
}

export interface AdoptionRow {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  templateId: string;
  templateKey: string;
  version: number;
  state: string;
  adoptedByActorId: string;
  adoptedAt: Date;
  endedAt: Date | null;
  previousAdoptionId: string | null;
  note: string | null;
}

function adoptionSelect(tx: Tx) {
  return tx
    .select({
      id: templateAdoptions.id,
      tenantId: templateAdoptions.tenantId,
      tenantName: tenants.name,
      tenantSlug: tenants.slug,
      templateId: templateAdoptions.templateId,
      templateKey: methodologyTemplates.key,
      version: templateAdoptions.version,
      state: templateAdoptions.state,
      adoptedByActorId: templateAdoptions.adoptedByActorId,
      adoptedAt: templateAdoptions.adoptedAt,
      endedAt: templateAdoptions.endedAt,
      previousAdoptionId: templateAdoptions.previousAdoptionId,
      note: templateAdoptions.note
    })
    .from(templateAdoptions)
    .innerJoin(tenants, eq(tenants.id, templateAdoptions.tenantId))
    .innerJoin(methodologyTemplates, eq(methodologyTemplates.id, templateAdoptions.templateId));
}

export async function getRecordDetail(ctx: AgencyContext, recordId: string): Promise<RecordDetail | null> {
  return agencyRead(ctx, async (tx) => {
    const [record] = await tx.select().from(agencyKnowledgeRecords).where(eq(agencyKnowledgeRecords.id, recordId));
    if (!record) return null;
    const versions = await tx
      .select({ id: agencyKnowledgeVersions.id, version: agencyKnowledgeVersions.version, changelog: agencyKnowledgeVersions.changelog, checksum: agencyKnowledgeVersions.checksum, evidenceLink: agencyKnowledgeVersions.evidenceLink, createdByActorType: agencyKnowledgeVersions.createdByActorType, createdByActorId: agencyKnowledgeVersions.createdByActorId, createdAt: agencyKnowledgeVersions.createdAt })
      .from(agencyKnowledgeVersions)
      .where(eq(agencyKnowledgeVersions.recordId, recordId))
      .orderBy(desc(agencyKnowledgeVersions.version));
    const [cur] = record.currentVersionId
      ? await tx.select({ id: agencyKnowledgeVersions.id, version: agencyKnowledgeVersions.version, frontmatter: agencyKnowledgeVersions.frontmatter, bodyMarkdown: agencyKnowledgeVersions.bodyMarkdown, checksum: agencyKnowledgeVersions.checksum }).from(agencyKnowledgeVersions).where(eq(agencyKnowledgeVersions.id, record.currentVersionId))
      : [];
    const transitions = await tx.select().from(agencyKnowledgeTransitions).where(eq(agencyKnowledgeTransitions.recordId, recordId)).orderBy(desc(agencyKnowledgeTransitions.createdAt));
    const events = await tx.select().from(knowledgeDeprecationEvents).where(eq(knowledgeDeprecationEvents.recordId, recordId)).orderBy(desc(knowledgeDeprecationEvents.createdAt));
    const cases = await tx.select().from(evaluationCases).where(eq(evaluationCases.recordId, recordId)).orderBy(evaluationCases.name);
    const versionNumber = new Map(versions.map((v) => [v.id, v.version]));
    const [template] = await tx.select().from(methodologyTemplates).where(eq(methodologyTemplates.recordId, recordId));
    const adoptions = template ? await adoptionSelect(tx).where(eq(templateAdoptions.templateId, template.id)).orderBy(tenants.name, desc(templateAdoptions.adoptedAt)) : [];
    let promotion: RecordDetail["promotion"] = null;
    if (record.promotionRequestId) {
      const [p] = await tx
        .select({ id: knowledgePromotionRequests.id, state: knowledgePromotionRequests.state, tenantName: tenants.name, tenantSlug: tenants.slug, consentStatus: knowledgePromotionRequests.consentStatus, rightsBasis: knowledgePromotionRequests.rightsBasis, decidedAt: knowledgePromotionRequests.decidedAt })
        .from(knowledgePromotionRequests)
        .innerJoin(tenants, eq(tenants.id, knowledgePromotionRequests.tenantId))
        .where(eq(knowledgePromotionRequests.id, record.promotionRequestId));
      promotion = p ?? null;
    }
    return {
      record,
      current: cur ?? null,
      versions,
      transitions,
      events,
      evaluationCases: cases.map((c) => ({ ...c, lastVersion: c.lastVersionId ? (versionNumber.get(c.lastVersionId) ?? null) : null })),
      template: template ?? null,
      adoptions,
      promotion
    };
  });
}

// Skills registry -------------------------------------------------------------------------------------

export interface SkillRegistryRow {
  skillId: string;
  key: string;
  name: string;
  status: string;
  versions: Array<{ id: string; version: string; releaseChannel: string; checksum: string; createdAt: Date; channels: string[]; pinnedInstances: number; pinnedTenants: number }>;
}

/**
 * Catalogue tables (`skills`, `skill_versions`, `skill_release_channels`) are readable in agency scope. The pin
 * counts come from `agent_instances`, a tenant table that agency scope cannot see; they are read through the
 * operator role (metadata columns only) and only when the caller holds an operator role. Counts only, never
 * tenant content.
 */
export async function listSkillsRegistry(ctx: AgencyContext): Promise<{ rows: SkillRegistryRow[]; pinsAvailable: boolean }> {
  const rows = await agencyRead(ctx, async (tx) => {
    const sk = await tx.select().from(skills).orderBy(skills.key);
    const vs = await tx.select().from(skillVersions).orderBy(skillVersions.skillId, desc(skillVersions.createdAt));
    const ch = await tx.select().from(skillReleaseChannels);
    return sk.map((s) => ({
      skillId: s.id,
      key: s.key,
      name: s.name,
      status: s.status,
      versions: vs
        .filter((v) => v.skillId === s.id)
        .map((v) => ({ id: v.id, version: v.version, releaseChannel: v.releaseChannel, checksum: v.checksum, createdAt: v.createdAt, channels: ch.filter((c) => c.skillVersionId === v.id).map((c) => c.channel), pinnedInstances: 0, pinnedTenants: 0 }))
    }));
  });
  const pinsAvailable = hasOperatorRole(ctx.roles);
  if (pinsAvailable) {
    const op = operatorContext({ actorType: ctx.actorType, actorId: ctx.actorId, roles: ctx.roles });
    const pins = await getDb().withContext(op, (tx) =>
      tx
        .select({ skillVersionId: agentInstances.skillVersionId, instances: num(sql`count(*)`), tenantsN: num(sql`count(distinct ${agentInstances.tenantId})`) })
        .from(agentInstances)
        .where(sql`${agentInstances.skillVersionId} is not null`)
        .groupBy(agentInstances.skillVersionId)
    );
    const byVersion = new Map(pins.map((p) => [p.skillVersionId, p]));
    for (const s of rows) for (const v of s.versions) {
      const p = byVersion.get(v.id);
      if (p) {
        v.pinnedInstances = p.instances;
        v.pinnedTenants = p.tenantsN;
      }
    }
  }
  return { rows, pinsAvailable };
}

// Promotion requests ----------------------------------------------------------------------------------

export interface PromotionRow {
  request: typeof knowledgePromotionRequests.$inferSelect;
  tenantName: string;
  tenantSlug: string;
  reviews: Array<typeof knowledgePromotionReviews.$inferSelect>;
  publishedPath: string | null;
}

/** All promotion requests visible to the caller, open ones first. Reviewer or superadmin only (RLS returns nothing otherwise). */
export async function listPromotionRequests(ctx: AgencyContext): Promise<PromotionRow[]> {
  return agencyRead(ctx, async (tx) => {
    const reqs = await tx
      .select({ request: knowledgePromotionRequests, tenantName: tenants.name, tenantSlug: tenants.slug, publishedPath: agencyKnowledgeRecords.path })
      .from(knowledgePromotionRequests)
      .innerJoin(tenants, eq(tenants.id, knowledgePromotionRequests.tenantId))
      .leftJoin(agencyKnowledgeRecords, eq(agencyKnowledgeRecords.id, knowledgePromotionRequests.publishedRecordId))
      .orderBy(desc(knowledgePromotionRequests.createdAt));
    if (reqs.length === 0) return [];
    const reviews = await tx.select().from(knowledgePromotionReviews).where(inArray(knowledgePromotionReviews.requestId, reqs.map((r) => r.request.id))).orderBy(knowledgePromotionReviews.createdAt);
    const order: Record<string, number> = { nominated: 0, in_review: 1, approved: 2, published: 3, rejected: 4, withdrawn: 5 };
    return reqs
      .map((r) => ({ request: r.request, tenantName: r.tenantName, tenantSlug: r.tenantSlug, publishedPath: r.publishedPath, reviews: reviews.filter((v) => v.requestId === r.request.id) }))
      .sort((a, b) => (order[a.request.state] ?? 9) - (order[b.request.state] ?? 9) || b.request.createdAt.getTime() - a.request.createdAt.getTime());
  });
}

// Templates and adoptions -----------------------------------------------------------------------------

export interface TemplateRow {
  template: typeof methodologyTemplates.$inferSelect;
  recordTitle: string;
  recordState: KnowledgeRecordState;
  recordPath: string;
  currentVersion: number | null;
  currentVersionId: string | null;
  versions: Array<{ id: string; version: number; changelog: string }>;
}

export interface TemplatesView {
  templates: TemplateRow[];
  clientTenants: Array<{ id: string; slug: string; name: string; kind: string }>;
  adoptions: AdoptionRow[];
  /** Published records without a template yet: candidates for "Create template from record". */
  candidateRecords: Array<{ id: string; title: string; path: string; state: KnowledgeRecordState }>;
}

export async function getTemplatesView(ctx: AgencyContext): Promise<TemplatesView> {
  return agencyRead(ctx, async (tx) => {
    const tpls = await tx
      .select({ template: methodologyTemplates, recordTitle: agencyKnowledgeRecords.title, recordState: agencyKnowledgeRecords.state, recordPath: agencyKnowledgeRecords.path, currentVersionId: agencyKnowledgeRecords.currentVersionId, currentVersion: agencyKnowledgeVersions.version })
      .from(methodologyTemplates)
      .innerJoin(agencyKnowledgeRecords, eq(agencyKnowledgeRecords.id, methodologyTemplates.recordId))
      .leftJoin(agencyKnowledgeVersions, eq(agencyKnowledgeVersions.id, agencyKnowledgeRecords.currentVersionId))
      .orderBy(methodologyTemplates.name);
    const recordIds = tpls.map((t) => t.template.recordId);
    const versions = recordIds.length > 0 ? await tx.select({ id: agencyKnowledgeVersions.id, recordId: agencyKnowledgeVersions.recordId, version: agencyKnowledgeVersions.version, changelog: agencyKnowledgeVersions.changelog }).from(agencyKnowledgeVersions).where(inArray(agencyKnowledgeVersions.recordId, recordIds)).orderBy(desc(agencyKnowledgeVersions.version)) : [];
    const clientTenants = await tx.select({ id: tenants.id, slug: tenants.slug, name: tenants.name, kind: tenants.kind }).from(tenants).where(sql`${tenants.kind} <> 'agency'`).orderBy(tenants.name);
    const adoptions = await adoptionSelect(tx).orderBy(desc(templateAdoptions.adoptedAt));
    const candidates = await tx
      .select({ id: agencyKnowledgeRecords.id, title: agencyKnowledgeRecords.title, path: agencyKnowledgeRecords.path, state: agencyKnowledgeRecords.state })
      .from(agencyKnowledgeRecords)
      .where(and(inArray(agencyKnowledgeRecords.state, ["approved", "published", "draft", "in_review"]), sql`not exists (select 1 from ${methodologyTemplates} m where m.record_id = ${agencyKnowledgeRecords.id})`))
      .orderBy(agencyKnowledgeRecords.state, agencyKnowledgeRecords.title);
    return {
      templates: tpls.map((t) => ({ ...t, versions: versions.filter((v) => v.recordId === t.template.recordId).map(({ id, version, changelog }) => ({ id, version, changelog })) })),
      clientTenants,
      adoptions,
      candidateRecords: candidates
    };
  });
}

// History ---------------------------------------------------------------------------------------------

export interface HistoryEntry {
  at: Date;
  kind: "transition" | "release" | "rollback" | "deprecate" | "reinstate" | "archive" | "consent_review" | "adoption" | "promotion";
  recordId: string | null;
  recordTitle: string | null;
  recordPath: string | null;
  summary: string;
  detail: string | null;
  actor: string;
  tenantName: string | null;
}

/** Cross-record timeline: transitions, releases and rollbacks, deprecations, adoptions (metadata) and publications from promotions. */
export async function listHistory(ctx: AgencyContext, limit = 200): Promise<HistoryEntry[]> {
  return agencyRead(ctx, async (tx) => {
    const tr = await tx
      .select({ t: agencyKnowledgeTransitions, title: agencyKnowledgeRecords.title, path: agencyKnowledgeRecords.path })
      .from(agencyKnowledgeTransitions)
      .innerJoin(agencyKnowledgeRecords, eq(agencyKnowledgeRecords.id, agencyKnowledgeTransitions.recordId))
      .orderBy(desc(agencyKnowledgeTransitions.createdAt))
      .limit(limit);
    const ev = await tx
      .select({ e: knowledgeDeprecationEvents, title: agencyKnowledgeRecords.title, path: agencyKnowledgeRecords.path, version: agencyKnowledgeVersions.version })
      .from(knowledgeDeprecationEvents)
      .innerJoin(agencyKnowledgeRecords, eq(agencyKnowledgeRecords.id, knowledgeDeprecationEvents.recordId))
      .leftJoin(agencyKnowledgeVersions, eq(agencyKnowledgeVersions.id, knowledgeDeprecationEvents.versionId))
      .orderBy(desc(knowledgeDeprecationEvents.createdAt))
      .limit(limit);
    const ad = await adoptionSelect(tx).orderBy(desc(templateAdoptions.adoptedAt)).limit(limit);
    const adRecords = await tx.select({ templateId: methodologyTemplates.id, recordId: agencyKnowledgeRecords.id, title: agencyKnowledgeRecords.title, path: agencyKnowledgeRecords.path }).from(methodologyTemplates).innerJoin(agencyKnowledgeRecords, eq(agencyKnowledgeRecords.id, methodologyTemplates.recordId));
    const recByTemplate = new Map(adRecords.map((r) => [r.templateId, r]));
    const pr = await tx
      .select({ p: knowledgePromotionRequests, tenantName: tenants.name, title: agencyKnowledgeRecords.title, path: agencyKnowledgeRecords.path })
      .from(knowledgePromotionRequests)
      .innerJoin(tenants, eq(tenants.id, knowledgePromotionRequests.tenantId))
      .leftJoin(agencyKnowledgeRecords, eq(agencyKnowledgeRecords.id, knowledgePromotionRequests.publishedRecordId))
      .where(eq(knowledgePromotionRequests.state, "published"))
      .orderBy(desc(knowledgePromotionRequests.updatedAt))
      .limit(limit);

    const out: HistoryEntry[] = [];
    for (const r of tr) out.push({ at: r.t.createdAt, kind: "transition", recordId: r.t.recordId, recordTitle: r.title, recordPath: r.path, summary: `${r.t.fromState ?? "new"} -> ${r.t.toState}`, detail: r.t.note, actor: `${r.t.actorType}:${r.t.actorId}`, tenantName: null });
    for (const r of ev) out.push({ at: r.e.createdAt, kind: r.e.kind, recordId: r.e.recordId, recordTitle: r.title, recordPath: r.path, summary: `${r.e.kind}${r.version ? ` v${r.version}` : ""} (${r.e.affectedAdoptions} active adoption${r.e.affectedAdoptions === 1 ? "" : "s"} unchanged)`, detail: r.e.reason, actor: `${r.e.actorType}:${r.e.actorId}`, tenantName: null });
    for (const a of ad) {
      const rec = recByTemplate.get(a.templateId);
      out.push({ at: a.adoptedAt, kind: "adoption", recordId: rec?.recordId ?? null, recordTitle: rec?.title ?? null, recordPath: rec?.path ?? null, summary: `${a.templateKey} v${a.version} adopted (${a.state})`, detail: a.note, actor: `user:${a.adoptedByActorId}`, tenantName: a.tenantName });
    }
    for (const r of pr) out.push({ at: r.p.updatedAt, kind: "promotion", recordId: r.p.publishedRecordId, recordTitle: r.title, recordPath: r.path, summary: `promotion published: ${r.p.title}`, detail: r.p.rightsBasis ? `rights basis: ${r.p.rightsBasis}` : null, actor: `user:${r.p.reviewerActorId ?? "unknown"}`, tenantName: r.tenantName });
    return out.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
  });
}
