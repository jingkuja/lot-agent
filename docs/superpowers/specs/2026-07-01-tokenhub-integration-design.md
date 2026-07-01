# Tokenhub 集成：外部登录鉴权 + 动态模型目录 + 模型选择器

**Date:** 2026-07-01
**Status:** Approved
**Topic:** 将 tokenhub（`https://tokenhub.todoucloud.com/api/agent-market`）接入为平台的
**鉴权来源**与**模型来源**：密码登录换取用户 `api_key`；每个用户用自己的 key 拉取可用模型目录并调用模型。

## 背景

现状：
- **鉴权**：邮箱登录（`upsertUserByEmail`，无密码），自建 `sessions` 表 + Bearer token。`users(id UUID, email UNIQUE NOT NULL, name, created_at)`。
- **模型**：服务启动时从 `config/default.json` 静态注入（`populateModelRegistry`），全局、非按用户。模型 id 目前**硬编码在 agent 定义**（`def.defaultModelId`）与 `conversations.ts`（image→`gpt-image-2-token`、video→`kling-standard`）。没有按会话的模型覆盖，也没有模型选择器 UI。
- **Provider 基础设施已就绪**：`makeImageProvider`/`makeVideoProvider`（`server/src/generation/config.ts`）已接受 `{ baseUrl, apiKey, adapter, model }` 且默认指向 tokenhub；`OpenAIProvider`/`ChatCompletionsImageProvider`/`HappyhorseVideoAdapter` 均接受 base+key+model。当前 key 来自共享的 `TOKENHUB_API_KEY` env。

目标：把「谁登录、用什么 key、有哪些模型、走哪个 provider」从静态全局改为**按用户动态**。

## 关键决策（已确认）

1. **密码保护**：RSA 非对称加密。后端进程内临时生成 RSA-OAEP 2048 密钥对，前端登录前拉公钥加密密码；后端私钥解密后再调 tokenhub。无需 TLS 也能防明文抓包。
2. **用户身份**：以 tokenhub 的 `user_id` 作为主身份（`external_user_id`）。
3. **动态计费**：config 维护价格表 + 按类型默认价；未知模型用默认价（保留现有计费管道）。
4. **模型选择生效范围**：按会话持久化（conversations 新增 `model_id` 列）。
5. **模型调用 key**：用各用户自己的 `api_key`。Provider 不再是全局单例，按请求构建。
6. **模型目录拉取**：后端代理 `GET /api/models` + Redis 短 TTL（~300s）缓存。

## 接口约定（tokenhub）

- `POST /auth/login  { username, password }` → `{ data: { user_id, name, api_key, access_token }, success }`（其他一律视为失败）。
- `GET /models`（Bearer api_key）→ `{ data: { llm: string[], image: string[], video: string[] }, success }`。
- Base URL：`https://tokenhub.todoucloud.com/api/agent-market`（登录/目录）；模型调用 base 沿用 `generation.baseUrl`（当前 `.../v1`），可在 config 映射。

## 架构

### 1. 外部鉴权 + RSA（`server/src/auth`, `routes/auth.ts`）

- **临时密钥对**：启动时 `node:crypto` 生成 RSA-OAEP 2048 密钥对，仅存内存。
- `GET /api/auth/public-key`（公开）→ SPKI 公钥（base64/PEM）。
- `POST /api/auth/login { username, encryptedPassword }`（公开）：
  1. 用内存私钥 `crypto.privateDecrypt`(RSA-OAEP, SHA-256) 解密。
  2. `TokenhubClient.login(username, password)`。
  3. `success:true` → `upsertUserByExternalId({ externalUserId: user_id, username: name, apiKey: api_key })` → 建本地 session → 返回 `{ token, user }`（**剥离 api_key**）。
  4. 任意失败（解密错/网络错/`success:false`/超时）→ `401`，固定消息 `登录失败，请稍后再试或者联系管理员`。不泄露底层原因。
- **`TokenhubClient`**（server，thin fetch 封装：`login`、`listModels`），便于测试 mock。
- **FE `Login.tsx`**：用户名 + 密码字段；提交时拉公钥 → Web Crypto `RSA-OAEP`/SHA-256 加密密码 → 提交。无新 npm 依赖（浏览器内置 Web Crypto、Node 内置 crypto）。

### 2. 用户表（`db/database.ts`，inline 幂等迁移）

- `ALTER TABLE users ADD COLUMN IF NOT EXISTS external_user_id BIGINT`（唯一索引 `CREATE UNIQUE INDEX IF NOT EXISTS`），`ADD COLUMN IF NOT EXISTS username VARCHAR(255)`，`ADD COLUMN IF NOT EXISTS api_key TEXT`；`ALTER COLUMN email DROP NOT NULL`。
- 新方法：`upsertUserByExternalId({ externalUserId, username, apiKey })`、`getUserApiKey(userId): Promise<string|null>`。
- `StoredUser` 增字段；**统一 sanitizer 在返回给客户端前剥离 `api_key`**（`/login`、`/me`）。

### 3. 动态模型目录（`routes/models.ts` 新增）

