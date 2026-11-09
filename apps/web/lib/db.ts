import { createDb, type DbHandle } from "@sbos/db";
import { requireEnv } from "./env";

// One pool per server process. Next.js may evaluate modules more than once in dev, so cache on globalThis.
const globalForDb = globalThis as unknown as { __sbosDb?: DbHandle };

export function getDb(): DbHandle {
  if (!globalForDb.__sbosDb) {
    globalForDb.__sbosDb = createDb({ connectionString: requireEnv("DATABASE_URL"), max: 5 });
  }
  return globalForDb.__sbosDb;
}
