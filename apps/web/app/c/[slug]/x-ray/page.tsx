import Link from "next/link";
import { notFound } from "next/navigation";
import { clientNav, Shell } from "@/components/shell";
import { Badge, Card, Empty, Stat, Status } from "@/components/ui";
import { PageHeader, ShortId, StateBadge, Table, Td, Tr } from "@/components/agent-ui";
import { ClaimBadge, EstimateLabel, FindingStateBadge, InterventionBadge, OpportunityStateBadge, SeverityBadge, SystemClaimBadge, UncertaintyBadge } from "@/components/xray-ui";
import { getTenantHeader } from "@/lib/client/queries";
import { getXrayPage, type XrayProcess } from "@/lib/client/xray-queries";
import { businessCaseView, priorityView } from "@/lib/client/xray-helpers";
import { fmtDate } from "@/lib/format";
import { requireTenantContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

function StepTable({ process, showIntervention }: { process: XrayProcess | null; showIntervention: boolean }) {
  if (!process) return <Empty>No {showIntervention ? "TO-BE" : "AS-IS"} variant recorded for this process.</Empty>;
  return (
    <Table head={showIntervention ? ["#", "Kind", "Step", "Owner", "System", "Intervention"] : ["#", "Kind", "Step", "Owner", "System", "Wait / exceptions"]} empty={process.steps.length === 0 ? <Empty>No steps recorded.</Empty> : null}>
      {process.steps.map((s) => (
        <Tr key={s.id}>
          <Td className="text-faint">{s.seq}</Td>
          <Td><Badge>{s.kind}</Badge></Td>
          <Td className="font-medium">{s.name}{s.control ? <div className="text-xs text-faint">control: {s.control}</div> : null}</Td>
          <Td className="text-xs text-muted">{s.ownerRole ?? ""}</Td>
          <Td className="text-xs text-muted">{s.systemName ?? ""}</Td>
          {showIntervention ? <Td><InterventionBadge value={s.intervention} /></Td> : <Td className="text-xs text-muted">{[s.waitTimeHint, s.exceptions].filter(Boolean).join(" · ")}</Td>}
        </Tr>
      ))}
    </Table>
  );
}

export default async function XrayPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await requireTenantContext(slug);
  if (!access) notFound();
  const [tenant, x] = await Promise.all([getTenantHeader(access.ctx), getXrayPage(access.ctx)]);
  if (!tenant || !x) notFound();
  const processKeys = [...new Set(x.processes.map((p) => p.key))];
  const openFindings = x.findings.filter((f) => f.state === "open");
  return (
    <Shell title={tenant.name} subtitle="Client workspace" nav={clientNav(slug)}>
      <div className="space-y-6">
        <PageHeader title="Business X-Ray">
          Company snapshot, maturity scorecard, AS-IS and TO-BE process maps, the issues and evidence register, open questions and decisions, and the opportunity backlog. Everything is read from this tenant's records; every score lists the inputs it was computed from. <Status state="implemented" />
        </PageHeader>

        <section id="snapshot" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-4">
            <Stat label="Departments" value={x.departments.length} hint="organisation map" />
            <Stat label="Systems" value={x.systems.length} hint={`${x.systems.filter((s) => s.claimStatus !== "stated").length} verified or connected`} />
            <Stat label="Facts" value={x.facts.total} hint={`${x.facts.verified} verified`} />
            <Stat label="Open findings" value={openFindings.length} hint={`${openFindings.filter((f) => f.severity === "critical" || f.severity === "high").length} critical or high`} />
          </div>
          <div className="grid gap-4 md:grid-cols-[1fr_2fr]">
            <Card title="Company profile">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-faint">Name</dt><dd className="font-medium">{x.tenant.name}</dd>
                <dt className="text-faint">Industry</dt><dd>{x.tenant.industry ?? "n/a"}</dd>
                <dt className="text-faint">Kind</dt><dd><Badge tone={x.tenant.kind === "demo" ? "warning" : "cyan"}>{x.tenant.kind === "demo" ? "synthetic tenant" : x.tenant.kind}</Badge></dd>
                <dt className="text-faint">Status</dt><dd>{x.tenant.status}</dd>
                <dt className="text-faint">Locale</dt><dd>{x.tenant.locale}</dd>
                <dt className="text-faint">Onboarded</dt><dd>{fmtDate(x.tenant.createdAt)}</dd>
              </dl>
              <div className="mt-3 text-xs uppercase tracking-wide text-faint">Departments</div>
              <ul className="mt-1 text-sm">{x.departments.map((d) => <li key={d.id} className="flex justify-between py-0.5"><span>{d.name}</span><span className="text-faint">{d.headRole ?? ""}</span></li>)}</ul>
            </Card>
            <Card title="Systems register" footer="Claim status: stated (named in intake, unverified), verified_exists (existence confirmed), connected (read access with consent). Nothing here is connected yet.">
              <Table head={["System", "Function", "Department", "Source of truth for", "API", "Claim"]} empty={x.systems.length === 0 ? <Empty>No systems registered.</Empty> : null}>
                {x.systems.map((s) => (
                  <Tr key={s.id}>
                    <Td className="font-medium">{s.name}<div className="text-xs text-faint">{s.vendor ?? ""}</div></Td>
                    <Td className="text-xs text-muted">{s.function}</Td>
                    <Td className="text-xs text-muted">{s.departmentKey ?? ""}</Td>
                    <Td className="text-xs text-muted">{s.sourceOfTruthFor.join(", ")}</Td>
                    <Td className="text-xs text-muted">{s.apiCapabilities.join(", ")}</Td>
                    <Td><SystemClaimBadge value={s.claimStatus} /></Td>
                  </Tr>
                ))}
              </Table>
            </Card>
          </div>
        </section>

        <Card
          title="Maturity scorecard per department"
          footer={
            <span>
              Rule (transparent, deterministic): <code>answers</code> = answered / total questions x 40; <code>evidence</code> = verified / total facts x 30 (facts are tenant-wide, so this component is the same for every department); <code>systems</code> = verified or connected / registered systems x 30; <code>penalty</code> = 15 per open critical finding plus 8 per open high finding, capped at 30; score = clamp(sum - penalty, 0, 100). Uncertainty follows the evidence count (answers plus verified facts): below 3 high, below 8 medium, otherwise low. A department with no questions, facts, systems or findings has no score.
            </span>
          }
        >
          <div className="grid gap-3 md:grid-cols-2">
            {x.departments.map((d) => (
              <div key={d.id} className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium">{d.name}</div>
                  <div className="flex items-center gap-2"><UncertaintyBadge value={d.maturity.uncertainty} /><span className="text-2xl font-semibold text-fg">{d.maturity.score === null ? <span className="text-sm text-muted">no inputs</span> : `${d.maturity.score}`}</span></div>
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-faint">
                  {d.maturity.inputs.map((i) => <div key={i.label} className="contents"><dt>{i.label}</dt><dd className="text-muted">{i.value}</dd></div>)}
                  <dt>Components</dt><dd className="text-muted">answers {d.maturity.components.answers} · evidence {d.maturity.components.evidence} · systems {d.maturity.components.systems} · penalty {d.maturity.components.penalty}</dd>
                  <dt>Evidence count</dt><dd className="text-muted">{d.maturity.evidenceCount}</dd>
                </dl>
              </div>
            ))}
          </div>
        </Card>

        <section id="processes" className="space-y-4">
          <h2 className="text-lg font-semibold">Process maps (AS-IS and TO-BE)</h2>
          {processKeys.length === 0 ? <Empty>No processes reconstructed yet. The Process Redesign agent builds the AS-IS map from answers and proposes a TO-BE map with intervention labels.</Empty> : null}
          {processKeys.map((key) => {
            const asIs = x.processes.find((p) => p.key === key && p.variant === "as_is") ?? null;
            const toBe = x.processes.find((p) => p.key === key && p.variant === "to_be") ?? null;
            const head = asIs ?? toBe!;
            return (
              <Card key={key} title={head.name} footer={`Department ${head.department ?? "n/a"} · verification ${head.verification.replaceAll("_", " ")} · ${head.sourceCount} source(s). Intervention labels: stop, simplify, standardize, integrate, automate, keep human (deliberately manual).`}>
                {head.description ? <p className="mb-3 text-sm text-muted">{head.description}</p> : null}
                <div className="grid gap-4 lg:grid-cols-2">
                  <div><div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-faint">AS-IS {asIs ? <StateBadge kind="classification" value="internal" /> : null}</div><StepTable process={asIs} showIntervention={false} /></div>
                  <div><div className="mb-2 text-xs uppercase tracking-wide text-faint">TO-BE</div><StepTable process={toBe} showIntervention /></div>
                </div>
              </Card>
            );
          })}
        </section>

        <Card title={`Issues and evidence register (${x.findings.length})`} footer="Claim type on every finding: client_statement (said in an interview), data_observation (measured from a connected source), hypothesis (the agent's inference). Confidence is the producer's self-assessment. Impact amounts, when present, are estimates.">
          <Table head={["Finding", "Department", "Severity", "Claim", "Urgency", "Confidence", "Sources", "Evidence", "State", "Owner"]} empty={x.findings.length === 0 ? <Empty>No findings yet. The Finance and Operations agents record findings after the intake answers.</Empty> : null}>
            {x.findings.map((f) => {
              const impact = (f.impact && typeof f.impact === "object" ? f.impact : {}) as { description?: string; estimated_annual_cost?: { amount: number; currency: string } };
              return (
                <Tr key={f.id}>
                  <Td className="max-w-md"><div id={`finding-${f.id}`} className="font-medium">{f.title}</div><div className="text-xs text-muted">{f.description}</div>{impact.description ? <div className="mt-1 text-xs text-faint">Impact: {impact.description}{impact.estimated_annual_cost ? <> · <EstimateLabel>{impact.estimated_annual_cost.amount} {impact.estimated_annual_cost.currency} per year</EstimateLabel></> : null}</div> : null}</Td>
                  <Td className="text-xs text-muted">{f.department}</Td>
                  <Td><SeverityBadge value={f.severity} /></Td>
                  <Td><ClaimBadge value={f.claim} /></Td>
                  <Td className="text-xs text-muted">{f.urgency.replaceAll("_", " ")}</Td>
                  <Td className="text-muted">{f.confidence.toFixed(2)}</Td>
                  <Td className="text-muted">{f.sourceCount}</Td>
                  <Td className="text-muted">{f.evidenceCount}</Td>
                  <Td><FindingStateBadge value={f.state} /></Td>
                  <Td className="text-xs text-muted">{f.ownerRole}</Td>
                </Tr>
              );
            })}
          </Table>
        </Card>

        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Open questions by department" footer={<Link href={`/c/${slug}/inbox`} className="underline">Open the Interview Inbox</Link>}>
            {x.openQuestionsByDepartment.length === 0 ? <Empty>No open questions.</Empty> : <ul className="text-sm">{x.openQuestionsByDepartment.map((q) => <li key={q.department} className="flex justify-between py-1"><span>{q.department}</span><span className="font-medium">{q.n}</span></li>)}</ul>}
          </Card>
          <Card title={`Pending decisions (${x.pendingApprovals.length})`} footer={<Link href={`/c/${slug}/approvals`} className="underline">Decide in Approvals</Link>}>
            {x.pendingApprovals.length === 0 ? <Empty>Nothing waits for a decision.</Empty> : (
              <ul className="divide-y divide-border text-sm">
                {x.pendingApprovals.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span><Link href={`/c/${slug}/approvals/${a.id}`} className="underline">{a.summary}</Link><span className="ml-2 text-xs text-faint">{a.subjectType.replaceAll("_", " ")} · needs {a.approverRole}</span></span>
                    <StateBadge kind="risk" value={a.risk} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <Card title={`Opportunity backlog (${x.opportunities.length})`} footer={<span>Priority composite = impact x feasibility x time_to_value / risk (scores 1 to 5), computed by the proposing service. Business case figures are estimates by contract. Decisions and tasks: <Link href={`/c/${slug}/actions`} className="underline">Management Action Center</Link>.</span>}>
          {x.opportunities.length === 0 ? <Empty>No opportunities proposed yet.</Empty> : (
            <div className="space-y-3">
              {x.opportunities.map((o) => {
                const bc = businessCaseView(o.businessCase);
                const p = priorityView(o.priorityScore);
                return (
                  <div key={o.id} id={`opportunity-${o.id}`} className="rounded-md border border-border p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-medium">{o.title}</div>
                      <div className="flex items-center gap-2"><InterventionBadge value={o.intervention} /><OpportunityStateBadge value={o.state} />{o.approvalState ? <Badge tone={o.approvalState === "approved" ? "success" : o.approvalState === "pending" ? "warning" : "neutral"}>approval {o.approvalState}</Badge> : <Badge tone="warning">no approval</Badge>}</div>
                    </div>
                    <p className="mt-1 text-xs text-muted">{o.description}</p>
                    <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                      <div><dt className="text-faint">Priority composite</dt><dd className="font-medium">{p.composite ?? "n/a"} <span className="text-faint">(impact {p.impact ?? "?"}, feasibility {p.feasibility ?? "?"}, risk {p.risk ?? "?"}, time to value {p.timeToValue ?? "?"})</span></dd></div>
                      <div><dt className="text-faint">Effort</dt><dd>{bc.effort ? <EstimateLabel>{bc.effort}</EstimateLabel> : "n/a"}</dd></div>
                      <div><dt className="text-faint">Estimated cost</dt><dd>{bc.cost ? <EstimateLabel>{bc.cost.amount} {bc.cost.currency}</EstimateLabel> : <span className="text-faint">not estimated</span>}</dd></div>
                      <div><dt className="text-faint">Estimated yearly saving</dt><dd>{bc.saving ? <EstimateLabel>{bc.saving.amount} {bc.saving.currency}</EstimateLabel> : <span className="text-faint">not estimated</span>}</dd></div>
                      <div><dt className="text-faint">Dependencies</dt><dd>{bc.dependencies.join("; ") || "none listed"}</dd></div>
                      <div><dt className="text-faint">Risks</dt><dd>{bc.risks.join("; ") || "none listed"}</dd></div>
                      <div className="sm:col-span-2"><dt className="text-faint">Expected KPI changes</dt><dd>{bc.kpiChanges.length === 0 ? "none listed" : bc.kpiChanges.map((c, i) => <span key={i} className="mr-3">{c.kpi} {c.direction} <EstimateLabel>{c.magnitude}</EstimateLabel></span>)}</dd></div>
                      <div><dt className="text-faint">Based on findings</dt><dd>{o.findingIds.length}</dd></div>
                      <div><dt className="text-faint">Confidence</dt><dd>{o.confidence.toFixed(2)} · proposed {fmtDate(o.createdAt)} · <ShortId id={o.id} /></dd></div>
                    </dl>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card title="Implementation status">
          <ul className="space-y-1 text-sm">
            <li><Status state="implemented" /> Snapshot, scorecard with documented rule and uncertainty, AS-IS and TO-BE step tables, findings register, questions and decisions, opportunity backlog (M3-10)</li>
            <li><Status state="simulated" /> Findings, processes and opportunities on this synthetic tenant come from the simulated agent runtime</li>
            <li><Status state="not_connected" /> No system is connected; claim status stays <code>stated</code> until M5</li>
            <li><Status state="planned" /> Pain points per process step, evidence record detail pages, semantic search over facts (ADR-019, M5)</li>
          </ul>
        </Card>
      </div>
    </Shell>
  );
}
