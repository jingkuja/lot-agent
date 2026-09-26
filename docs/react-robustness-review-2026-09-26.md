# Core ReAct 健壮性评估

评估日期：2026-09-26。代码基线：`a93d08e`。范围：core Agent、ToolRegistry、内置工具、OpenAI/Anthropic 流适配、上下文管理，以及 server 的消息持久化、trace、计量接入。

## 修复进展（2026-09-26）

下文保留的是修复前的审计证据，代码位置与行号对应原基线。此次修复已处理 R1–R9 的复现缺陷，并将主要故障场景加入长期回归测试。

| 范围 | 已落实的行为 |
| --- | --- |
| R1 权限 | Agent 和 Registry 在执行前校验本轮白名单；server 不注册宿主文件、命令工具 |
| R2 执行 | 每次尝试独立 deadline 并传播取消；只有显式 `retrySafe` 工具自动重试；写工具超时、断网等不确定结果标为 `unknown_outcome` 并停止本轮 |
| R3 输入 | Ajv 完整校验嵌套 schema；AskUserCard、OutlineCard 对历史或异常输入防御性解析 |
| R4 流完整性 | OpenAI/Anthropic 必须收到终止信息；截断、异常 EOF、非法工具 JSON 不再视为成功；保留已知 usage |
| R5 生命周期 | 准备阶段即启动 deadline，覆盖检索、记忆、压缩和模型等待；core 异常出口产出 error 与明确 done 状态并释放资源 |
| R6 预算 | 最终请求估算包含工具 schema、历史工具参数和生成预留；超预算拒绝发送；默认每轮运行最多 100 次工具调用、4 个并行调用 |
| R7 重试 | 已输出文字或 thinking 后不再透明重试并拼接内容；仅无可见输出时保留恢复路径 |
| R8 计量 | 尊重自定义 compressor；server 在每次实际 LLM 调用边界计量，消息保存与 trace 失败不再跳过已知 usage |
| R9 Trace | 用 toolCallId 关联并行工具结果，关闭未完成 span，保存运行状态 |

同时修复同批 cacheable 请求的进行中去重、插件同步异常及定时器清理、网络错误分类和尾部空帧漏 usage。网络读取覆盖响应 body 的取消和字节上限，原生 HTTP(S) 连接固定已校验的 DNS 地址；MCP 转发 signal；命令取消清理进程树；文档/PPT 在存储边界检查取消并清理本次新建的未提交文件。

验证结果：

- `pnpm test`：**218 个文件通过、10 个跳过；1499 项通过、58 项跳过**。桌面端测试需允许监听本机 loopback 端口，已在允许该操作的环境重跑通过。
- `pnpm --filter @lot-agent/core build`、server build、web build 均通过（包含生产声明/前端类型构建）。web 保留原有大 chunk 提示。
- core 全文件独立 `tsc --noEmit` 仍有既存测试文件类型错误（jobs/providers 的 mock 和类型断言），不等同于生产构建失败。
- 新增回归覆盖权限、写工具超时、同步 throw、嵌套输入、模型截断/EOF、取消、压缩器、上下文预算、并行去重/上限、进程树、DNS 固定、解压后字节限制、持久化失败计量与 UI 降级。

本次没有调用付费模型或业务数据库；真实 tokenhub/MCP 的端到端兼容、Windows 进程树取消和生产负载尚未验证。非合作式插件与已经提交的远端副作用无法通过 AbortSignal 撤销，因此保留“结果未知”而不宣称成功取消。持久化执行日志、跨进程崩溃恢复、计量数据库失败后的持久化补偿、全局/每用户并发预算仍属于下述第三批架构工作；当前修复不提供跨重启 exactly-once 保证，也不保证并行 trace 的事件时间就是工具真实执行耗时。

## 结论

**ReAct 的决策循环可以保留，但当前实现还不适合直接承担所有有副作用工具的可靠执行。** 主要问题集中在执行权限、超时后继续执行、自动重试、异常终止和结果一致性，而非需要更换 ReAct 算法。

已有轮次限制、运行 signal、工具超时、错误分类、参数检查、上下文压缩、工具调用去重和消息配对等基础。不过，一些保护目前只覆盖正常路径：隐藏工具并不等于禁止执行；超时返回并不等于任务停止；返回 done 也不一定代表模型完整结束。

