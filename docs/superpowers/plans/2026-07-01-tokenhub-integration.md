# Tokenhub Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tokenhub the platform's auth source (RSA password login → per-user `api_key`) and model source (per-user dynamic model catalog, per-conversation model selection, per-user provider calls).

**Architecture:** A new `TokenhubClient` wraps tokenhub's `/auth/login` and `/models`. Login decrypts an RSA-OAEP-encrypted password (ephemeral in-process keypair), calls tokenhub, and upserts a local user keyed by `external_user_id` storing the returned `api_key`. `GET /api/models` proxies the catalog (Redis-cached, enriched from a config `modelCatalog` block). A `ProviderFactory` builds LLM/image/video providers per-request using the caller's `api_key` and the selected model. The web app gets a `ModelPicker` (letter quick-filter) whose choice persists on `conversations.model_id`.

**Tech Stack:** TypeScript ESM monorepo (npm workspaces), Hono, `pg`, `ioredis`/BullMQ, React 19 + Vite, Vitest. Node `crypto` (BE) + Web Crypto (FE) for RSA — no new deps.

## Global Constraints

- ESM imports use explicit `.js` suffixes; 2-space indent.
- Interface-in-core, impl-in-server. Keep `pg`/`ioredis` out of `@lot-agent/core`.
- Secrets never in git; non-secret structure in `config/default.json`, keys via env.
- **`api_key` is a secret**: never in any response body sent to the client, never in info-level logs, never in the web bundle.
- Login failure of ANY kind returns HTTP 401 with the exact message `登录失败，请稍后再试或者联系管理员`.
- Tokenhub base for login/catalog: `https://tokenhub.todoucloud.com/api/agent-market`. Model-call base reuses `generation.baseUrl`.
- Web colors use existing `var(--*)` tokens only — no hardcoded hex/rgba.
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- Run tests with `npm test -w @lot-agent/server` / `-w @lot-agent/core` / root `npm test`.

---

## Task 1: TokenhubClient (login + listModels)

**Files:**
- Create: `packages/server/src/tokenhub/client.ts`
- Test: `packages/server/src/tokenhub/client.test.ts`

**Interfaces:**
- Produces:
  - `interface TokenhubLoginResult { userId: number; name: string; apiKey: string }`
  - `interface TokenhubModels { llm: string[]; image: string[]; video: string[] }`
  - `class TokenhubClient { constructor(baseUrl: string, fetchImpl?: typeof fetch); login(username: string, password: string): Promise<TokenhubLoginResult>; listModels(apiKey: string): Promise<TokenhubModels> }`
  - Both methods throw a plain `Error` (message `tokenhub_login_failed` / `tokenhub_models_failed`) on any non-`success` response or network error.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/tokenhub/client.test.ts
import { describe, it, expect, vi } from "vitest";
import { TokenhubClient } from "./client.js";

const ok = (data: unknown) =>
  ({ ok: true, json: async () => ({ data, success: true }) }) as Response;
const fail = () =>
  ({ ok: true, json: async () => ({ data: null, success: false, message: "bad" }) }) as Response;

