# Lot Agent

Lot Agent is an AI content and productivity workspace with a shared account, model gateway, and points system. It includes a React web app, an Electron desktop client, and a WeChat mini program focused on image and video creation.

The current implementation supports streaming assistant conversations, image/video generation, document and presentation creation, personal knowledge retrieval, and digital employee workflows. Model access and account services integrate with TokenHub / New API; feature availability depends on gateway access and deployment configuration.

## Features

- **Assistant workspace** — streaming chat, model selection, attachments, tool calls, memory, conversation projects, and installable agents.
- **Image and video creation** — real gateway adapters, asynchronous jobs, task recovery after refresh, previews, downloads, and revocable work sharing. Failed asset downloads have a download-only retry path.
- **Documents and presentations** — Word, PDF, Markdown, and HTML export; contract comparison through an agent and document tools; PPT outline confirmation, PPTX generation, and editing. Optional converters provide slide thumbnails.
- **Digital employee** — customer profiles, marketing materials, opportunity discovery and advice, customer acquisition, and generated copy and assets.
- **Personal knowledge** — private collections, documents, notes, facts, and materials; background parsing, image/scanned-PDF OCR, embeddings, hybrid retrieval, and versioned chat citations. A separate API supports collection-scoped knowledge keys.
- **Accounts and billing** — password, phone, and WeChat authentication flows; per-user managed model credentials; usage metering, points balances, and recharge through New API.
- **Extensibility** — agent tool allowlists, Markdown skills, MCP connections, and trace/span recording.
- **Clients** — web and desktop workspaces with themes and localized UI, plus native WeChat creation and gallery pages.

`general` and `digital_employee` are fixed agents. Image, video, and PPT agents are installed by default. The standalone `copywriting` definition remains hidden; digital employee copywriting is implemented separately.

## Architecture

TypeScript, ESM, and pnpm workspaces:

| Package | Responsibility |
| --- | --- |
| [`@lot-agent/core`](packages/core) | Agent loop, model/tool contracts, skills, context, memory abstractions, providers, and shared knowledge/presentation types; no direct PostgreSQL or Redis dependencies |
| [`@lot-agent/server`](packages/server) | Hono API, authentication, PostgreSQL repositories, billing, business services, file generation, and BullMQ workers |
| [`@lot-agent/web`](packages/web) | React 19 / Vite workspace, interactive chat cards, knowledge management, and digital employee UI |
| [`@lot-agent/desktop`](packages/desktop) | Electron shell reusing the web app, with local proxying, downloads, notifications, and credential storage |
| [`@lot-agent/miniprogram`](packages/miniprogram) | WeChat login, image/video creation, task polling, gallery, sharing, and saving |

```text
Web / Electron / WeChat mini program
                  |
             HTTP / SSE
                  |
               Hono API
                  |-- Agent engine, tools, skills, memory
                  |-- Digital employee and knowledge services
                  |-- PostgreSQL: accounts, conversations, tasks, usage, indexes
                  |-- Redis / BullMQ
                         |-- General worker: image/video, memory, opportunities
                         |-- Knowledge worker: parsing, OCR, embeddings, indexing

External integration: TokenHub / New API for accounts, models, quota, and payments
```

Generated assets, documents, and uploads use local storage under `data/`. Knowledge originals live separately in `data/knowledge` and are accessed through authentication or short-lived preview tickets.

The API runs versioned database migrations at startup, using an advisory lock and a transaction per migration. Workers consume the existing schema. Migration files and registration live in [`packages/server/src/db/migrations`](packages/server/src/db/migrations).

## Local Development

### 1. Install dependencies

Use Node.js 22 for local development. The pnpm version is pinned to **10.33.0** in [`package.json`](package.json). You also need PostgreSQL with **pgvector**, Redis, and model credentials for the features you want to exercise.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @lot-agent/core build
cp .env.example .env
```

For a new local database and Redis instance, you can use Docker:

```bash
docker run -d --name lot-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=lot -p 127.0.0.1:5432:5432 pgvector/pgvector:pg16
docker run -d --name lot-redis -p 127.0.0.1:6379:6379 redis:7
```

### 2. Configure local mode

For local development without the account gateway, set these values in `.env`, replacing the model placeholders with a compatible endpoint, model, and key:

```dotenv
DEBUG=1
NEW_API_MANAGED_KEYS=0

