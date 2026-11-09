import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { schema, writeAudit, type AgencyContext, type RequestContext, type Tx } from "@sbos/db";
import { AuthorizationError } from "./errors";
import { writeVaultDocument } from "./vault";
import { AGENCY_VAULT_FOLDERS, CLIENT_VAULT_FOLDERS } from "./vault-taxonomy";

/**
 * Agency Intelligence Vault services (spec 4H, Milestone 4).
 *
 * Everything here runs in agency scope (`ctx.kind === "agency"`). The database enforces the hard rules:
 * tenant scope cannot read agency tables at all; the record lifecycle, the promotion gate and the
 * adoption pin are triggers (`enforce_knowledge_transition`, `enforce_promotion_transition`,
 * `enforce_adoption`). The service layer adds validation, audit rows and the client-vault copy that an
 * adoption produces. Client content never flows into the agency vault automatically: the only path is a
 * `knowledge_promotion_requests` row that a human reviewer approves after rights, security and
 * identifiability checks.
 */
const { agencyKnowledgeRecords, agencyKnowledgeVersions, agencyKnowledgeTransitions, knowledgePromotionRequests, knowledgePromotionReviews, methodologyTemplates, templateAdoptions, evaluationCases, knowledgeDeprecationEvents, vaultDocuments } = schema;

export type KnowledgeRecordState = (typeof schema.knowledgeRecordState.enumValues)[number];
export type KnowledgeRecordKind = (typeof schema.knowledgeRecordKind.enumValues)[number];
export type KnowledgeOrigin = (typeof schema.knowledgeOrigin.enumValues)[number];
export type PromotionState = (typeof schema.promotionState.enumValues)[number];

const AGENCY_PATH_RE = /^[0-9]{2}_[a-z0-9_]+\/[A-Za-z0-9._/-]+\.md$/;
const REVIEWER_ROLES = ["agency_reviewer", "superadmin"] as const;
const PLACEHOLDER_RE = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

function assertAgency(ctx: RequestContext, what: string): asserts ctx is AgencyContext {
  if (ctx.kind !== "agency") throw new AuthorizationError(`${what} runs in agency scope only (got ${ctx.kind} context)`);
}

function hasRole(ctx: RequestContext, roles: readonly string[]): boolean {
  return ctx.roles.some((r) => roles.includes(r));
}

function checksumOf(frontmatter: Record<string, unknown>, body: string): string {
  return createHash("sha256").update(JSON.stringify(frontmatter)).update("\n").update(body).digest("hex");
}

function folderOf(path: string): string {
  return path.split("/")[0] ?? "";
}

// Records and versions --------------------------------------------------------------------------

export interface CreateKnowledgeRecordInput {
  path: string;
  title: string;
  kind?: KnowledgeRecordKind;
  bodyMarkdown: string;
  frontmatter?: Record<string, unknown>;
  changelog?: string;
  classification?: (typeof schema.classification.enumValues)[number];
  origin?: KnowledgeOrigin;
  license?: string | null;
  allowedUses?: string[];
  sourceVersion?: string | null;
  reviewDueAt?: string | null;
  confidence?: number | null;
  relatedSkillKeys?: string[];
  evidenceLink?: string | null;
  promotionRequestId?: string | null;
  /** Defaults to the acting actor. Set when a reviewer publishes an approved promotion on behalf of its nominator. */
  ownerActorId?: string;
}

