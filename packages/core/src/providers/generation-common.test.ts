import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseSize,
  extractVendorError,
  HttpGenerationClient,
  type VendorAdapter,
} from "./generation-common.js";

describe("parseSize", () => {
  it("parses WxH", () => {
    expect(parseSize("1024x768")).toEqual([1024, 768]);
  });
  it("parses W*H (chat-completions size format)", () => {
    expect(parseSize("2688*1536")).toEqual([2688, 1536]);
  });
  it("defaults to 1024x1024 for missing / malformed", () => {
    expect(parseSize(undefined)).toEqual([1024, 1024]);
    expect(parseSize("huge")).toEqual([1024, 1024]);
  });
});

describe("extractVendorError", () => {
  it("digs the innermost message out of a nested JSON-string envelope", () => {
    const msg = extractVendorError({
      code: "fail_to_fetch_task",
      message: '{"error":{"message":"当前账号处未订购seedance2.0模型资费包","type":"proxy_error"}}',
      data: null,
    });
    expect(msg).toContain("未订购seedance2.0");
  });
  it("falls back to the code when no message is present", () => {
    expect(extractVendorError({ code: "fail_to_fetch_task" })).toBe("fail_to_fetch_task");
  });
  it("returns undefined for a normal in-progress response", () => {
    expect(extractVendorError({ status: "processing", progress: 30 })).toBeUndefined();
  });
});

describe("HttpGenerationClient.create", () => {
  afterEach(() => vi.restoreAllMocks());
  // Adapter that reads the vendor task id the way the real happyhorse adapters
  // do — empty string when neither task_id nor id is present.
  const taskIdAdapter: VendorAdapter<{ model?: string }> = {
    createPath: () => "/create",
    pollPath: (id) => `/poll/${id}`,
    buildCreateBody: () => ({}),
    parseCreate: (json) => {
      const j = (json ?? {}) as Record<string, unknown>;
      return { taskId: String(j.task_id ?? j.id ?? ""), status: String(j.status ?? "queued"), progress: 0 };
    },
    parsePoll: () => ({ status: "processing", progress: 0 }),
    isTerminal: () => null,
  };
  it("throws the vendor message when a 200 create response carries no task id", async () => {
    // tokenhub can return a create failure as HTTP 200 with an error envelope and
    // no task_id. Without a task id there is nothing to poll, so it must surface
    // as a failure carrying the vendor message — not a queued task with an empty id.
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ code: "fail_to_fetch_task", message: '{"error":{"message":"当前账号处未订购seedance2.0模型资费包"}}', data: null }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const c = new HttpGenerationClient({ baseUrl: "https://api", apiKey: "k", adapter: taskIdAdapter, model: "m" });
    await expect(c.create({})).rejects.toThrow(/未订购seedance2\.0/);
  });
  it("returns the task when a create response carries a task id", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({ task_id: "task_1", status: "queued" }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const c = new HttpGenerationClient({ baseUrl: "https://api", apiKey: "k", adapter: taskIdAdapter, model: "m" });
    expect(await c.create({})).toEqual({ taskId: "task_1", status: "queued", progress: 0 });
  });
  it("carries the RAW response body in the error when no task id comes back", async () => {
    // A 200 body with no task_id and no vendor error envelope must still fail —
    // and the thrown error must contain the raw payload so the UI shows it on hover.
    const rawBody = JSON.stringify({ object: "video", status: "queued", progress: 0 });
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => rawBody }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const c = new HttpGenerationClient({ baseUrl: "https://api", apiKey: "k", adapter: taskIdAdapter, model: "m" });
    await expect(c.create({})).rejects.toThrow(rawBody);
  });
  it("fails with the raw text when a 2xx body is not JSON", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => "<html>gateway hiccup</html>" }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const c = new HttpGenerationClient({ baseUrl: "https://api", apiKey: "k", adapter: taskIdAdapter, model: "m" });
    await expect(c.create({})).rejects.toThrow(/gateway hiccup/);
  });
});

describe("HttpGenerationClient.poll", () => {
  afterEach(() => vi.restoreAllMocks());
  // An adapter that classifies nothing and reports whatever status it's given —
  // used to prove the client itself won't loop forever on a statusless response.
  const passthrough: VendorAdapter<{ model?: string }> = {
    createPath: () => "/create",
    pollPath: (id) => `/poll/${id}`,
    buildCreateBody: () => ({}),
    parseCreate: () => ({ taskId: "t", status: "queued", progress: 0 }),
    parsePoll: (json) => {
      const j = (json ?? {}) as Record<string, unknown>;
      return { status: String(j.status ?? ""), progress: 0 };
    },
    isTerminal: () => null,
  };
  it("treats a missing status as failed, not 'running'", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ weird: true }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const c = new HttpGenerationClient({ baseUrl: "https://api", apiKey: "k", adapter: passthrough, model: "m" });
    const r = await c.poll("t1");
    expect(r.status).toBe("failed");
  });
  it("still maps a real non-terminal status to 'running'", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ status: "processing" }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const c = new HttpGenerationClient({ baseUrl: "https://api", apiKey: "k", adapter: passthrough, model: "m" });
    const r = await c.poll("t1");
    expect(r.status).toBe("running");
  });

  it("retries once on a network error (poll is an idempotent read)", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "processing" }) });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const c = new HttpGenerationClient({ baseUrl: "https://api", apiKey: "k", adapter: passthrough, model: "m" });
    const r = await c.poll("t1");
    expect(r.status).toBe("running");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after one retry and surfaces the network error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const c = new HttpGenerationClient({ baseUrl: "https://api", apiKey: "k", adapter: passthrough, model: "m" });
    await expect(c.poll("t1")).rejects.toThrow(/ECONNRESET/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("passes an abort signal to fetch (request timeout)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ status: "processing" }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const c = new HttpGenerationClient({ baseUrl: "https://api", apiKey: "k", adapter: passthrough, model: "m" });
    await c.poll("t1");
    const init = fetchMock.mock.calls[0][1] as { signal?: unknown };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("HttpGenerationClient.create hardening", () => {
  afterEach(() => vi.restoreAllMocks());
  const adapter: VendorAdapter<{ model?: string }> = {
    createPath: () => "/create",
    pollPath: (id) => `/poll/${id}`,
    buildCreateBody: () => ({}),
    parseCreate: () => ({ taskId: "t", status: "queued", progress: 0 }),
    parsePoll: () => ({ status: "processing", progress: 0 }),
    isTerminal: () => null,
  };
  it("does NOT retry a network error (create is not idempotent)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const c = new HttpGenerationClient({ baseUrl: "https://api", apiKey: "k", adapter, model: "m" });
    await expect(c.create({})).rejects.toThrow(/ECONNRESET/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
