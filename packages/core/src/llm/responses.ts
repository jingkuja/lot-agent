import OpenAI, { type ClientOptions } from "openai";
import type { Response, ResponseInputItem, ResponseStreamEvent, ResponseCreateParamsStreaming } from "openai/resources/responses/responses";
import type { ChatChunk, ChatOptions, LLMProvider, LLMTool, Message } from "../types/index.js";
import { mediaPartPlaceholder } from "../types/index.js";
import { LLMResponseError } from "./errors.js";
import type { OpenAIProviderConfig } from "./openai.js";
import { withGatewayRequestId } from "./gateway-request-id.js";

/** Stateless Responses transport. Never replay an uncertain, potentially paid POST. */
export class OpenAIResponsesProvider implements LLMProvider {
  readonly reportsAttempts = true;
  private readonly client: OpenAI;
  constructor(private readonly config: OpenAIProviderConfig, transport: Pick<ClientOptions, "fetch"> = {}) {
    this.client = new OpenAI({
      ...transport, apiKey: config.apiKey, baseURL: config.baseUrl?.replace(/\/+$/, ""), defaultHeaders: config.headers, maxRetries: 0,
      fetch: transport.fetch ?? config.fetch as ClientOptions["fetch"],
    });
  }

  async *chat(messages: Message[], tools?: LLMTool[], opts?: ChatOptions): AsyncIterable<ChatChunk> {
    opts?.signal?.throwIfAborted();
    const params = opts?.params;
    const request: ResponseCreateParamsStreaming = {
      model: this.config.model,
      input: toResponsesInput(messages, this.config.model),
      store: false,
      include: ["reasoning.encrypted_content"],
      stream: true,
      max_output_tokens: params?.maxTokens,
      temperature: params?.temperature,
      top_p: params?.topP,
      // SDK 4.x predates the documented `none` effort; keep this wire-only
      // extension local instead of leaking vendor `thinking` into Responses.
      ...(params?.reasoning === "off" ? { reasoning: { effort: "none" } as unknown as ResponseCreateParamsStreaming["reasoning"] }
        : params?.reasoningEffort ? { reasoning: { effort: params.reasoningEffort } } : {}),
      ...(tools?.length ? { tools: tools.map(t => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.parameters, strict: false })), tool_choice: "auto" as const } : {}),
      ...(params?.responseSchema ? { text: { format: { type: "json_schema" as const, name: "response", schema: params.responseSchema, strict: false } } }
        : params?.responseFormat ? { text: { format: { type: "json_object" as const } } } : {}),
    };
    opts?.onAttempt?.();
    try {
      const stream = await withGatewayRequestId(this.client.responses.create(request, { signal: opts?.signal }), opts?.onRequestId);
      yield* mapResponsesStream(stream, this.config.model, opts?.onResponseId);
      opts?.onAttemptEnd?.();
    } catch (error) {
      opts?.onAttemptEnd?.(error);
      throw error;
    }
  }
}

export function toResponsesInput(messages: Message[], model: string): ResponseInputItem[] {
  return messages.flatMap((msg): ResponseInputItem[] => {
    if (msg.role === "tool") {
      if (!msg.toolCallId) throw new Error("Missing function call identity");
      return [{ type: "function_call_output", call_id: msg.toolCallId, output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) }];
    }
    if (msg.role === "assistant" && msg.responseState?.model === model) {
      // Only provider-produced items travel here; state is request-local and
      // must never be accepted from a client or reused for a different model.
      return msg.responseState.items as ResponseInputItem[];
    }
    const content = typeof msg.content === "string" ? msg.content : msg.content.map(p =>
      p.type === "image" && msg.role === "user" ? { type: "input_image" as const, image_url: p.image?.url ?? "", detail: "auto" as const }
        : { type: "input_text" as const, text: p.type === "text" ? p.text ?? "" : mediaPartPlaceholder(p) });
    const items: ResponseInputItem[] = [];
    if (content.length) items.push({ role: msg.role, content });
    for (const tc of msg.toolCalls ?? []) items.push({ type: "function_call", call_id: tc.id, name: tc.name, arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments) });
    return items;
  });
}

function responseUsage(response: Response): ChatChunk["usage"] {
  const u = response.usage;
  if (!u) return undefined;
  if (![u.input_tokens, u.output_tokens].every(n => Number.isSafeInteger(n) && n >= 0)) throw new LLMResponseError("Invalid Responses usage");
  if (u.input_tokens_details?.cached_tokens != null && (!Number.isSafeInteger(u.input_tokens_details.cached_tokens) || u.input_tokens_details.cached_tokens < 0 || u.input_tokens_details.cached_tokens > u.input_tokens)) throw new LLMResponseError("Invalid Responses cached usage");
  return { promptTokens: u.input_tokens, completionTokens: u.output_tokens,
    ...(u.input_tokens_details?.cached_tokens != null ? { cachedPromptTokens: u.input_tokens_details.cached_tokens } : {}) };
}

