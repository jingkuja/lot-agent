# 后台异步记忆抽取 — 设计稿

日期：2026-06-26
范围：把用户记忆的「判断 + 写入」从主对话的可见工具调用，改为对话结束后由 BullMQ worker 跑的、对用户不可见的异步 LLM 抽取任务。延续 `2026-06-26-user-memory-design.md`（已落地的三层记忆基建）。

## 背景 / 问题

当前 user 记忆只在主模型于 ReAct 循环里调用 `memory_write(tier:"user")` 时写入。该 tool_call/tool_result 会被持久化并通过 SSE 推给前端 → **在对话界面渲染成工具气泡**，且阻塞主回答。实际表现：(a) 默认廉价模型 `deepseek-v4-flash` 很少主动调用 → user 记忆几乎不触发；(b) 即便触发，写操作也暴露在用户对话里。

目标：记忆持久化**异步、对话不可见、由独立 LLM 抽取任务完成、只落库**。

## 决策（已与用户确认）

1. **移除所有记忆工具**：从聊天 agent 拿掉 `memory_read/write/list/delete`，对话里不再出现记忆工具气泡。user 记忆由后台抽取写入，并仍自动注入 prompt（不可见）。session 层随工具移除而停用。
2. **运行位置**：复用现有 BullMQ worker 队列。
3. **触发频率**：每个完成回合都 enqueue 一次抽取。

## 非目标（YAGNI）

- 前端记忆管理面板。
- 拆除 session 休眠代码（`RedisSessionBackend`/`hydrate`/`SessionMemoryBackend` 保留不动；每请求一次返回 `[]` 的 Redis GET 开销可忽略）。
- 抽取频率门控（用户选择每回合都跑）。
- 实时把抽取结果推回前端（结果只落库，下一回合通过 prompt 注入体现）。

## 架构改动

### A. 聊天路径不再暴露记忆工具

**`packages/server/src/services/agent-service.ts`**
- `init()` 中**删除** `createMemoryTools()` 的注册循环。general agent 的 `toolNames` 由此不含任何记忆工具。
- 连带效果：Task 2 的策略注入门控 `hasMemoryTools(allowedToolNames)` 自动返回 `false` → `MEMORY_POLICY_PROMPT` 不再注入。**无需改 `agent.ts`**。
- **保留**不可见读路径：`agent.run` 仍调用 `listUserMemory()` 注入 `[User Memory]` 到 system prompt。

**`packages/core/src/tools/memory-tools.ts` + `memory-tools.test.ts`**
- 删除（彻底无人引用——HTTP 路由用 `AgentMemoryStore` 直接读写，不经工具）。
- 从 `packages/core/src/tools/index.ts` 移除 `createMemoryTools` 导出（若存在）。

**session 层**：不改动。工具移除后无写入方，自然停用；`hydrate()` 找不到内容即空。

### B. 后台抽取（core 纯逻辑 + server worker）

**`packages/core/src/memory/extraction.ts`（新，纯函数可测）**

类型：
```ts
export interface MemoryTurn { userMessage: string; assistantText: string }
export interface MemoryExtraction {
  upserts: Array<{ key: string; value: string }>;
  deletes: string[];
}
```

函数：
- `buildExtractionMessages(turn: MemoryTurn, existing: MemoryEntry[]): Message[]`
  - 返回 `[{role:"system", content: <抽取指令>}, {role:"user", content: <本回合 + 现有记忆序列化>}]`。
  - 系统指令要点：你是记忆抽取器；从本回合对话抽取**可长期复用的用户事实/偏好**（称呼、语言偏好、行业/品牌背景、长期约束）；不抽一次性请求、临时上下文、敏感信息（密码/支付）；给定现有记忆，产出 `upserts`（新增或值变更，key 用稳定英文 snake_case）和 `deletes`（被用户更正/推翻/明显过时的现有 key）；**严格只输出 JSON** `{"upserts":[{"key":"","value":""}],"deletes":[""]}`，无可记内容则两者皆空数组。
- `parseExtraction(raw: string): MemoryExtraction`
  - 去除 ```` ```json ```` / ```` ``` ```` 围栏与首尾噪声，`JSON.parse`，校验 `upserts` 为 `{key:string,value:string}[]`、`deletes` 为 `string[]`；任一失败 → `{ upserts: [], deletes: [] }`（绝不抛）。
- `applyExtraction(adapter: PersistentMemoryAdapter, userId: string, ext: MemoryExtraction): Promise<void>`
  - 顺序：先 `deletes`（逐个 `adapter.delete(userId, key)`），再 `upserts`（逐个 `adapter.set(userId, key, value)`）。单条失败不阻断其余（各自 try/catch 吞并继续）。

从 `packages/core/src/memory/index.ts` 导出上述类型与函数。

**`packages/server/src/config.ts`（新，DRY 抽取）**
- 把 `index.ts` 里内联的 LLMConfig 构建（读 `config/default.json` + 注入 `OPENAI_*`/`ANTHROPIC_*`/`LLM_DEFAULT` 环境变量）抽成 `export async function loadLlmConfig(rootDir: string): Promise<LLMConfig>`。
- `index.ts` 的 `loadConfig()` 改为调用它；worker 也调用它来建 LLM provider。

