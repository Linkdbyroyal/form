import { describe, expect, it } from "vitest";
import { AGENCY_INVITE_ROLES, canManageTeam, invitationState, inviteNotice, parseInvite, roleKeyFor } from "../lib/mission-control/team-helpers";

/** Agency Team page rules (pure). The database-backed invitation flow reuses the accept-invitation page covered by auth.test.ts. */
describe("agency team invitations", () => {
  it("maps the three organisation roles to the ADR-017 agency role keys", () => {
    expect(AGENCY_INVITE_ROLES.map((r) => [r.orgRole, r.roleKey])).toEqual([["owner", "superadmin"], ["admin", "agency_operator"], ["member", "agency_consultant"]]);
    expect(roleKeyFor("viewer")).toBeNull();
  });
  it("validates and normalises the invite form", () => {
    expect(parseInvite({ email: " Colleague@Example.com ", role: "admin" })).toEqual({ ok: true, email: "colleague@example.com", role: "admin" });
    expect(parseInvite({ email: "nope", role: "admin" })).toMatchObject({ ok: false });
    expect(parseInvite({ email: "a@b.test", role: "superadmin" })).toMatchObject({ ok: false });
    expect(parseInvite({ email: null, role: null })).toMatchObject({ ok: false });
  });
  it("lets only superadmins manage the team", () => {
    expect(canManageTeam(["superadmin"])).toBe(true);
    expect(canManageTeam(["agency_operator"])).toBe(false);
    expect(canManageTeam([])).toBe(false);
  });
  it("derives the invitation state from status and expiry", () => {
    const now = new Date("2026-11-10T12:00:00Z");
    expect(invitationState({ status: "pending", expiresAt: new Date("2026-11-11T12:00:00Z") }, now)).toBe("pending");
    expect(invitationState({ status: "pending", expiresAt: new Date("2026-11-10T11:00:00Z") }, now)).toBe("expired");
    expect(invitationState({ status: "accepted", expiresAt: new Date("2026-11-10T11:00:00Z") }, now)).toBe("accepted");
    expect(invitationState({ status: "canceled", expiresAt: now }, now)).toBe("canceled");
  });
  it("shows the accept link only when no mail provider delivered the invitation", () => {
    const sent = inviteNotice({ email: "a@b.test", roleKey: "agency_operator", delivery: "resend", acceptUrl: "https://x/accept-invitation/1" });
    const logged = inviteNotice({ email: "a@b.test", roleKey: "agency_operator", delivery: "console", acceptUrl: "https://x/accept-invitation/1" });
    expect(sent).not.toContain("accept-invitation");
    expect(logged).toContain("https://x/accept-invitation/1");
    expect(logged).toContain("only logged");
  });
});
