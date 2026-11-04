import { createHash } from "node:crypto";
import Anthropic, { APIUserAbortError } from "@anthropic-ai/sdk";
import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema.mjs";
import type {
  ContentBlockParam,
  MessageCreateParamsStreaming,
  MessageParam,
  OutputConfig,
  RawMessageStreamEvent,
  ThinkingConfigParam,
  Tool,
  TextBlockParam,
  ToolResultBlockParam,
  ImageBlockParam,
  Base64ImageSource,
} from "@anthropic-ai/sdk/resources/messages";
import { LLMResponseError } from "./errors.js";
import { withGatewayRequestId } from "./gateway-request-id.js";
import type {
  ContentPart,
  Message,
  ChatChunk,
  ChatOptions,
  ChatParams,
  LLMTool,
  LLMProvider,
} from "../types/index.js";
import { mediaPartPlaceholder } from "../types/index.js";

export interface AnthropicProviderConfig {
  apiKey: string;
  model: string;
  /** Gateway origin; a trailing `/v1` is accepted because the SDK appends `/v1/messages`. */
  baseUrl?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

const ANTHROPIC_MODEL_KEYWORDS = ["claude", "fable", "opus", "sonnet"];
const JSON_OBJECT_INSTRUCTION = "Respond with a single JSON object only, with no surrounding text or code fences.";
const DEFAULT_MAX_TOKENS = 64_000;
const LEGACY_DEFAULT_MAX_TOKENS = 8192;
/** Claude 5 models think before answering, so a tight answer cap would otherwise end the turn with no answer. */
const MIN_MAX_TOKENS_WITH_THINKING = 4096;

/** Model ids the gateway serves over its Anthropic `/v1/messages` route. */
export function isAnthropicModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return ANTHROPIC_MODEL_KEYWORDS.some((keyword) => id.includes(keyword));
}

/** Parses family and version from ids such as `claude-opus-5-5`, `claude-sonnet-4-20250514` or `fable-5.1`. */
function claudeModelInfo(model: string): { family: string; version: number } | undefined {
  const match = /(fable|mythos|opus|sonnet|haiku)[-_.]?(\d{1,2})(?!\d)(?:[-_.](\d)(?!\d))?/i.exec(model);
  return match ? { family: match[1].toLowerCase(), version: Number(match[2]) + Number(match[3] ?? 0) / 10 } : undefined;
}

/** Thinking, effort and token cap differ by generation, and each mismatch is a 400 before any output. */
function generationOptions(model: string, params?: ChatParams): {
  thinking?: ThinkingConfigParam; effort?: OutputConfig["effort"]; maxTokens: number;
} {
  const info = claudeModelInfo(model);
  const version = info?.version ?? 0;
  const summarized = { type: "adaptive", display: "summarized" } as ThinkingConfigParam;
  const cannotDisable = info?.family === "fable" || info?.family === "mythos" || (info?.family === "opus" && version >= 5.5);
  let thinking: ThinkingConfigParam | undefined;
  let effort: OutputConfig["effort"] = version >= 4.6 ? params?.reasoningEffort : undefined;
  let budget = 0;

  if (params?.reasoning === "off") {
    if (cannotDisable) {
      effort = "low"; // Effort is the only control on these models.
    } else if (info?.family === "sonnet" && version >= 5.5) {
      thinking = { type: "between_tools" } as unknown as ThinkingConfigParam;
    } else if (info) {
      thinking = { type: "disabled" };
    }
  } else if (typeof params?.reasoning === "number" && params.reasoning > 0) {
    if (version >= 4.6) thinking = summarized;
    else {
      budget = params.reasoning;
      thinking = { type: "enabled", budget_tokens: budget };
    }
  } else if (version >= 5) {
    // Already on by default; only the display is opted into so the UI can show progress.
    thinking = summarized;
  }

  const requested = params?.maxTokens ?? (version >= 4.6 ? DEFAULT_MAX_TOKENS : LEGACY_DEFAULT_MAX_TOKENS);
  const thinkingOn = cannotDisable || (version >= 5 && params?.reasoning !== "off");
  const minimum = budget ? budget + 1024 : thinkingOn ? MIN_MAX_TOKENS_WITH_THINKING : 0;
  return { thinking, effort, maxTokens: Math.max(requested, minimum) };
}

