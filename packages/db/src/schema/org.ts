import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { apiCapability, systemClaimStatus } from "./enums";
import { tenants } from "./core";

/** Tenant organisation map. */
export const departments = pgTable(
  "departments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    headRole: text("head_role"),
    parentId: uuid("parent_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [uniqueIndex("departments_tenant_key_idx").on(t.tenantId, t.key)]
);

/**
 * Software register: what the client says they use. `claim_status` distinguishes a stated
 * application from a verified one and from a working connection (spec 4A).
 */
export const systems = pgTable(
  "systems",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    vendor: text("vendor"),
    function: text("function").notNull(),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
    administratorRole: text("administrator_role"),
    sourceOfTruthFor: text("source_of_truth_for").array().notNull().default(sql`'{}'::text[]`),
    dataTypes: text("data_types").array().notNull().default(sql`'{}'::text[]`),
    apiCapabilities: apiCapability("api_capabilities").array().notNull().default(sql`'{none}'::api_capability[]`),
    claimStatus: systemClaimStatus("claim_status").notNull().default("stated"),
    /** Free text that may contain client-confidential detail. Not readable by the operator role. */
    notes: text("notes"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("systems_tenant_idx").on(t.tenantId)]
);
