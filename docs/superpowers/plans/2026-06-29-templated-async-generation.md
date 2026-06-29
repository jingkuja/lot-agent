# Templated Async Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert image/video generation to the real vendor's async **create→poll** model behind a templated provider (fixed flow) + swappable per-vendor adapter, add reference-image (`media[]`) params, and show live progress %.

**Architecture:** A single `GenerationProvider` (`create`/`poll`) is the template; a `VendorAdapter` supplies endpoints, request body, and response parsing. `HttpGenerationProvider` drives any adapter; `HappyhorseAdapter` is the first vendor; `MockGenerationProvider` simulates the same async contract with a progress ramp. The worker runs one `runGenerationJob` create→poll→store flow (relaying progress) for both media types; the route accepts `media`; the web uploads reference images and renders the progress %.

**Tech Stack:** TypeScript ESM monorepo (npm workspaces), Vitest, Hono, `pg`, BullMQ, React 19 + Vite.

## Global Constraints

- ESM imports use explicit `.js` suffixes; 2-space indent.
- Interface-in-core, impl-in-server only when DB/Redis is needed; plain-`fetch` providers live in core.
- No secrets in git: vendor key via env `TOKENHUB_API_KEY`; `config/default.json` holds non-secret structure.
- Tests colocated as `*.test.ts`; TDD (failing test first).
- Web colors use existing `var(--*)` tokens; never hardcode hex/rgba in component rules.
- Vendor create: `POST {baseUrl}/{mediaType}/generation`; response `{ id, task_id, status, progress, ... }`. Poll: `GET {baseUrl}/{mediaType}s/{task_id}`; response `{ status, progress, metadata:{ url } }`. Terminal statuses: `completed` / `failed`.
- Reference image param: `media: [ { "type": "reference_image", "url": "<url>" } ]`.
- Each task must leave the full monorepo building (`npm run build`) — provider removal is sequenced so no task leaves a broken build.

---

### Task 1: Core — `generation.ts` (template + adapter + http + mock)

**Files:**
- Create: `packages/core/src/providers/generation.ts`
- Modify: `packages/core/src/providers/index.ts`
- Test: `packages/core/src/providers/generation.test.ts`

**Interfaces:**
- Produces (all exported from `@lot-agent/core`):
  - `type MediaType = "image" | "video"`
  - `interface ReferenceMedia { type: "reference_image"; url: string }`
  - `interface GenerationRequest { mediaType: MediaType; prompt: string; model?: string; size?: string; n?: number; durationSec?: number; ratio?: string; quality?: string; media?: ReferenceMedia[] }`
  - `interface CreateResult { taskId: string; status: string; progress: number }`
  - `interface PollResult { status: string; progress: number; url?: string; error?: string }`
  - `interface GenerationProvider { create(req: GenerationRequest): Promise<CreateResult>; poll(taskId: string, mediaType: MediaType): Promise<PollResult> }`
  - `interface VendorAdapter { createPath(m: MediaType): string; pollPath(m: MediaType, taskId: string): string; buildCreateBody(req: GenerationRequest, model: string): unknown; parseCreate(json: unknown): CreateResult; parsePoll(json: unknown): PollResult; isTerminal(status: string): "completed" | "failed" | null }`
  - `class HappyhorseAdapter implements VendorAdapter`
  - `class HttpGenerationProvider implements GenerationProvider` (ctor `{ baseUrl: string; apiKey: string; adapter: VendorAdapter; imageModel: string; videoModel: string }`)
  - `class MockGenerationProvider implements GenerationProvider` (ctor `(durationMs?: number, now?: () => number)`)
  - `const ADAPTERS: Record<string, () => VendorAdapter>` and `function pickAdapter(name: string): VendorAdapter`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/providers/generation.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  HappyhorseAdapter,
  HttpGenerationProvider,
  MockGenerationProvider,
  pickAdapter,
} from "./generation.js";

describe("HappyhorseAdapter", () => {
  const a = new HappyhorseAdapter();
  it("builds create/poll paths (singular create, plural poll)", () => {
    expect(a.createPath("image")).toBe("/image/generation");
    expect(a.createPath("video")).toBe("/video/generation");
    expect(a.pollPath("image", "t1")).toBe("/images/t1");
    expect(a.pollPath("video", "t1")).toBe("/videos/t1");
  });
  it("buildCreateBody maps duration + includes media only when present", () => {
    const body = a.buildCreateBody(
      { mediaType: "video", prompt: "麦田", size: "832x480", durationSec: 5, ratio: "16:9", media: [{ type: "reference_image", url: "u" }] },
      "happyhorse-1.0-t2v"
    ) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "happyhorse-1.0-t2v", prompt: "麦田", size: "832x480", duration: 5, ratio: "16:9", media: [{ type: "reference_image", url: "u" }] });
    const noMedia = a.buildCreateBody({ mediaType: "image", prompt: "p" }, "m") as Record<string, unknown>;
    expect("media" in noMedia).toBe(false);
  });
  it("parseCreate reads task_id/status/progress", () => {
    expect(a.parseCreate({ id: "x", task_id: "task_9", status: "queued", progress: 0 })).toEqual({ taskId: "task_9", status: "queued", progress: 0 });
  });
  it("parsePoll reads status/progress/metadata.url", () => {
    expect(a.parsePoll({ status: "completed", progress: 100, metadata: { url: "https://x/y.mp4" } })).toEqual({ status: "completed", progress: 100, url: "https://x/y.mp4", error: undefined });
  });
  it("isTerminal classifies completed/failed/other", () => {
    expect(a.isTerminal("completed")).toBe("completed");
    expect(a.isTerminal("failed")).toBe("failed");
    expect(a.isTerminal("processing")).toBe(null);
  });
});

