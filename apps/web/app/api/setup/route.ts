import { adminUserExists, bootstrapSuperadmin } from "@/lib/bootstrap-admin";
import { decideSetupAccess, parseSetupBody } from "@/lib/setup-gate";

export const dynamic = "force-dynamic";

/**
 * One-time deployment setup: creates the first superadmin on a fresh database (docs/deployment.md, section 3.11).
 * Enabled only while SBOS_SETUP_TOKEN (32+ characters) is set on the web service; requires that token as a bearer
 * token; refuses as soon as any admin user exists. Remove the variable after use. Logs identifiers only.
 */
export async function POST(request: Request) {
  const configuredToken = process.env.SBOS_SETUP_TOKEN;
  const pre = decideSetupAccess({ configuredToken, authorization: request.headers.get("authorization"), adminExists: false });
  if (!pre.allowed) return pre.status === 404 ? new Response("Not Found", { status: 404 }) : Response.json({ error: pre.reason }, { status: pre.status });

  const decision = decideSetupAccess({ configuredToken, authorization: request.headers.get("authorization"), adminExists: await adminUserExists() });
  if (!decision.allowed) return Response.json({ error: decision.reason }, { status: decision.status });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
  }
  const parsed = parseSetupBody(raw);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const steps: string[] = [];
  try {
    const result = await bootstrapSuperadmin(parsed.body, (m) => steps.push(m));
    console.log(JSON.stringify({ level: "info", msg: "setup: first superadmin created", userId: result.userId, organizationId: result.organizationId }));
    return Response.json({ status: "ok", userId: result.userId, organizationId: result.organizationId, agencySlug: result.agencySlug, memberships: result.memberships, steps, next: "Sign in at /sign-in, enable TOTP at /account/security, then remove SBOS_SETUP_TOKEN from the web service." });
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "setup failed", error: (err as Error).message }));
    return Response.json({ error: (err as Error).message, steps }, { status: 500 });
  }
}
