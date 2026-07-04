# 多 API-Key 选择 + 无模型态 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 登录解析 `api_keys` 数组，加入用户名旁的 key 切换设置弹窗（单选、遮罩），并在无 key/无模型时进入「暂无模型」态。

**Architecture:** 后端 tokenhub 客户端解析 `api_keys`，`users` 表新增 `api_keys JSONB` 存全量 key、`api_key` 存激活 key；原始 key 仅经 `toPublicUser` 遮罩后出网，前端按 index 切换，新端点 `POST /api/keys/active` 改激活 key 并清 Redis 目录缓存。无 key 时 `/api/models` 返回 200 空目录（不再 401，避免误登出），前端据空目录展示「暂无模型」并在发送时拦截。

**Tech Stack:** TypeScript (ESM, `.js` 后缀), Hono, PostgreSQL(`pg`, JSONB), ioredis, React 19 + Vite, Vitest。

## Global Constraints

- ESM 导入必须带显式 `.js` 后缀；2 空格缩进。
- **绝不把原始 api_key/email 发给前端**；`toPublicUser` 是 user→client 的唯一出口，遮罩在此完成。
- 迁移内联在 `db/database.ts` `migrate()`，用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`。
- NUMERIC/JSONB 由 pg 返回：JSONB 已解析为 JS 值，无需再 `JSON.parse`。
- Web 颜色一律走 `var(--*)` token，禁止硬编码 hex/rgba。
- 遮罩规则（唯一实现，勿复制多份）：`key.length <= 12 ? "***" : key.slice(0,6) + "***" + key.slice(-4)`。
- 无模型内联提示文案（逐字）：`暂无能使用模型，请前往订阅管理页面设置 api-key 和 key 能访问的模型`。
- 模型选择器空态文案（逐字）：触发按钮 `暂无模型`；弹层 `暂无模型，请前往订阅管理页面设置`。
- 后端 DB 方法（`database.ts`）在本仓库无 live-pg 单测，按既有惯例不新增 DB 集成测试，改由路由层用 mock db 覆盖。
- Web 包无 jsdom/testing-library，组件无自动化测试；前端任务以 `npm run build -w @lot-agent/web`（tsc+vite）通过 + 手动验证为门槛。

---

### Task 1: tokenhub 客户端解析 `api_keys`

**Files:**
- Modify: `packages/server/src/tokenhub/client.ts`
- Test: `packages/server/src/tokenhub/client.test.ts`

**Interfaces:**
- Produces: `TokenhubLoginResult = { userId: number; name: string; apiKeys: string[] }`；`TokenhubClient.login(username, password): Promise<TokenhubLoginResult>`。

- [ ] **Step 1: 更新既有测试 + 新增解析用例（先失败）**

把 `client.test.ts` 里第一个 `login` 用例的断言由 `apiKey` 改为 `apiKeys`，并新增回落/空两种用例：

```ts
  it("login maps api_keys array", async () => {
    const f = vi.fn().mockResolvedValue(
      ok({ user_id: 2, name: "138", api_key: "sk-A", api_keys: ["sk-A", "sk-B"], access_token: "sk-A" })
    );
    const c = new TokenhubClient("https://h/api/agent-market", f as unknown as typeof fetch);
    await expect(c.login("138", "pw")).resolves.toEqual({
      userId: 2, name: "138", apiKeys: ["sk-A", "sk-B"],
    });
  });

  it("login falls back to [api_key] when api_keys absent", async () => {
    const f = vi.fn().mockResolvedValue(ok({ user_id: 2, name: "138", api_key: "sk-A" }));
    const c = new TokenhubClient("https://h/api/agent-market", f as unknown as typeof fetch);
    await expect(c.login("138", "pw")).resolves.toEqual({ userId: 2, name: "138", apiKeys: ["sk-A"] });
  });

  it("login yields [] when neither api_keys nor api_key present", async () => {
    const f = vi.fn().mockResolvedValue(ok({ user_id: 2, name: "138" }));
    const c = new TokenhubClient("https://h/api/agent-market", f as unknown as typeof fetch);
    await expect(c.login("138", "pw")).resolves.toEqual({ userId: 2, name: "138", apiKeys: [] });
  });
