import { sql } from "drizzle-orm";
import { customType, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { actorType } from "./enums";
import { tenants } from "./core";
import { agentRuns, classification, questions, vaultDocuments, verificationStatus } from "./agents";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const tenantId = () => uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" });
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const consentStatus = pgEnum("consent_status", ["not_required", "pending", "granted", "revoked"]);
export const evidenceKind = pgEnum("evidence_kind", ["document", "system_record", "interview_answer", "screenshot", "metric", "observation"]);
export const verificationRequestState = pgEnum("verification_request_state", ["open", "verified", "rejected", "merged"]);
export const proposalState = pgEnum("proposal_state", ["pending", "approved", "rejected"]);
export const retrievalKind = pgEnum("retrieval_kind", ["fts", "facts", "document", "agent_context"]);

export const sources = pgTable("sources", {
  id: id(),
  tenantId: tenantId(),
  system: text("system").notNull(),
  locator: text("locator"),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }),
  checksum: text("checksum"),
  classification: classification("classification").notNull().default("confidential"),
  consent: consentStatus("consent").notNull().default("not_required"),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  createdByActorType: actorType("created_by_actor_type").notNull(),
  createdByActorId: text("created_by_actor_id").notNull(),
  createdAt: createdAt()
});

export const vaultFacts = pgTable(
  "vault_facts",
  {
    id: id(),
    tenantId: tenantId(),
    statement: text("statement").notNull(),
    subjectType: text("subject_type"),
    subjectKey: text("subject_key"),
    sourceIds: uuid("source_ids").array().notNull().default(sql`'{}'::uuid[]`),
    originSystem: text("origin_system").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    responsibleRole: text("responsible_role"),
    verification: verificationStatus("verification").notNull().default("unconfirmed"),
    confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull().default("0.50"),
    classification: classification("classification").notNull().default("confidential"),
    version: integer("version").notNull().default(1),
    accessPolicy: text("access_policy").array().notNull().default(sql`'{}'::text[]`),
    supersededBy: uuid("superseded_by"),
    contradicts: uuid("contradicts").array().notNull().default(sql`'{}'::uuid[]`),
    createdByActorType: actorType("created_by_actor_type").notNull(),
    createdByActorId: text("created_by_actor_id").notNull(),
    updatedByActorId: text("updated_by_actor_id").notNull(),
    search: tsvector("search"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("vault_facts_tenant_idx").on(t.tenantId, t.verification), index("vault_facts_subject_idx").on(t.tenantId, t.subjectType, t.subjectKey)]
);

export const answers = pgTable(
  "answers",
  {
    id: id(),
    tenantId: tenantId(),
    questionId: uuid("question_id").notNull().references(() => questions.id, { onDelete: "cascade" }),
    answerValue: jsonb("answer_value").notNull(),
    answerText: text("answer_text").notNull(),
    answeredByActorType: actorType("answered_by_actor_type").notNull(),
    answeredByActorId: text("answered_by_actor_id").notNull(),
    answeredByRole: text("answered_by_role").notNull(),
    answeredAt: timestamp("answered_at", { withTimezone: true }).notNull().defaultNow(),
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
    factId: uuid("fact_id").references(() => vaultFacts.id, { onDelete: "set null" }),
    verification: verificationStatus("verification").notNull().default("unconfirmed"),
    notes: text("notes"),
    supersedesAnswerId: uuid("supersedes_answer_id"),
    createdAt: createdAt()
  },
  (t) => [index("answers_tenant_question_idx").on(t.tenantId, t.questionId)]
);

export const evidence = pgTable("evidence", {
  id: id(),
  tenantId: tenantId(),
  kind: evidenceKind("kind").notNull(),
  summary: text("summary").notNull(),
  sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  classification: classification("classification").notNull().default("confidential"),
  verification: verificationStatus("verification").notNull().default("unconfirmed"),
  checksum: text("checksum"),
  relatedEntityType: text("related_entity_type"),
  relatedEntityId: uuid("related_entity_id"),
  createdByActorType: actorType("created_by_actor_type").notNull(),
  createdByActorId: text("created_by_actor_id").notNull(),
  createdAt: createdAt()
});

export const vaultFactRevisions = pgTable(
  "vault_fact_revisions",
  {
    id: id(),
    tenantId: tenantId(),
    factId: uuid("fact_id").notNull().references(() => vaultFacts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    statement: text("statement").notNull(),
    verification: verificationStatus("verification").notNull(),
    confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull(),
    sourceIds: uuid("source_ids").array().notNull(),
    changedByActorType: actorType("changed_by_actor_type").notNull(),
    changedByActorId: text("changed_by_actor_id").notNull(),
    changeNote: text("change_note"),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex("vault_fact_revisions_fact_version_idx").on(t.factId, t.version)]
);

export const vaultLinks = pgTable(
  "vault_links",
  {
    id: id(),
    tenantId: tenantId(),
    fromDocumentId: uuid("from_document_id").notNull().references(() => vaultDocuments.id, { onDelete: "cascade" }),
    toPath: text("to_path").notNull(),
    toDocumentId: uuid("to_document_id").references(() => vaultDocuments.id, { onDelete: "set null" }),
    linkText: text("link_text"),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex("vault_links_from_to_idx").on(t.fromDocumentId, t.toPath)]
);

export const factVerificationRequests = pgTable(
  "fact_verification_requests",
  {
    id: id(),
    tenantId: tenantId(),
    factId: uuid("fact_id").notNull().references(() => vaultFacts.id, { onDelete: "cascade" }),
    conflictingFactIds: uuid("conflicting_fact_ids").array().notNull().default(sql`'{}'::uuid[]`),
    raisedByActorType: actorType("raised_by_actor_type").notNull(),
    raisedByActorId: text("raised_by_actor_id").notNull(),
    reason: text("reason").notNull(),
    evidenceIds: uuid("evidence_ids").array().notNull().default(sql`'{}'::uuid[]`),
    requestedReviewerRole: text("requested_reviewer_role").notNull().default("client_admin"),
    state: verificationRequestState("state").notNull().default("open"),
    resolvedByActorId: text("resolved_by_actor_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("fvr_tenant_state_idx").on(t.tenantId, t.state)]
);

export const vaultChangeProposals = pgTable(
  "vault_change_proposals",
  {
    id: id(),
    tenantId: tenantId(),
    documentId: uuid("document_id").references(() => vaultDocuments.id, { onDelete: "set null" }),
    path: text("path").notNull(),
    title: text("title").notNull(),
    frontmatter: jsonb("frontmatter").notNull().default(sql`'{}'::jsonb`),
    bodyMarkdown: text("body_markdown").notNull(),
    changeNote: text("change_note"),
    proposedByActorType: actorType("proposed_by_actor_type").notNull(),
    proposedByActorId: text("proposed_by_actor_id").notNull(),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    state: proposalState("state").notNull().default("pending"),
    decidedByActorId: text("decided_by_actor_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    createdAt: createdAt()
  },
  (t) => [index("vcp_tenant_state_idx").on(t.tenantId, t.state)]
);

export const retrievalAudit = pgTable("retrieval_audit", {
  id: id(),
  tenantId: tenantId(),
  actorType: actorType("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  kind: retrievalKind("kind").notNull(),
  query: text("query"),
  resultIds: uuid("result_ids").array().notNull().default(sql`'{}'::uuid[]`),
  resultCount: integer("result_count").notNull().default(0),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow()
});

export const tenantPolicies = pgTable(
  "tenant_policies",
  {
    id: id(),
    tenantId: tenantId(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    updatedByActorId: text("updated_by_actor_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [uniqueIndex("tenant_policies_tenant_key_idx").on(t.tenantId, t.key)]
);
