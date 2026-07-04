# 多 API-Key 选择 + 无模型态 — 设计文档

日期: 2026-07-04
分支: feat/platform-foundation

## 背景

登录接口（tokenhub `/auth/login`）返回结构变更，新增 `api_keys` 数组字段，代表该账号能使用的全部模型调用 key：

```json
{
  "data": {
    "user_id": 2,
    "name": "13881071870",
    "api_key": "sk-7kLc...5Uir",
    "api_keys": ["sk-7kLc...5Uir", "sk-eqz...MWPe"],
    "access_token": "sk-7kLc...5Uir"
  }
}
```

目前系统只识别单个 `api_key`：`TokenhubClient.login` 只读 `data.api_key`，`users` 表只有一列
`api_key`，且**没有 key 的账号在登录时被 400 拦截**（`请前往中转站创建 api-key`）。模型目录经
`GET /api/models` → `getUserApiKey(userId)` → `tokenhub.listModels(apiKey)` 获取，按用户缓存在
Redis `models:${userId}`（约 5 分钟）。

本设计要实现三件事：

1. **登录解析 `api_keys`**：默认取第一个 key 作为激活 key，用它拉取模型目录。
2. **Key 切换设置**：进入 Agent 页面后，用户名右侧加设置按钮 → 弹窗列出该用户的 key（中间字符以
   `***` 遮罩），单选一个激活 key，切换后加载该 key 绑定的模型并刷新目录。
3. **无模型态**：账号无 key、或所选 key 无可用模型时，输入框与模型选择均显示「暂无模型」；点击发送
   不发送，提示「暂无能使用模型，请前往订阅管理页面设置 api-key 和 key 能访问的模型」。

## 已确认的决策

- **Key 选择语义**：单选。同一时间只有一个 key 处于激活态；选中即切换并加载它绑定的模型。UI 视觉上
  是 checkbox 列表，但语义等价于单选（radio）。
- **无 key 登录**：允许登录，进入「暂无模型」态（取消现有的 400 拦截）。
- **「订阅管理页面」**：当前项目无此页面，提示语仅显示纯文案，不做任何跳转。

## 约束与既有约定

- CLAUDE.md：**绝不把原始 api_key/email 发给前端**（`toPublicUser` 是唯一出口）。因此 key 只以
  遮罩形式跨网络传输，前端**按 index 选择**，服务端据 index 映射回真实 key。
- ESM 导入带显式 `.js` 后缀；2 空格缩进；新逻辑单元用 Vitest 做 TDD，测试文件同目录 `*.test.ts`。
- 接口在 core、实现带 DB/Redis 的在 server。本改动全部落在 server + web，不新增 core 抽象。
- 迁移是内联的（`db/database.ts` `migrate()`），用 `ALTER ... ADD COLUMN IF NOT EXISTS`。
- Web 主题：所有颜色走 `var(--*)` token，禁止硬编码 hex/rgba。

## 组件级设计

### 1. 后端：登录解析 `api_keys`

**`packages/server/src/tokenhub/client.ts`**

- `TokenhubLoginResult` 改为 `{ userId: number; name: string; apiKeys: string[] }`（移除单数
  `apiKey`）。
- `login()` 解析：`apiKeys = data.api_keys ?? (data.api_key ? [data.api_key] : [])`（向后兼容旧结构
  与仅返回单个 key 的情况；两者都无 → 空数组）。POST 返回体类型加上 `api_keys?: string[]`。

**`packages/server/src/db/database.ts`**

- 迁移新增：`ALTER TABLE users ADD COLUMN IF NOT EXISTS api_keys JSONB;`
- `StoredUser` 加 `api_keys?: string[] | null`（pg 的 JSONB 已解析为 JS 数组，无需再 `JSON.parse`）。
- `upsertUserByExternalId` 入参改为 `{ externalUserId; username; apiKeys: string[] }`：
  - 写入 `api_keys = $keys`（`JSON.stringify` 或直接传数组由 pg 序列化，统一用 `JSON.stringify` 存
    JSONB），`api_key = apiKeys[0] ?? null`（激活 key）。
  - 允许 `apiKeys` 为空 → `api_key` 存 `null`。
- 新增方法：
  - `getUserApiKeys(userId): Promise<string[]>` — 读 `api_keys`，非数组/NULL 返回 `[]`。
  - `setActiveApiKey(userId, index): Promise<string>` — 在 JS 中读出 `api_keys` 数组；`index` 越界
    （`< 0` 或 `>= 长度`）抛错；否则 `UPDATE users SET api_key = $1`（参数为 `keys[index]`），返回该原始 key。

