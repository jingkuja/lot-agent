# Image & Video Generation Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 图片生成 / 视频生成 agents generate media through the async task pipeline with OpenAI-compatible (mock-by-default) providers, persisting each generation as a conversation message and rendering generating → result → failure cards in chat.

**Architecture:** Core gains OpenAI-compatible image/video providers (real `fetch` + mock that returns a `data:` URL). The server loads a `generation` config block, the worker calls the provider, stores the asset, and writes the result back onto a persisted assistant message (`metadata.kind='generation'`, `status` = generating/completed/failed). A new route persists the user + assistant messages and enqueues the task. The web input branches by agent: image/video send hits the generation route and renders a `GenerationCard` that polls the task.

**Tech Stack:** TypeScript ESM monorepo (npm workspaces), Vitest, Hono, `pg`, BullMQ, React 19 + Vite.

## Global Constraints

- ESM imports use explicit `.js` suffixes; 2-space indent.
- Interface-in-core, impl-in-server only when DB/Redis is needed; plain `fetch` providers live in core.
- No secrets in git: vendor key via env `TOKENHUB_API_KEY`; `config/default.json` holds non-secret structure.
- NUMERIC from pg returns strings — convert with `Number()`.
- Web colors must use existing `var(--*)` tokens (add new tokens to both `:root` and `[data-theme="dark"]`); never hardcode hex/rgba in component rules.
- Tests colocated as `*.test.ts`; TDD (failing test first).
- Vendor contract (OpenAI image): request `{ model, prompt, size, quality, style, n, response_format }`; response `{ created:number, data:{url:string}[], usage?:{total_tokens:number} }`.

---

### Task 1: Image provider (core) — interface + mock + OpenAI impl

**Files:**
- Modify: `packages/core/src/providers/image.ts`
- Create: `packages/core/src/providers/placeholder.ts`
- Test: `packages/core/src/providers/image.test.ts`

**Interfaces:**
- Produces:
  - `interface ImageGenRequest { prompt: string; size?: string; quality?: string; style?: string; n?: number; responseFormat?: string; model?: string }`
  - `interface ImageData { url: string }`
  - `interface ImageGenResult { created: number; data: ImageData[]; usage?: { total_tokens: number } }`
  - `interface ImageProvider { generate(req: ImageGenRequest): Promise<ImageGenResult> }`
  - `class MockImageProvider implements ImageProvider` (constructor `()`)
  - `class OpenAIImageProvider implements ImageProvider` (constructor `(opts: { baseUrl: string; apiKey: string; model: string })`)
  - `placeholderSvgDataUrl(opts: { prompt: string; width: number; height: number; kind: "image" | "video" }): string`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/providers/image.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { MockImageProvider, OpenAIImageProvider } from "./image.js";

describe("MockImageProvider", () => {
  it("returns OpenAI-shaped result with a data: url", async () => {
    const r = await new MockImageProvider().generate({ prompt: "菊花", size: "1024x1024" });
    expect(r.data).toHaveLength(1);
    expect(r.data[0].url.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(typeof r.created).toBe("number");
  });

  it("honors n by returning n images", async () => {
    const r = await new MockImageProvider().generate({ prompt: "x", n: 3 });
    expect(r.data).toHaveLength(3);
  });

  it("throws when the prompt contains 'fail' (demo failure path)", async () => {
    await expect(new MockImageProvider().generate({ prompt: "please fail" })).rejects.toThrow();
  });
});

describe("OpenAIImageProvider", () => {
  afterEach(() => vi.restoreAllMocks());

  it("POSTs the OpenAI body and parses data[].url", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ created: 1, data: [{ url: "https://x/y.png" }], usage: { total_tokens: 0 } }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const p = new OpenAIImageProvider({ baseUrl: "https://api/v1", apiKey: "k", model: "m" });
    const r = await p.generate({ prompt: "hi", size: "1024x1024", n: 1 });

    expect(r.data[0].url).toBe("https://x/y.png");
    const [url, init] = (fetchMock as unknown as vi.Mock).mock.calls[0];
    expect(url).toBe("https://api/v1/images/generations");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ model: "m", prompt: "hi", size: "1024x1024", n: 1, response_format: "url" });
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer k" });
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" })) as unknown as typeof fetch);
    const p = new OpenAIImageProvider({ baseUrl: "https://api/v1", apiKey: "k", model: "m" });
    await expect(p.generate({ prompt: "hi" })).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/core -- image.test`
Expected: FAIL (`MockImageProvider`/`OpenAIImageProvider` not exported).

- [ ] **Step 3: Write the placeholder helper**

Create `packages/core/src/providers/placeholder.ts`:

```ts
/** Escape text for inclusion in SVG markup. */
function esc(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));
}

/**
 * Build a gradient placeholder SVG (used by the mock providers) and return it
 * as a base64 data URL. `kind` only tweaks the caption.
 */
export function placeholderSvgDataUrl(opts: {
  prompt: string;
  width: number;
  height: number;
  kind: "image" | "video";
}): string {
  const { prompt, width, height, kind } = opts;
  const caption = kind === "video" ? "MOCK VIDEO" : "MOCK IMAGE";
  const text = esc(prompt.slice(0, 40) || caption);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#60a5fa"/>
  </linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <text x="50%" y="46%" fill="#ffffff" font-family="sans-serif" font-size="${Math.round(width / 18)}" font-weight="700" text-anchor="middle">${caption}</text>
  <text x="50%" y="58%" fill="#ffffff" font-family="sans-serif" font-size="${Math.round(width / 26)}" text-anchor="middle" opacity="0.9">${text}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
```

- [ ] **Step 4: Rewrite `image.ts`**

Replace `packages/core/src/providers/image.ts` with:

```ts
import { placeholderSvgDataUrl } from "./placeholder.js";

export interface ImageGenRequest {
  prompt: string;
  size?: string;
  quality?: string;
  style?: string;
  n?: number;
  responseFormat?: string;
  model?: string;
}
export interface ImageData {
  url: string;
}
export interface ImageGenResult {
  created: number;
  data: ImageData[];
  usage?: { total_tokens: number };
}
export interface ImageProvider {
  generate(req: ImageGenRequest): Promise<ImageGenResult>;
}

/** Parse "1024x768" → [1024, 768]; defaults to 1024x1024. */
function parseSize(size?: string): [number, number] {
  const m = /^(\d+)x(\d+)$/.exec(size ?? "");
  return m ? [Number(m[1]), Number(m[2])] : [1024, 1024];
}

/** Mock provider: returns OpenAI-shaped result with placeholder SVG data URLs. */
export class MockImageProvider implements ImageProvider {
  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    if (/fail/i.test(req.prompt)) throw new Error("mock image failure (prompt contains 'fail')");
    const [w, h] = parseSize(req.size);
    const n = Math.max(1, req.n ?? 1);
    const data = Array.from({ length: n }, () => ({
      url: placeholderSvgDataUrl({ prompt: req.prompt, width: w, height: h, kind: "image" }),
    }));
    return { created: Math.floor(Date.now() / 1000), data, usage: { total_tokens: 0 } };
  }
}

