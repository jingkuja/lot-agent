# PPT Agent + 公用 ask_user 交互机制 — 设计文档

日期：2026-07-02
状态：已与用户逐节确认

## 背景与目标

`ppt` AgentDefinition 目前是纯占位（无工具、占位系统提示）。本期把它做成第一个有真实业务
能力的子 Agent，同时补齐一块所有 Agent 共用的基础能力：**Agent 在制作过程中缺信息时向用户
结构化提问**。

三个交付目标：

1. **PPT 专属输入框**：输入框左侧两个上传入口——「PPT 模版」（.pptx，最多 1 个）和
   「内容文件」（沿用现有文档类型）。两者都**可选**，缺什么 Agent 问什么。
2. **公用 ask_user 机制**：Agent 可发起结构化提问（问题 + 选项按钮 + 自由输入），本轮结束
   等用户回复；所有 Agent 可复用。
3. **真实 .pptx 产出，按模版渲染**：解析上传模版的主题（配色/字体/尺寸），LLM 生成大纲后
   用 pptxgenjs 渲染真实 .pptx 供下载。

## 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 产出深度 | 真实 .pptx，按模版渲染（非 stub、非纯大纲） |
| 交互形态 | 结构化提问卡片：ask_user 工具调用后本轮结束，回合制衔接 |
| 输入约束 | 模版、内容文件都可选；缺关键信息由 Agent 提问补齐 |
| 渲染路线 | A：主题提取 + pptxgenjs 重建（放弃 OOXML 直接改写模版，保真度换稳定性） |
| 执行路径 | 同步 chat ReAct 内完成（渲染为毫秒级进程内操作），不进 BullMQ |

## 第 1 节：公用 ask_user 机制

核心思路：**不加新 AgentEvent、不改 SSE 协议、不改消息持久化**。「向用户提问」是一个带
`endsTurn` 标记的普通工具，复用现有 tool_call 事件流与 `message_tool_calls` 持久化；前端对
`ask_user` 工具名做特殊渲染。

### core 改动

1. `ToolDefinition` 增加可选标记 `endsTurn?: boolean`（通用机制，不绑死 ask_user）。
2. `core/src/agent/agent.ts` ReAct 循环：执行完一个 `endsTurn` 工具后，正常 yield
   `tool_call` / `tool_result`，随后直接 `yield done` 结束本轮 run，不再回到 LLM。
   同一批 tool_calls 里 ask_user 之前的调用照常执行；ask_user 之后的剩余调用不再执行
   （run 已结束）。

### ask_user 工具（core/tools 内置）

```ts
input: {
  question: string,          // 必填
  options?: string[],        // 选项按钮，0–6 个
  allowFreeText?: boolean,   // 默认 true
}
```

- execute 返回占位文本：`[已向用户提问，等待回复；用户的回答将作为下一条消息出现]`。
  该占位结果进 workingHistory 与数据库，保证 tool_call→tool_result 配对完整，下一轮
  对话历史对 OpenAI 格式合法。
- 拥有此工具的 Agent 自动追加系统提示段（仿 `MEMORY_POLICY_PROMPT` 注入模式）：
  缺关键信息时用 ask_user 提问；一次只问一个问题；能给选项就给选项。

### 前端 AskUserCard

- `MessageBubble` 遇到 `name === "ask_user"` 的 tool_call → 渲染 AskUserCard 而非普通
  工具卡：问题文本 + 选项按钮（竖排 pill）+ 自由输入行（allowFreeText 时）。
- 点选项 = 把选项文本作为下一条用户消息直接发送（走现有 onSend）。
- 历史回放照常渲染（数据在 `message_tool_calls`）；仅当卡片是最后一条交互且非流式中才
  可点击；已回答的显示灰态并高亮其后第一条 user 消息的内容作为「用户的选择」。
- 用户无视卡片直接打字完全等价——回答就是下一条 user 消息，无状态机依赖。

### 公用接入

- `general` Agent 的 toolNames 加入 `ask_user`；`ppt` 必带；copywriting/image/video 等
  占位 Agent 待业务期接入时自取。

### 回合流程

```
LLM 决定提问 → tool_call(ask_user) → 执行(占位文本) → tool_result
→ done（SSE stream_end）
→ 前端渲染提问卡片 → 用户点选项/输入 → 新 user message → 下一轮 run
  （历史含 ask_user 调用 + 占位结果 + 用户回答，LLM 自然衔接）
```

## 第 2 节：PPT Agent 服务端

### 上传链路扩展

- `server/src/routes/uploads.ts` ALLOWED 白名单加 pptx mime
  （`application/vnd.openxmlformats-officedocument.presentationml.presentation`），
  沿用 20MB 文档上限。
- `AttachmentRef` 增加可选字段 `slot?: "ppt_template" | "content"`；前端上传后随消息
  附上，服务端随现有 message metadata 机制持久化（无表结构变更）。
