import { sql } from "drizzle-orm";
import { boolean, date, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { actorType } from "./enums";
import { tenants, users } from "./core";
import { systems } from "./org";
import { agentInstances, agentRuns, approvals, schedules, vaultDocuments, verificationStatus } from "./agents";
import { consentStatus, sources } from "./vault";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const tenantId = () => uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" });
const uuidArray = (name: string) => uuid(name).array().notNull().default(sql`'{}'::uuid[]`);

export const processStepKind = pgEnum("process_step_kind", ["trigger", "input", "activity", "handoff", "decision", "control", "output"]);
export const interventionType = pgEnum("intervention_type", ["stop", "simplify", "standardize", "integrate", "automate", "keep_human"]);
export const claimType = pgEnum("claim_type", ["client_statement", "data_observation", "hypothesis"]);
export const findingSeverity = pgEnum("finding_severity", ["critical", "high", "medium", "low", "info"]);
export const findingState = pgEnum("finding_state", ["open", "validated", "dismissed", "resolved"]);
export const opportunityState = pgEnum("opportunity_state", ["proposed", "approved", "rejected", "in_progress", "delivered", "verified"]);
export const refreshFrequency = pgEnum("refresh_frequency", ["realtime", "hourly", "daily", "weekly", "monthly", "manual"]);
export const kpiDirection = pgEnum("kpi_direction", ["higher_is_better", "lower_is_better"]);
export const kpiReliability = pgEnum("kpi_reliability", ["high", "medium", "low", "unknown"]);
export const kpiStatus = pgEnum("kpi_status", ["draft", "active", "stale", "missing_source", "retired"]);
export const observationStatus = pgEnum("observation_status", ["ok", "missing_data", "stale_data", "error"]);
export const dashboardAudience = pgEnum("dashboard_audience", ["ceo", "cfo", "coo", "team_lead", "consultant", "auditor", "custom"]);
export const widgetType = pgEnum("widget_type", ["kpi_tile", "trend_line", "bar", "table", "action_list", "briefing", "risk_list", "data_gap_list", "text_note"]);
export const actionTaskState = pgEnum("action_task_state", ["proposed", "awaiting_approval", "approved", "assigned", "in_progress", "verifying", "closed", "escalated", "rejected"]);
export const connectionPhase = pgEnum("connection_phase", ["metadata", "read_only", "sandbox", "write"]);
export const connectionStatus = pgEnum("connection_status", ["proposed", "consent_pending", "active", "paused", "revoked", "error"]);

export const processes = pgTable(
  "processes",
  {
    id: id(),
    tenantId: tenantId(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    department: text("department"),
    variant: text("variant").notNull().default("as_is"),
    ownerRole: text("owner_role"),
    description: text("description"),
    sourceIds: uuidArray("source_ids"),
    verification: verificationStatus("verification").notNull().default("unconfirmed"),
    vaultDocumentId: uuid("vault_document_id").references(() => vaultDocuments.id, { onDelete: "set null" }),
    createdByActorType: actorType("created_by_actor_type").notNull(),
    createdByActorId: text("created_by_actor_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [uniqueIndex("processes_tenant_key_variant_idx").on(t.tenantId, t.key, t.variant)]
);

export const processSteps = pgTable(
  "process_steps",
  {
    id: id(),
    tenantId: tenantId(),
    processId: uuid("process_id").notNull().references(() => processes.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: processStepKind("kind").notNull().default("activity"),
    name: text("name").notNull(),
    ownerRole: text("owner_role"),
    systemName: text("system_name"),
    input: text("input"),
    output: text("output"),
    waitTimeHint: text("wait_time_hint"),
    exceptions: text("exceptions"),
    control: text("control"),
    intervention: interventionType("intervention"),
    sourceIds: uuidArray("source_ids")
  },
  (t) => [uniqueIndex("process_steps_process_seq_idx").on(t.processId, t.seq)]
);

export const painPoints = pgTable("pain_points", {
  id: id(),
  tenantId: tenantId(),
  processId: uuid("process_id").references(() => processes.id, { onDelete: "set null" }),
  stepId: uuid("step_id").references(() => processSteps.id, { onDelete: "set null" }),
  description: text("description").notNull(),
  claim: claimType("claim").notNull(),
  evidenceIds: uuidArray("evidence_ids"),
  createdByActorType: actorType("created_by_actor_type").notNull(),
  createdByActorId: text("created_by_actor_id").notNull(),
  createdAt: createdAt()
});

export const findings = pgTable(
  "findings",
  {
    id: id(),
    tenantId: tenantId(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    department: text("department").notNull(),
    processId: uuid("process_id").references(() => processes.id, { onDelete: "set null" }),
    severity: findingSeverity("severity").notNull(),
    urgency: text("urgency").notNull(),
    impact: jsonb("impact").notNull().default(sql`'{}'::jsonb`),
    ownerRole: text("owner_role").notNull(),
    evidenceIds: uuidArray("evidence_ids"),
    sourceIds: uuidArray("source_ids"),
    claim: claimType("claim").notNull(),
    confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull().default("0.50"),
    state: findingState("state").notNull().default("open"),
    reviewStatus: text("review_status").notNull().default("unreviewed"),
    agentInstanceId: uuid("agent_instance_id").references(() => agentInstances.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [index("findings_tenant_state_idx").on(t.tenantId, t.state)]
);

export const opportunities = pgTable(
  "opportunities",
  {
    id: id(),
    tenantId: tenantId(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    findingIds: uuidArray("finding_ids"),
    intervention: interventionType("intervention").notNull(),
    businessCase: jsonb("business_case").notNull().default(sql`'{}'::jsonb`),
    priorityScore: jsonb("priority_score").notNull().default(sql`'{}'::jsonb`),
    toBeProcessId: uuid("to_be_process_id").references(() => processes.id, { onDelete: "set null" }),
    state: opportunityState("state").notNull().default("proposed"),
    requiresApproval: boolean("requires_approval").notNull().default(true),
    approvalId: uuid("approval_id").references(() => approvals.id),
    sourceIds: uuidArray("source_ids"),
    confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull().default("0.50"),
    reviewStatus: text("review_status").notNull().default("unreviewed"),
    agentInstanceId: uuid("agent_instance_id").references(() => agentInstances.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [index("opportunities_tenant_state_idx").on(t.tenantId, t.state)]
);

export const kpis = pgTable(
  "kpis",
  {
    id: id(),
    tenantId: tenantId(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    businessQuestion: text("business_question").notNull(),
    formula: text("formula").notNull(),
    unit: text("unit").notNull(),
    sourceSystem: text("source_system").notNull(),
    sourceField: text("source_field").notNull(),
    ownerRole: text("owner_role").notNull(),
    filters: jsonb("filters").notNull().default(sql`'{}'::jsonb`),
    refresh: refreshFrequency("refresh").notNull().default("daily"),
    direction: kpiDirection("direction").notNull().default("higher_is_better"),
    warningThreshold: numeric("warning_threshold"),
    criticalThreshold: numeric("critical_threshold"),
    reliability: kpiReliability("reliability").notNull().default("unknown"),
    permissionScope: text("permission_scope").array().notNull().default(sql`'{}'::text[]`),
    historyRetentionDays: integer("history_retention_days").notNull().default(730),
    lastSuccessfulSyncAt: timestamp("last_successful_sync_at", { withTimezone: true }),
    status: kpiStatus("status").notNull().default("draft"),
    createdByActorType: actorType("created_by_actor_type").notNull(),
    createdByActorId: text("created_by_actor_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [uniqueIndex("kpis_tenant_key_idx").on(t.tenantId, t.key)]
);

export const kpiObservations = pgTable(
  "kpi_observations",
  {
    id: id(),
    tenantId: tenantId(),
    kpiId: uuid("kpi_id").notNull().references(() => kpis.id, { onDelete: "cascade" }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    value: numeric("value"),
    status: observationStatus("status").notNull(),
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
    computedByActorType: actorType("computed_by_actor_type").notNull(),
    computedByActorId: text("computed_by_actor_id").notNull(),
    lineage: jsonb("lineage").notNull().default(sql`'{}'::jsonb`),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    syncRunId: uuid("sync_run_id")
  },
  (t) => [index("kpi_observations_kpi_time_idx").on(t.kpiId, t.observedAt)]
);

export const dashboards = pgTable("dashboards", {
  id: id(),
  tenantId: tenantId(),
  audience: dashboardAudience("audience").notNull(),
  title: text("title").notNull(),
  locale: text("locale").notNull().default("en"),
  version: integer("version").notNull().default(1),
  specification: jsonb("specification").notNull(),
  reviewStatus: text("review_status").notNull().default("unreviewed"),
  generatedByAgentInstanceId: uuid("generated_by_agent_instance_id").references(() => agentInstances.id, { onDelete: "set null" }),
  runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  isCurrent: boolean("is_current").notNull().default(false),
  createdAt: createdAt()
});

export const dashboardWidgets = pgTable(
  "dashboard_widgets",
  {
    id: id(),
    tenantId: tenantId(),
    dashboardId: uuid("dashboard_id").notNull().references(() => dashboards.id, { onDelete: "cascade" }),
    widgetKey: text("widget_key").notNull(),
    type: widgetType("type").notNull(),
    kpiIds: uuidArray("kpi_ids"),
    priority: integer("priority").notNull().default(100),
    reason: text("reason").notNull(),
    size: text("size").notNull().default("m"),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`)
  },
  (t) => [uniqueIndex("dashboard_widgets_dash_key_idx").on(t.dashboardId, t.widgetKey)]
);

export const actionTasks = pgTable(
  "action_tasks",
  {
    id: id(),
    tenantId: tenantId(),
    title: text("title").notNull(),
    issue: text("issue").notNull(),
    proposedAction: text("proposed_action").notNull(),
    opportunityId: uuid("opportunity_id").references(() => opportunities.id, { onDelete: "set null" }),
    findingId: uuid("finding_id").references(() => findings.id, { onDelete: "set null" }),
    ownerRole: text("owner_role"),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    approvalId: uuid("approval_id").references(() => approvals.id),
    state: actionTaskState("state").notNull().default("proposed"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    verificationScheduleId: uuid("verification_schedule_id").references(() => schedules.id, { onDelete: "set null" }),
    verificationNote: text("verification_note"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    sourceIds: uuidArray("source_ids"),
    createdByActorType: actorType("created_by_actor_type").notNull(),
    createdByActorId: text("created_by_actor_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [index("action_tasks_tenant_state_idx").on(t.tenantId, t.state)]
);

export const briefings = pgTable(
  "briefings",
  {
    id: id(),
    tenantId: tenantId(),
    briefingDate: date("briefing_date").notNull(),
    audience: dashboardAudience("audience").notNull().default("ceo"),
    content: jsonb("content").notNull(),
    vaultDocumentId: uuid("vault_document_id").references(() => vaultDocuments.id, { onDelete: "set null" }),
    agentInstanceId: uuid("agent_instance_id").references(() => agentInstances.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    simulated: boolean("simulated").notNull().default(false),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex("briefings_tenant_date_audience_idx").on(t.tenantId, t.briefingDate, t.audience)]
);

export const connections = pgTable(
  "connections",
  {
    id: id(),
    tenantId: tenantId(),
    systemId: uuid("system_id").references(() => systems.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    phase: connectionPhase("phase").notNull().default("metadata"),
    status: connectionStatus("status").notNull().default("proposed"),
    consent: consentStatus("consent").notNull().default("pending"),
    consentGivenByUserId: uuid("consent_given_by_user_id").references(() => users.id),
    consentGivenAt: timestamp("consent_given_at", { withTimezone: true }),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastError: text("last_error"),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    syncIntervalMinutes: integer("sync_interval_minutes").notNull().default(60),
    securityReviewedAt: timestamp("security_reviewed_at", { withTimezone: true }),
    securityReviewedBy: text("security_reviewed_by"),
    pausedReason: text("paused_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [index("connections_tenant_idx").on(t.tenantId, t.provider)]
);

export const credentialsMetadata = pgTable("credentials_metadata", {
  id: id(),
  tenantId: tenantId(),
  connectionId: uuid("connection_id").notNull().references(() => connections.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  secretRef: text("secret_ref").notNull(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdByActorId: text("created_by_actor_id").notNull(),
  createdAt: createdAt()
});
