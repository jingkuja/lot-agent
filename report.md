# Lot Agent 全面 Review 报告

> Review 范围：`packages/core`（Agent 引擎）、`packages/server`（HTTP / DB / Worker）、`packages/web`（Workspace UI），约 2.7 万行 TypeScript / TSX。
>
> 现状：93 个测试文件 / 610 个用例全部通过（建议后续在报告中同时记录测试命令、commit 与执行时间，便于复核）。
>
> 总体评价：项目分层较清晰，core 不依赖 pg、Redis 或 HTTP server；工具沙箱、部分 SSRF 防护、上下文压缩、prompt caching 等基础能力较完整。不过 core 直接依赖 OpenAI、Anthropic 和 MCP SDK，因此不宜描述为"无 vendor 依赖"。当前最需要优先处理的是写越权、计费身份与完整性、并行工具历史丢失，以及生成任务状态不一致。

本报告按三部分组织：**现有实现的问题**、**架构设计优化**、**可以增加的功能**。问题按严重程度排序，并尽可能给出具体代码证据。

---

## 一、现有实现的问题

### P0 —— 写越权 / 资损 / 数据完整性（建议立即处理）

#### 1. 生成任务输入可覆盖服务端消息 ID，可能跨用户覆写消息 metadata

生成入口没有把任务身份字段与用户输入严格隔离：

- `packages/server/src/routes/conversations.ts:300-309` 先生成服务端 `assistantMessageId`，之后再展开 `settings`；客户端可通过同名字段覆盖服务端值。
- `packages/server/src/routes/tasks.ts:12-46` 接收过于宽泛的 `input`，没有按任务类型对白名单字段做严格校验。
- `packages/server/src/generation/run-job.ts:56-71` 使用输入中的消息 ID 更新生成状态。
- `packages/server/src/db/database.ts:751-759` 更新消息时仅按 message ID 定位，没有同时约束 conversation、task 和 user。

结果是已登录用户可能让自己的生成任务修改其他用户消息的 `status` 与 `metadata`。这比 regenerate 的删除边界问题更严重，属于跨用户写越权。

建议：

1. `userId`、`conversationId`、`assistantMessageId`、`taskId` 均由服务端创建并持久化，不从通用 `settings` 透传。
2. image/video 等任务分别使用严格 schema，只接受允许的业务参数。
3. worker 更新消息时执行带 task、conversation、user 关联条件的更新，而不是只按 message ID 更新。
4. 增加"提交其他用户 message ID 不发生更新并返回 404"的回归测试。

#### 2. 聊天计费记录的是 Agent 默认模型，不是本回合实际模型

`packages/server/src/services/agent-service.ts:727-733` 的用量上报使用 `def.defaultModelId`，但本回合真正使用的模型来自显式选择、会话存储或 Agent 默认值的解析结果（`agent-service.ts:529`）。

```ts
const cost = await this.usageMeter.record({
  // ...
  modelId: def.defaultModelId, // 应使用本回合解析后的 modelId
  usage: { inputCount: inputTokens, outputCount: outputTokens },
});
```

后果包括：

- 高价模型按低价默认模型结算，造成资损。按 `config/default.json`：`claude-sonnet-4-20250514` 为 0.024/0.12 元/千 token，`deepseek-v4-flash` 为 0.001/0.002 —— **单价差 24~60 倍**；
- `usage_logs.model_id` 本身错误，按模型统计的报表失真；
- trace 中记录的 model/provider 也可能沿用默认模型，而非本回合实际模型。

同一函数里 `memory.extract` 入队时传的就是正确的 `modelId`（`agent-service.ts:701`），说明这是遗漏而非设计。

#### 3. 模型调用计量不完整：标题生成和上下文压缩未纳入计费

除主聊天和 memory extraction 外，至少还有两类实际 LLM 调用未形成完整计量：

- 标题生成：`packages/server/src/services/agent-service.ts:422-480` 调用 LLM，但没有读取 usage，也没有写入 `usage_logs`。
- 上下文压缩：`packages/core/src/context/context-manager.ts:433-475` 通过 `complete()` 调用模型；`packages/core/src/llm/complete.ts:3-13` 只返回文本，丢弃了 `done.usage`。

这意味着"所有昂贵模型调用都计量"的产品约束尚未真正成立。建议统一通过 metered provider 执行主对话、标题生成、上下文压缩和 memory extraction，并由 provider/run context 提供不可被调用点误填的实际 `modelId`。

