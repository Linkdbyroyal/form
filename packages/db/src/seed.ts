import { sql } from "drizzle-orm";
import { createDb, type DbHandle } from "./client";
import { agencyContext, tenantContext } from "./context";
import { writeAudit } from "./audit";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentDefinitions, agentInstances, budgets, departments, memberships, schedules, skillReleaseChannels, skillVersions, skills, systems, tenants, users } from "./schema/index";

/**
 * Synthetic seed data. Two demo client tenants and the agency tenant. No real company data.
 * Idempotent: re-running updates nothing and inserts only what is missing.
 */
export interface SeedResult {
  agencyTenantId: string;
  tenantIds: Record<string, string>;
  userIds: Record<string, string>;
}

const SYSTEM_ACTOR = { actorType: "system" as const, actorId: "seed", roles: ["superadmin"] };

export async function seed(handle: DbHandle): Promise<SeedResult> {
  const agencyCtx = agencyContext({ tenantId: null, ...SYSTEM_ACTOR });

  // 1. Tenants and users (agency scope).
  const ids = await handle.withContext(agencyCtx, async (tx) => {
    const tenantRows = [
      { slug: "second-brain-agency", name: "Second Brain AI Agency", kind: "agency" as const, status: "active" as const, industry: "AI consultancy" },
      { slug: "northline-events", name: "Northline Events (synthetic)", kind: "demo" as const, status: "onboarding" as const, industry: "Event rental" },
      { slug: "harbour-view-hotel", name: "Harbour View Hotel (synthetic)", kind: "demo" as const, status: "onboarding" as const, industry: "Hospitality" }
    ];
    const tenantIds: Record<string, string> = {};
    for (const row of tenantRows) {
      const [t] = await tx
        .insert(tenants)
        .values({ ...row, settings: { synthetic: row.kind === "demo" } })
        .onConflictDoNothing({ target: tenants.slug })
        .returning({ id: tenants.id });
      const existing = t ?? (await tx.select({ id: tenants.id }).from(tenants).where(sql`slug = ${row.slug}`))[0];
      if (!existing) throw new Error(`could not seed tenant ${row.slug}`);
      tenantIds[row.slug] = existing.id;
    }

    const userRows = [
      { email: "operator@secondbrain.test", displayName: "Sam Operator" },
      { email: "ceo@northline.test", displayName: "Nora Northline" },
      { email: "finance@northline.test", displayName: "Fred Finance" },
      { email: "ceo@harbourview.test", displayName: "Hugo Harbour" }
    ];
    const userIds: Record<string, string> = {};
    for (const row of userRows) {
      // Users are not tenant scoped, so RLS does not apply; the agency scope is still the correct actor.
      const [u] = await tx.insert(users).values(row).onConflictDoNothing().returning({ id: users.id });
      const existing = u ?? (await tx.select({ id: users.id }).from(users).where(sql`lower(email) = lower(${row.email})`))[0];
      if (!existing) throw new Error(`could not seed user ${row.email}`);
      userIds[row.email] = existing.id;
    }
    return { tenantIds, userIds };
  });

  const agencyTenantId = ids.tenantIds["second-brain-agency"]!;

  // 2. Memberships per tenant (tenant scope, because WITH CHECK requires tenant_id = app.tenant_id).
  const membershipPlan: Array<{ slug: string; email: string; role: string; department?: string }> = [
    { slug: "second-brain-agency", email: "operator@secondbrain.test", role: "superadmin" },
    { slug: "northline-events", email: "ceo@northline.test", role: "client_admin" },
    { slug: "northline-events", email: "finance@northline.test", role: "department_manager", department: "finance" },
    { slug: "harbour-view-hotel", email: "ceo@harbourview.test", role: "client_admin" }
  ];
  for (const m of membershipPlan) {
    const tenantId = ids.tenantIds[m.slug]!;
    await handle.withContext(tenantContext({ tenantId, ...SYSTEM_ACTOR }), async (tx) => {
      await tx
        .insert(memberships)
        .values({ tenantId, userId: ids.userIds[m.email]!, roleKey: m.role, departmentKey: m.department ?? null })
        .onConflictDoNothing();
    });
  }

  // 3. Organisation map and software register for the two demo tenants.
  await seedTenantOrg(handle, ids.tenantIds["northline-events"]!, NORTHLINE);
  await seedTenantOrg(handle, ids.tenantIds["harbour-view-hotel"]!, HARBOUR_VIEW);

  // 4. Agent catalogue (agency scope) and one Discovery agent instance per demo tenant.
  const catalogue = await seedAgentCatalogue(handle);
  await seedTenantAgents(handle, ids.tenantIds["northline-events"]!, "northline", catalogue, true);
  await seedTenantAgents(handle, ids.tenantIds["harbour-view-hotel"]!, "harbourview", catalogue, false);

  return { agencyTenantId, tenantIds: ids.tenantIds, userIds: ids.userIds };
}

