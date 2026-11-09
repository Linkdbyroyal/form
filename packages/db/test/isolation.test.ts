import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/client";
import { operatorContext, tenantContext } from "../src/context";
import { runMigrations } from "../src/migrate";
import { seed, type SeedResult } from "../src/seed";
import { auditEvents, departments, systems, tenants } from "../src/schema/index";

const url = process.env.DATABASE_URL_TEST ?? "postgres://sbos:sbos@localhost:5432/sbos_test";

let handle: DbHandle;
let seeded: SeedResult;
let tenantA: string;
let tenantB: string;

const actor = { actorType: "user" as const, actorId: "00000000-0000-0000-0000-000000000001", roles: ["client_ceo"] };

beforeAll(async () => {
  await runMigrations(url);
  handle = createDb({ connectionString: url, max: 4 });
  seeded = await seed(handle);
  tenantA = seeded.tenantIds["northline-events"]!;
  tenantB = seeded.tenantIds["harbour-view-hotel"]!;
});

afterAll(async () => {
  await handle.close();
});

describe("schema guard", () => {
  it("every table with a tenant_id column has RLS enabled and forced", async () => {
    const rows = await handle.db.execute<{ table_name: string; rowsecurity: boolean; forcerowsecurity: boolean }>(sql`
      SELECT c.table_name, cls.relrowsecurity AS rowsecurity, cls.relforcerowsecurity AS forcerowsecurity
      FROM information_schema.columns c
      JOIN pg_class cls ON cls.relname = c.table_name
      JOIN pg_namespace ns ON ns.oid = cls.relnamespace AND ns.nspname = 'public'
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND cls.relkind = 'r'
    `);
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const r of rows.rows) {
      expect(r.rowsecurity, `${r.table_name} rowsecurity`).toBe(true);
      expect(r.forcerowsecurity, `${r.table_name} forcerowsecurity`).toBe(true);
    }
  });
});

describe("tenant isolation", () => {
  it("tenant A sees only its own departments and systems", async () => {
    const a = await handle.withContext(tenantContext({ tenantId: tenantA, ...actor }), async (tx) => ({
      departments: await tx.select().from(departments),
      systems: await tx.select().from(systems),
      tenants: await tx.select().from(tenants)
    }));
    expect(a.departments.length).toBe(4);
    expect(a.systems.map((s) => s.name)).toContain("Rentman");
    expect(a.systems.map((s) => s.name)).not.toContain("Point of Sale");
    expect(a.departments.every((d) => d.tenantId === tenantA)).toBe(true);
    expect(a.tenants.map((t) => t.id)).toEqual([tenantA]);
  });

  it("tenant B sees only its own rows", async () => {
    const b = await handle.withContext(tenantContext({ tenantId: tenantB, ...actor }), async (tx) => tx.select().from(systems));
    expect(b.map((s) => s.name)).toContain("Point of Sale");
    expect(b.map((s) => s.name)).not.toContain("Rentman");
  });

  it("tenant A cannot insert a row that claims tenant B", async () => {
    await expectDbError(handle.withContext(tenantContext({ tenantId: tenantA, ...actor }), (tx) =>
        tx.insert(departments).values({ tenantId: tenantB, key: "smuggled", name: "Smuggled" })
      ), /row-level security/);
  });

  it("tenant A cannot update or delete tenant B rows (zero rows affected)", async () => {
    const updated = await handle.withContext(tenantContext({ tenantId: tenantA, ...actor }), (tx) =>
      tx.update(systems).set({ vendor: "hacked" }).where(sql`tenant_id = ${tenantB}`).returning({ id: systems.id })
    );
    expect(updated).toEqual([]);
    const deleted = await handle.withContext(tenantContext({ tenantId: tenantA, ...actor }), (tx) =>
      tx.delete(departments).where(sql`tenant_id = ${tenantB}`).returning({ id: departments.id })
    );
    expect(deleted).toEqual([]);
  });

  it("a transaction without tenant context sees nothing (fail closed)", async () => {
    const rows = await handle.db.transaction(async (tx) => {
      await tx.execute(sql.raw("SET LOCAL ROLE sbos_app"));
      return tx.select().from(systems);
    });
    expect(rows).toEqual([]);
  });

  it("context does not leak between pooled transactions", async () => {
    await handle.withContext(tenantContext({ tenantId: tenantA, ...actor }), (tx) => tx.select().from(systems));
    const afterwards = await handle.db.execute<{ tenant: string | null; role: string }>(
      sql`SELECT current_setting('app.tenant_id', true) AS tenant, current_user AS role`
    );
    expect(afterwards.rows[0]?.tenant ?? "").toBe("");
    expect(afterwards.rows[0]?.role).not.toBe("sbos_app");
  });
});

describe("operator role", () => {
  const op = operatorContext({ actorType: "user", actorId: seededOperatorId(), roles: ["agency_operator"] });

  it("sees tenant headers for all clients", async () => {
    const rows = await handle.withContext(op, (tx) => tx.select({ slug: tenants.slug }).from(tenants));
    expect(rows.map((r) => r.slug).sort()).toEqual(["harbour-view-hotel", "northline-events", "second-brain-agency"]);
  });

  it("can read system metadata but not the content column `notes`", async () => {
    const meta = await handle.withContext(op, (tx) => tx.select({ name: systems.name, claim: systems.claimStatus }).from(systems));
    expect(meta.length).toBeGreaterThan(0);
    await expectDbError(handle.withContext(op, (tx) => tx.select({ notes: systems.notes }).from(systems)), /permission denied/);
  });

  it("cannot modify tenant content", async () => {
    await expectDbError(handle.withContext(op, (tx) => tx.insert(departments).values({ tenantId: tenantA, key: "x", name: "x" })), /permission denied/);
  });
});

describe("audit trail", () => {
  it("is append-only for the application role", async () => {
    const ctx = tenantContext({ tenantId: tenantA, ...actor });
    const [row] = await handle.withContext(ctx, (tx) =>
      tx
        .insert(auditEvents)
        .values({ tenantId: tenantA, actorType: "user", actorId: actor.actorId, action: "test.insert", entityType: "test" })
        .returning({ id: auditEvents.id })
    );
    expect(row?.id).toBeDefined();
    await expectDbError(handle.withContext(ctx, (tx) => tx.update(auditEvents).set({ action: "tampered" }).where(sql`id = ${row!.id}`)), /permission denied/);
    await expectDbError(handle.withContext(ctx, (tx) => tx.delete(auditEvents).where(sql`id = ${row!.id}`)), /permission denied/);
  });

  it("tenant A cannot write an audit row for tenant B", async () => {
    await expectDbError(handle.withContext(tenantContext({ tenantId: tenantA, ...actor }), (tx) =>
        tx.insert(auditEvents).values({ tenantId: tenantB, actorType: "user", actorId: "x", action: "x", entityType: "x" })
      ), /row-level security/);
  });
});


/** Drizzle wraps driver errors as "Failed query: ..." with the Postgres error in `cause`. Match either. */
async function expectDbError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected the query to fail").not.toBeNull();
  const e = caught as { message?: string; cause?: { message?: string } };
  const text = `${e.message ?? ""} :: ${e.cause?.message ?? ""}`;
  expect(text).toMatch(pattern);
}

function seededOperatorId(): string {
  return "00000000-0000-0000-0000-00000000000a";
}
