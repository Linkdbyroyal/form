import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { actorType } from "./enums";
import { tenants, users } from "./core";
import { consentStatus } from "./vault";
import { connectionPhase, connections } from "./xray";

/** Milestone 5: connection phases with consent, sync runs with lineage, webhook endpoints (secret by reference). */
const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const tenantId = () => uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" });
const textArray = (name: string) => text(name).array().notNull().default(sql`'{}'::text[]`);

export const syncRunStatus = pgEnum("sync_run_status", ["running", "succeeded", "failed", "skipped"]);
export const syncTrigger = pgEnum("sync_trigger", ["schedule", "manual", "test"]);

export const connectionPhaseChanges = pgTable(
  "connection_phase_changes",
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid("connection_id").notNull().references(() => connections.id, { onDelete: "cascade" }),
    fromPhase: connectionPhase("from_phase"),
    toPhase: connectionPhase("to_phase").notNull(),
    kind: text("kind").notNull(),
    consent: consentStatus("consent"),
    scopes: textArray("scopes"),
    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    roles: textArray("roles"),
    reason: text("reason").notNull(),
    reviewOutcome: text("review_outcome"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("connection_phase_changes_connection_idx").on(t.connectionId, t.createdAt)]
);

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: id(),
    tenantId: tenantId(),
    connectionId: uuid("connection_id").notNull().references(() => connections.id, { onDelete: "cascade" }),
    trigger: syncTrigger("trigger").notNull(),
    phase: connectionPhase("phase").notNull(),
    mode: text("mode").notNull(),
    status: syncRunStatus("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    objectsRead: integer("objects_read").notNull().default(0),
    observationsWritten: integer("observations_written").notNull().default(0),
    errorClass: text("error_class"),
    errorMessage: text("error_message"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({})
  },
  (t) => [index("sync_runs_connection_idx").on(t.connectionId, t.startedAt)]
);

export const webhookEndpoints = pgTable("webhook_endpoints", {
  id: id(),
  tenantId: tenantId(),
  connectionId: uuid("connection_id").notNull().references(() => connections.id, { onDelete: "cascade" }),
  pathToken: text("path_token").notNull().unique(),
  secretRef: text("secret_ref").notNull(),
  signatureState: text("signature_state").notNull().default("unverified"),
  lastReceivedAt: timestamp("last_received_at", { withTimezone: true }),
  createdByActorId: text("created_by_actor_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});
