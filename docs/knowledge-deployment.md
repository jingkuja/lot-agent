# 内置知识服务部署与容量（2026-09-24）

## 发布与升级

沿用 server、worker、web、PostgreSQL、Redis。知识 worker 使用同一个服务镜像、独立 `lot-knowledge` 队列；不要把知识队列配置为旧 `lot-tasks`。本次只构建和演练本地环境，没有向生产发布。

1. 按 [备份手册](knowledge-backup-restore.md) 备份业务库及原件，并单独安全保存 `.env`、`config/local.json`、当前镜像摘要和 Compose 配置。禁止将秘密提交仓库。
2. PostgreSQL 保持主版本 16。现有测试容器已使用 `pgvector/pgvector:pg16`，实际 PG 16.15 / vector 0.8.6。生产应固定验证后的镜像摘要；不能用替换镜像直接跨 PG 主版本升级。原 PG 数据卷必须保留。
3. `pnpm install --frozen-lockfile`、`pnpm build`；或构建 `Dockerfile` 和 `Dockerfile.web`。知识目录为持久化 `data/knowledge`，与现有 assets/documents/uploads 同属 data 卷。备份不在公开静态路由内。
4. 先启动 server，完成既有迁移器到 29；随后启动普通 worker 和知识 worker。知识 worker 显式拒绝 schema 23/28，迁移失败不能先消费。Compose 使用 `docker compose --profile knowledge up -d`；先确认 server 迁移完成。开发使用 `pnpm dev:knowledge`。
5. 先开启管理、导入，验证索引 profile 和当前用户模型能力；需要外部接入才开启外部开关并创建最小范围知识 Key。检查健康状态、队列、用量与日志后开放流量。

配置：`KNOWLEDGE_MANAGEMENT_ENABLED=1`、`KNOWLEDGE_INGESTION_ENABLED=1`；外部默认 `KNOWLEDGE_EXTERNAL_ENABLED=0`。队列默认 `lot-knowledge`，知识并发 2，`KNOWLEDGE_PG_POOL_MAX=4`（允许 2–32）；连接总预算需同时计算 server、普通 worker 和知识 worker。解析隔离、文件数量/大小/超时限制见 [导入手册](knowledge-ingestion.md)，不能通过盲目加并发绕过。

使用每位用户的 TokenHub 凭证，模型 `qwen3.7-text-embedding`、1024 维。模型能力/价格元数据仅缓存 30 秒，并按用户、路由和凭证哈希隔离；余额检查与实际记账仍每次执行。并发账单查询最多合并 500ms；未取得账单仍失败关闭。密钥、凭证、原文及预览票据不要写入访问日志，生产关闭 DEBUG_LLM。

## 支持范围与代理

TXT/Markdown/PDF/DOCX、笔记和媒体说明可索引。图片/音频/视频支持私有保存、预览和 Range；没有把 OCR、ASR 或视频画面理解算作已实现。向量分段采用 UTF-8 保守预算，并以提供方真实 token 用量核验；没有声称使用模型专属 tokenizer。rerank 属后续可选优化。

Nginx 管理上传/替换均允许 200m，请求不缓冲；SSE 保持流式。镜像构建执行 `nginx -t`。Electron 使用现有本地反向代理传递认证、查询串、Range 和错误状态；实际 main/preload 的 UI 自动化已通过。预览票据不能当永久分享链接。外部契约见 [OpenAPI](knowledge-openapi.json) 和 [接入说明](knowledge-external-api.md)。Dify 已从范围剥离；Lot Bot 交付接口文档，没有实际消费方部署联调。

## 容量及运行版本

[实测报告](knowledge-retrieval-evaluation.md) 的 2 秒目标范围为约 1 万片段/并发 5，或约 10 万片段/并发 1。10 万片段/并发 5 的精确向量扫描 P95 达 2.6–2.7 秒，不承诺 2 秒 SLA。外部每 Key 60 次/分钟、5 并发；还受用户 TokenHub 配额约束。扩大部署前按目标硬件重测，再决定 HNSW。

实测 macOS arm64、M4 Max、36 GiB、Node 22.14.0；Docker 应用镜像基于 Node 20。中文分词 profile 包含 ICU 指纹，换 Node/ICU/模型/分段配置后必须核对 profile，并使用重建/激活工具迁移索引，不能默认为旧向量兼容。测试没有把 macOS 性能数值当成生产容器 SLA。