适用范围需要区分：对话与办公工具通过 `AgentService → Agent.run → ToolRegistry` 执行；独立图片/视频生成还走 BullMQ worker。本报告不能替代 worker、真实 tokenhub、PostgreSQL/Redis 或部署环境的端到端评估。

## 验证与边界

- 现有相关测试：**37 个文件、255 项全部通过**，覆盖 Agent、tools、LLM、context、MCP retry、agents、server services、计量包装器及 conversation run lease。
- 新增临时故障注入：7 个 ReAct/上下文探针、3 个集成/上下文探针均成功复现下述缺陷；另有工具执行、provider、React 渲染脚本复现。
- 探针断言的是“当前缺陷确实存在”，通过不代表行为正确。测试使用模拟模型、模拟网络、内存计数器和临时文件，没有调用真实付费模型或修改业务数据。
- 未做真实模型成功率评测、压测、进程崩溃恢复演练或真实 MCP 取消验证，不能据此给出生产成功率。
- 初次评估只新增文档，临时测试移出仓库；后续修复及长期回归见上方“修复进展”。

现有测试命令：

```bash
pnpm exec vitest run packages/core/src/agent packages/core/src/tools packages/core/src/llm packages/core/src/context packages/core/src/mcp packages/core/src/agents packages/server/src/services packages/server/src/billing/metered-llm.test.ts packages/server/src/routes/conversations.test.ts packages/server/src/db/conversation-run-lease.test.ts
```

## 需要优先处理的发现

优先级含义：P0 为权限边界问题，应首先封堵；P1 为会影响执行正确性或可用性的故障；P2 为一致性、诊断和适配缺口。

| 编号 | 优先级 | 发现 | 已验证影响 |
| --- | --- | --- | --- |
| R1 | P0 | 工具白名单没有执行期校验 | `allowedToolNames: []` 时，模型返回已注册工具名仍实际执行 |
| R2 | P1 | 超时仅停止等待，自动重试可能重复写入 | 3 次调用重叠；调用方收到错误以后，3 次副作用仍全部完成 |
| R3 | P1 | JSON Schema 仅浅校验 | 非字符串选项通过 `ask_user`，卡片渲染实际抛异常 |
| R4 | P1 | 模型流提前 EOF 被视为完成 | 完整工具参数未执行，无 error，直接 done |
| R5 | P1 | 运行时限和收尾未覆盖整个生命周期 | 准备阶段超过时限仍成功；压缩取消直接抛出，缺少 done |
| R6 | P1 | 上下文预算不是硬上限 | 总预算 4096 时，巨大工具参数使组装结果估算达 9055 tokens |
| R7 | P2 | malformed 重试污染已输出文本 | 失败前缀和成功答案拼接成最终可见内容 |
| R8 | P2 | 压缩计量被绕过，收尾失败会跳过计量 | 指定 compressor 未被调用；保存失败后已有 usage 未记录 |
| R9 | P2 | 并行工具 trace 关联错误 | 前一调用的错误记到后一调用，前一 span 没有结束时间 |

### R1：工具白名单必须成为执行权限

位置：[Agent 工具声明过滤](/Users/nikin/project/lotlife/lot-agent/packages/core/src/agent/agent.ts:273)、[执行入口](/Users/nikin/project/lotlife/lot-agent/packages/core/src/agent/agent.ts:460)、[Registry 执行](/Users/nikin/project/lotlife/lot-agent/packages/core/src/tools/registry.ts:43)。

`allowedToolNames` 只传给 `toLLMTools()`。模型返回工具调用后，`executeOne()` 直接用 `tc.name` 访问完整 registry，没有检查该工具是否在本次授权集合内。缓存、parallelSafe 和 endsTurn 的读取同样基于完整 registry。

server 把完整 `this.toolRegistry` 注入每次 run（`agent-service.ts:1266`）。`DISABLED_HOST_TOOLS` 中的 `read_file`、`write_file`、`execute_command` 等仍然注册，只从 general 的工具声明中排除（`:100`、`:742`）。

**复现：** 注册无害 `hidden` 工具，Agent 配置空白名单，模拟 provider 返回 `hidden({})`；模型收到的工具列表为空，但工具执行计数为 1。

**影响：** 如果模型或网关返回一个未声明但已注册的名称，运行时仍会接受。部署端“隐藏宿主工具”的设计不能构成权限边界。本次未尝试读取秘密或执行危险命令，也未验证真实模型被诱导的概率。