```

同时把原「login maps a successful response」用例的 `.resolves.toEqual({ userId: 2, name: "13881071870", apiKey: "sk-X" })` 改成 `apiKeys: ["sk-X"]`（该 mock 只含 `api_key: "sk-X"`）。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @lot-agent/server -- tokenhub/client.test.ts`
Expected: FAIL（返回值仍含 `apiKey`，无 `apiKeys`）。

- [ ] **Step 3: 实现解析**

在 `client.ts` 中：

```ts
export interface TokenhubLoginResult {
  userId: number;
  name: string;
  apiKeys: string[];
}
```

`login` 改为：

```ts
  async login(username: string, password: string): Promise<TokenhubLoginResult> {
    const data = await this.post<{
      user_id: number;
      name: string;
      api_key?: string;
      api_keys?: string[];
    }>("/auth/login", { username, password }, "tokenhub_login_failed");
    const apiKeys = data.api_keys ?? (data.api_key ? [data.api_key] : []);
    return { userId: data.user_id, name: data.name, apiKeys };
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @lot-agent/server -- tokenhub/client.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/tokenhub/client.ts packages/server/src/tokenhub/client.test.ts
git commit -m "feat(server): tokenhub login 解析 api_keys 数组"
```

---

### Task 2: DB 层 — `api_keys` 列 + upsert + 取列表 + 切换激活

**Files:**
- Modify: `packages/server/src/db/database.ts`（迁移块 ~L456、`StoredUser` ~L123、`upsertUserByExternalId` ~L1008、追加两方法）

**Interfaces:**
- Consumes: `TokenhubLoginResult.apiKeys`（Task 1）。
- Produces:
  - `StoredUser.api_keys?: string[] | null`
  - `upsertUserByExternalId(args: { externalUserId: number; username: string; apiKeys: string[] }): Promise<StoredUser>`（**签名变更**：原 `apiKey: string` → `apiKeys: string[]`）
  - `getUserApiKeys(userId: string): Promise<string[]>`
  - `setActiveApiKey(userId: string, index: number): Promise<string>`（越界抛 `Error("index_out_of_range")`）

- [ ] **Step 1: 迁移新增 `api_keys` 列**

在 `migrate()` 的 users `ALTER` 块（`ADD COLUMN IF NOT EXISTS api_key TEXT;` 之后）追加：

```sql
        ALTER TABLE users ADD COLUMN IF NOT EXISTS api_keys JSONB;
```

- [ ] **Step 2: `StoredUser` 加字段**

```ts
export interface StoredUser {
  id: string;
  email: string | null;
  name: string | null;
  created_at: string;
  external_user_id?: number | null;
  username?: string | null;
  api_key?: string | null;
  api_keys?: string[] | null;
}
```

- [ ] **Step 3: 改 `upsertUserByExternalId` 签名与写入**

```ts
  async upsertUserByExternalId(args: {
    externalUserId: number;
    username: string;
    apiKeys: string[];
  }): Promise<StoredUser> {
    const active = args.apiKeys[0] ?? null;
    const { rows } = await this.pool.query(
      `INSERT INTO users (external_user_id, username, name, api_key, api_keys, email)
         VALUES ($1, $2, $2, $3, $4, $5)
       ON CONFLICT (external_user_id)
         DO UPDATE SET username = $2, api_key = $3, api_keys = $4
       RETURNING *`,
      [args.externalUserId, args.username, active, JSON.stringify(args.apiKeys), `${args.username}@tokenhub.local`]
    );
    return rows[0];
  }
```

- [ ] **Step 4: 追加 `getUserApiKeys` 与 `setActiveApiKey`**

紧随 `getUserApiKey`（~L1024）之后追加：

```ts
  async getUserApiKeys(userId: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      "SELECT api_keys FROM users WHERE id = $1",
      [userId]
    );
    const keys = rows[0]?.api_keys;
    return Array.isArray(keys) ? keys : [];
  }

  async setActiveApiKey(userId: string, index: number): Promise<string> {
    const keys = await this.getUserApiKeys(userId);
    if (!Number.isInteger(index) || index < 0 || index >= keys.length) {
      throw new Error("index_out_of_range");
    }
    const active = keys[index];
    await this.pool.query("UPDATE users SET api_key = $1 WHERE id = $2", [active, userId]);
    return active;
  }
```

