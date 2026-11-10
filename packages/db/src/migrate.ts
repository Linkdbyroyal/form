import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, "..", "migrations");

/**
 * Minimal forward-only SQL migration runner. Each file runs in its own transaction and is
 * recorded in `schema_migrations`. Files are applied in lexical order (0001_, 0002_, ...).
 */
export async function runMigrations(connectionString: string, log: (msg: string) => void = () => {}): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const done = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const body = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      log(`applying ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(body);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

/** Drops everything in `public` and `auth` so a database can be rebuilt from migrations (dev/test only). */
export async function resetDatabase(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS auth CASCADE");
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await client.query("GRANT ALL ON SCHEMA public TO public");
  } finally {
    await client.end();
  }
}

/**
 * Ensures the application login role exists with the given password and can SET ROLE to `sbos_app` and
 * `sbos_operator` (never a superuser, never BYPASSRLS). Idempotent: the password is reset to the given value
 * on every run so a rotation only needs a new variable. Runs with the migration (schema owner) connection.
 * The role name is validated against a strict pattern because it is interpolated as an identifier.
 */
export async function ensureAppLoginRole(connectionString: string, input: { role: string; password: string }, log: (msg: string) => void = () => {}): Promise<void> {
  if (!/^[a-z][a-z0-9_]{2,40}$/.test(input.role)) throw new Error("application role name must be lowercase letters, digits and underscores");
  if (input.password.length < 24) throw new Error("application role password must be at least 24 characters");
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const exists = (await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [input.role])).rowCount;
    const ident = `"${input.role}"`;
    const literal = input.password.replace(/'/g, "''");
    if (!exists) {
      await client.query(`CREATE ROLE ${ident} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${literal}'`);
      log(`created application role ${input.role}`);
    } else {
      await client.query(`ALTER ROLE ${ident} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${literal}'`);
      log(`updated application role ${input.role}`);
    }
    await client.query(`GRANT sbos_app TO ${ident} WITH SET TRUE, INHERIT FALSE`);
    await client.query(`GRANT sbos_operator TO ${ident} WITH SET TRUE, INHERIT FALSE`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${ident}`);
    await client.query(`GRANT USAGE ON SCHEMA auth TO ${ident}`);
    // Better Auth reads and writes its own schema through the application connection (identity data, not tenant content).
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO ${ident}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ident}`);
    await client.query(`GRANT SELECT ON schema_migrations TO ${ident}`);
  } finally {
    await client.end();
  }
}