/** Creates a draft record with version 1 in one of the 18 agency folders. */
export async function createKnowledgeRecord(tx: Tx, ctx: RequestContext, input: CreateKnowledgeRecordInput): Promise<{ recordId: string; versionId: string }> {
  assertAgency(ctx, "creating agency knowledge");
  if (!AGENCY_PATH_RE.test(input.path)) throw new Error(`agency vault path "${input.path}" must be <NN_folder>/<name>.md`);
  const folder = folderOf(input.path);
  if (!(AGENCY_VAULT_FOLDERS as readonly string[]).includes(folder)) throw new Error(`"${folder}" is not one of the ${AGENCY_VAULT_FOLDERS.length} agency vault folders`);
  if (input.origin === "abstracted_from_client" && !input.promotionRequestId) throw new Error("knowledge abstracted from a client needs its promotion request");
  const frontmatter = input.frontmatter ?? {};
  const [rec] = await tx
    .insert(agencyKnowledgeRecords)
    .values({
      folder,
      path: input.path,
      title: input.title,
      kind: input.kind ?? "other",
      ownerActorId: input.ownerActorId ?? ctx.actorId,
      classification: input.classification ?? "internal",
      origin: input.origin ?? "own",
      license: input.license ?? null,
      allowedUses: input.allowedUses ?? [],
      sourceVersion: input.sourceVersion ?? null,
      reviewDueAt: input.reviewDueAt ?? null,
      confidence: input.confidence === undefined || input.confidence === null ? null : String(input.confidence),
      promotionRequestId: input.promotionRequestId ?? null,
      relatedSkillKeys: input.relatedSkillKeys ?? [],
      createdByActorType: ctx.actorType,
      createdByActorId: ctx.actorId
    })
    .returning({ id: agencyKnowledgeRecords.id });
  if (!rec) throw new Error("knowledge record insert returned nothing");
  const [ver] = await tx
    .insert(agencyKnowledgeVersions)
    .values({ recordId: rec.id, version: 1, frontmatter, bodyMarkdown: input.bodyMarkdown, changelog: input.changelog ?? "initial version", checksum: checksumOf(frontmatter, input.bodyMarkdown), evidenceLink: input.evidenceLink ?? null, createdByActorType: ctx.actorType, createdByActorId: ctx.actorId })
    .returning({ id: agencyKnowledgeVersions.id });
  if (!ver) throw new Error("knowledge version insert returned nothing");
  await tx.update(agencyKnowledgeRecords).set({ currentVersionId: ver.id }).where(eq(agencyKnowledgeRecords.id, rec.id));
  await writeAudit(tx, ctx, { action: "agency_knowledge.created", entityType: "agency_knowledge_record", entityId: rec.id, after: { path: input.path, kind: input.kind ?? "other", origin: input.origin ?? "own" } });
  return { recordId: rec.id, versionId: ver.id };
}

export interface AddKnowledgeVersionInput {
  recordId: string;
  bodyMarkdown: string;
  frontmatter?: Record<string, unknown>;
  changelog: string;
  evidenceLink?: string | null;
}

/**
 * Adds an immutable version. For a draft or in-review record the new version becomes current. For an
 * approved, published or deprecated record it is stored only; a reviewer releases it with `setCurrentVersion`,
 * so a published method never changes under its adopters without an authorised release.
 */
export async function addKnowledgeVersion(tx: Tx, ctx: RequestContext, input: AddKnowledgeVersionInput): Promise<{ versionId: string; version: number; current: boolean }> {
  assertAgency(ctx, "adding a knowledge version");
  const [rec] = await tx.select({ state: agencyKnowledgeRecords.state }).from(agencyKnowledgeRecords).where(eq(agencyKnowledgeRecords.id, input.recordId));
  if (!rec) throw new Error("knowledge record not found");
  if (rec.state === "archived") throw new Error("archived records do not take new versions");
  const [last] = await tx.select({ version: agencyKnowledgeVersions.version }).from(agencyKnowledgeVersions).where(eq(agencyKnowledgeVersions.recordId, input.recordId)).orderBy(desc(agencyKnowledgeVersions.version)).limit(1);
  const version = (last?.version ?? 0) + 1;
  const frontmatter = input.frontmatter ?? {};
  const [ver] = await tx
    .insert(agencyKnowledgeVersions)
    .values({ recordId: input.recordId, version, frontmatter, bodyMarkdown: input.bodyMarkdown, changelog: input.changelog, checksum: checksumOf(frontmatter, input.bodyMarkdown), evidenceLink: input.evidenceLink ?? null, createdByActorType: ctx.actorType, createdByActorId: ctx.actorId })
    .returning({ id: agencyKnowledgeVersions.id });
  if (!ver) throw new Error("knowledge version insert returned nothing");
  const current = rec.state === "draft" || rec.state === "in_review";
  if (current) await tx.update(agencyKnowledgeRecords).set({ currentVersionId: ver.id }).where(eq(agencyKnowledgeRecords.id, input.recordId));
  await writeAudit(tx, ctx, { action: "agency_knowledge.version_added", entityType: "agency_knowledge_record", entityId: input.recordId, after: { version, current } });
  return { versionId: ver.id, version, current };
}

