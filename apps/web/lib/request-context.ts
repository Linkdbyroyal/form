import { operatorContext, tenantContext, type OperatorContext, type TenantContext } from "@sbos/db";

/**
 * M0 placeholder: there is NO authentication yet. Every request acts as the seeded development
 * operator. Milestone 1 (ticket M1-01) replaces this with a real session. The UI shows a banner
 * while this file is in use.
 */
export const AUTH_STATUS = "dev-mode-no-auth" as const;

const DEV_OPERATOR_ID = process.env.SBOS_DEV_ACTOR_ID ?? "dev-operator";

export function getOperatorContext(): OperatorContext {
  return operatorContext({ actorType: "user", actorId: DEV_OPERATOR_ID, roles: ["agency_operator"] });
}

/** Tenant context for a client workspace page. In M0 the dev actor is treated as client_ceo of the tenant. */
export function getTenantContext(tenantId: string): TenantContext {
  return tenantContext({ tenantId, actorType: "user", actorId: DEV_OPERATOR_ID, roles: ["client_ceo"] });
}
