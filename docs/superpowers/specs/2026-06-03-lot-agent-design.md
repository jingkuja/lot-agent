# Lot Agent - 设计文档

## 概述

Lot Agent 是一个具备多 LLM 接入、工具调用、Skill 加载、MCP 接入和自主循环执行能力的 AI Agent 系统。采用 Web UI + HTTP API 模式对外提供服务。

## 技术选型

| 层级 | 技术 | 理由 |
|------|------|------|
| 语言 | TypeScript | 类型安全，AI SDK 生态最成熟 |
| 包管理 | npm workspaces monorepo | 模块化，包间独立可测试 |
| Web 框架 | Hono | 轻量、高性能、TypeScript 原生 |
| 前端 | React | 生态最丰富 |
| LLM SDK | `openai` + `@anthropic-ai/sdk` | 官方维护，流式输出支持 |
| MCP | `@modelcontextprotocol/sdk` | 官方 SDK |
| 构建 | tsup (库) + Vite (前端) | 快速、配置简单 |
| 数据库 | PostgreSQL (pg) | 关系型、生产就绪 |

## 架构

```
lot-agent/
├── packages/
│   ├── core/              # @lot-agent/core
│   │   ├── src/
│   │   │   ├── llm/       # LLM 提供者（OpenAI / Anthropic）
│   │   │   ├── agent/     # ReAct 循环引擎
│   │   │   ├── tools/     # 工具系统（文件读写等内置工具）
│   │   │   ├── mcp/       # MCP 客户端
│   │   │   ├── skills/    # Skill 加载器
│   │   │   ├── logger/    # 日志与链路追踪
│   │   │   ├── config/    # 配置管理
│   │   │   └── types/     # 公共类型定义
│   │   └── package.json
│   ├── server/            # @lot-agent/server
│   │   ├── src/
│   │   │   ├── routes/    # API 路由
│   │   │   ├── services/  # 会话管理、Agent 编排
│   │   │   ├── db/        # PostgreSQL 数据层
│   │   │   └── index.ts   # 入口
│   │   └── package.json
│   └── web/               # @lot-agent/web
│       ├── src/
│       │   ├── components/ # React 组件
│       │   ├── pages/      # 页面
│       │   ├── hooks/      # 自定义 hooks
│       │   └── api/        # API 调用层
│       └── package.json
├── skills/                # Markdown skill 文件
├── config/                # 默认配置
└── package.json
```

## 模块设计

### 1. LLM 提供者层 (`packages/core/src/llm/`)

统一接口，双实现：

```typescript
interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

interface LLMProvider {
  chat(messages: Message[], tools?: Tool[]): AsyncIterable<ChatChunk>;
}

interface ChatChunk {
  type: 'text' | 'tool_call' | 'done';
  content?: string;
  toolCall?: ToolCall;
  finishReason?: string;
  usage?: { promptTokens: number; completionTokens: number };
}
```

- OpenAI: 使用 `openai` SDK，兼容所有 OpenAI API 兼容服务
- Anthropic: 使用 `@anthropic-ai/sdk`，原生 tool_use
- 两者都走流式输出，统一为 `AsyncIterable<ChatChunk>`
- API key 和模型通过配置文件管理

### 2. Agent 循环引擎 (`packages/core/src/agent/`)

ReAct 推理-行动循环：

```
用户输入
  → [System Prompt 组装]
  → LLM 思考（可能产出 tool_calls）
  → 执行工具调用
  → 将结果追加到消息历史
  → LLM 继续思考
  → ... 循环直到 LLM 给出最终回复（无 tool_calls）
  → 返回最终结果
```

```typescript
interface AgentConfig {
  maxIterations: number;       // 最大循环次数，防止死循环
  systemPrompt: string;        // 基础 system prompt
  dynamicPromptParts?: string[]; // 动态拼接的 prompt 片段
}

interface Agent {
  run(userMessage: string, context: AgentContext): AsyncIterable<AgentEvent>;
}

type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; output: unknown }
  | { type: 'thinking'; content: string }
  | { type: 'done'; summary: string };
```

### 3. 工具系统 (`packages/core/src/tools/`)

统一工具接口：

```typescript
interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}

interface ToolResult {
  content: string;
  isError?: boolean;
}
```

内置工具（MVP）：
- `read_file` — 读取本地文件
- `write_file` — 写入本地文件
- `list_files` — 列出目录文件
- `execute_command` — 执行 shell 命令（受限沙箱）
- `search_files` — 按内容搜索文件

