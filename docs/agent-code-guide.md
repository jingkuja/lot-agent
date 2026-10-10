# Lot Agent 项目架构与代码导航

面向在本仓库进行功能开发、修复和重构的 Coding Agent。核对日期：2026-10-08；依据当前工作区代码，包含尚未提交的 PPT 改动，不代表线上已发布状态。本文是入口索引，具体行为以实现和对应测试为准。

路径约定：`core/`、`server/`、`web/` 分别简写 `packages/core/src/`、`packages/server/src/`、`packages/web/src/`；完整路径均相对仓库根目录。

## 1. 开始任务时先看什么

1. 阅读根目录 [AGENTS.md](../AGENTS.md)，用 `git status --short` 识别已有修改，保留用户正在进行的工作。
2. 根据下方功能索引定位前端入口、服务端路由和业务服务，再读相邻 `*.test.ts`，不要先通读整个仓库。
3. 涉及接口挂载看 [server/src/index.ts](../packages/server/src/index.ts)；涉及对象组装和聊天看 [agent-service.ts](../packages/server/src/services/agent-service.ts)；涉及运行命令看根 [package.json](../package.json)。
4. 历史说明中的“未实现”不能直接当作当前结论：正式迁移器、内置 RAG、数字员工、会话项目和 OCR 均已有代码。`README.md` 等历史文档中部分架构描述尚未同步，核对实现后再改。

## 2. 产品简介与功能边界

Lot Agent 是共用账号、模型网关和计费体系的 AI 内容与办公工作台。Web 和 Electron 提供完整工作台，小程序侧重图片、视频创作与作品管理。模型访问通过 TokenHub / New API 体系，使用所属用户的凭证。

| 功能域 | 当前能力 | 主要入口 |
| --- | --- | --- |
| 通用助手与 Agent 选择 | 流式聊天、模型选择、附件、工具调用、记忆、子 Agent 默认可用、九宫格选择与历史记录同步 | `Workspace.tsx`、`routes/agents.ts`、`agent-service.ts` |
| 图片 / 视频 | 按模型参数异步生成、任务恢复、结果预览与下载、作品分享 | `GenerationCard.tsx`、`routes/conversations.ts`、`generation/run-job.ts` |
| 营销影像 | 分步制作探店店铺介绍、主播宣传演讲，选择数字分身和视频背景 | `core/agents/definitions/marketing-video.ts`、`web/modules/marketing-video/` |
| 办公 | 文档导出、合同对比、PPT 大纲确认、生成与修改 | `server/tools/`、`server/ppt/`、`core/presentation/` |
| 数字员工 | 营销资料、客户画像、商机建议、客户获客、文案与素材生成 | `web/modules/digital-employee/`、`server/digital-employee/` |
| 个人知识库 | 资料 / 事实 / 素材管理、索引、混合检索、聊天引用、外部知识密钥 | `web/modules/knowledge/`、`server/knowledge/` |
| 数字分身 | 个人语音库 / 肖像库、麦克风录音、摄像头拍照、上传和视频参考素材选用 | `web/modules/digital-twin/`、`KnowledgePanel.tsx`、`InputBox.tsx` |
| 项目组织 | 会话项目创建、列表、会话归入项目 | `routes/conversations.ts`、迁移 `0031`；不等同完整项目协作系统 |
| 账号与积分 | 登录、注册、手机号 / 微信绑定、托管凭证、余额和充值记录 | `routes/auth.ts`、`routes/usage.ts`、`routes/recharge.ts` |

所有未隐藏的 Agent 默认可用，无需安装或卸载；`digital_employee` 保持独立产品入口。旧用户的安装记录仅用于保留排序，不再决定可用性。`copywriting` 定义仍隐藏，但数字员工业务已有文案能力，不能将二者混为一谈。合同对比依托 Agent 提示词、附件和文档工具。

