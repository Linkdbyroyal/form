"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { TenantContext } from "@sbos/db";
import { requestDeletion, setRetentionPolicy } from "@sbos/core";
import { getDb } from "../db";
import { errorMessage, withNotice } from "../format";
import { getPrincipal, requireTenantContext, type ResolvedTenant } from "../request-context";
import { DELETION_KINDS, isDataClass, validateRetentionDays } from "../mission-control/governance-helpers";

/**
 * Data & Retention write actions for the client workspace (Milestone 6). Each action resolves the tenant context
 * from the session, requires client_admin (never under a break-glass grant), and calls the @sbos/core service
 * inside `withContext()` in TENANT scope. The database is the real gate: the retention CHECK refuses a value
 * below the floor, the trigger `enforce_deletion_request` refuses anything but a fresh `requested` row from a
 * user. Decisions on deletion requests are agency decisions in Mission Control; execution is the worker's.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9-]{1,64}$/;

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
}

interface Resolved {
  slug: string;
  access: ResolvedTenant;
  ctx: TenantContext;
  publicUserId: string;
}

async function resolveWrite(form: FormData): Promise<Resolved> {
  const slug = text(form, "slug");
  if (!SLUG_RE.test(slug)) throw new Error("invalid workspace");
  const access = await requireTenantContext(slug);
  if (!access) throw new Error("workspace not found");
  if (access.viaGrant) throw new Error("a break-glass grant is read-only; retention and deletion are decisions of the client's own admin");
  if (!access.ctx.roles.includes("client_admin")) throw new Error(`this decision requires the client_admin role; your roles: ${access.ctx.roles.join(", ") || "none"}`);
  const principal = await getPrincipal();
  if (!principal) throw new Error("not signed in");
  return { slug, access, ctx: access.ctx, publicUserId: principal.data.publicUserId };
}

function safeReturn(form: FormData, fallback: string): string {
  const requested = text(form, "returnTo");
  return requested.startsWith("/") && !requested.startsWith("//") ? requested : fallback;
}

function isRedirect(err: unknown): boolean {
  return typeof err === "object" && err !== null && "digest" in err && typeof (err as { digest?: unknown }).digest === "string" && (err as { digest: string }).digest.startsWith("NEXT_REDIRECT");
}

function finish(slug: string | null, returnTo: string, outcome: { ok?: string; error?: string }): never {
  revalidatePath(returnTo.split("?")[0] ?? returnTo);
  if (slug) revalidatePath(`/c/${slug}/retention`);
  revalidatePath("/mission-control/governance");
  redirect(withNotice(returnTo, outcome));
}

function fallbackReturn(form: FormData): string {
  const slugGuess = text(form, "slug");
  return safeReturn(form, SLUG_RE.test(slugGuess) ? `/c/${slugGuess}/retention` : "/");
}

/** Client admin sets a tenant override for one data class; the floor is checked here and again by the database. */
export async function setTenantRetentionAction(form: FormData): Promise<void> {
  const returnTo = fallbackReturn(form);
  let slug: string | null = null;
  let outcome: { ok?: string; error?: string };
  try {
    const r = await resolveWrite(form);
    slug = r.slug;
    const dataClass = text(form, "dataClass");
    if (!isDataClass(dataClass)) throw new Error("unknown data class");
    const retentionDays = Number(text(form, "retentionDays"));
    const invalid = validateRetentionDays(dataClass, retentionDays);
    if (invalid) throw new Error(invalid);
    const reason = text(form, "reason");
    if (reason.length < 5) throw new Error("a reason is required (at least 5 characters)");
    if (reason.length > 1000) throw new Error("reason is longer than 1000 characters");
    await getDb().withContext(r.ctx, (tx) => setRetentionPolicy(tx, r.ctx, { tenantId: r.ctx.tenantId, dataClass, retentionDays, reason }));
    outcome = { ok: `Retention for ${dataClass.replaceAll("_", " ")} set to ${retentionDays} days for this workspace. The worker applies it on its weekly sweep (Sundays 03:00 UTC); rows older than that are then deleted. Audit events are never deleted.` };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(slug, returnTo, outcome);
}

/** Client admin files a deletion request; an agency reviewer decides, the worker (or a superadmin by runbook) executes. */
export async function requestDeletionAction(form: FormData): Promise<void> {
  const returnTo = fallbackReturn(form);
  let slug: string | null = null;
  let outcome: { ok?: string; error?: string };
  try {
    const r = await resolveWrite(form);
    slug = r.slug;
    const kindRaw = text(form, "kind");
    if (!(DELETION_KINDS as readonly string[]).includes(kindRaw)) throw new Error(`kind must be one of ${DELETION_KINDS.join(", ")}`);
    const kind = kindRaw as (typeof DELETION_KINDS)[number];
    const subjectRef = text(form, "subjectRef");
    if (!subjectRef) throw new Error("the subject reference is required");
    if (subjectRef.length > 500) throw new Error("subject reference is longer than 500 characters");
    if (kind === "connection_data" && !UUID_RE.test(subjectRef)) throw new Error("for connection data the subject reference is the connection id (UUID, see Integration Center)");
    if (kind === "tenant_offboarding" && subjectRef !== r.slug) throw new Error(`type the workspace slug (${r.slug}) to confirm an off-boarding request`);
    const reason = text(form, "reason");
    if (reason.length < 10) throw new Error("state the reason or legal basis (at least 10 characters)");
    if (reason.length > 4000) throw new Error("reason is longer than 4000 characters");
    const id = await getDb().withContext(r.ctx, (tx) => requestDeletion(tx, r.ctx, { tenantId: r.ctx.tenantId, kind, subjectRef, reason, userId: r.publicUserId }));
    const automated = kind === "document" || kind === "connection_data";
    outcome = { ok: `Deletion request ${id.slice(0, 8)} filed (${kind.replaceAll("_", " ")}). An agency reviewer decides; ${automated ? "once approved it is executed by the worker on its weekly schedule (Sundays 03:00 UTC)" : "once approved the agency follows the runbook and records a written summary"}. Nothing is deleted yet.` };
  } catch (err) {
    if (isRedirect(err)) throw err;
    outcome = { error: errorMessage(err) };
  }
  finish(slug, returnTo, outcome);
}