工具注册中心：
```typescript
class ToolRegistry {
  register(tool: Tool): void;
  get(name: string): Tool | undefined;
  getAll(): Tool[];
  toLLMTools(): LLMTool[];  // 转为 LLM API 的 tools 格式
}
```

### 4. Skill 系统 (`packages/core/src/skills/`)

Markdown 文件定义 Skill，动态加载注入 prompt：

```markdown
---
name: code-review
description: Review code for bugs and improvements
triggers:
  - "review this code"
  - "check my code"
---

You are a code reviewer. When reviewing code:
1. Check for bugs and logic errors
2. Suggest performance improvements
3. Verify naming conventions
...
```

```typescript
interface Skill {
  name: string;
  description: string;
  triggers: string[];       // 触发关键词
  content: string;          // Markdown 正文，作为 prompt 注入
}

class SkillLoader {
  loadFromDirectory(dir: string): Skill[];
  match(message: string, skills: Skill[]): Skill[];  // 匹配触发词
}
```

- Skill 文件放在 `skills/` 目录
- Agent 运行时根据用户消息匹配触发词，将匹配到的 skill 内容注入 system prompt
- 未匹配任何 skill 时使用默认 system prompt

### 5. MCP 客户端 (`packages/core/src/mcp/`)

```typescript
class MCPClientManager {
  connect(config: MCPConfig): Promise<void>;   // 连接 MCP Server
  disconnect(serverId: string): Promise<void>;
  getTools(): Tool[];                           // 获取所有 MCP 工具，转换为内部 Tool 格式
  callTool(name: string, input: unknown): Promise<ToolResult>;
}

interface MCPConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string;      // stdio 模式
  args?: string[];       // stdio 模式
  url?: string;          // sse/http 模式
}
```

- MCP 配置存储在 `config/mcp-servers.json`
- 启动时连接所有已配置的 MCP Server
- MCP 工具自动注册到 ToolRegistry，与内置工具统一调用

### 6. 日志与链路追踪 (`packages/core/src/logger/`)

```typescript
interface Trace {
  id: string;
  conversationId: string;
  startTime: number;
  endTime?: number;
  spans: Span[];
  metadata: { model: string; totalTokens: number; duration?: number };
}

interface Span {
  id: string;
  traceId: string;
  parentSpanId?: string;
  name: string;           // 'llm.chat' | 'tool.execute' | 'mcp.call' | 'skill.load'
  startTime: number;
  endTime?: number;
  status: 'ok' | 'error';
  attributes: Record<string, unknown>;
  events: SpanEvent[];    // 关键事件记录
}

interface SpanEvent {
  name: string;
  timestamp: number;
  attributes: Record<string, unknown>;
}
```

- 每次用户对话创建一个 Trace
- LLM 调用、工具执行、MCP 调用各创建 Span，形成树状结构
- 日志输出到：控制台（开发）、文件（持久化）、SQLite（Web UI 查询）
- 支持按 traceId 查询完整调用链

### 7. 配置管理 (`packages/core/src/config/`)

```typescript
interface AppConfig {
  llm: {
    default: 'openai' | 'anthropic';
    openai: { apiKey: string; baseUrl?: string; model: string };
    anthropic: { apiKey: string; model: string };
  };
  agent: {
    maxIterations: number;
    systemPrompt: string;
  };
  mcp: {
    servers: MCPConfig[];
  };
  server: {
    port: number;
    host: string;
  };
}
```

- 配置文件：`config/default.json`（默认）+ `config/local.json`（本地覆盖）
- 环境变量覆盖：`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 等

### 8. Server 层 (`packages/server/`)

API 路由设计：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/conversations` | 获取对话列表 |
| POST | `/api/conversations` | 创建新对话 |
| GET | `/api/conversations/:id` | 获取对话详情（含消息） |
| DELETE | `/api/conversations/:id` | 删除对话 |
| POST | `/api/conversations/:id/messages` | 发送消息，触发 Agent 执行，响应为 SSE 流式输出 |
| GET | `/api/skills` | 获取已加载的 Skill 列表 |
| GET | `/api/traces` | 获取 Trace 列表 |
| GET | `/api/traces/:id` | 获取 Trace 详情（含 Span 树） |
| GET | `/api/config` | 获取当前配置（脱敏） |
| PUT | `/api/config` | 更新配置 |

数据存储（SQLite）：
- `conversations` 表：id, title, created_at, updated_at
- `messages` 表：id, conversation_id, role, content, tool_calls, created_at
- `traces` 表：id, conversation_id, metadata, created_at
- `spans` 表：id, trace_id, parent_span_id, name, attributes, events, start_time, end_time, status

