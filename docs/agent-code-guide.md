# Lot Agent 项目架构与代码导航

面向在本仓库进行功能开发、修复和重构的 Coding Agent。文档整理日期：2026-10-17；依据当前工作区代码，不代表线上已发布状态。本文是入口索引，具体行为以实现和对应测试为准。

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
| 营销影像 | 三步制作营销短视频：文案与分镜、数字分身与背景素材、配音字幕与生成 | `core/agents/definitions/marketing-video.ts`、`web/modules/marketing-video/` |
| 办公 | 文档导出、合同对比、PPT 大纲确认、生成与修改 | `server/tools/`、`server/ppt/`、`core/presentation/` |
| 数字员工 | 营销资料、客户画像、商机建议、客户获客、文案与素材生成 | `web/modules/digital-employee/`、`server/digital-employee/` |
| 个人知识库 | 资料 / 事实 / 素材管理、索引、混合检索、聊天引用、外部知识密钥 | `web/modules/knowledge/`、`server/knowledge/` |
| 数字主播 | 数字分身原声配音 + 以图（`wan2.2-s2v`）或以视频（`videoretalk`）生成口播视频 | `core/digital-presenter/`、`server/digital-presenter/`、`web/modules/digital-presenter/` |
| 数字分身 | 个人语音库 / 肖像库、麦克风录音、摄像头拍照、上传和视频参考素材选用 | `web/modules/digital-twin/`、`KnowledgePanel.tsx`、`InputBox.tsx` |
| 项目组织 | 会话项目创建、列表、会话归入项目 | `routes/conversations.ts`、迁移 `0031`；不等同完整项目协作系统 |
| 账号与积分 | 登录、注册、手机号 / 微信绑定、托管凭证、余额和充值记录 | `routes/auth.ts`、`routes/usage.ts`、`routes/recharge.ts` |

所有未隐藏的 Agent 默认可用，无需安装或卸载；`digital_employee` 保持独立产品入口。旧用户的安装记录仅用于保留排序，不再决定可用性。`copywriting` 定义仍隐藏，但数字员工业务已有文案能力，不能将二者混为一谈。合同对比依托 Agent 提示词、附件和文档工具。

尚需区分的边界：通用发布连接器及内容审核仍是 stub / 关键词实现；营销影像另有文案与分镜风险检查，结合风险词规则表及平台规则进行模型审核。通用 TTS、ASR 接口仍保留占位提供器；参考视频分析已独立接入可选 Qwen ASR。小程序视频的声音、字幕等要求不代表已接入独立配音和后期合成。`core/agents/orchestration.ts` 已有 agent-as-tool 与 DAG 定义 / 校验，但不是完整的持久化多 Agent 工作流执行器。

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
                         ├─ 普通 Worker 进程：普通任务与营销制作使用独立队列
                         ├─ 知识 Worker：解析、OCR、embedding、索引发布
                         └─ 媒体分析 Worker：受控下载、抽帧、OCR、有序多图摘要

共享依赖：PostgreSQL（业务与 pgvector） · Redis（队列、缓存、会话记忆）
          本地文件存储 · TokenHub / New API（账号、模型、额度与支付）
```

| 包 / 目录 | 职责与边界 |
| --- | --- |
| [packages/core/src](../packages/core/src) | Agent 引擎、模型和工具接口、技能、上下文、记忆抽象、通用提供器。保持无 `pg` / `ioredis` 依赖；通过接口注入基础设施。 |
| [packages/server/src](../packages/server/src) | API、依赖组装、数据库、队列、计费、业务服务和文件生成。运行 API 与普通、知识、媒体分析 Worker 入口。 |
| [packages/web/src](../packages/web/src) | 浏览器工作台、交互卡片、知识管理和数字员工 UI；不持有网关内部密钥。 |
| [packages/desktop/src](../packages/desktop/src) | Electron 主进程、preload、本地静态与反向代理、下载、通知、凭证存储、本地工作目录授权与本机工具执行。业务界面复用 Web。 |
| [packages/miniprogram/miniprogram](../packages/miniprogram/miniprogram) | 微信原生页面、登录、生成、轮询、作品分享与保存。共用服务端业务。 |
| [skills](../skills) | 产品运行时加载的 Markdown 技能，不是本次 Coding Agent 的开发任务文档。 |
| [config](../config) | 非秘密配置、模型目录、Agent 参数与 MCP 配置。环境变量覆盖行为看对应 loader，不假定所有模块都合并 `local.json`。 |

## 4. 关键运行链路

### 4.1 登录、模型与计费

`App.tsx / 小程序 session.ts → routes/auth.ts → tokenhub/client.ts → users + sessions`。

Web 与桌面登录页 `web/components/Login.tsx` 在登录前提供“用户协议 / 隐私政策”，与账号菜单共用 `web/components/LegalModal.tsx` 的现有正文。

密码登录经 RSA 公钥加密后发送，服务端解密并向网关认证；另外有 Token 登录、手机登录、微信登录和绑定流程。非 DEBUG 的服务默认启用托管 New API 凭证，所需配置在 `AgentService` 构造函数校验，凭证加密实现见 `auth/secret-box.ts`。

“积分不足时使用灵渠 AI 余额”保存在 New API 的 `managed_api_keys.allow_balance_fallback`，新托管 Key 默认开启；小程序注册、Agent 注册和中转站账号首次进入 Agent 均由 New API 的 `model/managed_api_key.go → ensureManagedCredentialTx` 统一创建，后续登录保留用户手动关闭的选择。老账号统一开启使用 New API 仓库的 `scripts/enable-agent-balance-fallback.sql`，在中转站数据库手动执行。

模型列表由 `models/catalog.ts` 结合用户可用模型与本地目录生成；LLM 列表优先展示 `deepseek-v4.1-flash`，其余非 Claude 模型保持原顺序、Claude 排末尾。用户未选择时默认使用列表首项，已有会话或显式选择优先；配置和文字类 Agent 默认模型同为 `deepseek-v4.1-flash`。`models/provider-factory.ts` 按用户凭证和选定模型创建提供器。托管凭证不可用时不能静默改用平台 Key。LLM 调用计量见 `billing/metered-llm.ts`，额度和用量见 `billing/meter.ts`；知识 embedding 另有真实网关回执核对流程。

网页/桌面充值由 `routes/recharge.ts → tokenhub/client.ts` 调用 New API 原有支付流程。小程序通过 `pages/recharge/index.ts` 调用 `wx.requestVirtualPayment`；Agent 的 `payments/service.ts` 负责报价、订单持久化、微信查单、退款同步和发货，`payments/wechat-virtual.ts` 持有微信配置和签名逻辑，`payments/repository.ts` 实现数据库租约。`index.ts` 启动并停止后台补偿任务。New API 仅接收 HMAC 记账通知，原子生成小程序来源订单并对托管 Key 入账或回退，不保存微信配置。完整边界、配置和验收见 [微信虚拟支付](wechat-virtual-payment.md)。

### 4.2 聊天与工具

侧栏顶部 `BrandHeader.tsx` 一行放 logo、产品名、账号头像和收起按钮；点击头像打开 `AccountMenu.tsx`（显示名称与账号，并包含飞书接入、充值、文件管理、“积分不足时使用灵渠 AI 余额”开关，国际模式下还有语言选择），积分卡只保留余额与充值。工作台通过 `SidebarAgentTabs.tsx` 显示当前 Agent，默认展示两行三列、最多 6 个快捷选项；通用助手固定第一、营销影像固定第二，其余沿用历史排序；仅超过 6 个时显示九宫格“更多”按钮，点击后展开全部可用助手并允许滚动，点击“收起”恢复 6 个选项；展开 / 关闭面板或重复选择当前 Agent 不改变对话。`Workspace.tsx` 统一当前 Agent、历史筛选及新建会话目标；切换到不同 Agent 且已有会话、运行中任务或草稿时，通过 `AgentSwitchDialog.tsx` 确认后进入目标 Agent 的新对话。已发送的历史保留，后台任务继续；未发送的文字和附件在确认后清空。聊天区域顶部固定显示当前 Agent，输入框不再重复提供选择条。`routes/agents.ts` 对所有可见定义返回 `installed: true`；旧安装接口幂等成功，卸载接口拒绝，隐藏 Agent 仍不公开。

```text
InputBox / ChatPanel → useChat → POST /api/conversations/:id/messages
  → 用户归属与会话运行租约
  → AgentService.streamAgentResponse（模型、附件、知识、技能、记忆）
  → Core Agent.run（LLM → ToolRegistry → 工具结果 → 后续推理）
  → sse-adapter → useChat / chat-reducer → MessageBubble / 交互卡片
  → message-repository + trace-recorder + usage 计量
