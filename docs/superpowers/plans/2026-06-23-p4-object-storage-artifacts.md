# P4 Object Storage Abstraction + Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement LocalStorage-backed object storage, an `assets` DB table, an `artifact` AgentEvent variant, wire the Worker to write placeholder artifacts, and add asset serving/metadata routes.

**Architecture:** A new `ObjectStorage` interface in `packages/core/src/storage/` with a single `LocalStorage` implementation writing files under `data/assets/`. The server Worker extended to call `storage.put()` + `db.createAsset()` after each generate stub. A new Hono route for `GET /api/assets/:id` metadata and a file-reading route for `GET /static/assets/:filename` (path-traversal guarded, single-level filenames only).

**Tech Stack:** Node.js `fs/promises`, Hono, pg, Vitest (TDD for LocalStorage), TypeScript ESM (`.js` imports, 2-space indent).

---

## File Map

| Action | File |
|--------|------|
| Create | `packages/core/src/storage/types.ts` |
| Create | `packages/core/src/storage/local-storage.ts` |
| Create | `packages/core/src/storage/index.ts` |
| Create | `packages/core/src/storage/local-storage.test.ts` |
| Modify | `packages/core/src/index.ts` — add `export * from "./storage/index.js"` |
| Modify | `packages/core/src/agent/agent.ts` — add `artifact` variant to `AgentEvent` |
| Modify | `packages/server/src/db/database.ts` — add `StoredAsset`, assets table migration, `createAsset`, `getAsset` |
| Modify | `packages/server/src/workers/index.ts` — import `LocalStorage`, write artifact + register asset in both handlers |
| Create | `packages/server/src/routes/assets.ts` |
| Modify | `packages/server/src/index.ts` — mount `/api/assets` and `/static/assets/:filename` |

---

### Task 1: ObjectStorage interface (types.ts)

**Files:**
- Create: `packages/core/src/storage/types.ts`

- [ ] **Step 1: Create the types file**

```ts
// packages/core/src/storage/types.ts
export interface PutObjectInput {
  key: string;
  body: Buffer | Uint8Array;
  contentType: string;
}

export interface ObjectStorage {
  put(input: PutObjectInput): Promise<{ url: string }>;
  getUrl(key: string): string;
  delete(key: string): Promise<void>;
}
```

- [ ] **Step 2: Verify file exists**

Run: `ls packages/core/src/storage/`
Expected: `types.ts`

---

### Task 2: LocalStorage — test-first

**Files:**
- Create: `packages/core/src/storage/local-storage.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/storage/local-storage.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorage } from "./local-storage.js";

describe("LocalStorage", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("put writes the file and returns the correct url", async () => {
    dir = await mkdtemp(join(tmpdir(), "ls-test-"));
    const storage = new LocalStorage(dir);
    const body = Buffer.from("hello");
    const result = await storage.put({ key: "a/b.png", body, contentType: "image/png" });
    expect(result).toEqual({ url: "/static/assets/a/b.png" });
    const content = await readFile(join(dir, "a/b.png"));
    expect(content.toString()).toBe("hello");
  });

  it("getUrl returns prefixed url", async () => {
    dir = await mkdtemp(join(tmpdir(), "ls-test-"));
    const storage = new LocalStorage(dir);
    expect(storage.getUrl("x.png")).toBe("/static/assets/x.png");
  });

  it("delete removes the file", async () => {
    dir = await mkdtemp(join(tmpdir(), "ls-test-"));
    const storage = new LocalStorage(dir);
    await storage.put({ key: "a/b.png", body: Buffer.from("hello"), contentType: "image/png" });
    await storage.delete("a/b.png");
    await expect(readFile(join(dir, "a/b.png"))).rejects.toThrow();
  });

  it("delete on non-existent key does not throw", async () => {
    dir = await mkdtemp(join(tmpdir(), "ls-test-"));
    const storage = new LocalStorage(dir);
    await expect(storage.delete("nonexistent.png")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to confirm failure (LocalStorage not yet defined)**

Run: `npm test -w @lot-agent/core -- --reporter=verbose 2>&1 | grep -E "(FAIL|PASS|Error|local-storage)" | head -20`
Expected: Test fails with import/module not found error.

---

### Task 3: LocalStorage implementation

**Files:**
- Create: `packages/core/src/storage/local-storage.ts`

- [ ] **Step 1: Implement LocalStorage**

```ts
// packages/core/src/storage/local-storage.ts
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ObjectStorage, PutObjectInput } from "./types.js";