/** Moves the record through its lifecycle; `enforce_knowledge_transition` decides what is allowed and logs the transition. */
export async function transitionKnowledgeRecord(tx: Tx, ctx: RequestContext, input: { recordId: string; to: KnowledgeRecordState; note?: string }): Promise<void> {
  assertAgency(ctx, "changing a knowledge record state");
  const [before] = await tx.select({ state: agencyKnowledgeRecords.state }).from(agencyKnowledgeRecords).where(eq(agencyKnowledgeRecords.id, input.recordId));
  if (!before) throw new Error("knowledge record not found");
  await tx.update(agencyKnowledgeRecords).set({ state: input.to }).where(eq(agencyKnowledgeRecords.id, input.recordId));
  if (input.note) {
    // The trigger wrote the transition row; attach the human note to it.
    await tx.execute(sql`UPDATE agency_knowledge_transitions SET note = coalesce(note || '; ', '') || ${input.note} WHERE id = (SELECT id FROM agency_knowledge_transitions WHERE record_id = ${input.recordId} ORDER BY created_at DESC LIMIT 1)`);
  }
  await writeAudit(tx, ctx, { action: `agency_knowledge.${input.to}`, entityType: "agency_knowledge_record", entityId: input.recordId, before: { state: before.state }, after: { state: input.to }, metadata: input.note ? { note: input.note } : {} });
}

/**
 * Releases another stored version of a published record (roll forward or rollback). Reviewer only. Pinned
 * adoptions are never touched; the event records how many active adoptions still run an older version.
 */
export async function setCurrentVersion(tx: Tx, ctx: RequestContext, input: { recordId: string; versionId: string; reason: string }): Promise<{ kind: "release" | "rollback"; affectedAdoptions: number }> {
  assertAgency(ctx, "releasing a knowledge version");
  if (!hasRole(ctx, REVIEWER_ROLES)) throw new AuthorizationError("releasing or rolling back a version requires agency_reviewer or superadmin");
  const [rec] = await tx.select({ state: agencyKnowledgeRecords.state, currentVersionId: agencyKnowledgeRecords.currentVersionId }).from(agencyKnowledgeRecords).where(eq(agencyKnowledgeRecords.id, input.recordId));
  if (!rec) throw new Error("knowledge record not found");
  const [target] = await tx.select({ id: agencyKnowledgeVersions.id, version: agencyKnowledgeVersions.version }).from(agencyKnowledgeVersions).where(and(eq(agencyKnowledgeVersions.id, input.versionId), eq(agencyKnowledgeVersions.recordId, input.recordId)));
  if (!target) throw new Error("version does not belong to this record");
  const [current] = rec.currentVersionId ? await tx.select({ version: agencyKnowledgeVersions.version }).from(agencyKnowledgeVersions).where(eq(agencyKnowledgeVersions.id, rec.currentVersionId)) : [];
  const kind: "release" | "rollback" = current && target.version < current.version ? "rollback" : "release";
  const [count] = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM template_adoptions a JOIN methodology_templates t ON t.id = a.template_id WHERE t.record_id = ${input.recordId} AND a.state = 'active' AND a.record_version_id <> ${input.versionId}`).then((r) => r.rows);
  await tx.update(agencyKnowledgeRecords).set({ currentVersionId: input.versionId }).where(eq(agencyKnowledgeRecords.id, input.recordId));
  await tx.insert(knowledgeDeprecationEvents).values({ recordId: input.recordId, versionId: input.versionId, kind, reason: input.reason, affectedAdoptions: count?.n ?? 0, actorType: ctx.actorType, actorId: ctx.actorId });
  await writeAudit(tx, ctx, { action: `agency_knowledge.${kind}`, entityType: "agency_knowledge_record", entityId: input.recordId, after: { version: target.version, affectedAdoptions: count?.n ?? 0 }, metadata: { reason: input.reason } });
  return { kind, affectedAdoptions: count?.n ?? 0 };
}

/** Deprecates (or reinstates, or archives) a record with a logged reason. Adoptions keep their pinned version. */
export async function deprecateKnowledgeRecord(tx: Tx, ctx: RequestContext, input: { recordId: string; reason: string; kind?: "deprecate" | "reinstate" | "archive" | "consent_review" }): Promise<{ affectedAdoptions: number }> {
  assertAgency(ctx, "deprecating a knowledge record");
  const kind = input.kind ?? "deprecate";
  const [rec] = await tx.select({ currentVersionId: agencyKnowledgeRecords.currentVersionId }).from(agencyKnowledgeRecords).where(eq(agencyKnowledgeRecords.id, input.recordId));
  if (!rec) throw new Error("knowledge record not found");
  const [count] = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM template_adoptions a JOIN methodology_templates t ON t.id = a.template_id WHERE t.record_id = ${input.recordId} AND a.state = 'active'`).then((r) => r.rows);
  const to: KnowledgeRecordState | null = kind === "deprecate" ? "deprecated" : kind === "reinstate" ? "published" : kind === "archive" ? "archived" : null;
  if (to) await transitionKnowledgeRecord(tx, ctx, { recordId: input.recordId, to, note: input.reason });
  await tx.insert(knowledgeDeprecationEvents).values({ recordId: input.recordId, versionId: rec.currentVersionId, kind, reason: input.reason, affectedAdoptions: count?.n ?? 0, actorType: ctx.actorType, actorId: ctx.actorId });
  return { affectedAdoptions: count?.n ?? 0 };
}