```

`regenerate` 与发送消息共用会话运行租约，改聊天流程时需同时检查取消、失败收尾和历史持久化。`ask_user`、`propose_outline` 使用 `endsTurn: true` 结束本轮，让前端卡片接收用户回复。

`core/llm/responses.ts` 先校验并保留首个完整 Responses 终态，再等待正常 EOF（独立上限 1 秒），避免提前退出 SDK 导致网关记录 `client_gone`。尾部 reset、取消或超时不丢弃已验证结果，也不重复输出；缺失或不合法终态仍失败。Agent 在启动工具前继续检查取消。

ReAct 的运行控制见 [ReAct 运行状态与恢复](react-runtime.md)：`core/runtime/run-budget.ts` 统一推理、压缩及传输重试预算；`run-state.ts` 定义状态、执行日志接口和观测事件。服务端 `services/run-repository.ts` 将运行与工具步骤写入 `agent_runs / agent_steps`，执行前持久化意图，阻止未知写结果的自动重放。会话租约定期续租，消息写入和工具启动校验租约归属。`GET /api/conversations/:id/runs` 查询执行记录；前端 `RunRecoveryCard` 通过归属校验的操作核实接口处理未知结果，此接口不提供给模型。


技能由 `core/skills/loader.ts` 加载：Agent 作用域技能强制注入，触发词用于预取，其余通过索引与 `load_skill` 按需加载。新增垂直 Agent 必须显式配置工具白名单。

### 4.3 图片与视频异步生成

参考视频语音识别由 `server/marketing-analysis/speech.ts` 接入固定 `qwen-audio-3.1-asr-flash`，`runtime.ts` 按当前用户模型目录的 `llm/asr/audio` 分组判断是否可用；缺失时跳过并由 `ReferenceAnalysisPanel.tsx` 提示；参考输入框上方用单选在“粘贴链接或文案”（默认，链接与文案由 `marketingSourceKind` 自动识别）和“上传本地爆款视频”之间切换，补充创作要求默认展开，时长默认 30 秒且仅保留滑块。隔离解码为 16 kHz 单声道 WAV，通过 `audio-url.ts` 生成基于 `PUBLIC_BASE_URL` 的十分钟加密访问链接，调用网关 `/chat/completions` 的 `input.messages` / `parameters` 协议，复用持久化调用回执与取消保护；180 秒总期限约束请求与正文，未知结果禁止重发。转写进入摘要与文案，`a0001` 仅为无时间戳的原声证据，不用于时间线。OCR 缺口、下载文件无音轨及空转写在主结果旁可见，均不将未识别等同原片无声音。公网 URL 检查见 `scripts/check-marketing-analysis-audio-url.ts`，真实素材 `download/speech/analyze` 探测见 `scripts/check-marketing-analysis-local.ts`；[真实验收范围](marketing-video-reference-analysis.md#真实验收范围)区分本机 ASR、单台 Linux 服务器和待完成的批量验收。

`POST /api/conversations/:id/generations → 校验 / 额度预检 → pending 消息与 task → BullMQ → workers/index.ts → generation/run-job.ts → 提供器 → 下载并存储资产 → 计量 / 状态更新`。

前端以消息中的 `taskId` 查询 `GET /api/tasks/:id`；刷新后可以恢复。`grok-imagine-video-1.5` 在视频选择器显示为「spacebunny」（`visibleVideoModels`），请求仍发送真实模型 ID；限制定义在 `core/providers/video-generation.ts` 的 `grokVideoInputIssue`，由 `generation/input.ts → grokVideoIssue` 在会话生成和 `/api/tasks` 入口校验：参考视频最多 1 段、单次最长 8 秒且不能与参考图、首尾帧、参考音频同用（输入框时长选项同步收窄），参考音频最多 3 段，带参考图或参考视频时最高 720p。获客宝暂不提供该模型：`digital-employee/acquisition-service.ts → campaignVideoModels` 从可选视频模型中过滤，服务端 `resolveCampaignModel` 也会拒绝。生成缓存、失败状态、取消与下载重试都有独立语义。已有 `generation.redownload` 路径只重试产物下载，避免把下载失败直接变成再次收费生成。

数字分身可从工作台品牌区的“数字分身”直接打开，也可从知识面板侧栏进入；`KnowledgePanel.initialSection` 指定初始面板。`DigitalTwinPanel.tsx` 分别管理个人语音与肖像。复用知识管理的鉴权上传、原件读取、分页和删除，以 `digital-twin:voice` / `digital-twin:portrait` 标签和媒体类型筛选，无新增数据库表。`TwinCapture.tsx` 使用浏览器设备权限采集，录音经 `media.ts` 转为最长 15 秒的单声道 WAV，拍照输出 JPEG；关闭面板会释放设备。上传声音限 MP3/WAV、2–15 秒、15 MB，肖像限 JPG/PNG/WebP、20 MB，服务端沿用私有存储的归属、流式大小和文件签名校验。素材保存在私有库；视频输入框通过 `DigitalTwinPicker` 读取所选文件并加入既有 `video_reference_audio` / `video_reference_image` 上传链路，同时补充提示词，发送后按现有视频附件方式提供给模型。参考声音用于所选模型的视频生成，不提供独立的长片配音服务；真人肖像支持以所选模型为准。macOS 打包权限说明位于 `packages/desktop/electron-builder.yml`。

数字分身声音样例保存后，`TwinCapture.tsx → POST /api/rag/manage/items/:id/voice → digital-twin/voices.ts` 调用千问 `voice-enrollment/create_voice`，将音色 ID、目标模型及审核状态存入迁移 52 的 `digital_twin_voices`；旧样例通过 `VoiceEnrollment.tsx` 的“复刻声音”按钮接入。`GET` 同一路径只读取本地记录，“刷新音色状态”再次 `POST` 时仅查询已记录的音色 ID，未知创建结果（网络中断、408 / 5xx、格式异常的成功响应）按持久化随机前缀查询列表，不重发创建请求；千问明确拒绝（其余 4xx，或 2xx 中带错误码）时 `store.release` 删除该条未得到音色 ID 的记录，用户可用新前缀重新复刻。原件、类型、时长、公网地址和登录会话在持久化创建意图前校验；样例复用知识库绑定原用户会话的五分钟预览链接。服务端独立配置为 `QWEN_VOICE_BASE_URL`（默认 `https://maas.qianwenaiapi.com/api/v1`）、`QWEN_VOICE_API_KEY`、`QWEN_VOICE_TARGET_MODEL`（默认 `qwen-audio-3.0-tts-plus`），并要求供应商可访问的 `PUBLIC_BASE_URL`，不回退到其他模型密钥。`core/providers/qwen-voices.ts` 定义协议及存储接口，`digital-twin/voice-store.ts` 实现按用户 / 原件版本隔离的数据库存储。创建返回后先保存音色 ID，审核状态经刷新查询为 `DEPLOYING / OK / UNDEPLOYED`；查询结果为空时继续保留待核实状态；认领超过 2 分钟（`UNCONFIRMED_CREATE_RELEASE_MS`，创建请求期限为 30 秒）仍查不到时，`store.release` 按 `created_at` 删除该记录并返回 409，用户可重新复刻，避免千问 5xx 后永久卡在待核实。录音转 WAV 前 `media.ts → assertAudible` 拒绝峰值低于 -40 dBFS 的静音录音。切换密钥、地址或目标模型会阻止复用旧记录；删除本地样例后不再暴露其音色记录，供应商音色未自动删除。音色就绪后，`VoiceEnrollment.tsx` 提供配音试听：`POST /api/rag/manage/items/:id/voice/speech`（文案 ≤500 字、可选语气 ≤200 字、按生成类限流）→ `TwinVoices.speak` 仅从本地记录取音色 ID 和其绑定的目标模型，用当前用户的 New API Key 调用 `OPENAI_BASE_URL/audio/speech`（`core/providers/tts.ts` 的 `OpenAISpeechProvider`），费用由网关账号承担，Agent 不单独计费；无用户 Key 时不回退到环境密钥，合成请求不重试。网关阿里渠道需提供 `qwen-audio-3.0-tts-plus`，且与 `QWEN_VOICE_API_KEY` 属于同一千问账号，否则音色 ID 不可用。视频生成仍沿用既有参考音频路径，千问音色不写入 Kling metadata；营销视频整段配音、字幕与对口型见 [配音方案](marketing-video-audio-subtitle-plan-20261020.md)。协议依据：[千问声音复刻 HTTP API](https://platform.qianwenai.com/docs/api-reference/speech-synthesis/voice-cloning/http-api)。

