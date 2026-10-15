# 10 月 15 日评审修复与验收

依据《lot-agent 2026年10月15日工作质量深度评审》，在 `84ee4ad` 基线上修复 R01–R09。以下记录代码和本地验收结果，不代表生产发布或真实模型质量验收。

## 修复对应关系

| 编号 | 修复结果 | 主要验证 |
| --- | --- | --- |
| R01 | Responses 校验并保留首个完整终态，尾部等待独立限时 1 秒；reset、AbortError、永不 EOF 不丢失有效结果。无有效终态仍失败，工具执行仍检查取消。 | 安装的真实 SDK 配合 fake fetch，正常 EOF、断流、重复终态、failed/incomplete、取消后不启动工具。 |
| R02 | 历史素材读取与新生成限制分离；旧 WebM 可打开、移除和替换，缺失素材明确提示，完成项目仍可改发布信息。新任务记录输入版本 2，Worker 按任务冻结的 `generate_audio` 执行旧任务。 | Hono 路由、浏览器、真实 PG 和 FFmpeg；新生成继续拒绝 WebM，保留 owner 校验，旧任务音频语义不变。 |
| R03 | unknown 仅阻止当前项目修改；可切换、新建、刷新状态并查看操作 ID。完整回执提供本地恢复按钮，版本冲突保留独立结果。 | 真实 React/Chrome，包括重新打开同一草稿、切换其他草稿、手动刷新、无新增模型 POST 的恢复。 |
| R04 | 前后端共用分享 URL 提取及平台视频路径判断，覆盖相邻中英文标点、无协议短链和多链接；官网、用户主页及伪装域名保留合理文字语义。 | core 分类、服务端来源解析和直接 `/copy` 拒绝绕过测试。 |
| R05 | speech 检查点缺失时优先复用完整 ASR 回执；无可用回执且仍需原片时返回 `SOURCE_EXPIRED`。用户可明确选择仅用保留画面继续，七天隐私清理期限保持不变。 | 权限/拒绝/unknown/过期矩阵、真实 PG 清理与回执恢复、浏览器明确选择；恢复不解码、不重发已完成 ASR。 |
| R06 | 首次 summary intent 前，从选帧清单和实际 OCR/视觉完成状态补齐缺口，并按 revision 冻结摘要输入。JSONB 回读恢复请求字段顺序；已有旧 intent 保持原输入身份。 | quota、429、鉴权拒绝后的 summary-only，以及正常补做 OCR；真实 PG JSONB 往返、账本复用和旧 hash 检查。 |
| R07 | Compose 共享环境透传 owner 字节配额和磁盘低水位，部署模板同步默认值与合法范围。 | `compose config`、API/媒体 Worker 环境派生的临时容器、非法阈值及存储准入测试。 |
| R08 | 为历史草稿响应夹具正确建模，消除 `restored.assets` 的新增 unknown 类型诊断。 | 严格 tsc 差异：core 12 项保持不变，server 238 → 237，无新增诊断。 |
| R09 | 完整文本回执进入 `needs_apply`，保存不可变输入和解析器版本；本地恢复按原草稿版本原子应用，区分模型坏输出与本地提交失败。 | 真实 PG 注入 finish 回滚、COMMIT 成功但响应丢失、并发重复恢复、版本冲突、owner 隔离及解析器版本不匹配。 |

## 升级和恢复契约

新增迁移 [0044-marketing-result-recovery.ts](../packages/server/src/db/migrations/0044-marketing-result-recovery.ts)，不修改历史迁移。它为文本操作增加 `input_snapshot`、`parser_version`、`needs_apply` 活动锁，并增加分析任务的 `summary_inputs`。升级时先由新 server 执行迁移，再启用同版本 Worker 和 Web；媒体 Worker 检查新字段就绪。保留数据库备份，不删除账本或修改历史输入 hash。

`POST /api/marketing-videos/:id/text-operations/:operationId/recover` 要求项目和操作均属于当前用户，只读取已保存的完整回执，不调用供应商。重复恢复返回已存结果；草稿版本变化则保存 conflict 结果，不覆盖新编辑。模型 JSON/语义无效可标为 failed 并由用户显式重新生成；unknown 和尚未应用的有效结果继续阻止新的付费请求。