- [ ] **Step 5: 类型检查**

Run: `npm run build -w @lot-agent/server`
Expected: 编译失败，仅剩 `routes/auth.ts` 里 `upsertUserByExternalId({ ..., apiKey })` 旧调用点报错（Task 4 修复）。确认 `database.ts` 本身无错。

> 说明：本仓库 `database.ts` 无 live-pg 单测，故不新增 DB 集成测试；`setActiveApiKey` 的越界/成功路径由 Task 6 的路由测试通过 mock 覆盖。

- [ ] **Step 6: 提交**

```bash
git add packages/server/src/db/database.ts
git commit -m "feat(server): users.api_keys 列 + getUserApiKeys/setActiveApiKey + upsert 签名改 apiKeys"
```

---

### Task 3: `toPublicUser` 遮罩 + 激活索引

**Files:**
- Modify: `packages/server/src/db/user-sanitize.ts`
- Test: `packages/server/src/db/user-sanitize.test.ts`

**Interfaces:**
- Consumes: `StoredUser.api_keys`, `StoredUser.api_key`（Task 2）。
- Produces: `PublicUser = { id; name; username: string | null; apiKeys: string[]; activeKeyIndex: number }`；`maskKey(key: string): string`（导出，供测试）。

- [ ] **Step 1: 写失败测试**

替换/扩充 `user-sanitize.test.ts`，覆盖遮罩、激活索引、无 key(-1)、api_key 不在列表(-1)、不泄露原始 key：

```ts
import { describe, it, expect } from "vitest";
import { toPublicUser, maskKey } from "./user-sanitize.js";
import type { StoredUser } from "./database.js";

const base: StoredUser = {
  id: "u1", email: "e@x", name: "138", created_at: "t",
  external_user_id: 2, username: "138", api_key: null, api_keys: null,
};

describe("maskKey", () => {
  it("masks the middle of a long key", () => {
    expect(maskKey("sk-7kLcT3xuy7mcxId5X5jemZUrwKnTv15WB3unKkApNNtx5Uir")).toBe("sk-7kL***5Uir");
  });
  it("fully masks short keys", () => {
    expect(maskKey("sk-abc")).toBe("***");
  });
});

describe("toPublicUser", () => {
  it("returns masked keys + active index, never the raw key or email", () => {
    const u = { ...base, api_key: "sk-BBBBBBBBBBBBBB", api_keys: ["sk-AAAAAAAAAAAAAA", "sk-BBBBBBBBBBBBBB"] };
    const pub = toPublicUser(u);
    expect(pub).toEqual({
      id: "u1", name: "138", username: "138",
      apiKeys: ["sk-AAA***AAAA", "sk-BBB***BBBB"],
      activeKeyIndex: 1,
    });
    expect(JSON.stringify(pub)).not.toContain("sk-BBBBBBBBBBBBBB");
    expect(JSON.stringify(pub)).not.toContain("e@x");
  });
  it("activeKeyIndex is -1 when there is no key", () => {
    expect(toPublicUser(base)).toMatchObject({ apiKeys: [], activeKeyIndex: -1 });
  });
  it("activeKeyIndex is -1 when api_key is not in the list", () => {
    const u = { ...base, api_key: "sk-ZZZZZZZZZZZZZZ", api_keys: ["sk-AAAAAAAAAAAAAA"] };
    expect(toPublicUser(u).activeKeyIndex).toBe(-1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @lot-agent/server -- db/user-sanitize.test.ts`
Expected: FAIL（`maskKey` 未导出 / `apiKeys` 字段不存在）。

- [ ] **Step 3: 实现**

```ts
import type { StoredUser } from "./database.js";

export interface PublicUser {
  id: string;
  name: string;
  username: string | null;
  apiKeys: string[];
  activeKeyIndex: number;
}

/** 中间遮罩：保留前 6、后 4，其余用 ***；过短(<=12)整体遮罩。 */
export function maskKey(key: string): string {
  return key.length <= 12 ? "***" : `${key.slice(0, 6)}***${key.slice(-4)}`;
}

/** Never send api_key/email to the client. Single choke point for user->client. */
export function toPublicUser(u: StoredUser): PublicUser {
  const keys = Array.isArray(u.api_keys) ? u.api_keys : [];
  return {
    id: u.id,
    name: u.name ?? u.username ?? "",
    username: u.username ?? null,
    apiKeys: keys.map(maskKey),
    activeKeyIndex: u.api_key ? keys.indexOf(u.api_key) : -1,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @lot-agent/server -- db/user-sanitize.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/db/user-sanitize.ts packages/server/src/db/user-sanitize.test.ts
git commit -m "feat(server): toPublicUser 输出遮罩 key 列表 + activeKeyIndex"
```

