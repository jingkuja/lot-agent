# 后台异步记忆抽取 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把用户记忆的写入从主对话的可见工具调用，改为对话结束后由 BullMQ worker 跑的、对用户不可见的异步 LLM 抽取任务。

**Architecture:** core 新增纯函数（构建抽取提示 / 解析 / 应用到持久层）；server 抽出 `loadLlmConfig` 供 worker 复用、加一个 `lastTurn` 辅助；聊天 agent 移除全部记忆工具（策略注入随门控自动关闭）；`streamAgentResponse` 回合结束 fire-and-forget enqueue `memory.extract`；worker 跑廉价 LLM 抽取并写 `user_memory`。

**Tech Stack:** TypeScript（ESM，显式 `.js` 后缀）、npm workspaces、Vitest、BullMQ、ioredis、pg、Hono。

## Global Constraints

- ESM imports 必须带显式 `.js` 后缀；2 空格缩进。
- 接口在 core、依赖 Redis/pg 的实现在 server。
- core 不得 import `ioredis`/`pg`。
- 测试 Vitest，文件同址 `*.test.ts`。
- 全链 best-effort：enqueue/抽取/parse/apply 失败都不得影响主对话；`parseExtraction` 永不抛。
- 默认文本模型 id：`llmConfig.default === "openai" ? llmConfig.openai.model : llmConfig.anthropic.model`。
- 抽取器严格输出 JSON：`{"upserts":[{"key":"","value":""}],"deletes":[""]}`。
- 不提交任何密钥。

---

### Task 1: core — 抽取纯逻辑（build / parse / apply）

**Files:**
- Create: `packages/core/src/memory/extraction.ts`
- Modify: `packages/core/src/memory/index.ts`
- Test: `packages/core/src/memory/extraction.test.ts`

**Interfaces:**
- Consumes: `Message`（`../types/index.js`）、`MemoryEntry` + `PersistentMemoryAdapter`（`./store.js`）。
- Produces:
  - `interface MemoryTurn { userMessage: string; assistantText: string }`
  - `interface MemoryExtraction { upserts: Array<{ key: string; value: string }>; deletes: string[] }`
  - `buildExtractionMessages(turn: MemoryTurn, existing: MemoryEntry[]): Message[]`
  - `parseExtraction(raw: string): MemoryExtraction`
  - `applyExtraction(adapter: PersistentMemoryAdapter, userId: string, ext: MemoryExtraction): Promise<void>`

- [ ] **Step 1: 写失败测试**

Create `packages/core/src/memory/extraction.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import {
  buildExtractionMessages,
  parseExtraction,
  applyExtraction,
} from "./extraction.js";
import type { PersistentMemoryAdapter, MemoryEntry } from "./store.js";

describe("buildExtractionMessages", () => {
  it("returns a system + user message containing the turn and existing keys", () => {
    const existing: MemoryEntry[] = [
      { key: "preferred_language", value: "简体中文", tier: "user", createdAt: 0 },
    ];
    const msgs = buildExtractionMessages(
      { userMessage: "我叫小明", assistantText: "你好小明" },
      existing
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].role).toBe("user");
    const user = msgs[1].content as string;
    expect(user).toContain("我叫小明");
    expect(user).toContain("你好小明");
    expect(user).toContain("preferred_language");
  });

  it("is valid with no existing memories", () => {
    const msgs = buildExtractionMessages({ userMessage: "hi", assistantText: "hello" }, []);
    expect(msgs).toHaveLength(2);
    expect(typeof msgs[1].content).toBe("string");
  });
});

describe("parseExtraction", () => {
  it("parses plain JSON", () => {
    const r = parseExtraction('{"upserts":[{"key":"a","value":"b"}],"deletes":["c"]}');
    expect(r).toEqual({ upserts: [{ key: "a", value: "b" }], deletes: ["c"] });
  });

  it("parses fenced ```json blocks", () => {
    const r = parseExtraction('```json\n{"upserts":[],"deletes":[]}\n```');
    expect(r).toEqual({ upserts: [], deletes: [] });
  });

  it("returns empty ops on garbage", () => {
    expect(parseExtraction("not json at all")).toEqual({ upserts: [], deletes: [] });
  });

  it("drops malformed upserts and non-string deletes", () => {
    const r = parseExtraction(
      '{"upserts":[{"key":"a","value":"b"},{"key":"x"},"junk"],"deletes":["ok",5,null]}'
    );
    expect(r).toEqual({ upserts: [{ key: "a", value: "b" }], deletes: ["ok"] });
  });

  it("defaults missing arrays to empty", () => {
    expect(parseExtraction("{}")).toEqual({ upserts: [], deletes: [] });
  });
});

