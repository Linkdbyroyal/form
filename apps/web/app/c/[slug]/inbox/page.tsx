import Link from "next/link";
import { notFound } from "next/navigation";
import { clientNav, Shell } from "@/components/shell";
import { Badge, Card, Empty, Stat, Status, inputClass } from "@/components/ui";
import { Notice, PageHeader, StateBadge, smallPrimaryClass } from "@/components/agent-ui";
import { AnswerInput, VerificationBadge } from "@/components/vault-ui";
import { getTenantHeader } from "@/lib/client/queries";
import { listInboxView } from "@/lib/client/vault-queries";
import { answerQuestionAction } from "@/lib/client/vault-actions";
import { canAnswerQuestion, clientRole } from "@/lib/client/vault-helpers";
import { firstParam, fmtDate } from "@/lib/format";
import { requireTenantContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

export default async function InterviewInboxPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await requireTenantContext(slug);
  if (!access) notFound();
  const [tenant, inbox] = await Promise.all([getTenantHeader(access.ctx), listInboxView(access.ctx)]);
  if (!tenant) notFound();
  const roles = access.ctx.roles;
  const myRole = clientRole(roles);
  const readOnly = access.viaGrant || myRole === null;
  const total = inbox.rounds.reduce((a, r) => a + r.questions.length, 0);
  const returnTo = `/c/${slug}/inbox`;
  return (
    <Shell title={tenant.name} subtitle="Client workspace" nav={clientNav(slug)}>
      <div className="space-y-6">
        <PageHeader title="Interview Inbox">
          Questions the Discovery agent asks your organisation, grouped by round. Open questions were published after an approval. Your answer is stored with your role and timestamp and becomes an <em>unconfirmed</em> fact with an interview source in the Knowledge Vault; it is not treated as truth until evidence or a reviewer confirms it. <Status state="implemented" />
        </PageHeader>
        <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />
        <div className="grid gap-4 md:grid-cols-3">
          <Stat label="Open questions" value={inbox.counts.open} hint="published to your team" />
          <Stat label="Drafts" value={inbox.counts.draft} hint={inbox.draftsHidden ? "visible to the client admin only" : "awaiting publication approval"} />
          <Stat label="Answered" value={inbox.counts.answered} hint="each answer is a fact in the vault" />
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge tone="cyan">your roles: {roles.join(", ") || "none"}</Badge>
          {access.viaGrant ? <Badge tone="danger">break-glass grant: read-only, access is logged</Badge> : null}
          {myRole ? <Badge>answers are recorded as {myRole}</Badge> : null}
        </div>

        {total === 0 ? (
          <Card title="Rounds"><Empty>No questions yet. A Discovery run drafts 3 to 5 questions; after the client admin approves publication they appear here as open. See <Link href={`/c/${slug}/approvals`} className="underline">Approvals</Link>.</Empty></Card>
        ) : (
          inbox.rounds.map((r) => (
            <Card
              key={r.round?.id ?? "no-round"}
              title={r.round ? `Round ${r.round.roundNumber}${r.round.department ? ` · ${r.round.department}` : ""} · ${fmtDate(r.round.createdAt)}` : "Questions without a round"}
              footer={r.round ? `Round rationale: ${r.round.rationale}` : undefined}
            >
              <ul className="divide-y divide-border">
                {r.questions.map((q) => {
                  const mayAnswer = !readOnly && q.state === "open" && canAnswerQuestion(roles, q.recipientRole);
                  return (
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

                      {q.state === "answered" && q.answer ? (
                        <div className="mt-3 rounded-md border border-border bg-surface-2 p-3 text-sm">
                          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                            <span className="font-medium text-fg">Answer</span>
                            <span>by {q.answer.role}</span>
                            <span>at {fmtDate(q.answer.answeredAt)}</span>
                            <span className="text-faint">fact:</span> <VerificationBadge value={q.answer.factVerification ?? "unconfirmed"} />
                            {q.answer.factId ? <Link href={`/c/${slug}/vault/facts`} className="underline">view in facts</Link> : null}
                          </div>
                          <p className="mt-1 whitespace-pre-wrap">{q.answer.text}</p>
                          {q.answer.notes ? <p className="mt-1 text-xs text-muted">Notes: {q.answer.notes}</p> : null}
                        </div>
                      ) : q.state === "answered" ? (
                        <p className="mt-2 text-xs text-muted">Answered, but the answer row is not visible to your role.</p>
                      ) : null}

                      {q.state === "open" ? (
                        mayAnswer ? (
                          <form action={answerQuestionAction} className="mt-3 space-y-2 rounded-md border border-border p-3">
                            <input type="hidden" name="slug" value={slug} />
                            <input type="hidden" name="questionId" value={q.id} />
                            <input type="hidden" name="returnTo" value={returnTo} />
                            <label htmlFor={`value-${q.id}`} className="block text-xs text-muted">Your answer ({q.answerType.replaceAll("_", " ")})</label>
                            <AnswerInput id={`value-${q.id}`} answerType={q.answerType} options={q.options} />
                            <label className="block text-xs text-muted">Notes (optional)<input name="notes" maxLength={2000} className={`${inputClass} mt-1`} placeholder="Context, caveats, where this can be checked" /></label>
                            <div className="flex items-center gap-2">
                              <button type="submit" className={smallPrimaryClass}>Submit answer</button>
                              <span className="text-xs text-faint">Stored as {myRole}; becomes an unconfirmed fact with an interview source.</span>
                            </div>
                          </form>
                        ) : (
                          <p className="mt-2 text-xs text-muted">
                            {access.viaGrant ? "Break-glass access is read-only." : `Read-only: this question is addressed to ${q.recipientRole}. The client admin or a user with that role can answer it.`}
                          </p>
                        )
                      ) : null}
                      {q.state === "draft" ? <p className="mt-2 text-xs text-faint">Draft: visible to you as client admin; it becomes answerable after the publication approval.</p> : null}
                    </li>
                  );
                })}
              </ul>
            </Card>
          ))
        )}

        <Card title="Implementation status">
          <ul className="space-y-1 text-sm">
            <li><Status state="implemented" /> Question drafting by the Discovery agent, publication gate through an approval, inbox read in tenant context</li>
            <li><Status state="implemented" /> Answering per answer type (text, number, yes/no, choices, date); answer stored with role and timestamp; question marked answered; answer becomes an unconfirmed fact with an interview source (M2-03)</li>
            <li><Status state="planned" /> File attachments and live system references (M5); skipping and delegating a question to a department head</li>
          </ul>
        </Card>
      </div>
    </Shell>
  );
}
