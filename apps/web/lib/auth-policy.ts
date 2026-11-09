/**
 * Pure authorisation rules (ADR-015, ADR-017). No I/O, so they are unit-tested directly.
 * Role keys are the post-0002 names.
 */
export type TenantKind = "client" | "agency" | "demo";

/** Roles that may open Mission Control. */
export const OPERATOR_ROLES = ["superadmin", "agency_operator"] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

/** Roles whose holders must have a verified second factor before any session counts (ADR-015). */
export const MFA_REQUIRED_ROLES: ReadonlySet<string> = new Set<string>(OPERATOR_ROLES);

/** Better Auth organisation role -> membership role key, per tenant kind. */
const CLIENT_ROLE_BY_ORG_ROLE: Record<string, string> = {
  owner: "client_admin",
  admin: "department_manager",
  member: "client_employee"
};
const AGENCY_ROLE_BY_ORG_ROLE: Record<string, string> = {
  owner: "superadmin",
  admin: "agency_operator",
  member: "agency_consultant"
};
const ORG_ROLE_RANK: Record<string, number> = { owner: 3, admin: 2, member: 1 };

/** Membership role keys the bridge owns. Other role keys on a membership are never touched by the sync. */
export const BRIDGE_MANAGED_ROLES: readonly string[] = [
  ...Object.values(CLIENT_ROLE_BY_ORG_ROLE),
  ...Object.values(AGENCY_ROLE_BY_ORG_ROLE)
];

/**
 * Maps a Better Auth member role (possibly a comma-separated list such as "owner,admin") onto one
 * membership role key. The highest organisation role wins. Unknown roles map to null.
 */
export function mapOrgRoleToMembership(orgRole: string, tenantKind: TenantKind): string | null {
  const table = tenantKind === "agency" ? AGENCY_ROLE_BY_ORG_ROLE : CLIENT_ROLE_BY_ORG_ROLE;
  const roles = orgRole
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter((r) => r in table);
  if (roles.length === 0) return null;
  roles.sort((a, b) => (ORG_ROLE_RANK[b] ?? 0) - (ORG_ROLE_RANK[a] ?? 0));
  return table[roles[0]!] ?? null;
}

export type MfaDecision = "allow" | "require_mfa";

/**
 * A user holding any MFA-mandatory role without a verified second factor must be treated as
 * unauthenticated for operator surfaces. Everyone else passes (MFA stays optional for them).
 */
export function mfaGate(input: { roles: readonly string[]; twoFactorEnabled: boolean }): MfaDecision {
  if (input.twoFactorEnabled) return "allow";
  return input.roles.some((r) => MFA_REQUIRED_ROLES.has(r)) ? "require_mfa" : "allow";
}

export type OperatorAccess =
  | { kind: "allow"; roles: string[] }
  | { kind: "redirect"; to: "/sign-in" | "/account/security"; reason: "unauthenticated" | "not_operator" | "mfa_required" };

/**
 * Decides Mission Control access from the user's memberships on the agency tenant.
 * A missing session, a user without an operator role on the agency tenant, and an operator without
 * MFA are all treated as "not authenticated for this surface" (ADR-015/017).
 */
export function decideOperatorAccess(input: { authenticated: boolean; agencyRoles: readonly string[]; twoFactorEnabled: boolean }): OperatorAccess {
  if (!input.authenticated) return { kind: "redirect", to: "/sign-in", reason: "unauthenticated" };
  const roles = input.agencyRoles.filter((r): r is OperatorRole => (OPERATOR_ROLES as readonly string[]).includes(r));
  if (roles.length === 0) return { kind: "redirect", to: "/sign-in", reason: "not_operator" };
  if (mfaGate({ roles, twoFactorEnabled: input.twoFactorEnabled }) === "require_mfa") {
    return { kind: "redirect", to: "/account/security", reason: "mfa_required" };
  }
  return { kind: "allow", roles: [...roles] };
}

export type TenantAccess =
  | { kind: "allow"; roles: string[]; viaGrant: boolean }
  | { kind: "redirect"; to: "/sign-in" | "/account/security" }
  | { kind: "forbidden"; reason: "no_membership" | "superadmin_without_grant" };

/**
 * Decides client workspace access (ADR-017 break-glass):
 * - a membership on the tenant gives tenant context with those roles;
 * - a superadmin with an unexpired, unrevoked `client_content_grants` row gets tenant context flagged as viaGrant;
 * - a superadmin WITHOUT a grant is forbidden, not silently elevated.
 */
export function decideTenantAccess(input: {
  authenticated: boolean;
  tenantRoles: readonly string[];
  agencyRoles: readonly string[];
  twoFactorEnabled: boolean;
  hasActiveGrant: boolean;
  now?: Date;
}): TenantAccess {
  if (!input.authenticated) return { kind: "redirect", to: "/sign-in" };
  if (input.tenantRoles.length > 0) return { kind: "allow", roles: [...input.tenantRoles], viaGrant: false };
  const isSuperadmin = input.agencyRoles.includes("superadmin");
  if (!isSuperadmin) return { kind: "forbidden", reason: "no_membership" };
  if (mfaGate({ roles: input.agencyRoles, twoFactorEnabled: input.twoFactorEnabled }) === "require_mfa") {
    return { kind: "redirect", to: "/account/security" };
  }
  if (!input.hasActiveGrant) return { kind: "forbidden", reason: "superadmin_without_grant" };
  return { kind: "allow", roles: ["superadmin"], viaGrant: true };
}

/** True when a grant row is usable at `now`. */
export function grantIsActive(grant: { expiresAt: Date; revokedAt: Date | null }, now: Date = new Date()): boolean {
  return grant.revokedAt === null && grant.expiresAt.getTime() > now.getTime();
}