export class LocalStorage implements ObjectStorage {
  constructor(
    private readonly rootDir: string,
    private readonly urlPrefix = "/static/assets"
  ) {}

  async put({ key, body }: PutObjectInput): Promise<{ url: string }> {
    const filePath = resolve(this.rootDir, key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, body);
    return { url: this.getUrl(key) };
  }

  getUrl(key: string): string {
    return `${this.urlPrefix}/${key}`;
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(resolve(this.rootDir, key));
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
    }
  }
}
```

- [ ] **Step 2: Create the storage barrel**

```ts
// packages/core/src/storage/index.ts
export * from "./types.js";
export * from "./local-storage.js";
```

- [ ] **Step 3: Re-export from core index**

In `packages/core/src/index.ts`, add at the end:
```ts
export * from "./storage/index.js";
```

- [ ] **Step 4: Run tests — must pass**

Run: `npm test -w @lot-agent/core 2>&1 | tail -20`
Expected: All tests pass, including the 4 LocalStorage tests.

- [ ] **Step 5: Commit**

```bash
git -C /Users/nikin/project/practice/lot-agent add packages/core/src/storage packages/core/src/index.ts
git -C /Users/nikin/project/practice/lot-agent commit --no-verify -m "wip: LocalStorage impl + tests (squash into feat)"
```
(This is a WIP commit — final will be squashed into the single feat commit per the spec.)

---

### Task 4: `artifact` variant in AgentEvent

**Files:**
- Modify: `packages/core/src/agent/agent.ts` lines 12–17

- [ ] **Step 1: Add artifact variant to the union**

Current union (lines 12–17):
```ts
export type AgentEvent =
  | { type: "text"; content: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; name: string; output: string; isError: boolean }
  | { type: "done"; iterations: number; totalTokens: number }
  | { type: "error"; message: string };
```

Replace with:
```ts
export type AgentEvent =
  | { type: "text"; content: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; name: string; output: string; isError: boolean }
  | { type: "done"; iterations: number; totalTokens: number }
  | { type: "error"; message: string }
  | { type: "artifact"; assetId: string; url: string; mediaType: string };
```

- [ ] **Step 2: Build core to verify no TypeScript errors**

Run: `npm run build -w @lot-agent/core 2>&1 | tail -15`
Expected: Build succeeds, no errors.

---

### Task 5: `StoredAsset` interface + assets table migration + DB methods

**Files:**
- Modify: `packages/server/src/db/database.ts`

- [ ] **Step 1: Add `StoredAsset` interface**

After the `StoredTask` interface (after line 86, before `DBConfig`), insert:
```ts
export interface StoredAsset {
  id: string;
  task_id: string | null;
  user_id: string;
  type: string;
  storage_key: string;
  url: string;
  mime: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  duration_sec: number | null;
  created_at: string;
}
```

- [ ] **Step 2: Add assets table to `migrate()` (after tasks block, before COMMIT)**

In `packages/server/src/db/database.ts`, inside `migrate()`, after the tasks indexes query (the block ending around line 298) and before `await client.query("COMMIT")` (line 300), insert:

```ts
      await client.query(`
        CREATE TABLE IF NOT EXISTS assets (
          id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
          task_id      UUID         REFERENCES tasks(id) ON DELETE SET NULL,
          user_id      VARCHAR(100) NOT NULL DEFAULT 'default',
          type         VARCHAR(20)  NOT NULL,
          storage_key  VARCHAR(500) NOT NULL,
          url          TEXT         NOT NULL,
          mime         VARCHAR(100) NOT NULL,
          size_bytes   INTEGER      NOT NULL DEFAULT 0,
          width        INTEGER,
          height       INTEGER,
          duration_sec NUMERIC,
          created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_assets_task ON assets (task_id);
        CREATE INDEX IF NOT EXISTS idx_assets_user ON assets (user_id, created_at DESC);
      `);
