import { notFound } from "next/navigation";
import { clientNav, Shell } from "@/components/shell";
import { Badge, Card, Empty, Status, inputClass } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { FilterBar, Notice, PageHeader, ShortId, StateBadge, Table, Td, Tr, smallDangerClass, smallPrimaryClass } from "@/components/agent-ui";
import { VaultNav, VerificationBadge } from "@/components/vault-ui";
import { getTenantHeader } from "@/lib/client/queries";
import { FACT_FILTERS, listFacts } from "@/lib/client/vault-queries";
import { setFactVerificationAction } from "@/lib/client/vault-actions";
import { canManageVaultSettings, canReviewFacts } from "@/lib/client/vault-helpers";
import { firstParam, fmtDate } from "@/lib/format";
import { requireTenantContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

const PROMOTABLE = new Set(["unconfirmed", "hypothesis", "evidence_backed"]);

export default async function VaultFactsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await requireTenantContext(slug);
  if (!access) notFound();
  const filterRaw = firstParam(sp.verification);
  const filter = filterRaw && (FACT_FILTERS as readonly string[]).includes(filterRaw) ? filterRaw : null;
  const [tenant, { facts, counts }] = await Promise.all([getTenantHeader(access.ctx), listFacts(access.ctx, filter)]);
  if (!tenant) notFound();
  const roles = access.ctx.roles;
  const mayReview = canReviewFacts(roles) && !access.viaGrant;
  const basePath = `/c/${slug}/vault/facts`;
  const returnTo = filter ? `${basePath}?verification=${filter}` : basePath;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <Shell title={tenant.name} subtitle="Client workspace" nav={clientNav(slug)}>
      <div className="space-y-6">
        <PageHeader title="Facts">
          Atomic statements with provenance and an epistemic status: unconfirmed (an answer or note), hypothesis (contradicted), evidence backed (an agent found supporting evidence), verified (a reviewer confirmed), approved policy, deprecated. Agents can never set verified; the database trigger enforces it. <Status state="implemented" />
        </PageHeader>
        <VaultNav slug={slug} active="facts" showSettings={canManageVaultSettings(roles)} />
        <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />
        <div className="flex flex-wrap items-center gap-3">
          <FilterBar basePath={basePath} param="verification" current={filter} options={[{ value: null, label: `All (${total})` }, ...FACT_FILTERS.map((f) => ({ value: f, label: `${f.replaceAll("_", " ")} (${counts[f] ?? 0})` }))]} />
          {access.viaGrant ? <Badge tone="danger">break-glass grant: read-only</Badge> : null}
        </div>

        <Card title={`Facts (${facts.length}${facts.length === 100 ? ", newest 100" : ""})`} footer={mayReview ? "Promote: unconfirmed, hypothesis or evidence-backed facts become verified (confidence 0.90). Deprecate: the fact leaves search and agent context. Each change writes a fact revision and an audit event." : "Changing a fact's verification requires the client_admin role."}>
          <Table head={["Statement", "Verification", "Confidence", "Subject", "Origin", "Sources", "Version", "Updated", "Actions"]} empty={facts.length === 0 ? <Empty>No facts{filter ? ` with verification ${filter}` : ""} yet. Answering an interview question creates the first one.</Empty> : null}>
            {facts.map((f) => (
              <Tr key={f.id}>
                <Td className="max-w-md">
                  <div className="text-sm">{f.statement}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-faint">
                    <ShortId id={f.id} />
                    <StateBadge kind="classification" value={f.classification} />
                    {f.contradictsCount > 0 ? <Badge tone="warning">contradicts {f.contradictsCount}</Badge> : null}
                    {f.responsibleRole ? <span>responsible: {f.responsibleRole}</span> : null}
                  </div>
                </Td>
                <Td><VerificationBadge value={f.verification} /></Td>
                <Td className="text-muted">{f.confidence.toFixed(2)}</Td>
                <Td className="text-xs text-muted">{f.subjectType ? `${f.subjectType}${f.subjectKey ? `: ${f.subjectKey}` : ""}` : ""}</Td>
                <Td className="text-xs text-muted">{f.originSystem}</Td>
                <Td className="text-muted">{f.sourcesCount}</Td>
                <Td className="text-muted">v{f.version}</Td>
                <Td className="text-xs text-muted">{fmtDate(f.updatedAt)}</Td>
                <Td>
                  {mayReview && f.verification !== "deprecated" ? (
                    <form action={setFactVerificationAction} className="flex flex-col gap-1">
                      <input type="hidden" name="slug" value={slug} /><input type="hidden" name="factId" value={f.id} /><input type="hidden" name="returnTo" value={returnTo} />
                      <input name="note" placeholder="note (optional)" maxLength={1000} className={`${inputClass} w-36 py-1 text-xs`} />
                      <div className="flex gap-1">
                        {PROMOTABLE.has(f.verification) ? <button type="submit" name="verification" value="verified" className={smallPrimaryClass}>Verify</button> : null}
                        <ConfirmButton name="verification" value="deprecated" message="Mark this fact deprecated? It leaves search results and agent context." className={smallDangerClass}>Deprecate</ConfirmButton>
                      </div>
                    </form>
                  ) : (
                    <span className="text-xs text-faint">{f.verification === "deprecated" ? "deprecated" : mayReview ? "" : "client_admin only"}</span>
                  )}
                </Td>
              </Tr>
            ))}
          </Table>
        </Card>

        <Card title="Implementation status">
          <ul className="space-y-1 text-sm">
            <li><Status state="implemented" /> Fact list with verification filter, confidence, subject, origin, sources and version; promote and deprecate through setFactVerification (M2-05)</li>
            <li><Status state="implemented" /> Reviewer rule enforced by the database trigger (client_admin, agency_reviewer, superadmin); agents capped at evidence_backed</li>
            <li><Status state="planned" /> Fact detail page with revision history and linked sources and evidence</li>
          </ul>
        </Card>
      </div>
    </Shell>
  );
}
