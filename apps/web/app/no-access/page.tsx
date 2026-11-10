import Link from "next/link";
import { AccountMenu } from "@/components/account-menu";
import { AuthLayout } from "@/components/auth-layout";
import { Badge, buttonClass, buttonSecondaryClass } from "@/components/ui";
import { pendingInvitationsFor } from "@/lib/invitations";
import { requireSignedIn } from "@/lib/request-context";

export const dynamic = "force-dynamic";

/**
 * Shown to a signed-in user who opened an area their roles do not cover (Mission Control, the agency vault, a
 * client workspace). Lists what the account can open, any pending invitation for the address, and the way to
 * switch accounts. Replaces the earlier redirect to /sign-in, which looped for accounts without memberships.
 */
export default async function NoAccessPage({ searchParams }: { searchParams: Promise<{ area?: string }> }) {
  const { area } = await searchParams;
  const p = await requireSignedIn();
  const invitations = await pendingInvitationsFor(p.email);
  const places = p.data.memberships.map((m) => ({ href: m.kind === "agency" ? "/mission-control" : `/c/${m.slug}`, label: m.kind === "agency" ? `Mission Control (${m.roleKey})` : `${m.slug} (${m.roleKey})` }));
  return (
    <AuthLayout title="No access to this area" intro={`You are signed in as ${p.email}. ${area ? `The page ${area} needs a role this account does not have.` : "This account has no role for the page you opened."}`} account={<AccountMenu align="right" />} footer={<Link href="/" className="underline">Home</Link>}>
      <div className="space-y-4 text-sm">
        <div>
          <div className="text-xs text-faint">Roles of this account</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {p.data.memberships.length === 0 ? <span className="text-muted">none yet</span> : p.data.memberships.map((m) => <Badge key={`${m.tenantId}-${m.roleKey}`} tone={m.kind === "agency" ? "indigo" : "cyan"}>{m.slug}: {m.roleKey}</Badge>)}
          </div>
        </div>
        {invitations.length > 0 ? (
          <div className="rounded-md border border-cyan/40 bg-cyan/10 p-3">
            <div className="font-medium">Pending invitation{invitations.length > 1 ? "s" : ""} for {p.email}</div>
            <ul className="mt-2 space-y-2">
              {invitations.map((inv) => (
                <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{inv.organizationName} <Badge tone="cyan">{inv.role ?? "member"}</Badge></span>
                  <Link href={`/accept-invitation/${inv.id}`} className={buttonClass}>Accept invitation</Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {places.length > 0 ? (
          <div>
            <div className="text-xs text-faint">You can open</div>
            <ul className="mt-1 space-y-1">{places.map((pl) => <li key={pl.href}><Link href={pl.href} className="underline">{pl.label}</Link></li>)}</ul>
          </div>
        ) : null}
        <form method="post" action="/sign-out" className="pt-2">
          <input type="hidden" name="next" value={area && area.startsWith("/") ? area : "/"} />
          <button type="submit" className={buttonSecondaryClass}>Switch account</button>
        </form>
      </div>
    </AuthLayout>
  );
}
