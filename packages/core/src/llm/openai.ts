import OpenAI from "openai";
import type {
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { Message, ChatChunk, LLMTool, LLMProvider } from "../types/index.js";

export interface OpenAIProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
}

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor(config: OpenAIProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    this.model = config.model;
  }

  async *chat(messages: Message[], tools?: LLMTool[]): AsyncIterable<ChatChunk> {
    const oaiMessages = messages.map(toOpenAIMessage);
    const oaiTools = tools?.map(toOpenAITool);

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: oaiMessages,
      tools: oaiTools,
      tool_choice: oaiTools?.length ? "auto" : undefined,
      stream: true,
    });

    // Buffer for accumulating tool call arguments
    const toolCallBuffers = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      // Handle text content
      if (delta.content) {
        yield { type: "text", content: delta.content };
      }

      // Handle tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index;
          if (!toolCallBuffers.has(index)) {
            toolCallBuffers.set(index, {
              id: tc.id ?? "",
              name: "",
              arguments: "",
            });
          }
          const buf = toolCallBuffers.get(index)!;
          if (tc.id) buf.id = tc.id;
          if (tc.function?.name) buf.name = tc.function.name;
          if (tc.function?.arguments) buf.arguments += tc.function.arguments;
        }
      }

      // Handle finish
      if (chunk.choices[0]?.finish_reason) {
        // Flush buffered tool calls
        for (const buf of toolCallBuffers.values()) {
          let parsedArgs: unknown;
          try {
            parsedArgs = JSON.parse(buf.arguments);
          } catch {
            parsedArgs = buf.arguments;
          }
          yield {
            type: "tool_call",
            toolCall: { id: buf.id, name: buf.name, arguments: parsedArgs },
          };
        }

        yield {
          type: "done",
          finishReason: chunk.choices[0].finish_reason,
          usage: chunk.usage
            ? {
                promptTokens: chunk.usage.prompt_tokens,
                completionTokens: chunk.usage.completion_tokens,
              }
            : undefined,
        };
      }
    }
  }
}

export function toOpenAIMessage(msg: Message): OpenAI.ChatCompletionMessageParam {
  if (msg.role === "system") {
    return { role: "system", content: String(msg.content) };
  }
  if (msg.role === "user") {
    if (typeof msg.content === "string") {
      return { role: "user", content: msg.content };
    }
    return {
      role: "user",
      content: msg.content.map((p) =>
        p.type === "text"
          ? { type: "text" as const, text: p.text ?? "" }
          : {
              type: "image_url" as const,
              image_url: { url: p.image?.url ?? "" },
            }
      ),
    };
  }
  if (msg.role === "assistant") {
    const result: OpenAI.ChatCompletionAssistantMessageParam = {
      role: "assistant",
      content: typeof msg.content === "string" ? msg.content : null,
    };
    if (msg.toolCalls?.length) {
      result.tool_calls = msg.toolCalls.map(
        (tc): ChatCompletionMessageToolCall => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments:
              typeof tc.arguments === "string"
                ? tc.arguments
                : JSON.stringify(tc.arguments),
          },
        })
      );
    }
    return result;
  }
  if (msg.role === "tool") {
    return {
      role: "tool" as const,
      tool_call_id: msg.toolCallId ?? "",
      content: String(msg.content),
    };
  }
  throw new Error(`Unknown role: ${msg.role}`);
}

function toOpenAITool(tool: LLMTool): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