PG_HOST=localhost
PG_PORT=5432
PG_USER=postgres
PG_PASSWORD=postgres
PG_DATABASE=lot
REDIS_URL=redis://localhost:6379
REDIS_PASSWORD=

LLM_DEFAULT=openai
OPENAI_BASE_URL=https://your-model-gateway.example/v1
OPENAI_MODEL=your-text-model
OPENAI_API_KEY=your-local-development-key

PORT=3000
CORS_ORIGIN=http://localhost:5173
PUBLIC_BASE_URL=
LOT_AGENT_PUBLIC_URL=http://localhost:5173

KNOWLEDGE_MANAGEMENT_ENABLED=0
KNOWLEDGE_INGESTION_ENABLED=0
KNOWLEDGE_EXTERNAL_ENABLED=0
```

`DEBUG=1` bypasses login and uses a seeded development user with the environment-configured model. Use it only in a trusted local environment; disable it for deployment. `NEW_API_MANAGED_KEYS=0` explicitly overrides the template's managed-mode setting for this local flow.

For real image/video generation in local mode, configure `TOKENHUB_API_KEY` or the per-media overrides `IMAGE_GEN_API_KEY` / `VIDEO_GEN_API_KEY`, and choose supported models and adapters in [`config/default.json`](config/default.json). Media requests use `OPENAI_BASE_URL`; missing media keys fall back to mock providers in the environment-based flow.

The API requires a nonempty `PG_PASSWORD`. Non-secret model catalogs, pricing, agent/context settings, and generation adapters live in `config/default.json`; MCP connections live in [`config/mcp-servers.json`](config/mcp-servers.json). The current server loaders read these files directly; do not assume `config/local.json` is merged automatically.

### 3. Start the workspace

On a fresh database, start the API first and let migrations finish:

```bash
pnpm dev:server
```

After the API is ready, stop that process and launch the full development stack:

```bash
pnpm dev
```

This starts five commands:

| Process | Purpose |
| --- | --- |
| `core` | Watch and rebuild the shared core package |
| `server` | Hono API on port 3000 by default |
| `worker` | Image/video generation, memory extraction, and opportunity jobs |
| `knowledge` | Knowledge ingestion; exits when ingestion is disabled |
| `web` | Vite on port 5173, proxying `/api` and `/static` to the API |

Open [the web workspace](http://localhost:5173). The API health endpoint is [`/health`](http://localhost:3000/health).

Commands for running individual components:

```bash
pnpm dev:server
pnpm dev:web
pnpm --filter @lot-agent/server dev:worker
pnpm dev:knowledge
pnpm dev:desktop  # Starts Web + Electron; run the backend separately
```

See the [desktop guide](docs/desktop.md) and [mini program guide](docs/miniprogram.md) for client configuration and packaging.

### 4. Configure authenticated deployments

Normal operation uses TokenHub / New API authentication and managed credentials for each user. Configure:

- `SECRET_MASTER_KEY`: a 32-byte key, encoded as 64 hex characters or base64; use the same value in the API and workers.
- `NEW_API_INTERNAL_BASE_URL`, `NEW_API_INTERNAL_CLIENT_ID`, and `NEW_API_INTERNAL_CLIENT_SECRET`: access to the New API internal control plane.
- `OPENAI_BASE_URL`: the model gateway endpoint.
- `NEW_API_AGENT_KEY`: required for the gateway's jump-token login flow.
- Public URLs, CORS origins, database/Redis connections, and optional WeChat settings from [`.env.example`](.env.example).

Generate an encryption key with `openssl rand -hex 32`. Keep real credentials out of Git. Managed credentials are required outside debug mode even if `NEW_API_MANAGED_KEYS` is unset or `0`.

Use the client login flow: password login fetches `/api/auth/public-key`, encrypts the password, and exchanges it with `/api/auth/login` for a Bearer session token. Email-only passwordless login is not supported. Model calls use the authenticated user's credentials; recharge and payment records are managed by the external New API service.

See [deployment](docs/deployment.md) and [recharge integration](docs/recharge.md) for operational details.

### 5. Enable knowledge features

The default configuration selects `knowledge.source: "local"`. Management and ingestion are independently gated in `.env`:

```dotenv
KNOWLEDGE_MANAGEMENT_ENABLED=1
KNOWLEDGE_INGESTION_ENABLED=1
# Optional external read API:
KNOWLEDGE_EXTERNAL_ENABLED=1
```

Knowledge indexing requires pgvector, Redis, the knowledge worker, and user access to the configured embedding/OCR models. Enabling these flags alone does not provision gateway credentials. The external API uses separate knowledge keys and collection grants rather than login session tokens.

See [ingestion and retrieval](docs/knowledge-ingestion.md), [external API access](docs/knowledge-external-api.md), and the [OpenAPI contract](docs/knowledge-openapi.json). Knowledge originals and database contents both need backup; see [backup and restore](docs/knowledge-backup-restore.md).

PPT thumbnails are also optional: install LibreOffice and `pdftoppm`, with executable paths configured through `PPT_SOFFICE_PATH` and `PPT_PDFTOPPM_PATH` if needed. PPTX export remains available without them. See the [PPT workflow](docs/ppt-workflow.md).

## API Overview

Most workspace routes require a Bearer session token and enforce user ownership. Public authentication/product/share routes, knowledge-key access, and preview tickets have distinct access rules; see [`packages/server/src/index.ts`](packages/server/src/index.ts) for middleware and mounting.

| Route group | Purpose |
| --- | --- |
| `/api/auth` | Login, registration, password reset, profile, phone/WeChat binding, and sessions |
| `/api/agents`, `/api/models` | Agent discovery/installation and user-accessible model catalog |
| `/api/conversations` | Conversations, projects, messages via SSE, regeneration, knowledge scope, and generation submission |
| `/api/tasks`, `/api/video-drafts` | Background task status/cancellation and video drafting |
| `/api/assets`, `/api/uploads` | Generated assets, share management, and attachments |
| `/api/usage`, `/api/balance`, `/api/recharge` | Usage, points balance, and recharge |
| `/api/digital-employee` | Profiles, marketing, opportunities, and acquisition |
| `/api/knowledge-bases`, `/api/rag/manage` | Knowledge selection and private knowledge management |
| `/api/rag/v1`, `/api/rag/preview` | External knowledge-key access and ticketed previews |
| `/api/skills`, `/api/traces`, `/api/ratings`, `/api/memory` | Skills, diagnostics, feedback, and memory |
| `/api/platform`, `/api/publish` | Publishing integration scaffolding |
| `/api/public/product`, `/api/public/shares` | Public product information and explicitly shared works |

For exact request schemas, consult the route implementations and adjacent tests. Generated files are served through `/static/assets`, `/static/documents`, and `/static/uploads`; private knowledge originals are not mounted there.

## Build and Validate

```bash
pnpm build                              # Build all workspaces
pnpm test                               # Vitest suite
pnpm test:knowledge                     # Core build + focused knowledge tests
pnpm --filter @lot-agent/web build
pnpm --filter @lot-agent/miniprogram build  # Type checking, not device validation
pnpm dist:desktop:mac
pnpm dist:desktop:win
```

Tests are generally colocated as `*.test.ts`. Database integration, real model calls, desktop packaging, and WeChat device behavior require their respective environments. Additional knowledge diagnostics, reindexing, billing reconciliation, and backup commands are listed in `package.json`; read the associated scripts before running them against persistent data or paid models.

## Extending the Project

- **Agents and tools:** definitions live in `packages/core/src/agents/definitions`; registration and dependency wiring live in `packages/server/src/services/agent-service.ts`. Configure explicit tool allowlists for specialized agents.
- **Skills:** add Markdown files with `name`, `description`, and `triggers` frontmatter under `skills/`. The loader supports agent-scoped injection and on-demand loading.
- **MCP:** configure servers in `config/mcp-servers.json`. The repository ships with an empty server list.
- **Database:** append a migration under `packages/server/src/db/migrations/` and register it in `index.ts`; do not rewrite applied migrations.

Read [AGENTS.md](AGENTS.md) or [CLAUDE.md](CLAUDE.md) for development conventions, and [Project Architecture and Code Navigation](docs/agent-code-guide.md) for feature entry points and execution flows.

## Current Boundaries

- Xiaohongshu and WeChat publishing connectors remain stubs; content review uses a local keyword provider rather than a cloud moderation integration.
- TTS and ASR providers remain placeholders. Knowledge ingestion does not yet recognize audio/video content.
- Contract comparison uses agent instructions, attachments, and document tools. Conversation projects organize chats rather than providing a full collaboration system.
- Agent-as-tool and DAG definitions/validation exist in core, but there is no complete persistent multi-agent workflow executor.
- Supported gateway models and account/payment capabilities depend on the connected service. Repository implementations do not by themselves confirm a deployed integration is configured or available.