export type AgencySearchHit = {
  recordId: string;
  versionId: string;
  path: string;
  title: string;
  kind: KnowledgeRecordKind;
  state: KnowledgeRecordState;
  rank: number;
  snippet: string;
};

/**
 * Full-text search over the current version of agency records. It only touches agency tables, so no client
 * document, fact, embedding or run trace can appear in a result (acceptance 4); the query is logged in audit_events.
 */
export async function searchAgencyVault(tx: Tx, ctx: RequestContext, input: { query: string; limit?: number; states?: KnowledgeRecordState[] }): Promise<AgencySearchHit[]> {
  assertAgency(ctx, "agency vault search");
  const q = input.query.trim().slice(0, 200);
  if (!q) return [];
  const limit = Math.min(50, Math.max(1, input.limit ?? 20));
  const states = input.states ?? ["draft", "in_review", "approved", "published", "deprecated"];
  const rows = await tx
    .execute<AgencySearchHit & Record<string, unknown>>(
      sql`SELECT r.id AS "recordId", v.id AS "versionId", r.path, r.title, r.kind, r.state,
                 ts_rank(v.search || to_tsvector('english', r.title), websearch_to_tsquery('english', ${q}))::float8 AS rank,
                 ts_headline('english', v.body_markdown, websearch_to_tsquery('english', ${q}), 'MaxWords=30, MinWords=10') AS snippet
          FROM agency_knowledge_records r
          JOIN agency_knowledge_versions v ON v.id = r.current_version_id
          WHERE r.state = ANY(${sql.raw(`ARRAY[${states.map((s) => `'${s}'`).join(",")}]::knowledge_record_state[]`)})
            AND (v.search || to_tsvector('english', r.title)) @@ websearch_to_tsquery('english', ${q})
          ORDER BY rank DESC
          LIMIT ${limit}`
    )
    .then((r) => r.rows);
  await writeAudit(tx, ctx, { action: "agency_knowledge.search", entityType: "agency_vault", after: { resultCount: rows.length }, metadata: { query: q } });
  return rows;
}

// Methodology templates and adoptions -------------------------------------------------------------

export interface CreateTemplateInput {
  key: string;
  recordId: string;
  name: string;
  description: string;
  targetFolder: string;
  parameters?: schema.TemplateParameter[];
}

export async function createMethodologyTemplate(tx: Tx, ctx: RequestContext, input: CreateTemplateInput): Promise<string> {
  assertAgency(ctx, "creating a methodology template");
  if (!(CLIENT_VAULT_FOLDERS as readonly string[]).includes(input.targetFolder)) throw new Error(`target folder "${input.targetFolder}" is not a client vault folder`);
  const [row] = await tx
    .insert(methodologyTemplates)
    .values({ key: input.key, recordId: input.recordId, name: input.name, description: input.description, targetFolder: input.targetFolder, parameters: input.parameters ?? [] })
    .returning({ id: methodologyTemplates.id });
  if (!row) throw new Error("template insert returned nothing");
  await writeAudit(tx, ctx, { action: "methodology_template.created", entityType: "methodology_template", entityId: row.id, after: { key: input.key, recordId: input.recordId } });
  return row.id;
}

/** Replaces `{{key}}` placeholders; required parameters must be present, unknown placeholders are an error. */
export function renderTemplate(body: string, parameters: schema.TemplateParameter[], values: Record<string, string>): string {
  const merged: Record<string, string> = {};
  for (const p of parameters) {
    const v = values[p.key] ?? p.default;
    if ((v === undefined || v === "") && p.required) throw new Error(`parameter "${p.key}" (${p.label}) is required`);
    merged[p.key] = v ?? "";
  }
  return body.replace(PLACEHOLDER_RE, (_m, key: string) => {
    if (!(key in merged)) throw new Error(`template uses placeholder {{${key}}} that is not declared as a parameter`);
    return merged[key] ?? "";
  });
}

