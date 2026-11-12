import { LiveBoard } from "@/components/live/live-board";
import { firstParam } from "@/lib/format";
import { isUuid, parseLiveTab } from "@/lib/live/helpers";
import { getLiveSnapshot } from "@/lib/live/queries";
import { requireOperatorContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

/**
 * Live Agent Mission Control (ADR-024): slice 1 Command Queue, slice 2 Run Inspector. The server renders the first
 * snapshot in operator context; the client board then follows the event stream (PostgreSQL LISTEN/NOTIFY -> SSE) and
 * falls back to polling. `?tab=` and `?run=` restore the tab and the open drawer after a server action redirect.
 */
export default async function LivePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireOperatorContext();
  const sp = await searchParams;
  const snapshot = await getLiveSnapshot(ctx);
  const run = firstParam(sp.run);
  return (
    <LiveBoard
      initial={snapshot}
      ok={firstParam(sp.ok)}
      error={firstParam(sp.error)}
      operatorRoles={[...ctx.roles]}
      initialTab={parseLiveTab(firstParam(sp.tab))}
      initialRunId={isUuid(run) ? run : null}
    />
  );
}
