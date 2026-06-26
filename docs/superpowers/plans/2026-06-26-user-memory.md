# 完整三层用户记忆 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 session 记忆按 conversationId 跨消息持久化，并通过 system prompt 策略 + memory_delete 工具驱动模型在正确时机读写/清理用户记忆。

**Architecture:** core 定义 `SessionMemoryBackend` 接口，`AgentMemoryStore` 增加 `hydrate()` 与 session write-through；server 用 Redis 实现该接口（按 conversationId、20 分钟 TTL）。新增 `MEMORY_POLICY_PROMPT`，仅对带记忆工具的 agent 注入；新增 `memory_delete` 工具与可靠的 `deleteUserMemory()` 删除路径。

**Tech Stack:** TypeScript（ESM，显式 `.js` 后缀）、npm workspaces、Vitest、ioredis、Hono。

## Global Constraints

- ESM imports 必须带显式 `.js` 后缀；2 空格缩进。
- 接口在 core、实现（依赖 Redis/pg）在 server（interface-in-core / impl-in-server）。
- 测试用 Vitest，文件同址 `*.test.ts`。
- core 不得 import `ioredis`/`pg`。
- session TTL = 20 分钟（核心常量 `SESSION_TTL_MS = 20*60*1000`；Redis 端 `EX 1200`）。
- 不提交任何密钥。

---

### Task 1: core — SessionMemoryBackend 接口 + AgentMemoryStore 持久化/删除

**Files:**
- Create: `packages/core/src/memory/session-backend.ts`
- Modify: `packages/core/src/memory/store.ts`
- Modify: `packages/core/src/memory/index.ts`
- Test: `packages/core/src/memory/store.test.ts`

**Interfaces:**
- Consumes: 现有 `MemoryEntry`, `PersistentMemoryAdapter`（`store.ts`）。
- Produces:
  - `interface SessionMemoryBackend { load(conversationId: string): Promise<MemoryEntry[]>; save(conversationId: string, entries: MemoryEntry[]): Promise<void> }`
  - `AgentMemoryStore` 构造参数新增 `sessionBackend?: SessionMemoryBackend; conversationId?: string`
  - `AgentMemoryStore.hydrate(): Promise<void>`
  - `AgentMemoryStore.deleteUserMemory(key: string): Promise<void>`

- [ ] **Step 1: 写失败测试**

Create `packages/core/src/memory/store.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { AgentMemoryStore } from "./store.js";
import type { SessionMemoryBackend, MemoryEntry } from "./store.js";

class FakeSessionBackend implements SessionMemoryBackend {
  store = new Map<string, MemoryEntry[]>();
  saveCount = 0;
  async load(cid: string): Promise<MemoryEntry[]> {
    return this.store.get(cid) ?? [];
  }
  async save(cid: string, entries: MemoryEntry[]): Promise<void> {
    this.saveCount++;
    this.store.set(cid, entries);
  }
}

describe("AgentMemoryStore session persistence", () => {
  it("session survives across instances sharing backend + conversationId", async () => {
    const backend = new FakeSessionBackend();
    const a = new AgentMemoryStore({ sessionBackend: backend, conversationId: "c1" });
    a.set("session", "pending", "confirm-delete");
    await Promise.resolve();
    const b = new AgentMemoryStore({ sessionBackend: backend, conversationId: "c1" });
    await b.hydrate();
    expect(b.get("session", "pending")).toBe("confirm-delete");
  });

  it("does not leak session across conversations", async () => {
    const backend = new FakeSessionBackend();
    const a = new AgentMemoryStore({ sessionBackend: backend, conversationId: "c1" });
    a.set("session", "k", "v");
    await Promise.resolve();
    const b = new AgentMemoryStore({ sessionBackend: backend, conversationId: "c2" });
    await b.hydrate();
    expect(b.get("session", "k")).toBeUndefined();
  });

  it("ephemeral is not persisted to the backend", async () => {
    const backend = new FakeSessionBackend();
    const a = new AgentMemoryStore({ sessionBackend: backend, conversationId: "c1" });
    a.set("ephemeral", "tmp", "x");
    await Promise.resolve();
    expect(backend.saveCount).toBe(0);
  });

  it("delete on session flushes to backend", async () => {
    const backend = new FakeSessionBackend();
    const a = new AgentMemoryStore({ sessionBackend: backend, conversationId: "c1" });
    a.set("session", "k", "v");
    await Promise.resolve();
    a.delete("session", "k");
    await Promise.resolve();
    const b = new AgentMemoryStore({ sessionBackend: backend, conversationId: "c1" });
    await b.hydrate();
    expect(b.get("session", "k")).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @lot-agent/core -- store.test`