尚需区分的边界：发布连接器及内容审核仍是 stub / 关键词实现；TTS、ASR 仍为占位提供器。小程序视频的声音、字幕等要求不代表已接入独立配音和后期合成。`core/agents/orchestration.ts` 已有 agent-as-tool 与 DAG 定义 / 校验，但不是完整的持久化多 Agent 工作流执行器。

## 3. 技术架构

TypeScript + pnpm workspace + ESM；Web 使用 React 19 / Vite，API 使用 Hono，桌面端使用 Electron。

```text
Web / Electron（复用 Web） / 微信小程序
                  │ HTTP、SSE、任务查询
                  ▼
Hono API：鉴权、参数校验、限流、用户归属
     ├─ AgentService → Core Agent → LLM / 工具 / 技能 / 记忆
     ├─ DigitalEmployeeService → 客户 / 营销 / 商机 / 获客
     ├─ KnowledgeService → 资料管理 / 检索 / 外部接入
     └─ 任务提交 → Redis + BullMQ
                         ├─ 普通 Worker：图片、视频、记忆提取、商机发现
                         └─ 知识 Worker：解析、OCR、embedding、索引发布

共享依赖：PostgreSQL（业务与 pgvector） · Redis（队列、缓存、会话记忆）
          本地文件存储 · TokenHub / New API（账号、模型、额度与支付）
```

| 包 / 目录 | 职责与边界 |
| --- | --- |
| [packages/core/src](../packages/core/src) | Agent 引擎、模型和工具接口、技能、上下文、记忆抽象、通用提供器。保持无 `pg` / `ioredis` 依赖；通过接口注入基础设施。 |
| [packages/server/src](../packages/server/src) | API、依赖组装、数据库、队列、计费、业务服务和文件生成。运行 API 与两个 Worker 入口。 |
| [packages/web/src](../packages/web/src) | 浏览器工作台、交互卡片、知识管理和数字员工 UI；不持有网关内部密钥。 |
| [packages/desktop/src](../packages/desktop/src) | Electron 主进程、preload、本地静态与反向代理、下载、通知、凭证存储。业务界面复用 Web。 |
| [packages/miniprogram/miniprogram](../packages/miniprogram/miniprogram) | 微信原生页面、登录、生成、轮询、作品分享与保存。共用服务端业务。 |
| [skills](../skills) | 产品运行时加载的 Markdown 技能，不是本次 Coding Agent 的开发任务文档。 |
| [config](../config) | 非秘密配置、模型目录、Agent 参数与 MCP 配置。环境变量覆盖行为看对应 loader，不假定所有模块都合并 `local.json`。 |

## 4. 关键运行链路

### 4.1 登录、模型与计费

`App.tsx / 小程序 session.ts → routes/auth.ts → tokenhub/client.ts → users + sessions`。

密码登录经 RSA 公钥加密后发送，服务端解密并向网关认证；另外有 Token 登录、手机登录、微信登录和绑定流程。非 DEBUG 的服务默认启用托管 New API 凭证，所需配置在 `AgentService` 构造函数校验，凭证加密实现见 `auth/secret-box.ts`。

模型列表由 `models/catalog.ts` 结合用户可用模型与本地目录生成；`models/provider-factory.ts` 按用户凭证和选定模型创建提供器。托管凭证不可用时不能静默改用平台 Key。LLM 调用计量见 `billing/metered-llm.ts`，额度和用量见 `billing/meter.ts`；知识 embedding 另有真实网关回执核对流程。

网页/桌面充值由 `routes/recharge.ts → tokenhub/client.ts` 调用 New API 原有支付流程。小程序通过 `pages/recharge/index.ts` 调用 `wx.requestVirtualPayment`；Agent 的 `payments/service.ts` 负责报价、订单持久化、微信查单、退款同步和发货，`payments/wechat-virtual.ts` 持有微信配置和签名逻辑，`payments/repository.ts` 实现数据库租约。`index.ts` 启动并停止后台补偿任务。New API 仅接收 HMAC 记账通知，原子生成小程序来源订单并对托管 Key 入账或回退，不保存微信配置。完整边界、配置和验收见 [微信虚拟支付](wechat-virtual-payment.md)。

