import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Loads the repo-root .env into process.env without a dependency (values already set win). */
export function loadDotEnv(): void {
  const candidates = [join(process.cwd(), ".env"), join(process.cwd(), "..", "..", ".env")];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || !m[1]) continue;
      if (process.env[m[1]] === undefined) process.env[m[1]] = (m[2] ?? "").replace(/^"(.*)"$/, "$1");
    }
    return;
  }
}

/**
 * Connection string for a CLI run.
 * - `--test`: always DATABASE_URL_TEST.
 * - schema work (migrate, reset): DATABASE_URL_MIGRATE, falling back to DATABASE_URL.
 * - data work (seed): DATABASE_URL, falling back to DATABASE_URL_MIGRATE. Seeds write through the
 *   application role and must land in the database the application uses.
 */
export function urlFor(argv: string[], purpose: "schema" | "data" = "schema"): string {
  loadDotEnv();
  if (argv.includes("--test")) {
    const url = process.env.DATABASE_URL_TEST;
    if (!url) throw new Error("DATABASE_URL_TEST must be set");
    return url;
  }
  const order = purpose === "schema" ? ["DATABASE_URL_MIGRATE", "DATABASE_URL"] : ["DATABASE_URL", "DATABASE_URL_MIGRATE"];
  for (const key of order) {
    const url = process.env[key];
    if (url) return url;
  }
  throw new Error(`${order.join(" or ")} must be set`);
}
