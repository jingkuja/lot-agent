# 参考视频分析：实现与验证

2026-10-14。按[开发方案](marketing-video-reference-analysis-plan.md)实现 Responses 接入、持久化分析任务、独立 Worker、抽帧/OCR/多图摘要和工作台入口。用户提供的一条小红书视频已在本机完成下载、解码及 85 次完整模型测试，得到含 3 帧 OCR 缺口的摘要与时间线。**三平台下载成功率、批量质量评测、生产 Linux 隔离环境仍待验收**。默认 `MARKETING_ANALYSIS_ENABLED=0`，不能把单样本结果当作三平台已经交付验收。

## 协议与入口

- `core/llm/responses.ts` 实现 OpenAI Responses：`POST <baseUrl>/responses`、`input_text` / `input_image`、流式文本与推理摘要、函数调用/返回、结构化文本格式、终态和用量。Base URL 需包含 `/v1`，提供器不重复拼接。
- `OPENAI_PROTOCOL=responses` 或 `llm.openai.protocol` 设置默认协议；`modelCatalog.llmProtocols` 的模型级配置优先。目前 `deepseek-v4.1-flash`、`kimi-k3` 使用 Responses。其他模型保留 Chat Completions 默认配置。Core registry、用户提供器及普通 Worker 都读取协议配置。
- 使用 `store:false` 和 `reasoning.encrypted_content`，同一 Agent 推理轮中的工具续调保留提供器输出项；上下文预算包含这些项。状态只在当前运行内传递，不能由客户端提交或跨模型复用。
- Responses SDK 关闭自动重试；完整终态之前不执行函数调用。截断、拒答、错误及流提前结束不会成为可执行工具结果。工具仍经过原有 schema、服务端白名单、归属和沙箱检查。
- 参考分析始终使用当前用户的托管网关 Key 和用户可用模型目录，不回退到平台共享 Key。现有知识库的独立文档 OCR HTTP 路径保持原协议。

