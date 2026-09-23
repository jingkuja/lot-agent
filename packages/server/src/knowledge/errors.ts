export class KnowledgeError extends Error {
  constructor(
    readonly code: "INVALID_REQUEST" | "UNAUTHORIZED" | "SCOPE_FORBIDDEN" | "NOT_FOUND" | "KNOWLEDGE_UNAVAILABLE" | "CONFLICT" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_MEDIA",
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 503,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "KnowledgeError";
  }
}
