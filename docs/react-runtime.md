# ReAct 运行状态与恢复

## 执行边界

`AgentService → Agent.run → ToolRegistry` 保留现有调用方式。基础设施接口定义在 core，PostgreSQL 实现在 server。

- `RunBudget` 共享推理、上下文压缩、模型传输重试的次数与已知 usage；畸形工具调用仅由 Agent 做生成修复，provider 只重试传输故障。
- `ExecutionJournal.start` 必须成功后才能执行工具；`finish` 必须保存结果后才能向上层交付工具结果。没有日志能力的独立 core 使用者仍可运行，但不具备跨请求恢复保证。
- `RunRepository` 使用迁移 0034 的 `agent_runs / agent_steps`。运行保存原始任务、来源消息和终态；步骤保存输入、工具类别、结果和稳定的 operation ID。相同运行、轮次、call ID 重入时返回已有结果。
- 写操作启动后丢失结果视为 `unknown_outcome`。同一用户、会话、工具及规范化参数匹配到未知写结果时，不自动重复执行。实际外部副作用无法由数据库日志保证 exactly-once；未知结果必须核实。
- 请求持有会话租约并每 20 秒续租；工具启动和消息写入验证租约。新请求接管失效租约后，将旧运行的在途写步骤标为结果未知，读取步骤标为失败。

## 取消、错误与工具声明

`Tool.effect` 为 `read / write / interaction`，与 `retrySafe`、`cacheable`、`parallelSafe` 分离。未声明效果且没有安全读取标记的工具保守视为写操作。新增工具须明确审查这些属性；不能因为可重试就自动启用缓存或并行。

业务封装使用 `classifyToolFailure` 或数字员工的 `toolError`，保留嵌套网络异常的含义。写操作发生网络、超时、取消或未分类异常时停止本轮并要求核实。输入校验、无权限、资源不存在属于确定失败，不应伪装成已提交。

取消信号从运行、工具传到业务服务及模型调用；生成返回后、提交产物前再次检查取消。已经提交的操作不会因为取消而回滚，数据库/远端不接受取消时仍按未知结果处理。海报、视频继续使用已有任务队列及查询机制。

`web_search / web_fetch` 允许同批独立调用并发，受 `maxParallelTools` 约束。写操作默认串行。

## 上下文与预算

历史裁剪前扣除系统消息、检索、工具 schema、实际输出预留及消息开销。图片使用视觉内容的估计值，未知尺寸预留 4096 tokens，不按 base64 传输长度计量；这仍是估计，模型上下文安全余量继续保留。

滚动摘要携带覆盖历史的 SHA-256 指纹，历史变动或旧版无指纹摘要会重新计算。重新生成删除历史时，在同一 SQL 语句内删除 `contextSummary`。执行状态与产物结果保存在步骤表，不依赖有损摘要恢复。

默认参数在 `config/default.json`，可配置：

| 参数 | 默认值 | 范围 |
| --- | --- | --- |
| `maxIterations` | 20 | ReAct 迭代 |
| `maxToolCalls` | 100 | 工具调用 |
| `maxParallelTools` | 4 | 每批并发 |
| `maxLlmAttempts` | 60 | 推理、压缩、传输重试共享 |
| `maxTotalTokens` | 1,000,000 | 上述模型调用的已知 usage |
| `maxNoProgressRounds` | 3 | 连续同调用、同结果；停止前提示重规划 |
| `maxRunTimeMs` | 1,800,000 | 包括请求准备的总时限 |
| `maxCost` | 不设 | 可选，按已知 usage 与所选模型价格估算，单位元 |

token / 费用预算在下一次模型尝试前检查；供应商未返回 usage 的请求不能精确估价，单次请求也可能跨过阈值。次数与总时限仍生效。这些预算覆盖 ReAct 推理与压缩，业务工具内部独立计费的媒体/业务生成沿用其原有配额体系。

## 终态、查询与人工核实

终态包括 `completed / awaiting_input / failed / cancelled / timed_out / budget_exhausted / unknown_outcome / empty_response / stalled`，保存在运行记录及最终消息 metadata，SSE 同步传给前端。收到 `done` 后展示终态；收到落库和租约释放后的 `stream_end` 才解除发送锁。

`GET /api/conversations/:id/runs` 返回当前用户的运行及步骤，优先显示待核实记录。`POST /api/conversations/:id/operations/:operationId/verify` 接受 `{"outcome":"succeeded"}` 或 `{"outcome":"failed"}`：

- 仅会话所有者可以在会话空闲时核实结果未知的步骤。
- 前端“核实操作结果”要求用户先检查业务记录/生成结果，再声明已完成或未执行。
- 核实不会执行工具，原始结果作为 `previousResult` 保留；声明未执行后，后续新请求才可再次尝试。
- 此接口不注册为 Agent 工具，模型不能自行解除未知写保护。

模型尝试从请求开始记录 span，覆盖首 token 等待、纯工具调用、压缩、失败尝试；缓存命中单独记录。模型尝试 span 记录执行元数据；运行表保存用户请求、工具输入和结果，不额外写入模型凭证。

## 验证与上线

先构建 core 再运行依赖它的服务端测试。服务启动时正式迁移器应用 0034；不应手改旧迁移或在运行中的服务上单独跳过迁移部署代码。

```sh
pnpm --filter @lot-agent/core build
pnpm exec vitest run packages/core/src/agent packages/core/src/context packages/core/src/tools packages/core/src/llm packages/server/src/services
REACT_PG_TEST=1 pnpm exec vitest run packages/server/src/services/run-repository.integration.test.ts
```

数据库集成测试默认跳过；显式启用时读取本地 `.env` 的 PG 设置，仅允许本机地址，在随机独立 schema 中建表验证，结束后删除该 schema，不迁移现有业务表。覆盖崩溃恢复、同操作重入、用户与租约隔离、人工核实和摘要失效。
