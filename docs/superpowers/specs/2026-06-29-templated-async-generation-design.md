# Templated Async Generation (create→poll) + Reference Images + Progress — Design

Date: 2026-06-29
Status: Approved (design)

## Goal

The first cut of image/video generation assumed a **synchronous** OpenAI-style call
(`{data:[{url}]}`). The real vendor is **asynchronous**: a create call returns a `task_id` +
`status`/`progress`, and the client polls a status endpoint until `completed`, which carries the
result URL. This redesign:

1. Switches providers to the **async create→poll** model.
2. Makes it **templated**: the orchestration flow is fixed; each vendor's request body, response
   parsing, and endpoints live in a swappable **adapter**, so new vendors slot in fast (multiple
   formats may run in parallel later).
3. Adds a **reference image** param (`media[]`).
4. Surfaces live **progress %** in the generating card.

"先模拟": a mock provider stays the default (no live vendor / cost) but follows the same async
contract and ramps progress so the % display is demoable.

## Vendor contract (Happyhorse — the first adapter)

Create: `POST {baseUrl}/{mediaType}/generation` — `mediaType` ∈ {image, video} (singular).
Request body adds reference images:
```json
{ "model": "happyhorse-1.0-t2v", "prompt": "…", "size": "832x480", "duration": 5, "ratio": "16:9",
  "media": [ { "type": "reference_image", "url": "附件地址" } ] }
```
Create response (task envelope):
```json
{ "id":"task_…", "task_id":"task_…", "object":"video/image", "model":"happyhorse-1.0-t2v",
  "status":"queued", "progress":0, "created_at":1782715513 }
```
Poll: `GET {baseUrl}/{mediaType}s/{task_id}` — `images`/`videos` (plural). Response:
```json
{ "id":"task_…", "object":"video", "model":"…", "status":"completed", "progress":100,
  "created_at":…, "completed_at":…, "metadata": { "url":"https://…mp4" } }
```

## 1. Core — unified `GenerationProvider` + `VendorAdapter`

New `packages/core/src/providers/generation.ts`. Replaces the synchronous
`ImageProvider`/`VideoProvider` model and the `OpenAI*`/`Mock*` image/video classes.

```ts
type MediaType = "image" | "video";
interface ReferenceMedia { type: "reference_image"; url: string }
interface GenerationRequest {
  mediaType: MediaType; prompt: string; model?: string;
  size?: string; n?: number; durationSec?: number; ratio?: string; quality?: string;
  media?: ReferenceMedia[];
}
interface CreateResult { taskId: string; status: string; progress: number }
interface PollResult { status: string; progress: number; url?: string; error?: string }
interface GenerationProvider {
  create(req: GenerationRequest): Promise<CreateResult>;
  poll(taskId: string, mediaType: MediaType): Promise<PollResult>;
}
interface VendorAdapter {
  createPath(mediaType: MediaType): string;            // "/image/generation"
  pollPath(mediaType: MediaType, taskId: string): string; // "/images/{id}"
  buildCreateBody(req: GenerationRequest, model: string): unknown;
  parseCreate(json: unknown): CreateResult;            // task_id|id, status, progress
  parsePoll(json: unknown): PollResult;                // status, progress, metadata.url
  isTerminal(status: string): "completed" | "failed" | null;
}
```

- `HttpGenerationProvider implements GenerationProvider` — the **template**. Constructed with
  `{ baseUrl, apiKey, adapter, imageModel, videoModel }`. `create` POSTs
  `baseUrl + adapter.createPath(mediaType)` (Bearer auth) with `adapter.buildCreateBody`, then
  `adapter.parseCreate`. `poll` GETs `baseUrl + adapter.pollPath(...)` then `adapter.parsePoll`.
  Throws on non-ok HTTP.
- `HappyhorseAdapter implements VendorAdapter` — the contract above. `buildCreateBody` includes
  `media` only when present; maps `durationSec`→`duration`. `isTerminal`: `completed`→completed,
  `failed`→failed, else null.