export interface AdoptTemplateInput {
  tenantId: string;
  templateKey: string;
  parameters: Record<string, string>;
  /** Defaults to the record's current version. */
  versionId?: string;
  note?: string;
}

/**
 * Copies one published version of a template into a tenant's vault with the tenant's own values, and pins
 * it in `template_adoptions`. Runs in agency scope pinned to the tenant (`agencyContext({ tenantId })`), so RLS
 * lets the same transaction read the agency record and write the client document. A previous active adoption
 * of the same template becomes `superseded`.
 */
export async function adoptTemplate(tx: Tx, ctx: RequestContext, input: AdoptTemplateInput): Promise<{ adoptionId: string; documentId: string; version: number; path: string }> {
  assertAgency(ctx, "adopting a template");
  if (ctx.tenantId !== input.tenantId) throw new AuthorizationError("adoption runs in agency scope pinned to the target tenant");
  const [tpl] = await tx.select().from(methodologyTemplates).where(eq(methodologyTemplates.key, input.templateKey));
  if (!tpl) throw new Error(`template "${input.templateKey}" not found`);
  if (!tpl.active) throw new Error(`template "${input.templateKey}" is inactive`);
  const [rec] = await tx.select({ id: agencyKnowledgeRecords.id, state: agencyKnowledgeRecords.state, title: agencyKnowledgeRecords.title, currentVersionId: agencyKnowledgeRecords.currentVersionId, classification: agencyKnowledgeRecords.classification, license: agencyKnowledgeRecords.license }).from(agencyKnowledgeRecords).where(eq(agencyKnowledgeRecords.id, tpl.recordId));
  if (!rec) throw new Error("template record not found");
  if (rec.state !== "published") throw new Error(`template record is ${rec.state}; only published methods can be adopted`);
  const versionId = input.versionId ?? rec.currentVersionId;
  if (!versionId) throw new Error("template record has no current version");
  const [ver] = await tx.select().from(agencyKnowledgeVersions).where(and(eq(agencyKnowledgeVersions.id, versionId), eq(agencyKnowledgeVersions.recordId, rec.id)));
  if (!ver) throw new Error("version does not belong to the template record");

  const body = renderTemplate(ver.bodyMarkdown, tpl.parameters, input.parameters);
  const path = `${tpl.targetFolder}/${tpl.key}.md`;
  const frontmatter: Record<string, unknown> = {
    ...ver.frontmatter,
    sbos_template_key: tpl.key,
    sbos_template_version: ver.version,
    sbos_template_checksum: ver.checksum,
    sbos_adopted_at: new Date().toISOString(),
    sbos_origin: "agency_template",
    parameters: input.parameters
  };
  const doc = await writeVaultDocument(tx, ctx, { tenantId: input.tenantId, path, title: `${tpl.name}`, frontmatter, bodyMarkdown: body, classification: "internal", verification: "verified", changeNote: `adopted ${tpl.key} v${ver.version}${input.note ? `: ${input.note}` : ""}` });

  const [previous] = await tx.select({ id: templateAdoptions.id }).from(templateAdoptions).where(and(eq(templateAdoptions.tenantId, input.tenantId), eq(templateAdoptions.templateId, tpl.id), eq(templateAdoptions.state, "active")));
  if (previous) await tx.update(templateAdoptions).set({ state: "superseded", endedAt: new Date() }).where(eq(templateAdoptions.id, previous.id));
  const [adoption] = await tx
    .insert(templateAdoptions)
    .values({ tenantId: input.tenantId, templateId: tpl.id, recordVersionId: ver.id, version: ver.version, parameters: input.parameters, state: "active", vaultDocumentId: doc.documentId, previousAdoptionId: previous?.id ?? null, adoptedByActorId: ctx.actorId, note: input.note ?? null })
    .returning({ id: templateAdoptions.id });
  if (!adoption) throw new Error("adoption insert returned nothing");
  await writeAudit(tx, ctx, { action: "template.adopted", entityType: "template_adoption", entityId: adoption.id, after: { templateKey: tpl.key, version: ver.version, documentId: doc.documentId, superseded: previous?.id ?? null } });
  return { adoptionId: adoption.id, documentId: doc.documentId, version: ver.version, path };
}

