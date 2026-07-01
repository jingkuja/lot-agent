import { describe, it, expect, vi } from "vitest";
import { runGenerationJob, type RunJobDeps, type JobGenerationProvider } from "./run-job.js";

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
    },
    meter: { record: vi.fn(async () => { calls.metered = true; }) },
    cache: { get: vi.fn(async () => null), set: vi.fn(async (_k, v) => { calls.cacheSet = v; }) },
    updateProgress: vi.fn(async (_id, p) => { calls.progress.push(p); }),
    urlToBytes: vi.fn(async () => ({ body: Buffer.from("x"), mime: "image/svg+xml" })),
    extFor: () => "svg",
    modelId: "wanx-standard",
    vendorModel: "im",
    sleep: async () => {},
    pollIntervalMs: 0,
    ...over,
  };
  return { deps, calls };
}

const job = { id: "job1", userId: "u1", input: { prompt: "菊花", assistantMessageId: "m1", size: "1024x1024" } };

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

  it("uses cache hit without creating/polling", async () => {
    const provider: JobGenerationProvider = { create: vi.fn(), poll: vi.fn() };
    const cached = { assetIds: ["a"], assets: [{ url: "/static/assets/a.svg", mime: "image/svg+xml" }] };
    const { deps, calls } = fakeDeps(provider, { cache: { get: vi.fn(async () => cached), set: vi.fn() } });
    const out = await runGenerationJob(deps, job, "image");
    expect(out).toEqual(cached);
    expect(provider.create).not.toHaveBeenCalled();
    expect(calls.message.at(-1)).toMatchObject({ status: "completed" });
  });
});
