# Lot Agent 全面 Review 报告

> Review 范围：`packages/core`（Agent 引擎）、`packages/server`（HTTP/DB/Worker）、`packages/web`（Workspace UI），约 2.7 万行 TS。
> 现状：93 个测试文件 / 610 个用例全部通过；分层清晰（core 无 pg/redis/vendor 依赖），工具沙箱、SSRF 防护、上下文压缩、prompt caching 等基础质量高于同类实践项目的平均水平。
> 本报告按三部分组织：**现有实现的问题**（按严重程度分级）、**架构设计优化**、**可以增加的功能**。所有问题均给出 `文件:行号` 证据。

---

## 一、现有实现的问题

### P0 —— 正确性 / 资损 / 越权（建议尽快修）

#### 1. 聊天计费记的是 Agent 默认模型，不是本回合实际模型
`agent-service.ts:730` 的用量上报写死 `modelId: def.defaultModelId`，而本回合真正使用的模型是 `modelId`（显式选择 > 会话存储 > agent 默认，`agent-service.ts:529`）。

```ts
// agent-service.ts:727-732
const cost = await this.usageMeter.record({
  ...
  modelId: def.defaultModelId,   // ← 应为本回合解析出的 modelId
  usage: { inputCount: inputTokens, outputCount: outputTokens },
});
```

后果：用户把会话切到 `claude-sonnet-4`（0.024/0.12 元/千token）后，`usage_logs` 仍按 `deepseek-v4-flash`（0.001/0.002）记账——**单价差 24~60 倍**，且 `model_id` 字段本身也是错的，用量报表 by-model 全部失真。同一函数里 `memory.extract` 入队时传的就是正确的 `modelId`（`agent-service.ts:701`），说明这是遗漏而非设计。

#### 2. `traces` 路由完全没有属主校验（跨用户信息泄露）
`routes/traces.ts:8-21`：`GET /api/traces` 不带 `conversationId` 时返回**全站**最近 50 条 trace（`database.ts:905-908`），`GET /api/traces/:id` 可以读任意用户的 trace + spans（含错误信息、totalCost、工具调用序列）。CLAUDE.md 明确约定「cross-user access → 404」，此路由违反该约定。

#### 3. `ratings` 路由没有属主校验
`routes/ratings.ts`：任何登录用户可对任意 `messageId` 打分 / 读取 / 删除评分，没有校验该 message 所属会话属于当前用户。message id 是 UUID 不易枚举，但这是与 #2 同源的系统性缺口。

#### 4. 并行工具调用只有第一个 tool_result 落库
Agent 循环对 parallel-safe 工具会先 yield 全部 `tool_call` 再依次 yield `tool_result`（`agent.ts:505-527`）。而 server 侧的持久化逻辑：

```ts
// agent-service.ts:640-657
if (currentToolCalls.length > 0) {
  await saveAssistantWithToolCalls(...);   // 保存全部 N 个 call
  await saveToolResult(..., matchingCall?.id, ...); // 只保存第 1 个结果
  currentToolCalls = [];                   // 清空 → 第 2..N 个结果直接丢弃
}
```

第一个 `tool_result` 到达时就清空了 `currentToolCalls`，同批后续结果因 `length === 0` 不再写库。重载会话时 `loadHistory` 又会把「无结果的 tool_call」过滤掉（`message-repository.ts:59-64`），于是**并行批次里第 2..N 个工具调用及其结果从历史中彻底消失**，模型下回合看不到自己做过什么。

根因是事件模型缺陷：`AgentEvent` 的 `tool_result` 变体只有 `name` 没有 `id`（`agent.ts:30`），server 只能 `find(tc => tc.name === event.name)` 按名字猜配对（`agent-service.ts:636`）——同名并行调用（如两个 `web_fetch`）必然错配。

#### 5. 生成（图片/视频）的配额预检与计费用硬编码模型，无视用户实际选择
- 预检：`conversations.ts:277` 写死 `"gpt-image-2-token"` / `"kling-standard"` 估价；`tasks.ts:34-39` 同样。用户通过 `body.model` 选的真实模型只透传给 worker，不参与估价。
- 计费：worker 侧 `workers/index.ts:123` 的注释直言「Billing stays on the configured, statically-priced modelId」，`run-job.ts:123` 按 `deps.modelId`（配置默认）记账。

后果：用户选 `veo3.1` 等高价视频模型，402 预检与最终记账都按 `kling-standard` 的 0.5 元/秒算——限额形同虚设，账目与 tokenhub 实际扣费对不上。

