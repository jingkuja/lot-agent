# 营销影像十月十六日实施与验收记录

本次落实《营销影像核验报告与十月十六日实施方案》第七、八节的单人工作计划：完成 N01–N04 修复、回归、第一阶段交接，以及 F03/F04 的下一阶段契约与样例。第二阶段完整功能、生产发布和付费质量样本不属于本次交付。

代码基线为 `d2ccaeaa6abf4866a4b90e99abf3be3acfd06953`，分支 `feat/platform-foundation`。本次结果是该提交上的未提交工作区变更。开始时唯一未跟踪文件为 `output/pdf/marketing-video-review-20261015.pdf`，已保留。未修改历史迁移，没有新增数据库迁移，没有部署或调用真实供应商。

## 第一阶段结果

| 项目 | 已落实的行为 | 实际证据 |
| --- | --- | --- |
| N01 排队与终态 | 三分钟只触发队列诊断；健康等待不失败；Redis 未知不当作缺失；终态不能被隐式领取 | 单元测试、真实 PG/Redis、独立 Worker 进程 |
| N01 取消与重试 | 先持久取消，再尽力清理队列；跨进程轮询取消；合法重试保持 pending，最后一次失败才变 failed | 取消与领取边界、普通任务两次尝试、显式同 ID 恢复 |
| N02 安全错误 | 创建、轮询、恢复、音色和下载不再回显供应商自由文本 | 合成哨兵单测；实际适配器 → Worker → PG 错误列 → HTTP 项目响应和日志 |
| N03 历史恢复 | 按片段区分复用、查询下载、新提交和未知；使用原冻结输入；已知 WebM 回执可恢复 | 实际 HTTP + PG + 模拟供应商 + FFmpeg，HTTP 202、零新增视频 POST |
| N04 迁移测试 | 明确期望补到 0047，保留版本、名称、顺序及冲突断言 | migration-runner 测试通过；隔离 PG 中验证 0046/0047 及重复启动 |

### 队列与取消契约

入口为 `server/index.ts` 的定时诊断、`db/database.ts` 的受保护状态更新、`jobs/bullmq-queue.ts` 的投递与消费。以下路径均相对 `packages/`。

| 当前事实 | 数据库与页面行为 |
| --- | --- |
| pending、attempts=0、超过三分钟，任一队列存在 waiting/delayed/prioritized/active/waiting-children | 保持 pending，stage 为“等待队列处理” |
| Redis 未就绪、读取失败或读取超过两秒 | 保持 pending，stage 为“队列状态待核实”；停止本批后续 Redis 诊断请求 |
| 两个队列均没有作业 | 保持 pending，stage 为“投递未完成，可恢复排队”；由用户显式恢复原 ID |
| 明确失败、成功或取消后收到 Redis 重投 | 数据库领取失败，业务处理器不执行 |
| 普通任务允许重试且尚未耗尽次数 | running → pending，记录当前尝试号与“等待自动重试”；最终失败才写 failed |
| pending/running 接收取消 | 立即持久化 cancelled 和“已请求取消”，然后中止本进程信号并尽力删除等待项 |
| Redis 不可读时取消 | 仍返回已保存的取消请求；不等待 Redis 无限重连 |
| 原作业仍 active、等待或队列状态未知 | 拒绝恢复；两队列均已收尾后，显式恢复才允许转回 pending |

诊断每分钟运行，每批最多 100 条，按最近检查时间轮转。确证缺失也不由定时器盲目重建作业：原排队选项未全部持久化，自动重建可能丢失延迟策略。营销页面保留原 ID 的显式补投入口。

Worker 在进入处理器前检查持久状态，并每秒观察跨进程取消；营销执行链在创建视频前另行检查取消。已经发送到供应商的请求不能由本地取消撤回。取消响应新增 `cancellationRequested`，表示请求已保存，不表示供应商任务已经终止。页面显示“已请求取消”，并提示等原 Worker 收尾后再继续。

