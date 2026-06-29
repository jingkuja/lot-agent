# Image & Video Generation Agents — Design

Date: 2026-06-29
Status: Approved (design)

## Goal

Make the **图片生成** and **视频生成** agents actually generate media. Today they are
placeholder definitions and the chat input routes through the SSE/ReAct path. We wire them to
the existing async task pipeline (BullMQ worker → ObjectStorage → `assets`) with real
OpenAI-compatible providers, persist each generation as a conversation message, and render
generating → result → failure cards inline in the chat.

Three explicit requirements:
1. Image and video are **independent models, separately configured**.
2. Interface params follow the **OpenAI** image/video generation API.
3. After a request: async; chat shows **图片生成中 / 视频生成中**; on result the area updates to the
   image/video; on failure it shows **图片生成失败 / 视频生成失败**. Persist across reload.

"先模拟": providers are mock by default (no live vendor call / cost) but conform to the real
OpenAI request/response contract, so swapping to the live vendor is a config flip.

## OpenAI contract (reference)

Request (image): `{ model, prompt, size:"1024x1024", quality:"standard", style:"vivid", n:1, response_format:"url" }`
Response: `{ "created": 1719612345, "data": [ { "url": "https://.../image.png" } ], "usage": { "total_tokens": 0 } }`
Video create (given): `POST {baseUrl}/video/generations` body `{ "model":"happyhorse-1.0-t2v", "prompt":"..." }`.

## 1. Models & config — "独立模型，单独设置"

`config/default.json` gains a `generation` block:

```json
"generation": {
  "baseUrl": "https://tokenhub.todoucloud.com/v1",
  "mock": true,
  "image": { "model": "happyhorse-1.0-t2i", "modelId": "wanx-standard" },
  "video": { "model": "happyhorse-1.0-t2v", "modelId": "kling-standard" }
}
```

- `model` = vendor model string sent in the request; `modelId` = model-registry id used for
  pricing/quota/metering. Image and video are configured independently.
- API key via env `TOKENHUB_API_KEY` (no secret in git). `mock:true` ignores key and base URL.
- Worker reads vendor model + pricing modelId from config instead of hardcoding.

## 2. Providers (core) — OpenAI-compatible, mock by default

Extend interfaces in `core/providers/image.ts` & `video.ts`:

- `ImageGenRequest { prompt; size?; quality?; style?; n?; responseFormat?; model? }`
- `VideoGenRequest { prompt; size?; durationSec?; ratio?; model? }`
- Results expose the OpenAI shape `{ created, data:[{url}], usage }` plus the parsed url(s).

Implementations (each behind the interface):
- `OpenAIImageProvider` / `OpenAIVideoProvider`: `fetch` `POST {baseUrl}/images|video/generations`
  with `Authorization: Bearer {key}`, parse `data[].url`.
- `MockImageProvider` / `MockVideoProvider`: return an OpenAI-shaped response without a network
  call. Mock image writes a generated **SVG placeholder** (gradient + prompt text) → a real,
  viewable image. Mock video writes an SVG **poster** (done-state shows a framed poster + ▶; a
  real playable `.mp4` is not synthesizable in Node without ffmpeg — the live provider yields the
  true `<video>`). A prompt containing `fail` forces the failure path for demoing it.

A factory picks mock vs real from `generation.mock` / key presence.

## 3. Request params — "传设置参数"

`MediaSettings` pickers become **controlled** (state lifted into `InputBox`), so `onSend`
forwards the chosen settings:
- Image: `size = "{W}x{H}"` from the resolution picker; `n:1`, `quality`/`style` defaults.
- Video: `size = "{W}x{H}"`, `durationSec` from 时长, `ratio` from 比例 (quality drives short edge).

## 4. Flow & persistence — "持久化为对话消息"

No schema migration — reuse `messages.metadata` (JSONB) and `messages.status`.

- New route `POST /api/conversations/:id/generations` (auth + ownership):
  1. Persist a **user** message (prompt).
  2. Persist a pending **assistant** message: `status='generating'`,
     `metadata={ kind:'generation', mediaType, prompt, settings, taskId }`.
  3. Enqueue `image.generate`/`video.generate` with
     `{ conversationId, assistantMessageId, userId, model, ...params }` (quota pre-check, 402).
  4. Return `{ userMessage, assistantMessage, taskId }`.
- **Worker** (`workers/index.ts`): on success → update assistant message `status='completed'`,
  `metadata.assets=[{url,mime,durationSec}]`; on error (throw) → `status='failed'`,
  `metadata.error`. Fix the `userId="default"` hardcode; link asset to user/conversation.
  Add `db.updateMessageGeneration(messageId, patch)`.
- **Web**: `Workspace.doSend` branches by agent type. image/video → `api.generate(...)` then the
  card polls `GET /api/tasks/:id` while `generating`; terminal messages render their persisted
  final state on reload (no re-poll). Other agents → existing SSE chat unchanged.

## 5. UI — `GenerationCard`

`components/GenerationCard.tsx`, rendered by `MessageBubble` for `kind:'generation'` messages:
- **generating**: gradient card + media icon + "图片生成中… / 视频生成中……".
- **completed**: `<img>` (image) / `<video controls>` or poster (video); supports multiple assets.
- **failed**: gradient card + broken icon + "图片生成失败 / 视频生成失败".
All colors via existing CSS tokens; new gradient-card tokens added to both themes.

## 6. Error handling & testing

- Provider/network error → task failed → message failed → failure card. Quota 402 surfaced to the
  card. `GenCache` reused; cache key includes settings so different sizes don't collide.
- Vitest (colocated `*.test.ts`):
  - provider param mapping + mock output shape + OpenAI request body building;
  - `size` derivation from resolution; video settings mapping;
  - worker updates message metadata/status on success and failure;
  - route persists user + assistant messages and enqueues with the right input.

## Scope / non-goals

- One conversation = one media type (bound to its agent). `n` defaults to 1 (render all returned).
- Mock video done-state is a poster, not a playable clip, until the live vendor is wired.
- Real `projects` table, multi-model selector UI, and live vendor cutover remain deferred.
```
