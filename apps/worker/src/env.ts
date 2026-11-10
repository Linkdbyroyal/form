export interface WorkerEnv {
  databaseUrl: string;
  anthropicApiKey: string | null;
  defaultModel: string;
  resendApiKey: string | null;
  resendFrom: string;
  pumbleWebhookUrl: string | null;
  appBaseUrl: string;
  port: number;
  concurrency: number;
  forceSimulated: boolean;
  /** Tech Watch records fixture items instead of contacting approved sources (sandbox, CI). */
  techWatchOffline: boolean;
}

export function readEnv(): WorkerEnv {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  return {
    databaseUrl,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
    defaultModel: process.env.SBOS_DEFAULT_MODEL || "claude-sonnet-5-5",
    resendApiKey: process.env.RESEND_API_KEY || null,
    resendFrom: process.env.RESEND_FROM_EMAIL || "Second Brain OS <noreply@example.invalid>",
    pumbleWebhookUrl: process.env.PUMBLE_WEBHOOK_URL || null,
    appBaseUrl: process.env.BETTER_AUTH_URL || process.env.SBOS_APP_URL || "http://localhost:3000",
    port: Number(process.env.PORT || 8080),
    concurrency: Number(process.env.SBOS_WORKER_CONCURRENCY || 2),
    forceSimulated: process.env.SBOS_FORCE_SIMULATED === "1",
    techWatchOffline: process.env.SBOS_TECH_WATCH_OFFLINE === "1"
  };
}
