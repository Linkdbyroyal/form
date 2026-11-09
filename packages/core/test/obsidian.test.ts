import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { createDb, tenantContext, runMigrations, type DbHandle } from "@sbos/db";
import { seed } from "@sbos/db/seed";
import { exportVaultZip, importVaultZip, parseMarkdown, serializeMarkdown, writeVaultDocument, isValidVaultPath, backlinks } from "../src/index";
import { zipSync, strToU8 } from "fflate";
import { sql } from "drizzle-orm";
import { schema } from "@sbos/db";

const url = process.env.DATABASE_URL_TEST ?? "postgres://sbos:sbos@localhost:5432/sbos_test";
let handle: DbHandle;
let tenantA: string;
let tenantB: string;
const ceo = { actorType: "user" as const, actorId: "ceo-a", roles: ["client_admin"] };

beforeAll(async () => {
  await runMigrations(url);
  handle = createDb({ connectionString: url, max: 2 });
  const s = await seed(handle);
  tenantA = s.tenantIds["northline-events"]!;
  tenantB = s.tenantIds["harbour-view-hotel"]!;
});
afterAll(async () => handle.close());

describe("markdown frontmatter", () => {
  it("round-trips frontmatter and body", () => {
    const text = serializeMarkdown({ title: "Quote to cash", tags: ["finance", "process"], confidence: 0.7 }, "# Quote to cash\n\nBody with [[06_finance/export-billing]].");
    const parsed = parseMarkdown(text);
    expect(parsed.frontmatter).toEqual({ title: "Quote to cash", tags: ["finance", "process"], confidence: 0.7 });
    expect(parsed.body.startsWith("# Quote to cash")).toBe(true);
    expect(parseMarkdown("no frontmatter here").frontmatter).toEqual({});
  });
  it("validates vault paths", () => {
    expect(isValidVaultPath("04_processes_as_is/export-sample.md")).toBe(true);
    expect(isValidVaultPath("../etc/passwd.md")).toBe(false);
    expect(isValidVaultPath("notes/random.md")).toBe(false);
  });
});

describe("export and import", () => {
  it("exports only the tenant's documents and re-imports them as new revisions with links resolved", async () => {
    const ctxA = tenantContext({ tenantId: tenantA, ...ceo });
    const ctxB = tenantContext({ tenantId: tenantB, ...ceo });
    await handle.withContext(ctxA, (tx) => writeVaultDocument(tx, ctxA, { tenantId: tenantA, path: "04_processes_as_is/export-sample.md", title: "Export sample", frontmatter: { tags: ["finance"] }, bodyMarkdown: "See [[06_finance/export-billing]]." }));
    await handle.withContext(ctxA, (tx) => writeVaultDocument(tx, ctxA, { tenantId: tenantA, path: "06_finance/export-billing.md", title: "Export billing", frontmatter: {}, bodyMarkdown: "Billing runs weekly." }));
    await handle.withContext(ctxB, (tx) => writeVaultDocument(tx, ctxB, { tenantId: tenantB, path: "04_processes_as_is/export-checkin.md", title: "Export check-in", frontmatter: {}, bodyMarkdown: "Hotel only." }));

    const exported = await handle.withContext(ctxA, (tx) => exportVaultZip(tx, ctxA, { tenantId: tenantA }));
    const files = unzipSync(exported.zip);
    const names = Object.keys(files);
    expect(names).toEqual(expect.arrayContaining(["04_processes_as_is/export-sample.md", "06_finance/export-billing.md", "README.md"]));
    expect(names).not.toContain("04_processes_as_is/export-checkin.md");
    expect(exported.count).toBe(names.length - 1);
    const q2c = parseMarkdown(strFromU8(files["04_processes_as_is/export-sample.md"]!));
    expect(q2c.frontmatter.title).toBe("Export sample");
    expect(q2c.frontmatter.sbos_verification).toBe("unconfirmed");
    expect(q2c.frontmatter.tags).toEqual(["finance"]);

    // Import into tenant B: documents arrive as tenant B revisions; platform fields are dropped; bad paths are skipped.
    const zip = zipSync({
      "MyVault/04_processes_as_is/export-sample.md": files["04_processes_as_is/export-sample.md"]!,
      "MyVault/06_finance/export-billing.md": files["06_finance/export-billing.md"]!,
      "MyVault/random/notes.md": strToU8("# Loose note"),
      "MyVault/image.png": strToU8("binary")
    });
    const result = await handle.withContext(ctxB, (tx) => importVaultZip(tx, ctxB, { tenantId: tenantB, zip }));
    expect(result.imported.sort()).toEqual(["04_processes_as_is/export-sample.md", "06_finance/export-billing.md"]);
    expect(result.skipped.map((s) => s.path).sort()).toEqual(["MyVault/image.png", "MyVault/random/notes.md"]);
    const docsB = await handle.withContext(ctxB, (tx) => tx.select({ path: schema.vaultDocuments.path, frontmatter: schema.vaultDocuments.frontmatter, id: schema.vaultDocuments.id }).from(schema.vaultDocuments).where(sql`path = '04_processes_as_is/export-sample.md'`));
    expect(docsB.length).toBe(1);
    expect(docsB[0]!.frontmatter).toEqual({ tags: ["finance"] });
    const invoicingB = await handle.withContext(ctxB, (tx) => tx.select({ id: schema.vaultDocuments.id }).from(schema.vaultDocuments).where(sql`path = '06_finance/export-billing.md'`));
    const back = await handle.withContext(ctxB, (tx) => backlinks(tx, tenantB, invoicingB[0]!.id));
    expect(back.map((b) => b.path)).toEqual(["04_processes_as_is/export-sample.md"]);
  });
});
