import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import * as schema from "./schema/index";
import { assertUuid, type RequestContext } from "./context";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface DbHandle {
  pool: pg.Pool;
  db: Db;
  /** Run `fn` inside a transaction whose role and `app.*` settings come from `ctx`. The only sanctioned way to touch tenant data. */
  withContext<T>(ctx: RequestContext, fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  connectionString: string;
  max?: number;
}

/**
 * Creates a pooled connection. The connecting role must be able to `SET ROLE sbos_app` and
 * `SET ROLE sbos_operator` (granted by migration 0001). All settings are `SET LOCAL`, so they
 * end with the transaction and never leak to another request sharing the pooled connection.
 */
export function createDb(options: CreateDbOptions): DbHandle {
  const pool = new pg.Pool({ connectionString: options.connectionString, max: options.max ?? 10 });
  const db = drizzle(pool, { schema });

  async function withContext<T>(ctx: RequestContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await applyContext(tx, ctx);
      return fn(tx);
    });
  }

  return {
    pool,
    db,
    withContext,
    close: () => pool.end()
  };
}

async function applyContext(tx: Tx, ctx: RequestContext): Promise<void> {
  const role = ctx.kind === "operator" ? "sbos_operator" : "sbos_app";
  const scope = ctx.kind === "tenant" ? "tenant" : "agency";
  const tenantId = ctx.kind === "operator" ? null : ctx.tenantId;
  if (tenantId !== null) assertUuid(tenantId, "tenantId");

  // Role names are constants, never user input; settings values go through set_config as parameters.
  await tx.execute(sql.raw(`SET LOCAL ROLE ${role}`));
  await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId ?? ""}, true)`);
  await tx.execute(sql`SELECT set_config('app.actor_id', ${ctx.actorId}, true)`);
  await tx.execute(sql`SELECT set_config('app.actor_type', ${ctx.actorType}, true)`);
  await tx.execute(sql`SELECT set_config('app.actor_scope', ${scope}, true)`);
  await tx.execute(sql`SELECT set_config('app.roles', ${ctx.roles.join(",")}, true)`);
}

/** Connection string resolution shared by app, worker and CLIs. */
export function databaseUrlFromEnv(kind: "app" | "test" | "migrate" = "app"): string {
  const key = kind === "test" ? "DATABASE_URL_TEST" : kind === "migrate" ? "DATABASE_URL_MIGRATE" : "DATABASE_URL";
  const value = process.env[key] ?? (kind === "migrate" ? process.env.DATABASE_URL : undefined);
  if (!value) throw new Error(`${key} is not set`);
  return value;
}
