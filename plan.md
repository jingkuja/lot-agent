# Lot-Agent → 多 Agent 内容创作平台：架构升级计划

> **For agentic workers:** 用 superpowers:subagent-driven-development 或 superpowers:executing-plans 逐任务执行。步骤用 `- [ ]` 跟踪。
> **本计划范围**：仅把现有「单 Agent 系统」升级为「支持多 Agent / 多模态 / 计费 / 异步任务 / 审核 / 发布」的**平台底座**。**不实现**文案 / 图片 / 视频三个业务 Agent 的具体业务逻辑（留待后续）。

**Goal:** 在保留现有 TypeScript monorepo（core / server / web）的前提下，把硬编码的单 Agent 引擎改造成可注册多 Agent、可路由多种模型、可跑长耗时异步任务、可计量费用、可挂载审核与发布的平台底座。

**Architecture:** 保持 `@lot-agent/core`（引擎）/ `@lot-agent/server`（Hono + PostgreSQL）/ `@lot-agent/web`（React）三层。新增「Agent 注册表、模型注册表 + 多模态 Provider、异步任务队列 + Worker、对象存储抽象、计费计量、用户与鉴权、审核 Hook、发布连接器」等横切能力，业务 Agent 仅以「定义 + 工具集」形式接入。文档中提到的 Python/FastAPI/Celery 仅作能力参考，不引入。

**Tech Stack:** TypeScript、Hono、PostgreSQL（pg）、**Redis + BullMQ（异步队列，已提供测试 Redis `localhost:6379`，见 P3）**、Redis（缓存/限流/进度 pub-sub）、React/Vite、Vitest（新增测试）、zod（新增配置/入参校验）、MinIO/S3 SDK（对象存储，见 P4）。

---

## 0. 现状评估：代码与架构不合理处

执行前先读懂现状。以下问题在计划中均有对应任务修复（括号标注阶段）。

### A. 正确性 / 安全缺陷（必须先修）
1. **密钥入库**：`config/default.json` 提交了真实 DeepSeek `apiKey`；`packages/server/src/db/database.ts:87` 与 `packages/server/src/index.ts:42` 硬编码数据库口令 `rag123456`。需移到 `.env` 并轮换密钥。(P0)
2. **`PG_PORT` 解析 Bug**：`packages/server/src/index.ts:40` 写法 `Number(process.env.PG_PORT) ?? 5432`，当环境变量缺失时 `Number(undefined)` 得到 `NaN` 而非 `undefined`，`??` 不会兜底，连接将用 `NaN` 端口。应为 `Number(...) || 5432` 或先判空。(P0)
3. **`execute_command` 工具对 LLM 完全开放**（`packages/core/src/tools/builtins.ts:129`），等于把任意 shell 暴露给模型。单机自用尚可，多用户内容平台属 RCE 级风险，需按 Agent 维度收敛工具集 / 沙箱化。(P1)
4. **CORS 全开**（`packages/server/src/index.ts:61` `cors()`）+ 无鉴权 + 单用户硬编码 `userId: "default"`（`agent-service.ts:75`）。平台需要用户体系与鉴权。(P6)
5. **Trace 错误信息恒为 "Max iterations reached"**（`agent-service.ts:355`），无论真实错因（超时 / 工具失败）都这样记录，误导排障。(P2)

### B. 架构局限（升级核心）
6. **Agent 硬编码为单实例**：`new Agent({...})`，system prompt 是 `config.agent.systemPrompt` 一个全局字符串。没有「多 Agent 类型 / 人设 / 各自工具集 / 各自默认模型」的抽象，无法支撑首页选择文案 / 图片 / 视频。(P1)
7. **模型层只认 openai/anthropic 两个文本 Provider**（`llm/factory.ts`），且全局单一 `default`。无模型注册表、无能力路由（image/video/tts/asr/review）、无法按任务选模型。(P2)
8. **同步请求绑定，缺异步任务模型**：`Agent.run()` 是绑定单个 HTTP SSE 连接的生成器。图片（~30s）、视频（~5min）是长耗时任务，必须落到后台队列 + 状态轮询，不能挂在 SSE 连接上。当前完全没有 Job/Worker。(P3)
9. **无产物（artifact）通道**：`messages.content` 只是 `TEXT`（`database.ts:141`），`AgentEvent` 没有图片 / 视频产物事件，前端也只渲染文本。多模态产物无处落地。(P4)
10. **无对象存储抽象**：图片 / 视频需要 OSS/S3/MinIO，代码里完全没有。(P4)
11. **无计费 / 用量计量**：只统计 `total_tokens`，没有模型单价、`usage_logs`、单任务成本、用户额度。方案的核心「统一计费」缺位。(P5)
12. **无审核 / 发布抽象**：方案的内容审核、平台发布（小红书 / 公众号 OAuth）在现有代码无任何落点。(P7)
13. **`agent-service.streamAgentResponse` 是上帝方法**（约 225 行，`agent-service.ts:150-376`）：持久化、埋点、SSE 映射、标题生成、span 管理全部内联，手写状态机（`currentToolCalls`/`assistantContent`）脆弱易错。需要拆分。(P8)

