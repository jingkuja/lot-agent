# 文件上传（图片 + 文档）设计

日期：2026-06-24
分支：feat/platform-foundation

## 目标

在聊天输入框增加上传文件按钮（样式参考用户提供的 `+` 图标，置于发送按钮左侧），
支持用户随消息附带图片与文档；后端接收文件并以**混合方式**送达大模型：
图片走多模态（`image_url`），文档解析为文本注入 prompt。

## 范围

- 支持类型：
  - 图片：jpg / png / webp / gif → 多模态，不解析
  - 纯文本：txt / md / csv / json / 常见代码文件 → 直接 UTF-8 读取
  - PDF → 文本提取（`pdf-parse`）
  - docx → 文本提取（`mammoth`）
- 展示内容与发给模型的内容**分离**：气泡显示「文字 + 附件 chip」，
  模型收到「文字 + 图片 ContentPart + 文档解析文本」。
- 多轮：附件持久化在 user 消息 `metadata.attachments`，每轮重新 materialize，
  后续提问模型仍能看到文件内容。

### 非目标（YAGNI）

- 不做文档解析结果的持久化缓存（`assets.extracted_text`）——每轮重新解析，日后再优化。
- 不做 OCR、不解析图片中的文字、不解析 xlsx/pptx。
- 不做拖拽上传、粘贴上传（本期仅按钮选择；可作后续增强）。
- 不改 `assets` / `messages` 表结构（复用现有列）。

## 架构与数据流

```
[Web InputBox] --(1) 选文件--> 本地暂存 File[] + 显示 chip（含移除按钮）
     |
     |--(2) 点发送: 对每个文件 POST /api/uploads (multipart)
     v
[Server uploads route] 校验类型/大小 -> ObjectStorage.put -> assets 行(type='upload')
     |  返回 { assetId, filename, mime, size, url }
     v
[Web] 收集 attachments[] -> POST /messages { content, attachments:[{assetId,...}] }
     v
[Server messages route] -> AgentService.streamAgentResponse(content, attachments)
     |
     |-- saveUserMessage(content, metadata.attachments=[...])  // 气泡=文字+chip
     |-- 构造发给模型的 user message（见“消息构造”）
     v
[Agent.run] 模型收到多模态 user message
```

上传是独立的一步（先落盘拿 `assetId`，再带 `assetId` 发消息），
复用现有 `assets` 表与 `/static/assets/:filename` 静态服务，比把文件塞进 SSE 消息体更干净。

## 组件设计

### 1. 前端 `InputBox.tsx`

- 在 `input-toolbar-right` 内、发送/停止按钮的**紧邻左侧**新增一个 `+` 上传按钮
  （与用户截图一致），SVG 描边图标，复用 `var(--*)` 主题色，hover 态参考现有 `btn-send`。
- `<input type="file" hidden multiple accept=...>`，点 `+` 触发 `click()`。
- 本地 state：`attachments: PendingAttachment[]`（`{file, id, previewUrl?}`）。
  超过 5 个或超大小白名单时，前端即时提示并拒绝加入。
- 选中文件后在输入框上方渲染 chip 行：图片显示缩略图，文档显示文件名 + 类型图标，
  每个 chip 有移除按钮。
- `onSend` 签名扩展为 `onSend(content, files)`；保持纯文本可发（文字或文件至少其一）。

### 2. 前端上传 + 发送链路

- `api.uploadFile(file): Promise<UploadedAttachment>` —— `POST /api/uploads`，
  `FormData`，带 Bearer。返回 `{ assetId, filename, mime, size, url }`。
- `useChat.streamMessage(content, attachments)`：
  - 发送前先并发上传所有文件，得到 `UploadedAttachment[]`。
  - user `DisplayMessage` 增加 `attachments` 字段用于气泡渲染。
  - `api.sendMessage` body 增加 `attachments`。
- 上传失败：toast 提示并中止该次发送，不进入流式。

### 3. 后端 `routes/uploads.ts`（新）

- `POST /api/uploads`，`authMw` 保护，解析 multipart（Hono `c.req.parseBody()` 或
  `formData()`）。
- 校验：mime 在白名单、size 在上限；否则 400。
- `ObjectStorage.put({ key: 'uploads/<userId>/<uuid>.<ext>', body, contentType })`。
- 复用现有 asset 注册逻辑写 `assets` 行：`type='upload'`、`task_id=null`、
  `user_id`、`storage_key`、`url`、`mime`、`size_bytes`。
- 返回 `{ assetId, filename, mime, size, url }`。