/** Rolls a tenant back to the version of its previous adoption; the rolled-back row stays for the audit trail. */
export async function rollbackAdoption(tx: Tx, ctx: RequestContext, input: { tenantId: string; adoptionId: string; reason: string }): Promise<{ adoptionId: string; version: number }> {
  assertAgency(ctx, "rolling back an adoption");
  if (ctx.tenantId !== input.tenantId) throw new AuthorizationError("rollback runs in agency scope pinned to the target tenant");
  const [current] = await tx.select().from(templateAdoptions).where(and(eq(templateAdoptions.id, input.adoptionId), eq(templateAdoptions.tenantId, input.tenantId)));
  if (!current) throw new Error("adoption not found in this tenant");
  if (current.state !== "active") throw new Error(`adoption is ${current.state}; only the active adoption can be rolled back`);
  if (!current.previousAdoptionId) throw new Error("this is the first adoption of the template; there is no earlier version to return to");
  const [previous] = await tx.select().from(templateAdoptions).where(eq(templateAdoptions.id, current.previousAdoptionId));
  if (!previous) throw new Error("previous adoption not found");
  const [tpl] = await tx.select({ key: methodologyTemplates.key }).from(methodologyTemplates).where(eq(methodologyTemplates.id, current.templateId));
  if (!tpl) throw new Error("template not found");
  await tx.update(templateAdoptions).set({ state: "rolled_back", endedAt: new Date(), note: `${current.note ? `${current.note}; ` : ""}rolled back: ${input.reason}` }).where(eq(templateAdoptions.id, current.id));
  const readopted = await adoptTemplate(tx, ctx, { tenantId: input.tenantId, templateKey: tpl.key, parameters: previous.parameters, versionId: previous.recordVersionId, note: `rollback of adoption ${current.id.slice(0, 8)}: ${input.reason}` });
  await writeAudit(tx, ctx, { action: "template.rolled_back", entityType: "template_adoption", entityId: current.id, after: { toVersion: readopted.version, newAdoptionId: readopted.adoptionId }, metadata: { reason: input.reason } });
  return { adoptionId: readopted.adoptionId, version: readopted.version };
}

/** Ends an adoption without touching the client's copy (the document stays, marked in frontmatter). */
export async function revokeAdoption(tx: Tx, ctx: RequestContext, input: { tenantId: string; adoptionId: string; reason: string }): Promise<void> {
  assertAgency(ctx, "revoking an adoption");
  if (ctx.tenantId !== input.tenantId) throw new AuthorizationError("revocation runs in agency scope pinned to the target tenant");
  const [current] = await tx.select().from(templateAdoptions).where(and(eq(templateAdoptions.id, input.adoptionId), eq(templateAdoptions.tenantId, input.tenantId)));
  if (!current) throw new Error("adoption not found in this tenant");
  if (current.state !== "active") throw new Error(`adoption is ${current.state}`);
  await tx.update(templateAdoptions).set({ state: "revoked", endedAt: new Date(), note: `${current.note ? `${current.note}; ` : ""}revoked: ${input.reason}` }).where(eq(templateAdoptions.id, current.id));
  if (current.vaultDocumentId) {
    const [doc] = await tx.select({ frontmatter: vaultDocuments.frontmatter }).from(vaultDocuments).where(eq(vaultDocuments.id, current.vaultDocumentId));
    if (doc) await tx.update(vaultDocuments).set({ frontmatter: { ...(doc.frontmatter as Record<string, unknown>), sbos_template_revoked_at: new Date().toISOString() }, updatedByActorId: ctx.actorId }).where(eq(vaultDocuments.id, current.vaultDocumentId));
  }
  await writeAudit(tx, ctx, { action: "template.revoked", entityType: "template_adoption", entityId: current.id, metadata: { reason: input.reason } });
}

// Client -> Agency promotion gate -----------------------------------------------------------------

export interface NominateInsightInput {
  tenantId: string;
  title: string;
  proposedGenericStatement: string;
  rationale: string;
  classification?: (typeof schema.classification.enumValues)[number];
  confidentiality?: "public" | "internal" | "confidential";
  identifiabilityRisk?: "low" | "medium" | "high";
  rightsBasis?: string | null;
  consentStatus?: (typeof schema.consentStatus.enumValues)[number];
  ownerRole?: string;
  sourceRefs?: Record<string, unknown>;
  runId?: string | null;
}