真实队列夹具阻塞首个营销任务，将第二个任务的数据库创建时间推进至四分钟前，再调用实际诊断；第二个任务保持 pending，释放后只执行一次。另一等待任务取消后未进入处理器。该测试使用真实队列和受控时间推进，没有把三分钟墙钟等待描述成已实测。还验证了延迟作业、确证缺失、旧队列 active/waiting/终态、迁移锁竞争的单元边界、正常重试和独立子进程取消。Redis 不可用及超时使用确定性故障夹具，未做 Redis 服务停机压力测试。

### 安全错误契约

`core/src/providers/provider-error.ts` 提供统一错误类型。保留固定的供应商类别、`create/poll/download` 阶段、受控 HTTP 状态，以及 `HTTP_ERROR / TRANSPORT_ERROR / INVALID_RESPONSE / TASK_FAILED` 类别。请求 ID 仅接受 UUID 或 `req-`/`req_` 加 8–64 位十六进制，并排除与当前凭证相同的值。其他供应商 code/message、HTML、异常 cause 和响应正文都不进入错误消息。

POST 的网络失败不重试。轮询保持既有的一次网络重试；没有确定业务终态的查询失败仍保留原回执。下载失败保留原下载恢复路径，但错误文本统一收敛。共用错误提取函数的图片适配器同步取消了自由文本回显。

测试使用虚构的提示词、认证值、私有 URL、超长文本和非法请求 ID。真实数据库夹具读取父子任务 `error` 列与项目 HTTP 响应，并捕获日志，确认不含哨兵。此结论覆盖本次适配器错误出口，不代表已清理历史数据库和生产日志中的旧记录。

### 片段恢复契约

`server/src/marketing-video/recovery.ts` 为 HTTP 预检与 Worker 共用分类。判断顺序固定：unknown 优先，其次明确可重试失败、成功资产、已知供应商 ID，最后才是新提交。

| 片段类别 | 恢复行为 |
| --- | --- |
| output 有成功资产且没有 retrySafe | 校验资产所有者及片段任务关联，复用资产，不算新提交 |
| 已知 vendor ID、没有 retrySafe | 查询并下载原任务；不重新要求历史素材满足当前新建 MIME/尺寸/声音规则 |
| 无回执或明确 retrySafe | 继续执行当前新提交素材规则、分镜提示词限制和配额检查 |
| `marketing-submission-unknown`，即使同时带 retrySafe | 全批拒绝新意图，返回待核实；不会清掉 unknown 重发 |

恢复前验证父任务所有者、项目关联和失败/取消状态。片段查询同时检查任务所有者、`marketing.segment` 类型和 `input.parentId`。恢复使用父任务冻结的 draft 与声音选项；项目的当前展示文案不替代原输入。`reserve` 的恢复分支只修改状态，保留父子 ID、外部回执和 `marketing:<child>:<vendor>` 计量键。缺少且不再用于取材的历史素材可跳过；仍存在但属于其他用户的素材始终拒绝。

混合任务只对需要新提交的片段计入预估用量；任何新提交都必须通过严格规则。背景音乐属于本地合成输入，仍需可读取。恢复不是绕过输出归属、版本冲突、取消收尾或文件沙箱的入口。

## 验证环境与命令

日期为北京时间 2026-10-16。环境：macOS arm64、Node 22.14.0、pnpm 10.33.0、Vitest 2.1.9、TypeScript 5.9.3、FFmpeg 8.1.2。PG 使用 `pgvector/pgvector:pg16`，Redis 使用 `redis:7-alpine`，均为本次独立临时容器，仅绑定 127.0.0.1 的 55436/56386 端口，未连接已有业务容器。

