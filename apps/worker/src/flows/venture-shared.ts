import { desc, eq, sql } from "drizzle-orm";
import { agencyContext, schema, writeAudit } from "@sbos/db";
import { RunFailure, readFactsForAgent } from "@sbos/core";
import { DEFAULT_LAB_FOCUS, type VentureLabContext } from "@sbos/agents";
import type { FlowRuntime } from "./types";

const { agencyKnowledgeRecords, agencyKnowledgeVersions, tenants, opportunities, agentTasks, schedules } = schema;

/** The agency tenant is the only place the Venture Lab runs (ADR-025). */
export function assertAgencyTenant(rt: FlowRuntime): void {
  if (rt.tenant.kind !== "agency") throw new RunFailure("policy", `the Venture Lab runs in the agency tenant only (tenant kind is ${rt.tenant.kind})`);
}

/** Focus for this lab run: the task's instruction (schedule ticks and delegations carry one), else the default. */
export async function readLabFocus(rt: FlowRuntime): Promise<string> {
  return rt.tx(async (tx) => {
    if (rt.run.taskId) {
      const [task] = await tx.select({ instruction: agentTasks.instruction }).from(agentTasks).where(eq(agentTasks.id, rt.run.taskId));
      if (task?.instruction) return task.instruction.slice(0, 2000);
    }
    if (rt.run.scheduleId) {
      const [s] = await tx.select({ instruction: schedules.instruction }).from(schedules).where(eq(schedules.id, rt.run.scheduleId));
      if (s?.instruction) return s.instruction.slice(0, 2000);
    }
    return DEFAULT_LAB_FOCUS;
  });
}

/**
 * Assembles the lab context. Agency knowledge and the portfolio pattern are read in agency scope (RLS requires it and
 * the operator role cannot read the content); the read is gated by the `agency_vault.read` tool and audited. Only
 * published records are used. Tenant names and all client content stay out of the context.
 */
export async function readVentureLabContext(rt: FlowRuntime, focus: string, maxVentures: number): Promise<VentureLabContext> {
  assertAgencyTenant(rt);
  rt.gateway.authorize("agency_vault.read");
  rt.gateway.authorize("vault.read");
  const agencyCtx = agencyContext({ tenantId: rt.tenant.id, actorType: "agent", actorId: rt.instance.serviceIdentity, roles: ["agent_service"] });
  const agency = await rt.handle.withContext(agencyCtx, async (tx) => {
    const records = await tx
      .select({ path: agencyKnowledgeRecords.path, title: agencyKnowledgeRecords.title, kind: agencyKnowledgeRecords.kind, body: agencyKnowledgeVersions.bodyMarkdown })
      .from(agencyKnowledgeRecords)
      .innerJoin(agencyKnowledgeVersions, eq(agencyKnowledgeVersions.id, agencyKnowledgeRecords.currentVersionId))
      .where(eq(agencyKnowledgeRecords.state, "published"))
      .orderBy(desc(agencyKnowledgeRecords.updatedAt))
      .limit(40);
    const portfolio = await tx.select({ industry: tenants.industry, kind: tenants.kind, status: tenants.status }).from(tenants).where(sql`${tenants.kind} <> 'agency'`);
    await writeAudit(tx, agencyCtx, { action: "agency_knowledge.agent_read", entityType: "agency_vault", after: { records: records.length, portfolioTenants: portfolio.length, runId: rt.run.id } });
    return { records, portfolio };
  });
  const own = await rt.tx(async (tx) => {
    const prior = await tx.select({ title: opportunities.title, state: opportunities.state }).from(opportunities).orderBy(desc(opportunities.createdAt)).limit(100);
    const facts = await readFactsForAgent(tx, rt.ctx, { tenantId: rt.tenant.id, runId: rt.run.id, limit: 50 });
    return { prior, facts };
  });
  await rt.event("tool_call", `read agency knowledge: ${agency.records.length} published record(s), portfolio pattern of ${agency.portfolio.length} tenant(s), ${own.prior.length} prior opportunit(ies) (agency scope, audited)`, { tools: ["agency_vault.read", "vault.read"] });
  return {
    agency: { name: rt.tenant.name, industry: rt.tenant.industry, locale: rt.tenant.locale },
    focus,
    portfolio: agency.portfolio.map((p) => ({ industry: p.industry, kind: String(p.kind), status: String(p.status) })),
    knowledge: agency.records.map((r) => ({ path: r.path, title: r.title, kind: String(r.kind), excerpt: excerpt(r.body) })),
    priorIdeas: own.prior.map((p) => ({ title: p.title, state: String(p.state) })),
    facts: own.facts.map((f) => ({ statement: f.statement, verification: String(f.verification) })),
    maxVentures
  };
}

function excerpt(markdown: string): string {
  const text = markdown.replace(/^#.*$/gm, "").replace(/\{\{[^}]+\}\}/g, "").replace(/[|*`>\-]/g, " ").replace(/\s+/g, " ").trim();
  return text.length > 320 ? `${text.slice(0, 317)}...` : text;
}

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "venture";
}