### C. 工程卫生
14. **文档与现实漂移**：`README.md` / 设计文档写 SQLite + pnpm，实际是 PostgreSQL + npm workspaces。(P0)
15. **构建产物与数据库入库**：`packages/*/dist`、`packages/server/data/*.db*`、`config/default.json.tmp`、`schedule.txt` 等被提交，应进 `.gitignore`。(P0)
16. **零测试**：设计文档反复承诺「单元测试覆盖」，实际无任何测试文件，也无测试框架。(P0 引入 Vitest，各阶段补测)
17. **配置无 schema 校验**：`JSON.parse` + `as LLMConfig` 强转，环境变量覆盖逻辑分散且有 Bug（见 #2）。(P0)

---

## 1. 目标分层（升级后）

```
@lot-agent/core
  llm/                文本 Provider（保留）
  providers/   [新]   能力 Provider：ImageProvider / VideoProvider / TTSProvider / ReviewProvider
  models/      [新]   ModelRegistry + 计价元数据 + 能力路由
  agent/             ReAct 引擎（事件流扩展 artifact/cost）
  agents/      [新]   AgentRegistry + AgentDefinition（文案/图片/视频仅放定义占位）
  jobs/        [新]   Job 抽象 + Queue 接口（pg-boss/BullMQ 适配）
  storage/     [新]   ObjectStorage 接口（local/MinIO/S3）
  billing/     [新]   CostCalculator + UsageMeter
  publish/     [新]   PlatformConnector 接口（小红书/公众号占位）
  tools/ skills/ mcp/ context/ memory/ logger/   （保留，按 Agent 维度收敛工具）

@lot-agent/server
  auth/        [新]   用户与鉴权中间件
  routes/            按资源拆分：agents / tasks / assets / usage / billing / publish
  workers/     [新]   后台 Worker 进程入口
  services/          拆分 god method（persistence / trace / sse-adapter）
  db/migrations/ [新] 有序迁移文件取代单个 migrate()

@lot-agent/web
  pages/ Home  [新]   Agent 选择首页
  pages/ Workspace [新] Agent 工作台壳（对话 + 右侧预览面板 + 产物画廊 + 任务进度）
```

---

## P0 — 工程卫生与安全基线

**目标**：清理密钥、修连接 Bug、引入测试与配置校验、对齐文档。无功能变更。

**Files:**
- Modify: `.gitignore`
- Create: `.env.example`
- Modify: `packages/server/src/index.ts:19-46`（loadConfig）
- Create: `packages/core/src/config/schema.ts`
- Modify: `config/default.json`（移除密钥，置空）
- Modify: `README.md`、`docs/superpowers/specs/2026-06-03-lot-agent-design.md`（SQLite→PostgreSQL、pnpm→npm）
- Create: `vitest.config.ts`（根）、各 package 加 `test` 脚本

- [ ] **从 git 移除构建产物 / 数据库 / 临时文件**，并加入 `.gitignore`：
```
node_modules/
dist/
*.tsbuildinfo
data/*.db
data/*.db-shm
data/*.db-wal
packages/*/dist/
packages/*/data/
.env
.env.local
config/default.json
config/*.tmp
.DS_Store
```
  执行：`git rm -r --cached packages/*/dist packages/server/data config/default.json.tmp packages/server/schedule.txt` 后提交。
- [ ] **轮换并外置密钥**：把 `config/default.json` 的 `apiKey` 改为 `""`；新建 `.env.example` 列出 `OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL / ANTHROPIC_API_KEY / PG_HOST / PG_PORT / PG_USER / PG_PASSWORD / PG_DATABASE / REDIS_URL`（开发期 `REDIS_URL=redis://:rag123456@localhost:6379`）。提醒用户作废已泄露的 DeepSeek key 与库口令；**注意 Redis 测试密码与 PG 库口令相同（`rag123456`），生产环境必须各自独立并轮换**。
- [ ] **修 `PG_PORT` Bug**：`port: Number(process.env.PG_PORT) || 5432`；同时去掉 `index.ts:42` 与 `database.ts:82-88` 的硬编码口令默认值，缺失时抛错而非用 `rag123456`。
- [ ] **引入 Vitest**：根 `vitest.config.ts`，`packages/core/package.json` 与 `server` 加 `"test": "vitest run"`、devDependency `vitest`。
- [ ] **配置 zod 校验**：`packages/core/src/config/schema.ts` 定义 `AppConfigSchema`，`loadConfig` 用 `AppConfigSchema.parse(...)` 替代 `as LLMConfig`，校验失败给出清晰报错。先写测试：
```ts
// packages/core/src/config/schema.test.ts
import { describe, it, expect } from "vitest";
import { AppConfigSchema } from "./schema.js";
describe("AppConfigSchema", () => {
  it("rejects config without llm.default", () => {
    expect(() => AppConfigSchema.parse({ llm: {} })).toThrow();
  });
  it("accepts a minimal valid config", () => {
    const cfg = AppConfigSchema.parse({
      llm: { default: "openai", openai: { apiKey: "x", model: "m" }, anthropic: { apiKey: "", model: "m" } },
      agent: { maxIterations: 10, systemPrompt: "hi" },
      mcp: { servers: [] },
      server: { port: 3000, host: "0.0.0.0" },
    });
    expect(cfg.llm.default).toBe("openai");
  });
});
```
- [ ] 运行 `npm test -w @lot-agent/core` 确认通过；更新 README/设计文档技术栈描述。
- [ ] **Commit**：`chore: secrets/.gitignore hardening, fix PG_PORT, add vitest + config schema`