/**
 * An agent (or a client user) nominates a Potential Reusable Insight from the tenant's own scenario. The row
 * is created in tenant scope with state `nominated`; the trigger refuses any other initial state. Nothing is
 * copied anywhere until a reviewer approves it.
 */
export async function nominateReusableInsight(tx: Tx, ctx: RequestContext, input: NominateInsightInput): Promise<string> {
  if (ctx.kind === "operator" || ctx.tenantId !== input.tenantId) throw new AuthorizationError("a nomination is made inside the source tenant's context");
  if (input.proposedGenericStatement.trim().length < 20) throw new Error("the proposed generic statement must describe the pattern (at least 20 characters)");
  const [row] = await tx
    .insert(knowledgePromotionRequests)
    .values({
      tenantId: input.tenantId,
      nominatedByActorType: ctx.actorType,
      nominatedByActorId: ctx.actorId,
      runId: input.runId ?? null,
      title: input.title,
      proposedGenericStatement: input.proposedGenericStatement,
      rationale: input.rationale,
      classification: input.classification ?? "internal",
      confidentiality: input.confidentiality ?? "confidential",
      identifiabilityRisk: input.identifiabilityRisk ?? "medium",
      rightsBasis: input.rightsBasis ?? null,
      consentStatus: input.consentStatus ?? "pending",
      ownerRole: input.ownerRole ?? "agency_reviewer",
      sourceRefs: input.sourceRefs ?? {},
      state: "nominated"
    })
    .returning({ id: knowledgePromotionRequests.id });
  if (!row) throw new Error("promotion request insert returned nothing");
  await writeAudit(tx, ctx, { action: "knowledge_promotion.nominated", entityType: "knowledge_promotion_request", entityId: row.id, after: { title: input.title, identifiabilityRisk: input.identifiabilityRisk ?? "medium" } });
  return row.id;
}

export interface ReviewPromotionInput {
  requestId: string;
  decision: (typeof schema.promotionDecision.enumValues)[number];
  rightsCheck: boolean;
  securityCheck: boolean;
  identifiabilityCheck: boolean;
  note: string;
  /** Recorded on the request when the reviewer confirms the legal basis. */
  consentStatus?: (typeof schema.consentStatus.enumValues)[number];
  rightsBasis?: string;
}

/**
 * Records a human review and moves the request: `approve` with all three checks -> approved,
 * `reject` -> rejected, `needs_changes` -> back to nominated. The trigger refuses approval without a
 * qualifying review or without a recorded consent status.
 */
export async function reviewPromotion(tx: Tx, ctx: RequestContext, input: ReviewPromotionInput): Promise<PromotionState> {
  assertAgency(ctx, "reviewing a promotion request");
  if (!hasRole(ctx, REVIEWER_ROLES)) throw new AuthorizationError("reviewing requires agency_reviewer or superadmin");
  if (ctx.actorType === "agent") throw new AuthorizationError("agents cannot review promotion requests");
  const [req] = await tx.select({ state: knowledgePromotionRequests.state }).from(knowledgePromotionRequests).where(eq(knowledgePromotionRequests.id, input.requestId));
  if (!req) throw new Error("promotion request not found");
  if (req.state === "nominated") await tx.update(knowledgePromotionRequests).set({ state: "in_review" }).where(eq(knowledgePromotionRequests.id, input.requestId));
  else if (req.state !== "in_review") throw new Error(`promotion request is ${req.state}; only nominated or in-review requests take reviews`);
  await tx.insert(knowledgePromotionReviews).values({ requestId: input.requestId, reviewerActorType: ctx.actorType, reviewerActorId: ctx.actorId, roles: [...ctx.roles], decision: input.decision, rightsCheck: input.rightsCheck, securityCheck: input.securityCheck, identifiabilityCheck: input.identifiabilityCheck, note: input.note });
  const to: PromotionState = input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "nominated";
  await tx
    .update(knowledgePromotionRequests)
    .set({ state: to, ...(input.consentStatus ? { consentStatus: input.consentStatus } : {}), ...(input.rightsBasis ? { rightsBasis: input.rightsBasis } : {}) })
    .where(eq(knowledgePromotionRequests.id, input.requestId));
  await writeAudit(tx, ctx, { action: `knowledge_promotion.${to}`, entityType: "knowledge_promotion_request", entityId: input.requestId, after: { decision: input.decision, rightsCheck: input.rightsCheck, securityCheck: input.securityCheck, identifiabilityCheck: input.identifiabilityCheck }, metadata: { note: input.note } });
  return to;
}