**建议：** 执行前按本次 run 的不可变授权集合拒绝调用，返回 `permission`；缓存查询之前也执行校验。server 再注入受限 registry/执行 capability 作为第二层保护。宿主工具在服务部署中默认不注册。

### R2：超时、取消与重试没有保证副作用只发生一次

位置：[默认重试](/Users/nikin/project/lotlife/lot-agent/packages/core/src/types/index.ts:175)、[重试循环](/Users/nikin/project/lotlife/lot-agent/packages/core/src/tools/registry.ts:104)、[超时竞争](/Users/nikin/project/lotlife/lot-agent/packages/core/src/tools/registry.ts:142)。

所有工具默认遇到 `timeout/network` 最多重试两次。超时通过 `Promise.race` 返回错误，却没有中止当前 attempt；工具收到的是整次 run 的 signal，不是 attempt 的 deadline signal。即使工具支持 signal，单次超时也不会把这个 signal abort。

**复现：** 使用 100ms 后递增计数器的模拟写工具，把 timeout 缩为 10ms、重试间隔设为 0。实际 `started=3`、`maxActive=3`；Registry 返回错误时 `committed=0`，稍后 `committed=3`，三个 signal 都没有 abort。这是默认重试语义的加速复现，不是生产默认时长。

文档、PPT、业务写工具没有普遍声明禁止重试或幂等键。真实副作用是否重复取决于各工具内部事务与幂等性；执行框架本身没有保证。

取消传播还存在三个边界：

- [web_fetch](/Users/nikin/project/lotlife/lot-agent/packages/core/src/tools/builtins.ts:393) 在拿到 headers 后就移除超时和取消监听，随后才调用 `res.text()`（`:483`）。探针在 body 阶段取消，底层 fetch signal 仍为 false，body 完成后工具返回成功。`maxChars` 是读取后的文本裁剪，不是下载字节上限。
- [execute_command](/Users/nikin/project/lotlife/lot-agent/packages/core/src/tools/builtins.ts:236) 用 `execFile` 的 signal 取消直接子进程，未管理进程树。临时测试中父进程取消后，其子进程仍完成写入 marker。当前部署原意是隐藏该工具，但 R1 使这一假设不可靠。
- [MCP 工具](/Users/nikin/project/lotlife/lot-agent/packages/core/src/mcp/client.ts:113) 忽略 `_ctx.signal`，未传递给 `client.callTool`。这是静态确认的取消传播缺口，未对真实 MCP 服务做取消测试。

**建议：** 每次 attempt 建独立 AbortController，将 run 取消和 attempt deadline 合并；合作式工具完整覆盖 body、子任务和资源释放。默认只对明确可重试的只读工具重试。写操作需要持久化幂等键和调用状态；远端是否成功无法确认时应标为 `unknown_outcome`，不能简单重发。宿主进程树清理或隔离 worker 用于无法合作式停止的工作，不能指望 Promise.race 终止执行。

### R3：结构化输入没有被完整验证

位置：[validateToolInput](/Users/nikin/project/lotlife/lot-agent/packages/core/src/tools/validate.ts:18)、[ask_user schema](/Users/nikin/project/lotlife/lot-agent/packages/core/src/tools/ask-user.ts:40)、[卡片渲染](/Users/nikin/project/lotlife/lot-agent/packages/web/src/components/AskUserCard.tsx:70)。

校验器只检查顶层 required 和属性的基本类型，不验证根类型、嵌套对象、数组 items、enum、数值范围、maxItems 等。工具描述里的 schema 不能因此被视为运行时契约。

**复现：** `ask_user({question:"Choose?", options:[{label:"not a string"}]})` 被判定成功并 endsTurn。将同一输入交给真实 AskUserCard，用 React 服务端渲染实际抛出 `Objects are not valid as a React child`。

**建议：** 在 Registry 统一编译并执行完整 schema 校验，再在业务工具内做权限及语义检查。错误保留 JSON 路径，便于模型修正。前端卡片也需解析 unknown 数据并提供无效输入降级，不能仅依靠 TypeScript 类型断言。

### R4：没有终止帧的流仍能成功收尾

位置：[OpenAI 流结束处理](/Users/nikin/project/lotlife/lot-agent/packages/core/src/llm/openai.ts:201)、[Agent 完成判断](/Users/nikin/project/lotlife/lot-agent/packages/core/src/agent/agent.ts:438)。

