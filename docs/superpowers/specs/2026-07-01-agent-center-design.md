# Agent 中心(子 Agent 安装 / 绑定)设计

- 状态:已确认,待写实现计划
- 日期:2026-07-01
- 相关代码:`packages/core/src/agents`、`packages/server/src/routes/agents.ts`、`packages/server/src/db/database.ts`、`packages/web/src/components/{AgentSwitcher,BrandHeader,Sidebar}.tsx`、`packages/web/src/pages/Workspace.tsx`、`packages/web/src/api/client.ts`

## 目标

引入「Agent 中心」:一个按用户绑定的子 Agent 市场。用户可安装 / 卸载子 Agent,只有已安装的才出现在切换器里。通用助手对所有人默认存在、永远排第一、不可卸载。切换器容量有限,超出用「更多」气泡承载,并支持 MRU 插队排序(持久化)。

同时把上一轮讨论的 **PPT 制作**、**合同审核** 作为 stub 子 Agent 定义加入,使其可在中心里被安装。

## 现状(exploration 结论)

- `/api/agents`(`routes/agents.ts`)直接返回 `agentRegistry.list()` 全量定义,**无任何每用户状态**。
- `AgentSwitcher`(Image #3 胶囊)渲染传入的任意 agents;`Workspace` 强制 `general` 第一,并**硬编码隐藏** `copywriting`(`switcherAgents` 过滤)。
- `BrandHeader` 是侧栏顶部品牌卡(Image #1);侧栏底部目前**无按钮区**。
- Agent 是 `core/agents/definitions` 里的静态定义并在启动时注册。
- 鉴权中间件 `c.set("userId", s.userId)`,`userId` 为 session 的 UUID 字符串;`conversations.user_id` 是 `VARCHAR(100)`,存的就是该 UUID。→ 新表 `user_agents.user_id` 用 `VARCHAR(100)` 与之一致。

## 决策(已与用户确认)

| 议题 | 决策 |
|---|---|
| 范围 | Agent 中心基础设施 + 新增 PPT/合同审核 Agent + 为已有 Agent 补图标/元信息 |
| 安装状态存储 | 服务端每用户表 `user_agents`(跨设备一致) |
| 新用户默认安装 | 通用 + 图片 + 视频(通用不可卸载) |
| 溢出排序 / 卸载 | MRU 持久化 + 支持卸载(通用除外) |
| 「更多」阈值 | 通用 + 最多 6 个子 Agent;子 Agent 数 > 6 才出现「更多」 |
| 「更多」弹层 | 轻量溢出气泡(仅列未显示的已装 Agent 供快速切换),与 Agent 中心市场分离 |

## 数据模型

新表(inline migrate,沿用 `CREATE TABLE IF NOT EXISTS` + 幂等风格):

```sql
CREATE TABLE IF NOT EXISTS user_agents (
  user_id      VARCHAR(100)     NOT NULL,   -- 存 c.get("userId"),与 conversations.user_id 同型
  agent_id     VARCHAR(64)      NOT NULL,
  sort_order   DOUBLE PRECISION NOT NULL DEFAULT 0,  -- 越小越靠前;MRU 插队取 (min - 1)
  installed_at TIMESTAMPTZ      NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_user_agents_user ON user_agents (user_id, sort_order);
```

约束:
- **通用(general)永远视为已安装**,即使表中无对应行;服务端拒绝卸载 general。
- `sort_order` 用浮点,便于「插到最前」只需取当前该用户子 Agent 的 `min(sort_order) - 1`,无需批量重排。

## 默认安装 & 懒播种

- 读取「带安装状态的 agents」时,若该用户在 `user_agents` **无任何行** → 播种 `general(0)`、`image(1)`、`video(2)`。之后一律以表为准。
- 前端删除硬编码隐藏 `copywriting` 的逻辑;可见性改由「是否安装」决定。`copywriting` 默认不安装,在中心里可安装。

## Agent 元信息

- `AgentDefinition` 增加可选字段 `category?: string`(取值示例:`创作` / `办公` / `审核`)。卡片展示用 `name / description / category / type`。
- 图标沿用客户端 `type → icon` 映射;为新类型补 SVG 图标。
- 新增两个 **stub 子 Agent 定义**(遵循仓库 stub 约定,只有占位 systemPrompt / toolNames,无业务逻辑):
  - `ppt` — 名称「PPT 制作」,category「办公」,type 新增 `ppt`。
  - `contract` — 名称「合同审核」,category「审核」,type 新增 `contract`。
- 相应更新 `AgentType` 联合类型与注册表。

## API 表面(`/api/agents`,均需 Bearer,用户按 userId 隔离)

- `GET /api/agents` — 返回全量定义,每项附加 `installed: boolean`、`sortOrder: number | null`。首次访问触发懒播种。
- `POST /api/agents/:id/install` — 为当前用户安装:`sort_order = 该用户当前 max(sort_order) + 1`(追加到末尾)。幂等(已装则无副作用)。未知 agent id → 404。
- `DELETE /api/agents/:id/install` — 卸载。`id == general` → 400。未装视为幂等成功。
- `POST /api/agents/:id/promote` — MRU 插队:`target.sort_order = 该用户子 Agent 的 min(sort_order) - 1`,使其成为第一个子 Agent(整体第二位)。持久化。若该 Agent 未安装 → 400(需先安装);未知 id → 404。

## 排序与可见性规则(明确)

- 通用固定第 1 位,不计入「6」,不可卸载。
- 已安装子 Agent 按 `sort_order` 升序排列。
- 切换器可见项 = 通用 + 前 6 个子 Agent。
- 子 Agent 数 > 6 → 显示 通用 + 前 6 个 + 「更多」按钮。
- 从「更多」气泡选中某项 → 调 `promote`(移到子 Agent 首位 = 整体第二位)→ 进入可见区;原可见区第 6 个被挤入溢出。变更持久化。
- 新安装的 Agent 追加到末尾(最大 sort_order);若已超 6 则出现在「更多」里,否则直接作为胶囊显示。
- 当前激活的 Agent 被卸载 → 前端回落到通用并进入新会话态。

## 前端组件

- `api/client.ts`:`Agent` 接口增 `installed: boolean`、`sortOrder: number | null`;新增 `installAgent(id)`、`uninstallAgent(id)`、`promoteAgent(id)`。
- 新 hook `useAgents`(替代 App 里的静态传递):持有 agents 列表,提供 install / uninstall / promote(乐观更新 + 失败回拉)。
- `AgentSwitcher`:通用优先 → 已装子 Agent(按 sortOrder,截取前 6)→ 超出显示「更多」。
- `AgentOverflowPopover`(新):轻量浮层,列出未显示的已装 Agent;点选 = `promote` + 激活。
- `AgentCenterModal`(新):大弹窗,卡片网格(参照 Image #2 布局),按 category 分组 / 筛选,每卡片「安装 / 已安装·卸载」按钮。
- `SidebarFooter`「Agent 中心」按钮(新):放在 `workspace-sidebar` 底部(`<Sidebar>` 之下),点击打开 `AgentCenterModal`。
- 主题:全部使用现有 `var(--*)` token,禁止硬编码 hex / rgba(否则浅色模式破坏)。

## 测试(Vitest,colocated `*.test.ts`)

- 仓库/服务层:
  - 安装追加(max+1)、卸载、promote 的 sort_order 计算。
  - general 不可卸载守卫(400)。
  - 未知 id 安装(404)。
  - 默认播种(空 → general/image/video)。
  - `GET /api/agents` 的 `installed` / `sortOrder` 注解正确。
- 纯排序 helper 单测:给定已装列表 → 可见 6 + 溢出的切分,通用恒第一。

## 错误处理

- 卸载 general → 400。
- 安装未知 agent id → 404。
- 权限:按 `userId` 隐式隔离,不跨用户读写。
- 激活的 Agent 被卸载 → 回落通用,进入新会话态。

## 明确不做(YAGNI)

- 不做 Agent 评分 / 排行 / 搜索(市场卡片仅分组 + 筛选)。
- 不做 Agent 版本管理、付费安装、灰度。
- PPT / 合同审核的**真实业务逻辑**不在本次范围(仅 stub 定义,可被安装)。
- 不引入正式 migration runner(沿用 inline migrate)。
