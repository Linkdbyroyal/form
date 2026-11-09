import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, Status } from "@/components/ui";
import { getTenantOperatorView } from "@/lib/queries";
import { requireOperatorContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

export default async function ClientOperatorView({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  await requireOperatorContext();
  const view = await getTenantOperatorView(slug);
  if (!view) notFound();
  return (
    <div className="space-y-6">
      <header>
        <div className="text-xs text-faint"><Link href="/mission-control/clients" className="underline">Client Workspaces</Link> / {view.tenant.slug}</div>
        <h1 className="text-2xl font-semibold">{view.tenant.name}</h1>
        <p className="text-sm text-muted">Operator view: metadata only. The database role used here has no SELECT grant on content columns such as system notes. <Status state="implemented" /></p>
      </header>
      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Tenant"><dl className="text-sm"><dt className="text-faint">Kind</dt><dd>{view.tenant.kind}</dd><dt className="mt-2 text-faint">Status</dt><dd>{view.tenant.status}</dd><dt className="mt-2 text-faint">Industry</dt><dd>{view.tenant.industry ?? "n/a"}</dd></dl></Card>
        <Card title="Memberships by role"><ul className="text-sm">{view.members.map((m) => <li key={m.roleKey} className="flex justify-between"><span>{m.roleKey}</span><span>{m.n}</span></li>)}</ul></Card>
        <Card title="Departments"><ul className="text-sm">{view.departments.map((d) => <li key={d.id}>{d.name}</li>)}</ul></Card>
      </div>
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