#### 6. 生成任务无法真正取消
`BullmqJobQueue.cancel()` 会 abort 对应的 `JobControl.signal`（`bullmq-queue.ts:150-168`），但 `runGenerationJob` **从头到尾没有接收/检查任何 signal**（`run-job.ts:54`，worker 注册处 `workers/index.ts:140-147` 的 handler 也丢弃了 `ctl` 参数）。取消后轮询循环最长继续跑 15 分钟，vendor 端继续消耗。另外 `cancelTask` 把状态置 `cancelled` 后，handler 正常跑完时 `setTaskResult` 无条件把状态改回 `succeeded`（`database.ts:1408-1414` 没有 `WHERE status='running'` 守卫），取消状态会被覆盖。

#### 7. 生成消息 metadata 的写覆盖竞态
`conversations.ts:301-314` 的顺序是：先 `enqueue`，再把 `{status:"generating", taskId}` 整体写回消息。`updateMessageGeneration` 是**整体替换** metadata（`database.ts:751-759`）。当 gen-cache 命中时 worker 几乎瞬时完成并写入 `{status:"completed", assets}`，随后 route 的写回把消息打回 `generating` 并**丢掉 assets**。刷新后消息永远显示「生成中」，只能靠 taskId 轮询侥幸恢复。

#### 8. 聊天路径没有任何配额检查；`user_balance.balance` 从未被使用
`checkQuota`（`meter.ts:37-61`）只在 image/video 两处被调用。聊天（含长上下文 + 高价模型，单回合可能比一张图贵得多）不受 daily/monthly limit 约束。`user_balance.balance` 列存在但没有任何充值/扣减/校验逻辑——要么实现，要么删掉避免误导。

### P1 —— 可靠性 / 安全加固

#### 9. 生成缓存跨用户共享，结果与资产归属泄露
`genCacheKey` 不含 userId（`run-job.ts:76-79`）：用户 A 生成后，用户 B 用相同 prompt+参数会直接拿到 A 的 asset URL（缓存返回 `assets`，`run-job.ts:80-85`），B 的消息引用的是 A 名下的 asset 行。图片内容本身可能包含 A 的参考图元素。如果「相同输入共享结果」是有意的成本优化，至少应把缓存粒度做成可配置，并为命中方复制一条自己的 asset 记录。

#### 10. `/static/*` 三个静态路由无鉴权，仅靠 UUID 文件名不可猜
`index.ts:178-225`。上传的合同、生成的文档任何持有 URL 的人都能下载（链接会出现在聊天记录、日志、代理中）。`documents` 路由还会把 `.html` 以 `text/html` inline 渲染且无 `nosniff`（`index.ts:191-202`）——虽然 `doc-generator.ts:121-126` 已把 Markdown 里的原始 HTML 转义（防住了 `<script>`），但 marked 默认不拦 `javascript:` 链接，且该路由防护水平明显低于 uploads 路由（后者有 nosniff + attachment，`index.ts:204-225`）。session token 又存在 `localStorage`（`client.ts:120-132`），一旦任何同源 HTML 注入成立即可窃取。建议：documents 路由补 nosniff + 非白名单类型强制 attachment；敏感文件走带属主校验的下载路由或签名 URL。

#### 11. 静态文件全量读入内存、不支持 Range
三个静态路由都是 `readFile` 整个 Buffer 再返回（`index.ts:184,197,210`）。视频无法拖动进度条（无 `Accept-Ranges`），大文件并发下载有内存风险。应改为流式 + Range 支持。

#### 12. tokenhub api_key 明文存库；session token 明文存库
`database.ts:1026-1031`（`users.api_key` / `api_keys` JSONB）。DB 泄露即等于用户的计费 key 泄露。至少应用 KMS/env 派生密钥做对称加密；session token 可以只存哈希（`sessions.token`，`database.ts:476-484`）。

#### 13. sessions 只有硬过期，无清理、无续期
`session-store.ts:4,16-23`：7 天固定过期，过期行永不删除（表无限增长）；`last_seen_at` 在更新但没有滑动续期逻辑，活跃用户每 7 天被强制登出。

#### 14. `regenerate` 的删除边界不校验消息归属
`database.ts:786-794`：`deleteMessagesFromAndAfter` 用传入 messageId 的 `created_at` 做 `>=` 删除，但不校验该 message 属于该会话（路由只校验了会话属主，`conversations.ts:118-133`）。传入他人会话的 message id 时，会以对方消息的时间戳删除自己会话的消息——影响限于自身数据，但语义是错的。

#### 15. worker 的计费兜底与 server 不一致
worker 的 `UsageMeter` 只查静态 config（`workers/index.ts:65`），server 侧则有 `catalogModelConfig` 动态目录兜底（`agent-service.ts:344-346`）。结果：`memory.extract` 用动态 tokenhub 模型 id 时 `unknown model, skipping billing` 直接漏记账。

