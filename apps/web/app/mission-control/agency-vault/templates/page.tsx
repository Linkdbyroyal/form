import Link from "next/link";
import { CLIENT_VAULT_FOLDERS } from "@sbos/core";
import { Badge, Card, Empty, Status, inputClass } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { Notice, PageHeader, ShortId, Table, Td, Tr, selectClass, smallButtonClass, smallDangerClass, smallPrimaryClass } from "@/components/agent-ui";
import { AGENCY_VAULT_BASE, AdoptionStateBadge, AgencyVaultNav, AgencyVaultStatusCard, KnowledgeStateBadge } from "@/components/agency-vault-ui";
import { firstParam, fmtDate } from "@/lib/format";
import { adoptTemplateAction, createTemplateAction, revokeAdoptionAction, rollbackAdoptionAction } from "@/lib/mission-control/agency-vault-actions";
import { canReviewKnowledge, recordHref, shortActor } from "@/lib/mission-control/agency-vault-helpers";
import { getTemplatesView } from "@/lib/mission-control/agency-vault-queries";
import { requireAgencyContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

const RETURN_TO = `${AGENCY_VAULT_BASE}/templates`;

export default async function TemplatesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAgencyContext();
  const sp = await searchParams;
  const view = await getTemplatesView(ctx);
  const reviewer = canReviewKnowledge(ctx.roles);
  const presetRecord = firstParam(sp.record);
  const tenantsById = new Map(view.clientTenants.map((t) => [t.id, t]));

  return (
    <div className="space-y-6">
      <PageHeader title="Templates and adoptions" crumbs={[{ href: AGENCY_VAULT_BASE, label: "Agency Intelligence Vault" }, { label: "Templates & adoptions" }]}>
        Methodology templates turn a published agency record into a client document with the tenant&apos;s own values. An adoption pins one version per tenant; releases, rollbacks and deprecations of the record never change a running adoption (acceptance 5). The matrix shows which version runs where, never the parameters or the client&apos;s text (acceptance 6). <Status state="implemented" />
      </PageHeader>
      <AgencyVaultNav active="templates" />
      <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />

      <Card title={`Templates (${view.templates.length})`} footer="Only a published record can be adopted (enforce_adoption). Parameters are declared per template; {{key}} placeholders in the record body are replaced on adoption.">
        <Table head={["Template", "Record", "Record state", "Current version", "Target client folder", "Parameters", "Active"]} empty={view.templates.length === 0 ? <Empty>No templates. Create one from a record below.</Empty> : null}>
          {view.templates.map((t) => (
            <Tr key={t.template.id}>
              <Td><div className="font-medium">{t.template.name}</div><div className="font-mono text-[11px] text-faint">{t.template.key}</div></Td>
              <Td><Link href={recordHref(t.template.recordId)} className="underline">{t.recordTitle}</Link><div className="font-mono text-[11px] text-faint">{t.recordPath}</div></Td>
              <Td><KnowledgeStateBadge value={t.recordState} /></Td>
              <Td className="text-xs">{t.currentVersion ? `v${t.currentVersion}` : <span className="text-faint">none</span>} <span className="text-faint">({t.versions.length} stored)</span></Td>
              <Td className="font-mono text-xs">{t.template.targetFolder}</Td>
              <Td className="text-xs text-muted">{t.template.parameters.map((p) => `${p.key}${p.required ? "*" : ""}`).join(", ") || "none"}</Td>
              <Td>{t.template.active ? <Badge tone="success">active</Badge> : <Badge tone="danger">inactive</Badge>}</Td>
            </Tr>
          ))}
        </Table>
      </Card>

      <Card title="Adoption matrix (tenant x template)" footer="Metadata only: version, state and time of the latest adoption per cell. Parameter values and the generated document are visible in the client's own vault, not here. Roll back returns the tenant to its previous adoption's version and values as a new document revision; revoke ends the adoption and leaves the document in place.">
        {view.clientTenants.length === 0 || view.templates.length === 0 ? (
          <Empty>Nothing to show yet: {view.clientTenants.length === 0 ? "no client tenants" : "no templates"}.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-faint">
                <tr>
                  <th className="py-2 pr-3 font-medium">Tenant</th>
                  {view.templates.map((t) => <th key={t.template.id} className="py-2 pr-3 font-medium">{t.template.key}</th>)}
                </tr>
              </thead>
              <tbody>
                {view.clientTenants.map((tenant) => (
                  <tr key={tenant.id} className="border-t border-border align-top">
                    <td className="py-2 pr-3"><div className="font-medium">{tenant.name}</div><div className="font-mono text-[11px] text-faint">{tenant.slug} · {tenant.kind}</div></td>
                    {view.templates.map((t) => {
                      const cell = view.adoptions.filter((a) => a.tenantId === tenant.id && a.templateId === t.template.id);
                      const active = cell.find((a) => a.state === "active") ?? null;
                      const latest = cell[0] ?? null;
                      const shown = active ?? latest;
                      return (
                        <td key={t.template.id} className="py-2 pr-3">
                          {!shown ? (
                            <span className="text-xs text-faint">not adopted</span>
                          ) : (
                            <div className="space-y-1 text-xs">
                              <div className="flex flex-wrap items-center gap-1"><span className="font-medium">v{shown.version}</span> <AdoptionStateBadge value={shown.state} /></div>
                              <div className="text-muted">{fmtDate(shown.adoptedAt)} by {shortActor(shown.adoptedByActorId)}</div>
                              <div className="text-faint">{cell.length} adoption record(s)</div>
                              {active ? (
                                <div className="space-y-1">
                                  <form action={rollbackAdoptionAction} className="flex items-center gap-1">
                                    <input type="hidden" name="tenantId" value={tenant.id} /><input type="hidden" name="adoptionId" value={active.id} /><input type="hidden" name="returnTo" value={RETURN_TO} />
                                    <input name="reason" required maxLength={500} placeholder="reason" className={`${inputClass} w-32 py-1 text-xs`} />
                                    <ConfirmButton message={`Roll ${tenant.name} back to the previous adoption of ${t.template.key}? The client document gets a new revision with the earlier version's text.`} className={smallButtonClass}>Roll back</ConfirmButton>
                                  </form>
                                  <form action={revokeAdoptionAction} className="flex items-center gap-1">
                                    <input type="hidden" name="tenantId" value={tenant.id} /><input type="hidden" name="adoptionId" value={active.id} /><input type="hidden" name="returnTo" value={RETURN_TO} />
                                    <input name="reason" required maxLength={500} placeholder="reason" className={`${inputClass} w-32 py-1 text-xs`} />
                                    <ConfirmButton message={`Revoke the adoption of ${t.template.key} for ${tenant.name}? The document stays in the client vault, marked as revoked.`} className={smallDangerClass}>Revoke</ConfirmButton>
                                  </form>
                                </div>
                              ) : null}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={`All adoptions (${view.adoptions.length})`} footer="Every adoption row, including superseded, rolled back and revoked ones. previous links the adoption that a rollback or upgrade replaced.">
        <Table head={["Adoption", "Tenant", "Template", "Version", "State", "Adopted by", "Adopted", "Ended", "Previous", "Note"]} empty={view.adoptions.length === 0 ? <Empty>No adoptions yet.</Empty> : null}>
          {view.adoptions.map((a) => (
            <Tr key={a.id}>
              <Td><ShortId id={a.id} /></Td>
              <Td>{tenantsById.get(a.tenantId)?.name ?? a.tenantName}</Td>
              <Td className="font-mono text-xs">{a.templateKey}</Td>
              <Td className="text-xs">v{a.version}</Td>
              <Td><AdoptionStateBadge value={a.state} /></Td>
              <Td className="font-mono text-[11px] text-muted">{shortActor(a.adoptedByActorId)}</Td>
              <Td className="text-muted">{fmtDate(a.adoptedAt)}</Td>
              <Td className="text-muted">{a.endedAt ? fmtDate(a.endedAt) : ""}</Td>
              <Td>{a.previousAdoptionId ? <ShortId id={a.previousAdoptionId} /> : ""}</Td>
              <Td className="max-w-xs text-xs text-muted">{a.note ?? ""}</Td>
            </Tr>
          ))}
        </Table>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {view.templates.map((t) => (
          <Card key={t.template.id} title={`Adopt ${t.template.key} into a tenant`} footer={`Runs adoptTemplate in agency scope pinned to the chosen tenant: the agency record is read and the client document ${t.template.targetFolder}/${t.template.key}.md is written in one transaction. A previous active adoption of this template becomes superseded.`}>
            {t.recordState !== "published" ? <p className="mb-2 text-xs text-warning">The record is {t.recordState}; adoption is refused by the database until it is published.</p> : null}
            <form action={adoptTemplateAction} className="space-y-2">
              <input type="hidden" name="templateKey" value={t.template.key} />
              <input type="hidden" name="returnTo" value={RETURN_TO} />
              <div className="grid gap-2 md:grid-cols-2">
                <label className="block text-xs text-muted">Tenant
                  <select name="tenantId" required className={`${selectClass} mt-1 w-full`}>
                    {view.clientTenants.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.slug})</option>)}
                  </select>
                </label>
                <label className="block text-xs text-muted">Version
                  <select name="versionId" defaultValue="" className={`${selectClass} mt-1 w-full`}>
                    <option value="">current{t.currentVersion ? ` (v${t.currentVersion})` : ""}</option>
                    {t.versions.map((v) => <option key={v.id} value={v.id}>v{v.version}: {v.changelog.slice(0, 50)}</option>)}
                  </select>
                </label>
              </div>
              {t.template.parameters.length === 0 ? <p className="text-xs text-faint">This template declares no parameters.</p> : null}
              <div className="grid gap-2 md:grid-cols-2">
                {t.template.parameters.map((p) => (
                  <label key={p.key} className="block text-xs text-muted">
                    {p.label} {p.required ? <span className="text-danger">*</span> : <span className="text-faint">(optional)</span>}
                    <input name={`param_${p.key}`} defaultValue={p.default ?? ""} required={p.required && p.default === undefined} maxLength={2000} className={`${inputClass} mt-1`} placeholder={p.description ?? p.key} />
                  </label>
                ))}
              </div>
              <label className="block text-xs text-muted">Note<input name="note" maxLength={500} className={`${inputClass} mt-1`} placeholder="why this tenant adopts this version (optional)" /></label>
              <button type="submit" className={smallPrimaryClass}>Adopt into tenant</button>
            </form>
          </Card>
        ))}
      </div>

      <Card title="Create template from record" footer={`Parameters: one per line as key | label | required | default (third field: required or optional). Keys must match the {{key}} placeholders in the record body. Target folder is one of the ${CLIENT_VAULT_FOLDERS.length} client vault folders. ${reviewer ? "" : "Any agency role may define a template; adopting needs a published record."}`}>
        {view.candidateRecords.length === 0 ? (
          <Empty>Every record already has a template, or no records exist yet.</Empty>
        ) : (
          <form action={createTemplateAction} className="space-y-2">
            <input type="hidden" name="returnTo" value={RETURN_TO} />
            <div className="grid gap-2 md:grid-cols-2">
              <label className="block text-xs text-muted">Record
                <select name="recordId" defaultValue={presetRecord ?? view.candidateRecords[0]!.id} className={`${selectClass} mt-1 w-full`}>
                  {view.candidateRecords.map((r) => <option key={r.id} value={r.id}>{r.title} ({r.state}) · {r.path}</option>)}
                </select>
              </label>
              <label className="block text-xs text-muted">Key (lowercase, digits, dashes)<input name="key" required maxLength={64} pattern="[a-z0-9][a-z0-9-]{1,63}" className={`${inputClass} mt-1`} placeholder="closure-check-v2" /></label>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              <label className="block text-xs text-muted">Name<input name="name" required maxLength={200} className={`${inputClass} mt-1`} /></label>
              <label className="block text-xs text-muted">Target client folder
                <select name="targetFolder" defaultValue="05_processes_to_be" className={`${selectClass} mt-1 w-full`}>
                  {CLIENT_VAULT_FOLDERS.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </label>
            </div>
            <label className="block text-xs text-muted">Description<textarea name="description" required rows={2} maxLength={2000} className={`${inputClass} mt-1`} /></label>
            <label className="block text-xs text-muted">Parameters<textarea name="parameters" rows={5} className={`${inputClass} mt-1 font-mono`} placeholder={"project_system | Project or job system | required\nfinance_owner | Finance owner | required | finance\ninvoice_days | Invoice within (working days) | optional | 2"} /></label>
            <button type="submit" className={smallPrimaryClass}>Create template</button>
          </form>
        )}
      </Card>

      <AgencyVaultStatusCard />
    </div>
  );
}