OpenAI mapper 只有看到 `finish_reason` 才会 flush 缓存工具调用。若迭代器正常 EOF 但没有终止帧，不报错；Agent 把“没有 tool_call 事件”理解为最终答案，直接 done。

**复现：** 流给出完整 `effect({"value":"ready"})` 参数后 EOF；实际工具执行数 0，仅输出 `done(iterations=1,tokens=0)`，没有 error。若已有部分文本，也可能把半截答案视为完成。

此外 Agent 不用 `finishReason` 做决策；OpenAI 的 `length` 无法与完整回答区分。Anthropic mapper 更是把不同 `stop_reason` 一律写成 `stop`（`anthropic.ts:229`）。

**建议：** provider 明确区分完整完成、工具请求、截断、拒绝和异常 EOF；Agent 只在有效终止状态下接受结果。参数完整也不能替代流完整性校验。增加空流、部分文字后 EOF、工具参数中断、完整参数无终止帧的测试。

### R5：运行 deadline 与最终状态需要覆盖准备、压缩和退出

位置：[异步准备](/Users/nikin/project/lotlife/lot-agent/packages/core/src/agent/agent.ts:247)、[启动 deadline](/Users/nikin/project/lotlife/lot-agent/packages/core/src/agent/agent.ts:303)、[上下文组装](/Users/nikin/project/lotlife/lot-agent/packages/core/src/agent/agent.ts:347)、[清理](/Users/nikin/project/lotlife/lot-agent/packages/core/src/agent/agent.ts:551)。

`listUserMemory()` 和 retrieval 在创建 timeout controller 之前执行，因此不受 `maxRunTimeMs` 约束；它们也没有收到本次 run 的 signal。server 的历史/附件加载和 memory hydrate 还发生在 Agent.run 外面。

**复现一：** memory 准备耗时 40ms，`maxRunTimeMs=5ms`，依然无 timeout error。

`contextManager.assemble()` 位于捕获 provider 错误的 try/catch 之外。压缩时取消会从 ContextManager 抛出，外层只有 finally 清 timer，没有统一 error/done。

**复现二：** 在压缩调用中 abort 并抛异常，Agent 迭代器直接 reject，没有 done。若在已经消耗模型用量的后续轮次发生同类中断，server 依赖最终 done 的用量累计也可能丢失。

**建议：** 从请求执行开始建立统一 run supervisor，覆盖准备、检索、压缩、LLM、工具、持久化；把结果终态保存到独立状态，而非只依赖 SSE 的消费者完整读完生成器。保留 success、awaiting_input、cancelled、timed_out、failed、unknown_outcome 的区别。

### R6：巨大工具参数能突破上下文预算

位置：[token 统计](/Users/nikin/project/lotlife/lot-agent/packages/core/src/context/context-manager.ts:169)、[truncateToFit](/Users/nikin/project/lotlife/lot-agent/packages/core/src/context/context-manager.ts:486)。

预算计算会计入 toolCalls，但截断只处理消息 content，且永远保留最新轮次。一个巨大的 PPT/文档工具参数、或同轮累积的很多工具参数，无法被最后的文本 squeeze 减小。工具 schema 本身也没有计入 assemble 的预算。

**复现：** 总预算 4096、generation reserve 1000，最新轮次的工具参数含 9000 个中文字；组装后按同一 ContextManager 估算仍为 **9055 tokens**。

**建议：** 大型参数/结果用 artifact 引用并保留可核对摘要；按完整 assistant/tool 组压缩；加入工具 schema 和输出 reserve 后做最终硬校验。实在放不下时明确拒绝或拆分任务，不发送已知超限请求。禁止为了缩短内容而破坏 tool_call/tool_result 配对。

### R7：重试的内部答案与可见答案不一致

位置：[重试重置](/Users/nikin/project/lotlife/lot-agent/packages/core/src/agent/agent.ts:363)、[文本立即发送](/Users/nikin/project/lotlife/lot-agent/packages/core/src/agent/agent.ts:376)、[server 累积](/Users/nikin/project/lotlife/lot-agent/packages/server/src/services/agent-service.ts:1342)。

malformed-tool-call 重试会重置本次 attempt 的 assistantContent，但先前已 yield 的 text/thinking 不会撤销。server 将所有事件持续拼接。

**复现：** 首次先输出 `WRONG PREFIX` 再失败，重试输出 `CORRECT FINAL`；最终事件聚合为 `WRONG PREFIXCORRECT FINAL`。结构化输出校验只验证内部重置后的成功文本，也未覆盖外部聚合答案。

