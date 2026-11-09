import { eq } from "drizzle-orm";
import { Resend } from "resend";
import { operatorContext, schema, type DbHandle } from "@sbos/db";
import type { WorkerEnv } from "./env";
import { log } from "./log";

const { notifications, users } = schema;
const OPERATOR = operatorContext({ actorType: "system", actorId: "worker:notify", roles: ["agency_operator"] });

/**
 * Sends one queued notification. Email through Resend, internal updates through a Pumble incoming webhook.
 * Payloads carry identifiers and a deep link only (ADR-018). Without credentials the message is logged, not sent,
 * and the row is marked sent with `delivery: "logged"` so local development stays honest and visible.
 */
export async function sendNotification(handle: DbHandle, env: WorkerEnv, notificationId: string): Promise<void> {
  const row = await handle.withContext(OPERATOR, async (tx) => (await tx.select().from(notifications).where(eq(notifications.id, notificationId)))[0] ?? null);
  if (!row) throw new Error(`notification ${notificationId} not found`);
  if (row.state === "sent") return;

  const link = `${env.appBaseUrl}${deepLink(row.template, row.payload as Record<string, unknown>)}`;
  const text = `${row.subject}\n\nOpen in Second Brain OS: ${link}\n\nThis message contains no client content by design.`;

  try {
    let delivery = "logged";
    if (row.channel === "email") {
      const to = row.recipientUserId ? await lookupEmail(handle, row.recipientUserId) : null;
      if (env.resendApiKey && to) {
        const resend = new Resend(env.resendApiKey);
        const res = await resend.emails.send({ from: env.resendFrom, to, subject: `[Second Brain OS] ${row.subject}`, text });
        if (res.error) throw new Error(res.error.message);
        delivery = "resend";
      } else {
        log("info", "[mail:dev] email not sent (no RESEND_API_KEY or recipient)", { notificationId, subject: row.subject, to: to ? "set" : "none" });
      }
    } else if (row.channel === "pumble") {
      if (env.pumbleWebhookUrl) {
        const res = await fetch(env.pumbleWebhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
        if (!res.ok) throw new Error(`pumble webhook responded ${res.status}`);
        delivery = "pumble";
      } else {
        log("info", "[pumble:dev] message not sent (no PUMBLE_WEBHOOK_URL)", { notificationId, subject: row.subject });
      }
    }
    await handle.withContext(OPERATOR, (tx) =>
      tx.update(notifications).set({ state: "sent", sentAt: new Date(), attempts: row.attempts + 1, lastError: null, payload: { ...(row.payload as object), delivery } }).where(eq(notifications.id, notificationId))
    );
  } catch (err) {
    await handle.withContext(OPERATOR, (tx) => tx.update(notifications).set({ attempts: row.attempts + 1, lastError: (err as Error).message }).where(eq(notifications.id, notificationId)));
    throw err;
  }
}

export async function markNotificationFailed(handle: DbHandle, notificationId: string): Promise<void> {
  await handle.withContext(OPERATOR, (tx) => tx.update(notifications).set({ state: "failed" }).where(eq(notifications.id, notificationId)));
}

async function lookupEmail(handle: DbHandle, userId: string): Promise<string | null> {
  // Operator role cannot read e-mail addresses (column grant); use agency scope for delivery only.
  const { agencyContext } = await import("@sbos/db");
  const ctx = agencyContext({ tenantId: null, actorType: "system", actorId: "worker:notify", roles: ["superadmin"] });
  return handle.withContext(ctx, async (tx) => (await tx.select({ email: users.email }).from(users).where(eq(users.id, userId)))[0]?.email ?? null);
}

function deepLink(template: string, payload: Record<string, unknown>): string {
  switch (template) {
    case "approval.requested":
      return `/c/${String(payload.tenantSlug ?? "")}/approvals/${String(payload.approvalId ?? "")}`;
    case "questions.published":
      return `/c/${String(payload.tenantSlug ?? "")}/inbox`;
    case "incident.raised":
      return `/mission-control/errors`;
    default:
      return "/mission-control";
  }
}
