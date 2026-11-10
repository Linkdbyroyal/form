import { ensureAppLoginRole, runMigrations } from "../migrate";
import { urlFor } from "./_env";

const url = urlFor(process.argv);
const applied = await runMigrations(url, (m) => console.log(m));
console.log(applied.length ? `applied ${applied.length} migration(s)` : "database is up to date");

// Deployment bootstrap: the application login role is managed from the worker's environment (docs/deployment.md 3.2).
const role = process.env.SBOS_APP_DB_ROLE;
const password = process.env.SBOS_APP_DB_PASSWORD;
if (role && password) {
  await ensureAppLoginRole(url, { role, password }, (m) => console.log(m));
} else if (role || password) {
  console.warn("SBOS_APP_DB_ROLE and SBOS_APP_DB_PASSWORD must both be set to manage the application role; skipped");
}
