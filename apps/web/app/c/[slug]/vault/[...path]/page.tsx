import Link from "next/link";
import { notFound } from "next/navigation";
import { clientNav, Shell } from "@/components/shell";
import { Badge, Card, Empty, Status, inputClass } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { Notice, PageHeader, ShortId, StateBadge, Table, Td, Tr, selectClass, smallButtonClass, smallDangerClass, smallPrimaryClass } from "@/components/agent-ui";
import { DiffView, VaultNav, VerificationBadge } from "@/components/vault-ui";
import { getTenantHeader } from "@/lib/client/queries";
import { getVaultDocumentView } from "@/lib/client/vault-queries";
import { revertDocumentAction, saveDocumentAction } from "@/lib/client/vault-actions";
import { canEditDocuments, canManageVaultSettings, diffSummary, DOC_PATH_RE, folderOf, frontmatterRows, frontmatterToLines, lineDiff, renderMarkdown, VAULT_FOLDERS } from "@/lib/client/vault-helpers";
import { firstParam, fmtDate } from "@/lib/format";
import { requireTenantContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

function docHref(slug: string, path: string): string {
  return `/c/${slug}/vault/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export default async function VaultDocumentPage({ params, searchParams }: { params: Promise<{ slug: string; path: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug, path: segments } = await params;
  const sp = await searchParams;
  const access = await requireTenantContext(slug);
  if (!access) notFound();
  const path = segments.map((s) => decodeURIComponent(s)).join("/");
  if (!DOC_PATH_RE.test(path) || path.includes("..")) notFound();
  const compareRaw = Number(firstParam(sp.compare));
  const compareVersion = Number.isInteger(compareRaw) && compareRaw > 0 ? compareRaw : null;
  const editing = firstParam(sp.edit) === "1";
  const [tenant, view] = await Promise.all([getTenantHeader(access.ctx), getVaultDocumentView(access.ctx, path, compareVersion)]);
  if (!tenant) notFound();
  const roles = access.ctx.roles;
  const mayEdit = canEditDocuments(roles) && !access.viaGrant;
  const folder = folderOf(path);
  const here = docHref(slug, path);
  const crumbs = [{ href: `/c/${slug}/vault`, label: "Knowledge Vault" }, { href: `/c/${slug}/vault?folder=${folder}`, label: folder }, { label: path.slice(folder.length + 1) }];

  if (!view) {
    return (
      <Shell title={tenant.name} subtitle="Client workspace" nav={clientNav(slug)}>
        <div className="space-y-6">
          <PageHeader title="Document not found" crumbs={crumbs}>No document at <span className="font-mono">{path}</span> is visible to you.</PageHeader>
          <VaultNav slug={slug} active="browse" showSettings={canManageVaultSettings(roles)} />
          <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />
          <Card title="Why this can happen">
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
              <li>The path does not exist in this vault (check the folder list).</li>
              <li>The document is classified <em>restricted</em>: Row-Level Security hides it from every role except client_admin, agency_reviewer and superadmin. Your roles: {roles.join(", ") || "none"}.</li>
            </ul>
          </Card>
          {mayEdit && VAULT_FOLDERS.includes(folder) ? (
            <Card title="Create this document" footer="Creates version 1 and indexes its links. The path must be <NN_folder>/<name>.md inside one of the 20 standard folders.">
              <DocumentForm slug={slug} path={path} mode="create" title="" frontmatter={{}} body="" classification="confidential" />
            </Card>
          ) : null}
        </div>
      </Shell>
    );
  }

  const { document: doc, revisions, backlinks, outgoing, compare } = view;
  const html = renderMarkdown(doc.bodyMarkdown, { linkBase: `/c/${slug}/vault` });
  const diff = compare ? lineDiff(compare.bodyMarkdown, doc.bodyMarkdown) : null;
  const summary = diff ? diffSummary(diff) : null;
  const fmRows = frontmatterRows(doc.frontmatter);

  return (
    <Shell title={tenant.name} subtitle="Client workspace" nav={clientNav(slug)}>
      <div className="space-y-6">
        <PageHeader title={doc.title} crumbs={crumbs}>
          <span className="font-mono text-xs">{doc.path}</span> · version {doc.version} · updated {fmtDate(doc.updatedAt)} by <span className="font-mono text-xs">{doc.updatedByActorId}</span> <Status state="implemented" />
        </PageHeader>
        <VaultNav slug={slug} active="browse" showSettings={canManageVaultSettings(roles)} />
        <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <StateBadge kind="classification" value={doc.classification} />
          <VerificationBadge value={doc.verification} />
          <Badge>checksum {doc.checksum.slice(0, 12)}</Badge>
          {typeof doc.frontmatter.sbos_template_key === "string" ? (
            <span title={doc.frontmatter.sbos_template_revoked_at ? "The agency ended this adoption; the document stays in your vault." : "Installed from a Second Brain methodology template with your company's values. Agency knowledge itself is not visible from a client workspace."}>
              <Badge tone="indigo">Adopted from agency template {doc.frontmatter.sbos_template_key}{typeof doc.frontmatter.sbos_template_version === "number" ? ` v${doc.frontmatter.sbos_template_version}` : ""}{doc.frontmatter.sbos_template_revoked_at ? " (adoption ended)" : ""}</Badge>
            </span>
          ) : null}
          {mayEdit ? (
            editing ? <Link href={here} className={smallButtonClass}>Cancel edit</Link> : <Link href={`${here}?edit=1`} className={smallButtonClass}>Edit</Link>
          ) : (
            <span className="text-faint">{access.viaGrant ? "break-glass access is read-only" : "editing requires client_admin or department_manager"}</span>
          )}
          {compare ? <Link href={here} className={smallButtonClass}>Close comparison</Link> : null}
        </div>

        {editing && mayEdit ? (
          <Card title="Edit document" footer="Saving creates a new revision; the previous version stays in the list below and can be restored. Links ([[wikilinks]] and relative .md links) are re-indexed on save.">
            <DocumentForm slug={slug} path={doc.path} mode="edit" title={doc.title} frontmatter={doc.frontmatter} body={doc.bodyMarkdown} classification={doc.classification} canRestrict={roles.includes("client_admin")} />
          </Card>
        ) : null}

        {compare && diff && summary ? (
          <Card title={`Compare version ${compare.version} with current version ${doc.version}`} footer="Left-hand (red) lines exist only in the older version; right-hand (green) lines only in the current one. Minimal line diff; frontmatter differences are listed above the body.">
            <div className="mb-2 flex flex-wrap gap-2 text-xs">
              <Badge tone="success">+{summary.added} lines</Badge>
              <Badge tone="danger">-{summary.removed} lines</Badge>
              {JSON.stringify(compare.frontmatter) !== JSON.stringify(doc.frontmatter) ? <Badge tone="warning">frontmatter differs</Badge> : <Badge>frontmatter identical</Badge>}
            </div>
            {JSON.stringify(compare.frontmatter) !== JSON.stringify(doc.frontmatter) ? (
              <div className="mb-3 grid gap-2 text-xs md:grid-cols-2">
                <pre className="overflow-x-auto rounded-md border border-border bg-surface-2 p-2 font-mono">{`# v${compare.version}\n${frontmatterToLines(compare.frontmatter) || "(empty)"}`}</pre>
                <pre className="overflow-x-auto rounded-md border border-border bg-surface-2 p-2 font-mono">{`# v${doc.version}\n${frontmatterToLines(doc.frontmatter) || "(empty)"}`}</pre>
              </div>
            ) : null}
            <DiffView ops={diff} />
          </Card>
        ) : null}

        <div className="grid gap-4 md:grid-cols-[1fr_300px]">
          <Card title="Document">
            {/* Rendered by marked and passed through a strict allow-list sanitizer (sanitize-html); see lib/client/vault-helpers.ts. */}
            <div className="sb-prose" dangerouslySetInnerHTML={{ __html: html }} />
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
            <Card title={`Backlinks (${backlinks.length})`} footer="Documents whose body links to this path.">
              {backlinks.length === 0 ? (
                <Empty>No document links here yet.</Empty>
              ) : (
                <ul className="space-y-1 text-sm">
                  {backlinks.map((b) => (
                    <li key={b.fromDocumentId}>
                      <Link href={docHref(slug, b.path)} className="underline">{b.title}</Link>
                      <div className="font-mono text-[11px] text-faint">{b.path}{b.linkText ? ` · "${b.linkText}"` : ""}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title={`Outgoing links (${outgoing.length})`} footer="Extracted from the body on every save. A dangling link resolves when its target document is created.">
              {outgoing.length === 0 ? (
                <Empty>This document links nowhere.</Empty>
              ) : (
                <ul className="space-y-1 text-sm">
                  {outgoing.map((o) => (
                    <li key={o.toPath} className="flex items-center justify-between gap-2">
                      <Link href={docHref(slug, o.toPath)} className="truncate font-mono text-xs underline">{o.toPath}</Link>
                      {o.toDocumentId ? <Badge tone="success">resolved</Badge> : <Badge tone="warning">dangling</Badge>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>

        <Card title={`Revisions (${revisions.length})`} footer="Every save, agent draft, approved proposal and restore adds a revision. Restoring an older version writes it as a NEW version; history is never rewritten.">
          <Table head={["Version", "Changed by", "Note", "Date", "Run", "Actions"]} empty={revisions.length === 0 ? <Empty>No revisions recorded.</Empty> : null}>
            {revisions.map((r) => {
              const isCurrent = r.version === doc.version;
              return (
                <Tr key={r.id}>
                  <Td className="font-medium">v{r.version} {isCurrent ? <Badge tone="cyan">current</Badge> : null}</Td>
                  <Td className="text-xs text-muted">{r.changedByActorType}: {r.changedByActorId}</Td>
                  <Td className="text-xs text-muted">{r.changeNote ?? ""}</Td>
                  <Td className="text-muted">{fmtDate(r.createdAt)}</Td>
                  <Td className="text-xs text-muted">{r.runId ? <Link href={`/c/${slug}/agents`} className="underline"><ShortId id={r.runId} /></Link> : ""}</Td>
                  <Td>
                    {isCurrent ? (
                      <span className="text-xs text-faint">live version</span>
                    ) : (
                      <div className="flex flex-wrap items-center gap-1">
                        <Link href={`${here}?compare=${r.version}`} className={smallButtonClass}>Compare with current</Link>
                        {mayEdit ? (
                          <form action={revertDocumentAction} className="inline-flex items-center gap-1">
                            <input type="hidden" name="slug" value={slug} />
                            <input type="hidden" name="path" value={doc.path} />
                            <input type="hidden" name="documentId" value={doc.id} />
                            <input type="hidden" name="toVersion" value={r.version} />
                            <input type="hidden" name="returnTo" value={here} />
                            <ConfirmButton message={`Restore version ${r.version}? It becomes new version ${doc.version + 1}; the current content stays in history.`} className={smallDangerClass}>Restore this version</ConfirmButton>
                          </form>
                        ) : null}
                      </div>
                    )}
                  </Td>
                </Tr>
              );
            })}
          </Table>
        </Card>
      </div>
    </Shell>
  );
}

function DocumentForm({ slug, path, mode, title, frontmatter, body, classification, canRestrict = false }: { slug: string; path: string; mode: "create" | "edit"; title: string; frontmatter: Record<string, unknown>; body: string; classification: string; canRestrict?: boolean }) {
  return (
    <form action={saveDocumentAction} className="space-y-3">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="path" value={path} />
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="returnTo" value={docHref(slug, path)} />
      <div className="grid gap-3 md:grid-cols-[1fr_200px]">
        <label className="block text-xs text-muted">Title<input name="title" defaultValue={title} required maxLength={200} className={`${inputClass} mt-1`} /></label>
        <label className="block text-xs text-muted">Classification
          <select name="classification" defaultValue={classification} className={`${selectClass} mt-1 w-full`}>
            <option value="public">public</option>
            <option value="internal">internal</option>
            <option value="confidential">confidential</option>
            {canRestrict || classification === "restricted" ? <option value="restricted">restricted (client admin only)</option> : null}
          </select>
        </label>
      </div>
      <label className="block text-xs text-muted">Frontmatter (one <span className="font-mono">key: value</span> per line, or a JSON object)
        <textarea name="frontmatter" rows={4} defaultValue={frontmatterToLines(frontmatter)} className={`${inputClass} mt-1 font-mono`} placeholder={"tags: [\"finance\", \"process\"]\nowner: finance manager"} />
      </label>
      <label className="block text-xs text-muted">Body (Markdown; [[wikilinks]] to other vault paths are indexed)
        <textarea name="body" rows={18} defaultValue={body} className={`${inputClass} mt-1 font-mono`} />
      </label>
      <label className="block text-xs text-muted">Change note<input name="changeNote" maxLength={500} className={`${inputClass} mt-1`} placeholder={mode === "create" ? "created in the vault browser" : "what changed and why"} /></label>
      <div className="flex items-center gap-2">
        <button type="submit" className={smallPrimaryClass}>{mode === "create" ? "Create document" : "Save new version"}</button>
        <span className="text-xs text-faint">Writes through writeVaultDocument and syncDocumentLinks; audited as the signed-in user.</span>
      </div>
    </form>
  );
}
