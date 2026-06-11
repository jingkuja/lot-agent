# Lot Agent — PostgreSQL 数据库设计

## 概述

从 SQLite 迁移到 PostgreSQL，支持完整的对话历史、消息详情、用户评分、链路追踪。

## ER 关系图

```
conversations 1──N messages
conversations 1──N traces
messages     1──0..1 message_ratings
messages     1──N message_tool_calls
traces       1──N spans
```

## 表结构

### 1. conversations — 对话会话

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | UUID | PK, default gen_random_uuid() | 对话 ID |
| title | VARCHAR(500) | NOT NULL, default 'New Chat' | 对话标题 |
| model | VARCHAR(100) | | 使用的模型名称 |
| provider | VARCHAR(50) | | LLM 提供者 (openai/anthropic) |
| system_prompt | TEXT | | 该对话使用的 system prompt |
| status | VARCHAR(20) | NOT NULL, default 'active' | active / archived / deleted |
| metadata | JSONB | default '{}' | 扩展元数据 |
| created_at | TIMESTAMPTZ | NOT NULL, default now() | 创建时间 |
| updated_at | TIMESTAMPTZ | NOT NULL, default now() | 最后更新时间 |

索引：`idx_conversations_status_updated` (status, updated_at DESC)

---

### 2. messages — 对话消息

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | UUID | PK | 消息 ID |
| conversation_id | UUID | FK → conversations(id) ON DELETE CASCADE | 所属对话 |
| role | VARCHAR(20) | NOT NULL | user / assistant / tool / system |
| content | TEXT | NOT NULL, default '' | 消息正文 |
| tool_call_id | VARCHAR(100) | | tool 消息关联的 tool_call ID |
| token_count | INTEGER | | 该消息的 token 数 |
| model | VARCHAR(100) | | 生成该消息的模型 (assistant 消息) |
| latency_ms | INTEGER | | 生成耗时毫秒 (assistant 消息) |
| status | VARCHAR(20) | NOT NULL, default 'completed' | completed / streaming / error |
| metadata | JSONB | default '{}' | 扩展元数据 |
| created_at | TIMESTAMPTZ | NOT NULL, default now() | 创建时间 |

索引：
- `idx_messages_conversation` (conversation_id, created_at)
- `idx_messages_role` (role)
- `idx_messages_tool_call_id` (tool_call_id)

---

### 3. message_tool_calls — 工具调用记录

assistant 消息可能包含多个工具调用，单独建表避免 JSON 嵌套。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | UUID | PK | 记录 ID |
| message_id | UUID | FK → messages(id) ON DELETE CASCADE | 所属 assistant 消息 |
| tool_call_id | VARCHAR(100) | NOT NULL | LLM 返回的 tool_call ID |
| tool_name | VARCHAR(200) | NOT NULL | 工具名称 |
| tool_input | JSONB | NOT NULL, default '{}' | 工具输入参数 |
| status | VARCHAR(20) | NOT NULL, default 'pending' | pending / running / completed / error |
| created_at | TIMESTAMPTZ | NOT NULL, default now() | 创建时间 |

索引：`idx_tool_calls_message` (message_id)

---

### 4. message_ratings — 消息评分

用户对 assistant 消息的评价（点赞/踩），支持修改。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | UUID | PK | 评分 ID |
| message_id | UUID | FK → messages(id) ON DELETE CASCADE, UNIQUE | 关联消息 (一条消息一次评分) |
| rating | SMALLINT | NOT NULL, CHECK (1 or -1) | 1 = like, -1 = dislike |
| feedback | TEXT | | 可选的文字反馈 |
| created_at | TIMESTAMPTZ | NOT NULL, default now() | 创建时间 |
| updated_at | TIMESTAMPTZ | NOT NULL, default now() | 更新时间 |

索引：`idx_ratings_message` (message_id), `idx_ratings_rating` (rating)

---

### 5. traces — 链路追踪

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | UUID | PK | Trace ID |
| conversation_id | UUID | FK → conversations(id) ON DELETE CASCADE | 所属对话 |
| model | VARCHAR(100) | | 使用的模型 |
| provider | VARCHAR(50) | | LLM 提供者 |
| total_tokens | INTEGER | NOT NULL, default 0 | 总 token 消耗 |
| total_latency_ms | INTEGER | | 总耗时毫秒 |
| status | VARCHAR(20) | NOT NULL, default 'ok' | ok / error / timeout |
| error_message | TEXT | | 错误信息 (status=error 时) |
| metadata | JSONB | default '{}' | 扩展元数据 |
| created_at | TIMESTAMPTZ | NOT NULL, default now() | 创建时间 |

索引：`idx_traces_conversation` (conversation_id, created_at DESC)

---

### 6. spans — 追踪跨度

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | UUID | PK | Span ID |
| trace_id | UUID | FK → traces(id) ON DELETE CASCADE | 所属 Trace |
| parent_span_id | UUID | FK → spans(id) ON DELETE SET NULL | 父 Span |
| name | VARCHAR(100) | NOT NULL | 跨度名称 (llm.chat / tool.execute / mcp.call / skill.load) |
| status | VARCHAR(20) | NOT NULL, default 'ok' | ok / error |
| attributes | JSONB | default '{}' | 属性 (toolName, model, etc.) |
| events | JSONB | default '[]' | 事件列表 |
| start_time | TIMESTAMPTZ | NOT NULL | 开始时间 |
| end_time | TIMESTAMPTZ | | 结束时间 |
| duration_ms | INTEGER | GENERATED ALWAYS AS (extract(epoch from (end_time - start_time)) * 1000) | 自动计算耗时 |

索引：`idx_spans_trace` (trace_id, start_time), `idx_spans_name` (name)

---

## 字段说明

### rating 值域

| 值 | 含义 |
|----|------|
| 1 | 👍 点赞 (like) |
| -1 | 👎 踩 (dislike) |

### status 值域

**conversations.status:**
| 值 | 含义 |
|----|------|
| active | 正常对话 |
| archived | 已归档 |
| deleted | 软删除 |

**messages.status:**
| 值 | 含义 |
|----|------|
| completed | 正常完成 |
| streaming | 流式传输中 |
| error | 生成出错 |

**traces.status:**
| 值 | 含义 |
|----|------|
| ok | 正常完成 |
| error | 执行出错 |
| timeout | 超时 |

**spans.status:**
| 值 | 含义 |
|----|------|
| ok | 正常完成 |
| error | 执行出错 |

---

## 常用查询场景

1. **对话列表** — `SELECT * FROM conversations WHERE status = 'active' ORDER BY updated_at DESC`
2. **对话消息** — `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at`
3. **消息评分统计** — `SELECT rating, COUNT(*) FROM message_ratings GROUP BY rating`
4. **对话 Trace 列表** — `SELECT * FROM traces WHERE conversation_id = $1 ORDER BY created_at DESC`
5. **Trace 详情** — `SELECT * FROM spans WHERE trace_id = $1 ORDER BY start_time`
6. **Token 消耗统计** — `SELECT SUM(total_tokens) FROM traces WHERE conversation_id = $1`