数字主播使用独立的 `digital_presenter` Agent（空工具白名单，固定排在营销影像之后），`ChatPanel → web/modules/digital-presenter/DigitalPresenterStudio` 提供三步：口播文案（`/script` 用用户凭证的 `kimi-k3` 写稿，`/review` 把口播当作营销草稿的 `script` 复用 `marketing-video/compliance.ts` 的风险表与模型审核；两者均 `upstreamBilling`）、形象与声音（以图：数字分身肖像或上传；以视频：口播底片 + 可选目标人脸；素材以 `purpose=marketing-video` 私有上传；音色只能选已复刻的数字分身声音；需勾选授权确认）、配音与生成。`core/digital-presenter` 的 `planPresenterSegments` 按句把文案分成约 12 秒的段（单句超 15 秒要求拆句，最多 12 段）；`server/digital-presenter/takes.ts → PresenterVoicer` 逐段用 `TwinVoices.speakAs` 合成 WAV，先写 `digital_presenter_takes` 意图行、不自动重发，键覆盖音色、语速、语气和文本。`POST /:id/generate` 冻结各段配音，检查以图每段 < 19.5 秒且总长 ≤ 90 秒、以视频总长 2.2–118 秒且底片不短于配音，在一个事务中写入 `digital-presenter.video` 父任务（走 `lot-marketing-video` 长任务队列）和 `digital_presenter_clips`。`run.ts` 先在 `data/digital-presenter/<草稿>/jobs/<任务>/` 一次性准备输入（肖像按比例裁成 720 短边、底片裁到配音长度并转静音 H.264、配音按 0.25 秒停顿拼成母带），用 `signPresenterFile` 签发 3 小时、绑定内容哈希的公网链接，片段先记 `submitting` 再提交：明确拒绝记 `failed` 可重试，其余未知结果停止并须用户 `/unknown-clips/release` 确认；`/resume` 继续轮询已知供应商任务、只重提失败片段。下载结果后由 `media.ts` 合成：以图每段用本段配音替换音轨、段间定格 0.25 秒并隔段轻微推近；以视频用本地母带替换音轨。视频调用经 `OpenaiVideoAdapter` 的人像模型分支（不发 prompt，`seconds` 只用于网关预扣，VideoRetalk 固定 `video_extension=false`），用户 Key 由网关计费，本地不计量。迁移 56 建三张表；方案与验收见 [数字主播方案](digital-presenter-plan-20261021.md)。

声音复刻排障：`core/providers/qwen-voices.ts` 的 `QwenVoiceError` 仅保留白名单内的上游错误码及经过校验的请求 ID；`digital-twin/voice-errors.ts` 区分鉴权、额度、限流、样例下载、音频处理与未知拒绝，不再将所有 4xx 提示为样例问题。`knowledge/routes.ts` 在返回错误前向 server 标准错误输出 `[digital-twin] voice enrollment failed` 单行 JSON，包含 `itemId`、`phase`、`code`、`httpStatus`、`vendorCode`、`upstreamRequestId`、`outcome`，以及与响应 `request_id` 一致的本地 `requestId`。部署后通过 `docker compose logs --since=30m server | rg "voice enrollment failed"` 查询；这条同步调用不经过 Worker。未知上游错误码和原始 message 不记录，避免密钥、音频预览票据或用户内容泄露；缺失的历史日志无法补回，必要时用上游请求 ID 核查。

Kling 携带参考音频时，`generation/run-job.ts` 在缓存 / 视频任务恢复检查后调用 `generation/kling-voices.ts`：将样例转为公网 URL → `POST /v1/wand/kling/custom-voices` → 每 2.5 秒查询至 `succeed` → 取 `task_result.voices[].voice_id` 作为内部参考音色，提供器将其写入请求的 `metadata.voice_id`（两个音色时为 `metadata.voice_ids`），不向网关发送 `reference_audio`，并开启视频音频。New API 网关需把上述 metadata 转为腾讯 `contents` 中的 `type=voice` / `voice_id` 项。创建接口的 `task_id` 不作为音色 ID。非 Kling 模型沿用音频 URL。自动音色名称使用 20 字符以内的短名称。音色与视频 HTTP / 业务错误统一经 `core/providers/provider-error.ts` 收敛为供应商类别、阶段、HTTP 状态、安全错误类别及格式受控的请求 ID；不再回显供应商自由文本。单次最多两个音色；音色失败、超时或取消会阻止视频提交。