interface OrgSeed {
  departments: Array<{ key: string; name: string; headRole: string }>;
  systems: Array<{
    name: string;
    vendor: string;
    function: string;
    department: string;
    sourceOfTruthFor: string[];
    dataTypes: string[];
    apiCapabilities: Array<"api" | "mcp" | "webhook" | "export" | "none">;
    notes: string;
  }>;
}

const NORTHLINE: OrgSeed = {
  departments: [
    { key: "management", name: "Management", headRole: "client_admin" },
    { key: "sales", name: "Sales and Quotes", headRole: "department_manager" },
    { key: "operations", name: "Operations and Warehouse", headRole: "department_manager" },
    { key: "finance", name: "Finance", headRole: "department_manager" }
  ],
  systems: [
    { name: "Rentman", vendor: "Rentman", function: "Projects, equipment, crew planning, quotes, invoices", department: "operations", sourceOfTruthFor: ["projects", "equipment", "crew"], dataTypes: ["projects", "subprojects", "projectequipment", "invoices"], apiCapabilities: ["api", "mcp"], notes: "SYNTHETIC: stated by the CEO in intake; no connection verified." },
    { name: "QuickBooks Online", vendor: "Intuit", function: "Accounting, invoices, payments", department: "finance", sourceOfTruthFor: ["ledger", "payments"], dataTypes: ["invoices", "payments", "customers"], apiCapabilities: ["api", "mcp"], notes: "SYNTHETIC: stated; invoice sync to Rentman is manual according to intake." },
    { name: "Trengo", vendor: "Trengo", function: "Customer conversations incl. WhatsApp", department: "sales", sourceOfTruthFor: ["conversations"], dataTypes: ["tickets", "messages"], apiCapabilities: ["api", "webhook"], notes: "SYNTHETIC: stated." },
    { name: "Dropbox", vendor: "Dropbox", function: "Documents and contracts", department: "management", sourceOfTruthFor: ["documents"], dataTypes: ["files"], apiCapabilities: ["api", "mcp"], notes: "SYNTHETIC: stated." }
  ]
};

const HARBOUR_VIEW: OrgSeed = {
  departments: [
    { key: "management", name: "Management", headRole: "client_admin" },
    { key: "front_office", name: "Front Office and Reservations", headRole: "department_manager" },
    { key: "food_beverage", name: "Food and Beverage", headRole: "department_manager" },
    { key: "finance", name: "Finance", headRole: "department_manager" }
  ],
  systems: [
    { name: "Property Management System", vendor: "Unknown (to verify)", function: "Reservations, rooms, folios", department: "front_office", sourceOfTruthFor: ["reservations"], dataTypes: ["bookings", "folios"], apiCapabilities: ["export"], notes: "SYNTHETIC: vendor to be confirmed in discovery." },
    { name: "Point of Sale", vendor: "Unknown (to verify)", function: "Restaurant and bar sales", department: "food_beverage", sourceOfTruthFor: ["f&b sales"], dataTypes: ["tickets"], apiCapabilities: ["export"], notes: "SYNTHETIC." },
    { name: "Accounting package", vendor: "Unknown (to verify)", function: "Ledger", department: "finance", sourceOfTruthFor: ["ledger"], dataTypes: ["journals"], apiCapabilities: ["none"], notes: "SYNTHETIC." }
  ]
};

async function seedTenantOrg(handle: DbHandle, tenantId: string, org: OrgSeed): Promise<void> {
  const ctx = tenantContext({ tenantId, ...SYSTEM_ACTOR });
  await handle.withContext(ctx, async (tx) => {
    const deptIds: Record<string, string> = {};
    for (const d of org.departments) {
      const [row] = await tx
        .insert(departments)
        .values({ tenantId, key: d.key, name: d.name, headRole: d.headRole })
        .onConflictDoNothing()
        .returning({ id: departments.id });
      const existing = row ?? (await tx.select({ id: departments.id }).from(departments).where(sql`key = ${d.key}`))[0];
      if (existing) deptIds[d.key] = existing.id;
    }
    const existingSystems = await tx.select({ name: systems.name }).from(systems);
    const known = new Set(existingSystems.map((s) => s.name));
    for (const s of org.systems) {
      if (known.has(s.name)) continue;
      await tx.insert(systems).values({
        tenantId,
        name: s.name,
        vendor: s.vendor,
        function: s.function,
        departmentId: deptIds[s.department] ?? null,
        sourceOfTruthFor: s.sourceOfTruthFor,
        dataTypes: s.dataTypes,
        apiCapabilities: s.apiCapabilities,
        claimStatus: "stated",
        notes: s.notes
      });
      await writeAudit(tx, ctx, { action: "system.registered", entityType: "system", after: { name: s.name, claimStatus: "stated" } });
    }
  });
}

export function seedHandleFromEnv(url: string): DbHandle {
  return createDb({ connectionString: url, max: 2 });
}

interface Catalogue { definitionId: string; skillVersionId: string }

const here = dirname(fileURLToPath(import.meta.url));

