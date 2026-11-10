/**
 * Agency Team page (Mission Control): pure rules, unit tested without a database.
 * Organisation roles of the agency organisation map to membership role keys through the auth bridge (ADR-017).
 */
export const AGENCY_INVITE_ROLES = [
  { orgRole: "owner", roleKey: "superadmin", label: "Superadmin (owner)", description: "Full Mission Control, approves agency-level decisions, manages the team. TOTP mandatory." },
  { orgRole: "admin", roleKey: "agency_operator", label: "Agency operator (admin)", description: "Operates Mission Control; client content only through break-glass. TOTP mandatory." },
  { orgRole: "member", roleKey: "agency_consultant", label: "Agency consultant (member)", description: "Agency Intelligence Vault and Tech Watch; no operator pages." }
] as const;

export type AgencyOrgRole = (typeof AGENCY_INVITE_ROLES)[number]["orgRole"];

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function roleKeyFor(orgRole: string): string | null {
  return AGENCY_INVITE_ROLES.find((r) => r.orgRole === orgRole)?.roleKey ?? null;
}

export function parseInvite(input: { email: unknown; role: unknown }): { ok: true; email: string; role: AgencyOrgRole } | { ok: false; error: string } {
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 200) return { ok: false, error: "a valid e-mail address is required" };
  const role = typeof input.role === "string" ? input.role : "";
  if (!AGENCY_INVITE_ROLES.some((r) => r.orgRole === role)) return { ok: false, error: `role must be one of ${AGENCY_INVITE_ROLES.map((r) => r.orgRole).join(", ")}` };
  return { ok: true, email, role: role as AgencyOrgRole };
}

/** Only superadmins manage the agency team; operators can look but not invite. */
export function canManageTeam(roles: readonly string[]): boolean {
  return roles.includes("superadmin");
}

export function invitationState(inv: { status: string; expiresAt: Date }, now: Date = new Date()): "pending" | "expired" | "accepted" | "canceled" | "rejected" {
  if (inv.status === "pending") return inv.expiresAt.getTime() <= now.getTime() ? "expired" : "pending";
  if (inv.status === "accepted" || inv.status === "canceled" || inv.status === "rejected") return inv.status;
  return "pending";
}

/**
 * Notice after an invitation. While no mail provider is configured the mail is only printed to the server
 * console, so the accept link is shown to the superadmin who created it, to forward by a channel of their choice.
 */
export function inviteNotice(input: { email: string; roleKey: string; delivery: "console" | "resend"; acceptUrl: string }): string {
  const base = `Invitation for ${input.email} as ${input.roleKey} created (valid 72 hours).`;
  return input.delivery === "resend" ? `${base} The invitation e-mail was sent.` : `${base} No mail provider is configured, so the e-mail was only logged. Hand over this link yourself: ${input.acceptUrl}`;
}
