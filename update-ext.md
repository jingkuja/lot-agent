# core 模块扩展设计：欠缺能力盘点与升级方案（update-ext）

> **范围**：仅针对 `packages/core`（`@lot-agent/core`）。延续 `plan.md` P0–P8 打好的平台底座，
> 找出 core 在进入「业务 Agent 阶段」之前仍欠缺或需要改进的能力，并给出接口级设计。
> **不包含**：三个业务 Agent 的业务编排、真实厂商 API 对接的具体实现（仍留在既有接口后面）、
> server/web 层的改造（涉及处仅标注"server 需同步接线"）。
> 阶段编号沿用计划体例，记为 **E0–E6**（Extension）；E0 为正确性/安全修复，必须先行。

---

## 0. 现状成熟度总览

| 模块 | 现状 | 主要缺口 | 阶段 |
|---|---|---|---|
| `agent/` ReAct 引擎 | 成熟：超时/取消/dedup/endsTurn/滚动摘要齐备 | 无子 Agent 编排原语；工具串行执行；无 thinking 事件 | E3/E5 |
| `llm/` 文本 Provider | openai + anthropic 可用 | **计费 usage 缺失（两家）**；无调用参数；无重试；无 prompt cache；忽略推理内容 | E0/E1 |
| `models/` 注册表 | 注册/惰性实例化/计价元数据可用 | 无能力元数据（上下文窗口等）；`enabled` 不生效；无成本预估 | E2 |
| `context/` 上下文管理 | 成熟：弹性预算 + 滚动摘要 + 粘性边界 | 窗口固定 120K 与模型脱节；retrieval 通道预留未接线 | E2/E4 |
| `tools/` 工具系统 | 超时/重试/错误分类完善 | **路径逃逸、SSRF、入参不校验**；无审批标志；无并行执行 | E0/E6 |
| `memory/` 三层记忆 | 三层 + PG 适配 + 抽取管道可用 | 注入 prompt 无上限；检索是 ILIKE 非语义 | E4 |
| `providers/` 生成/审核 | image/video 适配器模式 + Mock 齐备 | 审核仅文本；无 ASR/Embedding 接口；单 url 输出；HTTP 无超时 | E1/E3 |
| `jobs/` 任务队列 | 接口 + 内存实现可用 | 无取消/优先级/延迟/心跳/重试策略（定时发布依赖延迟任务） | E5 |
| `storage/` 对象存储 | Local 实现可用 | 仅 Buffer（视频内存爆炸风险）；无 S3/预签名/exists | E6 |
| `publish/` 发布连接器 | 接口 + Stub | 无平台特有字段/refreshToken/定时发布/幂等键 | E6 |
| `skills/` 技能 | 目录加载 + 触发匹配可用 | 朴素子串触发；注入无 token 预算 | E6 |
| `mcp/` MCP 客户端 | 三种 transport 可连 | 工具未映射 execConfig；超时不关 transport；无重连/鉴权头 | E6 |
| `logger/` 可观测 | TraceManager + ConsoleSink | **trace/span Map 无界增长**；无结构化日志/metrics | E0/E6 |
| `billing/` 计费 | `calcCost` 纯函数 + 测试 | 无 `estimateCost`（额度预检在用拍脑袋估算） | E2 |
| `config/` 配置校验 | zod 校验主干 | models 的 provider 细节、mcp servers 未校验 | E6 |

---

## 1. 问题清单

### 1.1 正确性 / 安全（E0，必须先修）

1. **Anthropic 计费恒为 0**：`llm/anthropic.ts:140-143` 的 `done` chunk 不携带 `usage`，
   `Agent.run` 的 `inputTokens/outputTokens/totalTokens` 全程为 0 → `usage_logs` 记 0 成本。
   SDK 的 `message_delta`/`message_stop` 事件里有 `usage`，只是没取。
2. **OpenAI 流式 usage 依赖厂商默认行为**：`llm/openai.ts:49-58` 创建流时未传
   `stream_options: { include_usage: true }`。DeepSeek 默认在末 chunk 带 usage 所以现在"碰巧能用"，
   换任何严格遵循 OpenAI 规范的端点计费即归零。
