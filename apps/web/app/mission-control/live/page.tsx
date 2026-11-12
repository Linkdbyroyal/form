import { LiveBoard } from "@/components/live/live-board";
import { firstParam } from "@/lib/format";
import { isUuid, parseLiveTab } from "@/lib/live/helpers";
import { getLiveSnapshot } from "@/lib/live/queries";
import { requireOperatorContext } from "@/lib/request-context";

export const dynamic = "force-dynamic";

/**
 * Live Agent Mission Control (ADR-024): slice 1 Command Queue, slice 2 Run Inspector, slice 3 Flight Map, slice 4
 * Operations Deck. The server renders the first snapshot in operator context; the client board then follows the event
 * stream (PostgreSQL LISTEN/NOTIFY -> SSE) and falls back to polling. `?tab=`, `?run=` and `?department=` restore the
 * tab, the open drawer and the department filter after a server action redirect.
 */
export default async function LivePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireOperatorContext();
  const sp = await searchParams;
  const snapshot = await getLiveSnapshot(ctx);
  const run = firstParam(sp.run);
  const department = firstParam(sp.department);
  return (
    <LiveBoard
      initial={snapshot}
      ok={firstParam(sp.ok)}
      error={firstParam(sp.error)}
      operatorRoles={[...ctx.roles]}
      initialTab={parseLiveTab(firstParam(sp.tab))}
      initialRunId={isUuid(run) ? run : null}
      initialDepartment={department && department.length <= 100 ? department : null}
    />
  );
}
