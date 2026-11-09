import { exportVaultZip } from "@sbos/core";
import { getDb } from "@/lib/db";
import { requireTenantContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

/** Downloads the tenant vault as an Obsidian-compatible zip. RLS decides which documents the caller may export. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const resolved = await requireTenantContext(slug);
  if (!resolved) return new Response("Not found", { status: 404 });
  const ctx = resolved.ctx;
  if (resolved.viaGrant) return new Response("Export is not available under a break-glass grant.", { status: 403 });
  const { zip, count } = await getDb().withContext(ctx, (tx) => exportVaultZip(tx, ctx, { tenantId: ctx.tenantId }));
  const body = new Uint8Array(zip);
  return new Response(body, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${slug}-vault-${new Date().toISOString().slice(0, 10)}.zip"`,
      "x-sbos-documents": String(count)
    }
  });
}
