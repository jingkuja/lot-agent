# CLAUDE.md

Guidance for working in this repo. Lot Agent is the **platform foundation** for a multi-Agent
content-creation product (文案 / 图片 / 视频 → 审核 → 平台发布). It started as a single general
AI agent and was upgraded (phases P0–P8, see `plan.md`) into a multi-Agent / multi-modal /
metered / async platform base. **Business logic for the three content Agents is intentionally NOT
implemented yet** — image/video generation, real model vendors, OAuth publishing, and content
review are wired as pluggable interfaces with **stub** implementations.

## Stack

TypeScript monorepo using **npm workspaces** (not pnpm). Node ≥ 18, ESM.

| Package | Name | Tech | Builds with |
|---|---|---|---|
| `packages/core` | `@lot-agent/core` | Agent engine + all reusable abstractions (pure-ish, no HTTP/DB) | tsup |
| `packages/server` | `@lot-agent/server` | Hono HTTP API + PostgreSQL (`pg`) + BullMQ worker | tsup |
| `packages/web` | `@lot-agent/web` | React 19 + Vite chat/workspace UI | vite |

External infra: **PostgreSQL** (business data) and **Redis** (BullMQ queue, gen-cache, progress pub/sub). Object storage is local-disk (`data/assets/`) behind an `ObjectStorage` interface.

## Commands

```bash
npm install
npm run dev        # core(watch) + server + worker + web(vite) via concurrently
npm run dev:server
npm run dev:web
npm run dev:worker -w @lot-agent/server   # background job worker (separate process)
npm run build      # all workspaces
npm test           # vitest (root) — or: npm test -w @lot-agent/core | -w @lot-agent/server
```

Tests use **Vitest**; test files are colocated as `*.test.ts`. Web dev proxies `/api` and `/static` to `http://localhost:3000` (see `packages/web/vite.config.ts`).

### Required env (secrets are env-driven; `config/default.json` holds non-secret structure)

`.env` (see `.env.example`): `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`,
`ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`, `PG_HOST/PG_PORT/PG_USER/PG_PASSWORD/PG_DATABASE`
(server throws if `PG_PASSWORD` missing), `REDIS_URL`, `CORS_ORIGIN`. Personal config overrides go
in the gitignored `config/local.json`.

## Architecture

```
core/                                server/                              web/
  agent/        ReAct loop engine      services/                            pages/Home, Workspace
  agents/       AgentRegistry +          agent-service.ts (orchestrator)    components/* (chat, preview,
                definitions(copy/img/    message-repository.ts (persist)                gallery, task-progress, login, theme-toggle)
                video/general)           trace-recorder.ts (spans+trace)    api/client.ts (token + SSE)
  models/       ModelRegistry+pricing    sse-adapter.ts (AgentEvent→SSE)    hooks/useChat/useConversations/useTheme
                                                                            lib/theme.ts (light/dark + persist)
  providers/    image/video/tts/review  routes/  (one file per resource)
                (interfaces + stubs)     auth/  session-store + middleware
  publish/      PlatformConnector(stub)  jobs/  bullmq-queue + redis
  jobs/         JobQueue + in-mem fake   billing/ meter + gen-cache
  storage/      ObjectStorage + Local    workers/ index.ts (job consumer)
  billing/      calcCost (pure)          db/database.ts (pg + inline migrate)
  tools/ skills/ mcp/ context/ memory/ logger/ config/
```

### Request flow (chat)
`POST /api/conversations/:id/messages` (auth + ownership) → `AgentService.streamAgentResponse`
builds an `Agent` from the conversation's `AgentDefinition` (system prompt + tool whitelist +
model id), resolves the text provider from `ModelRegistry`, runs the ReAct loop, and yields
`AgentEvent`s. `sse-adapter` maps each event to SSE; `message-repository` persists; `trace-recorder`
records spans + the trace; usage is metered at the end. Memory is **per-request** (see Concurrency).

### Async generation flow (image/video)
`POST /api/tasks` (quota pre-check) → `BullmqJobQueue.enqueue` writes a `tasks` row + Redis job →
the **worker process** (`workers/index.ts`) consumes it, checks the Redis gen-cache, calls a Stub
provider, writes the artifact to `ObjectStorage`, registers an `assets` row, meters usage, caches
the result. Clients poll `GET /api/tasks/:id`. Assets served at `/static/assets/:filename`.

## Key concepts

