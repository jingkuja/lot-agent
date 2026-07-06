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
      json: async () => ({ code: "fail_to_fetch_task", message: '{"error":{"message":"当前账号处未订购seedance2.0模型资费包"}}', data: null }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const c = new HttpGenerationClient({ baseUrl: "https://api", apiKey: "k", adapter: taskIdAdapter, model: "m" });
    await expect(c.create({})).rejects.toThrow(/未订购seedance2\.0/);
  });
  it("returns the task when a create response carries a task id", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ task_id: "task_1", status: "queued" }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const c = new HttpGenerationClient({ baseUrl: "https://api", apiKey: "k", adapter: taskIdAdapter, model: "m" });
    expect(await c.create({})).toEqual({ taskId: "task_1", status: "queued", progress: 0 });
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
});