/** Stateless Messages transport. Never replay an uncertain, potentially paid POST. */
export class AnthropicProvider implements LLMProvider {
  readonly reportsAttempts = true;
  private client: Anthropic;
  private model: string;

  constructor(config: AnthropicProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      // `null` keeps a host-level ANTHROPIC_AUTH_TOKEN from being sent alongside the user's key.
      authToken: null,
      baseURL: config.baseUrl?.replace(/\/+$/, "").replace(/\/v1$/, ""),
      defaultHeaders: config.headers,
      fetch: config.fetch,
      maxRetries: 0,
    });
    this.model = config.model;
  }

  async *chat(
    messages: Message[],
    tools?: LLMTool[],
    opts?: ChatOptions
  ): AsyncIterable<ChatChunk> {
    opts?.signal?.throwIfAborted();
    const params = opts?.params;

    // Anthropic requires system prompt as a separate parameter
    const systemTexts = messages.filter((msg) => msg.role === "system").map((msg) => textOf(msg.content));
    if (params?.responseFormat === "json_object" && !params.responseSchema) systemTexts.push(JSON_OBJECT_INSTRUCTION);
    const systemText = systemTexts.join("\n\n");
    const systemBlocks: TextBlockParam[] = systemText
      ? [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }]
      : [];
    const apiTools = tools?.length ? tools.map(toAnthropicTool) : undefined;

    const conversation = toAnthropicConversation(messages, this.model, prefixDigest("", [systemText, apiTools]));
    const lastIndex = conversation.messages.length - 1;
    const cachedMessages = conversation.messages.map((msg, index) => index === lastIndex ? withCacheControl(msg) : msg);

    const { thinking, effort, maxTokens } = generationOptions(this.model, params);
    const outputConfig: OutputConfig = {
      ...(effort ? { effort } : {}),
      ...(params?.responseSchema
        ? { format: { type: "json_schema" as const, schema: transformJSONSchema(params.responseSchema) } }
        : {}),
    };

    // temperature / top_p stay out: current models reject them, and thinking excludes them on older ones.
    const body: MessageCreateParamsStreaming = {
      model: this.model,
      max_tokens: maxTokens,
      system: systemBlocks.length ? systemBlocks : undefined,
      messages: cachedMessages,
      tools: apiTools,
      stream: true,
      ...(thinking ? { thinking } : {}),
      ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    };

    opts?.onAttempt?.();
    try {
      const stream = await withGatewayRequestId(this.client.messages.create(body, { signal: opts?.signal }), opts?.onRequestId);
      yield* mapAnthropicStream(stream, { model: this.model, prefix: conversation.prefix, onResponseId: opts?.onResponseId });
      opts?.onAttemptEnd?.();
    } catch (error) {
      opts?.onAttemptEnd?.(error);
      throw error;
    }
  }
}

function textOf(content: Message["content"]): string {
  return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
}

const FINISH_REASONS: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
  refusal: "content_filter",
};

/**
 * Consumes the raw Anthropic message-stream events and yields ChatChunks.
 * Content blocks are tracked by the event's `index` (not by guessing "the
 * last one seen") so interleaved/multiple tool calls in one message route
 * their `input_json_delta` fragments correctly. Usage accumulates across
 * `message_start` (prompt + cached-prompt tokens) and `message_delta`
 * (completion tokens), landing on the `done` chunk emitted at `message_stop`.
 * With `options.model`, the finished blocks travel on `done.responseState` so a
 * tool continuation can replay thinking blocks unchanged.
 */
