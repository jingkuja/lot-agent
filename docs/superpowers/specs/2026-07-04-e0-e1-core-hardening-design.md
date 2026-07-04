# E0 + E1 core hardening — design

**Date:** 2026-07-04
**Status:** Approved (brainstorming complete, proceeding to implementation plan)
**Source:** `update-ext.md` §2 "E0 — 计费正确性与工具安全基线" and "E1 — LLM 调用层升级"

## Goal

Land the two highest-priority phases from `update-ext.md`'s core-extension roadmap:

- **E0**: fix silently-wrong billing (Anthropic usage always 0; OpenAI usage depends on vendor
  default behavior) and close two real security holes in the builtin tools (path traversal, SSRF)
  before the platform has more than one trusted user.
- **E1**: bring the LLM call layer up to "business-ready" — callers can set per-call params
  (temperature/maxTokens/topP), transient failures self-heal via retry, reasoning-model output is
  surfaced instead of silently dropped, and Anthropic prompt caching is wired for the free latency/
  cost win.

Unlike `update-ext.md`'s original core-only framing, this pass also wires the **server and web**
layers where E1 features need a visible surface (chat UI must show thinking output; the agent
definition's new `modelParams` field must actually reach the LLM call) — the user explicitly asked
for `server`/`web` to be included this round rather than left as a "server 需同步接线" TODO.

## Dependency change

`@anthropic-ai/sdk` bumps from `^0.30.0` → `^0.110.0` (npm latest as of 2026-07-04). Confirmed by
installing 0.110.0 in isolation and diffing its `messages.d.ts` against the installed 0.30.1:

- The streaming event skeleton is unchanged: `content_block_start` / `content_block_delta` /
  `content_block_stop` / `message_start` / `message_delta` / `message_stop` all still exist with
  the same discriminants, so `anthropic.ts`'s event-handling structure survives the bump.
- `cache_control` (prompt caching) is now on the **main** `messages` resource's block-param types
  (0.30.1 only had it under the deprecated `beta.promptCaching` namespace).
- `ThinkingDelta` (`content_block_delta` variant with `type: "thinking_delta"`) exists in 0.110.0
  and did not exist at all in 0.30.1 — extended thinking is a genuinely new capability, not a typing
  gap.
- `Usage` gained `cache_creation_input_tokens` / `cache_read_input_tokens` (0.30.1's `Usage` didn't
  track cache tokens).

Risk: bumping ~80 minor versions could carry unrelated breaking changes in parts of the SDK this
codebase doesn't use. Mitigation: after the bump, `npm run build -w @lot-agent/core` and
`npm test -w @lot-agent/core` must pass, plus the existing `message-mapping.test.ts` (pure mapping
functions) re-verified as-is.

## E0 — billing correctness + tool safety baseline

### `packages/core/src/llm/anthropic.ts`

- **Usage accounting**: accumulate `message_start.message.usage.input_tokens` as the base, add
  `message_delta.usage.output_tokens` when the `message_delta` event arrives, and include
  `{ promptTokens, completionTokens, cachedPromptTokens }` on the `done` chunk emitted at
  `message_stop` (previously `done` carried no `usage` at all → billing recorded 0 for every
  Anthropic call).
- **Tool block tracking by index**: `content_block_start`/`content_block_delta`/`content_block_stop`
  events all carry an `index` field identifying which content block they belong to. Replace the
  `toolBuffers: Map<string /* tool_use id */, ...>` + `[...keys()].pop()` "guess the last one"
  approach with `toolBuffers: Map<number /* block index */, ...>`, keyed by the event's `index`.
  This removes a correctness bug: interleaved/multiple tool_use blocks in one message currently risk
  routing `input_json_delta` fragments to the wrong tool call.

### `packages/core/src/llm/openai.ts`

- Add `stream_options: { include_usage: true }` to the `chat.completions.create` call when
  `stream: true`. The current code depends on the vendor defaulting to emitting `usage` on the final
  chunk (DeepSeek happens to); a strict OpenAI-spec-compliant endpoint would silently zero out
  billing. The existing `chunk.choices[0]?.delta` optional-chaining already tolerates the
  usage-only trailing chunk having an empty `choices` array, so no other change is needed here.

### Testability refactor (both providers)

Extract the "consume the SDK's raw event/chunk stream → yield `ChatChunk`" loop body into an
exported, pure(ish) async-generator function:

- `anthropic.ts`: `mapAnthropicStream(events: AsyncIterable<Anthropic.Messages.RawMessageStreamEvent>): AsyncIterable<ChatChunk>`
- `openai.ts`: `mapOpenAIStream(chunks: AsyncIterable<OpenAI.ChatCompletionChunk>): AsyncIterable<ChatChunk>`

`chat()` becomes `yield* mapXxxStream(rawStream)`. This mirrors the existing pattern where
`toAnthropicMessage`/`toOpenAIMessage` are already extracted, pure, and tested directly in
`message-mapping.test.ts` — the new stream-mapping functions get the same treatment, letting tests
feed a hand-built array of fake SDK events without touching the real client or network.

### `packages/core/src/tools/builtins.ts`

- **Path containment**: after `resolvePath`, assert
  `resolved === workingDirectory || resolved.startsWith(workingDirectory + sep)`; otherwise return
  `{ isError: true, errorKind: "permission" }`. Applies to `read_file`, `write_file`, `list_files`,
  `search_files`. Currently `../../etc/passwd`-style paths escape the working directory freely.
- **SSRF guard** (new `packages/core/src/tools/net-guard.ts`): `assertPublicUrl(url, opts?)` resolves
  the URL's host via DNS and rejects private/loopback/link-local ranges (`10/8`, `172.16/12`,
  `192.168/16`, `127/8`, `169.254/16`, `::1`, `fc00::/7`). `resolve` is an injectable parameter
  (default `dns.promises.lookup`) so tests can stub arbitrary hostnames without real DNS.
  `web_fetch`'s `fetchWithTimeout` switches to `redirect: "manual"` and manually follows up to 3
  redirects, re-checking each hop's target through the same guard (a same-origin redirect to an
  internal address is the classic SSRF bypass). An env var (`WEB_FETCH_ALLOW_HOSTS`, comma-separated
  hostnames) lets self-hosted deployments allow specific internal domains.
