import Link from "next/link";
import { notFound } from "next/navigation";
import { clientNav, Shell } from "@/components/shell";
import { Badge, Card, Empty, Stat, Status, buttonSecondaryClass } from "@/components/ui";
import { PageHeader, StateBadge } from "@/components/agent-ui";
import { getTenantHeader, listInboxRounds } from "@/lib/client/queries";
import { fmtDate } from "@/lib/format";
import { requireTenantContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

export default async function InterviewInboxPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await requireTenantContext(slug);
  if (!access) notFound();
  const [tenant, inbox] = await Promise.all([getTenantHeader(access.ctx), listInboxRounds(access.ctx)]);
  if (!tenant) notFound();
  const total = inbox.rounds.reduce((a, r) => a + r.questions.length, 0);
  return (
    <Shell title={tenant.name} subtitle="Client workspace" nav={clientNav(slug)}>
      <div className="space-y-6">
        <PageHeader title="Interview Inbox">
          Questions the Discovery agent asks your organisation, grouped by round. Open questions were published after an approval; drafts are still waiting for one. Reading is implemented; answering lands in Milestone 2. <Status state="implemented" />
        </PageHeader>
        <div className="grid gap-4 md:grid-cols-3">
          <Stat label="Open questions" value={inbox.counts.open} hint="published to your team" />
          <Stat label="Drafts" value={inbox.counts.draft} hint="awaiting publication approval" />
          <Stat label="Answered" value={inbox.counts.answered} hint="answer flow lands in M2" />
        </div>

        {total === 0 ? (
          <Card title="Rounds"><Empty>No open or draft questions. A Discovery run drafts 3 to 5 questions; after the client admin approves publication they appear here as open. See <Link href={`/c/${slug}/approvals`} className="underline">Approvals</Link>.</Empty></Card>
        ) : (
          inbox.rounds.map((r) => (
            <Card
              key={r.round?.id ?? "no-round"}
              title={r.round ? `Round ${r.round.roundNumber}${r.round.department ? ` · ${r.round.department}` : ""} · ${fmtDate(r.round.createdAt)}` : "Questions without a round"}
              footer={r.round ? `Round rationale: ${r.round.rationale}` : undefined}
            >
              <ul className="divide-y divide-border">
                {r.questions.map((q) => (
                  <li key={q.id} className="py-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <StateBadge kind="question" value={q.state} />
                      <Badge tone={q.priority === "critical" ? "danger" : q.priority === "high" ? "warning" : "neutral"}>{q.priority}</Badge>
                      <Badge>{q.department}</Badge>
                      <span className="text-muted">to {q.recipientRole}</span>
                      <span className="text-faint">answer type: {q.answerType}{q.options.length ? ` (${q.options.join(" / ")})` : ""} · confidence {q.confidence.toFixed(2)}</span>
                    </div>
                    <p className="mt-2 text-sm font-medium">{q.questionText}</p>
                    <dl className="mt-1 grid gap-1 text-xs text-muted md:grid-cols-2">
                      <div><dt className="inline text-faint">Why we ask: </dt><dd className="inline">{q.reason}</dd></div>
                      <div><dt className="inline text-faint">Evidence gap: </dt><dd className="inline">{q.evidenceGap}</dd></div>
                    </dl>
                    <div className="mt-2 flex items-center gap-2">
                      <button type="button" className={buttonSecondaryClass} disabled>Answer</button>
                      <Status state="planned" />
                      <span className="text-xs text-faint">Answering, skipping and delegation to a department head are Milestone 2 (M2).</span>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ))
        )}

        <Card title="Implementation status">
          <ul className="space-y-1 text-sm">
            <li><Status state="implemented" /> Question drafting by the Discovery agent, publication gate through an approval, inbox read in tenant context</li>
            <li><Status state="planned" /> Answer, skip and delegate; answers feed the Knowledge Vault and the next round (M2)</li>
          </ul>
        </Card>
      </div>
    </Shell>
  );
}