Expected: FAIL（`SessionMemoryBackend` 未导出 / `hydrate` 不存在）。

- [ ] **Step 3: 新建 session-backend.ts**

Create `packages/core/src/memory/session-backend.ts`:

```ts
import type { MemoryEntry } from "./store.js";

/**
 * Backend for persisting the session memory tier across requests,
 * keyed by conversationId. Implemented in server with Redis.
 */
export interface SessionMemoryBackend {
  load(conversationId: string): Promise<MemoryEntry[]>;
  save(conversationId: string, entries: MemoryEntry[]): Promise<void>;
}
```

- [ ] **Step 4: 改 store.ts — 构造、hydrate、write-through、deleteUserMemory**

在 `packages/core/src/memory/store.ts` 顶部 import 区加：

```ts
import type { SessionMemoryBackend } from "./session-backend.js";
```

`re-export` 类型（同文件已 `export type MemoryEntry`，让测试能 `from "./store.js"` 拿到接口）——在文件已有的类型导出附近加一行：

```ts
export type { SessionMemoryBackend } from "./session-backend.js";
```

把 `AgentMemoryStore` 的字段与构造函数替换为：

```ts
  private ephemeral = new InMemoryTier();
  private session = new InMemoryTier();
  private persistent?: PersistentMemoryAdapter;
  private userId?: string;
  private sessionBackend?: SessionMemoryBackend;
  private conversationId?: string;

  constructor(opts?: {
    persistent?: PersistentMemoryAdapter;
    userId?: string;
    sessionBackend?: SessionMemoryBackend;
    conversationId?: string;
  }) {
    this.persistent = opts?.persistent;
    this.userId = opts?.userId;
    this.sessionBackend = opts?.sessionBackend;
    this.conversationId = opts?.conversationId;
  }

  /** Best-effort write-through of the whole session tier to the backend. */
  private flushSession(): void {
    if (!this.sessionBackend || !this.conversationId) return;
    const entries = this.session
      .dump()
      .map((e) => ({ ...e, tier: "session" as const }));
    this.sessionBackend.save(this.conversationId, entries).catch(() => {});
  }

  /** Load persisted session memory for this conversation into the in-memory tier. */
  async hydrate(): Promise<void> {
    if (!this.sessionBackend || !this.conversationId) return;
    const entries = await this.sessionBackend.load(this.conversationId);
    const now = Date.now();
    for (const e of entries) {
      if (e.expiresAt && now > e.expiresAt) continue;
      const ttl = e.expiresAt ? e.expiresAt - now : SESSION_TTL_MS;
      this.session.set(e.key, e.value, e.meta, ttl);
    }
  }
```

在 `set()` 的 `case "session"` 分支末尾加 `this.flushSession();`：

```ts
      case "session":
        this.session.set(key, value, undefined, ttlMs ?? SESSION_TTL_MS);
        this.flushSession();
        break;
```

在 `delete()` 的 `case "session"` 分支末尾加 `this.flushSession();`：

```ts
      case "session":
        this.session.delete(key);
        this.flushSession();
        break;
```

在已有的 `async setUserMemory` 方法之后，新增可靠删除方法：

```ts
  async deleteUserMemory(key: string): Promise<void> {
    if (!this.persistent || !this.userId) return;
    await this.persistent.delete(this.userId, key);
  }
```

- [ ] **Step 5: 导出 session-backend（index.ts）**

在 `packages/core/src/memory/index.ts` 末尾加：

```ts
export type { SessionMemoryBackend } from "./session-backend.js";
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npm test -w @lot-agent/core -- store.test`
Expected: PASS（4 个用例全过）。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/memory/session-backend.ts packages/core/src/memory/store.ts packages/core/src/memory/index.ts packages/core/src/memory/store.test.ts
git commit -m "feat(core): session memory persistence backend + reliable user delete"
```

---

### Task 2: core — 记忆使用策略 prompt + 按工具门控注入

**Files:**
- Create: `packages/core/src/memory/policy.ts`
- Modify: `packages/core/src/memory/index.ts`
- Modify: `packages/core/src/agent/agent.ts`
- Test: `packages/core/src/memory/policy.test.ts`

**Interfaces:**
- Produces:
  - `MEMORY_POLICY_PROMPT: string`
  - `hasMemoryTools(names?: string[]): boolean`（`names` 为 `undefined` 视为「全部工具」→ `true`）

- [ ] **Step 1: 写失败测试**

Create `packages/core/src/memory/policy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { MEMORY_POLICY_PROMPT, hasMemoryTools } from "./policy.js";

