# API-Key name/group Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thread the `name`/`group` fields tokenhub now attaches to each api key through the server (login parsing → Postgres storage → sanitized API response) and into the web Key Settings modal.

**Architecture:** Introduce one shared type/normalizer (`RawApiKeyEntry` + `normalizeApiKeyEntries`) in a new `packages/server/src/tokenhub/api-key-entry.ts` module. It absorbs both wire shapes tokenhub might send (bare string, or `{api_key, name, group}`) and the shape already sitting in Postgres from before this change (bare string arrays). Every layer that currently treats an api key as a plain `string` switches to this object shape; `toPublicUser` is still the only place a masked key ever leaves the server, now alongside `name`/`group`.

**Tech Stack:** TypeScript, Vitest, Hono, `pg`. No new dependencies.

## Global Constraints

- ESM imports use explicit `.js` suffixes.
- 2-space indent.
- Never send the raw (unmasked) api key to the client — `toPublicUser` is the sole choke point.
- No secrets in git; no new env vars needed for this change.
- Web colors: only `var(--*)` tokens, never hardcoded hex/rgba.
- No new migration needed — `users.api_keys` stays a JSONB column; only the shape of its array elements changes going forward. Existing rows (plain `string[]`) are read via the same normalizer and are overwritten with the new object shape the next time that user logs in.
- Web has no component-render test setup (`vitest.config.ts` only includes `packages/**/*.test.ts`, no jsdom/RTL installed) — UI changes are verified manually via the dev server, consistent with every other component in this repo.

---

### Task 1: Shared `RawApiKeyEntry` type + normalizer

**Files:**
- Create: `packages/server/src/tokenhub/api-key-entry.ts`
- Test: `packages/server/src/tokenhub/api-key-entry.test.ts`

**Interfaces:**
- Produces: `interface RawApiKeyEntry { apiKey: string; name?: string; group?: string }` and `function normalizeApiKeyEntries(raw: unknown): RawApiKeyEntry[]`. Later tasks import both from `./api-key-entry.js` (or `../tokenhub/api-key-entry.js` from `db/`).

`normalizeApiKeyEntries` must accept, per array element:
- a bare `string` → `{ apiKey: string }`
- an object with either `api_key` (tokenhub wire field) or `apiKey` (our own persisted field) → `{ apiKey, name?, group? }`, dropping `name`/`group` when they're empty strings or missing
- anything else (no string key found) → the element is skipped, not thrown

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/tokenhub/api-key-entry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalizeApiKeyEntries } from "./api-key-entry.js";

