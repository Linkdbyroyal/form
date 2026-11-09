import { createAnthropic } from "@ai-sdk/anthropic";
import { Agent } from "@mastra/core/agent";
import type { AgentRuntime, StructuredGenerateInput, StructuredGenerateResult } from "./runtime";

export interface MastraRuntimeOptions {
  apiKey: string;
  model: string;
  agentId: string;
}

/**
 * Mastra Agent backed by the Anthropic provider of the Vercel AI SDK. Memory is disabled on purpose:
 * all persistence is ours (runs, checkpoints, vault), so nothing leaks between tenants through the framework.
 */
export class MastraAgentRuntime implements AgentRuntime {
  readonly simulated = false;
  readonly model: string;
  private readonly agentId: string;
  private readonly provider: ReturnType<typeof createAnthropic>;

  constructor(options: MastraRuntimeOptions) {
    this.model = options.model;
    this.agentId = options.agentId;
    this.provider = createAnthropic({ apiKey: options.apiKey });
  }

  async generateStructured<T>(input: StructuredGenerateInput<T>): Promise<StructuredGenerateResult<T>> {
    const started = Date.now();
    const agent = new Agent({
      id: this.agentId,
      name: this.agentId,
      instructions: input.instructions,
      // The AI SDK's LanguageModelV4 and Mastra's bundled V4 type differ in a return-type detail
      // (ai 7.0.166 vs @mastra/core 1.82.0). The runtime contract is the same; the cast is reviewed with every upgrade.
      model: this.provider(this.model) as unknown as ConstructorParameters<typeof Agent>[0]["model"]
    });
    const result = await agent.generate(input.prompt, {
      structuredOutput: { schema: input.schema },
      maxOutputTokens: input.maxOutputTokens ?? 4000
    } as never);
    const r = result as unknown as { object: T; usage?: Record<string, unknown>; totalUsage?: Record<string, unknown> };
    const usage = readUsage(r.totalUsage ?? r.usage);
    return { object: r.object, usage, model: this.model, simulated: false, durationMs: Date.now() - started };
  }
}

function readUsage(u: Record<string, unknown> | undefined): { inputTokens: number; outputTokens: number } {
  if (!u) return { inputTokens: 0, outputTokens: 0 };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: num(u.inputTokens ?? u.promptTokens),
    outputTokens: num(u.outputTokens ?? u.completionTokens)
  };
}