- **`execute_command` cancellation**: switch `execFileAsync` to pass `{ signal: context.signal }` —
  Node's `child_process` natively kills the subprocess when the signal aborts. Catch the abort
  explicitly and return a consistent `{ isError: true, errorKind: "unknown", content: "aborted" }}`
  shape rather than falling through to the generic "Command failed: ..." message.

### `packages/core/src/tools/validate.ts` (new)

`validateToolInput(schema: JSONSchema, input: unknown): string[]` — shallow validator: checks
`required` fields are present and, for each key in `schema.properties`, checks the JS runtime type
matches the schema's declared `type` (string/number/boolean/array/object). No recursion into nested
object/array item schemas, no `format`/`pattern`/`enum` support — deliberately minimal, matching
`update-ext.md`'s explicit preference for a hand-rolled checker over adding an Ajv dependency.
Returns `[]` when valid. `ToolRegistry.execute` calls this before `tool.execute`; a non-empty result
short-circuits to `{ isError: true, errorKind: "validation", content: <joined messages> }` and does
**not** consume a retry attempt (structured, not transient, failure).

### `packages/core/src/logger/trace.ts`

- `TraceManager` constructor takes an optional `maxTraces` (default 200). When `startTrace` would
  exceed it, evict the oldest trace (FIFO by insertion order) and cascade-delete its spans from the
  `spans` map. Currently both maps grow unbounded for the life of the process.
- `getTraceForConversation` currently returns the **first** matching trace found while iterating the
  map (insertion order ≈ oldest first) — semantically backwards for "show me the latest trace for
  this conversation". Change to track/return the most recent one.

## E1 — LLM call layer upgrade

### `packages/core/src/types/index.ts`

```ts
export interface ChatParams {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  /** Reserved for E3's structured-output work; unused by E1 itself. */
  responseSchema?: JSONSchema;
  reasoning?: "off" | number;
}
// ChatOptions gains: params?: ChatParams
// ChatChunk.type gains: "thinking" (content field reused)
// ChatChunk.usage gains: cachedPromptTokens?: number
```

