import { sql } from "drizzle-orm";
import { createDb, type DbHandle } from "./client";
import { agencyContext, tenantContext } from "./context";
import { writeAudit } from "./audit";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agencyKnowledgeRecords, agencyKnowledgeVersions, agentDefinitions, techSources, agentInstances, budgets, departments, memberships, methodologyTemplates, schedules, skillReleaseChannels, skillVersions, skills, systems, tenants, users } from "./schema/index";

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

  // 5. Agency Intelligence Vault starter records (agency scope, own knowledge only).
  await seedAgencyKnowledge(handle);

  // 6. Technology Intelligence: approved sources for the pinned dependencies (detection only, M6).
  await seedTechSources(handle);

  return { agencyTenantId, tenantIds: ids.tenantIds, userIds: ids.userIds };
}

/**
 * Second Brain's own starter knowledge: a published methodology template with a client-facing template
 * definition, a published interview set and one draft research note. Nothing here derives from a client.
 * The lifecycle transitions go through the database trigger (seed actor holds superadmin, so self-approval
 * is allowed and recorded on the transition).
 */
const AGENCY_RECORDS: Array<{ path: string; title: string; kind: "method_template" | "interview_set" | "research_note" | "decision"; publish: boolean; body: string; frontmatter: Record<string, unknown>; related: string[]; template?: { key: string; name: string; description: string; targetFolder: string; parameters: Array<{ key: string; label: string; required: boolean; default?: string; description?: string }> } }> = [
  {
    path: "06_process_patterns_and_sops/project-closure-invoice-readiness.md",
    title: "Project closure to invoice readiness check",
    kind: "method_template",
    publish: true,
    related: ["process-redesign", "finance-agent"],
    frontmatter: { pattern: "closure_gate", interventions: ["integrate", "automate", "keep_human", "standardize"], evidence: "synthetic pilot scenario; no client data" },
    body: `# Project closure to invoice readiness check

A reusable process module for companies that invoice from a project or job system. The specific analysis,
figures and people of any client stay in that client's vault; this pattern carries only the generic steps.

Trigger: a project in {{project_system}} reaches the state "{{closure_state}}".

| # | Kind | Step | Owner | Intervention |
|---|---|---|---|---|
| 1 | trigger | All returns and deliveries registered in {{project_system}} | operations | integrate |
| 2 | control | Automatic closure check: returns complete, extra costs captured, damages recorded | system | automate |
| 3 | decision | Exceptions routed to {{finance_owner}} for review | {{finance_owner}} | keep_human |
| 4 | activity | Invoice lines prepared from the project record in {{accounting_system}} | finance | automate |
| 5 | output | Invoice reviewed and sent within {{invoice_days}} working days | finance | standardize |

## Quality criteria

- No invoice is prepared while the closure check reports open exceptions.
- Every exception has an owner and a decision within one working day.
- The KPI "closed projects not invoiced" is measured from {{project_system}} and {{accounting_system}}, never estimated.

## Configurable integration interface

The project system and accounting system are parameters; the check itself is system-neutral.`,
    template: {
      key: "project-closure-invoice-readiness",
      name: "Project closure to invoice readiness check",
      description: "Closure gate before invoicing: returns, extra costs and damages verified before invoice preparation. Parameters: project system, closure state, finance owner, accounting system, invoice days.",
      targetFolder: "05_processes_to_be",
      parameters: [
        { key: "project_system", label: "Project or job system", required: true, description: "Where projects are planned and closed (for example Rentman, a PMS, an ERP)." },
        { key: "closure_state", label: "Closure state", required: true, description: "The state that marks a project as operationally finished." },
        { key: "finance_owner", label: "Finance owner for exceptions", required: true, default: "finance" },
        { key: "accounting_system", label: "Accounting system", required: true },
        { key: "invoice_days", label: "Invoice within (working days)", required: false, default: "2" }
      ]
    }
  },
  {
    path: "04_discovery_questions_and_assessments/intake-round-1-universal.md",
    title: "Universal intake questions, round 1",
    kind: "interview_set",
    publish: true,
    related: ["discovery-interview"],
    frontmatter: { audience: "client_admin", max_questions: 5, answer_types: ["text", "single_choice", "multi_choice", "number"] },
    body: `# Universal intake questions, round 1

Five questions the Discovery agent may draw from for any company. Each question states the evidence gap it closes.

1. Which departments exist and who leads each one? (organisation map)
2. Which software systems hold your projects, invoices, customers and documents? (systems register)
3. Where does work wait for a person today: hand-offs, approvals, re-typing? (pain points)
4. Which three numbers would you check every morning if they were reliable? (decision needs)
5. Which decisions must always stay with a person, whatever the automation? (keep_human boundaries)`
  },
  {
    path: "13_research_updates_and_release_reviews/github-assessment-2026-11.md",
    title: "GitHub assessment, November 2026 (draft)",
    kind: "research_note",
    publish: false,
    related: [],
    frontmatter: { source: "docs/research/github-assessment.md", status: "draft" },
    body: `# GitHub assessment, November 2026

Draft summary of the Build / Adopt / Integrate / Reject matrix (see the repository document for licences and
rationale). A repository is never an automatically verified best practice; every adoption goes through an
UpgradeProposal with tests.`
  }
];

