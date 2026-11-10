import Link from "next/link";
import { headers } from "next/headers";
import { initialsOf } from "@/lib/account-helpers";
import { getPrincipal } from "@/lib/request-context";
import { Badge } from "./ui";

/**
 * Account menu shown on every surface (Mission Control sidebar and mobile bar, client workspace, auth pages,
 * landing page): who is signed in, roles and MFA state, and the actions Security, Switch account and Sign out.
 * A native details/summary dropdown, so it works before hydration and without client state.
 */
export async function AccountMenu({ align = "right" }: { align?: "left" | "right" }) {
  const principal = await getPrincipal();
  const h = await headers();
  const current = h.get("x-sbos-pathname") ?? "/";
  if (!principal) {
    return <Link href={`/sign-in?next=${encodeURIComponent(current)}`} className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg">Sign in</Link>;
  }
  const avatar = principal.image ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={principal.image} alt="" className="h-8 w-8 rounded-full object-cover" />
  ) : (
    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo/30 text-xs font-semibold text-fg">{initialsOf(principal.name, principal.email)}</span>
  );
  return (
    <details className="group relative">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
        {avatar}
        <span className="hidden min-w-0 flex-col text-left sm:flex">
          <span className="truncate font-medium text-fg">{principal.name || principal.email}</span>
          <span className="truncate text-[11px] text-faint">{principal.email}</span>
        </span>
        <span aria-hidden className="text-faint">▾</span>
      </summary>
      <div className={`absolute z-30 mt-1 w-72 rounded-card border border-border bg-surface p-3 text-sm shadow-lg ${align === "right" ? "right-0" : "left-0"}`}>
        <div className="flex items-center gap-3">
          {avatar}
          <div className="min-w-0">
            <div className="truncate font-medium text-fg">{principal.name || principal.email}</div>
            <div className="truncate text-xs text-muted">{principal.email}</div>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {principal.data.memberships.map((m) => <Badge key={`${m.tenantId}-${m.roleKey}`} tone={m.kind === "agency" ? "indigo" : "cyan"}>{m.slug}: {m.roleKey}</Badge>)}
          <Badge tone={principal.twoFactorEnabled ? "success" : "warning"}>{principal.twoFactorEnabled ? "MFA on" : "MFA off"}</Badge>
        </div>
        <div className="mt-3 flex flex-col gap-1 border-t border-border pt-3">
          <Link href="/account/security" className="rounded-md px-2 py-1.5 text-muted hover:bg-surface-2 hover:text-fg">Account security (TOTP, password)</Link>
          <form method="post" action="/sign-out">
            <input type="hidden" name="next" value={current} />
            <button type="submit" className="w-full rounded-md px-2 py-1.5 text-left text-muted hover:bg-surface-2 hover:text-fg">Switch account (sign out, then sign in as someone else)</button>
          </form>
          <form method="post" action="/sign-out">
            <button type="submit" className="w-full rounded-md px-2 py-1.5 text-left font-medium text-danger hover:bg-surface-2">Sign out</button>
          </form>
        </div>
      </div>
    </details>
  );
}