3. **文件工具路径逃逸**：`tools/builtins.ts:29-31` `resolvePath` 只做 `resolve(cwd, path)`，
   `../../etc/passwd` 可读、`../` 可写任意位置。多用户平台上 `general` Agent 持有全部文件工具，
   等于跨出工作目录的任意文件读写。
4. **`web_fetch` 无 SSRF 防护**：`tools/builtins.ts:255-274` 对 URL 只查协议前缀，
   可让模型抓取 `http://localhost:3000/api/*`、内网地址、云 metadata（169.254.169.254）。
5. **工具入参零校验**：每个工具 `input as {...}` 直接强转；`ToolRegistry.execute` 不比对
   `tool.parameters`（JSON Schema）。模型传错参时得到的是 undefined 行为而非结构化 validation 错误。
6. **TraceManager 无界增长**：`logger/trace.ts:63-64` 两个 Map 只进不出，服务器长跑必漏内存；
   `getTraceForConversation` 线性扫描且返回**最早**一条，语义与"看最近一次"相反。
7. **Anthropic 多工具块串位风险**：`llm/anthropic.ts:85-90,94-117` 用 `[...toolBuffers.keys()].pop()`
   猜"当前块"，应改按 `content_block` 的 `index` 定位。
8. **`execute_command` 不响应取消**：注册表的 abort race 只是放弃等待（`tools/registry.ts:143-146`），
   子进程本身不被 kill；工具也未接 `context.signal`。

### 1.2 能力缺口（业务期之前需补的平台能力）

按「业务 Agent 落地时会立刻撞上」的顺序：

- **LLM 调用参数与重试**（E1）：`LLMProvider.chat` 除 signal 外无任何参数；Anthropic
  `max_tokens` 硬编码 8192（`anthropic.ts:54`）；`AgentDefinition` 没有 temperature/maxTokens 等
  模型参数位。LLM 调用没有重试 —— 一次 429/5xx 直接把整轮变成 error 事件（`agent/agent.ts:243-253`），
  而工具层早已有分类重试，标准不对齐。
- **结构化输出**（E3）：`AgentDefinition` 只有 `inputSchema` 没有 `outputSchema`；Provider 无
  JSON mode / schema 约束生成。P8 的 PreviewPanel（平台卡片渲染）与三个业务 Agent 的
  「结构化产物」强依赖此能力。
- **推理模型支持**（E1）：`openai.ts` 只消费 `delta.content`，DeepSeek R 系的 `reasoning_content`
  仅在 DEBUG 时打印即丢弃；`AgentEvent` 无 `thinking` 事件，无法在 UI 展示思考过程或计费区分。
- **模型能力元数据与上下文联动**（E2）：`ModelConfig` 无 `contextWindow/maxOutputTokens/vision`
  等能力位；`ContextManager` 的 `total: 120_000` 写死（`context-manager.ts:26-38`），
  换 32K 小模型会溢出、换 200K 模型浪费一半窗口。`enabled: false` 的模型照样能
  `getProvider`/`list` 出来（`models/registry.ts`），运营下线模型无法生效。
- **多模态消息与审核**（E3）：`ContentPart` 只有 `text|image`（`types/index.ts:1-6`），
  视频 Agent 期无法在对话里引用音视频；`ReviewProvider` 只有 `reviewText`（`providers/review.ts`），
  而平台产物恰恰是图片/视频 —— 审核链路对主要产物类型是断的。`ModelType` 声明了
  `asr`/`embedding`，`providers/` 却没有对应接口。
- **检索（RAG）基座**（E4）：`TokenBudget.retrieval` 预留 20K，但 `Agent.run` 调
  `assemble(..., undefined, ...)` 恒传空（`agent/agent.ts:214-221`）；core 无 EmbeddingProvider、
  无 VectorStore；记忆检索是 `ILIKE %q%`（`memory/pg-adapter.ts:74-90`）。爆款库、品牌资料、
  历史笔记检索是文案/图片 Agent 的第一依赖。
- **多 Agent 编排原语**（E5）：产品形态是「文案 → 图片 → 视频 → 审核 → 发布」的协作流水线，
  core 目前只有单 Agent ReAct 循环，没有 agent-as-tool（子 Agent 调用）、没有 Pipeline/Workflow
  抽象。业务期若在 server 里硬编码编排，会重演 agent-service「上帝方法」的老路。
