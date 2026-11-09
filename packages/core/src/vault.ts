import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema, type RequestContext, type Tx } from "@sbos/db";

const { vaultDocuments, vaultRevisions } = schema;

export interface WriteVaultDocumentInput {
  tenantId: string;
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  bodyMarkdown: string;
  classification?: "public" | "internal" | "confidential" | "restricted";
  verification?: "unconfirmed" | "hypothesis" | "evidence_backed" | "verified" | "approved_policy";
  runId?: string | null;
  changeNote?: string;
}

const PATH_RE = /^(0\d|1\d)_[a-z0-9_]+\/[A-Za-z0-9._/-]+\.md$/;

/** Creates or updates a Markdown document and records an immutable revision. Minimal M1 version; M2 adds facts, links and search. */
export async function writeVaultDocument(tx: Tx, ctx: RequestContext, input: WriteVaultDocumentInput): Promise<{ documentId: string; version: number }> {
  if (!PATH_RE.test(input.path)) throw new Error(`vault path "${input.path}" must be <NN_folder>/<name>.md`);
  const checksum = createHash("sha256").update(JSON.stringify(input.frontmatter)).update("\n").update(input.bodyMarkdown).digest("hex");
  const [existing] = await tx.select({ id: vaultDocuments.id, version: vaultDocuments.version }).from(vaultDocuments).where(and(eq(vaultDocuments.tenantId, input.tenantId), eq(vaultDocuments.path, input.path)));
  let documentId: string;
  let version: number;
  if (existing) {
    version = existing.version + 1;
    documentId = existing.id;
    await tx
      .update(vaultDocuments)
      .set({ title: input.title, frontmatter: input.frontmatter, bodyMarkdown: input.bodyMarkdown, classification: input.classification ?? "confidential", verification: input.verification ?? "unconfirmed", version, checksum, updatedByActorId: ctx.actorId })
      .where(eq(vaultDocuments.id, documentId));
  } else {
    version = 1;
    const [row] = await tx
      .insert(vaultDocuments)
      .values({
        tenantId: input.tenantId,
        path: input.path,
        title: input.title,
        frontmatter: input.frontmatter,
        bodyMarkdown: input.bodyMarkdown,
        classification: input.classification ?? "confidential",
        verification: input.verification ?? "unconfirmed",
        version,
        checksum,
        createdByActorType: ctx.actorType,
        createdByActorId: ctx.actorId,
        updatedByActorId: ctx.actorId
      })
      .returning({ id: vaultDocuments.id });
    if (!row) throw new Error("vault insert returned nothing");
    documentId = row.id;
  }
  await tx.insert(vaultRevisions).values({
    tenantId: input.tenantId,
    documentId,
    version,
    frontmatter: input.frontmatter,
    bodyMarkdown: input.bodyMarkdown,
    checksum,
    changedByActorType: ctx.actorType,
    changedByActorId: ctx.actorId,
    changeNote: input.changeNote ?? null,
    runId: input.runId ?? null
  });
  return { documentId, version };
}