/** Real OpenAI-compatible image provider. */
export class OpenAIImageProvider implements ImageProvider {
  constructor(private opts: { baseUrl: string; apiKey: string; model: string }) {}

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const res = await fetch(`${this.opts.baseUrl}/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify({
        model: req.model ?? this.opts.model,
        prompt: req.prompt,
        size: req.size ?? "1024x1024",
        quality: req.quality ?? "standard",
        style: req.style ?? "vivid",
        n: req.n ?? 1,
        response_format: req.responseFormat ?? "url",
      }),
    });
    if (!res.ok) throw new Error(`image generation failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as ImageGenResult;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w @lot-agent/core -- image.test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/providers/image.ts packages/core/src/providers/placeholder.ts packages/core/src/providers/image.test.ts
git commit -m "feat(core): OpenAI-compatible image provider + mock"
```

---

### Task 2: Video provider (core) — interface + mock + OpenAI impl

**Files:**
- Modify: `packages/core/src/providers/video.ts`
- Test: `packages/core/src/providers/video.test.ts`

**Interfaces:**
- Consumes: `placeholderSvgDataUrl` from Task 1.
- Produces:
  - `interface VideoGenRequest { prompt: string; size?: string; durationSec?: number; ratio?: string; model?: string }`
  - `interface VideoGenResult { created: number; data: { url: string }[]; durationSec: number; usage?: { total_tokens: number } }`
  - `interface VideoProvider { generate(req: VideoGenRequest): Promise<VideoGenResult> }`
  - `class MockVideoProvider implements VideoProvider`
  - `class OpenAIVideoProvider implements VideoProvider` (constructor `(opts: { baseUrl: string; apiKey: string; model: string })`)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/providers/video.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { MockVideoProvider, OpenAIVideoProvider } from "./video.js";

describe("MockVideoProvider", () => {
  it("returns a poster data url and echoes duration", async () => {
    const r = await new MockVideoProvider().generate({ prompt: "麦田", durationSec: 10, size: "832x480" });
    expect(r.data[0].url.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(r.durationSec).toBe(10);
  });
  it("throws when prompt contains 'fail'", async () => {
    await expect(new MockVideoProvider().generate({ prompt: "fail" })).rejects.toThrow();
  });
});

describe("OpenAIVideoProvider", () => {
  afterEach(() => vi.restoreAllMocks());
  it("POSTs to /video/generations with model + prompt", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ created: 1, data: [{ url: "https://x/y.mp4" }] }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    const p = new OpenAIVideoProvider({ baseUrl: "https://api/v1", apiKey: "k", model: "happyhorse-1.0-t2v" });
    const r = await p.generate({ prompt: "麦田", durationSec: 5, size: "832x480", ratio: "16:9" });
    expect(r.data[0].url).toBe("https://x/y.mp4");
    const [url, init] = (fetchMock as unknown as vi.Mock).mock.calls[0];
    expect(url).toBe("https://api/v1/video/generations");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ model: "happyhorse-1.0-t2v", prompt: "麦田", size: "832x480", duration: 5, ratio: "16:9" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/core -- video.test`
Expected: FAIL (not exported).

- [ ] **Step 3: Rewrite `video.ts`**

Replace `packages/core/src/providers/video.ts` with:

```ts
import { placeholderSvgDataUrl } from "./placeholder.js";

export interface VideoGenRequest {
  prompt: string;
  size?: string;
  durationSec?: number;
  ratio?: string;
  model?: string;
}
export interface VideoGenResult {
  created: number;
  data: { url: string }[];
  durationSec: number;
  usage?: { total_tokens: number };
}
export interface VideoProvider {
  generate(req: VideoGenRequest): Promise<VideoGenResult>;
}

function parseSize(size?: string): [number, number] {
  const m = /^(\d+)x(\d+)$/.exec(size ?? "");
  return m ? [Number(m[1]), Number(m[2])] : [832, 480];
}

/** Mock provider: returns an SVG poster data url (no real mp4). */
export class MockVideoProvider implements VideoProvider {
  async generate(req: VideoGenRequest): Promise<VideoGenResult> {
    if (/fail/i.test(req.prompt)) throw new Error("mock video failure (prompt contains 'fail')");
    const [w, h] = parseSize(req.size);
    const durationSec = req.durationSec ?? 5;
    return {
      created: Math.floor(Date.now() / 1000),
      data: [{ url: placeholderSvgDataUrl({ prompt: req.prompt, width: w, height: h, kind: "video" }) }],
      durationSec,
      usage: { total_tokens: 0 },
    };
  }
}

/** Real OpenAI-compatible video provider. */
export class OpenAIVideoProvider implements VideoProvider {
  constructor(private opts: { baseUrl: string; apiKey: string; model: string }) {}

  async generate(req: VideoGenRequest): Promise<VideoGenResult> {
    const res = await fetch(`${this.opts.baseUrl}/video/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify({
        model: req.model ?? this.opts.model,
        prompt: req.prompt,
        size: req.size,
        duration: req.durationSec,
        ratio: req.ratio,
      }),
    });
    if (!res.ok) throw new Error(`video generation failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as Omit<VideoGenResult, "durationSec">;
    return { ...json, durationSec: req.durationSec ?? 5 };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @lot-agent/core -- video.test`
Expected: PASS.

- [ ] **Step 5: Verify core barrel still exports providers**

`packages/core/src/providers/index.ts` already re-exports `./image.js` and `./video.js`; confirm the new classes are exported:

Run: `npm run build -w @lot-agent/core`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/providers/video.ts packages/core/src/providers/video.test.ts
git commit -m "feat(core): OpenAI-compatible video provider + mock"
```

---

### Task 3: Generation config + provider factory (server)

**Files:**
- Modify: `config/default.json`
- Modify: `.env.example`
- Create: `packages/server/src/generation/config.ts`
- Test: `packages/server/src/generation/config.test.ts`

**Interfaces:**
- Consumes: providers from Tasks 1–2.
- Produces:
  - `interface GenerationConfig { baseUrl: string; apiKey: string; mock: boolean; image: { model: string; modelId: string }; video: { model: string; modelId: string } }`
  - `loadGenerationConfig(rootDir: string): Promise<GenerationConfig>`
  - `makeImageProvider(cfg: GenerationConfig): ImageProvider`
  - `makeVideoProvider(cfg: GenerationConfig): VideoProvider`

- [ ] **Step 1: Add the config block**

In `config/default.json`, add a top-level `"generation"` key (sibling of `"models"`):

```json
"generation": {
  "baseUrl": "https://tokenhub.todoucloud.com/v1",
  "mock": true,
  "image": { "model": "happyhorse-1.0-t2i", "modelId": "wanx-standard" },
  "video": { "model": "happyhorse-1.0-t2v", "modelId": "kling-standard" }
}
```

In `.env.example`, add: `TOKENHUB_API_KEY=`

- [ ] **Step 2: Write the failing test**

Create `packages/server/src/generation/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeImageProvider, makeVideoProvider, type GenerationConfig } from "./config.js";
import { MockImageProvider, OpenAIImageProvider, MockVideoProvider, OpenAIVideoProvider } from "@lot-agent/core";