- **任务系统 v2**（E5）：`JobQueue`（`jobs/types.ts`）无取消、无优先级、无延迟任务
  （**定时发布直接依赖**）、无 attempts/重试策略、无心跳 —— worker 崩溃后任务永远 `running`。
- **生成 Provider 完善**（E1/E2）：`PollResult.url` 单值，`ImageGenerationRequest.n > 1` 的
  多图无处安放；无 seed/revisedPrompt 回传；`HttpGenerationClient` 的 fetch 无超时无重试
  （`generation-common.ts:41-65`）；额度预检需要的 `estimateCost(modelId, input)` 不存在。
- **发布连接器升级**（E6）：`PublishInput` 只有 title/body/assetIds，无话题标签/封面/定时；
  `exchangeToken` 无 refreshToken 与刷新流程；`publish` 无幂等键（重试会重复发文）。
- **存储 v2**（E6）：`ObjectStorage.put` 仅收 Buffer —— 5 分钟视频整段进内存；无
  `exists/list/预签名 URL`；plan P4 承诺的 `s3-storage.ts` 未落地。

### 1.3 工程改进（顺手做，不单列阶段）

- `formatForPrompt`/`listUserMemory` 注入 prompt 无条目/字节上限（`memory/store.ts:281-303`、
  `agent/agent.ts:130-144`），记忆多了必然膨胀上下文 → 加条数与 token 上限，超限截断。
- user 层记忆同步 `set` fire-and-forget 且吞错（`memory/store.ts:171-175`）→ 至少打日志。
- `anySignal` 的 abort 监听器不清理（`agent/agent.ts:56-67`）→ 用 `AbortSignal.any`（Node ≥ 20）
  或手动 removeEventListener。
- `estimateTokens` 纯启发式 → 用每轮真实 `usage.promptTokens` 反馈校正比例（可选）。
- `SkillLoader.match` 命中不去重、无数量上限、skill 正文无 token 预算。
- 摘要压缩默认用主模型（贵），`ContextManagerConfig.compressor` 已留位 → server 接一个便宜模型。

---

## 2. 设计方案（按阶段）

### E0 — 计费正确性与工具安全基线

**目标**：先把"钱算错"和"能出圈"的问题堵住。无新能力，行为向后兼容。

**Files:**
- Modify: `packages/core/src/llm/anthropic.ts`（usage 采集、按 index 跟踪 tool 块）
- Modify: `packages/core/src/llm/openai.ts`（`stream_options.include_usage`）
- Modify: `packages/core/src/tools/builtins.ts`（路径包含校验、SSRF 守卫、命令工具接 signal）
- Modify: `packages/core/src/tools/registry.ts`（入参 schema 校验）
- Modify: `packages/core/src/logger/trace.ts`（容量上限 + 最近优先）

- [ ] **Anthropic usage**：累计 `message_start.message.usage.input_tokens` 与
  `message_delta.usage.output_tokens`，在 `message_stop` 的 `done` chunk 带上
  `{ promptTokens, completionTokens }`。测试：mock 事件流断言 done.usage 非空。
- [ ] **OpenAI usage**：`stream: true` 时加 `stream_options: { include_usage: true }`；
  注意 usage-only 的末 chunk `choices` 为空数组，现有 `chunk.choices[0]?.delta` 已兼容，
  但 `finish_reason` 分支要允许 usage 在其后的独立 chunk 到达（先记 finishReason，
  流结束时统一 yield done）。
- [ ] **工具块按 index 跟踪**：`toolBuffers` 的 key 改用 `content_block_start` 事件的 `index`；
  `input_json_delta`/`content_block_stop` 均带 `index`，不再 pop 猜测。
- [ ] **路径包含校验**：`resolvePath` 后断言 `resolved === wd || resolved.startsWith(wd + sep)`，
  否则返回 `errorKind: "permission"`。对 `read_file/write_file/list_files/search_files` 生效。
  测试：`../outside.txt` 读写均拒绝；`sub/dir/f.txt` 正常。
- [ ] **SSRF 守卫**：`web_fetch` 解析 URL 后做 DNS lookup，拒绝私网/环回/链路本地段
  （127.0.0.0/8、10/8、172.16/12、192.168/16、169.254/16、::1、fc00::/7）；重定向逐跳复检
  （`fetch` 用 `redirect: "manual"` 自循环，上限 3 跳）。允许通过 env 白名单放行内网域
  （自托管场景）。测试用可注入的 resolver 打桩。