describe("TokenhubClient", () => {
  it("login maps a successful response", async () => {
    const f = vi.fn().mockResolvedValue(
      ok({ user_id: 2, name: "13881071870", api_key: "sk-X", access_token: "sk-X" })
    );
    const c = new TokenhubClient("https://h/api/agent-market", f as unknown as typeof fetch);
    await expect(c.login("13881071870", "pw")).resolves.toEqual({
      userId: 2,
      name: "13881071870",
      apiKey: "sk-X",
    });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://h/api/agent-market/auth/login");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      username: "13881071870",
      password: "pw",
    });
  });

  it("login throws generic error on success:false", async () => {
    const c = new TokenhubClient("https://h/api/agent-market", vi.fn().mockResolvedValue(fail()) as unknown as typeof fetch);
    await expect(c.login("u", "p")).rejects.toThrow("tokenhub_login_failed");
  });

  it("login throws generic error on network failure", async () => {
    const c = new TokenhubClient("https://h/api/agent-market", vi.fn().mockRejectedValue(new Error("ECONN")) as unknown as typeof fetch);
    await expect(c.login("u", "p")).rejects.toThrow("tokenhub_login_failed");
  });

  it("listModels returns the three buckets", async () => {
    const f = vi.fn().mockResolvedValue(ok({ llm: ["gpt-5.4"], image: ["gpt-image-2"], video: ["veo3.1"] }));
    const c = new TokenhubClient("https://h/api/agent-market", f as unknown as typeof fetch);
    await expect(c.listModels("sk-X")).resolves.toEqual({
      llm: ["gpt-5.4"], image: ["gpt-image-2"], video: ["veo3.1"],
    });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://h/api/agent-market/models");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer sk-X" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/server -- client.test`
Expected: FAIL — `Cannot find module './client.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/server/src/tokenhub/client.ts
export interface TokenhubLoginResult {
  userId: number;
  name: string;
  apiKey: string;
}
export interface TokenhubModels {
  llm: string[];
  image: string[];
  video: string[];
}

interface Envelope<T> {
  data: T | null;
  success: boolean;
  message?: string;
}

/** Thin fetch wrapper over tokenhub's agent-market API. Every failure — network,
 * non-2xx, or `success:false` — is collapsed into a single generic Error so
 * callers cannot leak the underlying cause to end users. */
export class TokenhubClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async login(username: string, password: string): Promise<TokenhubLoginResult> {
    const data = await this.post<{ user_id: number; name: string; api_key: string }>(
      "/auth/login",
      { username, password },
      "tokenhub_login_failed"
    );
    return { userId: data.user_id, name: data.name, apiKey: data.api_key };
  }

  async listModels(apiKey: string): Promise<TokenhubModels> {
    const data = await this.get<Partial<TokenhubModels>>(
      "/models",
      apiKey,
      "tokenhub_models_failed"
    );
    return { llm: data.llm ?? [], image: data.image ?? [], video: data.video ?? [] };
  }

  private async post<T>(path: string, body: unknown, errCode: string): Promise<T> {
    return this.unwrap<T>(
      () =>
        this.fetchImpl(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      errCode
    );
  }

  private async get<T>(path: string, apiKey: string, errCode: string): Promise<T> {
    return this.unwrap<T>(
      () =>
        this.fetchImpl(`${this.baseUrl}${path}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        }),
      errCode
    );
  }

  private async unwrap<T>(call: () => Promise<Response>, errCode: string): Promise<T> {
    try {
      const res = await call();
      if (!res.ok) throw new Error(errCode);
      const env = (await res.json()) as Envelope<T>;
      if (!env.success || env.data == null) throw new Error(errCode);
      return env.data;
    } catch {
      throw new Error(errCode);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/server -- client.test`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/tokenhub/
git commit -m "feat(server): TokenhubClient for login + model catalog"
```

---

## Task 2: RSA keypair util + public-key endpoint

**Files:**
- Create: `packages/server/src/auth/rsa.ts`
- Test: `packages/server/src/auth/rsa.test.ts`
- Modify: `packages/server/src/routes/auth.ts` (add `GET /public-key`)

**Interfaces:**
- Produces:
  - `interface RsaKeypair { publicKeyPem: string; decrypt(base64Ciphertext: string): string }`
  - `function generateRsaKeypair(): RsaKeypair` — RSA-OAEP/SHA-256, 2048-bit. `decrypt` takes base64 ciphertext, returns UTF-8 plaintext.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/auth/rsa.test.ts
import { describe, it, expect } from "vitest";
import { publicEncrypt, constants } from "node:crypto";
import { generateRsaKeypair } from "./rsa.js";

describe("generateRsaKeypair", () => {
  it("round-trips a password encrypted with the public key (RSA-OAEP/SHA-256)", () => {
    const kp = generateRsaKeypair();
    const cipher = publicEncrypt(
      { key: kp.publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from("Aa147258@", "utf-8")
    ).toString("base64");
    expect(kp.decrypt(cipher)).toBe("Aa147258@");
  });

  it("exposes a PEM public key", () => {
    expect(generateRsaKeypair().publicKeyPem).toMatch(/BEGIN PUBLIC KEY/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/server -- rsa.test`
Expected: FAIL — `Cannot find module './rsa.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/server/src/auth/rsa.ts
import { generateKeyPairSync, privateDecrypt, constants, type KeyObject } from "node:crypto";

export interface RsaKeypair {
  publicKeyPem: string;
  decrypt(base64Ciphertext: string): string;
}

/** Ephemeral in-process RSA-OAEP/SHA-256 keypair. The public key is served to the
 * browser so it can encrypt the password before POSTing it; only this process can
 * decrypt. Regenerated each start — the browser always fetches a fresh key first. */
export function generateRsaKeypair(): RsaKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const priv: KeyObject = privateKey;
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    decrypt(base64Ciphertext: string): string {
      return privateDecrypt(
        { key: priv, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        Buffer.from(base64Ciphertext, "base64")
      ).toString("utf-8");
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/server -- rsa.test`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the public-key endpoint**

In `packages/server/src/routes/auth.ts`, at the top add the import and a module-level keypair, and register the route inside `createAuthRoutes` before `return app;`:

```ts
import { generateRsaKeypair } from "../auth/rsa.js";

// Ephemeral per-process keypair used to decrypt login passwords.
const keypair = generateRsaKeypair();

// (inside createAuthRoutes, before `return app;`)
app.get("/public-key", (c) => c.json({ publicKey: keypair.publicKeyPem }));
```

Export the keypair for the login handler (Task 4) by placing `keypair` at module scope as shown (already module-level).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/auth/rsa.ts packages/server/src/auth/rsa.test.ts packages/server/src/routes/auth.ts
git commit -m "feat(server): ephemeral RSA keypair + /auth/public-key"
```

---

## Task 3: User table migration + external-id upsert + api_key access + sanitizer

**Files:**
- Modify: `packages/server/src/db/database.ts` (migration ~line 445-481; `StoredUser` ~line 123; user methods ~line 960)
- Create: `packages/server/src/db/user-sanitize.ts`
- Test: `packages/server/src/db/user-sanitize.test.ts`

**Interfaces:**
- Produces:
  - `StoredUser` gains `external_user_id: number | null; username: string | null; api_key: string | null`.
  - `interface PublicUser { id: string; name: string; username: string | null }`
  - `function toPublicUser(u: StoredUser): PublicUser` (strips `api_key`, `email`).
  - `Database.upsertUserByExternalId(args: { externalUserId: number; username: string; apiKey: string }): Promise<StoredUser>`
  - `Database.getUserApiKey(userId: string): Promise<string | null>`

- [ ] **Step 1: Write the failing sanitizer test**

```ts
// packages/server/src/db/user-sanitize.test.ts
import { describe, it, expect } from "vitest";
import { toPublicUser } from "./user-sanitize.js";

describe("toPublicUser", () => {
  it("strips api_key and email", () => {
    const pub = toPublicUser({
      id: "u1", email: "x@tokenhub.local", name: "Nik", created_at: "t",
      external_user_id: 2, username: "13881071870", api_key: "sk-secret",
    });
    expect(pub).toEqual({ id: "u1", name: "Nik", username: "13881071870" });
    expect(JSON.stringify(pub)).not.toContain("sk-secret");
  });

  it("falls back name to username when name is null", () => {
    const pub = toPublicUser({
      id: "u1", email: null, name: null, created_at: "t",
      external_user_id: 2, username: "13881071870", api_key: "sk",
    });
    expect(pub.name).toBe("13881071870");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/server -- user-sanitize.test`
Expected: FAIL — `Cannot find module './user-sanitize.js'`.

- [ ] **Step 3: Implement the sanitizer**

```ts
// packages/server/src/db/user-sanitize.ts
import type { StoredUser } from "./database.js";

export interface PublicUser {
  id: string;
  name: string;
  username: string | null;
}

/** Never send api_key/email to the client. Single choke point for user->client. */
export function toPublicUser(u: StoredUser): PublicUser {
  return { id: u.id, name: u.name ?? u.username ?? "", username: u.username ?? null };
}
```

- [ ] **Step 4: Extend `StoredUser` and add migration + methods**

In `packages/server/src/db/database.ts`, extend the interface (~line 123):

```ts
export interface StoredUser {
  id: string;
  email: string | null;
  name: string | null;
  created_at: string;
  external_user_id?: number | null;
  username?: string | null;
  api_key?: string | null;
}
```

In `migrate()`, right after the `CREATE TABLE IF NOT EXISTS users (...)` block (~line 451), add:

```ts
await client.query(`
  ALTER TABLE users ADD COLUMN IF NOT EXISTS external_user_id BIGINT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(255);
  ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key TEXT;
  ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_external ON users (external_user_id);
`);
```

Add methods near `getUserById` (~line 976):

```ts
async upsertUserByExternalId(args: {
  externalUserId: number;
  username: string;
  apiKey: string;
}): Promise<StoredUser> {
  const { rows } = await this.pool.query(
    `INSERT INTO users (external_user_id, username, name, api_key, email)
       VALUES ($1, $2, $2, $3, $4)
     ON CONFLICT (external_user_id)
       DO UPDATE SET username = $2, api_key = $3
     RETURNING *`,
    [args.externalUserId, args.username, args.apiKey, `${args.username}@tokenhub.local`]
  );
  return rows[0];
}

async getUserApiKey(userId: string): Promise<string | null> {
  const { rows } = await this.pool.query(
    "SELECT api_key FROM users WHERE id = $1",
    [userId]
  );
  return rows[0]?.api_key ?? null;
}
```

- [ ] **Step 5: Run tests + build**

Run: `npm test -w @lot-agent/server -- user-sanitize.test` — Expected: PASS.
Run: `npm run build -w @lot-agent/server` — Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/db/
git commit -m "feat(server): user external_user_id/username/api_key + sanitizer"
```

---

## Task 4: Login route — RSA decrypt + tokenhub login + session

**Files:**
- Modify: `packages/server/src/routes/auth.ts` (replace `POST /login`, update `/me`)
- Modify: `packages/server/src/services/agent-service.ts` (expose `tokenhub: TokenhubClient` + config base — see Interfaces)
- Test: `packages/server/src/routes/auth.test.ts`

**Interfaces:**
- Consumes: `TokenhubClient` (Task 1), `keypair` (Task 2), `upsertUserByExternalId`/`toPublicUser` (Task 3).
- Produces: `service.tokenhub: TokenhubClient` and `service.tokenhubBaseUrl: string` on `AgentService`.
  - `POST /api/auth/login { username, encryptedPassword }` → `{ token, user: PublicUser }` or `401 { error: "登录失败，请稍后再试或者联系管理员" }`.

- [ ] **Step 1: Add TokenhubClient to AgentService**

In `packages/server/src/services/agent-service.ts`, add a field and initialize it in the constructor (near where other services init, after `this.modelRegistry = ...`). Add import at top:

```ts
import { TokenhubClient } from "../tokenhub/client.js";
```

Add fields + init:

```ts
readonly tokenhub: TokenhubClient;
readonly tokenhubBaseUrl: string;
// in constructor:
this.tokenhubBaseUrl =
  process.env.TOKENHUB_BASE_URL ?? "https://tokenhub.todoucloud.com/api/agent-market";
this.tokenhub = new TokenhubClient(this.tokenhubBaseUrl);
```

- [ ] **Step 2: Write the failing route test**

```ts
// packages/server/src/routes/auth.test.ts
import { describe, it, expect, vi } from "vitest";
import { createAuthRoutes } from "./auth.js";

function fakeService() {
  return {
    tokenhub: { login: vi.fn() },
    db: { upsertUserByExternalId: vi.fn() },
    sessions: { createSession: vi.fn().mockResolvedValue("tok-1") },
  } as unknown as import("../services/agent-service.js").AgentService;
}

async function encryptFor(app: ReturnType<typeof createAuthRoutes>, pw: string) {
  const { publicEncrypt, constants } = await import("node:crypto");
  const res = await app.request("/public-key");
  const { publicKey } = await res.json();
  return publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(pw, "utf-8")
  ).toString("base64");
}

describe("auth login", () => {
  it("decrypts, calls tokenhub, upserts, returns token + sanitized user", async () => {
    const svc = fakeService();
    (svc.tokenhub.login as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 2, name: "138", apiKey: "sk-SECRET",
    });
    (svc.db.upsertUserByExternalId as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "u1", email: null, name: "138", created_at: "t",
      external_user_id: 2, username: "138", api_key: "sk-SECRET",
    });
    const app = createAuthRoutes(svc);
    const encryptedPassword = await encryptFor(app, "pw");
    const res = await app.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "138", encryptedPassword }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.token).toBe("tok-1");
    expect(json.user).toEqual({ id: "u1", name: "138", username: "138" });
    expect(JSON.stringify(json)).not.toContain("sk-SECRET");
    expect(svc.tokenhub.login).toHaveBeenCalledWith("138", "pw");
  });

  it("returns generic 401 when tokenhub login fails", async () => {
    const svc = fakeService();
    (svc.tokenhub.login as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("tokenhub_login_failed"));
    const app = createAuthRoutes(svc);
    const encryptedPassword = await encryptFor(app, "pw");
    const res = await app.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "138", encryptedPassword }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("登录失败，请稍后再试或者联系管理员");
  });

  it("returns generic 401 when decryption fails", async () => {
    const svc = fakeService();
    const app = createAuthRoutes(svc);
    const res = await app.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "138", encryptedPassword: "not-base64-rsa" }),
    });
    expect(res.status).toBe(401);
    expect(svc.tokenhub.login).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -w @lot-agent/server -- routes/auth.test`
Expected: FAIL — login still expects `{ email }`, returns wrong shape.

- [ ] **Step 4: Rewrite the login handler + /me sanitizing**

In `packages/server/src/routes/auth.ts`, add imports and replace the `POST /login` block and sanitize `/me`:

```ts
import { toPublicUser } from "../db/user-sanitize.js";

const LOGIN_FAIL = "登录失败，请稍后再试或者联系管理员";

// POST /login — RSA-encrypted password → tokenhub → local session
app.post("/login", async (c) => {
  let body: { username?: string; encryptedPassword?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const { username, encryptedPassword } = body;
  if (!username || !encryptedPassword) {
    return c.json({ error: LOGIN_FAIL }, 401);
  }
  try {
    const password = keypair.decrypt(encryptedPassword);
    const result = await service.tokenhub.login(username, password);
    const user = await service.db.upsertUserByExternalId({
      externalUserId: result.userId,
      username: result.name,
      apiKey: result.apiKey,
    });
    const token = await service.sessions.createSession(user.id);
    return c.json({ token, user: toPublicUser(user) });
  } catch {
    return c.json({ error: LOGIN_FAIL }, 401);
  }
});
```

In `/me`, replace `return c.json(user);` with `return c.json(toPublicUser(user));`.

- [ ] **Step 5: Run tests + build**

Run: `npm test -w @lot-agent/server -- routes/auth.test` — Expected: PASS (3 tests).
Run: `npm run build -w @lot-agent/server` — Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/routes/auth.ts packages/server/src/routes/auth.test.ts packages/server/src/services/agent-service.ts
git commit -m "feat(server): RSA password login via tokenhub, sanitized user output"
```

---

## Task 5: Web login — username/password + RSA encrypt + api client

**Files:**
- Modify: `packages/web/src/api/client.ts` (`User` type, `login`, add `getPublicKey`)
- Create: `packages/web/src/lib/rsa.ts`
- Modify: `packages/web/src/components/Login.tsx`
- Test: `packages/web/src/lib/rsa.test.ts`

**Interfaces:**
- Consumes: `GET /api/auth/public-key`, `POST /api/auth/login { username, encryptedPassword }`.
- Produces:
  - `User` becomes `{ id: string; name: string; username: string | null }` (drop `email`).
  - `api.getPublicKey(): Promise<{ publicKey: string }>`
  - `api.login(username: string, encryptedPassword: string): Promise<{ token: string; user: User }>`
  - `async function encryptPassword(pemPublicKey: string, password: string): Promise<string>` (base64 RSA-OAEP/SHA-256 via Web Crypto).

- [ ] **Step 1: Write the failing rsa test (jsdom/Web Crypto round-trip against Node)**

```ts
// packages/web/src/lib/rsa.test.ts
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, privateDecrypt, constants } from "node:crypto";
import { encryptPassword } from "./rsa.js";

describe("encryptPassword", () => {
  it("produces base64 RSA-OAEP ciphertext Node can decrypt", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const cipher = await encryptPassword(pem, "Aa147258@");
    const plain = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(cipher, "base64")
    ).toString("utf-8");
    expect(plain).toBe("Aa147258@");
  });
});
```

Note: this test needs Web Crypto (`crypto.subtle`) in the test env. Ensure the web vitest config uses `environment: "jsdom"` or `node` ≥18 (global `crypto.subtle` is available in Node 18+). If the web package has no vitest env set, add `// @vitest-environment node` as the first line of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/web -- rsa.test`
Expected: FAIL — `Cannot find module './rsa.js'`.

- [ ] **Step 3: Implement `encryptPassword` (Web Crypto, SPKI PEM → RSA-OAEP)**

```ts
// packages/web/src/lib/rsa.ts
/** Encrypt a password with an SPKI-PEM RSA public key using RSA-OAEP/SHA-256.
 * Returns base64 ciphertext for POSTing to /api/auth/login. Browser-native
 * Web Crypto — no dependencies. */
export async function encryptPassword(pemPublicKey: string, password: string): Promise<string> {
  const der = pemToArrayBuffer(pemPublicKey);
  const key = await crypto.subtle.importKey(
    "spki",
    der,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"]
  );
  const cipher = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    key,
    new TextEncoder().encode(password)
  );
  return btoa(String.fromCharCode(...new Uint8Array(cipher)));
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/web -- rsa.test`
Expected: PASS.

- [ ] **Step 5: Update the api client**

In `packages/web/src/api/client.ts`, change the `User` interface:

```ts
export interface User {
  id: string;
  name: string;
  username: string | null;
}
```

Replace the `login` entry and add `getPublicKey` in the `api` object:

```ts
getPublicKey: () => request<{ publicKey: string }>("/auth/public-key"),

login: (username: string, encryptedPassword: string) =>
  request<{ token: string; user: User }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, encryptedPassword }),
  }),
```

- [ ] **Step 6: Rewrite Login.tsx fields + submit**

In `packages/web/src/components/Login.tsx`: replace `email`/`name` state with `username`/`password`, import `encryptPassword`, and rewrite `handleSubmit`:

```tsx
import { encryptPassword } from "../lib/rsa.js";
// ...
const [username, setUsername] = useState("");
const [password, setPassword] = useState("");
// ...
const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault();
  if (!username.trim() || !password) return;
  setError(null);
  setLoading(true);
  try {
    const { publicKey } = await api.getPublicKey();
    const encrypted = await encryptPassword(publicKey, password);
    const res = await api.login(username.trim(), encrypted);
    setToken(res.token);
    onLogin(res.user);
  } catch (err) {
    setError(err instanceof Error && err.message !== "Unauthorized"
      ? err.message
      : "登录失败，请稍后再试或者联系管理员");
  } finally {
    setLoading(false);
  }
};
```

Replace the two form fields with a 用户名 text input (bound to `username`) and a 密码 `type="password"` input (bound to `password`). Keep existing `className`/label markup patterns (`login-field`, `login-title`, etc.).

- [ ] **Step 7: Build the web package**

Run: `npm run build -w @lot-agent/web`
Expected: no type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/lib/rsa.ts packages/web/src/lib/rsa.test.ts packages/web/src/api/client.ts packages/web/src/components/Login.tsx
git commit -m "feat(web): username/password login with RSA-OAEP password encryption"
```

