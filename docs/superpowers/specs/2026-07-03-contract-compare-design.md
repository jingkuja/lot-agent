# 合同对比 Agent — 设计文档

日期：2026-07-03
状态：已与用户确认

## 背景与目标

`contract` AgentDefinition 目前是纯占位（名称「合同审核」、无工具、占位系统提示）。本期把它
重做为「**合同对比**」子 Agent：用户上传新旧两版合同，Agent 找出条款增删、同条款内容变化与
合同主体变更，过程中的疑问用 ask_user 卡片与用户交互，最后询问是否生成对比报告。

全面复用 PPT Agent（见 `2026-07-02-ppt-agent-design.md`）建立的三套基础设施：

1. **slot 附件机制**（`AttachmentRef.slot` + InputBox 分槽上传入口）
2. **ask_user 用户卡片**（endsTurn 工具 + AskUserCard 前端渲染）
3. **generate_document 工具**（docx / pdf / md / html 文档产出与下载链接）

核心比对逻辑由 LLM 语义完成，**不新增任何算法/渲染代码**。

## 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 上传约束 | 两个入口（旧版/新版）都**可选**，缺哪份由 Agent 用 ask_user 卡片催传（与 PPT 一致） |
| 比对引擎 | **纯 LLM 语义比对**：两份合同全文提取进上下文，LLM 做条款对齐与差异分析；不写结构化切分代码 |
| 报告格式 | Agent 询问是否生成报告时，选项直接带格式（docx / pdf / markdown / 不需要），复用 generate_document |

## 第 1 节：Agent 定义（core）

重写 `packages/core/src/agents/definitions/contract.ts`：

- `id: "contract"`、`type: "contract"` 不变（web 图标 `agent-icons.tsx` 按 type 匹配，无需改动）。
- `name: "合同对比"`；`description: "上传新旧两版合同，找出条款增删、内容变化与主体变更"`；
  `category` 保持 `"审核"`。
- `toolNames: ["ask_user", "generate_document"]`（两个工具均已存在）。
- `inputSchema`：`{ oldContract?: string, newContract?: string }`，均可选（占位 schema 语义，
  与其他 Agent 一致）。
- `defaultModelId` 沿用 `deepseek-v4-flash`。

### systemPrompt 工作流

1. **盘点输入**：识别 `[旧版合同: …]…[/旧版合同]` / `[新版合同: …]…[/新版合同]` 标记包裹的
   正文；缺哪份就用 ask_user 卡片催传，一次一问；两份都缺则先问需求再催传。
2. **主体核对**：先比对合同双方主体（甲方/乙方名称、统一社会信用代码、地址、法定代表人等），
   有变更单独列出。
3. **条款比对**：语义对齐条款（不依赖条款编号一致），输出三类差异：
   - **新增条款**（新版有、旧版无）
   - **删除条款**（旧版有、新版无）
   - **内容变化**（同一条款新旧文本不同：逐条给出旧文摘录 / 新文摘录 / 变化影响说明）
4. **有疑问就问**：比对中遇到歧义（条款编号错位无法确认对应关系、文本缺失疑似解析不全、
   是否只关注某类条款等）→ ask_user 卡片确认，不要猜。
5. **输出结果**：以结构化 markdown 呈现——「主体变更 / 新增条款 / 删除条款 / 内容变化」四节，
   每条差异附风险提示；若上下文中出现 `[内容过长已截断]` 标记，须注明仅比对了截断前内容。
6. **询问报告**：结果给出后，用 ask_user 卡片问「是否生成对比报告」，选项：
   `生成 Word 报告 (docx)` / `生成 PDF 报告` / `生成 Markdown 报告` / `不需要`；
   用户选择格式后调 generate_document 产出并返回下载链接。

规则：不向用户暴露 assetId 等内部细节；解析失败/空文本时如实转告并请求重传。

## 第 2 节：附件链路（server）

`packages/server/src/services/attachment-extractor.ts` 最小扩展：

- `AttachmentRef.slot` 类型扩为 `"ppt_template" | "content" | "contract_old" | "contract_new"`。
- 合同 slot 走**现有文档提取逻辑**（pdf / docx / xlsx / txt 等分支不动，上传白名单不动），
  仅把包裹标记换成角色化标记：
  - `contract_old` → `[旧版合同: 文件名]\n正文\n[/旧版合同: 文件名]`
  - `contract_new` → `[新版合同: 文件名]\n正文\n[/新版合同: 文件名]`
- 解析失败 / 文件不可读沿用现有降级文案（`[附件 … 无法解析，已忽略内容]` 等），不抛错。
- 超长仍按 `MAX_DOC_CHARS` 截断并附 `…[内容过长已截断]` 标记。

## 第 3 节：Web UI

- `InputMode` 增加 `"contract"`；`ChatPanel` 按 `agentKind === "contract"` 设 `mode="contract"`，
  模型选择器沿用 llm 组。
- contract 模式下输入框左侧两个上传入口（对齐 ppt 模式「PPT 模版」按钮的位置与样式）：
  - **旧版合同**：`accept` 文档类型（pdf / docx / txt / md），最多 1 个，重复选择替换；
    chip 带「旧版」角标。
  - **新版合同**：同上，chip 带「新版」角标。
- 角标复用 `attachment-slot-badge` 样式体系，颜色只用现有 `var(--*)` token，不新增硬编码色值。
- 两个入口都可选，纯文本可发送；组件内分别保存 `oldContractFile` / `newContractFile`，
  发送时合并为带 slot 标记的附件列表交给 onSend，`useChat` 链路零改动（slot 已是透传字段）。
- contract 模式下只提供这两个专用入口，不提供通用文件/图片上传入口（ppt 模式是「模版 + 内容」
  两入口，contract 模式对应为「旧版 + 新版」两入口，均无裸通用入口）。

## 回合流程

```
用户在两个入口上传新旧合同（或只传一份/不传）→ 发送
→ extractAttachment 按 slot 注入角色化正文标记
→ Agent 盘点：缺文件 → ask_user 催传（本轮结束）→ 用户补传 → 下一轮
→ 主体核对 + 条款语义比对（歧义 → ask_user 确认）
→ 输出结构化对比结果（markdown）
→ ask_user「是否生成对比报告」（docx/pdf/md/不需要）
→ 用户选格式 → generate_document → 下载链接
```

## 错误处理

| 场景 | 行为 |
|---|---|
| 只传了一份合同 | Agent 用 ask_user 卡片催传另一份 |
| 两份都没传 | Agent 先了解需求，再逐份催传 |
| 合同解析失败/空文本 | 现有降级文案进上下文；Agent 转告用户并请求重传 |
| 超长合同被截断 | 沿用截断标记；Agent 在结果中注明仅比对了截断前内容 |
| 用户不点卡片直接打字 | 与点选项完全等价（ask_user 既有机制） |
| 同一入口重复选择文件 | 前端直接替换（各入口最多 1 个文件） |

## 测试（TDD / Vitest，测试文件与源码同目录）

- **core** `definitions.test.ts`：更新 contract 定义断言（名称「合同对比」、
  `toolNames` 含 `ask_user` 与 `generate_document`、描述、category）。
- **server** `attachment-extractor.test.ts`：新增 `contract_old` / `contract_new` 分支用例
  （角色化标记包裹正确；解析失败降级文案不变）。
- **web**：无组件测试基建，本期不新增（与 PPT 期一致）。

## 新依赖

无。

## 范围外（明确不做）

- 结构化条款切分算法（已确认走纯 LLM 路线）
- 逐字符 redline / diff 高亮视图
- OCR 扫描件识别
- 三份及以上多版本对比
