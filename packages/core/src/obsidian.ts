import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import YAML from "yaml";
import { and, eq } from "drizzle-orm";
import { schema, writeAudit, type RequestContext, type Tx } from "@sbos/db";
import { syncDocumentLinks } from "./knowledge";
import { writeVaultDocument } from "./vault";

const { vaultDocuments } = schema;

/**
 * Obsidian-compatible Markdown: YAML frontmatter between `---` fences, body with [[wikilinks]].
 * The vault folder taxonomy maps 1:1 to folders in the zip, so a tenant vault opens directly as an Obsidian vault.
 */
export function serializeMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  const fm = Object.keys(frontmatter).length === 0 ? "" : `---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n\n`;
  return `${fm}${body.endsWith("\n") ? body : `${body}\n`}`;
}

export function parseMarkdown(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { frontmatter: {}, body: text };
  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = YAML.parse(m[1]!);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) frontmatter = parsed as Record<string, unknown>;
  } catch {
    frontmatter = { _frontmatter_parse_error: true, _raw: m[1] };
  }
  return { frontmatter, body: text.slice(m[0].length).replace(/^\n/, "") };
}

const VAULT_PATH_RE = /^(0\d|1\d)_[a-z0-9_]+\/[A-Za-z0-9._/-]+\.md$/;

export function isValidVaultPath(path: string): boolean {
  return VAULT_PATH_RE.test(path) && !path.includes("..") && !path.startsWith("/");
}

/** Exports every document the context may read as a zip of Markdown files (RLS decides visibility). */
export async function exportVaultZip(tx: Tx, ctx: RequestContext, input: { tenantId: string }): Promise<{ zip: Uint8Array; count: number }> {
  const docs = await tx
    .select({ path: vaultDocuments.path, title: vaultDocuments.title, frontmatter: vaultDocuments.frontmatter, body: vaultDocuments.bodyMarkdown, classification: vaultDocuments.classification, verification: vaultDocuments.verification, version: vaultDocuments.version, updatedAt: vaultDocuments.updatedAt })
    .from(vaultDocuments)
    .where(eq(vaultDocuments.tenantId, input.tenantId));
  const files: Record<string, Uint8Array> = {};
  for (const d of docs) {
    const fm = { title: d.title, ...(d.frontmatter as Record<string, unknown>), sbos_classification: d.classification, sbos_verification: d.verification, sbos_version: d.version, sbos_updated_at: d.updatedAt.toISOString() };
    files[d.path] = strToU8(serializeMarkdown(fm, d.body));
  }
  files["README.md"] = strToU8(`# Second Brain Knowledge Vault export\n\nExported ${new Date().toISOString()} by ${ctx.actorType}:${ctx.actorId}. ${docs.length} documents. Open this folder as an Obsidian vault. Fields prefixed sbos_ are platform metadata and are ignored on import.\n`);
  await writeAudit(tx, ctx, { action: "vault.exported", entityType: "tenant", entityId: input.tenantId, after: { documents: docs.length } });
  return { zip: zipSync(files, { level: 6 }), count: docs.length };
}

export interface ImportResult {
  imported: string[];
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * Imports Markdown files from a zip or folder listing into the vault as new revisions (human import, direct write).
 * Paths must follow the vault taxonomy; anything else is reported and skipped. Platform fields (`sbos_*`) are dropped.
 */
export async function importVaultZip(tx: Tx, ctx: RequestContext, input: { tenantId: string; zip: Uint8Array; changeNote?: string }): Promise<ImportResult> {
  const entries = unzipSync(input.zip);
  return importMarkdownFiles(tx, ctx, { tenantId: input.tenantId, files: Object.entries(entries).map(([path, data]) => ({ path, text: strFromU8(data) })), changeNote: input.changeNote });
}

export async function importMarkdownFiles(tx: Tx, ctx: RequestContext, input: { tenantId: string; files: Array<{ path: string; text: string }>; changeNote?: string }): Promise<ImportResult> {
  const result: ImportResult = { imported: [], skipped: [] };
  for (const f of input.files) {
    const path = f.path.replace(/^\.?\//, "").replace(/^[^/]*\/(?=(0\d|1\d)_)/, "");
    if (path.endsWith("/") || path === "README.md") continue;
    if (!path.endsWith(".md")) {
      result.skipped.push({ path: f.path, reason: "not a markdown file" });
      continue;
    }
    if (!isValidVaultPath(path)) {
      result.skipped.push({ path: f.path, reason: "path outside the vault taxonomy (<NN_folder>/<name>.md)" });
      continue;
    }
    if (f.text.length > 2_000_000) {
      result.skipped.push({ path: f.path, reason: "file larger than 2 MB" });
      continue;
    }
    const { frontmatter, body } = parseMarkdown(f.text);
    const title = typeof frontmatter.title === "string" && frontmatter.title.trim() ? frontmatter.title.trim() : (/^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? path.split("/").pop()!.replace(/\.md$/, ""));
    const cleaned = Object.fromEntries(Object.entries(frontmatter).filter(([k]) => !k.startsWith("sbos_") && k !== "title"));
    const [existing] = await tx.select({ id: vaultDocuments.id, checksum: vaultDocuments.checksum }).from(vaultDocuments).where(and(eq(vaultDocuments.tenantId, input.tenantId), eq(vaultDocuments.path, path)));
    const r = await writeVaultDocument(tx, ctx, { tenantId: input.tenantId, path, title, frontmatter: cleaned, bodyMarkdown: body, changeNote: input.changeNote ?? `imported${existing ? " (update)" : ""}` });
    await syncDocumentLinks(tx, input.tenantId, r.documentId, body);
    result.imported.push(path);
  }
  await writeAudit(tx, ctx, { action: "vault.imported", entityType: "tenant", entityId: input.tenantId, after: { imported: result.imported.length, skipped: result.skipped.length } });
  return result;
}