协议依据：[Responses 迁移指南](https://developers.openai.com/api/docs/guides/migrate-to-responses)、[流式事件](https://developers.openai.com/api/docs/guides/streaming-responses)。兼容网关是否支持全部可选字段仍需真实探测；分析调用当前用提示词约束 JSON，并做服务端 schema 校验，不强制可选 JSON 模式。

## 自动创作、恢复与上游计费

`ProjectStudio → /api/marketing-video-analyses → PgAnalysisStore → lot-media-analysis → workers/media-analysis.ts → runtime.ts`。

迁移 **0039** 新增来源、分析、步骤、修订及加密平台会话表，并给营销项目增加分析引用。迁移 **0040** 增加创作上下文并取消本地金额预留；旧费用数据保留为历史记录。创建在一个 PG 事务中保存来源、任务、分析、幂等请求及目标草稿版本。PG 中的 queued / 过期 running 记录充当待投递记录，Worker 每 5 秒补发；普通 `lot-tasks` Worker 不消费媒体分析任务。

运行使用 90 秒租约，每 2 秒续约和检查取消；同一用户一次只运行一个分析，单任务默认 OCR 8 路、画面理解 3 路并发，两类请求同时运行；解码和抽帧默认 4 线程。成功下载、选帧、逐帧 OCR、分段观察、摘要和生成文案/分镜分别提交检查点。并发结果按原帧顺序和批次序号汇集，检查点串行写入；两类分析全部完成后才生成摘要，再生成文案和分镜。遇到额度、限流或未知结果时停止调度新调用，等待在途回执及检查点落盘，不自动重试。数据库不可用或租约丢失后停止发布结果，恢复读取已保存的调用，不重新提交未知请求。

每个模型步骤保存输入哈希、图片数、尝试编号、请求 ID、原始结果和真实 token 用量，不计算金额、不写本地费用账单。已知 OCR 无效输出保留回执并标记覆盖缺口，自动继续其他画面；不自动重试失败帧。缺失终态或用量进入待核实状态，不重发未知请求。明确的 HTTP 401/402/403/429 拒绝保存为 `rejected`，无需虚构零 token；余额不足显示充值后继续，只有用户主动继续才重试。

“继续生成”同样复用已知 OCR 缺口，只重试被拒绝的请求或未完成的视觉、摘要、创作步骤。图片数量按固定步骤的选帧覆盖计算，不累计同一批图片的重试次数；新增图片仍受 120 / 48 张上限约束。摘要时间标注与有效引用冲突时，从引用的实际观察时间确定区间并排序，再执行完整校验；不改写陈述、不接受不存在的证据，原始回执保持不变。

汇总摘要和最终文案/分镜请求均允许最多 5 分钟，逐帧 OCR 和分批画面理解为 2 分钟；用户取消和租约失效会立即中止，不自动重试超时调用。超时且缺少终态用量的请求仍需核对网关回执后恢复。

`marketing-video/creation.ts` 通过 `kimi-k3` 统一生成文案、发布标题/标签和每镜 4–15 秒的完整分镜，按用户选择的 15–60 秒目标时长自动分配；允许多最多 5 秒、实际最长 65 秒，并校验总和。纯文案通过 `/marketing-videos/copy` 一次请求完成；视频由 `runtime.ts → AnalysisModels.createCopy` 使用完整分析证据自动生成，并由 `PgAnalysisStore.finish` 原子写入目标草稿。草稿归属、版本、制作状态及分析关联必须仍匹配；冲突时保留结果，不覆盖其他页面修改。刷新页面只查询已保存任务和草稿，不启动生成。
兼容部分模型在 JSON 字符串中直接输出换行：只对字符串内未转义控制字符进行无损转义后重新解析，原始回执保持不变；缺引号、缺括号、截断、无效证据仍然拒绝，不补写推测内容。

本流程的余额与计费由上游网关负责，不要求 `MARKETING_ANALYSIS_BUDGET_CNY` 或 `MARKETING_ANALYSIS_PRICING`。页面不展示预算、已花费用或预计费用。保留时长、图片数量、文件大小、并发及请求大小限制，用于控制资源与隔离风险。其他业务已有的计费与限额机制不受影响。
操作员核对网关回执后，可以执行：

```sh
MARKETING_ANALYSIS_RECONCILIATION_NOTE='已核对的网关回执依据' \
pnpm marketing-analysis:reconcile USER_ID ANALYSIS_UUID 'ocr:f0001' 1 /private/path/receipt.json
```

回执必须有 `outcome`（completed / failed）、`responseId`、`text` 与经核实的 `usage.promptTokens / completionTokens`。工具拒绝覆盖已知回执或不匹配的请求 ID，保留核对记录，**不自动排队、不调用模型**。之后仍由用户显式继续。不得用估计 token 或虚构零用量解除保护。

## 来源、隔离与证据

平台适配接受三平台的单视频长链/短链，保留 B 站选定 `p` 和小红书必要访问参数；拒绝主页、合集、直播、多个链接、图文和超过 180 秒的媒体。B 站提取器的实际单 P / cid 及登录会话兼容性仍需真链核对，尚无浏览器自动化兜底。

下载器固定版本、固定参数，禁用插件、用户配置、JS runtimes、远程组件、外部下载器。只选有界的视频流，不额外请求独立音轨。下载进程在独立 Linux 网络命名空间内，只能通过任务专属 Unix socket 和 HTTPS CONNECT 代理出网；解析并固定公网 IPv4 地址，拒绝内网、保留网段和其他端口，所有连接累计限制 100 MiB。

小红书提取器在真实样本中给出明文 HTTP 的 `*.xhscdn.com` 媒体地址；固定下载参数仅将该 CDN 的 URL 升级为 HTTPS，仍由同一个出口代理校验。其他明文 HTTP 请求继续拒绝，并记录 `NETWORK_BLOCKED`，避免被误判成需要登录。

`sandbox.ts` 使用 bubblewrap 的用户、PID、网络、IPC 等命名空间，挂载只读程序和任务目录；FFmpeg / ffprobe 无出口 socket，只能读取本地签名校验后的容器。限制进程 CPU、地址空间、文件大小、文件数、输出和运行时间；媒体 Worker 容器另限内存、CPU 与 PID 数。缺少 Linux / bwrap / namespace 权限时失败关闭，**没有无沙箱回退**。父进程持有模型和数据库凭据，不传给下载器或解码器。

Apple Silicon macOS 本地开发可显式设置 `MARKETING_ANALYSIS_MACOS_SANDBOX=1`，由 Worker 的 `media-runtime.ts` 同时为下载和抽帧选择 `local-probe.ts` 中的 `sandbox-exec` 实现。开关默认关闭，`NODE_ENV=production` 或非 macOS 平台拒绝启用；缺少依赖/沙箱权限时仍失败，不执行无隔离子进程。运行时仅由 Worker 配置决定，HTTP 请求不能选择执行器。

抽帧保留实际源 PTS、timebase、旋转后尺寸、归一化时间及源文件哈希。约 2 Hz、首尾补帧、局部分区灰度差分和 5 秒周期覆盖；最多 361 候选、120 OCR 图片、48 多图图片、每批 6 张。达到预算时记录遗漏候选和限制，不标记为“完整字幕”。实际 VFR、起始偏移与旋转由合成视频测试覆盖；包含起始 PTS 为 190 秒、实际仅 2 秒的 WebM，时长限制不把容器起始偏移算成视频内容。

OCR 只合并相邻一致文字；空结果、漏识别或价格/否定词变化保留边界。修订保留机器原文，已有摘要失效；校对后的继续只使用当前证据生成摘要，不重做付费 OCR。分段观察按时间输入图片，综合使用文字和已发送给模型的证据 ID，验证引用、时间范围、长度和数量，并明确未分析声音。时间线端点不得超出所引证据的最早/最晚观察时间 500ms，防止单张首帧被扩展成整条视频。模型提示词要求区分叠加字幕和物体上的印刷文字。

原片和帧位于 `data/marketing-analysis/<owner hash>/<analysis UUID>`，不挂 `/static`。帧读取经过用户鉴权、固定对象名、无符号链接/硬链接及文件大小检查。Worker 每分钟清理已删除分析及满 7 天且已停止的原片，保留帧与结果直到删除；项目引用或未核实用量阻止删除。平台 Cookie 按用户和平台加密保存，撤销只影响之后的任务，已经启动的下载最多持有本次任务副本。

## API 与工作台

所有接口都位于 `/api/marketing-video-analyses`，要求登录；身份从认证中获取。错误只返回有限错误码，不返回来源 Token、Cookie、模型请求体或上游原始错误。

| 接口 | 行为 |
| --- | --- |
| `GET /capabilities` | 是否启用、时长与平台 |
| `POST /` | `{shareText,clientRequestId,target?:{projectId,projectVersion,locale}}`，幂等创建并关联草稿，202 |
| `GET /?offset=0` / `GET /:id` | 每页 20 条简要历史 / 完整结果与覆盖情况 |
| `GET /:id/frames/:frameId` | 私有 JPEG，`private,no-store` |
| `POST /:id/cancel` | 持久化取消，Worker 中止请求和本地处理 |
| `POST /:id/resume` / `POST /:id/summarize` | `{expectedRevision}`，显式付费动作，拒绝未知调用 |
| `PATCH /:id/text` | `{expectedRevision,texts:[{id,text}]}`，保存新修订，保留原文 |
| `POST /:id/apply-preview` / `POST /:id/apply` | `{expectedRevision,projectId,projectVersion,evidenceIds}`，兼容旧记录的预览 / 选用，新工作台不调用 |
| `DELETE /:id` | 检查租约、用量和项目引用后删除私有内容 |
| `GET /sessions` / `PUT /sessions/:platform` / `DELETE /sessions/:platform` | 登录态状态 / 导入 `{cookies}` / 撤销，不返回 Cookie |

营销工作台点击“拆解爆款文案”后直接显示一个“视频链接或参考文案”输入框。产品补充要求可选，点击“一键拆解并生成”后自动完成，文案与分镜显示在当前步骤并可编辑。“查看参考资料”默认折叠，仅展示摘要、画面文字和私有帧；不再要求校对、勾选、手动生成摘要或预览选用。平台登录仅在来源要求登录时展开处理。页面状态和图片 URL 随账号切换销毁。
## 配置与部署

在 `.env` 设置：

```dotenv
MARKETING_ANALYSIS_ENABLED=1
MARKETING_ANALYSIS_CONCURRENCY=2
MARKETING_ANALYSIS_OCR_CONCURRENCY=8
MARKETING_ANALYSIS_VISUAL_CONCURRENCY=3
MARKETING_ANALYSIS_DECODE_THREADS=4
YTDLP_VERSION=<固定发行版>
YTDLP_SHA256=<对应 CPU 架构独立可执行文件的官方 SHA256>
SECRET_MASTER_KEY=<现有服务的加密主密钥>
```

`MARKETING_ANALYSIS_CONCURRENCY` 是跨用户任务并发（1–4），同一用户仍一次一个分析；`OCR_CONCURRENCY`（1–16）和 `VISUAL_CONCURRENCY`（1–4）是单个视频的模型请求并发，`DECODE_THREADS`（1–8）控制隔离解码器线程，均使用上面完整的 `MARKETING_ANALYSIS_` 前缀。提高并发不增加选帧数或调用总数，也不改变已保存步骤的请求哈希和恢复规则。

以上尖括号为需填写的配置说明，不能直接作为配置值使用。API 和媒体 Worker 使用相同配置、PG/Redis 和私有数据卷。API 执行迁移；Worker 等待迁移 0040 的 `creation_context` 字段就绪。运行 `pnpm dev:media-analysis`；根 `pnpm dev` 也包含这个入口，未启用时直接退出。

Apple Silicon Mac 本地开发在 `.env` 另加 `MARKETING_ANALYSIS_MACOS_SANDBOX=1`，并确保 `/usr/bin/sandbox-exec` 和 `/opt/homebrew/bin/` 下的 `yt-dlp`、`ffmpeg`、`ffprobe`、`python3` 可用，`YTDLP_VERSION` 与安装版本一致。修改后重启 `pnpm dev`（或单独重启媒体 Worker）。此前因 `SANDBOX_REQUIRED` 失败的任务由用户点击“继续生成”恢复，不自动重试付费调用。生产部署保持此开关关闭；Docker Compose 不传入这个本地开发开关。

Linux 部署需要 `/usr/bin/bwrap`、`ffmpeg`、`ffprobe`、`prlimit`、`python3` 和 `/usr/local/bin/yt-dlp`。Python 仅运行隔离环境中的本地出口桥，不是独立服务。下载器源码/发行包参考 [yt-dlp](https://github.com/yt-dlp/yt-dlp)，隔离机制参考 [bubblewrap](https://github.com/containers/bubblewrap)。

可选专用镜像及 Compose profile：

```sh
docker build -t lot-agent-app:1.0 .
docker build -f Dockerfile.media-analysis -t lot-agent-media-analysis:1.0 \
  --build-arg YTDLP_VERSION="$YTDLP_VERSION" --build-arg YTDLP_SHA256="$YTDLP_SHA256" .
docker compose --profile media-analysis up -d
```

镜像固定下载器版本并校验 SHA256，不在任务中自更新。发布时还应固定基础应用镜像摘要。**此可选镜像与 Linux bubblewrap 执行尚未在本次 macOS 环境验收**；目标主机必须允许非特权 user namespace 及所需 mount 操作，容器 seccomp/AppArmor 也可能阻止它们。不能用 privileged、挂载宿主根目录/Docker socket 或关闭隔离作为运行条件；不满足时保留 `SANDBOX_REQUIRED` / 隔离失败，先完成目标运行环境验收。

## 验证命令与未完成验收

```sh
pnpm test:marketing-analysis
pnpm check:marketing-analysis:media  # 实际 FFmpeg，只有自制夹具
pnpm check:marketing-analysis:db    # 需专用空本机数据库 URL
pnpm check:marketing-analysis:ui    # 需 PLAYWRIGHT_MODULE 和本机 Chrome
pnpm check:marketing-analysis:local-sandbox # macOS 实际文件/网络隔离与取消，无模型调用
```

数据库脚本要求 `MARKETING_ANALYSIS_CHECK_DATABASE_URL` 指向本机空的 `media_analysis_check_*` 库（需安装 pgvector），验证旧库迁移、幂等提交、用户隔离、无本地预算、租约、取消、未知请求、核对、调用去重、修订、自动回填与版本冲突、私有帧和清理。另设 `MARKETING_ANALYSIS_CHECK_REDIS_URL=redis://127.0.0.1:<临时端口>/15` 可验证真实 BullMQ 投递、同用户串行、跨进程取消及崩溃后不重发；该 Redis 库必须是专用空库。UI 脚本使用真实 React（包括 StrictMode）与拦截数据，不调用真实模型；覆盖纯文案/视频自动生成、刷新恢复、只读资料、上游余额不足、取消、未知请求、账号切换、中英文和暗色主题。

本次本机验证结果（2026-10-14）：

| 检查 | 结果 |
| --- | --- |
| 全量 `pnpm test` | 289 个测试文件通过、13 个跳过；2203 项通过、76 项跳过 |
| Core / Server / Web 构建 | 通过；Web 保留现有大 chunk 提示 |
| 实际 FFmpeg 合成视频 | VFR、旋转、起始偏移、局部变化、首尾帧及超长拒绝通过 |
| 临时 PostgreSQL + Redis | 迁移、鉴权、恢复、计量、修订、草稿引用、清理与队列检查通过 |
| 浏览器页面 | 中英文、暗色、刷新、校对冲突、显式应用及账号隔离通过 |
| 新增脚本的补充严格类型检查 | 新增代码错误已修复；仍有未改动的 `digital-employee/service.ts` 类型断言与 `jobs/bullmq-queue.ts` 两个 ioredis 版本冲突，共 3 处既有错误 |

上表为首轮离线与集成验证；其中没有真实模型调用。验证创建的 PG / Redis 容器仅存夹具数据，验收后删除。

自动创作流程补充验证：纯文案直接生成完整分镜、视频分析自动回填、刷新恢复、上游余额不足/取消/未知调用、JSONB 字段顺序变化后的回执复用、草稿版本冲突均已通过定向单测和夹具集成检查。临时 PostgreSQL 迁移及自动回填检查、简化页面与原有视频制作浏览器回归、Core/Server/Web 构建通过；未调用真实模型。严格服务端类型检查仍报告上表所列的 3 处既有错误。

随后使用用户提供的小红书视频进行本机真实测试：yt-dlp `2026.07.04`、FFmpeg `8.1.2` 下载并抽帧通过，视频 37.1 秒、720×1280、18,035,982 字节，产生 76 张候选帧，正式策略选中 76 张 OCR、48 张理解帧。首尾两帧先完成 4 次真实 Responses 调用（DeepSeek OCR 2 次、Kimi 多图 1 次和摘要 1 次），均有完成回执、请求 ID 和真实用量，合计输入 4,788 / 输出 1,202 token。该样本无需导入平台 Cookie。

随后在用户明确批准最多 85 次调用、按网关实际计费后，执行正式采样策略的完整探测：

| 阶段 | 实际调用 | 结果 | 输入 / 输出 token |
| --- | --- | --- | --- |
| DeepSeek OCR | 76 | 73 帧有效，3 帧已知失败 | 54,186 / 45,788 |
| Kimi 理解与摘要 | 8 批图片 + 1 次摘要 | 48 张图片、34 条观察、8 条摘要、14 条时间线；引用和时间范围校验通过 | 67,529 / 3,532 |
| 完整测试合计 | 85 | `completed_with_gaps`，所有调用均有用量与请求 ID | 121,715 / 49,320 |

失败帧分别为 17 秒、19 秒 OCR 达到 8,192 输出 token 但没有文字结果，以及 18 秒返回含未转义换行的 JSON。失败费用全部保留；没有重试这 3 帧或超出 85 次上限。换行兼容修复已用该真实回执离线重放验证，不新增请求。加上前述 4 次初探，累计 89 次实际调用，输入 126,503 / 输出 50,522 token；输入中包含 1,280 缓存 token，不能再次叠加。没有根据价格比例推算人民币账单。

首帧、9.5 秒和 24.5 秒的字幕抽查与画面一致，不能当作全片 OCR 准确率。完整结果已区分衬纸印刷文字与叠加字幕，时间线没有再把单张首帧延伸至整片。人工复核仍发现摘要“全程展示白切鸡”的绝对化表述与片尾另一道菜矛盾，模型还把一个缺失模型证据 ID 推断成一段未采样区间，营销解读数组为空。已进一步收紧运动描述、覆盖范围和营销推断提示词；**这轮提示词调整没有追加付费复测**，原始模型结果和回执保留，不能据此宣告语义质量验收通过。

本次修复后的定向回归 121 项通过、4 项默认跳过；其中 3 项 macOS 原生沙箱测试已另行显式运行并通过，实际样本 FFmpeg 解码抽帧也已运行。Core / Server 构建通过；补充严格类型检查仍只有上表所述 3 处既有错误。

本机验证脚本供操作者显式运行；本地开发 Worker 可通过上述开关复用同一隔离实现，**不是生产 Worker 在 macOS 上的自动回退**。`local-probe.ts` 使用 macOS `sandbox-exec`：子进程只能读写任务目录和读取必要系统/Homebrew 程序；下载器仅可连接本机任务代理，父进程仍使用生产出口的公网 IP 校验、固定解析和累计流量限制；解码器无网络权限。子进程不继承应用环境和模型凭证。实际测试已验证任务外文件读写拒绝、代理之外的连接拒绝、解码器网络拒绝及进程取消。它不能代替 Linux 命名空间和生产镜像验收。

```sh
# 将已授权链接保存到私有 source.txt；不把含访问 Token 的分享链接写入命令历史。
MARKETING_ANALYSIS_LOCAL_DIR="$PWD/data/marketing-analysis-probes/<run-name>" \
YTDLP_VERSION=2026.07.04 pnpm check:marketing-analysis:local download

# 显式付费：使用当前操作者 .env 的 OPENAI_API_KEY / OPENAI_BASE_URL。
# 默认均匀保留最多 6 张 OCR、6 张理解帧（最多 8 次调用）。
MARKETING_ANALYSIS_LOCAL_DIR="$PWD/data/marketing-analysis-probes/<run-name>" \
MARKETING_ANALYSIS_LOCAL_MODEL_CALLS=1 pnpm check:marketing-analysis:local analyze
```

可通过 `MARKETING_ANALYSIS_LOCAL_MAX_OCR`（2–120）和 `MARKETING_ANALYSIS_LOCAL_MAX_VISUAL`（2–48）显式设置帧数，实际调用上限为 `OCR 帧数 + ceil(理解帧数 / 6) + 1`，实际图片上限为两类帧数之和。调用仍保留原模型的最多 8,192 输出 token 限制。本机报告不猜测网关价格比例对应的人民币金额，也不写入生产用户计费表；费用由操作者网关账户实际扣除，真实用量和完成回执保存在私有文件。增加帧数前应确定授权的调用量和费用范围。

同一目录保留下载、抽帧和各参数组合的调用记录，文件锁防止并发执行；凭证、来源、参数或请求内容变化时拒绝错误复用，未知调用不自动重发。目录 `data/marketing-analysis`、`data/marketing-analysis-probes` 均已加入 `.gitignore`，不提交原片、图片、访问 Token 或原始回执。

本机完整探测遇到有真实用量的 OCR 失败后，可显式设置 `MARKETING_ANALYSIS_LOCAL_SKIP_FAILED_OCR=1`，保留这些失败回执和已发生费用，将对应帧记入 `omittedOcrFrameIds` / `MODEL_OCR_FAILED`，继续尚未执行的原定请求。不会重新调用失败帧，不提高原定调用或图片上限；报告为 `completed_with_gaps`。未知请求、未知费用、多图理解或摘要失败仍停止。生产流程现在默认保留已知 OCR 缺口并自动继续；此开关仅用于手工探测脚本。

真实探测另外运行：

```sh
# models 最多 5 次付费请求；仅使用指定用户的托管凭证。
MARKETING_ANALYSIS_PROBE_USER_ID=USER_ID MARKETING_ANALYSIS_PROBE_ID=UUID \
MARKETING_ANALYSIS_PROBE_PRICING='<与上文相同单位的已核实价格 JSON>' \
pnpm check:marketing-analysis:live models

# Linux 隔离下载；链接和 Cookie 从操作者指定的私有文件读取。
MARKETING_ANALYSIS_PROBE_USER_ID=USER_ID MARKETING_ANALYSIS_PROBE_ID=UUID \
MARKETING_ANALYSIS_PROBE_SOURCE_FILE=/private/path/share.txt \
MARKETING_ANALYSIS_PROBE_COOKIE_FILE=/private/path/cookies.txt \
pnpm check:marketing-analysis:live download
```

报告放在 `data/marketing-analysis-probes` 私有目录；重用同一个 probe ID 复用已完成调用并阻止未知调用重发，文件锁和用户 PG advisory lock 保护单次探测。探测脚本是操作员验证入口，不替代生产任务租约与调用去重。

待真实素材和测试账号到位后完成：每平台至少 5 条下载探测、最终每平台至少 10 条质量评测；两个模型的图像/顺序/JSON/用量兼容性；B 站单 P / cid；抖音和小红书 Cookie、挑战页、短链与 CDN；必要时再实现浏览器兜底；Linux 隔离与生产镜像、出口和分片限额实测。当前不承诺下载成功率、OCR 准确率、实际费用或 P50/P95。
