import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/confirm-button";
import { Notice, Table, Td, Tr, selectClass, smallDangerClass } from "@/components/agent-ui";
import { Badge, Card, Empty, Status, buttonClass, inputClass } from "@/components/ui";
import { BREAK_GLASS_DEFAULT_MINUTES, BREAK_GLASS_DURATION_OPTIONS } from "@/lib/break-glass-policy";
import { listTenantGrants, ownGrantFor } from "@/lib/break-glass-service";
import { requestBreakGlassAction, revokeBreakGlassAction } from "@/lib/break-glass";
import { firstParam, fmtDate } from "@/lib/format";
import { getTenantOperatorView } from "@/lib/queries";
import { getPrincipal, requireOperatorContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function ClientOperatorView({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Search }) {
  const { slug } = await params;
  const sp = await searchParams;
  const op = await requireOperatorContext();
  const principal = await getPrincipal();
  const view = await getTenantOperatorView(slug);
  if (!view || !principal) notFound();
  const returnTo = `/mission-control/clients/${view.tenant.slug}`;
  const isSuperadmin = op.roles.includes("superadmin");
  const isClientTenant = view.tenant.kind !== "agency";
  const grants = isClientTenant ? await listTenantGrants(op, view.tenant.id) : [];
  const own = ownGrantFor(grants, principal.data.publicUserId);
  const ownActive = own?.active ? own : null;

  return (
    <div className="space-y-6">
      <header>
        <div className="text-xs text-faint"><Link href="/mission-control/clients" className="underline">Client Workspaces</Link> / {view.tenant.slug}</div>
        <h1 className="text-2xl font-semibold">{view.tenant.name}</h1>
        <p className="text-sm text-muted">Operator view: metadata only. The database role used here has no SELECT grant on content columns such as system notes. <Status state="implemented" /></p>
      </header>
      <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />
      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Tenant"><dl className="text-sm"><dt className="text-faint">Kind</dt><dd>{view.tenant.kind}</dd><dt className="mt-2 text-faint">Status</dt><dd>{view.tenant.status}</dd><dt className="mt-2 text-faint">Industry</dt><dd>{view.tenant.industry ?? "n/a"}</dd></dl></Card>
        <Card title="Memberships by role"><ul className="text-sm">{view.members.map((m) => <li key={m.roleKey} className="flex justify-between"><span>{m.roleKey}</span><span>{m.n}</span></li>)}</ul></Card>
        <Card title="Departments"><ul className="text-sm">{view.departments.map((d) => <li key={d.id}>{d.name}</li>)}</ul></Card>
      </div>

      {isClientTenant ? (
        <Card
          title="Client content access (break-glass)"
          footer="ADR-017: a grant opens the client workspace for a limited time. It needs a reason and a fresh authenticator code, writes an audit event and a Pumble notice, and every content read under it is logged in knowledge_access_logs. Grants expire automatically; the holder or a superadmin can revoke early."
        >
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted">Your access to this client:</span>
              {ownActive ? (
                <Badge tone="danger">active until {fmtDate(ownActive.expiresAt)}</Badge>
              ) : own?.revokedAt ? (
                <Badge tone="warning">revoked {fmtDate(own.revokedAt)}</Badge>
              ) : own ? (
                <Badge tone="neutral">expired {fmtDate(own.expiresAt)}</Badge>
              ) : (
                <Badge tone="neutral">none</Badge>
              )}
              <Status state="implemented" />
            </div>
            {ownActive ? (
              <div className="flex flex-wrap items-center gap-3">
                <Link href={`/c/${view.tenant.slug}`} className={buttonClass}>Open client workspace</Link>
                <form action={revokeBreakGlassAction}>
                  <input type="hidden" name="grantId" value={ownActive.id} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <ConfirmButton message="Revoke your content access to this client now?" className={smallDangerClass}>Revoke</ConfirmButton>
                </form>
                <span className="text-xs text-muted">Reason on file: {ownActive.reason}</span>
              </div>
            ) : (
              <form action={requestBreakGlassAction} className="grid gap-3 md:grid-cols-2">
                <input type="hidden" name="tenantSlug" value={view.tenant.slug} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <label className="block text-xs text-muted md:col-span-2">Reason (10 to 1000 characters; recorded in the audit trail and the Pumble notice)
                  <textarea name="reason" required minLength={10} maxLength={1000} rows={3} className={`${inputClass} mt-1`} placeholder="Ticket or incident reference and what you need to look at" />
                </label>
                <label className="block text-xs text-muted">Duration
                  <select name="durationMinutes" defaultValue={String(BREAK_GLASS_DEFAULT_MINUTES)} className={`${selectClass} mt-1 w-full`}>
                    {BREAK_GLASS_DURATION_OPTIONS.map((o) => <option key={o.minutes} value={o.minutes}>{o.label}</option>)}
                  </select>
                </label>
                <label className="block text-xs text-muted">Authenticator code (fresh TOTP, 6 digits)
                  <input name="totpCode" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} className={`${inputClass} mt-1`} placeholder="123456" />
                </label>
                <div className="md:col-span-2">
                  <button type="submit" className={buttonClass}>Request access</button>
                  <span className="ml-3 text-xs text-muted">On success you are taken to /c/{view.tenant.slug}, which shows the break-glass badge.</span>
                </div>
              </form>
            )}
          </div>
        </Card>
      ) : null}

      {isClientTenant ? (
        <Card title="Recent content grants" footer={isSuperadmin ? "Superadmins can revoke any active grant." : "You can revoke your own active grant; superadmins can revoke any."}>
          <Table head={["Holder", "Granted", "Expires", "Revoked", "State", "Reason", ""]} empty={grants.length === 0 ? <Empty>No content grants for this client yet.</Empty> : null}>
            {grants.map((g) => (
              <Tr key={g.id}>
                <Td>{g.holderName ?? g.userId.slice(0, 8)}{g.userId === principal.data.publicUserId ? <span className="ml-1 text-xs text-faint">(you)</span> : null}</Td>
                <Td className="text-muted">{fmtDate(g.createdAt)}</Td>
                <Td className="text-muted">{fmtDate(g.expiresAt)}</Td>
                <Td className="text-muted">{g.revokedAt ? fmtDate(g.revokedAt) : "n/a"}</Td>
                <Td><Badge tone={g.active ? "danger" : g.revokedAt ? "warning" : "neutral"}>{g.active ? "active" : g.revokedAt ? "revoked" : "expired"}</Badge></Td>
                <Td className="max-w-md text-xs text-muted">{g.reason}</Td>
                <Td>
                  {g.active && (isSuperadmin || g.userId === principal.data.publicUserId) ? (
                    <form action={revokeBreakGlassAction}>
                      <input type="hidden" name="grantId" value={g.id} />
                      <input type="hidden" name="returnTo" value={returnTo} />
                      <ConfirmButton message={`Revoke the grant held by ${g.holderName ?? "this user"}?`} className={smallDangerClass}>Revoke</ConfirmButton>
                    </form>
                  ) : null}
                </Td>
              </Tr>
            ))}
          </Table>
        </Card>
      ) : null}

      <Card title="Systems register (claimed by client, not verified)" footer="claim_status: stated = named in intake; verified_exists = IT agent confirmed the application exists; connected = a working, consented connection. Notes column is hidden from operators.">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-faint"><tr><th className="py-2">System</th><th>Vendor</th><th>Function</th><th>Capabilities</th><th>Claim</th></tr></thead>
          <tbody>
            {view.systems.map((s) => (
              <tr key={s.id} className="border-t border-border">
                <td className="py-2 font-medium">{s.name}</td>
                <td className="text-muted">{s.vendor ?? "n/a"}</td>
                <td className="text-muted">{s.function}</td>
                <td>{s.apiCapabilities.map((c) => <Badge key={c}>{c}</Badge>)}</td>
                <td><Badge tone={s.claimStatus === "connected" ? "success" : s.claimStatus === "verified_exists" ? "cyan" : "warning"}>{s.claimStatus}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