describe("hasMemoryTools", () => {
  it("true when undefined (all tools allowed)", () => {
    expect(hasMemoryTools(undefined)).toBe(true);
  });
  it("true when a memory tool is whitelisted", () => {
    expect(hasMemoryTools(["web_fetch", "memory_write"])).toBe(true);
  });
  it("false when no memory tool present", () => {
    expect(hasMemoryTools(["web_fetch", "create_document"])).toBe(false);
  });
  it("false for an empty whitelist", () => {
    expect(hasMemoryTools([])).toBe(false);
  });
});

describe("MEMORY_POLICY_PROMPT", () => {
  it("mentions all three tiers and the delete tool", () => {
    expect(MEMORY_POLICY_PROMPT).toContain("user");
    expect(MEMORY_POLICY_PROMPT).toContain("session");
    expect(MEMORY_POLICY_PROMPT).toContain("ephemeral");
    expect(MEMORY_POLICY_PROMPT).toContain("memory_delete");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @lot-agent/core -- policy.test`
Expected: FAIL（`./policy.js` 不存在）。

- [ ] **Step 3: 新建 policy.ts**

Create `packages/core/src/memory/policy.ts`:

```ts
/** Tool names that indicate an agent can use the memory system. */
const MEMORY_TOOL_NAMES = [
  "memory_read",
  "memory_write",
  "memory_list",
  "memory_delete",
];

/**
 * Whether the agent's tool whitelist grants access to memory tools.
 * `undefined` means "all tools allowed" → true.
 */
export function hasMemoryTools(names?: string[]): boolean {
  if (!names) return true;
  return names.some((n) => MEMORY_TOOL_NAMES.includes(n));
}

/** Strategy block injected into the system prompt for memory-capable agents. */
export const MEMORY_POLICY_PROMPT = `[记忆使用策略]
你有三层记忆，通过 memory_read / memory_write / memory_list / memory_delete 工具访问：
- user（持久）：写入跨会话长期有效的用户事实与稳定偏好，例如称呼、语言偏好、行业/品牌背景、长期约束。仅在用户明确表达或可稳妥推断的稳定信息时写入；不要写一次性请求、临时上下文或敏感信息（密码、支付信息）。
- session（会话）：写入仅在当前对话内有用的状态，例如待确认事项、当前任务的中间决定。20 分钟无活动后过期。
- ephemeral（工作）：单次回合内的临时中间结果，无需手动管理。

规则：
1. 写入前先用 memory_list 或 memory_read 查看，避免重复；同一事实用相同 key 覆盖更新，不要堆积近义条目。
2. 当用户更正信息、偏好变化或某条记忆明显过时，用 memory_write 覆盖或 memory_delete 删除，保持记忆精炼、无矛盾。
3. user 记忆的 key 用稳定的英文 snake_case（如 preferred_language、brand_name）。
4. 不要为了写而写：没有长期价值的内容不要进入 user。`;
```

- [ ] **Step 4: 导出（index.ts）**

在 `packages/core/src/memory/index.ts` 末尾加：

```ts
export { MEMORY_POLICY_PROMPT, hasMemoryTools } from "./policy.js";
```

- [ ] **Step 5: 在 agent.ts 注入（门控）**

在 `packages/core/src/agent/agent.ts` 顶部 import 区加：

```ts
import { hasMemoryTools, MEMORY_POLICY_PROMPT } from "../memory/policy.js";
```

在 `run()` 内、`// Inject memory into system prompt` 之前（即 `if (context.memory) {` 块上方），插入门控注入：

```ts
    // Inject memory usage policy when this agent can use memory tools
    if (context.memory && hasMemoryTools(this.config.allowedToolNames)) {
      systemParts.push(MEMORY_POLICY_PROMPT);
    }

```

- [ ] **Step 6: 运行测试 + 构建确认通过**

Run: `npm test -w @lot-agent/core -- policy.test && npm run build -w @lot-agent/core`
Expected: 测试 PASS；core 构建成功（注入处类型正确）。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/memory/policy.ts packages/core/src/memory/policy.test.ts packages/core/src/memory/index.ts packages/core/src/agent/agent.ts
git commit -m "feat(core): memory usage policy prompt, gated on memory-tool access"
```

---

### Task 3: core — memory_delete 工具

**Files:**
- Modify: `packages/core/src/tools/memory-tools.ts`
- Test: `packages/core/src/tools/memory-tools.test.ts`

**Interfaces:**
- Consumes: `AgentMemoryStore.deleteUserMemory()`（Task 1）、`AgentMemoryStore.delete()`（现有）。
- Produces: `createMemoryTools()` 返回 `[memory_read, memory_write, memory_list, memory_delete]`。

- [ ] **Step 1: 写失败测试**

Create `packages/core/src/tools/memory-tools.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createMemoryTools } from "./memory-tools.js";
import { AgentMemoryStore } from "../memory/store.js";
import type { PersistentMemoryAdapter, MemoryEntry } from "../memory/store.js";
import type { ToolContext } from "../types/index.js";

class FakePersistent implements PersistentMemoryAdapter {
  store = new Map<string, string>();
  async get(u: string, k: string) { return this.store.get(`${u}:${k}`); }
  async set(u: string, k: string, v: string) { this.store.set(`${u}:${k}`, v); }
  async delete(u: string, k: string) { this.store.delete(`${u}:${k}`); }
  async list(): Promise<MemoryEntry[]> { return []; }
  async search(): Promise<MemoryEntry[]> { return []; }
}

const tool = (name: string) => createMemoryTools().find((t) => t.name === name)!;

describe("memory_delete tool", () => {
  it("registers four memory tools in order", () => {
    expect(createMemoryTools().map((t) => t.name)).toEqual([
      "memory_read",
      "memory_write",
      "memory_list",
      "memory_delete",
    ]);
  });

  it("deletes user memory via the await path", async () => {
    const persistent = new FakePersistent();
    const memory = new AgentMemoryStore({ persistent, userId: "u1" });
    await memory.setUserMemory("brand_name", "Acme");
    const ctx: ToolContext = { workingDirectory: "/", memory };
    const res = await tool("memory_delete").execute({ tier: "user", key: "brand_name" }, ctx);
    expect(res.content).toContain("brand_name");
    expect(await memory.getUserMemory("brand_name")).toBeUndefined();
  });

  it("deletes session memory", async () => {
    const memory = new AgentMemoryStore({});
    memory.set("session", "pending", "x");
    const ctx: ToolContext = { workingDirectory: "/", memory };
    await tool("memory_delete").execute({ tier: "session", key: "pending" }, ctx);
    expect(memory.get("session", "pending")).toBeUndefined();
  });

  it("errors when memory is unavailable", async () => {
    const ctx = { workingDirectory: "/" } as ToolContext;
    const res = await tool("memory_delete").execute({ tier: "user", key: "k" }, ctx);
    expect(res.isError).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @lot-agent/core -- memory-tools.test`
Expected: FAIL（只注册 3 个工具，`memory_delete` 不存在）。

- [ ] **Step 3: 添加 memory_delete 工具**

在 `packages/core/src/tools/memory-tools.ts` 的 `memoryList` 定义之后、`return [...]` 之前，新增：

```ts
  const memoryDelete: Tool = {
    name: "memory_delete",
    description:
      "Delete a value from memory by key. Use when a stored fact is outdated, corrected by the user, or no longer relevant.",
    parameters: {
      type: "object",
      properties: {
        tier: {
          type: "string",
          enum: ["ephemeral", "session", "user"],
          description: "Memory tier to delete from",
        },
        key: {
          type: "string",
          description: "The memory key to delete",
        },
      },
      required: ["tier", "key"],
    },
    async execute(input, context: ToolContext): Promise<ToolResult> {
      const memory = context.memory;
      if (!memory) return { content: "Memory not available", isError: true };
      const { tier, key } = input as { tier: string; key: string };
      if (tier === "user") {
        await memory.deleteUserMemory(key);
        return { content: `Deleted from user memory: ${key}` };
      }
      memory.delete(tier as "ephemeral" | "session", key);
      return { content: `Deleted from ${tier} memory: ${key}` };
    },
  };
```

把返回语句改为：

```ts
  return [memoryRead, memoryWrite, memoryList, memoryDelete];
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @lot-agent/core -- memory-tools.test`
Expected: PASS（4 个用例全过）。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/tools/memory-tools.ts packages/core/src/tools/memory-tools.test.ts
git commit -m "feat(core): memory_delete tool for cleaning stale memory"
```

---

### Task 4: server — RedisSessionBackend

**Files:**
- Create: `packages/server/src/memory/redis-session-backend.ts`
- Test: `packages/server/src/memory/redis-session-backend.test.ts`

**Interfaces:**
- Consumes: `SessionMemoryBackend`, `MemoryEntry`（`@lot-agent/core`，Task 1）。
- Produces: `class RedisSessionBackend implements SessionMemoryBackend`，构造 `new RedisSessionBackend(redis: Redis)`。

- [ ] **Step 1: 写失败测试**

Create `packages/server/src/memory/redis-session-backend.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { RedisSessionBackend } from "./redis-session-backend.js";
import type { MemoryEntry } from "@lot-agent/core";

class FakeRedis {
  store = new Map<string, string>();
  lastSet?: { key: string; mode: string; ttl: number };
  async get(key: string) { return this.store.get(key) ?? null; }
  async set(key: string, val: string, mode: string, ttl: number) {
    this.lastSet = { key, mode, ttl };
    this.store.set(key, val);
    return "OK";
  }
  async del(key: string) { this.store.delete(key); return 1; }
}

const entry = (key: string, value: string): MemoryEntry => ({
  key,
  value,
  tier: "session",
  createdAt: Date.now(),
});

describe("RedisSessionBackend", () => {
  it("round-trips entries under a conversation key with 20min TTL", async () => {
    const redis = new FakeRedis();
    const backend = new RedisSessionBackend(redis as never);
    await backend.save("c1", [entry("pending", "confirm")]);
    expect(redis.lastSet).toEqual({ key: "mem:session:c1", mode: "EX", ttl: 1200 });
    const loaded = await backend.load("c1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].value).toBe("confirm");
  });

  it("returns [] for a missing conversation", async () => {
    const backend = new RedisSessionBackend(new FakeRedis() as never);
    expect(await backend.load("nope")).toEqual([]);
  });

  it("deletes the key when saving empty entries", async () => {
    const redis = new FakeRedis();
    const backend = new RedisSessionBackend(redis as never);
    redis.store.set("mem:session:c1", "[]");
    await backend.save("c1", []);
    expect(redis.store.has("mem:session:c1")).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @lot-agent/server -- redis-session-backend.test`
Expected: FAIL（`./redis-session-backend.js` 不存在）。

- [ ] **Step 3: 实现 RedisSessionBackend**

Create `packages/server/src/memory/redis-session-backend.ts`:

```ts
import type Redis from "ioredis";
import type { SessionMemoryBackend, MemoryEntry } from "@lot-agent/core";

const SESSION_TTL_SEC = 20 * 60; // 20 minutes
const keyFor = (conversationId: string) => `mem:session:${conversationId}`;

/**
 * Redis-backed session memory tier, keyed per conversation.
 * The whole tier is serialized to one JSON value; TTL refreshes on each save.
 */
export class RedisSessionBackend implements SessionMemoryBackend {
  constructor(private readonly redis: Redis) {}

  async load(conversationId: string): Promise<MemoryEntry[]> {
    const raw = await this.redis.get(keyFor(conversationId));
    if (!raw) return [];
    try {
      return JSON.parse(raw) as MemoryEntry[];
    } catch {
      return [];
    }
  }

  async save(conversationId: string, entries: MemoryEntry[]): Promise<void> {
    const key = keyFor(conversationId);
    if (entries.length === 0) {
      await this.redis.del(key);
      return;
    }
    await this.redis.set(key, JSON.stringify(entries), "EX", SESSION_TTL_SEC);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @lot-agent/server -- redis-session-backend.test`
Expected: PASS（3 个用例全过）。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/memory/redis-session-backend.ts packages/server/src/memory/redis-session-backend.test.ts
git commit -m "feat(server): Redis-backed session memory backend"
```

---

### Task 5: server — 接入 AgentService + 修复 /session/dump

**Files:**
- Modify: `packages/server/src/services/agent-service.ts`
- Modify: `packages/server/src/routes/memory.ts`

**Interfaces:**
- Consumes: `RedisSessionBackend`（Task 4）、`AgentMemoryStore.hydrate()`（Task 1）、`getRedis()`（`packages/server/src/jobs/redis.ts`，现有）。
- Produces: `AgentService.sessionBackend: RedisSessionBackend`（public 字段，供 route 使用）。

- [ ] **Step 1: AgentService 增加 sessionBackend 字段并在 init 创建**

在 `packages/server/src/services/agent-service.ts` 顶部 import 区加：

```ts
import { RedisSessionBackend } from "../memory/redis-session-backend.js";
import { getRedis } from "../jobs/redis.js";
```

在类字段区（`pgAdapter!` 声明附近）加：

```ts
  /** Redis-backed session memory backend — shared; per-request stores reference it */
  sessionBackend!: RedisSessionBackend;
```

在 `init()` 中、`this.pgAdapter = pgAdapter;` 之后加：

```ts
    // Session memory backend (Redis, per-conversation, 20min TTL)
    this.sessionBackend = new RedisSessionBackend(getRedis());
```

- [ ] **Step 2: streamAgentResponse 构造 memory 时接入 + hydrate**

在 `packages/server/src/services/agent-service.ts` 的 `streamAgentResponse` 内，把现有的

```ts
    const memory = new AgentMemoryStore({
      persistent: this.pgAdapter,
      userId: userId ?? "default",
    });
```

替换为：

```ts
    const memory = new AgentMemoryStore({
      persistent: this.pgAdapter,
      userId: userId ?? "default",
      sessionBackend: this.sessionBackend,
      conversationId,
    });
    // Load this conversation's persisted session memory before the run
    await memory.hydrate();
```

- [ ] **Step 3: 修复 routes/memory.ts 的 /session/dump（按 conversationId hydrate）**

在 `packages/server/src/routes/memory.ts` 中，把现有的同步 `/session/dump` 处理器

```ts
  // Get session memory (read-only)
  app.get("/session/dump", (c) => {
    const memory = getMemory(c.get("userId"));
    const entries = memory.dump("session");
    return c.json(entries);
  });
```

替换为：

```ts
  // Get session memory for a conversation (read-only)
  app.get("/session/dump", async (c) => {
    const conversationId = c.req.query("conversationId");
    if (!conversationId) return c.json([]);
    const memory = new AgentMemoryStore({
      sessionBackend: service.sessionBackend,
      conversationId,
    });
    await memory.hydrate();
    return c.json(memory.dump("session"));
  });
```

- [ ] **Step 4: 构建 + 全量测试确认通过**

Run: `npm run build -w @lot-agent/core && npm run build -w @lot-agent/server && npm test`
Expected: 两个 build 成功；全部 Vitest 套件 PASS（含 Task 1–4 新增用例，无回归）。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/services/agent-service.ts packages/server/src/routes/memory.ts
git commit -m "feat(server): wire Redis session memory into agent flow + fix /session/dump"
```

---

## 手动冒烟（可选，需 Redis + LLM key）

1. `npm run dev`，登录后在同一会话连续发两条消息：第一条让助手「记住我叫小明，偏好简体中文」。
2. 期望：助手调用 `memory_write`（user: 称呼/语言），后续新会话仍能在 system prompt 的 `[User Memory]` 看到。
3. 同会话内告知一个临时待确认项 → 期望写入 session；`GET /api/memory/session/dump?conversationId=<id>` 能看到该条；20 分钟后过期。
4. 让助手「忘掉我的称呼」→ 期望调用 `memory_delete`，`GET /api/memory` 不再包含该 key。

## Self-Review

- **Spec coverage：** session 跨轮持久化 → Task 1(store)+4(redis)+5(wiring)；策略 prompt → Task 2；memory_delete + 可靠删除 → Task 3(tool)+1(deleteUserMemory)；`/session/dump` 清理 → Task 5。全覆盖。
- **Placeholder scan：** 无 TBD/TODO；所有代码步骤给出完整代码。
- **Type consistency：** `SessionMemoryBackend.{load,save}` 签名跨 Task 1/4 一致；`hydrate()`/`deleteUserMemory()`/`hasMemoryTools()`/`MEMORY_POLICY_PROMPT` 定义处与使用处名称一致；`RedisSessionBackend(redis)` 构造与接入处一致。
