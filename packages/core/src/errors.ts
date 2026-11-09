export type FailureClass = "retryable" | "credential" | "policy" | "budget" | "model" | "validation" | "bug";

export class RunFailure extends Error {
  constructor(
    public readonly failureClass: FailureClass,
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "RunFailure";
  }
  get retryable(): boolean {
    return this.failureClass === "retryable" || this.failureClass === "model";
  }
}

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}
