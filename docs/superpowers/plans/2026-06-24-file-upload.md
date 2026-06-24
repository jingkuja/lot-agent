# 文件上传（图片 + 文档）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在聊天输入框增加上传文件按钮，支持图片与文档随消息上传；后端图片走多模态、文档解析文本注入 prompt，附件持久化并支持多轮重见。

**Architecture:** 上传分两步——先 `POST /api/uploads` 落盘到独立的 `data/uploads`（服务于 `/static/uploads`）并写 `assets` 行，再带 `assetId` 发消息。`AgentService` 把图片读成 base64 data URL 转 `ContentPart{image}`、文档经 `attachment-extractor` 解析成 `ContentPart{text}` 注入首个 user message。附件元数据存 `messages.metadata.attachments`，`loadHistory` 每轮重新 materialize。

**Tech Stack:** TypeScript ESM monorepo（npm workspaces）、Hono、pg、React 19/Vite、Vitest。新增依赖 `pdf-parse`、`mammoth`（@lot-agent/server）。

## Global Constraints

- ESM imports 必须带显式 `.js` 后缀；2-space 缩进。
- 接口在 core、实现在 server；core 不得引入 pg/ioredis/HTTP。
- 测试用 Vitest，colocated 为 `*.test.ts`；新逻辑单元走 TDD。
- 不改 `assets` / `messages` 表结构（复用 `assets.type`、可空 `task_id`、`messages.metadata`）。
- Web 颜色一律用 `var(--*)`，禁止硬编码 hex/rgba。
- 上限：每条消息 ≤ 5 文件；图片 ≤ 10MB、文档 ≤ 20MB；单文档解析文本截断 ~30000 字符。
- 类型白名单（mime）：
  - 图片：`image/jpeg`、`image/png`、`image/webp`、`image/gif`
  - 文档：`text/plain`、`text/markdown`、`text/csv`、`application/json`、`application/pdf`、`application/vnd.openxmlformats-officedocument.wordprocessingml.document`(docx)
  - 兜底：以 `text/` 开头的 mime 一律按纯文本处理。

## 共享类型（贯穿前后端）

```ts
// 上传响应 & 发送消息时携带的附件引用 & 存进 metadata 的形态，三者同构
interface AttachmentRef {
  assetId: string;
  filename: string;
  mime: string;
  size: number;
  url: string;                 // 形如 /static/uploads/<uuid>.<ext>，浏览器展示用
  kind: "image" | "doc";
}
```

`kind` 由 mime 判定：白名单图片 mime → `"image"`，否则 `"doc"`。

---

## File Structure

- `packages/core/src/storage/types.ts` — `ObjectStorage` 增加 `get(key)`
- `packages/core/src/storage/local-storage.ts` — 实现 `get`
- `packages/core/src/agent/agent.ts` — `run` 入参放宽为 `string | ContentPart[]`
- `packages/core/src/llm/openai.ts` — 导出 `toOpenAIMessage`（已支持 image_url，无需改逻辑）
- `packages/core/src/llm/anthropic.ts` — 导出 `toAnthropicMessage` 并新增 image block 映射
- `packages/server/src/services/attachment-extractor.ts` — **新增**，按 mime 解析为 `ContentPart`
- `packages/server/src/routes/uploads.ts` — **新增**，multipart 接收 + 校验 + 落盘 + 写 assets
- `packages/server/src/services/agent-service.ts` — `uploadStorage` 字段 + `streamAgentResponse` 接收 attachments
- `packages/server/src/services/message-repository.ts` — `saveUserMessage` 存 metadata + `loadHistory` 重 materialize
- `packages/server/src/routes/conversations.ts` — `/messages` body 接收 attachments
- `packages/server/src/index.ts` — 注册 uploads 路由 + `/static/uploads/:filename` 静态路由
- `packages/web/src/api/client.ts` — `uploadFile`、类型、`sendMessage` 带 attachments
- `packages/web/src/components/InputBox.tsx` — `+` 按钮 + chip 行
- `packages/web/src/hooks/useChat.ts` — 上传后发送 + DisplayMessage.attachments
- `packages/web/src/components/MessageBubble.tsx` — user 气泡渲染 chip
- `packages/web/src/App.css` — `+` 按钮与 chip 样式

---

## Task 1: Core 存储 `get()` + Agent.run 入参放宽

**Files:**
- Modify: `packages/core/src/storage/types.ts`
- Modify: `packages/core/src/storage/local-storage.ts`
- Modify: `packages/core/src/agent/agent.ts:66-70`
- Test: `packages/core/src/storage/local-storage.test.ts`

**Interfaces:**
- Produces: `ObjectStorage.get(key: string): Promise<Buffer>`；`Agent.run(userMessage: string | ContentPart[], context, history?)`

- [ ] **Step 1: 写失败测试** — 在 `local-storage.test.ts` 末尾追加：

```ts
it("get() reads back what put() wrote", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lot-store-"));
  const store = new LocalStorage(dir, "/static/x");
  await store.put({ key: "a.txt", body: Buffer.from("hello"), contentType: "text/plain" });
  const buf = await store.get("a.txt");
  expect(buf.toString("utf8")).toBe("hello");
});
```

确保该文件顶部已 import（若缺则补）：`import { mkdtemp } from "node:fs/promises";` `import { tmpdir } from "node:os";` `import { join } from "node:path";`

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w @lot-agent/core -- local-storage`
Expected: FAIL — `store.get is not a function`

- [ ] **Step 3: types.ts 增加 get**

在 `ObjectStorage` 接口内（`delete` 上方）加：

```ts
  get(key: string): Promise<Buffer>;