| 命令或检查 | 最终结果 | 退出码 |
| --- | --- | --- |
| `pnpm exec vitest run --maxWorkers=4 --minWorkers=1` | 304 文件通过、14 文件跳过；2475 项通过、80 项跳过 | 0 |
| `pnpm --filter @lot-agent/core build` | ESM 与 DTS 通过 | 0 |
| `pnpm --filter @lot-agent/server build` | ESM 与 DTS 通过 | 0 |
| `pnpm --filter @lot-agent/web build` | 类型构建及 Vite 通过，保留既有大 chunk 提示 | 0 |
| `pnpm check:marketing-video:queue` | 原 ID、队列隔离、0046 不变量、超龄等待、取消、重试、跨进程验证通过 | 0 |
| `pnpm check:marketing-video:db` | 0047、HTTP WebM 恢复、安全错误落库、计量去重、取消及 FFmpeg 合成通过 | 0 |
| `pnpm check:marketing-video:ui` | 真实 React/Chrome，模拟 API；三步流程、刷新、排队、取消、中英文、暗色窄屏通过 | 0 |
| Core `tsc --noEmit` | 12 项既有诊断；相对基线逐条无新增、无消失 | 2 |
| Server `tsc --noEmit` | 234 项既有诊断；相对基线逐条无新增、无消失 | 2 |
| `git diff --check` | 无空白错误 | 0 |

类型比较使用文件、行列、错误代码和完整诊断消息（含后续说明行）；用 Git 基线与当前文件的相同行映射消除插入代码造成的行号移动。不是仅比较总数。严格类型检查仍未通过，不以构建成功替代。

初始迁移测试有两个预期陈旧失败，修复后通过。初次全量测试在沙箱内无法监听桌面测试所需端口，被中止，退出 130；最终表格记录允许本地端口后的完整复跑。开发过程修复了新增类型问题和旧错误文本断言，最终保留的失败仅是上述历史严格类型诊断。跳过的外部/隔离集成测试不计通过。

可复跑入口：

```bash
pnpm --filter @lot-agent/core build
pnpm exec vitest run --maxWorkers=4 --minWorkers=1
pnpm --filter @lot-agent/server build
pnpm --filter @lot-agent/web build
pnpm exec tsc --noEmit -p packages/core/tsconfig.json
pnpm exec tsc --noEmit -p packages/server/tsconfig.json
# 以下连接串只允许指向本机全新空白 marketing_check_* 数据库。
MARKETING_QUEUE_CHECK_DATABASE_URL=<隔离PG> MARKETING_QUEUE_CHECK_REDIS_URL=<隔离Redis的15号库> pnpm check:marketing-video:queue
MARKETING_CHECK_DATABASE_URL=<另一个隔离PG空库> pnpm check:marketing-video:db
PLAYWRIGHT_MODULE=<playwright包路径> pnpm check:marketing-video:ui
```

本机证据文件位于 `/private/tmp/marketing-vitest-final.log`、`marketing-queue-check.log`、`marketing-db-check.log`、`marketing-ui-check.log`、`marketing-{core,server,web}-build.log`、`marketing-{core,server}-types-{before,after}.log` 与 `marketing-type-comparison.json`。截图位于 `/private/tmp/marketing-ui-20261016/`；它们是测试夹具画面，不是真实成片质量证据。临时文件不是长期审计存储。测试完成后，本任务创建的 PG/Redis 容器均已停止并自动删除。

## 第二阶段冻结契约与样例

本节及 [结构化验收样例](fixtures/marketing-video-stage2-contracts-20261016.json) 是下一工作包的设计输入，未宣称 F03/F04 已实现或通过验收。样例完全为合成数据。

### F03 同父任务音色复用

复用边界固定为单用户、单父任务、单槽位。父任务 ID 由服务端任务关联推导，不从 HTTP 接受。复用指纹包含契约版本、用户、父任务、槽位、供应商、模型、独立音色凭证范围和素材稳定身份/内容哈希。临时 URL、查询令牌、原始密钥不进入指纹或输入快照。

现有 `generation_voice_tasks` 主键为 `(task_id, slot)`，外键已允许引用父任务。因此优先复用该表，以追加迁移增加 `scope_version`：历史记录按 v1 子任务解释，新父级按 v2 解释；不更新旧外部请求 ID、voice_id 或子级指纹。素材内容版本目前不能仅凭 URL 判定，实施时需在授权读取后计算并冻结摘要，或使用可信存储版本。

