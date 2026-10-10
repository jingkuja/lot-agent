import { describe, it, expect, vi } from "vitest";
import { HttpKlingVoiceProvider, HttpVideoGenerationProvider, OpenaiVideoAdapter } from "@lot-agent/core";
import { KlingVoicePreparation } from "./kling-voices.js";
import {
  runGenerationJob,
  redownloadGenerationJob,
  JobCancelledError,
  type RunJobDeps,
  type JobGenerationProvider,
} from "./run-job.js";

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
      getAsset: vi.fn(async () => ({ user_id: "u1" })),
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

  it("forwards image quality to the provider, defaulting to auto", async () => {
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "completed", progress: 100, url: "data:image/svg+xml;base64,Zm9v" })),
    };
    const { deps } = fakeDeps(provider);
    await runGenerationJob(deps, job, "image");
    expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({ quality: "auto", size: "1024x1024" }));

    const high = { ...job, input: { ...job.input, quality: "high" } };
    await runGenerationJob(deps, high, "image");
    expect(provider.create).toHaveBeenLastCalledWith(expect.objectContaining({ quality: "high" }));
  });

  it("preserves video resolution in provider requests, messages and separate cache entries", async () => {
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "completed", progress: 100, url: "https://video.example/clip.mp4" })),
    };
    const { deps, calls } = fakeDeps(provider);
    for (const resolution of ["480p", "720p", "1080p"]) {
      await runGenerationJob(deps, { ...job, input: { ...job.input, resolution } }, "video");
      expect(provider.create).toHaveBeenLastCalledWith(expect.objectContaining({ resolution }));
      expect(calls.message.at(-1).metadata.settings.resolution).toBe(resolution);
    }
    const cacheKeys = vi.mocked(deps.cache.get).mock.calls.map(([key]) => key);
    expect(new Set(cacheKeys).size).toBe(3);
  });

  it("keeps the task id on the message through completion so lost submissions stay recoverable", async () => {
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "completed", progress: 100, url: "https://video.example/clip.mp4" })),
    };
    const { deps, calls } = fakeDeps(provider);
    await runGenerationJob(deps, job, "video");
    for (const write of calls.message) expect(write.metadata.taskId).toBe("job1");
    expect(calls.message.at(-1)).toMatchObject({ status: "completed", metadata: { taskId: "job1" } });
  });

  it("marks message failed and rethrows when poll returns failed", async () => {
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "failed", progress: 50, error: "boom" })),
    };
    const { deps, calls } = fakeDeps(provider);
    await expect(runGenerationJob(deps, job, "video")).rejects.toThrow(/boom/);
    expect(calls.message.at(-1)).toMatchObject({ id: "m1", status: "failed" });
    expect(deps.meter.record).not.toHaveBeenCalled();
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
    expect(deps.meter.record).not.toHaveBeenCalled();
  });

  it("uses PUBLIC_BASE_URL for every local video reference sent to the provider", async () => {
    const originalBaseUrl = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = "https://box.example.com/";
    try {
      const provider: JobGenerationProvider = {
        create: vi.fn(async () => ({ taskId: "v1", status: "queued", progress: 0 })),
        poll: vi.fn(async () => ({ status: "completed", progress: 100, url: "data:image/svg+xml;base64,Zm9v" })),
      };
      const { deps } = fakeDeps(provider);
      const videoJob = {
        ...job,
        input: {
          ...job.input,
          input_reference: ["/static/uploads/image.png"],
          reference_video: "/static/uploads/reference.mp4",
          reference_audio: ["/static/uploads/audio.mp3"],
          first_frame: "/static/uploads/first.png",
          last_frame: "/static/uploads/last.png",
          media: [
            { type: "reference_image", url: "/static/uploads/legacy-image.png" },
            { type: "reference_video", url: "/static/uploads/legacy-video.mp4" },
            { type: "reference_audio", url: "/static/uploads/legacy-audio.mp3" },
          ],
        },
      };

      await runGenerationJob(deps, videoJob, "video");

      expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({
        input_reference: ["https://box.example.com/static/uploads/image.png"],
        reference_video: "https://box.example.com/static/uploads/reference.mp4",
        reference_audio: ["https://box.example.com/static/uploads/audio.mp3"],
        generate_audio: true,
        first_frame: "https://box.example.com/static/uploads/first.png",
        last_frame: "https://box.example.com/static/uploads/last.png",
        media: [
          { type: "reference_image", url: "https://box.example.com/static/uploads/legacy-image.png" },
          { type: "reference_video", url: "https://box.example.com/static/uploads/legacy-video.mp4" },
          { type: "reference_audio", url: "https://box.example.com/static/uploads/legacy-audio.mp3" },
        ],
      }));
    } finally {
      if (originalBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = originalBaseUrl;
    }
  });

  it("encodes image-edit references as Base64 data URLs before calling the provider", async () => {
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "completed", progress: 100, url: "data:image/svg+xml;base64,Zm9v" })),
    };
    const { deps } = fakeDeps(provider, {
      urlToBytes: vi.fn(async () => ({ body: Buffer.from("reference"), mime: "image/png" })),
    });
    const imageJob = {
      ...job,
      input: {
        ...job.input,
        media: [{ type: "reference_image", url: "/static/uploads/reference.png" }],
      },
    };

    await runGenerationJob(deps, imageJob, "image");

    expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({
      media: [{ type: "reference_image", url: "data:image/png;base64,cmVmZXJlbmNl" }],
    }));
    expect(deps.urlToBytes).toHaveBeenCalledWith("/static/uploads/reference.png", { signal: undefined });
  });

  it("encodes two image-edit references as Base64 data URLs before calling the provider", async () => {
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "completed", progress: 100, url: "data:image/svg+xml;base64,Zm9v" })),
    };
    const { deps } = fakeDeps(provider, {
      urlToBytes: vi.fn(async (url: string) => ({
        body: Buffer.from(url.includes("a.png") ? "first" : "second"),
        mime: url.includes("a.png") ? "image/jpeg" : "image/png",
      })),
    });
    const imageJob = {
      ...job,
      input: {
        ...job.input,
        media: [
          { type: "reference_image", url: "/static/uploads/a.png" },
          { type: "reference_image", url: "/static/uploads/b.png" },
        ],
      },
    };

    await runGenerationJob(deps, imageJob, "image");

    expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({
      media: [
        { type: "reference_image", url: "data:image/jpeg;base64,Zmlyc3Q=" },
        { type: "reference_image", url: "data:image/png;base64,c2Vjb25k" },
      ],
    }));
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

  it("regenerates when a cached material has been permanently deleted", async () => {
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "new-vendor", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "completed", progress: 100, url: "data:image/svg+xml;base64,Zm9v" })),
    };
    const { deps } = fakeDeps(provider, { cache: { get: vi.fn(async () => ({ assetIds: ["deleted"], assets: [{ url: "/static/assets/deleted.svg", mime: "image/svg+xml" }] })), set: vi.fn() } });
    deps.db.getAsset = vi.fn(async () => undefined);
    const result = await runGenerationJob(deps, job, "image");
    expect(provider.create).toHaveBeenCalledOnce();
    expect(result.assetIds).not.toContain("deleted");
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

  it("classifies a post-completion download failure as download_failed, not failed", async () => {
    // The vendor produced the media (poll → completed with a url) but pulling
    // it into our storage timed out. That is recoverable: the message goes to
    // 'download_failed' with the vendor url preserved, the job returns a
    // downloadFailed output (does NOT throw → the task stays succeeded), and
    // nothing is metered (no asset was stored).
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "completed", progress: 100, url: "https://vendor.example/out.mp4" })),
    };
    const { deps, calls } = fakeDeps(provider, {
      urlToBytes: vi.fn(async () => { throw new Error("download timed out"); }),
    });
    const out = await runGenerationJob(deps, job, "video");
    expect(out.downloadFailed).toBe(true);
    expect(out.sourceUrl).toBe("https://vendor.example/out.mp4");
    expect(out.assets).toHaveLength(0);
    expect(calls.metered).toBe(false);
    const last = calls.message.at(-1);
    expect(last).toMatchObject({ id: "m1", status: "download_failed" });
    expect(last.metadata.sourceUrl).toBe("https://vendor.example/out.mp4");
    expect(last.metadata.error).toContain("download timed out");
  });

  it("finalizes a cancellation observed during download as cancelled, not download_failed", async () => {
    const controller = new AbortController();
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "completed", progress: 100, url: "https://vendor.example/out.mp4" })),
    };
    const { deps, calls } = fakeDeps(provider, {
      signal: controller.signal,
      // The download aborts because the job was cancelled mid-flight.
      urlToBytes: vi.fn(async () => { controller.abort(); throw new Error("aborted"); }),
    });
    await expect(runGenerationJob(deps, job, "video")).rejects.toBeInstanceOf(JobCancelledError);
    expect(calls.message.at(-1)).toMatchObject({ status: "cancelled" });
  });
});