describe("normalizeApiKeyEntries", () => {
  it("wraps bare strings", () => {
    expect(normalizeApiKeyEntries(["sk-A", "sk-B"])).toEqual([
      { apiKey: "sk-A" },
      { apiKey: "sk-B" },
    ]);
  });

  it("maps tokenhub wire objects (api_key snake_case) with name/group", () => {
    expect(
      normalizeApiKeyEntries([
        { api_key: "sk-A", name: "开放API密钥", group: "" },
        { api_key: "sk-B", name: "test", group: "agent2_demo" },
      ])
    ).toEqual([
      { apiKey: "sk-A", name: "开放API密钥" },
      { apiKey: "sk-B", name: "test", group: "agent2_demo" },
    ]);
  });

  it("maps our own persisted objects (apiKey camelCase)", () => {
    expect(normalizeApiKeyEntries([{ apiKey: "sk-A", name: "n", group: "g" }])).toEqual([
      { apiKey: "sk-A", name: "n", group: "g" },
    ]);
  });

  it("omits name/group when empty or absent", () => {
    expect(normalizeApiKeyEntries([{ api_key: "sk-A" }])).toEqual([{ apiKey: "sk-A" }]);
    expect(normalizeApiKeyEntries([{ api_key: "sk-A", name: "", group: "" }])).toEqual([
      { apiKey: "sk-A" },
    ]);
  });

  it("drops entries with no usable key string instead of throwing", () => {
    expect(normalizeApiKeyEntries([{ name: "orphan" }, "sk-OK", 42, null])).toEqual([
      { apiKey: "sk-OK" },
    ]);
  });

  it("returns [] for non-array input", () => {
    expect(normalizeApiKeyEntries(null)).toEqual([]);
    expect(normalizeApiKeyEntries(undefined)).toEqual([]);
    expect(normalizeApiKeyEntries("sk-A")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/server -- api-key-entry`
Expected: FAIL — `Cannot find module './api-key-entry.js'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/tokenhub/api-key-entry.ts`:

```ts
/** One usable model-call key for a tokenhub account. `name`/`group` are
 * display-only labels tokenhub attaches to the key; both optional. */
export interface RawApiKeyEntry {
  apiKey: string;
  name?: string;
  group?: string;
}

type WireEntry = { api_key?: unknown; apiKey?: unknown; name?: unknown; group?: unknown };

/** Normalizes one element of a tokenhub `api_keys` array — or of the JSONB
 * array we've persisted ourselves in an earlier/newer shape — into
 * RawApiKeyEntry. Accepts a bare string, a wire object (`api_key` snake_case),
 * or our own persisted object (`apiKey` camelCase). Entries with no usable
 * key string are dropped rather than throwing, since one malformed entry
 * shouldn't break login or key listing. */
export function normalizeApiKeyEntries(raw: unknown): RawApiKeyEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: RawApiKeyEntry[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      out.push({ apiKey: entry });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const e = entry as WireEntry;
    const apiKey = typeof e.apiKey === "string" ? e.apiKey : typeof e.api_key === "string" ? e.api_key : null;
    if (!apiKey) continue;
    const name = typeof e.name === "string" && e.name ? e.name : undefined;
    const group = typeof e.group === "string" && e.group ? e.group : undefined;
    out.push({ apiKey, ...(name ? { name } : {}), ...(group ? { group } : {}) });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/server -- api-key-entry`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/tokenhub/api-key-entry.ts packages/server/src/tokenhub/api-key-entry.test.ts
git commit -m "feat: add RawApiKeyEntry normalizer for tokenhub api-key name/group"
```

---

### Task 2: `TokenhubClient.login` returns `RawApiKeyEntry[]`

**Files:**
- Modify: `packages/server/src/tokenhub/client.ts`
- Modify: `packages/server/src/tokenhub/client.test.ts`

**Interfaces:**
- Consumes: `normalizeApiKeyEntries`, `RawApiKeyEntry` from `./api-key-entry.js` (Task 1).
- Produces: `TokenhubLoginResult.apiKeys: RawApiKeyEntry[]` (was `string[]`). `routes/auth.ts` passes `result.apiKeys` straight into `db.upsertUserByExternalId({ apiKeys: result.apiKeys })` — Task 3 changes that method's param type to match, so this task's output type must be `RawApiKeyEntry[]` exactly.

- [ ] **Step 1: Write the failing test**

Replace the four `login` tests in `packages/server/src/tokenhub/client.test.ts` (keep the other `describe` tests — `login throws...`, `listModels...` — unchanged) with:

```ts
import { describe, it, expect, vi } from "vitest";
import { TokenhubClient } from "./client.js";

const ok = (data: unknown) =>
  ({ ok: true, json: async () => ({ data, success: true }) }) as Response;
const fail = () =>
  ({ ok: true, json: async () => ({ data: null, success: false, message: "bad" }) }) as Response;

describe("TokenhubClient", () => {
  it("login maps a successful response with only api_key", async () => {
    const f = vi.fn().mockResolvedValue(
      ok({ user_id: 2, name: "13881071870", api_key: "sk-X", access_token: "sk-X" })
    );
    const c = new TokenhubClient("https://h/api/agent-market", f as unknown as typeof fetch);
    await expect(c.login("13881071870", "pw")).resolves.toEqual({
      userId: 2,
      name: "13881071870",
      apiKeys: [{ apiKey: "sk-X" }],
    });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://h/api/agent-market/auth/login");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      username: "13881071870",
      password: "pw",
    });
  });

  it("login maps bare-string api_keys array (legacy tokenhub shape)", async () => {
    const f = vi.fn().mockResolvedValue(
      ok({ user_id: 2, name: "138", api_key: "sk-A", api_keys: ["sk-A", "sk-B"], access_token: "sk-A" })
    );
    const c = new TokenhubClient("https://h/api/agent-market", f as unknown as typeof fetch);
    await expect(c.login("138", "pw")).resolves.toEqual({
      userId: 2, name: "138", apiKeys: [{ apiKey: "sk-A" }, { apiKey: "sk-B" }],
    });
  });

  it("login maps api_keys objects with name/group", async () => {
    const f = vi.fn().mockResolvedValue(
      ok({
        user_id: 2,
        name: "138",
        api_key: "sk-A",
        api_keys: [
          { api_key: "sk-A", name: "开放API密钥", group: "" },
          { api_key: "sk-B", name: "test", group: "agent2_demo" },
        ],
        access_token: "sk-A",
      })
    );
    const c = new TokenhubClient("https://h/api/agent-market", f as unknown as typeof fetch);
    await expect(c.login("138", "pw")).resolves.toEqual({
      userId: 2,
      name: "138",
      apiKeys: [
        { apiKey: "sk-A", name: "开放API密钥" },
        { apiKey: "sk-B", name: "test", group: "agent2_demo" },
      ],
    });
  });

  it("login falls back to [{apiKey}] when api_keys absent", async () => {
    const f = vi.fn().mockResolvedValue(ok({ user_id: 2, name: "138", api_key: "sk-A" }));
    const c = new TokenhubClient("https://h/api/agent-market", f as unknown as typeof fetch);
    await expect(c.login("138", "pw")).resolves.toEqual({
      userId: 2, name: "138", apiKeys: [{ apiKey: "sk-A" }],
    });
  });

  it("login yields [] when neither api_keys nor api_key present", async () => {
    const f = vi.fn().mockResolvedValue(ok({ user_id: 2, name: "138" }));
    const c = new TokenhubClient("https://h/api/agent-market", f as unknown as typeof fetch);
    await expect(c.login("138", "pw")).resolves.toEqual({ userId: 2, name: "138", apiKeys: [] });
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

Run: `npm test -w @lot-agent/server -- tokenhub/client`
Expected: FAIL — `login maps a successful response with only api_key` and others fail because `apiKeys` is still `["sk-X"]` not `[{ apiKey: "sk-X" }]`.

- [ ] **Step 3: Write minimal implementation**

In `packages/server/src/tokenhub/client.ts`, replace the top of the file and `login()`:

```ts
import { normalizeApiKeyEntries, type RawApiKeyEntry } from "./api-key-entry.js";

export interface TokenhubLoginResult {
  userId: number;
  name: string;
  apiKeys: RawApiKeyEntry[];
}
```

and:

```ts
  async login(username: string, password: string): Promise<TokenhubLoginResult> {
    const data = await this.post<{
      user_id: number;
      name: string;
      api_key?: string;
      api_keys?: unknown[];
    }>("/auth/login", { username, password }, "tokenhub_login_failed");
    const apiKeys = normalizeApiKeyEntries(data.api_keys ?? (data.api_key ? [data.api_key] : []));
    return { userId: data.user_id, name: data.name, apiKeys };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/server -- tokenhub/client`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/tokenhub/client.ts packages/server/src/tokenhub/client.test.ts
git commit -m "feat: TokenhubClient.login returns RawApiKeyEntry[] with name/group"
```

---

### Task 3: Postgres storage — `database.ts` uses `RawApiKeyEntry`

**Files:**
- Modify: `packages/server/src/db/database.ts:125-134` (`StoredUser`), `:1018-1062` (`upsertUserByExternalId`, `getUserApiKeys`, `setActiveApiKey`)

**Interfaces:**
- Consumes: `normalizeApiKeyEntries`, `RawApiKeyEntry` from `../tokenhub/api-key-entry.js` (Task 1).
- Produces: `upsertUserByExternalId(args: { externalUserId: number; username: string; apiKeys: RawApiKeyEntry[] })`; `getUserApiKeys(userId): Promise<RawApiKeyEntry[]>`; `setActiveApiKey(userId, index): Promise<string>` (return type unchanged — still the raw active key string). `StoredUser.api_keys?: (RawApiKeyEntry | string)[] | null` — kept as a union because rows written before this change still hold plain strings until that user's next login.

There is no existing test file exercising these three DB methods against a real Postgres instance (they're only reached indirectly, with a mocked `db`, from route tests) — Task 4 and the existing `routes/keys.test.ts` (unaffected, mocks `db.setActiveApiKey` directly) are what exercise this behavior end-to-end. This task is verified by the type check in Step 2 plus Task 4's route-level tests.

- [ ] **Step 1: Make the change**

In `packages/server/src/db/database.ts`, add the import near the top (alongside the other relative imports):

```ts
import { normalizeApiKeyEntries, type RawApiKeyEntry } from "../tokenhub/api-key-entry.js";
```

Change `StoredUser` (currently lines 125-134):

```ts
export interface StoredUser {
  id: string;
  email: string | null;
  name: string | null;
  created_at: string;
  external_user_id?: number | null;
  username?: string | null;
  api_key?: string | null;
  api_keys?: (RawApiKeyEntry | string)[] | null;
}
```

Change `upsertUserByExternalId`, `getUserApiKeys`, `setActiveApiKey` (currently lines 1018-1062):

```ts
  async upsertUserByExternalId(args: {
    externalUserId: number;
    username: string;
    apiKeys: RawApiKeyEntry[];
  }): Promise<StoredUser> {
    const active = args.apiKeys[0]?.apiKey ?? null;
    const { rows } = await this.pool.query(
      `INSERT INTO users (external_user_id, username, name, api_key, api_keys, email)
         VALUES ($1, $2, $2, $3, $4, $5)
       ON CONFLICT (external_user_id)
         DO UPDATE SET username = $2, api_key = $3, api_keys = $4
       RETURNING *`,
      [args.externalUserId, args.username, active, JSON.stringify(args.apiKeys), `${args.username}@tokenhub.local`]
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

  async getUserApiKeys(userId: string): Promise<RawApiKeyEntry[]> {
    const { rows } = await this.pool.query(
      "SELECT api_keys FROM users WHERE id = $1",
      [userId]
    );
    return normalizeApiKeyEntries(rows[0]?.api_keys);
  }

  /** Sets the single per-user active key (`users.api_key`); shared across all of that
   * account's concurrent sessions, not per-session. */
  async setActiveApiKey(userId: string, index: number): Promise<string> {
    const keys = await this.getUserApiKeys(userId);
    if (!Number.isInteger(index) || index < 0 || index >= keys.length) {
      throw new Error("index_out_of_range");
    }
    const active = keys[index].apiKey;
    await this.pool.query("UPDATE users SET api_key = $1 WHERE id = $2", [active, userId]);
    return active;
  }
```

(`getUserApiKey`, the singular scalar getter, is untouched — included above only to show it sits between the two changed methods.)

- [ ] **Step 2: Type-check the change**

Run: `npx tsc --noEmit -p packages/server 2>&1 | grep -E "database\.ts|api-key-entry\.ts|client\.ts"`
Expected: no output (the repo has pre-existing, unrelated `tsc` errors in `agent-service.title.test.ts` and `attachment-extractor.test.ts` from before this change — ignore those; this grep isolates errors in the files this plan touches).

- [ ] **Step 3: Run the full server test suite to confirm nothing else broke**

Run: `npm test -w @lot-agent/server`
Expected: `routes/keys.test.ts` still PASSes unmodified (it mocks `db.setActiveApiKey` directly, so the type change doesn't affect it). `routes/auth.test.ts` will FAIL here — that's expected, fixed in Task 4.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/db/database.ts
git commit -m "feat: store/read api-key entries as {apiKey,name,group} objects"
```

---

### Task 4: `toPublicUser` exposes `name`/`group` as `PublicApiKey[]`

**Files:**
- Modify: `packages/server/src/db/user-sanitize.ts`
- Modify: `packages/server/src/db/user-sanitize.test.ts`
- Modify: `packages/server/src/routes/auth.test.ts`

**Interfaces:**
- Consumes: `normalizeApiKeyEntries` from `../tokenhub/api-key-entry.js` (Task 1); `StoredUser` from `./database.js` (Task 3).
- Produces: `interface PublicApiKey { key: string; name: string; group?: string }`; `PublicUser.apiKeys: PublicApiKey[]` (was `string[]`). Task 6 (web) mirrors this exact shape.

- [ ] **Step 1: Write the failing test**

Replace `packages/server/src/db/user-sanitize.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { toPublicUser, maskKey } from "./user-sanitize.js";
import type { StoredUser } from "./database.js";

const base: StoredUser = {
  id: "u1", email: "e@x", name: "138", created_at: "t",
  external_user_id: 2, username: "138", api_key: null, api_keys: null,
};

describe("maskKey", () => {
  it("masks the middle of a long key", () => {
    expect(maskKey("sk-7kLcT3xuy7mcxId5X5jemZUrwKnTv15WB3unKkApNNtx5Uir")).toBe("sk-7kL***5Uir");
  });
  it("fully masks short keys", () => {
    expect(maskKey("sk-abc")).toBe("***");
  });
});

describe("toPublicUser", () => {
  it("returns masked keys + name/group + active index, never the raw key or email", () => {
    const u = {
      ...base,
      api_key: "sk-BBBBBBBBBBBBBB",
      api_keys: [
        { apiKey: "sk-AAAAAAAAAAAAAA", name: "开放API密钥", group: "" },
        { apiKey: "sk-BBBBBBBBBBBBBB", name: "test", group: "agent2_demo" },
      ],
    };
    const pub = toPublicUser(u);
    expect(pub).toEqual({
      id: "u1", name: "138", username: "138",
      apiKeys: [
        { key: "sk-AAA***AAAA", name: "开放API密钥" },
        { key: "sk-BBB***BBBB", name: "test", group: "agent2_demo" },
      ],
      activeKeyIndex: 1,
    });
    expect(JSON.stringify(pub)).not.toContain("sk-BBBBBBBBBBBBBB");
    expect(JSON.stringify(pub)).not.toContain("e@x");
  });

  it("falls back to the masked key as name when tokenhub gave no name", () => {
    const u = { ...base, api_key: "sk-AAAAAAAAAAAAAA", api_keys: [{ apiKey: "sk-AAAAAAAAAAAAAA" }] };
    expect(toPublicUser(u).apiKeys).toEqual([{ key: "sk-AAA***AAAA", name: "sk-AAA***AAAA" }]);
  });

  it("handles legacy bare-string api_keys rows the same way", () => {
    const u = { ...base, api_key: "sk-AAAAAAAAAAAAAA", api_keys: ["sk-AAAAAAAAAAAAAA"] };
    expect(toPublicUser(u).apiKeys).toEqual([{ key: "sk-AAA***AAAA", name: "sk-AAA***AAAA" }]);
  });

  it("activeKeyIndex is -1 when there is no key", () => {
    expect(toPublicUser(base)).toMatchObject({ apiKeys: [], activeKeyIndex: -1 });
  });

  it("activeKeyIndex is -1 when api_key is not in the list", () => {
    const u = { ...base, api_key: "sk-ZZZZZZZZZZZZZZ", api_keys: [{ apiKey: "sk-AAAAAAAAAAAAAA" }] };
    expect(toPublicUser(u).activeKeyIndex).toBe(-1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/server -- user-sanitize`
Expected: FAIL — `toPublicUser` still returns `apiKeys: string[]` via `keys.map(maskKey)`.

- [ ] **Step 3: Write minimal implementation**

Replace `packages/server/src/db/user-sanitize.ts`:

```ts
import type { StoredUser } from "./database.js";
import { normalizeApiKeyEntries } from "../tokenhub/api-key-entry.js";

export interface PublicApiKey {
  key: string;
  name: string;
  group?: string;
}

export interface PublicUser {
  id: string;
  name: string;
  username: string | null;
  apiKeys: PublicApiKey[];
  activeKeyIndex: number;
}

/** 中间遮罩：保留前 6、后 4，其余用 ***；过短(<=12)整体遮罩。 */
export function maskKey(key: string): string {
  return key.length <= 12 ? "***" : `${key.slice(0, 6)}***${key.slice(-4)}`;
}

/** Never send api_key/email to the client. Single choke point for user->client. */
export function toPublicUser(u: StoredUser): PublicUser {
  const keys = normalizeApiKeyEntries(u.api_keys);
  const activeKeyIndex = u.api_key ? keys.findIndex((k) => k.apiKey === u.api_key) : -1;
  return {
    id: u.id,
    name: u.name ?? u.username ?? "",
    username: u.username ?? null,
    apiKeys: keys.map((k) => ({
      key: maskKey(k.apiKey),
      name: k.name || maskKey(k.apiKey),
      ...(k.group ? { group: k.group } : {}),
    })),
    activeKeyIndex,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/server -- user-sanitize`
Expected: PASS (7 tests)

- [ ] **Step 5: Fix `routes/auth.test.ts` fixtures to match the new shape**

In `packages/server/src/routes/auth.test.ts`, update the two places `api_keys`/`apiKeys` fixtures use bare strings:

Replace this block (first `it` in `describe("auth login", ...)`):

```ts
    (svc.tokenhub.login as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 2, name: "138", apiKeys: ["sk-SECRETSECRET"],
    });
    (svc.db.upsertUserByExternalId as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "u1", email: null, name: "138", created_at: "t",
      external_user_id: 2, username: "138", api_key: "sk-SECRETSECRET", api_keys: ["sk-SECRETSECRET"],
    });
```

with:

```ts
    (svc.tokenhub.login as ReturnType<typeof vi.fn>).mockResolvedValue({
      userId: 2, name: "138", apiKeys: [{ apiKey: "sk-SECRETSECRET", name: "开放API密钥" }],
    });
    (svc.db.upsertUserByExternalId as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "u1", email: null, name: "138", created_at: "t",
      external_user_id: 2, username: "138", api_key: "sk-SECRETSECRET",
      api_keys: [{ apiKey: "sk-SECRETSECRET", name: "开放API密钥" }],
    });
```

and the matching expectation a few lines below:

```ts
    expect(json.user).toEqual({
      id: "u1", name: "138", username: "138",
      apiKeys: ["sk-SEC***CRET"], activeKeyIndex: 0,
    });
```

with:

```ts
    expect(json.user).toEqual({
      id: "u1", name: "138", username: "138",
      apiKeys: [{ key: "sk-SEC***CRET", name: "开放API密钥" }], activeKeyIndex: 0,
    });
```

The second test (`"allows login when the account has no api key"`) already uses empty arrays (`apiKeys: []`) for both the tokenhub mock and the stored-user mock, and asserts `apiKeys: []` — no change needed there.

- [ ] **Step 6: Run the full server test suite**

Run: `npm test -w @lot-agent/server`
Expected: PASS — all suites green, including `routes/auth.test.ts` and the untouched `routes/keys.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/db/user-sanitize.ts packages/server/src/db/user-sanitize.test.ts packages/server/src/routes/auth.test.ts
git commit -m "feat: expose api-key name/group via toPublicUser"
```

---

### Task 5: Web — `User.apiKeys` type becomes `PublicApiKey[]`

**Files:**
- Modify: `packages/web/src/api/client.ts:66-72`

**Interfaces:**
- Produces: `interface PublicApiKey { key: string; name: string; group?: string }`; `User.apiKeys: PublicApiKey[]`. Task 6 consumes this type in `KeySettingsModal`.

This is a type-only change (no runtime logic) mirroring Task 4's server type — there is no separate unit test for this file; it's exercised via `tsc`/`vite build` and Task 6's manual browser check.

- [ ] **Step 1: Make the change**

In `packages/web/src/api/client.ts`, replace:

```ts
export interface User {
  id: string;
  name: string;
  username: string | null;
  apiKeys: string[];
  activeKeyIndex: number;
}
```

with:

```ts
export interface PublicApiKey {
  key: string;
  name: string;
  group?: string;
}

export interface User {
  id: string;
  name: string;
  username: string | null;
  apiKeys: PublicApiKey[];
  activeKeyIndex: number;
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p packages/web`
Expected: errors in `KeySettingsModal.tsx` only (still expects `keys: string[]`) — fixed in Task 6. If any *other* file errors here, note it — it means there's an untracked `apiKeys` consumer beyond `Workspace.tsx:380` (`keys={user.apiKeys}`), which passes the array through untyped-narrowed and needs no change itself.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/api/client.ts
git commit -m "feat: type User.apiKeys as PublicApiKey[] on the web client"
```

---

### Task 6: Web — `KeySettingsModal` renders name + group badge

**Files:**
- Modify: `packages/web/src/components/KeySettingsModal.tsx`
- Modify: `packages/web/src/App.css:2716-2727`

**Interfaces:**
- Consumes: `PublicApiKey` from `../api/client.js` (Task 5).

- [ ] **Step 1: Make the component change**

Replace `packages/web/src/components/KeySettingsModal.tsx`:

```tsx
import type { PublicApiKey } from "../api/client.js";

interface KeySettingsModalProps {
  keys: PublicApiKey[];
  activeIndex: number;
  busy: boolean;
  onSelect: (index: number) => void;
  onClose: () => void;
}

/** API-Key 设置弹窗：单选一个激活 key（视觉为 checkbox 列表），选中即切换。
 *  key 已是遮罩串；组件从不接触原始 key，仅按 index 回传选择。 */
export function KeySettingsModal({ keys, activeIndex, busy, onSelect, onClose }: KeySettingsModalProps) {
  return (
    <div className="agent-center-overlay" onClick={onClose}>
      <div className="agent-center-modal key-settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="agent-center-head">
          <h2 className="agent-center-title">API-Key 设置</h2>
          <button className="agent-center-close" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        {keys.length === 0 ? (
          <p className="key-settings-empty">当前账号暂无可用 key，请前往订阅管理页面设置</p>
        ) : (
          <ul className="key-list">
            {keys.map((k, i) => (
              <li key={i}>
                <button
                  type="button"
                  className={`key-row ${i === activeIndex ? "active" : ""}`}
                  disabled={busy}
                  onClick={() => i !== activeIndex && onSelect(i)}
                >
                  <span className={`key-check ${i === activeIndex ? "checked" : ""}`} aria-hidden />
                  <span className="key-info">
                    <span className="key-label">
                      <span className="key-name">{k.name}</span>
                      {k.group && <span className="key-group-badge">{k.group}</span>}
                    </span>
                    <span className="key-mask">{k.key}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update the CSS**

In `packages/web/src/App.css`, replace:

```css
.key-settings-modal { width: min(420px, 92vw); }
.key-settings-empty { color: var(--text-muted); font-size: 14px; padding: 12px 4px; }
.key-list { list-style: none; margin: 0; padding: 4px 0; display: flex; flex-direction: column; gap: 8px; }
.key-row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 12px;
```

(keep whatever follows on that `.key-row` declaration line as-is — only the lines below are new/changed)

```css
.key-row:hover:not(:disabled) { border-color: var(--accent); }
.key-row.active { border-color: var(--accent); }
.key-row:disabled { opacity: 0.6; cursor: default; }
.key-check { width: 16px; height: 16px; border: 1.5px solid var(--border); border-radius: 4px; flex: none; }
.key-check.checked { background: var(--accent); border-color: var(--accent); }
.key-mask { font-family: ui-monospace, monospace; letter-spacing: 0.5px; }
```

with:

```css
.key-row:hover:not(:disabled) { border-color: var(--accent); }
.key-row.active { border-color: var(--accent); }
.key-row:disabled { opacity: 0.6; cursor: default; }
.key-check { width: 16px; height: 16px; border: 1.5px solid var(--border); border-radius: 4px; flex: none; }
.key-check.checked { background: var(--accent); border-color: var(--accent); }
.key-info { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; }
.key-label { display: flex; align-items: center; gap: 6px; }
.key-name { font-weight: 600; }
.key-group-badge {
  padding: 1px 6px; border-radius: 999px; font-size: 11px; line-height: 16px;
  color: var(--tag-general-fg); background: var(--tag-general-bg);
}
.key-mask { font-family: ui-monospace, monospace; letter-spacing: 0.5px; font-size: 12px; color: var(--text-muted); }
```

(the `.key-settings-modal`, `.key-settings-empty`, `.key-list` lines above stay unchanged — only shown so the edit anchor is unambiguous)

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p packages/web`
Expected: no output.

- [ ] **Step 4: Manual browser verification**

Run: `npm run dev:web` (and separately `npm run dev:server` if not already running).

- Log in (or use `DEBUG=1` per `.env.example` to skip login).
- Open the Key Settings modal (gear icon next to the username in the header).
- Confirm each key row shows: bold name on top (or the masked key itself, if tokenhub sent no name for that entry), a small pill badge next to the name for any non-empty `group`, and the masked key string below in monospace.
- Confirm clicking a row still switches the active key (existing behavior, unaffected by this change).
- Toggle light/dark theme and confirm the group badge colors adapt (it reuses `--tag-general-fg`/`--tag-general-bg`, already theme-aware).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/KeySettingsModal.tsx packages/web/src/App.css
git commit -m "feat: show api-key name and group in the Key Settings modal"
```

---

### Task 7: Final full-suite check

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS across `@lot-agent/core`, `@lot-agent/server`, `@lot-agent/web`.

- [ ] **Step 2: Filtered type-check across both touched packages**

Run: `npx tsc --noEmit -p packages/server 2>&1 | grep -E "api-key-entry|database\.ts|user-sanitize|tokenhub/client"; npx tsc --noEmit -p packages/web 2>&1 | grep -E "api/client|KeySettingsModal"`
Expected: no output from either command (pre-existing unrelated errors elsewhere in the repo are expected and out of scope for this change).

No commit for this task — it's a verification checkpoint, not a code change.