#### 16. 工具执行的取消与超时细节
- `web_fetch` 完全忽略 `context.signal`（`builtins.ts:390` 的 execute 只解构 input；`fetchWithTimeout` 用私有 controller）——run 被取消后 fetch 仍继续，与 `execute_command`/`web_search` 行为不一致。
- `search_files` 的 grep 参数缺 `--` 分隔（`builtins.ts:252-260`），pattern 以 `-` 开头会被解析成 grep 选项。
- `withLLMRetry` 的退避 `sleep` 不可中断（`retry.ts:69-71,101`）；`ToolRegistry.timeout()` 的计时器从不清理（`registry.ts:253-257`），每次工具调用都挂一个最长 `timeoutMs` 的活跃 timer。
- 文件工具的路径 containment 用 `resolve` 判断（`builtins.ts:35-37`），不解析符号链接——工作目录内的 symlink 可指向目录外（当前部署已禁用文件工具，风险搁置但别忘）。

#### 17. 同一会话的服务端并发无保护
web 端用 `streamsRef` 保证单会话单流（`useChat.ts:44,188-190`），但服务端没有任何锁：两个标签页/设备同时向同一会话发消息，`saveUserMessage`/`saveAssistantWithToolCalls` 会交错写入，历史顺序被破坏。消息排序仅靠 `created_at`（`database.ts:761-766`），连续插入落在同一微秒时顺序也不稳定（建议加自增 `seq` 列）。

#### 18. 无任何请求频率限制
login（RSA 解密 + tokenhub 转发）、uploads（20MB 全量 `parseBody` 进内存，`uploads.ts:45`）、消息发送都没有 rate limit。单用户可无限并发触发上传/LLM 调用。

#### 19. 任务进度的 Redis 发布无人订阅
`bullmq-queue.ts:172-178` 把进度 publish 到 `task:{id}:progress`，但没有任何订阅者；web 用 1 秒间隔轮询 `GET /api/tasks/:id`（`useChat.ts:112`）。要么删掉发布，要么补一条 SSE 通道（见架构建议 #6）。

### P2 —— 小问题 / 代码坏味道

| # | 问题 | 位置 |
|---|------|------|
| 20 | `maxRunTimeMs: 600_000` 注释写 "5 min"，docstring 写默认 300000，三处互相矛盾 | `agent.ts:44,102` |
| 21 | `done` 事件的 `cachedPromptTokens` 在 SSE 适配层被丢弃 | `sse-adapter.ts:23-30` |
| 22 | 路由用 `service["llmConfig"]` 索引访问私有成员 | `conversations.ts:51-54` |
| 23 | malformed-recovery 的合成 user 消息只进内存 workingHistory，不落库，重载后上下文缺失 | `agent.ts:423` |
| 24 | 标题 prompt 说 max 30 chars，代码截断 50 | `agent-service.ts:467,476` |
| 25 | 前端消息 id 用 `Date.now()` 拼接，同毫秒的 tool result 会撞 key | `useChat.ts:227,306` |
| 26 | `regenerate` 先删 DB 再重发，重发失败时该轮历史永久丢失 | `useChat.ts:399-408` |
| 27 | 上传 mime 完全信任客户端 `File.type`，无 magic-bytes 校验 | `uploads.ts:31` |
| 28 | `usage_logs.user_id`/`conversations.user_id` 为 VARCHAR 无外键，与 `users.id`(UUID) 弱关联 | `database.ts:428,492` |
| 29 | `anySignal` 给外部 signal 挂监听后从不移除，长命 signal 上会累积 | `agent.ts:87-98` |
| 30 | `web_search` 用平台的 `BIGMODEL_API_KEY`，与「一切模型调用记到用户自己 key」的产品原则不一致，且这笔成本不进 `usage_logs` | `builtins.ts:479` |

---

## 二、架构设计优化

按投入产出排序，前四项直接消解上面一半的 P0/P1。

### 1. 给事件模型补上身份：`tool_result` 携带 `toolCallId`
这是问题 #4 的根治方案。`AgentEvent` 的 `tool_result` 变体加 `id` 字段（Agent 循环里 `recordResult` 拿得到 `tc.id`，`agent.ts:482-501`），server 端按 id 精确配对持久化，SSE 契约同步加字段（前端向后兼容）。顺手给每个 SSE 事件编 `seq`，为断线续传（`Last-Event-ID`）打基础。

