import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, Empty, Status, inputClass } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { Notice, PageHeader, ShortId, StateBadge, Table, Td, Tr, selectClass, smallButtonClass, smallDangerClass, smallPrimaryClass } from "@/components/agent-ui";
import { AGENCY_VAULT_BASE, AdoptionStateBadge, AgencyVaultNav, AgencyVaultStatusCard, ConsentBadge, DeprecationKindBadge, EvalResultBadge, KnowledgeStateBadge, OriginBadge, PromotionStateBadge } from "@/components/agency-vault-ui";
import { frontmatterRows, frontmatterToLines, renderMarkdown } from "@/lib/client/vault-helpers";
import { firstParam, fmtDate } from "@/lib/format";
import { addVersionAction, recordEvaluationResultAction, recordLifecycleAction, setCurrentVersionAction, upsertEvaluationCaseAction } from "@/lib/mission-control/agency-vault-actions";
import { agencyFolderLabel, canReviewKnowledge, recordActionsFor, recordHref, shortActor } from "@/lib/mission-control/agency-vault-helpers";
import { getRecordDetail } from "@/lib/mission-control/agency-vault-queries";
import { requireAgencyContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

export default async function RecordDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await requireAgencyContext();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await getRecordDetail(ctx, id);
  if (!d) notFound();
  const { record, current, versions, transitions, events, evaluationCases, template, adoptions, promotion } = d;
  const reviewer = canReviewKnowledge(ctx.roles);
  const here = recordHref(id);
  const html = current ? renderMarkdown(current.bodyMarkdown) : "";
  const fmRows = current ? frontmatterRows(current.frontmatter) : [];
  const actions = recordActionsFor(record.state).filter((a) => reviewer || !a.reviewerOnly);
  const hiddenActions = recordActionsFor(record.state).filter((a) => a.reviewerOnly && !reviewer);
  const isOwner = record.ownerActorId === ctx.actorId;
  const activeAdoptions = adoptions.filter((a) => a.state === "active").length;

  return (
    <div className="space-y-6">
      <PageHeader title={record.title} crumbs={[{ href: AGENCY_VAULT_BASE, label: "Agency Intelligence Vault" }, { href: `${AGENCY_VAULT_BASE}?folder=${record.folder}`, label: agencyFolderLabel(record.folder) }, { label: record.path.slice(record.folder.length + 1) }]}>
        <span className="font-mono text-xs">{record.path}</span> · {current ? `current version ${current.version}` : "no current version"} · owner <span className="font-mono text-xs">{shortActor(record.ownerActorId)}</span> · updated {fmtDate(record.updatedAt)} <Status state="implemented" />
      </PageHeader>
      <AgencyVaultNav active="library" />
      <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <KnowledgeStateBadge value={record.state} />
        <Badge>{record.kind.replaceAll("_", " ")}</Badge>
        <StateBadge kind="classification" value={record.classification} />
        <OriginBadge value={record.origin} />
        {record.license ? <Badge tone="cyan">license: {record.license}</Badge> : <Badge>no license recorded</Badge>}
        {record.allowedUses.map((u) => <Badge key={u} tone="indigo">use: {u}</Badge>)}
        {record.relatedSkillKeys.map((k) => <Badge key={k}>skill: {k}</Badge>)}
        {current ? <Badge>checksum {current.checksum.slice(0, 12)}</Badge> : null}
        {record.reviewDueAt ? <Badge tone="warning">review due {record.reviewDueAt}</Badge> : null}
        {isOwner ? <Badge tone="neutral">you are the owner</Badge> : null}
      </div>

      <Card title="Lifecycle" footer={`draft -> in_review -> approved -> published -> deprecated -> archived, enforced by enforce_knowledge_transition. Approve, publish, deprecate, reinstate and archive need agency_reviewer or superadmin; the author cannot approve their own record unless superadmin (recorded on the transition). Your roles: ${ctx.roles.join(", ")}.`}>
        {actions.length === 0 && hiddenActions.length === 0 ? (
          <Empty>{record.state === "archived" ? "Archived records take no further transitions and no new versions." : "No transition available from this state."}</Empty>
        ) : (
          <form action={recordLifecycleAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="recordId" value={record.id} />
            <input type="hidden" name="returnTo" value={here} />
            <label className="block text-xs text-muted">Note or reason<input name="note" maxLength={1000} className={`${inputClass} mt-1 w-80`} placeholder={record.state === "published" || record.state === "deprecated" ? "reason (required for deprecate, reinstate, archive)" : "note for the transition log (optional)"} /></label>
            {actions.map((a) =>
              a.destructive ? (
                <ConfirmButton key={a.action} name="action" value={a.action} message={`${a.label} this record? ${activeAdoptions} active adoption(s) keep their pinned version.`} className={smallDangerClass}>{a.label}</ConfirmButton>
              ) : (
                <button key={a.action} type="submit" name="action" value={a.action} className={a.action === "draft" ? smallButtonClass : smallPrimaryClass}>{a.label}</button>
              )
            )}
            {hiddenActions.length > 0 ? <span className="text-xs text-faint">{hiddenActions.map((a) => a.label).join(", ")}: agency_reviewer or superadmin only.</span> : null}
          </form>
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-[1fr_320px]">
        <Card title={current ? `Document (version ${current.version})` : "Document"}>
          {current ? (
            // Rendered by marked and passed through the same strict sanitizer as the client vault (lib/client/vault-helpers.ts).
            <div className="sb-prose" dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <Empty>This record has no current version. Add one below.</Empty>
          )}
        </Card>
        <div className="space-y-4">
          <Card title="Frontmatter">
            {fmRows.length === 0 ? (
              <Empty>No frontmatter.</Empty>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {fmRows.map((r) => (
                    <tr key={r.key} className="border-t border-border first:border-t-0">
                      <td className="py-1 pr-2 align-top font-mono text-xs text-faint">{r.key}</td>
                      <td className="py-1 break-words text-xs">{r.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <Card title="Record metadata">
            <dl className="space-y-1 text-xs">
              <div className="flex justify-between gap-2"><dt className="text-faint">Id</dt><dd><ShortId id={record.id} /></dd></div>
              <div className="flex justify-between gap-2"><dt className="text-faint">Created</dt><dd>{fmtDate(record.createdAt)} by {record.createdByActorType}:{shortActor(record.createdByActorId)}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-faint">Source version</dt><dd>{record.sourceVersion ?? "n/a"}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-faint">Confidence</dt><dd>{record.confidence ?? "n/a"}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-faint">Promotion request</dt><dd>{record.promotionRequestId ? <ShortId id={record.promotionRequestId} /> : "none (own knowledge)"}</dd></div>
            </dl>
          </Card>
          {promotion ? (
            <Card title="Rights basis" footer="Agency-internal metadata. The published text contains no tenant identifier and no source references; the source tenant is shown here by name only.">
              <dl className="space-y-1 text-xs">
                <div className="flex justify-between gap-2"><dt className="text-faint">Request</dt><dd><PromotionStateBadge value={promotion.state} /></dd></div>
                <div className="flex justify-between gap-2"><dt className="text-faint">Source tenant</dt><dd>{promotion.tenantName} <span className="font-mono text-faint">{promotion.tenantSlug}</span></dd></div>
                <div className="flex justify-between gap-2"><dt className="text-faint">Consent</dt><dd><ConsentBadge value={promotion.consentStatus} /></dd></div>
                <div className="flex justify-between gap-2"><dt className="text-faint">Rights basis</dt><dd className="text-right">{promotion.rightsBasis ?? "recorded on the request"}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-faint">Decided</dt><dd>{fmtDate(promotion.decidedAt)}</dd></div>
              </dl>
            </Card>
          ) : null}
        </div>
      </div>

      <Card title={`Versions (${versions.length})`} footer="Versions are immutable (database trigger). For a draft or in-review record a new version becomes current at once; for an approved, published or deprecated record it is stored only and a reviewer releases it with Make current (release or rollback, logged with the number of active adoptions that still run another version).">
        <Table head={["Version", "Changelog", "Checksum", "Evidence", "Created by", "Created", "Actions"]} empty={versions.length === 0 ? <Empty>No versions.</Empty> : null}>
          {versions.map((v) => {
            const isCurrent = v.id === record.currentVersionId;
            return (
              <Tr key={v.id}>
                <Td className="font-medium">v{v.version} {isCurrent ? <Badge tone="cyan">current</Badge> : null}</Td>
                <Td className="max-w-sm text-xs text-muted">{v.changelog}</Td>
                <Td className="font-mono text-[11px] text-faint">{v.checksum.slice(0, 12)}</Td>
                <Td className="text-xs">{v.evidenceLink ? <span className="break-all text-muted">{v.evidenceLink}</span> : <span className="text-faint">none</span>}</Td>
                <Td className="text-xs text-muted">{v.createdByActorType}:{shortActor(v.createdByActorId)}</Td>
                <Td className="text-muted">{fmtDate(v.createdAt)}</Td>
                <Td>
                  {isCurrent ? (
                    <span className="text-xs text-faint">live version</span>
                  ) : reviewer && record.state !== "archived" ? (
                    <form action={setCurrentVersionAction} className="flex items-center gap-1">
                      <input type="hidden" name="recordId" value={record.id} />
                      <input type="hidden" name="versionId" value={v.id} />
                      <input type="hidden" name="returnTo" value={here} />
                      <input name="reason" required maxLength={1000} placeholder="reason" className={`${inputClass} w-40 py-1 text-xs`} />
                      <ConfirmButton message={`Make version ${v.version} the current version? Active adoptions keep their pinned version.`} className={smallButtonClass}>Make current</ConfirmButton>
                    </form>
                  ) : (
                    <span className="text-xs text-faint">{record.state === "archived" ? "archived" : "release: reviewer only"}</span>
                  )}
                </Td>
              </Tr>
            );
          })}
        </Table>
      </Card>

      {record.state !== "archived" ? (
        <Card title="Add version" footer="Creates the next immutable version with a changelog and an optional evidence link. Frontmatter is prefilled from the current version.">
          <form action={addVersionAction} className="space-y-3">
            <input type="hidden" name="recordId" value={record.id} />
            <input type="hidden" name="returnTo" value={here} />
            <label className="block text-xs text-muted">Frontmatter (one <span className="font-mono">key: value</span> per line, or a JSON object)
              <textarea name="frontmatter" rows={3} defaultValue={current ? frontmatterToLines(current.frontmatter) : ""} className={`${inputClass} mt-1 font-mono`} />
            </label>
            <label className="block text-xs text-muted">Body (Markdown; <span className="font-mono">{"{{key}}"}</span> placeholders become template parameters)
              <textarea name="body" rows={14} required defaultValue={current?.bodyMarkdown ?? ""} className={`${inputClass} mt-1 font-mono`} />
            </label>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block text-xs text-muted">Changelog<input name="changelog" required maxLength={500} className={`${inputClass} mt-1`} placeholder="what changed and why" /></label>
              <label className="block text-xs text-muted">Evidence link<input name="evidenceLink" maxLength={1000} className={`${inputClass} mt-1`} placeholder="docs/..., a run id or an external reference" /></label>
            </div>
            <button type="submit" className={smallPrimaryClass}>Add version</button>
          </form>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title={`Transitions (${transitions.length})`} footer="Written by the database trigger on every state change: actor, roles at that moment and the note. self_approved_by_superadmin marks an owner approving their own record.">
          <Table head={["When", "From", "To", "Actor", "Roles", "Note"]} empty={transitions.length === 0 ? <Empty>No transitions.</Empty> : null}>
            {transitions.map((t) => (
              <Tr key={t.id}>
                <Td className="text-muted">{fmtDate(t.createdAt)}</Td>
                <Td className="text-xs">{t.fromState ? t.fromState.replaceAll("_", " ") : <span className="text-faint">new</span>}</Td>
                <Td><KnowledgeStateBadge value={t.toState} /></Td>
                <Td className="font-mono text-[11px] text-muted">{t.actorType}:{shortActor(t.actorId)}</Td>
                <Td className="text-xs text-muted">{t.roles.join(", ")}</Td>
                <Td className="max-w-xs text-xs text-muted">{t.note ?? ""}</Td>
              </Tr>
            ))}
          </Table>
        </Card>
        <Card title={`Release and deprecation events (${events.length})`} footer="affected adoptions counts the active adoptions that kept running another version when the event happened (acceptance 5: adoptions never change under a release, rollback or deprecation).">
          <Table head={["When", "Kind", "Version", "Reason", "Affected adoptions", "Actor"]} empty={events.length === 0 ? <Empty>No release, rollback or deprecation events.</Empty> : null}>
            {events.map((e) => {
              const v = versions.find((x) => x.id === e.versionId);
              return (
                <Tr key={e.id}>
                  <Td className="text-muted">{fmtDate(e.createdAt)}</Td>
                  <Td><DeprecationKindBadge value={e.kind} /></Td>
                  <Td className="text-xs">{v ? `v${v.version}` : <span className="text-faint">n/a</span>}</Td>
                  <Td className="max-w-xs text-xs text-muted">{e.reason}</Td>
                  <Td className="text-xs">{e.affectedAdoptions}</Td>
                  <Td className="font-mono text-[11px] text-muted">{e.actorType}:{shortActor(e.actorId)}</Td>
                </Tr>
              );
            })}
          </Table>
        </Card>
      </div>

      <Card title={`Evaluation cases (${evaluationCases.length})`} footer="Named input and expected output pairs per record. Results are recorded by hand against a version; automated runs by the Agency Knowledge Curator Agent are planned.">
        <Table head={["Name", "Input", "Expected", "Last result", "Version", "Last run", "Record result"]} empty={evaluationCases.length === 0 ? <Empty>No evaluation cases yet.</Empty> : null}>
          {evaluationCases.map((c) => (
            <Tr key={c.id}>
              <Td className="font-medium">{c.name}</Td>
              <Td className="max-w-xs font-mono text-[11px] text-muted break-all">{JSON.stringify(c.input)}</Td>
              <Td className="max-w-xs font-mono text-[11px] text-muted break-all">{JSON.stringify(c.expected)}</Td>
              <Td><EvalResultBadge value={c.lastResult} /></Td>
              <Td className="text-xs">{c.lastVersion ? `v${c.lastVersion}` : <span className="text-faint">n/a</span>}</Td>
              <Td className="text-muted">{fmtDate(c.lastRunAt)}</Td>
              <Td>
                {versions.length > 0 ? (
                  <form action={recordEvaluationResultAction} className="flex items-center gap-1">
                    <input type="hidden" name="recordId" value={record.id} />
                    <input type="hidden" name="caseId" value={c.id} />
                    <input type="hidden" name="returnTo" value={here} />
                    <select name="versionId" defaultValue={record.currentVersionId ?? versions[0]!.id} className={`${selectClass} py-1 text-xs`}>
                      {versions.map((v) => <option key={v.id} value={v.id}>v{v.version}</option>)}
                    </select>
                    <button type="submit" name="result" value="pass" className={smallPrimaryClass}>Pass</button>
                    <button type="submit" name="result" value="fail" className={smallDangerClass}>Fail</button>
                  </form>
                ) : null}
              </Td>
            </Tr>
          ))}
        </Table>
        <form action={upsertEvaluationCaseAction} className="mt-4 grid gap-3 md:grid-cols-[200px_1fr_1fr_auto]">
          <input type="hidden" name="recordId" value={record.id} />
          <input type="hidden" name="returnTo" value={here} />
          <label className="block text-xs text-muted">Name<input name="name" required maxLength={120} className={`${inputClass} mt-1`} placeholder="e.g. hotel checkout" /></label>
          <label className="block text-xs text-muted">Input (JSON object)<input name="input" className={`${inputClass} mt-1 font-mono`} placeholder='{"project_system": "Mews PMS"}' /></label>
          <label className="block text-xs text-muted">Expected (JSON object)<input name="expected" className={`${inputClass} mt-1 font-mono`} placeholder='{"contains": "Mews PMS"}' /></label>
          <div className="flex items-end"><button type="submit" className={smallButtonClass}>Save case</button></div>
        </form>
      </Card>

      {template ? (
        <Card title={`Template definition: ${template.key}`} footer={<>Adoptions show metadata only (tenant, version, state, time); parameter values and the client&apos;s document stay in the client vault. Adopt, roll back or revoke on the <Link href={`${AGENCY_VAULT_BASE}/templates`} className="underline">Templates page</Link>.</>}>
          <div className="grid gap-4 md:grid-cols-2">
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between gap-2"><dt className="text-faint">Name</dt><dd>{template.name}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-faint">Target client folder</dt><dd className="font-mono text-xs">{template.targetFolder}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-faint">Active</dt><dd>{template.active ? <Badge tone="success">yes</Badge> : <Badge tone="danger">no</Badge>}</dd></div>
              <div><dt className="text-faint">Description</dt><dd className="text-muted">{template.description}</dd></div>
              <div><dt className="text-faint">Parameters</dt><dd>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {template.parameters.map((p) => <li key={p.key}><span className="font-mono">{p.key}</span> · {p.label} · {p.required ? "required" : "optional"}{p.default !== undefined ? ` · default "${p.default}"` : ""}</li>)}
                  {template.parameters.length === 0 ? <li className="text-faint">none</li> : null}
                </ul>
              </dd></div>
            </dl>
            <Table head={["Tenant", "Version", "State", "Adopted", "Ended"]} empty={adoptions.length === 0 ? <Empty>No adoptions yet.</Empty> : null}>
              {adoptions.map((a) => (
                <Tr key={a.id}>
                  <Td>{a.tenantName} <span className="font-mono text-[11px] text-faint">{a.tenantSlug}</span></Td>
                  <Td className="text-xs">v{a.version}</Td>
                  <Td><AdoptionStateBadge value={a.state} /></Td>
                  <Td className="text-muted">{fmtDate(a.adoptedAt)}</Td>
                  <Td className="text-muted">{a.endedAt ? fmtDate(a.endedAt) : ""}</Td>
                </Tr>
              ))}
            </Table>
          </div>
        </Card>
      ) : (
        <Card title="Template definition" footer="A record becomes a methodology template on the Templates page (key, name, description, target client folder, parameters).">
          <Empty>No methodology template references this record. {record.state === "published" ? <Link href={`${AGENCY_VAULT_BASE}/templates?record=${record.id}`} className="underline">Create one</Link> : "Publish the record first; only published versions can be adopted."}</Empty>
        </Card>
      )}

      <AgencyVaultStatusCard />
    </div>
  );
}
