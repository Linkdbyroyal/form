import { notFound } from "next/navigation";
import { clientNav, Shell } from "@/components/shell";
import { Badge, Card, Status } from "@/components/ui";
import { requireTenantContext } from "@/lib/request-context";
import { getTenantWorkspace } from "@/lib/workspace-queries";

export const dynamic = "force-dynamic";

export default async function ClientWorkspace({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // Membership on this tenant, or superadmin with an active content grant; otherwise 403 (ADR-017).
  const access = await requireTenantContext(slug);
  if (!access) notFound();
  const d = await getTenantWorkspace(access.ctx, access.viaGrant);
  if (!d) notFound();
  return (
    <Shell title={d.tenant.name} subtitle="Client workspace" nav={clientNav(slug)}>
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">Workspace</h1>
          <p className="text-sm text-muted">This page runs in tenant context: Row-Level Security limits every query to this tenant. Viewing it wrote an audit event.</p>
          <div className="mt-2 flex gap-2"><Badge tone="warning">{d.tenant.kind === "demo" ? "synthetic tenant" : d.tenant.kind}</Badge><Badge>{d.tenant.status}</Badge><Badge>locale {d.tenant.locale}</Badge>{access.viaGrant ? <Badge tone="danger">break-glass grant: access is logged</Badge> : <Badge tone="cyan">roles: {access.ctx.roles.join(", ")}</Badge>}</div>
        </header>
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Departments"><ul className="text-sm">{d.departments.map((x) => <li key={x.id} className="flex justify-between py-1"><span>{x.name}</span><span className="text-faint">{x.headRole ?? ""}</span></li>)}</ul></Card>
          <Card title="Recent audit events" footer="append-only; actor, action and entity per row">
            <ul className="text-xs">{d.recentAudit.map((a) => <li key={a.id} className="flex justify-between py-1"><span>{a.action} · {a.entityType}</span><span className="text-faint">{a.actorType}:{a.actorId} · {a.occurredAt.toISOString().slice(0, 19)}Z</span></li>)}</ul>
          </Card>
        </div>
        <Card title="Systems register" footer="Content column `notes` is visible here because this is tenant context; operators do not see it.">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-faint"><tr><th className="py-2">System</th><th>Function</th><th>Source of truth for</th><th>Claim</th><th>Notes</th></tr></thead>
            <tbody>
              {d.systems.map((s) => (
                <tr key={s.id} className="border-t border-border align-top">
                  <td className="py-2 font-medium">{s.name}<div className="text-xs text-faint">{s.vendor}</div></td>
                  <td className="text-muted">{s.function}</td>
                  <td className="text-muted">{s.sourceOfTruthFor.join(", ")}</td>
                  <td><Badge tone={s.claimStatus === "connected" ? "success" : "warning"}>{s.claimStatus}</Badge></td>
                  <td className="text-xs text-muted">{s.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="Implementation status">
          <ul className="space-y-1 text-sm">
            <li><Status state="implemented" /> Tenant-scoped data access, org map, systems register, audit</li>
            <li><Status state="implemented" /> Access from the signed-in user's membership or an active content grant (M1-01)</li>
            <li><Status state="planned" /> CEO Dashboard, Business X-Ray, Interview Inbox, Action Center, Knowledge Vault (M2–M3)</li>
            <li><Status state="not_connected" /> All listed systems are claims from intake; none is connected</li>
          </ul>
        </Card>
      </div>
    </Shell>
  );
}
