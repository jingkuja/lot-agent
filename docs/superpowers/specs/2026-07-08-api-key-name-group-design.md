# API-Key 增加 name/group 字段 — 设计文档

日期: 2026-07-08
分支: feat/platform-foundation

## 背景

在 [[2026-07-04-multi-apikey-and-empty-model-state-design]] 中，tokenhub 登录接口的 `api_keys`
被建模为纯字符串数组，并在服务端/前端所有环节（`TokenhubClient` → `users.api_keys` JSONB →
`toPublicUser` → 前端 `User.apiKeys` → `KeySettingsModal`）以 `string[]` 传递。

tokenhub `/auth/login` 接口现在给每个 key 附加了 `name`（用户在中转站起的名字）与 `group`（分组，
可能为空字符串）：

```json
{
  "data": {
    "user_id": 2,
    "name": "13881071870",
    "api_key": "sk-7kLc...5Uir",
    "api_keys": [
      {"api_key": "sk-7kLc...5Uir", "name": "开放API密钥", "group": ""},
      {"api_key": "sk-eqz...MWPe", "name": "test", "group": "agent2_demo"}
    ],
    "access_token": "sk-7kLc...5Uir"
  }
}
```

本设计要把 `name`/`group` 从 tokenhub 一路带到 Key 设置弹窗，替换掉现有的纯字符串建模。

## 已确认的决策

- **旧数据兼容**：`users.api_keys` 里已有的历史行仍是纯字符串数组（无 name/group）。不做一次性回填
  迁移；`upsertUserByExternalId` 本就在每次登录时用 tokenhub 最新响应整体覆盖 `api_keys`，用户下次
  登录后该行自然变成新结构。读取路径（DB 读出、tokenhub 解析）需兼容「纯字符串」与「对象」两种条目，
  统一归一化为内部形状。
- **展示兜底**：条目缺 `name`（或整体是历史遗留的裸字符串）时，展示名回退为遮罩后的 key 本身（沿用
  现有行为）；`group` 为空/缺失时不渲染分组徽标（不占位、不显示空括号）。
- **UI 布局**：每行以 `name` 作为主标签（加粗），`group`（非空时）以小徽标形式渲染在 name 旁，遮罩
  key 作为次要文本显示在下方。徽标复用现有中性标签配色 `--tag-general-fg`/`--tag-general-bg`（与
  `InputBox.tsx` 里 `attachment-slot-badge` 系列徽标同源），不新增颜色变量。

## 约束与既有约定

- CLAUDE.md：**绝不把原始 api_key 发给前端**——`toPublicUser` 仍是唯一出口，`name`/`group` 是非敏感
  展示字段，可以随遮罩 key 一起下发。
- 服务端/前端各自独立声明类型（无共享包），沿用仓库现状（`client.ts`/`database.ts`/
  `user-sanitize.ts`/前端 `api/client.ts` 目前就是各自重复声明 `apiKeys: string[]`）。
- 迁移仍是内联 `ALTER ... ADD COLUMN IF NOT EXISTS`；本次不改表结构（`api_keys` 仍是 JSONB，只是
  数组元素形状从字符串变成对象），不需要新迁移。
- Web 主题：颜色一律走 `var(--*)` token。

## 组件级设计

### 1. 类型

新增内部类型（服务端），替代裸 `string[]`：

```ts
// packages/server/src/tokenhub/client.ts 及 db/database.ts 共用概念（各自声明，不建共享包）
interface RawApiKeyEntry {
  apiKey: string;
  name?: string;
  group?: string;
}
```

对外展示类型（服务端 `user-sanitize.ts` 产出，前端 `api/client.ts` 镜像声明）：

```ts
interface PublicApiKey {
  key: string;      // 遮罩后的 key，例 "sk-7kL***5Uir"
  name: string;     // 已解析，永不为空（缺失时回退为 key）
  group?: string;   // 为空/缺失时省略此字段
}
```

### 2. 后端：tokenhub 登录解析

**`packages/server/src/tokenhub/client.ts`**

- POST 返回体类型的 `api_keys` 字段改为 `(string | { api_key: string; name?: string; group?: string })[]`
  （tokenhub 可能仍对旧版客户端返回纯字符串，防御性兼容两种形状）。
- `login()` 内新增归一化：
  ```ts
  const apiKeys: RawApiKeyEntry[] = (data.api_keys ?? (data.api_key ? [data.api_key] : []))
    .map((e) => (typeof e === "string" ? { apiKey: e } : { apiKey: e.api_key, name: e.name, group: e.group }));
  ```
- `TokenhubLoginResult.apiKeys` 类型改为 `RawApiKeyEntry[]`。

### 3. 后端：持久化与读取

**`packages/server/src/db/database.ts`**

- `StoredUser.api_keys` 类型改为 `(RawApiKeyEntry | string)[] | null`（历史行是 `string[]`，新行是
  对象数组，两种都可能从 pg 读出）。
- 新增内部辅助函数 `normalizeApiKeys(raw: (RawApiKeyEntry | string)[] | null): RawApiKeyEntry[]`：
  逐项把裸字符串转成 `{ apiKey: item }`，对象项原样透出；`raw` 非数组/null 时返回 `[]`。放在
  `database.ts` 内部（或抽到独立小文件），`getUserApiKeys`、`setActiveApiKey`、`user-sanitize.ts`
  统一调用它，不各自实现一遍。
