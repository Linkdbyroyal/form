import type { AgentRuntime, StructuredGenerateInput, StructuredGenerateResult } from "./runtime";

/**
 * Deterministic runtime used when no ANTHROPIC_API_KEY is configured or when a run is explicitly simulated.
 * It never calls the network. Callers supply a `fixture` producer per skill; output is validated against the schema
 * exactly like a real model result, so the rest of the pipeline is exercised for real.
 */
export class SimulatedRuntime implements AgentRuntime {
  readonly simulated = true;
  readonly model = "simulated";
  constructor(private readonly fixture: (prompt: string) => unknown) {}

  async generateStructured<T>(input: StructuredGenerateInput<T>): Promise<StructuredGenerateResult<T>> {
    const started = Date.now();
    const raw = this.fixture(input.prompt);
    const object = input.schema.parse(raw);
    const inputTokens = Math.ceil((input.instructions.length + input.prompt.length) / 4);
    const outputTokens = Math.ceil(JSON.stringify(raw).length / 4);
    return { object, usage: { inputTokens, outputTokens }, model: this.model, simulated: true, durationMs: Date.now() - started };
  }
}