const base: GenerationConfig = {
  baseUrl: "https://api/v1",
  apiKey: "",
  mock: true,
  image: { model: "i", modelId: "wanx-standard" },
  video: { model: "v", modelId: "kling-standard" },
};

describe("provider factory", () => {
  it("mock:true → mock providers", () => {
    expect(makeImageProvider(base)).toBeInstanceOf(MockImageProvider);
    expect(makeVideoProvider(base)).toBeInstanceOf(MockVideoProvider);
  });
  it("mock:false with key → real providers", () => {
    const cfg = { ...base, mock: false, apiKey: "k" };
    expect(makeImageProvider(cfg)).toBeInstanceOf(OpenAIImageProvider);
    expect(makeVideoProvider(cfg)).toBeInstanceOf(OpenAIVideoProvider);
  });
  it("mock:false but no key → falls back to mock", () => {
    const cfg = { ...base, mock: false, apiKey: "" };
    expect(makeImageProvider(cfg)).toBeInstanceOf(MockImageProvider);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -w @lot-agent/server -- generation/config`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `config.ts`**

Create `packages/server/src/generation/config.ts`:

```ts
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  MockImageProvider,
  OpenAIImageProvider,
  MockVideoProvider,
  OpenAIVideoProvider,
  type ImageProvider,
  type VideoProvider,
} from "@lot-agent/core";

export interface GenerationConfig {
  baseUrl: string;
  apiKey: string;
  mock: boolean;
  image: { model: string; modelId: string };
  video: { model: string; modelId: string };
}

/** Load the non-secret `generation` block from config + the key from env. */
export async function loadGenerationConfig(rootDir: string): Promise<GenerationConfig> {
  const raw = JSON.parse(await readFile(resolve(rootDir, "config/default.json"), "utf-8")) as {
    generation?: Partial<GenerationConfig>;
  };
  const g = raw.generation ?? {};
  return {
    baseUrl: g.baseUrl ?? "https://tokenhub.todoucloud.com/v1",
    apiKey: process.env.TOKENHUB_API_KEY ?? "",
    mock: g.mock ?? true,
    image: { model: g.image?.model ?? "", modelId: g.image?.modelId ?? "wanx-standard" },
    video: { model: g.video?.model ?? "", modelId: g.video?.modelId ?? "kling-standard" },
  };
}

const useMock = (cfg: GenerationConfig) => cfg.mock || !cfg.apiKey;

export function makeImageProvider(cfg: GenerationConfig): ImageProvider {
  return useMock(cfg)
    ? new MockImageProvider()
    : new OpenAIImageProvider({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.image.model });
}

export function makeVideoProvider(cfg: GenerationConfig): VideoProvider {
  return useMock(cfg)
    ? new MockVideoProvider()
    : new OpenAIVideoProvider({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.video.model });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w @lot-agent/server -- generation/config`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add config/default.json .env.example packages/server/src/generation/
git commit -m "feat(server): generation config + provider factory"
```

---

### Task 4: DB helper to update a generation message

**Files:**
- Modify: `packages/server/src/db/database.ts`
- Test: `packages/server/src/db/generation-message.test.ts`

**Interfaces:**
- Produces: `DB.updateMessageGeneration(messageId: string, patch: { status: string; metadata: Record<string, unknown> }): Promise<void>` — sets `status` and merges `metadata` (replaces the JSONB column with the provided object).

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/db/generation-message.test.ts`. This is a unit test against a query-spy, not a live DB:

```ts
import { describe, it, expect, vi } from "vitest";
import { DB } from "./database.js";

describe("updateMessageGeneration", () => {
  it("UPDATEs status + metadata for the message id", async () => {
    const db = Object.create(DB.prototype) as DB;
    const query = vi.fn(async () => ({ rows: [] }));
    // @ts-expect-error inject a fake pool
    db.pool = { query };
    await db.updateMessageGeneration("m1", { status: "completed", metadata: { kind: "generation", assets: [] } });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/UPDATE messages SET status = \$1, metadata = \$2 WHERE id = \$3/);
    expect(params[0]).toBe("completed");
    expect(JSON.parse(params[1] as string)).toMatchObject({ kind: "generation" });
    expect(params[2]).toBe("m1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/server -- generation-message`
Expected: FAIL (`updateMessageGeneration` is not a function).

- [ ] **Step 3: Implement the method**

In `packages/server/src/db/database.ts`, add inside the `DB` class (next to `addMessage`):

```ts
  /** Patch a generation message's status + metadata (used by the worker). */
  async updateMessageGeneration(
    messageId: string,
    patch: { status: string; metadata: Record<string, unknown> }
  ): Promise<void> {
    await this.pool.query(
      "UPDATE messages SET status = $1, metadata = $2 WHERE id = $3",
      [patch.status, JSON.stringify(patch.metadata), messageId]
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @lot-agent/server -- generation-message`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/db/database.ts packages/server/src/db/generation-message.test.ts
git commit -m "feat(server): DB.updateMessageGeneration"
```

---

### Task 5: Worker handlers — real providers + persist result onto the message

**Files:**
- Modify: `packages/server/src/workers/index.ts`

**Interfaces:**
- Consumes: `loadGenerationConfig`, `makeImageProvider`, `makeVideoProvider` (Task 3); `DB.updateMessageGeneration` (Task 4); provider result shapes (Tasks 1–2).
- Job input shape (produced by Task 6): `image.generate` / `video.generate` input =
  `{ prompt: string; conversationId: string; assistantMessageId: string; size?: string; n?: number; durationSec?: number; ratio?: string; quality?: string }`; `job.userId` carries the owner.

- [ ] **Step 1: Add a shared bytes helper near the top of `main()`**

In `packages/server/src/workers/index.ts`, after `const cache = new GenCache(conn);`, add:

```ts
  const genConfig = await loadGenerationConfig(ROOT);
  const imageProvider = makeImageProvider(genConfig);
  const videoProvider = makeVideoProvider(genConfig);

  /** Resolve a provider url (http(s) or data:) to bytes + mime. */
  async function urlToBytes(url: string): Promise<{ body: Buffer; mime: string }> {
    if (url.startsWith("data:")) {
      const [head, b64] = url.slice(5).split(",", 2);
      const mime = head.split(";")[0] || "application/octet-stream";
      return { body: Buffer.from(b64, "base64"), mime };
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const mime = res.headers.get("content-type") ?? "application/octet-stream";
    return { body: Buffer.from(await res.arrayBuffer()), mime };
  }

  /** Map a mime to a stored-file extension. */
  const extFor = (mime: string) =>
    mime.includes("svg") ? "svg" : mime.includes("mp4") ? "mp4" : mime.includes("png") ? "png" : mime.split("/")[1] ?? "bin";
```

Add the imports at the top of the file:

```ts
import { loadGenerationConfig } from "../generation/config.js";
import { makeImageProvider, makeVideoProvider } from "../generation/config.js";
```

- [ ] **Step 2: Replace the `image.generate` handler**

Replace the existing `queue.process("image.generate", ...)` block with:

```ts
  queue.process("image.generate", async (job) => {
    const input = job.input as Record<string, unknown>;
    const prompt = (input.prompt as string) ?? "";
    const assistantMessageId = input.assistantMessageId as string | undefined;
    const baseMeta = {
      kind: "generation",
      mediaType: "image",
      prompt,
      settings: { size: input.size, n: input.n },
    };
    try {
      const cacheKey = genCacheKey("image.generate", job.input);
      const cached = await cache.get<{ assetIds: string[]; assets: { url: string; mime: string }[] }>(cacheKey);
      if (!cached) await queue.updateProgress(job.id, 25);

      const result =
        cached ??
        (await (async () => {
          const r = await imageProvider.generate({
            prompt,
            size: input.size as string | undefined,
            n: input.n as number | undefined,
          });
          await queue.updateProgress(job.id, 70);
          const assets: { url: string; mime: string }[] = [];
          const assetIds: string[] = [];
          for (const d of r.data) {
            const { body, mime } = await urlToBytes(d.url);
            const assetId = randomUUID();
            const key = `${assetId}.${extFor(mime)}`;
            const { url } = await storage.put({ key, body, contentType: mime });
            await db.createAsset({
              id: assetId, taskId: job.id, userId: job.userId, type: "image",
              storageKey: key, url, mime, sizeBytes: body.byteLength,
            });
            assets.push({ url, mime });
            assetIds.push(assetId);
          }
          await meter.record({
            userId: job.userId, taskId: job.id, modelId: genConfig.image.modelId,
            usage: { inputCount: 0, outputCount: r.data.length },
          });
          const out = { assetIds, assets };
          await cache.set(cacheKey, out);
          return out;
        })());

      if (assistantMessageId) {
        await db.updateMessageGeneration(assistantMessageId, {
          status: "completed",
          metadata: { ...baseMeta, status: "completed", assets: result.assets },
        });
      }
      await queue.updateProgress(job.id, 100);
      return result;
    } catch (err) {
      if (assistantMessageId) {
        await db.updateMessageGeneration(assistantMessageId, {
          status: "failed",
          metadata: { ...baseMeta, status: "failed", error: err instanceof Error ? err.message : String(err) },
        });
      }
      throw err;
    }
  });
```

- [ ] **Step 3: Replace the `video.generate` handler**

Replace the existing `queue.process("video.generate", ...)` block with:

```ts
  queue.process("video.generate", async (job) => {
    const input = job.input as Record<string, unknown>;
    const prompt = (input.prompt as string) ?? "";
    const assistantMessageId = input.assistantMessageId as string | undefined;
    const baseMeta = {
      kind: "generation",
      mediaType: "video",
      prompt,
      settings: { size: input.size, durationSec: input.durationSec, ratio: input.ratio },
    };
    try {
      const cacheKey = genCacheKey("video.generate", job.input);
      const cached = await cache.get<{ assetIds: string[]; assets: { url: string; mime: string; durationSec: number }[] }>(cacheKey);
      if (!cached) await queue.updateProgress(job.id, 25);

      const result =
        cached ??
        (await (async () => {
          const r = await videoProvider.generate({
            prompt,
            size: input.size as string | undefined,
            durationSec: input.durationSec as number | undefined,
            ratio: input.ratio as string | undefined,
          });
          await queue.updateProgress(job.id, 70);
          const { body, mime } = await urlToBytes(r.data[0].url);
          const assetId = randomUUID();
          const key = `${assetId}.${extFor(mime)}`;
          const { url } = await storage.put({ key, body, contentType: mime });
          await db.createAsset({
            id: assetId, taskId: job.id, userId: job.userId, type: "video",
            storageKey: key, url, mime, sizeBytes: body.byteLength, durationSec: r.durationSec,
          });
          await meter.record({
            userId: job.userId, taskId: job.id, modelId: genConfig.video.modelId,
            usage: { inputCount: 0, outputCount: r.durationSec },
          });
          const out = { assetIds: [assetId], assets: [{ url, mime, durationSec: r.durationSec }] };
          await cache.set(cacheKey, out);
          return out;
        })());

      if (assistantMessageId) {
        await db.updateMessageGeneration(assistantMessageId, {
          status: "completed",
          metadata: { ...baseMeta, status: "completed", assets: result.assets },
        });
      }
      await queue.updateProgress(job.id, 100);
      return result;
    } catch (err) {
      if (assistantMessageId) {
        await db.updateMessageGeneration(assistantMessageId, {
          status: "failed",
          metadata: { ...baseMeta, status: "failed", error: err instanceof Error ? err.message : String(err) },
        });
      }
      throw err;
    }
  });
```

- [ ] **Step 4: Verify the worker still builds**

Run: `npm run build -w @lot-agent/server`
Expected: build succeeds (no unused-import or type errors). Remove the now-unused `StubImageProvider`/`StubVideoProvider` import if the build flags it.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/workers/index.ts
git commit -m "feat(server): worker uses real providers + writes result onto the message"
```

---

### Task 6: Route — POST /api/conversations/:id/generations

**Files:**
- Modify: `packages/server/src/routes/conversations.ts`
- Test: `packages/server/src/routes/generations.test.ts`

**Interfaces:**
- Consumes: `AgentService` (`jobQueue`, `usageMeter`, `modelRegistry`, `db`); `DB.addMessage`, `DB.getConversation`.
- Produces: `POST /api/conversations/:id/generations` body `{ prompt: string; mediaType: "image" | "video"; settings?: { size?: string; n?: number; durationSec?: number; ratio?: string; quality?: string } }` → 202 `{ userMessage: {id, role, content}, assistantMessage: {id, role, status, metadata}, taskId }`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/routes/generations.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createGenerationRoutes } from "./conversations.js";

function fakeService() {
  const messages: any[] = [];
  return {
    messages,
    db: {
      getConversation: vi.fn(async () => ({ id: "c1", user_id: "u1" })),
      addMessage: vi.fn(async (id: string, _cid: string, role: string, content: string, opts: any) => {
        messages.push({ id, role, content, ...opts });
      }),
      updateMessageGeneration: vi.fn(async () => {}),
    },
    usageMeter: { checkQuota: vi.fn(async () => ({ ok: true })) },
    modelRegistry: { getConfig: vi.fn(() => ({ unitPrice: 0.04 })) },
    jobQueue: { enqueue: vi.fn(async () => "task-1") },
  } as any;
}

function app(service: any) {
  const a = new Hono<{ Variables: { userId: string } }>();
  a.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
  a.route("/conversations", createGenerationRoutes(service));
  return a;
}

describe("POST /conversations/:id/generations", () => {
  it("persists user + assistant messages and enqueues a task", async () => {
    const service = fakeService();
    const res = await app(service).request("/conversations/c1/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "菊花", mediaType: "image", settings: { size: "1024x1024", n: 1 } }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.taskId).toBe("task-1");
    expect(body.userMessage.content).toBe("菊花");
    expect(body.assistantMessage.status).toBe("generating");
    expect(service.jobQueue.enqueue).toHaveBeenCalledWith(
      "image.generate",
      expect.objectContaining({ prompt: "菊花", conversationId: "c1", assistantMessageId: body.assistantMessage.id, size: "1024x1024" }),
      "u1"
    );
    expect(service.messages).toHaveLength(2);
  });

  it("404s when the conversation belongs to another user", async () => {
    const service = fakeService();
    service.db.getConversation = vi.fn(async () => ({ id: "c1", user_id: "other" }));
    const res = await app(service).request("/conversations/c1/generations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "x", mediaType: "image" }),
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/server -- generations`
Expected: FAIL (`createGenerationRoutes` not exported).

- [ ] **Step 3: Implement the route**

In `packages/server/src/routes/conversations.ts`, add the import at the top if missing:

```ts
import { randomUUID } from "node:crypto";
```

Add and export this factory (it returns a Hono sub-app mounted at `/conversations`, mirroring the existing ownership pattern):

```ts
type GenVariables = { userId: string };

export function createGenerationRoutes(service: AgentService) {
  const app = new Hono<{ Variables: GenVariables }>();

  app.post("/:id/generations", async (c) => {
    const userId = c.get("userId");
    const conversationId = c.req.param("id");

    const conv = await service.db.getConversation(conversationId);
    if (!conv || (conv as { user_id?: string }).user_id !== userId) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    let body: { prompt?: string; mediaType?: "image" | "video"; settings?: Record<string, unknown> };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const prompt = (body.prompt ?? "").trim();
    const mediaType = body.mediaType;
    if (!prompt || (mediaType !== "image" && mediaType !== "video")) {
      return c.json({ error: "prompt and mediaType (image|video) are required" }, 400);
    }
    const settings = body.settings ?? {};
    const type = mediaType === "image" ? "image.generate" : "video.generate";

    // Quota pre-check (mirrors the /tasks route).
    const modelId = mediaType === "image" ? "wanx-standard" : "kling-standard";
    const unit = service.modelRegistry.getConfig(modelId)?.unitPrice ?? 0;
    const durationSec = Number(settings.durationSec ?? 5);
    const estimatedCost = mediaType === "image" ? unit * Number(settings.n ?? 1) : unit * durationSec;
    const quota = await service.usageMeter.checkQuota(userId, estimatedCost);
    if (!quota.ok) return c.json({ error: quota.reason, estimatedCost }, 402);

    // Persist user message.
    const userMessageId = randomUUID();
    await service.db.addMessage(userMessageId, conversationId, "user", prompt);

    // Persist pending assistant generation message.
    const assistantMessageId = randomUUID();
    const metadata = { kind: "generation", mediaType, prompt, settings, status: "generating" };
    await service.db.addMessage(assistantMessageId, conversationId, "assistant", "", {
      metadata,
      model: modelId,
    });
    // The DB default status is 'completed'; force it to 'generating'.
    await service.db.updateMessageGeneration(assistantMessageId, { status: "generating", metadata });

    // Enqueue.
    const taskId = await service.jobQueue.enqueue(
      type,
      { prompt, conversationId, assistantMessageId, ...settings },
      userId
    );

    return c.json(
      {
        userMessage: { id: userMessageId, role: "user", content: prompt },
        assistantMessage: { id: assistantMessageId, role: "assistant", status: "generating", metadata },
        taskId,
      },
      202
    );
  });

  return app;
}
```

- [ ] **Step 4: Mount the route in the server**

Find where conversation routes are mounted (search `createConversationRoutes` / `app.route("/conversations"` in `packages/server/src/index.ts`). Mount the generation routes on the same authenticated `/api/conversations` base, e.g. directly after the existing conversation routes:

```ts
import { createConversationRoutes, createGenerationRoutes } from "./routes/conversations.js";
// ...
api.route("/conversations", createGenerationRoutes(service));
```

(Place it alongside the existing `api.route("/conversations", createConversationRoutes(...))` so `authMw` already applies.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w @lot-agent/server -- generations`
Expected: PASS.

- [ ] **Step 6: Build the server**

Run: `npm run build -w @lot-agent/server`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/routes/conversations.ts packages/server/src/routes/generations.test.ts packages/server/src/index.ts
git commit -m "feat(server): POST /conversations/:id/generations enqueues + persists messages"
```

---

### Task 7: Web — controlled MediaSettings + settings in onSend

**Files:**
- Modify: `packages/web/src/components/MediaSettings.tsx`
- Modify: `packages/web/src/components/InputBox.tsx`
- Modify: `packages/web/src/components/ChatPanel.tsx`

**Interfaces:**
- Produces:
  - `interface ImageSettings { size: string; n: number }`
  - `interface VideoSettings { size: string; durationSec: number; ratio: string; quality: string }`
  - `InputBox` `onSend` becomes `(content: string, files: File[], settings?: ImageSettings | VideoSettings) => void`.
  - `ImageSettingsPicker` / `VideoSettingsPicker` add `onChange: (s: ImageSettings | VideoSettings) => void` and report on mount + change.

- [ ] **Step 1: Lift image settings out of `ImageSettingsPicker`**

In `packages/web/src/components/MediaSettings.tsx`, export the settings types and emit changes. Add near the top:

```ts
export interface ImageSettings { size: string; n: number }
export interface VideoSettings { size: string; durationSec: number; ratio: string; quality: string }
```

In `ImageSettingsPicker`, change the signature and report changes:

```tsx
export function ImageSettingsPicker({
  disabled,
  onChange,
}: {
  disabled?: boolean;
  onChange?: (s: ImageSettings) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useDismiss(open, () => setOpen(false));
  const [ratio, setRatio] = useState<Ratio>(IMAGE_RATIOS[0]); // 16:9
  const [dim, setDim] = useState<Dim>(deriveResolution(16, 9, 1536));

  useEffect(() => {
    onChange?.({ size: `${dim.width}x${dim.height}`, n: 1 });
  }, [dim, onChange]);

  const pickRatio = (r: Ratio) => {
    setRatio(r);
    setDim(deriveResolution(r.w, r.h, 1536));
  };
  // ...rest unchanged (trigger + popup)...
}
```

Add `useEffect` to the existing React import at the top of the file:

```ts
import { useState, useRef, useEffect } from "react";
```

- [ ] **Step 2: Lift video settings out of `VideoSettingsPicker`**

In `VideoSettingsPicker`, add `onChange` and report:

```tsx
export function VideoSettingsPicker({
  disabled,
  onChange,
}: {
  disabled?: boolean;
  onChange?: (s: VideoSettings) => void;
}) {
  // ...existing state (quality, ratio, dim, duration)...
  useEffect(() => {
    onChange?.({
      size: `${dim.width}x${dim.height}`,
      durationSec: Number(duration.replace(/[^0-9]/g, "")) || 5,
      ratio: ratio.label,
      quality: quality.short,
    });
  }, [dim, duration, ratio, quality, onChange]);
  // ...rest unchanged...
}
```

- [ ] **Step 3: Thread settings through `InputBox`**

In `packages/web/src/components/InputBox.tsx`:

- Update the prop type and `onSend`:

```ts
import { ImageSettingsPicker, VideoSettingsPicker, type ImageSettings, type VideoSettings } from "./MediaSettings.js";

interface InputBoxProps {
  onSend: (content: string, files: File[], settings?: ImageSettings | VideoSettings) => void;
  onStop: () => void;
  disabled: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  mode?: InputMode;
}
```

- Hold the latest settings in a ref and pass them to the pickers:

```tsx
  const settingsRef = useRef<ImageSettings | VideoSettings | undefined>(undefined);
```

- In `handleSend`, forward the settings:

```tsx
  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if ((!trimmed && files.length === 0) || disabled) return;
    onSend(trimmed, files, mediaMode ? settingsRef.current : undefined);
    setValue("");
    setFiles([]);
    revokeAll();
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [value, files, disabled, onSend, revokeAll, mediaMode]);
```

- Wire the pickers' `onChange`:

```tsx
          {mode === "image" && (
            <ImageSettingsPicker disabled={disabled} onChange={(s) => (settingsRef.current = s)} />
          )}
          {mode === "video" && (
            <VideoSettingsPicker disabled={disabled} onChange={(s) => (settingsRef.current = s)} />
          )}
```

- [ ] **Step 4: Propagate the new `onSend` signature through `ChatPanel`**

`ChatPanel`'s `onSend` prop type must widen to accept settings. In `packages/web/src/components/ChatPanel.tsx`:

```ts
import { InputBox, type InputMode } from "./InputBox.js";
import type { ImageSettings, VideoSettings } from "./MediaSettings.js";

interface ChatPanelProps {
  messages: DisplayMessage[];
  onSend: (content: string, files: File[], settings?: ImageSettings | VideoSettings) => void;
  // ...rest unchanged...
}
```

(`InputBox` already receives `onSend={onSend}` — no JSX change needed.)

- [ ] **Step 5: Verify the web typechecks**

Run: `npx tsc --noEmit -p packages/web/tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/MediaSettings.tsx packages/web/src/components/InputBox.tsx packages/web/src/components/ChatPanel.tsx
git commit -m "feat(web): controlled media settings forwarded through onSend"
```

---

### Task 8: Web — generation API, card, message render, and send branching

**Files:**
- Modify: `packages/web/src/api/client.ts`
- Create: `packages/web/src/components/GenerationCard.tsx`
- Modify: `packages/web/src/hooks/useChat.ts`
- Modify: `packages/web/src/components/MessageBubble.tsx`
- Modify: `packages/web/src/pages/Workspace.tsx`
- Modify: `packages/web/src/App.css`

**Interfaces:**
- Consumes: `POST /conversations/:id/generations` (Task 6); `GET /tasks/:id` (existing); settings types (Task 7).
- Produces:
  - `api.generate(conversationId, { prompt, mediaType, settings }) => Promise<{ userMessage; assistantMessage; taskId }>`
  - `DisplayMessage.generation?: { mediaType: "image" | "video"; status: "generating" | "completed" | "failed"; assets?: { url: string; mime: string; durationSec?: number }[]; error?: string; taskId?: string }`
  - `useChat.generateMedia(prompt: string, mediaType: "image" | "video", settings?: ImageSettings | VideoSettings): void`
  - `<GenerationCard generation={...} />`

- [ ] **Step 1: Add the API method + types**

In `packages/web/src/api/client.ts`, add to the `api` object (near `createTask`):

```ts
  generate: (
    conversationId: string,
    body: { prompt: string; mediaType: "image" | "video"; settings?: unknown }
  ) =>
    request<{
      userMessage: { id: string; role: "user"; content: string };
      assistantMessage: {
        id: string;
        role: "assistant";
        status: string;
        metadata: { mediaType: "image" | "video"; status: string; assets?: { url: string; mime: string; durationSec?: number }[]; error?: string };
      };
      taskId: string;
    }>(`/conversations/${conversationId}/generations`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
```

- [ ] **Step 2: Add the `generation` field to `DisplayMessage`**

In `packages/web/src/hooks/useChat.ts`, extend the interface:

```ts
export interface GenerationView {
  mediaType: "image" | "video";
  status: "generating" | "completed" | "failed";
  assets?: { url: string; mime: string; durationSec?: number }[];
  error?: string;
  taskId?: string;
}

export interface DisplayMessage {
  id: string;
  dbId?: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: { name: string; input: unknown }[];
  toolResult?: { name: string; output: string; isError: boolean };
  isStreaming?: boolean;
  rating?: number | null;
  attachments?: UploadedAttachment[];
  generation?: GenerationView;
}
```

- [ ] **Step 3: Map persisted generation messages in `loadMessages`**

In `useChat.ts` `loadMessages`, inside the `.map`, derive `generation` from metadata. Replace the returned object's tail with an added field:

```ts
      const gen =
        role === "assistant" && parsedMeta?.kind === "generation"
          ? {
              mediaType: parsedMeta.mediaType as "image" | "video",
              status: (parsedMeta.status ?? "generating") as GenerationView["status"],
              assets: parsedMeta.assets,
              error: parsedMeta.error,
            }
          : undefined;
      return {
        id: m.id,
        dbId: m.id,
        role,
        content: m.content,
        attachments:
          role === "user"
            ? (parsedMeta?.attachments as UploadedAttachment[] | undefined)
            : undefined,
        toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : undefined,
        toolResult:
          role === "tool"
            ? { name: toolName ?? "tool", output: m.content, isError: false }
            : undefined,
        rating: m.rating ?? null,
        generation: gen,
      };
```

- [ ] **Step 4: Add `generateMedia` to `useChat` (with polling)**

In `useChat.ts`, add this callback inside the hook and include it in the returned object:

```ts
  const generateMedia = useCallback(
    (prompt: string, mediaType: "image" | "video", settings?: unknown) => {
      const cid = cidRef.current;
      if (!cid || !prompt.trim() || isStreaming) return;
      setIsStreaming(true);

      (async () => {
        try {
          const res = await api.generate(cid, { prompt, mediaType, settings });
          const userMsg: DisplayMessage = { id: res.userMessage.id, dbId: res.userMessage.id, role: "user", content: prompt };
          const genMsg: DisplayMessage = {
            id: res.assistantMessage.id,
            dbId: res.assistantMessage.id,
            role: "assistant",
            content: "",
            generation: { mediaType, status: "generating", taskId: res.taskId },
          };
          setMessages((prev) => [...prev, userMsg, genMsg]);

          // Poll the task until terminal, then patch the generation message.
          const poll = async () => {
            try {
              const t = await api.getTask(res.taskId);
              if (t.status === "done" || t.status === "failed") {
                const out = t.output as { assets?: { url: string; mime: string; durationSec?: number }[] } | undefined;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === genMsg.id
                      ? {
                          ...m,
                          generation: {
                            mediaType,
                            status: t.status === "done" ? "completed" : "failed",
                            assets: out?.assets,
                            error: t.error,
                            taskId: res.taskId,
                          },
                        }
                      : m
                  )
                );
                setIsStreaming(false);
                onStreamEndRef.current?.();
                return;
              }
            } catch {
              /* keep polling */
            }
            setTimeout(poll, 1000);
          };
          poll();
        } catch (e) {
          setIsStreaming(false);
          window.alert(`生成请求失败：${e instanceof Error ? e.message : String(e)}`);
        }
      })();
    },
    [isStreaming]
  );
```

Add `generateMedia` to the hook's `return { ... }`.

- [ ] **Step 5: Create `GenerationCard`**

Create `packages/web/src/components/GenerationCard.tsx`:

```tsx
import type { GenerationView } from "../hooks/useChat.js";

const LABELS = {
  image: { loading: "图片生成中……", fail: "图片生成失败" },
  video: { loading: "视频生成中……", fail: "视频生成失败" },
};

function MediaIcon({ mediaType }: { mediaType: "image" | "video" }) {
  if (mediaType === "video") {
    return (
      <svg viewBox="0 0 24 24" className="gen-card-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
        <path d="M10 9.5v5l4-2.5z" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="gen-card-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <circle cx="8.5" cy="8.5" r="1.6" />
      <path d="m21 15-4.5-4.5L5 21" />
    </svg>
  );
}

export function GenerationCard({ generation }: { generation: GenerationView }) {
  const { mediaType, status, assets, error } = generation;

  if (status === "completed" && assets && assets.length > 0) {
    return (
      <div className="gen-card-assets">
        {assets.map((a, i) =>
          mediaType === "video" && a.mime.startsWith("video/") ? (
            <video key={i} className="gen-asset" src={a.url} controls />
          ) : (
            <img key={i} className="gen-asset" src={a.url} alt={`生成结果 ${i + 1}`} />
          )
        )}
      </div>
    );
  }

  const failed = status === "failed";
  return (
    <div className={`gen-card ${mediaType} ${failed ? "gen-card--failed" : "gen-card--loading"}`} title={error ?? undefined}>
      <MediaIcon mediaType={mediaType} />
      <div className="gen-card-label">{failed ? LABELS[mediaType].fail : LABELS[mediaType].loading}</div>
    </div>
  );
}
```

- [ ] **Step 6: Render generation messages in `MessageBubble`**

In `packages/web/src/components/MessageBubble.tsx`, import the card and render it when `message.generation` is set (before the normal content block):

```tsx
import { GenerationCard } from "./GenerationCard.js";
// inside the component, where the assistant content renders:
if (message.generation) {
  return (
    <div className="message-wrapper message-assistant">
      <div className="message-wrapper-inner">
        <GenerationCard generation={message.generation} />
      </div>
    </div>
  );
}
```

(Place this early-return after the hooks but before the existing text/tool rendering; match the existing wrapper class names used for assistant messages in the file.)

- [ ] **Step 7: Branch send in `Workspace`**

In `packages/web/src/pages/Workspace.tsx`:

- Destructure `generateMedia` from `useChat`:

```ts
  const { messages, send, stop, isStreaming, loadMessages, clear, regenerate, generateMedia } =
    useChat(activeId, handleStreamEnd, activeIdRef, updateTitle);
```

- In `doSend`, branch on the active agent kind. Replace the `send(content, files)` calls with a helper that picks generation vs chat:

```ts
  const doSend = useCallback(
    async (content: string, files: File[] = [], settings?: unknown) => {
      const kind = activeAgent?.type || activeAgent?.id;
      const dispatch = () => {
        if (kind === "image" || kind === "video") {
          generateMedia(content, kind as "image" | "video", settings);
        } else {
          send(content, files);
        }
      };
      if (newAgentId) {
        const conv = await api.createConversation(undefined, newAgentId);
        activeIdRef.current = conv.id;
        setActiveId(conv.id);
        setNewAgentId(null);
        refresh();
        dispatch();
        return;
      }
      dispatch();
    },
    [newAgentId, setActiveId, refresh, send, generateMedia, activeAgent]
  );
```

(Note: `generateMedia`/`send` read `cidRef.current`, which `activeIdRef` updates synchronously — same pattern the existing code relies on.)

- The `ChatPanel` `onSend={doSend}` already matches the widened `(content, files, settings)` signature.

- [ ] **Step 8: Add card styles to `App.css`**

Add new tokens to BOTH `:root` and `[data-theme="dark"]` (place beside the existing `--agent-icon-*` tokens):

```css
  --gen-card-from: rgba(167,139,250,0.16);
  --gen-card-to: rgba(96,165,250,0.12);
```

Then append the card styles (after the media-settings block):

```css
/* ── 生成结果卡片 ── */
.gen-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  width: min(520px, 100%);
  aspect-ratio: 16 / 9;
  border-radius: 18px;
  background: linear-gradient(135deg, var(--gen-card-from), var(--gen-card-to));
  color: var(--accent);
}
.gen-card.image { aspect-ratio: 16 / 10; }
.gen-card-icon { width: 40px; height: 40px; }
.gen-card-label { font-size: 16px; font-weight: 600; color: var(--accent); }
.gen-card--failed { color: var(--accent); opacity: 0.92; }
.gen-card--loading .gen-card-icon { animation: gen-pulse 1.4s ease-in-out infinite; }
@keyframes gen-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }

.gen-card-assets { display: flex; flex-wrap: wrap; gap: 10px; }
.gen-asset {
  max-width: min(520px, 100%);
  border-radius: 16px;
  box-shadow: var(--shadow-md);
}
```

- [ ] **Step 9: Typecheck + build the web**

Run: `npx tsc --noEmit -p packages/web/tsconfig.json && npm run build -w @lot-agent/web`
Expected: no errors; build succeeds.

- [ ] **Step 10: Commit**

```bash
git add packages/web/src/api/client.ts packages/web/src/components/GenerationCard.tsx packages/web/src/hooks/useChat.ts packages/web/src/components/MessageBubble.tsx packages/web/src/pages/Workspace.tsx packages/web/src/App.css
git commit -m "feat(web): generation card + send branching + task polling"
```

---

## Manual verification (after all tasks)

1. `npm run build` (all workspaces) succeeds; `npm test` passes.
2. With Postgres + Redis up: `npm run dev` and `npm run dev:worker -w @lot-agent/server`.
3. Switch to 图像生成, type a prompt, send → user bubble + "图片生成中……" card → within ~1s a placeholder image appears. Reload the conversation → the image persists.
4. Prompt containing `fail` → "图片生成失败" card; reload → failure persists.
5. Switch to 视频生成, send → "视频生成中……" → poster card; reload persists.
6. AI 对话 agent still streams normally (unchanged path).
```
