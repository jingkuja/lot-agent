# DEBUG mode — design

**Date:** 2026-07-04
**Status:** Draft (awaiting user review)

## Goal

Add a local debug mode toggled by the environment variable `DEBUG=1`. When on:

- **No login required** — the app is usable (web + API) without going through tokenhub login.
- **Env model + key** — model calls use the env-configured LLM (`OPENAI_API_KEY` /
  `OPENAI_MODEL` / `OPENAI_BASE_URL`) instead of a per-user tokenhub api_key.

This is a developer convenience for running the stack locally without a tokenhub account. It is
**not** a production auth mode.

## Background (what already exists)

- Every `/api/*` route except `/api/auth/*` is behind `authMw`, which requires a `Bearer` token,
  resolves it to a session, and sets `c.get("userId")`. The web app shows the `Login` screen until
  `api.me()` succeeds.
- Providers are built **per request** from the caller's tokenhub `api_key` + selected model.
- There is **already an env fallback**: in `AgentService.streamAgentResponse` (and `generateTitle`),
  when `db.getUserApiKey(userId)` returns `null`, the LLM falls back to
  `createLLMProvider(this.llmConfig)` — the env-driven OpenAI/Anthropic provider. So an api-key-less
  user already chats against the env model.
- The gap: `getUserModelCatalog(userId, null)` returns `null` → `GET /api/models` is empty →
  `ModelPicker` shows "暂无模型" and the web send-guard blocks sending. So a login-less user cannot
  actually use chat through the UI today.

Debug mode therefore reduces to: (1) admit requests without a token, (2) surface the env model in
the catalog, (3) let the web skip the login screen.

## Design

Single boolean `debug = process.env.DEBUG === "1"`, computed once at startup and threaded to the
few places that need it. A fixed debug user id is derived from a seeded DB row.

### 1. Debug user (startup seed)

When `debug`, `index.ts` (after `service.init()`) seeds a stable user row via the existing
`db.upsertUserByExternalId({ externalUserId: 0, username: "debug", apiKeys: [] })`. Empty `apiKeys`
means `api_key` is stored as `null`, so **every provider resolution falls through to the env LLM**
with no extra branching. The returned row id is kept as `service.debugUserId`.

Real users log in via tokenhub and get `externalUserId` from tokenhub; `0` is reserved and cannot
collide.

### 2. Auth bypass (`auth/middleware.ts`)

`createAuthMiddleware(sessions)` → `createAuthMiddleware(sessions, opts?: { debug; debugUserId })`.

New logic: resolve the token as today. If it resolves to a session, use it (so a logged-in user in a
debug build still acts as themselves). Otherwise, **if `debug`**, set `userId = debugUserId` and
continue instead of returning 401. If not debug, unchanged 401 behavior.

Net effect in debug: `/api/*` works with **no** `Authorization` header.

### 3. Env model catalog (`services/agent-service.ts`)

`AgentService` gains a `debug: boolean` field (from `ServiceConfig`). In `getUserModelCatalog`, when
`apiKey` is null:

```ts
if (!apiKey) {
  if (this.debug) {
    // Surface the single env model so the picker/send-guard work without tokenhub.
    return enrichCatalog(this.modelCatalog, {
      llm: [defaultLlmModelId(this.llmConfig)],
      image: [],
      video: [],
    });
  }
  return null;
}
```

Not cached in Redis (cheap, and avoids staleness if env changes). `GET /api/models` then returns the
one env LLM; the ModelPicker shows it and the "无可用模型" send-guard passes.

### 4. Public mode endpoint (`routes/auth.ts`)

New **public** route `GET /api/auth/mode` → `{ debug: boolean, user: PublicUser | null }`. When
debug, `user` is the sanitized debug user (`toPublicUser`), else `null`. Lets the web decide whether
to skip login before it has any token.

### 5. Web skip-login (`web/src/api/client.ts`, `web/src/App.tsx`)

- `client.ts`: add `mode(): Promise<{ debug; user }>`.
- `App.tsx` mount flow:
  - token present → `me()` as today.
  - no token → `mode()`; if `debug` → `enter(user)` (straight to Workspace, no Login screen); else
    → show Login.

Tokenless API calls from the Workspace succeed because the middleware admits them. The existing
`lot:unauthorized` (401) listener stays; in debug the middleware never 401s.

## Files touched

| File | Change |
|---|---|
| `packages/server/src/index.ts` | compute `debug`; seed debug user; pass `debug`+`debugUserId` to middleware; put `debug` in `ServiceConfig` |
| `packages/server/src/auth/middleware.ts` | `debug`/`debugUserId` bypass |
| `packages/server/src/services/agent-service.ts` | `debug` field; env catalog branch in `getUserModelCatalog` |
| `packages/server/src/routes/auth.ts` | public `GET /mode` |
| `packages/web/src/api/client.ts` | `mode()` |
| `packages/web/src/App.tsx` | skip login when debug |
| `.env.example` | document `DEBUG=1` |

## Tests

- `middleware.test.ts` — debug + no token → sets debugUserId & calls next; debug off + no token → 401.
- `agent-service` / catalog — `getUserModelCatalog(id, null)` with debug on returns a one-LLM catalog
  from the env model; with debug off returns null.
- `auth.test.ts` — `GET /mode` returns `{ debug, user }` correctly on/off.

## Non-goals / limitations

- Only an **LLM** is available in debug (image/video env stubs are empty in the catalog). Async
  image/video generation is out of scope for this toggle.
- Usage is still **metered** against the debug user (harmless locally; no quota tuning here).
- DEBUG is a **local-dev** switch. It must default off and never be enabled in a deployed
  environment — documented as such in `.env.example`.