async function seedAgencyKnowledge(handle: DbHandle): Promise<void> {
  const ctx = agencyContext({ tenantId: null, ...SYSTEM_ACTOR });
  await handle.withContext(ctx, async (tx) => {
    for (const r of AGENCY_RECORDS) {
      const folder = r.path.split("/")[0]!;
      const [rec] = await tx
        .insert(agencyKnowledgeRecords)
        .values({ folder, path: r.path, title: r.title, kind: r.kind, ownerActorId: SYSTEM_ACTOR.actorId, classification: "internal", origin: "own", license: "Second Brain internal", allowedUses: ["client_delivery", "agent_context"], relatedSkillKeys: r.related, createdByActorType: "system", createdByActorId: SYSTEM_ACTOR.actorId })
        .onConflictDoNothing({ target: agencyKnowledgeRecords.path })
        .returning({ id: agencyKnowledgeRecords.id });
      if (!rec) continue; // already seeded
      const checksum = createHash("sha256").update(JSON.stringify(r.frontmatter)).update("\n").update(r.body).digest("hex");
      const [ver] = await tx.insert(agencyKnowledgeVersions).values({ recordId: rec.id, version: 1, frontmatter: r.frontmatter, bodyMarkdown: r.body, changelog: "seeded starter version", checksum, createdByActorType: "system", createdByActorId: SYSTEM_ACTOR.actorId }).returning({ id: agencyKnowledgeVersions.id });
      await tx.update(agencyKnowledgeRecords).set({ currentVersionId: ver!.id }).where(sql`id = ${rec.id}`);
      if (r.publish) {
        for (const state of ["in_review", "approved", "published"] as const) {
          await tx.update(agencyKnowledgeRecords).set({ state }).where(sql`id = ${rec.id}`);
        }
      }
      if (r.template) {
        await tx.insert(methodologyTemplates).values({ key: r.template.key, recordId: rec.id, name: r.template.name, description: r.template.description, targetFolder: r.template.targetFolder, parameters: r.template.parameters }).onConflictDoNothing({ target: methodologyTemplates.key });
      }
      await writeAudit(tx, ctx, { action: "agency_knowledge.seeded", entityType: "agency_knowledge_record", entityId: rec.id, after: { path: r.path, published: r.publish } });
    }
  });
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

interface Catalogue { definitions: Record<string, { definitionId: string; skillVersionId: string }> }

const here = dirname(fileURLToPath(import.meta.url));

interface SkillMeta { name: string; description: string; version: string; contracts: string[]; allowed_tools: string[]; release_channel: string }

/** Minimal frontmatter reader for SKILL.md (name, description, version, lists in [a, b] form). */
function readSkillMd(key: string): { md: string; meta: SkillMeta } {
  const md = readFileSync(join(here, "..", "seed-data", "skills", key, "SKILL.md"), "utf8");
  const fm = /^---\n([\s\S]*?)\n---/.exec(md)?.[1] ?? "";
  const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(fm)?.[1]?.trim() ?? "";
  const list = (k: string) => field(k).replace(/^\[|\]$/g, "").split(",").map((x) => x.trim()).filter(Boolean);
  return { md, meta: { name: field("name"), description: field("description"), version: field("version") || "0.1.0", contracts: list("contracts"), allowed_tools: list("allowed_tools"), release_channel: field("release_channel") || "stable" } };
}

/** Agent catalogue: one definition per role, each pinned to an immutable skill version read from seed-data/skills. */
const DEFINITIONS: Array<{ key: string; name: string; mission: string; department: string | null; authority: "t1" | "t2" | "t3"; cron: string | null; escalation: string; budget: string; runCap: string; outputs: string[]; quality: string[]; extraTools?: string[] }> = [
  { key: "discovery-interview", name: "Discovery & Interview Agent", mission: "Understand the business and ask adaptive, targeted questions that close evidence gaps.", department: "cross-functional", authority: "t1", cron: "0 7 * * 1-5", escalation: "client_admin", budget: "5.00", runCap: "0.25", outputs: ["QuestionRequest", "AgentRunResult"], quality: ["max 5 questions per round", "no re-asking answered questions", "reason and evidence_gap present"] },
  { key: "finance-agent", name: "CFO & Finance Agent", mission: "Review cash flow, invoicing, receivables, payables, costs and controls; state findings with claim types.", department: "finance", authority: "t1", cron: "30 7 * * 1-5", escalation: "department_manager", budget: "5.00", runCap: "0.25", outputs: ["Finding", "QuestionRequest"], quality: ["claim type on every finding", "no invented amounts", "max 2 questions per run"] },
  { key: "operations-agent", name: "COO & Operations Agent", mission: "Review planning, capacity, deliveries, returns and hand-offs; state findings with claim types.", department: "operations", authority: "t1", cron: "0 8 * * 1-5", escalation: "department_manager", budget: "5.00", runCap: "0.25", outputs: ["Finding", "QuestionRequest"], quality: ["claim type on every finding", "max 2 questions per run"] },
  { key: "process-redesign", name: "Process Redesign Agent", mission: "Reconstruct AS-IS from answers, design TO-BE with intervention labels, propose one opportunity for approval.", department: "cross-functional", authority: "t3", cron: null, escalation: "client_admin", budget: "5.00", runCap: "0.40", outputs: ["Opportunity"], quality: ["intervention label per changed step", "approval before any task"] },
  { key: "ceo-intelligence", name: "CEO Intelligence Agent", mission: "Discover decision needs, define KPIs with source and formula, produce a render-safe dashboard specification.", department: "management", authority: "t1", cron: null, escalation: "client_admin", budget: "5.00", runCap: "0.40", outputs: ["KpiDefinition", "DashboardSpecification"], quality: ["no KPI without source and formula", "widget whitelist only", "missing data shown as state"] },
  { key: "executive-briefing", name: "Executive Briefing Agent", mission: "Write the daily executive briefing with eight fixed sections and five to seven sourced priorities.", department: "management", authority: "t1", cron: "30 6 * * 1-5", escalation: "client_admin", budget: "5.00", runCap: "0.30", outputs: ["ExecutiveBriefing"], quality: ["exactly eight sections", "5 to 7 priorities", "every item sourced"] },
  { key: "performance-agent", name: "Performance & Continuous Improvement Agent", mission: "Verify approved actions and their effect; ask the owner when evidence is missing; never assume completion.", department: "management", authority: "t1", cron: null, escalation: "client_admin", budget: "5.00", runCap: "0.25", outputs: ["QuestionRequest"], quality: ["verified only with evidence", "owner question when evidence missing"] }
];

async function seedAgentCatalogue(handle: DbHandle): Promise<Catalogue> {
  const ctx = agencyContext({ tenantId: null, ...SYSTEM_ACTOR });
  return handle.withContext(ctx, async (tx) => {
    const definitions: Catalogue["definitions"] = {};
    for (const d of DEFINITIONS) {
      const { md, meta } = readSkillMd(d.key);
      const checksum = createHash("sha256").update(md).digest("hex");
      const [skill] = await tx.insert(skills).values({ key: d.key, name: meta.name || d.name, description: meta.description || d.mission }).onConflictDoNothing({ target: skills.key }).returning({ id: skills.id });
      const skillId = skill?.id ?? (await tx.select({ id: skills.id }).from(skills).where(sql`key = ${d.key}`))[0]!.id;
      const [version] = await tx.insert(skillVersions).values({ skillId, version: meta.version, skillMd: md, contracts: meta.contracts, allowedTools: meta.allowed_tools, releaseChannel: "stable", checksum, createdBy: "seed" }).onConflictDoNothing().returning({ id: skillVersions.id });
      const skillVersionId = version?.id ?? (await tx.select({ id: skillVersions.id }).from(skillVersions).where(sql`skill_id = ${skillId} and version = ${meta.version}`))[0]!.id;
      await tx.insert(skillReleaseChannels).values({ skillId, channel: "stable", skillVersionId, updatedBy: "seed" }).onConflictDoNothing();
      const [def] = await tx
        .insert(agentDefinitions)
        .values({ key: d.key, name: d.name, mission: d.mission, department: d.department, skillId, defaultModel: "claude-sonnet-5-5", modelPolicy: { default: "claude-sonnet-5-5", classification: "claude-haiku-5-5" }, allowedTools: meta.allowed_tools, requiredData: ["company_profile", "departments", "systems", "prior_questions", "answers", "facts"], authority: d.authority, defaultScheduleCron: d.cron, escalationRole: d.escalation, defaultBudgetUsdMonth: d.budget, defaultRunCapUsd: d.runCap, inputContracts: [], outputContracts: [...d.outputs, "AgentRunResult"], qualityCriteria: d.quality, ownerRole: "superadmin" })
        .onConflictDoNothing({ target: agentDefinitions.key })
        .returning({ id: agentDefinitions.id });
      const definitionId = def?.id ?? (await tx.select({ id: agentDefinitions.id }).from(agentDefinitions).where(sql`key = ${d.key}`))[0]!.id;
      definitions[d.key] = { definitionId, skillVersionId };
    }
    // Platform budget (ADR-016): USD 25 per month, hard stop.
    await tx.insert(budgets).values({ scope: "platform", capUsdMonth: "25.00", runCapUsd: "0.50" }).onConflictDoNothing();
    return { definitions };
  });
}

/** Activates agent instances for a tenant. The pilot tenant gets the full pool; others start with Discovery only. */
async function seedTenantAgents(handle: DbHandle, tenantId: string, slugPart: string, catalogue: Catalogue, fullPool: boolean): Promise<void> {
  const ctx = tenantContext({ tenantId, ...SYSTEM_ACTOR });
  const keys = fullPool ? DEFINITIONS.map((d) => d.key) : ["discovery-interview"];
  await handle.withContext(ctx, async (tx) => {
    await tx.insert(budgets).values({ tenantId, scope: "tenant", capUsdMonth: "10.00", runCapUsd: "0.50" }).onConflictDoNothing();
    for (const key of keys) {
      const cat = catalogue.definitions[key]!;
      const def = DEFINITIONS.find((d) => d.key === key)!;
      const serviceIdentity = `agent:${key}:${slugPart}`;
      const [inst] = await tx.insert(agentInstances).values({ tenantId, definitionId: cat.definitionId, skillVersionId: cat.skillVersionId, name: def.name, state: "idle", serviceIdentity }).onConflictDoNothing().returning({ id: agentInstances.id });
      const instanceId = inst?.id ?? (await tx.select({ id: agentInstances.id }).from(agentInstances).where(sql`service_identity = ${serviceIdentity}`))[0]!.id;
      await tx.insert(budgets).values({ tenantId, scope: "agent_instance", agentInstanceId: instanceId, capUsdMonth: def.budget, runCapUsd: def.runCap }).onConflictDoNothing();
      if (fullPool && def.cron) {
        const existing = await tx.select({ id: schedules.id }).from(schedules).where(sql`agent_instance_id = ${instanceId}`);
        if (existing.length === 0) {
          await tx.insert(schedules).values({ tenantId, agentInstanceId: instanceId, name: `${def.name} (weekdays)`, cron: def.cron, timezone: "UTC", enabled: key === "discovery-interview", expectedBySeconds: 900, instruction: `Scheduled run of ${def.name}` });
        }
      }
      if (inst) await writeAudit(tx, ctx, { action: "agent_instance.activated", entityType: "agent_instance", entityId: instanceId, after: { definition: key } });
    }
  });
}

const TECH_SOURCES: Array<{ key: string; name: string; kind: "github_releases" | "official_docs" | "security_advisory" | "standard"; fetchKind: "github_releases" | "manual"; url: string; agents: string[] }> = [
  { key: "mastra-releases", name: "Mastra releases", kind: "github_releases", fetchKind: "github_releases", url: "https://github.com/mastra-ai/mastra/releases", agents: ["all"] },
  { key: "pg-boss-releases", name: "pg-boss releases", kind: "github_releases", fetchKind: "github_releases", url: "https://github.com/timgit/pg-boss/releases", agents: ["worker"] },
  { key: "better-auth-releases", name: "Better Auth releases", kind: "github_releases", fetchKind: "github_releases", url: "https://github.com/better-auth/better-auth/releases", agents: ["web"] },
  { key: "nextjs-releases", name: "Next.js releases", kind: "github_releases", fetchKind: "github_releases", url: "https://github.com/vercel/next.js/releases", agents: ["web"] },
  { key: "drizzle-releases", name: "Drizzle ORM releases", kind: "github_releases", fetchKind: "github_releases", url: "https://github.com/drizzle-team/drizzle-orm/releases", agents: ["db"] },
  { key: "anthropic-model-docs", name: "Anthropic model documentation", kind: "official_docs", fetchKind: "manual", url: "https://docs.anthropic.com/", agents: ["all"] },
  { key: "owasp-llm-top10", name: "OWASP Top 10 for LLM applications", kind: "standard", fetchKind: "manual", url: "https://owasp.org/www-project-top-10-for-large-language-model-applications/", agents: ["all"] }
];

async function seedTechSources(handle: DbHandle): Promise<void> {
  const ctx = agencyContext({ tenantId: null, ...SYSTEM_ACTOR });
  await handle.withContext(ctx, async (tx) => {
    for (const s of TECH_SOURCES) {
      const [row] = await tx
        .insert(techSources)
        .values({ key: s.key, name: s.name, kind: s.kind, fetchKind: s.fetchKind, url: s.url, approved: true, approvedBy: SYSTEM_ACTOR.actorId, approvedAt: new Date(), relevantAgentKeys: s.agents, checkIntervalHours: 24, createdByActorId: SYSTEM_ACTOR.actorId })
        .onConflictDoNothing({ target: techSources.key })
        .returning({ id: techSources.id });
      if (row) await writeAudit(tx, ctx, { action: "tech_source.seeded", entityType: "tech_source", entityId: row.id, after: { key: s.key, approved: true } });
    }
  });
}
