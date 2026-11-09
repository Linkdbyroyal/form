import Link from "next/link";
import { notFound } from "next/navigation";
import { clientNav, Shell } from "@/components/shell";
import { Badge, Card, Empty, Stat, Status, inputClass } from "@/components/ui";
import { Notice, PageHeader, StateBadge, Table, Td, Tr, smallButtonClass } from "@/components/agent-ui";
import { VaultNav, VerificationBadge } from "@/components/vault-ui";
import { getTenantHeader } from "@/lib/client/queries";
import { getVaultBrowser, getVaultCounters } from "@/lib/client/vault-queries";
import { canEditDocuments, canManageVaultSettings, FOLDER_RE, VAULT_FOLDERS } from "@/lib/client/vault-helpers";
import { firstParam, fmtDate } from "@/lib/format";
import { requireTenantContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

function docHref(slug: string, path: string): string {
  return `/c/${slug}/vault/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export default async function VaultBrowserPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await requireTenantContext(slug);
  if (!access) notFound();
  const folderParam = firstParam(sp.folder);
  const folder = folderParam && FOLDER_RE.test(folderParam) ? folderParam : null;
  const query = (firstParam(sp.q) ?? "").trim().slice(0, 200) || null;
  const [tenant, browser, counters] = await Promise.all([getTenantHeader(access.ctx), getVaultBrowser(access.ctx, { folder, query }), getVaultCounters(access.ctx)]);
  if (!tenant) notFound();
  const roles = access.ctx.roles;
  const base = `/c/${slug}/vault`;
  return (
    <Shell title={tenant.name} subtitle="Client workspace" nav={clientNav(slug)}>
      <div className="space-y-6">
        <PageHeader title="Knowledge Vault">
          Your organisation's Markdown documents with frontmatter, revisions, links and facts. Documents are grouped in the 20 standard folders; every search is logged in the retrieval audit, and <em>restricted</em> documents are hidden by the database for roles below client admin. <Status state="implemented" />
        </PageHeader>
        <VaultNav slug={slug} active="browse" showSettings={canManageVaultSettings(roles)} />
        <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />
        <div className="grid gap-4 md:grid-cols-4">
          <Stat label="Documents" value={browser.totalDocuments} hint="visible to your role" />
          <Stat label="Facts" value={counters.facts} hint="atomic statements with sources" />
          <Stat label="Open verification requests" value={counters.openRequests} hint="contradictions waiting for a reviewer" />
          <Stat label="Pending proposals" value={counters.pendingProposals} hint="agent changes waiting for approval" />
        </div>

        <Card title="Export and import (Obsidian-compatible)" footer="Export writes a zip of Markdown files with YAML frontmatter and [[wikilinks]] in the 20 standard folders; it opens directly as an Obsidian vault. Import creates new revisions for every Markdown file whose path follows the taxonomy; other files are reported and skipped. Platform fields (sbos_*) are ignored on import.">
          <div className="flex flex-wrap items-center gap-3">
            {!access.viaGrant ? <a href={`${base}/export`} className={smallButtonClass}>Download vault as zip</a> : <span className="text-xs text-muted">Export is not available under a break-glass grant.</span>}
            {canEditDocuments(roles) && !access.viaGrant ? (
              <form method="post" action={`${base}/import`} encType="multipart/form-data" className="flex flex-wrap items-center gap-2">
                <input type="file" name="archive" accept=".zip,application/zip" required className="text-xs" />
                <button type="submit" className={smallButtonClass}>Import zip</button>
              </form>
            ) : null}
          </div>
        </Card>

        <Card title="Search">
          <form method="get" action={base} className="flex flex-wrap items-center gap-2">
            {folder ? <input type="hidden" name="folder" value={folder} /> : null}
            <input name="q" defaultValue={query ?? ""} maxLength={200} placeholder="Search documents and facts (full-text, websearch syntax)" className={`${inputClass} max-w-xl`} />
            <button type="submit" className={smallButtonClass}>Search</button>
            {query ? <Link href={folder ? `${base}?folder=${folder}` : base} className="text-xs underline">clear</Link> : null}
          </form>
          {browser.hits ? (
            <div className="mt-4">
              <div className="mb-2 text-xs text-muted">{browser.hits.length} hit{browser.hits.length === 1 ? "" : "s"} for "{query}" (logged in retrieval_audit as kind fts)</div>
              {browser.hits.length === 0 ? (
                <Empty>No documents or facts match. Deprecated facts and restricted documents outside your role never appear here.</Empty>
              ) : (
                <ul className="divide-y divide-border">
                  {browser.hits.map((h) => (
                    <li key={`${h.kind}-${h.id}`} className="py-2 text-sm">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <Badge tone={h.kind === "document" ? "cyan" : "indigo"}>{h.kind}</Badge>
                        <VerificationBadge value={h.verification} />
                        <StateBadge kind="classification" value={h.classification} />
                        <span className="text-faint">rank {h.rank.toFixed(3)}</span>
                      </div>
                      {h.kind === "document" && h.path ? (
                        <Link href={docHref(slug, h.path)} className="mt-1 block font-medium underline">{h.title}</Link>
                      ) : (
                        <Link href={`/c/${slug}/vault/facts`} className="mt-1 block font-medium">{h.title}</Link>
                      )}
                      {h.kind === "document" ? <div className="text-xs text-faint">{h.path}</div> : null}
                      {/* ts_headline wraps matches in <b> tags; we show the snippet as plain text to avoid injecting HTML. */}
                      <p className="mt-1 text-xs text-muted">{h.snippet.replaceAll("<b>", "").replaceAll("</b>", "")}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </Card>

        <div className="grid gap-4 md:grid-cols-[280px_1fr]">
          <Card title="Folders" footer={`${VAULT_FOLDERS.length} standard folders. Empty folders are shown so the taxonomy is visible before documents exist.`}>
            <ul className="space-y-0.5 text-sm">
              {browser.folders.map((f) => {
                const active = f.folder === folder;
                return (
                  <li key={f.folder}>
                    <Link href={`${base}?folder=${f.folder}`} className={`flex items-center justify-between rounded-md px-2 py-1 ${active ? "bg-surface-2 text-cyan" : f.count === 0 ? "text-faint hover:text-muted" : "text-muted hover:bg-surface-2 hover:text-fg"}`} title={f.folder}>
                      <span className="truncate"><span className="font-mono text-[11px] text-faint">{f.folder.slice(0, 2)}</span> {f.label}{f.standard ? "" : " (non-standard)"}</span>
                      <span className="ml-2 shrink-0 text-xs">{f.count}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Card>

          <Card title={folder ? `Documents in ${folder}` : "Documents"} footer={canEditDocuments(roles) && !access.viaGrant ? "New documents are created from the document page: open any path under a folder, for example 00_company_profile/profile.md, and use the create form." : "Editing requires client_admin or department_manager."}>
            {!folder ? (
              <Empty>Select a folder on the left to list its documents, or search above.</Empty>
            ) : (
              <>
                <Table head={["Title", "Path", "Classification", "Verification", "Version", "Updated"]} empty={browser.documents.length === 0 ? <Empty>No documents in this folder yet.{canEditDocuments(roles) && !access.viaGrant ? <> Create one at <Link href={docHref(slug, `${folder}/new-document.md`)} className="underline">{folder}/new-document.md</Link>.</> : null}</Empty> : null}>
                  {browser.documents.map((d) => (
                    <Tr key={d.id}>
                      <Td className="font-medium"><Link href={docHref(slug, d.path)} className="underline">{d.title}</Link></Td>
                      <Td className="font-mono text-xs text-muted">{d.path}</Td>
                      <Td><StateBadge kind="classification" value={d.classification} /></Td>
                      <Td><VerificationBadge value={d.verification} /></Td>
                      <Td className="text-muted">v{d.version}</Td>
                      <Td className="text-muted">{fmtDate(d.updatedAt)}</Td>
                    </Tr>
                  ))}
                </Table>
              </>
            )}
          </Card>
        </div>

        <Card title="Implementation status">
          <ul className="space-y-1 text-sm">
            <li><Status state="implemented" /> Folder tree with counts, document list, full-text search over documents and facts with retrieval audit (M2-06, M2-07)</li>
            <li><Status state="implemented" /> Document page: frontmatter, rendered Markdown, backlinks, revisions, compare and restore, edit (M2-06)</li>
            <li><Status state="implemented" /> Restricted documents hidden by Row-Level Security for roles below client admin</li>
            <li><Status state="implemented" /> Obsidian-compatible export (zip of Markdown with frontmatter and wikilinks) and import for admins and managers, see the form above</li>
            <li><Status state="planned" /> Semantic search with embeddings (M3), graph view</li>
          </ul>
        </Card>
      </div>
    </Shell>
  );
}