### `packages/core/src/agents/types.ts`

`AgentDefinition` gains `modelParams?: ChatParams`.

### `packages/core/src/agent/agent.ts`

- `AgentConfig` gains `modelParams?: ChatParams`, passed as `context.llm.chat(messages, tools, { signal, params: this.config.modelParams })`.
- `AgentEvent` gains `{ type: "thinking"; content: string }`. When a `thinking` chunk arrives from
  the LLM, forward it as an `AgentEvent` immediately — but do **not** append it to `workingHistory`
  (it's a display-only side channel; folding it into the context that gets replayed to the model
  next iteration would waste tokens on content the model didn't ask to see again).
- Accumulate `cachedPromptTokens` the same way `inputTokens`/`outputTokens` already accumulate, and
  include it on the `done` event (`cachedPromptTokens: number`, defaulting to 0) — collected for
  observability, not fed into billing this round (see Non-goals).

### `packages/core/src/llm/retry.ts` (new)

```ts
export interface LLMRetryConfig {
  maxRetries?: number;              // default 2
  baseDelayMs?: number;             // default 1000
  isRetryable?(err: unknown): boolean;   // default: HTTP 429/5xx or network-error heuristics
  retryAfterMs?(err: unknown): number | undefined;  // reads Retry-After when the SDK error exposes headers
}

export function withLLMRetry(
  createStream: () => AsyncIterable<ChatChunk>,
  cfg?: LLMRetryConfig
): AsyncIterable<ChatChunk>;
```

Only retries when the failing attempt **has not yielded any chunk yet** — once text has started
streaming to the caller, a retry would either duplicate output or require the caller to discard
partial state, so a failure past that point propagates as a normal error instead. Exponential
backoff with jitter, capped, honoring `Retry-After` when present.

Each provider's `chat()` wraps its stream-creation step in this helper. For OpenAI, since
`chat.completions.create()` is itself async, the whole "await create() + map to ChatChunk" body is
wrapped in an `async function*` — calling an async generator function returns the iterable
synchronously without starting execution, so `createStream()` naturally re-issues a fresh HTTP
request on every retry attempt.

### `packages/core/src/llm/complete.ts` (new)

`complete(llm: LLMProvider, messages: Message[], opts?: ChatOptions): Promise<string>` — drains a
`chat()` stream and concatenates `text` chunks. Replaces the hand-rolled `for await` loop in
`context-manager.ts`'s private `summarize()` method (the one other core call site with this exact
pattern; the memory-extraction LLM call lives in server and is out of scope here per
`update-ext.md`'s core-only boundary for that specific item).

### Reasoning / thinking content

- **Anthropic**: consume `content_block_delta` events where `delta.type === "thinking_delta"`,
  yielding `{ type: "thinking", content: delta.thinking }`.
- **OpenAI/DeepSeek**: consume `delta.reasoning_content` (not part of the official OpenAI delta
  type — DeepSeek's own convention — accessed via a type assertion), yielding the same shape.

### Prompt caching (Anthropic only)

Add `cache_control: { type: "ephemeral" }` to the system block and to the last content block of the
final message in `chatMessages` (the two points `ContextManager.assemble` already keeps stable
across turns thanks to its prefix-caching-friendly structure — see `context-manager.ts`'s docblock).
Map `usage.cache_read_input_tokens` → `ChatChunk.usage.cachedPromptTokens`.

### `packages/core/src/llm/index.ts`

Export `withLLMRetry` and `complete` alongside the existing provider/factory exports.

## Server wiring

### `packages/server/src/services/agent-service.ts`

- Pass `modelParams: def.modelParams` when constructing `new Agent({ ...this.agentConfig, ... })` —
  currently nothing populates this field on any `AgentDefinition`, so it's inert until a definition
  sets it, but the plumbing needs to exist for E1's `ChatParams` to ever reach an LLM call.
- Add a `currentThinking` accumulator parallel to `currentToolCalls`/`assistantContent`: append on
  `event.type === "thinking"`, reset to `""` at the same point `currentToolCalls = []` resets (after
  each `tool_result`, since that's an iteration boundary — one assistant DB row per ReAct
  iteration).
- Pass `currentThinking` into `saveAssistantWithToolCalls(...)` and the final `saveFinalAssistant(...)`
  call.
- Read `cachedPromptTokens` off the `done` event and pass it to `recorder.finish({ totalTokens,
  cachedPromptTokens, errorMessage })` — persisted into the trace's existing freeform `metadata`
  JSONB column for observability. **Not** passed to `usageMeter.record` — billing calculation is
  unchanged this round (see Non-goals).

### `packages/server/src/services/message-repository.ts`

`saveAssistantWithToolCalls` and `saveFinalAssistant` each gain an optional trailing `thinking?:
string` parameter, forwarded as `metadata: thinking ? { thinking } : {}` to `db.addMessage` (same
JSONB column already used for attachment/generation metadata on other message kinds — no schema
migration).

### `packages/server/src/services/sse-adapter.ts`

`agentEventToSse`'s switch gains `case "thinking": return { type: "thinking", content: event.content
};`. The function is written to be total over the `AgentEvent` union, so TypeScript will fail the
build if this case is missed once `AgentEvent` grows the new variant.

### `packages/server/src/services/trace-recorder.ts`

`finish()` gains an optional `cachedPromptTokens?: number` parameter, written to
`trace.metadata.cachedPromptTokens` the same way `totalTokens` already is — no DB schema change (it
rides in the existing `metadata` JSONB column on the `traces` table).

## Web wiring

### `packages/web/src/api/client.ts`

`AgentEvent.type` union gains `"thinking"` (reuses the existing `content` field — no new field
needed).

### `packages/web/src/hooks/useChat.ts`

- `DisplayMessage` gains `thinking?: string`.
- In the SSE handler inside `streamMessage`: `event.type === "thinking"` appends to
  `assistantMsg.thinking` using the same immutable-patch-and-`setMessages` pattern already used for
  `text`. Reset `thinking` to `""` at the same point `toolCalls`/`content` reset for the next
  iteration (the block right after a `tool_result` starts a fresh `assistantMsg`).
- `loadMessages`: read `parsedMeta?.thinking` into `DisplayMessage.thinking` when reconstructing
  historical messages from `metadata`.

### `packages/web/src/components/MessageBubble.tsx`

Add a "thinking" card variant reusing the existing `CollapsibleToolCard` component's structure (a
distinct icon, e.g. 💭, and a "思考过程" label instead of a tool name), rendered **before** the
`message-content` block — thinking precedes the final answer, the inverse ordering rationale from
the existing `ask_user`/`propose_outline` cards (which render *after* content because the model's
prose leads up to asking the question). `defaultCollapsed={!!message.dbId}`: expanded while
live-streaming (so the user watches reasoning happen), collapsed by default once loaded as history —
consistent with how tool-call/tool-result cards already behave.

## Testing strategy

- `packages/core/src/llm/anthropic.test.ts` (new): feed `mapAnthropicStream` a hand-built array of
  `RawMessageStreamEvent`-shaped objects; assert usage accumulation, `thinking` chunk emission, and
  that two interleaved tool_use blocks route their `input_json_delta` fragments correctly by index.
- `packages/core/src/llm/openai.test.ts` (new): same shape for `mapOpenAIStream` — usage-only
  trailing chunk, `reasoning_content` → thinking chunk.
- `packages/core/src/llm/retry.test.ts` (new): a `createStream` stub that throws a retryable error
  twice then succeeds on the third call resolves with all chunks; a stream that yields one chunk
  then throws does **not** retry (error propagates).
- `packages/core/src/llm/complete.test.ts` (new): aggregates multiple text chunks into one string.
- `packages/core/src/tools/net-guard.test.ts` (new): injected fake resolver — private-range IPs
  rejected, public IPs allowed, redirect chain capped at 3 hops.
- `packages/core/src/tools/validate.test.ts` (new): missing required field and wrong-type field each
  produce a validation error; a valid input produces `[]`.
- `packages/core/src/logger/trace.test.ts` (new, none exists today): inserting past `maxTraces`
  evicts the oldest trace and its spans; `getTraceForConversation` returns the most recently started
  trace when multiple exist for the same conversation.
- `packages/core/src/context/context-manager.test.ts`: existing `summarize`-driven tests must stay
  green after the internal switch to `complete()`.
- `packages/server/src/services/message-repository.test.ts`: new case asserting `thinking` lands in
  the persisted row's `metadata`.
- `packages/server/src/services/sse-adapter.test.ts` (exists — add a case): `thinking` event maps
  correctly; exhaustiveness is otherwise enforced by the compiler.

## Non-goals / explicit follow-ups (not in this pass)

- **Differentiated billing for cached tokens**: `cachedPromptTokens` is collected and recorded into
  trace metadata for observability, but `UsageMeter.record`/`calcCost` keep billing cache-read tokens
  at full input price. Anthropic's ~90% cache-read discount is a real, immediate cost saving, but
  wiring it into pricing means adding a `ModelConfig.cachedInputDiscount` field, updating
  `config/default.json` and its zod schema, and re-deriving `calcCost`'s signature — deferred to a
  dedicated billing pass (would fold naturally into `update-ext.md`'s E2 cost-estimation work).
- **`responseSchema` enforcement**: the `ChatParams.responseSchema` field is added now so E3's
  structured-output work has somewhere to put it, but nothing in this pass reads or enforces it.
- **E2–E6** of `update-ext.md` (model capability metadata, multimodal content, retrieval,
  orchestration primitives, storage/publish/MCP hardening) are untouched.

## Files touched

| File | Change |
|---|---|
| `packages/core/package.json` | `@anthropic-ai/sdk` `^0.30.0` → `^0.110.0` |
| `packages/core/src/types/index.ts` | `ChatParams`, `ChatOptions.params`, `ChatChunk` thinking + cachedPromptTokens |
| `packages/core/src/llm/anthropic.ts` | usage accounting, index-keyed tool buffers, `mapAnthropicStream`, retry wrap, thinking, prompt cache |
| `packages/core/src/llm/anthropic.test.ts` | new |
| `packages/core/src/llm/openai.ts` | `stream_options.include_usage`, `mapOpenAIStream`, retry wrap, thinking |
| `packages/core/src/llm/openai.test.ts` | new |
| `packages/core/src/llm/retry.ts` | new |
| `packages/core/src/llm/retry.test.ts` | new |
| `packages/core/src/llm/complete.ts` | new |
| `packages/core/src/llm/complete.test.ts` | new |
| `packages/core/src/llm/index.ts` | export retry/complete |
| `packages/core/src/context/context-manager.ts` | `summarize()` uses `complete()` |
| `packages/core/src/agents/types.ts` | `AgentDefinition.modelParams` |
| `packages/core/src/agent/agent.ts` | `AgentConfig.modelParams`, thinking event, cachedPromptTokens on done |
| `packages/core/src/tools/builtins.ts` | path containment, SSRF guard wiring, cancellable `execute_command` |
| `packages/core/src/tools/net-guard.ts` | new |
| `packages/core/src/tools/net-guard.test.ts` | new |
| `packages/core/src/tools/validate.ts` | new |
| `packages/core/src/tools/validate.test.ts` | new |
| `packages/core/src/tools/registry.ts` | calls `validateToolInput` before execute |
| `packages/core/src/logger/trace.ts` | bounded `TraceManager`, latest-first `getTraceForConversation` |
| `packages/core/src/logger/trace.test.ts` | new |
| `packages/server/src/services/agent-service.ts` | `modelParams` passthrough, thinking accumulation, `cachedPromptTokens` → trace |
| `packages/server/src/services/message-repository.ts` | `thinking` param → metadata |
| `packages/server/src/services/message-repository.test.ts` | new case |
| `packages/server/src/services/sse-adapter.ts` | `thinking` case |
| `packages/server/src/services/sse-adapter.test.ts` | new case |
| `packages/server/src/services/trace-recorder.ts` | `cachedPromptTokens` param |
| `packages/web/src/api/client.ts` | `AgentEvent.type` gains `"thinking"` |
| `packages/web/src/hooks/useChat.ts` | `DisplayMessage.thinking`, accumulate/reset, load from metadata |
| `packages/web/src/components/MessageBubble.tsx` | thinking card (pre-content, collapsible) |
