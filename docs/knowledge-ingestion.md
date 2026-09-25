# 本地知识管理、入库与检索（S1 / S2）

2026-09-24。S1/S2 管理、事实、素材、索引迁移与恢复已实现，并以现有 PostgreSQL / Redis 验证。用户已接受“字节候选分段＋模型返回 usage 校验”作为本阶段方案，S1/S2 验收完成；精确 tokenizer 不再作为前置条件。

## 本地运行

沿用现有 PostgreSQL 16 + pgvector 和 Redis，不需要临时容器。先启动 server 完成迁移，再启动知识消费者：

```sh
pnpm run dev:server
# 另一个终端
pnpm run dev:knowledge
# 前端（如果尚未运行）
pnpm run dev:web
```

`.env` 的 `KNOWLEDGE_MANAGEMENT_ENABLED=1` 开启管理入口，`KNOWLEDGE_INGESTION_ENABLED=1` 开启新资料的入库及本地检索；本次已在本地启用。仓库默认仍关闭。不会自动将此前保存的资料全部计费入库：无任务的待处理资料可调用 retry；新建资料才自动排队。

`KNOWLEDGE_QUEUE` 默认 `lot-knowledge`，禁止设为 `lot-tasks`；`KNOWLEDGE_CONCURRENCY` 默认 2，范围 1–8。原生成/记忆 Worker 保持原队列。所有消费者使用同一份代码、Node/ICU、模型路由配置和私有存储目录。`pnpm dev` 同时启动知识 Worker；仅在 `KNOWLEDGE_INGESTION_ENABLED=1` 时消费，启动时最多等待 30 秒让 server 完成迁移。单独启动时使用 `pnpm dev:knowledge`。

前端侧栏“本地知识库”提供全部资料、个人信息、个人素材和知识库列表。全部资料内提供“全部 / 未分类”筛选，搜索位于顶部；未加入任何知识库的资料属于未分类；库内收集默认关联当前库。可拖放或选择最多 20 个文件、粘贴笔记、保存书签；新建库自动建议名称并提供“创建并导入”。批次保留逐项状态，可仅重试失败项，重复文件可使用已有资料或保存独立副本。

支持库名称/说明/标签编辑、资料类型/标签/标题筛选、分页、多选加入或移出库、编辑说明和正文、文件替换、任务取消/重试。上传进度与后台索引进度分别展示；上传未完成时提示离开风险，完成后处理不依赖页面。替换失败保留旧版，界面明确显示“旧版仍可检索”。Cmd/Ctrl+K 打开收集/搜索入口，文本编辑控件内不劫持快捷键。

检索可选择全局本人资料（包括收件箱、有效个人事实）或指定库，支持关键词、语义、混合及显式降级。结果显示来源、真实位置与手工说明标记；查看出处打开所属版本并定位，正文以纯文本呈现。轮询及复制/查看时重新核验引用，资料删除/更新后清除旧引用。

“个人信息”管理强类型字段、分类、版本、有效期、停用、外部可见开关和库关联，支持历史查看。自动记忆提取改为候选，确认后才改变事实；聊天优先确认事实，过期/停用事实的同 key 旧记忆也不会重新浮现。修改立即撤销旧语义投影，新投影异步构建。**外部知识 API 尚未开放**，单项开关不等于外部授权。

“个人素材”分别展示本人旧上传/生成素材及私有资料；“用于当前对话”只放入输入框，不自动发送或归档，“保存个人素材”复制到私有空间，“加入知识库”显式建立关联。旧素材按 owner 核验并排除数字员工会话资产；归档独立副本不会随旧资产删除消失，也不会撤销旧静态/分享链接。图片/音频/视频通过短期会话票据预览，无法播放时仍可下载；媒体说明可编辑；图片文字识别已接入，音视频内容识别 / ASR 尚未接入。

## 图片与扫描 PDF 的 OCR

