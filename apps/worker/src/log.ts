/** Structured JSON logging. Never log payloads, prompts, model output or secrets; identifiers only. */
export function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}