**job 类型**
- 常量 `MEMORY_EXTRACT_JOB = "memory.extract"`，输入 `{ conversationId: string }`（userId 经 `enqueue(type, input, userId)` 第三参传递）。

**`agent-service.ts` enqueue**
- `streamAgentResponse` 的 `finally` 块、`saveFinalAssistant(...)` 之后，加：
  ```ts
  this.jobQueue
    .enqueue("memory.extract", { conversationId }, userId ?? "default")
    .catch((err) => console.warn("[memory.extract] enqueue failed:", err));
  ```
- fire-and-forget，不 `await`，不影响 SSE/流式输出。

**`workers/index.ts` handler**
- 在 `main()` 内构建：`const llmConfig = await loadLlmConfig(ROOT)`；`const llm = createLLMProvider(llmConfig)`；`const memAdapter = new PgMemoryAdapter(db.pool); await memAdapter.init();`。
- 注册：
  ```ts
  queue.process("memory.extract", async (job) => {
    const { conversationId } = job.input as { conversationId: string };
    const userId = job.userId;
    const messages = await db.getMessages(conversationId);
    const turn = lastTurn(messages);            // 取最后一组 user+assistant
    if (!turn) { await queue.updateProgress(job.id, 100); return { upserts: 0, deletes: 0 }; }
    const existing = await memAdapter.list(userId);
    let raw = "";
    for await (const chunk of llm.chat(buildExtractionMessages(turn, existing))) {
      if (chunk.type === "text") raw += chunk.content;
    }
    const ext = parseExtraction(raw);
    await applyExtraction(memAdapter, userId, ext);
    // best-effort 计量（默认文本模型 id）
    await queue.updateProgress(job.id, 100);
    return { upserts: ext.upserts.length, deletes: ext.deletes.length };
  });
  ```
  - `lastTurn(messages)`：**worker 侧**小辅助（操作 server 的 `StoredMessage`，不放 core 以免 core 依赖 server 消息类型），从有序消息里取最后一条 `user` 与其后最近一条 `assistant` 文本，拼成 `MemoryTurn`；取不到返回 `null`。
  - 计量：`modelId` 取默认文本模型——`llmConfig.default === "openai" ? llmConfig.openai.model : llmConfig.anthropic.model`；`meter.record({ userId, taskId: job.id, modelId, usage })`（usage 若 provider 不返回 token 则跳过；best-effort，失败吞）。

## 数据流（改造后）

1. 回合结束 → `streamAgentResponse` 的 `finally` → enqueue `memory.extract {conversationId}`（userId）。用户 SSE 正常收尾，**界面无任何额外内容、无工具气泡**。
2. worker 取 job → 载入最后一轮 + 现有 user 记忆 → 廉价 LLM 抽取 → `applyExtraction` 写 `user_memory`。
3. 下一条消息：`agent.run` 把更新后的 `[User Memory]` 注入 system prompt（不可见）→ 模型"记住"用户，全程无可见写操作。

## 错误处理

全链 best-effort，绝不影响主对话：
- enqueue 失败 → `.catch` 吞并记日志。
- worker 抽取/LLM/parse 失败 → handler 内吞（job 标记失败但不影响用户）；`parseExtraction` 永不抛、坏输出→空操作。
- `applyExtraction` 单条 upsert/delete 失败不阻断其余。

## 测试（TDD，Vitest 同址 `*.test.ts`）

- **`packages/core/src/memory/extraction.test.ts`**
  - `parseExtraction`：合法 JSON；带 ```` ```json ```` 围栏；纯垃圾 → `{upserts:[],deletes:[]}`；缺字段/类型错 → 空；`deletes` 含非字符串 → 过滤或整体空。
  - `buildExtractionMessages`：system+user 两条；user 内容包含本回合文本与现有记忆的 key；existing 为空时也合法。
  - `applyExtraction`：fake `PersistentMemoryAdapter` 验证 deletes 调 `delete`、upserts 调 `set`，且单条失败不阻断后续。
- **`packages/server/src/config.test.ts`**（可选轻量）：`loadLlmConfig` 注入 env 覆盖 default.json 的 apiKey/model。
- worker `memory.extract` 接线：build + 手动冒烟（需 Redis + worker 进程 + LLM key）。

## 手动冒烟（需 Redis + worker + LLM key）

1. `npm run dev`（含 worker）。发一条含明确长期信息的消息，如「我叫小明，长期偏好简体中文」。
2. 期望：用户对话里**没有**任何记忆工具气泡；回答正常。
3. 稍后 worker 日志显示 `memory.extract` 完成；`GET /api/memory` 出现 `preferred_language` / 称呼等条目。
4. 新开一条消息问「我叫什么」→ 模型能答出（来自 prompt 注入的 `[User Memory]`），且仍无可见写操作。
5. 说「不要再用简体了，改用繁体」→ 下一轮抽取应 upsert/纠正该偏好；过时项被 delete。

## 风险 / 取舍

- 每回合 +1 次廉价 LLM 调用（已计量）——用户选定的成本。
- 抽取有延迟：记忆在「下一回合」才体现，非当前回合即时可见。符合"异步、不进当前对话"的要求。
- worker 与 server 各自建一份 LLM provider/`PgMemoryAdapter`——进程隔离使然，`loadLlmConfig` 抽取后配置逻辑已 DRY。
- 抽取质量依赖廉价模型；坏输出 → 空操作（不写脏数据），可后续换更强模型。
