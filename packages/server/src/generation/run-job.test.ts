import { describe, it, expect, vi } from "vitest";
import { runGenerationJob, JobCancelledError, type RunJobDeps, type JobGenerationProvider } from "./run-job.js";

function fakeDeps(provider: JobGenerationProvider, over: Partial<RunJobDeps> = {}): { deps: RunJobDeps; calls: any } {
  const calls: any = { progress: [], asset: null, message: [], metered: false, cacheSet: null, vendorIdSet: null };
  const deps: RunJobDeps = {
    provider,
    storage: { put: vi.fn(async ({ key }) => ({ url: `/static/assets/${key}` })) },
    db: {
      createAsset: vi.fn(async (a) => { calls.asset = a; }),
      updateMessageGeneration: vi.fn(async (id, patch) => { calls.message.push({ id, ...patch }); }),
      getTaskVendorId: vi.fn(async () => null),
      setTaskVendorId: vi.fn(async (_id, v) => { calls.vendorIdSet = v; }),
      getTaskStatus: vi.fn(async () => "running"),
    },
    meter: { record: vi.fn(async () => { calls.metered = true; }) },
    cache: { get: vi.fn(async () => null), set: vi.fn(async (_k, v) => { calls.cacheSet = v; }) },
    updateProgress: vi.fn(async (_id, p) => { calls.progress.push(p); }),
    urlToBytes: vi.fn(async (_url: string, _opts?: { signal?: AbortSignal }) => ({ body: Buffer.from("x"), mime: "image/svg+xml" })),
    extFor: () => "svg",
    modelId: "wanx-standard",
    vendorModel: "im",
    sleep: async () => {},
    pollIntervalMs: 0,
    ...over,
  };
  return { deps, calls };
}

const job = { id: "job1", userId: "u1", input: { prompt: "菊花", conversationId: "c1", assistantMessageId: "m1", size: "1024x1024" } };

