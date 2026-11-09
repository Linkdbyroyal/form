"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { schema } from "@sbos/db";
import { decideApproval } from "@sbos/core";
import { getDb } from "../db";
import { getJobs } from "../jobs";
import { errorMessage, withNotice } from "../format";
import { requireTenantContext } from "../request-context";

/**
 * Client Workspace write actions. They run in TENANT context for the signed-in member, so RLS pins the
 * transaction to that tenant. The approval decision itself is `decideApproval` from @sbos/core, which writes
 * the audit row and resumes or cancels the suspended run; the database trigger refuses self-approval and a
 * second decision, and its message is shown to the user through `?error=`.
 */
const { approvals } = schema;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
}

export async function decideClientApprovalAction(form: FormData): Promise<void> {
  const slug = text(form, "slug");
  const safeSlug = /^[a-z0-9-]{1,64}$/.test(slug) ? slug : null;
  const requested = text(form, "returnTo");
  const returnTo = requested.startsWith("/") && !requested.startsWith("//") ? requested : safeSlug ? `/c/${safeSlug}/approvals` : "/";
  let outcome: { ok?: string; error?: string };
  try {
    if (!safeSlug) throw new Error("invalid workspace");
    const approvalId = text(form, "approvalId");
    if (!UUID_RE.test(approvalId)) throw new Error("approvalId must be a UUID");
    const decisionRaw = text(form, "decision");
    if (decisionRaw !== "approved" && decisionRaw !== "rejected") throw new Error("decision must be approved or rejected");
    const decision = decisionRaw;
    const note = text(form, "note").slice(0, 1000);

    const access = await requireTenantContext(safeSlug);
    if (!access) throw new Error("workspace not found");
    if (access.viaGrant) throw new Error("a break-glass grant is read-only; approvals are decided by the client's own roles");
    const ctx = access.ctx;
    const jobs = await getJobs();
    await getDb().withContext(ctx, async (tx) => {
      const [row] = await tx.select({ approverRole: approvals.approverRole, state: approvals.state }).from(approvals).where(eq(approvals.id, approvalId));
      if (!row) throw new Error("approval not found in this workspace");
      if (!ctx.roles.includes(row.approverRole)) throw new Error(`this approval requires the ${row.approverRole} role; your roles: ${ctx.roles.join(", ")}`);
      await decideApproval(tx, ctx, jobs, { tenantId: ctx.tenantId, approvalId, decision, decidedBy: { actorId: ctx.actorId, userId: null }, note: note || undefined });
    });
    outcome = { ok: decision === "approved" ? "Approved. The agent run resumes and publishes the questions to the Interview Inbox." : "Rejected. The agent run was cancelled; nothing was published." };
  } catch (err) {
    outcome = { error: errorMessage(err) };
  }
  revalidatePath(returnTo.split("?")[0] ?? returnTo);
  if (safeSlug) {
    revalidatePath(`/c/${safeSlug}/approvals`);
    revalidatePath(`/c/${safeSlug}/inbox`);
    revalidatePath(`/c/${safeSlug}/agents`);
  }
  redirect(withNotice(returnTo, outcome));
}
