/**
 * Model pricing in USD per million tokens. Reviewed with every model change (ADR-016).
 * Values are our configured estimates for budget enforcement; the invoice from the provider is authoritative.
 * Last review: 2026-11-09.
 */
export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-sonnet-5-5": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-haiku-5-5": { inputPerMillion: 1, outputPerMillion: 5 },
  "claude-opus-5-5": { inputPerMillion: 15, outputPerMillion: 75 },
  simulated: { inputPerMillion: 0, outputPerMillion: 0 }
};

export function estimateCostUsd(model: string, tokensInput: number, tokensOutput: number): number {
  const price = MODEL_PRICES[model] ?? MODEL_PRICES["claude-sonnet-5-5"]!;
  const cost = (tokensInput / 1_000_000) * price.inputPerMillion + (tokensOutput / 1_000_000) * price.outputPerMillion;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