- [ ] **入参校验**：`ToolRegistry.execute` 在调用 `tool.execute` 前用 Ajv（或手写的
  required/type 最小校验器，避免新依赖则选后者）比对 `tool.parameters`；不合法直接返回
  `{ isError: true, errorKind: "validation" }`，让模型看到结构化报错自行纠正，不进重试。
- [ ] **TraceManager 有界化**：构造参数 `maxTraces`（默认 200），FIFO 淘汰并级联清理其 spans；
  `getTraceForConversation` 改为返回**最新**一条。
- [ ] **命令工具可取消**：`executeCommandTool` 改用 `execFile(..., { signal: context.signal })`
  （Node 支持 AbortSignal kill 子进程）。
- [ ] **Commit**：`fix(core): correct LLM usage accounting; sandbox file tools; SSRF guard; validate tool inputs; bound TraceManager`

### E1 — LLM 调用层升级（参数 / 重试 / 推理 / prompt cache）

**目标**：让文本调用层达到"业务可调参、故障可自愈、成本可省"的水平。

**关键契约**（`types/index.ts`）：

```ts
export interface ChatParams {
  temperature?: number;
  maxTokens?: number;        // Anthropic 必填位由此注入，替代硬编码 8192
  topP?: number;
  /** JSON Schema 约束输出（E3 结构化输出复用此位） */
  responseSchema?: JSONSchema;
  /** 推理预算：off 关闭；数值为 thinking token 上限（支持的模型生效） */
  reasoning?: "off" | number;
}
export interface ChatOptions {
  signal?: AbortSignal;
  params?: ChatParams;
}
// ChatChunk 增加推理与缓存计量：
//   { type: "thinking"; content: string }
//   usage 扩展 { promptTokens, completionTokens, cachedPromptTokens? }
```

- [ ] `AgentDefinition` 增 `modelParams?: ChatParams`；`Agent` 透传到每次 `llm.chat`。
- [ ] **LLM 重试**：新增 `llm/retry.ts` —— `withLLMRetry(fn, cfg)` 包装单次流式调用；
  仅对"未产出任何 chunk 前"的 429/5xx/网络错误重试（流一旦开始输出就不重试，交给上层报错），
  指数退避 + 抖动，尊重 `Retry-After`。默认 2 次。测试：前两次抛 429 第三次成功。
- [ ] **推理内容**：openai.ts 消费 `delta.reasoning_content`（DeepSeek 约定）、anthropic.ts 消费
  `thinking_delta`，统一 yield `{ type: "thinking" }`；`Agent.run` 原样转发为
  `AgentEvent { type: "thinking" }`（server 的 sse-adapter 需同步映射；不入 workingHistory）。
- [ ] **Prompt cache**：AnthropicProvider 给 system 块与最后一条历史消息打
  `cache_control: { type: "ephemeral" }`（ContextManager 已保证前缀稳定，白捡的折扣）；
  usage 采集 `cache_read_input_tokens` 进 `cachedPromptTokens`，供 meter 差异化计价。
- [ ] **非流式便捷方法**：`llm/complete.ts` 提供 `complete(llm, messages, opts): Promise<string>`
  （聚合 text chunk），替换 context-manager `summarize`、memory extraction 等处的手写循环。
- [ ] **Commit**：`feat(core): chat params + LLM retry + thinking events + prompt caching`

### E2 — 模型能力元数据与上下文/成本联动

**目标**：模型知道自己"多大、多贵、会什么"，上下文预算与额度预检不再拍脑袋。

```ts
// models/types.ts
export interface ModelCapabilities {
  contextWindow?: number;      // tokens；ContextManager.total 据此派生
  maxOutputTokens?: number;    // ChatParams.maxTokens 默认值
  vision?: boolean;            // 是否接受 image ContentPart
  toolUse?: boolean;           // 不支持时 Agent 直接禁工具而非报错
  reasoning?: boolean;
}
export interface ModelConfig { /* 现有字段 */ capabilities?: ModelCapabilities; }
```

- [x] `config/default.json` 的 `models` 段补 capabilities；`config/schema.ts` 同步校验。
- [x] **registry 尊重 enabled**：`list()` 默认过滤 `enabled: false`（加 `{ includeDisabled }` 逃生门）；
  `getProvider` 对 disabled 返回 undefined。测试补齐。