export interface PublishPromotionInput {
  requestId: string;
  path: string;
  title?: string;
  kind?: KnowledgeRecordKind;
  /** The generic, de-identified text the reviewer publishes. Defaults to the proposed generic statement. */
  bodyMarkdown?: string;
  license?: string | null;
  allowedUses?: string[];
  relatedSkillKeys?: string[];
}

/**
 * Turns an approved promotion request into a self-contained agency record and publishes it. The record carries
 * the rights basis and the request id (agency-internal metadata) but no tenant identifier, no source ids and
 * no client text other than what the reviewer approved, so no other client can trace it back (spec 4H "Publish").
 */
export async function publishPromotion(tx: Tx, ctx: RequestContext, input: PublishPromotionInput): Promise<{ recordId: string; versionId: string }> {
  assertAgency(ctx, "publishing a promotion");
  if (!hasRole(ctx, REVIEWER_ROLES)) throw new AuthorizationError("publishing requires agency_reviewer or superadmin");
  const [req] = await tx.select().from(knowledgePromotionRequests).where(eq(knowledgePromotionRequests.id, input.requestId));
  if (!req) throw new Error("promotion request not found");
  if (req.state !== "approved") throw new Error(`promotion request is ${req.state}; only approved requests are published`);
  const body = input.bodyMarkdown ?? `# ${input.title ?? req.title}\n\n${req.proposedGenericStatement}\n\n## Why it is reusable\n\n${req.rationale}`;
  const created = await createKnowledgeRecord(tx, ctx, {
    path: input.path,
    title: input.title ?? req.title,
    kind: input.kind ?? "reusable_insight",
    bodyMarkdown: body,
    frontmatter: { origin: "abstracted_from_client", rights_basis: req.rightsBasis ?? "recorded on the promotion request", consent_status: req.consentStatus, confidentiality: req.confidentiality, identifiability_risk: req.identifiabilityRisk, promotion_request: req.id },
    changelog: "published from an approved promotion request",
    classification: req.classification,
    origin: "abstracted_from_client",
    license: input.license ?? null,
    allowedUses: input.allowedUses ?? ["internal_method"],
    relatedSkillKeys: input.relatedSkillKeys ?? [],
    promotionRequestId: req.id
  });
  for (const to of ["in_review", "approved", "published"] as const) await transitionKnowledgeRecord(tx, ctx, { recordId: created.recordId, to, note: to === "published" ? `promotion ${req.id.slice(0, 8)} approved by ${req.reviewerActorId ?? ctx.actorId}` : undefined });
  await tx.update(knowledgePromotionRequests).set({ state: "published", publishedRecordId: created.recordId }).where(eq(knowledgePromotionRequests.id, req.id));
  await writeAudit(tx, ctx, { action: "knowledge_promotion.published", entityType: "knowledge_promotion_request", entityId: req.id, after: { recordId: created.recordId, path: input.path } });
  return created;
}

// Evaluation cases --------------------------------------------------------------------------------

export async function upsertEvaluationCase(tx: Tx, ctx: RequestContext, input: { recordId: string; name: string; input: Record<string, unknown>; expected: Record<string, unknown> }): Promise<string> {
  assertAgency(ctx, "defining an evaluation case");
  const [row] = await tx
    .insert(evaluationCases)
    .values({ recordId: input.recordId, name: input.name, input: input.input, expected: input.expected, createdByActorId: ctx.actorId })
    .onConflictDoUpdate({ target: [evaluationCases.recordId, evaluationCases.name], set: { input: input.input, expected: input.expected } })
    .returning({ id: evaluationCases.id });
  if (!row) throw new Error("evaluation case upsert returned nothing");
  return row.id;
}

export async function recordEvaluationResult(tx: Tx, ctx: RequestContext, input: { caseId: string; versionId: string; result: "pass" | "fail" }): Promise<void> {
  assertAgency(ctx, "recording an evaluation result");
  await tx.update(evaluationCases).set({ lastResult: input.result, lastRunAt: new Date(), lastVersionId: input.versionId }).where(eq(evaluationCases.id, input.caseId));
  await writeAudit(tx, ctx, { action: "evaluation_case.result", entityType: "evaluation_case", entityId: input.caseId, after: { result: input.result, versionId: input.versionId } });
}