### 2. 计费收敛为单一管道（billing as middleware）
现在计费散落在 4 个调用点，各自手填 `modelId`，已产生 3 个不一致 bug（#1、#5、#15）。建议：

- `ProviderFactory` 返回的 provider 自带 `modelId` 元数据，`UsageMeter.record` 从 provider/回合上下文取模型，而不是调用点手填；
- 估价（`estimateCost`）和记账（`calcCost`）强制使用**同一个**解析函数（输入是「用户实际选择的模型 id」，带目录兜底），杜绝预检与结算模型不一致；
- `checkQuota` 前移为横切关注点：所有昂贵调用（聊天、生成、memory.extract）统一走一个 `withQuota(userId, estimate, fn)` 包装。

### 3. 任务/消息状态机：单一事实来源
问题 #6、#7 的共同根因是「task 行」和「message.metadata」两处冗余状态互相追赶。建议：

- message.metadata 只存 `taskId`（一次写入不再更新），前端展示所需的状态/资产一律 join task 行（`GET /api/tasks/:id` 已经是前端的实际数据源）；
- 若保留冗余，`updateMessageGeneration` 改为 JSONB merge + 状态单向推进守卫（`WHERE metadata->>'status' NOT IN ('completed','failed')`）；
- task 的所有终态迁移加 `WHERE status IN ('pending','running')` 守卫，`cancelled` 不再被 `succeeded` 覆盖；
- `runGenerationJob` 接收 `JobControl.signal`：create/poll/download 的 fetch 全部挂 signal，轮询循环每圈检查。

### 4. 属主校验中间件化
`getConversation → user_id !== userId → 404` 的模式已在 5 个路由手写，而 traces/ratings 忘写（#2、#3）。提炼 `requireOwned` helper：

```ts
const conv = await requireOwnedConversation(c, service.db); // 内部 404
```

并给 ratings 补「message → conversation → user」链式校验、给 traces 补 conversation 过滤（或干脆 admin-only）。**建议为每个路由补一条「非属主访问返回 404」的测试**，把约定固化。

### 5. 拆分 `AgentService` 这个 god object
751 行的 `AgentService` 同时持有 DB、Redis、BullMQ、SkillLoader、MCP、tokenhub、ProviderFactory、UsageMeter、上传存储……所有路由都拿整个 service 再挖字段（甚至 `service["llmConfig"]`）。建议按限界拆分：

- `ChatService`（streamAgentResponse + title + summary 持久化）
- `CatalogService`（getUserModelCatalog + ProviderFactory + 缓存失效）
- `GenerationService`（quota + enqueue + message 编排）
- 路由构造函数按需注入接口，core 的「interface-in-core, impl-in-server」原则同样适用于 server 内部分层。

### 6. 进度推送替代轮询
Redis pub/sub 基建已就位（#19），补一条 `GET /api/tasks/:id/events` SSE 路由（订阅 `task:{id}:progress`，兜底轮询 DB），前端 `pollGeneration` 换成 EventSource + 断线回退轮询。同时消灭每任务每秒一次的 HTTP 轮询与死代码。

### 7. 静态资源走 ObjectStorage 抽象 + 签名/鉴权下载
`ObjectStorage` 接口已存在，规划中的 S3 实现落地时，把 `/static/*` 换成两种之一：(a) 短时效签名 URL；(b) 带 Bearer 的 `/api/files/:id` 流式下载（校验 asset 属主，支持 Range）。本地盘实现也应先做流式 + Range（#11）。

### 8. 正式的 migration runner
inline `migrate()` 已 1400+ 行且 DDL/DML/backfill 混杂（`database.ts:216-602`），`ALTER ... DROP NOT NULL` 这类不可 CREATE-IF-NOT-EXISTS 的语句只能靠幂等性硬扛。引入 `node-pg-migrate`（或自写 `schema_migrations` 表 + 顺序文件），backfill 独立成 data migration。这也是 roadmap 已承认的欠账。

### 9. 会话级写锁
per-conversation 的 `pg_advisory_xact_lock(hashtext(conversationId))`（或 Redis `SET NX PX`）：同会话并发 send 直接 409，或排队。消息表加 `seq BIGSERIAL` 保证稳定排序（#17）。

### 10. 前端 useChat 的 reducer 化
513 行的 `useChat` 用闭包变量 + `setMessages(prev => ...)` 手工维护流状态，事件种类还在增加（title/artifact/generation）。把 SSE 事件收敛为 `dispatch(event)` + 纯 reducer（可单测事件序列 → 视图状态），`isStreaming`/`genPoll`/`streams` 三份互相纠缠的状态自然归一。

