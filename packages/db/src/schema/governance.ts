import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { actorType } from "./enums";
import { tenants, users } from "./core";
import { skillVersions } from "./agents";
import { agencyKnowledgeRecords } from "./agency";

/** Milestone 6: Technology Intelligence Center (spec 4D) and data retention / deletion requests. */
const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const textArray = (name: string) => text(name).array().notNull().default(sql`'{}'::text[]`);

export const techSourceKind = pgEnum("tech_source_kind", ["official_docs", "changelog", "github_releases", "security_advisory", "standard", "regulation", "test_results"]);
export const techFetchKind = pgEnum("tech_fetch_kind", ["github_releases", "rss", "json", "manual"]);
export const upgradeKind = pgEnum("upgrade_kind", ["knowledge_update", "skill_update", "code_update"]);
export const upgradeStatus = pgEnum("upgrade_status", ["detected", "assessed", "approved", "applied", "rolled_back", "rejected"]);
export const securityRisk = pgEnum("security_risk", ["none", "low", "medium", "high", "critical"]);
export const deletionKind = pgEnum("deletion_kind", ["document", "connection_data", "subject_data", "tenant_offboarding"]);
export const deletionState = pgEnum("deletion_state", ["requested", "approved", "rejected", "executing", "completed"]);

export const techSources = pgTable("tech_sources", {
  id: id(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  kind: techSourceKind("kind").notNull(),
  fetchKind: techFetchKind("fetch_kind").notNull().default("manual"),
  url: text("url").notNull(),
  approved: boolean("approved").notNull().default(false),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  relevantAgentKeys: textArray("relevant_agent_keys"),
  checkIntervalHours: integer("check_interval_hours").notNull().default(24),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdByActorId: text("created_by_actor_id").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});

export const techUpdates = pgTable(
  "tech_updates",
  {
    id: id(),
    sourceId: uuid("source_id").notNull().references(() => techSources.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    subject: text("subject").notNull(),
    currentVersion: text("current_version"),
    proposedVersion: text("proposed_version").notNull(),
    sourceUrl: text("source_url").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    summary: text("summary").notNull().default(""),
    kind: upgradeKind("kind"),
    relevantAgentKeys: textArray("relevant_agent_keys"),
    potentialBenefit: text("potential_benefit"),
    compatibilityNotes: text("compatibility_notes"),
    securityRisk: securityRisk("security_risk"),
    migrationPlan: text("migration_plan"),
    testResult: text("test_result"),
    rollbackPlan: text("rollback_plan"),
    pullRequestUrl: text("pull_request_url"),
    skillVersionId: uuid("skill_version_id").references(() => skillVersions.id, { onDelete: "set null" }),
    previousSkillVersionId: uuid("previous_skill_version_id").references(() => skillVersions.id, { onDelete: "set null" }),
    knowledgeRecordId: uuid("knowledge_record_id").references(() => agencyKnowledgeRecords.id, { onDelete: "set null" }),
    reviewerActorId: text("reviewer_actor_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    status: upgradeStatus("status").notNull().default("detected"),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [index("tech_updates_status_idx").on(t.status, t.detectedAt)]
);

export const techUpdateTransitions = pgTable("tech_update_transitions", {
  id: id(),
  updateId: uuid("update_id").notNull().references(() => techUpdates.id, { onDelete: "cascade" }),
  fromStatus: upgradeStatus("from_status"),
  toStatus: upgradeStatus("to_status").notNull(),
  actorType: actorType("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  roles: textArray("roles"),
  note: text("note"),
  createdAt: createdAt()
});

export const techWatchRuns = pgTable("tech_watch_runs", {
  id: id(),
  sourceId: uuid("source_id").notNull().references(() => techSources.id, { onDelete: "cascade" }),
  mode: text("mode").notNull(),
  status: text("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }).notNull().defaultNow(),
  itemsSeen: integer("items_seen").notNull().default(0),
  updatesNew: integer("updates_new").notNull().default(0),
  errorMessage: text("error_message")
});

export const retentionPolicies = pgTable("retention_policies", {
  id: id(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
  dataClass: text("data_class").notNull(),
  retentionDays: integer("retention_days").notNull(),
  reason: text("reason").notNull(),
  setByActorId: text("set_by_actor_id").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});

export const retentionSweeps = pgTable("retention_sweeps", {
  id: id(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
  dataClass: text("data_class").notNull(),
  cutoff: timestamp("cutoff", { withTimezone: true }).notNull(),
  deletedCount: integer("deleted_count").notNull(),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow()
});

export const deletionRequests = pgTable(
  "deletion_requests",
  {
    id: id(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    kind: deletionKind("kind").notNull(),
    subjectRef: text("subject_ref").notNull(),
    reason: text("reason").notNull(),
    requestedByActorType: actorType("requested_by_actor_type").notNull(),
    requestedByActorId: text("requested_by_actor_id").notNull(),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, { onDelete: "set null" }),
    state: deletionState("state").notNull().default("requested"),
    legalHold: boolean("legal_hold").notNull().default(false),
    reviewerActorId: text("reviewer_actor_id"),
    reviewNote: text("review_note"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [index("deletion_requests_tenant_idx").on(t.tenantId, t.state)]
);
