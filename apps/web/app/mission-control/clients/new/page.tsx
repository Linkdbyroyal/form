import Link from "next/link";
import { Notice } from "@/components/agent-ui";
import { Card, Status, buttonClass, inputClass } from "@/components/ui";
import { createClientAction } from "@/lib/mission-control/onboarding";
import { firstParam } from "@/lib/format";
import { requireOperatorContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

const DEPARTMENTS_EXAMPLE = ["management|Management|client_admin", "sales|Sales and Quotes|department_manager", "operations|Operations and Warehouse|department_manager", "finance|Finance|department_manager"].join("\n");
const SYSTEMS_EXAMPLE = ["Rentman|Rentman|Projects, equipment, crew planning, quotes, invoices|operations|api,mcp", "QuickBooks Online|Intuit|Accounting, invoices, payments|finance|api,mcp", "Trengo|Trengo|Customer conversations incl. WhatsApp|sales|api,webhook", "Dropbox|Dropbox|Documents and contracts|management|api,mcp"].join("\n");

export default async function NewClientPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOperatorContext();
  const sp = await searchParams;
  return (
    <div className="space-y-6">
      <header>
        <div className="text-xs text-faint"><Link href="/mission-control/clients" className="underline">Client Workspaces</Link> / new</div>
        <h1 className="text-2xl font-semibold">New client</h1>
        <p className="text-sm text-muted">
          Creates the tenant (kind client, status onboarding), departments, the systems register (claim status stated), budgets, one agent instance per definition pinned to the stable skill release, a Discovery schedule (weekdays 07:00 UTC, enabled) and the Better Auth organisation, then invites the CEO. Every step writes an audit row. <Status state="implemented" />
        </p>
      </header>
      <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />

      <form action={createClientAction} className="space-y-6">
        <Card title="Company">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="text-xs text-faint">Company name<input name="name" required maxLength={160} className={inputClass} placeholder="Northline Events" /></label>
            <label className="text-xs text-faint">Slug (URL, lowercase, dashes)<input name="slug" required maxLength={64} pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]" className={inputClass} placeholder="northline-events" /></label>
            <label className="text-xs text-faint">Industry<input name="industry" maxLength={120} className={inputClass} placeholder="Event rental" /></label>
            <label className="text-xs text-faint">Locale
              <select name="locale" defaultValue="en" className={`${inputClass}`}>
                <option value="en">en (English)</option>
                <option value="nl">nl (Dutch)</option>
                <option value="pap">pap (Papiamentu)</option>
              </select>
            </label>
          </div>
        </Card>

        <Card title="Organisation map" footer="One department per line: key|name|head role. Head role is optional and one of client_admin, department_manager, client_employee. Keys are lowercase letters, digits and underscores and are referenced by the systems below and by agent questions.">
          <label className="text-xs text-faint">Departments<textarea name="departments" required rows={6} className={`${inputClass} font-mono text-xs`} defaultValue={DEPARTMENTS_EXAMPLE} /></label>
        </Card>

        <Card title="Systems register" footer="One system per line: name|vendor|function|department key|capabilities (comma list of api, mcp, webhook, export, none). Every system is registered as a claim (stated); nothing is connected and no credential is stored.">
          <label className="text-xs text-faint">Systems<textarea name="systems" rows={6} className={`${inputClass} font-mono text-xs`} defaultValue={SYSTEMS_EXAMPLE} /></label>
        </Card>

        <Card title="CEO invitation" footer="The CEO receives an invitation link (72 hours) to create an account for this address and join the organisation as owner, which the bridge mirrors as client_admin. Without RESEND_API_KEY the mail is printed to the server console with the prefix [mail:dev].">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="text-xs text-faint">CEO name<input name="ceoName" required maxLength={120} className={inputClass} placeholder="Nora Northline" /></label>
            <label className="text-xs text-faint">CEO e-mail<input name="ceoEmail" type="email" required maxLength={200} className={inputClass} placeholder="ceo@example.com" /></label>
          </div>
        </Card>

        <div className="flex items-center gap-3">
          <button type="submit" className={buttonClass}>Create client and invite CEO</button>
          <Link href="/mission-control/clients" className="text-sm text-muted underline">Cancel</Link>
        </div>
      </form>

      <Card title="What happens next">
        <ul className="space-y-1 text-sm">
          <li><Status state="implemented" /> The Discovery agent runs on weekdays at 07:00 UTC (and on demand from Agent Detail) and drafts up to 5 intake questions for the CEO's approval</li>
          <li><Status state="implemented" /> Agent instances for Finance, Operations, Process Redesign, CEO Intelligence, Executive Briefing and Performance are idle; their schedules are created disabled where the definition has one</li>
          <li><Status state="planned" /> Operator-side editing of departments and systems after creation; resend or revoke an invitation</li>
        </ul>
      </Card>
    </div>
  );
}
