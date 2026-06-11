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

/** Tool execution result */
export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** Context passed to tool execution */
export interface ToolContext {
  workingDirectory: string;
}

/** Tool definition */
export interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}
