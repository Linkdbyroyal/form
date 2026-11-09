import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { listClientWorkspaces } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function ClientWorkspaces() {
  const rows = await listClientWorkspaces();
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Client Workspaces</h1>
        <p className="text-sm text-muted">Tenant headers and counts, read through the operator role. Content requires a client content grant and is logged.</p>
      </header>
      <Card>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-faint">
            <tr><th className="py-2">Tenant</th><th>Kind</th><th>Status</th><th>Industry</th><th className="text-right">Members</th><th className="text-right">Departments</th><th className="text-right">Systems</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className="border-t border-border">
                <td className="py-2 font-medium">{t.name}<div className="text-xs text-faint">{t.slug}</div></td>
                <td><Badge tone={t.kind === "agency" ? "indigo" : t.kind === "demo" ? "warning" : "cyan"}>{t.kind}</Badge></td>
                <td className="text-muted">{t.status}</td>
                <td className="text-muted">{t.industry ?? "n/a"}</td>
                <td className="text-right">{t.members}</td>
                <td className="text-right">{t.departments}</td>
                <td className="text-right">{t.systems}</td>
                <td className="text-right">
                  {t.kind !== "agency" ? (
                    <span className="space-x-3">
                      <Link className="text-cyan underline" href={`/mission-control/clients/${t.slug}`}>operator view</Link>
                      <Link className="text-muted underline" href={`/c/${t.slug}`}>open workspace</Link>
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