### 9. Web UI (`packages/web/`)

布局：

```
┌──────────────────────────────────────────────────────────┐
│ [可扩展: Skills 列表区域]                                  │
├──────────────┬───────────────────────────────────────────┤
│              │                                           │
│  历史对话列表  │           Chat UI                         │
│              │    ┌─────────────────────────────────┐    │
│  ┌────────┐  │    │ assistant: 我已经帮你完成了...    │    │
│  │ 对话 1  │  │    │                                 │    │
│  │ 对话 2  │  │    │ 🔧 read_file: /path/to/file    │    │
│  │ 对话 3  │  │    │ 🔧 write_file: /path/to/file   │    │
│  │  ...    │  │    │                                 │    │
│  └────────┘  │    └─────────────────────────────────┘    │
│              │    ┌─────────────────────────────────┐    │
│  [+ 新对话]  │    │  输入框                    [发送] │    │
│              │    └─────────────────────────────────┘    │
│              │                                           │
│              │  [可扩展: 执行日志面板 (Trace/Span 树)]     │
├──────────────┴───────────────────────────────────────────┤
│                        状态栏                              │
└──────────────────────────────────────────────────────────┘
```

核心组件：
- `Sidebar` — 左侧对话列表 + 新增按钮
- `ChatPanel` — 右侧聊天区域
- `MessageBubble` — 消息气泡（区分 user/assistant/tool）
- `ToolCallCard` — 工具调用可视化卡片
- `InputBox` — 输入框 + 发送按钮
- `StatusBar` — 底部状态栏（当前模型、连接状态）

MVP 先实现核心布局和交互，扩展区域用空白占位。

## 开发计划

### 阶段 1：项目脚手架与基础设施

**目标**：monorepo 搭建完成，三个包可独立构建运行。

**内容**：
- 初始化 pnpm workspace monorepo
- 配置 TypeScript、ESLint、Prettier
- 搭建 `packages/core` — tsup 构建
- 搭建 `packages/server` — Hono 入口 + tsx 开发模式
- 搭建 `packages/web` — Vite + React 脚手架
- 定义公共类型 (`types/`)
- 配置包间依赖关系

**交付**：`pnpm dev` 可启动 server，浏览器可打开空白 React 页面。

---

### 阶段 2：LLM 提供者层

**目标**：统一接口接入 OpenAI 和 Anthropic，支持流式输出。

**内容**：
- 定义统一消息格式 (`Message`, `ChatChunk`, `Tool`)
- 实现 `OpenAIProvider` — 基于 `openai` SDK，流式输出
- 实现 `AnthropicProvider` — 基于 `@anthropic-ai/sdk`，流式输出
- 实现 `LLMProviderFactory` — 根据配置创建 provider 实例
- 消息格式双向转换（内部格式 ↔ OpenAI 格式 ↔ Anthropic 格式）
- 单元测试覆盖

**交付**：可通过代码调用两个 LLM 并获取流式输出。

---

### 阶段 3：工具系统

**目标**：工具注册、执行框架完成，内置基础工具可用。

**内容**：
- 定义 `Tool` 接口和 `ToolRegistry`
- 实现内置工具：
  - `read_file` — 读取文件内容
  - `write_file` — 写入文件
  - `list_files` — 列出目录内容
  - `execute_command` — 执行 shell 命令
  - `search_files` — 文件内容搜索
- 工具输入校验（基于 JSON Schema）
- 工具结果格式化（截断过长输出等）
- 工具执行错误处理
- 单元测试覆盖

**交付**：ToolRegistry 可注册/查询工具，每个工具可独立调用和测试。

---

### 阶段 4：Agent 循环引擎

**目标**：ReAct 循环跑通，能完成多步工具调用任务。

**内容**：
- 实现 `Agent.run()` — ReAct 核心循环
- System Prompt 组装（基础 prompt + 动态片段拼接）
- 消息历史管理（追加 user/assistant/tool 消息）
- 循环终止条件（无 tool_calls / 达到 maxIterations）
- Agent 事件流（text/tool_call/tool_result/done）
- 最大迭代次数保护
- 单元测试 + 集成测试（mock LLM + 真实工具）

**交付**：可通过代码发起一个任务，Agent 自主调用工具完成并返回结果。

---

### 阶段 5：日志与链路追踪

**目标**：完整的 Trace/Span 日志系统，支持查询。

