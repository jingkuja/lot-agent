# Model Selection Defaults + Title Model — Design

Date: 2026-07-02
Status: approved

## Problem

1. **Title summarization ignores the user's model.** `generateTitle`
   (`packages/server/src/services/agent-service.ts`) always uses
   `getLLMProvider()` — the env-default LLM — while the chat turn itself
   resolves the user's picked model (explicit pick > `conversation.model` >
   agent default) and builds a per-user provider from the caller's apiKey.
2. **The displayed default model is never actually sent.** `selectedModel`
   in `Workspace` starts `null`; `ModelPicker` *displays* `models[0]` as a
   fallback label but sends nothing, so the server silently falls back to the
   agent's config default — display and behavior can diverge.
3. **Empty catalog hides the picker entirely.** `InputBox` renders
   `ModelPicker` only when `models.length > 0`, so a user whose catalog is
   empty (no apiKey / upstream down) gets no picker and no explanation.

## Decisions (user-confirmed)

- Title generation uses **the same model as the current chat turn** (same
  resolution chain and same apiKey/provider fallback as the chat path).
- The picker keeps **per-group selections**: `llm` / `image` / `video` each
  remember their own pick; each initializes to that group's **first model**
  returned by `GET /api/models`.
- Entering a conversation with a stored `conversation.model` **overrides**
  the `llm` slot (stored-priority). Only new/model-less conversations use the
  group-first default.
- Empty catalog: the picker still renders, trigger label **「默认」**, and the
  popup shows a single grey non-interactive row
  **「无更多模型，请联系管理员」** (no search input, nothing selectable).

## Part 1 — Server: title uses the turn's model

`generateTitle(conversationId, userMessage, attachments?, opts?)` gains
`opts?: { userId?: string; modelId?: string }` and resolves its LLM exactly
like `streamAgentResponse`:

1. `modelId` = `opts.modelId` → `conversation.model` → env default
   (`resolveConversationModel`, already exported by `agent-service.ts`).
2. Provider: if `opts.userId` has an apiKey →
   `providerFactory.llm(modelId, apiKey)`; otherwise the existing
   `getLLMProvider()` env fallback. Same chain as the chat path.

Call sites (`packages/server/src/routes/conversations.ts`):

- **Chat SSE route** (~line 199): pass `{ userId, modelId: body.modelId }`.
  Note `streamAgentResponse` has already persisted an explicit pick to
  `conversation.model` by the time the title runs, so both paths agree.
- **Media-generation route** (~line 309): pass `{ userId }` only — the
  turn's model there is an image/video model and cannot summarize text.
  Falls back to `conversation.model` (verified: only the chat path ever
  writes `conversation.model`, so it always holds an LLM id) else env
  default.

Rejected alternative: threading the already-built provider out of
`streamAgentResponse` — it's an async generator; the plumbing costs more
than re-resolving two cheap lookups.

## Part 2 — Web: per-group defaults + empty-state picker

### State (Workspace)

Replace `selectedModel: string | null` with one record:

```ts
type SelectedModels = { llm: string | null; image: string | null; video: string | null };
```

- **Catalog load:** any slot still `null` is filled with that group's first
  model id. Implemented as a pure helper `fillModelDefaults(prev, catalog)`
  (new `packages/web/src/lib/model-defaults.ts`) so it's unit-testable.
- **Conversation load:** `conversationModel` (from `useChat`) overwrites the
  `llm` slot when non-null — stored-priority.
- **Picker change:** `ChatPanel` already picks the catalog group by media
  kind (text→llm, image, video); `onModelChange` now writes to the matching
  slot, and the picker's `value` reads from it — each group remembers its
  own pick across media-kind switches.

### Sends

- Chat `send(...)` passes `selectedModels.llm`.
- `generateMedia(...)` passes `selectedModels.image` / `.video` per kind.
- Slots are pre-filled after catalog load, so the group-first default is now
  actually sent, not just displayed. Empty catalog ⇒ slots stay `null` ⇒
  nothing sent ⇒ server env/agent default resolves as today.

### Empty-state picker

- `InputBox`: drop the `models.length > 0` guard — always render
  `ModelPicker` when `onModelChange` is provided.
- `ModelPicker`: when `models` is empty — trigger label 「默认」; popup
  contains only a grey non-interactive hint row
  「无更多模型，请联系管理员」; no search input; nothing selectable.
  Styling reuses existing `model-popup` / muted tokens (`var(--text-muted)`),
  no new hardcoded colors.

## Error handling

- Title generation stays best-effort (existing try/catch at both call
  sites); a bad/missing model falls through the same catch.
- Catalog fetch failure (`useModels` catch → empty catalog) degrades to the
  empty-state picker + server-side default — same as "no models returned".

## Testing

- **Vitest (server):** title model resolution — explicit pick wins; falls
  back to `conversation.model`; falls back to env default; no-apiKey uses
  env provider.
- **Vitest (web):** `fillModelDefaults` — fills only `null` slots with the
  group's first id; preserves existing picks; no-op on empty catalog.
- **Browser (manual):** per-group memory across media-kind switches;
  stored-conversation priority on conversation open; empty-catalog picker
  shows 「默认」+ hint row.

## Out of scope

- Persisting image/video picks per conversation (only the chat LLM pick is
  stored today; unchanged).
- Any change to `GET /api/models`, its Redis caching, or catalog grouping.
- Admin flows for provisioning models ("请联系管理员" is a dead-end hint by
  design).
