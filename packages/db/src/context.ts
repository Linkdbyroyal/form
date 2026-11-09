/**
 * Request context that every database transaction runs under.
 * It is translated into Postgres session settings (`SET LOCAL app.*`) and a `SET LOCAL ROLE`,
 * so Row-Level Security policies and column grants decide what the query can see.
 */
export type ActorType = "user" | "agent" | "system";

export interface TenantContext {
  kind: "tenant";
  tenantId: string;
  actorType: ActorType;
  actorId: string;
  roles: readonly string[];
}

/** Cross-client operational view for agency staff. Never sees content columns. */
export interface OperatorContext {
  kind: "operator";
  actorType: ActorType;
  actorId: string;
  roles: readonly string[];
}

/** Agency scope acting inside a tenant (for example creating a tenant, or writing agency-level audit rows). */
export interface AgencyContext {
  kind: "agency";
  tenantId: string | null;
  actorType: ActorType;
  actorId: string;
  roles: readonly string[];
}

export type RequestContext = TenantContext | OperatorContext | AgencyContext;

export function tenantContext(input: Omit<TenantContext, "kind">): TenantContext {
  return { kind: "tenant", ...input };
}

export function operatorContext(input: Omit<OperatorContext, "kind">): OperatorContext {
  return { kind: "operator", ...input };
}

export function agencyContext(input: Omit<AgencyContext, "kind">): AgencyContext {
  return { kind: "agency", ...input };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a UUID, got "${value}"`);
  }
}