describe("HttpGenerationProvider", () => {
  afterEach(() => vi.restoreAllMocks());
  it("create POSTs createPath with adapter body + Bearer", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ task_id: "task_1", status: "queued", progress: 0 }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const p = new HttpGenerationProvider({ baseUrl: "https://api/v1", apiKey: "k", adapter: new HappyhorseAdapter(), imageModel: "im", videoModel: "vm" });
    const r = await p.create({ mediaType: "video", prompt: "hi" });
    expect(r).toEqual({ taskId: "task_1", status: "queued", progress: 0 });
    const [url, init] = (fetchMock.mock.calls[0] as [string, RequestInit]);
    expect(url).toBe("https://api/v1/video/generation");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "vm", prompt: "hi" });
  });
  it("poll GETs pollPath and normalizes terminal status", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ status: "completed", progress: 100, metadata: { url: "https://x/y.png" } }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const p = new HttpGenerationProvider({ baseUrl: "https://api/v1", apiKey: "k", adapter: new HappyhorseAdapter(), imageModel: "im", videoModel: "vm" });
    const r = await p.poll("task_1", "image");
    expect(r.status).toBe("completed");
    expect(r.url).toBe("https://x/y.png");
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("https://api/v1/images/task_1");
  });
  it("create throws on non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" })) as unknown as typeof fetch);
    const p = new HttpGenerationProvider({ baseUrl: "https://api/v1", apiKey: "k", adapter: new HappyhorseAdapter(), imageModel: "im", videoModel: "vm" });
    await expect(p.create({ mediaType: "image", prompt: "x" })).rejects.toThrow(/500/);
  });
});

describe("MockGenerationProvider", () => {
  it("ramps progress then completes with a data: url", async () => {
    let t = 0;
    const p = new MockGenerationProvider(1000, () => t);
    const created = await p.create({ mediaType: "image", prompt: "菊花" });
    expect(created.status).toBe("queued");
    t = 500;
    const mid = await p.poll(created.taskId, "image");
    expect(mid.status).toBe("processing");
    expect(mid.progress).toBe(50);
    t = 1000;
    const done = await p.poll(created.taskId, "image");
    expect(done.status).toBe("completed");
    expect(done.progress).toBe(100);
    expect(done.url?.startsWith("data:image/svg+xml;base64,")).toBe(true);
  });
  it("fails when prompt contains 'fail' past the halfway mark", async () => {
    let t = 0;
    const p = new MockGenerationProvider(1000, () => t);
    const c = await p.create({ mediaType: "video", prompt: "please fail" });
    t = 600;
    const r = await p.poll(c.taskId, "video");
    expect(r.status).toBe("failed");
  });
});