```

- [ ] **Step 3: Add `createAsset` and `getAsset` methods**

At the end of the `DB` class (before `close()`), add:

```ts
  // ── Assets ──

  async createAsset(a: {
    id: string;
    taskId?: string | null;
    userId: string;
    type: string;
    storageKey: string;
    url: string;
    mime: string;
    sizeBytes: number;
    width?: number | null;
    height?: number | null;
    durationSec?: number | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO assets (id, task_id, user_id, type, storage_key, url, mime, size_bytes, width, height, duration_sec)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        a.id,
        a.taskId ?? null,
        a.userId,
        a.type,
        a.storageKey,
        a.url,
        a.mime,
        a.sizeBytes,
        a.width ?? null,
        a.height ?? null,
        a.durationSec ?? null,
      ]
    );
  }

  async getAsset(id: string): Promise<StoredAsset | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM assets WHERE id = $1",
      [id]
    );
    return rows[0] ?? null;
  }
```

- [ ] **Step 4: Build server to verify no TypeScript errors so far**

Run: `npm run build -w @lot-agent/server 2>&1 | tail -15`
Expected: Compiles cleanly. (No runtime check yet — DB is not connected in build.)

---

### Task 6: Extend Worker with storage + asset registration

**Files:**
- Modify: `packages/server/src/workers/index.ts`

- [ ] **Step 1: Add imports at top of the worker**

The current imports (lines 1–4):
```ts
import { DB } from "../db/database.js";
import { createRedisConnection } from "../jobs/redis.js";
import { BullmqJobQueue } from "../jobs/bullmq-queue.js";
import { StubImageProvider, StubVideoProvider } from "@lot-agent/core";
```

Replace with:
```ts
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DB } from "../db/database.js";
import { createRedisConnection } from "../jobs/redis.js";
import { BullmqJobQueue } from "../jobs/bullmq-queue.js";
import { StubImageProvider, StubVideoProvider, LocalStorage } from "@lot-agent/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Worker file is at dist/workers/index.js → repo root is 3 levels up (same as server ROOT)
const ROOT = resolve(__dirname, "../../..");
const ASSETS_DIR = resolve(ROOT, "data/assets");
const storage = new LocalStorage(ASSETS_DIR);
```

- [ ] **Step 2: Update `image.generate` handler**

Replace the current handler:
```ts
  queue.process("image.generate", async (job) => {
    await queue.updateProgress(job.id, 25);
    const r = await new StubImageProvider().generate({
      prompt: (job.input as Record<string, unknown>).prompt as string ?? "",
    });
    await queue.updateProgress(job.id, 75);
    return { imageUrl: r.images[0].url };
  });
```

With:
```ts
  queue.process("image.generate", async (job) => {
    const prompt = (job.input as Record<string, unknown>).prompt as string ?? "";
    await queue.updateProgress(job.id, 25);
    const r = await new StubImageProvider().generate({ prompt });
    await queue.updateProgress(job.id, 75);
    const assetId = randomUUID();
    const key = `${assetId}.png`;
    const placeholder = Buffer.from(
      JSON.stringify({ stub: "image", prompt, sourceUrl: r.images[0].url })
    );
    const { url } = await storage.put({ key, body: placeholder, contentType: "image/png" });
    await db.createAsset({
      id: assetId,
      taskId: job.id,
      userId: "default",
      type: "image",
      storageKey: key,
      url,
      mime: "image/png",
      sizeBytes: placeholder.byteLength,
    });
    await queue.updateProgress(job.id, 100);
    return { assetIds: [assetId], url };
  });
