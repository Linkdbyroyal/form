import { boolean, index, integer, pgSchema, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Better Auth tables (ADR-015). Generated with `@better-auth/cli generate` against the 1.7.18 config
 * (email/password + organization + twoFactor + admin plugins) and moved into Postgres schema `auth`
 * with snake_case columns. Mirrors `migrations/0003_auth.sql`.
 *
 * These tables are identity data, not client content: no `tenant_id`, no RLS, no grants to the
 * app roles. Only the owner/migration role and the web app's dedicated auth pool use them.
 */
export const authSchema = pgSchema("auth");

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const authUser = authSchema.table(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    // twoFactor plugin
    twoFactorEnabled: boolean("two_factor_enabled").default(false),
    // admin plugin
    role: text("role"),
    banned: boolean("banned").default(false),
    banReason: text("ban_reason"),
    banExpires: ts("ban_expires")
  },
  (t) => [uniqueIndex("user_email_uidx").on(t.email)]
);

export const authSession = authSchema.table(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: ts("expires_at").notNull(),
    token: text("token").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id").notNull().references(() => authUser.id, { onDelete: "cascade" }),
    // organization plugin
    activeOrganizationId: text("active_organization_id"),
    // admin plugin
    impersonatedBy: text("impersonated_by")
  },
  (t) => [uniqueIndex("session_token_uidx").on(t.token), index("session_user_id_idx").on(t.userId)]
);

export const authAccount = authSchema.table(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull().references(() => authUser.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow()
  },
  (t) => [index("account_user_id_idx").on(t.userId)]
);

export const authVerification = authSchema.table(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow()
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)]
);

export const authOrganization = authSchema.table(
  "organization",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    logo: text("logo"),
    createdAt: ts("created_at").notNull().defaultNow(),
    metadata: text("metadata")
  },
  (t) => [uniqueIndex("organization_slug_uidx").on(t.slug)]
);

export const authMember = authSchema.table(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => authOrganization.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => authUser.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [index("member_organization_id_idx").on(t.organizationId), index("member_user_id_idx").on(t.userId)]
);

export const authInvitation = authSchema.table(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => authOrganization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull().default("pending"),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    inviterId: text("inviter_id").notNull().references(() => authUser.id, { onDelete: "cascade" })
  },
  (t) => [index("invitation_organization_id_idx").on(t.organizationId), index("invitation_email_idx").on(t.email)]
);

export const authTwoFactor = authSchema.table(
  "two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id").notNull().references(() => authUser.id, { onDelete: "cascade" }),
    verified: boolean("verified").default(true),
    failedVerificationCount: integer("failed_verification_count").default(0),
    lockedUntil: ts("locked_until")
  },
  (t) => [index("two_factor_secret_idx").on(t.secret), index("two_factor_user_id_idx").on(t.userId)]
);

/**
 * Schema object keyed by Better Auth model name. Pass this same object to `drizzle()` and to
 * `drizzleAdapter()` so the adapter can resolve every model.
 */
export const betterAuthSchema = {
  user: authUser,
  session: authSession,
  account: authAccount,
  verification: authVerification,
  organization: authOrganization,
  member: authMember,
  invitation: authInvitation,
  twoFactor: authTwoFactor
} as const;