- [x] **上下文预算联动**：server 装配 Agent 时按
  `contextConfig.budget.total = capabilities.contextWindow ?? 120_000`（10% 安全边际）注入；
  core 侧 `ContextManager` 不改逻辑，只是不再被写死的 120K 绑架。
- [x] **成本预估**：`billing/cost.ts` 增
  `estimateCost(model: ModelConfig, est: { inputCount?: number; outputCount?: number }): number`
  —— LLM 按估算 token、image 按张数、video 按秒数复用 `calcCost` 口径；server 的 402 预检与
  「费用预估展示」共用一个真源。TDD：三种类型各一条。
- [x] **生成 HTTP 客户端加固**：`HttpGenerationClient` 的 fetch 加 20s 超时 + AbortSignal 透传 +
  网络错误一次重试（poll 是幂等读，安全）。
- [ ] **Commit**：`feat(core): model capabilities metadata + cost estimation + enabled filtering`

### E3 — 结构化输出与多模态类型补全

**目标**：业务 Agent 的产物是**结构化**、**多模态**的，类型系统与审核链路先行铺路。

- [x] **ContentPart 扩展**：
  ```ts
  export interface ContentPart {
    type: "text" | "image" | "video" | "audio" | "file";
    text?: string;
    image?: { url: string; mediaType: string };
    media?: { url: string; mediaType: string; durationSec?: number };  // video/audio/file
  }
  ```
  两个 LLM Provider 对不支持的 part 降级为文本占位（沿用 anthropic.ts 现有的兜底手法）。
- [x] **outputSchema**：`AgentDefinition` 增 `outputSchema?: JSONSchema`；装配时经
  `ChatParams.responseSchema` 下发 —— openai 走 `response_format: { type: "json_schema" }`，
  anthropic 走 tool-choice 强制单工具的等价实现；`Agent.run` 结束时若定义了 outputSchema，
  对最终文本做一次 JSON.parse + 校验，失败 yield 结构化 error（不重跑，交上层决策）。
- [x] **审核多模态化**：
  ```ts
  export interface ReviewInput {
    kind: "text" | "image" | "video";
    text?: string;
    url?: string;                       // image/video 产物地址
    scene?: "chat" | "publish";         // 发布前审核更严
  }
  export interface ReviewResult {
    verdict: ReviewVerdict;
    reasons: string[];
    labels?: string[];                  // 违规分类税目（政治/色情/广告法…）
  }
  export interface ReviewProvider { review(input: ReviewInput): Promise<ReviewResult>; }
  ```
  `KeywordReviewProvider` 实现 text，image/video 返回 `suspect`（"stub 无法审图"）——
  逼着发布链路对非文本产物显式决策而非静默放行。保留 `reviewText` 为兼容薄壳,标 `@deprecated`。
- [x] **ASR / Embedding 接口**：`providers/asr.ts`（`transcribe(req) → { text, durationSec }`）、
  `providers/embedding.ts`（`embed(texts: string[]) → number[][]`，E4 的地基）+ 各配 Stub。
- [x] **多图输出**：`PollResult` 增 `urls?: string[]`（保留 `url` 为首图兼容位）；
  Happyhorse 适配器与 Mock 同步填充。
- [ ] **Commit**：`feat(core): multimodal content parts + structured output + multimodal review + asr/embedding interfaces`

### E4 — 检索基座（把预留的 retrieval 通道接活）

**目标**：给业务期的「爆款库 / 品牌资料 / 历史内容」检索提供 core 侧抽象；
`TokenBudget.retrieval` 那 20K 从摆设变成真通道。

```ts
// retrieval/types.ts
export interface VectorDoc { id: string; text: string; meta?: Record<string, unknown>; }
export interface VectorStore {
  upsert(namespace: string, docs: Array<VectorDoc & { vector: number[] }>): Promise<void>;
  query(namespace: string, vector: number[], topK: number): Promise<Array<VectorDoc & { score: number }>>;
  delete(namespace: string, ids: string[]): Promise<void>;
}
export interface Retriever {           // Embedding + VectorStore 的组合门面
  retrieve(namespace: string, query: string, topK?: number): Promise<VectorDoc[]>;
}
```