describe("runGenerationJob", () => {
  it("creates, polls to completion, stores asset, relays progress, marks message completed", async () => {
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "queued", progress: 0 })),
      poll: vi.fn()
        .mockResolvedValueOnce({ status: "processing", progress: 40 })
        .mockResolvedValueOnce({ status: "completed", progress: 100, url: "data:image/svg+xml;base64,Zm9v" }),
    };
    const { deps, calls } = fakeDeps(provider);
    const out = await runGenerationJob(deps, job, "image");
    expect(out.assets).toHaveLength(1);
    expect(calls.progress).toEqual([40, 100, 100]);
    expect(calls.asset.userId).toBe("u1");
    expect(calls.message.at(-1)).toMatchObject({ id: "m1", status: "completed" });
    expect(calls.metered).toBe(true);
  });

  it("marks message failed and rethrows when poll returns failed", async () => {
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "failed", progress: 50, error: "boom" })),
    };
    const { deps, calls } = fakeDeps(provider);
    await expect(runGenerationJob(deps, job, "image")).rejects.toThrow(/boom/);
    expect(calls.message.at(-1)).toMatchObject({ id: "m1", status: "failed" });
  });

  it("marks the message failed and preserves the create response for the UI tooltip", async () => {
    const rawResponse = '{"id":"task_1","object":"video","status":"queued","progress":0}';
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => { throw new Error(`未返回任务ID：${rawResponse}`); }),
      poll: vi.fn(),
    };
    const { deps, calls } = fakeDeps(provider);
    await expect(runGenerationJob(deps, job, "video")).rejects.toThrow(rawResponse);
    expect(provider.poll).not.toHaveBeenCalled();
    expect(calls.message.at(-1)).toMatchObject({ id: "m1", status: "failed" });
    expect(calls.message.at(-1).metadata.error).toContain(rawResponse);
  });

  it("persists the vendor task id after create, then polls with it", async () => {
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "vendor_abc", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "completed", progress: 100, url: "data:image/svg+xml;base64,Zm9v" })),
    };
    const { deps, calls } = fakeDeps(provider);
    await runGenerationJob(deps, job, "image");
    expect(deps.db.setTaskVendorId).toHaveBeenCalledWith("job1", "vendor_abc");
    expect(calls.vendorIdSet).toBe("vendor_abc");
    expect(provider.poll).toHaveBeenCalledWith("vendor_abc");
  });

  it("resumes polling with the stored vendor task id without re-creating", async () => {
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "should_not_be_used", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "completed", progress: 100, url: "data:image/svg+xml;base64,Zm9v" })),
    };
    const { deps } = fakeDeps(provider);
    deps.db.getTaskVendorId = vi.fn(async () => "vendor_existing");
    await runGenerationJob(deps, job, "image");
    expect(provider.create).not.toHaveBeenCalled();
    expect(deps.db.setTaskVendorId).not.toHaveBeenCalled();
    expect(provider.poll).toHaveBeenCalledWith("vendor_existing");
  });

  it("scopes every message update to the job's conversation and user", async () => {
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "completed", progress: 100, url: "data:image/svg+xml;base64,Zm9v" })),
    };
    const { deps } = fakeDeps(provider);
    await runGenerationJob(deps, job, "image");
    expect(deps.db.updateMessageGeneration).toHaveBeenCalled();
    for (const call of (deps.db.updateMessageGeneration as any).mock.calls) {
      expect(call[2]).toEqual({ conversationId: "c1", userId: "u1" });
    }
  });

  it("never updates a message when the input carries no server-set conversationId", async () => {
    // A standalone /tasks job has no message; a forged assistantMessageId
    // without the server-injected conversationId must not reach the DB.
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "completed", progress: 100, url: "data:image/svg+xml;base64,Zm9v" })),
    };
    const { deps } = fakeDeps(provider);
    const forged = { id: "job2", userId: "u1", input: { prompt: "菊花", assistantMessageId: "victim-message" } };
    await runGenerationJob(deps, forged, "image");
    expect(deps.db.updateMessageGeneration).not.toHaveBeenCalled();
  });

  it("stops polling and marks the message cancelled when the task row is cancelled", async () => {
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "processing", progress: 10 })),
    };
    const { deps, calls } = fakeDeps(provider, { maxWaitMs: 200 });
    // First status check sees the cancellation written by the server process.
    deps.db.getTaskStatus = vi.fn(async () => "cancelled");
    await expect(runGenerationJob(deps, job, "image")).rejects.toBeInstanceOf(JobCancelledError);
    expect(calls.message.at(-1)).toMatchObject({ id: "m1", status: "cancelled" });
    expect(calls.metered).toBe(false);
  });

  it("stops mid-poll once the task row flips to cancelled", async () => {
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "processing", progress: 10 })),
    };
    const { deps, calls } = fakeDeps(provider, { maxWaitMs: 200 });
    const statuses = ["running", "cancelled"];
    deps.db.getTaskStatus = vi.fn(async () => statuses.shift() ?? "cancelled");
    await expect(runGenerationJob(deps, job, "image")).rejects.toBeInstanceOf(JobCancelledError);
    expect(calls.message.at(-1)).toMatchObject({ status: "cancelled" });
    // Polling must not continue for the full 15-minute budget after cancel.
    expect((provider.poll as any).mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("honors an in-process abort signal", async () => {
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "processing", progress: 10 })),
    };
    const controller = new AbortController();
    controller.abort();
    const { deps, calls } = fakeDeps(provider, { signal: controller.signal, maxWaitMs: 200 });
    await expect(runGenerationJob(deps, job, "image")).rejects.toBeInstanceOf(JobCancelledError);
    expect(calls.message.at(-1)).toMatchObject({ status: "cancelled" });
    expect(provider.create).not.toHaveBeenCalled();
  });

  it("forwards the in-process abort signal through to urlToBytes on download", async () => {
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "completed", progress: 100, url: "https://vendor.example/out.png" })),
    };
    const controller = new AbortController();
    const { deps } = fakeDeps(provider, { signal: controller.signal });
    await runGenerationJob(deps, job, "image");
    expect(deps.urlToBytes).toHaveBeenCalledWith("https://vendor.example/out.png", { signal: controller.signal });
  });

  it("uses cache hit without creating/polling", async () => {
    const provider: JobGenerationProvider = { create: vi.fn(), poll: vi.fn() };
    const cached = { assetIds: ["a"], assets: [{ url: "/static/assets/a.svg", mime: "image/svg+xml" }] };
    const { deps, calls } = fakeDeps(provider, { cache: { get: vi.fn(async () => cached), set: vi.fn() } });
    const out = await runGenerationJob(deps, job, "image");
    expect(out).toEqual(cached);
    expect(provider.create).not.toHaveBeenCalled();
    expect(calls.message.at(-1)).toMatchObject({ status: "completed" });
  });

  it("hits the cache on a second run by the same user with identical input", async () => {
    const store = new Map<string, unknown>();
    const sharedCache = {
      get: vi.fn(async (k: string) => (store.has(k) ? store.get(k) : null)),
      set: vi.fn(async (k: string, v: unknown) => { store.set(k, v); }),
    };
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "completed", progress: 100, url: "data:image/svg+xml;base64,Zm9v" })),
    };
    const { deps: deps1 } = fakeDeps(provider, { cache: sharedCache });
    await runGenerationJob(deps1, job, "image");
    expect(provider.create).toHaveBeenCalledTimes(1);

    const { deps: deps2 } = fakeDeps(provider, { cache: sharedCache });
    await runGenerationJob(deps2, job, "image");
    expect(provider.create).toHaveBeenCalledTimes(1); // still one — second run is a cache hit
  });

  it("does not leak a cache hit across different users with identical input", async () => {
    const store = new Map<string, unknown>();
    const sharedCache = {
      get: vi.fn(async (k: string) => (store.has(k) ? store.get(k) : null)),
      set: vi.fn(async (k: string, v: unknown) => { store.set(k, v); }),
    };
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "completed", progress: 100, url: "data:image/svg+xml;base64,Zm9v" })),
    };
    const jobA = { id: "jobA", userId: "userA", input: { prompt: "菊花", conversationId: "cA", assistantMessageId: "mA", size: "1024x1024" } };
    const jobB = { id: "jobB", userId: "userB", input: { prompt: "菊花", conversationId: "cB", assistantMessageId: "mB", size: "1024x1024" } };

    const { deps: depsA, calls: callsA } = fakeDeps(provider, { cache: sharedCache });
    await runGenerationJob(depsA, jobA, "image");
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(callsA.asset.userId).toBe("userA");
    expect(callsA.metered).toBe(true);

    const { deps: depsB, calls: callsB } = fakeDeps(provider, { cache: sharedCache });
    await runGenerationJob(depsB, jobB, "image");
    // Different user, same prompt/params — must NOT be a cache hit.
    expect(provider.create).toHaveBeenCalledTimes(2);
    expect(callsB.asset.userId).toBe("userB");
    expect(callsB.metered).toBe(true);
  });
});
