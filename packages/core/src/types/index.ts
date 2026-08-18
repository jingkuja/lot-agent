/** Content part for multimodal messages */
export interface ContentPart {
  type: "text" | "image" | "video" | "audio" | "file";
  text?: string;
  image?: { url: string; mediaType: string };
  /** video / audio / file payload (image keeps its own `image` field). */
  media?: { url: string; mediaType: string; durationSec?: number };
}

/**
 * Text stand-in for a media part an LLM provider can't ingest natively — a
 * provider degrades unsupported parts to this instead of dropping them, so the
 * model at least knows a video/audio/file was referenced and where it lives.
 */
export function mediaPartPlaceholder(part: ContentPart): string {
  const url = part.media?.url ?? part.image?.url ?? "";
  const label =
    part.type === "video" ? "视频" :
    part.type === "audio" ? "音频" :
    part.type === "file" ? "文件" :
    part.type === "image" ? "图片" : "媒体";
  return `[${label}: ${url}]`;
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

/** Per-call model parameters. */
export interface ChatParams {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  /** Reserved for E3's structured-output work; unread by any provider today. */
  responseSchema?: JSONSchema;
  reasoning?: "off" | number;
}

/** Streamed chunk from LLM */
export interface ChatChunk {
  type: "text" | "tool_call" | "done" | "thinking";
  content?: string;
  toolCall?: ToolCall;
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    /** Input tokens served from the provider's prompt cache, billed at a discount. */
    cachedPromptTokens?: number;
  };
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
  params?: ChatParams;
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
  /** Source conversation/message are optional generic provenance fields for business-domain tools. */
  conversationId?: string;
  sourceMessageId?: string;
  /** The original user text, supplied by the server rather than the model. */
  sourceText?: string;
  /** Model actually selected for this turn, for domain audit records only. */
  modelId?: string;
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
  /**
   * When true, a SUCCESSFUL execution of this tool ends the current agent
   * run (the turn is handed back to the user, e.g. ask_user). Remaining
   * batched tool calls are skipped; an isError result does NOT end the turn.
   */
  endsTurn?: boolean;
  /**
   * When true, this tool is a read-only/side-effect-free operation that is safe
   * to run concurrently with other parallel-safe tools in the same batch. The
   * Agent executes consecutive parallel-safe calls together (events still yield
   * in call order). Defaults to false — most tools run sequentially.
   */
  parallelSafe?: boolean;
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
