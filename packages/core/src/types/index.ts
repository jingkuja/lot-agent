/** Content part for multimodal messages */
export interface ContentPart {
  type: "text" | "image";
  text?: string;
  image?: { url: string; mediaType: string };
}

/** Tool call from LLM */
export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

/** Unified message format */
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

/** Streamed chunk from LLM */
export interface ChatChunk {
  type: "text" | "tool_call" | "done";
  content?: string;
  toolCall?: ToolCall;
  finishReason?: string;
  usage?: { promptTokens: number; completionTokens: number };
}

/** JSON Schema type for tool parameters */
export type JSONSchema = Record<string, unknown>;

/** LLM tool definition */
export interface LLMTool {
  name: string;
  description: string;
  parameters: JSONSchema;
}

/** Options for a single LLM chat call */
export interface ChatOptions {
  /** Aborts the in-flight request (run timeout or client disconnect). */
  signal?: AbortSignal;
}

/** Unified LLM provider interface */
export interface LLMProvider {
  chat(
    messages: Message[],
    tools?: LLMTool[],
    opts?: ChatOptions
  ): AsyncIterable<ChatChunk>;
}

/** Error classification for tools */
export type ToolErrorKind =
  | "timeout"     // Execution exceeded time limit
  | "network"     // Network/IO error (retryable)
  | "not_found"   // Resource not found (non-retryable)
  | "permission"  // Permission denied (non-retryable)
  | "validation"  // Invalid input (non-retryable)
  | "unknown";    // Unclassified

/** Tool execution result */
export interface ToolResult {
  content: string;
  isError?: boolean;
  errorKind?: ToolErrorKind;
  /** Suggested retry delay in ms (for retryable errors) */
  retryAfterMs?: number;
}

/** Retry configuration */
export interface RetryConfig {
  /** Max retry attempts. Default: 2 */
  maxRetries: number;
  /** Base delay between retries in ms. Default: 1000 */
  baseDelayMs: number;
  /** Only retry these error kinds. Default: ['timeout', 'network'] */
  retryableKinds: ToolErrorKind[];
}

/** Per-tool execution config */
export interface ToolExecConfig {
  /** Timeout in ms. Default: 30000 */
  timeoutMs: number;
  /** Retry configuration */
  retry: RetryConfig;
}

/** Context passed to tool execution */
export interface ToolContext {
  workingDirectory: string;
  memory?: import("../memory/store.js").AgentMemoryStore;
  /** Owner of the current request — used by tools that persist user-scoped artifacts (e.g. generated documents). */
  userId?: string;
  /** Aborts long-running tool work when the run times out or the client disconnects. */
  signal?: AbortSignal;
}

/** Tool definition */
export interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  /** Per-tool execution config overrides */
  execConfig?: Partial<ToolExecConfig>;
  /**
   * When true, an identical call (same name + args) that already succeeded in
   * the current run is reused instead of re-executed. Only safe for pure /
   * idempotent reads whose result cannot change due to other actions in the
   * run (e.g. web fetches). Defaults to false — most tools must re-run.
   */
  cacheable?: boolean;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}

/** Default tool execution config */
export const DEFAULT_TOOL_EXEC_CONFIG: ToolExecConfig = {
  timeoutMs: 30_000,
  retry: {
    maxRetries: 2,
    baseDelayMs: 1_000,
    retryableKinds: ["timeout", "network"],
  },
};