---

## P1 — Agent 抽象与注册表（多 Agent 底座）

**目标**：把单 Agent 改造成「按 `agentId` 路由的多 Agent」。每个 Agent 是一份定义（人设 prompt + 允许的工具子集 + 默认模型 + 入参 schema），引擎据此装配运行。文案/图片/视频仅放**定义占位**，不写业务。

**Files:**
- Create: `packages/core/src/agents/types.ts`、`registry.ts`、`registry.test.ts`、`index.ts`
- Create: `packages/core/src/agents/definitions/`（`copywriting.ts`/`image.ts`/`video.ts` 占位定义）
- Modify: `packages/core/src/agent/agent.ts`（按定义装配工具/ prompt/ 模型）
- Modify: `packages/core/src/tools/registry.ts`（支持按名取子集）
- Modify: `packages/server/src/services/agent-service.ts`（streamAgentResponse 接收 agentId）
- Create: `packages/server/src/routes/agents.ts`（`GET /api/agents` 列表）

- [ ] **定义 `AgentDefinition` 契约**（`agents/types.ts`）：
```ts
export type AgentType = "general" | "copywriting" | "image" | "video";

export interface AgentDefinition {
  id: string;                 // "copywriting"
  name: string;               // "文案创作"
  type: AgentType;
  description: string;        // 首页卡片一句话
  systemPrompt: string;       // 人设
  toolNames: string[];        // 该 Agent 允许使用的工具子集（白名单）
  defaultModelId: string;     // 默认模型（见 P2 ModelRegistry）
  /** 工作台输入表单的 JSON Schema（平台/风格/主题等），前端据此渲染 */
  inputSchema?: Record<string, unknown>;
}

export interface AgentRegistry {
  register(def: AgentDefinition): void;
  get(id: string): AgentDefinition | undefined;
  list(): AgentDefinition[];
}
```
- [ ] **先写注册表测试**（`agents/registry.test.ts`）：注册后 `get`/`list` 可取回；`get` 未知 id 返回 `undefined`。运行确认 FAIL。
- [ ] **实现 `InMemoryAgentRegistry`**（`agents/registry.ts`）；运行确认 PASS。
- [ ] **ToolRegistry 支持子集**：在 `tools/registry.ts` 加 `toLLMTools(names?: string[])`，传入白名单时只导出对应工具。补一条测试：白名单只含 `read_file` 时 `toLLMTools(["read_file"]).length === 1`。
- [ ] **引擎按定义装配**：`Agent` 构造支持 `allowedToolNames`、用 `toLLMTools(allowedToolNames)`；`general` 定义保留现有全量工具，`copywriting` 仅 `["web_search","web_fetch"]`（**不含** `execute_command`，落实 #3 收敛）。
- [ ] **放占位定义**：`definitions/copywriting.ts` 等导出 `AgentDefinition`，`systemPrompt` 用方案 3.2 的小红书示例 prompt，`toolNames` 收敛，`inputSchema` 留最小字段（platform/topic/style）。**不实现**业务流程。
- [ ] **服务与路由接入**：`AgentService` 持有 `AgentRegistry` 并在 `init()` 注册内置定义；`streamAgentResponse(conversationId, userMessage, agentId)` 按 `agentId` 取定义装配；新增 `GET /api/agents` 返回 `list()`（供首页渲染）。`conversations` 表加 `agent_id` 列（见 P0 之后的迁移）。
- [ ] 运行 `npm test -w @lot-agent/core` 全绿。
- [ ] **Commit**：`feat(core): agent registry + per-agent tool scoping; expose GET /api/agents`

---

## P2 — 模型注册表 + 多模态 Provider + 成本元数据

**目标**：用 `ModelRegistry` 取代 `llm/factory.ts` 的二选一逻辑，支持按 `modelId`/能力取 Provider，并携带计价信息（供 P5 计费）。新增图像/视频/TTS Provider 接口（**只定义接口 + 一个可跑通的占位实现**，真实厂商对接留后续）。

