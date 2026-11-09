import { sql } from "drizzle-orm";
import { boolean, date, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { actorType } from "./enums";
import { tenants } from "./core";
import { agentRuns, classification, vaultDocuments } from "./agents";
import { consentStatus } from "./vault";

/**
 * Milestone 4: Agency Intelligence Vault (spec 4H). Agency tables have no tenant_id and are visible in
 * agency scope only; `template_adoptions` and `knowledge_promotion_requests` are tenant rows.
 */
const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const textArray = (name: string) => text(name).array().notNull().default(sql`'{}'::text[]`);

export const knowledgeRecordState = pgEnum("knowledge_record_state", ["draft", "in_review", "approved", "published", "deprecated", "archived"]);
export const knowledgeRecordKind = pgEnum("knowledge_record_kind", ["method_template", "process_pattern", "interview_set", "sop", "dashboard_template", "kpi_definition", "skill_note", "blueprint", "reusable_insight", "research_note", "decision", "other"]);
export const knowledgeOrigin = pgEnum("knowledge_origin", ["own", "public_license", "abstracted_from_client"]);
export const promotionState = pgEnum("promotion_state", ["nominated", "in_review", "approved", "rejected", "withdrawn", "published"]);
export const promotionDecision = pgEnum("promotion_decision", ["approve", "reject", "needs_changes"]);
export const adoptionState = pgEnum("adoption_state", ["active", "superseded", "rolled_back", "revoked"]);
export const deprecationKind = pgEnum("deprecation_kind", ["release", "deprecate", "rollback", "reinstate", "archive", "consent_review"]);

export const agencyKnowledgeRecords = pgTable(
  "agency_knowledge_records",
  {
    id: id(),
    folder: text("folder").notNull(),
    path: text("path").notNull(),
    title: text("title").notNull(),
    kind: knowledgeRecordKind("kind").notNull().default("other"),
    state: knowledgeRecordState("state").notNull().default("draft"),
    currentVersionId: uuid("current_version_id").references((): AnyPgColumn => agencyKnowledgeVersions.id, { onDelete: "set null" }),
    ownerActorId: text("owner_actor_id").notNull(),
    classification: classification("classification").notNull().default("internal"),
    origin: knowledgeOrigin("origin").notNull().default("own"),
    license: text("license"),
    allowedUses: textArray("allowed_uses"),
    sourceVersion: text("source_version"),
    reviewDueAt: date("review_due_at"),
    confidence: numeric("confidence", { precision: 3, scale: 2 }),
    promotionRequestId: uuid("promotion_request_id").references((): AnyPgColumn => knowledgePromotionRequests.id, { onDelete: "restrict" }),
    relatedSkillKeys: textArray("related_skill_keys"),
    createdByActorType: actorType("created_by_actor_type").notNull(),
    createdByActorId: text("created_by_actor_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [uniqueIndex("agency_knowledge_records_path_key").on(t.path), index("agency_knowledge_records_folder_idx").on(t.folder, t.state)]
);

export const agencyKnowledgeVersions = pgTable(
  "agency_knowledge_versions",
  {
    id: id(),
    recordId: uuid("record_id").notNull().references(() => agencyKnowledgeRecords.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    frontmatter: jsonb("frontmatter").$type<Record<string, unknown>>().notNull().default({}),
    bodyMarkdown: text("body_markdown").notNull(),
    changelog: text("changelog").notNull(),
    checksum: text("checksum").notNull(),
    evidenceLink: text("evidence_link"),
    createdByActorType: actorType("created_by_actor_type").notNull(),
    createdByActorId: text("created_by_actor_id").notNull(),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex("agency_knowledge_versions_record_version_key").on(t.recordId, t.version)]
);

export const agencyKnowledgeTransitions = pgTable("agency_knowledge_transitions", {
  id: id(),
  recordId: uuid("record_id").notNull().references(() => agencyKnowledgeRecords.id, { onDelete: "cascade" }),
  fromState: knowledgeRecordState("from_state"),
  toState: knowledgeRecordState("to_state").notNull(),
  actorType: actorType("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  roles: textArray("roles"),
  note: text("note"),
  createdAt: createdAt()
});

export const knowledgePromotionRequests = pgTable(
  "knowledge_promotion_requests",
  {
    id: id(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    nominatedByActorType: actorType("nominated_by_actor_type").notNull(),
    nominatedByActorId: text("nominated_by_actor_id").notNull(),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    proposedGenericStatement: text("proposed_generic_statement").notNull(),
    rationale: text("rationale").notNull(),
    classification: classification("classification").notNull().default("internal"),
    confidentiality: text("confidentiality").notNull().default("confidential"),
    identifiabilityRisk: text("identifiability_risk").notNull().default("medium"),
    rightsBasis: text("rights_basis"),
    consentStatus: consentStatus("consent_status").notNull().default("pending"),
    ownerRole: text("owner_role").notNull().default("agency_reviewer"),
    reviewerRole: text("reviewer_role").notNull().default("agency_reviewer"),
    sourceRefs: jsonb("source_refs").$type<Record<string, unknown>>().notNull().default({}),
    state: promotionState("state").notNull().default("nominated"),
    reviewerActorId: text("reviewer_actor_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    publishedRecordId: uuid("published_record_id").references((): AnyPgColumn => agencyKnowledgeRecords.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [index("knowledge_promotion_requests_state_idx").on(t.state, t.createdAt)]
);

export const knowledgePromotionReviews = pgTable("knowledge_promotion_reviews", {
  id: id(),
  requestId: uuid("request_id").notNull().references(() => knowledgePromotionRequests.id, { onDelete: "cascade" }),
  reviewerActorType: actorType("reviewer_actor_type").notNull(),
  reviewerActorId: text("reviewer_actor_id").notNull(),
  roles: textArray("roles"),
  decision: promotionDecision("decision").notNull(),
  rightsCheck: boolean("rights_check").notNull().default(false),
  securityCheck: boolean("security_check").notNull().default(false),
  identifiabilityCheck: boolean("identifiability_check").notNull().default(false),
  note: text("note").notNull(),
  createdAt: createdAt()
});

export interface TemplateParameter {
  key: string;
  label: string;
  required: boolean;
  default?: string;
  description?: string;
}

export const methodologyTemplates = pgTable("methodology_templates", {
  id: id(),
  key: text("key").notNull().unique(),
  recordId: uuid("record_id").notNull().references(() => agencyKnowledgeRecords.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  description: text("description").notNull(),
  targetFolder: text("target_folder").notNull(),
  parameters: jsonb("parameters").$type<TemplateParameter[]>().notNull().default([]),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});

export const templateAdoptions = pgTable(
  "template_adoptions",
  {
    id: id(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    templateId: uuid("template_id").notNull().references(() => methodologyTemplates.id, { onDelete: "restrict" }),
    recordVersionId: uuid("record_version_id").notNull().references(() => agencyKnowledgeVersions.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    parameters: jsonb("parameters").$type<Record<string, string>>().notNull().default({}),
    state: adoptionState("state").notNull().default("active"),
    vaultDocumentId: uuid("vault_document_id").references(() => vaultDocuments.id, { onDelete: "set null" }),
    previousAdoptionId: uuid("previous_adoption_id").references((): AnyPgColumn => templateAdoptions.id, { onDelete: "set null" }),
    adoptedByActorId: text("adopted_by_actor_id").notNull(),
    adoptedAt: timestamp("adopted_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    note: text("note")
  },
  (t) => [index("template_adoptions_tenant_idx").on(t.tenantId, t.templateId, t.state)]
);

export const evaluationCases = pgTable(
  "evaluation_cases",
  {
    id: id(),
    recordId: uuid("record_id").notNull().references(() => agencyKnowledgeRecords.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
    expected: jsonb("expected").$type<Record<string, unknown>>().notNull().default({}),
    lastResult: text("last_result").notNull().default("not_run"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastVersionId: uuid("last_version_id").references(() => agencyKnowledgeVersions.id, { onDelete: "set null" }),
    createdByActorId: text("created_by_actor_id").notNull(),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex("evaluation_cases_record_name_key").on(t.recordId, t.name)]
);

export const knowledgeDeprecationEvents = pgTable("knowledge_deprecation_events", {
  id: id(),
  recordId: uuid("record_id").notNull().references(() => agencyKnowledgeRecords.id, { onDelete: "cascade" }),
  versionId: uuid("version_id").references(() => agencyKnowledgeVersions.id, { onDelete: "set null" }),
  kind: deprecationKind("kind").notNull(),
  reason: text("reason").notNull(),
  affectedAdoptions: integer("affected_adoptions").notNull().default(0),
  actorType: actorType("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  createdAt: createdAt()
});