---

## Task 6: modelCatalog config + pricing/provider resolver

**Files:**
- Modify: `config/default.json` (add `modelCatalog` block)
- Create: `packages/server/src/models/catalog.ts`
- Test: `packages/server/src/models/catalog.test.ts`

**Interfaces:**
- Produces:
  - `interface Pricing { inputPrice: number; outputPrice: number; unitPrice: number }`
  - `interface CatalogModel { id: string; type: "llm" | "image" | "video"; provider: string; pricing: Pricing }`
  - `interface ModelCatalogConfig { providerMap: Record<string, string>; defaultProvider: Record<string, string>; pricing: Record<string, Pricing>; defaultPricing: Record<string, Pricing> }`
  - `function resolveProvider(cfg: ModelCatalogConfig, id: string, type: string): string`
  - `function resolvePricing(cfg: ModelCatalogConfig, id: string, type: string): Pricing`
  - `function enrichCatalog(cfg: ModelCatalogConfig, models: { llm: string[]; image: string[]; video: string[] }): { llm: CatalogModel[]; image: CatalogModel[]; video: CatalogModel[] }`

- [ ] **Step 1: Add config block**

In `config/default.json`, add a top-level `"modelCatalog"` key:

```json
"modelCatalog": {
  "defaultProvider": { "llm": "openai", "image": "chat-completions", "video": "happyhorse" },
  "providerMap": {
    "happyhorse-1.0-t2v": "happyhorse",
    "doubao-seedance-2.0": "happyhorse",
    "veo2": "happyhorse",
    "veo3.1": "happyhorse",
    "gemini-2.5-flash-image": "chat-completions",
    "gpt-image-2": "chat-completions",
    "gpt-image-2-token": "chat-completions",
    "qwen-image-2.0": "chat-completions",
    "qwen-image-2.0-pro": "chat-completions"
  },
  "pricing": {
    "gpt-image-2-token": { "inputPrice": 0, "outputPrice": 0, "unitPrice": 0.04 }
  },
  "defaultPricing": {
    "llm": { "inputPrice": 0.001, "outputPrice": 0.002, "unitPrice": 0 },
    "image": { "inputPrice": 0, "outputPrice": 0, "unitPrice": 0.04 },
    "video": { "inputPrice": 0, "outputPrice": 0, "unitPrice": 0.5 }
  }
}
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/server/src/models/catalog.test.ts
import { describe, it, expect } from "vitest";
import { resolveProvider, resolvePricing, enrichCatalog, type ModelCatalogConfig } from "./catalog.js";

const cfg: ModelCatalogConfig = {
  defaultProvider: { llm: "openai", image: "chat-completions", video: "happyhorse" },
  providerMap: { "veo3.1": "happyhorse", "gpt-image-2-token": "chat-completions" },
  pricing: { "gpt-image-2-token": { inputPrice: 0, outputPrice: 0, unitPrice: 0.04 } },
  defaultPricing: {
    llm: { inputPrice: 0.001, outputPrice: 0.002, unitPrice: 0 },
    image: { inputPrice: 0, outputPrice: 0, unitPrice: 0.04 },
    video: { inputPrice: 0, outputPrice: 0, unitPrice: 0.5 },
  },
};

describe("catalog resolvers", () => {
  it("llm always resolves to the llm default provider", () => {
    expect(resolveProvider(cfg, "any-unknown-llm", "llm")).toBe("openai");
  });
  it("image/video use providerMap then per-type default", () => {
    expect(resolveProvider(cfg, "veo3.1", "video")).toBe("happyhorse");
    expect(resolveProvider(cfg, "unknown-image", "image")).toBe("chat-completions");
  });
  it("pricing uses the table then falls back to per-type default", () => {
    expect(resolvePricing(cfg, "gpt-image-2-token", "image").unitPrice).toBe(0.04);
    expect(resolvePricing(cfg, "brand-new-llm", "llm")).toEqual(cfg.defaultPricing.llm);
  });
  it("enrichCatalog builds three typed buckets", () => {
    const out = enrichCatalog(cfg, { llm: ["gpt-5.4"], image: ["gpt-image-2-token"], video: ["veo3.1"] });
    expect(out.llm[0]).toEqual({ id: "gpt-5.4", type: "llm", provider: "openai", pricing: cfg.defaultPricing.llm });
    expect(out.video[0].provider).toBe("happyhorse");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -w @lot-agent/server -- catalog.test`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```ts
// packages/server/src/models/catalog.ts
export interface Pricing {
  inputPrice: number;
  outputPrice: number;
  unitPrice: number;
}
export interface CatalogModel {
  id: string;
  type: "llm" | "image" | "video";
  provider: string;
  pricing: Pricing;
}
export interface ModelCatalogConfig {
  providerMap: Record<string, string>;
  defaultProvider: Record<string, string>;
  pricing: Record<string, Pricing>;
  defaultPricing: Record<string, Pricing>;
}

/** LLM always uses its default provider (openai-compatible). Image/video look up
 * the per-model providerMap, then fall back to the per-type default. */
export function resolveProvider(cfg: ModelCatalogConfig, id: string, type: string): string {
  if (type === "llm") return cfg.defaultProvider.llm;
  return cfg.providerMap[id] ?? cfg.defaultProvider[type] ?? cfg.defaultProvider.llm;
}

export function resolvePricing(cfg: ModelCatalogConfig, id: string, type: string): Pricing {
  return cfg.pricing[id] ?? cfg.defaultPricing[type] ?? { inputPrice: 0, outputPrice: 0, unitPrice: 0 };
}

export function enrichCatalog(
  cfg: ModelCatalogConfig,
  models: { llm: string[]; image: string[]; video: string[] }
): { llm: CatalogModel[]; image: CatalogModel[]; video: CatalogModel[] } {
  const build = (ids: string[], type: "llm" | "image" | "video"): CatalogModel[] =>
    ids.map((id) => ({
      id,
      type,
      provider: resolveProvider(cfg, id, type),
      pricing: resolvePricing(cfg, id, type),
    }));
  return { llm: build(models.llm, "llm"), image: build(models.image, "image"), video: build(models.video, "video") };
}
```

