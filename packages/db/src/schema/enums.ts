import { pgEnum } from "drizzle-orm/pg-core";

export const tenantKind = pgEnum("tenant_kind", ["client", "agency", "demo"]);
export const tenantStatus = pgEnum("tenant_status", ["onboarding", "active", "paused", "offboarded"]);
export const userStatus = pgEnum("user_status", ["invited", "active", "disabled"]);
export const roleScope = pgEnum("role_scope", ["agency", "client"]);
export const actorType = pgEnum("actor_type", ["user", "agent", "system"]);
export const apiCapability = pgEnum("api_capability", ["api", "mcp", "webhook", "export", "none"]);
export const systemClaimStatus = pgEnum("system_claim_status", ["stated", "verified_exists", "connected"]);
