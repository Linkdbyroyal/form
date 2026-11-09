import Link from "next/link";
import { AuthLayout } from "@/components/auth-layout";
import { Badge } from "@/components/ui";
import { MFA_REQUIRED_ROLES } from "@/lib/auth-policy";
import { principalNeedsMfa, requireSignedIn } from "@/lib/request-context";
import { TotpEnrollment } from "./totp-enrollment";

export const dynamic = "force-dynamic";

export default async function SecurityPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const { reason } = await searchParams;
  const p = await requireSignedIn();
  const mandatory = p.agencyRoles.some((r) => MFA_REQUIRED_ROLES.has(r));
  const blocked = principalNeedsMfa(p);
  return (
    <AuthLayout
      title="Account security"
      intro="Time-based one-time passwords (TOTP) with an authenticator app such as 1Password, Aegis or Google Authenticator."
      footer={<Link href={p.agencyRoles.length ? "/mission-control" : "/"} className="underline">Back</Link>}
    >
      <div className="mb-4 space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted">Signed in as</span><span className="font-medium">{p.email}</span>
          <Badge tone={p.twoFactorEnabled ? "success" : "warning"}>{p.twoFactorEnabled ? "MFA enabled" : "MFA not enabled"}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted">Roles</span>
          {p.data.memberships.length === 0 ? <span className="text-faint">none</span> : p.data.memberships.map((m) => <Badge key={`${m.tenantId}-${m.roleKey}`} tone={m.kind === "agency" ? "indigo" : "cyan"}>{m.slug}: {m.roleKey}</Badge>)}
        </div>
        {blocked ? (
          <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-warning">
            {reason === "mfa_required" ? "Mission Control refused this session: " : ""}
            Your role ({p.agencyRoles.filter((r) => MFA_REQUIRED_ROLES.has(r)).join(", ")}) requires a verified second factor (ADR-015). Until TOTP is enabled, operator pages treat you as not signed in.
          </p>
        ) : mandatory ? (
          <p className="text-success">Second factor verified. Operator pages are available.</p>
        ) : (
          <p className="text-muted">MFA is optional for your roles but recommended.</p>
        )}
      </div>
      <TotpEnrollment enabled={p.twoFactorEnabled} />
    </AuthLayout>
  );
}