### 4. 后端 `services/attachment-extractor.ts`（新）

- `extract(attachment): Promise<ContentPart>` 按 mime 分派：
  - 图片 → `{ type:'image', image:{ url, mediaType:mime } }`
  - txt/md/csv/json/代码 → UTF-8 读取，`{ type:'text', text: wrap(filename, body) }`
  - pdf → `pdf-parse` 提取，同上 wrap
  - docx → `mammoth` 提取，同上 wrap
  - 失败/不支持 → `{ type:'text', text:'[附件 x.ext 无法解析，已忽略内容]' }`（不抛错）
- 文本 wrap 格式：
  ```
  [附件: report.pdf]
  <解析文本，截断到 ~30k 字符，超出加 …[内容过长已截断]>
  [/附件: report.pdf]
  ```
- 文件 body 从 `ObjectStorage` 读取（按 `storage_key`）。
  注：`ObjectStorage` 目前无 `get`，需新增 `get(key): Promise<Buffer>`（LocalStorage 实现读盘）。

### 5. 后端 `AgentService.streamAgentResponse` 改造

- 签名增加 `attachments?: AttachmentRef[]`。
- `saveUserMessage(conversationId, content, { attachments })` →
  写 `messages.metadata.attachments`（`addMessage` 已支持 metadata）。
- 构造发给模型的首个 user message：
  - `parts: ContentPart[] = []`
  - 文字非空 → `parts.push({type:'text', text: content})`
  - 每个 attachment → `parts.push(await extractor.extract(att))`
  - `agent.run` 接收的 userMessage 由 string 扩展为支持 `ContentPart[]`
    （`Agent.run` 与 `Message.content` 已支持 `ContentPart[]`；需把 run 入参从
    `string` 放宽为 `string | ContentPart[]`，并在内部按现状包成 user message）。

### 6. 多轮 `loadHistory` 改造

- 读到带 `metadata.attachments` 的 user 消息时，把 `content` 重新组装为
  `ContentPart[]`：原文字 + 重新 materialize 的附件（图片→image part，
  文档→重新解析注入）。后续轮次模型始终看得到文件。
- 代价：长文档每轮重新解析 + 重新计 token，由现有 metering 兜底。

### 7. 持久化 / 重新加载对话

- `getConversation` 返回每条 user 消息的 `metadata.attachments`。
- 前端 `loadMessages` 把 `attachments` 填入 `DisplayMessage`，
  user 气泡渲染 chip；点击图片预览、文档下载，复用 `/static/assets/...`。

## 数据模型

- `messages.metadata.attachments: AttachmentRef[]`
  - `AttachmentRef = { assetId, filename, mime, size, url, kind:'image'|'doc' }`
- `assets` 行：`type='upload'`，`task_id=null`，其余复用现有列。
- 无表结构变更。

## 上限 / 校验（默认值，可调）

- 每条消息最多 5 个文件。
- 图片每个 ≤ 10MB；文档每个 ≤ 20MB。
- 单文档解析文本截断到 ~30k 字符。
- 类型白名单在上传路由强制校验，非法 → 400。

## 错误处理

- 上传：类型/大小不合法 → 400，前端提示并不加入。
- 解析：失败降级为占位文本，不中断对话。
- 发送：任一文件上传失败 → 中止本次发送并提示，不进入流式。

## 测试（Vitest，colocated）

- `attachment-extractor.test.ts`：txt/json 直读、pdf/docx 提取（小样本）、
  截断逻辑、不支持类型降级、解析异常降级。
- uploads route：白名单/大小校验返回 400；合法文件写 assets 并返回元数据。
- `loadHistory`：带 attachments 的 user 消息能重新 materialize 为 ContentPart[]。
- 前端：InputBox chip 增删、上限拦截（按现有前端测试惯例，若有）。

## 新增依赖

- `pdf-parse`、`mammoth`（加入 `@lot-agent/server`）。

## 影响的文件

- 新增：`server/src/routes/uploads.ts`、`server/src/services/attachment-extractor.ts`
- 改：`web/src/components/InputBox.tsx`、`web/src/components/MessageBubble.tsx`（chip 渲染）、
  `web/src/hooks/useChat.ts`、`web/src/api/client.ts`、`web/src/App.css`
- 改：`server/src/services/agent-service.ts`、`server/src/services/message-repository.ts`、
  `server/src/index.ts`（注册路由）
- 改：`core/src/agent/agent.ts`（run 入参放宽）、`core/src/storage/types.ts` +
  `local-storage.ts`（新增 `get`）
