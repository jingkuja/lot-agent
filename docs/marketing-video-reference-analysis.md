# 参考视频分析：实现与验证

2026-10-14。按[开发方案](marketing-video-reference-analysis-plan.md)实现 Responses 接入、持久化分析任务、独立 Worker、抽帧/OCR/多图摘要和工作台入口。用户提供的一条小红书视频已在本机完成下载、解码及 85 次完整模型测试，得到含 3 帧 OCR 缺口的摘要与时间线。**三平台下载成功率、批量质量评测、生产 Linux 隔离环境仍待验收**。默认 `MARKETING_ANALYSIS_ENABLED=0`，不能把单样本结果当作三平台已经交付验收。

## 协议与入口

- `core/llm/responses.ts` 实现 OpenAI Responses：`POST <baseUrl>/responses`、`input_text` / `input_image`、流式文本与推理摘要、函数调用/返回、结构化文本格式、终态和用量。Base URL 需包含 `/v1`，提供器不重复拼接。
- `OPENAI_PROTOCOL=responses` 或 `llm.openai.protocol` 设置默认协议；`modelCatalog.llmProtocols` 的模型级配置优先。目前 `deepseek-v4.1-flash`、`kimi-k3` 使用 Responses。其他模型保留 Chat Completions 默认配置。Core registry、用户提供器及普通 Worker 都读取协议配置。
- 使用 `store:false` 和 `reasoning.encrypted_content`，同一 Agent 推理轮中的工具续调保留提供器输出项；上下文预算包含这些项。状态只在当前运行内传递，不能由客户端提交或跨模型复用。
- Responses SDK 关闭自动重试；完整终态之前不执行函数调用。截断、拒答、错误及流提前结束不会成为可执行工具结果。工具仍经过原有 schema、服务端白名单、归属和沙箱检查。
- 参考分析始终使用当前用户的托管网关 Key 和用户可用模型目录，不回退到平台共享 Key。现有知识库的独立文档 OCR HTTP 路径保持原协议。

