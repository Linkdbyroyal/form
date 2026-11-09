import Link from "next/link";
import { AuthLayout } from "@/components/auth-layout";

/** Rendered by forbidden() from lib/request-context.ts: signed in, but no membership or active content grant. */
export default function Forbidden() {
  return (
    <AuthLayout title="403: no access to this workspace" intro="You are signed in, but you hold no membership on this tenant and no active content grant.">
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
        <li>Client staff: ask the tenant administrator for an invitation.</li>
        <li>Agency staff: client content requires a break-glass grant (reason, fresh MFA, maximum 8 hours; ADR-017). Operational metadata is available in Mission Control.</li>
      </ul>
      <div className="mt-4 flex gap-3 text-sm">
        <Link href="/mission-control" className="underline">Mission Control</Link>
        <Link href="/" className="underline">Home</Link>
      </div>
    </AuthLayout>
  );
}
