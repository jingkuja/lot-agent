# Lot Agent

Platform foundation for a **multi-Agent content-creation product**
(文案 / 图片 / 视频 → 审核 → 平台发布).

It started as a single general AI agent and was upgraded (phases P0–P8, see
[`plan.md`](./plan.md)) into a multi-Agent, multi-modal, metered, async platform base.
The three content Agents (copywriting / image / video) are wired as **pluggable interfaces
with stub implementations** — real generation vendors, OAuth publishing, and content review
are intentionally **not implemented yet**. The goal is a clean, working pipeline you can drop
real business logic into.

> 用 vibecoding 搭建一个 agent 平台底座，用来学习、实验最新的 agent 知识。

## Features

- **Multi-Agent registry** — `general` (full tools), plus `copywriting` / `image` / `video`
  placeholder definitions; tools are whitelisted per Agent.
- **Multi-LLM** — OpenAI-compatible (DeepSeek/OpenAI/local) and Anthropic, unified streaming.
- **Model registry + pricing** — text / image / video / tts / asr / review model metadata with cost.
- **Async generation** — BullMQ queue + a separate **worker process** for image/video tasks.
- **Metering & billing** — every model call writes `usage_logs`; spend derived via SQL; quota pre-checks.
- **Multi-user auth** — Bearer-token sessions, multiple concurrent sessions per account, per-user data.
- **Review + publish (stubs)** — review hook runs before publish; connectors for 小红书 / 微信公众号.
- **Tooling** — built-in tools, Markdown skills, MCP client, full trace/span logging.
- **Web UI** — React 19 chat/workspace with light/dark theming, file upload, task progress.

## Stack

TypeScript monorepo, **npm workspaces** (not pnpm), Node ≥ 18, ESM.

| Package | Name | Role |
|---|---|---|
| `packages/core` | `@lot-agent/core` | Agent engine + reusable abstractions (no HTTP/DB) |
| `packages/server` | `@lot-agent/server` | Hono HTTP API + PostgreSQL (`pg`) + BullMQ worker |
| `packages/web` | `@lot-agent/web` | React 19 + Vite chat/workspace UI |

External infra: **PostgreSQL** (business data) and **Redis** (BullMQ queue, gen-cache, progress
pub/sub). Object storage is local disk (`data/assets/`) behind an `ObjectStorage` interface.

## Quick Start

### 1. Prerequisites

- Node.js ≥ 18, npm ≥ 9
- A running **PostgreSQL** (the server auto-migrates tables on startup)
- A running **Redis** (required by the queue / worker / cache)
- At least one LLM key (OpenAI-compatible or Anthropic) to exercise the chat path

Quick infra via Docker (optional):

```bash
docker run -d --name lot-pg   -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=lot -p 5432:5432 postgres:16
docker run -d --name lot-redis -p 6379:6379 redis:7
```

### 2. Install

```bash
npm install
```

### 3. Configure

Copy the env template and fill in secrets (the server **throws if `PG_PASSWORD` is empty**):

```bash
cp .env.example .env
```

Minimal `.env` for local dev:

```bash
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_MODEL=deepseek-v4-flash
LLM_DEFAULT=openai

PG_HOST=localhost
PG_PORT=5432
PG_USER=postgres
PG_PASSWORD=postgres
PG_DATABASE=lot

REDIS_URL=redis://localhost:6379
CORS_ORIGIN=http://localhost:5173
```

Non-secret structure (models, pricing, agent prompt, context budget) lives in
[`config/default.json`](./config/default.json); personal overrides go in the gitignored
`config/local.json`.

### 4. Run

```bash
# Start everything: core(watch) + server + worker + web
npm run dev
```

This launches four processes via `concurrently`:

| Color | Process | What |
|---|---|---|
| blue | core | tsup watch build of `@lot-agent/core` |
| green | server | Hono API on `http://localhost:3000` (auto-migrates DB) |
| cyan | worker | BullMQ job consumer (image/video tasks) — **separate process** |
| magenta | web | Vite dev server on `http://localhost:5173` (proxies `/api` + `/static`) |

Then open **http://localhost:5173**.

Run pieces individually if you prefer:

```bash
npm run dev:server                      # API only
npm run dev:web                         # web only
npm run dev:worker -w @lot-agent/server # worker only (needed for image/video tasks)
```

### 5. Try it from the CLI

Auth is passwordless: **login upserts a user by email** and returns a Bearer token. Every
`/api/*` route except `/api/auth/*` requires that token.

```bash
# 1) Login → get a token
TOKEN=$(curl -s http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"me@local","name":"Me"}' | jq -r .token)

# 2) List available Agents
curl -s http://localhost:3000/api/agents -H "Authorization: Bearer $TOKEN" | jq

# 3) Create a conversation (pick an agent: general | copywriting | image | video)
CONV=$(curl -s http://localhost:3000/api/conversations \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"agentId":"general","title":"hello"}' | jq -r .id)

# 4) Send a message — response streams back as SSE
curl -N http://localhost:3000/api/conversations/$CONV/messages \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"content":"用三句话介绍一下你自己"}'
```

> The web UI does all of this for you — the CLI flow above is just to show the API shape.

## Build & Test

```bash
npm run build   # build all workspaces
npm test        # vitest (root) — or: npm test -w @lot-agent/core | -w @lot-agent/server
```

Tests are Vitest, colocated as `*.test.ts`.

## Project Structure

```
lot-agent/
├── packages/
│   ├── core/      # agent loop, agents registry, models, providers (image/video/tts/review),
│   │              #   publish, jobs, storage, billing, tools, skills, mcp, context, memory
│   ├── server/    # Hono API, services, routes, auth, jobs (bullmq), billing, workers, db
│   └── web/       # React 19 chat/workspace UI
├── skills/        # Markdown skill files
├── config/        # default.json (models/pricing/agent/server) + mcp-servers + local.json
├── data/          # runtime data incl. assets/ (gitignored)
├── plan.md        # phased upgrade plan (P0–P8) and what each phase delivered
└── CLAUDE.md      # working guidance for this repo
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

## API surface

All `/api/*` need a Bearer token except `/api/auth/*`.

| Group | Endpoints |
|---|---|
| Auth | `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` |
| Agents | `GET /api/agents` |
| Conversations | `GET/POST /api/conversations` · `GET/DELETE /api/conversations/:id` · `POST /api/conversations/:id/messages` (SSE) · `POST /api/conversations/:id/regenerate` |
| Tasks (async gen) | `POST /api/tasks` · `GET /api/tasks/:id` |
| Assets | `GET /api/assets/:id` · `GET /static/assets/:filename` |
| Billing | `GET /api/usage/{summary,logs,balance}` · `GET /api/balance` |
| Publish | `GET /api/platform/auth/:platform` · `POST /api/platform/:platform/connect` · `POST /api/publish` · `GET /api/publish/records` |
| Misc | `GET /api/skills` · `GET /api/traces` · `GET /api/traces/:id` · `/api/ratings` · `/api/memory` |

## Status / not yet done

Real business Agent flows (copywriting/image/video generation), real model vendors
(通义万相 / 可灵 / DALL·E), real OAuth publishing, cloud content review (阿里云内容安全),
a `projects` table, Redis rate-limiting, and a formal migration runner are **deferred** to the
business phase — all behind the existing interfaces. See [`plan.md`](./plan.md) for the full plan.
