import Link from "next/link";
import { notFound } from "next/navigation";
import { clientNav, Shell } from "@/components/shell";
import { ConfirmButton } from "@/components/confirm-button";
import { Badge, Card, Empty, Stat, Status, inputClass } from "@/components/ui";
import { Notice, PageHeader, ShortId, Table, Td, Tr, selectClass, smallButtonClass, smallDangerClass, smallPrimaryClass } from "@/components/agent-ui";
import { ActionTaskStateBadge, EstimateLabel, InterventionBadge, OpportunityStateBadge } from "@/components/xray-ui";
import { createActionTaskAction, decideOpportunityAction, setActionTaskStateAction } from "@/lib/client/action-actions";
import { getTenantHeader } from "@/lib/client/queries";
import { businessCaseView, priorityView } from "@/lib/client/xray-helpers";
import { getActionCenterPage } from "@/lib/client/xray-queries";
import { firstParam, fmtDate } from "@/lib/format";
import { getPrincipal, requireTenantContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

export default async function ActionCenterPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await requireTenantContext(slug);
  if (!access) notFound();
  const [tenant, page, principal] = await Promise.all([getTenantHeader(access.ctx), getActionCenterPage(access.ctx), getPrincipal()]);
  if (!tenant || !principal) notFound();
  const roles = access.ctx.roles;
  const isAdmin = !access.viaGrant && roles.includes("client_admin");
  const canWrite = !access.viaGrant;
  const me = principal.data.publicUserId;
  const returnTo = `/c/${slug}/actions`;
  const proposed = page.opportunities.filter((o) => o.state === "proposed");
  const approved = page.opportunities.filter((o) => o.state === "approved" || o.state === "in_progress");
  const others = page.opportunities.filter((o) => !proposed.includes(o) && !approved.includes(o));
  const openTasks = page.tasks.filter((t) => !["closed", "rejected"].includes(t.state));
  const isOwner = (t: (typeof page.tasks)[number]) => canWrite && (t.ownerUserId === me || (t.ownerUserId === null && t.ownerRole !== null && roles.includes(t.ownerRole)));

  return (
    <Shell title={tenant.name} subtitle="Client workspace" nav={clientNav(slug)}>
      <div className="space-y-6">
        <PageHeader title="Management Action Center">
          Issue to action to owner to approval to task to verification to closure. A proposed opportunity needs the CEO's approval before any task exists (the database refuses otherwise); an action task is assigned to an owner and verified later by the Performance agent on a schedule. <Status state="implemented" />
        </PageHeader>
        <Notice ok={firstParam(sp.ok)} error={firstParam(sp.error)} />
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge tone="cyan">your roles: {roles.join(", ") || "none"}</Badge>
          {access.viaGrant ? <Badge tone="danger">break-glass grant: read-only, access is logged</Badge> : null}
          {page.performanceAgent ? <Badge tone={page.performanceAgent.state === "blocked" || page.performanceAgent.state === "error" ? "warning" : "success"}>{page.performanceAgent.name}: {page.performanceAgent.state}</Badge> : <Badge tone="warning">no Performance agent instance: tasks get no verification schedule</Badge>}
        </div>
        <div className="grid gap-4 md:grid-cols-4">
          <Stat label="Proposed opportunities" value={proposed.length} hint="waiting for a decision" />
          <Stat label="Approved opportunities" value={approved.length} hint="tasks can be created" />
          <Stat label="Open tasks" value={openTasks.length} hint="assigned, in progress, verifying or escalated" />
          <Stat label="Closed tasks" value={page.tasks.filter((t) => t.state === "closed").length} hint="with a verification note" />
        </div>

        <Card title={`Proposed opportunities (${proposed.length})`} footer="Approve or Reject decides the approval request attached to the opportunity and then moves the opportunity. The approval trigger refuses a requester deciding their own request and a second decision; `enforce_opportunity_approval` refuses `approved` without an approved approval.">
          {proposed.length === 0 ? <Empty>No proposed opportunities. The Process Redesign agent proposes one after the department reviews.</Empty> : (
            <div className="space-y-3">
              {proposed.map((o) => (
                <OpportunityCard key={o.id} o={o}>
                  {isAdmin ? (
                    <form action={decideOpportunityAction} className="mt-3 flex flex-wrap items-end gap-2">
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="returnTo" value={returnTo} />
                      <input type="hidden" name="opportunityId" value={o.id} />
                      <label className="flex-1 text-xs text-faint">Decision note (optional)<input name="note" maxLength={1000} className={inputClass} placeholder="Why, and any conditions" /></label>
                      <ConfirmButton name="decision" value="approved" className={smallPrimaryClass} message={`Approve "${o.title}"? This unlocks task creation.`}>Approve</ConfirmButton>
                      <ConfirmButton name="decision" value="rejected" className={smallDangerClass} message={`Reject "${o.title}"? No task can be created from it afterwards.`}>Reject</ConfirmButton>
                    </form>
                  ) : (
                    <div className="mt-3 text-xs text-faint">Deciding requires the client_admin role.</div>
                  )}
                </OpportunityCard>
              ))}
            </div>
          )}
        </Card>

        <Card title={`Approved opportunities (${approved.length})`} footer="Creating a task reuses the opportunity's approval, assigns the owner, and schedules a verification run for the Performance agent after the chosen number of days.">
          {approved.length === 0 ? <Empty>No approved opportunity yet.</Empty> : (
            <div className="space-y-3">
              {approved.map((o) => (
                <OpportunityCard key={o.id} o={o}>
                  {isAdmin ? (
                    <details className="mt-3 rounded-md border border-border p-3">
                      <summary className="cursor-pointer text-sm font-medium">Create action task{o.taskCount > 0 ? ` (${o.taskCount} already)` : ""}</summary>
                      <form action={createActionTaskAction} className="mt-3 grid gap-3 md:grid-cols-2">
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="returnTo" value={returnTo} />
                        <input type="hidden" name="opportunityId" value={o.id} />
                        <label className="text-xs text-faint md:col-span-2">Title<input name="title" required maxLength={200} defaultValue={`Implement: ${o.title}`} className={inputClass} /></label>
                        <label className="text-xs text-faint md:col-span-2">Issue (the problem)<textarea name="issue" required maxLength={2000} rows={2} className={inputClass} defaultValue={o.findingTitles[0] ?? ""} /></label>
                        <label className="text-xs text-faint md:col-span-2">Proposed action<textarea name="proposedAction" required maxLength={4000} rows={3} className={inputClass} defaultValue={o.description} /></label>
                        <label className="text-xs text-faint">Owner role
                          <select name="ownerRole" required className={`${selectClass} w-full`} defaultValue="department_manager">
                            <option value="client_admin">client_admin</option>
                            <option value="department_manager">department_manager</option>
                            <option value="client_employee">client_employee</option>
                          </select>
                        </label>
                        <label className="text-xs text-faint">Owner (member)
                          <select name="ownerUserId" className={`${selectClass} w-full`} defaultValue="">
                            <option value="">unassigned (role only)</option>
                            {page.members.map((m) => <option key={`${m.userId}-${m.roleKey}`} value={m.userId}>{m.displayName} ({m.roleKey}{m.departmentKey ? `, ${m.departmentKey}` : ""})</option>)}
                          </select>
                        </label>
                        <label className="text-xs text-faint">Due date<input name="dueAt" type="date" className={inputClass} /></label>
                        <label className="text-xs text-faint">Verify after (days)<input name="verifyAfterDays" type="number" min={1} max={90} defaultValue={7} className={inputClass} /></label>
                        <div className="md:col-span-2"><button type="submit" className={smallPrimaryClass}>Create and assign task</button></div>
                      </form>
                    </details>
                  ) : (
                    <div className="mt-3 text-xs text-faint">Creating tasks requires the client_admin role.</div>
                  )}
                </OpportunityCard>
              ))}
            </div>
          )}
        </Card>

        {others.length > 0 ? (
          <Card title={`Other opportunities (${others.length})`}>
            <div className="space-y-3">{others.map((o) => <OpportunityCard key={o.id} o={o} />)}</div>
          </Card>
        ) : null}

        <Card title={`Action tasks (${page.tasks.length})`} footer="States: proposed, awaiting approval, approved, assigned, in progress, verifying, closed, escalated, rejected. The owner marks a task in progress; the client admin closes it (verification note required) or escalates. The verification schedule runs the Performance agent, which never assumes completion.">
          <Table head={["Task", "State", "Owner", "Due", "Verification", "Approval", "Actions"]} empty={page.tasks.length === 0 ? <Empty>No action tasks yet.</Empty> : null}>
            {page.tasks.map((t) => (
              <Tr key={t.id}>
                <Td className="max-w-md">
                  <div id={`task-${t.id}`} className="font-medium">{t.title}</div>
                  <div className="text-xs text-muted">Issue: {t.issue}</div>
                  <div className="text-xs text-muted">Action: {t.proposedAction}</div>
                  <div className="text-[11px] text-faint">{t.opportunityTitle ? <>from opportunity {t.opportunityTitle} · </> : null}created {fmtDate(t.createdAt)} · <ShortId id={t.id} /></div>
                </Td>
                <Td><ActionTaskStateBadge value={t.state} />{t.closedAt ? <div className="text-[11px] text-faint">closed {fmtDate(t.closedAt)}</div> : null}</Td>
                <Td className="text-xs">{t.ownerName ?? <span className="text-faint">unassigned</span>}<div className="text-faint">{t.ownerRole ?? ""}</div></Td>
                <Td className="text-xs text-muted">{t.dueAt ? fmtDate(t.dueAt) : "n/a"}</Td>
                <Td className="max-w-xs text-xs">
                  {t.schedule ? <div className="text-muted">{t.schedule.enabled ? "scheduled" : "schedule disabled"} · cron <code className="font-mono">{t.schedule.cron}</code>{t.schedule.nextRunAt ? ` · next ${fmtDate(t.schedule.nextRunAt)}` : ""}{t.schedule.lastRunAt ? ` · last ${fmtDate(t.schedule.lastRunAt)}` : ""}</div> : <div className="text-faint">no verification schedule</div>}
                  {t.verificationNote ? <div className="mt-1 rounded bg-surface-2 px-2 py-1 text-muted">{t.verificationNote}</div> : null}
                </Td>
                <Td className="text-xs">{t.approvalState ? <Badge tone={t.approvalState === "approved" ? "success" : "warning"}>{t.approvalState}</Badge> : <span className="text-faint">none</span>}</Td>
                <Td>
                  {canWrite && !["closed", "rejected"].includes(t.state) ? (
                    <div className="flex flex-col gap-2">
                      {isOwner(t) || isAdmin ? (
                        ["assigned", "approved", "verifying", "escalated"].includes(t.state) ? (
                          <form action={setActionTaskStateAction}>
                            <input type="hidden" name="slug" value={slug} />
                            <input type="hidden" name="returnTo" value={returnTo} />
                            <input type="hidden" name="taskId" value={t.id} />
                            <input type="hidden" name="state" value="in_progress" />
                            <button type="submit" className={smallButtonClass}>Mark in progress</button>
                          </form>
                        ) : null
                      ) : null}
                      {isAdmin ? (
                        <form action={setActionTaskStateAction} className="flex flex-col gap-1">
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="returnTo" value={returnTo} />
                          <input type="hidden" name="taskId" value={t.id} />
                          <input name="note" maxLength={2000} placeholder="Verification note (required to close)" className={`${inputClass} text-xs`} />
                          <div className="flex gap-1">
                            <ConfirmButton name="state" value="closed" className={smallPrimaryClass} message="Close this task? The note is stored as the verification evidence.">Close</ConfirmButton>
                            <ConfirmButton name="state" value="escalated" className={smallDangerClass} message="Escalate this task to the client admin?">Escalate</ConfirmButton>
                          </div>
                        </form>
                      ) : null}
                      {!isAdmin && !isOwner(t) ? <span className="text-[11px] text-faint">owner or client_admin only</span> : null}
                    </div>
                  ) : <span className="text-[11px] text-faint">{access.viaGrant ? "read-only" : "final"}</span>}
                </Td>
              </Tr>
            ))}
          </Table>
        </Card>

        <Card title="Implementation status">
          <ul className="space-y-1 text-sm">
            <li><Status state="implemented" /> Approve or reject proposed opportunities, create and assign tasks with a verification schedule, owner and admin state transitions (M3-08)</li>
            <li><Status state="implemented" /> Hard rules in the database: approval before task, no self-approval, no double decision, state trigger on tasks</li>
            <li><Status state="simulated" /> Verification runs use the simulated runtime on this tenant; the agent sets the task to verifying and asks the owner instead of assuming completion</li>
            <li><Status state="planned" /> Owner notifications by e-mail or Pumble when a task is assigned; task detail page with the verification run events (<Link href={`/c/${slug}/agents`} className="underline">Agent Center</Link> shows runs today)</li>
          </ul>
        </Card>
      </div>
    </Shell>
  );
}

