# S1 / S2 补齐与验证记录

更新日期：2026-09-24；实施与测试日期：2026-09-23。沿用现有 PostgreSQL 16 / pgvector / Redis，无新增容器。**按 2026-09-24 用户确认的分段方案，S1、S2 已完成本阶段验收。** 采用已验证的字节候选分段与模型返回 usage 校验，不再将精确 tokenizer 作为阶段完成的前置条件。

## 本批实现

| 范围 | 结果 |
| --- | --- |
| S1-01/02 | 追加迁移 27/28；schema readiness；私有上传、版本读取、短期预览；实际磁盘占用、上传租约、备份窗口及保留期清理 |
| S1-03 | 库名称/说明/标签、资料过滤/分页、多库批量关联、文件替换、幂等导入、重复文件复用 |
| S1-04 | 强类型确认事实、候选/历史、有效期/停用/外部可见性；确认优先于自动记忆，修改立即撤销旧语义投影 |
| S1-05 | 本人旧上传/生成与私有素材列表；独立私有归档；直接放入当前对话附件，不自动发送或归档；原生图片/音频/视频控件及下载 |
| S1-06 | 收件箱、拖放/选择/粘贴、建议库名与创建导入、20 文件逐项状态、失败重试、重复选择、键盘入口 |
| S2-01 | 事务 outbox、独立 BullMQ 队列、稳定 task ID、持久取消/租约/代次、真实进程恢复与 checkpoint 复用 |
| S2-02/03 | TXT/MD/笔记/PDF/DOCX/媒体说明解析、真实定位、隔离超时与 heap 限制；按用户 TokenHub 调用与真实账单、完整性校验后原子发布 |
| S2-04/06 | 中文 ICU 词法及型号保护、PG 全文+精确向量+RRF、全局/库内范围、事实有效性、显式降级、引用重核验和定位 UI |
| S2-05 | 独立维度空间、可恢复重建、完整性切换、校验回滚、取消和保留期清理；普通请求不执行维度 DDL |

## 实际验证

- `pnpm build`：全部工作区构建通过。
- `pnpm test`：**1,370 通过，37 个 opt-in 集成测试跳过，无失败**。修正 3 个旧断言：迁移不能固定截止于 20，原上传接口的当前请求体上限为 151 MiB。
- `pnpm check:knowledge:integration --redis`：**37 通过**，包括全新 schema/已有库迁移、跨用户隔离、当前事实/历史、批量关联、替换保留旧版、归档副本独立、上传/备份期间禁止 GC、索引完整性切换/回滚/延迟回收。
- 故障注入：真正启动独立 BullMQ 子进程，在向量 checkpoint 落库后 `SIGKILL`；新子进程等待 Redis stalled 重投后恢复。测试只提前过期自己的 PG 租约，验证 task attempts=2、单次发布、重启不再调用 embedding 替身。
- 解析：真实生成的 PDF/DOCX fixture 验证页号、标题/段落及 >30K 正文尾部；空白 PDF 明确要求 OCR；密码 PDF、无效 UTF-8、损坏 DOCX、输出超限、阻塞/取消被正确拒绝。
- Chrome：真实管理 HTTP、现有 PG、隔离会话与私有存储；20 个混合文件（TXT、PDF、DOCX、PNG、WAV 和一个故意不支持文件）保留 19 个成功项及单项失败；建库/改名、重复复用、事实纠正、私有素材归档/预览、全局检索、手机深色布局、原文定位与删除后清除引用通过。
- Electron 43.2.0：镜像下载文件与项目锁定包内官方 SHA-256 比对通过；运行项目真实 main/preload，使用独立临时 userData，执行同一组管理 UI 验收，另通过私有音频播放/拖动验证。未改动现有用户登录配置。
- UI 测试 embedding 是确定性替身，**不代表真实模型验收**。另运行 `pnpm check:knowledge:live --live --latest-user`：最近登录的已授权账号真实 TokenHub → 编译知识 Worker → pgvector → hybrid → 行号引用成功；索引一次调用 30 input tokens，实际索引费用 `0.000016` 元。查询向量另行计量；合成资料/队列/任务已清理，真实用量记录保留。
- `server tsc --noEmit` 仍报告仓库原有的其他模块类型问题（日志 600 行）；新增 `src/knowledge/` 无类型报错。工作区约定 build 和全部测试通过，不将其说成“全仓静态类型检查无错误”。

## 可重复 UI 验收

先构建 core、server、desktop，安装 Chrome 和 Playwright；测试只允许本地 PG，并自动清理测试账号/数据。临时截图不含真实资料。

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright pnpm check:knowledge:ui --local
# Electron 可执行文件需匹配项目锁定版本；使用实际 main/preload 和临时用户配置
PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
ELECTRON_PATH=/absolute/path/to/Electron \
pnpm check:knowledge:ui --local --electron
```

测试不会启动实际业务定时器或原任务消费者；管理路由、会话鉴权、DB、私有存储和解析器都使用项目实现。它验证知识管理模块和 Electron 宿主，不代替完整原聊天产品的端到端业务验收；原聊天/生成/记忆/SSE/附件/桌面代理由既有回归测试覆盖。

## 已接受的分段方案与后续边界

查阅了 [官方 embedding 说明](https://help.aliyun.com/zh/model-studio/embedding)、[同步接口规格](https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api/)以及本地 TokenHub 路由实现。公开规格支持默认 1024 维及多种维度，但本次未找到明确匹配 `qwen3.7-text-embedding` 的离线 tokenizer 文件或可用的 TokenHub token 计数入口。OpenSearch 的计数服务属于另一套产品接口，不能据此声称当前用户 TokenHub 凭证可调用；旧版 Qwen tokenizer 也不能冒充精确匹配。

2026-09-24 用户确认：Qwen 向量模型没有可用 tokenizer 接口，接受目前已验证的方案先行，不因向量调用费用继续阻塞本阶段。继续按用户凭证调用并记录真实用量与实际费用。

本阶段验收采用 `provider-usage-per-chunk-v1`：512 UTF-8 字节候选、64 字节重叠，单段 embedding 返回真实 usage 后验证 ≤512 tokens；超预算失败，不截断正文、不把字节数写成计费 token。此方案已跑通并获用户接受；**不是按模型精确 token 边界和 token overlap 切分**，这一差异作为已接受的设计调整记录，不再列为未完成项。未来若获得匹配资源，应发布新 profile 并通过现有构建/切换/回滚流程迁移，不能直接改变现有索引规则。

其他已声明边界：解析资源限制包含 JS heap 而非总 RSS；正式大规模中文检索质量、容量指标及整机备份恢复归于 S4。外部知识 Key、Dify 与 Agent 本地检索工具接线归于 S3；OCR/ASR/rerank 归于 P1，本批不宣称完成。
