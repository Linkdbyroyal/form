import { Resend } from "resend";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export type MailDelivery = { channel: "resend"; id: string | null } | { channel: "console" };

/**
 * Transactional mail for authentication flows (verification, password reset, invitations).
 * With RESEND_API_KEY set the message goes through Resend (ADR-018); without it the message is
 * printed to the server console with a `[mail:dev]` prefix so local development needs no key.
 * Messages carry links and identifiers only, never client content (ADR-018).
 */
export async function sendMail(message: MailMessage): Promise<MailDelivery> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[mail:dev] to=${message.to}\n[mail:dev] subject=${message.subject}\n[mail:dev] ${message.text.split("\n").join("\n[mail:dev] ")}`);
    return { channel: "console" };
  }
  const from = process.env.MAIL_FROM;
  if (!from) throw new Error("MAIL_FROM must be set when RESEND_API_KEY is set");
  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send({ from, to: message.to, subject: message.subject, text: message.text });
  if (error) throw new Error(`Resend failed: ${error.name}: ${error.message}`);
  return { channel: "resend", id: data?.id ?? null };
}