迁移前没有原始输入快照或解析器版本的记录不能安全自动重建，恢复接口会要求按原版本核实。解析器未来升级也必须显式提供兼容读取器，不能拿当前草稿或新解析器猜测旧结果。不要直接降级到不识别 `needs_apply` 的旧应用版本；需要回退时先停止任务并保留完整数据，通过兼容版本处理已有记录。

源文件清理仍以七天为硬期限，保留 selection、展示帧和回执。完成回执优先恢复；unknown 继续等待核实。仅画面恢复只适用于源已过期、尚无 speech 和摘要/创作 intent 的任务，显式记录 `SOURCE_EXPIRED` 跳过原因，不冒充“原视频无声音”，也不改变已提交摘要的身份。

## 验证结果

环境：macOS，本机 Node 22.14.0、pnpm 10.33.0；Docker 中隔离的 PostgreSQL 16（pgvector）和 Redis 7，测试数据库不连接生产。模型、下载器和浏览器业务接口使用夹具；FFmpeg 为实际媒体处理。

| 检查 | 实际结果 |
| --- | --- |
| `pnpm build` | 五个包通过；Web 保留既有大 chunk 提示。 |
| `pnpm test --maxWorkers=4 --minWorkers=1` | 298 文件通过、14 跳过；2,356 项通过、80 项跳过。跳过项不计作通过。 |
| core/server `tsc --noEmit` | 分别剩余 12/237 项历史诊断，命令仍非零；相对基线无新增，R08 已消除。 |
| `MARKETING_ANALYSIS_MEDIA_TEST=1 pnpm exec vitest run packages/server/src/marketing-analysis/frames.test.ts` | 真实 FFmpeg 用例 3 项通过。 |
| `pnpm check:marketing-analysis:db` | 真实迁移、事务回滚、提交结果未知、并发、归属、准入、101 行公平派发、摘要身份、ASR 恢复与源过期通过；另一次启用真实 Redis/BullMQ 的运行通过。 |
| `pnpm check:marketing-video:db` | 真实 PG/FFmpeg 的分段、重试、账务、归档、时长与旧任务音频语义通过；供应商为夹具。 |
| `pnpm check:marketing-video:ui` / `pnpm check:marketing-analysis:ui` | 真实 React/Chrome，通过草稿恢复、导航、历史 WebM、来源过期、账号隔离、中英文、暗色及窄屏；检查输出截图。 |
| Compose 自定义阈值 | owner=3,221,225,472、min-free=2,147,483,648 在 server/worker/media-analysis-worker 配置一致；临时容器验证两项环境值。未据此宣称完整应用镜像上线通过。 |

数据库脚本要求新建的本机测试库；分析脚本使用 `MARKETING_ANALYSIS_CHECK_DATABASE_URL`（库名 `media_analysis_check_*`），视频脚本使用 `MARKETING_CHECK_DATABASE_URL`（库名 `marketing_check_*`）。可选 `MARKETING_ANALYSIS_CHECK_REDIS_URL` 仅使用空的本机 15 号库。UI 脚本需要 Playwright、Chrome 和本机回环端口，可通过 `PLAYWRIGHT_MODULE` 指定已有模块。测试容器及数据为本轮专用，用后删除。

## 保留的发布门禁

本轮没有向真实供应商发起付费请求，没有生产部署。目标 Linux 媒体隔离、最终生产镜像和供应链扫描、运行时维护版本升级、生产音频 URL 网关可达性与访问控制、三平台授权素材批量验收、生成视频口播/字幕/人物一致性仍需独立验收。源码与本机夹具通过不能替代这些门禁。

ASR 仍只转写实际下载文件的内嵌音轨，不承诺分离音轨抓取、静音检测、词级时间戳或音画对齐。既有真实样例与限制见 [真实验收记录](marketing-video-live-acceptance.md)；此前修复历史见 [10 月 14 日评审问题修复](marketing-video-review-fixes.md)。
