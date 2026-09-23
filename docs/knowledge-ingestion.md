# 本地知识入库与检索（S2 首版）

2026-09-23。文本 RAG 主链已实现并通过真实本地联调；完整 S2 验收尚未结束，见文末边界。

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

`KNOWLEDGE_QUEUE` 默认 `lot-knowledge`，禁止设为 `lot-tasks`；`KNOWLEDGE_CONCURRENCY` 默认 2，范围 1–8。原生成/记忆 Worker 保持原队列。所有消费者使用同一份代码、Node/ICU、模型路由配置和私有存储目录。`pnpm dev` 保留原启动集合，知识 Worker 用上面的独立命令启动。

前端侧栏新增“本地知识库”，原远程入口保留。可建库，上传 TXT/Markdown/PDF/DOCX 或粘贴笔记，查看状态，取消/重试，选择混合、关键词或语义检索，查看真实引用及复制摘录。上传完成后任务不依赖页面存活。当前面板一次检索一个明确选择的库。

## 模型、分段与计量

- 固定 `qwen3.7-text-embedding`、1024 维、cosine；向量归一化后保存。`OPENAI_BASE_URL` 是固定模型路由，不取平台环境 API Key。每次执行按 owner 从现有凭证机制读取有效 Key；先检查该 Key 的模型列表。
- 用户提供的 `qwen3-rerank` 留给设计中的 P1 重排序；当前 hybrid 是中文全文检索 + 精确 cosine + RRF。
- [官方接口规格](https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api/)规定该 embedding 默认 1024 维、每批最多 20 条。适配器校验数量、维度、索引顺序、非有限数和零向量。
- **尚未确认该模型对应的可离线 tokenizer**。当前 profile 明确标为 `provider-usage-per-chunk-v1`：以 512 UTF-8 字节、64 字节重叠产生候选，逐段请求，使用返回的真实 input usage 验证不超过 512 tokens。它不是“精确 tokenizer 切分”，也不会把字符/字节数记作计费 tokens；超过预算整次入库失败而不截断正文。待取得对应 tokenizer 后应建新 profile 并重建。
- `Intl.Segmenter('zh')` 负责中文词法，英文型号独立保留；ICU 版本纳入 immutable profile。查询和资料严格匹配 profile。ICU 字典存在将部分词拆成单字的情况，应继续做中文检索质量评测。
- 单文档解析最多 50 MiB、500 页、200 万字符、30 秒；Worker JS old heap 256 MiB + young heap 32 MiB，可终止。此限制**不是进程总 RSS 上限**。索引最多 2000 片段，超限明确失败；不静默丢弃尾部。
- 真实调用先持久化 `rag_embedding_charges` 回执，再按 TokenHub `/api/log/token` 的 request_id/model_name 匹配实际 quota，以 `/api/status` 的 quota_per_unit/exchange_rate 换算，事务写入既有 `usage_logs`，同一回执只计一次。
- 账单日志延迟或不可读时持久保留待对账回执，并以 `EMBEDDING_BILLING_PENDING` 阻止后续模型调用，不记为免费。后续重试先尝试对账。网关不返回 request_id 或旧日志已不可查询时，需要运营核对回执，不应清空账单以强行继续。当前没有独立后台对账定时器。
- 平台每日/月度限制使用每 512 字节 0.01 元的保守准入预算；**它不是模型价格**，实际费用始终以网关账单为准。TokenHub 自身余额/限额仍由网关执行。并发额度预占不在此版提供。
- 已完成片段存入运行 checkpoint；同 revision 重试可复用。无法消除“网关已收费但响应/本地落库丢失”窗口，任何实际重调仍需如实计费。

## 持久任务与发布

迁移 0025 增加 task.queue_name、rag_ingestion_runs 和 rag_outbox。新 revision/task/run/outbox 同事务提交；Redis 仅接收 task ID。dispatcher 稳定 ID 补投，Worker 用持久租约和 generation 防止重复执行、取消迟到及过期进程发布。发布事务检查当前代次/租约/未删除状态，写完整片段后才切 active revision。替换失败保留旧版可检索。

迁移 0026 添加 pgvector、immutable profiles、chunks、GIN 及账单回执；当前 schema 固定 `vector(1024)`。不同模型/路由/ICU profile 不混用，检测到不同 profile 时返回需重建。禁止在请求中自动 ALTER 维度。

同模型单资料重建命令会保留活动版本，创建新版本并排队（会使用资料所有者的 Key 计费）：

```sh
pnpm knowledge:reindex OWNER_UUID ITEM_UUID EXPECTED_VERSION
```

有 pending revision 时先处理该版本，命令不会覆盖并发编辑。维度迁移、全库 profile 灰度切换/回滚、历史对象和向量的保留期清理仍待实现；当前只撤销可见性，保留历史数据，不按文件年龄擅自删除。

## 管理 API 补充

均使用原有 Bearer 会话，与外部知识 Key 无关：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/rag/manage/status` | 功能状态 |
| POST | `/api/rag/manage/items/:id/retry` | `{version}`，新运行代次 |
| POST | `/api/tasks/:id/cancel` | 持久取消（按任务类型分流） |
| GET | `/api/tasks/:id` | 持久任务状态 |
| POST | `/api/rag/manage/retrieval` | 显式选库检索 |

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

设置以上两个功能开关为 1。server 执行迁移；knowledge-worker 等待 server healthcheck，检查 schema 26 后才领取任务。原 worker 不消费知识队列。

## 验证与剩余验收

```sh
pnpm run test:knowledge
pnpm run check:knowledge:integration --redis
# 显式计费：仅用于已获授权的最近登录账号；测试结束清理合成资料，保留用量。
pnpm run check:knowledge:live --live --latest-user
```

已验证：全项目 build；24 项现有 PG/Redis 集成测试；真实编译 Worker → embedding → pgvector → hybrid → 真实行号引用。普通全文测试 1363 通过、24 个 opt-in 集成测试跳过，3 个原有失败：uploads 的大小断言、0010 固定迁移列表、0020 固定末尾迁移断言。

完整 S2 仍需：精确模型 tokenizer、profile/维度迁移与回滚、文件原件替换/保留期清理、包含 S1 个人事实的全局搜索、浏览器/Electron/手机端到端及检索质量评测。UI 已构建通过，但不能以构建代替这些验收。S3 的 Agent 本地调用及外部知识 Key/API 尚未接入。
