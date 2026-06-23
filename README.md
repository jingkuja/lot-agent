# Lot Agent

A self-hosted AI agent with multi-LLM support, tool calling, skills, MCP integration, and autonomous task execution.

用 vibecoding 搭建一个基本的 agent 系统，用来学习，实验最新的 agent知识


## Features

- **Multi-LLM**: OpenAI and Anthropic with unified streaming interface
- **Tool System**: Built-in tools (file read/write, shell, search) + extensible registry
- **Skills**: Markdown-based skill files with trigger-word matching
- **MCP Client**: Connect external MCP servers for additional tools
- **ReAct Loop**: Autonomous reasoning-action loop with max iteration protection
- **Tracing**: Full trace/span logging for every agent execution
- **Web UI**: Chat interface with conversation management

## Quick Start

### Prerequisites

- Node.js >= 18
- npm >= 9

### Install

```bash
npm install
```

### Configure

Edit `config/default.json`:

```json
{
  "llm": {
    "default": "openai",
    "openai": {
      "apiKey": "sk-...",
      "model": "gpt-4o"
    },
    "anthropic": {
      "apiKey": "sk-ant-...",
      "model": "claude-sonnet-4-20250514"
    }
  }
}
```

Or use environment variables:

```bash
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
```

### Run

```bash
# Start all services (core watcher + server + web dev server)
npm run dev

# Or start individually:
npm run dev:server   # API server on http://localhost:3000
npm run dev:web      # Web UI on http://localhost:5173
```

Open http://localhost:5173 in your browser.

## Project Structure

```
lot-agent/
├── packages/
│   ├── core/          # Agent engine, LLM clients, tools, skills, MCP, logger
│   ├── server/        # Hono HTTP API + PostgreSQL
│   └── web/           # React chat UI
├── skills/            # Markdown skill files
├── config/            # Configuration files
│   ├── default.json   # Main config (LLM, agent, server)
│   └── mcp-servers.json
└── data/              # Runtime data (gitignored)
```

## Adding Skills

Create a `.md` file in `skills/`:

```markdown
---
name: my-skill
description: What this skill does
triggers:
  - "keyword1"
  - "keyword2"
---

Your skill prompt content here...
```

## Adding MCP Servers

Edit `config/mcp-servers.json`:

```json
{
  "servers": [
    {
      "id": "filesystem",
      "name": "Filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  ]
}
```

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/conversations` | List conversations |
| POST | `/api/conversations` | Create conversation |
| GET | `/api/conversations/:id` | Get conversation + messages |
| DELETE | `/api/conversations/:id` | Delete conversation |
| POST | `/api/conversations/:id/messages` | Send message (SSE stream) |
| GET | `/api/skills` | List loaded skills |
| GET | `/api/traces` | List traces |
| GET | `/api/traces/:id` | Get trace + spans |
