import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { actorType, roleScope, tenantKind, tenantStatus, userStatus } from "./enums";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** One row per client company, plus exactly one `agency` tenant for Second Brain itself. */
export const tenants = pgTable(
  "tenants",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    kind: tenantKind("kind").notNull().default("client"),
    status: tenantStatus("status").notNull().default("onboarding"),
    locale: text("locale").notNull().default("en"),
    industry: text("industry"),
    settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [uniqueIndex("tenants_slug_idx").on(t.slug)]
);

/** Global identities. The auth provider (M1) maps its account id to `users.id`. */
export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    status: userStatus("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [uniqueIndex("users_email_idx").on(sql`lower(${t.email})`)]
);

/** Role catalogue. Global, not tenant-scoped. */
export const roles = pgTable("roles", {
  key: text("key").primaryKey(),
  scope: roleScope("scope").notNull(),
  description: text("description").notNull()
});

/** user x tenant x role. */
export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    roleKey: text("role_key").notNull().references(() => roles.key),
    departmentKey: text("department_key"),
    createdAt: createdAt()
  },
  (t) => [
    uniqueIndex("memberships_unique_idx").on(t.tenantId, t.userId, t.roleKey),
    index("memberships_user_idx").on(t.userId)
  ]
);

/** Explicit, time-boxed permission for an agency user to read a client's content (spec 4F). */
export const clientContentGrants = pgTable(
  "client_content_grants",
  {
    id: id(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    grantedBy: uuid("granted_by").notNull().references(() => users.id),
    reason: text("reason").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt()
  },
  (t) => [index("client_content_grants_user_tenant_idx").on(t.userId, t.tenantId)]
);

/** Append-only audit trail. The app role has INSERT and SELECT only. */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "restrict" }),
    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    beforeHash: text("before_hash"),
    afterHash: text("after_hash"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("audit_events_tenant_time_idx").on(t.tenantId, t.occurredAt)]
);

