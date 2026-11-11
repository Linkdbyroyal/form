import { getLiveSnapshot } from "@/lib/live/queries";
import { resolveOperatorContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Polling fallback for the live board when the event stream is unavailable. Same gate and the same snapshot as the stream. */
export async function GET(): Promise<Response> {
  const ctx = await resolveOperatorContext();
  if (!ctx) return Response.json({ error: "operator session with MFA required" }, { status: 401 });
  const snapshot = await getLiveSnapshot(ctx);
  return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
}