- [ ] **接口 + InMemoryVectorStore**（余弦相似度，单测/开发用）落 core；pgvector 适配器落 server
  （遵循 Interface-in-core / impl-in-server 惯例）。
- [ ] **接线 ContextManager**：`AgentContext` 增 `retriever?: Retriever` 与
  `retrievalNamespace?: string`；`Agent.run` 每轮 assemble 前用**当前用户消息**做一次
  `retrieve`，格式化为 `[Retrieved Context]` 块经 assemble 的 `memory` 参数旁新增的
  `retrieval` 参数传入（受 `budget.retrieval` 截断，逻辑同 memory 块）。无 retriever 时零开销，
  完全向后兼容。
- [ ] **记忆语义检索**：`AgentMemoryStore.searchUserMemory` 在配置了 Retriever 时优先走向量检索，
  ILIKE 作为降级路径。
- [ ] **注入上限**（1.3 工程项顺手做）：`formatForPrompt` 与 user memory 注入各加
  条数（20）与字符（4K）上限，超限按 `updatedAt` 新者优先。
- [ ] **Commit**：`feat(core): retrieval foundation (embedding + vector store + context wiring)`

### E5 — 多 Agent 编排原语 + 任务系统 v2

**目标**：把「多 Agent 协作」从口号变成 core 原语；任务队列补齐长任务生命周期管理。
这是业务期编排（文案→配图→审核→发布）的直接地基。

**编排——两个互补原语**：

```ts
// agents/orchestration.ts
/** ① agent-as-tool：把注册表中的 Agent 包装成可被别的 Agent 调用的工具 */
export function agentAsTool(
  def: AgentDefinition,
  runner: (def: AgentDefinition, input: string, ctx: ToolContext) => Promise<string>,
): Tool;   // name: `agent__${def.id}`，description 取 def.description，endsTurn: false

/** ② Pipeline：声明式串接多个步骤，供 worker 消费（jobs v2 的 workflow 任务类型） */
export interface PipelineStep {
  id: string;
  kind: "agent" | "generation" | "review" | "publish";
  agentId?: string;            // kind=agent
  taskType?: string;           // kind=generation → jobs 任务类型
  inputFrom: Array<{ step: string; field?: string }>;  // 依赖即 DAG 边
  gate?: "review-pass" | "manual-approve";             // 关卡：审核不过/未批则停
}
export interface PipelineDefinition { id: string; steps: PipelineStep[]; }
export function validatePipeline(def: PipelineDefinition): string[];  // 环/悬空依赖检测,纯函数可 TDD
```

子 Agent 运行走独立的 `Agent` 实例与独立 ContextManager，父子仅通过工具入参/结果交换文本——
不共享 workingHistory，天然并发安全（与 P6 的 per-request memory 原则一致）。

**JobQueue v2**（`jobs/types.ts`，向后兼容扩展）：

```ts
export interface EnqueueOpts {
  priority?: number;        // 大任务让路
  delayMs?: number;         // 定时发布的地基
  maxAttempts?: number;     // 默认 1；重试由队列而非 handler 负责
  idempotencyKey?: string;  // 重复提交去重
}
export interface JobQueue {
  enqueue<I>(type: string, input: I, userId: string, opts?: EnqueueOpts): Promise<string>;
  process<I, O>(type: string, handler: (job: JobRecord<I>, ctl: JobControl) => Promise<O>): void;
  get(id: string): Promise<JobRecord | null>;
  cancel(id: string): Promise<boolean>;          // pending 直接取消；running 置取消标记
  updateProgress(id: string, progress: number, stage?: string): Promise<void>;
}
export interface JobControl { signal: AbortSignal; heartbeat(): void; }
// JobRecord 增: attempts: number; stage?: string; status 增 "cancelled"
```

- [ ] `InMemoryJobQueue` 补齐 v2 语义（delay 用 setTimeout、cancel、attempts）作契约测试基准；
  `BullmqJobQueue`（server）映射到 BullMQ 原生 priority/delay/attempts/stalled 检测。
- [ ] `agentAsTool` + `validatePipeline` TDD 落地；`general` Agent 定义**暂不**挂子 Agent 工具
  （业务期按需开白名单），本期只交付原语与测试。
