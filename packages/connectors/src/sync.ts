import { and, eq } from "drizzle-orm";
import { schema, tenantContext, type DbHandle, type TenantContext } from "@sbos/db";
import { expiredCredentialReferences, finishSyncRun, raiseIncident, recordMetricObservations, startSyncRun, type JobBackend, type MetricReadingInput } from "@sbos/core";
import { getConnector, isProvider } from "./registry";
import { EnvSecretReader, NoSecretReader, maskSecrets } from "./secrets";
import { ConnectorNotImplementedError, PhaseViolationError, type ConnectorContext, type ConnectorMode, type SecretReader } from "./types";

const { connections, systems } = schema;

class CredentialExpiredError extends Error {
  constructor(refs: string[]) {
    super(`credential reference(s) expired: ${refs.join(", ")}; rotate the secret and update the reference before the next live sync`);
    this.name = "CredentialExpiredError";
  }
}

export interface RunSyncInput {
  tenantId: string;
  connectionId: string;
  trigger: "schedule" | "manual" | "test";
  /** Defaults to EnvSecretReader; tests inject a reader. Never used in sandbox mode. */
  secrets?: SecretReader;
  /** Defaults to a guard that refuses every call in the metadata phase and in sandbox mode. */
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

export interface RunSyncResult {
  syncRunId: string;
  status: "succeeded" | "failed" | "skipped";
  mode: ConnectorMode;
  objectsRead: number;
  observationsWritten: number;
  networkCalls: number;
  note: string;
}

/**
 * Executes one sync for a connection (worker job `connector.sync`). Rules enforced here, on top of the
 * database trigger: the metadata phase never contacts a system (the fetch handed to the connector throws and
 * counts); sandbox mode uses fixtures and no secrets; live mode exists only when a live connector is
 * implemented and a credential reference is registered. Every outcome is a `sync_runs` row; failures also
 * raise an incident with identifiers only.
 */
export async function runConnectionSync(handle: DbHandle, jobs: JobBackend, input: RunSyncInput): Promise<RunSyncResult> {
  const now = input.now ?? (() => new Date());
  let networkCalls = 0;
  const ctx: TenantContext = tenantContext({ tenantId: input.tenantId, actorType: "system", actorId: `connector:${input.connectionId.slice(0, 8)}`, roles: ["system"] });

  const conn = await handle.withContext(ctx, async (tx) => {
    const [c] = await tx.select().from(connections).where(and(eq(connections.id, input.connectionId), eq(connections.tenantId, input.tenantId)));
    if (!c) return null;
    const [s] = c.systemId ? await tx.select({ name: systems.name }).from(systems).where(eq(systems.id, c.systemId)) : [];
    return { ...c, systemName: s?.name ?? null };
  });
  if (!conn) throw new Error("connection not found");
  if (!isProvider(conn.provider)) throw new Error(`unknown provider ${conn.provider}`);
  const provider = conn.provider;
  const config = (conn.config ?? {}) as Record<string, unknown>;
  const mode: ConnectorMode = config.mode === "live" ? "live" : "sandbox";

  const syncRunId = await handle.withContext(ctx, (tx) => startSyncRun(tx, ctx, { tenantId: input.tenantId, connectionId: input.connectionId, trigger: input.trigger, phase: conn.phase, mode }));
  const finish = async (status: "succeeded" | "failed" | "skipped", extra: { objectsRead?: number; observationsWritten?: number; errorClass?: string; errorMessage?: string; note: string }) => {
    await handle.withContext(ctx, (tx) => finishSyncRun(tx, ctx, { tenantId: input.tenantId, syncRunId, status, objectsRead: extra.objectsRead ?? 0, observationsWritten: extra.observationsWritten ?? 0, errorClass: extra.errorClass ?? null, errorMessage: extra.errorMessage ?? null, details: { note: extra.note, networkCalls, trigger: input.trigger } }));
    return { syncRunId, status, mode, objectsRead: extra.objectsRead ?? 0, observationsWritten: extra.observationsWritten ?? 0, networkCalls, note: extra.note } satisfies RunSyncResult;
  };

  // Phase and status gates: nothing leaves the platform in the metadata phase or while paused.
  if (conn.phase === "metadata") return finish("skipped", { note: "metadata phase: no external call is allowed; only the descriptor is known" });
  if (conn.phase === "write") return finish("failed", { errorClass: "phase_not_supported", errorMessage: "write phase has no implementation", note: "refused" });
  if (conn.status !== "active" && input.trigger !== "test") return finish("skipped", { note: `connection is ${conn.status}; scheduled and manual syncs run only while active` });
  if (conn.consent !== "granted") return finish("skipped", { note: "consent is not granted" });

  const guardedFetch: typeof globalThis.fetch = async (url, init) => {
    networkCalls++;
    if (mode === "sandbox") throw new PhaseViolationError("sandbox mode must not contact external systems");
    return (input.fetch ?? globalThis.fetch)(url, init);
  };
  const connectorCtx: ConnectorContext = { tenantId: input.tenantId, connectionId: input.connectionId, phase: conn.phase, mode, config, secrets: mode === "sandbox" ? new NoSecretReader() : (input.secrets ?? new EnvSecretReader()), fetch: guardedFetch, now };

  try {
    if (mode === "live") {
      const expired = await handle.withContext(ctx, (tx) => expiredCredentialReferences(tx, ctx, { tenantId: input.tenantId, connectionId: input.connectionId, now: now() }));
      if (expired.length > 0) throw new CredentialExpiredError(expired.map((e) => e.secretRef));
    }
    const connector = getConnector(provider, mode);
    const descriptor = connector.describe();
    const period = { start: new Date(now().getTime() - 30 * 86_400_000), end: now() };
    if (input.trigger === "test") {
      const result = await connector.testConnection(connectorCtx);
      return finish(result.ok ? "succeeded" : "failed", { objectsRead: Object.values(result.objectsVisible).reduce((a, b) => a + b, 0), note: `${result.message} (${result.mode})` });
    }
    const readings = await connector.readMetrics(connectorCtx, descriptor.metrics.map((m) => m.key), period);
    const objectsRead = new Set(readings.flatMap((r) => r.sourceRecordIds)).size;
    const inputs: MetricReadingInput[] = readings.map((r) => {
      const m = descriptor.metrics.find((x) => x.key === r.key)!;
      return { key: r.key, name: m.name, unit: m.unit, formula: m.formula, sourceField: m.sourceField, direction: m.direction, status: r.status, value: r.value, periodStart: r.periodStart, periodEnd: r.periodEnd, sourceRecordIds: r.sourceRecordIds };
    });
    const sourceSystem = conn.systemName ?? descriptor.displayName;
    const { written } = await handle.withContext(ctx, (tx) => recordMetricObservations(tx, ctx, { tenantId: input.tenantId, connectionId: input.connectionId, syncRunId, sourceSystem, readings: inputs }));
    return finish("succeeded", { objectsRead, observationsWritten: written, note: mode === "sandbox" ? "simulated: sandbox fixtures, no external system contacted" : "live read-only sync" });
  } catch (err) {
    const e = err as Error;
    const errorClass = err instanceof CredentialExpiredError ? "credential_expired" : err instanceof ConnectorNotImplementedError ? "connector_not_implemented" : err instanceof PhaseViolationError ? "phase_violation" : "connector_error";
    const message = maskSecrets(e.message ?? String(err));
    const result = await finish("failed", { errorClass, errorMessage: message, note: "sync failed" });
    await handle.withContext(ctx, (tx) => raiseIncident(tx, jobs, { tenantId: input.tenantId, kind: errorClass === "connector_not_implemented" || errorClass === "credential_expired" ? "credential_invalid" : "worker_error", severity: errorClass === "phase_violation" ? "critical" : "high", title: `Connector sync failed (${provider}): ${errorClass}`, details: { connectionId: input.connectionId, syncRunId, errorClass }, dedupeKey: `connector:${input.connectionId}:${errorClass}` }));
    return result;
  }
}