#### 4. `traces` 路由缺少属主校验，可跨用户读取运行信息

`packages/server/src/routes/traces.ts:8-21`：

- `GET /api/traces` 不传 `conversationId` 时会返回全站最近 50 条 trace（`database.ts:905-908`）；
- `GET /api/traces/:id` 可读取任意 trace 及 spans；
- 没有执行 conversation → user 的属主校验，违反 CLAUDE.md「cross-user access → 404」约定。

泄露内容包括会话关联、模型字段、token、延迟、错误信息及工具名称/顺序。需要注意：当前持久化 trace 并不包含 `totalCost`；`packages/server/src/services/trace-recorder.ts:73-75` 明确说明该字段未被持久化（成本是在 `finish()` 之后写入内存对象的），因此不能把 `totalCost` 列为当前接口已经泄露的字段。

建议将普通用户查询强制限定为自己的 conversation，非属主统一返回 404；全站 trace 查询仅开放给管理员。

#### 5. `ratings` 路由缺少消息属主校验

`packages/server/src/routes/ratings.ts` 允许登录用户按任意 `messageId` 创建、读取和删除评分，但没有验证 message → conversation → user 的归属链。UUID 难枚举不能替代授权检查。

建议将属主校验提炼为统一 helper，并为创建、读取、删除三个路径分别补跨用户 404 测试。

#### 6. 并行工具调用只有第一个 `tool_result` 落库

Agent 对 parallel-safe 工具会先发出一组 `tool_call`，再依次发出对应的 `tool_result`（`packages/core/src/agent.ts:505-527`）。server 在收到第一个结果后保存全部 calls、保存一个 result，随后立即清空 `currentToolCalls`（`packages/server/src/services/agent-service.ts:640-657`），导致同批后续结果不再落库。

重新加载历史时，`packages/server/src/services/message-repository.ts:59-64` 又会过滤缺少结果的 tool call，因此第 2..N 个工具调用及结果从历史中消失，模型下回合看不到自己做过什么。

根因是 `AgentEvent` 的 `tool_result` 只有工具名称，没有 `toolCallId`（`packages/core/src/agent.ts:30`），服务端只能按名称猜测配对（`agent-service.ts:636`）；同名并行调用（如两个 `web_fetch`）必然存在歧义。

建议让 `tool_result` 强制携带 call ID，服务端按 ID 逐项持久化，并补充"多个不同名工具"和"多个同名工具"两类并行回归测试。

#### 7. 图片/视频的预检、执行与结算没有使用同一实际模型

- `packages/server/src/routes/conversations.ts:271-280` 和 `packages/server/src/routes/tasks.ts:30-39` 使用固定模型（`"gpt-image-2-token"` / `"kling-standard"`）估价，用户实际提交的模型只被透传给 worker。
- `packages/server/src/workers/index.ts:123` 与 `packages/server/src/generation/run-job.ts:120-125` 又按配置默认模型结算（worker 注释直言 "Billing stays on the configured, statically-priced modelId"）。
- 用户提交的模型没有与其可用模型目录及媒体类型做统一校验。

后果：用户选 `veo3.1` 等高价视频模型时，402 预检与最终记账都按 `kling-standard` 计算——限额形同虚设，账目与 tokenhub 实际扣费对不上。

此外还有两个相关问题：

1. `n`、`durationSec` 等字段缺少有限数、正数和上限校验，负数或异常值可能绕过配额判断，甚至产生错误成本。
2. `packages/core/src/providers/image-generation.ts:63-73` 支持多图 `urls`，但 `run-job.ts` 只处理单个 `url`；当 `n > 1` 时可能只保存第一张图并只按一张计费。

建议对 image/video 建立独立 schema，约束模型类型、数量、时长、尺寸和比例；预估与结算调用同一个模型价格解析器；按实际成功产物数量创建资产并计量。

#### 8. 生成任务无法形成可靠的取消闭环

`packages/server/src/queue/bullmq-queue.ts:150-168` 的 `cancel()` 会 abort 当前进程 Map 中的 `JobControl.signal`，但：

