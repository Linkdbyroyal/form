import type { z } from "zod";

/**
 * AgentRuntime is the only interface the worker and core depend on for model execution (ADR-003).
 * The Mastra adapter implements it; the simulated runtime implements it without any network call.
 */
export interface StructuredGenerateInput<T> {
  /** SKILL.md body or other system instructions. */
  instructions: string;
  /** User-turn content assembled by our code. Untrusted data must already be wrapped by the caller. */
  prompt: string;
  schema: z.ZodType<T>;
  /** Hard upper bound on output tokens for this call. */
  maxOutputTokens?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface StructuredGenerateResult<T> {
  object: T;
  usage: Usage;
  model: string;
  simulated: boolean;
  durationMs: number;
}

export interface AgentRuntime {
  readonly model: string;
  readonly simulated: boolean;
  generateStructured<T>(input: StructuredGenerateInput<T>): Promise<StructuredGenerateResult<T>>;
}

/** Wraps untrusted content so the model treats it as data, never as instructions (SECURITY.md principle 4). */
export function wrapUntrusted(label: string, content: string): string {
  const safe = content.replace(/<\/?untrusted[^>]*>/gi, "");
  return `<untrusted source="${label}">\n${safe}\n</untrusted>`;
}