**Files:**
- Create: `packages/core/src/models/types.ts`、`registry.ts`、`registry.test.ts`
- Create: `packages/core/src/providers/image.ts`、`video.ts`、`tts.ts`（接口 + Stub）
- Modify: `packages/core/src/llm/factory.ts`（改为向 ModelRegistry 注册文本模型）
- Modify: `packages/core/src/agent/agent.ts`（按 `def.defaultModelId` 取文本 Provider）
- Modify: `config/default.json`（新增 `models` 段）

- [ ] **定义模型与能力契约**（`models/types.ts`）：
```ts
export type ModelType = "llm" | "image" | "video" | "tts" | "asr" | "embedding" | "review";
export type BillingUnit = "token" | "image" | "second" | "character" | "request";

export interface ModelConfig {
  id: string;            // "deepseek-v4-flash" / "wanx-standard" / "kling-standard"
  type: ModelType;
  provider: string;      // "openai" | "anthropic" | "wanx" | "kling" ...
  billingUnit: BillingUnit;
  inputPrice: number;    // 元/单位（LLM 输入；非 LLM 为 0）
  outputPrice: number;   // 元/单位（LLM 输出；非 LLM 用 unitPrice）
  unitPrice: number;     // 非 LLM 统一单价（元/张|秒|千字符|次）
  enabled: boolean;
}

export interface ModelRegistry {
  register(cfg: ModelConfig, factory: () => unknown): void;
  getConfig(id: string): ModelConfig | undefined;
  list(type?: ModelType): ModelConfig[];
  getProvider<T = unknown>(id: string): T | undefined; // 惰性实例化
}
```
- [ ] **先写测试**：注册 1 个 llm + 1 个 image，`list("image").length === 1`，`getConfig` 取回价格字段，`getProvider` 惰性创建且单例。运行确认 FAIL → 实现 → PASS。
- [ ] **定义多模态 Provider 接口**（`providers/*.ts`）：
```ts
// image.ts
export interface ImageGenRequest { prompt: string; size?: string; n?: number; }
export interface ImageGenResult { images: { url: string }[]; raw?: unknown; }
export interface ImageProvider { generate(req: ImageGenRequest): Promise<ImageGenResult>; }

// 占位实现：返回一张固定占位图 URL，便于打通链路与计费，不调真实 API
export class StubImageProvider implements ImageProvider {
  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    return { images: [{ url: `stub://image?prompt=${encodeURIComponent(req.prompt)}` }] };
  }
}
```
  `video.ts`/`tts.ts` 同样给接口 + Stub（video 返回 `stub://video`，含 `durationSec`）。
- [ ] **factory 改造**：`createTextModels(config, registry)` 把现有 openai/anthropic 注册进 `ModelRegistry`；保留 `LLMProvider` 接口不变。`config/default.json` 增加 `models: [...]`（含 DeepSeek 文本与 1 个 image/video 占位的计价元数据，价格取方案 6.3/6.4）。
- [ ] **引擎按 modelId 取文本 Provider**：`Agent` 运行时由 `def.defaultModelId` → `registry.getProvider<LLMProvider>(id)`，替换原来注入单一 llm 的方式（保持 `AgentContext.llm` 兼容：服务层解析后注入）。
- [ ] 运行 core 测试全绿。
- [ ] **Commit**：`feat(core): model registry with pricing + image/video/tts provider interfaces (stub)`

---

## P3 — 异步任务队列与 Worker

**目标**：长耗时生成（图片/视频）从「SSE 同步」改为「提交任务 → 后台 Worker 执行 → 轮询/SSE 查状态」。引入队列抽象。

**决策**：已提供测试 Redis（`localhost:6379`），默认 **BullMQ**（并发控制、限速、重试、延迟任务更适合生成类长任务，且为 V2「定时发布」打基础）。`JobQueue` 接口隔离实现，需要时可回退 pg-boss。进度通过 Redis pub/sub 扇出，前端可订阅而非纯轮询。

**Files:**
- Create: `packages/core/src/jobs/types.ts`、`bullmq-queue.ts`、`types.test.ts`
- Create: `packages/core/src/cache/redis.ts`（共享 Redis 客户端，供队列/缓存/限流复用）
- Create: `packages/server/src/db/migrations/002_tasks.sql`
- Create: `packages/server/src/workers/index.ts`（Worker 进程入口）
- Create: `packages/server/src/routes/tasks.ts`（`POST /api/tasks`、`GET /api/tasks/:id`）
- Modify: `package.json`（新增 `dev:worker` 脚本）