```

- [ ] **Step 4: local-storage.ts 实现 get**

顶部 import 改为：`import { mkdir, writeFile, unlink, readFile } from "node:fs/promises";`
在 `getUrl` 与 `delete` 之间加：

```ts
  async get(key: string): Promise<Buffer> {
    return readFile(resolve(this.rootDir, key));
  }
```

- [ ] **Step 5: 放宽 Agent.run 入参**

`agent.ts` 第 66-70 行签名改为：

```ts
  async *run(
    userMessage: string | ContentPart[],
    context: AgentContext,
    history: Message[] = []
  ): AsyncIterable<AgentEvent> {
```

确保 `agent.ts` 顶部 `import` 自 `../types/index.js` 含 `ContentPart`（若 import 列表里没有则加上）。第 135 行 `{ role: "user", content: userMessage }` 无需改动——`Message.content` 已是 `string | ContentPart[]`，`ContextManager.assemble` 已处理两种形态。

- [ ] **Step 6: 跑测试 + 全量编译**

Run: `npm test -w @lot-agent/core -- local-storage` → PASS
Run: `npm run build -w @lot-agent/core`
Expected: 编译通过

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/storage packages/core/src/agent/agent.ts
git commit -m "feat(core): ObjectStorage.get + Agent.run 接受 ContentPart[]"
```

---

## Task 2: 两个 LLM provider 支持图片 ContentPart

OpenAI 已把非 text part 映射成 `image_url`（取 `p.image.url`），传入 base64 data URL 即可，无需改逻辑——仅导出函数以便测试。Anthropic 当前**丢弃**图片 part，需新增 base64 image block 映射。

**Files:**
- Modify: `packages/core/src/llm/openai.ts:102`
- Modify: `packages/core/src/llm/anthropic.ts:135-144`
- Test: `packages/core/src/llm/message-mapping.test.ts` (Create)

**Interfaces:**
- Produces: `export function toOpenAIMessage(...)`、`export function toAnthropicMessage(...)`（供测试与复用）

- [ ] **Step 1: 写失败测试** — 新建 `packages/core/src/llm/message-mapping.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { toOpenAIMessage } from "./openai.js";
import { toAnthropicMessage } from "./anthropic.js";
import type { Message } from "../types/index.js";

const imgUrl = "data:image/png;base64,iVBORw0KGgo=";
const msg: Message = {
  role: "user",
  content: [
    { type: "text", text: "看这张图" },
    { type: "image", image: { url: imgUrl, mediaType: "image/png" } },
  ],
};

describe("toOpenAIMessage", () => {
  it("maps image part to image_url", () => {
    const out = toOpenAIMessage(msg) as { content: any[] };
    expect(out.content).toContainEqual({ type: "image_url", image_url: { url: imgUrl } });
  });
});

describe("toAnthropicMessage", () => {
  it("maps data-url image part to base64 image block", () => {
    const out = toAnthropicMessage(msg) as { content: any[] };
    expect(out.content).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w @lot-agent/core -- message-mapping`
Expected: FAIL — `toOpenAIMessage` 非导出（import 报错）/ anthropic 无 image block

- [ ] **Step 3: 导出 openai 映射函数**

`openai.ts:102` `function toOpenAIMessage(` 改为 `export function toOpenAIMessage(`。逻辑不变。

- [ ] **Step 4: anthropic 导出 + image block 映射**

`anthropic.ts:135` `function toAnthropicMessage(` 改为 `export function toAnthropicMessage(`。
把第 136-144 的 user 分支替换为（解析 data URL，文本块与图片块混合）：

```ts
  if (msg.role === "user") {
    if (typeof msg.content === "string") {
      return { role: "user", content: msg.content };
    }
    const content = msg.content.map((p) => {
      if (p.type === "image" && p.image) {
        const m = /^data:([^;]+);base64,(.*)$/.exec(p.image.url);
        if (m) {
          return {
            type: "image" as const,
            source: { type: "base64" as const, media_type: m[1], data: m[2] },
          };
        }
        // 非 data URL（兜底）：当作文本提示，避免直接丢弃
        return { type: "text" as const, text: `[图片: ${p.image.url}]` };
      }
      return { type: "text" as const, text: p.text ?? "" };
    });
    return { role: "user", content: content as MessageParam["content"] };
  }
```

若 TS 对 `media_type` 字面量报错，把 `m[1]` 断言为 `as any` 不可取——改用现有 SDK 的 `ImageBlockParam` 类型导入（`anthropic.ts` 顶部已从 `@anthropic-ai/sdk/resources/messages` 导入类型，按需补 `ImageBlockParam`）。

- [ ] **Step 5: 跑测试 + 编译**

Run: `npm test -w @lot-agent/core -- message-mapping` → PASS
Run: `npm run build -w @lot-agent/core` → 通过

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/llm
git commit -m "feat(core): LLM provider 支持图片 ContentPart（OpenAI image_url / Anthropic base64 block）"
```

---

## Task 3: 文档解析 attachment-extractor

**Files:**
- Create: `packages/server/src/services/attachment-extractor.ts`
- Test: `packages/server/src/services/attachment-extractor.test.ts`
- Modify: `packages/server/package.json`（加 `pdf-parse`、`mammoth`、`@types/pdf-parse`）

**Interfaces:**
- Consumes: `ObjectStorage.get`（Task 1）；`AttachmentRef`（本计划共享类型）
- Produces:
  ```ts
  const MAX_DOC_CHARS = 30000;
  function attachmentKind(mime: string): "image" | "doc";
  async function extractAttachment(att: AttachmentRef, storage: ObjectStorage): Promise<ContentPart>;
  ```

- [ ] **Step 1: 装依赖**

```bash
npm install pdf-parse mammoth -w @lot-agent/server
npm install -D @types/pdf-parse -w @lot-agent/server
```

- [ ] **Step 2: 写失败测试** — 新建 `attachment-extractor.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { extractAttachment, attachmentKind, MAX_DOC_CHARS } from "./attachment-extractor.js";
import type { ObjectStorage } from "@lot-agent/core";
import type { AttachmentRef } from "./attachment-extractor.js";

function fakeStorage(bytes: Buffer): ObjectStorage {
  return {
    put: async () => ({ url: "" }),
    getUrl: () => "",
    delete: async () => {},
    get: async () => bytes,
  };
}
const base: AttachmentRef = { assetId: "a", filename: "f", mime: "", size: 0, url: "/static/uploads/x", kind: "doc" };

describe("attachmentKind", () => {
  it("classifies images vs docs", () => {
    expect(attachmentKind("image/png")).toBe("image");
    expect(attachmentKind("application/pdf")).toBe("doc");
    expect(attachmentKind("text/plain")).toBe("doc");
  });
});

describe("extractAttachment", () => {
  it("reads plain text and wraps with filename", async () => {
    const s = fakeStorage(Buffer.from("hello world"));
    const part = await extractAttachment({ ...base, filename: "note.txt", mime: "text/plain" }, s);
    expect(part).toEqual({ type: "text", text: "[附件: note.txt]\nhello world\n[/附件: note.txt]" });
  });

  it("makes a base64 data-url image part", async () => {
    const s = fakeStorage(Buffer.from([1, 2, 3]));
    const part = await extractAttachment({ ...base, filename: "p.png", mime: "image/png", kind: "image" }, s);
    expect(part).toEqual({ type: "image", image: { url: "data:image/png;base64,AQID", mediaType: "image/png" } });
  });

  it("truncates over-long documents", async () => {
    const s = fakeStorage(Buffer.from("x".repeat(MAX_DOC_CHARS + 100)));
    const part = await extractAttachment({ ...base, filename: "big.txt", mime: "text/plain" }, s);
    expect(part.type).toBe("text");
    expect((part.text as string).includes("[内容过长已截断]")).toBe(true);
  });

  it("degrades gracefully on unsupported type", async () => {
    const s = fakeStorage(Buffer.from("zzz"));
    const part = await extractAttachment({ ...base, filename: "a.bin", mime: "application/octet-stream" }, s);
    expect(part).toEqual({ type: "text", text: "[附件 a.bin 无法解析，已忽略内容]" });
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test -w @lot-agent/server -- attachment-extractor`
Expected: FAIL — 模块不存在

- [ ] **Step 4: 实现 extractor**

新建 `packages/server/src/services/attachment-extractor.ts`：

```ts
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import type { ContentPart, ObjectStorage } from "@lot-agent/core";

export const MAX_DOC_CHARS = 30000;

export interface AttachmentRef {
  assetId: string;
  filename: string;
  mime: string;
  size: number;
  url: string;
  kind: "image" | "doc";
}

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export function attachmentKind(mime: string): "image" | "doc" {
  return IMAGE_MIMES.has(mime) ? "image" : "doc";
}

/** 把附件转成发给模型的 ContentPart；图片→base64 data URL，文档→解析文本，失败降级。 */
export async function extractAttachment(
  att: AttachmentRef,
  storage: ObjectStorage
): Promise<ContentPart> {
  // storage key = url 去掉静态前缀（/static/uploads/）
  const key = att.url.replace(/^\/static\/uploads\//, "");
  const bytes = await storage.get(key);

  if (attachmentKind(att.mime) === "image") {
    const b64 = bytes.toString("base64");
    return { type: "image", image: { url: `data:${att.mime};base64,${b64}`, mediaType: att.mime } };
  }

  let text: string | null = null;
  try {
    if (att.mime === "application/pdf") {
      text = (await pdfParse(bytes)).text;
    } else if (
      att.mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      text = (await mammoth.extractRawText({ buffer: bytes })).value;
    } else if (
      att.mime.startsWith("text/") ||
      att.mime === "application/json"
    ) {
      text = bytes.toString("utf8");
    }
  } catch {
    text = null;
  }

  if (text == null) {
    return { type: "text", text: `[附件 ${att.filename} 无法解析，已忽略内容]` };
  }

  let body = text;
  if (body.length > MAX_DOC_CHARS) {
    body = body.slice(0, MAX_DOC_CHARS) + "\n…[内容过长已截断]";
  }
  return { type: "text", text: `[附件: ${att.filename}]\n${body}\n[/附件: ${att.filename}]` };
}
```

确认 `@lot-agent/core` 已导出 `ObjectStorage` 与 `ContentPart`（core 的 `index.ts` 应 re-export；若缺，在 core 的入口补 `export type { ContentPart } from "./types/index.js";` 与 storage 类型导出，并 `npm run build -w @lot-agent/core`）。

- [ ] **Step 5: 跑测试**

Run: `npm test -w @lot-agent/server -- attachment-extractor` → PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/package.json package-lock.json packages/server/src/services/attachment-extractor.ts packages/server/src/services/attachment-extractor.test.ts
git commit -m "feat(server): attachment-extractor 解析文档/图片为 ContentPart"
```

---

## Task 4: 上传路由 + 独立存储 + 静态服务

**Files:**
- Modify: `packages/server/src/services/agent-service.ts`（加 `uploadStorage` 公共字段）
- Create: `packages/server/src/routes/uploads.ts`
- Modify: `packages/server/src/index.ts`（authMw + 注册路由 + 静态路由）
- Test: `packages/server/src/routes/uploads.test.ts`

**Interfaces:**
- Consumes: `service.uploadStorage`、`service.db.createAsset`、`AttachmentRef`、`attachmentKind`
- Produces: `POST /api/uploads`（multipart，字段名 `file`）→ `200 { assetId, filename, mime, size, url, kind }`；非法 → `400 { error }`。`service.uploadStorage: ObjectStorage`

- [ ] **Step 1: AgentService 暴露 uploadStorage**

在 `agent-service.ts` 第 152-161 附近（`createDocTool` 之后）加：

```ts
    // 用户上传文件的独立存储，服务于 /static/uploads（与 data/assets 生成物分开）
    this.uploadStorage = new LocalStorage(resolve(root, "data/uploads"), "/static/uploads");
```

并在类字段声明区（与 `db` 等同级）加：`uploadStorage!: LocalStorage;`（`LocalStorage` 已 import）。

- [ ] **Step 2: 写失败测试** — 新建 `uploads.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
import { createUploadRoutes } from "./uploads.js";

function makeService() {
  const created: any[] = [];
  return {
    created,
    uploadStorage: { put: vi.fn(async () => ({ url: "" })), getUrl: (k: string) => `/static/uploads/${k}`, get: vi.fn(), delete: vi.fn() },
    db: { createAsset: vi.fn(async (a: any) => { created.push(a); }) },
  } as any;
}

function appFor(service: any) {
  const app = createUploadRoutes(service);
  // inject userId like authMw does
  app.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
  return app;
}

function fileBody(name: string, type: string, bytes: Uint8Array) {
  const fd = new FormData();
  fd.append("file", new File([bytes], name, { type }));
  return fd;
}

describe("POST /uploads", () => {
  it("rejects disallowed mime", async () => {
    const service = makeService();
    const app = createUploadRoutes(service);
    app.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
    const res = await app.request("/", { method: "POST", body: fileBody("a.exe", "application/x-msdownload", new Uint8Array([1])) });
    expect(res.status).toBe(400);
  });

  it("stores allowed file and returns ref", async () => {
    const service = makeService();
    const app = createUploadRoutes(service);
    app.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
    const res = await app.request("/", { method: "POST", body: fileBody("note.txt", "text/plain", new Uint8Array([104, 105])) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ filename: "note.txt", mime: "text/plain", size: 2, kind: "doc" });
    expect(json.assetId).toBeTruthy();
    expect(service.created.length).toBe(1);
  });
});
```

> 注意：测试里 `app.use` 必须在 `createUploadRoutes` 内的路由注册**之前**生效。若 Hono 子应用中后注册的中间件不覆盖已注册路由，改为在 `createUploadRoutes(service, { userIdForTest: "u1" })` 不优雅——更简单：让 `createUploadRoutes` 返回的 app 第一个 middleware 读 `c.get("userId")`，测试通过 `app.request("/", { headers: ... })` 配合一个最小 stub middleware。实现见下：测试用 `new Hono()` 包一层注入 userId 再 `.route("/", uploadApp)`。

为可靠注入，改用如下 helper（替换上面两处构造）：

```ts
import { Hono } from "hono";
function appFor(service: any) {
  const wrap = new Hono();
  wrap.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
  wrap.route("/", createUploadRoutes(service));
  return wrap;
}
```
并把两个用例里的 `app` 换成 `appFor(service)`，请求路径用 `"/"`。

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test -w @lot-agent/server -- uploads`
Expected: FAIL — 模块不存在

- [ ] **Step 4: 实现 uploads 路由**

新建 `packages/server/src/routes/uploads.ts`：

```ts
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import type { AgentService } from "../services/agent-service.js";
import { attachmentKind } from "../services/attachment-extractor.js";

type Variables = { userId: string };

const ALLOWED = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "text/plain", "text/markdown", "text/csv", "application/json",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_DOC = 20 * 1024 * 1024;

export function createUploadRoutes(service: AgentService) {
  const app = new Hono<{ Variables: Variables }>();

  app.post("/", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.parseBody();
    const file = body["file"];
    if (!(file instanceof File)) {
      return c.json({ error: "file is required" }, 400);
    }
    const mime = file.type || "application/octet-stream";
    const isAllowed = ALLOWED.has(mime) || mime.startsWith("text/");
    if (!isAllowed) {
      return c.json({ error: `unsupported type: ${mime}` }, 400);
    }
    const kind = attachmentKind(mime);
    const size = file.size;
    if (kind === "image" && size > MAX_IMAGE) {
      return c.json({ error: "image too large (max 10MB)" }, 400);
    }
    if (kind === "doc" && size > MAX_DOC) {
      return c.json({ error: "document too large (max 20MB)" }, 400);
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const ext = extname(file.name) || "";
    const id = randomUUID();
    const key = `${id}${ext}`;
    const { url } = await service.uploadStorage.put({
      key, body: buf, contentType: mime,
    });

    await service.db.createAsset({
      id, taskId: null, userId, type: "upload",
      storageKey: key, url, mime, sizeBytes: size,
    });

    return c.json({ assetId: id, filename: file.name, mime, size, url, kind });
  });

  return app;
}
```

- [ ] **Step 5: 注册路由 + 静态服务（index.ts）**

`index.ts` 顶部加：`import { createUploadRoutes } from "./routes/uploads.js";`
在 authMw 区（与 `app.use("/api/assets/*", authMw);` 同组）加：`app.use("/api/uploads/*", authMw);`
在 protected 路由区（`app.route("/api/assets", ...)` 附近）加：`app.route("/api/uploads", createUploadRoutes(service));`
在 `ASSETS_DIR` 定义旁加：`const UPLOADS_DIR = resolve(ROOT, "data/uploads");`
在 `/static/documents/:filename` 路由后追加镜像路由：

```ts
  app.get("/static/uploads/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (filename.includes("/") || filename.includes("..")) {
      return c.text("bad request", 400);
    }
    try {
      const buf = await readFile(resolve(UPLOADS_DIR, filename));
      return c.body(buf, 200, { "Content-Type": guessMime(filename) });
    } catch {
      return c.text("not found", 404);
    }
  });
```

- [ ] **Step 6: 跑测试 + 编译**

Run: `npm test -w @lot-agent/server -- uploads` → PASS
Run: `npm run build -w @lot-agent/server` → 通过

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/routes/uploads.ts packages/server/src/routes/uploads.test.ts packages/server/src/index.ts packages/server/src/services/agent-service.ts
git commit -m "feat(server): /api/uploads 接收文件并落盘 + /static/uploads 静态服务"
```

---

## Task 5: 后端串联——保存附件、注入模型、多轮重 materialize

**Files:**
- Modify: `packages/server/src/services/message-repository.ts`
- Modify: `packages/server/src/services/agent-service.ts:279-294`
- Modify: `packages/server/src/routes/conversations.ts:110-145`
- Test: `packages/server/src/services/message-repository.test.ts`（Create 或追加）

**Interfaces:**
- Consumes: `extractAttachment`、`AttachmentRef`、`service.uploadStorage`
- Produces:
  - `saveUserMessage(conversationId, userMessage, attachments?: AttachmentRef[]): Promise<string>`（attachments 存入 `metadata.attachments`）
  - `loadHistory(...)`：带 `metadata.attachments` 的 user 消息 → `content` 重组为 `ContentPart[]`
  - `streamAgentResponse(conversationId, userMessage, agentId?, userId?, attachments?: AttachmentRef[])`

- [ ] **Step 1: 写失败测试** — 在 `message-repository.test.ts` 追加（用内存 stub db）：

```ts
import { describe, it, expect } from "vitest";
import { MessageRepository } from "./message-repository.js"; // 按实际导出名调整

// 最小 db stub：记录 addMessage 调用并能回放 getMessages
function memDb() {
  const rows: any[] = [];
  return {
    rows,
    addMessage: async (id: string, cid: string, role: string, content: string, opts: any = {}) => {
      rows.push({ id, conversation_id: cid, role, content, tool_call_id: opts.toolCallId ?? null, tool_calls: null, metadata: opts.metadata ?? {} });
    },
    getMessages: async () => rows,
  } as any;
}

it("saveUserMessage stores attachments in metadata", async () => {
  const db = memDb();
  const repo = new MessageRepository(db);
  const att = [{ assetId: "a1", filename: "n.txt", mime: "text/plain", size: 2, url: "/static/uploads/a1.txt", kind: "doc" as const }];
  const id = await repo.saveUserMessage("c1", "hi", att);
  const row = db.rows.find((r: any) => r.id === id);
  expect(row.metadata.attachments).toEqual(att);
});
```

> 若现有 `loadHistory` 依赖 `getMessages` 返回 `metadata` 字段，确认 `db.getMessages` 的真实 SELECT 已带 `metadata`（`SELECT *` 即可，messages 表有该列）。`MessageRepository` 构造与导出名以文件实际为准。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w @lot-agent/server -- message-repository`
Expected: FAIL — `saveUserMessage` 不接受第三参 / metadata 未写

- [ ] **Step 3: 改 saveUserMessage**

`message-repository.ts` 顶部 import 加：`import type { AttachmentRef } from "./attachment-extractor.js";`
替换第 14-18 行：

```ts
  async saveUserMessage(
    conversationId: string,
    userMessage: string,
    attachments?: AttachmentRef[]
  ): Promise<string> {
    const userMsgId = randomUUID();
    await this.db.addMessage(userMsgId, conversationId, "user", userMessage, {
      metadata: attachments?.length ? { attachments } : {},
    });
    return userMsgId;
  }
```

- [ ] **Step 4: loadHistory 重 materialize**

`loadHistory` 需要把图片/文档重新转 `ContentPart[]`。由于解析要读存储且是 async，给 `MessageRepository` 注入一个可选 materializer。最简实现：在构造里接收 `uploadStorage`，或给 `loadHistory` 加参数。采用后者（更少改构造）：

把 `loadHistory(conversationId, excludeMessageId)` 改为：

```ts
  async loadHistory(
    conversationId: string,
    excludeMessageId: string,
    materialize?: (atts: AttachmentRef[]) => Promise<import("@lot-agent/core").ContentPart[]>
  ): Promise<Message[]> {
```

在构造 `history.push({...})` 的循环里（第 48-57 行），对 user 消息读取 metadata 并重组：

```ts
    for (const m of filtered) {
      if (m.role === "tool" && m.tool_call_id) {
        if (!validToolCallIds.has(m.tool_call_id)) continue;
      }
      let content: Message["content"] = m.content;
      if (m.role === "user" && materialize) {
        const meta = typeof m.metadata === "string" ? JSON.parse(m.metadata) : m.metadata;
        const atts = (meta?.attachments ?? []) as AttachmentRef[];
        if (atts.length) {
          const parts = await materialize(atts);
          content = [
            ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
            ...parts,
          ];
        }
      }
      history.push({
        role: m.role as Message["role"],
        content,
        toolCallId: m.tool_call_id ?? undefined,
      });
    }
```

（`m.metadata` 形态依 `getMessages` 而定——pg 的 JSONB 返回对象，stub 返回对象；两者都被上面 `typeof` 分支覆盖。）

- [ ] **Step 5: agent-service 接收并注入 attachments**

`streamAgentResponse` 签名（第 279-284）改为加 `attachments?: AttachmentRef[]`（顶部 import `AttachmentRef`、`extractAttachment` from `./attachment-extractor.js`，`ContentPart` from `@lot-agent/core`）。

第 290-294 替换为：

```ts
    const userMsgId = await this.messageRepo.saveUserMessage(
      conversationId,
      userMessage,
      attachments
    );
    const materialize = (atts: AttachmentRef[]) =>
      Promise.all(atts.map((a) => extractAttachment(a, this.uploadStorage)));
    const history = await this.messageRepo.loadHistory(
      conversationId,
      userMsgId,
      materialize
    );
```

构造本轮发给模型的 user 输入（在 `agent.run(userMessage, ...)` 之前，第 341 行附近）：

```ts
    let runInput: string | ContentPart[] = userMessage;
    if (attachments?.length) {
      const parts = await materialize(attachments);
      runInput = [
        ...(userMessage ? [{ type: "text" as const, text: userMessage }] : []),
        ...parts,
      ];
    }
```

并把第 341 行 `agent.run(userMessage, context, history)` 改为 `agent.run(runInput, context, history)`。

- [ ] **Step 6: conversations 路由接收 attachments**

`conversations.ts` 第 118-120 与第 138-140 的 `/messages` handler：
body 类型改为 `{ content: string; attachments?: AttachmentRef[] }`（顶部 import `AttachmentRef`）。
把校验 `if (!body.content)` 放宽为允许「有附件、无文字」：

```ts
    if (!body.content && !(body.attachments && body.attachments.length)) {
      return c.json({ error: "content or attachments required" }, 400);
    }
```

把 `service.streamAgentResponse(... body.content ...)` 调用补上第 4/5 参（按现有传参顺序，确保 `userId` 仍在第 4 位、attachments 第 5 位）：

```ts
          for await (const event of service.streamAgentResponse(
            id,
            body.content ?? "",
            agentId,            // 现有变量，保持
            userId,             // 现有变量，保持
            body.attachments
          )) {
```

（以现有该调用的实参为准，仅在末尾追加 `body.attachments`；若现有未传 agentId/userId 显式，按现状补齐位置。）

- [ ] **Step 7: 跑测试 + 编译**

Run: `npm test -w @lot-agent/server -- message-repository` → PASS
Run: `npm run build -w @lot-agent/server` → 通过

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/services/message-repository.ts packages/server/src/services/message-repository.test.ts packages/server/src/services/agent-service.ts packages/server/src/routes/conversations.ts
git commit -m "feat(server): 保存附件元数据、注入模型并多轮重 materialize"
```

---

## Task 6: 前端 API 客户端

**Files:**
- Modify: `packages/web/src/api/client.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface UploadedAttachment { assetId: string; filename: string; mime: string; size: number; url: string; kind: "image" | "doc"; }
  api.uploadFile(file: File): Promise<UploadedAttachment>
  api.sendMessage(conversationId, content, onEvent, attachments?: UploadedAttachment[]): AbortController
  ```

- [ ] **Step 1: 加 UploadedAttachment 类型**

在 `client.ts` 顶部类型区加：

```ts
export interface UploadedAttachment {
  assetId: string;
  filename: string;
  mime: string;
  size: number;
  url: string;
  kind: "image" | "doc";
}
```

- [ ] **Step 2: 加 uploadFile（不经 request()，因为是 multipart）**

在 `api` 对象内加：

```ts
  uploadFile: async (file: File): Promise<UploadedAttachment> => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${BASE}/uploads`, {
      method: "POST",
      headers: { ...authHeaders() }, // 不要手动设 Content-Type，浏览器自动带 boundary
      body: fd,
    });
    if (res.status === 401) {
      clearToken();
      window.dispatchEvent(new Event("lot:unauthorized"));
      throw new Error("Unauthorized");
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error ?? res.statusText);
    }
    return res.json();
  },
```

- [ ] **Step 3: sendMessage 带 attachments**

把 `sendMessage` 签名改为：

```ts
  sendMessage: (
    conversationId: string,
    content: string,
    onEvent: (event: AgentEvent) => void | Promise<void>,
    attachments?: UploadedAttachment[]
  ): AbortController => {
```

并把请求 body 改为：`body: JSON.stringify({ content, attachments }),`

- [ ] **Step 4: 编译检查**

Run: `npx tsc --noEmit -p packages/web/tsconfig.json`
Expected: 无新增错误

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api/client.ts
git commit -m "feat(web): api.uploadFile + sendMessage 携带附件"
```

---

## Task 7: 前端 InputBox — `+` 按钮与 chip 行

**Files:**
- Modify: `packages/web/src/components/InputBox.tsx`
- Modify: `packages/web/src/App.css`

**Interfaces:**
- Consumes: `UploadedAttachment`（仅类型，用于 kind 判定时用 File）
- Produces: `InputBox` 的 `onSend` 改为 `(content: string, files: File[]) => void`；内部维护 `files` state 与 chip 渲染。

- [ ] **Step 1: 扩展 props 与 state**

`InputBoxProps.onSend` 改为 `onSend: (content: string, files: File[]) => void;`
组件内加：

```ts
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const MAX_FILES = 5;
  const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,.txt,.md,.csv,.json,application/pdf,.docx";

  const addFiles = useCallback((picked: FileList | null) => {
    if (!picked) return;
    setFiles((prev) => {
      const next = [...prev];
      for (const f of Array.from(picked)) {
        if (next.length >= MAX_FILES) break;
        next.push(f);
      }
      return next;
    });
  }, []);

  const removeFile = useCallback((idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }, []);
```

- [ ] **Step 2: handleSend 带文件并清空**

替换 `handleSend`：

```ts
  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if ((!trimmed && files.length === 0) || disabled) return;
    onSend(trimmed, files);
    setValue("");
    setFiles([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [value, files, disabled, onSend]);
```

- [ ] **Step 3: 渲染 chip 行 + `+` 按钮 + 隐藏 input**

在 `<div className="input-box">` 内、`<textarea>` 之前插入 chip 行：

```tsx
      {files.length > 0 && (
        <div className="input-attachments">
          {files.map((f, i) => (
            <div className="attachment-chip" key={i}>
              {f.type.startsWith("image/") ? (
                <img className="attachment-thumb" src={URL.createObjectURL(f)} alt={f.name} />
              ) : (
                <span className="attachment-doc-icon" aria-hidden>📄</span>
              )}
              <span className="attachment-name" title={f.name}>{f.name}</span>
              <button className="attachment-remove" onClick={() => removeFile(i)} title="移除" type="button">✕</button>
            </div>
          ))}
        </div>
      )}
```

在 `input-toolbar-right` 内、发送/停止按钮**之前**插入：

```tsx
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPT}
            style={{ display: "none" }}
            onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
          />
          <button
            type="button"
            className="btn-upload"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || files.length >= MAX_FILES}
            title="上传文件"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
```

并把 `btn-send` 的 `disabled={!value.trim()}` 改为 `disabled={!value.trim() && files.length === 0}`。

- [ ] **Step 4: 加样式（App.css 末尾）**

```css
.btn-upload {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.btn-upload:hover:not(:disabled) { background: var(--overlay-raise); color: var(--text); }
.btn-upload:disabled { opacity: 0.4; cursor: default; }
.btn-upload svg { width: 20px; height: 20px; }

.input-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 8px 0;
}
.attachment-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-tool);
  font-size: 12px;
  color: var(--text-secondary);
}
.attachment-thumb { width: 24px; height: 24px; border-radius: 4px; object-fit: cover; }
.attachment-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attachment-remove {
  border: none; background: transparent; cursor: pointer;
  color: var(--text-muted); font-size: 12px; line-height: 1; padding: 0;
}
.attachment-remove:hover { color: var(--text); }
```

- [ ] **Step 5: 编译检查**

Run: `npx tsc --noEmit -p packages/web/tsconfig.json`
Expected: 报错指向 `ChatPanel`/调用处 `onSend` 签名不匹配 → 由 Task 8 修复。可暂时容忍此一处，或先改 ChatPanel（见 Task 8 Step 1）后再编译。

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/InputBox.tsx packages/web/src/App.css
git commit -m "feat(web): InputBox 上传按钮 + 附件 chip"
```

---

## Task 8: 前端串联——发送上传、气泡 chip、重载还原

**Files:**
- Modify: `packages/web/src/components/ChatPanel.tsx`
- Modify: `packages/web/src/hooks/useChat.ts`
- Modify: `packages/web/src/components/MessageBubble.tsx`
- Modify: `packages/web/src/App.css`（user 气泡 chip 复用 Task 7 样式即可，必要时微调）

**Interfaces:**
- Consumes: `api.uploadFile`、`api.sendMessage(..., attachments)`、`UploadedAttachment`
- Produces: `DisplayMessage.attachments?: UploadedAttachment[]`；`ChatPanel.onSend(content, files)`

- [ ] **Step 1: ChatPanel 透传 onSend 第二参**

`ChatPanelProps.onSend` 改为 `(content: string, files: File[]) => void`。`InputBox` 已是该签名，直接透传；`InputBox` 的 `onSend={onSend}` 不变。把 `ChatPanel` 的 `onSend` prop 类型与传入处对齐。

- [ ] **Step 2: DisplayMessage 加 attachments**

`useChat.ts` 的 `DisplayMessage` 接口加：`attachments?: UploadedAttachment[];`（import 类型：`import { api, type UploadedAttachment } from "../api/client.js";`，若已 import api 则合并）。

- [ ] **Step 3: streamMessage 先上传再发送**

把 `streamMessage` 签名改为 `(content: string, files: File[] = [])`，在构造 userMsg 前加上传：

```ts
  const streamMessage = useCallback(
    (content: string, files: File[] = []) => {
      const cid = cidRef.current;
      if (!cid || (!content.trim() && files.length === 0) || isStreaming) return;

      setIsStreaming(true);
      (async () => {
        let uploaded: UploadedAttachment[] = [];
        try {
          uploaded = await Promise.all(files.map((f) => api.uploadFile(f)));
        } catch (e) {
          setIsStreaming(false);
          window.alert(`文件上传失败：${e instanceof Error ? e.message : String(e)}`);
          return;
        }

        const userMsgId = `user-${Date.now()}`;
        const userMsg: DisplayMessage = {
          id: userMsgId, role: "user", content, attachments: uploaded,
        };
        setMessages((prev) => [...prev, userMsg]);

        let assistantMsg: DisplayMessage = {
          id: `assistant-${Date.now()}`, role: "assistant", content: "", isStreaming: true,
        };
        let pendingToolCalls: { name: string; input: unknown }[] = [];

        abortRef.current = api.sendMessage(cid, content, async (event) => {
          /* …把原有的 onEvent 回调体原样放这里… */
        }, uploaded);
      })();
    },
    [conversationId, isStreaming, loadMessages]
  );
```

> 实施要点：把原函数内从 `if (event.type === "text" …)` 到 error 分支的**整段 onEvent 回调体**移入新结构的 `api.sendMessage(..., async (event) => { … }, uploaded)`。原先在外层 `setIsStreaming(true)` 已上移到 try 之前，删除原位置那一行，避免重复。`assistantMsg`/`pendingToolCalls` 声明已移入闭包。

- [ ] **Step 4: regenerate 适配新签名**

`regenerate` 内 `streamMessage(lastUserContent)` 保持可用（files 默认 `[]`），无需改。

- [ ] **Step 5: loadMessages 还原 attachments**

`loadMessages` 映射里，user 消息从 `metadata` 取 attachments：

```ts
      const meta = (m as { metadata?: any }).metadata;
      const parsedMeta = typeof meta === "string" ? JSON.parse(meta) : meta;
      return {
        id: m.id, dbId: m.id, role, content: m.content,
        attachments: role === "user" ? (parsedMeta?.attachments ?? undefined) : undefined,
        toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : undefined,
        toolResult: role === "tool" ? { name: toolName ?? "tool", output: m.content, isError: false } : undefined,
        rating: m.rating ?? null,
      };
```

并确认 `StoredMessage`（client.ts）含 `metadata?: string | Record<string, unknown> | null;`（如缺则加）。

- [ ] **Step 6: MessageBubble 渲染 user 气泡 chip**

`MessageBubbleProps.message` 已是 `DisplayMessage`（含 attachments）。在 user 分支（第 16-26 行）`message-content` 之后插入：

```tsx
          {message.attachments && message.attachments.length > 0 && (
            <div className="message-attachments">
              {message.attachments.map((a, i) => (
                <a className="attachment-chip" key={i} href={a.url} target="_blank" rel="noreferrer">
                  {a.kind === "image" ? (
                    <img className="attachment-thumb" src={a.url} alt={a.filename} />
                  ) : (
                    <span className="attachment-doc-icon" aria-hidden>📄</span>
                  )}
                  <span className="attachment-name" title={a.filename}>{a.filename}</span>
                </a>
              ))}
            </div>
          )}
```

- [ ] **Step 7: 气泡 chip 样式（App.css）**

```css
.message-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
  justify-content: flex-end;
}
.message-attachments .attachment-chip { text-decoration: none; }
```

- [ ] **Step 8: 编译 + 构建**

Run: `npx tsc --noEmit -p packages/web/tsconfig.json` → 无错误
Run: `npm run build -w @lot-agent/web` → 通过

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/components/ChatPanel.tsx packages/web/src/hooks/useChat.ts packages/web/src/components/MessageBubble.tsx packages/web/src/api/client.ts packages/web/src/App.css
git commit -m "feat(web): 上传文件随消息发送 + 气泡附件 chip + 重载还原"
```

---

## Task 9: 端到端冒烟（手动验证）

**Files:** 无（手动）

- [ ] **Step 1: 起服务**

```bash
npm run dev
```

- [ ] **Step 2: 验证图片**

登录 → 新建对话 → 点 `+` 选一张 png → 输入“描述这张图” → 发送。
预期：气泡显示缩略图 chip；模型回复能描述图片内容（需配置了多模态可用的模型 key）。

- [ ] **Step 3: 验证文档**

点 `+` 选一个 pdf 或 txt → 输入“总结这个文件” → 发送。
预期：气泡显示文件名 chip；模型回复基于文件内容；追问“第二段讲了什么”仍能命中（多轮重 materialize 生效）。

- [ ] **Step 4: 验证重载**

刷新页面、重开该对话。
预期：历史 user 气泡仍显示附件 chip，图片可预览、文档可点开下载。

- [ ] **Step 5: 验证校验**

尝试上传 >10MB 图片或非白名单类型。
预期：前端拒绝或后端 400 提示，不进入流式。

---

## Self-Review（已对照 spec）

- §1 架构数据流 → Task 4/5（上传两步、注入模型）✓
- §2 文档解析（txt/md/csv/json/pdf/docx + 截断 + 降级）→ Task 3 ✓
- §2 图片多模态 → Task 2（provider）+ Task 3（base64 data URL）✓
- §3 多轮重 materialize → Task 5 Step 4-5 ✓
- §3 持久化/重载还原 → Task 5（metadata）+ Task 8 Step 5-6 ✓
- 上限/校验 → Task 4（mime/size）+ Task 3（30k 截断）+ Task 7（前端 5 文件）✓
- 错误处理（上传 400 / 解析降级 / 发送中止）→ Task 4 / Task 3 / Task 8 Step 3 ✓
- 展示与模型内容分离 → 气泡存 content+chip（Task 5 saveUserMessage 不写解析文本进 content）✓
- 数据模型不改表 → 复用 assets.type='upload' + messages.metadata ✓
- 新依赖 pdf-parse/mammoth → Task 3 ✓

类型一致性：`AttachmentRef`（server）与 `UploadedAttachment`（web）字段同构；`extractAttachment`/`attachmentKind`/`MAX_DOC_CHARS` 在 Task 3 定义、Task 4/5 引用名一致；`ObjectStorage.get`、`Agent.run(string|ContentPart[])` 在 Task 1 定义、后续引用一致。