`core/providers/kling-voices.ts` 定义音色 HTTP 协议和持久化接口；`generation/kling-voice-store.ts` 通过迁移 35 的 `generation_voice_tasks` 保存用户 / 视频任务 / 音频序号对应的外部请求 ID、音色任务 ID 和音色 ID。写请求前先保存外部请求 ID，未知创建结果仅查询，不重发 POST；凭证 / 来源指纹变化时拒绝复用。该记录只用于同一任务恢复，不跨视频任务缓存音色。Worker 通过 `generation/config.ts` 的 `loadKlingVoiceConfig` 读取独立服务端配置 `KLING_VOICE_BASE_URL`（默认 `https://tokenhub.tencentmaas.com/v1`）与 `KLING_VOICE_API_KEY`，不回退到 LLM、视频或用户推理 Key。客户端在基础地址后追加 `/wand/kling/custom-voices` 及查询路径；音色状态仍按用户 / 任务隔离，指纹绑定独立音色服务凭证。未配置 Key 时仅带参考声音的真实 Kling 任务报错；视频生成继续使用原有提供器配置，营销私有音频仅通过 `PUBLIC_BASE_URL` 上的 10 分钟临时链接供供应商读取。音色指纹继续使用原素材地址；既有检查点不依赖素材链接恢复。Mock 视频不请求真实音色服务。协议依据：[腾讯 Kling 音色管理文档](https://cloud.tencent.com/document/product/1823/135742)。

营销影像使用独立的 `marketing_video` Agent（空工具白名单）。`ChatPanel → MarketingVideoStudio → ProjectStudio` 提供三步创作（`ProjectStudio` 持有草稿状态和动作；界面拆为 `DraftLibrary`、`CopyStep`、`MaterialsStep`、`ProductionStep`、`ResultPanel` 及 `StudioFields`；错误、通知和长请求进度（`WaitStatus`，阶段 + 已用时）放在与步骤按钮一起吸底的停靠区；删除、取消、放弃、重提和跳过等确认统一用 `ConfirmDialog.tsx` 的 `useConfirm`（沿用 `AgentSwitchDialog` 的原生 `<dialog>` 样式），不使用 `window.confirm`；`session.ts` 提供草稿会话守卫、单操作互斥和任务状态轮询，`materials.ts` 做上传前校验）：确定文案（生成或拆解改写，可编辑分镜）、确定素材（数字分身/肖像、产品样例图、背景和场景；人物、产品、场景三区及全部参考图的上限取自当前模型配置 `MarketingVideoProfile.referenceImages`，兼容旧单张草稿；可选 1 个直接参与生成的参考视频，可同用的图片数和每镜上限取决于模型配置，并关闭原生口播配音，提交前由前后端校验）、确认与制作（配音方式二选一，草稿字段 `narration` 缺省为「AI 配音」：「AI 配音」由视频模型生成人物语音，选填音色样例仅作音色参考，可直接从数字分身语音库选择或上传；「数字分身旁白」用数字分身已复刻的原声逐镜 TTS（`DigitalTwinPicker` 的 `onPickVoice` 按条目选择就绪音色；`NarrationPanel` 生成、试听、单镜重做并可按配音调整镜长；`marketing-video/narration.ts → MarketingNarrator` 经 `TwinVoices.speakAs` 合成 WAV，迁移 55 `marketing_video_narrations` 记录意图与结果，文件在 `data/marketing-narration/<草稿>/`；接口 `GET/POST /:id/narration`、`GET /:id/narration/:slot`），片段无声生成且提示词要求人物不对镜头念台词，`/generate` 以输入版本 4 冻结每镜配音并标记 `local_subtitles`，Worker 合成时替换音轨；该标记的任务片段不画文字，字幕由 `marketing-video/subtitles.ts` 按确认文案切行、按配音时长与 `silencedetect` 停顿计时，在 `media.ts → composeMarketingVideo` 逐镜规范化时用 libass 烧录（`mediaCapabilities().subtitles` 付费前检查），见 [配音方式](marketing-video.md#配音方式)；真人对口型由独立的数字主播 Agent 负责，见 [数字主播方案](digital-presenter-plan-20261021.md)；上传 BGM、字幕、画面比例与清晰度；分镜默认只显示总览，展开“修改分镜”后编辑；分镜下的「定妆图」（`KeyArtPanel`，接口 `GET/POST /:id/key-art`）按统一设定和已选参考图生成一张人物在主场景中的图片：`marketing-video/key-art.ts → MarketingKeyArtist` 用用户 Key 调图片模型（`MARKETING_KEY_ART_MODEL`，默认 `gpt-image-2.5-flare`，网关计费、本地不计量），迁移 58 `marketing_video_key_arts` 先写意图行、不自动重发，键（basis）覆盖提示词、比例和参考图，结果存为私有上传素材；`/generate` 把当前外观的定妆图追加在参考图之后并冻结为 `input.key_art`，Worker 和 `/revise` 按该标记让每镜和单镜重做都带同一张图（`prompt.ts → marketingSegmentPrompt` 的 `keyArt`），没有定妆图时生成前确认；“文案与分镜检查”只在此步显示，生成前自动检查，未通过时停留在此步修改；草稿 `storyboardAudio` 记录分镜按有声或无声规划，与参考视频设置不一致时在第 2、3 步提示重建分镜，生成前再确认）。`TextOperationPanel` 位于步骤按钮旁的底部停靠区，只显示进行中 / 待核实状态，已收到的回执自动填入草稿，不向用户展示操作编号或历史记录；结果未知时提供「放弃这次结果」，本页发起的同类请求还提供「放弃并重新生成」（`ProjectStudio` 记录最后一次文案类请求，放弃后用新请求 ID 重发）。`StoryboardEditor` 提供生成前的详细分镜确认，包含口播、画面、动作与镜头运动，可手动编辑或通过 `POST /api/marketing-videos/:id/storyboard` 按要求修改全部 / 单段分镜；确认后才提交视频任务。分镜随草稿 JSONB 保存，修改口播同步正文，修改正文清空旧分镜，修改时长优先自动重分配各镜时长。`core/marketing-video` 定义严格草稿 schema 和分段规划；整片可选 15–60 秒，每镜保存 4–15 秒的独立时长，由 Kimi 自动选择镜数和分配，实际总长允许比目标多最多 5 秒、最长 65 秒，合成和产物时长采用实际各镜总和；迁移 41 支持最多 15 镜，旧分镜仍按原 15 秒兼容。片段模型不写死：`core/marketing-video/models.ts` 为每个模型定义 `MarketingVideoProfile`（每镜上限、参考图分区与合计上限、提示词中的图片写法、参考视频可同用图片数、参考素材最高清晰度、参考视频限制、提示词上限），服务端 `MARKETING_VIDEO_MODEL`（`marketing-video/model.ts`，默认 `grok-imagine-video-1.5`，可选 `kling-video-v3-omni`）选择新任务的配置并经 `/capabilities` 下发给前端；冻结任务由 `marketingJobProfile` 按记录的 `modelId` 恢复。Kling 音色链路由 `run-job.ts` 按模型 ID 自动启用。切换和新增模型见 [模型配置与切换](marketing-video.md#模型配置与切换)。

`POST /api/marketing-videos/:id/generate → marketing-video/repository.ts` 在付费生成前校验各镜总和（目标至目标 +5 秒，最多 65 秒），在一个 PG 事务中创建草稿关联的父任务和全部片段任务，随后按父任务 ID 幂等投递 Redis。`workers/index.ts → marketing-video/run.ts` 同时执行最多 `MARKETING_VIDEO_SEGMENT_CONCURRENCY` 个片段（默认 2），保留成功产物、模型任务 ID 和提交未知状态；恢复仅继续原任务，明确失败的片段才在用户点击继续后重新生成。`media.ts` 在本地校验文件签名、规范化编码并以 FFmpeg 拼接、混入 BGM，并在混入 BGM 前对拼接结果做成片检查（`inspectFilmQuality`：`blackdetect`、`freezedetect`，应有语音时加 `silencedetect`，按镜号归类；不调用任何模型），结果随成片写入 `output.quality`，由 `ResultPanel` 的「成片检查」显示；`resolveMarketingSegments` 保留确认后的分镜边界，任务快照携带完整分镜；`creation.ts` 统一文案、分镜修改和发布文案提示词，复用 `prompt.ts` 的素材角色、配音状态与字段约束，修改镜头默认保留确认文案。`prompt.ts` 为每段模型请求提供当前镜文案及画面、动作、镜头，`marketingImageReferences` 同时决定提交图片顺序与提示词编号；拆解来源不自动作为生成素材。字幕按该镜文案生成，参考视频模式只生成无声画面及可选字幕，不使用本地字幕滤镜或 ASR 对齐。规则详见 [营销视频制作](marketing-video.md#提示词与素材引用)。取消经父任务传递到模型轮询和 FFmpeg。结果页 `TaskStatus.tsx` 展示进度，停止后由 `failure.ts` 把任务错误归类为原因、下一步和可用操作（继续生成 / 复制为新草稿 / 重新提交未知片段 / 联系客服）；供应商明确拒绝创建或连接阶段失败（`CONNECT_ERROR`）时 `run.ts → definiteRejection` 释放未知标记，允许修正后继续；确实未知的片段由用户确认后经 `POST /:id/unknown-segments/release` 只重提这些片段，迁移 49 记录释放次数与时间。迁移 36 新增项目 / 片段表与计量幂等键，保证恢复不重复记录同一模型任务费用。Kling 音色由 `run.ts` 在片段并发前按父任务准备一次，片段经 `RunJobDeps.voiceScopeTaskId` 复用；`media.ts → mediaCapabilities` 用编码器 / 滤镜清单和探针短片判断合成就绪，API 与 Worker 均在付费前检查。审核与标题标签（`/:id/review`、`/:id/publication`）与文案、分镜共用 `operations.ts` 的调用记录（迁移 50）；审核时 `begin` 取同一草稿、同语言、同规则版本的上一次已应用审核，由 `compliance.ts → marketingReviewDelta` 按字段名和镜号比对，只让模型检查改动字段（与分镜一致的正文不重复检查），未改字段的结果沿用；增量随输入快照冻结，回执恢复结果一致，本地风险表仍全篇执行，无可用基准或没有保留字段时整篇检查。每用户同时最多 2 个文案类请求；参考图按 `MarketingVideoProfile.referenceImage` 在前端上传时和 `/generate` 时（`image-size.ts` 读取真实文件头）检查。草稿列表 `GET /api/marketing-videos` 支持 `limit/cursor/q` 分页搜索（`repository.ts → page`）。

`generation/private-materials.ts` 处理营销上传的临时链接及静态访问控制。迁移 47 回填项目和冻结任务中的上传素材私有标记；`routes/uploads.ts` 接收 `purpose=marketing-video`。`generation/kling-voice-store.ts` 先读取既有检查点，新音色在本地素材准备成功后才记录意图。`jobs/task-queues.ts` 将营销父任务路由到 `lot-marketing-video`，`marketingQueueLimits` 读取 `MARKETING_VIDEO_CONCURRENCY`（每进程，默认 2）与 `MARKETING_VIDEO_USER_CONCURRENCY`（每用户，默认 1）与 `MARKETING_VIDEO_SEGMENT_CONCURRENCY`（每条视频的片段并发，默认 2，经 `MarketingRunDeps.segmentConcurrency` 传给 `run.ts`）；`bullmq-queue.ts` 独立消费并兼容旧 `lot-tasks` 作业，营销作业经 `db.claimTaskWithinOwnerLimit` 领取，同用户超限时转为 delayed 让出槽位。迁移 46 更新队列元数据，不修改任务 ID 或供应商回执。`db/database.ts` 的三分钟待领取扫描只触发 `BullmqJobQueue.diagnosePending`，检查两条队列后写等待、未知或投递缺失诊断，不生成失败终态；Redis 读取有界。终态拒绝隐式领取，允许的普通重试保持 pending。取消先持久化并由跨进程 Worker 轮询观察，API 的 `cancellationRequested` 表示已请求取消；队列不可读或原作业未收尾时拒绝恢复。详细边界见 [素材访问与队列隔离](marketing-video.md#素材访问与队列隔离)及[十月十六日实施与验收](marketing-video-implementation-20261016.md)。

草稿按用户保存到数据库，页面只在账号隔离的 localStorage 里保存最后打开的项目 ID。制作配置提交后固定，发布标题 / 标签仍可编辑；`marketing-video/archive.ts` 将成片和发布信息归档到私有知识库，再次保存同步最新文案。首版实际对口型和抖音直发能力明确禁用，结果可预览、下载并复制发布文案。成片或任务停止后，`ResultPanel → ShotRevision` 支持单镜重做：可以修改各镜文字或勾选镜头，`POST /:id/revise → repository.ts → revise` 新建父任务，只提交所选镜头，其余镜头的片段任务直接引用原资产（`output.reusedFrom`），`run.ts` 不再调用模型或计量这些片段。`ResultPanel` 的「成片设置」可改背景音乐与音量、本地烧录字幕的开关和旁白音色 / 语速 / 语气：`core/marketing-video` 的 `marketingRevisionKey(draft, composition)` 按 `revision.composition` 放行这些只在合成时生效的设置，`shots` 为空的 `/revise` 沿用全部片段只重新合成；旁白任务只改口播时 `marketingShotNeedsClip` 允许保留画面，只换配音和字幕。迁移 53 允许同一草稿保留多次制作的片段行。修改镜数、时长或其他配置仍需复制为新草稿。删除草稿（`repository.ts → remove`）在同一事务中删除生成的片段与成片资产行（含单镜重做前各次制作）、该草稿的定妆图和为该草稿创建的参考分析（复用 `marketing-analysis/repository.ts → deleteAnalysisRecord`），提交后由 `routes.ts` 删除文件；上传素材保留在个人素材。`GET /api/marketing-videos/usage` 汇总草稿视频、引用素材和参考分析目录的占用，`DraftLibrary.tsx` 展开时显示。旧会话结果仍由包装组件展示，旧 `/api/video-drafts` 与会话生成接口保持兼容，其 4–15 秒限制不影响新项目链路。依赖、恢复语义和验收命令见 [营销视频制作](marketing-video.md)。

`AgentService.marketingText → marketing-video/text.ts` 统一处理文案 JSON 输出、完整结束检查、5 分钟超时及安全错误码。文案和分镜固定使用当前用户凭证的 `kimi-k3`，文案与分镜检查（营销影像和数字主播的 `/review`）改用更快的 `deepseek-v4.1-flash`（`MARKETING_REVIEW_MODEL`），均不回退到其他默认模型；数字人模式在分镜创作和实际片段请求中都要求人物每镜出镜；截断结果不作为审核通过，不自动重新采样，审核等既有请求仍经 `meterLLM` 记录。创作文案/分镜请求使用 `upstreamBilling`，不做本地额度检查或金额计算。

“检查当前文案”通过 `marketing-video/compliance.ts` 合并风险表条件匹配与模型语义审核，`compliance-rules.ts` 保存用户词表的黑名单、条件词和局部豁免场景。审核覆盖正文、标题、标签、背景及每镜台词、画面、动作、镜头；规则版本与字段边界进入 `marketingReviewText`，修改内容后旧检查失效。`web/modules/marketing-video/ReviewPanel.tsx` 按字段和镜号展示风险原因、规则来源及修改建议；一键修改仅替换该字段唯一的原文片段，手动修改可编辑完整字段，两者都只保存草稿、不自动重检；上次检查结果保留为“内容已修改”状态，只列出原文仍在的问题，由用户点击“检查当前文案”重检（数字主播的 `PresenterSteps.tsx → ReviewSection` 相同）。修改分镜台词同步正文；手改整篇正文清空旧分镜并提示重建。官方规则的来源和适用范围见[营销视频内容检查](marketing-video.md#内容检查)；证号、榜单或白名单字样不能替代真实性核验，检查结果不等同平台审核通过。

“拆解爆款文案”在选择按钮下提供视频链接/文案统一输入，链接与文案自动识别，仅“上传本地爆款视频”需单独选择；`core/marketing-video/source.ts` 提供共享提示分类，普通官网 URL 保留为文字，服务端拒绝视频链接绕过分析进入 `/copy`。纯文案经 `marketing-video/creation.ts` 一次生成文案和分镜；“拆解爆款文案”的参考来源支持视频链接、文案和上传本地爆款视频；需要平台登录的链接引导用户上传本地视频，界面不收集平台 Cookies；`POST /api/marketing-video-analyses/uploads → marketing-analysis/uploads.ts` 保存 MP4 / MOV / WebM（100 MB、最长 180 秒、最高 1080p）的私有来源，迁移 `0045` 记录归属和哈希。草稿 `referenceUpload` 与直接参与生成的 `assets.video` 独立；`runtime.ts` 将归属及哈希校验后的上传复制至分析目录，复用隔离解码、OCR、ASR、摘要和自动回填。上传按用户存放在 `data/marketing-analysis/<owner hash>/uploads/<upload UUID>`，不挂静态目录，使用独立命名空间避免与分析任务 ID 碰撞；原片满七天后按任务状态回收，切换来源清除旧分析引用。

参考视频分析通过 `ProjectStudio → /api/marketing-video-analyses → marketing-analysis/repository.ts → lot-media-analysis → workers/media-analysis.ts` 运行。迁移 `0039` 保存来源、分析、步骤、修订、加密平台 Cookie 和草稿引用；原片/证据在私有目录。`runtime.ts` 编排隔离下载、本地 PTS 抽帧、DeepSeek OCR、Kimi 观察、摘要及文案/分镜创作；`config.ts` 默认解码/抽帧 4 线程、单视频 OCR 8 路和画面理解 3 路，`pipeline.ts` 并行调度两类模型工作，按帧/批次序号汇集并串行保存检查点，全部完成后统一摘要；迁移 `0040` 保存目标草稿和版本，`repository.ts.finish` 自动回填，版本冲突保留结果。`ReferenceAnalysisPanel` 查询进度并提供可展开的只读资料；已有未完成分析时主入口切换为“继续生成”，通过原分析的 `/resume` 复用已保存的拆解与摘要，仅补齐未完成步骤，刷新不新建任务。请求结果未知时隐藏重新拆解入口，继续遵守核实后恢复的保护。`ledger.ts` 保留意图与真实 token 回执，本流程不计算金额或预留预算，上游余额不足则停止，用户充值后显式继续；未知结果不自动重发。`scripts/check-marketing-analysis-local.ts`、`local-probe.ts` 和 `probe-resume.ts` 提供显式 macOS 验证、隔离及保留失败费用的缺口续测。Apple Silicon 本地 Worker 可设置 `MARKETING_ANALYSIS_MACOS_SANDBOX=1`，由 `media-runtime.ts` 为下载及抽帧选择 macOS 沙箱；生产环境禁止该开关并保持 Linux 隔离，HTTP 输入不能选择运行时。默认未启用；单条小红书已完成下载和 85 次完整模型测试，保留 3 帧 OCR 缺口，三平台批量质量仍待验收；2026-10-16 已在 Ubuntu 22.04 / amd64 验证 Linux 沙箱，其他目标主机须重新预检。配置、API、恢复及检查命令见[参考视频分析实现](marketing-video-reference-analysis.md)。

Linux 抖音下载由 `deploy/media-analysis-proxy-bridge.py` 仅对规范化抖音 URL 选择固定的 `yt-dlp-douyin`；构建脚本及已审查的上游签名兼容补丁见 `deploy/yt-dlp/README.md`，其他平台保留原版下载器。抖音提取器遇到浏览器会话缺失或 HTTP 403 时，`marketing-analysis/download.ts → douyin-browser.ts → browser-pipe.ts` 在隔离的匿名 Chromium 会话中读取公开播放器一次，校验视频 ID、HTTPS CDN、时长和尺寸后，经 `--load-info-json` 继续下载。浏览器与下载器共用有界 HTTPS 出口，不导入已有浏览器账号；实际登录限制、验证码、取消和网络拒绝不触发此兜底。`sandbox.ts` 提供 Linux 浏览器命名空间，`local-probe.ts` 提供显式开发开关下的 macOS 隔离；生产媒体镜像新增 Chromium 依赖，变更后需重建。

`marketing-video/operations.ts` 通过迁移 `0042` / `0044` 持久化文案和分镜修改的请求 ID、输入哈希、原始输入快照、解析器版本、草稿版本、模型、协议、回执及结果。完整回执进入 `needs_apply`；`POST /:id/text-operations/:operationId/recover` 仅用原始快照和回执本地解析、原子应用，提交结果未知时先读已存结果，版本冲突单独保留。`/copy` 和 `/:id/storyboard` 要求 `clientRequestId`；文案入口另传 `projectId` / `version`。结果与草稿回填原子提交，版本冲突单独保留结果，`GET /:id/text-operations` 和 `TextOperationPanel` 提供刷新恢复；未知请求阻止重复调用；网关未返回任何内容（无响应 ID、正文和用量）的失败按未计费处理并可直接重试：明确拒绝记为 `failed`，其他错误、超时和断连记为 `cancelled`（迁移 54），回执保存网关请求 ID（`core/llm/gateway-request-id.ts` 读取 `x-oneapi-request-id`，经 `ChatOptions.onRequestId` 上报），供偶发扣费核对退费。`/copy` 和 `/:id/storyboard` 的模型请求不绑定浏览器连接，刷新页面不会制造未知状态。查询和恢复已保存结果不调用模型；`TextOperationPanel` 提供状态刷新与恢复，unknown 仅锁定当前项目修改，允许切换或新建草稿，用户确认可能重复计费后可经 `POST /:id/text-operations/:operationId/release` 放弃（状态 `released`，迁移 49）。历史素材 GET 与新生成限制分离，旧 WebM 可预览和替换；`marketing-video/recovery.ts` 供 HTTP 与 Worker 逐片分类复用、查询下载、新提交和 unknown。已知回执按原父任务冻结输入恢复，跳过无关的新建素材规则；新提交仍严格预检和计量，unknown 阻止整批新付费意图。片段查询及输出复用检查用户与父子任务关联。Worker 以任务冻结的 `generate_audio` 保持旧任务音频语义，新任务记录 `marketingInputVersion: 2`。

`marketing-analysis/summary-input.ts` 统一正常与摘要恢复输入，依据 selection 和实际 OCR/视觉完成状态补齐处理缺口；迁移 `0044` 的 `summary_inputs` 在首次摘要请求前按 revision 冻结输入，JSONB 回读重建原字段顺序，旧 intent 保持原 hash。限制项去重并保留首次顺序；`completedVisualBatches` 记录实际处理完成度，旧任务从账本读取批次状态。`analysisUserKey` 将取消和 15 秒授权截止时间传到模型目录 HTTP 与正文读取。创建、恢复和重新摘要共用用户事务锁下的准入检查；队列每次选各用户一个可运行候选。`storage.ts` 检查累计字节、在途预留和磁盘低水位；迁移 `0043` 记录临时文件清理，保留全部展示帧和不可变 selection。原片满七天后回收，抽帧完成立即删除 `gray.raw`。语音检查点缺失时优先从完整 ASR 回执恢复，不重新解码或请求；无回执且源已过期返回 `SOURCE_EXPIRED`，用户可显式选择仅使用保留画面继续，unknown 保护不变。`ReferenceAnalysisPanel` 展示缺口、时间线、引用和推断，按真实转写状态说明声音证据。修复范围和验证见 [恢复与升级契约](marketing-video-reference-analysis.md#恢复与升级契约)。

`marketing-analysis/models.ts` 对汇总摘要和文案/分镜合成统一使用 5 分钟超时，逐帧 OCR 和分批观察为 2 分钟；取消和租约失效立即中止。中断请求保留已有资料与请求 ID，核对回执后从未完成步骤继续。

通用 Responses 提供器在 `core/llm/responses.ts`，由 `llm.openai.protocol` / `OPENAI_PROTOCOL` 和优先级更高的 `modelCatalog.llmProtocols` 选择；已给 DeepSeek 与 Kimi 配置 Responses。工具调用使用 `call_id`，同轮 encrypted reasoning 状态参与上下文预算，保留原有 schema 和工具白名单。现有文档 OCR 独立 HTTP 路径保持原协议。

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

飞书接入：`server/feishu/` 的 `onboarding-client.ts` / `service.ts` 仅支持每用户通过官方 PersonalAgent 扫码创建机器人、设备授权与私聊验证码绑定，应用凭证按用户加密入库，不读取全局共享应用凭证；`channel.ts` 按用户应用维护 SDK 长连接并并行消费任务，`repository.ts` 按用户串行、持久化去重及取消。`web/components/FeishuSettings.tsx` 从当前 Agent 卡片（`SidebarAgentTabs.tsx`）或账号菜单打开，轮询接入进度及绑定后的通道状态；`Sidebar.tsx`、`useConversations.ts`、`useChat.ts` 展示并刷新每用户唯一置顶的飞书会话。迁移 `0037` 保存接入记录，`0038` 增加加密应用凭据、接入阶段、会话唯一索引并合并旧历史。`AgentService.streamAgentResponse` 的 `channel: "feishu"` 首次使用用户可用模型列表的默认项并保存到会话，沿用 Web 通用助手的服务端工具白名单，复用队列预写的消息并排除尚未执行的任务上下文。`server/feishu/tools.ts` 在任意 Agent 文字对话按请求注入官方联系人搜索（`contact:user:search`，用户 Token，支持分页和可见外部联系人）与发送工具；收件人 `self` 由机器人向绑定本人投递，其他联系人默认使用用户身份，明确选择 `identity: "bot"` 时自动以机器人发送；外部单聊需收件人先启用，受控失败回执附启用链接。保留身份隔离的持久化幂等、同一请求跨身份去重、绑定版本校验和取消。设置页仅管理连接与授权，移除手动联系人/发送表单。`channel.ts` 回传提问选项、PPT 大纲与文档下载回执，并把等待用户回复保存为 `awaiting_input`；完整读取错误后的终态，保留发送回执、受控 API 错误码及运行 ID，明确拒绝的幂等重入不会误报未知结果。协议、权限、失败语义和验证见 [飞书接入](feishu.md)。

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

- Web 桌面版下载：`App.tsx` / `components/DesktopDownload.tsx` 在登录后的右上角显示三平台下载弹窗，链接指向当前域名根路径的 `linquclaw-arm64.dmg`、`linquclaw.dmg`、`linquclaw.exe`；复用 `/api/public/product` 的 `globle` 标记，`globle > 0` 或 Electron 环境隐藏入口。
- 桌面本地工具：`core/desktop/protocol.ts` 为共享协议（`@lot-agent/core/desktop`）；`web/components/DesktopWorkspace.tsx` 为输入框上方常驻的目录选择栏、左下角的三档权限菜单，并在聊天内渲染批准卡片；`web/hooks/useDesktopWorkspace.ts` 同步当前会话审批状态，`packages/desktop/src/main/tool-approvals.ts` 持有会话策略与单次批准 ID；`server/desktop/routes.ts` / `broker.ts` 校验归属和单次 capability，在通用助手当前请求中注入工具代理；`packages/desktop/src/main/tool-host.ts` 持有授权、轮询并取消任务，`local-tools.ts` 执行本地文件读写及单文件删除，`local-shell.ts` 执行 Windows 系统 PowerShell 或 macOS/Linux Bash；v2 注册按客户端能力限定命令工具。普通 Web / 小程序不获本机执行桥接，部署服务器不执行宿主命令。限制、会话授权与多实例路由要求见 [桌面端](desktop.md)。
- 桌面自动更新：`packages/desktop/src/main/updater.ts` 管理签名清单、下载与安装；`update-manifest.ts` 验证 Ed25519、平台和版本；Mac 通过 `mac-update.ts` / `scripts/mac-update-helper.sh` 备份替换与启动确认，Windows 通过 NSIS 签名清单 Provider；`web/components/DesktopUpdate.tsx` 显示进度与重启/手动安装入口。`deploy/desktop-release.mjs` 准备及原子发布，`deploy/nginx.conf` 提供静态分发；配置与限制见 [桌面自动更新](desktop-updates.md)。
- 桌面完整发布包：`pnpm release:desktop <版本号>` → `packages/desktop/scripts/release.mjs`，在 Mac 上顺序构建三平台、复用更新密钥签名、生成服务器脚本及压缩包；`deploy/nginx-desktop-updates.conf` / `nginx-desktop-downloads.conf` 是随包分发的宿主机 Nginx 片段。不会自动上传或发布服务器。
- 桌面：`packages/desktop/scripts/pack.mjs` 统一重建 Core / Web / Electron 后打包，可用 `--server-url` 指定默认后端（默认 `https://todoucloud.com`）；同目录 `dev.mjs` / `clean.mjs` 提供跨平台启动与清理。`packages/desktop/src/main/config-store.ts` 解析启动地址参数及凭证归属；`packages/desktop/src/main/index.ts` 启动；`main/local-server.ts` 静态、代理及本地配置接口来源校验；`main/ipc.ts` 与 `preload/index.ts` 定义桥接；`main/secure-token.ts` 存储凭证。
- 小程序：`packages/miniprogram/miniprogram/app.json` 页面 / 导航；`services/api.ts` 请求；`services/session.ts` 登录；`services/generate.ts`、`services/video.ts` 创作；`pages/studio/`、`pages/video/`、`pages/gallery/`、`pages/mine/` 为主入口。

## 6. 数据与接口定位

### 数据库

正式迁移在 [db/migrations](../packages/server/src/db/migrations)，由 [migration-runner.ts](../packages/server/src/db/migration-runner.ts) 使用 advisory lock 和逐迁移事务执行，版本与名称写入 `schema_migrations`；同号异名会在执行迁移前报错。当前最新为 `0056-digital-presenter.ts`（已有数据库的版本 32 属于 `comic-drama`）。只有 server 负责迁移，Worker 使用已有 schema；知识 Worker 检查迁移 30 就绪，媒体分析 Worker 检查迁移 45 的私有上传表，以及迁移 44 的摘要输入字段和既有创作上下文、清理字段就绪。

运行日志新增 `agent_runs / agent_steps`，结果核实保留原始回执；普通模型会话与媒体生成任务状态互不替代。

新增表 / 字段应追加迁移文件并在 `migrations/index.ts` 注册，不能只修改历史迁移或依赖手工 SQL。普通业务查询集中在 `db/database.ts`；数字员工和知识库有自己的 repository。PG `NUMERIC` 返回字符串，计算前显式转换。

主要数据域：账号 `users / sessions`；聊天 `conversations / messages / message_tool_calls`；运行 `traces / spans / tasks`；资产 `assets`；支付 `virtual_payment_orders`；计量 `usage_logs`；Agent 安装 `user_agents`；知识表以 `rag_` 为主。数字员工与项目表的准确字段通过对应迁移和 repository 查找，不从旧表格复制。

### HTTP 与文件

| 路由组 | 定位方式 / 认证 |
| --- | --- |
| `/api/auth` | `routes/auth.ts`；登录等为公开入口，资料修改 / 绑定等在处理器内校验身份 |
| `/api/conversations` | 聊天、项目、知识范围、生成与再生成；会话认证和资源归属 |
| `/api/agents`、`/api/models` | Agent 目录与模型目录；会话认证 |
| `/api/marketing-videos` | `marketing-video/routes.ts`；三步创作、用户草稿（含删除与空间用量）、文案检查、分段生成和知识库归档 |
| `/api/digital-presenters` | `digital-presenter/routes.ts`；数字主播草稿、口播文案、文案检查、逐段原声配音、生成 / 继续 / 释放未知片段；供应商只经 `/api/public/digital-presenter-media/:token`（`files.ts`，3 小时加密链接）读取输入 |
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
pnpm dev                    # core watch + API + 普通 Worker + 知识 Worker + 媒体分析 Worker + Web
pnpm dev:server
pnpm dev:web
pnpm --filter @lot-agent/server dev:worker
pnpm dev:knowledge
pnpm dev:desktop             # Web + Electron；后端需另行运行
```

API 默认 3000；Vite 默认 5173，普通 `dev` / `dev:web` 将 `/api`、`/static`、`/health` 代理到 `localhost:3000`。只有 `dev:desktop` 显式启用的 Vite `desktop` 模式读取桌面保存的服务器地址，避免本地新前端误连旧版线上后端。需要 PostgreSQL / Redis；知识索引还需要 pgvector 和知识开关。新环境启动消费者前确认 server 迁移完成。

```bash
# 按实际改动选择测试范围；新纯逻辑按仓库约定先写 Vitest 测试
pnpm exec vitest run packages/core/src/tools/registry.test.ts
pnpm test:knowledge
pnpm check:desktop-tools:ui  # 桌面工作目录界面、中英文主题与 Web 入口隔离（模拟桥接）
pnpm check:agent-navigation:ui # 需 Playwright 和 Chrome；模拟接口检查 Agent 切换、确认与历史隔离
pnpm check:marketing-video:ui # 模拟接口验证三步创作、素材、草稿/任务恢复、单镜重做、中英文和暗色界面
# MARKETING_CHECK_DATABASE_URL 指向空的本地 marketing_check_* 测试库
pnpm check:marketing-video:db # 隔离数据库、模拟模型、本地 FFmpeg 合成与恢复验证
pnpm check:digital-twin:ui    # 需 Playwright（可用 PLAYWRIGHT_MODULE 指定路径）和 Chrome；模拟设备及 HTTP 数据，无付费调用
pnpm --filter @lot-agent/web build
pnpm --filter @lot-agent/miniprogram build  # 类型检查，真机行为另验
pnpm test
pnpm build
```

测试一般与实现同目录，命名 `*.test.ts`。构建 / 测试通过不自动代表数据库集成、真实模型、浏览器或微信真机验收通过；报告实际运行范围。知识库集成脚本及真实付费验证分别见根 `package.json` 与专项手册，运行前读取参数和数据清理范围。纯文档修改只需核对路径、命令与内容，不必启动业务或调用付费模型。

## 9. 专项文档

- 产品方向：[定位、客群与路线图](roadmap.md)。
- 部署与客户端：[部署（含知识服务）](deployment.md)、[营销影像新服务器部署](marketing-video-new-server-deployment.md)、[媒体 Worker Linux 安全策略与预检](../deploy/security/README.md)、[桌面端与平台验收](desktop.md)、[桌面发布与更新](desktop-updates.md)、[小程序](miniprogram.md)。
- 账号与接入：[充值](recharge.md)、[微信虚拟支付](wechat-virtual-payment.md)、[飞书](feishu.md)。
- 营销影像：[视频制作、素材隐私与内容检查](marketing-video.md)、[参考视频分析、恢复与验收](marketing-video-reference-analysis.md)、[十月十六日实施记录](marketing-video-implementation-20261016.md)（保留 N01–N04 及未实施的 F03/F04 契约和样例）、[服务器部署与修复记录](marketing-video-server-deployment-20261016.md)（实际环境与回退依据）。
- Agent 与办公：[ReAct 运行与恢复](react-runtime.md)、[PPT 工作流](ppt-workflow.md)、[PPT 技能](../skills/ppt-authoring.md)、[文档技能](../skills/doc-generation.md)。
- 知识库：[管理接口、入库与账单恢复](knowledge-ingestion.md)、[外部 API](knowledge-external-api.md)、[OpenAPI 契约](knowledge-openapi.json)、[备份恢复](knowledge-backup-restore.md)、[检索优化与历史评测](knowledge-retrieval-optimization.md)。

历史评审和单次验证记录的有效契约、运维步骤与待验收项已合并到上述功能手册，原始过程可查 Git 历史。历史测试保留日期及环境限制，不代表当前版本或生产已验收。功能入口、数据流或迁移方式改变时同步维护本索引；无需复制完整 API schema 或测试结果日志。