- `packages/server/src/generation/run-job.ts:54` 没有接收 signal，轮询循环取消后最长继续跑 15 分钟，vendor 端继续消耗；
- `packages/server/src/workers/index.ts:140-147` 注册 handler 时丢弃了 `ctl`；
- server 与 worker 通常是独立进程，进程内 Map 不能传播取消；
- 当前 HTTP tasks 路由没有对外 cancel API；
- `packages/server/src/db/database.ts:1408-1421` 的成功/失败更新没有 `WHERE status IN (...)` 守卫，可覆盖 `cancelled`；
- web 端也没有完整识别 `cancelled` 终态。

因此，现状不是"cancel API 已有但 UI 未接"，而是只有内部取消原语，缺少属主校验的 HTTP API、跨进程取消传播、I/O signal 接入和状态迁移守卫。

#### 9. 生成消息 metadata 存在写覆盖竞态

`packages/server/src/routes/conversations.ts:301-314` 先 enqueue，再整体写入 `{status: "generating", taskId}`。`packages/server/src/db/database.ts:751-759` 对 metadata 是整体替换。

缓存命中时，worker 几乎瞬时完成并先写入 `{status: "completed", assets}`，随后 route 再把消息覆盖回 `generating` 并丢掉 assets。刷新后消息可能长期停留在"生成中"，只能靠 taskId 轮询侥幸恢复。

应将 task 行作为单一事实来源；如果保留 metadata 冗余，则使用 JSONB merge、版本/CAS 和单向状态迁移守卫。

#### 10. 配额检查覆盖不全，而且"先查后调用"可并发超卖

`checkQuota`（`meter.ts:37-61`）目前主要用于 image/video，聊天（含长上下文 + 高价模型，单回合可能比一张图贵得多）、标题、上下文压缩等昂贵调用没有统一配额入口。即使把所有调用包进简单的 `withQuota()`，多个并发请求仍可能同时读取旧消费值并全部通过。

建议建立额度账本：

1. 调用前原子创建 reservation；
2. 调用成功后按实际 usage settlement；
3. 失败或取消时 release；
4. reservation + settled amount 共同参与 daily/monthly limit 判断。

`user_balance.balance` 当前也没有完整充值、扣减或校验闭环。应明确它是实际余额还是仅作限额配置；若短期不使用，建议删除或标记为未启用，避免造成错误安全感。

### P1 —— 安全 / 可靠性 / 可运维性

#### 11. 生成缓存跨用户共享，静态 URL 与资产归属不一致

`packages/server/src/generation/run-job.ts:76-85` 的缓存 key 不包含 user ID。用户 B 使用相同 prompt+参数命中用户 A 的缓存时：

- task output 复用 A 的 asset IDs；
- B 的消息复制 A 的静态 URL；
- 不会创建 B 自己的资产行；
- B 通过带属主校验的资产 API 读取该 ID 会得到 404，但公开静态 URL 仍可访问。

这既可能泄露包含参考图元素的结果，也会造成数据库归属和消息展示不一致。如果共享缓存是有意的成本优化，至少应将内容缓存与用户资产记录分离，并为命中用户创建自己的引用/资产记录；否则默认按用户隔离。

#### 12. vendor 产物下载存在 SSRF、无界内存读取和不可取消问题

`packages/server/src/workers/index.ts:79-89` 对 vendor 返回的 URL 直接执行 `fetch()`，并把响应整体读入 `arrayBuffer()`。当前缺少：

- 环回、私网和 link-local 地址限制；
- 每次重定向后的地址复检；
- 明确的下载超时；
- Content-Length 与实际读取字节上限；
- 任务取消 signal；
- 流式写入 ObjectStorage。

生成图片 URL 可能来自模型文本解析，不能一律视为可信。建议复用 `web_fetch` 的地址校验策略，逐跳验证重定向，限制协议和响应大小，并通过流式管道写入存储。

#### 13. `/static/*` 路由无鉴权，主动内容可在同源执行

`packages/server/src/index.ts:178-225` 的静态路由仅依赖不可猜文件名。持有 URL 的任何人都可下载合同、文档或生成内容；URL 还可能进入聊天记录、日志和代理。

`documents` 路由会以内联 `text/html` 返回 HTML。`nosniff` 不能阻止明确声明为 `text/html` 的内容执行，因此仅补该响应头不够。（`doc-generator.ts:121-126` 已把 Markdown 中的原始 HTML 转义，挡住了 `<script>` 注入的主路径，但 marked 默认不拦 `javascript:` 链接，且该防线不覆盖其他写入 documents 目录的路径。）建议选择以下方案之一：