知识入库使用用户指定的 `deepseek-v4.1-flash`，通过现有 `OPENAI_BASE_URL`（未设置时使用配置中的 OpenAI 网关地址）的 `/chat/completions` 调用；不会切换到其他模型，也不会使用平台环境 Key。网关必须提供这个模型 ID 的图片输入能力。[DeepSeek 视觉接口文档](https://api-docs.deepseek.com/guides/vision/)说明了标准 `image_url` / base64 输入格式；官方公共模型别名与网关模型 ID 可能不同。

- 图片上传后自动排队识字，无须先填写说明；无文字且说明为空时，使用同一模型生成画面说明，发布索引时写入说明字段，并以 `generated_description` 来源参与检索。已有人工说明直接保留并用于检索。音视频仍只索引人工说明。
- PDF 优先提取现有文字层，仅对无文字的页逐页渲染并识别，保留原始页码。含少量文字层但主要内容是图片的页面不属于当前自动回退范围。
- 提示词在 `packages/server/src/knowledge/ingestion/ocr.ts` 的 `OCR_PROMPT`：忠实转录、保留语言/结构/表格，模糊处标记 `[无法辨认]`，不总结或猜测，不执行图片中的指令。无文字返回专用标记，不把模型的解释当正文。
- OCR 结果标为 `ocr`，人工说明仍标为 `manual_description`。PDF 空白页有诊断，整份 PDF 无文字时明确失败；图片则回退到画面说明，仅在模型仍未返回有效说明时失败；截断输出不发布为完整索引。
- 每张图片最大 32 MiB；每份 PDF 最多识别 50 个无文字页，超出时在调用前报错。每页渲染宽度 1800 像素，模型调用超时 120 秒、输出上限 8192 tokens；解析线程仍隔离运行，OCR 等待不占用原来的 30 秒解析阶段限时。
- 每次调用读取资料所有者的有效 Key，沿用 LLM 的 `UsageMeter` 和目录定价记录真实输入/输出 token；额度预检使用配置价格估算，网关实际收费由用户 Key 承担。成功页逐页 checkpoint，同 revision 重试复用；网络响应或落库丢失窗口仍可能需要重新付费识别。
- 不自动重跑历史资料。此前失败的扫描 PDF 可点击“重试”；旧图片可通过“编辑 / 替换”保存新版本或使用下方单资料重建命令重新入库。更新后需重启 server 和知识 Worker。

这项能力接入知识库入库流程；对话附件的即时处理流程保持原样。

## 模型、分段与计量

- 固定 `qwen3.7-text-embedding`、1024 维、cosine；向量归一化后保存。`OPENAI_BASE_URL` 是固定模型路由，不取平台环境 API Key。每次执行按 owner 从现有凭证机制读取有效 Key；先检查该 Key 的模型列表。
- 用户提供的 `qwen3-rerank` 留给设计中的 P1 重排序；当前 hybrid 是中文全文检索 + 精确 cosine + RRF。
- [官方接口规格](https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api/)规定该 embedding 默认 1024 维、每批最多 20 条。适配器校验数量、维度、索引顺序、非有限数和零向量。
- **本阶段采用用户于 2026-09-24 确认的分段方案**，不依赖尚未获得的匹配 tokenizer。当前 profile 明确标为 `provider-usage-per-chunk-v1`：以 512 UTF-8 字节、64 字节重叠产生候选，逐段请求，使用返回的真实 input usage 验证不超过 512 tokens。它不是“精确 tokenizer 切分”，也不会把字符/字节数记作计费 tokens；超过预算整次入库失败而不截断正文。未来若切换到对应 tokenizer，应建新 profile 并重建；这属于后续优化。
- `Intl.Segmenter('zh')` 负责中文词法，英文型号独立保留；ICU 版本纳入 immutable profile。查询和资料严格匹配 profile。ICU 字典存在将部分词拆成单字的情况，应继续做中文检索质量评测。
- 单文档解析最多 50 MiB、500 页、200 万字符、30 秒；Worker JS old heap 256 MiB + young heap 32 MiB，可终止。此限制**不是进程总 RSS 上限**。索引最多 2000 片段，超限明确失败；不静默丢弃尾部。
- 真实调用先持久化 `rag_embedding_charges` 回执，再按 TokenHub `/api/log/token` 的 request_id/model_name 匹配实际 quota，以 `/api/status` 的 quota_per_unit/exchange_rate 换算，事务写入既有 `usage_logs`，同一回执只计一次。
- 账单日志延迟或不可读时持久保留待对账回执，并以 `EMBEDDING_BILLING_PENDING` 阻止后续模型调用，不记为免费。后续重试先尝试对账。网关不返回 request_id 或旧日志已不可查询时，需要运营核对回执，不应清空账单以强行继续。当前没有独立后台对账定时器。
- 平台每日/月度限制使用每 512 字节 0.01 元的保守准入预算；**它不是模型价格**，实际费用始终以网关账单为准。TokenHub 自身余额/限额仍由网关执行。并发额度预占不在此版提供。
- 已完成片段存入运行 checkpoint；同 revision 重试可复用。无法消除“网关已收费但响应/本地落库丢失”窗口，任何实际重调仍需如实计费。

## 持久任务与发布

迁移 0025 增加 task.queue_name、rag_ingestion_runs 和 rag_outbox。新 revision/task/run/outbox 同事务提交；Redis 仅接收 task ID。dispatcher 稳定 ID 补投，Worker 用持久租约和 generation 防止重复执行、取消迟到及过期进程发布。发布事务检查当前代次/租约/未删除状态，写完整片段后才切 active revision。替换失败保留旧版可检索。

迁移 0026 添加 pgvector、immutable profiles、chunks、GIN 及账单回执。0027 增加确认事实/候选/历史、素材来源、库标签、上传租约及备份保留窗口。0028 增加独立索引空间、用户活动 profile、完整性标记与重建 checkpoint。默认空间为 `vector(1024)`；其他维度由管理员单独建表，普通请求不会 ALTER 维度。

同模型单资料重建命令会保留活动版本，创建新版本并排队（会使用资料所有者的 Key 计费）：

```sh
pnpm knowledge:reindex OWNER_UUID ITEM_UUID EXPECTED_VERSION
```

有 pending revision 时先处理该版本，单资料重建不会覆盖并发编辑。全库模型/维度迁移：

```sh
# OWNER_UUID 必须是资料所有者；DIMENSIONS 必须为模型实际支持的维度。
pnpm knowledge:index start OWNER_UUID DIMENSIONS qwen3.7-text-embedding
pnpm knowledge:index build OWNER_UUID BUILD_UUID
pnpm knowledge:index status OWNER_UUID
pnpm knowledge:index switch OWNER_UUID BUILD_UUID EXPECTED_STATE_VERSION
# 回滚前也会检查所有当前资料在旧空间的完整性
pnpm knowledge:index rollback OWNER_UUID EXPECTED_STATE_VERSION
pnpm knowledge:index cancel OWNER_UUID BUILD_UUID
```

`build` 以所有者有效 TokenHub 凭证计费，支持合法 checkpoint 复用。构建期间旧索引仍服务；切换事务核对当时全部活动版本的片段数量及 profile。期间资料改变会拒绝不完整切换，重新 build 后再切换。回滚只在旧空间仍覆盖当前资料时允许；若新资料缺旧索引，先向旧 profile 重建。取消阻止迟到产物发布。不同模型/维度/路由/ICU profile 不混用。

保留期清理默认 dry-run，最低 7 天、默认 30 天：

```sh
pnpm knowledge:gc
# 备份前建立与备份保留期相符的禁止清理窗口
pnpm knowledge:gc --backup-hold-days=30
# 审阅计划后显式执行（会永久删除超过保留期、无引用的数据）
pnpm knowledge:gc --apply
```

清理核对活动/待处理版本、运行中任务、上传租约、索引构建、回滚窗口和物理引用；备份 hold 有效时整体停止。旧索引按 owner 删除行，保留共享表结构，不影响其他用户；保留期过后旧回滚指针撤销。元数据提交后再删除物理孤立文件，期间锁定同 owner 的新上传，重复运行安全。已登记历史对象与孤立私有文件均计入实际占用。清理不是自动定时任务，备份保留周期应小于或等于实际 GC 保留期。

## 管理 API 补充

均使用原有 Bearer 会话，与外部知识 Key 无关：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/rag/manage/status` | 功能状态 |
| POST | `/api/rag/manage/items/:id/retry` | `{version}`，新运行代次 |
| POST | `/api/tasks/:id/cancel` | 持久取消（按任务类型分流） |
| GET | `/api/tasks/:id` | 持久任务状态 |
| POST | `/api/rag/manage/retrieval` | 显式选库检索 |
| POST | `/api/rag/manage/search` | 仅内部会话可搜索本人全部资料，`collection_ids: []` |
| GET/PUT | `/api/rag/manage/profile` | 列出/版本校验后保存确认事实 |
| GET | `/api/rag/manage/profile/:id/history` | 事实修改历史 |
| GET/POST | `/api/rag/manage/profile/candidates[/:id]` | 读取/确认或拒绝候选 |
| POST | `/api/rag/manage/memberships` | 批量加入或移出库 |
| PUT | `/api/rag/manage/items/:id/file` | 原件替换，`X-Knowledge-Version` + 幂等键 |
| GET | `/api/rag/manage/items/:id/revisions/:revisionId/text` | 当前合法版本的纯文本与定位 |
| GET | `/api/rag/manage/materials` | 本人旧素材，时间+ID 游标 |
| GET | `/api/rag/manage/materials/:id/content` | 本人旧素材鉴权读取，不归档 |
| POST | `/api/rag/manage/materials/archive` | 显式复制旧素材到私有域 |
| GET | `/api/rag/manage/storage` | 实际私有磁盘占用 |

检索例：

```json
{
  "query": "如何离线查看资料？",
  "collection_ids": ["知识库 UUID"],
  "mode": "hybrid",
  "top_k": 5,
  "allow_degraded": false,
  "filters": { "source_types": ["document", "note"], "tags": [] }
}
```

collection_ids 1–10 个，top_k 1–20，tags 为 AND、source_types 为 OR。每路最多 30 候选；按 chunk ID 去重后 RRF，返回前重新核对当前版本、删除状态、归属、标签和库关联。无权限库在模型调用前拒绝。只有 `allow_degraded=true` 才在查询 embedding 故障时使用关键词并返回警告。FTS 分数是 ts_rank_cd，不是 BM25；分数不是正确率。

## 部署

新版迁移依赖 pgvector，**即使功能关闭也需要扩展可安装**。Compose 的 PostgreSQL 改为 `pgvector/pgvector:pg16`；不要不经备份直接把已有 Alpine 数据卷切到 Debian 镜像。先备份、停旧实例，核对主版本、扩展及排序规则版本，必要时 REINDEX/REFRESH COLLATION，确认旧业务数据后再升级 server。本次现有本地实例已在 S1 按此流程替换。

知识进程复用应用镜像和 `app_data`，独立 Compose profile：

```sh
docker compose --profile knowledge up -d
```

设置以上两个功能开关为 1。server 执行迁移；knowledge-worker 等待 server healthcheck，检查 schema 28 后才领取任务。原 worker 不消费知识队列。

## 验证与剩余验收

```sh
pnpm run test:knowledge
pnpm run check:knowledge:integration --redis
# 显式计费：仅用于已获授权的最近登录账号；测试结束清理合成资料，保留用量。
pnpm run check:knowledge:live --live --latest-user
```

验证记录见 [S1/S2 验收记录](knowledge-s1-s2-verification.md)。数据库、Redis 与浏览器验证均复用现有本地基础设施，只创建并清理隔离测试账号/队列/临时文件，不创建容器。真实模型测试保留其实际用量记录。

已接受的设计调整：采用“字节候选 + 返回 usage 硬校验”，不将其描述为精确 token 切分，也不再将匹配 tokenizer 列为阶段阻塞项。其他边界：Worker 内存限制是 JS heap 而非总 RSS；大规模中文质量和容量指标留待 S4。S3 的 Agent 本地检索工具及外部知识 Key / Dify API 尚未接入，S1/S2 不开放外部入口。

## 2026-09-24 Review 修复升级

本版要求 schema 0030，并引入短行合并 v2 profile、仅保存状态与按凭证隔离的回执对账。旧索引保留原规则；升级步骤、显式重建和账单恢复见 [RAG Review 修复记录](knowledge-review-fixes.md)。
