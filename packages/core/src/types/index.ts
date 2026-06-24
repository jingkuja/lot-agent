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

/** Unified LLM provider interface */
export interface LLMProvider {
  chat(messages: Message[], tools?: LLMTool[]): AsyncIterable<ChatChunk>;
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
}

/** Tool definition */
export interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  /** Per-tool execution config overrides */
  execConfig?: Partial<ToolExecConfig>;
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