describe("redownloadGenerationJob", () => {
  const redlJob = {
    id: "job1",
    userId: "u1",
    input: { prompt: "菊花", conversationId: "c1", assistantMessageId: "m1", sourceUrl: "https://vendor.example/out.mp4", durationSec: 5 },
  };

  it("re-fetches the source url, stores the asset, meters, and completes the message — no vendor call", async () => {
    const provider: JobGenerationProvider = { create: vi.fn(), poll: vi.fn() };
    const { deps, calls } = fakeDeps(provider, {
      urlToBytes: vi.fn(async () => ({ body: Buffer.from("mp4"), mime: "video/mp4" })),
      extFor: () => "mp4",
    });
    const out = await redownloadGenerationJob(deps, redlJob, "video");
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.poll).not.toHaveBeenCalled();
    expect(deps.urlToBytes).toHaveBeenCalledWith("https://vendor.example/out.mp4", { signal: undefined });
    expect(out.assets).toHaveLength(1);
    expect(calls.asset.userId).toBe("u1");
    expect(calls.metered).toBe(true);
    expect(calls.message.at(-1)).toMatchObject({ id: "m1", status: "completed" });
  });

  it("leaves the message download_failed again when the retry download fails too", async () => {
    const provider: JobGenerationProvider = { create: vi.fn(), poll: vi.fn() };
    const { deps, calls } = fakeDeps(provider, {
      urlToBytes: vi.fn(async () => { throw new Error("download timed out"); }),
    });
    const out = await redownloadGenerationJob(deps, redlJob, "video");
    expect(out.downloadFailed).toBe(true);
    expect(calls.metered).toBe(false);
    expect(calls.message.at(-1)).toMatchObject({ id: "m1", status: "download_failed" });
  });

  it("throws when no sourceUrl is supplied", async () => {
    const provider: JobGenerationProvider = { create: vi.fn(), poll: vi.fn() };
    const { deps } = fakeDeps(provider);
    const bad = { id: "job1", userId: "u1", input: { prompt: "x", conversationId: "c1", assistantMessageId: "m1" } };
    await expect(redownloadGenerationJob(deps, bad, "video")).rejects.toThrow(/sourceUrl/);
  });
});

