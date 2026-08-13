# AGENTS.md

Guidance for working in this repo. Lot Agent is a multi-Agent content/office assistant product:
one always-available **通用助手 (`general`)** plus installable **vertical sub-Agents** (图片生成 /
视频生成 / PPT 制作 / 合同对比 / 文案[hidden]) managed through an in-app **Agent 中心**. Users log
in through an external **tokenhub** account; all model calls (LLM / image / video) go through
tokenhub's OpenAI-compatible endpoints and are billed to the **user's own api key**. The platform
foundation phases are documented in `plan.md` (P0–P8) and `update-ext.md` (core extension E0–E6);
consult them for history/roadmap, not current behavior.

## Stack

TypeScript monorepo using **npm workspaces** (not pnpm). Node ≥ 18, ESM.

| Package | Name | Tech | Builds with |
|---|---|---|---|
| `packages/core` | `@lot-agent/core` | Agent engine + reusable abstractions (no HTTP/DB deps) | tsup |
| `packages/server` | `@lot-agent/server` | Hono HTTP API + PostgreSQL (`pg`) + BullMQ worker + doc/PPT tooling | tsup |
| `packages/web` | `@lot-agent/web` | React 19 + Vite single-page Workspace UI | vite |
| `packages/desktop` | `@lot-agent/desktop` | Electron shell over the web app (macOS arm64/x64 + Windows); loopback static+proxy server, native window/downloads/notifications/tray, safeStorage token | tsup + electron-builder |

External infra: **PostgreSQL** (business data), **Redis** (BullMQ queue, model-catalog cache,
gen-cache, session-tier memory, progress pub/sub), **tokenhub** (auth + model gateway). Object
storage is local-disk (`data/assets|documents|uploads`) behind an `ObjectStorage` interface.

## Commands

```bash
npm install
npm run dev        # core(watch) + server + worker + web(vite) via concurrently
npm run dev:server
npm run dev:web
npm run dev:worker -w @lot-agent/server   # background job worker (separate process)
npm run build      # all workspaces
npm test           # vitest (root) — or: npm test -w @lot-agent/core | -w @lot-agent/server
npm run dev:desktop   # web(vite HMR) + Electron dev window
npm run dist:desktop  # build web + package desktop installers (see docs/desktop.md)
```

Tests use **Vitest**, colocated as `*.test.ts`. Web dev proxies `/api` and `/static` to
`http://localhost:3000` (`packages/web/vite.config.ts`).

### Env (see `.env.example`; non-secret structure lives in `config/default.json`, personal overrides in gitignored `config/local.json`)

- `OPENAI_API_KEY/BASE_URL/MODEL`, `ANTHROPIC_*`, `LLM_DEFAULT` — env-configured **fallback** LLM
  (used in DEBUG mode / when a user has no tokenhub key; normal chat uses the per-user key).
- `TOKENHUB_API_KEY` (+ optional `IMAGE_GEN_API_KEY` / `VIDEO_GEN_API_KEY`) — image/video vendor key.
- `BIGMODEL_API_KEY` — 智谱 web_search.
- `PG_*` (server throws if `PG_PASSWORD` missing), `REDIS_URL`/`REDIS_PASSWORD`, `PORT`, `CORS_ORIGIN`.
- `PUBLIC_BASE_URL` — absolute base for `/static/*` download links (deployed box).
- `DEBUG=1` — skips login (seeded debug user, env LLM). Never in production. `DEBUG_LLM=1` logs raw payloads.

## Architecture

```
core/                                 server/                               web/
  agent/     ReAct loop engine          services/                             pages/Workspace (single page)
  agents/    AgentRegistry + defs         agent-service.ts (orchestrator)     components/ AgentSwitcher,
             (copy/image/video/            attachment-extractor.ts (docx/pdf/            AgentCenterModal, ModelPicker,
              ppt/contract; general          xlsx/pptx → text, 30K cap)                  GenerationCard, OutlineCard,
              built in agent-service)       message-repository / sse-adapter/            AskUserCard, KeySettingsModal,
  llm/       openai+anthropic providers,    trace-recorder                                InputBox(uploads), Sidebar…
             withLLMRetry, complete(),    routes/   one file per resource      hooks/ useChat/useAgents/useModels/
             prompt caching, thinking     auth/     session-store(PG)+rsa+mw          useConversations/useTheme
  models/    ModelRegistry + pricing     models/   tokenhub catalog + ProviderFactory
  providers/ image/video adapters        tokenhub/ client (login + model list)
             (happyhorse, chat-          generation/ config loader + run-job
              completions), review, tts  tools/    generate_document, generate_ppt, propose_outline
  publish/   PlatformConnector (stub)    ppt/      renderer/themes/layouts/template-renderer
  jobs/      JobQueue + in-mem fake      memory/   RedisSessionBackend, last-turn
  storage/   ObjectStorage + Local       jobs/     bullmq-queue + redis
  billing/   calcCost (pure)             billing/  meter + gen-cache
  tools/     builtins + ask_user         workers/  index.ts (image/video job consumer)
  skills/ mcp/ context/ memory/ logger/  db/       database.ts (pg + inline migrate)
```

