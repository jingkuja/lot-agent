# RAG Review 修复记录（2026-09-24）

对应 `design/rag/reports/implementation-review-2026-09-24.md`。本次修改实现与测试，未对现有业务资料执行重建、切换或付费模型调用。

## 修复对照

| Review 问题 | 修复 |
| --- | --- |
| P1 企业素材进入个人素材 | 列表、原件读取、归档共用隔离条件，检查任务 `featureScope`、数字员工会话和企业素材库关联；覆盖没有 conversationId 的获客生成任务。 |
| P1 切换 Key 后被旧账单永久阻塞 | 回执按用户、原网关和 Key 指纹隔离；只保存指纹，不保存新的一份明文 Key。保留待核对费用，后台用仍保留的原凭证对账；提供退役 Key / 历史账单的人工对账命令。 |
| P2 短行分块导致跨行漏召回及过多任务 | 新配置 `utf8-packed-512-overlap64-v2` 合并相邻行/段落，保留字节预算和重叠；不跨 PDF 页、DOCX 标题或内容来源，返回实际行/段落范围。旧 v1 行为不变。 |
| P2 上传重试误报重复 | 重复检测移入幂等事务，先回放已成功响应；同内容不同请求仍提示重复，相同请求不会重复创建资料或任务。 |
| P2 无说明媒体/书签必然失败 | 引入 `stored_only`；无说明时不建任务，补充说明后入库，清空说明立即撤下旧索引。迁移修复既有无说明的待处理版本并使旧任务失效。 |
| P2 对话只能检索文档/笔记 | 增加显式资料类型选择，支持书签、媒体说明和有效个人信息，贯通选择、保存、刷新和发送；默认仍只有文档/笔记。 |
| P2 重开丢失失败原因及 OCR 提示 | 资料接口返回持久错误码和解析诊断，列表/预览显示未识别 PDF 页；不依赖当前页面的轮询缓存。 |
| P2 素材筛选漏页、来源错误 | 类型、来源、标签、标题在 SQL 分页前筛选；新归档持久记录上传/生成来源，原素材删除后仍保留。已有归档在原素材尚存时回填来源。 |
| P2 Electron 外部 API 地址错误 | 使用真实 preload `getServerUrl()` 配置，缺少配置时明确提示；浏览器仍使用当前站点地址。 |
| P2 聊天出处长时间显示失效版本 | 定期和窗口聚焦时重新验证，失效后清除；聊天与管理界面共用定位、高亮、PDF 页码跳转及媒体预览组件。 |

同时修复过期个人事实的可检索计数、个人信息外部授权提示、上传队列逐项移除；补齐素材网格/列表、类型占位图、尺寸/时长和未归档原件预览。Core 增加可供浏览器使用的纯知识契约入口，复用资料类型与引用类型。临时网络、429/5xx 和待回执错误可按原任务策略重试。

## 升级与索引兼容

1. 按现有部署流程备份并停止旧知识 Worker，先启动新 server 完成 **migration 0030**，再启动新 Worker。新 Worker 拒绝旧 schema。不要单独将旧应用回滚到新 schema 上：回执唯一约束和资料状态已有变化，数据库回滚应遵循备份恢复流程。
2. 已有用户的活动 profile 和 checkpoint 不改写。新用户默认使用 v2；已有用户需要通过现有 `knowledge:index start → build → switch` 流程切换。保持原模型、维度、路由，目标配置仅升级 chunker。`build` 会用资料所有者的凭证产生真实费用，因此本次未自动执行。
3. 默认 1024 维模型的命令示例（其他配置须填写实际值）：

```sh
pnpm knowledge:index start OWNER_UUID 1024 qwen3.7-text-embedding
pnpm knowledge:index build OWNER_UUID BUILD_UUID
pnpm knowledge:index status OWNER_UUID
pnpm knowledge:index switch OWNER_UUID BUILD_UUID EXPECTED_STATE_VERSION
```

构建期间旧索引继续提供查询。修改正文、新增资料等竞争变更仍由原有完整性检查和切换版本校验处理。

## 延迟回执与恢复

知识 Worker 每 30 秒核对待结算回执，即使最后一个片段/查询已经完成也会继续处理。付费向量在回执延迟时可以保存 checkpoint；同一凭证有待结算费用时，不继续发起新向量调用。其他 Key / 网关不被旧回执阻塞。

```sh
pnpm knowledge:billing status OWNER_UUID
pnpm knowledge:billing reconcile OWNER_UUID ORIGINAL_PROVIDER_ROUTE
# 如需原来的退役 Key，通过安全环境变量 KNOWLEDGE_RECEIPT_KEY 提供，不放入命令行参数。
# 迁移前没有凭证指纹的历史记录，核实原网关和凭证后显式启用：
pnpm knowledge:billing reconcile OWNER_UUID ORIGINAL_PROVIDER_ROUTE --legacy
```

只根据匹配的 request ID、模型名和网关实际 quota 写费用；缺少 request ID、已撤销凭证或超过网关日志保留窗口的记录继续显示为 pending，不能自动猜测费用或记作零元。历史无指纹记录不会由后台猜测原凭证；人工 `--legacy` 核对也只结算有匹配回执的记录。

## 验证

- `pnpm test`：1,385 通过，57 个 opt-in 测试跳过；`pnpm run build`：全部工作区通过。
- 隔离 PostgreSQL 的 RAG 测试集：92 通过，3 个 Redis 测试跳过。包含旧 schema 29 升级到 30、企业任务隔离、HTTP 上传重放、无说明状态转换、错误与诊断恢复、筛选分页、过期事实计数、跨行召回、旧 Key 与新网关隔离、延迟回执后台结算和历史回执人工恢复。
- Chrome 与 Electron 43.2.0：真实管理 API、会话、数据库、解析器和私有存储；验证混合文件批量上传、逐项移除、媒体保存/播放/拖动、素材原件与私有副本预览、对话资料类型勾选、错误及 PDF 诊断在重开后恢复、引用自动失效、移动端深色布局、外部 Key 创建/轮换/撤销。Electron 另验证配置的服务器 BaseURL。
- 模型为确定性替身，未重新调用真实付费模型。Redis 专项测试仍为 opt-in，本轮未运行；队列协议未改变。
- server 的全目录 `tsc --noEmit` 仍存在既有测试及其他模块类型问题；本次知识实现无新增类型错误，不将其描述为全仓类型检查通过。
