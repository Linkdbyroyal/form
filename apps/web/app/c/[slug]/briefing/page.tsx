import Link from "next/link";
import { notFound } from "next/navigation";
import { clientNav, Shell } from "@/components/shell";
import { Badge, Card, Empty, Status } from "@/components/ui";
import { PageHeader, ShortId, Table, Td, Tr } from "@/components/agent-ui";
import { BRIEFING_SECTIONS } from "@/components/xray-ui";
import { getTenantHeader } from "@/lib/client/queries";
import { getBriefingPage, type BriefingPage } from "@/lib/client/xray-queries";
import { firstParam, fmtDate } from "@/lib/format";
import { requireTenantContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refHref(slug: string, kind: "finding" | "opportunity" | "task", id: string): string {
  if (kind === "task") return `/c/${slug}/actions#task-${id}`;
  if (kind === "opportunity") return `/c/${slug}/actions#opportunity-${id}`;
  return `/c/${slug}/x-ray#finding-${id}`;
}

function SourceLinks({ ids, refs, slug }: { ids: string[]; refs: BriefingPage["refs"]; slug: string }) {
  if (ids.length === 0) return <span className="text-[11px] text-warning">no source ids</span>;
  return (
    <span className="flex flex-wrap gap-1 text-[11px]">
      {ids.map((id) => {
        const r = refs[id];
        return r ? (
          <Link key={id} href={refHref(slug, r.kind, id)} className="underline" title={id}>{r.kind}: {r.title}</Link>
        ) : (
          <span key={id} className="text-faint" title={id}>source <ShortId id={id} /></span>
        );
      })}
    </span>
  );
}

export default async function BriefingPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await requireTenantContext(slug);
  if (!access) notFound();
  const requested = firstParam(sp.id);
  const briefingId = requested && UUID_RE.test(requested) ? requested : null;
  const [tenant, page] = await Promise.all([getTenantHeader(access.ctx), getBriefingPage(access.ctx, briefingId)]);
  if (!tenant) notFound();
  const b = page.latest;
  return (
    <Shell title={tenant.name} subtitle="Client workspace" nav={clientNav(slug)}>
      <div className="space-y-6">
        <PageHeader title="Executive Briefing" crumbs={[{ href: `/c/${slug}/dashboard`, label: "CEO Dashboard" }, { label: "Briefing" }]}>
          The daily briefing written by the Executive Briefing agent: eight fixed sections and one to seven priorities, every item with its source ids and confidence. Items that reference a finding, opportunity or task link to it. <Status state="implemented" />
        </PageHeader>

        {page.invalidLatest ? (
          <div role="alert" className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">The briefing of {page.invalidLatest.briefingDate} does not satisfy the ExecutiveBriefing contract and is not rendered.</div>
        ) : null}

        {!b && !page.invalidLatest ? (
          <Empty>No briefing stored yet. The Executive Briefing agent writes one per day once its schedule is enabled (weekdays 06:30 UTC), or when a run is started from Mission Control.</Empty>
        ) : null}

        {b ? (
          <>
            <Card title={`Briefing for ${b.briefingDate}`}>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge tone={b.simulated ? "warning" : "success"}>{b.simulated ? "simulated" : "live"}</Badge>
                <Badge>{b.content.review_status}</Badge>
                <Badge>confidence {b.content.confidence.toFixed(2)}</Badge>
                <span className="text-faint">generated {fmtDate(b.content.generated_at)} by {b.content.permissions_context.actor_id} {b.content.run_id ? <> · run <ShortId id={b.content.run_id} /></> : null}</span>
              </div>
              <div className="mt-4">
                <div className="text-xs uppercase tracking-wide text-faint">Top priorities ({b.content.top_priorities.length})</div>
                <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm">{b.content.top_priorities.map((p, i) => <li key={i}>{p}</li>)}</ol>
              </div>
            </Card>
            <div className="grid gap-4 md:grid-cols-2">
              {BRIEFING_SECTIONS.map((s) => {
                const items = b.content.sections[s.key];
                return (
                  <Card key={s.key} title={`${s.label} (${items.length})`}>
                    {items.length === 0 ? (
                      <div className="text-sm text-faint">Nothing recorded in this section.</div>
                    ) : (
                      <ul className="space-y-3 text-sm">
                        {items.map((it, i) => (
                          <li key={i}>
                            <div>{it.text}</div>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-faint">
                              <span>confidence {it.confidence.toFixed(2)}</span>
                              <SourceLinks ids={it.source_ids} refs={page.refs} slug={slug} />
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                );
              })}
            </div>
          </>
        ) : null}

        <Card title={`Earlier briefings (${page.earlier.length})`} footer="One briefing per calendar date and audience; re-running the agent on the same day replaces that day's briefing.">
          <Table head={["Date", "Mode", "Priorities", "Stored", ""]} empty={page.earlier.length === 0 ? <Empty>No earlier briefings.</Empty> : null}>
            {page.earlier.map((e) => (
              <Tr key={e.id}>
                <Td className="font-medium">{e.briefingDate}</Td>
                <Td><Badge tone={e.simulated ? "warning" : "success"}>{e.simulated ? "simulated" : "live"}</Badge></Td>
                <Td className="text-muted">{e.priorities}</Td>
                <Td className="text-muted">{fmtDate(e.createdAt)}</Td>
                <Td><Link href={`/c/${slug}/briefing?id=${e.id}`} className="text-xs underline">open</Link></Td>
              </Tr>
            ))}
          </Table>
        </Card>
      </div>
    </Shell>
  );
}