function OpportunityCard({ o, children }: { o: Awaited<ReturnType<typeof getActionCenterPage>>["opportunities"][number]; children?: React.ReactNode }) {
  const bc = businessCaseView(o.businessCase);
  const p = priorityView(o.priorityScore);
  return (
    <div id={`opportunity-${o.id}`} className="rounded-md border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-medium">{o.title}</div>
        <div className="flex flex-wrap items-center gap-2">
          <InterventionBadge value={o.intervention} />
          <OpportunityStateBadge value={o.state} />
          {o.approval ? <Badge tone={o.approval.state === "approved" ? "success" : o.approval.state === "pending" ? "warning" : o.approval.state === "rejected" ? "danger" : "neutral"}>approval {o.approval.state}</Badge> : <Badge tone="warning">no approval request</Badge>}
        </div>
      </div>
      <p className="mt-1 text-xs text-muted">{o.description}</p>
      <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        <div><dt className="text-faint">Priority composite</dt><dd className="font-medium">{p.composite ?? "n/a"} <span className="text-faint">(impact {p.impact ?? "?"}, feasibility {p.feasibility ?? "?"}, risk {p.risk ?? "?"}, time to value {p.timeToValue ?? "?"})</span></dd></div>
        <div><dt className="text-faint">Effort</dt><dd>{bc.effort ? <EstimateLabel>{bc.effort}</EstimateLabel> : "n/a"}</dd></div>
        <div><dt className="text-faint">Based on findings</dt><dd>{o.findingTitles.join("; ") || "none"}</dd></div>
        <div><dt className="text-faint">Approval</dt><dd>{o.approval ? <>needs {o.approval.approverRole} · risk {o.approval.risk}{o.approval.decidedAt ? ` · decided ${fmtDate(o.approval.decidedAt)}` : ""}{o.approval.decisionNote ? ` · "${o.approval.decisionNote}"` : ""} · requested by {o.approval.requestedByActorId}</> : "n/a"}</dd></div>
        <div className="sm:col-span-2"><dt className="text-faint">Expected KPI changes</dt><dd>{bc.kpiChanges.length === 0 ? "none listed" : bc.kpiChanges.map((c, i) => <span key={i} className="mr-3">{c.kpi} {c.direction} <EstimateLabel>{c.magnitude}</EstimateLabel></span>)}</dd></div>
      </dl>
      {children}
    </div>
  );
}
