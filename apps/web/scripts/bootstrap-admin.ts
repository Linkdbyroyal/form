import { loadRootEnv } from "./_env";

/**
 * Dev bootstrap: creates the first superadmin through Better Auth's server API (logic in lib/bootstrap-admin.ts,
 * shared with the one-time deployment route POST /api/setup).
 *
 *   SBOS_ADMIN_EMAIL=you@example.com SBOS_ADMIN_PASSWORD='...' pnpm --filter @sbos/web bootstrap-admin
 */
loadRootEnv();

const email = process.env.SBOS_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.SBOS_ADMIN_PASSWORD;
const name = process.env.SBOS_ADMIN_NAME?.trim() || "Superadmin";
if (!email || !password) {
  console.error("SBOS_ADMIN_EMAIL and SBOS_ADMIN_PASSWORD must be set");
  process.exit(1);
}
if (password.length < 12) {
  console.error("SBOS_ADMIN_PASSWORD must be at least 12 characters");
  process.exit(1);
}

const { bootstrapSuperadmin } = await import("../lib/bootstrap-admin");
const { closeAuthDb } = await import("../lib/auth-db");
const { getDb } = await import("../lib/db");

try {
  await bootstrapSuperadmin({ email, password, name }, (m) => console.log(m));
  console.log("next step: sign in at /sign-in and enable TOTP at /account/security (required for superadmin).");
} finally {
  await closeAuthDb();
  await getDb().close();
}
