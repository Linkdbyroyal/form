import { sql } from "drizzle-orm";
import { boolean, customType, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });
import { actorType } from "./enums";
import { clientContentGrants, tenants, users } from "./core";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const tenantId = () => uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" });

export const authorityTier = pgEnum("authority_tier", ["t1", "t2", "t3"]);
export const definitionStatus = pgEnum("definition_status", ["draft", "active", "deprecated"]);
export const releaseChannel = pgEnum("release_channel", ["draft", "beta", "stable", "deprecated"]);
export const agentState = pgEnum("agent_state", ["active", "idle", "running", "paused", "blocked", "error", "disabled"]);
export const taskState = pgEnum("task_state", ["draft", "open", "assigned", "in_progress", "waiting_input", "waiting_approval", "done", "cancelled", "failed"]);
export const taskPriority = pgEnum("task_priority", ["critical", "high", "medium", "low"]);
export const runTrigger = pgEnum("run_trigger", ["schedule", "event", "command", "resume", "recovery"]);
export const runState = pgEnum("run_state", ["queued", "running", "waiting_for_input", "waiting_for_approval", "paused", "succeeded", "failed", "cancelled", "timed_out", "interrupted"]);
export const runEventKind = pgEnum("run_event_kind", ["state_change", "step_started", "step_finished", "tool_call", "tool_denied", "model_call", "question_created", "approval_requested", "approval_decided", "output_written", "checkpoint", "help_request", "error", "note"]);
export const classification = pgEnum("classification", ["public", "internal", "confidential", "restricted"]);
export const approvalState = pgEnum("approval_state", ["pending", "approved", "rejected", "expired", "withdrawn"]);
export const riskLevel = pgEnum("risk_level", ["low", "medium", "high", "critical"]);
export const misfirePolicy = pgEnum("misfire_policy", ["skip", "run_once_late"]);
export const incidentKind = pgEnum("incident_kind", ["run_failed", "dead_letter", "missed_schedule", "budget_exceeded", "credential_invalid", "worker_error", "notification_failed", "lease_expired", "tool_denied", "admission_refused"]);
export const incidentState = pgEnum("incident_state", ["open", "acknowledged", "resolved"]);
export const budgetScope = pgEnum("budget_scope", ["platform", "tenant", "agent_instance"]);
export const notificationChannel = pgEnum("notification_channel", ["email", "pumble"]);
export const notificationState = pgEnum("notification_state", ["queued", "sent", "failed"]);
export const questionState = pgEnum("question_state", ["draft", "open", "answered", "skipped", "superseded"]);
export const verificationStatus = pgEnum("verification_status", ["unconfirmed", "hypothesis", "evidence_backed", "verified", "approved_policy", "deprecated"]);
export const feedbackKind = pgEnum("feedback_kind", ["correction", "approval", "rejection", "clarification", "instruction"]);