---

### Task 4: 登录路由 — 允许无 key 登录，改用 `apiKeys`

**Files:**
- Modify: `packages/server/src/routes/auth.ts`
- Test: `packages/server/src/routes/auth.test.ts`

**Interfaces:**
- Consumes: `TokenhubLoginResult.apiKeys`（Task 1）、`upsertUserByExternalId({ ..., apiKeys })`（Task 2）、`toPublicUser`（Task 3）。

- [ ] **Step 1: 改测试（先失败）**

在 `auth.test.ts`：
1. 第一个用例的 tokenhub mock `{ userId: 2, name: "138", apiKey: "sk-SECRET" }` → `{ userId: 2, name: "138", apiKeys: ["sk-SECRET"] }`；upsert mock 结果加 `api_keys: ["sk-SECRET"]`；`json.user` 断言改为：

```ts
    expect(json.user).toEqual({
      id: "u1", name: "138", username: "138",
      apiKeys: ["sk-SEC***CRET"], activeKeyIndex: 0,
    });
```

（注：`maskKey("sk-SECRET")` — 长度 9 ≤ 12 → `"***"`；请把 mock 的 key 换成足够长的 `"sk-SECRETSECRET"`，长度 15 → `"sk-SEC***CRET"`，两处 `api_key`/`api_keys` 同步为该值，并保留 `not.toContain("sk-SECRETSECRET")`。）

2. 把「fails with a create-api-key message when tokenhub returns an empty api_key」用例整体替换为「允许无 key 登录」：

```ts
  it("allows login when the account has no api key (empty apiKeys)", async () => {
    const svc = fakeService();
    (svc.tokenhub.login as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 2, name: "138", apiKeys: [],
    });
    (svc.db.upsertUserByExternalId as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "u1", email: null, name: "138", created_at: "t",
      external_user_id: 2, username: "138", api_key: null, api_keys: [],
    });
    const app = createAuthRoutes(svc);
    const encryptedPassword = await encryptFor(app, "pw");
    const res = await app.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "138", encryptedPassword }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.token).toBe("tok-1");
    expect(json.user).toMatchObject({ apiKeys: [], activeKeyIndex: -1 });
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @lot-agent/server -- routes/auth.test.ts`
Expected: FAIL（现路由仍读 `result.apiKey` 并对空 key 返回 400）。

- [ ] **Step 3: 实现**

在 `auth.ts`：删除 `NO_API_KEY` 常量与 `if (!result.apiKey) { return c.json({ error: NO_API_KEY }, 400); }` 整段；`login` 处理体改为：

```ts
      const password = keypair.decrypt(encryptedPassword);
      const result = await service.tokenhub.login(username, password);
      const user = await service.db.upsertUserByExternalId({
        externalUserId: result.userId,
        username: result.name,
        apiKeys: result.apiKeys,
      });
      const token = await service.sessions.createSession(user.id);
      return c.json({ token, user: toPublicUser(user) });
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @lot-agent/server -- routes/auth.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/routes/auth.ts packages/server/src/routes/auth.test.ts
git commit -m "feat(server): 允许无 api-key 登录，登录改用 apiKeys 数组"
```

---

### Task 5: `/api/models` 无 key 返回 200 空目录

**Files:**
- Modify: `packages/server/src/routes/models.ts`
- Test: `packages/server/src/routes/models.test.ts`

**Interfaces:**
- Consumes: `AgentService.getUserModelCatalog`（无 key → null）。

- [ ] **Step 1: 写失败测试**

在 `models.test.ts` 追加（`svc` 里 `getUserApiKey` 返回 null 时目录为 null → 期望 200 空）：

