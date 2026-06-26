# 完整三层用户记忆 — 设计稿

日期：2026-06-26
范围：修复记忆系统的两个结构性缺陷（session 跨轮失效、缺少使用策略），形成一个会被模型在正确时机调用的完整用户记忆。

## 背景 / 问题

记忆系统已接线（工具注册、`agent.run` 注入 prompt、user 层落 Postgres），但两点导致它在实际对话中几乎不生效：

1. **Session 层跨不了消息。** `streamAgentResponse` 每个请求 `new AgentMemoryStore(...)`，ephemeral/session 是挂在该对象上的内存 `Map`，请求结束即被 GC。后果：第 N 轮写的 session 记忆在第 N+1 轮读不到；`store.ts` 的 20 分钟 TTL 是死代码；`formatForPrompt()` 在 run 开头作用于刚 new 的空 store，session 段永远为空、永不进 prompt。session 退化成 ephemeral。
2. **没有任何东西引导模型用记忆。** general 的 system prompt 无记忆策略；prompt 注入是「有数据才注入」，冷启动下 `user_memory` 空 → 不注入 → 模型不主动写 → 表一直空，形成自锁循环。

## 目标

- session 记忆按 `conversationId` 跨消息持久化（20 分钟 TTL）。
- 模型在正确时机自主调用记忆工具（写稳定偏好、清理过时项），靠 system prompt 策略驱动。
- 新增删除能力，使记忆可「清理」而非只堆积。

## 非目标（YAGNI）

- 前端记忆管理面板。
- ephemeral 持久化、user 层语义检索升级。
- copywriting/image/video 业务 agent 的记忆接入（它们不带记忆工具，自然不受影响）。

## 架构改动

### 1. Session 跨轮持久化（Redis，按 conversationId）

遵循项目 "interface-in-core / impl-in-server" 模式。

**`packages/core/src/memory/session-backend.ts`（新）**
```ts
export interface SessionMemoryBackend {
  load(conversationId: string): Promise<MemoryEntry[]>;
  save(conversationId: string, entries: MemoryEntry[]): Promise<void>;
}
```
整层序列化为一个 JSON，存单个 key；save 时刷新 TTL。

**`packages/server/src/memory/redis-session-backend.ts`（新）**
- 复用 `getRedis()`（ioredis）。
- key = `mem:session:{conversationId}`。
- `save`：`SET key JSON "EX" 1200`（20 分钟）。
- `load`：`GET` → `JSON.parse`（过期/缺失 → `[]`）。

**`AgentMemoryStore` 改动（`store.ts`，保持现有同步接口不破坏）**
- 构造参数新增 `sessionBackend?` 与 `conversationId?`。
- 新增 `async hydrate()`：若有 sessionBackend+conversationId，`load` 出的条目写入内存 session 层。
- session 的 `set`/`delete`：改完内存后 write-through，fire-and-forget `sessionBackend.save(conversationId, this.session.dump())`（best-effort，与现有 user 层 fire-and-forget 风格一致；失败静默）。
- **ephemeral 不持久化**，保持工作记忆语义（每次 run `clearEphemeral()`）。

**`packages/server/src/services/agent-service.ts`**
- 持有一个 `RedisSessionBackend`（init 时建，复用共享 redis 连接）。
- `streamAgentResponse` 构造 memory 时传入 `sessionBackend` + `conversationId`，并在构建 `context` 前 `await memory.hydrate()`。
- 由此 `agent.run` 现有的 `formatForPrompt()` 能拿到已水合 session 内容并注入 prompt —— 跨轮打通，无需改 `agent.run` 的注入逻辑本身。

### 2. 提示策略 + 清理工具

**`MEMORY_POLICY_PROMPT` 常量（`packages/core/src/memory`，导出）**