export async function* mapResponsesStream(stream: AsyncIterable<ResponseStreamEvent>, model: string, onResponseId?: (id: string) => void): AsyncIterable<ChatChunk> {
  let terminal: Response | undefined;
  let terminalChunks: ChatChunk[] = [];
  let usage: ChatChunk["usage"];
  let refusal = false;
  const streamed = new Map<string, string>();
  const iterator = stream[Symbol.asyncIterator]();
  let tailTimer: ReturnType<typeof setTimeout> | undefined;
  let tailDeadline: Promise<null> | undefined;
  let exhausted = false;
  try {
    for (;;) {
      const next = tailDeadline ? await Promise.race([iterator.next(), tailDeadline]) : await iterator.next();
      if (!next) break;
      if (next.done) { exhausted = true; break; }
      const event = next.value;
      if (terminal) continue;
      if (event.type === "response.created") onResponseId?.(event.response.id);
      if (event.type === "response.output_text.delta") {
        const key = `${event.output_index}:${event.content_index}`;
        streamed.set(key, (streamed.get(key) ?? "") + event.delta);
        yield { type: "text", content: event.delta };
      } else if (event.type === "response.reasoning_summary_text.delta") {
        yield { type: "thinking", content: event.delta };
      } else if (event.type === "response.refusal.delta" || event.type === "response.refusal.done") {
        refusal = true;
      } else if (["response.completed", "response.incomplete", "response.failed"].includes(event.type)) {
        const response = (event as { response: Response }).response;
        usage = responseUsage(response);
        if (response.status !== event.type.slice("response.".length)) throw new LLMResponseError("Inconsistent Responses terminal event", usage);
        // Validate and retain the entire first terminal before reading the tail.
        // A reset or cancellation after this point cannot erase a valid result.
        terminalChunks = response.status === "failed" ? [] : completedChunks(response, model, streamed, refusal, usage);
        terminal = response;
        // Normally EOF follows immediately. Give the gateway a short chance to
        // close cleanly, independently of potentially unbounded caller signals.
        tailDeadline = new Promise(resolve => { tailTimer = setTimeout(() => resolve(null), 1000); });
      } else if (event.type === "error") {
        // Never expose upstream bodies (which can contain prompts or keys).
        throw new LLMResponseError("Responses stream error", usage);
      }
    }
  } catch (error) {
    if (!terminal) {
      if (usage && !(error instanceof LLMResponseError)) throw new LLMResponseError("Responses stream interrupted", usage);
      throw error;
    }
  } finally {
    clearTimeout(tailTimer);
    if (!exhausted) {
      // SDK Stream.return can wait behind a stuck read. Abort its own transport,
      // never the caller's signal, and do not wait indefinitely for cleanup.
      (stream as { controller?: AbortController }).controller?.abort();
      void iterator.return?.().catch(() => {});
    }
  }
  if (!terminal) throw new LLMResponseError("Responses stream ended before completion", usage);
  if (terminal.status === "failed" || terminal.status === "cancelled") throw new LLMResponseError(`Responses ${terminal.status}`, usage);
  yield* terminalChunks;
}

function completedChunks(terminal: Response, model: string, streamed: Map<string, string>, refusal: boolean, usage: ChatChunk["usage"]): ChatChunk[] {
  if (terminal.status === "incomplete") {
    return [{ type: "done", finishReason: terminal.incomplete_details?.reason === "max_output_tokens" ? "length" : "content_filter", usage }];
  }
  if (terminal.status !== "completed") throw new LLMResponseError("Invalid Responses terminal status", usage);
  if (!Array.isArray(terminal.output)) throw new LLMResponseError("Invalid Responses output", usage);
  const chunks: ChatChunk[] = [];
  const calls: NonNullable<ChatChunk["toolCall"]>[] = [];
  const ids = new Set<string>();
  for (const [index, item] of terminal.output.entries()) {
    if (item.type === "message") {
      if (item.status !== "completed") throw new LLMResponseError("Incomplete Responses message", usage);
      for (const [partIndex, part] of item.content.entries()) {
        if (part.type === "refusal") refusal = true;
        if (part.type !== "output_text") continue;
        const prior = streamed.get(`${index}:${partIndex}`) ?? "";
        if (!part.text.startsWith(prior)) throw new LLMResponseError("Inconsistent Responses text", usage);
        if (part.text.length > prior.length) chunks.push({ type: "text", content: part.text.slice(prior.length) });
      }
    } else if (item.type === "function_call") {
      if (!item.call_id || !item.name || ids.has(item.call_id) || (item.status && item.status !== "completed")) throw new LLMResponseError("Invalid Responses function identity", usage);
      ids.add(item.call_id);
      let args: unknown;
      try { args = JSON.parse(item.arguments); }
      catch { throw new LLMResponseError("Invalid Responses function arguments", usage); }
      calls.push({ id: item.call_id, name: item.name, arguments: args });
    } else if (item.type !== "reasoning") throw new LLMResponseError("Unsupported Responses output item", usage);
  }
  // Validate every call before dispatching any; never execute refusal or
  // truncated output. Function schemas/allowlists remain the registry's job.
  if (!refusal) for (const toolCall of calls) chunks.push({ type: "tool_call", toolCall });
  chunks.push({ type: "done", finishReason: refusal ? "content_filter" : calls.length ? "tool_calls" : "stop", usage,
    responseId: terminal.id, responseState: { model, items: terminal.output } });
  return chunks;
}
