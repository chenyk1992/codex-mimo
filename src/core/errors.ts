export class CodexMimoError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "CodexMimoError";
  }
}

export class PolicyDeniedError extends CodexMimoError {
  constructor(message: string, public readonly path?: string) {
    super(message, "POLICY_DENIED");
    this.name = "PolicyDeniedError";
  }
}

export class MiMoCodeNotFoundError extends CodexMimoError {
  constructor() {
    super("MiMoCode CLI not found or not working", "MIMO_NOT_FOUND");
    this.name = "MiMoCodeNotFoundError";
  }
}

export class SessionNotFoundError extends CodexMimoError {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`, "SESSION_NOT_FOUND");
    this.name = "SessionNotFoundError";
  }
}
