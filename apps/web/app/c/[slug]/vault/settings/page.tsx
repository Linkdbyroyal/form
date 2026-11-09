import { notFound } from "next/navigation";
import { clientNav, Shell } from "@/components/shell";
import { Badge, Card, Status } from "@/components/ui";
import { Notice, PageHeader, selectClass, smallPrimaryClass } from "@/components/agent-ui";
import { VaultNav } from "@/components/vault-ui";
import { getTenantHeader } from "@/lib/client/queries";
import { getWriteModePolicy } from "@/lib/client/vault-queries";
import { saveWriteModePolicyAction } from "@/lib/client/vault-actions";
import { canManageVaultSettings, folderLabel, VAULT_FOLDERS } from "@/lib/client/vault-helpers";
import { firstParam, fmtDate } from "@/lib/format";
import { requireTenantContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

export default async function VaultSettingsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await requireTenantContext(slug);
  if (!access) notFound();
  const roles = access.ctx.roles;
  const mayManage = canManageVaultSettings(roles) && !access.viaGrant;
  const [tenant, policy] = await Promise.all([getTenantHeader(access.ctx), getWriteModePolicy(access.ctx)]);
  if (!tenant) notFound();
  const currentDefault = policy.value.default === "proposal_required" ? "proposal_required" : "auto_draft";
  const overrides = VAULT_FOLDERS.filter((f) => policy.value[f] === "auto_draft" || policy.value[f] === "proposal_required").length;
  return (
    <Shell title={tenant.name} subtitle="Client workspace" nav={clientNav(slug)}>
      <div className="space-y-6">
        <PageHeader title="Vault settings">
          How agents may write into your vault. <em>auto_draft</em>: the agent writes a draft document directly (verification unconfirmed, a revision is recorded). <em>proposal_required</em>: the agent files a change proposal that a client admin or department manager approves in the review queue. The policy is stored as <span className="font-mono">vault.agent_write_mode</span> and read by agents on every write. <Status state="implemented" />
        </PageHeader>
        <VaultNav slug={slug} active="settings" showSettings={canManageVaultSettings(roles)} />
        <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge tone="cyan">your roles: {roles.join(", ") || "none"}</Badge>
          <Badge>current default: {currentDefault}</Badge>
          <Badge>{overrides} folder override{overrides === 1 ? "" : "s"}</Badge>
          {policy.updatedAt ? <Badge>last saved {fmtDate(policy.updatedAt)} by <span className="font-mono">{policy.updatedByActorId}</span></Badge> : <Badge tone="warning">no policy saved yet: agents use auto_draft</Badge>}
        </div>

        {!mayManage ? (
          <Card title="Agent write mode">
            <p className="text-sm text-muted">{access.viaGrant ? "Break-glass access is read-only." : "Only the client admin can change vault settings."} Current default: <span className="font-medium text-fg">{currentDefault}</span>.</p>
            {overrides > 0 ? (
              <ul className="mt-2 space-y-1 text-sm">
                {VAULT_FOLDERS.filter((f) => policy.value[f]).map((f) => (
                  <li key={f} className="flex justify-between"><span className="font-mono text-xs">{f}</span><span className="text-muted">{policy.value[f]}</span></li>
                ))}
              </ul>
            ) : null}
          </Card>
        ) : (
          <form action={saveWriteModePolicyAction}>
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="returnTo" value={`/c/${slug}/vault/settings`} />
            <div className="space-y-4">
              <Card title="Default mode" footer="Applies to every folder without an override below.">
                <label className="flex items-center gap-3 text-sm">
                  <span className="text-muted">Agents write as</span>
                  <select name="default" defaultValue={currentDefault} className={selectClass}>
                    <option value="auto_draft">auto_draft (write drafts directly)</option>
                    <option value="proposal_required">proposal_required (file a proposal for review)</option>
                  </select>
                </label>
              </Card>
              <Card title="Per-folder overrides" footer="Inherit keeps the default. Sensitive folders (finance, policies and security) are good candidates for proposal_required.">
                <div className="grid gap-2 md:grid-cols-2">
                  {VAULT_FOLDERS.map((f) => (
                    <label key={f} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
                      <span><span className="font-mono text-[11px] text-faint">{f.slice(0, 2)}</span> {folderLabel(f)}</span>
                      <select name={`folder:${f}`} defaultValue={policy.value[f] === "auto_draft" || policy.value[f] === "proposal_required" ? policy.value[f] : "inherit"} className={selectClass}>
                        <option value="inherit">inherit</option>
                        <option value="auto_draft">auto_draft</option>
                        <option value="proposal_required">proposal_required</option>
                      </select>
                    </label>
                  ))}
                </div>
                <div className="mt-4 flex items-center gap-2">
                  <button type="submit" className={smallPrimaryClass}>Save policy</button>
                  <span className="text-xs text-faint">Written through setTenantPolicy; audited as tenant_policy.set.</span>
                </div>
              </Card>
            </div>
          </form>
        )}

        <Card title="Implementation status">
          <ul className="space-y-1 text-sm">
            <li><Status state="implemented" /> Default and per-folder agent write mode stored as a tenant policy and resolved by agentWriteDocument (M2-10)</li>
            <li><Status state="planned" /> Policies for retention, export schedule and classification defaults</li>
          </ul>
        </Card>
      </div>
    </Shell>
  );
}