- [ ] **Step 5: Run test + verify config parses**

Run: `npm test -w @lot-agent/server -- catalog.test` — Expected: PASS (4 tests).
Run: `node -e "JSON.parse(require('fs').readFileSync('config/default.json','utf8')).modelCatalog.defaultProvider"` — Expected: no error.

- [ ] **Step 6: Commit**

```bash
git add config/default.json packages/server/src/models/catalog.ts packages/server/src/models/catalog.test.ts
git commit -m "feat(server): modelCatalog config + provider/pricing resolvers"
```

---

## Task 7: GET /api/models — proxy + Redis cache + enrichment

**Files:**
- Create: `packages/server/src/routes/models.ts`
- Modify: `packages/server/src/services/agent-service.ts` (load `modelCatalog` config → `service.modelCatalog`; expose `service.redis`)
- Modify: wherever routes are mounted (find with grep — likely `packages/server/src/app.ts` or `index.ts`) to mount `createModelRoutes(service)` at `/api/models`
- Test: `packages/server/src/routes/models.test.ts`

**Interfaces:**
- Consumes: `service.tokenhub.listModels`, `service.db.getUserApiKey`, `service.modelCatalog` (ModelCatalogConfig), `enrichCatalog` (Task 6).
- Produces: `createModelRoutes(service): Hono` serving `GET /` → `{ llm, image, video }` of `CatalogModel[]`. Reads `c.get("userId")`. Redis cache key `models:<userId>` TTL 300s.

- [ ] **Step 1: Load modelCatalog into AgentService + expose redis**

In `agent-service.ts`, after the config is loaded, set `this.modelCatalog` from the parsed config's `modelCatalog` field, and expose the existing redis connection. Add fields:

```ts
readonly modelCatalog: import("../models/catalog.js").ModelCatalogConfig;
readonly redis: import("ioredis").Redis;
```

Init (the config object is already read in the constructor — reuse it; `conn` is the redis connection created at ~line 142):

```ts
this.modelCatalog = (config as { modelCatalog: import("../models/catalog.js").ModelCatalogConfig }).modelCatalog;
this.redis = conn;
```

