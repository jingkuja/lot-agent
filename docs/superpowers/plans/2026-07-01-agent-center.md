# Agent 中心(子 Agent 安装 / 绑定)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每个用户可安装/卸载子 Agent,只有已安装的出现在切换器;通用永远第一且不可卸载;切换器超 6 个子 Agent 用「更多」气泡承载并支持 MRU 持久化排序;新增「Agent 中心」市场弹窗;并把 PPT 制作、合同审核 作为 stub 子 Agent 加入。

**Architecture:** 服务端新增每用户 `user_agents` 表(安装 + `sort_order`)。`GET /api/agents` 复用现有接口,为每项附加 `installed`/`sortOrder`,并在首次访问时懒播种默认安装(general/image/video)。新增 install/uninstall/promote 三个写接口。前端把静态 agents 换成 `useAgents` hook,切换器只渲染已安装项,超出走「更多」气泡;底部「Agent 中心」按钮打开市场弹窗。排序拆分与 sort_order 计算都抽成纯函数单测。

**Tech Stack:** TypeScript(ESM,`.js` 后缀导入)、npm workspaces、Hono、pg、React 19 + Vite、Vitest。

## Global Constraints

- ESM 导入必须带显式 `.js` 后缀(如 `from "./install-order.js"`),2 空格缩进。
- 新逻辑单元用 Vitest,测试文件 colocated 为 `*.test.ts`。
- 接口在 core、实现在 server(本计划新增的 DB 逻辑放 server)。
- 迁移是 inline:写在 `packages/server/src/db/database.ts` 的 `migrate()` 里,用 `CREATE TABLE IF NOT EXISTS` + 幂等 `ALTER ... IF NOT EXISTS`,无迁移 runner。
- NUMERIC / DOUBLE PRECISION 列从 pg 返回字符串,必须用 `Number()` 转换。
- Web 颜色一律用 `packages/web/src/App.css` 里的 `var(--*)` token,禁止硬编码 hex / rgba。
- 通用(`general`)永远视为已安装、永远排第一、不可卸载。
- 无真实密钥入库;PPT/合同审核 只做 stub 定义,无业务逻辑。
- `c.get("userId")` 为 session UUID 字符串,与 `conversations.user_id`(VARCHAR)一致;新表 `user_agents.user_id` 用 `VARCHAR(100)`。

---

## File Structure

**Backend (`packages/core`)**
- `src/agents/types.ts` — 修改:`AgentType` 增 `ppt`/`contract`;`AgentDefinition` 增 `category?`。
- `src/agents/definitions/ppt.ts` — 新建:`pptDefinition`。
- `src/agents/definitions/contract.ts` — 新建:`contractDefinition`。
- `src/agents/definitions/index.ts` — 修改:导出新定义。
- `src/agents/definitions/{image,video,copywriting}.ts` — 修改:补 `category`。
- `src/agents/definitions/definitions.test.ts` — 新建:定义字段断言。

**Backend (`packages/server`)**
- `src/agents/install-order.ts` — 新建:纯 sort_order/默认集常量。
- `src/agents/install-order.test.ts` — 新建。
- `src/db/database.ts` — 修改:迁移建表 + 6 个仓库方法。
- `src/routes/agents.ts` — 修改:GET 注解 + install/uninstall/promote。
- `src/routes/agents.test.ts` — 新建:路由测试(fake db)。
- `src/services/agent-service.ts` — 修改:注册 ppt/contract。
- `src/index.ts` — 修改:`app.use("/api/agents", authMw)`。

**Frontend (`packages/web`)**
- `src/api/client.ts` — 修改:`Agent` 增字段 + 3 个方法。
- `src/lib/agent-order.ts` — 新建:纯拆分助手。
- `src/lib/agent-order.test.ts` — 新建。
- `src/hooks/useAgents.ts` — 新建。
- `src/components/AgentSwitcher.tsx` — 修改:接入拆分 + 「更多」。
- `src/components/AgentOverflowPopover.tsx` — 新建。
- `src/components/AgentCenterModal.tsx` — 新建。
- `src/pages/Workspace.tsx` — 修改:接线。
- `src/App.tsx` — 修改:agents 来源改为 useAgents(经 Workspace)。
- `src/App.css` — 修改:新组件样式 token。

---

## Task 1: 新增 PPT / 合同审核 Agent 定义 + category 字段

**Files:**
- Modify: `packages/core/src/agents/types.ts`
- Create: `packages/core/src/agents/definitions/ppt.ts`
- Create: `packages/core/src/agents/definitions/contract.ts`
- Modify: `packages/core/src/agents/definitions/index.ts`
- Modify: `packages/core/src/agents/definitions/image.ts`, `video.ts`, `copywriting.ts`
- Test: `packages/core/src/agents/definitions/definitions.test.ts`
- Modify: `packages/server/src/services/agent-service.ts`

**Interfaces:**
- Produces: `AgentDefinition` 现含 `category?: string`;`AgentType` 含 `"ppt" | "contract"`;`pptDefinition`、`contractDefinition`(id 分别 `"ppt"`/`"contract"`)。后续任务的图标映射与市场分组依赖 `type` 与 `category`。

- [ ] **Step 1: 写失败测试**

`packages/core/src/agents/definitions/definitions.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { pptDefinition, contractDefinition, imageDefinition } from "./index.js";

describe("agent definitions", () => {
  it("ppt is an office stub agent", () => {
    expect(pptDefinition.id).toBe("ppt");
    expect(pptDefinition.type).toBe("ppt");
    expect(pptDefinition.category).toBe("办公");
    expect(pptDefinition.toolNames).toEqual([]);
  });

  it("contract is a review stub agent", () => {
    expect(contractDefinition.id).toBe("contract");
    expect(contractDefinition.type).toBe("contract");
    expect(contractDefinition.category).toBe("审核");
  });

  it("existing agents carry a category", () => {
    expect(imageDefinition.category).toBe("创作");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w @lot-agent/core -- definitions`
Expected: FAIL(`pptDefinition` 未导出 / `category` undefined)。

- [ ] **Step 3: 实现类型与定义**

`packages/core/src/agents/types.ts` — 改前两处:
```ts
export type AgentType = "general" | "copywriting" | "image" | "video" | "ppt" | "contract";

export interface AgentDefinition {
  id: string;
  name: string;
  type: AgentType;
  description: string;
  category?: string;          // 市场分组用,如 创作 / 办公 / 审核
  systemPrompt: string;
  toolNames: string[];
  defaultModelId: string;
  inputSchema?: Record<string, unknown>;
}
```

