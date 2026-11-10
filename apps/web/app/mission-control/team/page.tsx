import { Notice } from "@/components/agent-ui";
import { Badge, Card, Empty, Status, buttonClass, buttonSecondaryClass, inputClass } from "@/components/ui";
import { firstParam } from "@/lib/format";
import { inviteAgencyMemberAction, revokeInvitationAction } from "@/lib/mission-control/team-actions";
import { AGENCY_INVITE_ROLES, canManageTeam, invitationState, roleKeyFor } from "@/lib/mission-control/team-helpers";
import { agencyOrganisation, listTeamInvitations, listTeamMembers } from "@/lib/mission-control/team-queries";
import { requireOperatorContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

const fmt = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ") + " UTC";

export default async function TeamPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const op = await requireOperatorContext();
  const sp = await searchParams;
  const manage = canManageTeam(op.roles);
  const agency = await agencyOrganisation(op);
  const members = agency?.orgId ? await listTeamMembers(agency.orgId) : [];
  const invitations = agency?.orgId ? await listTeamInvitations(agency.orgId) : [];
  const mailConfigured = Boolean(process.env.RESEND_API_KEY);
  const baseUrl = process.env.BETTER_AUTH_URL ?? "";

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Agency Team</h1>
        <p className="text-sm text-muted">
          Members of the agency organisation {agency ? <span className="font-medium">{agency.name}</span> : null} and their invitations. Organisation roles map to membership roles through the auth bridge: owner is superadmin, admin is agency operator, member is agency consultant. Superadmin and operator accounts need TOTP before operator pages open. <Status state="implemented" />
        </p>
      </header>
      <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />

      {!agency?.orgId ? <Empty>The agency organisation is not linked yet. Run the superadmin bootstrap first (docs/deployment.md 3.11).</Empty> : null}

      <Card title={`Members (${members.length})`}>
        {members.length === 0 ? (
          <Empty>No members yet.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-faint"><tr><th className="py-1">E-mail</th><th>Name</th><th>Role</th><th>MFA</th><th>Joined</th></tr></thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.memberId} className="border-t border-border">
                  <td className="py-2 font-medium">{m.email}</td>
                  <td>{m.name}</td>
                  <td><Badge tone="indigo">{roleKeyFor(m.orgRole) ?? m.orgRole}</Badge></td>
                  <td><Badge tone={m.twoFactorEnabled ? "success" : "warning"}>{m.twoFactorEnabled ? "enabled" : "not enabled"}</Badge></td>
                  <td className="text-faint">{fmt(m.joinedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {manage && agency?.orgId ? (
        <Card title="Invite a colleague" footer={mailConfigured ? "The invitation e-mail is sent through Resend and is valid for 72 hours." : "No mail provider is configured on this deployment: the e-mail is only logged on the server and the accept link is shown here after creation, so you hand it over yourself. Status: implemented, delivery not connected."}>
          <form action={inviteAgencyMemberAction} className="grid gap-4 md:grid-cols-3">
            <label className="text-xs text-faint md:col-span-2">E-mail<input name="email" type="email" required maxLength={200} className={inputClass} placeholder="colleague@example.com" /></label>
            <label className="text-xs text-faint">Role
              <select name="role" defaultValue="admin" className={inputClass}>
                {AGENCY_INVITE_ROLES.map((r) => <option key={r.orgRole} value={r.orgRole}>{r.label}</option>)}
              </select>
            </label>
            <div className="md:col-span-3 text-xs text-faint">
              {AGENCY_INVITE_ROLES.map((r) => <div key={r.orgRole}><span className="font-medium text-muted">{r.label}:</span> {r.description}</div>)}
            </div>
            <div className="md:col-span-3"><button type="submit" className={buttonClass}>Create invitation</button></div>
          </form>
        </Card>
      ) : (
        <Card title="Invite a colleague"><p className="text-sm text-muted">Only a superadmin can invite agency team members.</p></Card>
      )}

      <Card title={`Invitations (${invitations.length})`}>
        {invitations.length === 0 ? (
          <Empty>No invitations.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-faint"><tr><th className="py-1">E-mail</th><th>Role</th><th>State</th><th>Expires</th><th>Invited by</th><th></th></tr></thead>
            <tbody>
              {invitations.map((inv) => {
                const state = invitationState(inv);
                return (
                  <tr key={inv.id} className="border-t border-border align-top">
                    <td className="py-2 font-medium">{inv.email}</td>
                    <td><Badge tone="indigo">{roleKeyFor(inv.role ?? "") ?? inv.role ?? "?"}</Badge></td>
                    <td><Badge tone={state === "pending" ? "cyan" : state === "accepted" ? "success" : "neutral"}>{state}</Badge></td>
                    <td className="text-faint">{fmt(inv.expiresAt)}</td>
                    <td className="text-faint">{inv.inviterEmail ?? "?"}</td>
                    <td className="text-right">
                      {state === "pending" && manage ? (
                        <div className="flex flex-col items-end gap-1">
                          {!mailConfigured ? <code className="break-all text-xs text-muted">{baseUrl}/accept-invitation/{inv.id}</code> : null}
                          <form action={revokeInvitationAction}><input type="hidden" name="invitationId" value={inv.id} /><button type="submit" className={buttonSecondaryClass}>Revoke</button></form>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