- HTML/SVG 等主动内容强制 `Content-Disposition: attachment` 并以 `application/octet-stream` 返回；
- 放到无 Cookie、无凭证的独立 origin，并配置严格 CSP/sandbox；
- 敏感资源统一走带属主校验的下载 API 或短时签名 URL。

当前 session token 存在 localStorage（`client.ts:120-132`），一旦同源脚本执行，token 可能被读取，因此文件源隔离尤为重要。

#### 14. 静态文件全量读入内存且不支持 Range

`packages/server/src/index.ts:184,197,210` 都使用 `readFile` 返回完整 Buffer。大文件并发下载会增加内存压力，视频也无法可靠拖动进度（无 `Accept-Ranges`）。

建议改为流式响应，支持 `Range`、`Accept-Ranges`、`Content-Range`、合理缓存头，并对单次与并发带宽做限制。

#### 15. API key、平台 access token 和 session token 明文存储

- `packages/server/src/db/database.ts:1026-1031` 涉及用户 tokenhub API key（`users.api_key` / `api_keys` JSONB），DB 泄露即等于用户计费 key 泄露；
- `sessions.token` 保存原始 session token（`database.ts:476-484`）；
- `platform_accounts.access_token` 同样属于敏感凭据。

建议 API key 与平台 access token 使用 envelope encryption（主密钥来自 KMS 或受控环境变量）；session token 只保存 SHA-256 等不可逆摘要，服务端对收到的 token 做相同哈希后查询。

#### 16. session 只有固定过期，没有清理策略

`packages/server/src/auth/session-store.ts:4,16-23` 采用 7 天硬过期并更新 `last_seen_at`，但过期行不会自动清理（表无限增长）。

固定过期可能是有意的安全策略，不应直接判为缺陷；是否改为滑动续期需要产品与安全策略共同决定。明确需要补的是定期清理、用户主动登出/撤销、设备会话管理及异常会话审计。

#### 17. `regenerate` 删除边界没有校验 message 属于目标 conversation

`packages/server/src/db/database.ts:786-794` 使用传入 message ID 的 `created_at` 作为 `>=` 删除边界，但没有验证该消息属于目标会话。路由虽然校验了会话属主（`conversations.ts:118-133`），却未验证消息归属。

传入其他会话的消息 ID 时，会以对方消息的时间戳删除当前用户自己会话的消息——影响限于自身数据，但语义是错的。建议 SQL 同时约束 `message.id` 与 `conversation_id`，找不到时返回 404。

#### 18. worker 与 server 的模型价格目录不一致

worker 的 `UsageMeter` 只查询静态配置（`packages/server/src/workers/index.ts:65`），server 侧则支持动态 catalog 兜底（`agent-service.ts:344-346`）。memory extraction 使用动态 tokenhub 模型 ID 时，worker 可能把它视为 unknown model 并跳过计费（`unknown model, skipping billing`）。

server 和 worker 应共享同一个 ModelCatalog / PricingResolver，并明确动态目录缓存的一致性和失效机制。

#### 19. 工具执行的取消、超时和路径边界不统一

- `web_fetch` 忽略 `context.signal`（`builtins.ts:390` 的 execute 只解构 input；`fetchWithTimeout` 用私有 controller），run 取消后仍可能继续请求，与 `execute_command`/`web_search` 行为不一致。
- `search_files` 的 grep 参数缺少 `--` 分隔（`builtins.ts:252-260`），`-` 开头的 pattern 可能被解释为选项。
- `withLLMRetry` 的退避 sleep 不可中断（`retry.ts:69-71,101`）。
- `ToolRegistry.timeout()` 的 timer 没有及时清理（`registry.ts:253-257`），每次工具调用都挂一个最长 `timeoutMs` 的活跃 timer。
- 文件工具使用 `resolve` 做路径 containment（`builtins.ts:35-37`），但不解析符号链接；工作目录内 symlink 可能指向目录外（当前部署已禁用文件工具，风险搁置但别忘）。

建议统一使用可组合、可清理的 signal/timeout helper；文件访问在最终打开目标前验证 realpath，并根据部署模式决定是否彻底禁用符号链接。

#### 20. 同一会话的服务端并发无保护

