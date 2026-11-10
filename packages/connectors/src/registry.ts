import { RentmanLiveConnector } from "./rentman";
import { SandboxConnector } from "./sandbox";
import { ConnectorNotImplementedError, PROVIDERS, type Connector, type ConnectorMode, type Provider } from "./types";

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/**
 * Returns the connector for a provider and mode. Live connectors: Rentman (M5-05, ADR-023). For the other
 * providers asking for `live` is an explicit "not connected" error, never a silent fallback to fixtures. The
 * sync service decides the mode from the connection (sandbox fixtures until the phase is read_only with live
 * credentials configured and `config.mode` set to live).
 */
export function getConnector(provider: Provider, mode: ConnectorMode): Connector {
  if (mode === "sandbox") return new SandboxConnector(provider);
  if (provider === "rentman") return new RentmanLiveConnector();
  throw new ConnectorNotImplementedError(provider, mode);
}

/** Providers with a live, read-only implementation (the UI states "not connected" for the others). */
export const LIVE_PROVIDERS: readonly Provider[] = ["rentman"];

/** Descriptors are available for every provider in every mode (metadata phase needs nothing else). */
export function describeProvider(provider: Provider) {
  return new SandboxConnector(provider).describe();
}
