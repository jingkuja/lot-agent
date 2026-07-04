import Anthropic, {
  RateLimitError,
  InternalServerError,
  APIConnectionError,
  APIConnectionTimeoutError,
} from "@anthropic-ai/sdk";
import { withLLMRetry } from "./retry.js";
import type {
  MessageParam,
  RawMessageStreamEvent,
  Tool,
  ToolUseBlock,
  TextBlockParam,
  ToolUseBlockParam,
  ImageBlockParam,
  Base64ImageSource,
} from "@anthropic-ai/sdk/resources/messages";
import type {
  Message,
  ChatChunk,
  ChatOptions,
  LLMTool,
  LLMProvider,
} from "../types/index.js";

export interface AnthropicProviderConfig {
  apiKey: string;
  model: string;
}

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;

  constructor(config: AnthropicProviderConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model;
  }

  async *chat(
    messages: Message[],
    tools?: LLMTool[],
    opts?: ChatOptions
  ): AsyncIterable<ChatChunk> {
    // Anthropic requires system prompt as a separate parameter
    const systemMessages: string[] = [];
    const chatMessages: MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemMessages.push(String(msg.content));
      } else {
        chatMessages.push(toAnthropicMessage(msg));
      }
    }

    const anthropicTools = tools?.map(toAnthropicTool);
    const params = opts?.params;

    const systemText = systemMessages.join("\n\n");
    const systemBlocks: TextBlockParam[] = systemText
      ? [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }]
      : [];

    const cachedMessages =
      chatMessages.length > 0
        ? [
            ...chatMessages.slice(0, -1),
            withCacheControl(chatMessages[chatMessages.length - 1]),
          ]
        : chatMessages;

    const createStream = () =>
      mapAnthropicStream(
        this.client.messages.stream(
          {
            model: this.model,
            max_tokens: params?.maxTokens ?? 8192,
            temperature: params?.temperature,
            top_p: params?.topP,
            system: systemBlocks.length ? systemBlocks : undefined,
            messages: cachedMessages,
            tools: anthropicTools,
          },
          { signal: opts?.signal }
        )
      );

    yield* withLLMRetry(createStream, { isRetryable: isAnthropicRetryable });
  }
}

function isAnthropicRetryable(err: unknown): boolean {
  return (
    err instanceof RateLimitError ||
    err instanceof InternalServerError ||
    err instanceof APIConnectionError ||
    err instanceof APIConnectionTimeoutError
  );
}

/**
 * Consumes the raw Anthropic message-stream events and yields ChatChunks.
 * Tool-use blocks are tracked by the event's `index` (not by guessing "the
 * last one seen") so interleaved/multiple tool calls in one message route
 * their `input_json_delta` fragments correctly. Usage accumulates across
 * `message_start` (prompt + cached-prompt tokens) and `message_delta`
 * (completion tokens), landing on the `done` chunk emitted at `message_stop`
 * — previously `done` carried no usage at all.
 */
