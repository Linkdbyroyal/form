import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { betterAuthSchema } from "@sbos/db/schema";

export type AuthDb = NodePgDatabase<typeof betterAuthSchema>;

/**
 * Dedicated owner-level pool for Better Auth. It touches ONLY schema `auth` (identity data, not
 * tenant-scoped) and never goes through `withContext()`. Connects as DATABASE_URL_AUTH, falling back
 * to DATABASE_URL_MIGRATE and then DATABASE_URL (in dev all three are the schema owner `sbos`).
 *
 * The connecting role is not a superuser and has no BYPASSRLS, so this pool cannot read or write the
 * RLS-forced `public` tables at all: every bridge write to `public.*` goes through `withContext()`.
 */
const globalForAuthDb = globalThis as unknown as { __sbosAuthDb?: { pool: pg.Pool; db: AuthDb } };

export function authDatabaseUrl(): string {
  const url = process.env.DATABASE_URL_AUTH ?? process.env.DATABASE_URL_MIGRATE ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_AUTH, DATABASE_URL_MIGRATE or DATABASE_URL must be set for the auth pool");
  return url;
}

export function getAuthDb(): AuthDb {
  if (!globalForAuthDb.__sbosAuthDb) {
    const pool = new pg.Pool({ connectionString: authDatabaseUrl(), max: 3 });
    globalForAuthDb.__sbosAuthDb = { pool, db: drizzle(pool, { schema: betterAuthSchema }) };
  }
  return globalForAuthDb.__sbosAuthDb.db;
}

export async function closeAuthDb(): Promise<void> {
  const current = globalForAuthDb.__sbosAuthDb;
  if (!current) return;
  globalForAuthDb.__sbosAuthDb = undefined;
  await current.pool.end();
}
