import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Loads the repo-root .env into process.env for scripts and tests (values already set win). */
export function loadRootEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(process.cwd(), ".env"), join(here, "..", ".env"), join(here, "..", "..", "..", ".env")];
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
