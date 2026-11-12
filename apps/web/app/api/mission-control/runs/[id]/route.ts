import { isUuid } from "@/lib/live/helpers";
import { getLiveRunDetail } from "@/lib/live/run-detail";
import { resolveOperatorContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Run detail for the Live inspector drawer (ADR-024, slice 2). Same gate as the snapshot and stream routes: operator
 * with MFA, otherwise 401 JSON. 400 for a malformed id, 404 when the run does not exist. The body is the operator
 * view only (RLS and column grants decide), never checkpoint, result or event payloads.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const ctx = await resolveOperatorContext();
  if (!ctx) return Response.json({ error: "operator session with MFA required" }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: "run id must be a UUID" }, { status: 400 });
  const detail = await getLiveRunDetail(ctx, id);
  if (!detail) return Response.json({ error: "run not found" }, { status: 404 });
  return Response.json(detail, { headers: { "Cache-Control": "no-store" } });
}
