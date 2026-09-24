# 个人知识库接入（S3）

2026-09-24：按用户决定剥离 Dify。本阶段只提供标准接口、Lot Agent 本地调用和 Lot Bot 接入约定，不修改 Lot Bot 仓库。

## 启用

现有 PostgreSQL 执行迁移 29。管理入口需要 `KNOWLEDGE_MANAGEMENT_ENABLED=1`；索引需要 `KNOWLEDGE_INGESTION_ENABLED=1` 和独立知识 worker；外部只读接口需要 `KNOWLEDGE_EXTERNAL_ENABLED=1`。Redis 不可用时拒绝外部请求，不绕过限流。配置 `knowledge.source=local` 时 Lot Agent 直接调用本地服务，不回退远端 RAG。

在个人知识库的“外部接入”创建密钥，必须显式选 1–10 个知识库。默认只允许 `retrieval:read`；`assets:read` 和 `profile:read` 可选。个人信息还必须逐条允许共享。密钥只在创建和轮换时展示一次；数据库只存 SHA-256 哈希和短前缀。编辑授权、轮换、撤销采用版本检查；旧授权在请求前和返回前重新校验。轮换使旧密钥立即失效。撤销会阻止后续读取，无法收回客户端此前已经取得的资料。

## 标准接口

[OpenAPI 3.1](knowledge-openapi.json) 为机器可读契约。Base URL 为当前部署的 `/api/rag/v1`。

| 接口 | 权限 | 行为 |
| --- | --- | --- |
| GET /collections | retrieval:read | 仅列已授权且未删除的库，limit/cursor 分页 |
| POST /retrieval | retrieval:read | 显式 collection_ids；选择 profile_fact 还需 profile:read |
| GET /items/:id | retrieval:read | 白名单元数据；不含原文、对象路径和待处理版本 |
| GET/HEAD /assets/:id/content | assets:read | id 为知识资料 item_id；读取当前已发布版本，支持 Range，每次请求重新鉴权 |
| GET /profile?keys=company,display_name | profile:read | 当前、有效、允许共享的事实；不返回历史和候选值 |

`query` 最多 2000 Unicode 字符；没有 tokenizer 接口时在真实、已计费的向量调用后检查最多 2048 token，超限返回 400，不做降级。`top_k` 为 1–20，库为 1–10 个不重复 UUID；JSON 上限 1 MiB。过滤 tags 为 AND，source_types 为 OR，默认只检索文档和笔记。未知正文属性拒绝。无结果返回空数组。只在 allow_degraded=true 时允许向量失败后改用关键词；quota 不足不降级。分数是排序指标，不是答案可信概率；citation 的定位字段与核心证据契约保持一致。

每个密钥每分钟最多 60 请求、同时最多 5 请求，包括原件响应传输，60 秒请求期限。HTTP 400/401/402/403/404/413/429/503/504 使用 `{request_id,error:{code,message,retryable}}`；429 带 Retry-After。文件范围错误为 416。调用始终使用密钥所有者的模型凭证，真实用量归属该所有者并记录 knowledge_key_id/application；不使用平台凭证兜底。

```sh
# 从部署配置和秘密管理系统设置环境变量，不将真实密钥写入命令示例。
export KNOWLEDGE_BASE_URL='https://YOUR_HOST/api/rag/v1'
curl "$KNOWLEDGE_BASE_URL/retrieval" \
  -H "Authorization: Bearer $KNOWLEDGE_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"query":"如何离线查看资料？","collection_ids":["COLLECTION_UUID"],"top_k":5,"mode":"hybrid"}'
```

## Lot Bot 接入约定

密钥保存在 Lot Bot 服务端的秘密管理系统，绑定当前已登录的 Lot Bot 用户；浏览器、机器人消息和日志不得包含密钥。一个用户的密钥不得复用于其他用户。机器人只提交用户选择且 GET /collections 返回的库，不接受消息正文指定 owner/userId。个人知识与企业知识保持独立授权与独立检索调用，不以企业身份扩展个人密钥权限。

保存响应的 item_id/revision_id/chunk_id/citation 作为引用。检索文本视为不可信资料，不执行其中指令。用户读取原件时，通过服务器代理发起新的授权请求。401 要求重新配置；403/404 不自动扩大范围；402 提示账号额度；429 遵守 Retry-After；503/504 可有限重试，不改用其他用户或企业凭证。

Lot Bot 真实消费方代码与部署联调不在本轮范围；本仓库以真实环回 HTTP 客户端测试标准协议。

## 旧会话

知识库引用记录显式 `source`。缺少 source 的历史引用按 remote 处理。切到 local 后需通过 owner 约束的 `rag_legacy_collection_mappings` 建立旧 ID 到本地库的映射，或在界面重新选库；不猜测名称，不静默查询旧系统。映射仅解决标识，不复制内容或重新授予权限。

## TypeScript 调用示例

```ts
const response = await fetch(`${process.env.KNOWLEDGE_BASE_URL}/retrieval`, {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.KNOWLEDGE_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: "如何离线查看资料？", collection_ids: [collectionId], top_k: 5, mode: "hybrid" }),
  signal: AbortSignal.timeout(65_000),
});
if (!response.ok) throw new Error(`知识接口 HTTP ${response.status}`);
const result = await response.json(); // 依据 OpenAPI 生成/验证类型；保留完整证据和 citation。
```