内容（中文，面向模型）：
- **user（持久）**：写跨会话稳定事实/偏好——称呼、语言偏好、行业/品牌背景、长期约束。仅在用户明确表达或可稳妥推断的稳定信息时写；不写一次性请求、临时上下文、敏感信息（密码/支付）。
- **session（会话）**：写仅当前对话有用的状态——待确认事项、当前任务的中间决定。20 分钟无活动过期。
- **ephemeral（工作）**：单回合临时中间结果，无需手动管理。
- 规则：(1) 写前先 `memory_list`/`memory_read` 去重，同一事实用相同 key 覆盖更新，不堆近义条目；(2) 用户更正、偏好变化、记忆过时 → `memory_write` 覆盖或 `memory_delete` 删除，保持精炼无矛盾；(3) user key 用稳定英文 snake_case（如 `preferred_language`、`brand_name`）；(4) 不为写而写，无长期价值的不进 user。

**注入点（`packages/core/src/agent/agent.ts`）**
- 在 run 构建 systemParts 时，**仅当 `allowedToolNames` 含记忆工具（memory_read/write/list/delete 任一）** 时，把 `MEMORY_POLICY_PROMPT` 追加进 systemParts。gated，避免无谓 token，且不带记忆工具的 agent 不受影响。

**`memory_delete` 工具（`packages/core/src/tools/memory-tools.ts`）**
- 参数 `{ tier: ephemeral|session|user, key }`。
- user → 现有 `AgentMemoryStore.delete("user")` 是 fire-and-forget，删除不可靠。`AgentMemoryStore` 新增 async 方法 `deleteUserMemory(key)`（内部 `await persistent.delete(userId, key)`），工具走该 await 路径，保证删除落库后再返回。
- session/ephemeral → 同步 `memory.delete(tier, key)`，session 触发 write-through save。
- 返回确认文案。

### 3. 清理项

**`packages/server/src/routes/memory.ts` 的 `/session/dump`**
当前每次 new 空 store → 永远 `[]`。改为接受 `?conversationId`：构造带 sessionBackend 的 store → `await hydrate()` → `dump("session")`；无 conversationId → `[]`。

## 数据流（修复后）

1. `POST /conversations/:id/messages` → `streamAgentResponse`。
2. 构造 `AgentMemoryStore({ persistent: pgAdapter, userId, sessionBackend, conversationId })`。
3. `await memory.hydrate()` —— 从 Redis 载入本会话 session 记忆。
4. `agent.run`：`clearEphemeral()` → systemParts 注入 `MEMORY_POLICY_PROMPT`（含记忆工具时）→ `formatForPrompt()` 注入已水合 session → `listUserMemory()` 注入 user 层。
5. 模型按策略调用 `memory_write`（session/user）/`memory_delete`/`memory_list`；session 写入 write-through 回 Redis（刷新 TTL）。
6. 下一条消息 hydrate 时读回 session —— 跨轮生效。

## 测试（TDD，Vitest 同址 `*.test.ts`）

- **`packages/core/src/memory/store.test.ts`**
  - fake `SessionMemoryBackend`（内存 Map<conversationId, entries>）。
  - 两个 store 实例共享同一 fake backend + 同一 conversationId：实例 A `set("session",...)` 后 save，实例 B `hydrate()` 能读到 —— 验证跨实例（跨请求）存活。
  - session `set`/`delete` 触发 backend.save。
  - ephemeral 不调用 backend（不持久化）。
- **`packages/core/src/tools/memory-tools.test.ts`**
  - `memory_delete` 对 session/user 行为正确。
  - write→list 去重语义（相同 key 覆盖）。
- **`packages/server/src/memory/redis-session-backend.test.ts`**
  - fake redis（实现用到的 get/set）验证 load/save round-trip + `EX 1200` 参数。

## 风险 / 取舍

- write-through best-effort：run 中途 crash 可能丢未 save 的 session 写。对 20 分钟会话状态可接受；换取不引入同步阻塞。
- 策略块每请求注入增加 token：已 gate 在「含记忆工具」的 agent，且仅 general 当前带记忆工具。必要成本。
- session 整层一个 key 序列化：会话内 session 条目量小，开销可忽略。
