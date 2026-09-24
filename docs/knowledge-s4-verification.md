# S4 完成与验收记录

2026-09-24。S3 遗漏项已补齐，S4 在约定的本地交付范围完成：不含生产发布、Dify、Lot Bot 仓库实施或旧系统数据切换。

## 实施

- S3：补做真实 LLM 聊天端到端验证；知识 worker schema 门槛改为 29，防止仍按 28 启动后写入新计费字段失败；Compose 补齐外部 API 开关。
- S4-01：冻结 50 文档/100 问题，真实向量评测、关键词/语义/混合基线、1 万/10 万片段和并发 1/5 的原始性能样本。混合 Recall@5 100%、引用定位正确率 100%、越权泄漏 0。数据是自制合成集，不代表生产泛化保证。[评测报告](knowledge-retrieval-evaluation.md)
- S4-02：知识 worker 独立可配置连接池，镜像持久化目录、Nginx 替换上传限额和构建期语法检查、Electron 转发回归；PG 16 同主版本升级与 schema 门槛演练。[部署说明](knowledge-deployment.md)
- S4-03：完整共享库一致快照、GC 保护、原件/旧资产校验、独立空库恢复工具和实际演练；已有 PG 重启后数据持久。恢复不自动启动模型任务。[恢复与回退](knowledge-backup-restore.md)
- S4-04：真实聊天、真实向量/HTTP、Chrome/Electron UI、旧业务测试、干净目录按锁安装构建测试、两个 Docker 发布镜像构建与 Compose 配置检查。

## 验证证据

| 项目 | 结果 / 记录 |
|---|---|
| 真正聊天全链路 | deepseek-v4-flash + qwen3.7-text-embedding；HTTP 选库、改写、检索、随机启用码回答、SSE、数据库版本引用；`tests/eval/results/chat.json` |
| DB/Redis 集成 | 45 通过，覆盖跨用户、计费回执、worker 被杀重启、幂等和竞争；既有 PG/Redis |
| 旧库升级 | schema 23 → 29、重复迁移、拒绝旧 schema 消费、旧聊天/生成/用量不变；`tests/eval/results/upgrade.json` |
| 备份恢复 | 75 表、176 文件、hash/计数/vector/授权/检索校验；临时数据库已删除；`tests/eval/results/restore.json` |
| 持久化 | 重启用户指定的现有 postgres 容器，数据库行与宿主机私有原件不变；`tests/eval/results/persistence.json` |
| UI | Chrome 与 Electron 实际 main/preload：20 文件部分失败、素材复用、图片与音频 Range、事实修订、查找、一次性 Key/轮换/撤销、出处删除失效、移动暗色 |
| 干净发布 | `tests/eval/results/clean-release.json`；离线锁定依赖缓存、禁用安装脚本、无 .env/个人配置/业务数据，完整构建、1378 项测试通过（45 项集成默认跳过，已另行全部通过）；临时快照保留构建和日志 |
| 静态检查 | Web tsc 通过；Server 全量 tsc 仍有原模块既有错误，knowledge/知识 worker 没有新增报错，未声称全仓类型检查通过 |
| Docker | `lot-agent:s4-validation` 与 `lot-agent-web:s4-validation` 构建通过（web 含 nginx -t）；Compose knowledge profile 配置验证通过；未新建运行容器 |

UI 产物：Chrome `lot-knowledge-ui-PR9KlM`，Electron `lot-knowledge-ui-9qiZVA`，均在系统临时目录。测试用户/临时库/测试密钥已清理，真实用量记录保留。完整备份保留在忽略的受限目录，不是公开交付附件。

Docker 应用构建摘要 `sha256:de25495dc47101d7f693de308de2cb143fc2393f9553b1393cd6c887335bca4d`；Web `sha256:12740b64f8ce381135e542b2c34af3084c0f8cac9bdb54074d0c6d5cd667d109`。该次镜像已覆盖应用改动，后续新增交付脚本与手册由干净工作区快照验证。

## 已知边界

- 限流范围内性能复测 240 次零错误；10 万片段/并发 5 P95 为 2.6–2.7 秒，未达到初始 2 秒目标。按计划采用容量边界（1 万/5 或 10 万/1），没有声称 HNSW 已优化完成。
- 自动化旧图像/视频、营销、记忆、任务、附件和计量使用确定性模型替身；没有再向所有供应商真实生成收费素材。真实模型验收覆盖 embedding 和聊天。
- 没有专属 tokenizer，沿用用户接受的保守分段和真实 token 核验；无 OCR/ASR/视频理解，rerank 暂不纳入当前版本。
- Dify 已剥离；Lot Bot 标准 API/接入文档已交付，实际消费方部署联调不在本次范围。没有实施生产发布或旧系统数据迁移。

复现命令均在根 package.json：`check:knowledge:release`、`check:knowledge:integration`、`check:knowledge:chat`、`check:knowledge:eval`、`check:knowledge:upgrade`、`check:knowledge:restore`、`check:knowledge:persistence`；真实调用显式要求 `--live --latest-user`，本地运维演练要求 `--local`，恢复/重启还需指定现有容器。
