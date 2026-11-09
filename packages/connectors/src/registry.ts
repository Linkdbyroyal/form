import { SandboxConnector } from "./sandbox";
import { ConnectorNotImplementedError, PROVIDERS, type Connector, type ConnectorMode, type Provider } from "./types";

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/**
 * Returns the connector for a provider and mode. Live connectors arrive with M5-05 to M5-07 once sandbox
 * credentials exist; until then asking for `live` is an explicit "not connected" error, never a silent
 * fallback to fixtures. The sync service decides the mode from the connection (sandbox fixtures until the
 * phase is read_only with live credentials configured).
 */
export function getConnector(provider: Provider, mode: ConnectorMode): Connector {
  if (mode === "sandbox") return new SandboxConnector(provider);
  throw new ConnectorNotImplementedError(provider, mode);
}

/** Descriptors are available for every provider in every mode (metadata phase needs nothing else). */
export function describeProvider(provider: Provider) {
  return new SandboxConnector(provider).describe();
}
