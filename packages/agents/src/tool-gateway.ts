import { AuthorizationError } from "@sbos/core";

/**
 * Server-side authorisation for every tool an agent may use. The model never decides what is allowed;
 * the intersection of the definition's and the pinned skill version's `allowed_tools` does.
 */
export class ToolGateway {
  private readonly allowed: Set<string>;
  public readonly denied: string[] = [];

  constructor(definitionTools: readonly string[], skillTools: readonly string[]) {
    const skill = new Set(skillTools);
    this.allowed = new Set(definitionTools.filter((t) => skill.has(t)));
  }

  authorize(tool: string): void {
    if (!this.allowed.has(tool)) {
      this.denied.push(tool);
      throw new AuthorizationError(`tool "${tool}" is not allowed for this agent instance`);
    }
  }

  list(): string[] {
    return [...this.allowed].sort();
  }
}