describe("pickAdapter", () => {
  it("returns Happyhorse for known + unknown names", () => {
    expect(pickAdapter("happyhorse")).toBeInstanceOf(HappyhorseAdapter);
    expect(pickAdapter("nope")).toBeInstanceOf(HappyhorseAdapter);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/core -- generation.test`
Expected: FAIL (module `./generation.js` not found).

- [ ] **Step 3: Implement `generation.ts`**

Create `packages/core/src/providers/generation.ts`:

```ts
import { randomUUID } from "node:crypto";
import { placeholderSvgDataUrl } from "./placeholder.js";

export type MediaType = "image" | "video";
export interface ReferenceMedia { type: "reference_image"; url: string }
export interface GenerationRequest {
  mediaType: MediaType;
  prompt: string;
  model?: string;
  size?: string;
  n?: number;
  durationSec?: number;
  ratio?: string;
  quality?: string;
  media?: ReferenceMedia[];
}
export interface CreateResult { taskId: string; status: string; progress: number }
export interface PollResult { status: string; progress: number; url?: string; error?: string }
export interface GenerationProvider {
  create(req: GenerationRequest): Promise<CreateResult>;
  poll(taskId: string, mediaType: MediaType): Promise<PollResult>;
}
export interface VendorAdapter {
  createPath(mediaType: MediaType): string;
  pollPath(mediaType: MediaType, taskId: string): string;
  buildCreateBody(req: GenerationRequest, model: string): unknown;
  parseCreate(json: unknown): CreateResult;
  parsePoll(json: unknown): PollResult;
  isTerminal(status: string): "completed" | "failed" | null;
}

function parseSize(size?: string): [number, number] {
  const m = /^(\d+)x(\d+)$/.exec(size ?? "");
  return m ? [Number(m[1]), Number(m[2])] : [1024, 1024];
}

/** First vendor: tokenhub "happyhorse" async create→poll format. */
export class HappyhorseAdapter implements VendorAdapter {
  createPath(mediaType: MediaType): string {
    return `/${mediaType}/generation`;
  }
  pollPath(mediaType: MediaType, taskId: string): string {
    return `/${mediaType === "image" ? "images" : "videos"}/${taskId}`;
  }
  buildCreateBody(req: GenerationRequest, model: string): unknown {
    const body: Record<string, unknown> = { model, prompt: req.prompt };
    if (req.size) body.size = req.size;
    if (req.durationSec != null) body.duration = req.durationSec;
    if (req.ratio) body.ratio = req.ratio;
    if (req.media && req.media.length > 0) body.media = req.media;
    return body;
  }
  parseCreate(json: unknown): CreateResult {
    const j = (json ?? {}) as Record<string, unknown>;
    return {
      taskId: String(j.task_id ?? j.id ?? ""),
      status: String(j.status ?? "queued"),
      progress: Number(j.progress ?? 0),
    };
  }
  parsePoll(json: unknown): PollResult {
    const j = (json ?? {}) as Record<string, unknown>;
    const meta = (j.metadata ?? {}) as Record<string, unknown>;
    return {
      status: String(j.status ?? ""),
      progress: Number(j.progress ?? 0),
      url: typeof meta.url === "string" ? meta.url : undefined,
      error: typeof j.error === "string" ? j.error : undefined,
    };
  }
  isTerminal(status: string): "completed" | "failed" | null {
    if (status === "completed") return "completed";
    if (status === "failed") return "failed";
    return null;
  }
}

/** Template: drives any VendorAdapter over HTTP. */
export class HttpGenerationProvider implements GenerationProvider {
  constructor(
    private opts: { baseUrl: string; apiKey: string; adapter: VendorAdapter; imageModel: string; videoModel: string }
  ) {}
  private model(mediaType: MediaType): string {
    return mediaType === "image" ? this.opts.imageModel : this.opts.videoModel;
  }
  async create(req: GenerationRequest): Promise<CreateResult> {
    const { adapter, baseUrl, apiKey } = this.opts;
    const model = req.model ?? this.model(req.mediaType);
    const res = await fetch(`${baseUrl}${adapter.createPath(req.mediaType)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(adapter.buildCreateBody(req, model)),
    });
    if (!res.ok) throw new Error(`generation create failed: ${res.status} ${await res.text()}`);
    return adapter.parseCreate(await res.json());
  }
  async poll(taskId: string, mediaType: MediaType): Promise<PollResult> {
    const { adapter, baseUrl, apiKey } = this.opts;
    const res = await fetch(`${baseUrl}${adapter.pollPath(mediaType, taskId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`generation poll failed: ${res.status} ${await res.text()}`);
    const parsed = adapter.parsePoll(await res.json());
    const term = adapter.isTerminal(parsed.status);
    return { ...parsed, status: term ?? "running" };
  }
}

const MOCK_DURATION_MS = 3500;
/** Mock: in-memory async simulation with a progress ramp (no network / cost). */
export class MockGenerationProvider implements GenerationProvider {
  private tasks = new Map<string, { createdAt: number; req: GenerationRequest }>();
  constructor(private durationMs: number = MOCK_DURATION_MS, private now: () => number = () => Date.now()) {}
  async create(req: GenerationRequest): Promise<CreateResult> {
    const taskId = `mock_${randomUUID()}`;
    this.tasks.set(taskId, { createdAt: this.now(), req });
    return { taskId, status: "queued", progress: 0 };
  }
  async poll(taskId: string, mediaType: MediaType): Promise<PollResult> {
    const t = this.tasks.get(taskId);
    if (!t) return { status: "failed", progress: 0, error: "unknown mock task" };
    const elapsed = this.now() - t.createdAt;
    const pct = this.durationMs <= 0 ? 100 : Math.min(100, Math.round((elapsed / this.durationMs) * 100));
    if (/fail/i.test(t.req.prompt) && pct >= 50) {
      return { status: "failed", progress: pct, error: "mock failure (prompt contains 'fail')" };
    }
    if (pct >= 100) {
      const [w, h] = parseSize(t.req.size);
      return { status: "completed", progress: 100, url: placeholderSvgDataUrl({ prompt: t.req.prompt, width: w, height: h, kind: mediaType }) };
    }
    return { status: "processing", progress: pct };
  }
}

export const ADAPTERS: Record<string, () => VendorAdapter> = {
  happyhorse: () => new HappyhorseAdapter(),
};
export function pickAdapter(name: string): VendorAdapter {
  return (ADAPTERS[name] ?? ADAPTERS.happyhorse)();
}
```

- [ ] **Step 4: Export from the providers barrel**

Edit `packages/core/src/providers/index.ts` — add as the first line:

```ts
export * from "./generation.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w @lot-agent/core -- generation.test`
Expected: PASS (all describe blocks green).

- [ ] **Step 6: Build core**

Run: `npm run build -w @lot-agent/core`
Expected: build succeeds (new exports resolve).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/providers/generation.ts packages/core/src/providers/generation.test.ts packages/core/src/providers/index.ts
git commit -m "feat(core): templated async GenerationProvider + Happyhorse adapter + mock"
```

---

### Task 2: Server config — `makeGenerationProvider` + adapter

**Files:**
- Modify: `config/default.json`
- Modify: `packages/server/src/generation/config.ts`
- Modify: `packages/server/src/generation/config.test.ts`

**Interfaces:**
- Consumes: `HttpGenerationProvider`, `MockGenerationProvider`, `pickAdapter`, `GenerationProvider` (Task 1).
- Produces:
  - `GenerationConfig` gains `adapter: string`.
  - `makeGenerationProvider(cfg: GenerationConfig): GenerationProvider` (mock when `cfg.mock || !cfg.apiKey`, else `HttpGenerationProvider` with `pickAdapter(cfg.adapter)`).
  - Existing `makeImageProvider`/`makeVideoProvider` remain for now (removed in Task 5).

- [ ] **Step 1: Add `adapter` to config**

In `config/default.json`, inside the `"generation"` block, add `"adapter": "happyhorse"` (sibling of `baseUrl`/`mock`).

- [ ] **Step 2: Write the failing test**

Append to `packages/server/src/generation/config.test.ts` a new block (keep existing tests):

```ts
import { makeGenerationProvider } from "./config.js";
import { HttpGenerationProvider, MockGenerationProvider } from "@lot-agent/core";

describe("makeGenerationProvider", () => {
  const base = { baseUrl: "https://api/v1", apiKey: "", mock: true, adapter: "happyhorse", image: { model: "im", modelId: "wanx-standard" }, video: { model: "vm", modelId: "kling-standard" } };
  it("mock:true → MockGenerationProvider", () => {
    expect(makeGenerationProvider(base)).toBeInstanceOf(MockGenerationProvider);
  });
  it("mock:false + key → HttpGenerationProvider", () => {
    expect(makeGenerationProvider({ ...base, mock: false, apiKey: "k" })).toBeInstanceOf(HttpGenerationProvider);
  });
  it("mock:false + no key → falls back to mock", () => {
    expect(makeGenerationProvider({ ...base, mock: false, apiKey: "" })).toBeInstanceOf(MockGenerationProvider);
  });
});
```

(The existing top imports already pull from `./config.js` and `@lot-agent/core`; add `makeGenerationProvider`, `HttpGenerationProvider`, `MockGenerationProvider` to those import lists rather than re-importing if your linter objects to duplicate import sources — either form compiles.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -w @lot-agent/server -- generation/config`
Expected: FAIL (`makeGenerationProvider` not exported, `adapter` missing on type).

- [ ] **Step 4: Implement**

In `packages/server/src/generation/config.ts`:

Add to the core import list: `HttpGenerationProvider, MockGenerationProvider, pickAdapter, type GenerationProvider`.

Add `adapter: string;` to the `GenerationConfig` interface (after `mock`).

In `loadGenerationConfig`'s returned object, add `adapter: g.adapter ?? "happyhorse",` (after `mock`).

Add the factory (after `makeVideoProvider`):

```ts
export function makeGenerationProvider(cfg: GenerationConfig): GenerationProvider {
  if (cfg.mock || !cfg.apiKey) return new MockGenerationProvider();
  return new HttpGenerationProvider({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    adapter: pickAdapter(cfg.adapter),
    imageModel: cfg.image.model,
    videoModel: cfg.video.model,
  });
}
```

- [ ] **Step 5: Run tests + build**

Run: `npm test -w @lot-agent/server -- generation/config && npm run build -w @lot-agent/server`
Expected: PASS; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add config/default.json packages/server/src/generation/config.ts packages/server/src/generation/config.test.ts
git commit -m "feat(server): makeGenerationProvider + adapter config"
```

---

### Task 3: Server — `runGenerationJob` flow + worker rewrite

**Files:**
- Create: `packages/server/src/generation/run-job.ts`
- Test: `packages/server/src/generation/run-job.test.ts`
- Modify: `packages/server/src/workers/index.ts`

**Interfaces:**
- Consumes: `GenerationProvider`, `MediaType`, `ReferenceMedia` (Task 1); `makeGenerationProvider` (Task 2); `genCacheKey` (`../billing/gen-cache.js`).
- Produces:
  - `interface RunJobDeps { provider; storage; db; meter; cache; updateProgress; urlToBytes; extFor; modelId; vendorModel; pollIntervalMs?; maxWaitMs?; sleep? }` (exact shape in the code below).
  - `runGenerationJob(deps: RunJobDeps, job: { id: string; userId: string; input: Record<string, unknown> }, mediaType: MediaType): Promise<{ assetIds: string[]; assets: { url: string; mime: string; durationSec?: number }[] }>`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/generation/run-job.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { runGenerationJob, type RunJobDeps } from "./run-job.js";
import type { GenerationProvider } from "@lot-agent/core";

function fakeDeps(provider: GenerationProvider, over: Partial<RunJobDeps> = {}): { deps: RunJobDeps; calls: any } {
  const calls: any = { progress: [], asset: null, message: [], metered: false, cacheSet: null };
  const deps: RunJobDeps = {
    provider,
    storage: { put: vi.fn(async ({ key }) => ({ url: `/static/assets/${key}` })) },
    db: {
      createAsset: vi.fn(async (a) => { calls.asset = a; }),
      updateMessageGeneration: vi.fn(async (id, patch) => { calls.message.push({ id, ...patch }); }),
    },
    meter: { record: vi.fn(async () => { calls.metered = true; }) },
    cache: { get: vi.fn(async () => null), set: vi.fn(async (_k, v) => { calls.cacheSet = v; }) },
    updateProgress: vi.fn(async (_id, p) => { calls.progress.push(p); }),
    urlToBytes: vi.fn(async () => ({ body: Buffer.from("x"), mime: "image/svg+xml" })),
    extFor: () => "svg",
    modelId: "wanx-standard",
    vendorModel: "im",
    sleep: async () => {},
    pollIntervalMs: 0,
    ...over,
  };
  return { deps, calls };
}

const job = { id: "job1", userId: "u1", input: { prompt: "菊花", assistantMessageId: "m1", size: "1024x1024" } };

describe("runGenerationJob", () => {
  it("creates, polls to completion, stores asset, relays progress, marks message completed", async () => {
    const provider: GenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "queued", progress: 0 })),
      poll: vi.fn()
        .mockResolvedValueOnce({ status: "processing", progress: 40 })
        .mockResolvedValueOnce({ status: "completed", progress: 100, url: "data:image/svg+xml;base64,Zm9v" }),
    };
    const { deps, calls } = fakeDeps(provider);
    const out = await runGenerationJob(deps, job, "image");
    expect(out.assets).toHaveLength(1);
    expect(calls.progress).toEqual([40, 100, 100]);
    expect(calls.asset.userId).toBe("u1");
    expect(calls.message.at(-1)).toMatchObject({ id: "m1", status: "completed" });
    expect(calls.metered).toBe(true);
  });

  it("marks message failed and rethrows when poll returns failed", async () => {
    const provider: GenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "failed", progress: 50, error: "boom" })),
    };
    const { deps, calls } = fakeDeps(provider);
    await expect(runGenerationJob(deps, job, "image")).rejects.toThrow(/boom/);
    expect(calls.message.at(-1)).toMatchObject({ id: "m1", status: "failed" });
  });

  it("uses cache hit without creating/polling", async () => {
    const provider: GenerationProvider = { create: vi.fn(), poll: vi.fn() };
    const cached = { assetIds: ["a"], assets: [{ url: "/static/assets/a.svg", mime: "image/svg+xml" }] };
    const { deps, calls } = fakeDeps(provider, { cache: { get: vi.fn(async () => cached), set: vi.fn() } });
    const out = await runGenerationJob(deps, job, "image");
    expect(out).toEqual(cached);
    expect(provider.create).not.toHaveBeenCalled();
    expect(calls.message.at(-1)).toMatchObject({ status: "completed" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/server -- run-job`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `run-job.ts`**

Create `packages/server/src/generation/run-job.ts`:

```ts
import { randomUUID } from "node:crypto";
import { genCacheKey } from "../billing/gen-cache.js";
import type { GenerationProvider, MediaType, ReferenceMedia } from "@lot-agent/core";

export interface RunJobDeps {
  provider: GenerationProvider;
  storage: { put(a: { key: string; body: Buffer; contentType: string }): Promise<{ url: string }> };
  db: {
    createAsset(a: Record<string, unknown>): Promise<void>;
    updateMessageGeneration(id: string, patch: { status: string; metadata: Record<string, unknown> }): Promise<void>;
  };
  meter: { record(r: Record<string, unknown>): Promise<void> };
  cache: { get<T>(k: string): Promise<T | null>; set(k: string, v: unknown): Promise<void> };
  updateProgress(taskId: string, progress: number): Promise<void>;
  urlToBytes(url: string): Promise<{ body: Buffer; mime: string }>;
  extFor(mime: string): string;
  modelId: string;
  vendorModel: string;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface JobLike { id: string; userId: string; input: Record<string, unknown> }
type GenAssets = { url: string; mime: string; durationSec?: number }[];
type GenOut = { assetIds: string[]; assets: GenAssets };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runGenerationJob(deps: RunJobDeps, job: JobLike, mediaType: MediaType): Promise<GenOut> {
  const input = job.input;
  const prompt = (input.prompt as string) ?? "";
  const assistantMessageId = input.assistantMessageId as string | undefined;
  const media = input.media as ReferenceMedia[] | undefined;
  const baseMeta = {
    kind: "generation",
    mediaType,
    prompt,
    settings: { size: input.size, n: input.n, durationSec: input.durationSec, ratio: input.ratio },
  };
  const sleep = deps.sleep ?? realSleep;
  const pollIntervalMs = deps.pollIntervalMs ?? 1500;
  const maxWaitMs = deps.maxWaitMs ?? 5 * 60 * 1000;

  const setMsg = async (status: string, extra: Record<string, unknown>) => {
    if (assistantMessageId) {
      await deps.db.updateMessageGeneration(assistantMessageId, { status, metadata: { ...baseMeta, status, ...extra } });
    }
  };

  try {
    const cacheKey = genCacheKey(`${mediaType}.generate`, {
      prompt, size: input.size, n: input.n, durationSec: input.durationSec, ratio: input.ratio,
      media: media?.map((m) => m.url), model: deps.vendorModel,
    });
    const cached = await deps.cache.get<GenOut>(cacheKey);
    if (cached) {
      await setMsg("completed", { assets: cached.assets });
      await deps.updateProgress(job.id, 100);
      return cached;
    }

    const created = await deps.provider.create({
      mediaType, prompt,
      size: input.size as string | undefined,
      n: input.n as number | undefined,
      durationSec: input.durationSec as number | undefined,
      ratio: input.ratio as string | undefined,
      media,
    });

    const start = Date.now();
    let p = await deps.provider.poll(created.taskId, mediaType);
    for (;;) {
      await deps.updateProgress(job.id, p.progress);
      if (p.status === "completed") break;
      if (p.status === "failed") throw new Error(p.error ?? "generation failed");
      if (Date.now() - start > maxWaitMs) throw new Error("generation timed out");
      await sleep(pollIntervalMs);
      p = await deps.provider.poll(created.taskId, mediaType);
    }
    if (!p.url) throw new Error("generation completed without a url");

    const { body, mime } = await deps.urlToBytes(p.url);
    const assetId = randomUUID();
    const key = `${assetId}.${deps.extFor(mime)}`;
    const { url } = await deps.storage.put({ key, body, contentType: mime });
    const durationSec = mediaType === "video" ? Number(input.durationSec ?? 5) : undefined;
    await deps.db.createAsset({ id: assetId, taskId: job.id, userId: job.userId, type: mediaType, storageKey: key, url, mime, sizeBytes: body.byteLength, durationSec });
    await deps.meter.record({ userId: job.userId, taskId: job.id, modelId: deps.modelId, usage: { inputCount: 0, outputCount: mediaType === "video" ? (durationSec ?? 1) : 1 } });
    const assets: GenAssets = [durationSec != null ? { url, mime, durationSec } : { url, mime }];
    const out: GenOut = { assetIds: [assetId], assets };
    await deps.cache.set(cacheKey, out);
    await setMsg("completed", { assets });
    await deps.updateProgress(job.id, 100);
    return out;
  } catch (err) {
    await setMsg("failed", { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
```

- [ ] **Step 4: Run the run-job test**

Run: `npm test -w @lot-agent/server -- run-job`
Expected: PASS (3 tests).

- [ ] **Step 5: Rewrite the worker handlers**

In `packages/server/src/workers/index.ts`:

Change the import on line 18 from:
```ts
import { loadGenerationConfig, makeImageProvider, makeVideoProvider } from "../generation/config.js";
```
to:
```ts
import { loadGenerationConfig, makeGenerationProvider } from "../generation/config.js";
import { runGenerationJob, type RunJobDeps } from "../generation/run-job.js";
```

Replace the provider construction (lines that build `imageProvider`/`videoProvider`):
```ts
  const genConfig = await loadGenerationConfig(ROOT);
  const generationProvider = makeGenerationProvider(genConfig);
```

Add a deps builder right after `extFor` is defined:
```ts
  const genDeps = (mediaType: "image" | "video"): RunJobDeps => ({
    provider: generationProvider,
    storage,
    db,
    meter,
    cache,
    updateProgress: (taskId, progress) => queue.updateProgress(taskId, progress),
    urlToBytes,
    extFor,
    modelId: mediaType === "image" ? genConfig.image.modelId : genConfig.video.modelId,
    vendorModel: mediaType === "image" ? genConfig.image.model : genConfig.video.model,
  });
```

Replace the entire `queue.process("image.generate", ...)` block and the entire `queue.process("video.generate", ...)` block with:
```ts
  queue.process("image.generate", (job) => runGenerationJob(genDeps("image"), job, "image"));
  queue.process("video.generate", (job) => runGenerationJob(genDeps("video"), job, "video"));
```

Leave the `memory.extract` handler untouched.

- [ ] **Step 6: Build the server**

Run: `npm run build -w @lot-agent/server`
Expected: build succeeds. (`makeImageProvider`/`makeVideoProvider` are now unused but still exported — removed in Task 5.)

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/generation/run-job.ts packages/server/src/generation/run-job.test.ts packages/server/src/workers/index.ts
git commit -m "feat(server): runGenerationJob create→poll→store flow + worker delegates"
```

---

### Task 4: Route — accept `media` reference images

**Files:**
- Modify: `packages/server/src/routes/conversations.ts`
- Modify: `packages/server/src/routes/generations.test.ts`

**Interfaces:**
- Produces: `POST /api/conversations/:id/generations` body additionally accepts `media?: { type: "reference_image"; url: string }[]`, threaded into the enqueued task input.

- [ ] **Step 1: Write the failing test**

Append a test to `packages/server/src/routes/generations.test.ts` (reuse the existing `fakeService`/`app` helpers in that file):

```ts
it("threads media (reference images) into the enqueued input", async () => {
  const service = fakeService();
  const res = await app(service).request("/conversations/c1/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "菊花", mediaType: "image", settings: { size: "1024x1024" }, media: [{ type: "reference_image", url: "/static/assets/x.png" }] }),
  });
  expect(res.status).toBe(202);
  const body = await res.json();
  expect(service.jobQueue.enqueue).toHaveBeenCalledWith(
    "image.generate",
    expect.objectContaining({ media: [{ type: "reference_image", url: "/static/assets/x.png" }], size: "1024x1024" }),
    "u1"
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/server -- generations`
Expected: FAIL (enqueue input has no `media`).

- [ ] **Step 3: Implement**

In `packages/server/src/routes/conversations.ts`, inside `createGenerationRoutes`'s handler:

Widen the body type to include media:
```ts
    let body: { prompt?: string; mediaType?: "image" | "video"; settings?: Record<string, unknown>; media?: { type: string; url: string }[] };
```

After `const settings = body.settings ?? {};`, add:
```ts
    const media = Array.isArray(body.media) ? body.media : undefined;
```

Change the enqueue input to include media:
```ts
    const taskId = await service.jobQueue.enqueue(
      type,
      { prompt, conversationId, assistantMessageId, ...settings, ...(media ? { media } : {}) },
      userId
    );
```

- [ ] **Step 4: Run tests + build**

Run: `npm test -w @lot-agent/server -- generations && npm run build -w @lot-agent/server`
Expected: PASS (3 tests now); build succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/conversations.ts packages/server/src/routes/generations.test.ts
git commit -m "feat(server): generations route accepts reference-image media[]"
```

---

### Task 5: Core/server cleanup — remove the old sync providers

**Files:**
- Delete: `packages/core/src/providers/image.ts`, `packages/core/src/providers/image.test.ts`, `packages/core/src/providers/video.ts`, `packages/core/src/providers/video.test.ts`
- Modify: `packages/core/src/providers/index.ts`
- Modify: `packages/core/src/models/factory.ts`
- Modify: `packages/server/src/generation/config.ts`
- Modify: `packages/server/src/generation/config.test.ts`

**Interfaces:**
- Removes: `ImageProvider`/`VideoProvider`/`ImageGenRequest`/`ImageGenResult`/`VideoGenRequest`/`VideoGenResult`, `Mock/OpenAI Image/Video` classes, and `makeImageProvider`/`makeVideoProvider`. `placeholderSvgDataUrl` (in `placeholder.ts`) stays.

- [ ] **Step 1: Delete the old provider files and tests**

```bash
git rm packages/core/src/providers/image.ts packages/core/src/providers/image.test.ts packages/core/src/providers/video.ts packages/core/src/providers/video.test.ts
```

- [ ] **Step 2: Drop their barrel exports**

In `packages/core/src/providers/index.ts`, remove the `export * from "./image.js";` and `export * from "./video.js";` lines. Keep `generation.js`, `tts.js`, `review.js`, and ensure `placeholder.js` symbols still reach consumers — add `export * from "./placeholder.js";` if it is not already exported elsewhere (check: `grep -rn "placeholder" packages/core/src/providers/index.ts`; `generation.ts` imports it directly so the barrel does not strictly need it, but export it for external use).

- [ ] **Step 3: Fix `models/factory.ts`**

In `packages/core/src/models/factory.ts`:
- Remove the imports `import { MockImageProvider } from "../providers/image.js";` and `import { StubVideoProvider } from "../providers/video.js";` (whichever names are present).
- Remove the `if (m.type === "image") return new MockImageProvider();` and `if (m.type === "video") return new ...;` branches. The trailing `throw new Error(\`No provider factory for model type: ${m.type}\`);` now covers image/video (generation runs through the GenerationProvider pipeline, not the model registry's `getProvider`). Keep the `tts` branch and its import.

- [ ] **Step 4: Remove `makeImageProvider`/`makeVideoProvider` from server config**

In `packages/server/src/generation/config.ts`:
- Remove `MockImageProvider, OpenAIImageProvider, MockVideoProvider, OpenAIVideoProvider, type ImageProvider, type VideoProvider` from the core import (keep `HttpGenerationProvider, MockGenerationProvider, pickAdapter, type GenerationProvider`).
- Delete the `useMock` const ONLY if now unused — `makeGenerationProvider` has its own inline check, so delete `useMock`, `makeImageProvider`, and `makeVideoProvider`.

In `packages/server/src/generation/config.test.ts`:
- Delete the `describe("provider factory", ...)` block that referenced `makeImageProvider`/`makeVideoProvider` and remove those names + `MockImageProvider`/`OpenAIImageProvider`/`MockVideoProvider`/`OpenAIVideoProvider` from its imports. Keep the `makeGenerationProvider` describe block from Task 2.

- [ ] **Step 5: Confirm no stray references, then full build + full test suite**

First grep for any remaining importer of the deleted symbols:
```bash
grep -rn "StubImageProvider\|StubVideoProvider\|MockImageProvider\|MockVideoProvider\|OpenAIImageProvider\|OpenAIVideoProvider\|makeImageProvider\|makeVideoProvider\|ImageGenRequest\|VideoGenRequest\|providers/image\|providers/video" packages --include="*.ts"
```
Expected: no matches (only `generation.ts`/`MockGenerationProvider`/`HttpGenerationProvider` remain, which this grep does not match). Fix any hit before building.

Then:
Run: `npm run build && npm test`
Expected: build succeeds across all workspaces; suite green (the deleted image/video provider tests are gone; generation tests cover their replacement).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(core): remove sync image/video providers in favor of GenerationProvider"
```

---

### Task 6: Web — reference upload + progress %

**Files:**
- Modify: `packages/web/src/api/client.ts`
- Modify: `packages/web/src/hooks/useChat.ts`
- Modify: `packages/web/src/pages/Workspace.tsx`
- Modify: `packages/web/src/components/GenerationCard.tsx`

**Interfaces:**
- Consumes: `api.uploadFile` (existing, returns `UploadedAttachment` with `.url`); `api.getTask` (existing, `TaskStatus` has `progress`).
- Produces:
  - `api.generate` body adds `media?: { type: "reference_image"; url: string }[]`.
  - `GenerationView` gains `progress?: number`.
  - `useChat.generateMedia(prompt, mediaType, settings?, files?)` — uploads image files → `media`, sends, and relays poll progress.

- [ ] **Step 1: Add `media` to `api.generate`**

In `packages/web/src/api/client.ts`, in the `generate` method's body type, add `media`:
```ts
  generate: (
    conversationId: string,
    body: { prompt: string; mediaType: "image" | "video"; settings?: unknown; media?: { type: "reference_image"; url: string }[] }
  ) =>
```
(Leave the rest of the method unchanged.)

- [ ] **Step 2: Add `progress` to `GenerationView`**

In `packages/web/src/hooks/useChat.ts`, add to the `GenerationView` interface:
```ts
  progress?: number;
```

- [ ] **Step 3: Upload reference files + relay progress in `generateMedia`**

In `packages/web/src/hooks/useChat.ts`, replace the `generateMedia` callback with this version (adds the `files` param, uploads images to `media`, and patches progress on each non-terminal poll; keeps the existing cancellation token + 15-failure cap):

```ts
  const generateMedia = useCallback(
    (prompt: string, mediaType: "image" | "video", settings?: unknown, files: File[] = []) => {
      const cid = cidRef.current;
      if (!cid || !prompt.trim() || isStreaming) return;
      setIsStreaming(true);

      if (genPollRef.current) genPollRef.current.cancelled = true;
      const token = { cancelled: false };
      genPollRef.current = token;

      (async () => {
        try {
          const imgs = files.filter((f) => f.type.startsWith("image/"));
          const uploaded = imgs.length ? await Promise.all(imgs.map((f) => api.uploadFile(f))) : [];
          const media = uploaded.map((u) => ({ type: "reference_image" as const, url: u.url }));

          const res = await api.generate(cid, { prompt, mediaType, settings, media: media.length ? media : undefined });
          const userMsg: DisplayMessage = { id: res.userMessage.id, dbId: res.userMessage.id, role: "user", content: prompt };
          const genMsg: DisplayMessage = {
            id: res.assistantMessage.id,
            dbId: res.assistantMessage.id,
            role: "assistant",
            content: "",
            generation: { mediaType, status: "generating", progress: 0, taskId: res.taskId },
          };
          setMessages((prev) => [...prev, userMsg, genMsg]);

          let failures = 0;
          const poll = async () => {
            if (token.cancelled) return;
            try {
              const t = await api.getTask(res.taskId);
              failures = 0;
              if (token.cancelled) return;
              if (t.status === "succeeded" || t.status === "failed") {
                const out = t.output as { assets?: { url: string; mime: string; durationSec?: number }[] } | undefined;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === genMsg.id
                      ? { ...m, generation: { mediaType, status: t.status === "succeeded" ? "completed" : "failed", progress: 100, assets: out?.assets, error: t.error, taskId: res.taskId } }
                      : m
                  )
                );
                if (genPollRef.current === token) genPollRef.current = null;
                setIsStreaming(false);
                onStreamEndRef.current?.();
                return;
              }
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === genMsg.id && m.generation
                    ? { ...m, generation: { ...m.generation, status: "generating", progress: t.progress } }
                    : m
                )
              );
            } catch {
              failures += 1;
              if (failures >= 15) {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === genMsg.id
                      ? { ...m, generation: { mediaType, status: "failed", error: "生成状态获取失败", taskId: res.taskId } }
                      : m
                  )
                );
                if (genPollRef.current === token) genPollRef.current = null;
                setIsStreaming(false);
                onStreamEndRef.current?.();
                return;
              }
            }
            if (!token.cancelled) setTimeout(poll, 1000);
          };
          poll();
        } catch (e) {
          if (genPollRef.current === token) genPollRef.current = null;
          setIsStreaming(false);
          window.alert(`生成请求失败：${e instanceof Error ? e.message : String(e)}`);
        }
      })();
    },
    [isStreaming]
  );
```

- [ ] **Step 4: Forward files in `Workspace.doSend`**

In `packages/web/src/pages/Workspace.tsx`, in `doSend`'s `dispatch`, pass `files`:
```ts
        if (kind === "image" || kind === "video") {
          generateMedia(content, kind as "image" | "video", settings, files);
        } else {
```

- [ ] **Step 5: Show progress in `GenerationCard`**

In `packages/web/src/components/GenerationCard.tsx`, replace the loading/failed card's label so the loading state shows the percentage. Change the label block to:
```tsx
  const failed = status === "failed" || status === "completed";
  const label = failed
    ? LABELS[mediaType].fail
    : `${mediaType === "video" ? "视频" : "图片"}生成中 ${generation.progress ?? 0}%`;
  return (
    <div className={`gen-card ${mediaType} ${failed ? "gen-card--failed" : "gen-card--loading"}`} title={error ?? undefined}>
      <MediaIcon mediaType={mediaType} />
      <div className="gen-card-label">{label}</div>
    </div>
  );
```
(Keep the existing completed-with-assets early return above this; `LABELS` already holds the fail strings.)

- [ ] **Step 6: Typecheck + build**

Run: `npx tsc --noEmit -p packages/web/tsconfig.json && npm run build -w @lot-agent/web`
Expected: zero type errors; build succeeds.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/api/client.ts packages/web/src/hooks/useChat.ts packages/web/src/pages/Workspace.tsx packages/web/src/components/GenerationCard.tsx
git commit -m "feat(web): reference-image upload + live generation progress %"
```

---

## Manual verification (after all tasks)

1. `npm run build` (all workspaces) and `npm test` pass.
2. With Postgres + Redis: `npm run dev` + `npm run dev:worker -w @lot-agent/server`.
3. 图像生成: type a prompt → user bubble + "图片生成中 N%" that climbs 0→100 over ~3.5s → placeholder image; reload persists it.
4. Attach a 参考图 then generate → upload succeeds, request carries `media[]` (mock ignores it, but no error).
5. Prompt containing `fail` → "图片生成失败".
6. 视频生成: same flow, "视频生成中 N%" → poster; AI 对话 unchanged.
```