### 4.2 聊天与工具

工作台通过 `SidebarAgentTabs.tsx` 显示当前 Agent，默认展示 3 个快捷选项；九宫格按钮下方标注“更多”，点击后展开全部可用助手，点击“收起”恢复 3 个选项；展开 / 关闭面板或重复选择当前 Agent 不改变对话。`Workspace.tsx` 统一当前 Agent、历史筛选及新建会话目标；切换到不同 Agent 且已有会话、运行中任务或草稿时，通过 `AgentSwitchDialog.tsx` 确认后进入目标 Agent 的新对话。已发送的历史保留，后台任务继续；未发送的文字和附件在确认后清空。聊天区域顶部固定显示当前 Agent，输入框不再重复提供选择条。`routes/agents.ts` 对所有可见定义返回 `installed: true`；旧安装接口幂等成功，卸载接口拒绝，隐藏 Agent 仍不公开。

```text
InputBox / ChatPanel → useChat → POST /api/conversations/:id/messages
  → 用户归属与会话运行租约
  → AgentService.streamAgentResponse（模型、附件、知识、技能、记忆）
  → Core Agent.run（LLM → ToolRegistry → 工具结果 → 后续推理）
  → sse-adapter → useChat / chat-reducer → MessageBubble / 交互卡片
  → message-repository + trace-recorder + usage 计量
```

`regenerate` 与发送消息共用会话运行租约，改聊天流程时需同时检查取消、失败收尾和历史持久化。`ask_user`、`propose_outline` 使用 `endsTurn: true` 结束本轮，让前端卡片接收用户回复。

ReAct 的运行控制见 [ReAct 运行状态与恢复](react-runtime.md)：`core/runtime/run-budget.ts` 统一推理、压缩及传输重试预算；`run-state.ts` 定义状态、执行日志接口和观测事件。服务端 `services/run-repository.ts` 将运行与工具步骤写入 `agent_runs / agent_steps`，执行前持久化意图，阻止未知写结果的自动重放。会话租约定期续租，消息写入和工具启动校验租约归属。`GET /api/conversations/:id/runs` 查询执行记录；前端 `RunRecoveryCard` 通过归属校验的操作核实接口处理未知结果，此接口不提供给模型。


技能由 `core/skills/loader.ts` 加载：Agent 作用域技能强制注入，触发词用于预取，其余通过索引与 `load_skill` 按需加载。新增垂直 Agent 必须显式配置工具白名单。

### 4.3 图片与视频异步生成

`POST /api/conversations/:id/generations → 校验 / 额度预检 → pending 消息与 task → BullMQ → workers/index.ts → generation/run-job.ts → 提供器 → 下载并存储资产 → 计量 / 状态更新`。

前端以消息中的 `taskId` 查询 `GET /api/tasks/:id`；刷新后可以恢复。生成缓存、失败状态、取消与下载重试都有独立语义。已有 `generation.redownload` 路径只重试产物下载，避免把下载失败直接变成再次收费生成。

数字分身可从工作台品牌区的“数字分身”直接打开，也可从知识面板侧栏进入；`KnowledgePanel.initialSection` 指定初始面板。`DigitalTwinPanel.tsx` 分别管理个人语音与肖像。复用知识管理的鉴权上传、原件读取、分页和删除，以 `digital-twin:voice` / `digital-twin:portrait` 标签和媒体类型筛选，无新增数据库表。`TwinCapture.tsx` 使用浏览器设备权限采集，录音经 `media.ts` 转为最长 15 秒的单声道 WAV，拍照输出 JPEG；关闭面板会释放设备。上传声音限 MP3/WAV、2–15 秒、15 MB，肖像限 JPG/PNG/WebP、20 MB，服务端沿用私有存储的归属、流式大小和文件签名校验。素材保存在私有库；视频输入框通过 `DigitalTwinPicker` 读取所选文件并加入既有 `video_reference_audio` / `video_reference_image` 上传链路，同时补充提示词，发送后按现有视频附件方式提供给模型。参考声音用于所选模型的视频生成，不提供独立的长片配音服务；真人肖像支持以所选模型为准。macOS 打包权限说明位于 `packages/desktop/electron-builder.yml`。

