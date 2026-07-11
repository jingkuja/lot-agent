import OpenAI, {
  RateLimitError,
  InternalServerError,
  APIConnectionError,
  APIConnectionTimeoutError,
} from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type {
  Message,
  ChatChunk,
  ChatOptions,
  LLMTool,
  LLMProvider,
} from "../types/index.js";
import { mediaPartPlaceholder } from "../types/index.js";
import { withLLMRetry, isMalformedToolCallError } from "./retry.js";
import { logger } from "../logger/log.js";

const log = logger.child({ mod: "llm.openai" });

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

  async *chat(
    messages: Message[],
    tools?: LLMTool[],
    opts?: ChatOptions
  ): AsyncIterable<ChatChunk> {
    const oaiMessages = messages.map(toOpenAIMessage);
    const oaiTools = tools?.map(toOpenAITool);

    const debug = ["1", "true", "yes"].includes(
      (process.env.DEBUG_LLM ?? "").toLowerCase()
    );
    if (debug) {
      log.debug("request", {
        model: this.model,
        messages: oaiMessages.length,
        tools: oaiTools?.length ?? 0,
      });
    }

    const client = this.client;
    const model = this.model;
    const params = opts?.params;

    const createStream = () =>
      mapOpenAIStream(
        (async function* () {
          const stream = await client.chat.completions.create(
            {
              model,
              messages: oaiMessages,
              tools: oaiTools,
              tool_choice: oaiTools?.length ? "auto" : undefined,
              stream: true,
              stream_options: { include_usage: true },
              temperature: params?.temperature,
              max_tokens: params?.maxTokens,
              top_p: params?.topP,
              // Structured output: constrain generation to the JSON schema.
              // `strict: false` so arbitrary user schemas (without the strict
              // subset's additionalProperties/required rules) aren't rejected.
              ...(params?.responseSchema
                ? {
                    response_format: {
                      type: "json_schema" as const,
                      json_schema: { name: "response", schema: params.responseSchema, strict: false },
                    },
                  }
                : {}),
            },
            { signal: opts?.signal }
          );
          yield* stream;
        })()
      );

    yield* withLLMRetry(createStream, { isRetryable: isOpenAIRetryable, signal: opts?.signal });
  }
}

function isOpenAIRetryable(err: unknown): boolean {
  return (
    err instanceof RateLimitError ||
    err instanceof InternalServerError ||
    err instanceof APIConnectionError ||
    err instanceof APIConnectionTimeoutError ||
    // A 400-class rejection of truncated/garbled tool-call JSON — transient,
    // so let the model regenerate instead of killing the turn.
    isMalformedToolCallError(err)
  );
}

/**
 * Consumes the raw OpenAI-shaped chunk stream and yields ChatChunks. A
 * usage-only trailing chunk (strict `stream_options.include_usage`
 * compliance) has an EMPTY `choices` array — so `done` isn't emitted the
 * moment `finish_reason` is seen; it waits for either a usage-bearing chunk
 * (attached to the finish_reason chunk, e.g. DeepSeek, or trailing/separate,
 * e.g. spec-compliant OpenAI) or the stream ending with no usage at all
 * (a vendor that ignores `stream_options` entirely).
 */
export async function* mapOpenAIStream(
  stream: AsyncIterable<ChatCompletionChunk>
): AsyncIterable<ChatChunk> {
  const debug = ["1", "true", "yes"].includes(
    (process.env.DEBUG_LLM ?? "").toLowerCase()
  );
  const toolCallBuffers = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  let finishReason: string | undefined;

  function* flushToolCalls(): Generator<ChatChunk> {
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
    toolCallBuffers.clear();
  }

  for await (const chunk of stream) {
    // Some gateways omit `choices` entirely on the trailing usage chunk
    // (instead of the spec's empty array) — treat missing as empty.
    const choices = chunk.choices ?? [];
    if (debug) log.debug("chunk", { choice: choices[0] });

    const delta = choices[0]?.delta as
      | (ChatCompletionChunk.Choice["delta"] & { reasoning_content?: string })
      | undefined;

    if (delta?.reasoning_content) {
      yield { type: "thinking", content: delta.reasoning_content };
    }
    if (delta?.content) {
      yield { type: "text", content: delta.content };
    }

    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const index = tc.index;
        if (!toolCallBuffers.has(index)) {
          toolCallBuffers.set(index, { id: tc.id ?? "", name: "", arguments: "" });
        }
        const buf = toolCallBuffers.get(index)!;
        if (tc.id) buf.id = tc.id;
        if (tc.function?.name) buf.name = tc.function.name;
        if (tc.function?.arguments) buf.arguments += tc.function.arguments;
      }
    }

    if (choices[0]?.finish_reason) {
      finishReason = choices[0].finish_reason;
    }

    if (finishReason && (chunk.usage || choices.length === 0)) {
      yield* flushToolCalls();
      yield {
        type: "done",
        finishReason,
        usage: chunk.usage
          ? {
              promptTokens: chunk.usage.prompt_tokens,
              completionTokens: chunk.usage.completion_tokens,
            }
          : undefined,
      };
      finishReason = undefined;
    }
  }

  // Stream ended without a usage chunk ever arriving after finish_reason
  // (vendor doesn't support stream_options.include_usage at all).
  if (finishReason) {
    yield* flushToolCalls();
    yield { type: "done", finishReason };
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
      content: msg.content.map((p) => {
        if (p.type === "text") return { type: "text" as const, text: p.text ?? "" };
        if (p.type === "image") {
          return { type: "image_url" as const, image_url: { url: p.image?.url ?? "" } };
        }
        // video / audio / file — no OpenAI content type for these; degrade to text.
        return { type: "text" as const, text: mediaPartPlaceholder(p) };
      }),
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