- `upsertUserByExternalId` 入参 `apiKeys: RawApiKeyEntry[]`；写入 `api_keys = JSON.stringify(apiKeys)`，
  `api_key = apiKeys[0]?.apiKey ?? null`（激活 key 标量列不变）。
- `getUserApiKeys(userId): Promise<RawApiKeyEntry[]>`：读出后过 `normalizeApiKeys`。
- `setActiveApiKey(userId, index)`：读出后过 `normalizeApiKeys`，越界检查不变；
  `UPDATE users SET api_key = $1`，参数为 `keys[index].apiKey`（而非整个对象）。

### 4. 后端：遮罩 + 展示（唯一出口 `toPublicUser`）

**`packages/server/src/db/user-sanitize.ts`**

- `PublicUser.apiKeys` 类型改为 `PublicApiKey[]`（原来是 `string[]`）。
- `toPublicUser(u)`：
  ```ts
  const keys = normalizeApiKeys(u.api_keys);
  const activeKeyIndex = u.api_key ? keys.findIndex((k) => k.apiKey === u.api_key) : -1;
  const apiKeys = keys.map((k) => ({
    key: maskKey(k.apiKey),
    name: k.name || maskKey(k.apiKey),
    ...(k.group ? { group: k.group } : {}),
  }));
  ```
- `maskKey` 逻辑不变。原始 key 依旧绝不出现在返回值中；`name`/`group` 是非敏感字段，直接透出。

### 5. 后端：切换激活 key 端点

**`packages/server/src/routes/keys.ts`**

- 逻辑不受影响（按 index 操作，不关心元素形状），无需改动。

### 6. 前端：类型与展示

**`packages/web/src/api/client.ts`**

- 新增 `interface PublicApiKey { key: string; name: string; group?: string }`；`User.apiKeys` 类型
  由 `string[]` 改为 `PublicApiKey[]`。

**`packages/web/src/components/KeySettingsModal.tsx`**

- Props 的 `keys: string[]` 改为 `keys: PublicApiKey[]`。
- 每行渲染：
  ```tsx
  <span className="key-name">{k.name}</span>
  {k.group && <span className="key-group-badge">{k.group}</span>}
  <span className="key-mask">{k.key}</span>
  ```
  `key-name` 加粗、`key-mask` 保持现有 monospace 次要样式（可能需要从当前单行布局改成两行：
  名称+徽标一行，遮罩 key 小字一行）。
- CSS（`App.css`，`.key-row` 一带）新增：
  ```css
  .key-name { font-weight: 600; }
  .key-group-badge {
    padding: 1px 6px; border-radius: 999px; font-size: 11px; line-height: 16px;
    color: var(--tag-general-fg); background: var(--tag-general-bg);
  }
  ```
  （沿用 `attachment-slot-badge`/`badge-general` 的配色变量，不新增颜色 token。）

其余前端调用点（`Workspace.tsx` 传 `user.apiKeys` 给 `KeySettingsModal`）不需要改动逻辑，仅类型
随 `User.apiKeys` 一起变化。

## 数据流

```
登录:
  POST /api/auth/login
    → tokenhub.login → 归一化 api_keys → RawApiKeyEntry[]
    → upsertUserByExternalId(api_keys=full 对象数组, api_key=apiKeys[0]?.apiKey??null)
    → toPublicUser → normalizeApiKeys（兼容历史 string[]）→ PublicApiKey[]（key/name/group）
    → 前端 setUser → KeySettingsModal 渲染 name + group 徽标 + 遮罩 key

切换 key: 不变（按 index，见既有设计）
```

## 错误处理

- tokenhub 返回的条目形状异常（既非字符串也无 `api_key` 字段）：归一化时按「跳过该条目」处理，不
  抛错、不中断登录（宁可少一个 key，也不能让登录失败）。
- 历史纯字符串行与新对象行混用（同一账号不同时间登录写入）：`normalizeApiKeys` 逐项判断类型，
  两种形状在同一数组内混存也能正确处理。

## 测试计划

后端：
- `tokenhub/client.test.ts`：`login` 解析对象数组 `api_keys`；解析纯字符串数组（旧结构兼容）；
  解析混合数组；条目缺 `api_key` 时跳过；两者都无 → `[]`。
- `db`（database 测试）：`normalizeApiKeys` 对字符串项/对象项/混合数组的归一化；`getUserApiKeys`
  返回归一化结果；`setActiveApiKey` 用 `keys[index].apiKey` 正确更新标量列。
- `user-sanitize.test.ts`：`toPublicUser` 输出的 `apiKeys` 含 `key`/`name`/`group`；`name` 缺失时
  回退遮罩 key；`group` 为空字符串时该字段被省略；`activeKeyIndex` 按 `apiKey` 匹配（含历史字符串
  行）。

前端：
- `KeySettingsModal`：渲染 `name` 与 `group` 徽标（`group` 为 `undefined` 时不渲染徽标）；遮罩
  key 仍以次要文本展示；点击行为不变。

## 不在本次范围

- 按 `group` 分组/筛选 key 列表（本次只展示，不做交互分组）。
- 一次性数据库回填迁移（依赖用户下次登录自然覆盖）。
- 计费/配额按 key 名称或分组维度统计。