父任务在启动片段并发前，为所有需要新提交且没有旧检查点的片段准备共享音色。任何旧子级检查点继续按 v1 查询：已有视频回执不再准备音色；已有声音意图查询原 ID；unknown 不视作空记录，也不合并为一次新创建。新 v2 记录仍用原子 claim 确认唯一提交者，输入签名/授权先于意图落库。

至少验收：四段一个槽位仅一次创建；双槽位各一次；并发争抢只有一个 POST；断连/重启查询原请求；凭证/素材版本/用户变化拒绝复用；原子任务 voice_id 保持。供应商有效期、许可和收费尚待核对，禁止跨项目缓存及固定节省金额承诺。

### F04 审核与发布文案回执

扩展 `marketing_text_operations.kind` 为 `review/publication`，只追加迁移。继续使用 `(user_id, clientRequestId)` 幂等身份。输入固定为 `projectId`、`projectVersion`、操作种类、locale、冻结草稿及操作参数；相同 ID 不同输入返回冲突。新操作使用各自版本化解析器，旧 `marketing-result-v1` 的 copy/storyboard 分支保持原行为。

review 快照包含完整审核字段、字段边界指纹和规则版本；成功应用仅更新与该版本、指纹相符的审核结果。publication 快照包含 fillMissing/覆盖意图，补缺基于旧快照先计算，再用版本条件原子应用，不对新草稿重新推导补缺。

状态保持 `running → needs_apply → succeeded/conflict`。完整模型回执先持久化，后本地解析和原子应用；未知结果只核实。事务提交响应丢失先重读结果；回执已存但应用失败只做本地恢复；版本改变保留独立结果。UI 复用 `TextOperationPanel` 展示未知、待应用和冲突，刷新不得再次调用模型，并保留切换草稿能力。

至少验收：并发同 ID 一次模型 POST；同 ID 异输入 409；跨用户 404；保存/响应丢失后 POST 总数仍为 1；版本冲突不覆盖当前草稿；规则或审核指纹变化时旧结果无效；没有兼容快照的旧记录进入人工核实。

### F05 余量工作仅交付测试设计

本次选择报告允许的 F05 就绪探针设计，没有同时扩展 F07。执行 Worker 需要报告二进制路径与版本；测试“true 假程序”、缺 libx264/AAC、缺 scale/pad/setsar/fps/aresample/apad/anullsrc/amix/volume/concat，以及真实短片合成。缓存键含路径、版本和参数；API 主机通过不能代表执行 Worker 就绪。能力失败关闭，单任务素材检查独立执行。该设计没有更改当前 `mediaCapabilities`，F05 仍是后续缺口。

## 发布门禁与回滚交接

本次关闭 N01–N04 的代码与已运行本地回归项。目标 Nginx/CDN 缓存和日志、私有链接时钟容差、真实供应商十分钟取材、Linux 媒体隔离、Worker SIGTERM 排空、生产 P95，以及真实口播/字幕质量仍未验证。F03–F08 与 G01–G08 不因本次测试通过升级为完整功能。生产镜像的运行时升级继续单独处理。

发布时应固定实际提交与镜像，先停止新意图，盘点既有外部回执，再排空旧 Worker。不能让旧代码继续将等待任务标失败。没有新增迁移；0046/0047 保留，禁止为回滚把私有素材重新公开。

回滚候选需重新评审：基线 `d2ccaea` 理解现有私有 schema，但包含本次修复的排队、错误回显和历史恢复缺陷，不能直接作为可扩大使用的安全版本。优先修复前进；紧急回退时保持新任务关闭，并保留当前数据库与外部回执。已有取消、unknown 或已发生计量不得通过回滚数据快照抹去。

剩余负责人均待分配：运维负责目标网关、时钟、SIGTERM 与 Linux 隔离；供应商接入负责人核对音色/图片契约及授权样本预算；产品负责人确认真实质量验收门槛。没有代替任何人承诺上线或费用。