- `attachment-extractor.ts`：
  - `slot === "ppt_template"`：不做文本提取，转成标记文本
    `[PPT模版已上传: 文件名 (templateAssetId: xxx)]` —— LLM 由此知道有模版并拿到
    assetId 传给渲染工具。
  - 内容文件：走现有 pdf/docx/xlsx/txt 提取；新增 pptx 文本提取分支
    （jszip 读 slide XML 的 `<a:t>`），旧 PPT 也能作为内容素材。

### 渲染层（仿 doc-tool 先例，均为纯函数、可单测）

- `server/src/ppt/theme-extractor.ts`：`extractTheme(bytes) → PptTheme`。
  jszip 解包 .pptx，解析 `ppt/theme/theme1.xml`（dk1/lt1/accent1–6、majorFont/minorFont）
  与 `presentation.xml` 幻灯片尺寸。解析失败 → 返回内置默认主题（降级，不抛错）。
- `server/src/ppt/renderer.ts`：`renderPptx(outline, theme) → Buffer`。
  pptxgenjs 定义三种版式：cover（封面）/ section（章节页）/ content（标题+要点页），
  应用主题色与字体。

Outline 结构：

```ts
{
  title: string,
  slides: [{
    layout: "cover" | "section" | "content",
    title: string,
    bullets?: string[],
    notes?: string,
  }]
}
```

### generate_ppt 工具（server/src/tools/ppt-tool.ts，注入 storage + db）

- 输入：`{ title, templateAssetId?, slides[] }`，JSON Schema 校验 layout 枚举。
- 执行：有 templateAssetId → 从 uploadStorage 读模版字节提主题；无或失败 → 默认主题；
  渲染 Buffer 存入 `data/documents`（`/static/documents` 已有静态路由）；
  `db.createAsset` 登记；返回 markdown 下载链接（前端现有 markdown 渲染直接可点）。
- 同步执行于 chat ReAct 路径内；不进 BullMQ（队列留给真正慢的 image/video）。

### ppt AgentDefinition 重写

- `toolNames: ["ask_user", "generate_ppt"]`（最小工具面）。
- systemPrompt 描述真实工作流：
  1. 盘点已有输入（模版标记、内容文件文本、用户描述）；
  2. 缺关键信息（主题、受众、页数、风格）用 ask_user 补齐，一次一问；
  3. 先以文本输出大纲让用户过目（自然语言确认，不强制卡片）；
  4. 调 generate_ppt 产出下载链接；
  5. 支持增量修改（「第 X 页改成…」→ 调整 outline 重新渲染）。

## 第 3 节：Web UI

### InputBox 增加 ppt 模式

- `InputMode` 增加 `"ppt"`；`ChatPanel` 按 `agent.type === "ppt"` 设 `mode="ppt"`，
  模型选择器用 llm 组。
- ppt 模式左侧工具区两个入口按钮（对齐 image/video「参考图」按钮的位置与样式）：
  - **PPT 模版**：`accept=".pptx"`，最多 1 个，重复选择替换；chip 带「模版」角标。
  - **内容文件**：accept 复用现有文档类型（pdf/docx/xlsx/txt/md/pptx…，不含图片），
    沿用 MAX_FILES 上限；chip 带「内容」角标。
- 组件内分开保存 `templateFile` / `contentFiles`，发送时合并为带 slot 标记的列表交给
  onSend；`useChat` 上传后把 slot 写入 attachment 随消息发出。两者都可选，纯文本可发。
- 样式全部使用现有 `var(--*)` token，不新增硬编码色值。

## 错误处理

| 场景 | 行为 |
|---|---|
| 模版损坏/非法 pptx | 主题提取降级默认主题；工具结果注明「模版解析失败，已用默认样式」，LLM 转告用户 |
| 渲染异常 | 工具返回 `isError`，Agent 向用户说明并可重试 |
| ask_user 无 options | 卡片只显示问题 + 自由输入 |
| 用户不点卡片直接打字 | 与点选项完全等价 |
| 非 .pptx 当模版上传 | 前端 accept 拦截 + 服务端 mime 校验 400 |

## 测试（TDD / Vitest，测试文件与源码同目录）

- **core**：`agent.test.ts` 加 endsTurn 用例（工具执行后 run 终止、占位 tool_result 入史、
  同批后续 tool_calls 不执行）；ask_user 工具 schema/execute 测试；`definitions.test.ts`
  更新 ppt 定义断言。
- **server**：`theme-extractor.test.ts`（fixture 模版 → 颜色/字体/尺寸断言；坏文件 → 默认
  主题）；`renderer.test.ts`（outline → 可解包 zip、slide 数量、文本在位）；
  `ppt-tool.test.ts`（asset 落库、链接返回、templateAssetId 缺失降级）；
  `uploads.test.ts` 加 pptx 用例；`attachment-extractor.test.ts` 加 template slot 分支 +
  pptx 文本提取分支。
- **web**：无组件测试基建，本期不新增。

## 新依赖

`pptxgenjs`、`jszip`（均加在 `@lot-agent/server`）。

## 范围外（明确不做）

- PPT 页面缩略图 / 可视化预览
- 图片自动配图
- 生成任务异步化（BullMQ）
- 模版母版级保真（OOXML 直接改写，路线 B——`renderer` 保持 outline+theme 纯函数边界，
  后续可替换实现）