**建议：** 增加 attempt 标识和替换/作废事件，UI、消息存储和 outputSchema 校验使用同一成功 attempt；或在不可回滚输出以后禁止透明重试。不要只在内存里清空字符串。

### R8：计量包装器和 finally 并未保证计量完成

位置：[service 配置 compressor](/Users/nikin/project/lotlife/lot-agent/packages/server/src/services/agent-service.ts:1225)、[Agent 显式传入普通 llm](/Users/nikin/project/lotlife/lot-agent/packages/core/src/agent/agent.ts:352)、[ContextManager 参数优先级](/Users/nikin/project/lotlife/lot-agent/packages/core/src/context/context-manager.ts:246)。

ContextManager 优先使用 assemble 参数里的 compressor，其次才使用构造配置。Agent 总是传 `context.llm`，覆盖 server 为压缩配置的 `meterLLM`。

**复现：** 显式配置的 compressor 被调用 0 次，普通 provider 调用 2 次（压缩和正文）。压缩 usage 也不经过 Agent 主循环累计，因而该接入不能实现注释声明的压缩计量。

另外，service 的 finally 先 await `saveFinalAssistant()`，再结束 trace，最后才记录 usage（`:1410`、`:1448`、`:1451`）。前两步失败会跳过后续步骤。

**复现：** 模拟正文成功并给出 12+5 tokens，注入最终消息保存失败；迭代器抛异常，usageMeter.record 调用数为 0。

**建议：** 统一在每次实际模型调用边界采集 usage，压缩和重试也带 attempt id；计量、trace、消息最终保存分别处理失败并有补偿记录。不能让 trace 存储失败阻断计量。

### R9：并行执行的 span 会串号

位置：[单个 toolSpanId](/Users/nikin/project/lotlife/lot-agent/packages/server/src/services/trace-recorder.ts:14)、[覆盖当前 span](/Users/nikin/project/lotlife/lot-agent/packages/server/src/services/trace-recorder.ts:50)、[调用侧未带 call id](/Users/nikin/project/lotlife/lot-agent/packages/server/src/services/agent-service.ts:1348)。

Agent 已支持连续 parallelSafe 调用一起启动，但 TraceRecorder 仍仅有一个 toolSpanId。两个 call 先后 start 后，第一个 result 结束的是第二个 span，之后第一个 span 无法正常关闭。

**复现：** first/second 两次 start，随后 error/ok 两次 result；first 仍是 ok 且无 end_time，second 被记为 error。真实耗时也不能从当前结果事件顺序可靠还原。

**建议：** 用 toolCallId/attemptId 映射 span；执行器在真实开始、结束时产出生命周期事件。当前生产内置并行工具主要是 load_skill，因此优先级低于前述执行安全问题，但会影响后续并行工具扩展。

## 其他已发现的缺口

- **Anthropic 参数恢复失败（P2）：** mapper 把非法 JSON 保留为字符串（`anthropic.ts:195`），下一轮 `toAnthropicMessage` 又 JSON.parse（`:308`）。探针产生 validation result 后，下一轮直接以 SyntaxError 退出，模型收不到修复反馈。正常 tokenhub 用户聊天走 OpenAIProvider，此项主要影响 Anthropic/fallback。
- **错误分类丢失（P2）：** web_search 捕获网络错误后只返回 isError，没有 errorKind（`builtins.ts:612`），Registry 当作 unknown，不按配置重试。模拟 fetch failed 得到 attempts=1，即使 maxRetries=2。
- **非标准网关空帧漏 usage（P2）：** finish 帧后若先有无 usage 的空 choices 帧、再有真正 usage 帧，OpenAI mapper 提前 done 并丢弃最后用量（`openai.ts:185`）。模拟 50+20 tokens 未进入 done。需要与真实 tokenhub 适配行为核对发生频率。
- **插件同步异常逃逸（P2）：** `tool.execute()` 在 Registry 的 try 之前调用（`registry.ts:153`）。插件若同步 throw，异常逃出执行器且 timeout timer 未清理；临时脚本同时观察到同步错误和随后 unhandled TimeoutError。当前内置工具多为 async，应通过 Promise 包装和统一 finally 加固扩展边界。
- **同批 cacheable 去重无效（P2）：** 缓存只存已完成结果，Promise.all 同时启动的相同调用都看不到缓存。探针里相同只读调用执行 2 次。应共享进行中的 promise，失败后移除。
- **缺少工具总调用数及并发上限（设计缺口）：** maxIterations 限制模型轮次，不能限制一轮的工具数量；parallelSafe 批次直接 Promise.all。需单次调用上限、全局/每用户并发预算和重复失败停止规则。
- **DNS 检查与连接分离（已知静态风险）：** web_fetch 注释已记录 DNS rebinding 的检查/使用时间差（`builtins.ts:405`）。本次未做网络攻击验证，应单独安排安全测试和连接地址固定。

