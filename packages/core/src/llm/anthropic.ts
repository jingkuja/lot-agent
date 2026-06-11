import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  Tool,
  ToolUseBlock,
  TextBlockParam,
  ToolUseBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import type { Message, ChatChunk, LLMTool, LLMProvider } from "../types/index.js";

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

  async *chat(messages: Message[], tools?: LLMTool[]): AsyncIterable<ChatChunk> {
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

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 8192,
      system: systemMessages.join("\n\n") || undefined,
      messages: chatMessages,
      tools: anthropicTools,
    });

    // Buffer for accumulating tool use blocks
    const toolBuffers = new Map<
      string,
      { id: string; name: string; input: string }
    >();

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") {
          const block = event.content_block as ToolUseBlock;
          toolBuffers.set(block.id, {
            id: block.id,
            name: block.name,
            input: "",
          });
        }
      }

      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          yield { type: "text", content: event.delta.text };
        }
        if (event.delta.type === "input_json_delta") {
          // Find the current tool being accumulated
          const lastKey = [...toolBuffers.keys()].pop();
          if (lastKey) {
            const buf = toolBuffers.get(lastKey)!;
            buf.input += event.delta.partial_json;
          }
        }
      }

      if (event.type === "content_block_stop") {
        // Check if a tool block just finished
        const lastKey = [...toolBuffers.keys()].pop();
        if (lastKey) {
          const buf = toolBuffers.get(lastKey)!;
          // Only emit if this block hasn't been emitted yet
          if (buf.input || buf.name) {
            let parsedArgs: unknown;
            try {
              parsedArgs = JSON.parse(buf.input || "{}");
            } catch {
              parsedArgs = buf.input;
            }
            yield {
              type: "tool_call",
              toolCall: {
                id: buf.id,
                name: buf.name,
                arguments: parsedArgs,
              },
            };
            toolBuffers.delete(lastKey);
          }
        }
      }

      if (event.type === "message_stop") {
        // Flush any remaining tool buffers
        for (const buf of toolBuffers.values()) {
          let parsedArgs: unknown;
          try {
            parsedArgs = JSON.parse(buf.input || "{}");
          } catch {
            parsedArgs = buf.input;
          }
          yield {
            type: "tool_call",
            toolCall: {
              id: buf.id,
              name: buf.name,
              arguments: parsedArgs,
            },
          };
        }
        toolBuffers.clear();

        yield {
          type: "done",
          finishReason: "stop",
        };
      }
    }
  }
}

function toAnthropicMessage(msg: Message): MessageParam {
  if (msg.role === "user") {
    if (typeof msg.content === "string") {
      return { role: "user", content: msg.content };
    }
    const content: TextBlockParam[] = msg.content
      .filter((p) => p.type === "text")
      .map((p) => ({ type: "text", text: p.text ?? "" }));
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
