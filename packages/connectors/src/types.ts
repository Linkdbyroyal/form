/**
 * Connector contract (Milestone 5, ADR-011). A connector reads from a client system; it never writes.
 * The platform decides the phase; the connector only reports what each phase needs. `metadata` means no
 * network call at all: the platform may call `describe()` and nothing else.
 */
export type Provider = "rentman" | "quickbooks" | "trengo" | "dropbox";
export const PROVIDERS: readonly Provider[] = ["rentman", "quickbooks", "trengo", "dropbox"];

export type ConnectionPhase = "metadata" | "read_only" | "sandbox" | "write";
export type ConnectorMode = "sandbox" | "live";

export interface ObjectKindDescriptor {
  kind: string;
  /** Fields the connector reads, in the source system's vocabulary. Shown to the client when consent is requested. */
  fields: string[];
  /** Plain-language statement of what is never read (for example message bodies). */
  excluded?: string;
}

export interface MetricDescriptor {
  key: string;
  name: string;
  unit: string;
  /** Formula in terms of the object fields, shown as KPI lineage. */
  formula: string;
  sourceField: string;
  direction: "higher_is_better" | "lower_is_better";
}

export interface ConnectorDescriptor {
  provider: Provider;
  displayName: string;
  vendor: string;
  objects: ObjectKindDescriptor[];
  metrics: MetricDescriptor[];
  /** Scopes requested per phase, in the vendor's own words plus a plain-language gloss. */
  scopes: Record<Exclude<ConnectionPhase, "write">, Array<{ scope: string; gloss: string }>>;
  /** Which secret references the live connector needs (names only). */
  secretRefs: string[];
  docsUrl: string;
}

export interface SecretReader {
  /** Returns the secret value for a reference, or null when it is not configured. Never log the result. */
  read(ref: string): Promise<string | null>;
}

export interface ConnectorContext {
  tenantId: string;
  connectionId: string;
  phase: ConnectionPhase;
  mode: ConnectorMode;
  /** Non-secret settings from `connections.config`. */
  config: Record<string, unknown>;
  secrets: SecretReader;
  /** Injected fetch so tests can prove that no network call happens in the metadata phase. */
  fetch: typeof globalThis.fetch;
  now: () => Date;
}

export interface SourceObject {
  kind: string;
  id: string;
  updatedAt: string;
  /** Only the declared fields, nothing else. */
  fields: Record<string, string | number | boolean | null>;
}

export interface MetricReading {
  key: string;
  status: "ok" | "missing_data" | "stale_data" | "error";
  value: number | null;
  periodStart: Date;
  periodEnd: Date;
  sourceField: string;
  formula: string;
  sourceRecordIds: string[];
  note?: string;
}

export interface TestConnectionResult {
  ok: boolean;
  mode: ConnectorMode;
  message: string;
  objectsVisible: Record<string, number>;
}

export interface Connector {
  describe(): ConnectorDescriptor;
  /** Verifies credentials and permissions in read_only or sandbox phase. Not allowed in metadata phase. */
  testConnection(ctx: ConnectorContext): Promise<TestConnectionResult>;
  listObjects(ctx: ConnectorContext, kind: string, since: Date | null): Promise<SourceObject[]>;
  readMetrics(ctx: ConnectorContext, keys: string[], period: { start: Date; end: Date }): Promise<MetricReading[]>;
}

export class ConnectorNotImplementedError extends Error {
  constructor(provider: Provider, mode: ConnectorMode) {
    super(`${mode} connector for ${provider} is not implemented in this release (not connected)`);
    this.name = "ConnectorNotImplementedError";
  }
}

export class PhaseViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhaseViolationError";
  }
}
