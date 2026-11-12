/** Display helpers shared by Mission Control and Client Workspace pages. Pure functions, no I/O. */

export function fmtDate(value: Date | string | null | undefined): string {
  if (!value) return "n/a";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "n/a";
  return d.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

export function fmtUsd(value: number | string | null | undefined, digits = 4): string {
  const n = typeof value === "string" ? Number(value) : (value ?? 0);
  if (!Number.isFinite(n)) return "n/a";
  return `$${n.toFixed(digits)}`;
}

export function fmtInt(value: number | string | null | undefined): string {
  const n = typeof value === "string" ? Number(value) : (value ?? 0);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "n/a";
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** First value of a query-string parameter, or null. */
export function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** Start of the current UTC month; the same boundary the budget service uses. */
export function monthStartUtc(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * Builds `path?key=value` for the redirect after a server action. Only same-origin paths are accepted. Query parameters
 * already on the path (for example the Live board's `tab` and `run`) are kept; a previous `ok` or `error` is replaced.
 * A fragment is dropped: the server cannot redirect to one reliably.
 */
export function withNotice(returnTo: string, notice: { ok?: string; error?: string }): string {
  const path = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/mission-control";
  const withoutHash = path.split("#")[0] ?? path;
  const [base, query = ""] = withoutHash.split("?", 2) as [string, string?];
  const params = new URLSearchParams(query);
  params.delete("ok");
  params.delete("error");
  if (notice.ok) params.set("ok", notice.ok);
  if (notice.error) params.set("error", notice.error);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Turns a thrown value (usually a Postgres error from a trigger or grant) into a short message for the UI. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // drizzle wraps a Postgres error as "Failed query: <sql>" with the trigger text in `cause`; show the cause.
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message && err.message.startsWith("Failed query")) return cause.message.slice(0, 300);
    return err.message.slice(0, 300);
  }
  return String(err).slice(0, 300);
}