export async function* mapAnthropicStream(
  events: AsyncIterable<RawMessageStreamEvent>,
  options: { model?: string; prefix?: string; onResponseId?: (id: string) => void } = {}
): AsyncIterable<ChatChunk> {
  const blocks = new Map<number, ContentBlockParam>();
  const toolInputs = new Map<number, string>();
  let promptTokens = 0;
  let cachedPromptTokens = 0;
  let completionTokens = 0;
  let stopped = false;
  let finishReason = "stop";
  let responseId: string | undefined;
  const usage = () => ({ promptTokens, completionTokens, cachedPromptTokens });

  try {
    for await (const event of events) {
      if (event.type === "message_start") {
        // Anthropic splits total input across three buckets: `input_tokens` is
        // ONLY the uncached remainder; cache reads and cache writes are reported
        // separately. Bill the full input (all three) so enabling prompt caching
        // never silently drops billed tokens — this mirrors OpenAI's
        // `prompt_tokens`, which already includes cached tokens. `cachedPromptTokens`
        // stays the cached subset, for observability only.
        const u = event.message.usage;
        cachedPromptTokens = u.cache_read_input_tokens ?? 0;
        promptTokens =
          u.input_tokens + cachedPromptTokens + (u.cache_creation_input_tokens ?? 0);
        responseId = event.message.id;
        if (responseId) options.onResponseId?.(responseId);
      }

      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "tool_use") {
          blocks.set(event.index, { type: "tool_use", id: block.id, name: block.name, input: {} });
          toolInputs.set(event.index, "");
        } else if (block.type === "text") {
          blocks.set(event.index, { type: "text", text: "" });
        } else if (block.type === "thinking") {
          blocks.set(event.index, { type: "thinking", thinking: block.thinking ?? "", signature: block.signature ?? "" });
        } else if (block.type === "redacted_thinking") {
          blocks.set(event.index, { type: "redacted_thinking", data: block.data });
        }
      }

      if (event.type === "content_block_delta") {
        const block = blocks.get(event.index);
        if (event.delta.type === "text_delta") {
          if (block?.type === "text") block.text += event.delta.text;
          yield { type: "text", content: event.delta.text };
        }
        if (event.delta.type === "thinking_delta") {
          if (block?.type === "thinking") block.thinking += event.delta.thinking;
          yield { type: "thinking", content: event.delta.thinking };
        }
        if (event.delta.type === "signature_delta" && block?.type === "thinking") block.signature = event.delta.signature;
        if (event.delta.type === "input_json_delta" && toolInputs.has(event.index)) {
          toolInputs.set(event.index, toolInputs.get(event.index) + event.delta.partial_json);
        }
      }

      if (event.type === "message_delta") {
        completionTokens = event.usage.output_tokens;
        finishReason = event.delta.stop_reason ?? finishReason;
      }

      if (event.type === "message_stop") {
        stopped = true;
        if (["stop", "end_turn", "tool_use", "stop_sequence"].includes(finishReason)) {
          for (const [index, input] of toolInputs) {
            const block = blocks.get(index);
            if (block?.type !== "tool_use") continue;
            try {
              block.input = JSON.parse(input || "{}");
            } catch {
              throw new LLMResponseError("malformed tool_call arguments", usage());
            }
            yield {
              type: "tool_call",
              toolCall: { id: block.id, name: block.name, arguments: block.input },
            };
          }
        }

        const items = [...blocks.values()].filter((block) => block.type !== "text" || block.text);
        yield {
          type: "done",
          finishReason: FINISH_REASONS[finishReason] ?? finishReason,
          ...(responseId ? { responseId } : {}),
          ...(options.model ? { responseState: { model: options.model, prefix: options.prefix, items } } : {}),
          usage: usage(),
        };
      }
    }
  } catch (error) {
    // A paid generation already started: keep its usage, and never surface the upstream body.
    if (!promptTokens || error instanceof LLMResponseError || error instanceof APIUserAbortError) throw error;
    throw new LLMResponseError("Anthropic stream interrupted", usage());
  }
  if (!stopped) throw new LLMResponseError("LLM stream ended before completion (missing message_stop)", usage());
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
  if (isThinkingBlock(content[lastIndex])) return message; // Thinking blocks cannot carry a breakpoint.
  content[lastIndex] = {
    ...content[lastIndex],
    cache_control: { type: "ephemeral" },
  } as (typeof content)[number];
  return { ...message, content };
}