```ts
  it("returns an empty catalog (200) when the user has no api key", async () => {
    const service = {
      redis: { get: vi.fn().mockResolvedValue(null), set: vi.fn() },
      db: { getUserApiKey: vi.fn().mockResolvedValue(null) },
      tokenhub: { listModels: vi.fn() },
      getUserModelCatalog: AgentService.prototype.getUserModelCatalog,
      modelCatalog: {} as never,
    } as unknown as import("../services/agent-service.js").AgentService;
    const res = await mount(service).request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ llm: [], image: [], video: [] });
    expect(service.tokenhub.listModels).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @lot-agent/server -- routes/models.test.ts`
Expected: FAIL（当前无 key 返回 401）。

- [ ] **Step 3: 实现**

`models.ts` 中把 `if (!catalog) return c.json({ error: "no api key" }, 401);` 改为：

```ts
    if (!catalog) return c.json({ llm: [], image: [], video: [] });
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @lot-agent/server -- routes/models.test.ts`
Expected: PASS（含既有两用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/routes/models.ts packages/server/src/routes/models.test.ts
git commit -m "fix(server): 无 api-key 时 /api/models 返回 200 空目录，避免前端误登出"
```

---

### Task 6: 切换激活 key 端点 `POST /api/keys/active`

**Files:**
- Create: `packages/server/src/routes/keys.ts`
- Create: `packages/server/src/routes/keys.test.ts`
- Modify: `packages/server/src/index.ts`（挂载 + authMw）

**Interfaces:**
- Consumes: `db.setActiveApiKey(userId, index)`（Task 2）、`service.redis.del(key)`。
- Produces: `createKeyRoutes(service): Hono<{ Variables: { userId: string } }>`；`POST /active { index } → { ok: true, activeKeyIndex }`。

- [ ] **Step 1: 写失败测试**

`keys.test.ts`（仿 `models.test.ts` 的 mock + userId 注入）：

```ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createKeyRoutes } from "./keys.js";

