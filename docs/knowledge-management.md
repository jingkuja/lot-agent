# 内置知识管理接口（S1 后端）

知识管理与聊天检索分别开关。设置 `KNOWLEDGE_MANAGEMENT_ENABLED=1` 并重启 server 后开放本页管理接口；`config/default.json` 中 `knowledge.source` 仍为 `remote`。目前不要切换为 `local`，本地 embedding/检索和工作台 UI 尚未交付。

server 启动时通过原迁移器执行第 24 版 `knowledge-foundation`。本版只建立元数据表，不要求旧部署先安装 vector 扩展；后续 S2 的索引 schema 将单独验证扩展和模型维度。Worker 本版不消费知识任务，资料保存后为 `stored` / `pending`，不宣称正文已经可检索。

## 数据与原件

- 复用 users/sessions 和现有 PostgreSQL Pool。新增 `rag_collections`、`rag_objects`、`rag_items`、`rag_item_revisions`、`rag_collection_items`、`rag_item_tags`、`rag_idempotency`、`rag_preview_tickets`。
- 资料关联、原件关联、活动/待发布版本及预览会话使用 owner 复合外键。更新要求期望 `version`，并发旧写入返回 409。
- 原件位于项目 `data/knowledge`，不加入任何 `/static` 挂载。原件键按用户 + SHA-256 隔离；只在服务端使用，不返回永久 URL。
- 流式上传限制格式、签名和大小，文本只接收 UTF-8；临时写入完整后原子链接成不可变文件。同用户同内容只存一份，不同用户独立存储。
- 删除资料撤销关联和预览、清空活动/待发布指针、提升运行代次；不立即物理删除原件。历史版本及已删除资料的原件仍计入容量。自动物理 GC、崩溃暂存清理和数据库失败后孤立文件对账尚未接入，因此不会冒险删除可能有引用的文件。
- 文本/PDF/DOCX 最大 50 MiB，图片 20 MiB，音频 100 MiB，视频 200 MiB。签名验证不等于完整解析；损坏内容将在 S2 解析阶段诊断。

## 会话管理接口

前缀 `/api/rag/manage`，使用现有 `Authorization: Bearer <session>`。请求不接受 owner、内部对象键或活动版本指针。

| 方法 | 路径 | 输入/行为 |
| --- | --- | --- |
| GET / POST | `/collections` | 分页列库 / `{name, description?}` 建库 |
| PATCH | `/collections/:id` | `{name, description?, version}` |
| DELETE | `/collections/:id` | `{version}`，只移除库与关联，保留资料 |
| GET / POST | `/items` | 分页列资料 / 新建笔记或书签 |
| GET | `/items/:id` | 归属检查后的元数据，不含磁盘键 |
| PATCH | `/items/:id` | `{version, title, description?, tags?, content?, sourceUrl?}`；正文仅笔记可改，URL 仅书签可改；创建新版本并取消旧待处理代次 |
| DELETE | `/items/:id` | `{version}`，返回受影响库 ID |
| PUT / DELETE | `/collections/:collectionId/items/:itemId` | 加入 / 移出单个库，重复加入幂等 |
| POST | `/uploads` | 原始文件字节流，见下文 |
| GET / HEAD | `/items/:id/revisions/:revisionId/content` | 鉴权文件流，支持单段 Range，非法 Range 为 416 |
| POST | `/items/:id/revisions/:revisionId/preview-ticket` | 生成最长 5 分钟且不超过会话到期时间的预览 URL |
| GET | `/storage` | `storedBytes`，含历史/待回收对象，同用户内容去重 |

列库、列资料支持 `limit=1..100`、`cursor`（使用返回的 `nextCursor`，不要自行拼接）。列资料可指定 `collectionId`。游标保留 PG 时间戳微秒精度，以免同毫秒内资料被跳过。

创建库、创建资料、上传文件必须发送 `Idempotency-Key`（1–128 个可见 ASCII 字符）。同用户同路由同 Key 同请求返回同结果；改请求而复用 Key 返回 409。事务级锁防止跨进程同时创建重复记录。重新上传仍会读取/校验字节，但不会产生重复实体或同用户重复原件。

笔记示例：

```json
{
  "sourceType": "note",
  "title": "产品说明",
  "content": "离线模式支持查看已下载资料。",
  "description": "内部测试资料",
  "collectionIds": [],
  "tags": ["产品"]
}
```

书签使用 `sourceType: "bookmark"` 和 `sourceUrl`（HTTP/HTTPS），只保存地址和说明，不请求远程网页。

## 流式上传

上传接口接收原始字节，不接收 multipart；这样无需将 200 MiB 视频完整读进内存。设置文件的 `Content-Type`，用 `X-Knowledge-Metadata` 发送经 `encodeURIComponent(JSON.stringify(...))` 编码的元数据（编码后上限 16 KiB）：

```ts
const metadata = { title: file.name, collectionIds: [collectionId], tags: [], description: "" };
await fetch("/api/rag/manage/uploads", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${sessionToken}`,
    "Idempotency-Key": crypto.randomUUID(),
    "Content-Type": file.type || "text/plain",
    "X-Knowledge-Metadata": encodeURIComponent(JSON.stringify(metadata)),
  },
  body: file,
});
```

成功返回 `{id, revisionId}`，通过资料详情获取保存/索引状态。MIME 白名单以服务端为准，不应给未知文件强制伪造 MIME；上面文本 fallback 只适用于已确认的文本文件。当前一请求一文件；批量收集 UI 和批次状态尚未提供。

小文件可鉴权 fetch 后创建 Blob URL。大文件使用预览接口返回的 `/api/rag/preview/<ticket>`；此 URL 不需要额外 Bearer 头，但每次请求都会重新检查原会话、票据有效期、资料删除状态、运行代次和版本可见性。退出、到期、编辑、删除后后续请求失效，已开始传输的数据不回收。没有真实会话的 DEBUG 用户无法签发票据，可使用管理文件流。

响应使用 `no-store`、`nosniff` 和安全内容策略。应用与仓库 nginx 对预览路径不记录 URL；新增代理也必须避免记录该能力 URL。nginx 为知识上传单独配置 200 MiB 上限和流式转发，不改变旧上传接口限制。

错误为 `{request_id, error: {code, message, retryable}}`。400 参数、401 会话、404 不存在或不可见、409 版本/幂等冲突、413 超限、415 格式不支持、503 依赖不可用。不会把数据库错误原文或原件键返回客户端。

## 验证

```bash
pnpm run test:knowledge
pnpm run check:knowledge:integration
pnpm run build
```

集成脚本仅允许本地 PG，从现有 `.env` 读取 PG 配置并只转交数据库变量；显式执行迁移，创建专用随机测试用户并清理。完整空 schema 验证放在事务内回滚，使用现有实例，不创建/删除容器和数据库。普通 `pnpm test` 不读取开发者数据库，跳过集成组。

S1 余项包括个人事实/记忆协调、已有资产归档、素材与快捷收集 UI；S2 再接可靠任务、全文解析和真实索引。外部 Key 与 Dify 路由尚未开放。
