import { LiveBoard } from "@/components/live/live-board";
import { firstParam } from "@/lib/format";
import { getLiveSnapshot } from "@/lib/live/queries";
import { requireOperatorContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

/**
 * Live Agent Mission Control, slice 1 (ADR-024): the Command Queue. The server renders the first snapshot in operator
 * context; the client board then follows the event stream (PostgreSQL LISTEN/NOTIFY -> SSE) and falls back to polling.
 */
export default async function LivePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireOperatorContext();
  const sp = await searchParams;
  const snapshot = await getLiveSnapshot(ctx);
  return <LiveBoard initial={snapshot} ok={firstParam(sp.ok)} error={firstParam(sp.error)} operatorRoles={[...ctx.roles]} />;
}