function isThinkingBlock(block: ContentBlockParam): boolean {
  return block.type === "thinking" || block.type === "redacted_thinking";
}

function withoutThinking(message: MessageParam): MessageParam {
  return typeof message.content === "string" ? message : { ...message, content: message.content.filter((block) => !isThinkingBlock(block)) };
}

function prefixDigest(previous: string, value: unknown): string {
  return createHash("sha256").update(previous).update(JSON.stringify(value)).digest("base64url");
}

/**
 * Builds the Messages conversation. A thinking block is bound to the system
 * prompt, tools and every earlier message, and earlier thinking blocks may only
 * be dropped from the front. Context compression rewrites history mid-run, so
 * each block's recorded prefix is compared here: everything up to the last
 * changed turn loses its thinking instead of failing the request with a 400.
 */
export function toAnthropicConversation(messages: Message[], model: string, seed: string): { messages: MessageParam[]; prefix: string } {
  const out: MessageParam[] = [];
  const recordedPrefixes = new Map<number, string>();
  let previousRole: Message["role"] | undefined;
  for (const msg of messages) {
    if (msg.role === "system") continue;
    const param = toAnthropicMessage(msg, model);
    const last = out[out.length - 1];
    if (msg.role === "tool" && previousRole === "tool" && Array.isArray(last?.content) && Array.isArray(param.content)) {
      // All results of a parallel tool call belong in one user turn.
      last.content.push(...param.content);
    } else if (param.content.length) {
      if (msg.role === "assistant" && msg.responseState?.model === model && msg.responseState.prefix !== undefined) {
        recordedPrefixes.set(out.length, msg.responseState.prefix);
      }
      out.push(param);
    }
    previousRole = msg.role;
  }

  let prefix = seed;
  let keepThinkingFrom = 0;
  out.forEach((message, index) => {
    const recorded = recordedPrefixes.get(index);
    if (recorded !== undefined && recorded !== prefix) keepThinkingFrom = index + 1;
    prefix = prefixDigest(prefix, withoutThinking(message));
  });
  return { messages: out.map((message, index) => index < keepThinkingFrom ? withoutThinking(message) : message), prefix };
}

/** Tool-call ids from other models can hold characters Anthropic rejects, such as `functions.search:0`. */
function safeToolId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function toContentBlocks(parts: ContentPart[]): Array<TextBlockParam | ImageBlockParam> {
  return parts.map((p) => {
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
    if (p.type === "text") return { type: "text", text: p.text ?? "" };
    // video / audio / file — no native block; degrade to a text placeholder.
    return { type: "text", text: mediaPartPlaceholder(p) };
  });
}

/** `model` enables replaying provider-produced blocks, which are only valid for the model that wrote them. */
export function toAnthropicMessage(msg: Message, model?: string): MessageParam {
  if (msg.role === "user") {
    return { role: "user", content: typeof msg.content === "string" ? msg.content : toContentBlocks(msg.content) };
  }

  if (msg.role === "assistant") {
    if (model && msg.responseState?.model === model) {
      return { role: "assistant", content: msg.responseState.items as ContentBlockParam[] };
    }
    const content: ContentBlockParam[] = [];
    const text = textOf(msg.content);
    if (text) content.push({ type: "text", text });
    for (const tc of msg.toolCalls ?? []) {
      content.push({
        type: "tool_use",
        id: safeToolId(tc.id),
        name: tc.name,
        input: typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments,
      });
    }
    return { role: "assistant", content };
  }

  if (msg.role === "tool") {
    const result: ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: safeToolId(msg.toolCallId ?? ""),
      content: typeof msg.content === "string" ? msg.content : toContentBlocks(msg.content),
    };
    return { role: "user", content: [result] };
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
