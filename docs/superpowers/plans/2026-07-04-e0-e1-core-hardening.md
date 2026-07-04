# E0 + E1 Core Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix silently-wrong LLM billing and two real tool-safety holes (E0), then upgrade the LLM
call layer with retry, per-call params, reasoning/"thinking" events, and Anthropic prompt caching
(E1) — including the server and web wiring needed to actually see thinking output in the chat UI.

**Architecture:** All new logic lands in `packages/core` behind existing seams (`LLMProvider`,
`Tool`, `ToolRegistry`, `TraceManager`, `Agent`). Two SDK-consuming providers get their "parse raw
stream → `ChatChunk`" loops extracted into pure, directly-testable functions. Retry wraps a
provider's stream-creation step generically. Server (`agent-service.ts` and three small
collaborators) and web (`useChat.ts`, `MessageBubble.tsx`) get the minimal plumbing to surface the
new `thinking` event end-to-end.

**Tech Stack:** TypeScript (ESM), Vitest, `@anthropic-ai/sdk`, `openai` SDK, Hono (server), React 19
(web).

## Global Constraints

- ESM imports use explicit `.js` suffixes (e.g. `from "./registry.js"`), 2-space indent.
- TDD with Vitest for new pure/logic units; tests colocated as `*.test.ts`.
- Interface-in-core, impl-in-server when an abstraction needs DB/Redis.
- No secrets in git; no new dependencies unless explicitly called for (this plan adds none beyond
  the `@anthropic-ai/sdk` version bump).
- `packages/web` has no component/hook test harness in this codebase today — web tasks are verified
  by running the dev server and exercising the feature in a browser, not by new automated tests.
- Every "Run tests" step means `npm test -w @lot-agent/core` or `npm test -w @lot-agent/server`
  (root `npm test` runs the whole monorepo via a single `vitest run` — either works, but scoping to
  the touched workspace is faster during iteration).

---

### Task 1: Bump `@anthropic-ai/sdk` to `^0.110.0`

**Files:**
- Modify: `packages/core/package.json`

**Interfaces:**
- Produces: nothing new — this only changes the dependency version. Downstream tasks (15–17) rely
  on `cache_control` (main `messages` resource) and `ThinkingDelta`/`thinking_delta` existing in the
  SDK's types, which only 0.110.0 has.

- [ ] **Step 1: Bump the version**

In `packages/core/package.json`, change:
```json
    "@anthropic-ai/sdk": "^0.30.0",
```
to:
```json
    "@anthropic-ai/sdk": "^0.110.0",
```

- [ ] **Step 2: Reinstall**

Run: `npm install` (repo root)
Expected: lockfile updates `@anthropic-ai/sdk` to `0.110.x`; no install errors.

- [ ] **Step 3: Verify the existing code still builds and tests pass**

Run: `npm run build -w @lot-agent/core`
Expected: PASS (no type errors — the streaming event discriminants
`content_block_start`/`content_block_delta`/`content_block_stop`/`message_start`/`message_delta`/
`message_stop` are unchanged between 0.30.1 and 0.110.0, so the current `anthropic.ts` compiles
as-is).

Run: `npm test -w @lot-agent/core`
Expected: PASS, including `packages/core/src/llm/message-mapping.test.ts` (the existing
`toAnthropicMessage` test).

- [ ] **Step 4: Commit**

```bash
git add packages/core/package.json package-lock.json
git commit -m "chore(core): bump @anthropic-ai/sdk to ^0.110.0

Needed for prompt-cache (cache_control moved to the main messages
resource) and extended-thinking stream events, both added in E1."
```

---

### Task 2: Extend core LLM types (`ChatParams`, `ChatOptions.params`, `ChatChunk` thinking/cache fields)

**Files:**
- Modify: `packages/core/src/types/index.ts`

**Interfaces:**
- Produces: `ChatParams` (consumed by Task 14, 16, 19, 20), `ChatOptions.params` (consumed by Task
  14, 16, 19), `ChatChunk.type` gains `"thinking"` (consumed by Task 13, 15), `ChatChunk.usage`
  gains `cachedPromptTokens?: number` (consumed by Task 13, 15, 17, 19).

This is a pure additive/backward-compatible type change (all new fields optional) — there is no new
runtime behavior to red/green test, so verification is a build check instead of a Vitest run.

- [ ] **Step 1: Add `ChatParams` and extend `ChatOptions`/`ChatChunk`**

In `packages/core/src/types/index.ts`, replace:
```ts
/** Streamed chunk from LLM */
export interface ChatChunk {
  type: "text" | "tool_call" | "done";
  content?: string;
  toolCall?: ToolCall;
  finishReason?: string;
  usage?: { promptTokens: number; completionTokens: number };
}
```
with:
```ts
/** Per-call model parameters. */
export interface ChatParams {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  /** Reserved for E3's structured-output work; unread by any provider today. */
  responseSchema?: JSONSchema;
  reasoning?: "off" | number;
}

/** Streamed chunk from LLM */
export interface ChatChunk {
  type: "text" | "tool_call" | "done" | "thinking";
  content?: string;
  toolCall?: ToolCall;
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    /** Input tokens served from the provider's prompt cache, billed at a discount. */
    cachedPromptTokens?: number;
  };
}
```

Then update `ChatOptions` — replace:
```ts
/** Options for a single LLM chat call */
export interface ChatOptions {
  /** Aborts the in-flight request (run timeout or client disconnect). */
  signal?: AbortSignal;
}
```
with:
```ts
/** Options for a single LLM chat call */
export interface ChatOptions {
  /** Aborts the in-flight request (run timeout or client disconnect). */
  signal?: AbortSignal;
  params?: ChatParams;
}
```

`ChatParams` must be declared before `ChatOptions` references it in the same file — place the new
`ChatParams` interface directly above `ChatChunk` (both are above `ChatOptions` already in the file,
so this ordering is satisfied as shown).

- [ ] **Step 2: Verify it builds**

Run: `npm run build -w @lot-agent/core`
Expected: PASS. (No existing callers construct a `ChatChunk`/`ChatOptions` literal that would now
fail — all new fields are optional.)

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types/index.ts
git commit -m "feat(core): add ChatParams, ChatOptions.params, thinking chunk type, cachedPromptTokens"
```

---

### Task 3: `tools/validate.ts` — shallow JSON-schema input validator

**Files:**
- Create: `packages/core/src/tools/validate.ts`
- Test: `packages/core/src/tools/validate.test.ts`

**Interfaces:**
- Produces: `validateToolInput(schema: JSONSchema, input: unknown): string[]` (consumed by Task 4).

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/tools/validate.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { validateToolInput } from "./validate.js";

const schema = {
  type: "object",
  properties: {
    path: { type: "string" },
    count: { type: "number" },
  },
  required: ["path"],
};

describe("validateToolInput", () => {
  it("returns no errors for valid input", () => {
    expect(validateToolInput(schema, { path: "a.txt", count: 3 })).toEqual([]);
  });

  it("flags a missing required field", () => {
    const errors = validateToolInput(schema, { count: 3 });
    expect(errors).toContain('missing required field "path"');
  });

  it("flags a wrong-type field", () => {
    const errors = validateToolInput(schema, { path: "a.txt", count: "three" });
    expect(errors.some((e) => e.includes('field "count"'))).toBe(true);
  });

  it("ignores unknown extra fields", () => {
    expect(validateToolInput(schema, { path: "a.txt", extra: true })).toEqual([]);
  });

  it("treats non-object input as an empty object for property checks", () => {
    const errors = validateToolInput(schema, "not an object");
    expect(errors).toContain('missing required field "path"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/core -- validate`
Expected: FAIL with "Cannot find module './validate.js'" (or similar — the file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/tools/validate.ts`:
```ts
import type { JSONSchema } from "../types/index.js";

const JS_TYPE_CHECKS: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number",
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
};

/**
 * Shallow JSON-schema validation: checks `required` fields are present and,
 * for each declared property, that the runtime type matches the schema's
 * `type`. No recursion into nested schemas, no format/pattern/enum support —
 * deliberately minimal (a hand-rolled checker instead of adding an Ajv
 * dependency). Returns an empty array when the input is valid.
 */