- [ ] **定义 Job 契约**（`jobs/types.ts`）：
```ts
export type JobStatus = "pending" | "running" | "succeeded" | "failed";
export interface JobRecord<I = unknown, O = unknown> {
  id: string;
  type: string;            // "image.generate" | "video.generate"
  status: JobStatus;
  progress: number;        // 0-100
  input: I;
  output?: O;              // 含 asset 引用（见 P4）
  error?: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}
export interface JobQueue {
  enqueue<I>(type: string, input: I, userId: string): Promise<string>; // 返回 jobId
  process<I, O>(type: string, handler: (job: JobRecord<I>) => Promise<O>): void;
  get(id: string): Promise<JobRecord | null>;
  updateProgress(id: string, progress: number): Promise<void>;
}
```
- [ ] **建表**（`002_tasks.sql`）：`tasks(id, type, status, progress, input jsonb, output jsonb, error, user_id, created_at, updated_at)` + 索引 `(user_id, created_at desc)`、`(status)`。
- [ ] **先写测试**（`jobs/types.test.ts`，用内存假实现满足契约，避免单测依赖真 Redis）：`enqueue` 返回 id 且状态 `pending`；注册 `process` 后执行使状态变 `succeeded` 且 `output` 写回；`updateProgress` 可读到进度。FAIL → 实现 `BullmqJobQueue`（连 `REDIS_URL`，进度写 `tasks` 表 + Redis pub/sub 发布 `task:<id>:progress`）→ PASS。集成测试用提供的测试 Redis 跑端到端入队/消费。
- [ ] **Worker 进程**（`workers/index.ts`）：连库、注册 `image.generate`/`video.generate` 两个 handler，handler 内调用 P2 的 Stub Provider，分阶段 `updateProgress(25/50/100)`，产物先返回 Stub URL（P4 接对象存储后替换）。**不写业务编排**，只打通「入队→执行→落库」。
- [ ] **任务路由**：`POST /api/tasks {type,input}` 入队返回 `jobId`；`GET /api/tasks/:id` 返回状态/进度/产物。
- [ ] **脚本**：`package.json` 加 `"dev:worker": "npm run dev -w @lot-agent/server -- worker"`（或独立入口），并把 worker 纳入 `dev` 的 concurrently。
- [ ] 运行测试全绿；手动 `curl` 入队一个 `image.generate` 看状态流转到 `succeeded`。
- [ ] **Commit**：`feat: async job queue (pg-boss) + worker + tasks API`

---

## P4 — 对象存储抽象与产物（artifact）通道

**目标**：生成的图片/视频落到对象存储，DB 用 `assets` 表登记，消息/事件流可引用产物。打通多模态产物链路。

**Files:**
- Create: `packages/core/src/storage/types.ts`、`local-storage.ts`、`s3-storage.ts`、`local-storage.test.ts`
- Create: `packages/server/src/db/migrations/003_assets.sql`
- Create: `packages/server/src/routes/assets.ts`（`GET /api/assets/:id`）
- Modify: `packages/core/src/agent/agent.ts`（`AgentEvent` 增 `artifact` 事件）
- Modify: `packages/server/src/workers/index.ts`（产物写存储 + 登记 asset）

- [ ] **定义存储契约**（`storage/types.ts`）：
```ts
export interface PutObjectInput { key: string; body: Buffer | Uint8Array; contentType: string; }
export interface ObjectStorage {
  put(input: PutObjectInput): Promise<{ url: string }>;
  getUrl(key: string): string;            // 可访问 URL（本地为静态路由，S3 为预签名）
  delete(key: string): Promise<void>;
}
```
- [ ] **先写 `LocalStorage` 测试**：`put` 写入临时目录后 `getUrl` 返回可读路径，`delete` 后文件消失。FAIL → 实现 `LocalStorage`（写 `data/assets/`，经 server 静态路由暴露）→ PASS。`S3Storage`（MinIO/OSS 兼容）给实现但默认不启用，由 config 切换。
- [ ] **建表**（`003_assets.sql`）：`assets(id, task_id, user_id, type[image|video|audio], storage_key, url, mime, size_bytes, width, height, duration_sec, created_at)`。
- [ ] **扩展事件流**：`AgentEvent` 增 `{ type: "artifact"; assetId: string; url: string; mediaType: string }`，便于文本对话里以缩略图引用产物。
- [ ] **Worker 落产物**：image/video handler 生成后（占位阶段先把 Stub 内容写一段 bytes）`storage.put` → 插入 `assets` → `job.output = { assetIds: [...] }`。
- [ ] **资产路由 + 静态服务**：`GET /api/assets/:id` 返回元数据；server 挂 `/static/assets/*` 指向本地存储目录。
- [ ] 运行测试全绿。
- [ ] **Commit**：`feat: object storage abstraction + assets table + artifact events`

---

## P5 — 计费计量（CostCalculator + UsageMeter）

**目标**：每次模型调用按 P2 的计价元数据计算成本并落 `usage_logs`，支持按用户/类型/时间聚合与额度防护。这是方案「统一计费」的底座。

