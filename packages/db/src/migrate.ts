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