web 端只在单个页面实例中限制同会话单流（`useChat.ts:44,188-190`），但两个标签页或设备仍可同时发送。服务端没有会话级并发控制，`saveUserMessage`/`saveAssistantWithToolCalls` 可能交错写入；当前按 `created_at` 排序（`database.ts:761-766`）也无法保证同时间戳记录的稳定顺序。

不建议用 `pg_advisory_xact_lock` 直接包住完整流式回合：短事务结束后锁会释放，长事务持锁又会长期占用连接与数据库资源。可选方案包括：

- dedicated connection 上的 session advisory lock；
- 带租约和 fencing token 的 Redis 锁；
- conversation 上的 `active_run_id/version` 原子 CAS。

消息表应增加 conversation 内稳定 `seq`，并按 `(conversation_id, seq)` 排序。

#### 21. 缺少请求频率和资源额度限制

login（RSA 解密 + tokenhub 转发）、uploads、消息发送、生成任务等路径没有完整 rate limit。上传还把 20MB body 整体读入内存（`uploads.ts:45` 的 `parseBody`）。

建议按 IP、用户和接口成本分层限流；上传使用流式解析并限制并发、文件数、总字节与 MIME/magic bytes；昂贵调用同时受频率限制和额度 reservation 约束。

#### 22. Redis 任务进度发布没有消费者

`packages/server/src/queue/bullmq-queue.ts:172-178` 发布 `task:{id}:progress`，但当前没有订阅端；web 用 1 秒间隔轮询 `GET /api/tasks/:id`（`useChat.ts:112`）。

若保留 pub/sub，应增加带属主校验的任务事件流。浏览器原生 EventSource 不能设置当前 Bearer `Authorization` header，不能直接替换现有 fetch 鉴权。可选方案是：

- 使用 `fetch()` 读取 SSE；
- 改用安全的 HttpOnly Cookie；
- 为事件流签发短时、一次性 token。

Redis subscriber 必须使用独立连接，不能复用进入 subscriber 模式的普通命令连接。

### P2 —— 小问题 / 代码坏味道

| # | 问题 | 位置 / 建议 |
|---|---|---|
| 23 | `maxRunTimeMs: 600_000` 与 "5 min" 注释、默认值文档三处互相矛盾 | `packages/core/src/agent.ts:44,102`，统一常量和注释 |
| 24 | `done` 事件的 `cachedPromptTokens` 在 SSE 适配层丢失 | `packages/server/src/services/sse-adapter.ts:23-30` |
| 25 | 路由通过 `service["llmConfig"]` 访问私有成员 | `packages/server/src/routes/conversations.ts:51-54`，改成公开接口或按需注入 |
| 26 | malformed-recovery 合成消息只存在 working history，不落库 | `packages/core/src/agent.ts:423`；主要影响 trace/replay 可复现性，若保存应作为内部事件或 metadata，而非伪装成普通 user 消息 |
| 27 | 标题 prompt 规定 max 30 chars，代码截断 50 | `packages/server/src/services/agent-service.ts:467,476` |
| 28 | 前端消息 ID 基于 `Date.now()`，同毫秒事件可能撞 key | `packages/web/src/hooks/useChat.ts:227,306`，使用事件 ID/toolCallId/UUID |
| 29 | regenerate 先删除 DB 历史再重发，失败时该轮历史不可恢复 | `packages/web/src/hooks/useChat.ts:399-408`，改为分支或事务化状态 |
| 30 | 上传 MIME 完全信任客户端 `File.type` | `packages/server/src/routes/uploads.ts:31`，增加 magic-bytes 检测 |
| 31 | 多张业务表的 `user_id` 使用 VARCHAR，缺乏系统性外键约束 | 不只 `usage_logs`（`database.ts:428`）、`conversations`（`database.ts:492`），还应检查 tasks、assets、review_logs、platform_accounts、publish_records、user_agents 等 |
| 32 | `anySignal` 给外部 signal 增加的监听器未移除，长命 signal 上会累积 | `packages/core/src/agent.ts:87-98` |
| 33 | `web_search` 使用平台 `BIGMODEL_API_KEY`，成本未计量或限流 | `packages/core/src/tools/builtins.ts:479`；它是外部搜索成本，不宜直接描述为违反"所有模型调用使用用户 key"，但应计量并限流 |

---

## 二、架构设计优化