**Files:**
- Create: `packages/core/src/billing/cost.ts`、`cost.test.ts`、`meter.ts`
- Create: `packages/server/src/db/migrations/004_billing.sql`
- Create: `packages/server/src/routes/usage.ts`（`/api/usage/summary`、`/api/usage/logs`、`/api/balance`）
- Modify: `packages/core/src/agent/agent.ts`（每次 LLM `done` 用量 → meter）
- Modify: `packages/server/src/workers/index.ts`（image/video 完成 → meter）

- [ ] **定义计价函数**（`billing/cost.ts`）：
```ts
import type { ModelConfig } from "../models/types.js";
export interface UsageCounts { inputCount: number; outputCount: number; }
/** 返回元为单位的总成本 */
export function calcCost(model: ModelConfig, usage: UsageCounts): number {
  if (model.type === "llm" || model.type === "embedding") {
    return (usage.inputCount * model.inputPrice + usage.outputCount * model.outputPrice) / 1000;
  }
  // image/video/tts/asr/review：outputCount 为张数/秒数/字符数/次数
  return usage.outputCount * model.unitPrice;
}
```
- [ ] **先写测试**：LLM 按 (input·inPrice + output·outPrice)/1000；image 按 张数·unitPrice；video 按 秒数·unitPrice。FAIL → 实现 → PASS。
- [ ] **建表**（`004_billing.sql`）：`model_configs`（落 P2 元数据，便于运营改价）、`usage_logs(id,user_id,task_id,model_id,model_type,input_count,output_count,total_cost,created_at)`、`user_balance(user_id,balance,daily_limit,monthly_limit,monthly_used)`。
- [ ] **UsageMeter**（`billing/meter.ts`）：`record({userId, taskId, modelId, usage})` 查 `model_configs` → `calcCost` → 插 `usage_logs` → 累加 `user_balance.monthly_used`。
- [ ] **埋点接入**：LLM 流 `done.usage` → meter（文本）；worker 完成 image/video → meter（按张/秒）。Trace metadata 增 `totalCost`。
- [ ] **额度防护**：高成本任务（image/video）入队前检查 `user_balance` 是否超 `daily_limit/monthly_limit`，超限拒绝并返回预估费用（落实方案「费用预估 + 额度管控」）。
- [ ] **缓存复用（Redis）**：用 `cache/redis.ts` 对「相同模型 + 相同归一化入参」的生成结果做缓存（key = `gen:<modelId>:<hash(input)>`，存 assetIds/文本），命中直接返回且**不计费**，落实方案 6.7「缓存复用」成本策略。先写测试：同一入参第二次调用走缓存、不再产生 `usage_logs`。
- [ ] **用量接口**：`/api/usage/summary?by=model_type|model|day`、`/api/usage/logs`、`/api/balance`。
- [ ] 运行测试全绿。
- [ ] **Commit**：`feat: cost calculator + usage metering + balance guard + usage API`

---

## P6 — 多用户与并发会话鉴权

**目标**：去掉硬编码 `userId:"default"`，建**多用户体系**，支持**多人同时登录、同一账号多端并发会话**，给会话/任务/用量/余额/资产加 `user_id` 维度并强制归属校验。**关键并发修复**：当前 `AgentService` 共用一个 `AgentMemoryStore`，其 ephemeral 状态在每次 run 开头被全局 `clearEphemeral()` 清空——多用户并发请求会相互踩踏，必须改为**按请求/会话隔离**。

**Files:**
- Create: `packages/server/src/db/migrations/005_users.sql`（实际仍写入现有 `migrate()`，沿用内联模式）
- Create: `packages/server/src/auth/session-store.ts`、`session-store.test.ts`（会话令牌存取，支持一账号多活跃会话）
- Create: `packages/server/src/auth/middleware.ts`、`middleware.test.ts`
- Create: `packages/server/src/routes/auth.ts`（login / logout / me）
- Modify: `packages/server/src/index.ts`（挂鉴权中间件、收紧 CORS、`/api/auth` 公开）
- Modify: 各 route + `agent-service.ts`（从上下文取 `userId` 替代 `"default"`；按用户隔离 memory）

- [ ] **建表**（写入现有 `migrate()`）：
  - `users(id UUID pk, email UNIQUE NOT NULL, name, created_at)`。
  - `sessions(id UUID pk, user_id FK→users ON DELETE CASCADE, token VARCHAR UNIQUE NOT NULL, created_at, expires_at, last_seen_at)`——**一个 user 可有多行 session**（多端/多人并发登录），索引 `(token)`、`(user_id)`。
  - 给 `conversations`/`tasks`/`assets`/`usage_logs` 的 `user_id` 由 `'default'` 改为引用真实用户：保留列，新增索引；存量行回填到一个种子用户 `seed@local`（迁移幂等）。`user_balance.user_id` 已是主键。