`packages/core/src/agents/definitions/ppt.ts`(新建):
```ts
import type { AgentDefinition } from "../types.js";

export const pptDefinition: AgentDefinition = {
  id: "ppt",
  name: "PPT 制作",
  type: "ppt",
  description: "根据主题一键生成结构化演示文稿",
  category: "办公",
  systemPrompt: "（占位）PPT 制作 Agent,后续接入演示文稿生成能力。",
  toolNames: [],
  defaultModelId: "deepseek-v4-flash",
  inputSchema: {
    type: "object",
    properties: {
      topic: { type: "string" },
      slides: { type: "number" },
    },
    required: ["topic"],
  },
};
```

`packages/core/src/agents/definitions/contract.ts`(新建):
```ts
import type { AgentDefinition } from "../types.js";

export const contractDefinition: AgentDefinition = {
  id: "contract",
  name: "合同审核",
  type: "contract",
  description: "上传合同,自动识别风险条款并给出审核意见",
  category: "审核",
  systemPrompt: "（占位）合同审核 Agent,后续接入文档解析与风险审查能力。",
  toolNames: [],
  defaultModelId: "deepseek-v4-flash",
  inputSchema: {
    type: "object",
    properties: {
      document: { type: "string" },
    },
    required: ["document"],
  },
};
```

`packages/core/src/agents/definitions/index.ts`(改为):
```ts
export { copywritingDefinition } from "./copywriting.js";
export { imageDefinition } from "./image.js";
export { videoDefinition } from "./video.js";
export { pptDefinition } from "./ppt.js";
export { contractDefinition } from "./contract.js";
```

给 `image.ts` 定义对象加一行 `category: "创作",`(放在 `type` 之后);同样给 `video.ts` 加 `category: "创作",`、`copywriting.ts` 加 `category: "创作",`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w @lot-agent/core -- definitions`
Expected: PASS。

- [ ] **Step 5: 服务端注册新定义**

`packages/server/src/services/agent-service.ts`:第 13 行附近 import 增加 `pptDefinition, contractDefinition`(与 `imageDefinition` 同处导入);在第 242 行 `this.agentRegistry.register(videoDefinition);` 之后追加:
```ts
    this.agentRegistry.register(pptDefinition);
    this.agentRegistry.register(contractDefinition);
```

- [ ] **Step 6: 构建 core 确认无类型错误**

Run: `npm run build -w @lot-agent/core`
Expected: 成功,无 TS 错误。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/agents packages/server/src/services/agent-service.ts
git commit -m "feat(agents): add ppt & contract stub agents + category field"
```

---

## Task 2: 服务端安装排序纯函数

**Files:**
- Create: `packages/server/src/agents/install-order.ts`
- Test: `packages/server/src/agents/install-order.test.ts`

**Interfaces:**
- Produces:
  - `DEFAULT_INSTALLED_AGENT_IDS: readonly string[]` = `["general","image","video"]`
  - `GENERAL_AGENT_ID = "general"`
  - `nextSortOrder(existing: number[]): number` — `max(existing)+1`,空数组返回 `0`。
  - `promotedSortOrder(subAgentOrders: number[]): number` — `min(subAgentOrders)-1`,空数组返回 `-1`。
- Task 3 的 DB 方法消费这些函数。

- [ ] **Step 1: 写失败测试**

`packages/server/src/agents/install-order.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  DEFAULT_INSTALLED_AGENT_IDS,
  GENERAL_AGENT_ID,
  nextSortOrder,
  promotedSortOrder,
} from "./install-order.js";

describe("install-order", () => {
  it("default set installs general/image/video with general first", () => {
    expect(DEFAULT_INSTALLED_AGENT_IDS).toEqual(["general", "image", "video"]);
    expect(DEFAULT_INSTALLED_AGENT_IDS[0]).toBe(GENERAL_AGENT_ID);
  });

  it("nextSortOrder appends after current max", () => {
    expect(nextSortOrder([])).toBe(0);
    expect(nextSortOrder([0, 1, 2])).toBe(3);
    expect(nextSortOrder([-1, 5])).toBe(6);
  });

  it("promotedSortOrder moves ahead of current min", () => {
    expect(promotedSortOrder([])).toBe(-1);
    expect(promotedSortOrder([1, 2, 3])).toBe(0);
    expect(promotedSortOrder([-2, 4])).toBe(-3);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -w @lot-agent/server -- install-order`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现**

`packages/server/src/agents/install-order.ts`:
```ts
/** 新用户默认安装的 Agent(general 必须第一)。 */
export const DEFAULT_INSTALLED_AGENT_IDS = ["general", "image", "video"] as const;

/** 永远已安装、不可卸载、恒排第一的通用 Agent id。 */
export const GENERAL_AGENT_ID = "general";

/** 追加安装时的 sort_order:排到当前最大之后。 */
export function nextSortOrder(existing: number[]): number {
  return (existing.length ? Math.max(...existing) : -1) + 1;
}

/** MRU 插队:排到当前所有子 Agent 之前(min - 1)。 */
export function promotedSortOrder(subAgentOrders: number[]): number {
  return (subAgentOrders.length ? Math.min(...subAgentOrders) : 0) - 1;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -w @lot-agent/server -- install-order`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/agents/install-order.ts packages/server/src/agents/install-order.test.ts