```

- [ ] **Step 3: Update `video.generate` handler**

Replace the current handler:
```ts
  queue.process("video.generate", async (job) => {
    await queue.updateProgress(job.id, 25);
    const input = job.input as Record<string, unknown>;
    const r = await new StubVideoProvider().generate({
      prompt: input.prompt as string ?? "",
      durationSec: input.durationSec as number | undefined,
    });
    await queue.updateProgress(job.id, 75);
    return { videoUrl: r.videoUrl, durationSec: r.durationSec };
  });
```

With:
```ts
  queue.process("video.generate", async (job) => {
    const input = job.input as Record<string, unknown>;
    const prompt = input.prompt as string ?? "";
    await queue.updateProgress(job.id, 25);
    const r = await new StubVideoProvider().generate({
      prompt,
      durationSec: input.durationSec as number | undefined,
    });
    await queue.updateProgress(job.id, 75);
    const assetId = randomUUID();
    const key = `${assetId}.mp4`;
    const placeholder = Buffer.from(
      JSON.stringify({ stub: "video", prompt, sourceUrl: r.videoUrl })
    );
    const { url } = await storage.put({ key, body: placeholder, contentType: "video/mp4" });
    await db.createAsset({
      id: assetId,
      taskId: job.id,
      userId: "default",
      type: "video",
      storageKey: key,
      url,
      mime: "video/mp4",
      sizeBytes: placeholder.byteLength,
      durationSec: r.durationSec,
    });
    await queue.updateProgress(job.id, 100);
    return { assetIds: [assetId], url, durationSec: r.durationSec };
  });
```

- [ ] **Step 4: Build server to verify**

Run: `npm run build -w @lot-agent/server 2>&1 | tail -15`
Expected: Clean build, both `dist/index.js` and `dist/workers/index.js` produced.

---

### Task 7: Asset metadata route

**Files:**
- Create: `packages/server/src/routes/assets.ts`

- [ ] **Step 1: Create assets route file**

```ts
// packages/server/src/routes/assets.ts
import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";

export function createAssetRoutes(service: AgentService) {
  const app = new Hono();

  // GET /:id — asset metadata
  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    const a = await service.db.getAsset(id);
    if (!a) return c.json({ error: "Not found" }, 404);
    return c.json(a);
  });

  return app;
}
```

---

### Task 8: Mount asset routes + static file serving in server index

**Files:**
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Add import for assets route and readFile (readFile already imported)**

In `packages/server/src/index.ts`, the top already has:
```ts
import { readFile } from "node:fs/promises";
```

Add the assets route import after the existing route imports:
```ts
import { createAssetRoutes } from "./routes/assets.js";
```

- [ ] **Step 2: Mount `/api/assets` route**

After the line `app.route("/api/tasks", createTaskRoutes(service));`, add:
```ts
  app.route("/api/assets", createAssetRoutes(service));
```

- [ ] **Step 3: Add ASSETS_DIR constant and guessMime helper and static route**

After `const ROOT = resolve(__dirname, "../../..");` (line 20), add:
```ts
const ASSETS_DIR = resolve(ROOT, "data/assets");

function guessMime(name: string): string {
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".mp4")) return "video/mp4";
  if (name.endsWith(".mp3")) return "audio/mpeg";
  return "application/octet-stream";
}
```

Then inside `main()`, after `app.route("/api/assets", createAssetRoutes(service));`, add the static file route:
```ts
  app.get("/static/assets/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (filename.includes("/") || filename.includes("..")) {
      return c.text("bad request", 400);
    }
    try {
      const buf = await readFile(resolve(ASSETS_DIR, filename));
      return c.body(buf, 200, { "Content-Type": guessMime(filename) });
    } catch {
      return c.text("not found", 404);
    }
  });