以下方案按投入产出排序。前五项可直接消除大部分 P0 的同类根因。

### 1. 建立严格的任务命令边界

不要让通用 `input/settings` 同时承载用户业务参数和服务端身份字段。

- image/video 分别定义 schema；
- 服务端身份字段使用独立 command/context 创建；
- task 表持久化不可变的 user、conversation、message 关联；
- worker 从 task 关联读取身份，而不是信任 payload；
- 所有写回都带属主与预期状态条件。

### 2. 给事件模型补上稳定身份

`tool_result` 必须携带 `toolCallId`（Agent 循环里 `recordResult` 拿得到 `tc.id`，`agent.ts:482-501`），服务端按 ID 配对持久化，SSE 契约同步加字段（前端向后兼容）。所有流式事件可进一步携带：

- `runId`：区分同一会话的不同运行；
- `seq`：run 内稳定序列；
- `eventId`：用于幂等和去重；
- `parentId`：需要时表达工具/子 Agent 因果关系。

增加 `seq` 只是断线续传（`Last-Event-ID`）的前提，不等于已经支持 replay。

### 3. 计费收敛为统一的 metered execution 管道

现在计费散落在多个调用点，各自手填 `modelId`，已产生多个不一致 bug（#2、#3、#7、#18）。建议用一个统一执行器覆盖 chat、title、compression、memory、image 和 video：

1. 从用户可用 ModelCatalog 解析实际模型、媒体类型和价格；
2. 进行参数 schema 校验；
3. 原子预留额度；
4. 调用 provider 并捕获实际 usage/产物数；
5. 结算或释放 reservation；
6. 同步记录 usage、trace 和业务关联。

`modelId` 应来自 provider/run context，不允许每个调用点手填。server 与 worker 必须共享同一个 PricingResolver，估价（`estimateCost`）和记账（`calcCost`）强制使用同一个模型解析函数。

### 4. 任务状态使用单一事实来源和显式状态机

问题 #8、#9 的共同根因是"task 行"和"message.metadata"两处冗余状态互相追赶。建议 task 表作为权威状态源，message metadata 只保存 `taskId`（一次写入不再更新），前端展示所需的状态/资产一律 join task 行（`GET /api/tasks/:id` 已经是前端的实际数据源）。状态迁移至少应定义：

```text
pending -> running -> succeeded
                  -> failed
pending/running -> cancelling -> cancelled
```

每次迁移使用 `WHERE status IN (...)` 或 version CAS，终态不可被后续写覆盖。取消信号通过 Redis/DB/BullMQ 可跨进程传播，并接入 create、poll、download、storage 等所有可中断 I/O。

### 5. 属主校验中间件化

`getConversation → user_id !== userId → 404` 的模式已在多个路由手写，而 traces/ratings 忘写（#4、#5）。提炼统一的资源加载和授权 helper：

```ts
const conversation = await requireOwnedConversation(ctx, conversationId);
const message = await requireOwnedMessage(ctx, messageId);
const task = await requireOwnedTask(ctx, taskId);
```

内部统一采用 404 隐藏资源存在性。为 conversations、messages、ratings、traces、tasks、assets 和 downloads 建立跨用户访问测试矩阵，把约定固化。

### 6. 拆分 `AgentService`

751 行的 `AgentService` 同时承担 DB、Redis、BullMQ、SkillLoader、MCP、catalog、provider、usage、上传等职责，所有路由都拿整个 service 再挖字段（甚至 `service["llmConfig"]`）。可按限界拆为：

- `ChatService`：run 编排、消息与标题；
- `CatalogService`：用户模型目录和缓存失效；
- `BillingService`：reservation、settlement 和 usage 查询；
- `GenerationService`：任务创建、状态与取消；
- `TraceService`：运行可观测性；
- 路由只注入实际需要的接口。core 的「interface-in-core, impl-in-server」原则同样适用于 server 内部分层。

### 7. 任务进度采用鉴权事件流，并保留轮询回退

Redis pub/sub 基建已就位（#22）。新增 `GET /api/tasks/:id/events` 前必须先校验 task 属主。鉴于当前 Bearer 鉴权，前端优先使用 fetch streaming SSE；若未来改为 HttpOnly Cookie，再考虑原生 EventSource。

事件流需要 initial snapshot、心跳、完成事件和断线后的 DB 回退。Redis pub/sub 只提供实时通知，不提供历史 replay。落地后可消灭每任务每秒一次的 HTTP 轮询与死代码。

