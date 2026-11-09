import { schema, type Tx } from "@sbos/db";
import type { JobBackend } from "./job-backend";

const { notifications } = schema;

export interface QueueNotificationInput {
  tenantId: string | null;
  channel: "email" | "pumble";
  template: string;
  subject: string;
  /** Identifiers and a deep link only. Never client content, amounts or personal data (ADR-018). */
  payload: Record<string, unknown>;
  recipientRole?: string | null;
  recipientUserId?: string | null;
}

const FORBIDDEN_PAYLOAD_KEYS = ["body", "body_markdown", "question_text", "instruction", "notes", "amount", "iban", "password", "token", "secret"];

export async function queueNotification(tx: Tx, jobs: JobBackend, input: QueueNotificationInput): Promise<string> {
  for (const key of Object.keys(input.payload)) {
    if (FORBIDDEN_PAYLOAD_KEYS.includes(key)) throw new Error(`notification payload may not contain "${key}"`);
  }
  const [row] = await tx
    .insert(notifications)
    .values({
      tenantId: input.tenantId,
      channel: input.channel,
      template: input.template,
      subject: input.subject,
      payload: input.payload,
      recipientRole: input.recipientRole ?? null,
      recipientUserId: input.recipientUserId ?? null
    })
    .returning({ id: notifications.id });
  if (!row) throw new Error("notification insert returned nothing");
  await jobs.enqueue("notify.send", { notificationId: row.id, tenantId: input.tenantId }, { retryLimit: 5 });
  return row.id;
}
