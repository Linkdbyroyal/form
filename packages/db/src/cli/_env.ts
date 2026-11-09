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

export function urlFor(argv: string[]): string {
  loadDotEnv();
  const test = argv.includes("--test");
  const key = test ? "DATABASE_URL_TEST" : "DATABASE_URL_MIGRATE";
  const url = process.env[key] ?? (test ? undefined : process.env.DATABASE_URL);
  if (!url) throw new Error(`${key} (or DATABASE_URL) must be set`);
  return url;
}