- [ ] **工具并行执行**（顺手）：`Tool` 增 `parallelSafe?: boolean`（只读类工具标 true），
  `Agent.run` 对同一批 toolCalls 中连续的 parallelSafe 段用 `Promise.all`，事件仍按原顺序 yield。
- [ ] **Commit**：`feat(core): agent-as-tool + pipeline primitives; job queue v2 (cancel/delay/priority/attempts)`

### E6 — 存储 / 发布 / MCP / 可观测工程强化

**目标**：清掉剩余的接口欠账与工程卫生，业务期不再回头改 core 契约。

- [ ] **ObjectStorage v2**：
  ```ts
  export interface ObjectStorage {
    put(input: PutObjectInput): Promise<{ url: string }>;
    putStream(key: string, body: NodeJS.ReadableStream, contentType: string, sizeHint?: number): Promise<{ url: string }>;
    getUrl(key: string, opts?: { expiresInSec?: number }): string;   // S3 → 预签名
    get(key: string): Promise<Buffer>;
    exists(key: string): Promise<boolean>;
    delete(key: string): Promise<void>;
  }
  ```
  Local 实现补齐（putStream 用 pipeline 落盘）；`s3-storage.ts`（S3/OSS/MinIO 兼容，
  `@aws-sdk/client-s3`）本期落地，config 切换。worker 下载生成产物改走流式直传。
- [ ] **Publish v2**：`PublishInput` 增 `tags?: string[]; coverAssetId?: string; scheduleAt?: string;
  idempotencyKey?: string`；`exchangeToken` 返回增 `refreshToken?`；接口增
  `refreshToken(rt: string)` 与 `revoke(userId: string)`。Stub 同步；定时发布 = server 把
  `scheduleAt` 换算成 jobs v2 的 `delayMs`，core 无新机制。
- [ ] **MCP 硬化**：MCP 工具映射时带默认 `execConfig`（timeout 30s）并透传 `cacheable: false`；
  连接超时后显式 `transport.close()`；`connect` 失败指数退避重连（上限 3 次）；
  `MCPConfig` 增 `headers?: Record<string,string>`（远程 transport 鉴权）。
- [ ] **Skills 改进**：`match` 结果去重 + `maxSkills`（默认 3）+ 注入前按 `estimateTokens`
  预算截断（并入 systemPrompt 的 16K 预算内）。
- [ ] **结构化日志**：`logger/log.ts` 极简分级 logger（debug/info/warn/error，JSON 行输出，
  `LOG_LEVEL` env 控制），替换 core 里散落的 `console.warn/error`（skills/loader、DEBUG_LLM 等）。
- [ ] **配置 schema 补全**：`AppConfigSchema` 校验 `models[].capabilities`、mcp servers
  （对齐 `MCPConfig` 形状）、新增 `storage`（driver: local|s3 + 各自字段）段。
- [ ] **Commit**：`feat(core): storage v2 + publish v2 + mcp hardening + structured logging + config schema completion`

---

## 3. 依赖关系与排期建议

```
E0 (正确性/安全) ──┬──> E1 (LLM 层) ──> E3 (结构化/多模态)
                   ├──> E2 (模型元数据/成本)      │
                   │         └────────────┬──────┘
                   │                      v
                   │              E4 (检索基座)
                   └──> E5 (编排 + jobs v2)   E6 (工程强化)
```

- **E0 立即做**：计费错账每天都在发生；两处安全洞在多用户环境是现实风险。
- **E1/E2 先于业务期**：调参、重试、成本预估是三个业务 Agent 的运行前提。
- **E3/E4 与业务 Agent 并行启动**：结构化输出与检索是文案 Agent 的第一批需求。
- **E5 在图片/视频 Agent 动工前就位**：避免编排逻辑先在 server 长歪再返工。
- **E6 可穿插**：每项独立，适合填缝。

所有新增均遵循既有惯例：TDD（Vitest 先红后绿）、接口在 core / 带 DB/Redis 的实现在 server、
ESM `.js` 后缀、Stub 先行打通链路。

## 4. 不在本期范围

真实厂商适配器（通义万相/可灵/DALL·E 的 VendorAdapter 实现）、阿里云内容安全对接、
小红书/公众号真实 OAuth、三个业务 Agent 的 prompt 工程与编排内容、web 前端对
thinking/artifact 新事件的渲染（另行随 server sse-adapter 改造提单）、正式迁移 runner。