**内容**：
- 实现 `TraceManager` — 创建 Trace 和 Span
- 在 Agent 循环中埋点（LLM 调用、工具执行各生成 Span）
- 日志输出：控制台（pretty-print）+ 文件（JSON Lines）
- SQLite 存储 Trace/Span 数据
- 查询接口：按 traceId 查询完整调用链
- 单元测试覆盖

**交付**：Agent 运行时自动生成完整调用链日志，可查询。

---

### 阶段 6：Skill 系统

**目标**：Markdown Skill 文件可加载、匹配、注入 prompt。

**内容**：
- 定义 Skill 文件格式（frontmatter + body）
- 实现 `SkillLoader` — 从目录加载 Skill 文件
- 实现触发词匹配逻辑
- Skill 内容注入 system prompt 的机制
- Agent 循环集成：运行前匹配 Skill，组装 prompt
- 提供 2-3 个示例 Skill 文件
- 单元测试覆盖

**交付**：在 `skills/` 目录放入 Skill 文件，Agent 可自动匹配并使用。

---

### 阶段 7：MCP 客户端

**目标**：Agent 可连接外部 MCP Server，使用其提供的工具。

**内容**：
- 实现 `MCPClientManager` — 管理多个 MCP Server 连接
- 支持 stdio 和 SSE 两种传输方式
- MCP 工具自动转换为内部 `Tool` 格式
- MCP 工具注册到 ToolRegistry
- MCP 配置文件解析 (`config/mcp-servers.json`)
- 连接生命周期管理（启动、断开、重连）
- 单元测试 + 集成测试（本地 MCP Server mock）

**交付**：配置一个 MCP Server，Agent 可发现并调用其工具。

---

### 阶段 8：Server API 层

**目标**：HTTP API 完整可用，前端可通过 API 与 Agent 交互。

**内容**：
- SQLite 数据库初始化（conversations, messages, traces, spans 表）
- 实现路由：
  - 对话 CRUD (`/api/conversations`)
  - 发送消息 + SSE 流式输出 (`/api/conversations/:id/messages`)
  - Skill 列表 (`/api/skills`)
  - Trace 查询 (`/api/traces`)
- 会话管理（conversation ↔ agent session 映射）
- Agent 事件流 → SSE 转换
- 静态文件服务（前端构建产物）
- CORS 配置
- 错误处理中间件

**交付**：可通过 curl / Postman 完整对话，SSE 流式输出正常。

---

### 阶段 9：Web UI

**目标**：完整的聊天界面，可进行多轮对话。

**内容**：
- 页面布局：左侧 Sidebar + 右侧 ChatPanel
- `Sidebar` 组件：
  - 对话列表（标题、时间、选中状态）
  - 新增对话按钮
  - 对话切换
  - 预留 Skills 列表扩展位
- `ChatPanel` 组件：
  - 消息流展示（区分 user/assistant/tool 消息）
  - `MessageBubble` — 消息气泡，支持 Markdown 渲染
  - `ToolCallCard` — 工具调用可视化（名称、参数、结果）
  - `InputBox` — 多行输入 + 发送按钮 + Enter 发送
  - SSE 流式消息实时追加
  - Agent 执行中状态指示
- `StatusBar` — 底部状态栏
- API 调用层（fetch + SSE EventSource）
- 预留执行日志面板扩展位

**交付**：浏览器中可完整使用，创建对话、发送消息、查看工具调用、多轮对话。

---

### 阶段 10：配置与联调

**目标**：端到端可用，配置完善。

**内容**：
- 配置管理页面或配置文件完善
- 环境变量支持
- 开发模式热重载（server + web）
- `pnpm dev` 一键启动全部服务
- 端到端测试：完整对话 → 工具调用 → Skill 匹配 → MCP 调用
- README 编写（项目说明、启动方式、配置说明）

**交付**：完整可运行的 Lot Agent 系统。

---

## 开发顺序总览

```
阶段 1 脚手架
  └─ 阶段 2 LLM 层
      └─ 阶段 3 工具系统
          └─ 阶段 4 Agent 循环  ← 核心，到这里 Agent 可独立运行
              ├─ 阶段 5 日志追踪  ← 可与 6/7 并行
              ├─ 阶段 6 Skill 系统  ← 可与 5/7 并行
              └─ 阶段 7 MCP 客户端  ← 可与 5/6 并行
                  └─ 阶段 8 Server API
                      └─ 阶段 9 Web UI
                          └─ 阶段 10 联调收尾
```

阶段 1-4 是串行的，必须按顺序完成（每个阶段依赖前一个）。阶段 5/6/7 可以并行开发。阶段 8-10 依赖前面所有阶段。
