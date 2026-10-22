import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseSize,
  extractVendorError,
  isRealPersonRejection,
  HttpGenerationClient,
  type VendorAdapter,
} from "./generation-common.js";
import type { ProviderError } from "./provider-error.js";

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

// Shape reported by tokenhub, with the vendor error code prefix masked.
const REAL_PERSON_BODY = `status_code=400, ${JSON.stringify({
  code: "fail_to_fetch_task",
  message: JSON.stringify({ error: { code: "***.PrivacyInformation", message: "The request failed because the input image 'content[0]' may contain real person. Request id: 0217", param: "content[0]", type: "BadRequest" } }),
  data: null,
})}`;

describe("isRealPersonRejection", () => {
  it("matches masked codes and the leaf message at any nesting depth", () => {
    expect(isRealPersonRejection(REAL_PERSON_BODY)).toBe(true);
    expect(isRealPersonRejection({ error: { message: JSON.stringify({ code: "InputImageSensitiveContentDetected.PrivacyInformation" }) } })).toBe(true);
    expect(isRealPersonRejection({ code: "fail_to_fetch_task", message: "当前账号处未订购seedance2.0模型资费包" })).toBe(false);
  });
});

describe("extractVendorError", () => {
  it("replaces a nested vendor error envelope with a fixed safe category", () => {
    const msg = extractVendorError({
      code: "fail_to_fetch_task",
      message: '{"error":{"message":"当前账号处未订购seedance2.0模型资费包","type":"proxy_error"}}',
      data: null,
    });
    expect(msg).toContain("TASK_FAILED");
    expect(msg).not.toContain("未订购seedance2.0");
  });
  it("falls back to the code when no message is present", () => {
    expect(extractVendorError({ code: "fail_to_fetch_task" })).toContain("TASK_FAILED");
  });
  it("classifies a real-person rejection without copying the vendor text", () => {
    const msg = extractVendorError({ code: "fail_to_fetch_task", message: REAL_PERSON_BODY, data: null });
    expect(msg).toContain("REAL_PERSON_REJECTED");
    expect(msg).toContain("真人认证");
    expect(msg).not.toContain("content[0]");
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
  it("returns a safe invalid-response error when a 200 create has no task id", async () => {
    // tokenhub can return a create failure as HTTP 200 with an error envelope and
    // no task_id. Without a task id there is nothing to poll, so it must surface
    // as a failure carrying the vendor message — not a queued task with an empty id.
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ code: "fail_to_fetch_task", message: '{"error":{"message":"当前账号处未订购seedance2.0模型资费包"}}', data: null }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const c = new HttpGenerationClient({ baseUrl: "https://api", apiKey: "k", adapter: taskIdAdapter, model: "m" });
    await expect(c.create({})).rejects.toThrow("INVALID_RESPONSE");
  });
  it("classifies a non-JSON HTTP 400 real-person rejection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, text: async () => REAL_PERSON_BODY })) as unknown as typeof fetch);
    const c = new HttpGenerationClient({ baseUrl: "https://api", apiKey: "k", adapter: taskIdAdapter, model: "m" });
    const err = await c.create({}).catch(e => e as Error);
    expect(err.message).toContain("REAL_PERSON_REJECTED");
    expect(err.message).not.toContain("content[0]");
  });
  it("keeps the gateway request ID of a failed create", async () => {
    const headers = new Headers({ "x-oneapi-request-id": "20261022054753752798000zwvf9kakt1kd2rFO" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, headers, text: async () => JSON.stringify({ error: { code: "upstream_error" } }) })) as unknown as typeof fetch);
    const c = new HttpGenerationClient({ baseUrl: "https://api", apiKey: "k", adapter: taskIdAdapter, model: "m" });
    const err = await c.create({}).then(() => undefined, (e: ProviderError) => e);
    expect(err).toMatchObject({ code: "HTTP_ERROR", httpStatus: 500, gatewayRequestId: "20261022054753752798000zwvf9kakt1kd2rFO" });
    expect(err?.message).not.toContain("20261022054753752798000zwvf9kakt1kd2rFO");
  });
  it("returns the task when a create response carries a task id", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({ task_id: "task_1", status: "queued" }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const c = new HttpGenerationClient({ baseUrl: "https://api", apiKey: "k", adapter: taskIdAdapter, model: "m" });
    expect(await c.create({})).toEqual({ taskId: "task_1", status: "queued", progress: 0 });
  });
  it("reports a missing task id without exposing the raw response body", async () => {
    const rawBody = JSON.stringify({ object: "video", status: "queued", progress: 0 });
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => rawBody }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const c = new HttpGenerationClient({ baseUrl: "https://api", apiKey: "k", adapter: taskIdAdapter, model: "m" });
    await expect(c.create({})).rejects.toThrow("INVALID_RESPONSE");
  });
  it("marks a create that never connected as CONNECT_ERROR and keeps sent requests ambiguous", async () => {
    const failure = (cause: unknown) => Object.assign(new TypeError("fetch failed"), { cause });
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const cases: [unknown, string][] = [
      [failure(refused), "CONNECT_ERROR"],
      [failure(Object.assign(new AggregateError([refused, refused]), { code: "ECONNREFUSED" })), "CONNECT_ERROR"],
      [failure(Object.assign(new AggregateError([refused, { code: "ECONNRESET" }]), { code: "ECONNREFUSED" })), "TRANSPORT_ERROR"],
      [failure(Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" })), "TRANSPORT_ERROR"],
      [failure(Object.assign(new Error("reset"), { code: "ECONNRESET" })), "TRANSPORT_ERROR"],
      [new DOMException("timed out", "TimeoutError"), "TRANSPORT_ERROR"],
    ];
    for (const [error, code] of cases) {
      vi.stubGlobal("fetch", vi.fn(async () => { throw error; }) as unknown as typeof fetch);
      const c = new HttpGenerationClient({ baseUrl: "https://api", apiKey: "k", adapter: taskIdAdapter, model: "m" });
      await expect(c.create({})).rejects.toThrow(`create，${code}`);
    }
  });
  it("reports a malformed response without exposing unstructured text", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => "<html>gateway hiccup</html>" }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const c = new HttpGenerationClient({ baseUrl: "https://api", apiKey: "k", adapter: taskIdAdapter, model: "m" });
    await expect(c.create({})).rejects.toThrow("INVALID_RESPONSE");
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
    expect(r.failureUnconfirmed).toBe(true);
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
    await expect(c.poll("t1")).rejects.toThrow("TRANSPORT_ERROR");
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
    await expect(c.create({})).rejects.toThrow("TRANSPORT_ERROR");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("logs operation metadata without request, response, prompt, URL or credentials", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const body = { prompt: "private portrait prompt", input_reference: ["https://media.example/private.png?material_token=secret-capability"] };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ task_id: "t", request: body, secret: "private-response" }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const c = new HttpGenerationClient({ baseUrl: "https://private-endpoint.example", apiKey: "private-api-key", adapter: { ...adapter, buildCreateBody: () => body }, model: "m" });
    await c.create({});
    expect(log.mock.calls).toEqual([
      ["[generation.create] request", { method: "POST" }],
      ["[generation.create] response", { status: 200 }],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves a safe upstream diagnostic while hiding echoed prompt, URL and key", async () => {
    const body = { prompt: "private portrait prompt", input_reference: ["https://media.example/private.png?material_token=secret-capability"] };
    const fetchMock = vi.fn(async () => ({ ok: false, status: 422, text: async () => JSON.stringify({
      message: `Invalid reference: ${body.prompt}; ${body.input_reference[0]}; Bearer private-api-key`,
      request: body,
    }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const c = new HttpGenerationClient({ baseUrl: "https://api", apiKey: "private-api-key", adapter: { ...adapter, buildCreateBody: () => body }, model: "m" });
    const error = await c.create({}).then((): never => { throw new Error("expected create failure"); }, (error: Error) => error);
    expect(error.message).toContain("HTTP 422");
    expect(error.message).not.toContain("Invalid reference");
    for (const privateValue of [body.prompt, body.input_reference[0], "private-api-key", "secret-capability", "request"]) expect(error.message).not.toContain(privateValue);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("omits a raw error page on a failed poll", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 503, text: async () => "<html>private-content https://media.example/secret?material_token=secret</html>" }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const c = new HttpGenerationClient({ baseUrl: "https://api", apiKey: "private-api-key", adapter, model: "m" });
    await expect(c.poll("t")).rejects.toThrow("HTTP 503");
  });
});