**`packages/server/src/routes/auth.ts`**

- `POST /login`：移除 `if (!result.apiKey) return 400`（`NO_API_KEY` 常量删除）。无 key 账号照常
  `upsertUserByExternalId({ ..., apiKeys: result.apiKeys })` → 建会话 → 返回 `{ token, user }`。

### 2. 后端：遮罩 + 激活索引（唯一出口 `toPublicUser`）

**`packages/server/src/db/user-sanitize.ts`**

- `PublicUser` 扩展：
  ```ts
  apiKeys: string[];        // 遮罩后的 key，例 "sk-7kL***5Uir"
  activeKeyIndex: number;   // 激活 key 在 apiKeys 中的下标；无 key 时为 -1
  ```
- 新增 `maskKey(key): string`：`key.length <= 12 ? "***" : key.slice(0, 6) + "***" + key.slice(-4)`。
- `toPublicUser(u)`：`const keys = u.api_keys ?? []`；`apiKeys = keys.map(maskKey)`；
  `activeKeyIndex = u.api_key ? keys.indexOf(u.api_key) : -1`（找不到也为 -1）。
- 原始 key 绝不出现在返回值中。

`/me` 与登录返回都用 `toPublicUser`，因此二者自动带上遮罩列表与激活索引，刷新页面即可重建弹窗。

### 3. 后端：切换激活 key 的新端点

**`packages/server/src/routes/keys.ts`（新文件，挂载于 `/api/keys`，走 `authMw`）**

- `POST /api/keys/active`，body `{ index: number }`：
  - `userId = c.get("userId")`。
  - 调 `db.setActiveApiKey(userId, index)`；越界 → `400 { error: "无效的 key" }`。
  - 清 Redis 缓存 `models:${userId}`（`service.redis.del(...)`），使下次 `GET /api/models` 用新 key
    重新拉取。
  - 返回 `{ ok: true, activeKeyIndex: index }`。
- 在服务器组装路由处挂载该路由（与其它 `/api/*` 资源一致，位于 `authMw` 之后）。

### 4. 后端：无 key 时 `/api/models` 返回空目录（不再 401）

**`packages/server/src/routes/models.ts`**

- 现状：`if (!catalog) return c.json({ error: "no api key" }, 401)`。前端 `request()` 对 401 会
  `clearToken()` 并派发 `lot:unauthorized` → **无 key 用户会被立刻登出**，与「允许无 key 登录并停在
  暂无模型态」矛盾。
- 改为：无 key/无目录时返回 `200 { llm: [], image: [], video: [] }`。tokenhub 网络失败仍返回 502。
- 有 key 但该 key 无模型时，`tokenhub.listModels` 自然返回空数组 → enrich 后为空目录 → 200 空。

### 5. 前端：类型与 API 客户端

**`packages/web/src/api/client.ts`**

- `User` 扩展：`apiKeys: string[]; activeKeyIndex: number`。
- 新增 `api.setActiveKey(index): Promise<{ ok: boolean; activeKeyIndex: number }>` →
  `POST /keys/active`。

### 6. 前端：设置按钮 + Key 弹窗

**`packages/web/src/components/BrandHeader.tsx`**

- 在用户名 `brand-email` 右侧加设置齿轮按钮（`onOpenKeySettings` 回调，仅在有 `user` 时显示），
  沿用现有按钮样式，颜色走 `var(--*)`。

**`packages/web/src/components/KeySettingsModal.tsx`（新）**

- Props：`keys: string[]`（遮罩）、`activeIndex: number`、`busy: boolean`、`onSelect(index)`、
  `onClose()`。
- 结构参考 `AgentCenterModal`（遮罩层 + 卡片 + 关闭）。列出每个 key 为一行，行内 checkbox：
  `activeIndex` 对应行为选中态；点击其它行触发 `onSelect(index)`（单选，切换即选中）。
- `keys` 为空时显示「当前账号暂无可用 key，请前往订阅管理页面设置」纯文案。
- `busy` 时禁用行点击（切换请求进行中）。

### 7. 前端：Workspace 编排切换 + 刷新目录

**`packages/web/src/pages/Workspace.tsx`**

- `useModels()` 已暴露 `reload`；取出使用。
- 新增 state：`activeKeyIndex`（初值 `user.activeKeyIndex`）、`keyModalOpen`、`keyBusy`。
- `handleSelectKey(index)`：`setKeyBusy(true)` → `await api.setActiveKey(index)` →
  成功后 `setActiveKeyIndex(index)`、`setSelectedModels(EMPTY_SELECTED)`（丢弃旧 key 的选择）、
  `reload()`（拉新目录；`fillModelDefaults` 副作用据新目录回填，空目录则保持空 → 暂无模型）→
  `finally setKeyBusy(false)`。可选：成功后关闭弹窗。