export function validateToolInput(schema: JSONSchema, input: unknown): string[] {
  const errors: string[] = [];
  const properties = (schema.properties as Record<string, JSONSchema>) ?? {};
  const required = (schema.required as string[]) ?? [];
  const obj = (
    typeof input === "object" && input !== null ? input : {}
  ) as Record<string, unknown>;

  for (const key of required) {
    if (!(key in obj) || obj[key] === undefined) {
      errors.push(`missing required field "${key}"`);
    }
  }

  for (const [key, propSchema] of Object.entries(properties)) {
    if (!(key in obj) || obj[key] === undefined) continue; // optional/absent — nothing to check
    const expectedType = propSchema.type as string | undefined;
    const check = expectedType ? JS_TYPE_CHECKS[expectedType] : undefined;
    if (check && !check(obj[key])) {
      errors.push(`field "${key}" must be of type ${expectedType}, got ${typeof obj[key]}`);
    }
  }

  return errors;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/core -- validate`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/validate.ts packages/core/src/tools/validate.test.ts
git commit -m "feat(core): add shallow JSON-schema tool-input validator"
```

---

### Task 4: Wire `validateToolInput` into `ToolRegistry.execute`

**Files:**
- Modify: `packages/core/src/tools/registry.ts`
- Test: `packages/core/src/tools/registry.test.ts`

**Interfaces:**
- Consumes: `validateToolInput(schema, input): string[]` from Task 3.
- Produces: `ToolRegistry.execute` now returns `{ isError: true, errorKind: "validation" }` before
  ever calling `tool.execute` when input fails validation — no retry attempt is consumed.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/tools/registry.test.ts`:
```ts
describe("ToolRegistry.execute — input validation", () => {
  const schema = {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  };

  it("rejects input missing a required field before calling execute", async () => {
    const registry = new ToolRegistry();
    let executed = false;
    registry.register({
      name: "read_file",
      description: "reads a file",
      parameters: schema,
      execute: async () => {
        executed = true;
        return { content: "ok" };
      },
    });
    const result = await registry.execute("read_file", {}, { workingDirectory: "/tmp" });
    expect(result.isError).toBe(true);
    expect(result.errorKind).toBe("validation");
    expect(executed).toBe(false);
  });

  it("runs the tool when input is valid", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "read_file",
      description: "reads a file",
      parameters: schema,
      execute: async () => ({ content: "ok" }),
    });
    const result = await registry.execute(
      "read_file",
      { path: "a.txt" },
      { workingDirectory: "/tmp" }
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("ok");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/core -- tools/registry`
Expected: FAIL — the first test currently calls `execute` (no validation gate exists yet), so
`executed` is `true` and `result.errorKind` is `undefined`.

- [ ] **Step 3: Wire in the validator**

In `packages/core/src/tools/registry.ts`, add the import:
```ts
import { validateToolInput } from "./validate.js";
```

Then in `execute()`, replace:
```ts
  async execute(
    name: string,
    input: unknown,
    context: ToolContext,
    opts: { signal?: AbortSignal } = {}
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        content: `Tool not found: ${name}`,
        isError: true,
        errorKind: "not_found",
      };
    }

    // Merge default config with per-tool overrides
    const config = this.mergeConfig(tool);
```
with:
```ts
  async execute(
    name: string,
    input: unknown,
    context: ToolContext,
    opts: { signal?: AbortSignal } = {}
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        content: `Tool not found: ${name}`,
        isError: true,
        errorKind: "not_found",
      };
    }

    const validationErrors = validateToolInput(tool.parameters, input);
    if (validationErrors.length > 0) {
      return {
        content: `Invalid input for tool '${name}': ${validationErrors.join("; ")}`,
        isError: true,
        errorKind: "validation",
      };
    }

    // Merge default config with per-tool overrides
    const config = this.mergeConfig(tool);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/core -- tools/registry`
Expected: PASS (all tests in the file, including the pre-existing `toLLMTools` suite).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/registry.ts packages/core/src/tools/registry.test.ts
git commit -m "feat(core): validate tool input against its JSON schema before execute"
```

---

### Task 5: `tools/net-guard.ts` — SSRF guard

**Files:**
- Create: `packages/core/src/tools/net-guard.ts`
- Test: `packages/core/src/tools/net-guard.test.ts`

**Interfaces:**
- Produces: `assertPublicUrl(url: string, opts？: NetGuardOptions): Promise<void>` (throws
  `SsrfError`), `isPrivateAddress(ip: string, family: number): boolean`, `SsrfError` class,
  `NetGuardOptions` interface (all consumed by Task 6).

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/tools/net-guard.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { assertPublicUrl, isPrivateAddress, SsrfError } from "./net-guard.js";

describe("isPrivateAddress", () => {
  it("flags RFC1918 and loopback IPv4 ranges", () => {
    expect(isPrivateAddress("10.0.0.5", 4)).toBe(true);
    expect(isPrivateAddress("172.16.0.1", 4)).toBe(true);
    expect(isPrivateAddress("172.31.255.255", 4)).toBe(true);
    expect(isPrivateAddress("192.168.1.1", 4)).toBe(true);
    expect(isPrivateAddress("127.0.0.1", 4)).toBe(true);
    expect(isPrivateAddress("169.254.169.254", 4)).toBe(true); // cloud metadata
  });

  it("does not flag public IPv4 addresses or adjacent-but-public ranges", () => {
    expect(isPrivateAddress("8.8.8.8", 4)).toBe(false);
    expect(isPrivateAddress("93.184.216.34", 4)).toBe(false);
    expect(isPrivateAddress("172.32.0.1", 4)).toBe(false); // just outside 172.16/12
  });

  it("flags IPv6 loopback and unique-local/link-local ranges", () => {
    expect(isPrivateAddress("::1", 6)).toBe(true);
    expect(isPrivateAddress("fd00::1", 6)).toBe(true);
    expect(isPrivateAddress("fe80::1", 6)).toBe(true);
  });

  it("does not flag a public IPv6 address", () => {
    expect(isPrivateAddress("2001:4860:4860::8888", 6)).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  it("rejects a hostname that resolves to a private address", async () => {
    const resolve = async () => [{ address: "127.0.0.1", family: 4 }];
    await expect(
      assertPublicUrl("http://internal.example/", { resolve })
    ).rejects.toThrow(SsrfError);
  });

  it("allows a hostname that resolves to a public address", async () => {
    const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
    await expect(
      assertPublicUrl("http://example.com/", { resolve })
    ).resolves.toBeUndefined();
  });

  it("allows a private-resolving hostname when explicitly allow-listed", async () => {
    const resolve = async () => [{ address: "127.0.0.1", family: 4 }];
    await expect(
      assertPublicUrl("http://internal.local/", {
        resolve,
        allowHosts: ["internal.local"],
      })
    ).resolves.toBeUndefined();
  });

  it("rejects when the resolver returns no addresses", async () => {
    const resolve = async () => [];
    await expect(
      assertPublicUrl("http://nowhere.invalid/", { resolve })
    ).rejects.toThrow(SsrfError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/core -- net-guard`
Expected: FAIL — `./net-guard.js` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/tools/net-guard.ts`:
```ts
import { lookup as dnsLookup } from "node:dns/promises";

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface NetGuardOptions {
  /** Injectable for tests; defaults to node:dns/promises lookup. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Hostnames allowed to resolve to a private address (self-hosted deployments). */
  allowHosts?: string[];
}

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7
  if (lower.startsWith("fe80")) return true; // link-local
  return false;
}

/** True if `ip` (of the given address `family`, 4 or 6) is a private/loopback/link-local address. */
export function isPrivateAddress(ip: string, family: number): boolean {
  return family === 6 ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

async function defaultResolve(hostname: string): Promise<ResolvedAddress[]> {
  return dnsLookup(hostname, { all: true });
}

/**
 * Resolves `url`'s host and throws `SsrfError` if any resolved address is
 * private/loopback/link-local, unless the hostname is explicitly allow-listed.
 */
export async function assertPublicUrl(
  url: string,
  opts: NetGuardOptions = {}
): Promise<void> {
  const parsed = new URL(url);
  if (opts.allowHosts?.includes(parsed.hostname)) return;

  const resolve = opts.resolve ?? defaultResolve;
  const addrs = await resolve(parsed.hostname);
  if (addrs.length === 0) {
    throw new SsrfError(`could not resolve host: ${parsed.hostname}`);
  }
  for (const { address, family } of addrs) {
    if (isPrivateAddress(address, family)) {
      throw new SsrfError(
        `refusing to fetch private/internal address: ${address} (host: ${parsed.hostname})`
      );
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/core -- net-guard`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/net-guard.ts packages/core/src/tools/net-guard.test.ts
git commit -m "feat(core): add SSRF guard (assertPublicUrl) for outbound fetches"
```

---

### Task 6: Wire the SSRF guard + manual redirect handling into `web_fetch`

**Files:**
- Modify: `packages/core/src/tools/builtins.ts`
- Test: `packages/core/src/tools/builtins.test.ts` (new file)

**Interfaces:**
- Consumes: `assertPublicUrl`, `SsrfError` from Task 5.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/tools/builtins.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { webFetchTool } from "./builtins.js";
import type { ToolContext } from "../types/index.js";

const ctx: ToolContext = { workingDirectory: process.cwd() };

describe("web_fetch SSRF guard", () => {
  it("refuses to fetch a loopback address", async () => {
    const result = await webFetchTool.execute({ url: "http://127.0.0.1:1/" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("private");
  });

  it("refuses to fetch the cloud metadata address", async () => {
    const result = await webFetchTool.execute(
      { url: "http://169.254.169.254/latest/meta-data/" },
      ctx
    );
    expect(result.isError).toBe(true);
  });

  it("rejects a non-http(s) URL before attempting any resolution", async () => {
    const result = await webFetchTool.execute({ url: "file:///etc/passwd" }, ctx);
    expect(result.isError).toBe(true);
  });
});
```

(This test hits real, local IP literals only — `dns.lookup` on an IP literal resolves
synchronously/locally without a real network DNS query, so this is hermetic and requires no
mocking.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/core -- tools/builtins`
Expected: FAIL — `webFetchTool.execute` currently only checks the URL scheme, so `127.0.0.1` and the
metadata address are fetched (or fail for an unrelated reason like connection refused, not with a
"private" message), so the assertions on `result.content` fail.

- [ ] **Step 3: Wire in the guard + manual redirects**

In `packages/core/src/tools/builtins.ts`, add the import (near the top, with the other tool
imports):
```ts
import { assertPublicUrl } from "./net-guard.js";
```

Replace the existing `fetchWithTimeout` function:
```ts
async function fetchWithTimeout(
  url: string,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; LotAgent/0.1; +https://github.com/lot-agent)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}
```
with:
```ts
const MAX_REDIRECTS = 3;

function webFetchAllowHosts(): string[] {
  return (process.env.WEB_FETCH_ALLOW_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  redirect: RequestRedirect = "follow"
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; LotAgent/0.1; +https://github.com/lot-agent)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches `url`, re-checking the SSRF guard on every hop of up to
 * `MAX_REDIRECTS` manual redirects (a same-origin-looking redirect to an
 * internal address is the classic SSRF bypass — following redirects
 * automatically would skip the guard on the final, real destination).
 */
async function fetchPublic(url: string, timeoutMs: number): Promise<Response> {
  let currentUrl = url;
  const allowHosts = webFetchAllowHosts();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(currentUrl, { allowHosts });
    const res = await fetchWithTimeout(currentUrl, timeoutMs, "manual");
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop === MAX_REDIRECTS) {
        throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return res;
  }
  throw new Error("unreachable");
}
```

Then in `webFetchTool.execute`, replace:
```ts
    try {
      const res = await fetchWithTimeout(url, 15_000);
```
with:
```ts
    try {
      const res = await fetchPublic(url, 15_000);
```
(the surrounding `try`/`catch` already formats any thrown error — including `SsrfError` — as
`Failed to fetch URL: ${msg}`, so no other change is needed in `execute`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/core -- tools/builtins`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/builtins.ts packages/core/src/tools/builtins.test.ts
git commit -m "feat(core): guard web_fetch against SSRF, incl. redirect hops"
```

---

### Task 7: Path containment for file tools

**Files:**
- Modify: `packages/core/src/tools/builtins.ts`
- Test: `packages/core/src/tools/builtins.test.ts`

**Interfaces:** none new — internal fix to `resolvePath`'s callers.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/tools/builtins.test.ts`:
```ts
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileTool, writeFileTool, listFilesTool } from "./builtins.js";

describe("path containment", () => {
  it("rejects reading outside the working directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lot-agent-test-"));
    const result = await readFileTool.execute(
      { path: "../../etc/passwd" },
      { workingDirectory: dir }
    );
    expect(result.isError).toBe(true);
    expect(result.errorKind).toBe("permission");
    await rm(dir, { recursive: true, force: true });
  });

  it("allows reading a file inside a subdirectory of the working directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lot-agent-test-"));
    await writeFile(join(dir, "f.txt"), "hello");
    const result = await readFileTool.execute({ path: "f.txt" }, { workingDirectory: dir });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("hello");
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects writing outside the working directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lot-agent-test-"));
    const result = await writeFileTool.execute(
      { path: "../escape.txt", content: "x" },
      { workingDirectory: dir }
    );
    expect(result.isError).toBe(true);
    expect(result.errorKind).toBe("permission");
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects listing outside the working directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lot-agent-test-"));
    const result = await listFilesTool.execute({ path: ".." }, { workingDirectory: dir });
    expect(result.isError).toBe(true);
    expect(result.errorKind).toBe("permission");
    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/core -- tools/builtins`
Expected: FAIL — `../../etc/passwd`, `../escape.txt`, and `..` all currently resolve and execute
without any containment check.

- [ ] **Step 3: Add the containment check**

In `packages/core/src/tools/builtins.ts`, replace:
```ts
function resolvePath(input: { path: string }, ctx: ToolContext): string {
  return resolve(ctx.workingDirectory, input.path);
}
```
with:
```ts
import { sep } from "node:path";

function resolvePath(input: { path: string }, ctx: ToolContext): string {
  return resolve(ctx.workingDirectory, input.path);
}

/** True if `resolved` is the working directory or a path underneath it. */
function isContained(resolved: string, workingDirectory: string): boolean {
  return resolved === workingDirectory || resolved.startsWith(workingDirectory + sep);
}
```
(add the `sep` import to the existing `import { resolve } from "node:path";` line instead of a
separate import statement — i.e. change it to `import { resolve, sep } from "node:path";`, and drop
the duplicate shown above).

Then in each of `readFileTool`, `writeFileTool`, `listFilesTool`, `searchFilesTool`'s `execute`,
insert the check right after computing `fullPath`. For example, `readFileTool.execute` changes
from:
```ts
  async execute(input, context) {
    const { path } = input as { path: string };
    const fullPath = resolvePath({ path }, context);
    try {
      const content = await readFile(fullPath, "utf-8");
      return { content: truncate(content) };
    } catch (error) {
```
to:
```ts
  async execute(input, context) {
    const { path } = input as { path: string };
    const fullPath = resolvePath({ path }, context);
    if (!isContained(fullPath, context.workingDirectory)) {
      return {
        content: `Path escapes the working directory: ${path}`,
        isError: true,
        errorKind: "permission",
      };
    }
    try {
      const content = await readFile(fullPath, "utf-8");
      return { content: truncate(content) };
    } catch (error) {
```

Apply the same `isContained` guard (right after `const fullPath = resolvePath(...)`, before the
`try`) to `writeFileTool.execute`, `listFilesTool.execute`, and `searchFilesTool.execute`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/core -- tools/builtins`
Expected: PASS (all `path containment` + `web_fetch SSRF guard` tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/builtins.ts packages/core/src/tools/builtins.test.ts
git commit -m "fix(core): sandbox file tools to the working directory"
```

---

### Task 8: `execute_command` cancellation via signal

**Files:**
- Modify: `packages/core/src/tools/builtins.ts`
- Test: `packages/core/src/tools/builtins.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/tools/builtins.test.ts`:
```ts
import { executeCommandTool } from "./builtins.js";

describe("execute_command cancellation", () => {
  it("aborts a long-running command promptly when the signal fires", async () => {
    const controller = new AbortController();
    const ctx: ToolContext = { workingDirectory: process.cwd(), signal: controller.signal };
    const start = Date.now();
    const promise = executeCommandTool.execute({ command: "sleep", args: ["5"] }, ctx);
    setTimeout(() => controller.abort(), 100);
    const result = await promise;
    const elapsed = Date.now() - start;
    expect(result.isError).toBe(true);
    expect(elapsed).toBeLessThan(2000); // aborted promptly, not after the full 5s sleep
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/core -- tools/builtins`
Expected: FAIL — `context.signal` is never passed to `execFileAsync` today, so the command runs its
full 5-second course; `elapsed` will be ≥ 5000ms.

- [ ] **Step 3: Pass the signal through**

In `packages/core/src/tools/builtins.ts`, replace `executeCommandTool.execute`:
```ts
  async execute(input, context) {
    const { command, args = [] } = input as {
      command: string;
      args?: string[];
    };
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: context.workingDirectory,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      const output = [stdout, stderr].filter(Boolean).join("\n");
      return { content: truncate(output) || "(no output)" };
    } catch (error: unknown) {
      const err = error as { message?: string; stdout?: string; stderr?: string };
      return {
        content: truncate(
          `Command failed: ${err.message}\n${err.stdout ?? ""}\n${err.stderr ?? ""}`
        ),
        isError: true,
      };
    }
  },
```
with:
```ts
  async execute(input, context) {
    const { command, args = [] } = input as {
      command: string;
      args?: string[];
    };
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: context.workingDirectory,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        signal: context.signal,
      });
      const output = [stdout, stderr].filter(Boolean).join("\n");
      return { content: truncate(output) || "(no output)" };
    } catch (error: unknown) {
      const err = error as {
        message?: string;
        stdout?: string;
        stderr?: string;
        name?: string;
        code?: string;
      };
      if (err.name === "AbortError" || err.code === "ABORT_ERR") {
        return { content: "Command aborted", isError: true, errorKind: "unknown" };
      }
      return {
        content: truncate(
          `Command failed: ${err.message}\n${err.stdout ?? ""}\n${err.stderr ?? ""}`
        ),
        isError: true,
      };
    }
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/core -- tools/builtins`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/builtins.ts packages/core/src/tools/builtins.test.ts
git commit -m "fix(core): kill execute_command's subprocess on run cancellation"
```

---

### Task 9: `TraceManager` hardening — bounded size + latest-first lookup

**Files:**
- Modify: `packages/core/src/logger/trace.ts`
- Test: `packages/core/src/logger/trace.test.ts` (new file)

**Interfaces:**
- Produces: `TraceManager` constructor now takes an optional `{ maxTraces?: number }` (default 200);
  `getTraceForConversation` now returns the most recently started trace instead of the first found.
  No breaking change — existing zero-arg `new TraceManager()` call sites are unaffected.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/logger/trace.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { TraceManager } from "./trace.js";

describe("TraceManager bounding", () => {
  it("evicts the oldest trace once maxTraces is exceeded", () => {
    const tm = new TraceManager({ maxTraces: 2 });
    const t1 = tm.startTrace("conv-1", "model-a");
    const t2 = tm.startTrace("conv-2", "model-a");
    const t3 = tm.startTrace("conv-3", "model-a");
    expect(tm.getTrace(t1.id)).toBeUndefined();
    expect(tm.getTrace(t2.id)).toBeDefined();
    expect(tm.getTrace(t3.id)).toBeDefined();
  });

  it("cascades eviction so an evicted trace's span can no longer be ended", () => {
    const tm = new TraceManager({ maxTraces: 1 });
    const t1 = tm.startTrace("conv-1", "model-a");
    const span = tm.startSpan(t1.id, "llm.chat");
    let onSpanCalls = 0;
    tm.addSink({ onTrace: () => {}, onSpan: () => { onSpanCalls++; } });
    tm.startTrace("conv-2", "model-a"); // evicts t1 and its span
    tm.endSpan(span.id); // no-op — span was cascade-deleted
    expect(onSpanCalls).toBe(0);
  });

  it("defaults maxTraces to 200 when not configured", () => {
    const tm = new TraceManager();
    for (let i = 0; i < 200; i++) tm.startTrace(`conv-${i}`, "model-a");
    const first = tm.getTraceForConversation("conv-0");
    expect(first).toBeDefined(); // not yet evicted at exactly 200
    tm.startTrace("conv-200", "model-a"); // the 201st — now evicts conv-0's trace
    expect(tm.getTraceForConversation("conv-0")).toBeUndefined();
  });
});

describe("TraceManager.getTraceForConversation", () => {
  it("returns the most recently started trace for a conversation", () => {
    const tm = new TraceManager();
    tm.startTrace("conv-1", "model-a");
    const second = tm.startTrace("conv-1", "model-a");
    expect(tm.getTraceForConversation("conv-1")?.id).toBe(second.id);
  });

  it("returns undefined for a conversation with no traces", () => {
    const tm = new TraceManager();
    expect(tm.getTraceForConversation("nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/core -- logger/trace`
Expected: FAIL — `new TraceManager({ maxTraces: 2 })` is a type error today (constructor takes no
args) and there is no eviction; `getTraceForConversation` returns the *first* match, not the latest.

- [ ] **Step 3: Implement bounding + latest-first lookup**

In `packages/core/src/logger/trace.ts`, replace:
```ts
export class TraceManager {
  private traces = new Map<string, Trace>();
  private spans = new Map<string, Span>();
  private sinks: TraceSink[] = [];

  addSink(sink: TraceSink): void {
    this.sinks.push(sink);
  }

  startTrace(conversationId: string, model: string): Trace {
    const trace: Trace = {
      id: randomUUID(),
      conversationId,
      startTime: Date.now(),
      spans: [],
      metadata: { model, totalTokens: 0 },
    };
    this.traces.set(trace.id, trace);
    return trace;
  }
```
with:
```ts
export interface TraceManagerConfig {
  /** Max traces kept in memory; oldest is evicted (FIFO) past this. Default: 200. */
  maxTraces?: number;
}

export class TraceManager {
  private traces = new Map<string, Trace>();
  private spans = new Map<string, Span>();
  private sinks: TraceSink[] = [];
  private maxTraces: number;

  constructor(config: TraceManagerConfig = {}) {
    this.maxTraces = config.maxTraces ?? 200;
  }

  addSink(sink: TraceSink): void {
    this.sinks.push(sink);
  }

  startTrace(conversationId: string, model: string): Trace {
    const trace: Trace = {
      id: randomUUID(),
      conversationId,
      startTime: Date.now(),
      spans: [],
      metadata: { model, totalTokens: 0 },
    };
    this.traces.set(trace.id, trace);
    this.evictIfNeeded();
    return trace;
  }

  /** FIFO-evict the oldest trace(s) and cascade-delete their spans. */
  private evictIfNeeded(): void {
    while (this.traces.size > this.maxTraces) {
      const oldestId = this.traces.keys().next().value as string | undefined;
      if (!oldestId) break;
      const oldest = this.traces.get(oldestId);
      this.traces.delete(oldestId);
      if (oldest) {
        for (const span of oldest.spans) this.spans.delete(span.id);
      }
    }
  }
```

Then replace `getTraceForConversation`:
```ts
  getTraceForConversation(conversationId: string): Trace | undefined {
    for (const trace of this.traces.values()) {
      if (trace.conversationId === conversationId) return trace;
    }
    return undefined;
  }
```
with:
```ts
  getTraceForConversation(conversationId: string): Trace | undefined {
    let latest: Trace | undefined;
    // Map iteration is insertion order; keep overwriting so the last match
    // (most recently started, among traces still held) wins.
    for (const trace of this.traces.values()) {
      if (trace.conversationId === conversationId) latest = trace;
    }
    return latest;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/core -- logger/trace`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/logger/trace.ts packages/core/src/logger/trace.test.ts
git commit -m "fix(core): bound TraceManager memory + return latest trace per conversation"
```

---

### Task 10: `llm/retry.ts` — generic stream-retry wrapper

**Files:**
- Create: `packages/core/src/llm/retry.ts`
- Test: `packages/core/src/llm/retry.test.ts`

**Interfaces:**
- Produces: `withLLMRetry(createStream, cfg?): AsyncIterable<ChatChunk>`, `LLMRetryConfig` interface
  (consumed by Task 14, 16).

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/llm/retry.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { withLLMRetry } from "./retry.js";
import type { ChatChunk } from "../types/index.js";

async function drain(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

describe("withLLMRetry", () => {
  it("retries a retryable failure and succeeds on a later attempt", async () => {
    let calls = 0;
    async function* stream() {
      calls++;
      if (calls < 3) throw new Error("429 rate limit");
      yield { type: "text", content: "ok" } as ChatChunk;
    }
    const out = await drain(withLLMRetry(stream, { baseDelayMs: 1 }));
    expect(calls).toBe(3);
    expect(out).toEqual([{ type: "text", content: "ok" }]);
  });

  it("does not retry once a chunk has already been yielded", async () => {
    let calls = 0;
    async function* stream() {
      calls++;
      yield { type: "text", content: "partial" } as ChatChunk;
      throw new Error("500 internal error");
    }
    await expect(drain(withLLMRetry(stream, { baseDelayMs: 1 }))).rejects.toThrow(
      "500 internal error"
    );
    expect(calls).toBe(1);
  });

  it("gives up after maxRetries and throws the last error", async () => {
    let calls = 0;
    async function* stream() {
      calls++;
      throw new Error("429 rate limit");
    }
    await expect(
      drain(withLLMRetry(stream, { maxRetries: 1, baseDelayMs: 1 }))
    ).rejects.toThrow("429 rate limit");
    expect(calls).toBe(2); // initial attempt + 1 retry
  });

  it("does not retry a non-retryable error", async () => {
    let calls = 0;
    async function* stream() {
      calls++;
      throw new Error("400 bad request");
    }
    await expect(drain(withLLMRetry(stream, { baseDelayMs: 1 }))).rejects.toThrow(
      "400 bad request"
    );
    expect(calls).toBe(1);
  });

  it("honors a custom isRetryable predicate", async () => {
    let calls = 0;
    async function* stream() {
      calls++;
      if (calls < 2) throw new Error("custom-retryable");
      yield { type: "text", content: "ok" } as ChatChunk;
    }
    const out = await drain(
      withLLMRetry(stream, {
        baseDelayMs: 1,
        isRetryable: (err) => err instanceof Error && err.message === "custom-retryable",
      })
    );
    expect(out).toEqual([{ type: "text", content: "ok" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/core -- llm/retry`
Expected: FAIL — `./retry.js` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/llm/retry.ts`:
```ts
import type { ChatChunk } from "../types/index.js";

export interface LLMRetryConfig {
  /** Max retry attempts after the first. Default: 2. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default: 1000. */
  baseDelayMs?: number;
  /** Default: HTTP 429/5xx or common network-error message substrings. */
  isRetryable?(err: unknown): boolean;
  /** Reads a Retry-After-style delay off the error, if present. */
  retryAfterMs?(err: unknown): number | undefined;
}

function defaultIsRetryable(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504") ||
    message.includes("rate limit") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("network")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps a stream-creating function with retry. Only retries when the failing
 * attempt produced zero chunks — a fresh request is safe to redo; once any
 * chunk has already reached the caller, a later failure propagates as-is
 * instead of duplicating or discarding partial output.
 */
export async function* withLLMRetry(
  createStream: () => AsyncIterable<ChatChunk>,
  cfg: LLMRetryConfig = {}
): AsyncIterable<ChatChunk> {
  const maxRetries = cfg.maxRetries ?? 2;
  const baseDelayMs = cfg.baseDelayMs ?? 1000;
  const isRetryable = cfg.isRetryable ?? defaultIsRetryable;

  for (let attempt = 0; ; attempt++) {
    let yieldedAny = false;
    try {
      for await (const chunk of createStream()) {
        yieldedAny = true;
        yield chunk;
      }
      return;
    } catch (err) {
      if (yieldedAny || attempt >= maxRetries || !isRetryable(err)) {
        throw err;
      }
      const retryAfter = cfg.retryAfterMs?.(err);
      const delay = retryAfter ?? baseDelayMs * 2 ** attempt + Math.random() * 300;
      await sleep(Math.min(delay, 10_000));
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/core -- llm/retry`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/llm/retry.ts packages/core/src/llm/retry.test.ts
git commit -m "feat(core): add withLLMRetry — retry-before-first-chunk stream wrapper"
```

---

### Task 11: `llm/complete.ts` — non-streaming convenience helper

**Files:**
- Create: `packages/core/src/llm/complete.ts`
- Test: `packages/core/src/llm/complete.test.ts`

**Interfaces:**
- Produces: `complete(llm: LLMProvider, messages: Message[], opts?: ChatOptions): Promise<string>`
  (consumed by Task 12).

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/llm/complete.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { complete } from "./complete.js";
import type { ChatChunk, LLMProvider, Message } from "../types/index.js";

function fakeLLM(chunks: ChatChunk[]): LLMProvider {
  return {
    async *chat(): AsyncIterable<ChatChunk> {
      for (const c of chunks) yield c;
    },
  };
}

describe("complete", () => {
  it("concatenates all text chunks into one string", async () => {
    const llm = fakeLLM([
      { type: "text", content: "Hello, " },
      { type: "text", content: "world!" },
      { type: "done", finishReason: "stop" },
    ]);
    const result = await complete(llm, [{ role: "user", content: "hi" }] as Message[]);
    expect(result).toBe("Hello, world!");
  });

  it("ignores non-text chunks (e.g. thinking, tool_call)", async () => {
    const llm = fakeLLM([
      { type: "thinking", content: "pondering" },
      { type: "text", content: "answer" },
      { type: "done", finishReason: "stop" },
    ]);
    const result = await complete(llm, [{ role: "user", content: "hi" }] as Message[]);
    expect(result).toBe("answer");
  });

  it("returns an empty string when the stream has no text chunks", async () => {
    const llm = fakeLLM([{ type: "done", finishReason: "stop" }]);
    const result = await complete(llm, [{ role: "user", content: "hi" }] as Message[]);
    expect(result).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/core -- llm/complete`
Expected: FAIL — `./complete.js` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/llm/complete.ts`:
```ts
import type { ChatOptions, LLMProvider, Message } from "../types/index.js";

/** Drains a chat() stream and returns the concatenated text content. */
export async function complete(
  llm: LLMProvider,
  messages: Message[],
  opts?: ChatOptions
): Promise<string> {
  let text = "";
  for await (const chunk of llm.chat(messages, undefined, opts)) {
    if (chunk.type === "text" && chunk.content) text += chunk.content;
  }
  return text;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/core -- llm/complete`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/llm/complete.ts packages/core/src/llm/complete.test.ts
git commit -m "feat(core): add complete() — non-streaming text aggregation helper"
```

---

### Task 12: `context-manager.ts` — use `complete()` in `summarize()`

**Files:**
- Modify: `packages/core/src/context/context-manager.ts`

**Interfaces:**
- Consumes: `complete(llm, messages, opts)` from Task 11.

This is a pure refactor with no behavior change — the existing `context-manager.test.ts` suite
(`FakeCompressor`/`ThrowingCompressor`-based tests) is the regression net, so there's no new test to
write.

- [ ] **Step 1: Add the import**

In `packages/core/src/context/context-manager.ts`, add near the top:
```ts
import { complete } from "../llm/complete.js";
```

- [ ] **Step 2: Replace the manual loop**

Replace:
```ts
    let summary = "";
    for await (const chunk of compressor.chat(
      [
        { role: "system", content: system },
        { role: "user", content: userParts },
      ],
      undefined,
      { signal }
    )) {
      if (chunk.type === "text") summary += chunk.content;
    }
    return summary;
```
with:
```ts
    return complete(
      compressor,
      [
        { role: "system", content: system },
        { role: "user", content: userParts },
      ],
      { signal }
    );
```

- [ ] **Step 3: Run the existing suite to confirm no regression**

Run: `npm test -w @lot-agent/core -- context-manager`
Expected: PASS — every existing test in `context-manager.test.ts` (elision, sticky-boundary
summary, rolling extension, etc.) stays green, since `complete()` aggregates text chunks identically
to the removed loop.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/context/context-manager.ts
git commit -m "refactor(core): use complete() in ContextManager.summarize"
```

---

### Task 13: OpenAI provider — extract `mapOpenAIStream`, fix usage accounting, add thinking events

**Files:**
- Modify: `packages/core/src/llm/openai.ts`
- Test: `packages/core/src/llm/openai.test.ts` (new file)

**Interfaces:**
- Produces: `mapOpenAIStream(stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>):
  AsyncIterable<ChatChunk>` (consumed by Task 14; also directly unit-tested here).

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/llm/openai.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mapOpenAIStream } from "./openai.js";
import type { ChatChunk } from "../types/index.js";

async function collect(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

function chunkStream(chunks: unknown[]): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

describe("mapOpenAIStream", () => {
  it("waits for a trailing usage-only chunk (empty choices) before emitting done", async () => {
    const stream = chunkStream([
      { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
    ]);
    const out = await collect(mapOpenAIStream(stream));
    expect(out[0]).toEqual({ type: "text", content: "hi" });
    const done = out.find((c) => c.type === "done");
    expect(done?.usage).toEqual({ promptTokens: 10, completionTokens: 2 });
  });

  it("emits done with usage immediately when usage arrives on the finish_reason chunk", async () => {
    const stream = chunkStream([
      {
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      },
    ]);
    const out = await collect(mapOpenAIStream(stream));
    const done = out.find((c) => c.type === "done");
    expect(done?.usage).toEqual({ promptTokens: 5, completionTokens: 1 });
  });

  it("emits done with no usage when the vendor never sends one", async () => {
    const stream = chunkStream([
      { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] },
    ]);
    const out = await collect(mapOpenAIStream(stream));
    const done = out.find((c) => c.type === "done");
    expect(done).toBeDefined();
    expect(done?.usage).toBeUndefined();
  });

  it("maps DeepSeek reasoning_content to a thinking chunk", async () => {
    const stream = chunkStream([
      { choices: [{ index: 0, delta: { reasoning_content: "let me think..." }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
    const out = await collect(mapOpenAIStream(stream));
    expect(out[0]).toEqual({ type: "thinking", content: "let me think..." });
  });

  it("accumulates tool call arguments by index across chunks", async () => {
    const stream = chunkStream([
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "" } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }, finish_reason: null },
        ],
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }, finish_reason: null },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const out = await collect(mapOpenAIStream(stream));
    const toolCall = out.find((c) => c.type === "tool_call");
    expect(toolCall?.toolCall).toEqual({ id: "call_1", name: "read_file", arguments: { path: "a.txt" } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/core -- llm/openai`
Expected: FAIL — `mapOpenAIStream` is not exported yet.

- [ ] **Step 3: Extract the function and fix usage accounting**

In `packages/core/src/llm/openai.ts`, add `ChatCompletionChunk` to the existing type import:
```ts
import type {
  ChatCompletionChunk,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
```

Replace the whole `chat()` method body:
```ts
  async *chat(
    messages: Message[],
    tools?: LLMTool[],
    opts?: ChatOptions
  ): AsyncIterable<ChatChunk> {
    const oaiMessages = messages.map(toOpenAIMessage);
    const oaiTools = tools?.map(toOpenAITool);

    const debug = ["1", "true", "yes"].includes(
      (process.env.DEBUG_LLM ?? "").toLowerCase()
    );
    if (debug) {
      console.error(
        `[DEBUG_LLM] request model=${this.model} messages=${oaiMessages.length} tools=${oaiTools?.length ?? 0}`
      );
    }

    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: oaiMessages,
        tools: oaiTools,
        tool_choice: oaiTools?.length ? "auto" : undefined,
        stream: true,
      },
      { signal: opts?.signal }
    );

    // Buffer for accumulating tool call arguments
    const toolCallBuffers = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    for await (const chunk of stream) {
      // Dump the raw API delta so you can see exactly what the model returns
      // (e.g. reasoning_content vs content). Enable with DEBUG_LLM=1.
      if (debug) console.error("[DEBUG_LLM] chunk", JSON.stringify(chunk.choices[0]));

      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      // Handle text content
      if (delta.content) {
        yield { type: "text", content: delta.content };
      }

      // Handle tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index;
          if (!toolCallBuffers.has(index)) {
            toolCallBuffers.set(index, {
              id: tc.id ?? "",
              name: "",
              arguments: "",
            });
          }
          const buf = toolCallBuffers.get(index)!;
          if (tc.id) buf.id = tc.id;
          if (tc.function?.name) buf.name = tc.function.name;
          if (tc.function?.arguments) buf.arguments += tc.function.arguments;
        }
      }

      // Handle finish
      if (chunk.choices[0]?.finish_reason) {
        // Flush buffered tool calls
        for (const buf of toolCallBuffers.values()) {
          let parsedArgs: unknown;
          try {
            parsedArgs = JSON.parse(buf.arguments);
          } catch {
            parsedArgs = buf.arguments;
          }
          yield {
            type: "tool_call",
            toolCall: { id: buf.id, name: buf.name, arguments: parsedArgs },
          };
        }

        yield {
          type: "done",
          finishReason: chunk.choices[0].finish_reason,
          usage: chunk.usage
            ? {
                promptTokens: chunk.usage.prompt_tokens,
                completionTokens: chunk.usage.completion_tokens,
              }
            : undefined,
        };
      }
    }
  }
```
with:
```ts
  async *chat(
    messages: Message[],
    tools?: LLMTool[],
    opts?: ChatOptions
  ): AsyncIterable<ChatChunk> {
    const oaiMessages = messages.map(toOpenAIMessage);
    const oaiTools = tools?.map(toOpenAITool);

    const debug = ["1", "true", "yes"].includes(
      (process.env.DEBUG_LLM ?? "").toLowerCase()
    );
    if (debug) {
      console.error(
        `[DEBUG_LLM] request model=${this.model} messages=${oaiMessages.length} tools=${oaiTools?.length ?? 0}`
      );
    }

    const client = this.client;
    const model = this.model;
    const params = opts?.params;

    const createStream = () =>
      mapOpenAIStream(
        (async function* () {
          const stream = await client.chat.completions.create(
            {
              model,
              messages: oaiMessages,
              tools: oaiTools,
              tool_choice: oaiTools?.length ? "auto" : undefined,
              stream: true,
              stream_options: { include_usage: true },
              temperature: params?.temperature,
              max_tokens: params?.maxTokens,
              top_p: params?.topP,
            },
            { signal: opts?.signal }
          );
          yield* stream;
        })()
      );

    yield* createStream();
  }
```

(this task leaves `createStream()` called directly, un-retried — Task 14 wraps it with
`withLLMRetry`, since that's a separate, independently-revertible concern from the usage/thinking
fix here).

Then add the extracted, exported `mapOpenAIStream` function below the class (near the existing
`toOpenAIMessage`/`toOpenAITool` functions):
```ts
/**
 * Consumes the raw OpenAI-shaped chunk stream and yields ChatChunks. A
 * usage-only trailing chunk (strict `stream_options.include_usage`
 * compliance) has an EMPTY `choices` array — so `done` isn't emitted the
 * moment `finish_reason` is seen; it waits for either a usage-bearing chunk
 * (attached to the finish_reason chunk, e.g. DeepSeek, or trailing/separate,
 * e.g. spec-compliant OpenAI) or the stream ending with no usage at all
 * (a vendor that ignores `stream_options` entirely).
 */
export async function* mapOpenAIStream(
  stream: AsyncIterable<ChatCompletionChunk>
): AsyncIterable<ChatChunk> {
  const debug = ["1", "true", "yes"].includes(
    (process.env.DEBUG_LLM ?? "").toLowerCase()
  );
  const toolCallBuffers = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  let finishReason: string | undefined;

  function* flushToolCalls(): Generator<ChatChunk> {
    for (const buf of toolCallBuffers.values()) {
      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(buf.arguments);
      } catch {
        parsedArgs = buf.arguments;
      }
      yield {
        type: "tool_call",
        toolCall: { id: buf.id, name: buf.name, arguments: parsedArgs },
      };
    }
    toolCallBuffers.clear();
  }

  for await (const chunk of stream) {
    if (debug) console.error("[DEBUG_LLM] chunk", JSON.stringify(chunk.choices[0]));

    const delta = chunk.choices[0]?.delta as
      | (ChatCompletionChunk.Choice["delta"] & { reasoning_content?: string })
      | undefined;

    if (delta?.reasoning_content) {
      yield { type: "thinking", content: delta.reasoning_content };
    }
    if (delta?.content) {
      yield { type: "text", content: delta.content };
    }

    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const index = tc.index;
        if (!toolCallBuffers.has(index)) {
          toolCallBuffers.set(index, { id: tc.id ?? "", name: "", arguments: "" });
        }
        const buf = toolCallBuffers.get(index)!;
        if (tc.id) buf.id = tc.id;
        if (tc.function?.name) buf.name = tc.function.name;
        if (tc.function?.arguments) buf.arguments += tc.function.arguments;
      }
    }

    if (chunk.choices[0]?.finish_reason) {
      finishReason = chunk.choices[0].finish_reason;
    }

    if (finishReason && (chunk.usage || chunk.choices.length === 0)) {
      yield* flushToolCalls();
      yield {
        type: "done",
        finishReason,
        usage: chunk.usage
          ? {
              promptTokens: chunk.usage.prompt_tokens,
              completionTokens: chunk.usage.completion_tokens,
            }
          : undefined,
      };
      finishReason = undefined;
    }
  }

  // Stream ended without a usage chunk ever arriving after finish_reason
  // (vendor doesn't support stream_options.include_usage at all).
  if (finishReason) {
    yield* flushToolCalls();
    yield { type: "done", finishReason };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/core -- llm/openai`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full core suite to check for regressions**

Run: `npm test -w @lot-agent/core -- message-mapping`
Expected: PASS — `toOpenAIMessage` is untouched by this task.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/llm/openai.ts packages/core/src/llm/openai.test.ts
git commit -m "fix(core): OpenAI usage accounting for strict stream_options compliance; add thinking events"
```

---

### Task 14: OpenAI provider — retry wrap + `ChatParams` passthrough verification

**Files:**
- Modify: `packages/core/src/llm/openai.ts`
- Test: `packages/core/src/llm/openai.test.ts`

**Interfaces:**
- Consumes: `withLLMRetry` from Task 10.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/llm/openai.test.ts`. This test exercises `OpenAIProvider.chat` end to
end against a fake `OpenAI` client (constructor-injected via the existing `OpenAIProviderConfig`
shape is not enough — the SDK client is built internally — so this test stubs the module-level
`OpenAI` class via `vi.mock`, matching how the SDK is actually invoked):
```ts
import { describe, it, expect, vi } from "vitest";
```
(add `vi` to the existing `vitest` import at the top of the file)

```ts
vi.mock("openai", () => {
  class FakeAPIError extends Error {}
  return {
    default: class FakeOpenAI {
      chat = {
        completions: {
          create: vi.fn(),
        },
      };
      constructor(_config: unknown) {}
    },
    RateLimitError: FakeAPIError,
    InternalServerError: FakeAPIError,
    APIConnectionError: FakeAPIError,
    APIConnectionTimeoutError: FakeAPIError,
  };
});

describe("OpenAIProvider.chat retry", () => {
  it("retries a RateLimitError raised before any chunk and succeeds on the next attempt", async () => {
    const { OpenAIProvider } = await import("./openai.js");
    const { RateLimitError } = (await import("openai")) as unknown as {
      RateLimitError: new (msg?: string) => Error;
    };
    const provider = new OpenAIProvider({ apiKey: "x", model: "test-model" });
    const create = (provider as unknown as { client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } })
      .client.chat.completions.create;

    let call = 0;
    create.mockImplementation(async () => {
      call++;
      if (call === 1) throw new RateLimitError("rate limited");
      return {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] };
        },
      };
    });

    const out: string[] = [];
    for await (const chunk of provider.chat([{ role: "user", content: "hi" }])) {
      if (chunk.type === "text" && chunk.content) out.push(chunk.content);
    }
    expect(call).toBe(2);
    expect(out).toEqual(["ok"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/core -- llm/openai`
Expected: FAIL — `chat()` doesn't retry today, so the first (and only) call throws
`RateLimitError`, which propagates out of `provider.chat(...)` uncaught by the test's `for await`.

- [ ] **Step 3: Wrap with `withLLMRetry`**

In `packages/core/src/llm/openai.ts`, add the imports:
```ts
import OpenAI, {
  RateLimitError,
  InternalServerError,
  APIConnectionError,
  APIConnectionTimeoutError,
} from "openai";
import { withLLMRetry } from "./retry.js";
```
(the existing `import OpenAI from "openai";` line becomes the combined default+named import above —
replace it rather than adding a second import line.)

Add, near the bottom of the file (module scope, alongside `toOpenAITool`):
```ts
function isOpenAIRetryable(err: unknown): boolean {
  return (
    err instanceof RateLimitError ||
    err instanceof InternalServerError ||
    err instanceof APIConnectionError ||
    err instanceof APIConnectionTimeoutError
  );
}
```

Then change the last line of `chat()` from:
```ts
    yield* createStream();
```
to:
```ts
    yield* withLLMRetry(createStream, { isRetryable: isOpenAIRetryable });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/core -- llm/openai`
Expected: PASS (6 tests total in the file).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/llm/openai.ts packages/core/src/llm/openai.test.ts
git commit -m "feat(core): retry OpenAI stream creation on rate-limit/5xx/connection errors"
```

---

### Task 15: Anthropic provider — extract `mapAnthropicStream`, fix usage/index-tracking, add thinking events

**Files:**
- Modify: `packages/core/src/llm/anthropic.ts`
- Test: `packages/core/src/llm/anthropic.test.ts` (new file)

**Interfaces:**
- Produces: `mapAnthropicStream(events: AsyncIterable<Anthropic.Messages.RawMessageStreamEvent>):
  AsyncIterable<ChatChunk>` (consumed by Task 16, 17; also directly unit-tested here).

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/llm/anthropic.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mapAnthropicStream } from "./anthropic.js";
import type { ChatChunk } from "../types/index.js";

async function collect(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

function eventStream(events: unknown[]): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
  };
}

describe("mapAnthropicStream", () => {
  it("accumulates usage from message_start + message_delta into the done chunk", async () => {
    const events = eventStream([
      { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 20 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: {}, usage: { output_tokens: 8 } },
      { type: "message_stop" },
    ]);
    const out = await collect(mapAnthropicStream(events));
    expect(out).toContainEqual({ type: "text", content: "hi" });
    const done = out.find((c) => c.type === "done");
    expect(done?.usage).toEqual({ promptTokens: 100, completionTokens: 8, cachedPromptTokens: 20 });
  });

  it("maps thinking_delta to a thinking chunk", async () => {
    const events = eventStream([
      { type: "message_start", message: { usage: { input_tokens: 1, cache_read_input_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm..." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: {}, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]);
    const out = await collect(mapAnthropicStream(events));
    expect(out).toContainEqual({ type: "thinking", content: "hmm..." });
  });

  it("routes input_json_delta fragments to the correct tool_use block by index, even interleaved", async () => {
    const events = eventStream([
      { type: "message_start", message: { usage: { input_tokens: 1, cache_read_input_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t0", name: "read_file" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "list_files" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path"' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ':"."}' } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: {}, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]);
    const out = await collect(mapAnthropicStream(events));
    const calls = out.filter((c) => c.type === "tool_call");
    expect(calls).toContainEqual({
      type: "tool_call",
      toolCall: { id: "t0", name: "read_file", arguments: { path: "a.txt" } },
    });
    expect(calls).toContainEqual({
      type: "tool_call",
      toolCall: { id: "t1", name: "list_files", arguments: { path: "." } },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/core -- llm/anthropic`
Expected: FAIL — `mapAnthropicStream` doesn't exist yet.

- [ ] **Step 3: Extract the function, fix usage + index-tracking, add thinking**

In `packages/core/src/llm/anthropic.ts`, add `RawMessageStreamEvent` to the existing type import:
```ts
import type {
  MessageParam,
  RawMessageStreamEvent,
  Tool,
  ToolUseBlock,
  TextBlockParam,
  ToolUseBlockParam,
  ImageBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
```

Replace the whole `chat()` method body:
```ts
  async *chat(
    messages: Message[],
    tools?: LLMTool[],
    opts?: ChatOptions
  ): AsyncIterable<ChatChunk> {
    // Anthropic requires system prompt as a separate parameter
    const systemMessages: string[] = [];
    const chatMessages: MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemMessages.push(String(msg.content));
      } else {
        chatMessages.push(toAnthropicMessage(msg));
      }
    }

    const anthropicTools = tools?.map(toAnthropicTool);

    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: 8192,
        system: systemMessages.join("\n\n") || undefined,
        messages: chatMessages,
        tools: anthropicTools,
      },
      { signal: opts?.signal }
    );

    // Buffer for accumulating tool use blocks
    const toolBuffers = new Map<
      string,
      { id: string; name: string; input: string }
    >();

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") {
          const block = event.content_block as ToolUseBlock;
          toolBuffers.set(block.id, {
            id: block.id,
            name: block.name,
            input: "",
          });
        }
      }

      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          yield { type: "text", content: event.delta.text };
        }
        if (event.delta.type === "input_json_delta") {
          // Find the current tool being accumulated
          const lastKey = [...toolBuffers.keys()].pop();
          if (lastKey) {
            const buf = toolBuffers.get(lastKey)!;
            buf.input += event.delta.partial_json;
          }
        }
      }

      if (event.type === "content_block_stop") {
        // Check if a tool block just finished
        const lastKey = [...toolBuffers.keys()].pop();
        if (lastKey) {
          const buf = toolBuffers.get(lastKey)!;
          // Only emit if this block hasn't been emitted yet
          if (buf.input || buf.name) {
            let parsedArgs: unknown;
            try {
              parsedArgs = JSON.parse(buf.input || "{}");
            } catch {
              parsedArgs = buf.input;
            }
            yield {
              type: "tool_call",
              toolCall: {
                id: buf.id,
                name: buf.name,
                arguments: parsedArgs,
              },
            };
            toolBuffers.delete(lastKey);
          }
        }
      }

      if (event.type === "message_stop") {
        // Flush any remaining tool buffers
        for (const buf of toolBuffers.values()) {
          let parsedArgs: unknown;
          try {
            parsedArgs = JSON.parse(buf.input || "{}");
          } catch {
            parsedArgs = buf.input;
          }
          yield {
            type: "tool_call",
            toolCall: {
              id: buf.id,
              name: buf.name,
              arguments: parsedArgs,
            },
          };
        }
        toolBuffers.clear();

        yield {
          type: "done",
          finishReason: "stop",
        };
      }
    }
  }
```
with:
```ts
  async *chat(
    messages: Message[],
    tools?: LLMTool[],
    opts?: ChatOptions
  ): AsyncIterable<ChatChunk> {
    // Anthropic requires system prompt as a separate parameter
    const systemMessages: string[] = [];
    const chatMessages: MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemMessages.push(String(msg.content));
      } else {
        chatMessages.push(toAnthropicMessage(msg));
      }
    }

    const anthropicTools = tools?.map(toAnthropicTool);
    const params = opts?.params;

    const createStream = () =>
      mapAnthropicStream(
        this.client.messages.stream(
          {
            model: this.model,
            max_tokens: params?.maxTokens ?? 8192,
            temperature: params?.temperature,
            top_p: params?.topP,
            system: systemMessages.join("\n\n") || undefined,
            messages: chatMessages,
            tools: anthropicTools,
          },
          { signal: opts?.signal }
        )
      );

    yield* createStream();
  }
```

(as with Task 13/14 for OpenAI, retry-wrapping `createStream()` is Task 16's concern — this task
only fixes usage/index-tracking/thinking.)

Then add the extracted, exported `mapAnthropicStream` function below the class:
```ts
/**
 * Consumes the raw Anthropic message-stream events and yields ChatChunks.
 * Tool-use blocks are tracked by the event's `index` (not by guessing "the
 * last one seen") so interleaved/multiple tool calls in one message route
 * their `input_json_delta` fragments correctly. Usage accumulates across
 * `message_start` (prompt + cached-prompt tokens) and `message_delta`
 * (completion tokens), landing on the `done` chunk emitted at `message_stop`
 * — previously `done` carried no usage at all.
 */
export async function* mapAnthropicStream(
  events: AsyncIterable<RawMessageStreamEvent>
): AsyncIterable<ChatChunk> {
  const toolBuffers = new Map<number, { id: string; name: string; input: string }>();
  let promptTokens = 0;
  let cachedPromptTokens = 0;
  let completionTokens = 0;

  for await (const event of events) {
    if (event.type === "message_start") {
      promptTokens = event.message.usage.input_tokens;
      cachedPromptTokens = event.message.usage.cache_read_input_tokens ?? 0;
    }

    if (event.type === "content_block_start") {
      if (event.content_block.type === "tool_use") {
        const block = event.content_block as ToolUseBlock;
        toolBuffers.set(event.index, { id: block.id, name: block.name, input: "" });
      }
    }

    if (event.type === "content_block_delta") {
      if (event.delta.type === "text_delta") {
        yield { type: "text", content: event.delta.text };
      }
      if (event.delta.type === "thinking_delta") {
        yield { type: "thinking", content: event.delta.thinking };
      }
      if (event.delta.type === "input_json_delta") {
        const buf = toolBuffers.get(event.index);
        if (buf) buf.input += event.delta.partial_json;
      }
    }

    if (event.type === "content_block_stop") {
      const buf = toolBuffers.get(event.index);
      if (buf && (buf.input || buf.name)) {
        let parsedArgs: unknown;
        try {
          parsedArgs = JSON.parse(buf.input || "{}");
        } catch {
          parsedArgs = buf.input;
        }
        yield {
          type: "tool_call",
          toolCall: { id: buf.id, name: buf.name, arguments: parsedArgs },
        };
        toolBuffers.delete(event.index);
      }
    }

    if (event.type === "message_delta") {
      completionTokens = event.usage.output_tokens;
    }

    if (event.type === "message_stop") {
      for (const buf of toolBuffers.values()) {
        let parsedArgs: unknown;
        try {
          parsedArgs = JSON.parse(buf.input || "{}");
        } catch {
          parsedArgs = buf.input;
        }
        yield {
          type: "tool_call",
          toolCall: { id: buf.id, name: buf.name, arguments: parsedArgs },
        };
      }
      toolBuffers.clear();

      yield {
        type: "done",
        finishReason: "stop",
        usage: { promptTokens, completionTokens, cachedPromptTokens },
      };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/core -- llm/anthropic`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the message-mapping regression check**

Run: `npm test -w @lot-agent/core -- message-mapping`
Expected: PASS — `toAnthropicMessage` is untouched by this task.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/llm/anthropic.ts packages/core/src/llm/anthropic.test.ts
git commit -m "fix(core): Anthropic usage accounting + index-keyed tool buffers; add thinking events"
```

---

### Task 16: Anthropic provider — retry wrap

**Files:**
- Modify: `packages/core/src/llm/anthropic.ts`
- Test: `packages/core/src/llm/anthropic.test.ts`

**Interfaces:**
- Consumes: `withLLMRetry` from Task 10.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/llm/anthropic.test.ts`:
```ts
import { describe as describe2, it as it2, expect as expect2, vi } from "vitest";
```
(instead of a second `describe`/`it`/`expect` import alias, just reuse the existing top-of-file
`import { describe, it, expect } from "vitest";` and add `vi` to it — i.e. change that line to
`import { describe, it, expect, vi } from "vitest";` and drop the aliased import shown above.)

```ts
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAPIError extends Error {}
  return {
    default: class FakeAnthropic {
      messages = { stream: vi.fn() };
      constructor(_config: unknown) {}
    },
    RateLimitError: FakeAPIError,
    InternalServerError: FakeAPIError,
    APIConnectionError: FakeAPIError,
    APIConnectionTimeoutError: FakeAPIError,
  };
});

describe("AnthropicProvider.chat retry", () => {
  it("retries a RateLimitError raised before any chunk and succeeds on the next attempt", async () => {
    const { AnthropicProvider } = await import("./anthropic.js");
    const { RateLimitError } = (await import("@anthropic-ai/sdk")) as unknown as {
      RateLimitError: new (msg?: string) => Error;
    };
    const provider = new AnthropicProvider({ apiKey: "x", model: "test-model" });
    const streamFn = (provider as unknown as { client: { messages: { stream: ReturnType<typeof vi.fn> } } })
      .client.messages.stream;

    let call = 0;
    streamFn.mockImplementation(() => {
      call++;
      if (call === 1) throw new RateLimitError("rate limited");
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "message_start",
            message: { usage: { input_tokens: 1, cache_read_input_tokens: 0 } },
          };
          yield { type: "content_block_start", index: 0, content_block: { type: "text" } };
          yield {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ok" },
          };
          yield { type: "content_block_stop", index: 0 };
          yield { type: "message_delta", delta: {}, usage: { output_tokens: 1 } };
          yield { type: "message_stop" };
        },
      };
    });

    const out: string[] = [];
    for await (const chunk of provider.chat([{ role: "user", content: "hi" }])) {
      if (chunk.type === "text" && chunk.content) out.push(chunk.content);
    }
    expect(call).toBe(2);
    expect(out).toEqual(["ok"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/core -- llm/anthropic`
Expected: FAIL — `chat()` doesn't retry today, so the mocked `RateLimitError` on the first call
propagates uncaught.

- [ ] **Step 3: Wrap with `withLLMRetry`**

In `packages/core/src/llm/anthropic.ts`, add the imports:
```ts
import Anthropic, {
  RateLimitError,
  InternalServerError,
  APIConnectionError,
  APIConnectionTimeoutError,
} from "@anthropic-ai/sdk";
```
(replace the existing `import Anthropic from "@anthropic-ai/sdk";` line with this combined
default+named import.)

Also add:
```ts
import { withLLMRetry } from "./retry.js";
```

Add, near the bottom of the file:
```ts
function isAnthropicRetryable(err: unknown): boolean {
  return (
    err instanceof RateLimitError ||
    err instanceof InternalServerError ||
    err instanceof APIConnectionError ||
    err instanceof APIConnectionTimeoutError
  );
}
```

Change the last line of `chat()` from:
```ts
    yield* createStream();
```
to:
```ts
    yield* withLLMRetry(createStream, { isRetryable: isAnthropicRetryable });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/core -- llm/anthropic`
Expected: PASS (4 tests total in the file).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/llm/anthropic.ts packages/core/src/llm/anthropic.test.ts
git commit -m "feat(core): retry Anthropic stream creation on rate-limit/5xx/connection errors"
```

---

### Task 17: Anthropic provider — prompt caching

**Files:**
- Modify: `packages/core/src/llm/anthropic.ts`
- Test: `packages/core/src/llm/anthropic.test.ts`

**Interfaces:**
- Produces: `withCacheControl(message: MessageParam): MessageParam` (exported for direct testing).

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/llm/anthropic.test.ts`:
```ts
import { withCacheControl } from "./anthropic.js";

describe("withCacheControl", () => {
  it("wraps a plain string message into a single cache-breakpointed text block", () => {
    const out = withCacheControl({ role: "user", content: "hello" });
    expect(out.content).toEqual([
      { type: "text", text: "hello", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("adds cache_control only to the last block of a multi-block message", () => {
    const out = withCacheControl({
      role: "user",
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    });
    expect(out.content).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("leaves an empty-string message unchanged", () => {
    const msg = { role: "user" as const, content: "" };
    expect(withCacheControl(msg)).toBe(msg);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/core -- llm/anthropic`
Expected: FAIL — `withCacheControl` doesn't exist yet.

- [ ] **Step 3: Implement `withCacheControl` and wire it in**

In `packages/core/src/llm/anthropic.ts`, add near `toAnthropicMessage`:
```ts
/**
 * Attaches an ephemeral cache-control breakpoint: to the whole message when
 * its content is a plain string (wrapped into a single text block), or to
 * the LAST content block when it's already an array. Anthropic bills a
 * cache-read of everything up to and including a breakpoint at a steep
 * discount versus a fresh prompt, so this is placed on the system block
 * (below) and the trailing edge of history — both stable, prefix-cached
 * points per `ContextManager.assemble`'s structure.
 */
export function withCacheControl(message: MessageParam): MessageParam {
  if (typeof message.content === "string") {
    if (!message.content) return message; // nothing to cache-break on an empty message
    return {
      ...message,
      content: [
        { type: "text", text: message.content, cache_control: { type: "ephemeral" } },
      ],
    };
  }
  if (message.content.length === 0) return message;
  const content = [...message.content];
  const lastIndex = content.length - 1;
  content[lastIndex] = {
    ...content[lastIndex],
    cache_control: { type: "ephemeral" },
  } as (typeof content)[number];
  return { ...message, content };
}
```

Then in `chat()`, replace:
```ts
    const anthropicTools = tools?.map(toAnthropicTool);
    const params = opts?.params;

    const createStream = () =>
      mapAnthropicStream(
        this.client.messages.stream(
          {
            model: this.model,
            max_tokens: params?.maxTokens ?? 8192,
            temperature: params?.temperature,
            top_p: params?.topP,
            system: systemMessages.join("\n\n") || undefined,
            messages: chatMessages,
            tools: anthropicTools,
          },
          { signal: opts?.signal }
        )
      );
```
with:
```ts
    const anthropicTools = tools?.map(toAnthropicTool);
    const params = opts?.params;

    const systemText = systemMessages.join("\n\n");
    const systemBlocks: TextBlockParam[] = systemText
      ? [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }]
      : [];

    const cachedMessages =
      chatMessages.length > 0
        ? [
            ...chatMessages.slice(0, -1),
            withCacheControl(chatMessages[chatMessages.length - 1]),
          ]
        : chatMessages;

    const createStream = () =>
      mapAnthropicStream(
        this.client.messages.stream(
          {
            model: this.model,
            max_tokens: params?.maxTokens ?? 8192,
            temperature: params?.temperature,
            top_p: params?.topP,
            system: systemBlocks.length ? systemBlocks : undefined,
            messages: cachedMessages,
            tools: anthropicTools,
          },
          { signal: opts?.signal }
        )
      );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/core -- llm/anthropic`
Expected: PASS (7 tests total in the file).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/llm/anthropic.ts packages/core/src/llm/anthropic.test.ts
git commit -m "feat(core): Anthropic prompt caching on system + last history message"
```

---

### Task 18: `llm/index.ts` — export `withLLMRetry` and `complete`

**Files:**
- Modify: `packages/core/src/llm/index.ts`

- [ ] **Step 1: Add the exports**

Replace the contents of `packages/core/src/llm/index.ts`:
```ts
export { OpenAIProvider, type OpenAIProviderConfig } from "./openai.js";
export { AnthropicProvider, type AnthropicProviderConfig } from "./anthropic.js";
export { createLLMProvider, type LLMConfig, type ProviderType } from "./factory.js";
```
with:
```ts
export { OpenAIProvider, type OpenAIProviderConfig } from "./openai.js";
export { AnthropicProvider, type AnthropicProviderConfig } from "./anthropic.js";
export { createLLMProvider, type LLMConfig, type ProviderType } from "./factory.js";
export { withLLMRetry, type LLMRetryConfig } from "./retry.js";
export { complete } from "./complete.js";
```

- [ ] **Step 2: Verify it builds**

Run: `npm run build -w @lot-agent/core`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/llm/index.ts
git commit -m "chore(core): export withLLMRetry and complete from llm/index"
```

---

### Task 19: `agent/agent.ts` (+ `agents/types.ts`) — `modelParams` passthrough, thinking event, cachedPromptTokens

**Files:**
- Modify: `packages/core/src/agents/types.ts`
- Modify: `packages/core/src/agent/agent.ts`
- Test: `packages/core/src/agent/agent.test.ts`

**Interfaces:**
- Produces: `AgentDefinition.modelParams?: ChatParams` (consumed by Task 23);
  `AgentConfig.modelParams?: ChatParams` (consumed by Task 23); `AgentEvent` gains
  `{ type: "thinking"; content: string }` (consumed by Task 21, 23, 24); `AgentEvent`'s `done`
  variant gains `cachedPromptTokens: number` (consumed by Task 23).

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/agent/agent.test.ts`, extend the `scriptedLLM` helper (at the top of the file)
to also capture the `opts` each `chat()` call received — replace:
```ts
/** LLM that replays a script of chunk-lists; one list per chat() call. Records the messages it received. */
function scriptedLLM(script: ChatChunk[][]): LLMProvider & { calls: Message[][] } {
  let i = 0;
  const calls: Message[][] = [];
  return {
    calls,
    async *chat(messages: Message[]): AsyncIterable<ChatChunk> {
      calls.push(messages);
      const chunks =
        script[i++] ?? [
          { type: "done", usage: { promptTokens: 1, completionTokens: 1 } },
        ];
      for (const c of chunks) yield c;
    },
  };
}
```
with:
```ts
/** LLM that replays a script of chunk-lists; one list per chat() call. Records the messages and opts it received. */
function scriptedLLM(
  script: ChatChunk[][]
): LLMProvider & { calls: Message[][]; optsCalls: (ChatOptions | undefined)[] } {
  let i = 0;
  const calls: Message[][] = [];
  const optsCalls: (ChatOptions | undefined)[] = [];
  return {
    calls,
    optsCalls,
    async *chat(
      messages: Message[],
      _tools?: LLMTool[],
      opts?: ChatOptions
    ): AsyncIterable<ChatChunk> {
      calls.push(messages);
      optsCalls.push(opts);
      const chunks =
        script[i++] ?? [
          { type: "done", usage: { promptTokens: 1, completionTokens: 1 } },
        ];
      for (const c of chunks) yield c;
    },
  };
}
```

Add `ChatOptions` and `LLMTool` to the existing type import at the top of the file:
```ts
import type {
  ChatChunk,
  ChatOptions,
  LLMProvider,
  LLMTool,
  Message,
  Tool,
  ToolContext,
} from "../types/index.js";
```

Then append these three new tests (inside or after the existing `describe("Agent.run", ...)`
block — as a sibling `describe`):
```ts
describe("Agent.run — E1 additions", () => {
  it("forwards thinking chunks as AgentEvents without adding them to workingHistory", async () => {
    const llm = scriptedLLM([
      [
        { type: "thinking", content: "let me think..." },
        { type: "text", content: "answer" },
        { type: "done", usage: { promptTokens: 1, completionTokens: 1 } },
      ],
    ]);
    const agent = new Agent({ systemPrompt: "sys" });
    const events = await collect(agent.run("hi", makeContext(llm)));
    expect(events).toContainEqual({ type: "thinking", content: "let me think..." });
  });

  it("accumulates cachedPromptTokens from usage into the done event", async () => {
    const llm = scriptedLLM([
      [
        { type: "text", content: "hi" },
        {
          type: "done",
          usage: { promptTokens: 10, completionTokens: 5, cachedPromptTokens: 4 },
        },
      ],
    ]);
    const agent = new Agent({ systemPrompt: "sys" });
    const events = await collect(agent.run("hi", makeContext(llm)));
    const done = events.find((e) => e.type === "done") as { cachedPromptTokens: number };
    expect(done.cachedPromptTokens).toBe(4);
  });

  it("defaults cachedPromptTokens to 0 when usage omits it", async () => {
    const llm = scriptedLLM([textChunks("hi")]);
    const agent = new Agent({ systemPrompt: "sys" });
    const events = await collect(agent.run("hi", makeContext(llm)));
    const done = events.find((e) => e.type === "done") as { cachedPromptTokens: number };
    expect(done.cachedPromptTokens).toBe(0);
  });

  it("passes AgentConfig.modelParams through to llm.chat", async () => {
    const llm = scriptedLLM([textChunks("hi")]);
    const agent = new Agent({
      systemPrompt: "sys",
      modelParams: { temperature: 0.2, maxTokens: 500 },
    });
    await collect(agent.run("hi", makeContext(llm)));
    expect(llm.optsCalls[0]?.params).toEqual({ temperature: 0.2, maxTokens: 500 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/core -- agent/agent`
Expected: FAIL — `AgentConfig` has no `modelParams` field (type error), `AgentEvent` has no
`"thinking"` variant, and `done`'s payload has no `cachedPromptTokens`.

- [ ] **Step 3: Implement**

In `packages/core/src/agents/types.ts`, add the import and field. Replace:
```ts
export type AgentType = "general" | "copywriting" | "image" | "video" | "ppt" | "contract";

export interface AgentDefinition {
  id: string;
  name: string;
  type: AgentType;
  description: string;
  category?: string;          // 市场分组用,如 创作 / 办公 / 审核
  hidden?: boolean;           // 保持注册(旧会话仍可解析)但不在 Agent 中心展示/安装
  systemPrompt: string;
  toolNames: string[];        // allowed tool whitelist; empty array = no tools
  defaultModelId: string;     // e.g. "deepseek-v4-flash" (matches a configured model id)
  inputSchema?: Record<string, unknown>;
}
```
with:
```ts
import type { ChatParams } from "../types/index.js";

export type AgentType = "general" | "copywriting" | "image" | "video" | "ppt" | "contract";

export interface AgentDefinition {
  id: string;
  name: string;
  type: AgentType;
  description: string;
  category?: string;          // 市场分组用,如 创作 / 办公 / 审核
  hidden?: boolean;           // 保持注册(旧会话仍可解析)但不在 Agent 中心展示/安装
  systemPrompt: string;
  toolNames: string[];        // allowed tool whitelist; empty array = no tools
  defaultModelId: string;     // e.g. "deepseek-v4-flash" (matches a configured model id)
  inputSchema?: Record<string, unknown>;
  modelParams?: ChatParams;
}
```

In `packages/core/src/agent/agent.ts`:

1. Add `ChatParams` to the type import:
```ts
import type {
  ChatParams,
  Message,
  ContentPart,
  LLMProvider,
  ToolCall,
  ToolContext,
  ToolResult,
} from "../types/index.js";
```

2. Extend `AgentEvent` — replace:
```ts
/** Events emitted during agent execution */
export type AgentEvent =
  | { type: "text"; content: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; name: string; output: string; isError: boolean }
  | { type: "done"; iterations: number; totalTokens: number; inputTokens: number; outputTokens: number }
  | { type: "error"; message: string }
  | { type: "artifact"; assetId: string; url: string; mediaType: string };
```
with:
```ts
/** Events emitted during agent execution */
export type AgentEvent =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; name: string; output: string; isError: boolean }
  | {
      type: "done";
      iterations: number;
      totalTokens: number;
      inputTokens: number;
      outputTokens: number;
      cachedPromptTokens: number;
    }
  | { type: "error"; message: string }
  | { type: "artifact"; assetId: string; url: string; mediaType: string };
```

3. Add `modelParams` to `AgentConfig` — replace:
```ts
export interface AgentConfig {
  maxIterations: number;
  /** Wall-clock timeout for the entire agent run in ms. Default: 300000 (5 min) */
  maxRunTimeMs: number;
  systemPrompt: string;
  dynamicPromptParts?: string[];
  contextConfig?: ContextManagerConfig;
  /** Optional whitelist of tool names this agent is allowed to use. Undefined = all tools. */
  allowedToolNames?: string[];
}
```
with:
```ts
export interface AgentConfig {
  maxIterations: number;
  /** Wall-clock timeout for the entire agent run in ms. Default: 300000 (5 min) */
  maxRunTimeMs: number;
  systemPrompt: string;
  dynamicPromptParts?: string[];
  contextConfig?: ContextManagerConfig;
  /** Optional whitelist of tool names this agent is allowed to use. Undefined = all tools. */
  allowedToolNames?: string[];
  modelParams?: ChatParams;
}
```

4. Add a `cachedPromptTokens` accumulator and thread it through — replace:
```ts
    const tools = context.toolRegistry.toLLMTools(this.config.allowedToolNames);
    let iterations = 0;
    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
```
with:
```ts
    const tools = context.toolRegistry.toLLMTools(this.config.allowedToolNames);
    let iterations = 0;
    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedPromptTokens = 0;
```

5. Update the `done` closure — replace:
```ts
    const done = (): AgentEvent => ({
      type: "done",
      iterations,
      totalTokens,
      inputTokens,
      outputTokens,
    });
```
with:
```ts
    const done = (): AgentEvent => ({
      type: "done",
      iterations,
      totalTokens,
      inputTokens,
      outputTokens,
      cachedPromptTokens,
    });
```

6. Pass `modelParams` to `llm.chat` and handle the `thinking` chunk, and accumulate
`cachedPromptTokens` — replace:
```ts
        try {
          for await (const chunk of context.llm.chat(messages, tools, { signal })) {
            if (chunk.type === "text" && chunk.content) {
              assistantContent += chunk.content;
              yield { type: "text", content: chunk.content };
            }
            if (chunk.type === "tool_call" && chunk.toolCall) {
              hasToolCalls = true;
              toolCalls.push(chunk.toolCall);
            }
            if (chunk.type === "done" && chunk.usage) {
              totalTokens +=
                chunk.usage.promptTokens + chunk.usage.completionTokens;
              inputTokens += chunk.usage.promptTokens;
              outputTokens += chunk.usage.completionTokens;
            }
          }
        } catch (err) {
```
with:
```ts
        try {
          for await (const chunk of context.llm.chat(messages, tools, {
            signal,
            params: this.config.modelParams,
          })) {
            if (chunk.type === "thinking" && chunk.content) {
              yield { type: "thinking", content: chunk.content };
            }
            if (chunk.type === "text" && chunk.content) {
              assistantContent += chunk.content;
              yield { type: "text", content: chunk.content };
            }
            if (chunk.type === "tool_call" && chunk.toolCall) {
              hasToolCalls = true;
              toolCalls.push(chunk.toolCall);
            }
            if (chunk.type === "done" && chunk.usage) {
              totalTokens +=
                chunk.usage.promptTokens + chunk.usage.completionTokens;
              inputTokens += chunk.usage.promptTokens;
              outputTokens += chunk.usage.completionTokens;
              cachedPromptTokens += chunk.usage.cachedPromptTokens ?? 0;
            }
          }
        } catch (err) {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/core -- agent/agent`
Expected: PASS (all existing + 4 new tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agents/types.ts packages/core/src/agent/agent.ts packages/core/src/agent/agent.test.ts
git commit -m "feat(core): AgentDefinition.modelParams passthrough; thinking events; cachedPromptTokens on done"
```

---

### Task 20: Server — `message-repository.ts` — persist `thinking` into message metadata

**Files:**
- Modify: `packages/server/src/services/message-repository.ts`
- Test: `packages/server/src/services/message-repository.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/server/src/services/message-repository.test.ts`:
```ts
describe("saveAssistantWithToolCalls thinking metadata", () => {
  it("stores thinking text in metadata when provided", async () => {
    const db = memDb();
    const repo = new MessageRepository(db);
    const id = await repo.saveAssistantWithToolCalls("c1", "answer", [], "reasoning trace");
    const row = db.rows.find((r: any) => r.id === id);
    expect(row.metadata.thinking).toBe("reasoning trace");
  });

  it("writes empty metadata when no thinking is given", async () => {
    const db = memDb();
    const repo = new MessageRepository(db);
    const id = await repo.saveAssistantWithToolCalls("c1", "answer", []);
    const row = db.rows.find((r: any) => r.id === id);
    expect(row.metadata).toEqual({});
  });
});

describe("saveFinalAssistant thinking metadata", () => {
  it("stores thinking text in metadata when provided", async () => {
    const db = memDb();
    const repo = new MessageRepository(db);
    await repo.saveFinalAssistant("c1", "final answer", [], "final reasoning");
    const row = db.rows.find((r: any) => r.content === "final answer");
    expect(row.metadata.thinking).toBe("final reasoning");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/server -- message-repository`
Expected: FAIL — TypeScript error (extra 4th argument) or, if compiled loosely, the metadata simply
won't contain `thinking`.

- [ ] **Step 3: Add the `thinking` parameter**

In `packages/server/src/services/message-repository.ts`, replace:
```ts
  async saveAssistantWithToolCalls(
    conversationId: string,
    content: string,
    toolCalls: { id: string; name: string; arguments: unknown }[]
  ): Promise<string> {
    const assistantMsgId = randomUUID();
    await this.db.addMessage(
      assistantMsgId,
      conversationId,
      "assistant",
      content,
      { toolCallId: undefined }
    );
    for (const tc of toolCalls) {
      await this.db.addToolCall(assistantMsgId, tc.id, tc.name, tc.arguments);
    }
    return assistantMsgId;
  }
```
with:
```ts
  async saveAssistantWithToolCalls(
    conversationId: string,
    content: string,
    toolCalls: { id: string; name: string; arguments: unknown }[],
    thinking?: string
  ): Promise<string> {
    const assistantMsgId = randomUUID();
    await this.db.addMessage(
      assistantMsgId,
      conversationId,
      "assistant",
      content,
      { toolCallId: undefined, metadata: thinking ? { thinking } : {} }
    );
    for (const tc of toolCalls) {
      await this.db.addToolCall(assistantMsgId, tc.id, tc.name, tc.arguments);
    }
    return assistantMsgId;
  }
```

Replace:
```ts
  async saveFinalAssistant(
    conversationId: string,
    content: string,
    toolCalls: { id: string; name: string; arguments: unknown }[]
  ): Promise<void> {
    if (!content && toolCalls.length === 0) return;
    const assistantMsgId = randomUUID();
    await this.db.addMessage(
      assistantMsgId,
      conversationId,
      "assistant",
      content
    );
    for (const tc of toolCalls) {
      await this.db.addToolCall(assistantMsgId, tc.id, tc.name, tc.arguments);
    }
  }
```
with:
```ts
  async saveFinalAssistant(
    conversationId: string,
    content: string,
    toolCalls: { id: string; name: string; arguments: unknown }[],
    thinking?: string
  ): Promise<void> {
    if (!content && toolCalls.length === 0) return;
    const assistantMsgId = randomUUID();
    await this.db.addMessage(
      assistantMsgId,
      conversationId,
      "assistant",
      content,
      { metadata: thinking ? { thinking } : {} }
    );
    for (const tc of toolCalls) {
      await this.db.addToolCall(assistantMsgId, tc.id, tc.name, tc.arguments);
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/server -- message-repository`
Expected: PASS (all existing + 3 new tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/message-repository.ts packages/server/src/services/message-repository.test.ts
git commit -m "feat(server): persist thinking text into assistant message metadata"
```

---

### Task 21: Server — `sse-adapter.ts` — map the `thinking` event

**Files:**
- Modify: `packages/server/src/services/sse-adapter.ts`
- Test: `packages/server/src/services/sse-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/server/src/services/sse-adapter.test.ts`:
```ts
  it("maps thinking event", () => {
    expect(agentEventToSse({ type: "thinking", content: "reasoning..." })).toEqual({
      type: "thinking",
      content: "reasoning...",
    });
  });
```
(add this `it` inside the existing `describe("agentEventToSse", () => { ... })` block, alongside
the other event-mapping tests.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/server -- sse-adapter`
Expected: FAIL with a TypeScript compile error — `agentEventToSse`'s switch is exhaustive over
`AgentEvent`, and passing a `{ type: "thinking", ... }` literal where no such case exists is a type
mismatch (the object doesn't match any arm of the union the function's parameter type expects) —
this shows up as the whole file failing to type-check/run.

- [ ] **Step 3: Add the case**

In `packages/server/src/services/sse-adapter.ts`, replace:
```ts
export function agentEventToSse(event: AgentEvent): Record<string, unknown> {
  switch (event.type) {
    case "text":
      return { type: "text", content: event.content };
```
with:
```ts
export function agentEventToSse(event: AgentEvent): Record<string, unknown> {
  switch (event.type) {
    case "text":
      return { type: "text", content: event.content };
    case "thinking":
      return { type: "thinking", content: event.content };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/server -- sse-adapter`
Expected: PASS (all existing + 1 new test).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/sse-adapter.ts packages/server/src/services/sse-adapter.test.ts
git commit -m "feat(server): map the thinking AgentEvent to SSE"
```

---

### Task 22: Server — `trace-recorder.ts` — record `cachedPromptTokens`

**Files:**
- Modify: `packages/server/src/services/trace-recorder.ts`
- Test: `packages/server/src/services/trace-recorder.test.ts` (new file)

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/services/trace-recorder.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { TraceManager } from "@lot-agent/core";
import { TraceRecorder } from "./trace-recorder.js";

function fakeDb() {
  const traces: any[] = [];
  return {
    traces,
    addTrace: async (t: any) => {
      traces.push(t);
    },
    addSpan: async () => {},
  } as any;
}

describe("TraceRecorder.finish", () => {
  it("writes cachedPromptTokens into the persisted trace metadata when provided", async () => {
    const db = fakeDb();
    const tm = new TraceManager();
    const recorder = new TraceRecorder(tm, db, "claude-x", "anthropic");
    recorder.start("conv-1", "claude-x");
    await recorder.finish({ totalTokens: 100, cachedPromptTokens: 40 });
    expect(db.traces[0].metadata.cachedPromptTokens).toBe(40);
  });

  it("omits cachedPromptTokens from metadata when not provided", async () => {
    const db = fakeDb();
    const tm = new TraceManager();
    const recorder = new TraceRecorder(tm, db, "claude-x", "anthropic");
    recorder.start("conv-1", "claude-x");
    await recorder.finish({ totalTokens: 100 });
    expect(db.traces[0].metadata.cachedPromptTokens).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @lot-agent/server -- trace-recorder`
Expected: FAIL — `finish()` doesn't accept `cachedPromptTokens` today (TypeScript error on the first
test's call).

- [ ] **Step 3: Add the parameter**

In `packages/server/src/services/trace-recorder.ts`, replace:
```ts
  async finish(params: {
    totalTokens: number;
    errorMessage?: string;
  }): Promise<void> {
    // Close any still-open spans
    if (this.llmSpanId) this.traceManager.endSpan(this.llmSpanId);
    if (this.toolSpanId) this.traceManager.endSpan(this.toolSpanId);

    const hasError = params.errorMessage !== undefined;
    const latencyMs = Date.now() - this.requestStart;

    this.trace.metadata.totalTokens = params.totalTokens;
    if (hasError) {
      (this.trace.metadata as Record<string, unknown>).status = "error";
    }
    this.traceManager.endTrace(this.trace.id);
```
with:
```ts
  async finish(params: {
    totalTokens: number;
    cachedPromptTokens?: number;
    errorMessage?: string;
  }): Promise<void> {
    // Close any still-open spans
    if (this.llmSpanId) this.traceManager.endSpan(this.llmSpanId);
    if (this.toolSpanId) this.traceManager.endSpan(this.toolSpanId);

    const hasError = params.errorMessage !== undefined;
    const latencyMs = Date.now() - this.requestStart;

    this.trace.metadata.totalTokens = params.totalTokens;
    if (params.cachedPromptTokens !== undefined) {
      (this.trace.metadata as Record<string, unknown>).cachedPromptTokens =
        params.cachedPromptTokens;
    }
    if (hasError) {
      (this.trace.metadata as Record<string, unknown>).status = "error";
    }
    this.traceManager.endTrace(this.trace.id);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @lot-agent/server -- trace-recorder`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/trace-recorder.ts packages/server/src/services/trace-recorder.test.ts
git commit -m "feat(server): record cachedPromptTokens on the trace for observability"
```

---

### Task 23: Server — `agent-service.ts` wiring (modelParams, thinking accumulation, cachedPromptTokens → trace)

**Files:**
- Modify: `packages/server/src/services/agent-service.ts`

**Interfaces:**
- Consumes: `AgentDefinition.modelParams`, `AgentConfig.modelParams`, `AgentEvent` `"thinking"` +
  `done.cachedPromptTokens` from Task 19; `MessageRepository.saveAssistantWithToolCalls`/
  `saveFinalAssistant`'s new `thinking?` param from Task 20; `TraceRecorder.finish`'s new
  `cachedPromptTokens?` param from Task 22.

This task's imperative event-loop wiring follows this file's existing convention: complex decision
logic is extracted into small pure functions (e.g. `readPersistedSummary`, `buildFinalAssistantContent`)
which are unit-tested, while the streaming loop itself is exercised manually (there is no fake-DB
harness for a full `streamAgentResponse` run in this codebase — see `agent-service.*.test.ts`,
which each test one extracted pure helper). This task's changes are three straight-line
accumulator/passthrough edits with nothing worth extracting, so verification here is a build +
existing-suite regression check; true end-to-end verification happens in Task 24/25 when the web UI
can display the result.

- [ ] **Step 1: Pass `modelParams` when constructing the `Agent`**

In `packages/server/src/services/agent-service.ts`, find the `Agent` construction:
```ts
    const agent = new Agent({
      ...this.agentConfig,
      systemPrompt: def.systemPrompt,
      allowedToolNames: def.toolNames,
      dynamicPromptParts: dynamicParts,
      contextConfig: contextConfig
        ? { ...contextConfig, compressor: llm, initialSummary: persistedSummary }
        : undefined,
    });
```
Replace with:
```ts
    const agent = new Agent({
      ...this.agentConfig,
      systemPrompt: def.systemPrompt,
      allowedToolNames: def.toolNames,
      dynamicPromptParts: dynamicParts,
      modelParams: def.modelParams,
      contextConfig: contextConfig
        ? { ...contextConfig, compressor: llm, initialSummary: persistedSummary }
        : undefined,
    });
```

- [ ] **Step 2: Add a `currentThinking` accumulator alongside the existing tool-call accumulator**

Find:
```ts
    let assistantContent = "";
    let producedAssistantText = "";
    let currentToolCalls: { id: string; name: string; arguments: unknown }[] = [];
    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let lastErrorMessage: string | undefined;
```
Replace with:
```ts
    let assistantContent = "";
    let producedAssistantText = "";
    let currentToolCalls: { id: string; name: string; arguments: unknown }[] = [];
    let currentThinking = "";
    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedPromptTokens = 0;
    let lastErrorMessage: string | undefined;
```

- [ ] **Step 3: Accumulate thinking, thread it into both save points, reset per iteration, track cachedPromptTokens**

Find the event-handling loop:
```ts
      for await (const event of agent.run(runInput, context, history, { signal })) {
        if (event.type === "text") {
          recorder.startLlmSpan();
          assistantContent += event.content;
          producedAssistantText += event.content;
        }

        if (event.type === "tool_call") {
          recorder.endLlmSpan();
          recorder.startToolSpan(event.name);
          currentToolCalls.push({
            id: event.id,
            name: event.name,
            arguments: event.input,
          });
        }

        if (event.type === "tool_result") {
          recorder.endToolSpan(event.isError ? "error" : "ok");

          const matchingCall = currentToolCalls.find(
            (tc) => tc.name === event.name
          );

          if (currentToolCalls.length > 0) {
            // Save assistant message with tool calls, then the tool result
            await this.messageRepo.saveAssistantWithToolCalls(
              conversationId,
              assistantContent || "",
              currentToolCalls
            );
            await this.messageRepo.saveToolResult(
              conversationId,
              matchingCall?.id,
              event.output
            );

            assistantContent = "";
            currentToolCalls = [];
          }
        }

        if (event.type === "done") {
          totalTokens = event.totalTokens;
          inputTokens = event.inputTokens;
          outputTokens = event.outputTokens;
        }

        if (event.type === "error") {
          lastErrorMessage = event.message;
        }

        yield event;
      }
```
Replace with:
```ts
      for await (const event of agent.run(runInput, context, history, { signal })) {
        if (event.type === "thinking") {
          currentThinking += event.content;
        }

        if (event.type === "text") {
          recorder.startLlmSpan();
          assistantContent += event.content;
          producedAssistantText += event.content;
        }

        if (event.type === "tool_call") {
          recorder.endLlmSpan();
          recorder.startToolSpan(event.name);
          currentToolCalls.push({
            id: event.id,
            name: event.name,
            arguments: event.input,
          });
        }

        if (event.type === "tool_result") {
          recorder.endToolSpan(event.isError ? "error" : "ok");

          const matchingCall = currentToolCalls.find(
            (tc) => tc.name === event.name
          );

          if (currentToolCalls.length > 0) {
            // Save assistant message with tool calls, then the tool result
            await this.messageRepo.saveAssistantWithToolCalls(
              conversationId,
              assistantContent || "",
              currentToolCalls,
              currentThinking || undefined
            );
            await this.messageRepo.saveToolResult(
              conversationId,
              matchingCall?.id,
              event.output
            );

            assistantContent = "";
            currentToolCalls = [];
            currentThinking = "";
          }
        }

        if (event.type === "done") {
          totalTokens = event.totalTokens;
          inputTokens = event.inputTokens;
          outputTokens = event.outputTokens;
          cachedPromptTokens = event.cachedPromptTokens;
        }

        if (event.type === "error") {
          lastErrorMessage = event.message;
        }

        yield event;
      }
```

- [ ] **Step 4: Pass thinking into the final save, and cachedPromptTokens into the trace**

Find:
```ts
      const finalContent = buildFinalAssistantContent(
        assistantContent || "",
        lastErrorMessage,
        signal?.aborted ?? false
      );
      await this.messageRepo.saveFinalAssistant(
        conversationId,
        finalContent,
        currentToolCalls
      );
```
Replace with:
```ts
      const finalContent = buildFinalAssistantContent(
        assistantContent || "",
        lastErrorMessage,
        signal?.aborted ?? false
      );
      await this.messageRepo.saveFinalAssistant(
        conversationId,
        finalContent,
        currentToolCalls,
        currentThinking || undefined
      );
```

Find:
```ts
      // Finish trace + spans (with the ACTUAL error message, if any)
      await recorder.finish({ totalTokens, errorMessage: lastErrorMessage });
```
Replace with:
```ts
      // Finish trace + spans (with the ACTUAL error message, if any)
      await recorder.finish({ totalTokens, cachedPromptTokens, errorMessage: lastErrorMessage });
```

- [ ] **Step 5: Build and run the existing server suite**

Run: `npm run build -w @lot-agent/server`
Expected: PASS (Tasks 20 and 22 already added the `thinking?`/`cachedPromptTokens?` parameters these
calls now pass).

Run: `npm test -w @lot-agent/server`
Expected: PASS — no existing test constructs `AgentEvent.done` or calls
`saveAssistantWithToolCalls`/`saveFinalAssistant`/`recorder.finish` with a fixed arity that this
would break (the new parameters are additive).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/services/agent-service.ts
git commit -m "feat(server): thread modelParams, thinking accumulation, and cachedPromptTokens through the chat loop"
```

---

### Task 24: Web — `api/client.ts` + `hooks/useChat.ts` — thinking event wiring

**Files:**
- Modify: `packages/web/src/api/client.ts`
- Modify: `packages/web/src/hooks/useChat.ts`

**Interfaces:**
- Produces: `DisplayMessage.thinking?: string` (consumed by Task 25).

No automated test exists for hooks in this codebase (`packages/web` has no component/hook test
harness — see Global Constraints). Verification is manual: run the dev server and confirm thinking
content streams live and survives a reload.

- [ ] **Step 1: Add the SSE event type**

In `packages/web/src/api/client.ts`, replace:
```ts
export interface AgentEvent {
  type: "text" | "tool_call" | "tool_result" | "done" | "error" | "stream_end" | "artifact" | "title";
```
with:
```ts
export interface AgentEvent {
  type: "text" | "thinking" | "tool_call" | "tool_result" | "done" | "error" | "stream_end" | "artifact" | "title";
```

- [ ] **Step 2: Add `thinking` to `DisplayMessage` and accumulate it while streaming**

In `packages/web/src/hooks/useChat.ts`, replace:
```ts
export interface DisplayMessage {
  id: string;
  dbId?: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: { name: string; input: unknown }[];
  toolResult?: { name: string; output: string; isError: boolean };
  isStreaming?: boolean;
  rating?: number | null;
  attachments?: UploadedAttachment[];
  generation?: GenerationView;
}
```
with:
```ts
export interface DisplayMessage {
  id: string;
  dbId?: string;
  role: "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  toolCalls?: { name: string; input: unknown }[];
  toolResult?: { name: string; output: string; isError: boolean };
  isStreaming?: boolean;
  rating?: number | null;
  attachments?: UploadedAttachment[];
  generation?: GenerationView;
}
```

In the SSE handler inside `streamMessage`, find:
```ts
        api.sendMessage(cid, content, async (event) => {
        if (event.type === "text" && event.content) {
          assistantMsg = {
            ...assistantMsg,
            content: assistantMsg.content + event.content,
          };
          if (isCurrent())
            setMessages((prev) => {
              const filtered = prev.filter((m) => m.id !== assistantMsg.id);
              return [...filtered, assistantMsg];
            });
        }
```
Replace with:
```ts
        api.sendMessage(cid, content, async (event) => {
        if (event.type === "thinking" && event.content) {
          assistantMsg = {
            ...assistantMsg,
            thinking: (assistantMsg.thinking ?? "") + event.content,
          };
          if (isCurrent())
            setMessages((prev) => {
              const filtered = prev.filter((m) => m.id !== assistantMsg.id);
              return [...filtered, assistantMsg];
            });
        }

        if (event.type === "text" && event.content) {
          assistantMsg = {
            ...assistantMsg,
            content: assistantMsg.content + event.content,
          };
          if (isCurrent())
            setMessages((prev) => {
              const filtered = prev.filter((m) => m.id !== assistantMsg.id);
              return [...filtered, assistantMsg];
            });
        }
```
(the subsequent `tool_result` handler already replaces `assistantMsg` with a brand-new object
literal for the next iteration, so `thinking` resets to `undefined` there automatically — no extra
change needed for the reset.)

- [ ] **Step 3: Read `thinking` back from persisted metadata**

In `loadMessages`, find:
```ts
      return {
        id: m.id,
        dbId: m.id,
        role,
        content: m.content,
        attachments:
          role === "user"
            ? (parsedMeta?.attachments as UploadedAttachment[] | undefined)
            : undefined,
        toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : undefined,
        toolResult:
          role === "tool"
            ? { name: toolName ?? "tool", output: m.content, isError: false }
            : undefined,
        rating: m.rating ?? null,
        generation: gen,
      };
```
Replace with:
```ts
      return {
        id: m.id,
        dbId: m.id,
        role,
        content: m.content,
        thinking: parsedMeta?.thinking as string | undefined,
        attachments:
          role === "user"
            ? (parsedMeta?.attachments as UploadedAttachment[] | undefined)
            : undefined,
        toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : undefined,
        toolResult:
          role === "tool"
            ? { name: toolName ?? "tool", output: m.content, isError: false }
            : undefined,
        rating: m.rating ?? null,
        generation: gen,
      };
```

- [ ] **Step 4: Type-check the web package**

Run: `npm run build -w @lot-agent/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api/client.ts packages/web/src/hooks/useChat.ts
git commit -m "feat(web): accumulate and persist thinking content in useChat"
```

---

### Task 25: Web — `MessageBubble.tsx` — render the thinking card

**Files:**
- Modify: `packages/web/src/components/MessageBubble.tsx`

**Interfaces:**
- Consumes: `DisplayMessage.thinking` from Task 24.

- [ ] **Step 1: Widen `CollapsibleToolCard`'s `type` prop and icon/label logic**

In `packages/web/src/components/MessageBubble.tsx`, replace:
```ts
function CollapsibleToolCard({
  title,
  type,
  isError,
  defaultCollapsed = false,
  children,
}: {
  title: string;
  type: "call" | "result";
  isError?: boolean;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const hasContent = React.Children.count(children) > 0;

  return (
    <div
      className={`tool-card ${type} ${isError ? "error" : ""} ${collapsed ? "collapsed" : ""}`}
    >
      <div
        className="tool-card-header clickable"
        onClick={() => setCollapsed((v) => !v)}
      >
        <span className="tool-card-chevron">{collapsed ? "▶" : "▼"}</span>
        <span className="tool-card-icon">
          {type === "call" ? "⚙" : isError ? "✕" : "✓"}
        </span>
        <span className="tool-card-title">{title}</span>
        <span className="tool-card-type">
          {type === "call" ? "calling" : "result"}
        </span>
      </div>
      {!collapsed && hasContent && (
        <div className="tool-card-body">{children}</div>
      )}
    </div>
  );
}
```
with:
```ts
function CollapsibleToolCard({
  title,
  type,
  isError,
  defaultCollapsed = false,
  children,
}: {
  title: string;
  type: "call" | "result" | "thinking";
  isError?: boolean;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const hasContent = React.Children.count(children) > 0;

  return (
    <div
      className={`tool-card ${type} ${isError ? "error" : ""} ${collapsed ? "collapsed" : ""}`}
    >
      <div
        className="tool-card-header clickable"
        onClick={() => setCollapsed((v) => !v)}
      >
        <span className="tool-card-chevron">{collapsed ? "▶" : "▼"}</span>
        <span className="tool-card-icon">
          {type === "call" ? "⚙" : type === "thinking" ? "💭" : isError ? "✕" : "✓"}
        </span>
        <span className="tool-card-title">{title}</span>
        <span className="tool-card-type">
          {type === "call" ? "calling" : type === "thinking" ? "thinking" : "result"}
        </span>
      </div>
      {!collapsed && hasContent && (
        <div className="tool-card-body">{children}</div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Render the thinking card before the message content**

In the assistant-message render branch, find:
```ts
  return (
    <div className="message-wrapper message-assistant">
      <div className="message-wrapper-inner">
        {/* Message content — click to open in preview */}
        {(() => {
```
Replace with:
```ts
  return (
    <div className="message-wrapper message-assistant">
      <div className="message-wrapper-inner">
        {message.thinking && (
          <CollapsibleToolCard
            title="思考过程"
            type="thinking"
            defaultCollapsed={!!message.dbId}
          >
            <pre className="tool-output">{message.thinking}</pre>
          </CollapsibleToolCard>
        )}
        {/* Message content — click to open in preview */}
        {(() => {
```

- [ ] **Step 3: Type-check the web package**

Run: `npm run build -w @lot-agent/web`
Expected: PASS.

- [ ] **Step 4: Manually verify in the browser**

Run: `npm run dev` (repo root — starts core watch + server + worker + web)

In the browser:
1. Open the chat UI, pick a reasoning-capable model (a DeepSeek-R model, or an Anthropic model with
   `AgentDefinition.modelParams.reasoning` set — note: nothing currently sets that field on any
   built-in `AgentDefinition`, so if none is configured yet, this step confirms only that the UI
   *doesn't break* when `thinking` is absent; wiring an actual reasoning-enabled agent definition is
   out of this plan's scope).
2. Send a message. Confirm no console errors and the assistant reply still streams and renders
   normally (regression check — this is the main risk of this task, since every assistant message
   now runs through the widened `CollapsibleToolCard`).
3. If a reasoning-capable model is available: confirm a 💭 "思考过程" card appears above the reply,
   expanded while streaming, and confirm it collapses after reloading the conversation (persisted
   via `metadata.thinking`).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/MessageBubble.tsx
git commit -m "feat(web): render a collapsible thinking card above the assistant reply"
```

---

## Post-plan regression check

After all 25 tasks:

- [ ] Run: `npm run build` (repo root — builds all workspaces)
  Expected: PASS
- [ ] Run: `npm test` (repo root — runs the full Vitest suite across workspaces)
  Expected: PASS