export const skills = pgTable("skills", {
  id: id(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  status: definitionStatus("status").notNull().default("active"),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});

export const skillVersions = pgTable(
  "skill_versions",
  {
    id: id(),
    skillId: uuid("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    skillMd: text("skill_md").notNull(),
    contracts: text("contracts").array().notNull().default(sql`'{}'::text[]`),
    allowedTools: text("allowed_tools").array().notNull().default(sql`'{}'::text[]`),
    releaseChannel: releaseChannel("release_channel").notNull().default("draft"),
    checksum: text("checksum").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex("skill_versions_skill_version_idx").on(t.skillId, t.version)]
);

export const skillReleaseChannels = pgTable("skill_release_channels", {
  id: id(),
  skillId: uuid("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  channel: releaseChannel("channel").notNull(),
  skillVersionId: uuid("skill_version_id").notNull().references(() => skillVersions.id),
  updatedBy: text("updated_by").notNull(),
  updatedAt: updatedAt()
});

export const agentDefinitions = pgTable("agent_definitions", {
  id: id(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  mission: text("mission").notNull(),
  department: text("department"),
  skillId: uuid("skill_id").references(() => skills.id),
  defaultModel: text("default_model").notNull().default("claude-sonnet-5-5"),
  modelPolicy: jsonb("model_policy").notNull().default(sql`'{}'::jsonb`),
  allowedTools: text("allowed_tools").array().notNull().default(sql`'{}'::text[]`),
  requiredData: text("required_data").array().notNull().default(sql`'{}'::text[]`),
  authority: authorityTier("authority").notNull().default("t1"),
  defaultScheduleCron: text("default_schedule_cron"),
  escalationRole: text("escalation_role"),
  defaultBudgetUsdMonth: numeric("default_budget_usd_month", { precision: 10, scale: 2 }).notNull().default("5.00"),
  defaultRunCapUsd: numeric("default_run_cap_usd", { precision: 10, scale: 4 }).notNull().default("0.50"),
  inputContracts: text("input_contracts").array().notNull().default(sql`'{}'::text[]`),
  outputContracts: text("output_contracts").array().notNull().default(sql`'{}'::text[]`),
  qualityCriteria: text("quality_criteria").array().notNull().default(sql`'{}'::text[]`),
  ownerRole: text("owner_role").notNull().default("superadmin"),
  status: definitionStatus("status").notNull().default("active"),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});

export const budgets = pgTable("budgets", {
  id: id(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
  scope: budgetScope("scope").notNull(),
  agentInstanceId: uuid("agent_instance_id"),
  capUsdMonth: numeric("cap_usd_month", { precision: 10, scale: 2 }).notNull(),
  runCapUsd: numeric("run_cap_usd", { precision: 10, scale: 4 }).notNull().default("0.50"),
  warnRatio: numeric("warn_ratio", { precision: 3, scale: 2 }).notNull().default("0.80"),
  hardStop: boolean("hard_stop").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt()
});

export const agentInstances = pgTable(
  "agent_instances",
  {
    id: id(),
    tenantId: tenantId(),
    definitionId: uuid("definition_id").notNull().references(() => agentDefinitions.id),
    skillVersionId: uuid("skill_version_id").references(() => skillVersions.id),
    name: text("name").notNull(),
    state: agentState("state").notNull().default("idle"),
    serviceIdentity: text("service_identity").notNull(),
    model: text("model"),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextScheduledRunAt: timestamp("next_scheduled_run_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [index("agent_instances_tenant_idx").on(t.tenantId), uniqueIndex("agent_instances_identity_idx").on(t.tenantId, t.serviceIdentity)]
);

export const agentTasks = pgTable(
  "agent_tasks",
  {
    id: id(),
    tenantId: tenantId(),
    agentInstanceId: uuid("agent_instance_id").references(() => agentInstances.id, { onDelete: "set null" }),
    parentTaskId: uuid("parent_task_id"),
    title: text("title").notNull(),
    instruction: text("instruction").notNull(),
    department: text("department"),
    priority: taskPriority("priority").notNull().default("medium"),
    state: taskState("state").notNull().default("open"),
    ownerRole: text("owner_role"),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    createdByActorType: actorType("created_by_actor_type").notNull(),
    createdByActorId: text("created_by_actor_id").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [index("agent_tasks_tenant_state_idx").on(t.tenantId, t.state)]
);

export const schedules = pgTable(
  "schedules",
  {
    id: id(),
    tenantId: tenantId(),
    agentInstanceId: uuid("agent_instance_id").notNull().references(() => agentInstances.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    enabled: boolean("enabled").notNull().default(true),
    expectedBySeconds: integer("expected_by_seconds").notNull().default(900),
    misfire: misfirePolicy("misfire").notNull().default("skip"),
    instruction: text("instruction"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [index("schedules_tenant_idx").on(t.tenantId)]
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: id(),
    tenantId: tenantId(),
    agentInstanceId: uuid("agent_instance_id").notNull().references(() => agentInstances.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => agentTasks.id, { onDelete: "set null" }),
    scheduleId: uuid("schedule_id").references(() => schedules.id, { onDelete: "set null" }),
    skillVersionId: uuid("skill_version_id").references(() => skillVersions.id),
    /** Delegation lineage (ADR-024): the run that spawned this one, when a flow delegates to a sub-agent. */
    parentRunId: uuid("parent_run_id"),
    trigger: runTrigger("trigger").notNull(),
    triggerRef: text("trigger_ref"),
    state: runState("state").notNull().default("queued"),
    attempt: integer("attempt").notNull().default(1),
    jobId: text("job_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    summary: text("summary"),
    error: jsonb("error"),
    tokensInput: integer("tokens_input").notNull().default(0),
    tokensOutput: integer("tokens_output").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    simulated: boolean("simulated").notNull().default(false),
    checkpoint: jsonb("checkpoint"),
    result: jsonb("result"),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [index("agent_runs_tenant_state_idx").on(t.tenantId, t.state), index("agent_runs_instance_idx").on(t.agentInstanceId, t.createdAt)]
);

export const runEvents = pgTable(
  "run_events",
  {
    id: id(),
    tenantId: tenantId(),
    runId: uuid("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: runEventKind("kind").notNull(),
    classification: classification("classification").notNull().default("internal"),
    summary: text("summary").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    tokensInput: integer("tokens_input").notNull().default(0),
    tokensOutput: integer("tokens_output").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    durationMs: integer("duration_ms"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [uniqueIndex("run_events_run_seq_idx").on(t.runId, t.seq)]
);

export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    tenantId: tenantId(),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    taskId: uuid("task_id").references(() => agentTasks.id, { onDelete: "set null" }),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id"),
    requestedByActorType: actorType("requested_by_actor_type").notNull(),
    requestedByActorId: text("requested_by_actor_id").notNull(),
    approverRole: text("approver_role").notNull(),
    risk: riskLevel("risk").notNull(),
    summary: text("summary").notNull(),
    rationale: text("rationale").notNull(),
    evidenceIds: uuid("evidence_ids").array().notNull().default(sql`'{}'::uuid[]`),
    blocking: boolean("blocking").notNull().default(true),
    state: approvalState("state").notNull().default("pending"),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id),
    decidedByActorId: text("decided_by_actor_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [index("approvals_tenant_state_idx").on(t.tenantId, t.state)]
);

export const approvedActions = pgTable("approved_actions", {
  id: id(),
  tenantId: tenantId(),
  runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  actionType: text("action_type").notNull(),
  risk: riskLevel("risk").notNull(),
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  approvalId: uuid("approval_id").references(() => approvals.id),
  executedAt: timestamp("executed_at", { withTimezone: true }),
  result: jsonb("result"),
  createdAt: createdAt()
});

export const incidents = pgTable(
  "incidents",
  {
    id: id(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    kind: incidentKind("kind").notNull(),
    severity: riskLevel("severity").notNull().default("medium"),
    title: text("title").notNull(),
    details: jsonb("details").notNull().default(sql`'{}'::jsonb`),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    scheduleId: uuid("schedule_id").references(() => schedules.id, { onDelete: "set null" }),
    agentInstanceId: uuid("agent_instance_id").references(() => agentInstances.id, { onDelete: "set null" }),
    state: incidentState("state").notNull().default("open"),
    acknowledgedBy: text("acknowledged_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    dedupeKey: text("dedupe_key"),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [index("incidents_state_idx").on(t.state, t.createdAt)]
);

export const costEvents = pgTable("cost_events", {
  id: id(),
  tenantId: tenantId(),
  runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  agentInstanceId: uuid("agent_instance_id").references(() => agentInstances.id, { onDelete: "set null" }),
  taskId: uuid("task_id").references(() => agentTasks.id, { onDelete: "set null" }),
  model: text("model").notNull(),
  tokensInput: integer("tokens_input").notNull(),
  tokensOutput: integer("tokens_output").notNull(),
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull(),
  simulated: boolean("simulated").notNull().default(false),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow()
});

export const agentFeedback = pgTable("agent_feedback", {
  id: id(),
  tenantId: tenantId(),
  agentInstanceId: uuid("agent_instance_id").notNull().references(() => agentInstances.id, { onDelete: "cascade" }),
  runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  taskId: uuid("task_id").references(() => agentTasks.id, { onDelete: "set null" }),
  givenByActorId: text("given_by_actor_id").notNull(),
  kind: feedbackKind("kind").notNull(),
  message: text("message").notNull(),
  appliesTo: jsonb("applies_to"),
  shouldUpdateSkill: boolean("should_update_skill").notNull().default(false),
  createdAt: createdAt()
});

export const notifications = pgTable("notifications", {
  id: id(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
  channel: notificationChannel("channel").notNull(),
  template: text("template").notNull(),
  recipientRole: text("recipient_role"),
  recipientUserId: uuid("recipient_user_id").references(() => users.id, { onDelete: "set null" }),
  subject: text("subject").notNull(),
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  state: notificationState("state").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: createdAt()
});

export const knowledgeAccessLogs = pgTable("knowledge_access_logs", {
  id: id(),
  tenantId: tenantId(),
  actorType: actorType("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  grantId: uuid("grant_id").references(() => clientContentGrants.id, { onDelete: "set null" }),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  purpose: text("purpose"),
  accessedAt: timestamp("accessed_at", { withTimezone: true }).notNull().defaultNow()
});

export const interviewRounds = pgTable("interview_rounds", {
  id: id(),
  tenantId: tenantId(),
  runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  roundNumber: integer("round_number").notNull(),
  department: text("department"),
  rationale: text("rationale").notNull(),
  createdAt: createdAt()
});

export const questions = pgTable(
  "questions",
  {
    id: id(),
    tenantId: tenantId(),
    roundId: uuid("round_id").references(() => interviewRounds.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    department: text("department").notNull(),
    recipientRole: text("recipient_role").notNull(),
    questionText: text("question_text").notNull(),
    reason: text("reason").notNull(),
    evidenceGap: text("evidence_gap").notNull(),
    priority: taskPriority("priority").notNull(),
    answerType: text("answer_type").notNull(),
    options: text("options").array().notNull().default(sql`'{}'::text[]`),
    state: questionState("state").notNull().default("draft"),
    confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull().default("0.5"),
    askedByAgentInstanceId: uuid("asked_by_agent_instance_id").references(() => agentInstances.id, { onDelete: "set null" }),
    dependsOn: uuid("depends_on").array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [index("questions_tenant_state_idx").on(t.tenantId, t.state)]
);

export const vaultDocuments = pgTable(
  "vault_documents",
  {
    id: id(),
    tenantId: tenantId(),
    path: text("path").notNull(),
    title: text("title").notNull(),
    frontmatter: jsonb("frontmatter").notNull().default(sql`'{}'::jsonb`),
    bodyMarkdown: text("body_markdown").notNull(),
    classification: classification("classification").notNull().default("confidential"),
    verification: verificationStatus("verification").notNull().default("unconfirmed"),
    version: integer("version").notNull().default(1),
    checksum: text("checksum").notNull(),
    createdByActorType: actorType("created_by_actor_type").notNull(),
    createdByActorId: text("created_by_actor_id").notNull(),
    updatedByActorId: text("updated_by_actor_id").notNull(),
    /** Generated column (migration 0005). Never written by the application. */
    search: tsvector("search"),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [uniqueIndex("vault_documents_tenant_path_idx").on(t.tenantId, t.path)]
);

export const vaultRevisions = pgTable(
  "vault_revisions",
  {
    id: id(),
    tenantId: tenantId(),
    documentId: uuid("document_id").notNull().references(() => vaultDocuments.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    frontmatter: jsonb("frontmatter").notNull(),
    bodyMarkdown: text("body_markdown").notNull(),
    checksum: text("checksum").notNull(),
    changedByActorType: actorType("changed_by_actor_type").notNull(),
    changedByActorId: text("changed_by_actor_id").notNull(),
    changeNote: text("change_note"),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    createdAt: createdAt()
  },
  (t) => [uniqueIndex("vault_revisions_doc_version_idx").on(t.documentId, t.version)]
);

/** Operator instructions for a run, applied at its next checkpoint (ADR-024). Agents never write them. */
export const runInstructions = pgTable(
  "run_instructions",
  {
    id: id(),
    tenantId: tenantId(),
    runId: uuid("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    createdByActorType: actorType("created_by_actor_type").notNull(),
    createdByActorId: text("created_by_actor_id").notNull(),
    createdAt: createdAt(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumedAtStep: text("consumed_at_step")
  },
  (t) => [index("run_instructions_run_idx").on(t.runId, t.createdAt)]
);