git commit -m "feat(agents): pure sort-order helpers for install/promote"
```

---

## Task 3: user_agents 表 + 仓库方法

**Files:**
- Modify: `packages/server/src/db/database.ts`(`migrate()` 内建表 + 类中新增 6 个方法)

**Interfaces:**
- Consumes: `DEFAULT_INSTALLED_AGENT_IDS`, `nextSortOrder`, `promotedSortOrder`, `GENERAL_AGENT_ID`(Task 2)。
- Produces(`DatabaseService` 上的方法):
  - `getUserAgents(userId: string): Promise<Map<string, number>>` — 返回 `agent_id → sort_order`;若该用户无行则先播种默认集再返回。
  - `installUserAgent(userId: string, agentId: string): Promise<void>` — 追加(max+1),已装幂等。
  - `uninstallUserAgent(userId: string, agentId: string): Promise<void>` — 删除行。
  - `promoteUserAgent(userId: string, agentId: string): Promise<void>` — sort_order 置 (子 Agent min − 1)。
  - `isUserAgentInstalled(userId: string, agentId: string): Promise<boolean>`。

> DB 方法本身不单测(与仓库现有约定一致,DatabaseService 无 PG 单测);正确性由 Task 4 路由测试(fake db)+ 手动验证保证。SQL 需精确。

- [ ] **Step 1: 迁移建表**

在 `database.ts` 的 `migrate()` 事务内(P7 表块之后、`await client.query("COMMIT")` 之前)加入:
```ts
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_agents (
          user_id      VARCHAR(100)     NOT NULL,
          agent_id     VARCHAR(64)      NOT NULL,
          sort_order   DOUBLE PRECISION NOT NULL DEFAULT 0,
          installed_at TIMESTAMPTZ      NOT NULL DEFAULT now(),
          PRIMARY KEY (user_id, agent_id)
        );
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_user_agents_user ON user_agents (user_id, sort_order);
      `);
```

- [ ] **Step 2: 顶部导入纯函数**

`database.ts` 顶部 import 区加入:
```ts
import {
  DEFAULT_INSTALLED_AGENT_IDS,
  GENERAL_AGENT_ID,
  nextSortOrder,
  promotedSortOrder,
} from "../agents/install-order.js";
```

- [ ] **Step 3: 新增仓库方法**

在 `DatabaseService` 类内(紧邻 `getMonthlySpend` 之后)加入:
```ts
  // ── User agents (Agent 中心) ──

  async getUserAgents(userId: string): Promise<Map<string, number>> {
    const read = async () =>
      (
        await this.pool.query(
          `SELECT agent_id, sort_order FROM user_agents
           WHERE user_id = $1 ORDER BY sort_order ASC`,
          [userId]
        )
      ).rows;

    let rows = await read();
    if (rows.length === 0) {
      // 懒播种默认安装集(general/image/video),sort_order 按数组下标。
      for (let i = 0; i < DEFAULT_INSTALLED_AGENT_IDS.length; i++) {
        await this.pool.query(
          `INSERT INTO user_agents (user_id, agent_id, sort_order) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, agent_id) DO NOTHING`,
          [userId, DEFAULT_INSTALLED_AGENT_IDS[i], i]
        );
      }
      rows = await read();
    }
    return new Map(rows.map((r) => [r.agent_id as string, Number(r.sort_order)]));
  }

  async installUserAgent(userId: string, agentId: string): Promise<void> {
    const { rows } = await this.pool.query(
      `SELECT sort_order FROM user_agents WHERE user_id = $1`,
      [userId]
    );
    const order = nextSortOrder(rows.map((r) => Number(r.sort_order)));
    await this.pool.query(
      `INSERT INTO user_agents (user_id, agent_id, sort_order) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, agent_id) DO NOTHING`,
      [userId, agentId, order]
    );
  }

  async uninstallUserAgent(userId: string, agentId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM user_agents WHERE user_id = $1 AND agent_id = $2`,
      [userId, agentId]
    );
  }

  async promoteUserAgent(userId: string, agentId: string): Promise<void> {
    const { rows } = await this.pool.query(
      `SELECT sort_order FROM user_agents WHERE user_id = $1 AND agent_id <> $2`,
      [userId, GENERAL_AGENT_ID]
    );
    const order = promotedSortOrder(rows.map((r) => Number(r.sort_order)));
    await this.pool.query(
      `UPDATE user_agents SET sort_order = $3 WHERE user_id = $1 AND agent_id = $2`,
      [userId, agentId, order]
    );
  }

  async isUserAgentInstalled(userId: string, agentId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM user_agents WHERE user_id = $1 AND agent_id = $2`,
      [userId, agentId]
    );
    return rows.length > 0;
  }
```

- [ ] **Step 4: 构建确认无类型错误**

Run: `npm run build -w @lot-agent/server`
Expected: 成功。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/db/database.ts
git commit -m "feat(db): user_agents table + install/uninstall/promote repo methods"
```

---

## Task 4: /api/agents 路由(注解 + 安装/卸载/promote)

**Files:**
- Modify: `packages/server/src/routes/agents.ts`
- Test: `packages/server/src/routes/agents.test.ts`
- Modify: `packages/server/src/index.ts`(auth 中间件)

**Interfaces:**
- Consumes: `service.db.getUserAgents / installUserAgent / uninstallUserAgent / promoteUserAgent / isUserAgentInstalled`(Task 3);`service.agentRegistry.get / list`。
- Produces(HTTP):
  - `GET /api/agents` → `Array<AgentDefinition & { installed: boolean; sortOrder: number | null }>`。
  - `POST /api/agents/:id/install` → `{ ok: true }`;未知 id → 404。
  - `DELETE /api/agents/:id/install` → `{ ok: true }`;`id === "general"` → 400。
  - `POST /api/agents/:id/promote` → `{ ok: true }`;未知 id → 404;未安装 → 400。

- [ ] **Step 1: 写失败测试**

`packages/server/src/routes/agents.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createAgentRoutes } from "./agents.js";

function fakeService(installed: Map<string, number>) {
  return {
    agentRegistry: {
      list: () => [
        { id: "general", name: "通用助手", type: "general", description: "", toolNames: [], defaultModelId: "m" },
        { id: "image", name: "图片生成", type: "image", description: "", toolNames: [], defaultModelId: "m" },
        { id: "contract", name: "合同审核", type: "contract", description: "", toolNames: [], defaultModelId: "m" },
      ],
      get: (id: string) => (["general", "image", "contract"].includes(id) ? { id } : undefined),
    },
    db: {
      getUserAgents: vi.fn(async () => installed),
      installUserAgent: vi.fn(async () => {}),
      uninstallUserAgent: vi.fn(async () => {}),
      promoteUserAgent: vi.fn(async () => {}),
      isUserAgentInstalled: vi.fn(async (_u: string, id: string) => installed.has(id)),
    },
  } as any;
}

function app(service: any) {
  const a = new Hono<{ Variables: { userId: string } }>();
  a.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
  a.route("/agents", createAgentRoutes(service));
  return a;
}