- **Agent registry** (`core/agents`): each Agent is an `AgentDefinition` (`id`, `systemPrompt`,
  `toolNames` whitelist, `defaultModelId`, `inputSchema`). `general` = full tools + config prompt;
  `copywriting`/`image`/`video` are placeholder definitions (no business logic). Tools are scoped
  per Agent via `ToolRegistry.toLLMTools(names)` — e.g. `copywriting` cannot call `execute_command`.
- **Model registry** (`core/models`): `ModelConfig` carries type (`llm|image|video|tts|asr|embedding|review`)
  + pricing; `getProvider(id)` lazily builds the provider. Seeded from `config/default.json`'s `models`.
- **Billing** (`core/billing/cost.ts` pure `calcCost` + `server/billing/meter.ts`): every model call
  writes `usage_logs`; daily/monthly spend is **derived via SQL SUM** (no counter columns). Expensive
  tasks are quota-checked (402). Redis `GenCache` returns cached generations **without re-billing**.
- **Auth & concurrency (P6)**: multi-user with **multiple concurrent sessions per account**
  (`sessions` table, Bearer token). Every `/api/*` route except `/api/auth/*` is behind `authMw`,
  which sets `c.get("userId")`; resources are user-scoped with ownership checks (cross-user → 404).
  **Memory is constructed fresh per request** (`AgentMemoryStore` per `streamAgentResponse`) and
  memory tools read `context.memory` — never a shared singleton — so concurrent users/sessions
  never clobber each other's ephemeral state.
- **Review + publish (P7)**: `ReviewProvider` (keyword stub) runs **before** publish; `reject` →
  403 and is still logged to `review_logs`. `PlatformConnector` stubs for `xiaohongshu`/`wechat_mp`.

## Data layer

PostgreSQL via `pg`. **Migrations are inline** in `db/database.ts` `migrate()` using
`CREATE TABLE IF NOT EXISTS` + idempotent `ALTER ... ADD COLUMN IF NOT EXISTS` (no migration-runner).
Tables: `users`, `sessions`, `conversations`, `messages`, `message_tool_calls`, `message_ratings`,
`traces`, `spans`, `tasks`, `assets`, `usage_logs`, `user_balance`, `review_logs`,
`platform_accounts`, `publish_records`. NUMERIC columns return strings from pg — convert with `Number()`.

## API surface (all `/api/*` need a Bearer token except `/api/auth/*`)

`auth/login|logout|me`, `agents`, `conversations` (+`/messages` SSE, `/regenerate`), `tasks`,
`assets/:id` (+ `/static/assets/:filename`), `usage/{summary,logs,balance}`, `balance`,
`platform/auth/:platform` + `platform/:platform/connect`, `publish` + `publish/records`,
`skills`, `traces`, `ratings`, `memory`.

## Conventions

- **ESM imports use explicit `.js` suffixes** (e.g. `from "./registry.js"`), 2-space indent.
- **TDD with Vitest** for new pure/logic units; tests colocated as `*.test.ts`.
- **Interface-in-core, impl-in-server** when an abstraction needs DB/Redis (e.g. `JobQueue` interface
  + `InMemoryJobQueue` in core; `BullmqJobQueue` in server). Keeps core free of `pg`/`ioredis`.
- **No secrets in git**: keys empty in `config/default.json`, injected via env. Do not commit real keys.
- Stub providers (`Stub*Provider`, `Keyword*`, `Stub*Connector`) prove the pipeline — replace with real
  vendor integrations in the business phase, behind the existing interfaces.
- **Web theming**: all colors are CSS variables in `web/src/App.css`; `:root` is the **light** (default)
  palette, `[data-theme="dark"]` overrides it. A pre-paint script in `index.html` sets `data-theme` from
  `localStorage` (key `lot:theme`) before first render to avoid flash; `ThemeToggle` + `useTheme` flip it
  at runtime. Use the existing `var(--*)` tokens (incl. `--overlay-raise/sink`, `--code-*-bg`) for new UI —
  never hardcode hex/`rgba`, or light mode breaks.

## Status / not-yet-done

Business Agent flows (real copywriting/image/video generation), real model vendors (通义万相/可灵/
DALL·E), real OAuth publishing, cloud content review (阿里云内容安全), `projects` table, Redis
rate-limiting, and a formal migration runner are **deferred**. The chat SSE path needs an LLM API key
to exercise end-to-end. See `plan.md` for the full phased plan and what each phase delivered.
