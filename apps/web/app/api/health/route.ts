import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Liveness + database reachability. Returns no tenant data. */
export async function GET() {
  const started = Date.now();
  try {
    const db = getDb();
    const r = await db.db.execute<{ ok: number; migrations: number }>(sql`SELECT 1 AS ok, (SELECT count(*) FROM schema_migrations) AS migrations`);
    return Response.json({ status: "ok", database: "reachable", migrations: Number(r.rows[0]?.migrations ?? 0), latency_ms: Date.now() - started, version: "0.1.0" });
  } catch (err) {
    return Response.json({ status: "degraded", database: "unreachable", error: (err as Error).message }, { status: 503 });
  }
}