## 建议的加固顺序

### 第一批：把工具执行变成可信边界

1. 执行期白名单，部署端不注册宿主工具；覆盖空白名单和未知工具名。
2. 完整 schema 校验；交互卡片对无效输入降级。
3. 写工具默认关闭自动重试；独立 attempt deadline；明确取消和未知结果语义。
4. web_fetch 全 body 的取消、字节限制；MCP signal 传递；宿主工具进程树管理。

### 第二批：保证每次 run 的结果可解释

1. provider 完整终止检测、finishReason 归一、非法参数恢复。
2. run supervisor 覆盖准备、压缩和收尾；终态持久化独立于 SSE 消费。
3. 重试 attempt 与可见文本、工具结果、消息存储一致。
4. compressor 选择、计量、trace 关联及上下文硬预算修正。

### 第三批：为更长或更昂贵的任务增加恢复能力

在 core 定义 RunStore/ToolExecutionStore 接口，在 server 实现 PostgreSQL/Redis 存储；为有副作用调用保存 runId、toolCallId、attempt、幂等键和 started/succeeded/failed/unknown_outcome 状态。长时间、不可取消或占 CPU 的工具交给隔离 worker；重启恢复先核对执行结果，再决定是否重试。

ReAct 继续负责“根据结果选择下一步”，执行器负责“是否允许、如何验证、何时停止、是否能重试”，run supervisor 负责“生命周期、预算和终态”。这能沿用现有 Agent 定义和业务工具，避免把权限与重试规则继续散落在循环内。

## 修复后的验收标准

| 场景 | 应满足的不变量 |
| --- | --- |
| 模型返回未授权工具 | execute 调用次数为 0，且不命中缓存返回敏感结果 |
| 嵌套非法输入 | 工具收到输入前拒绝；UI 不崩溃 |
| 写操作超时/断网 | 不盲目重试；无法确认的结果标记 unknown_outcome |
| 用户取消 | 合作式任务及时停止；无法停止的任务有可追踪终态，不能伪装已取消成功 |
| 模型流异常/截断 | 不被当作完整答案；无确认终止时不执行缓存中的工具调用 |
| 透明重试 | 用户可见、持久化和校验结果属于同一成功 attempt |
| 准备/压缩/保存失败 | run 终态可查询；已知 usage 有记录或可补偿 |
| 大参数/大量调用 | 不突破上下文、工具数量和并发预算 |
| 同名并行调用 | 每个 call id 对应自己的结果、span 和执行状态 |
| 进程重启 | 已产生副作用的调用不会因无状态重放而重复执行 |

## 本机复现材料

以下文件留在临时目录，可能被系统清理；其中 Vitest 文件需要放回原相对目录才能运行。它们是评估探针，不应直接加入正常回归套件；修复时应改为断言上述正确行为。

- ReAct 六项探针：`/private/tmp/lot-agent-react-review-probe.test.ts`，原目录 `packages/core/src/agent/`。
- 补充上下文探针：`/private/tmp/lot-agent-react-review-context-probe.test.ts`，原目录 `packages/core/src/agent/`。
- 集成/上下文三项探针：`/private/tmp/lot-agent-robustness-integration-probe.test.ts`，原目录 `packages/server/src/services/`。
- 工具执行脚本：`/private/tmp/lot-tools-review.mts`。
- 同步抛错脚本：`/private/tmp/lot-tools-sync-throw.mts`。
- AskUserCard 渲染脚本：`/private/tmp/lot-tools-ui-review.mts`。
- Provider 脚本：`/private/tmp/lot-agent-provider-audit.ts`。

工具脚本可用 `pnpm --filter @lot-agent/server exec node --import tsx/esm /private/tmp/lot-tools-review.mts` 运行；provider 脚本用 `pnpm --filter @lot-agent/server exec node --import tsx /private/tmp/lot-agent-provider-audit.ts`。