describe("applyExtraction", () => {
  it("deletes then upserts via the adapter", async () => {
    const calls: string[] = [];
    const adapter: PersistentMemoryAdapter = {
      get: async () => undefined,
      set: async (_u, k) => { calls.push(`set:${k}`); },
      delete: async (_u, k) => { calls.push(`del:${k}`); },
      list: async () => [],
      search: async () => [],
    };
    await applyExtraction(adapter, "u1", {
      upserts: [{ key: "a", value: "1" }],
      deletes: ["old"],
    });
    expect(calls).toEqual(["del:old", "set:a"]);
  });

  it("continues after a single op failure", async () => {
    const set = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const adapter: PersistentMemoryAdapter = {
      get: async () => undefined,
      set,
      delete: async () => {},
      list: async () => [],
      search: async () => [],
    };
    await applyExtraction(adapter, "u1", {
      upserts: [{ key: "a", value: "1" }, { key: "b", value: "2" }],
      deletes: [],
    });
    expect(set).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @lot-agent/core -- extraction.test`
Expected: FAIL（`./extraction.js` 不存在）。

- [ ] **Step 3: 实现 extraction.ts**

Create `packages/core/src/memory/extraction.ts`:

```ts
import type { Message } from "../types/index.js";
import type { MemoryEntry, PersistentMemoryAdapter } from "./store.js";

export interface MemoryTurn {
  userMessage: string;
  assistantText: string;
}

export interface MemoryExtraction {
  upserts: Array<{ key: string; value: string }>;
  deletes: string[];
}

const SYSTEM_PROMPT = `你是用户记忆抽取器。从一段对话回合中抽取可长期复用的用户事实与稳定偏好（称呼、语言偏好、行业/品牌背景、长期约束）。
不要抽取一次性请求、临时上下文或敏感信息（密码、支付信息）。
你会拿到该用户的现有记忆。请产出：
- upserts：需要新增或值发生变化的记忆，key 用稳定的英文 snake_case（如 preferred_language、brand_name）。
- deletes：被用户更正、推翻或明显过时、应删除的现有 key。
没有任何可记内容时，两个数组都为空。
严格只输出 JSON，不要解释、不要 markdown：{"upserts":[{"key":"","value":""}],"deletes":[""]}`;

export function buildExtractionMessages(
  turn: MemoryTurn,
  existing: MemoryEntry[]
): Message[] {
  const existingText = existing.length
    ? existing.map((e) => `- ${e.key}: ${e.value}`).join("\n")
    : "（无）";
  const userContent =
    `[现有记忆]\n${existingText}\n\n` +
    `[本回合对话]\n用户: ${turn.userMessage}\n助手: ${turn.assistantText}`;
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];
}

export function parseExtraction(raw: string): MemoryExtraction {
  const empty: MemoryExtraction = { upserts: [], deletes: [] };
  if (!raw) return empty;
  // Strip code fences and surrounding noise; grab the outermost JSON object.
  const fenced = raw.replace(/```json/gi, "```");
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return empty;
  let obj: unknown;
  try {
    obj = JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return empty;
  }
  if (typeof obj !== "object" || obj === null) return empty;
  const o = obj as Record<string, unknown>;
  const upserts = Array.isArray(o.upserts)
    ? o.upserts.filter(
        (u): u is { key: string; value: string } =>
          typeof u === "object" &&
          u !== null &&
          typeof (u as Record<string, unknown>).key === "string" &&
          typeof (u as Record<string, unknown>).value === "string"
      )
    : [];
  const deletes = Array.isArray(o.deletes)
    ? o.deletes.filter((d): d is string => typeof d === "string")
    : [];
  return { upserts, deletes };
}

export async function applyExtraction(
  adapter: PersistentMemoryAdapter,
  userId: string,
  ext: MemoryExtraction
): Promise<void> {
  for (const key of ext.deletes) {
    try {
      await adapter.delete(userId, key);
    } catch {
      // best-effort: one failure must not block the rest
    }
  }
  for (const { key, value } of ext.upserts) {
    try {
      await adapter.set(userId, key, value);
    } catch {
      // best-effort
    }
  }
}
```

- [ ] **Step 4: 导出（index.ts）**

在 `packages/core/src/memory/index.ts` 末尾加：

```ts
export {
  buildExtractionMessages,
  parseExtraction,
  applyExtraction,
  type MemoryTurn,
  type MemoryExtraction,
} from "./extraction.js";
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -w @lot-agent/core -- extraction.test`
Expected: PASS（全部用例）。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/memory/extraction.ts packages/core/src/memory/extraction.test.ts packages/core/src/memory/index.ts
git commit -m "feat(core): memory extraction pure logic (build/parse/apply)"
```

---

### Task 2: server — 抽出 `loadLlmConfig` 供 worker 复用

**Files:**
- Create: `packages/server/src/config.ts`
- Modify: `packages/server/src/index.ts:48-90`（`loadConfig`）
- Test: `packages/server/src/config.test.ts`

**Interfaces:**
- Consumes: `AppConfigSchema`, `LLMConfig`（`@lot-agent/core`）。
- Produces: `loadLlmConfig(rootDir: string): Promise<LLMConfig>` —— 读 `{rootDir}/config/default.json`，套用 `OPENAI_*`/`ANTHROPIC_*`/`LLM_DEFAULT` 环境覆盖，`AppConfigSchema.parse` 后返回 `config.llm`。

- [ ] **Step 1: 写失败测试**

Create `packages/server/src/config.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { loadLlmConfig } from "./config.js";

// repo root: this test sits at packages/server/src/config.test.ts
const ROOT = resolve(__dirname, "../../..");

describe("loadLlmConfig", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
    delete process.env.LLM_DEFAULT;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("applies OPENAI_* and LLM_DEFAULT env overrides", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_MODEL = "gpt-test";
    process.env.LLM_DEFAULT = "openai";
    const llm = await loadLlmConfig(ROOT);
    expect(llm.default).toBe("openai");
    expect(llm.openai.apiKey).toBe("sk-test");
    expect(llm.openai.model).toBe("gpt-test");
  });

  it("falls back to config defaults when env is unset", async () => {
    const llm = await loadLlmConfig(ROOT);
    expect(llm.openai.apiKey).toBe(""); // default.json keeps keys empty
    expect(typeof llm.openai.model).toBe("string");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @lot-agent/server -- config.test`
Expected: FAIL（`./config.js` 不存在）。

- [ ] **Step 3: 实现 config.ts**

Create `packages/server/src/config.ts`:

```ts
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AppConfigSchema } from "@lot-agent/core";
import type { LLMConfig } from "@lot-agent/core";

/**
 * Load the LLM config from {rootDir}/config/default.json, applying
 * OPENAI_* / ANTHROPIC_* / LLM_DEFAULT env overrides before validation.
 * Shared by the API server and the background worker.
 */
export async function loadLlmConfig(rootDir: string): Promise<LLMConfig> {
  const configPath = resolve(rootDir, "config/default.json");
  const rawConfig = JSON.parse(await readFile(configPath, "utf-8"));

  const llmRaw = rawConfig.llm ?? {};
  const openaiRaw = llmRaw.openai ?? {};
  const anthropicRaw = llmRaw.anthropic ?? {};

  if (process.env.OPENAI_API_KEY) openaiRaw.apiKey = process.env.OPENAI_API_KEY;
  if (process.env.OPENAI_BASE_URL) openaiRaw.baseUrl = process.env.OPENAI_BASE_URL;
  if (process.env.OPENAI_MODEL) openaiRaw.model = process.env.OPENAI_MODEL;
  if (process.env.ANTHROPIC_API_KEY) anthropicRaw.apiKey = process.env.ANTHROPIC_API_KEY;
  if (process.env.ANTHROPIC_MODEL) anthropicRaw.model = process.env.ANTHROPIC_MODEL;
  if (process.env.LLM_DEFAULT) llmRaw.default = process.env.LLM_DEFAULT;

  llmRaw.openai = openaiRaw;
  llmRaw.anthropic = anthropicRaw;
  rawConfig.llm = llmRaw;

  const config = AppConfigSchema.parse(rawConfig);
  return config.llm as LLMConfig;
}
```

- [ ] **Step 4: 重构 index.ts 的 loadConfig 复用它**

在 `packages/server/src/index.ts` 顶部 import 区加：

```ts
import { loadLlmConfig } from "./config.js";
```

把 `loadConfig()` 函数体（当前 48-90 行）替换为：

```ts
async function loadConfig(): Promise<ServiceConfig> {
  const llm = await loadLlmConfig(ROOT);

  const configPath = resolve(ROOT, "config/default.json");
  const config = AppConfigSchema.parse(JSON.parse(await readFile(configPath, "utf-8")));

  const pgPassword = process.env.PG_PASSWORD;
  if (!pgPassword) throw new Error("PG_PASSWORD is required");

  return {
    llm,
    models: config.models ?? [],
    agent: config.agent as ServiceConfig["agent"],
    mcpConfigPath: resolve(ROOT, "config/mcp-servers.json"),
    skillsDir: resolve(ROOT, "skills"),
    db: {
      host: process.env.PG_HOST ?? "localhost",
      port: Number(process.env.PG_PORT) || 5432,
      user: process.env.PG_USER ?? "postgres",
      password: pgPassword,
      database: process.env.PG_DATABASE ?? "lot",
    },
  };
}
```

（`LLMConfig` 的 import 若变为未使用，TS 不会报错；保留即可。其余 import 不动。）

- [ ] **Step 5: 运行测试 + 构建确认通过**

Run: `npm test -w @lot-agent/server -- config.test && npm run build -w @lot-agent/server`
Expected: 测试 PASS；server 构建成功。

- [ ] **Step 6: 提交**

```bash
git add packages/server/src/config.ts packages/server/src/config.test.ts packages/server/src/index.ts
git commit -m "refactor(server): extract loadLlmConfig for reuse by worker"
```

---

### Task 3: server — `lastTurn` 辅助

**Files:**
- Create: `packages/server/src/memory/last-turn.ts`
- Test: `packages/server/src/memory/last-turn.test.ts`

**Interfaces:**
- Consumes: `MemoryTurn`（`@lot-agent/core`，Task 1）。
- Produces: `lastTurn(messages: Array<{ role: string; content: string }>): MemoryTurn | null` —— 取最后一条非空 `assistant` 文本及其之前最近的 `user` 文本。

- [ ] **Step 1: 写失败测试**

Create `packages/server/src/memory/last-turn.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { lastTurn } from "./last-turn.js";

describe("lastTurn", () => {
  it("pairs the last assistant reply with the preceding user message", () => {
    const t = lastTurn([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ]);
    expect(t).toEqual({ userMessage: "u2", assistantText: "a2" });
  });

  it("skips empty assistant messages (e.g. tool-call placeholders)", () => {
    const t = lastTurn([
      { role: "user", content: "u1" },
      { role: "assistant", content: "" },
      { role: "tool", content: "result" },
      { role: "assistant", content: "final" },
    ]);
    expect(t).toEqual({ userMessage: "u1", assistantText: "final" });
  });

  it("returns null when there is no assistant message", () => {
    expect(lastTurn([{ role: "user", content: "u1" }])).toBeNull();
  });

  it("returns empty userMessage when no preceding user exists", () => {
    expect(lastTurn([{ role: "assistant", content: "a" }])).toEqual({
      userMessage: "",
      assistantText: "a",
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @lot-agent/server -- last-turn.test`
Expected: FAIL（`./last-turn.js` 不存在）。

- [ ] **Step 3: 实现 last-turn.ts**

Create `packages/server/src/memory/last-turn.ts`:

```ts
import type { MemoryTurn } from "@lot-agent/core";

/**
 * From an ordered message list, take the last non-empty assistant reply and
 * the nearest preceding user message — the turn the extractor analyzes.
 */
export function lastTurn(
  messages: Array<{ role: string; content: string }>
): MemoryTurn | null {
  let assistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].content.trim()) {
      assistantIdx = i;
      break;
    }
  }
  if (assistantIdx === -1) return null;

  let userMessage = "";
  for (let i = assistantIdx - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userMessage = messages[i].content;
      break;
    }
  }
  return { userMessage, assistantText: messages[assistantIdx].content };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @lot-agent/server -- last-turn.test`
Expected: PASS（4 用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/memory/last-turn.ts packages/server/src/memory/last-turn.test.ts
git commit -m "feat(server): lastTurn helper for extracting the latest conversation turn"
```

---

### Task 4: 聊天 agent 移除全部记忆工具

**Files:**
- Modify: `packages/server/src/services/agent-service.ts`（移除 `createMemoryTools` 注册与 import）
- Delete: `packages/core/src/tools/memory-tools.ts`
- Delete: `packages/core/src/tools/memory-tools.test.ts`
- Modify: `packages/core/src/tools/index.ts`（移除 `createMemoryTools` 导出）

**Interfaces:**
- Produces: general agent 的 `toolNames` 不再含 `memory_read/write/list/delete`；连带使 `hasMemoryTools(allowedToolNames)` 返回 `false`，`MEMORY_POLICY_PROMPT` 不再注入（无需改 `agent.ts`）。
- 不变：`agent.run` 仍通过 `listUserMemory()` 注入 `[User Memory]`（不可见读路径保留）。

- [ ] **Step 1: 删除工具文件**

```bash
git rm packages/core/src/tools/memory-tools.ts packages/core/src/tools/memory-tools.test.ts
```

- [ ] **Step 2: 移除 tools/index.ts 的导出**

在 `packages/core/src/tools/index.ts` 中删除这一行：

```ts
export { createMemoryTools } from "./memory-tools.js";
```

- [ ] **Step 3: agent-service.ts 移除 import 与注册**

在 `packages/server/src/services/agent-service.ts` 的 `@lot-agent/core` import 列表中删除 `createMemoryTools,`。

删除 `init()` 中这段注册循环（连同其注释）：

```ts
    // Register memory tools — no closure capture; each tool reads context.memory at call time
    for (const tool of createMemoryTools()) {
      this.toolRegistry.register(tool);
    }
```

- [ ] **Step 4: 构建 + 全量测试确认无回归**

Run: `npm run build -w @lot-agent/core && npm run build -w @lot-agent/server && npm test`
Expected: 两 build 成功；全套件 PASS（已删除 memory-tools.test.ts，无孤儿测试；policy.test.ts 仍在且通过——`hasMemoryTools`/`MEMORY_POLICY_PROMPT` 仍导出）。

- [ ] **Step 5: 提交**

```bash
git add -A packages/core/src/tools packages/server/src/services/agent-service.ts
git commit -m "feat: remove memory tools from chat agent (writes move to background)"
```

---

### Task 5: enqueue + worker 抽取 handler

**Files:**
- Modify: `packages/server/src/services/agent-service.ts`（`streamAgentResponse` 的 `finally` enqueue）
- Modify: `packages/server/src/workers/index.ts`（注册 `memory.extract` handler）

**Interfaces:**
- Consumes: `this.jobQueue.enqueue`（现有 `JobQueue`）；`loadLlmConfig`（Task 2）；`lastTurn`（Task 3）；`buildExtractionMessages`/`parseExtraction`/`applyExtraction`（Task 1）；`createLLMProvider` + `PgMemoryAdapter`（`@lot-agent/core`）。
- Job：type `"memory.extract"`，input `{ conversationId: string }`，userId 经 `enqueue` 第三参。

- [ ] **Step 1: agent-service 回合结束 enqueue**

在 `packages/server/src/services/agent-service.ts` 的 `streamAgentResponse` 的 `finally` 块内、`await this.messageRepo.saveFinalAssistant(...)` 之后，加：

```ts
      // Fire-and-forget: extract durable user memory from this turn in the
      // background worker — never blocks the stream, never shows in the chat.
      this.jobQueue
        .enqueue("memory.extract", { conversationId }, userId ?? "default")
        .catch((err) => console.warn("[memory.extract] enqueue failed:", err));
```

- [ ] **Step 2: worker 顶部 import + 构建依赖**

在 `packages/server/src/workers/index.ts` 顶部 import 区加：

```ts
import {
  createLLMProvider,
  PgMemoryAdapter,
  buildExtractionMessages,
  parseExtraction,
  applyExtraction,
} from "@lot-agent/core";
import { loadLlmConfig } from "../config.js";
import { lastTurn } from "../memory/last-turn.js";
```

（`StubImageProvider, StubVideoProvider, LocalStorage` 等现有 import 保留。）

在 `main()` 中、`const cache = new GenCache(conn);` 之后，加：

```ts
  // Background memory extraction deps
  const llmConfig = await loadLlmConfig(ROOT);
  const extractLlm = createLLMProvider(llmConfig);
  const memAdapter = new PgMemoryAdapter(db.pool);
  await memAdapter.init();
  const extractModelId =
    llmConfig.default === "openai" ? llmConfig.openai.model : llmConfig.anthropic.model;
```

- [ ] **Step 3: 注册 memory.extract handler**

在 `packages/server/src/workers/index.ts` 的 `main()` 内、`console.log("Worker started, listening for jobs");` 之前，加：

```ts
  // Register memory.extract handler — runs a cheap LLM to pull durable user
  // facts/preferences from the latest turn and persist them. Best-effort.
  queue.process("memory.extract", async (job) => {
    const { conversationId } = job.input as { conversationId: string };
    const userId = job.userId;

    const messages = await db.getMessages(conversationId);
    const turn = lastTurn(messages);
    if (!turn) {
      await queue.updateProgress(job.id, 100);
      return { upserts: 0, deletes: 0 };
    }

    const existing = await memAdapter.list(userId);

    let raw = "";
    let inputTokens = 0;
    let outputTokens = 0;
    for await (const chunk of extractLlm.chat(buildExtractionMessages(turn, existing))) {
      if (chunk.type === "text") raw += chunk.content ?? "";
      if (chunk.type === "done" && chunk.usage) {
        inputTokens = chunk.usage.promptTokens;
        outputTokens = chunk.usage.completionTokens;
      }
    }

    const ext = parseExtraction(raw);
    await applyExtraction(memAdapter, userId, ext);

    if (inputTokens + outputTokens > 0) {
      try {
        await meter.record({
          userId,
          taskId: job.id,
          modelId: extractModelId,
          usage: { inputCount: inputTokens, outputCount: outputTokens },
        });
      } catch (err) {
        console.warn("[memory.extract] meter failed:", err);
      }
    }

    await queue.updateProgress(job.id, 100);
    return { upserts: ext.upserts.length, deletes: ext.deletes.length };
  });
```

注意：`ChatChunk`（`core/src/types/index.ts`）的 done chunk 用 `usage?: { promptTokens; completionTokens }`（不是 `inputTokens`/`outputTokens`——那是 agent.run 的 `AgentEvent`，与此处的 LLM 流 chunk 不同类型）。`usage` 可能缺省，故 token 取不到时跳过计量（已 gate 在 `>0`）。

- [ ] **Step 4: 构建 + 全量测试确认通过**

Run: `npm run build -w @lot-agent/core && npm run build -w @lot-agent/server && npm test`
Expected: 两 build 成功；全套件 PASS（本任务为接线，无新单测，靠 build + 既有套件无回归）。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/services/agent-service.ts packages/server/src/workers/index.ts
git commit -m "feat: enqueue + worker handler for async background memory extraction"
```

---

## 手动冒烟（需 Redis + worker 进程 + LLM key）

1. `npm run dev`（含 worker）。发一条含明确长期信息的消息：「我叫小明，长期偏好简体中文」。
2. 期望：用户对话里**无任何记忆工具气泡**，回答正常、不被阻塞。
3. worker 日志出现 `memory.extract` 完成；`GET /api/memory` 出现 `preferred_language`/称呼等条目。
4. 新开一条消息问「我叫什么」→ 模型能答出（来自 prompt 注入的 `[User Memory]`），仍无可见写操作。
5. 说「改用繁体」→ 下一轮抽取 upsert 纠正该偏好。

## Self-Review

- **Spec coverage：** A 移除工具 → Task 4（含 policy 自动关闭、保留 `[User Memory]` 注入）；B 抽取纯逻辑 → Task 1；`loadLlmConfig` → Task 2；`lastTurn` → Task 3；enqueue + worker handler → Task 5。手动冒烟覆盖端到端。全覆盖。
- **Placeholder scan：** 无 TBD/TODO；所有代码步骤给出完整代码。Task 5 Step 3 对 done chunk 字段名给了具体兜底说明，非占位。
- **Type consistency：** `MemoryTurn`/`MemoryExtraction` 在 Task 1 定义，Task 3/5 一致引用；`buildExtractionMessages`/`parseExtraction`/`applyExtraction` 签名跨 Task 1/5 一致；`loadLlmConfig(rootDir)` 跨 Task 2/5 一致；`lastTurn(messages)` 跨 Task 3/5 一致；job type 字面量 `"memory.extract"` 在 Task 5 两处一致。