- `MockGenerationProvider implements GenerationProvider` — in-memory `Map<taskId,{createdAt,req}>`.
  `create`→ `mock_<uuid>`, status `queued`, progress 0. `poll`→ progress from elapsed time over
  ~3.5 s (`processing` until 100, then `completed` with `placeholderSvgDataUrl(...)` as the url);
  prompt containing `fail` → `failed` at ~50 %.
- A small `ADAPTERS: Record<string, () => VendorAdapter>` map enables more vendors later.
- `placeholderSvgDataUrl` is retained. `core/models/factory.ts` drops its now-unused
  `MockImageProvider`/`MockVideoProvider` image/video branches (the model type falls through to the
  existing "no provider factory" throw). Pricing via `getConfig` is unaffected.

## 2. Config

`generation` block gains `"adapter": "happyhorse"`. `GenerationConfig` gains `adapter: string`.
`makeGenerationProvider(cfg): GenerationProvider` → `MockGenerationProvider` when
`cfg.mock || !cfg.apiKey`, else `HttpGenerationProvider` with `pickAdapter(cfg.adapter)` and the
image/video model names. The old `makeImageProvider`/`makeVideoProvider` are replaced.

## 3. Worker — one create→poll→store flow

Both `image.generate` and `video.generate` delegate to `runGenerationJob(deps, job, mediaType)`:
1. Deterministic cache key from `{ prompt, size, n, durationSec, ratio, media (urls), model }`.
   On hit → mark message `completed` with cached assets, return.
2. `provider.create(req)` → vendor task id (req carries `media` from job input).
3. Poll loop every ~1.5 s, capped by a max wall-clock (e.g. 5 min → `failed` on timeout). Each
   tick: `queue.updateProgress(job.id, pollResult.progress)`.
4. Terminal `completed` → download `pollResult.url` (`urlToBytes` handles `http(s)` and `data:`)
   → store asset → message `completed` + `assets` + meter + `cache.set`. Terminal `failed` →
   message `failed` with the error. `job.userId` used throughout.

The worker reads `job.input`: `{ prompt, conversationId, assistantMessageId, size?, n?, durationSec?,
ratio?, quality?, media? }`.

## 4. Route

`POST /api/conversations/:id/generations` body accepts `media?: { type: "reference_image"; url }[]`,
threaded into the enqueued task input. Ownership (404) / quota (402) unchanged.

## 5. Web — reference upload + progress %

- `useChat.generateMedia(prompt, mediaType, settings, files)` uploads the 参考图 files via the
  existing `api.uploadFile` (image files only), builds `media:[{type:"reference_image",url}]`, and
  calls `api.generate(cid, { prompt, mediaType, settings, media })`. `Workspace.doSend` forwards the
  `files` it already receives.
- `GenerationView` gains `progress?: number`. The poll loop reads `t.progress` from `getTask` and
  patches the generating message each tick. `GenerationCard` loading state renders
  **图片生成中 {progress}% / 视频生成中 {progress}%**.
- `api.generate` request type adds `media`.

## 6. Error handling & testing

Adapters parse defensively (missing fields tolerated). Non-ok create/poll → throw → message
`failed`. Poll timeout → `failed`. Vitest (colocated):
- `HappyhorseAdapter`: `createPath`/`pollPath` strings; `buildCreateBody` includes `media` + maps
  duration; `parseCreate`/`parsePoll` against the exact JSON samples above.
- `MockGenerationProvider`: ramps 0→100 then `completed` with a `data:` url; `fail` prompt →
  `failed`.
- `HttpGenerationProvider`: `create` + `poll` with mocked `fetch` (URL, method, headers, parse).
- `makeGenerationProvider`: mock vs http selection.
- Route: `media` included in the enqueued input.
- Worker `runGenerationJob`: progress relayed, asset stored on completion, message failed on error
  (with provider injected as deps).

## Scope / non-goals

- Resuming a poll for an in-flight generation after a page reload (shows static 生成中 until the
  next interaction).
- Real public-URL reachability of reference images (a deployment concern; mock unaffected).
- Shipping more than the Happyhorse adapter (the map is ready for additional vendors).
```