协议依据：[Responses 迁移指南](https://developers.openai.com/api/docs/guides/migrate-to-responses)、[流式事件](https://developers.openai.com/api/docs/guides/streaming-responses)。兼容网关是否支持全部可选字段仍需真实探测；分析调用当前用提示词约束 JSON，并做服务端 schema 校验，不强制可选 JSON 模式。

## 可选视频语音转写

参考视频拆解使用固定模型 `qwen-audio-3.1-asr-flash`。当前用户模型目录的 `llm`、`asr` 或 `audio` 分组包含该 ID 才会转写；没有模型（或网关明确返回模型不存在）则保存跳过原因，页面提示并继续画面/文字分析。仍沿用当前用户凭证与现有网关 Base URL，不配置独立共享 Key，不切换其他 ASR 模型。2026-10-15 真实网关将该模型放在 `audio` 分组，现已保留并识别此分组，避免错误跳过。

`marketing-analysis/speech.ts` 在现有无网络解码沙箱中读取私有原片，转成最长 180 秒、16 kHz、单声道 PCM WAV。请求为 `POST <baseUrl>/chat/completions`，按用户提供的协议使用 `input.messages[].content[].input_audio.data`、`parameters.format="wav"` 与 `parameters.sample_rate="16000"`；音频使用 `PUBLIC_BASE_URL` 拼接 `/api/public/marketing-analysis-audio/<token>` 的公网 URL。`audio-url.ts` 用 `SECRET_MASTER_KEY` 加密包含任务归属、内容哈希和十分钟有效期的访问凭证；API 校验后只返回该任务的私有 WAV，请求结束即删除临时文件。API 和媒体 Worker 必须共享私有数据卷与主密钥，且 PUBLIC_BASE_URL 必须从模型网关可达。转写取 `choices[0].message.content`，保存响应 ID、实际 token 用量；完成状态必须为 `stop`，中断/未知用量不自动重发。

转写保存在既有 snapshot JSONB 的 `speech` 字段，页面“查看参考资料”可展开原文；成功转写参与摘要和文案/分镜生成。`a0001` 是整段原声证据，只允许摘要和营销解读引用，不编造逐字时间戳。没有音轨时同样提示跳过；已有完成记录不自动补做付费 ASR。临时 WAV 在转写请求结束后删除，原片保持现有私有存储与清理策略。

ASR 使用覆盖请求与正文的 180 秒总期限，显式中断不响应 signal 的等待；用户取消、租约丢失和 shutdown 同样退出，清理响应流不延长等待。已提交但未得到确定回执的调用保存为 unknown，不自动重发。主结果旁直接展示 OCR 缺口和音频缺口；空转写只表示未识别到语音，下载文件无音轨只描述当前文件，均不证明原视频无声音。下载器回退纯视频时尚不补取独立音轨。

验证：协议、实际用量解析、模型缺失/无音轨、用户隔离、取消、未知请求不重发与证据校验均有离线测试。2026-10-15 使用用户提供的 localhost:4000 网关和 `https://todoucloud.com/2.wav` 实际调用一次成功：文本“测试录音设备，进入网站。”，输入 173 / 输出 7 tokens，响应 ID `828cc2f2-6d3f-9d34-88cd-f00ac0bc3d01`。未将 Key 写入文件或日志。样例联调将 PUBLIC_BASE_URL 临时设为 `https://todoucloud.com`，没有改动环境文件；新增临时音频路由需随 API 一起部署，不能将样例 URL 的成功当作生产反向代理已验收。

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

本地爆款视频通过鉴权的 `POST /uploads` 接收 multipart `file` 和 UUID `clientRequestId`，只接受 MP4 / MOV / WebM，正文上限 101 MiB、文件上限 100 MiB，并校验 MIME 和容器签名。迁移 **0045** 保存上传归属、原文件名、哈希及过期状态。文件位于 `data/marketing-analysis/<owner hash>/uploads/<upload UUID>`，与分析任务隔离且不公开挂载；容量预检涵盖未分析的上传。草稿保存 `referenceUpload: {id,name}`，它不作为视频生成素材使用。创建分析传 `uploadId`（与 `shareText` 互斥）；Worker 校验归属、单一常规文件及 SHA-256 后复制到任务目录，沿用无网络解码沙箱校验真实时长 ≤180 秒、分辨率 ≤1080p，再进入相同 OCR / ASR / 摘要 / 创作链路。上传及分析请求均幂等，刷新不重新发起模型调用。替换/移除来源会清理旧的草稿分析引用；上传满七天且无活动分析时回收原文件，过期后重新分析需重新上传。

平台适配接受三平台的单视频长链/短链，保留 B 站选定 `p` 和小红书必要访问参数；拒绝主页、合集、直播、多个链接、图文和超过 180 秒的媒体。B 站提取器的实际单 P / cid 及登录会话兼容性仍需真链核对；浏览器兜底仅用于抖音。

下载错误区分明确登录要求（`AUTH_REQUIRED`）、浏览器会话缺失（`PLATFORM_SESSION_REQUIRED`）和访问拒绝（`PLATFORM_ACCESS_DENIED`）。抖音提取器的 `Fresh cookies (not necessarily logged in) are needed` 只说明需要有效浏览器会话，不能据此认定视频必须登录；单独的 HTTP 403 也不作为登录证据。

2026-10-16 线上诊断确认详情接口返回 `ArgusSecurityPlugin Signature Not Found`。Linux 媒体镜像为规范化抖音链接单独使用固定的 `yt-dlp-douyin`，将已审查的 [上游 PR #17826](https://github.com/yt-dlp/yt-dlp/pull/17826) 应用到官方 `2026.08.19` portable zipapp；源包、补丁与变更前后提取器均校验 SHA256。该 PR 尚未合并，不能表述为官方已发布修复。构建与更新约束见 [固定抖音提取器补丁](../deploy/yt-dlp/README.md)。原版可执行文件及 `YTDLP_SHA256` 不变，其他平台和浏览器白名单元数据下载继续使用原版；原有沙箱、HTTPS 出口、用户 Cookie 归属及取消不变。

抖音元数据读取遇到上述会话缺失/访问拒绝时，`download.ts → douyin-browser.ts` 自动尝试一次全新的匿名 Chromium 会话，最多 45 秒。可关闭的登录推广面板不作为访问限制；只读取公开页面中播放器实际加载的 HTTPS `*.douyinvod.com` 地址，要求 URL 的 `__vid` 与最终页面视频 ID 一致，并校验时长和尺寸。父进程生成白名单元数据，通过私有 `browser-source.json` 和 yt-dlp `--load-info-json` 下载，避免再次进入需要 Cookie 的提取器。页面验证码、明确登录要求、取消、网络拒绝和其他平台不会触发此兜底；没有验证码自动处理。匿名页面仍无法获取媒体时返回 `BROWSER_READ_FAILED`，缺少浏览器返回 `BROWSER_UNAVAILABLE`，不误报必须登录。用户仍可选择“上传本地爆款视频”继续。

浏览器通过 `browser-pipe.ts` 使用私有 FD 3/4 通信，不开放调试端口、不复用用户浏览器配置或平台 Cookie。Linux 在独立 bubblewrap 命名空间中使用空工作目录和 256 MiB 临时文件系统，macOS 使用独立临时目录及 `sandbox-exec`；浏览器进程不接收应用凭据。浏览器后台明文 HTTP 请求无可用代理端点，页面图片/字体请求被拦截，HTTPS 页面和视频共用原有公网校验及 100 MiB 累计流量限制，连接数有界为最多 64。取消/超时终止进程组并清理临时配置；媒体下载后删除私有 URL 元数据。浏览器允许 JavaScript 执行网页，yt-dlp 自身仍禁用 JS runtimes。

下载器固定版本、固定参数，禁用插件、用户配置、JS runtimes、远程组件、外部下载器。优先选择含音轨的有界视频流，若无合并流则沿用视频流；当前不额外下载独立音轨，无音轨时页面提示并仅分析画面。下载进程在独立 Linux 网络命名空间内，只能通过任务专属 Unix socket 和 HTTPS CONNECT 代理出网；解析并固定公网 IPv4 地址，拒绝内网、保留网段和其他端口，所有连接累计限制 100 MiB。

小红书提取器在真实样本中给出明文 HTTP 的 `*.xhscdn.com` 媒体地址；固定下载参数仅将该 CDN 的 URL 升级为 HTTPS，仍由同一个出口代理校验。其他明文 HTTP 请求继续拒绝，并记录 `NETWORK_BLOCKED`，避免被误判成需要登录。

`sandbox.ts` 使用 bubblewrap 的用户、PID、网络、IPC 等命名空间，挂载只读程序和任务目录；FFmpeg / ffprobe 无出口 socket，只能读取本地签名校验后的容器。限制进程 CPU、地址空间、文件大小、文件数、输出和运行时间；媒体 Worker 容器另限内存、CPU 与 PID 数。缺少 Linux / bwrap / namespace 权限时失败关闭，**没有无沙箱回退**。父进程持有模型和数据库凭据，不传给下载器或解码器。

Apple Silicon macOS 本地开发可显式设置 `MARKETING_ANALYSIS_MACOS_SANDBOX=1`，由 Worker 的 `media-runtime.ts` 同时为下载和抽帧选择 `local-probe.ts` 中的 `sandbox-exec` 实现。开关默认关闭，`NODE_ENV=production` 或非 macOS 平台拒绝启用；缺少依赖/沙箱权限时仍失败，不执行无隔离子进程。运行时仅由 Worker 配置决定，HTTP 请求不能选择执行器。

抽帧保留实际源 PTS、timebase、旋转后尺寸、归一化时间及源文件哈希。约 2 Hz、首尾补帧、局部分区灰度差分和 5 秒周期覆盖；最多 361 候选、120 OCR 图片、48 多图图片、每批 6 张。达到预算时记录遗漏候选和限制，不标记为“完整字幕”。实际 VFR、起始偏移与旋转由合成视频测试覆盖；包含起始 PTS 为 190 秒、实际仅 2 秒的 WebM，时长限制不把容器起始偏移算成视频内容。

OCR 只合并相邻一致文字；空结果、漏识别或价格/否定词变化保留边界。修订保留机器原文，已有摘要失效；校对后的继续只使用当前证据生成摘要，不重做付费 OCR。分段观察按时间输入图片，综合使用文字和已发送给模型的证据 ID，验证引用、时间范围、长度和数量，并按实际 ASR 状态区分原声转写与未分析声音。时间线端点不得超出所引证据的最早/最晚观察时间 500ms，防止单张首帧被扩展成整条视频。模型提示词要求区分叠加字幕和物体上的印刷文字。

原片和帧位于 `data/marketing-analysis/<owner hash>/<analysis UUID>`，不挂 `/static`。帧读取经过用户鉴权、固定对象名、无符号链接/硬链接及文件大小检查。Worker 每分钟清理已删除分析及满 7 天且已停止的原片，保留帧与结果直到删除；项目引用或未核实用量阻止删除。平台 Cookie 按用户和平台加密保存，撤销只影响之后的任务，已经启动的下载最多持有本次任务副本。

## API 与工作台

所有接口都位于 `/api/marketing-video-analyses`，要求登录；身份从认证中获取。错误只返回有限错误码，不返回来源 Token、Cookie、模型请求体或上游原始错误。

| 接口 | 行为 |
| --- | --- |
| `GET /capabilities` | 是否启用、时长与平台 |
| `POST /uploads` | multipart `{file,clientRequestId}`，幂等私有上传，返回 `{id,name}`，201 |
| `POST /` | `{shareText?,uploadId?,clientRequestId,target?:{projectId,projectVersion,locale}}`，两个来源字段二选一，幂等创建并关联草稿，202 |
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

本地上传同样依赖 `MARKETING_ANALYSIS_ENABLED=1`、迁移 0045、运行中的媒体分析 Worker、共享私有数据卷及隔离 FFmpeg / FFprobe；仅省去平台下载，不绕过模型可用性或沙箱检查。ASR 仍按上文要求配置 `PUBLIC_BASE_URL`。现有 Nginx 全局 `client_max_body_size 155m` 可覆盖该上传请求，HTTP 入口复用上传限流。先升级 API 执行迁移，再启动新版媒体 Worker。

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

Apple Silicon Mac 本地开发在 `.env` 另加 `MARKETING_ANALYSIS_MACOS_SANDBOX=1`，并确保 `/usr/bin/sandbox-exec` 和 `/opt/homebrew/bin/` 下的 `yt-dlp`、`ffmpeg`、`ffprobe`、`python3` 可用，`YTDLP_VERSION` 与安装版本一致。抖音匿名网页兜底另需 `/Applications/Google Chrome.app`，只启动临时配置，不读取用户已登录浏览器。修改后重启 `pnpm dev`（或单独重启媒体 Worker）。此前因 `SANDBOX_REQUIRED` 失败的任务由用户点击“继续生成”恢复，不自动重试付费调用。生产部署保持此开关关闭；Docker Compose 不传入这个本地开发开关。

Linux 部署需要 `/usr/bin/bwrap`、`ffmpeg`、`ffprobe`、`prlimit`、`python3`、`chromium` 和 `/usr/local/bin/yt-dlp`。Python 仅运行隔离环境中的本地出口桥，不是独立服务。新增浏览器依赖后须重建 `Dockerfile.media-analysis` 镜像，不能只重启旧镜像。下载器源码/发行包参考 [yt-dlp](https://github.com/yt-dlp/yt-dlp)，隔离机制参考 [bubblewrap](https://github.com/containers/bubblewrap)。

Debian Chromium 在沙箱内直接运行 `/usr/lib/chromium/chromium`，避免 `/usr/bin/chromium` 包装脚本读取未挂载的 `/etc/chromium.d`。Linux 不使用 `--disable-crashpad-for-testing`；HOME 和缓存目录固定在沙箱的 `/tmp` 中。媒体容器默认两任务并发时使用 `pids_limit: 512`，原 128 上限会令浏览器和出口桥无法创建线程。已有服务器须在保留 seccomp / AppArmor 等策略的前提下更新镜像标签与这一资源限制；普通 `restart` 不应用它们。

可选专用镜像及 Compose profile：

```sh
docker build -t lot-agent-app:1.0 .
docker build -f Dockerfile.media-analysis -t lot-agent-media-analysis:1.0 \
  --build-arg YTDLP_VERSION="$YTDLP_VERSION" --build-arg YTDLP_SHA256="$YTDLP_SHA256" .
docker compose --profile media-analysis up -d
```

镜像固定下载器版本并校验 SHA256，不在任务中自更新。发布时还应固定基础应用镜像摘要。**2026-10-16 已在 Ubuntu 22.04 / amd64 完成 Linux 沙箱与媒体工具链验收**，见[实测记录](marketing-video-server-deployment-20261016.md)。新服务器须按[首次部署指南](marketing-video-new-server-deployment.md)准备宿主机策略并重新预检；目标主机必须允许非特权 user namespace 及所需 mount 操作，容器 seccomp/AppArmor 也可能阻止它们。不能用 privileged、挂载宿主根目录/Docker socket 或关闭隔离作为运行条件；不满足时保留 `SANDBOX_REQUIRED` / 隔离失败，先完成目标运行环境验收。

## 验证命令与未完成验收

Ubuntu / Docker 出现 namespace 或 mount 拒绝时，按
[媒体 Worker 专用安全策略](../deploy/security/README.md)安装并验证 seccomp / AppArmor
策略。先在无业务数据的测试容器验证，再重建媒体 Worker；不关闭 seccomp / AppArmor。
嵌套 proc 挂载所需的 `systempaths=unconfined` 必须与 v2 AppArmor 配套使用。

```sh
pnpm test:marketing-analysis
pnpm check:marketing-analysis:media  # 实际 FFmpeg，只有自制夹具
pnpm check:marketing-analysis:db    # 需专用空本机数据库 URL
pnpm check:marketing-analysis:ui    # 需 PLAYWRIGHT_MODULE 和本机 Chrome
pnpm check:marketing-analysis:audio-url # 经 PUBLIC_BASE_URL 校验短时 WAV、哈希和删除后 404，无模型调用
pnpm check:marketing-analysis:local-sandbox # macOS 实际文件/网络隔离与取消，无模型调用
```

2026-10-15 补充真实验收见[公网音频、Linux 与小红书 ASR 验收记录](marketing-video-live-acceptance.md)。本机探测按 `download → speech → analyze` 执行：`speech` 使用当前操作员凭证和持久化单次账本，先检查公网 WAV 哈希再提交 ASR；`analyze` 将同源 `asr/result.json` 中的语音加入摘要，并把语音哈希加入独立探测上下文。不得给已有视觉调用的旧探测目录补写语音后继续；输入变更会拒绝复用。原片链接、语音和回执仅存于 Git 忽略的私有探测目录。

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

2026-10-16 抖音匿名兜底本机实测：用户短链 `https://v.douyin.com/Opl7-ZVVzec/` 在不导入 Cookie、不登录的独立 Chrome 会话中完成下载，视频 ID `7658289800398589193`，58.2 秒、576×1024、8,139,173 字节，FFprobe 确认音视频双轨，隔离抽帧产出 118 张候选帧。此检查未调用付费模型，不代表所有抖音视频都可匿名访问。

待真实素材和测试账号到位后完成：每平台至少 5 条下载探测、最终每平台至少 10 条质量评测；两个模型的图像/顺序/JSON/用量兼容性；B 站单 P / cid；抖音和小红书 Cookie、挑战页、短链与 CDN；新增 Chromium 的生产镜像与出口限额验收。当前不承诺下载成功率、OCR 准确率、实际费用或 P50/P95。