describe("agents routes", () => {
  it("GET annotates installed + sortOrder", async () => {
    const res = await app(fakeService(new Map([["general", 0], ["image", 1]]))).request("/agents");
    expect(res.status).toBe(200);
    const body = await res.json();
    const byId = Object.fromEntries(body.map((a: any) => [a.id, a]));
    expect(byId.general.installed).toBe(true);
    expect(byId.image).toMatchObject({ installed: true, sortOrder: 1 });
    expect(byId.contract).toMatchObject({ installed: false, sortOrder: null });
  });

  it("POST install unknown id -> 404", async () => {
    const res = await app(fakeService(new Map())).request("/agents/nope/install", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST install known id -> ok + calls db", async () => {
    const svc = fakeService(new Map());
    const res = await app(svc).request("/agents/contract/install", { method: "POST" });
    expect(res.status).toBe(200);
    expect(svc.db.installUserAgent).toHaveBeenCalledWith("u1", "contract");
  });

  it("DELETE general -> 400", async () => {
    const res = await app(fakeService(new Map())).request("/agents/general/install", { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("DELETE installed sub-agent -> ok", async () => {
    const svc = fakeService(new Map([["image", 1]]));
    const res = await app(svc).request("/agents/image/install", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(svc.db.uninstallUserAgent).toHaveBeenCalledWith("u1", "image");
  });

  it("POST promote not-installed -> 400", async () => {
    const res = await app(fakeService(new Map())).request("/agents/contract/promote", { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("POST promote installed -> ok", async () => {
    const svc = fakeService(new Map([["contract", 2]]));
    const res = await app(svc).request("/agents/contract/promote", { method: "POST" });
    expect(res.status).toBe(200);
    expect(svc.db.promoteUserAgent).toHaveBeenCalledWith("u1", "contract");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -w @lot-agent/server -- agents`
Expected: FAIL(当前 GET 无 installed 字段,写接口不存在)。

- [ ] **Step 3: 实现路由**

`packages/server/src/routes/agents.ts`(整体替换):
```ts
import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";

export function createAgentRoutes(service: AgentService): Hono<{ Variables: { userId: string } }> {
  const app = new Hono<{ Variables: { userId: string } }>();

  // 全部 Agent 定义 + 当前用户的安装状态与排序
  app.get("/", async (c) => {
    const userId = c.get("userId");
    const installed = await service.db.getUserAgents(userId); // 首次访问触发懒播种
    return c.json(
      service.agentRegistry.list().map((d) => {
        const isInstalled = d.id === "general" ? true : installed.has(d.id);
        return {
          ...d,
          installed: isInstalled,
          sortOrder: installed.has(d.id) ? installed.get(d.id)! : null,
        };
      })
    );
  });

  app.post("/:id/install", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    if (!service.agentRegistry.get(id)) return c.json({ error: "Unknown agent" }, 404);
    await service.db.installUserAgent(userId, id);
    return c.json({ ok: true });
  });

  app.delete("/:id/install", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    if (id === "general") return c.json({ error: "Cannot uninstall the general agent" }, 400);
    await service.db.uninstallUserAgent(userId, id);
    return c.json({ ok: true });
  });

  app.post("/:id/promote", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    if (!service.agentRegistry.get(id)) return c.json({ error: "Unknown agent" }, 404);
    if (!(await service.db.isUserAgentInstalled(userId, id)))
      return c.json({ error: "Agent not installed" }, 400);
    await service.db.promoteUserAgent(userId, id);
    return c.json({ ok: true });
  });

  return app;
}
```

- [ ] **Step 4: 确保 GET /api/agents 也受 auth 保护**

`packages/server/src/index.ts`:在第 107 行 `app.use("/api/agents/*", authMw);` 之前(或之后)加一行,覆盖无尾斜杠的基础路径:
```ts
  app.use("/api/agents", authMw);
```

- [ ] **Step 5: 运行确认通过**

Run: `npm test -w @lot-agent/server -- agents`
Expected: PASS(全部用例)。

- [ ] **Step 6: 提交**

```bash
git add packages/server/src/routes/agents.ts packages/server/src/routes/agents.test.ts packages/server/src/index.ts
git commit -m "feat(api): agent install/uninstall/promote + installed annotation"
```

---

## Task 5: Web API 客户端(类型 + 方法)

**Files:**
- Modify: `packages/web/src/api/client.ts`

**Interfaces:**
- Produces:
  - `Agent` 增 `category?: string`、`installed?: boolean`、`sortOrder?: number | null`。
  - `api.installAgent(id: string): Promise<{ ok: true }>`
  - `api.uninstallAgent(id: string): Promise<{ ok: true }>`
  - `api.promoteAgent(id: string): Promise<{ ok: true }>`

- [ ] **Step 1: 扩展 Agent 接口**

`packages/web/src/api/client.ts` 第 49–57 行的 `Agent` 接口末尾(`inputSchema?: unknown;` 之后)加入:
```ts
  category?: string;
  installed?: boolean;
  sortOrder?: number | null;
```

- [ ] **Step 2: 新增三个方法**

在 `api` 对象里 `listAgents` 那行(第 156 行)之后加入:
```ts
  installAgent: (id: string) =>
    request<{ ok: true }>(`/agents/${id}/install`, { method: "POST" }),
  uninstallAgent: (id: string) =>
    request<{ ok: true }>(`/agents/${id}/install`, { method: "DELETE" }),
  promoteAgent: (id: string) =>
    request<{ ok: true }>(`/agents/${id}/promote`, { method: "POST" }),
```

- [ ] **Step 3: 构建确认无类型错误**

Run: `npm run build -w @lot-agent/web`
Expected: 成功(TS 编译通过)。

- [ ] **Step 4: 提交**

```bash
git add packages/web/src/api/client.ts
git commit -m "feat(web-api): Agent install fields + install/uninstall/promote calls"
```

---

## Task 6: 前端排序拆分纯函数

**Files:**
- Create: `packages/web/src/lib/agent-order.ts`
- Test: `packages/web/src/lib/agent-order.test.ts`

**Interfaces:**
- Produces:
  - `GENERAL_ID = "general"`,`MAX_VISIBLE_SUBAGENTS = 6`。
  - `interface SplitAgents<T> { general: T | null; visible: T[]; overflow: T[] }`
  - `splitInstalledAgents<T extends { id: string; sortOrder?: number | null }>(installed: T[]): SplitAgents<T>` — 仅传入 **已安装** agents。general 抽出;其余按 `sortOrder` 升序(null 视为 +∞ 排最后),前 6 为 `visible`,其余 `overflow`。

- [ ] **Step 1: 写失败测试**

`packages/web/src/lib/agent-order.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { splitInstalledAgents, MAX_VISIBLE_SUBAGENTS } from "./agent-order.js";

const mk = (id: string, sortOrder: number | null) => ({ id, sortOrder });

describe("splitInstalledAgents", () => {
  it("pulls general out and sorts sub-agents by sortOrder", () => {
    const r = splitInstalledAgents([mk("image", 2), mk("general", 0), mk("video", 1)]);
    expect(r.general?.id).toBe("general");
    expect(r.visible.map((a) => a.id)).toEqual(["video", "image"]);
    expect(r.overflow).toEqual([]);
  });

  it("keeps first 6 sub-agents visible, rest overflow", () => {
    const subs = Array.from({ length: 8 }, (_, i) => mk(`a${i}`, i));
    const r = splitInstalledAgents([mk("general", -1), ...subs]);
    expect(r.visible).toHaveLength(MAX_VISIBLE_SUBAGENTS);
    expect(r.visible.map((a) => a.id)).toEqual(["a0", "a1", "a2", "a3", "a4", "a5"]);
    expect(r.overflow.map((a) => a.id)).toEqual(["a6", "a7"]);
  });

  it("null sortOrder sorts last", () => {
    const r = splitInstalledAgents([mk("general", 0), mk("x", null), mk("y", 5)]);
    expect(r.visible.map((a) => a.id)).toEqual(["y", "x"]);
  });

  it("no general -> general is null", () => {
    const r = splitInstalledAgents([mk("image", 0)]);
    expect(r.general).toBeNull();
    expect(r.visible.map((a) => a.id)).toEqual(["image"]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -w @lot-agent/web -- agent-order`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现**

`packages/web/src/lib/agent-order.ts`:
```ts
export const GENERAL_ID = "general";
export const MAX_VISIBLE_SUBAGENTS = 6;

export interface SplitAgents<T> {
  general: T | null;
  visible: T[];
  overflow: T[];
}

/** 传入已安装 agents:抽出 general,子 Agent 按 sortOrder 升序(null 最后),
 *  前 MAX_VISIBLE_SUBAGENTS 个可见,其余进溢出。 */
export function splitInstalledAgents<T extends { id: string; sortOrder?: number | null }>(
  installed: T[]
): SplitAgents<T> {
  const general = installed.find((a) => a.id === GENERAL_ID) ?? null;
  const rank = (a: T) => (a.sortOrder == null ? Number.POSITIVE_INFINITY : a.sortOrder);
  const subs = installed
    .filter((a) => a.id !== GENERAL_ID)
    .sort((a, b) => rank(a) - rank(b));
  return {
    general,
    visible: subs.slice(0, MAX_VISIBLE_SUBAGENTS),
    overflow: subs.slice(MAX_VISIBLE_SUBAGENTS),
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -w @lot-agent/web -- agent-order`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/lib/agent-order.ts packages/web/src/lib/agent-order.test.ts
git commit -m "feat(web): pure splitInstalledAgents helper (visible 6 + overflow)"
```

---

## Task 7: useAgents hook

**Files:**
- Create: `packages/web/src/hooks/useAgents.ts`

**Interfaces:**
- Consumes: `api.listAgents / installAgent / uninstallAgent / promoteAgent`(Task 5)。
- Produces:
  ```ts
  interface UseAgents {
    agents: Agent[];            // 全量(含未安装),带 installed/sortOrder
    installed: Agent[];         // agents.filter(a => a.installed)
    loading: boolean;
    refresh: () => Promise<void>;
    install: (id: string) => Promise<void>;
    uninstall: (id: string) => Promise<void>;
    promote: (id: string) => Promise<void>;
  }
  function useAgents(enabled: boolean): UseAgents
  ```
  三个写操作:调用 API 后 `await refresh()` 重新拉取(简单可靠,不做乐观更新)。`enabled` 为 false 时不拉取(未登录)。

- [ ] **Step 1: 实现 hook**

`packages/web/src/hooks/useAgents.ts`:
```ts
import { useState, useEffect, useCallback } from "react";
import { api, type Agent } from "../api/client.js";

export interface UseAgents {
  agents: Agent[];
  installed: Agent[];
  loading: boolean;
  refresh: () => Promise<void>;
  install: (id: string) => Promise<void>;
  uninstall: (id: string) => Promise<void>;
  promote: (id: string) => Promise<void>;
}

export function useAgents(enabled: boolean): UseAgents {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setAgents(await api.listAgents());
    } catch {
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void refresh();
    else setAgents([]);
  }, [enabled, refresh]);

  const install = useCallback(async (id: string) => { await api.installAgent(id); await refresh(); }, [refresh]);
  const uninstall = useCallback(async (id: string) => { await api.uninstallAgent(id); await refresh(); }, [refresh]);
  const promote = useCallback(async (id: string) => { await api.promoteAgent(id); await refresh(); }, [refresh]);

  return { agents, installed: agents.filter((a) => a.installed), loading, refresh, install, uninstall, promote };
}
```

- [ ] **Step 2: 构建确认无类型错误**

Run: `npm run build -w @lot-agent/web`
Expected: 成功。

- [ ] **Step 3: 提交**

```bash
git add packages/web/src/hooks/useAgents.ts
git commit -m "feat(web): useAgents hook (list + install/uninstall/promote + refresh)"
```

---

## Task 8: AgentSwitcher 接入拆分 + 「更多」溢出气泡

**Files:**
- Modify: `packages/web/src/components/AgentSwitcher.tsx`
- Create: `packages/web/src/components/AgentOverflowPopover.tsx`
- Modify: `packages/web/src/App.css`(新增 `.agent-more-*` / `.agent-overflow-*` token 化样式)

**Interfaces:**
- Consumes: `splitInstalledAgents`(Task 6)。
- Produces:
  - `AgentSwitcher` props 改为 `{ agents: Agent[]; activeId: string; onSwitch: (id: string) => void; onPickOverflow: (id: string) => void; disabled?: boolean }`,其中 `agents` 为**已安装**列表(调用方传 installed)。
  - `AgentOverflowPopover` props:`{ agents: Agent[]; activeId: string; onPick: (id: string) => void; onClose: () => void }`。
- `onPickOverflow(id)` 由 Task 10 实现为「promote + 激活」。

- [ ] **Step 1: 图标映射补 ppt/contract**

`AgentSwitcher.tsx` 的 `ICONS` 对象里(`video` 之后)加入两个条目:
```tsx
  ppt: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  ),
  contract: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" />
      <path d="M14 2v6h6M9 13l2 2 4-4" />
    </svg>
  ),
```

- [ ] **Step 2: 实现溢出气泡组件**

`packages/web/src/components/AgentOverflowPopover.tsx`(新建):
```tsx
import { useEffect, useRef } from "react";
import type { Agent } from "../api/client.js";

interface Props {
  agents: Agent[];
  activeId: string;
  onPick: (id: string) => void;
  onClose: () => void;
}

/** 「更多」轻量浮层:列出未显示的已安装 Agent,点选即快速切换。 */
export function AgentOverflowPopover({ agents, activeId, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  return (
    <div className="agent-overflow-popover" ref={ref} role="menu">
      {agents.map((a) => (
        <button
          key={a.id}
          type="button"
          role="menuitem"
          className={`agent-overflow-item ${a.id === activeId ? "active" : ""}`}
          onClick={() => onPick(a.id)}
        >
          {a.name}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: 改造 AgentSwitcher**

`AgentSwitcher.tsx` 的 props 与渲染改为(保留原 `ICONS`/`kindOf`,替换 props 接口与 `AgentSwitcher` 函数体):
```tsx
import { useState } from "react";
import { splitInstalledAgents } from "../lib/agent-order.js";
import { AgentOverflowPopover } from "./AgentOverflowPopover.js";

interface AgentSwitcherProps {
  /** 已安装 agents(含 general);组件内部负责排序/截断。 */
  agents: Agent[];
  activeId: string;
  onSwitch: (agentId: string) => void;
  onPickOverflow: (agentId: string) => void;
  disabled?: boolean;
}

export function AgentSwitcher({ agents, activeId, onSwitch, onPickOverflow, disabled }: AgentSwitcherProps) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const { general, visible, overflow } = splitInstalledAgents(agents);
  const pills = general ? [general, ...visible] : visible;

  const renderPill = (a: Agent) => {
    const kind = kindOf(a);
    return (
      <button
        key={a.id}
        type="button"
        className={`agent-pill ${a.id === activeId ? "active" : ""}`}
        onClick={() => onSwitch(a.id)}
        disabled={disabled}
        title={a.description}
      >
        <span className={`agent-pill-icon agent-pill-icon--${kind}`} aria-hidden>
          {ICONS[kind]}
        </span>
        <span className="agent-pill-label">{a.name}</span>
      </button>
    );
  };

  return (
    <div className="agent-switcher">
      {pills.map(renderPill)}
      {overflow.length > 0 && (
        <div className="agent-more-wrap">
          <button
            type="button"
            className="agent-pill agent-more"
            onClick={() => setOverflowOpen((v) => !v)}
            disabled={disabled}
            title="更多已安装 Agent"
          >
            <span className="agent-pill-label">更多</span>
          </button>
          {overflowOpen && (
            <AgentOverflowPopover
              agents={overflow}
              activeId={activeId}
              onPick={(id) => { setOverflowOpen(false); onPickOverflow(id); }}
              onClose={() => setOverflowOpen(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 样式(token 化)**

`packages/web/src/App.css` 末尾追加(仅用现有 `var(--*)`,不硬编码颜色):
```css
.agent-more-wrap { position: relative; display: inline-flex; }
.agent-overflow-popover {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  min-width: 160px;
  background: var(--overlay-raise);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 4px;
  box-shadow: 0 8px 24px var(--overlay-sink);
  z-index: 40;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.agent-overflow-item {
  text-align: left;
  padding: 8px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font-size: 14px;
}
.agent-overflow-item:hover { background: var(--overlay-sink); }
.agent-overflow-item.active { color: var(--accent); font-weight: 600; }
```
> 若 `--overlay-raise` / `--overlay-sink` / `--accent` / `--border` / `--text` 在 `App.css` 中命名不同,以现有 token 为准替换(先在 `:root` 中确认实际变量名)。

- [ ] **Step 5: 构建确认无类型错误**

Run: `npm run build -w @lot-agent/web`
Expected: 成功(注意:Task 10 才更新 Workspace 的调用点,此步可能因 Workspace 旧 props 报错 —— 若报错,允许留到 Task 10 一起构建;本步只需保证 AgentSwitcher/AgentOverflowPopover 自身语法/类型正确)。

- [ ] **Step 6: 提交**

```bash
git add packages/web/src/components/AgentSwitcher.tsx packages/web/src/components/AgentOverflowPopover.tsx packages/web/src/App.css
git commit -m "feat(web): AgentSwitcher overflow (更多) popover + ppt/contract icons"
```

---

## Task 9: Agent 中心弹窗 + 侧栏底部按钮

**Files:**
- Create: `packages/web/src/components/AgentCenterModal.tsx`
- Modify: `packages/web/src/App.css`(`.agent-center-*` token 化样式)

**Interfaces:**
- Consumes: `Agent`(带 `installed`/`category`)。
- Produces:
  - `AgentCenterModal` props:`{ agents: Agent[]; onInstall: (id: string) => void; onUninstall: (id: string) => void; onClose: () => void; busyId?: string | null }`。
  - 侧栏底部「Agent 中心」按钮在 Task 10 加到 `Workspace`(此任务只交付弹窗组件 + 样式)。

- [ ] **Step 1: 实现弹窗**

`packages/web/src/components/AgentCenterModal.tsx`(新建):
```tsx
import { useMemo } from "react";
import type { Agent } from "../api/client.js";

interface Props {
  agents: Agent[];
  onInstall: (id: string) => void;
  onUninstall: (id: string) => void;
  onClose: () => void;
  busyId?: string | null;
}

/** Agent 中心:卡片网格市场,按 category 分组,安装 / 卸载。 */
export function AgentCenterModal({ agents, onInstall, onUninstall, onClose, busyId }: Props) {
  const groups = useMemo(() => {
    const m = new Map<string, Agent[]>();
    for (const a of agents) {
      const key = a.category ?? "其他";
      (m.get(key) ?? m.set(key, []).get(key)!).push(a);
    }
    return [...m.entries()];
  }, [agents]);

  return (
    <div className="agent-center-overlay" onClick={onClose}>
      <div className="agent-center-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Agent 中心">
        <div className="agent-center-head">
          <span className="agent-center-title">Agent 中心</span>
          <button className="agent-center-close" onClick={onClose} aria-label="关闭">×</button>
        </div>

        <div className="agent-center-body">
          {groups.map(([category, list]) => (
            <section key={category} className="agent-center-group">
              <div className="agent-center-group-label">{category}</div>
              <div className="agent-center-grid">
                {list.map((a) => {
                  const isGeneral = a.id === "general";
                  const busy = busyId === a.id;
                  return (
                    <div key={a.id} className="agent-card">
                      <div className="agent-card-name">{a.name}</div>
                      <div className="agent-card-desc">{a.description || "暂无描述"}</div>
                      <div className="agent-card-footer">
                        {a.installed ? (
                          <button
                            className="agent-card-btn installed"
                            disabled={isGeneral || busy}
                            onClick={() => onUninstall(a.id)}
                            title={isGeneral ? "通用助手不可卸载" : "卸载"}
                          >
                            {isGeneral ? "默认" : busy ? "处理中…" : "已安装 · 卸载"}
                          </button>
                        ) : (
                          <button
                            className="agent-card-btn"
                            disabled={busy}
                            onClick={() => onInstall(a.id)}
                          >
                            {busy ? "处理中…" : "安装"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 样式(token 化)**

`packages/web/src/App.css` 末尾追加(仅用现有 `var(--*)`):
```css
.agent-center-overlay {
  position: fixed; inset: 0; z-index: 100;
  background: var(--overlay-sink);
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.agent-center-modal {
  width: min(920px, 100%); max-height: 82vh; overflow: hidden;
  display: flex; flex-direction: column;
  background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 16px;
  box-shadow: 0 20px 60px var(--overlay-sink);
}
.agent-center-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 18px 22px; border-bottom: 1px solid var(--border);
}
.agent-center-title { font-size: 18px; font-weight: 700; }
.agent-center-close {
  border: none; background: transparent; color: var(--text-muted);
  font-size: 22px; line-height: 1; cursor: pointer;
}
.agent-center-body { overflow-y: auto; padding: 18px 22px; }
.agent-center-group { margin-bottom: 20px; }
.agent-center-group-label { font-size: 13px; color: var(--text-muted); margin-bottom: 10px; }
.agent-center-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px;
}
.agent-card {
  border: 1px solid var(--border); border-radius: 12px; padding: 16px;
  background: var(--overlay-raise); display: flex; flex-direction: column; gap: 8px;
}
.agent-card-name { font-size: 15px; font-weight: 600; }
.agent-card-desc { font-size: 13px; color: var(--text-muted); flex: 1; }
.agent-card-footer { display: flex; justify-content: flex-end; }
.agent-card-btn {
  padding: 6px 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--accent); background: var(--accent); color: #fff; font-size: 13px;
}
.agent-card-btn.installed { background: transparent; color: var(--text-muted); border-color: var(--border); }
.agent-card-btn:disabled { opacity: 0.6; cursor: default; }
```
> 同 Task 8:以 `App.css` `:root` 中真实 token 名为准(`--bg`/`--text`/`--text-muted`/`--border`/`--accent`/`--overlay-raise`/`--overlay-sink`)。`agent-card-btn` 的白色文字属于按钮前景,若主题有 `--on-accent` 之类 token 优先使用。

- [ ] **Step 3: 构建确认无类型错误**

Run: `npm run build -w @lot-agent/web`
Expected: 组件自身通过(Workspace 接线在 Task 10)。

- [ ] **Step 4: 提交**

```bash
git add packages/web/src/components/AgentCenterModal.tsx packages/web/src/App.css
git commit -m "feat(web): Agent 中心 marketplace modal (install/uninstall cards)"
```

---

## Task 10: Workspace / App 接线(收尾,端到端可用)

**Files:**
- Modify: `packages/web/src/pages/Workspace.tsx`
- Modify: `packages/web/src/App.tsx`

**Interfaces:**
- Consumes: `useAgents`(Task 7)、`AgentSwitcher`(Task 8 新 props)、`AgentCenterModal`(Task 9)、`GENERAL_ID`(Task 6)。

- [ ] **Step 1: App 改为把 user 交给 Workspace,agents 由 Workspace 内部 useAgents 管理**

`packages/web/src/App.tsx`:
- 删除 `agents` state 与 `enter` 里 `setAgents(await api.listAgents())`、401 handler 里的 `setAgents([])`、logout 里的 `setAgents([])`,以及 `type Agent` 导入(若不再使用)。
- `enter` 简化为:
```ts
  const enter = useCallback(async (u: User) => {
    setUser(u);
    setView("ready");
  }, []);
```
- 渲染改为(第 75 行附近):
```tsx
    content = <Workspace user={user} onLogout={handleLogout} />;
```

- [ ] **Step 2: Workspace 接入 useAgents + 去掉静态 agents props**

`packages/web/src/pages/Workspace.tsx`:
- import 增加:
```ts
import { useAgents } from "../hooks/useAgents.js";
import { AgentCenterModal } from "../components/AgentCenterModal.js";
import { GENERAL_ID } from "../lib/agent-order.js";
```
- `WorkspaceProps` 去掉 `agents`,保留 `user`、`onLogout`:
```ts
interface WorkspaceProps {
  user: User;
  onLogout: () => void;
}
export function Workspace({ user, onLogout }: WorkspaceProps) {
  const { agents, installed, install, uninstall, promote } = useAgents(true);
```
- 把原来基于 `agents` 的派生改为基于 `installed`。将第 19–23 行 `orderedAgents` 替换为:
```ts
  // 已安装 agents;general 恒第一(仅用于 Sidebar 标签映射等需要全序的场景)。
  const orderedAgents = useMemo(() => {
    const general = installed.find((a) => a.type === "general" || a.id === GENERAL_ID);
    if (!general) return installed;
    return [general, ...installed.filter((a) => a !== general)];
  }, [installed]);
```
- 删除第 173–178 行「屏蔽文案创作」的 `switcherAgents`(改由安装状态控制可见性)。
- 新增 Agent 中心弹窗开关 + 忙碌态:
```ts
  const [centerOpen, setCenterOpen] = useState(false);
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);
```

- [ ] **Step 2b: 溢出选择 handler(promote + 激活)**

在 `handleSwitchAgent` 之后新增:
```ts
  const handlePickOverflow = useCallback(
    async (agentId: string) => {
      await promote(agentId);   // 移到子 Agent 首位(整体第二位),持久化
      handleSwitchAgent(agentId);
    },
    [promote, handleSwitchAgent]
  );
```

- [ ] **Step 3: 安装 / 卸载 handler(含激活项被卸载的回落)**

```ts
  const handleInstall = useCallback(
    async (id: string) => {
      setBusyAgentId(id);
      try { await install(id); } finally { setBusyAgentId(null); }
    },
    [install]
  );

  const handleUninstall = useCallback(
    async (id: string) => {
      setBusyAgentId(id);
      try {
        await uninstall(id);
        // 卸载当前激活的 Agent → 回落通用并进入新会话态
        if (id === activeAgentId) {
          setActiveAgentId(GENERAL_ID);
          setNewAgentId(GENERAL_ID);
          setActiveId(null);
          clear();
          setPreviewContent(null);
        }
      } finally {
        setBusyAgentId(null);
      }
    },
    [uninstall, activeAgentId, setActiveId, clear]
  );
```

- [ ] **Step 4: 更新 switcher 用 installed + 新 props**

把第 180–187 行的 `switcher` 改为:
```tsx
  const switcher = (
    <AgentSwitcher
      agents={installed}
      activeId={activeAgentId}
      onSwitch={handleSwitchAgent}
      onPickOverflow={handlePickOverflow}
      disabled={isStreaming}
    />
  );
```

- [ ] **Step 5: 侧栏底部「Agent 中心」按钮 + 弹窗渲染**

在 `workspace-sidebar` 里 `<Sidebar ... />` 之后(第 207 行 `</Sidebar>` 调用结束后、包裹 div 关闭前)加入按钮:
```tsx
        <button className="sidebar-agent-center-btn" onClick={() => setCenterOpen(true)}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
            <path d="M17.5 14v7M14 17.5h7" />
          </svg>
          Agent 中心
        </button>
```
在组件最外层 `return (<div className="workspace">...)` 的末尾(最后一个 `</div>` 之前)加入弹窗:
```tsx
      {centerOpen && (
        <AgentCenterModal
          agents={agents}
          onInstall={handleInstall}
          onUninstall={handleUninstall}
          onClose={() => setCenterOpen(false)}
          busyId={busyAgentId}
        />
      )}
```

- [ ] **Step 6: 底部按钮样式(token 化)**

`packages/web/src/App.css` 末尾追加:
```css
.sidebar-agent-center-btn {
  display: flex; align-items: center; gap: 8px;
  margin: 8px 12px; padding: 10px 12px;
  border: 1px solid var(--border); border-radius: 10px;
  background: var(--overlay-raise); color: var(--text);
  cursor: pointer; font-size: 14px;
}
.sidebar-agent-center-btn:hover { border-color: var(--accent); color: var(--accent); }
```
> 布局上让它固定在侧栏底部:确认 `.workspace-sidebar` 是 flex column;若需要贴底,给按钮加 `margin-top: auto;`(在 `.sidebar` 之后)。以现有 `.workspace-sidebar` 布局为准微调。

- [ ] **Step 7: 全量构建 + 单测**

Run: `npm run build -w @lot-agent/web && npm test`
Expected: 构建成功;全部单测通过(core / server / web)。

- [ ] **Step 8: 手动端到端验证**

Run: `npm run dev`(需要 PG + Redis;server 启动会 inline migrate 建 `user_agents`)。
验证清单:
1. 登录后切换器显示:通用 + 图片 + 视频(默认安装)。
2. 点侧栏底部「Agent 中心」→ 弹窗按 创作/办公/审核 分组;通用卡片显示「默认」不可卸载。
3. 安装「合同审核」「PPT 制作」「文案创作」→ 关闭弹窗,切换器出现对应胶囊。
4. 安装到子 Agent 超过 6 个 → 出现「更多」;点开气泡列出溢出项;选一个 → 它移到通用之后第一位,原第 6 个进溢出(刷新后仍保持,验证持久化)。
5. 在中心卸载当前激活的子 Agent → 切换器回落到通用、进入新会话态。
6. 切换浅色/深色主题 → 弹窗、气泡、卡片、按钮配色正常(无硬编码色导致的破色)。

- [ ] **Step 9: 提交**

```bash
git add packages/web/src/pages/Workspace.tsx packages/web/src/App.tsx packages/web/src/App.css
git commit -m "feat(web): wire Agent 中心 — useAgents, switcher, overflow, center modal"
```

---

## Self-Review(计划作者已核对)

**Spec coverage:**
- 数据模型 `user_agents` → Task 3 ✓
- 默认安装 & 懒播种 → Task 2(常量)+ Task 3(`getUserAgents` 播种)✓
- Agent 元信息 `category` + ppt/contract stub → Task 1 ✓
- API(GET 注解 / install / uninstall(general 400) / promote(未装 400))→ Task 4 ✓
- 排序与可见性(通用第一、前 6、溢出、MRU 持久化、新装追加、激活被卸载回落)→ Task 6(拆分)+ Task 3(sort_order)+ Task 10(回落 + promote 接线)✓
- 前端组件(client / useAgents / AgentSwitcher / AgentOverflowPopover / AgentCenterModal / SidebarFooter 按钮)→ Task 5/7/8/9/10 ✓
- 测试(sort_order 计算、general 守卫、未知 id、播种、GET 注解、纯拆分)→ Task 2/4/6 ✓;DB 方法按仓库约定不单测,路由测试 + 手动验证覆盖。
- 错误处理(卸载 general 400、未知 id 404、userId 隔离、激活被卸载回落)→ Task 4 + Task 10 ✓
- 明确不做项:未引入评分/搜索/版本/付费/migration runner ✓

**Placeholder scan:** 无 TBD/TODO;所有代码步骤含完整代码。CSS token 名处标注「以 App.css 实际变量名为准」——这是对既有系统的对齐指令,非占位。

**Type consistency:** `installed`/`sortOrder` 字段贯穿 client↔useAgents↔splitInstalledAgents↔AgentSwitcher 一致;`onPickOverflow`(Task 8 定义)= Task 10 `handlePickOverflow`;`GENERAL_ID`(web)与 `GENERAL_AGENT_ID`(server)分别在各自包内使用,值同为 `"general"`。

**已知需实现时确认的点(非阻塞):**
- `App.css` 真实 token 变量名(Task 8/9/10 已标注以 `:root` 为准)。
- `.workspace-sidebar` 是否 flex-column、按钮贴底方式(Task 10 Step 6 标注)。
