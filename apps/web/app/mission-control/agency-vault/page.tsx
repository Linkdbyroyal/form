import Link from "next/link";
import { Badge, Card, Empty, Stat, Status, inputClass } from "@/components/ui";
import { Notice, PageHeader, Table, Td, Tr, smallButtonClass, smallPrimaryClass } from "@/components/agent-ui";
import { AGENCY_VAULT_BASE, AgencyVaultNav, AgencyVaultStatusCard, KnowledgeStateBadge, OriginBadge } from "@/components/agency-vault-ui";
import { firstParam, fmtDate } from "@/lib/format";
import { AGENCY_MODULES, KNOWLEDGE_STATES, buildAgencyFolderTree, moduleForFolder, recordHref, sanitizeSnippet, shortActor } from "@/lib/mission-control/agency-vault-helpers";
import { getAgencyVaultSummary, listKnowledgeRecords, listSkillsRegistry } from "@/lib/mission-control/agency-vault-queries";
import { requireAgencyContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

function libraryHref(params: { folder?: string | null; state?: string | null; q?: string | null; view?: string | null }): string {
  const sp = new URLSearchParams();
  if (params.folder) sp.set("folder", params.folder);
  if (params.state) sp.set("state", params.state);
  if (params.q) sp.set("q", params.q);
  if (params.view) sp.set("view", params.view);
  const qs = sp.toString();
  return qs ? `${AGENCY_VAULT_BASE}?${qs}` : AGENCY_VAULT_BASE;
}

export default async function KnowledgeLibraryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAgencyContext();
  const sp = await searchParams;
  const folder = firstParam(sp.folder);
  const state = firstParam(sp.state);
  const q = firstParam(sp.q);
  const view = firstParam(sp.view);
  const [summary, library, skillsView] = await Promise.all([getAgencyVaultSummary(ctx), listKnowledgeRecords(ctx, { folder, state, q }), view === "skills" ? listSkillsRegistry(ctx) : Promise.resolve(null)]);
  const tree = buildAgencyFolderTree(library.folderCounts);
  const activeModule = moduleForFolder(folder);
  const published = summary.recordsByState.find((s) => s.state === "published")?.n ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader title="Agency Intelligence Vault" crumbs={[{ href: "/mission-control", label: "Mission Control" }, { label: "Agency Intelligence Vault" }]}>
        Second Brain&apos;s own methods, patterns, interview sets, blueprints and approved reusable insights. Only agency knowledge lives here: client content enters through a reviewed promotion request, never automatically. <Status state="implemented" />
      </PageHeader>
      <AgencyVaultNav active="library" pendingReviews={summary.canSeePromotions ? summary.pendingReviews : 0} />
      <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />

      <div className="grid gap-4 md:grid-cols-4">
        <Stat label="Records" value={summary.records} hint={`${published} published`} />
        <Stat label="Pending reviews" value={summary.canSeePromotions ? summary.pendingReviews : "n/a"} hint={summary.canSeePromotions ? `${summary.approvedAwaitingPublication} approved, awaiting publication` : "visible to agency_reviewer and superadmin"} />
        <Stat label="Templates" value={summary.templates} hint="active methodology templates" />
        <Stat label="Active adoptions" value={summary.activeAdoptions} hint="pinned versions across tenants" />
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <Link href={libraryHref({ state, q })} className={`rounded-full border px-3 py-1 ${!folder && view !== "skills" ? "border-cyan/60 text-cyan" : "border-border text-muted hover:text-fg"}`}>All folders</Link>
        {AGENCY_MODULES.map((m) => (
          <Link key={m.key} href={libraryHref({ folder: m.folder, state, q })} className={`rounded-full border px-3 py-1 ${folder === m.folder ? "border-cyan/60 text-cyan" : "border-border text-muted hover:text-fg"}`}>
            {m.label} <span className="text-faint">({library.folderCounts.get(m.folder) ?? 0})</span>
          </Link>
        ))}
        <Link href={libraryHref({ view: "skills" })} className={`rounded-full border px-3 py-1 ${view === "skills" ? "border-cyan/60 text-cyan" : "border-border text-muted hover:text-fg"}`}>Skills Registry</Link>
      </div>

      {view === "skills" && skillsView ? (
        <Card title="Skills Registry (read-only)" footer={`skills, skill_versions and skill_release_channels are catalogue tables readable in agency scope. ${skillsView.pinsAvailable ? "Pin counts come from agent_instances through the operator role: counts only, no tenant content." : "Pin counts per tenant need an operator role (superadmin or agency_operator); they are not shown for your roles."} Skill editing and release management are the Agent Skills & Versions module (not built).`}>
          <Table head={["Skill", "Version", "Channel", "Release channels", "Checksum", "Created", "Pinned by"]} empty={skillsView.rows.length === 0 ? <Empty>No skills seeded.</Empty> : null}>
            {skillsView.rows.flatMap((s) =>
              s.versions.map((v, i) => (
                <Tr key={v.id}>
                  <Td className="font-medium">{i === 0 ? <>{s.name}<div className="font-mono text-[11px] text-faint">{s.key} · {s.status}</div></> : null}</Td>
                  <Td className="font-mono text-xs">{v.version}</Td>
                  <Td><Badge tone={v.releaseChannel === "stable" ? "success" : v.releaseChannel === "deprecated" ? "danger" : "neutral"}>{v.releaseChannel}</Badge></Td>
                  <Td className="text-xs text-muted">{v.channels.length > 0 ? v.channels.join(", ") : "none"}</Td>
                  <Td className="font-mono text-[11px] text-faint">{v.checksum.slice(0, 12)}</Td>
                  <Td className="text-muted">{fmtDate(v.createdAt)}</Td>
                  <Td className="text-xs text-muted">{skillsView.pinsAvailable ? `${v.pinnedInstances} instance(s) in ${v.pinnedTenants} tenant(s)` : <span className="text-faint">operator role required</span>}</Td>
                </Tr>
              ))
            )}
          </Table>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-[260px_1fr]">
          <Card title="Folders (18)" footer="The agency vault taxonomy (spec 4H). Empty folders are listed so the structure is visible.">
            <ul className="space-y-0.5 text-sm">
              {tree.map((n) => (
                <li key={n.folder}>
                  <Link href={libraryHref({ folder: n.folder, state, q })} className={`flex items-center justify-between rounded px-2 py-1 ${folder === n.folder ? "bg-surface-2 text-cyan" : "text-muted hover:bg-surface-2 hover:text-fg"}`}>
                    <span className="truncate"><span className="font-mono text-[11px] text-faint">{n.folder.slice(0, 2)}</span> {n.label}</span>
                    <span className="text-xs text-faint">{n.count}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>

          <div className="space-y-4">
            <Card title={activeModule ? activeModule.label : folder ? `Folder ${folder}` : "All records"} footer={library.searched ? "Full-text search over the current version of agency records (title and body, websearch syntax). Every search is logged in audit_events as agency_knowledge.search. Semantic search is deferred to M5 (ADR-019)." : "Records across the agency vault. State filters mirror the lifecycle enforced by the database trigger."}>
              <form method="get" action={AGENCY_VAULT_BASE} className="mb-3 flex flex-wrap items-center gap-2">
                {folder ? <input type="hidden" name="folder" value={folder} /> : null}
                {state ? <input type="hidden" name="state" value={state} /> : null}
                <input name="q" defaultValue={q ?? ""} placeholder="Search agency knowledge (for example: closure invoice)" maxLength={200} className={`${inputClass} max-w-md`} />
                <button type="submit" className={smallPrimaryClass}>Search</button>
                {q ? <Link href={libraryHref({ folder, state })} className={smallButtonClass}>Clear</Link> : null}
              </form>
              <div className="mb-3 flex flex-wrap gap-2 text-xs">
                <Link href={libraryHref({ folder, q })} className={`rounded-full border px-3 py-1 ${!state ? "border-cyan/60 text-cyan" : "border-border text-muted hover:text-fg"}`}>any state</Link>
                {KNOWLEDGE_STATES.map((s) => (
                  <Link key={s} href={libraryHref({ folder, q, state: s })} className={`rounded-full border px-3 py-1 ${state === s ? "border-cyan/60 text-cyan" : "border-border text-muted hover:text-fg"}`}>
                    {s.replaceAll("_", " ")} <span className="text-faint">({library.stateCounts.get(s) ?? 0})</span>
                  </Link>
                ))}
              </div>
              <Table head={["Title", "Path", "Kind", "State", "Origin", "Version", "Owner", "Updated"]} empty={library.rows.length === 0 ? <Empty>{library.searched ? "No agency record matches this query. Client documents are never searched here." : folder ? <>No records in this folder yet. <Link href={`${AGENCY_VAULT_BASE}/new?folder=${folder}`} className="underline">Create one</Link>.</> : "No records yet."}</Empty> : null}>
                {library.rows.map((r) => (
                  <Tr key={r.id}>
                    <Td className="max-w-sm">
                      <Link href={recordHref(r.id)} className="font-medium underline">{r.title}</Link>
                      {r.snippet ? <div className="mt-1 text-xs text-muted" dangerouslySetInnerHTML={{ __html: sanitizeSnippet(r.snippet) }} /> : null}
                    </Td>
                    <Td className="font-mono text-[11px] text-faint">{r.path}</Td>
                    <Td className="text-xs text-muted">{r.kind.replaceAll("_", " ")}</Td>
                    <Td><KnowledgeStateBadge value={r.state} /></Td>
                    <Td><OriginBadge value={r.origin} /></Td>
                    <Td className="text-xs">{r.currentVersion ? `v${r.currentVersion}` : <span className="text-faint">none</span>}</Td>
                    <Td className="font-mono text-[11px] text-muted">{shortActor(r.ownerActorId)}</Td>
                    <Td className="text-muted">{fmtDate(r.updatedAt)}</Td>
                  </Tr>
                ))}
              </Table>
            </Card>
            {activeModule ? (
              <Card title={`About ${activeModule.label}`}>
                <p className="text-sm text-muted">
                  {activeModule.key === "interviews" ? "Question sets the Discovery agent may draw from. A published interview set is agency knowledge; the answers a client gives stay in that client's vault." : null}
                  {activeModule.key === "blueprints" ? "Industry blueprints: generic process and KPI patterns per sector. Blueprints abstracted from a client arrive only through an approved promotion request." : null}
                  {activeModule.key === "design" ? "Dashboard, KPI and design-system definitions used by the CEO dashboard renderer. The widget whitelist itself lives in the contracts package." : null}
                  {activeModule.key === "techwatch" ? "Research updates and release reviews (for example the GitHub assessment). Drafts here are research notes, not decisions; decisions are recorded in docs/DECISIONS.md and folder 14." : null}
                </p>
                {activeModule.key === "techwatch" ? (
                  <div className="mt-3 rounded-card border border-cyan/40 bg-surface-2 p-3 text-sm">
                    <div className="font-medium">Technology Intelligence Center (spec 4D, M6)</div>
                    <p className="mt-1 text-xs text-muted">Approved sources, scheduled detection by the worker and the Upgrade Center (assess, approve with the artefact of the kind, apply with a test result, roll back) live on their own page. A knowledge update references a published record from this folder.</p>
                    <Link href="/mission-control/tech-watch" className={`${smallPrimaryClass} mt-2`}>Open Tech Watch</Link>
                  </div>
                ) : null}
              </Card>
            ) : null}
          </div>
        </div>
      )}

      <AgencyVaultStatusCard />
    </div>
  );
}
