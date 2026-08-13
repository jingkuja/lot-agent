# URL Token Auto-Login — Design

**Date:** 2026-07-08
**Status:** Approved

## Goal

Visiting the web app at `/?token=<jwt>` exchanges that tokenhub-issued JWT for a
local session and drops the user straight into the workspace — no manual
username/password login. This lets tokenhub link users directly into Lot Agent.

## Decisions

- **Precedence:** the URL `token` always wins. Even if a valid local session
  (`lot_token`) already exists, arriving with `?token=` re-authenticates as that
  token's account and replaces the session.
- **Failure:** if the exchange fails (expired/invalid JWT, network error), show
  an error message (`自动登录失败，请手动登录`) above the normal manual login form.
- **URL cleanup:** on both success and failure, strip `?token=` from the address
  bar via `history.replaceState` so the JWT never lingers in history/bookmarks.
- **Server-side exchange:** the browser only ever holds the tokenhub JWT for the
  duration of the initial link; the JWT is POSTed to our server, which exchanges
  it with tokenhub and returns our own PG-backed session token.

## Components

### 1. tokenhub client — `packages/server/src/tokenhub/client.ts`

Add `tokenLogin(token: string): Promise<TokenhubLoginResult>`, mirroring
`login()`:

```
POST {baseUrl}/auth/token-login   body: { token }
→ { user_id, name, api_key?, api_keys? }
→ normalizeApiKeyEntries(api_keys ?? [api_key])
→ { userId, name, apiKeys }
```

Reuses the existing `post()` / `unwrap()` envelope handling and error-code
opacity (all failures collapse to a single generic `Error`). The response's
`access_token` field is ignored — only identity + `api_keys` are needed, the
same shape `login()` already consumes.

### 2. Server route — `packages/server/src/routes/auth.ts`

Add `POST /token-login` (public, sibling of `/login`):

```
body { token } → service.tokenhub.tokenLogin(token)
  → db.upsertUserByExternalId(...) → sessions.createSession(user.id)
  → { token: sessionToken, user: toPublicUser(user) }
```

Missing/empty token, or any tokenhub failure, → generic `LOGIN_FAIL` 401 (same
opacity rule as `/login`). The returned session `token` is our own PG session
token, distinct from the incoming tokenhub JWT.

### 3. Web API client — `packages/web/src/api/client.ts`

Add `tokenLogin(token: string)` → `POST /auth/token-login` returning
`{ token, user }`.

### 4. Web bootstrap — `packages/web/src/App.tsx`

New first step in the mount effect, before the existing `getToken()` check:

- Read `token` from `window.location.search` (via `readTokenFromUrl` helper).
- **If present** (URL token always wins): call `api.tokenLogin(token)`.
  - Success → `setToken(res.token)`, strip `?token=`, `enter(res.user)`.
  - Failure → strip `?token=`, set an error message, show `Login` with it.
- **If absent** → existing flow unchanged (validate `lot_token` via `me()`,
  else `mode()` / login).

Stripping happens on both paths so the JWT never lingers in the address bar.

### 5. Login error surface — `packages/web/src/components/Login.tsx`

Add optional `initialError?: string` prop, used as the initial `error` state, so
App can pass the auto-login failure message.

### 6. URL helper — `packages/web/src/lib/url-token.ts`

Pure `readTokenFromUrl(search: string): string | null` — extracts and decodes
the `token` param — kept out of the App effect so it can be unit-tested.

## Testing

- `client.test.ts`: `tokenLogin` success maps fields + normalizes keys; failure
  collapses to the error code.
- `auth.test.ts`: `POST /token-login` success returns session + user; missing
  token → 401; tokenhub throw → 401.
- `url-token.test.ts`: extracts token, returns null when absent, decodes
  percent-encoding.