- [ ] **SessionStore**（`auth/session-store.ts`，TDD）：`createSession(userId)`→生成随机 token（`crypto.randomBytes`）写库返回 token；`resolve(token)`→返回 `{userId}` 或 null（校验未过期，刷新 `last_seen_at`）；`revoke(token)`。**同一 userId 多次 `createSession` 产生多个并存有效 token**。先写测试：两次 create 同一 user → 两个 token 都能 resolve 到该 user；revoke 其一不影响另一；过期 token resolve 为 null。
- [ ] **鉴权中间件**（`auth/middleware.ts`，TDD）：从 `Authorization: Bearer <token>` 经 `SessionStore.resolve` 注入 `c.set("userId", userId)`；缺失/无效 → 401。先写测试：无 token→401；有效 token→`next()` 且能取到 userId；无效 token→401。
- [ ] **Auth 路由**（`routes/auth.ts`，**公开、免鉴权**）：`POST /api/auth/login {email, name?}`→ upsert user + `createSession` → 返回 `{token, user}`；`POST /api/auth/logout`（带 token）→ `revoke`；`GET /api/auth/me`（带鉴权）→ 当前 user。开发期允许任意 email 直接登录（无密码），后续接 OAuth/密码。
- [ ] **并发隔离 memory**（关键）：`AgentService` 不再持有单一共享 `AgentMemoryStore`。改为**每次 `streamAgentResponse` 按 `userId` 构造（或从 per-user 缓存取）一个 memory 实例**，且 ephemeral 状态随请求生命周期，不跨请求共享；持久化 user memory 仍按 `userId` 落库查询。确保两个并发请求互不清空对方 ephemeral。先写/补一个并发测试：并发两个 run 使用不同 userId，各自 memory 不串。
- [ ] **全链路 user 维度**：`streamAgentResponse(conversationId, userMessage, agentId, userId)`；`createConversation/listConversations/getConversation` 带 `userId` 并校验归属（他人会话 404）；`tasks` 入队 `enqueue(type, input, userId)` 与 `GET /api/tasks/:id` 校验归属；`usage`/`balance`/`assets` 路由用注入的 `userId` 取代 `"default"`；worker 仍用 task 行上的 `user_id` 计费（任务已带 userId）。
- [ ] **收紧 CORS**：`cors({ origin: <配置白名单>, credentials: true })` 取代裸 `cors()`；白名单从 env/config 读（开发默认 `http://localhost:5173`）。
- [ ] **限流（Redis，可选并发保护）**：基于 Redis 原子计数按 `userId` 滑窗限流生成类接口（如 N 次/分钟）。先写测试：超阈值返回 429。
- [ ] 运行 `npm test -w @lot-agent/core` 与 `-w @lot-agent/server` 全绿；构建通过；并发 e2e：两个用户各自登录拿 token，并发发起任务/会话，互不可见对方数据。
- [ ] **Commit**：`feat(server): multi-user auth with concurrent sessions + per-user scoping + memory isolation; tighten CORS`

---

## P7 — 审核 Hook 与发布连接器（接口层，占位实现）

**目标**：为内容审核与平台发布留**可插拔接口与数据表**，提供 Stub 实现打通链路，真实对接（阿里云内容安全、小红书/公众号 OAuth）留后续。

**Files:**
- Create: `packages/core/src/providers/review.ts`（接口 + 关键词 Stub）
- Create: `packages/core/src/publish/types.ts`、`stub-connector.ts`
- Create: `packages/server/src/db/migrations/006_review_publish.sql`
- Create: `packages/server/src/routes/publish.ts`
- Create: `packages/core/src/providers/review.test.ts`

- [ ] **审核接口**（`providers/review.ts`）：
```ts
export type ReviewVerdict = "pass" | "suspect" | "reject";
export interface ReviewResult { verdict: ReviewVerdict; reasons: string[]; }
export interface ReviewProvider {
  reviewText(text: string): Promise<ReviewResult>;
}
export class KeywordReviewProvider implements ReviewProvider { /* 本地违禁词表，第一道过滤 */ }
```
  先写测试：含违禁词 → `reject`；正常文本 → `pass`。FAIL → 实现 → PASS。
- [ ] **发布连接器接口**（`publish/types.ts`）：
```ts
export interface PlatformConnector {
  platform: string;                 // "xiaohongshu" | "wechat_mp"
  getAuthUrl(userId: string): string;            // OAuth 授权链接
  exchangeToken(code: string): Promise<{ accessToken: string; expiresAt: number }>;
  publish(input: { title: string; body: string; assetIds: string[] }): Promise<{ url: string }>;
}
```
  `stub-connector.ts` 给两平台占位实现（`publish` 返回 `stub://published/...`）。
