import { importVaultZip } from "@sbos/core";
import { getDb } from "@/lib/db";
import { requireTenantContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";
const MAX_ZIP_BYTES = 25 * 1024 * 1024;

/** Imports Markdown files from an uploaded zip (Obsidian export). Only client_admin and department_manager may import. */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const resolved = await requireTenantContext(slug);
  if (!resolved) return new Response("Not found", { status: 404 });
  const ctx = resolved.ctx;
  const base = `/c/${slug}/vault`;
  if (resolved.viaGrant || !ctx.roles.some((r) => r === "client_admin" || r === "department_manager")) {
    return Response.redirect(new URL(`${base}?error=${encodeURIComponent("Import requires the client admin or department manager role.")}`, req.url), 303);
  }
  const form = await req.formData();
  const file = form.get("archive");
  if (!(file instanceof File) || file.size === 0) return Response.redirect(new URL(`${base}?error=${encodeURIComponent("Choose a zip file to import.")}`, req.url), 303);
  if (file.size > MAX_ZIP_BYTES) return Response.redirect(new URL(`${base}?error=${encodeURIComponent("Zip larger than 25 MB.")}`, req.url), 303);
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const result = await getDb().withContext(ctx, (tx) => importVaultZip(tx, ctx, { tenantId: ctx.tenantId, zip: bytes, changeNote: `imported from ${file.name}` }));
    const msg = `Imported ${result.imported.length} document(s)${result.skipped.length ? `, skipped ${result.skipped.length} (${result.skipped.slice(0, 3).map((s) => `${s.path}: ${s.reason}`).join("; ")})` : ""}.`;
    return Response.redirect(new URL(`${base}?ok=${encodeURIComponent(msg)}`, req.url), 303);
  } catch (err) {
    return Response.redirect(new URL(`${base}?error=${encodeURIComponent((err as Error).message.slice(0, 300))}`, req.url), 303);
  }
}