export async function* mapAnthropicStream(
  events: AsyncIterable<RawMessageStreamEvent>
): AsyncIterable<ChatChunk> {
  const toolBuffers = new Map<number, { id: string; name: string; input: string }>();
  let promptTokens = 0;
  let cachedPromptTokens = 0;
  let completionTokens = 0;

  for await (const event of events) {
    if (event.type === "message_start") {
      promptTokens = event.message.usage.input_tokens;
      cachedPromptTokens = event.message.usage.cache_read_input_tokens ?? 0;
    }

    if (event.type === "content_block_start") {
      if (event.content_block.type === "tool_use") {
        const block = event.content_block as ToolUseBlock;
        toolBuffers.set(event.index, { id: block.id, name: block.name, input: "" });
      }
    }

    if (event.type === "content_block_delta") {
      if (event.delta.type === "text_delta") {
        yield { type: "text", content: event.delta.text };
      }
      if (event.delta.type === "thinking_delta") {
        yield { type: "thinking", content: event.delta.thinking };
      }
      if (event.delta.type === "input_json_delta") {
        const buf = toolBuffers.get(event.index);
        if (buf) buf.input += event.delta.partial_json;
      }
    }

    if (event.type === "content_block_stop") {
      const buf = toolBuffers.get(event.index);
      if (buf && (buf.input || buf.name)) {
        let parsedArgs: unknown;
        try {
          parsedArgs = JSON.parse(buf.input || "{}");
        } catch {
          parsedArgs = buf.input;
        }
        yield {
          type: "tool_call",
          toolCall: { id: buf.id, name: buf.name, arguments: parsedArgs },
        };
        toolBuffers.delete(event.index);
      }
    }

    if (event.type === "message_delta") {
      completionTokens = event.usage.output_tokens;
    }

    if (event.type === "message_stop") {
      for (const buf of toolBuffers.values()) {
        let parsedArgs: unknown;
        try {
          parsedArgs = JSON.parse(buf.input || "{}");
        } catch {
          parsedArgs = buf.input;
        }
        yield {
          type: "tool_call",
          toolCall: { id: buf.id, name: buf.name, arguments: parsedArgs },
        };
      }
      toolBuffers.clear();

      yield {
        type: "done",
        finishReason: "stop",
        usage: { promptTokens, completionTokens, cachedPromptTokens },
      };
    }
  }
}

/**
 * Attaches an ephemeral cache-control breakpoint: to the whole message when
 * its content is a plain string (wrapped into a single text block), or to
 * the LAST content block when it's already an array. Anthropic bills a
 * cache-read of everything up to and including a breakpoint at a steep
 * discount versus a fresh prompt, so this is placed on the system block
 * (below) and the trailing edge of history — both stable, prefix-cached
 * points per `ContextManager.assemble`'s structure.
 */
export function withCacheControl(message: MessageParam): MessageParam {
  if (typeof message.content === "string") {
    if (!message.content) return message; // nothing to cache-break on an empty message
    return {
      ...message,
      content: [
        { type: "text", text: message.content, cache_control: { type: "ephemeral" } },
      ],
    };
  }
  if (message.content.length === 0) return message;
  const content = [...message.content];
  const lastIndex = content.length - 1;
  content[lastIndex] = {
    ...content[lastIndex],
    cache_control: { type: "ephemeral" },
  } as (typeof content)[number];
  return { ...message, content };
}

export function toAnthropicMessage(msg: Message): MessageParam {
  if (msg.role === "user") {
    if (typeof msg.content === "string") {
      return { role: "user", content: msg.content };
    }
    const content: Array<TextBlockParam | ImageBlockParam> = msg.content.map(
      (p) => {
        if (p.type === "image" && p.image) {
          const m = /^data:([^;]+);base64,(.*)$/.exec(p.image.url);
          if (m) {
            return {
              type: "image",
              source: {
                type: "base64",
                media_type: m[1] as Base64ImageSource["media_type"],
                data: m[2],
              },
            };
          }
          // 非 data URL（兜底）：当作文本提示，避免直接丢弃
          return { type: "text", text: `[图片: ${p.image.url}]` };
        }
        return { type: "text", text: p.text ?? "" };
      }
    );
    return { role: "user", content };
  }

  if (msg.role === "assistant") {
    const content: Array<TextBlockParam | ToolUseBlockParam> = [];
    if (typeof msg.content === "string" && msg.content) {
      content.push({ type: "text", text: msg.content });
    }
    if (msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input:
            typeof tc.arguments === "string"
              ? JSON.parse(tc.arguments)
              : tc.arguments,
        });
      }
    }
    return { role: "assistant", content };
  }

  if (msg.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: msg.toolCallId ?? "",
          content: String(msg.content),
        },
      ],
    };
  }

  throw new Error(`Unsupported role for Anthropic: ${msg.role}`);
}

function toAnthropicTool(tool: LLMTool): Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Tool["input_schema"],
  };
}