### 11. 密钥与会话安全
- api_key 加密静态存储（envelope encryption，密钥来自 env/KMS）；
- session token 存哈希（`sha256(token)`），验证时哈希比对；
- 登录/上传/消息接口加基础 rate limit（hono-rate-limiter + Redis 计数即可）；
- 定期任务清理过期 sessions（顺手清理 `tasks`/`usage_logs` 的归档策略）。

---

## 三、可以增加的功能

按「现有基建已就绪、增量小收益大」优先排列：

### 近期（基建已备好，主要是补 UI/接线）

1. **用量与限额面板**：`GET /api/usage/summary|logs|balance` 已齐全，但前端没有任何入口；补一个「用量」页面（按天/按模型的消费图表 + daily/monthly 限额设置——`user_balance` 的 limit 列目前无任何设置入口）。
2. **任务中心**：tasks 表 + cancel API 都在，UI 无入口。列出进行中/历史生成任务，提供取消按钮（配合架构 #3 修好取消传播）。
3. **素材库 / 生成历史画廊**：assets 表已按 user 索引（`idx_assets_user`），做一个「我的生成」瀑布流：预览、下载、复制 prompt 一键重生成、作为参考图再创作。
4. **记忆管理 UI**：memory 的 list/search/set/delete API 完整（`routes/memory.ts`），前端没有管理界面。让用户能看到/纠正「系统记住了我什么」，也是隐私体验的重要一环。
5. **会话导出**：`generate_document` 已能产 docx/pdf/md/html，加一个「导出对话」按钮几乎零成本。
6. **消息编辑与分支重发**：目前 `regenerate` 只支持最后一轮且破坏性删除（#26）。支持编辑任意 user 消息后从该点分支（消息表加 `parent_id` 或 branch 维度），是聊天产品的标配。

### 中期（roadmap 已列出接口，需要实现闭环）

7. **RAG 知识库（E4 收尾）**：Embedding 接口和 `retrieval/`（Retriever、InMemoryVectorStore）已存在，Agent 循环也预留了 `retriever/retrievalNamespace` 注入点（`agent.ts:66-74`）——缺的只是 pgvector 版 VectorStore + 「上传文档入库」管道（附件抽文本能力已有，`attachment-extractor.ts`）。落地后即可做「个人知识库问答」Agent 与跨会话资料引用。
8. **多 Agent 编排执行器（E5 收尾）**：`agentAsTool` 和 `Pipeline` 校验原语已写好（`orchestration.ts`），补一个执行引擎：让 PPT Agent 调用图片 Agent 生成配图、文案 Agent → 审核 → 发布走 Pipeline gate。这是产品差异化最大的方向。
9. **断线续传**：SSE 断开后目前只能等 `loadMessages` 兜底。基于架构 #1 的事件 `seq`，支持 `Last-Event-ID` 续流；移动端弱网体验会明显改善。
10. **语音输入**：ASR stub 接口已存在（`providers/asr.ts`），接一个真实 ASR 即可在 InputBox 加语音按钮。
11. **自定义 Agent**：`AgentDefinition` 已完全数据化（systemPrompt/toolNames/modelParams/inputSchema），把定义从代码常量搬到 DB 表 + 一个创建表单，用户即可自建垂直 Agent 并出现在 Agent 中心。

### 远期（依赖外部打通）

12. **真实发布通道**：`PlatformConnector` 目前是 stub；小红书/公众号 OAuth + 真实发布 + `review_logs` 闭环。
13. **内容审核升级**：`KeywordReviewProvider` → 云审核 API（文本 + 图片多模态，`ReviewProvider` 已支持多模态签名）。
14. **团队空间**：会话/素材在组织内共享、key 池统一管理（依赖 tokenhub 侧的组织模型）。
15. **管理端可观测性**：traces/spans 已入库，修复越权（#2）后做一个 admin-only 的 trace 浏览器（回合耗时瀑布图、错误聚合、成本 Top-N），排查线上问题不再靠翻日志。

---

## 附：建议的修复顺序

| 批次 | 内容 | 理由 |
|------|------|------|
| 第 1 批 | #1 计费模型、#2/#3 越权、#4 tool_result 丢失 | 资损 + 数据泄露 + 数据丢失，均为小 diff |
| 第 2 批 | #5 生成估价/计费、#6 取消传播、#7 metadata 竞态、#8 聊天配额 | 计费与任务状态机整体收敛（配合架构 #2、#3） |
| 第 3 批 | #9 缓存隔离、#10/#11 静态资源、#12 密钥加密、#18 rate limit | 安全加固 |
| 持续 | 架构 #4（属主中间件）+ 每路由的越权测试、#8 migration runner | 防同类问题复发 |