- `GET /api/models`（auth）：取调用者 `api_key` → `TokenhubClient.listModels` → 返回三类富化列表：
  ```ts
  { llm: Model[], image: Model[], video: Model[] }
  Model = { id: string; type: "llm"|"image"|"video"; provider: string;
            label?: string; description?: string; pricing: Pricing }
  ```
- **Redis 缓存** key `models:<userId>`，TTL ~300s。
- 富化来自新 config 块 **`modelCatalog`**：
  - `pricing`: `{ [modelId]: {inputPrice,outputPrice,unitPrice} }` + `defaults`（按 type）。
  - `providerMap`: image/video 模型 → 本地 adapter，例如
    `{ "happyhorse-1.0-t2v":"happyhorse", "veo3.1":"happyhorse", "gemini-2.5-flash-image":"chat-completions" }`；
    另有按 type 默认（`image → chat-completions`、`video → happyhorse`）。**llm 恒走 openai provider。**

### 4. 按用户 provider 解析 + 计费

- **`ProviderFactory`（server）**：入参 `{ modelId, type, apiKey }` → 经 `modelCatalog.providerMap` 定 provider 种类，构建：
  - `llm` → `new OpenAIProvider({ apiKey: userKey, baseUrl: tokenhubBase, model: modelId })`
  - `image` → `makeImageProvider({ baseUrl, apiKey: userKey, adapter, model: modelId, mock:false })`
  - `video` → `makeVideoProvider({ baseUrl, apiKey: userKey, adapter:"happyhorse", model: modelId, mock:false })`
  - 按请求构建（构造廉价）；模型调用不再用启动期全局单例。
- **Chat 路径**（`agent-service.ts`）：模型 id = `conversation.model_id ?? agentDef.defaultModelId`；取调用者 `api_key`；经 `ProviderFactory` 建 LLM。
- **异步生成路径**（`routes/tasks` + `workers/index.ts`）：用 task 选中的模型；worker 依 task 行的 `user_id` 从 DB 载入该用户 `api_key` 构建 provider。
- **计费**：`UsageMeter` 价格解析回退 `modelCatalog.pricing[id]` → 按 type 默认价，使动态模型仍可计费。

### 5. 模型选择器 UI（`components/ModelPicker.tsx` 新增）

- 触发按钮置于输入区右下角（`MediaSettings` 旁）：图标 + 当前模型名 + chevron。
- 弹层含**搜索框（字母快速过滤，大小写不敏感子串匹配）** + 可滚动列表（`图标 · 名称 · 描述 · 标签` 行），对齐 image1 样例。
- 按 **agent 的类型**过滤列表（文本类 agent→`llm`、图片 agent→`image`、视频 agent→`video`）。
- 全部使用现有 `var(--*)` 主题 token，不硬编码颜色。

### 6. 模型选择持久化（按会话）

- 迁移：`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS model_id VARCHAR(100)`。
- `POST /api/conversations/:id/messages` 接受可选 `modelId` → 持久化到 `conversation.model_id` 后使用。新会话把选择存于 FE state，随首条消息发送并落库。
- `GET /api/conversations/:id` 返回 `model_id`，供选择器恢复。

## 错误处理

- 登录任何环节失败 → 统一 `401` + 固定中文提示；服务端记日志（含底层原因）不外泄。
- `/api/models`：tokenhub 报错或 key 失效 → `502`/`401`，前端选择器显示「模型加载失败」并允许重试；缓存未命中失败不写缓存。
- 模型调用失败沿用现有 AgentEvent/任务错误管道。
- api_key 绝不出现在任何返回客户端的响应体、日志的 info 级别、或前端。

## 测试（Vitest，TDD，`*.test.ts` colocated）

- RSA 加解密 round-trip（FE Web Crypto 编码 ↔ BE `privateDecrypt`）。
- `TokenhubClient` login/models：success 与 failure→generic-error（mock fetch）。
- 目录富化 + 价格解析（已知 id 命中、未知走默认）。
- `ProviderFactory` 路由（llm→openai、image→chat-completions、video→happyhorse）。
- `upsertUserByExternalId`（插入/更新幂等）。
- api_key sanitizer（`/login`、`/me` 响应不含 key）。
- 模型选择器过滤逻辑（子串、大小写不敏感）。

## 实现顺序（各自可独立测试）

1. 鉴权 + RSA + 用户表（含 `TokenhubClient`、sanitizer）
2. 目录端点 + `modelCatalog` config + 缓存
3. `ProviderFactory` + 计费回退
4. conversations `model_id` + 消息端点接受 modelId
5. 选择器 UI（`ModelPicker` + 接入 InputBox/agent 类型过滤）

## 非目标（YAGNI）

- 不做持久化 RSA 密钥/密钥轮换（进程内临时对已足够）。
- 不做 tokenhub `access_token` 与本地 session 的双向同步（本地 session 独立）。
- 不改现有 mock/真实 provider 的内部实现，只改「用谁的 key、哪个 model」。
- 不做模型目录的管理后台；`providerMap`/`pricing` 手工维护在 config。
