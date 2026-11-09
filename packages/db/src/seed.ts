import { sql } from "drizzle-orm";
import { createDb, type DbHandle } from "./client";
import { agencyContext, tenantContext } from "./context";
import { writeAudit } from "./audit";
import { departments, memberships, systems, tenants, users } from "./schema/index";

/**
 * Synthetic seed data. Two demo client tenants and the agency tenant. No real company data.
 * Idempotent: re-running updates nothing and inserts only what is missing.
 */
export interface SeedResult {
  agencyTenantId: string;
  tenantIds: Record<string, string>;
  userIds: Record<string, string>;
}

const SYSTEM_ACTOR = { actorType: "system" as const, actorId: "seed", roles: ["agency_superadmin"] };

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
    { slug: "second-brain-agency", email: "operator@secondbrain.test", role: "agency_superadmin" },
    { slug: "northline-events", email: "ceo@northline.test", role: "client_ceo" },
    { slug: "northline-events", email: "finance@northline.test", role: "client_manager", department: "finance" },
    { slug: "harbour-view-hotel", email: "ceo@harbourview.test", role: "client_ceo" }
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
    { key: "management", name: "Management", headRole: "client_ceo" },
    { key: "sales", name: "Sales and Quotes", headRole: "client_manager" },
    { key: "operations", name: "Operations and Warehouse", headRole: "client_manager" },
    { key: "finance", name: "Finance", headRole: "client_manager" }
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
    { key: "management", name: "Management", headRole: "client_ceo" },
    { key: "front_office", name: "Front Office and Reservations", headRole: "client_manager" },
    { key: "food_beverage", name: "Food and Beverage", headRole: "client_manager" },
    { key: "finance", name: "Finance", headRole: "client_manager" }
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