describe("Kling voice references", () => {
  function setup() {
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "video-vendor-1", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "completed", progress: 100, url: "https://video.example/clip.mp4" })),
    };
    const prepareKlingVoices = vi.fn<NonNullable<RunJobDeps["prepareKlingVoices"]>>(async () => "917124264959582304");
    const { deps, calls } = fakeDeps(provider, { vendorModel: "kling-video-v3-omni", prepareKlingVoices });
    const voiceJob = { ...job, input: { ...job.input, reference_audio: "https://media.example/voice.wav", generate_audio: false } };
    return { deps, calls, provider, prepareKlingVoices, voiceJob };
  }

  it("creates voice first and sends voice_id, not voice task ID or source URL", async () => {
    const { deps, provider, prepareKlingVoices, voiceJob } = setup();
    await runGenerationJob(deps, voiceJob, "video");
    expect(prepareKlingVoices).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", taskId: "job1", referenceAudio: voiceJob.input.reference_audio }));
    expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({ reference_audio: "917124264959582304", generate_audio: true }));
    expect(prepareKlingVoices.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(provider.create).mock.invocationCallOrder[0]);
  });

  it("runs the real HTTP adapters in voice POST → voice GET → video POST → video GET order", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ code: 0, data: { task_id: "voice-task", task_status: "submitted" } }))
      .mockResolvedValueOnce(Response.json({ code: 0, data: { task_id: "voice-task", task_status: "succeed", task_result: { voices: [{ voice_id: "917124264959582304", status: "succeed" }] } } }))
      .mockResolvedValueOnce(Response.json({ id: "video-task", status: "queued" }))
      .mockResolvedValueOnce(Response.json({ id: "video-task", status: "completed", progress: 100, metadata: { url: "https://media.example/result.mp4" } }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const options = { baseUrl: "https://gateway.example/v1", apiKey: "owner-key" };
      const preparation = new KlingVoicePreparation({
        provider: new HttpKlingVoiceProvider({ baseUrl: "https://voice.example/v1", apiKey: "voice-service-key" }),
        store: {
          claim: async (_scope, externalTaskId) => ({ created: true, checkpoint: { externalTaskId } }),
          save: async () => {},
        },
        credentialScope: "voice-service-scope",
        validateUrl: async () => {},
        sleep: async () => {},
      });
      const { deps, voiceJob } = setup();
      await runGenerationJob({
        ...deps,
        provider: new HttpVideoGenerationProvider({ ...options, model: deps.vendorModel, adapter: new OpenaiVideoAdapter() }),
        prepareKlingVoices: (input) => preparation.prepare(input),
      }, voiceJob, "video");
      expect(fetcher.mock.calls.map(([url, init]) => [url, init.method ?? "GET"])).toEqual([
        ["https://voice.example/v1/wand/kling/custom-voices", "POST"],
        ["https://voice.example/v1/wand/kling/custom-voices/voice-task", "GET"],
        ["https://gateway.example/v1/videos", "POST"],
        ["https://gateway.example/v1/videos/video-task", "GET"],
      ]);
      const videoBody = JSON.parse(fetcher.mock.calls[2][1].body);
      expect(videoBody).toMatchObject({ metadata: { voice_id: "917124264959582304" }, generate_audio: true });
      expect(videoBody).not.toHaveProperty("reference_audio");
      expect(JSON.parse(fetcher.mock.calls[0][1].body).voice_url).toBe(voiceJob.input.reference_audio);
      expect(fetcher.mock.calls.map(([, init]) => init.headers.Authorization)).toEqual([
        "Bearer voice-service-key", "Bearer voice-service-key", "Bearer owner-key", "Bearer owner-key",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("resolves public URLs and converts legacy audio without leaking legacy URLs", async () => {
    const previousBase = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = "https://media.example";
    try {
      const { deps, provider, prepareKlingVoices } = setup();
      await runGenerationJob(deps, { ...job, input: { ...job.input, media: [
        { type: "reference_audio", url: "/static/uploads/voice.wav" },
        { type: "reference_image", url: "/static/uploads/face.jpg" },
      ] } }, "video");
      expect(prepareKlingVoices).toHaveBeenCalledWith(expect.objectContaining({ referenceAudio: ["https://media.example/static/uploads/voice.wav"] }));
      expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({
        reference_audio: "917124264959582304",
        media: [{ type: "reference_image", url: "https://media.example/static/uploads/face.jpg" }],
      }));
    } finally {
      if (previousBase === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = previousBase;
    }
  });

  it("keeps non-Kling references unchanged and skips preparation without audio", async () => {
    const { deps, provider, prepareKlingVoices, voiceJob } = setup();
    await runGenerationJob({ ...deps, vendorModel: "seedance-2.0" }, voiceJob, "video");
    expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({ reference_audio: voiceJob.input.reference_audio }));
    await runGenerationJob(deps, job, "video");
    expect(prepareKlingVoices).not.toHaveBeenCalled();
  });

  it("skips voice creation for a resumed video task", async () => {
    const { deps, provider, prepareKlingVoices, voiceJob } = setup();
    vi.mocked(deps.db.getTaskVendorId).mockResolvedValue("existing-video");
    await runGenerationJob(deps, voiceJob, "video");
    expect(provider.poll).toHaveBeenCalledWith("existing-video");
    expect(prepareKlingVoices).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
  });

  it("does not create video after failed or unconfigured voice preparation", async () => {
    const { deps, calls, provider, prepareKlingVoices, voiceJob } = setup();
    prepareKlingVoices.mockRejectedValue(new Error("voice failed"));
    await expect(runGenerationJob(deps, voiceJob, "video")).rejects.toThrow("voice failed");
    expect(calls.message.at(-1).status).toBe("failed");
    await expect(runGenerationJob({ ...deps, prepareKlingVoices: undefined }, voiceJob, "video")).rejects.toThrow("音色服务未配置");
    expect(provider.create).not.toHaveBeenCalled();
  });

  it("honors cancellation after voice creation and before video submission", async () => {
    const { deps, calls, provider, prepareKlingVoices, voiceJob } = setup();
    prepareKlingVoices.mockImplementation(async () => {
      vi.mocked(deps.db.getTaskStatus).mockResolvedValue("cancelled");
      return "voice-1";
    });
    await expect(runGenerationJob(deps, voiceJob, "video")).rejects.toBeInstanceOf(JobCancelledError);
    expect(calls.message.at(-1).status).toBe("cancelled");
    expect(provider.create).not.toHaveBeenCalled();
  });

  it("marks an interrupted voice HTTP request cancelled rather than failed", async () => {
    const { deps, calls, provider, prepareKlingVoices, voiceJob } = setup();
    const controller = new AbortController();
    prepareKlingVoices.mockImplementation(async ({ signal }) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    });
    await expect(runGenerationJob({ ...deps, signal: controller.signal }, voiceJob, "video")).rejects.toBeInstanceOf(JobCancelledError);
    expect(calls.message.at(-1).status).toBe("cancelled");
    expect(provider.create).not.toHaveBeenCalled();
  });
});