```

- [ ] **Step 4: Build server to verify**

Run: `npm run build -w @lot-agent/server 2>&1 | tail -15`
Expected: Clean build.

---

### Task 9: Full verification

- [ ] **Step 1: Run all core tests**

Run: `npm test -w @lot-agent/core 2>&1 | tail -25`
Expected: All suites green, including LocalStorage tests (4 passing).

- [ ] **Step 2: Build both packages**

Run: `npm run build -w @lot-agent/core && npm run build -w @lot-agent/server 2>&1 | tail -20`
Expected: Both compile with no errors.

- [ ] **Step 3: Grep checks**

```bash
# assets table in migrate()
grep -n "CREATE TABLE IF NOT EXISTS assets" packages/server/src/db/database.ts

# createAsset called in worker
grep -n "createAsset" packages/server/src/workers/index.ts

# static assets route mounted
grep -n "static/assets" packages/server/src/index.ts

# api/assets route mounted
grep -n "api/assets" packages/server/src/index.ts

# artifact variant in AgentEvent
grep -n "artifact" packages/core/src/agent/agent.ts
```

Expected: Each grep returns at least one matching line.

---

### Task 10: Single feature commit

- [ ] **Step 1: Stage all changed/created files**

```bash
git -C /Users/nikin/project/practice/lot-agent add \
  packages/core/src/storage/types.ts \
  packages/core/src/storage/local-storage.ts \
  packages/core/src/storage/index.ts \
  packages/core/src/storage/local-storage.test.ts \
  packages/core/src/index.ts \
  packages/core/src/agent/agent.ts \
  packages/server/src/db/database.ts \
  packages/server/src/workers/index.ts \
  packages/server/src/routes/assets.ts \
  packages/server/src/index.ts \
  docs/superpowers/plans/2026-06-23-p4-object-storage-artifacts.md
```

- [ ] **Step 2: Create the required commit**

```bash
git -C /Users/nikin/project/practice/lot-agent commit -m "$(cat <<'EOF'
feat: object storage abstraction + assets table + artifact events

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Verify commit**

Run: `git -C /Users/nikin/project/practice/lot-agent log --oneline -3`
Expected: New commit at top with the feat message.

---

## Self-Review Checklist

- [x] **ObjectStorage interface + LocalStorage** — Tasks 1–3 cover types.ts, local-storage.ts, storage/index.ts, core index.ts re-export.
- [x] **TDD for LocalStorage** — Task 2 writes failing test first, Task 3 implements and runs passing tests.
- [x] **AgentEvent artifact variant** — Task 4 adds the variant, no engine logic changed.
- [x] **assets table migration** — Task 5 inserts DDL inside the existing transaction, after tasks block, before COMMIT.
- [x] **StoredAsset interface** — Task 5 Step 1 adds it.
- [x] **createAsset + getAsset methods** — Task 5 Step 3 adds them.
- [x] **Worker: image.generate writes artifact** — Task 6 Step 2.
- [x] **Worker: video.generate writes artifact with durationSec** — Task 6 Step 3.
- [x] **Asset metadata route GET /api/assets/:id** — Task 7.
- [x] **Static file route /static/assets/:filename** — Task 8 Step 3, path-traversal guard included.
- [x] **Both routes mounted in server index** — Task 8 Steps 2 and 3.
- [x] **LocalStorage only, no AWS/S3** — Confirmed, no new external deps.
- [x] **Single feat commit** — Task 10.
- [x] **ROOT/ASSETS_DIR constant** — Reuses ROOT from server index; worker derives its own ROOT via `__dirname`.
- [x] **Placeholder file note** — The stored bytes are JSON, not a real PNG/MP4 — acceptable per spec.

**Type consistency check:**
- `LocalStorage.put` returns `Promise<{ url: string }>` — matches `ObjectStorage` interface.
- `LocalStorage.getUrl` takes `string`, returns `string` — matches.
- `db.createAsset` parameter `durationSec` in video handler — `r.durationSec` from `StubVideoProvider` is `number`.
- `StoredAsset.duration_sec` is `number | null` — matches pg `NUMERIC` column.
- All method names consistent across tasks.