### 8. 静态资源统一走 ObjectStorage 与受控下载

`ObjectStorage` 接口已存在。规划中的 S3 实现落地时，把 `/static/*` 换成短时签名 URL 或带 Bearer 的 `/api/files/:id` 流式下载（校验 asset 属主，支持 Range）。ObjectStorage 应支持：

- 流式 put/get；
- metadata、size、content type；
- Range；
- 短时签名 URL 或受权 API；
- 主动内容隔离；
- 用户资产引用与底层内容对象分离，以安全支持去重缓存。

本地盘实现也应先做流式 + Range（#14）。

### 9. 引入正式 migration runner

`packages/server/src/db/database.ts` 全文件超过 1400 行，其中 inline `migrate()` 约 386 行（`database.ts:216-602`），DDL/DML/backfill 混杂，`ALTER ... DROP NOT NULL` 这类不可 CREATE-IF-NOT-EXISTS 的语句只能靠幂等性硬扛。建议引入 `schema_migrations` + 顺序 migration 文件（如 `node-pg-migrate`）；DDL 与 backfill 分开执行，并为大表迁移设计锁和回滚策略。这也是 roadmap 已承认的欠账。

### 10. 会话并发采用租约/CAS，而不是长事务锁

conversation 增加 `active_run_id`、`run_version` 或同等字段；开始运行时原子 claim，完成后按 fencing token release。需要支持排队时再引入队列，不支持时明确返回 409。

消息使用 conversation 内递增 `seq`，避免依赖时间戳排序（#20）。

### 11. 前端流状态 reducer 化

513 行的 `useChat` 用闭包变量 + `setMessages(prev => ...)` 手工维护流状态，事件种类还在增加。将 title、text delta、tool、artifact、generation 和 terminal 事件统一交给纯 reducer（可单测事件序列 → 视图状态）；以 `runId/eventId/toolCallId` 作为身份，减少闭包状态、重复事件和 React key 碰撞，`isStreaming`/`genPoll`/`streams` 三份互相纠缠的状态自然归一。

### 12. 密钥、会话与资源治理

- API key 和 platform access token 做静态加密（envelope encryption，密钥来自 env/KMS）；
- session token 只存摘要（`sha256(token)`），验证时哈希比对；
- 登录、上传、聊天和生成实施分级 rate limit（hono-rate-limiter + Redis 计数即可）；
- 建立 sessions、tasks、usage_logs、traces、assets 的保留和归档策略；
- 审计管理员读取全站 trace、密钥变更和平台授权操作。

---

## 三、可以增加的功能

### 近期：先补 API 闭环，再接 UI

1. **用量与限额面板**
   已有 usage summary/logs/balance 查询能力（`GET /api/usage/summary|logs|balance`），但前端没有任何入口，daily/monthly limit 的写入、权限和语义也尚需定义。先补限额更新 API、reservation 展示和管理员/用户权限，再做按天、按模型消费图表。

2. **任务中心**
   当前不是"cancel API 已齐全"。需要新增用户级任务列表、分页、属主校验 cancel API、`cancelled` 终态、跨进程取消传播（配合架构 #4），再提供进行中/历史任务 UI。

3. **素材库 / 生成历史**
   assets 有基础表和索引（`idx_assets_user`），但缺少完整的用户级分页列表、归档/删除、缓存命中归属与引用模型。完成后再提供瀑布流：预览、下载、复制 prompt 一键重生成、作为参考图再创作。

4. **记忆管理 UI**
   memory 的 list/search/set/delete API 基本可复用（`routes/memory.ts`）。UI 应同时说明来源、更新时间和删除影响，让用户能查看并纠正"系统记住了我什么"——也是隐私体验的重要一环。

5. **确定性的会话导出**
   `generate_document` 是 Agent 工具，不等同于可靠的会话导出。建议新增服务端导出接口，按属主校验后序列化消息、工具调用、附件和生成资产，并直接创建 md/docx/pdf artifact，避免再次调用 LLM。

6. **消息编辑与分支重发**
   当前 regenerate 只支持最后一轮且是破坏性删除（#29）。可引入 branch/parent message 关系，编辑任意 user 消息后创建新分支，保留原历史并允许切换——聊天产品的标配。

### 中期：完成已有抽象的生产闭环