function svc(setActive: ReturnType<typeof vi.fn>) {
  return {
    db: { setActiveApiKey: setActive },
    redis: { del: vi.fn().mockResolvedValue(1) },
  } as unknown as import("../services/agent-service.js").AgentService;
}
function mount(service: import("../services/agent-service.js").AgentService) {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
  app.route("/", createKeyRoutes(service));
  return app;
}
const post = (app: ReturnType<typeof mount>, body: unknown) =>
  app.request("/active", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("POST /api/keys/active", () => {
  it("switches active key and clears the model cache", async () => {
    const setActive = vi.fn().mockResolvedValue("sk-B");
    const service = svc(setActive);
    const res = await post(mount(service), { index: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, activeKeyIndex: 1 });
    expect(setActive).toHaveBeenCalledWith("u1", 1);
    expect(service.redis.del).toHaveBeenCalledWith("models:u1");
  });

  it("returns 400 when the index is out of range", async () => {
    const setActive = vi.fn().mockRejectedValue(new Error("index_out_of_range"));
    const res = await post(mount(svc(setActive)), { index: 9 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("无效的 key");
  });

  it("returns 400 when index is missing/not a number", async () => {
    const setActive = vi.fn();
    const res = await post(mount(svc(setActive)), {});
    expect(res.status).toBe(400);
    expect(setActive).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @lot-agent/server -- routes/keys.test.ts`
Expected: FAIL（`./keys.js` 不存在）。

- [ ] **Step 3: 实现路由**

`packages/server/src/routes/keys.ts`：

```ts
import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";

type Variables = { userId: string };

/** POST /active { index } — 切换当前用户的激活 api-key（按 index），
 * 并清掉 Redis 模型目录缓存，使下次 GET /api/models 用新 key 重新拉取。 */
export function createKeyRoutes(service: AgentService): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.post("/active", async (c) => {
    const userId = c.get("userId");
    let body: { index?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "无效的 key" }, 400);
    }
    const index = body.index;
    if (typeof index !== "number" || !Number.isInteger(index)) {
      return c.json({ error: "无效的 key" }, 400);
    }
    try {
      await service.db.setActiveApiKey(userId, index);
    } catch {
      return c.json({ error: "无效的 key" }, 400);
    }
    await service.redis.del(`models:${userId}`);
    return c.json({ ok: true, activeKeyIndex: index });
  });

  return app;
}
```

- [ ] **Step 4: 挂载路由 + authMw**

`index.ts`：`import { createKeyRoutes } from "./routes/keys.js";`（与其它 route import 同处）；在 `app.use("/api/models/*", authMw);` 附近加 `app.use("/api/keys/*", authMw);`；在 `app.route("/api/models", createModelRoutes(service));` 附近加 `app.route("/api/keys", createKeyRoutes(service));`。

- [ ] **Step 5: 运行测试 + 全量 server 测试确认通过**

Run: `npm test -w @lot-agent/server -- routes/keys.test.ts`
Expected: PASS。
Run: `npm test -w @lot-agent/server`
Expected: 全绿（Task 1/3/4/5 改动一并回归）。

- [ ] **Step 6: 提交**

```bash
git add packages/server/src/routes/keys.ts packages/server/src/routes/keys.test.ts packages/server/src/index.ts
git commit -m "feat(server): POST /api/keys/active 切换激活 key + 清目录缓存"
```

---

### Task 7: 前端 API 客户端 + `User` 类型

**Files:**
- Modify: `packages/web/src/api/client.ts`（`User` 接口 ~L66、`api` 对象 ~L158）

**Interfaces:**
- Produces: `User` 增 `apiKeys: string[]; activeKeyIndex: number`；`api.setActiveKey(index: number): Promise<{ ok: boolean; activeKeyIndex: number }>`。

- [ ] **Step 1: 扩展 `User` 类型**

```ts
export interface User {
  id: string;
  name: string;
  username: string | null;
  apiKeys: string[];
  activeKeyIndex: number;
}
```

- [ ] **Step 2: 加 `setActiveKey`**

在 `api` 对象 Auth 区块（`me: ...` 之后）加：

```ts
  setActiveKey: (index: number) =>
    request<{ ok: boolean; activeKeyIndex: number }>("/keys/active", {
      method: "POST",
      body: JSON.stringify({ index }),
    }),
```

- [ ] **Step 3: 类型检查**

Run: `npm run build -w @lot-agent/web`
Expected: 编译通过（`User` 现有消费方只读 `name`/`username`，新增字段可选消费不报错）。

- [ ] **Step 4: 提交**

```bash
git add packages/web/src/api/client.ts
git commit -m "feat(web): User 增 apiKeys/activeKeyIndex + api.setActiveKey"
```

---

### Task 8: `KeySettingsModal` 组件

**Files:**
- Create: `packages/web/src/components/KeySettingsModal.tsx`

**Interfaces:**
- Produces: `KeySettingsModal(props: { keys: string[]; activeIndex: number; busy: boolean; onSelect: (index: number) => void; onClose: () => void })`。

- [ ] **Step 1: 实现组件**

复用 `AgentCenterModal` 已有的弹窗外壳类名（`agent-center-overlay/-modal/-head/-title/-close` —— 已确认存在），只新增 key 列表自有类名；全部颜色走 `var(--*)`：

```tsx
interface KeySettingsModalProps {
  keys: string[];
  activeIndex: number;
  busy: boolean;
  onSelect: (index: number) => void;
  onClose: () => void;
}

/** API-Key 设置弹窗：单选一个激活 key（视觉为 checkbox 列表），选中即切换。
 *  keys 已是遮罩串；组件从不接触原始 key，仅按 index 回传选择。 */
export function KeySettingsModal({ keys, activeIndex, busy, onSelect, onClose }: KeySettingsModalProps) {
  return (
    <div className="agent-center-overlay" onClick={onClose}>
      <div className="agent-center-modal key-settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="agent-center-head">
          <h2 className="agent-center-title">API-Key 设置</h2>
          <button className="agent-center-close" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        {keys.length === 0 ? (
          <p className="key-settings-empty">当前账号暂无可用 key，请前往订阅管理页面设置</p>
        ) : (
          <ul className="key-list">
            {keys.map((masked, i) => (
              <li key={i}>
                <button
                  type="button"
                  className={`key-row ${i === activeIndex ? "active" : ""}`}
                  disabled={busy}
                  onClick={() => i !== activeIndex && onSelect(i)}
                >
                  <span className={`key-check ${i === activeIndex ? "checked" : ""}`} aria-hidden />
                  <span className="key-mask">{masked}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 加样式**

在 `packages/web/src/App.css` 末尾追加（仅新增 key 列表样式；弹窗外壳沿用 `agent-center-*`。用已确认存在的 token：`--border`, `--overlay-raise`, `--text`, `--text-muted`, `--accent`）：

```css
.key-settings-modal { width: min(420px, 92vw); }
.key-settings-empty { color: var(--text-muted); font-size: 14px; padding: 12px 4px; }
.key-list { list-style: none; margin: 0; padding: 4px 0; display: flex; flex-direction: column; gap: 8px; }
.key-row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 12px;
  border: 1px solid var(--border); border-radius: 10px; background: var(--overlay-raise);
  color: var(--text); cursor: pointer; font-family: inherit; text-align: left; }
.key-row:hover:not(:disabled) { border-color: var(--accent); }
.key-row.active { border-color: var(--accent); }
.key-row:disabled { opacity: 0.6; cursor: default; }
.key-check { width: 16px; height: 16px; border: 1.5px solid var(--border); border-radius: 4px; flex: none; }
.key-check.checked { background: var(--accent); border-color: var(--accent); }
.key-mask { font-family: ui-monospace, monospace; letter-spacing: 0.5px; }
```

- [ ] **Step 3: 类型检查**

Run: `npm run build -w @lot-agent/web`
Expected: 通过（组件未被引用也应能编译）。

- [ ] **Step 4: 提交**

```bash
git add packages/web/src/components/KeySettingsModal.tsx packages/web/src/App.css
git commit -m "feat(web): KeySettingsModal 单选遮罩 key 弹窗"
```

---

### Task 9: `BrandHeader` 用户名旁设置按钮

**Files:**
- Modify: `packages/web/src/components/BrandHeader.tsx`

**Interfaces:**
- Consumes: 无。
- Produces: `BrandHeaderProps` 增 `onOpenKeySettings?: () => void`。

- [ ] **Step 1: 加 prop 与齿轮按钮**

`BrandHeaderProps` 增 `onOpenKeySettings?: () => void;`；在 `brand-account` 里、`brand-email` 之后、`btn-logout` 之前插入齿轮按钮（仅 `user && onOpenKeySettings` 时渲染）：

```tsx
          {user && onOpenKeySettings && (
            <button
              className="btn-key-settings"
              onClick={onOpenKeySettings}
              title="API-Key 设置"
              aria-label="API-Key 设置"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          )}
```

- [ ] **Step 2: 样式**

`App.css` 追加（复用 logout 按钮观感，颜色走 token）：

```css
.btn-key-settings { display: inline-flex; align-items: center; justify-content: center;
  background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 2px; }
.btn-key-settings:hover { color: var(--accent); }
```

- [ ] **Step 3: 类型检查**

Run: `npm run build -w @lot-agent/web`
Expected: 通过。

- [ ] **Step 4: 提交**

```bash
git add packages/web/src/components/BrandHeader.tsx packages/web/src/App.css
git commit -m "feat(web): BrandHeader 用户名旁 API-Key 设置齿轮按钮"
```

---

### Task 10: `Workspace` 编排 key 切换 + 刷新目录

**Files:**
- Modify: `packages/web/src/pages/Workspace.tsx`

**Interfaces:**
- Consumes: `api.setActiveKey`（Task 7）、`KeySettingsModal`（Task 8）、`BrandHeader.onOpenKeySettings`（Task 9）、`useModels().reload`、`EMPTY_SELECTED`。

- [ ] **Step 1: 引入依赖 + 取 reload**

顶部加 `import { KeySettingsModal } from "../components/KeySettingsModal.js";`；把 `const { models: modelCatalog } = useModels();` 改为 `const { models: modelCatalog, reload: reloadModels } = useModels();`。

- [ ] **Step 2: 加状态 + 切换处理**

在组件内（`selectedModels` state 附近）加：

```tsx
  const [activeKeyIndex, setActiveKeyIndex] = useState(user.activeKeyIndex);
  const [keyModalOpen, setKeyModalOpen] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);

  const handleSelectKey = useCallback(
    async (index: number) => {
      setKeyBusy(true);
      try {
        await api.setActiveKey(index);
        setActiveKeyIndex(index);
        setSelectedModels(EMPTY_SELECTED); // 丢弃旧 key 的选择，等新目录回填
        reloadModels();
        setKeyModalOpen(false);
      } catch {
        // 切换失败：保持原激活项；弹窗留开供重试
      } finally {
        setKeyBusy(false);
      }
    },
    [reloadModels]
  );
```

- [ ] **Step 3: 传齿轮回调 + 渲染弹窗**

给 `BrandHeader` 加 `onOpenKeySettings={() => setKeyModalOpen(true)}`；在 `centerOpen` 弹窗渲染附近（`workspace` 根 div 内末尾）加：

```tsx
      {keyModalOpen && (
        <KeySettingsModal
          keys={user.apiKeys}
          activeIndex={activeKeyIndex}
          busy={keyBusy}
          onSelect={handleSelectKey}
          onClose={() => setKeyModalOpen(false)}
        />
      )}
```

- [ ] **Step 4: 类型检查**

Run: `npm run build -w @lot-agent/web`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/pages/Workspace.tsx
git commit -m "feat(web): Workspace 接入 key 切换弹窗 + 切换后刷新模型目录"
```

---

### Task 11: `ModelPicker` 空态文案「暂无模型」

**Files:**
- Modify: `packages/web/src/components/ModelPicker.tsx`

- [ ] **Step 1: 改两处文案**

- `const current = isEmpty ? "默认" : ...` → `const current = isEmpty ? "暂无模型" : value ?? models[0]?.id ?? "选择模型";`
- 空态弹层 `<div className="model-empty">无更多模型，请联系管理员</div>` → `<div className="model-empty">暂无模型，请前往订阅管理页面设置</div>`

- [ ] **Step 2: 类型检查**

Run: `npm run build -w @lot-agent/web`
Expected: 通过。

- [ ] **Step 3: 提交**

```bash
git add packages/web/src/components/ModelPicker.tsx
git commit -m "feat(web): ModelPicker 空目录显示「暂无模型」"
```

---

### Task 12: `InputBox` 无模型时拦截发送并提示

**Files:**
- Modify: `packages/web/src/components/InputBox.tsx`

**Interfaces:**
- Consumes: 已有 props `models`, `onModelChange`（无需新增 prop；内部派生 `noModels`）。

- [ ] **Step 1: 派生 noModels + 提示状态**

在组件体内（`const [value, setValue] = useState("")` 附近）加：

```tsx
  const noModels = !!onModelChange && models.length === 0;
  const [noModelNotice, setNoModelNotice] = useState(false);
```

- [ ] **Step 2: 发送时拦截**

`handleSend` 开头（`const trimmed = value.trim();` 之后、原空值判断之前）插入：

```tsx
    if (noModels) {
      setNoModelNotice(true);
      return;
    }
```

并把 `noModels` 加入 `handleSend` 的 `useCallback` 依赖数组。

- [ ] **Step 3: 输入变化时清除提示**

`textarea` 的 `onChange` 由 `(e) => setValue(e.target.value)` 改为：

```tsx
        onChange={(e) => { setValue(e.target.value); if (noModelNotice) setNoModelNotice(false); }}
```

- [ ] **Step 4: 渲染内联提示**

在 `return (<div className="input-box">` 内、现有 `input-modal-hint`（多模态提示）附近，加：

```tsx
      {noModelNotice && (
        <div className="input-modal-hint" role="alert">
          <span aria-hidden>⚠️</span>
          暂无能使用模型，请前往订阅管理页面设置 api-key 和 key 能访问的模型
        </div>
      )}
```

- [ ] **Step 5: 类型检查**

Run: `npm run build -w @lot-agent/web`
Expected: 通过。

- [ ] **Step 6: 手动验证（无自动化组件测试）**

启动 `npm run dev`，用无 key 账号登录：应进入工作区、模型选择器显示「暂无模型」、点击发送出现内联提示且不发送；用有 key 账号点齿轮切换到无模型的 key 亦然；切回有模型的 key 后目录恢复、可正常发送。

- [ ] **Step 7: 提交**

```bash
git add packages/web/src/components/InputBox.tsx
git commit -m "feat(web): 无可用模型时拦截发送并内联提示"
```

---

## 收尾

- [ ] **全量测试 + 构建**

Run: `npm test`
Expected: 全绿。
Run: `npm run build`
Expected: 各 workspace 构建成功。

- [ ] **端到端手动验证**（参考 Task 12 Step 6 场景）。
