# Design: Synchronous chat-completions image provider

Date: 2026-06-30

## Goal

Make image generation actually produce images by adding a **synchronous** provider
that hits tokenhub's OpenAI-style chat-completions endpoint, parsing the image URL
out of the assistant message's markdown. It replaces the async `happyhorse` adapter
as the default image provider, runs through the existing job queue (so the chat shows
"图片正在生成" then updates asynchronously), and the UI image-settings popup drops the
free resolution input in favor of a fixed ratio→resolution mapping.

## Endpoint

- `POST https://tokenhub.todoucloud.com/v1/chat/completions`
- Auth: `Authorization: Bearer <TOKENHUB_API_KEY>`
- Request body:
  ```json
  {
    "model": "gpt-image-2-token",
    "messages": [{ "role": "user", "content": "<prompt>" }],
    "size": "2048*2048",
    "prompt": "<prompt>"
  }
  ```
- Response: standard OpenAI chat-completion. The image is a markdown link inside
  `choices[0].message.content`, e.g. `![image](https://.../x.png)`.
- Synchronous: one call returns the finished image. Failure = no extractable
  `http(s)` image URL.

## Components

### Core (`packages/core/src/providers/`)

- **`extractImageUrl(content: string): string | null`** — pure. Returns the first
  `![...](url)` markdown image URL requiring `http(s)`; `null` on missing/malformed.
- **`ChatCompletionsImageProvider implements ImageGenerationProvider`** — adapts the
  synchronous endpoint to the existing `create()/poll()` interface using an in-memory
  result map (same pattern as `MockImageGenerationProvider`):
  - `create(req)` POSTs the body above, extracts the URL; **throws** if none (so
    `runGenerationJob`'s catch marks the assistant message `failed`); otherwise stashes
    the URL under a synthetic `taskId` and returns `{status:"completed",progress:100}`.
  - `poll(taskId)` returns the stashed `{status:"completed",progress:100,url}`.
  - Keeps `runGenerationJob` unchanged (create → store asset → update message).
  - Known limitation: a worker crash between `create` and `poll` loses the in-memory
    result (same as the mock provider). Acceptable at this stage.
- `parseSize` accepts `*` as well as `x` (only affects mock placeholder sizing).

### Server

- `makeImageProvider(cfg)` branches on `adapter === "chat-completions"` → new provider;
  else existing happyhorse path; mock fallback unchanged.
- `config/default.json`:
  - add model `{ id:"gpt-image-2-token", type:"image", provider:"tokenhub",
    billingUnit:"image", inputPrice:0, outputPrice:0, unitPrice:0.04, enabled:true }`.
  - `generation.image` → `{ adapter:"chat-completions", model:"gpt-image-2-token",
    modelId:"gpt-image-2-token" }`.
- Replace hardcoded `"wanx-standard"` in the image quota pre-checks
  (`routes/tasks.ts`, `routes/conversations.ts`) with `"gpt-image-2-token"`.
- API key via existing env `TOKENHUB_API_KEY` (test key in `.env`, never committed).

### Web (`components/MediaSettings.tsx`)

- Replace `IMAGE_RATIOS` + free `ResolutionInput` with a fixed ratio→size list,
  default **1:1**. NOTE: the live endpoint rejects the `*` separator from the
  sample request ("不合法的size") and only accepts `WxH`, so sizes use `x`:

  | Ratio | Size |
  |---|---|
  | 16:9 | `2688x1536` |
  | 9:16 | `1536x2688` |
  | 1:1 (default) | `2048x2048` |
  | 4:3 | `2368x1728` |
  | 3:4 | `1728x2368` |

- Image popup shows only ratio buttons; `onChange` emits `{ size, n:1 }` with the
  mapped `*` size. `ResolutionInput` removed (image-only); `deriveResolution` stays
  for video.

## Data flow (unchanged path)

UI picks ratio → emits `size` (`2048*2048`) → `POST /conversations/:id/messages`
generation → enqueue `image.generate` job + placeholder assistant message
(`status:"generating"`) → worker `runGenerationJob` → `ChatCompletionsImageProvider`
create (sync HTTP + extract) → poll (completed) → download → `ObjectStorage` →
`updateMessageGeneration(completed, asset)` → chat updates asynchronously.

## Tests

- `extractImageUrl`: valid, missing, malformed, non-image text.
- `ChatCompletionsImageProvider`: create/poll with mocked `fetch` (success +
  extraction-failure throws).