/** Skills and agent definitions are agency assets; versions are immutable and pinned by instances. */
async function seedAgentCatalogue(handle: DbHandle): Promise<Catalogue> {
  const ctx = agencyContext({ tenantId: null, ...SYSTEM_ACTOR });
  const skillMd = readFileSync(join(here, "..", "seed-data", "skills", "discovery-interview", "SKILL.md"), "utf8");
  const checksum = createHash("sha256").update(skillMd).digest("hex");
  return handle.withContext(ctx, async (tx) => {
    const [skill] = await tx
      .insert(skills)
      .values({ key: "discovery-interview", name: "Discovery & Interview", description: "Builds company knowledge and asks only the next useful question." })
      .onConflictDoNothing({ target: skills.key })
      .returning({ id: skills.id });
    const skillId = skill?.id ?? (await tx.select({ id: skills.id }).from(skills).where(sql`key = 'discovery-interview'`))[0]!.id;

    const [version] = await tx
      .insert(skillVersions)
      .values({ skillId, version: "0.1.0", skillMd, contracts: ["QuestionRequest"], allowedTools: ["vault.read", "systems.read", "questions.read", "questions.create", "vault.write_draft", "approvals.request"], releaseChannel: "stable", checksum, createdBy: "seed" })
      .onConflictDoNothing()
      .returning({ id: skillVersions.id });
    const skillVersionId = version?.id ?? (await tx.select({ id: skillVersions.id }).from(skillVersions).where(sql`skill_id = ${skillId} and version = '0.1.0'`))[0]!.id;

    await tx.insert(skillReleaseChannels).values({ skillId, channel: "stable", skillVersionId, updatedBy: "seed" }).onConflictDoNothing();

    const [def] = await tx
      .insert(agentDefinitions)
      .values({
        key: "discovery-interview",
        name: "Discovery & Interview Agent",
        mission: "Understand the business and ask adaptive, targeted questions that close evidence gaps.",
        department: "cross-functional",
        skillId,
        defaultModel: "claude-sonnet-5-5",
        modelPolicy: { default: "claude-sonnet-5-5", classification: "claude-haiku-5-5" },
        allowedTools: ["vault.read", "systems.read", "questions.read", "questions.create", "vault.write_draft", "approvals.request"],
        requiredData: ["company_profile", "departments", "systems", "prior_questions"],
        authority: "t1",
        defaultScheduleCron: "0 7 * * 1-5",
        escalationRole: "client_admin",
        defaultBudgetUsdMonth: "5.00",
        defaultRunCapUsd: "0.25",
        inputContracts: [],
        outputContracts: ["QuestionRequest", "AgentRunResult"],
        qualityCriteria: ["max 5 questions per round", "no re-asking answered questions", "reason and evidence_gap present"],
        ownerRole: "superadmin"
      })
      .onConflictDoNothing({ target: agentDefinitions.key })
      .returning({ id: agentDefinitions.id });
    const definitionId = def?.id ?? (await tx.select({ id: agentDefinitions.id }).from(agentDefinitions).where(sql`key = 'discovery-interview'`))[0]!.id;

    // Platform budget (ADR-016): USD 25 per month, hard stop.
    await tx.insert(budgets).values({ scope: "platform", capUsdMonth: "25.00", runCapUsd: "0.50" }).onConflictDoNothing();
    return { definitionId, skillVersionId };
  });
}

async function seedTenantAgents(handle: DbHandle, tenantId: string, slugPart: string, catalogue: Catalogue, withSchedule: boolean): Promise<void> {
  const ctx = tenantContext({ tenantId, ...SYSTEM_ACTOR });
  await handle.withContext(ctx, async (tx) => {
    const serviceIdentity = `agent:discovery:${slugPart}`;
    const [inst] = await tx
      .insert(agentInstances)
      .values({ tenantId, definitionId: catalogue.definitionId, skillVersionId: catalogue.skillVersionId, name: "Discovery & Interview", state: "idle", serviceIdentity })
      .onConflictDoNothing()
      .returning({ id: agentInstances.id });
    const instanceId = inst?.id ?? (await tx.select({ id: agentInstances.id }).from(agentInstances).where(sql`service_identity = ${serviceIdentity}`))[0]!.id;

    await tx.insert(budgets).values({ tenantId, scope: "tenant", capUsdMonth: "10.00", runCapUsd: "0.50" }).onConflictDoNothing();
    await tx.insert(budgets).values({ tenantId, scope: "agent_instance", agentInstanceId: instanceId, capUsdMonth: "5.00", runCapUsd: "0.25" }).onConflictDoNothing();

    if (withSchedule) {
      const existing = await tx.select({ id: schedules.id }).from(schedules).where(sql`agent_instance_id = ${instanceId}`);
      if (existing.length === 0) {
        await tx.insert(schedules).values({
          tenantId,
          agentInstanceId: instanceId,
          name: "Discovery round (weekdays 07:00 UTC)",
          cron: "0 7 * * 1-5",
          timezone: "UTC",
          enabled: true,
          expectedBySeconds: 900,
          instruction: "Run the next discovery round: review open evidence gaps and produce the next 3 to 5 questions."
        });
      }
    }
    await writeAudit(tx, ctx, { action: "agent_instance.activated", entityType: "agent_instance", entityId: instanceId, after: { definition: "discovery-interview" } });
  });
}