### Auth flow (tokenhub)
Browser fetches `GET /api/auth/public-key` (ephemeral per-process RSA keypair) → encrypts the
password → `POST /api/auth/login` decrypts and forwards to tokenhub → on success upserts the user
(`external_user_id`, `username`, `api_keys` JSONB) and mints a PG-backed session token. All other
`/api/*` routes require the Bearer token (`authMw` sets `c.get("userId")`; cross-user access → 404).
`POST /api/keys/active` switches the user's active api key and busts the model-catalog cache.

### Model resolution (per user, per request)
`GET /api/models` → `getUserModelCatalog`: fetch the user's model list from tokenhub with their
active key, enrich with `config/default.json`'s `modelCatalog` (providerMap → adapter, pricing),
cache in Redis `models:{userId}` (TTL 300s). Chat builds an LLM provider **per request** via
`ProviderFactory.llm(modelId, userApiKey)` (OpenAI-compatible; providers are never shared
singletons because billing follows the caller's key). The conversation's selected model persists
on the conversation row.

### Chat flow
`POST /api/conversations/:id/messages` (SSE) → `AgentService.streamAgentResponse` builds an
`Agent` from the conversation's `AgentDefinition` (system prompt + tool whitelist + model params),
runs the ReAct loop, yields `AgentEvent`s (incl. `thinking`) → `sse-adapter` maps to SSE;
`message-repository` persists; `trace-recorder` records spans; usage is metered at the end.
Attachments uploaded via `POST /api/uploads` are parsed by `attachment-extractor` and injected
into the message as tagged text blocks. Titles are auto-generated on the first message.

### In-conversation generation flow (image/video)
`POST /api/conversations/:id/generations` (quota pre-check, 402) → persists a pending assistant
message (`metadata.kind: "generation"`) → `BullmqJobQueue.enqueue` → the **worker process**
consumes `image.generate` / `video.generate`, checks the Redis gen-cache, calls the real vendor
adapter (`happyhorse` polling / `chat-completions`; `mock` flag in config), stores the artifact,
meters usage. The web `GenerationCard` polls `GET /api/tasks/:id` (taskId is saved on the message
so reloads can resume). Artifacts: `/static/assets/:filename`; docs `/static/documents/…`;
uploads `/static/uploads/…`.

## Key concepts

- **Agent system**: `AgentDefinition` (`id`, `type`, `category`, `hidden`, `systemPrompt`,
  `toolNames` whitelist, `defaultModelId`, `modelParams`, `inputSchema`) in
  `core/agents/definitions`. The `general` def is assembled at startup in `agent-service.ts` from
  config prompt + all registered tools minus `DISABLED_HOST_TOOLS` (file/shell tools stay
  registered but hidden on the deployed box — only web + document tools are exposed).
  Install state lives in `user_agents` (per-user, `sort_order`, MRU promote); `general` is always
  installed and not uninstallable; `image`+`video` are seeded on first access
  (`server/agents/install-order.ts`); `hidden` defs (copywriting) are invisible/uninstallable.
- **Interactive tools end the turn**: `ask_user` (core) and `propose_outline` (server) set
  `endsTurn: true` — the loop stops and the web renders AskUserCard/OutlineCard for the user's
  reply. Follow this pattern for any "wait for user input" tool.
- **Office tooling (server/tools)**: `generate_document` (Markdown → docx/pdf/md/html via
  docx/pdfkit/marked, returns a download link) and `generate_ppt` (pptxgenjs renderer with theme
  presets, layout validation, and cloning/theme-extraction from a user-uploaded .pptx template —
  see `server/ppt/`). The PPT Agent's craft knowledge lives in `skills/ppt-authoring.md`.
- **Skills**: markdown files in root `skills/`, frontmatter supports `agents:` (scope a skill to
  specific Agent ids) and `triggers:` (substring match on the user message). Loading is hybrid:
  `agents:` skills are force-injected for their Agent; trigger hits are a prefetch fast path;
  everything else is exposed as a name+description index in the system prompt and loaded on
  demand via the `load_skill` builtin tool (`core/skills/load-skill-tool.ts`,
  `buildSkillPromptParts`). Vertical agents opt in by adding `"load_skill"` to `toolNames`.
- **Memory**: session tier is Redis-backed per conversation (20-min TTL,
  `server/memory/redis-session-backend.ts`); user tier is PG. Memory objects are constructed
  per request — never a shared singleton — so concurrent sessions don't clobber each other.
- **Billing**: `core/billing/cost.ts` pure `calcCost` + `server/billing/meter.ts`; every model
  call writes `usage_logs`; spend is derived via SQL SUM (no counter columns). Dynamic tokenhub
  models fall back to `modelCatalog` pricing. Expensive tasks quota-check (402); Redis `GenCache`
  returns cached generations without re-billing.
- **Core LLM layer (`core/llm`)**: OpenAI + Anthropic streaming providers with
  `withLLMRetry` (retry before first chunk on 429/5xx), `complete()` non-streaming helper,
  Anthropic prompt caching (system + last history message, `cachedPromptTokens` reported on
  `done`), `thinking` events, strict usage accounting. `ChatParams`
  (`temperature/maxTokens/topP/reasoning`) flows from `AgentDefinition.modelParams`.
- **Tool safety (core/tools)**: file tools are sandboxed to the working directory; `web_fetch`
  has an SSRF guard (incl. redirect hops); tool input is validated against its JSON schema before
  execute; `execute_command` kills its subprocess on cancellation. Don't regress these.
- **Review + publish**: still **stub** (`KeywordReviewProvider` gate before publish, reject → 403
  + `review_logs`; `PlatformConnector` stubs for xiaohongshu/wechat_mp).

## Data layer

PostgreSQL via `pg`. **Migrations are inline** in `db/database.ts` `migrate()` using
`CREATE TABLE IF NOT EXISTS` + idempotent `ALTER … ADD COLUMN IF NOT EXISTS` (no migration runner).
Tables: `users` (tokenhub identity + `api_keys`), `sessions`, `conversations`, `messages`,
`message_tool_calls`, `message_ratings`, `traces`, `spans`, `tasks`, `assets`, `usage_logs`,
`user_balance`, `review_logs`, `platform_accounts`, `publish_records`, `user_agents`.
NUMERIC columns return strings from pg — convert with `Number()`.

## API surface (Bearer token required except `/api/auth/*` and `/health`)

`auth/{public-key,mode,login,logout,me}`, `agents` (+ `/:id/install`, `/:id/promote`),
`models`, `keys/active`, `conversations` (+ `/messages` SSE, `/regenerate`, `/generations`),
`uploads`, `tasks`, `assets/:id`, `usage/{summary,logs,balance}`, `balance`,
`platform/…` + `publish` (stub), `skills`, `traces`, `ratings`, `memory`.
Static: `/static/{assets,documents,uploads}/:filename`.

## Deployment

Single-box Docker Compose (`docker-compose.yml`): postgres, redis, server, worker (same image,
`ROLE`-switched), web (nginx serving `web/dist`, proxying `/api` + `/static` with SSE unbuffered).
See `docs/deployment.md`; `deploy/ota/` holds the offline-box OTA update + frp scripts.

## Conventions

- **ESM imports use explicit `.js` suffixes** (e.g. `from "./registry.js"`), 2-space indent.
- **TDD with Vitest** for new pure/logic units; tests colocated as `*.test.ts`.
- **Interface-in-core, impl-in-server** when an abstraction needs DB/Redis (e.g. `JobQueue` in
  core, `BullmqJobQueue` in server). Core stays free of `pg`/`ioredis`/vendor SDKs.
- **No secrets in git**: keys empty in `config/default.json`, injected via env.
- **Error opacity for auth**: login failures (decrypt, tokenhub, network) collapse to one generic
  message — don't leak causes to clients.
- **Web theming**: all colors are CSS variables in `web/src/App.css`; `:root` = light,
  `[data-theme="dark"]` overrides. A pre-paint script in `index.html` reads `localStorage`
  (`lot:theme`) before first render. Use existing `var(--*)` tokens — never hardcode hex/`rgba`.

## Status / not-yet-done

Copywriting Agent is a hidden placeholder. Publish/review remain stubs (real OAuth publishing and
cloud content review deferred). From `update-ext.md`, E0 (billing correctness + tool security),
most of E1 (retry, prompt caching, thinking, ChatParams), E2 (model capabilities + cost estimation
+ enabled filtering), and E3 (multimodal `ContentPart`, structured output via `responseSchema`/
`AgentDefinition.outputSchema`, multimodal `ReviewProvider`, ASR/Embedding stub interfaces, multi-image
`PollResult.urls`) are landed. Still open: RAG retrieval wiring (E4 — Embedding interface exists, no
VectorStore/Retriever yet), multi-Agent orchestration primitives (E5), jobs v2 (cancel/priority/delay),
S3 storage, and a formal migration runner.
