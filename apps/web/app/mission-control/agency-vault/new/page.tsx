import { AGENCY_VAULT_FOLDERS } from "@sbos/core";
import { Card, Status, inputClass } from "@/components/ui";
import { Notice, PageHeader, selectClass, smallPrimaryClass } from "@/components/agent-ui";
import { AGENCY_VAULT_BASE, AgencyVaultNav, AgencyVaultStatusCard } from "@/components/agency-vault-ui";
import { firstParam } from "@/lib/format";
import { createRecordAction } from "@/lib/mission-control/agency-vault-actions";
import { CLASSIFICATIONS, CREATABLE_ORIGINS, RECORD_KINDS, agencyFolderLabel } from "@/lib/mission-control/agency-vault-helpers";
import { requireAgencyContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

export default async function NewRecordPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAgencyContext();
  const sp = await searchParams;
  const preset = firstParam(sp.folder);
  const defaultFolder = preset && (AGENCY_VAULT_FOLDERS as readonly string[]).includes(preset) ? preset : "06_process_patterns_and_sops";
  return (
    <div className="space-y-6">
      <PageHeader title="New knowledge record" crumbs={[{ href: AGENCY_VAULT_BASE, label: "Agency Intelligence Vault" }, { label: "New record" }]}>
        Creates a draft with version 1 in one of the 18 agency folders, owned by you (<span className="font-mono text-xs">{ctx.actorId.slice(0, 8)}</span>). Origin is limited to Second Brain&apos;s own work or public-licensed material: knowledge abstracted from a client is created only through an approved promotion request. <Status state="implemented" />
      </PageHeader>
      <AgencyVaultNav active="new" />
      <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />

      <Card title="Record" footer="Path becomes <folder>/<file name>.md and must be unique. The record starts as draft; submit it for review from its detail page. Calls createKnowledgeRecord in agency scope and writes an audit row.">
        <form action={createRecordAction} className="space-y-3">
          <input type="hidden" name="returnTo" value={`${AGENCY_VAULT_BASE}/new`} />
          <div className="grid gap-3 md:grid-cols-[1fr_1fr]">
            <label className="block text-xs text-muted">Folder
              <select name="folder" defaultValue={defaultFolder} className={`${selectClass} mt-1 w-full`}>
                {AGENCY_VAULT_FOLDERS.map((f) => <option key={f} value={f}>{f.slice(0, 2)} {agencyFolderLabel(f)}</option>)}
              </select>
            </label>
            <label className="block text-xs text-muted">File name<input name="fileName" required maxLength={200} className={`${inputClass} mt-1`} placeholder="closure-check-v2.md" /></label>
          </div>
          <label className="block text-xs text-muted">Title<input name="title" required maxLength={200} className={`${inputClass} mt-1`} /></label>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="block text-xs text-muted">Kind
              <select name="kind" defaultValue="process_pattern" className={`${selectClass} mt-1 w-full`}>
                {RECORD_KINDS.map((k) => <option key={k} value={k}>{k.replaceAll("_", " ")}</option>)}
              </select>
            </label>
            <label className="block text-xs text-muted">Classification
              <select name="classification" defaultValue="internal" className={`${selectClass} mt-1 w-full`}>
                {CLASSIFICATIONS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="block text-xs text-muted">Origin
              <select name="origin" defaultValue="own" className={`${selectClass} mt-1 w-full`}>
                {CREATABLE_ORIGINS.map((o) => <option key={o} value={o}>{o.replaceAll("_", " ")}</option>)}
              </select>
            </label>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="block text-xs text-muted">License<input name="license" maxLength={200} className={`${inputClass} mt-1`} placeholder="Second Brain internal, CC BY 4.0, ..." /></label>
            <label className="block text-xs text-muted">Allowed uses (comma separated)<input name="allowedUses" maxLength={1000} className={`${inputClass} mt-1`} placeholder="client_delivery, agent_context" /></label>
            <label className="block text-xs text-muted">Related skill keys (comma separated)<input name="relatedSkillKeys" maxLength={1000} className={`${inputClass} mt-1`} placeholder="process-redesign, finance-agent" /></label>
          </div>
          <label className="block text-xs text-muted">Frontmatter (one <span className="font-mono">key: value</span> per line, or a JSON object)
            <textarea name="frontmatter" rows={3} className={`${inputClass} mt-1 font-mono`} placeholder={"pattern: closure_gate\nevidence: synthetic pilot scenario; no client data"} />
          </label>
          <label className="block text-xs text-muted">Body (Markdown; <span className="font-mono">{"{{key}}"}</span> placeholders can later become template parameters)
            <textarea name="body" rows={16} required className={`${inputClass} mt-1 font-mono`} placeholder={"# Title\n\nGeneric method text. No client names, amounts or identifiers."} />
          </label>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block text-xs text-muted">Changelog<input name="changelog" maxLength={500} className={`${inputClass} mt-1`} placeholder="initial version" /></label>
            <label className="block text-xs text-muted">Evidence link<input name="evidenceLink" maxLength={1000} className={`${inputClass} mt-1`} placeholder="docs/..., a run id or an external reference" /></label>
          </div>
          <button type="submit" className={smallPrimaryClass}>Create draft</button>
        </form>
      </Card>

      <AgencyVaultStatusCard />
    </div>
  );
}