Kling 携带参考音频时，`generation/run-job.ts` 在缓存 / 视频任务恢复检查后调用 `generation/kling-voices.ts`：将样例转为公网 URL → `POST /v1/wand/kling/custom-voices` → 每 2.5 秒查询至 `succeed` → 取 `task_result.voices[].voice_id` 作为内部参考音色，提供器将其写入请求的 `metadata.voice_id`（两个音色时为 `metadata.voice_ids`），不向网关发送 `reference_audio`，并开启视频音频。New API 网关需把上述 metadata 转为腾讯 `contents` 中的 `type=voice` / `voice_id` 项。创建接口的 `task_id` 不作为音色 ID。非 Kling 模型沿用音频 URL。自动音色名称使用 20 字符以内的短名称。音色 HTTP / 业务错误保留脱敏后的 message、code、request_id 供排查，不丢弃 400 的具体原因。单次最多两个音色；音色失败、超时或取消会阻止视频提交。

`core/providers/kling-voices.ts` 定义音色 HTTP 协议和持久化接口；`generation/kling-voice-store.ts` 通过迁移 35 的 `generation_voice_tasks` 保存用户 / 视频任务 / 音频序号对应的外部请求 ID、音色任务 ID 和音色 ID。写请求前先保存外部请求 ID，未知创建结果仅查询，不重发 POST；凭证 / 来源指纹变化时拒绝复用。该记录只用于同一任务恢复，不跨视频任务缓存音色。Worker 通过 `generation/config.ts` 的 `loadKlingVoiceConfig` 读取独立服务端配置 `KLING_VOICE_BASE_URL`（默认 `https://tokenhub.tencentmaas.com/v1`）与 `KLING_VOICE_API_KEY`，不回退到 LLM、视频或用户推理 Key。客户端在基础地址后追加 `/wand/kling/custom-voices` 及查询路径；音色状态仍按用户 / 任务隔离，指纹绑定独立音色服务凭证。未配置 Key 时仅带参考声音的真实 Kling 任务报错；视频生成继续使用原有提供器配置，音频通过 `PUBLIC_BASE_URL` 对公网可读。Mock 视频不请求真实音色服务。协议依据：[腾讯 Kling 音色管理文档](https://cloud.tencent.com/document/product/1823/135742)。

营销影像使用独立的 `marketing_video` Agent（空工具白名单），由 `ChatPanel → MarketingVideoStudio` 展示九步向导：创作方向与文案、标题标签、数字分身、声音设置、视频背景、视频画面、BGM·字幕、视频封面、确认生成。`draft.ts` 组织探店 / 主播口播要求，将肖像、背景按顺序放入 `video_reference_image`，声音放入 `video_reference_audio`，封面放入 `video_first_frame`；提示词同步标注肖像、背景图片与音频的对应序号。背景支持预设、自定义描述和上传参考图；字幕、配乐及文字仍由视频模型生成。营销影像固定使用 `kling-video-v3-omni`，前端不提供模型选择，服务端也固定入队模型；三个分辨率档位显示为默认（720p）、高清（1080p）、超清（4K）。

文案生成复用鉴权计量的 `/api/video-drafts`。确认后 `Workspace` 创建 `marketing_video` 会话并保存 `videoPublication`，经 `useChat.generateMedia` 进入现有异步视频任务链路；结果使用 `GenerationCard` 预览、下载、取消和重试下载，返回历史可恢复任务。生成期间和结果页不提供重复生成按钮，新视频通过新会话开始；服务端与小程序共用会话租约及已有任务回放，同一会话不重复入队；未发送草稿切换时沿用 Agent 切换确认。发布标题 / 标签独立保存在会话元数据，可在结果页复制，不混入生成提示词。

### 4.4 文档与 PPT

普通文档：`generate_document → doc-generator.ts → docx / pdf / md / html → data/documents`。

PPT 当前工作区链路：`propose_outline → OutlineCard → 确认协议 → ppt-confirmation.ts / AgentService → ppt-tool.ts → renderer / template-renderer → PPTX + 可选缩略图 → PptArtifactCard`。共享 schema、文稿与容量规则位于 `@lot-agent/core/presentation`。预览依赖 LibreOffice 和 `pdftoppm`；不可用时仍可下载 PPTX。详见 [PPT 工作流](ppt-workflow.md)。

### 4.5 内置知识库

写入：`/api/rag/manage → repository + private-storage → revision / outbox → 知识队列 → workers/knowledge.ts → 解析 / OCR / embedding → checkpoint → 原子发布索引`。

读取：`聊天选择知识范围 → local-service.ts → retrieval.ts → 关键词 / 元数据 / 向量 + RRF → 主命中与相邻上下文 → knowledge-context.ts → 带版本和定位的引用 → KnowledgeSources / SourcePreview`。

配置中的 `knowledge.source` 当前为 `local`，管理、入库、外部访问还有独立开关。图片和扫描 PDF 已接入 `ingestion/ocr.ts`；音视频内容识别仍未接入。知识资料原件在 `data/knowledge`，通过鉴权或短期预览票据读取，不挂到公开静态目录。

外部 `/api/rag/v1` 使用独立知识密钥、按库授权和限流，不能复用登录令牌替代。`docs/knowledge-openapi.json` 被契约测试直接读取，变更接口时需要同步它。

### 4.6 数字员工

`ProductShell / Workspace / DigitalEmployeeLayout → /api/digital-employee 或聊天入口 → digital-employee/services + tools → repositories / jobs / 用户模型`。

数字员工共享 `digital_employee` Agent，通过 `featureScope` 区分 `marketing-materials`、`customer-profile`、`opportunity-advisor`、`customer-acquisition`。工具与素材访问都需要遵守该作用域。修改画像时同时检查候选确认、摘要投影及后续营销 / 商机引用；修改获客生成时检查任务归属、配额和素材来源。

## 5. 基础代码索引

以下路径沿用开头的简写约定。文件名不带行号，避免代码移动导致索引失效。

| 要了解 / 修改的内容 | 优先阅读路径 |
| --- | --- |
| API 启动、路由挂载、定时调度 | `server/index.ts`、`server/load-env.ts`、`server/config.ts` |
| 产品外壳与页面切换 | `web/App.tsx`、`web/shell/ProductShell.tsx`、`web/pages/Workspace.tsx`；当前用 History API，不是 React Router |
| 请求、认证与流式状态 | `web/api/client.ts`、`web/hooks/useChat.ts`、`web/hooks/chat-reducer.ts`、`web/lib/token-store.ts` |
| 会话、项目、发送 / 再生成 | `server/routes/conversations.ts`、`server/db/database.ts`、`web/hooks/useConversations.ts`、`web/components/Sidebar.tsx` |
| Agent 定义、注册与默认可用性 | `core/agents/definitions/`、`core/agents/types.ts`、`server/services/agent-service.ts`、`server/agents/install-order.ts`、`server/routes/agents.ts` |
| ReAct、模型终态、上下文 | `core/agent/agent.ts`、`core/llm/`、`core/context/context-manager.ts` |
| 工具权限、schema、重试 / 取消 | `core/tools/registry.ts`、`core/tools/validate.ts`、`core/runtime/abort.ts` |
| 网页搜索、网络访问、宿主工具 | `core/tools/builtins.ts`、`core/tools/net-fetch.ts`、`core/tools/net-guard.ts`、`core/tools/process.ts` |
| 技能与 MCP 接入 | `core/skills/`、`core/mcp/`、`skills/`、`config/mcp-servers.json` |
| 消息、SSE、链路追踪 | `server/services/message-repository.ts`、`server/services/sse-adapter.ts`、`server/services/trace-recorder.ts` |
| 附件上传与文本提取 | `server/routes/uploads.ts`、`server/services/attachment-extractor.ts`、`web/components/InputBox.tsx` |
| 模型目录与生成适配 | `server/models/catalog.ts`、`server/models/provider-factory.ts`、`server/generation/config.ts`、`core/providers/` |
| 任务、Worker 与缓存 | `server/jobs/bullmq-queue.ts`、`server/jobs/persisted-job.ts`、`server/workers/index.ts`、`server/generation/run-job.ts`、`server/billing/gen-cache.ts` |
| 文档 / PPT 工具与结果 | `server/tools/`、`server/ppt/`、`core/presentation/`、`web/components/OutlineCard.tsx`、`web/components/PptArtifactCard.tsx` |
| 登录、微信、托管凭证 | `server/routes/auth.ts`、`server/auth/`、`server/tokenhub/client.ts`、`server/db/user-sanitize.ts` |
| 积分、计量、充值 | `server/billing/`、`core/billing/cost.ts`、`server/routes/usage.ts`、`server/routes/recharge.ts`、`web/components/PointsBalance.tsx` |
| 会话与用户记忆 | `core/memory/`、`server/memory/redis-session-backend.ts`、`server/workers/index.ts` 的 `memory.extract` |
| 知识管理 / 原件 / 外部 API | `server/knowledge/routes.ts`、`server/knowledge/repository.ts`、`server/knowledge/private-storage.ts`、`server/knowledge/access/` |
| 知识解析 / OCR / 索引 / 计费回执 | `server/knowledge/ingestion/`、`server/workers/knowledge.ts`、`server/workers/knowledge-parser.ts` |
| 知识召回 / 聊天引用 / 个人事实 | `server/knowledge/retrieval.ts`、`server/knowledge/retrieval-query.ts`、`server/services/knowledge-context.ts`、`server/knowledge/profile/`、`web/modules/knowledge/` |
| 数字员工画像 / 营销 / 商机 / 获客 | `server/digital-employee/routes.ts`、`service.ts`、`marketing-service.ts`、`opportunity-service.ts`、`acquisition-service.ts`、`tools/`；上述后六项均位于 `server/digital-employee/` |
| 数字员工前端 | `web/modules/digital-employee/` 下的 `profiles/`、`marketing/`、`opportunities/`、`acquisition/` |
| 作品访问与分享撤销 | `server/routes/assets.ts`、`server/routes/image-shares.ts`；文件名仍叫 image-shares，但需同时核对视频使用方 |
| 主题与语言 | `web/App.css`、`web/hooks/useTheme.ts`、`web/i18n/messages.ts`、`web/i18n/index.tsx` |

其他客户端入口：

- 桌面：`packages/desktop/src/main/index.ts` 启动；`main/local-server.ts` 静态与代理；`main/ipc.ts` 与 `preload/index.ts` 定义桥接；`main/secure-token.ts` 存储凭证。
- 小程序：`packages/miniprogram/miniprogram/app.json` 页面 / 导航；`services/api.ts` 请求；`services/session.ts` 登录；`services/generate.ts`、`services/video.ts` 创作；`pages/studio/`、`pages/video/`、`pages/gallery/`、`pages/mine/` 为主入口。

## 6. 数据与接口定位

### 数据库

正式迁移在 [db/migrations](../packages/server/src/db/migrations)，由 [migration-runner.ts](../packages/server/src/db/migration-runner.ts) 使用 advisory lock 和逐迁移事务执行，版本与名称写入 `schema_migrations`；同号异名会在执行迁移前报错。当前最新为 `0034-agent-run-state.ts`（已有数据库的版本 32 属于 `comic-drama`）。只有 server 负责迁移，Worker 使用已有 schema；知识 Worker 检查迁移 30 就绪。

运行日志新增 `agent_runs / agent_steps`，结果核实保留原始回执；普通模型会话与媒体生成任务状态互不替代。

新增表 / 字段应追加迁移文件并在 `migrations/index.ts` 注册，不能只修改历史迁移或依赖手工 SQL。普通业务查询集中在 `db/database.ts`；数字员工和知识库有自己的 repository。PG `NUMERIC` 返回字符串，计算前显式转换。

主要数据域：账号 `users / sessions`；聊天 `conversations / messages / message_tool_calls`；运行 `traces / spans / tasks`；资产 `assets`；支付 `virtual_payment_orders`；计量 `usage_logs`；Agent 安装 `user_agents`；知识表以 `rag_` 为主。数字员工与项目表的准确字段通过对应迁移和 repository 查找，不从旧表格复制。

### HTTP 与文件

| 路由组 | 定位方式 / 认证 |
| --- | --- |
| `/api/auth` | `routes/auth.ts`；登录等为公开入口，资料修改 / 绑定等在处理器内校验身份 |
| `/api/conversations` | 聊天、项目、知识范围、生成与再生成；会话认证和资源归属 |
| `/api/agents`、`/api/models` | Agent 目录与模型目录；会话认证 |
| `/api/tasks`、`/api/assets`、`/api/uploads` | 异步任务、产物、附件；会话认证和资源归属 |
| `/api/usage`、`/api/balance`、`/api/recharge` | 用量、余额、充值；会话认证 |
| `/api/digital-employee` | 数字员工业务；会话认证、归属和功能作用域 |
| `/api/knowledge-bases`、`/api/rag/manage` | 聊天选库兼容入口、内置知识管理；会话认证 |
| `/api/rag/v1`、`/api/rag/preview` | 分别使用外部知识密钥、短期票据；后者还检查原会话和资料有效性 |
| `/api/public/product`、`/api/public/shares` | 产品信息、显式发布的作品分享；不是私人会话访问入口 |
| `/health`、`/static/{assets,documents,uploads}` | 健康检查与静态产物；不要把知识原件或密钥存入这些静态路径 |

完整挂载及限流以 `server/index.ts` 为准，具体参数以路由 schema / 验证器为准。

## 7. 常见改动的最短路径

| 需求 | 建议改动顺序与检查点 |
| --- | --- |
| 新增 Agent | definition → 导出 / 注册 → 工具白名单 → 可见性 → 前端九宫格选择和图标 → 权限及目录测试 |
| 新增工具 / 交互卡片 | core 契约或 server 工具 → 注册与 Agent 白名单 → SSE / 持久化 → 前端解析与卡片；等待回复使用 `endsTurn` |
| 新增模型 / 参数 | 目录和 provider 映射 → 服务端输入 → 提供器请求 → 前端设置 → 缓存键 / 计量；不要只加模型选择项 |
| 改聊天行为 | `useChat` + reducer → 会话路由 → `AgentService` / core → 消息与 trace；覆盖刷新、取消、失败、再生成 |
| 改知识检索 | `retrieval-query.ts` / `retrieval.ts` → owner / scope / revision 条件 → 引用 UI → 检索回归；改变分段 / 模型需新 profile 和重建流程 |
| 改数字员工业务 | featureScope → 服务 / repository / 工具 → 管理页面和聊天入口；同时检查个人与企业素材隔离 |
| 改数据库 | 新迁移 → 注册 → repository / 类型 → 新旧数据兼容测试；Worker 在迁移就绪后消费 |
| 改 PPT | 共享 schema / deck → 工具 → 布局与容量 → 确认和结果卡 → 样例视觉检查；共享导出要同步 package exports / tsup |
| 改小程序生成 | 页面 → services → 共用生成 API / Worker；覆盖重复点击、响应丢失、离开恢复、账号切换和分享撤销 |

必须保持的行为：用户归属由服务端认证决定；模型凭证与计量跟随用户；共享单例不能保存请求用户的模型或记忆状态；工具执行时检查白名单与完整 schema；写工具不盲目自动重试；网络访问保留 SSRF、防重定向绕过、取消和大小限制。部署端不注册宿主文件 / shell 工具。

代码使用 2 空格缩进、ESM import 的 `.js` 后缀。Web 颜色使用现有 CSS 变量，并检查暗色主题与中英文文案。浏览器侧共享类型优先用 `@lot-agent/core/knowledge`、`@lot-agent/core/presentation` 等专用入口，避免引入服务端依赖。

## 8. 运行与验证

命令从仓库根目录运行；pnpm 版本按 `package.json` 的 `packageManager`，当前为 `10.33.0`。依赖配置参考 [.env.example](../.env.example)，不要将实际密钥写进文档或 Git。

```bash
pnpm install --frozen-lockfile
pnpm --filter @lot-agent/core build
pnpm dev                    # core watch + API + 普通 Worker + 知识 Worker + Web
pnpm dev:server
pnpm dev:web
pnpm --filter @lot-agent/server dev:worker
pnpm dev:knowledge
pnpm dev:desktop             # Web + Electron；后端需另行运行
```

API 默认 3000；Vite 默认 5173，代理 `/api` 和 `/static` 到 API。需要 PostgreSQL / Redis；知识索引还需要 pgvector 和知识开关。新环境启动消费者前确认 server 迁移完成。

```bash
# 按实际改动选择测试范围；新纯逻辑按仓库约定先写 Vitest 测试
pnpm exec vitest run packages/core/src/tools/registry.test.ts
pnpm test:knowledge
pnpm check:agent-navigation:ui # 需 Playwright 和 Chrome；模拟接口检查 Agent 切换、确认与历史隔离
pnpm check:marketing-video:ui # 模拟接口验证九步创作、素材、提交、任务恢复、中英文和暗色界面
pnpm check:digital-twin:ui    # 需 Playwright（可用 PLAYWRIGHT_MODULE 指定路径）和 Chrome；模拟设备及 HTTP 数据，无付费调用
pnpm --filter @lot-agent/web build
pnpm --filter @lot-agent/miniprogram build  # 类型检查，真机行为另验
pnpm test
pnpm build
```

测试一般与实现同目录，命名 `*.test.ts`。构建 / 测试通过不自动代表数据库集成、真实模型、浏览器或微信真机验收通过；报告实际运行范围。知识库集成脚本及真实付费验证分别见根 `package.json` 与专项手册，运行前读取参数和数据清理范围。纯文档修改只需核对路径、命令与内容，不必启动业务或调用付费模型。

## 9. 专项文档

- 部署与客户端：[部署](deployment.md)、[桌面端](desktop.md)、[小程序](miniprogram.md)、[充值](recharge.md)。
- 办公：[PPT 工作流](ppt-workflow.md)、[PPT 技能](../skills/ppt-authoring.md)、[文档技能](../skills/doc-generation.md)。
- 知识库：[入库与检索](knowledge-ingestion.md)、[外部 API](knowledge-external-api.md)、[OpenAPI 契约](knowledge-openapi.json)、[备份恢复](knowledge-backup-restore.md)、[检索优化](knowledge-retrieval-optimization.md)。

部分专项手册混有阶段历史，例如 schema 29、尚无 OCR、没有后台账单核对等说法已落后于实现。按本文代码入口核对后使用。功能入口、数据流或迁移方式改变时同步维护本索引；无需在这里复制完整 API schema 或测试结果日志。