- [ ] **建表**（`006_review_publish.sql`）：`review_logs(id,task_id,content_type,verdict,detail,created_at)`、`platform_accounts(id,user_id,platform,access_token,expires_at)`、`publish_records(id,user_id,project_id,platform,status,published_url,created_at)`。
- [ ] **发布路由**：`GET /api/platform/auth/:platform`、`POST /api/publish`、`GET /api/publish/records`，内部走 `PlatformConnector`，发布前先调 `ReviewProvider` 并记 `review_logs`（`reject` 则拦截）。
- [ ] 运行测试全绿。
- [ ] **Commit**：`feat: review provider + publish connector interfaces (stub) + tables`

---

## P8 — 服务层重构与前端壳

**目标**：拆掉 `streamAgentResponse` 上帝方法；前端从单聊天页升级为「首页 Agent 选择 + 工作台壳（对话 + 右侧预览面板 + 产物画廊 + 任务进度）」。仍不含业务 Agent 逻辑。

**Files:**
- Create: `packages/server/src/services/persistence.ts`、`trace-recorder.ts`、`sse-adapter.ts`
- Modify: `packages/server/src/services/agent-service.ts`（编排，瘦身）
- Create: `packages/web/src/pages/Home.tsx`、`pages/Workspace.tsx`
- Create: `packages/web/src/components/PreviewPanel.tsx`、`ArtifactGallery.tsx`、`TaskProgress.tsx`
- Modify: `packages/web/src/App.tsx`（路由：`/` 首页、`/agent/:id` 工作台）

- [ ] **抽出持久化**（`persistence.ts`）：把消息/工具调用落库逻辑从 god method 移出为 `MessageRepository`，纯函数式、可单测（mock pool）。先写测试：保存 assistant + tool 调用后能按会话取回正确顺序。
- [ ] **抽出 trace 记录**（`trace-recorder.ts`）：span 起止/落库内聚于此；**修复 #5**：`error_message` 用真实错因（从 `error` 事件的 message 透传），而非恒为 "Max iterations reached"。
- [ ] **抽出 SSE 适配**（`sse-adapter.ts`）：`AgentEvent`（含新增 `artifact`）→ SSE 行的纯映射，单测覆盖每种事件。
- [ ] **`AgentService` 瘦身**：仅负责编排「装配 Agent → 跑引擎 → 调三个协作件」，目标 < 80 行。运行 server 测试全绿。
- [ ] **前端首页**（`Home.tsx`）：拉 `GET /api/agents` 渲染 3 张卡片（方案 2.4 布局），点击进 `/agent/:id`。
- [ ] **工作台壳**（`Workspace.tsx` + 组件）：左对话（复用现有 SSE 流）+ 右 `PreviewPanel`（接收结构化 JSON 渲染平台卡片，先做小红书/公众号两个静态模板）+ `ArtifactGallery`（渲染 `artifact` 事件缩略图）+ `TaskProgress`（轮询 `GET /api/tasks/:id` 显示进度）。**不写业务生成逻辑**，仅打通组件与 API。
- [ ] **Commit**：`refactor(server): split agent-service god method; feat(web): home + workspace shell`

---

## 自检（按 writing-plans 要求）

- **方案覆盖**：多 Agent(P1)、多模态模型/Provider(P2)、异步队列(P3)、对象存储/产物(P4)、统一计费/额度(P5)、用户鉴权(P6)、审核+发布接口(P7)、前端首页/工作台/预览(P8) 均有任务；安全与文档漂移在 P0。**有意不含**：文案/图片/视频业务编排、真实厂商 API 对接、定时发布/数据回流（按本次「仅架构升级」范围）。
- **类型一致性**：`AgentDefinition.defaultModelId` ↔ `ModelRegistry.getProvider(id)`；`JobRecord.output.assetIds` ↔ `assets` 表 ↔ `AgentEvent.artifact.assetId`；`ModelConfig` 价格字段 ↔ `calcCost` 一致。
- **占位边界明确**：P2/P3/P4/P7 的 Stub 仅为打通链路与计费/状态流转，真实模型与平台对接为后续业务阶段。

## 风险
- **队列实现**：默认 BullMQ（依赖 Redis，已提供测试环境）。单测用内存假实现、集成测试用真 Redis；`JobQueue` 接口已隔离，必要时回退 pg-boss。
- **Redis 可用性**：队列/缓存/限流/进度 pub-sub 均依赖 Redis，需纳入健康检查与启动依赖；Redis 不可用时缓存/限流应「降级放行」而非阻断主流程。
- **存量数据迁移**：P6 给已有表加 `user_id` 需回填默认用户，迁移脚本须幂等。
- **密钥已泄露**：P0 仅外置配置，**已提交的 DeepSeek key、PG 库口令、Redis 密码（三者中 PG 与 Redis 同为 `rag123456`）必须立即作废并各自独立轮换**（git 历史仍含旧值）。

## 不在本期范围（后续业务阶段）
文案/图片/视频三个 Agent 的业务流程与 Prompt 工程、真实模型厂商对接（通义万相/可灵/DALL·E）、真实审核（阿里云内容安全）、小红书/公众号真实 OAuth 与发布、定时发布、数据回流、爆款分析等。