- 把齿轮回调 `onOpenKeySettings={() => setKeyModalOpen(true)}` 传给 `BrandHeader`；渲染
  `KeySettingsModal`（`keys={user.apiKeys}`、`activeIndex={activeKeyIndex}`）。

### 8. 前端：无模型态展示

**`packages/web/src/components/ModelPicker.tsx`**

- `models.length === 0` 时：
  - 触发按钮文案由「默认」改为「**暂无模型**」。
  - 弹层空态文案由「无更多模型，请联系管理员」改为「**暂无模型，请前往订阅管理页面设置**」。

**`packages/web/src/components/InputBox.tsx`**

- 新增 prop `noModels?: boolean`。由 `ChatPanel`/`Workspace` 传入，派生自：存在模型选择器
  （`onModelChange` 存在）且当前分组 `models.length === 0`。
- `handleSend`：进入时若 `noModels` → **不发送**，`setNoModelNotice(true)` 展示内联提示：
  「**暂无能使用模型，请前往订阅管理页面设置 api-key 和 key 能访问的模型**」。用户输入变化时清除该提示。
- 发送按钮保持可点（需求要求点击发送才弹提示），不因 `noModels` 禁用。
- 提示样式复用 `input-modal-hint` 类或新增等价类，颜色走 `var(--*)`。

`ChatPanel` 需把 `noModels` 从 Workspace 透传到 `InputBox`（Workspace 已知 `modelGroup` 与
`modelCatalog`，可算 `modelCatalog[modelGroup].length === 0`）。

## 数据流

```
登录:
  POST /api/auth/login
    → tokenhub.login → { userId, name, apiKeys[] }
    → upsertUserByExternalId(api_keys=full, api_key=apiKeys[0]??null)
    → toPublicUser → { ..., apiKeys: masked[], activeKeyIndex }
    → 前端 setUser

进页面拉目录:
  GET /api/models → getUserApiKey → 有 key: tokenhub.listModels → 目录; 无 key: 200 空目录

切换 key:
  KeySettingsModal 点选 index
    → api.setActiveKey(index)
    → POST /api/keys/active → setActiveApiKey + del(models:userId)
    → 前端 setActiveKeyIndex + setSelectedModels(EMPTY) + reload()
    → GET /api/models 用新 key 重新拉取 → 目录更新 / 空 → 暂无模型

发送拦截:
  InputBox.handleSend: noModels ? 显示提示并 return : 正常 onSend
```

## 错误处理

- tokenhub 登录失败/解密失败 → 沿用现有 `LOGIN_FAIL`（401）。
- `setActiveKey` index 越界 → 400，前端弹窗保持原激活项不变并可提示。
- `GET /api/models` tokenhub 失败 → 502；无 key → 200 空目录（不 401，避免误登出）。
- 切换 key 请求失败 → `finally` 复位 `keyBusy`，`activeKeyIndex` 不变。

## 测试计划

后端：
- `tokenhub/client.test.ts`：`login` 解析 `api_keys`；只有 `api_key` 时回落为 `[api_key]`；两者都无 → `[]`。
- `db`（database 测试）：`getUserApiKeys` 解析 JSONB；`setActiveApiKey` 越界抛错、正常更新 `api_key`。
- `user-sanitize.test.ts`：`maskKey` 遮罩规则；`activeKeyIndex` 正确（含无 key → -1、api_key 不在
  列表 → -1）；返回值不含原始 key。
- `routes/auth.test.ts`：无 key 登录返回 200 + token（不再 400）。
- `routes/models.test.ts`：无 key → 200 空目录（非 401）。
- `routes/keys.test.ts`（新）：切换设置激活 key 并清缓存；越界 → 400；未认证 → 401。

前端：
- `KeySettingsModal`：渲染遮罩行、激活项选中、点击触发 `onSelect(index)`。
- `InputBox`：`noModels` 时点击发送不调用 `onSend` 且显示提示；有模型时正常发送；输入变化清除提示。
- `ModelPicker`：空目录时文案为「暂无模型」。

## 不在本次范围

- 真实「订阅管理页面」/路由（仅文案）。
- 多 key 合并目录（已确认单选）。
- 计费按 key 维度拆分（沿用当前激活 key 计费）。
```