(If `config` isn't in scope at that point, read `modelCatalog` from the same object the constructor already parses for `models`/`generation`.)

- [ ] **Step 2: Write the failing test**

```ts
// packages/server/src/routes/models.test.ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createModelRoutes } from "./models.js";

function svc(cacheHit: string | null) {
  return {
    redis: { get: vi.fn().mockResolvedValue(cacheHit), set: vi.fn() },
    db: { getUserApiKey: vi.fn().mockResolvedValue("sk-user") },
    tokenhub: { listModels: vi.fn().mockResolvedValue({ llm: ["gpt-5.4"], image: [], video: ["veo3.1"] }) },
    modelCatalog: {
      defaultProvider: { llm: "openai", image: "chat-completions", video: "happyhorse" },
      providerMap: {}, pricing: {},
      defaultPricing: {
        llm: { inputPrice: 0, outputPrice: 0, unitPrice: 0 },
        image: { inputPrice: 0, outputPrice: 0, unitPrice: 0 },
        video: { inputPrice: 0, outputPrice: 0, unitPrice: 0 },
      },
    },
  } as unknown as import("../services/agent-service.js").AgentService;
}

function mount(service: import("../services/agent-service.js").AgentService) {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("userId", "u1"); await next(); });
  app.route("/", createModelRoutes(service));
  return app;
}

describe("GET /api/models", () => {
  it("fetches, enriches, and caches on miss", async () => {
    const service = svc(null);
    const res = await mount(service).request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.llm[0]).toMatchObject({ id: "gpt-5.4", provider: "openai" });
    expect(body.video[0].provider).toBe("happyhorse");
    expect((service.redis.set as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it("serves cache on hit without calling tokenhub", async () => {
    const cached = JSON.stringify({ llm: [], image: [], video: [] });
    const service = svc(cached);
    const res = await mount(service).request("/");
    expect(res.status).toBe(200);
    expect(service.tokenhub.listModels).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -w @lot-agent/server -- routes/models.test`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the route**

```ts
// packages/server/src/routes/models.ts
import { Hono } from "hono";
import type { AgentService } from "../services/agent-service.js";
import { enrichCatalog } from "../models/catalog.js";

type Variables = { userId: string };
const CACHE_TTL_SEC = 300;

export function createModelRoutes(service: AgentService): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.get("/", async (c) => {
    const userId = c.get("userId");
    const cacheKey = `models:${userId}`;
    const cached = await service.redis.get(cacheKey);
    if (cached) return c.json(JSON.parse(cached));

    const apiKey = await service.db.getUserApiKey(userId);
    if (!apiKey) return c.json({ error: "no api key" }, 401);

    let raw;
    try {
      raw = await service.tokenhub.listModels(apiKey);
    } catch {
      return c.json({ error: "模型加载失败" }, 502);
    }
    const enriched = enrichCatalog(service.modelCatalog, raw);
    await service.redis.set(cacheKey, JSON.stringify(enriched), "EX", CACHE_TTL_SEC);
    return c.json(enriched);
  });

  return app;
}
```

- [ ] **Step 5: Mount the route**

Find where other routes mount (grep `createTaskRoutes` in `packages/server/src`), and next to them add:

```ts
import { createModelRoutes } from "./routes/models.js";
app.route("/api/models", createModelRoutes(service));
```

(Place the mount alongside the other authed routes so `authMw` runs — verify the file that applies `authMw` to `/api/*` covers `/api/models`.)

- [ ] **Step 6: Run tests + build**

Run: `npm test -w @lot-agent/server -- routes/models.test` — Expected: PASS (2 tests).
Run: `npm run build -w @lot-agent/server` — Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/routes/models.ts packages/server/src/routes/models.test.ts packages/server/src/services/agent-service.ts packages/server/src/app.ts
git commit -m "feat(server): GET /api/models catalog proxy with Redis cache + enrichment"
```

---

## Task 8: ProviderFactory (per-user LLM/image/video)

**Files:**
- Create: `packages/server/src/models/provider-factory.ts`
- Test: `packages/server/src/models/provider-factory.test.ts`

**Interfaces:**
- Consumes: `resolveProvider` (Task 6), `OpenAIProvider` (core), `makeImageProvider`/`makeVideoProvider` (`generation/config.ts`), `MediaGenerationConfig`.
- Produces:
  - `interface ProviderFactoryDeps { catalog: ModelCatalogConfig; llmBaseUrl: string; imageBase: MediaGenerationConfig; videoBase: MediaGenerationConfig }`
  - `class ProviderFactory { constructor(deps); llm(modelId: string, apiKey: string): LLMProvider; image(modelId: string, apiKey: string): ImageGenerationProvider; video(modelId: string, apiKey: string): VideoGenerationProvider }`
  - `image`/`video` override `apiKey`, `model`, `mock:false`, and `adapter` (from `resolveProvider`) onto the base `MediaGenerationConfig`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/models/provider-factory.test.ts
import { describe, it, expect } from "vitest";
import { OpenAIProvider, ChatCompletionsImageProvider, HttpVideoGenerationProvider } from "@lot-agent/core";
import { ProviderFactory } from "./provider-factory.js";
import type { ModelCatalogConfig } from "./catalog.js";
import type { MediaGenerationConfig } from "../generation/config.js";

const catalog: ModelCatalogConfig = {
  defaultProvider: { llm: "openai", image: "chat-completions", video: "happyhorse" },
  providerMap: { "veo3.1": "happyhorse", "gpt-image-2-token": "chat-completions" },
  pricing: {}, defaultPricing: {
    llm: { inputPrice: 0, outputPrice: 0, unitPrice: 0 },
    image: { inputPrice: 0, outputPrice: 0, unitPrice: 0 },
    video: { inputPrice: 0, outputPrice: 0, unitPrice: 0 },
  },
};
const media = (): MediaGenerationConfig => ({
  baseUrl: "https://h/v1", apiKey: "", mock: true, adapter: "happyhorse", model: "", modelId: "",
});

const f = new ProviderFactory({
  catalog, llmBaseUrl: "https://h/v1", imageBase: media(), videoBase: media(),
});

describe("ProviderFactory", () => {
  it("llm → OpenAIProvider", () => {
    expect(f.llm("gpt-5.4", "sk-u")).toBeInstanceOf(OpenAIProvider);
  });
  it("image → ChatCompletionsImageProvider when adapter resolves to chat-completions", () => {
    expect(f.image("gpt-image-2-token", "sk-u")).toBeInstanceOf(ChatCompletionsImageProvider);
  });
  it("video → HttpVideoGenerationProvider (happyhorse) with real key", () => {
    expect(f.video("veo3.1", "sk-u")).toBeInstanceOf(HttpVideoGenerationProvider);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/server -- provider-factory.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/server/src/models/provider-factory.ts
import { OpenAIProvider, type LLMProvider, type ImageGenerationProvider, type VideoGenerationProvider } from "@lot-agent/core";
import { makeImageProvider, makeVideoProvider, type MediaGenerationConfig } from "../generation/config.js";
import { resolveProvider, type ModelCatalogConfig } from "./catalog.js";

export interface ProviderFactoryDeps {
  catalog: ModelCatalogConfig;
  llmBaseUrl: string;
  imageBase: MediaGenerationConfig;
  videoBase: MediaGenerationConfig;
}

/** Builds a provider bound to a specific user's api_key + selected model, per
 * request. Model calls are billed to the caller's tokenhub key, so providers
 * cannot be shared startup singletons. Construction is cheap (config only). */
export class ProviderFactory {
  constructor(private readonly deps: ProviderFactoryDeps) {}

  llm(modelId: string, apiKey: string): LLMProvider {
    return new OpenAIProvider({ apiKey, baseUrl: this.deps.llmBaseUrl, model: modelId });
  }

  image(modelId: string, apiKey: string): ImageGenerationProvider {
    const adapter = resolveProvider(this.deps.catalog, modelId, "image");
    return makeImageProvider({ ...this.deps.imageBase, apiKey, model: modelId, mock: false, adapter });
  }

  video(modelId: string, apiKey: string): VideoGenerationProvider {
    const adapter = resolveProvider(this.deps.catalog, modelId, "video");
    return makeVideoProvider({ ...this.deps.videoBase, apiKey, model: modelId, mock: false, adapter });
  }
}
```

Note: confirm `LLMProvider`, `ImageGenerationProvider`, `VideoGenerationProvider`, `OpenAIProvider`, `ChatCompletionsImageProvider`, `HttpVideoGenerationProvider` are exported from `@lot-agent/core` (they are used elsewhere in server). If a type isn't exported, import it from its concrete path as done in existing server files.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/server -- provider-factory.test`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/models/provider-factory.ts packages/server/src/models/provider-factory.test.ts
git commit -m "feat(server): ProviderFactory builds per-user LLM/image/video providers"
```

---

## Task 9: Wire chat path — conversation model_id + per-user LLM

**Files:**
- Modify: `packages/server/src/db/database.ts` (conversations `model_id` migration + `setConversationModel`; `StoredConversation` type)
- Modify: `packages/server/src/services/agent-service.ts` (build `ProviderFactory`; use it in `streamAgentResponse`; accept `modelId`)
- Modify: `packages/server/src/routes/conversations.ts` (accept `modelId` in message body; return `model_id`)
- Test: `packages/server/src/services/agent-service.model.test.ts`

**Interfaces:**
- Consumes: `ProviderFactory` (Task 8), `getUserApiKey` (Task 3).
- Produces:
  - `Database.setConversationModel(id: string, modelId: string): Promise<void>`
  - `streamAgentResponse(..., opts?: { modelId?: string })` — resolves model = `modelId ?? conversation.model_id ?? def.defaultModelId`; builds LLM via `ProviderFactory` using the user's api_key (falls back to existing shared provider when no api_key, so local/dev without tokenhub still runs).
  - Message endpoint accepts `{ content, attachments?, modelId? }`; conversation GET returns `model_id`.

- [ ] **Step 1: Add conversations.model_id migration + setter**

In `database.ts` `migrate()`, near the other conversation ALTERs (~line 470):

```ts
await client.query(`
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS model_id VARCHAR(100);
`);
```

Add to the `StoredConversation` interface a `model_id?: string | null;` field, and a method near other conversation methods:

```ts
async setConversationModel(id: string, modelId: string): Promise<void> {
  await this.pool.query("UPDATE conversations SET model_id = $2 WHERE id = $1", [id, modelId]);
}
```

- [ ] **Step 2: Build the ProviderFactory in AgentService**

In `agent-service.ts`, add field `readonly providerFactory: ProviderFactory;` and init after generation config + modelCatalog are available:

```ts
import { ProviderFactory } from "../models/provider-factory.js";
// after loading genConfig (image/video MediaGenerationConfig) + modelCatalog:
this.providerFactory = new ProviderFactory({
  catalog: this.modelCatalog,
  llmBaseUrl: this.llmConfig.openai.baseUrl ?? this.tokenhubBaseUrl,
  imageBase: this.generationConfig.image,
  videoBase: this.generationConfig.video,
});
```

(If `generationConfig` isn't already a field, capture the value from `loadGenerationConfig` where the worker/service loads it. Verify the field name used in this file; reuse whatever holds image/video `MediaGenerationConfig`.)

- [ ] **Step 3: Write the failing model-selection test**

```ts
// packages/server/src/services/agent-service.model.test.ts
import { describe, it, expect } from "vitest";
import { resolveConversationModel } from "./agent-service.js";

describe("resolveConversationModel", () => {
  it("prefers explicit modelId, then conversation.model_id, then agent default", () => {
    expect(resolveConversationModel("m-explicit", "m-conv", "m-default")).toBe("m-explicit");
    expect(resolveConversationModel(undefined, "m-conv", "m-default")).toBe("m-conv");
    expect(resolveConversationModel(undefined, null, "m-default")).toBe("m-default");
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -w @lot-agent/server -- agent-service.model.test`
Expected: FAIL — `resolveConversationModel` not exported.

- [ ] **Step 5: Implement resolver + use it in streamAgentResponse**

Add an exported pure helper near the top of `agent-service.ts`:

```ts
export function resolveConversationModel(
  explicit: string | undefined,
  conversationModelId: string | null | undefined,
  agentDefault: string
): string {
  return explicit ?? conversationModelId ?? agentDefault;
}
```

Change the `streamAgentResponse` signature to accept an options object (append param) and replace the LLM resolution (line 346). Load the conversation + user key and build via factory, keeping a safe fallback:

```ts
// signature: add trailing param
opts?: { modelId?: string }
// ...
const conversation = await this.db.getConversation(conversationId);
if (opts?.modelId) await this.db.setConversationModel(conversationId, opts.modelId);
const modelId = resolveConversationModel(opts?.modelId, conversation?.model_id, def.defaultModelId);
const apiKey = userId ? await this.db.getUserApiKey(userId) : null;
const llm = apiKey
  ? this.providerFactory.llm(modelId, apiKey)
  : (this.modelRegistry.getProvider<LLMProvider>(def.defaultModelId) ?? this.getLLMProvider());
```

- [ ] **Step 6: Thread modelId through the message route**

In `routes/conversations.ts`, extend the body type and pass it through:

```ts
const body = await c.req.json<{ content: string; attachments?: AttachmentRef[]; modelId?: string }>();
// ...
for await (const event of service.streamAgentResponse(
  id, body.content ?? "", conversation.agent_id, userId, attachments, c.req.raw.signal,
  { modelId: body.modelId }
)) {
```

The conversation GET (line 97) already spreads `...conversation`, so `model_id` is returned automatically once the column exists.

- [ ] **Step 7: Run tests + build**

Run: `npm test -w @lot-agent/server -- agent-service.model.test` — Expected: PASS.
Run: `npm run build -w @lot-agent/server` — Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/db/database.ts packages/server/src/services/agent-service.ts packages/server/src/services/agent-service.model.test.ts packages/server/src/routes/conversations.ts
git commit -m "feat(server): per-conversation model_id + per-user LLM in chat path"
```

---

## Task 10: Wire async gen path — per-user image/video providers in worker

**Files:**
- Modify: `packages/server/src/routes/tasks.ts` (store selected `modelId` in task input; quota uses catalog pricing)
- Modify: `packages/server/src/workers/index.ts` (build provider per-job with the owning user's api_key + task model)
- Modify: `packages/server/src/routes/conversations.ts` (generation route ~line 264: use selected model instead of hardcoded ids)
- Test: `packages/server/src/workers/gen-provider.test.ts`

**Interfaces:**
- Consumes: `ProviderFactory` (Task 8), `Database.getUserApiKey` (Task 3), `resolvePricing` (Task 6).
- Produces: `function pickGenModel(mediaType: "image" | "video", input: Record<string, unknown>, fallback: string): string` — reads `input.modelId` else fallback. Worker builds `providerFactory.image|video(model, userApiKey)` per job.

- [ ] **Step 1: Write the failing helper test**

```ts
// packages/server/src/workers/gen-provider.test.ts
import { describe, it, expect } from "vitest";
import { pickGenModel } from "./gen-provider.js";

describe("pickGenModel", () => {
  it("uses input.modelId when present", () => {
    expect(pickGenModel("image", { modelId: "gpt-image-2" }, "fallback")).toBe("gpt-image-2");
  });
  it("falls back when absent", () => {
    expect(pickGenModel("video", {}, "happyhorse-1.0-t2v")).toBe("happyhorse-1.0-t2v");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/server -- gen-provider.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

```ts
// packages/server/src/workers/gen-provider.ts
/** The task's selected model id (persisted in the job input by the tasks route),
 * falling back to the media type's configured default. */
export function pickGenModel(
  _mediaType: "image" | "video",
  input: Record<string, unknown>,
  fallback: string
): string {
  const m = input.modelId;
  return typeof m === "string" && m.length > 0 ? m : fallback;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/server -- gen-provider.test`
Expected: PASS (2 tests).

- [ ] **Step 5: Persist modelId at enqueue + quota via catalog**

In `routes/tasks.ts`, include the client-selected `modelId` (validated to be a string) in the enqueued input, and compute quota from catalog pricing:

```ts
const body = await c.req.json<{ /* existing */ modelId?: string }>();
// build the input object that gets enqueued — add:
//   modelId: typeof body.modelId === "string" ? body.modelId : undefined,
// quota: resolve unit price from modelCatalog instead of hardcoded ids
import { resolvePricing } from "../models/catalog.js";
const type = mediaType === "image" ? "image" : "video";
const modelForQuota = typeof body.modelId === "string" ? body.modelId : "";
const unit = resolvePricing(service.modelCatalog, modelForQuota, type).unitPrice;
estimatedCost = type === "image" ? unit * 1 : unit * durationSec;
```

(Keep the existing enqueue call; just add `modelId` to its `input` payload.)

- [ ] **Step 6: Build per-job providers in the worker**

In `workers/index.ts`, replace the startup-singleton `imageProvider`/`videoProvider` (lines 62-63) usage inside the job handlers with per-job construction. Add a `ProviderFactory` and load the user's key:

```ts
import { ProviderFactory } from "../models/provider-factory.js";
import { pickGenModel } from "./gen-provider.js";
// after genConfig + modelCatalog loaded:
const providerFactory = new ProviderFactory({
  catalog: modelCatalog,
  llmBaseUrl: genConfig.image.baseUrl,
  imageBase: genConfig.image,
  videoBase: genConfig.video,
});

// in each job handler, replace the fixed provider with:
const apiKey = (await db.getUserApiKey(job.userId)) ?? "";
const model = pickGenModel("image", job.input as Record<string, unknown>, genConfig.image.modelId);
const provider = apiKey ? providerFactory.image(model, apiKey) : imageProvider; // mock fallback
```

Do the same for video with `providerFactory.video`. Load `modelCatalog` in the worker from `config/default.json` alongside the existing `models` read (lines 52-56):

```ts
const modelCatalog = (rawConfig as { modelCatalog?: import("../models/catalog.js").ModelCatalogConfig }).modelCatalog!;
```

Also update the meter's pricing source to fall back to catalog (Task 11 covers the shared resolver — for the worker, wrap the existing `modelMap.get(id)` with catalog fallback):

```ts
import { resolvePricing } from "../models/catalog.js";
const meter = new UsageMeter(db, (id) => modelMap.get(id) ?? {
  id, type: "image", provider: "", billingUnit: "image",
  ...resolvePricing(modelCatalog, id, "image"), enabled: true,
});
```

(Refine the `type` per media in the actual call site if the meter is invoked per media type; otherwise a generic fallback price is acceptable per the spec's default-pricing rule.)

- [ ] **Step 7: Use selected model in the chat generation route**

In `routes/conversations.ts` (~line 264), replace the hardcoded `modelId` selection with the conversation's `model_id` when present:

```ts
const modelId = conv?.model_id
  ?? (mediaType === "image" ? "gpt-image-2-token" : "happyhorse-1.0-t2v");
const unit = resolvePricing(service.modelCatalog, modelId, mediaType === "image" ? "image" : "video").unitPrice;
```

Ensure the enqueued job input carries `modelId` so the worker's `pickGenModel` sees it.

- [ ] **Step 8: Run tests + build**

Run: `npm test -w @lot-agent/server` — Expected: all PASS.
Run: `npm run build -w @lot-agent/server` — Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/routes/tasks.ts packages/server/src/workers/ packages/server/src/routes/conversations.ts
git commit -m "feat(server): per-user image/video providers + selected model in async gen"
```

---

## Task 11: UsageMeter pricing fallback to catalog

**Files:**
- Modify: `packages/server/src/services/agent-service.ts` (UsageMeter pricing lookup ~line 211)
- Test: `packages/server/src/billing/meter-fallback.test.ts`

**Interfaces:**
- Consumes: `resolvePricing` (Task 6), `service.modelCatalog`.
- Produces: a pricing resolver passed to `UsageMeter` that returns a `ModelConfig`-shaped object for dynamically-discovered llm models (falls back to `defaultPricing.llm`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/billing/meter-fallback.test.ts
import { describe, it, expect } from "vitest";
import { catalogModelConfig } from "../services/agent-service.js";
import type { ModelCatalogConfig } from "../models/catalog.js";

const cfg: ModelCatalogConfig = {
  defaultProvider: { llm: "openai", image: "chat-completions", video: "happyhorse" },
  providerMap: {}, pricing: {},
  defaultPricing: {
    llm: { inputPrice: 0.001, outputPrice: 0.002, unitPrice: 0 },
    image: { inputPrice: 0, outputPrice: 0, unitPrice: 0.04 },
    video: { inputPrice: 0, outputPrice: 0, unitPrice: 0.5 },
  },
};

describe("catalogModelConfig", () => {
  it("builds a ModelConfig for an unknown llm id using default pricing", () => {
    const mc = catalogModelConfig(cfg, "brand-new-llm", "llm");
    expect(mc).toMatchObject({ id: "brand-new-llm", type: "llm", inputPrice: 0.001, outputPrice: 0.002 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/server -- meter-fallback.test`
Expected: FAIL — `catalogModelConfig` not exported.

- [ ] **Step 3: Implement + wire**

Add to `agent-service.ts`:

```ts
import { resolvePricing, type ModelCatalogConfig } from "../models/catalog.js";
import type { ModelConfig, ModelType } from "@lot-agent/core";

export function catalogModelConfig(
  cfg: ModelCatalogConfig,
  id: string,
  type: ModelType
): ModelConfig {
  const p = resolvePricing(cfg, id, type);
  const billingUnit = type === "llm" ? "token" : type === "video" ? "second" : "image";
  return { id, type, provider: "", billingUnit, ...p, enabled: true };
}
```

Change the UsageMeter construction (line 211) to fall back to the catalog:

```ts
this.usageMeter = new UsageMeter(this.db, (id) =>
  this.modelRegistry.getConfig(id) ?? catalogModelConfig(this.modelCatalog, id, "llm")
);
```

- [ ] **Step 4: Run test + build**

Run: `npm test -w @lot-agent/server -- meter-fallback.test` — Expected: PASS.
Run: `npm run build -w @lot-agent/server` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/agent-service.ts packages/server/src/billing/meter-fallback.test.ts
git commit -m "feat(server): meter falls back to catalog pricing for dynamic models"
```

---

## Task 12: Web ModelPicker component + filter

**Files:**
- Create: `packages/web/src/components/ModelPicker.tsx`
- Create: `packages/web/src/lib/model-filter.ts`
- Test: `packages/web/src/lib/model-filter.test.ts`
- Modify: `packages/web/src/App.css` (reuse `media-*` popover tokens; add `.model-*` rules using `var(--*)` only)

**Interfaces:**
- Produces:
  - `interface CatalogModel { id: string; type: "llm" | "image" | "video"; provider: string; label?: string; description?: string }`
  - `function filterModels(models: CatalogModel[], query: string): CatalogModel[]` — case-insensitive substring over `id` (and `label` if present).
  - `function ModelPicker({ models, value, onChange, disabled }: { models: CatalogModel[]; value: string | null; onChange: (id: string) => void; disabled?: boolean }): JSX.Element`

- [ ] **Step 1: Write the failing filter test**

```ts
// packages/web/src/lib/model-filter.test.ts
import { describe, it, expect } from "vitest";
import { filterModels } from "./model-filter.js";

const models = [
  { id: "gpt-5.4", type: "llm" as const, provider: "openai" },
  { id: "deepseek-v4-pro", type: "llm" as const, provider: "openai" },
  { id: "GLM-5.2", type: "llm" as const, provider: "openai" },
];

describe("filterModels", () => {
  it("returns all when query empty", () => {
    expect(filterModels(models, "")).toHaveLength(3);
  });
  it("matches case-insensitive substring on id", () => {
    expect(filterModels(models, "deep").map((m) => m.id)).toEqual(["deepseek-v4-pro"]);
    expect(filterModels(models, "glm").map((m) => m.id)).toEqual(["GLM-5.2"]);
    expect(filterModels(models, "5").map((m) => m.id)).toEqual(["gpt-5.4", "GLM-5.2"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/web -- model-filter.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the filter**

```ts
// packages/web/src/lib/model-filter.ts
export interface CatalogModel {
  id: string;
  type: "llm" | "image" | "video";
  provider: string;
  label?: string;
  description?: string;
}

/** Case-insensitive substring quick-filter over model id (and label if given). */
export function filterModels(models: CatalogModel[], query: string): CatalogModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter(
    (m) => m.id.toLowerCase().includes(q) || (m.label?.toLowerCase().includes(q) ?? false)
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/web -- model-filter.test`
Expected: PASS (2 tests).

- [ ] **Step 5: Implement the ModelPicker component**

```tsx
// packages/web/src/components/ModelPicker.tsx
import { useState, useRef, useEffect } from "react";
import { filterModels, type CatalogModel } from "../lib/model-filter.js";

/** Bottom-right model selector with a letter quick-filter. Popover styling reuses
 * the media-picker tokens; all colors via var(--*). */
export function ModelPicker({
  models,
  value,
  onChange,
  disabled,
}: {
  models: CatalogModel[];
  value: string | null;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = value ?? models[0]?.id ?? "选择模型";
  const filtered = filterModels(models, query);

  return (
    <div className="media-picker model-picker" ref={wrapRef}>
      <button
        type="button"
        className="media-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open}
        title="选择模型"
      >
        <span className="media-trigger-label">{current}</span>
        <svg className="media-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="media-popup model-popup">
          <input
            className="model-search"
            autoFocus
            placeholder="输入字母快速筛选…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="model-list">
            {filtered.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`model-row ${m.id === value ? "active" : ""}`}
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
              >
                <span className="model-row-name">{m.label ?? m.id}</span>
                {m.description && <span className="model-row-desc">{m.description}</span>}
              </button>
            ))}
            {filtered.length === 0 && <div className="model-empty">无匹配模型</div>}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Add CSS (var(--*) only)**

Append to `packages/web/src/App.css`:

```css
.model-popup { min-width: 260px; max-width: 320px; }
.model-search {
  width: 100%; box-sizing: border-box; margin-bottom: 8px; padding: 6px 10px;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--overlay-sink); color: var(--text); font-size: 13px;
}
.model-list { max-height: 280px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.model-row {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  padding: 8px 10px; border-radius: 8px; background: transparent; border: none;
  cursor: pointer; text-align: left; color: var(--text);
}
.model-row:hover { background: var(--overlay-raise); }
.model-row.active { background: var(--overlay-raise); }
.model-row-name { font-size: 13px; font-weight: 500; }
.model-row-desc { font-size: 12px; color: var(--text-muted); }
.model-empty { padding: 12px; color: var(--text-muted); font-size: 13px; text-align: center; }
```

If `--text-muted` isn't a defined token, use `--text-secondary` (grep `App.css` for the muted-text token name and use whichever exists).

- [ ] **Step 7: Build**

Run: `npm run build -w @lot-agent/web`
Expected: no type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/components/ModelPicker.tsx packages/web/src/lib/model-filter.ts packages/web/src/lib/model-filter.test.ts packages/web/src/App.css
git commit -m "feat(web): ModelPicker with letter quick-filter"
```

---

## Task 13: Wire ModelPicker into InputBox + fetch catalog + persist selection

**Files:**
- Modify: `packages/web/src/api/client.ts` (add `listModels`)
- Modify: `packages/web/src/hooks/useAgents.ts` or create `packages/web/src/hooks/useModels.ts` (fetch catalog on login/agent entry)
- Modify: `packages/web/src/components/InputBox.tsx` (mount `ModelPicker` bottom-right; hold selected model; pass to send)
- Modify: `packages/web/src/hooks/useChat.ts` (include `modelId` in send payload)

**Interfaces:**
- Consumes: `GET /api/models` → `{ llm, image, video }` of `CatalogModel[]`; `ModelPicker` (Task 12).
- Produces:
  - `api.listModels(): Promise<{ llm: CatalogModel[]; image: CatalogModel[]; video: CatalogModel[] }>`
  - `useModels(): { models: { llm; image; video }; loading: boolean; reload: () => void }`
  - Send path carries `modelId` to `POST /conversations/:id/messages`.

- [ ] **Step 1: Add api.listModels**

In `packages/web/src/api/client.ts`, import/define `CatalogModel` (re-export from `../lib/model-filter.js`) and add:

```ts
import type { CatalogModel } from "../lib/model-filter.js";

listModels: () =>
  request<{ llm: CatalogModel[]; image: CatalogModel[]; video: CatalogModel[] }>("/models"),
```

- [ ] **Step 2: Add useModels hook**

```ts
// packages/web/src/hooks/useModels.ts
import { useState, useEffect, useCallback } from "react";
import { api } from "../api/client.js";
import type { CatalogModel } from "../lib/model-filter.js";

type Catalog = { llm: CatalogModel[]; image: CatalogModel[]; video: CatalogModel[] };
const EMPTY: Catalog = { llm: [], image: [], video: [] };

/** Fetch the caller's available models once on mount (server caches ~5min). */
export function useModels() {
  const [models, setModels] = useState<Catalog>(EMPTY);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    api.listModels().then(setModels).catch(() => setModels(EMPTY)).finally(() => setLoading(false));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { models, loading, reload };
}
```

- [ ] **Step 3: Mount ModelPicker in InputBox**

In `InputBox.tsx`: import `ModelPicker` + `useModels`, pick the type-appropriate list from `mode` (`image`→image, `video`→video, else `llm`), and render the picker in the controls row next to the media pickers (alongside lines 223-227). Add props `selectedModel: string | null` and `onModelChange: (id: string) => void` to `InputBox` (lift state to the parent that owns the conversation), OR hold it in a module-scope var mirroring `lastImageRatioLabel` if the conversation-level owner is not readily available. Prefer lifting to the chat page so it can seed from `conversation.model_id`.

```tsx
import { ModelPicker } from "./ModelPicker.js";
// choose list:
const modelList = mode === "image" ? models.image : mode === "video" ? models.video : models.llm;
// in the controls row:
<ModelPicker
  models={modelList}
  value={selectedModel}
  onChange={onModelChange}
  disabled={disabled}
/>
```

- [ ] **Step 4: Thread modelId through send**

In `useChat.ts`, find where the message POST body is built and add `modelId`:

```ts
body: JSON.stringify({ content, attachments, modelId: selectedModel ?? undefined }),
```

Seed `selectedModel` from the loaded conversation's `model_id` when a conversation opens (the conversation GET now returns `model_id`).

- [ ] **Step 5: Build + typecheck**

Run: `npm run build -w @lot-agent/web`
Expected: no type errors.

- [ ] **Step 6: Manual smoke (documented, not automated)**

With server + worker + web running and a real tokenhub account: log in with 手机号/密码 → confirm chat works; open the model picker bottom-right, type letters to filter, select a model → send → confirm the new conversation persists the choice on reload (picker restores it).

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/api/client.ts packages/web/src/hooks/useModels.ts packages/web/src/components/InputBox.tsx packages/web/src/hooks/useChat.ts
git commit -m "feat(web): wire ModelPicker + catalog fetch + per-conversation model persistence"
```

---

## Self-Review

**Spec coverage:**
- §1 External auth + RSA → Tasks 1, 2, 4, 5. ✓
- §2 User table → Task 3. ✓
- §3 Dynamic catalog → Tasks 6, 7. ✓
- §4 Per-user providers + billing → Tasks 8, 9, 10, 11. ✓
- §5 Model selector UI → Tasks 12, 13. ✓
- §6 Per-conversation persistence → Tasks 9 (model_id), 13 (seed/persist). ✓
- Error handling (generic login 401, /models 502, api_key never leaked) → Tasks 1, 4, 7, and sanitizer Task 3. ✓
- Testing list → each unit has a colocated `*.test.ts`. ✓

**Placeholder scan:** No TBD/TODO. Wiring tasks (7, 9, 10, 13) include "verify the field name / grep for X" notes where the exact local identifier must be confirmed in-file; these are explicit verification steps, not deferred work — the code to write is shown.

**Type consistency:** `CatalogModel`/`Pricing`/`ModelCatalogConfig` defined in Task 6 and reused verbatim in 7, 8, 11; the web `CatalogModel` (Task 12) is the client-facing shape (adds optional `label`/`description`). `resolveConversationModel`, `pickGenModel`, `catalogModelConfig`, `toPublicUser`, `encryptPassword`, `TokenhubClient` signatures match across producing/consuming tasks.

**Known integration risks to verify during execution (not gaps):**
- AgentService constructor already parses config once — reuse that object for `modelCatalog` rather than re-reading the file.
- Confirm `authMw` covers `/api/models` when mounting (Task 7 Step 5).
- Confirm the field name holding image/video `MediaGenerationConfig` on AgentService (Task 9 Step 2) — reuse it, don't reload.