7. **RAG 知识库（E4 收尾）**
   Retriever、InMemoryVectorStore 和 attachment extraction 已有基础，Agent 循环也预留了 `retriever/retrievalNamespace` 注入点（`agent.ts:66-74`）。还需 pgvector/外部向量库、文档切分与版本、异步入库、删除传播、引用证据、租户隔离和配额管理。落地后即可做"个人知识库问答" Agent 与跨会话资料引用。

8. **多 Agent 编排执行器（E5 收尾）**
   在 `agentAsTool` 与 Pipeline 原语（`orchestration.ts`）上补执行状态、超时/取消、预算传播、工具白名单、人工 gate、结果 schema 和 trace，避免把子 Agent 变成不可观测的黑盒。典型场景：PPT Agent 调用图片 Agent 生成配图、文案 Agent → 审核 → 发布走 Pipeline gate。这是产品差异化最大的方向。

9. **断线续传**
   除事件 `seq` 外，还需要 `runId`、事件缓存/持久化、保留期限、Last-Event-ID 解析、重复去除和终态 replay。Redis pub/sub 本身不能承担历史事件存储。移动端弱网体验会明显改善。

10. **语音输入**
    ASR stub 接口已存在（`providers/asr.ts`）。接入真实 ASR 前需补音频格式、时长/大小限制、上传隐私、取消和成本计量，然后在 InputBox 加语音按钮。

11. **自定义 Agent**
    `AgentDefinition` 已完全数据化（systemPrompt/toolNames/modelParams/inputSchema），入库只是第一步，还需工具白名单、模型可用性校验、prompt/version 管理、租户隔离、发布审核、输出 schema 校验和版本回滚，然后用户即可自建垂直 Agent 并出现在 Agent 中心。

### 远期：依赖外部平台和组织能力

12. **真实发布通道**：`PlatformConnector` 目前是 stub；平台 OAuth、token 加密、刷新/撤销、幂等发布、失败重试与 review audit。
13. **内容审核升级**：`KeywordReviewProvider` → 云审核 API；文本、图片、视频多模态审核（`ReviewProvider` 已支持多模态签名），保留策略版本和人工复核记录。
14. **团队空间**：组织 RBAC、会话/资产共享边界、key 池与成本中心、审计日志（依赖 tokenhub 侧的组织模型）。
15. **管理端可观测性**：traces/spans 已入库，修复 trace 越权（#4）后建立 admin-only 浏览器，提供回合耗时瀑布、错误聚合、成本 Top-N、模型与工具维度筛选——排查线上问题不再靠翻日志。

---

## 附：建议的修复顺序

| 批次 | 内容 | 验收重点 |
|---|---|---|
| 第 1 批 | #1 任务输入写越权、#2/#3 计费身份与漏计、#4/#5 属主越权、#6 工具结果丢失 | 跨用户写/读均返回 404；所有 LLM 调用记录实际模型与 usage；并行同名工具可完整恢复历史 |
| 第 2 批 | #7 生成参数/模型/多图计量、#8 取消闭环、#9 状态竞态、#10 原子配额 | 预估与结算使用同一模型解析；取消不可被成功覆盖；并发额度不超卖 |
| 第 3 批 | #11 缓存与资产归属、#12 vendor 下载、#13/#14 文件安全与流式下载、#15 密钥治理、#21 限流 | 缓存不泄露用户内容；下载抗 SSRF/大响应；主动内容不在主应用源执行 |
| 第 4 批 | #16～#22 可靠性与运维问题、正式 migration、会话并发控制 | 清理/归档可运行；同会话并发行为确定；Redis 进度能力有真实消费者或被删除 |
| 持续 | 属主校验测试矩阵、计费一致性测试、状态机性质测试、安全回归 | 每类新资源默认具备属主、额度、取消、审计与保留策略 |

## 最终判断

项目当前的问题不是单个函数质量差，而是几项横切能力尚未形成统一机制：**身份字段可信边界、属主校验、计费、任务状态和事件身份**。优先把这些机制收敛，比逐个修补表面症状更能防止同类问题复发。

其中应最先处理的是：生成任务跨用户写越权、实际模型计费错误、未计量 LLM 调用、traces/ratings 读越权，以及并行工具历史丢失。完成这些后，再推进生成状态机、原子配额、文件下载安全和产品功能建设。
