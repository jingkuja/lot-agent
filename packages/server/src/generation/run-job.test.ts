import { describe, it, expect, vi } from "vitest";
import { HttpKlingVoiceProvider, HttpVideoGenerationProvider, OpenAIImagesImageProvider, OpenaiVideoAdapter } from "@lot-agent/core";
import { KlingVoicePreparation } from "./kling-voices.js";
import sharp from "sharp";
import {
  applyImageRedo,
  runGenerationJob,
  runImageSetRedo,
  settleImageRedo,
  SET_REFERENCE_NOTE,
  redownloadGenerationJob,
  JobCancelledError,
  type RunJobDeps,
  type JobGenerationProvider,
} from "./run-job.js";

function fakeDeps(provider: JobGenerationProvider, over: Partial<RunJobDeps> = {}): { deps: RunJobDeps; calls: any } {
  const calls: any = { progress: [], asset: null, message: [], metered: false, cacheSet: null, vendorIdSet: null };
  const deps: RunJobDeps = {
    provider,
    storage: { put: vi.fn(async ({ key }) => ({ url: `/static/assets/${key}` })), putStream: vi.fn() },
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
  it.each(["create", "poll", "resume", "download"])("does not persist or display upstream secrets from %s failures", async phase => {
    const secret = "SENTINEL-private-prompt https://private.example/a?material_token=SENTINEL-token Bearer SENTINEL-key";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") return phase === "create"
        ? Response.json({ message: secret, request_id: secret }, { status: 503 })
        : Response.json({ id: "original-vendor-id", status: "queued" });
      return phase === "download" ? Response.json({ status: "completed", metadata: { url: "https://vendor.example/clip.mp4" } })
        : Response.json({ status: "failed", error: secret });
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      const provider = new HttpVideoGenerationProvider({ baseUrl: "https://vendor.example", apiKey: "SENTINEL-key", adapter: new OpenaiVideoAdapter(), model: "fixture" });
      const { deps, calls } = fakeDeps(provider);
      if (phase === "resume") vi.mocked(deps.db.getTaskVendorId).mockResolvedValue("original-vendor-id");
      if (phase === "download") vi.mocked(deps.urlToBytes).mockRejectedValue(new Error(secret));
      let diagnostic = "";
      try { diagnostic = (await runGenerationJob(deps, job, "video")).error ?? ""; }
      catch (error) { diagnostic = (error as Error).message; }
      const visibleErrors = calls.message.map((message: { metadata: { error?: string } }) => message.metadata.error).join(" ");
      expect(diagnostic).toMatch(/HTTP_ERROR|TASK_FAILED|TRANSPORT_ERROR/);
      expect(diagnostic + visibleErrors + JSON.stringify(log.mock.calls)).not.toMatch(/SENTINEL|private\.example|material_token|Bearer/);
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(phase === "resume" ? 0 : 1);
    } finally { log.mockRestore(); vi.unstubAllGlobals(); }
  });
  it("refreshes material capabilities after slow voice preparation, without changing frozen references", async () => {
    let phase = "preflight";
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "completed", progress: 100, url: "https://video.example/clip.mp4" })),
    };
    const { deps } = fakeDeps(provider, {
      vendorModel: "kling-video-v3-omni",
      resolveReferenceUrl: vi.fn(async url => `${url}?material_token=${phase}`),
      prepareKlingVoices: vi.fn(async input => {
        expect(input.referenceAudio).toBe("https://media.example/voice.wav");
        phase = "after-voice"; return "voice-id";
      }),
    });
    const input = { prompt: "script", reference_audio: "https://media.example/voice.wav", input_reference: "/static/uploads/portrait.png" };
    await runGenerationJob(deps, { ...job, input }, "video");
    expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({ input_reference: "/static/uploads/portrait.png?material_token=after-voice", reference_audio: "voice-id" }));
    expect(input.input_reference).toBe("/static/uploads/portrait.png");
  });
  it("signs only a new submission, retains stable input/cache identity and omits private request content from logs", async () => {
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "completed", progress: 100, url: "https://video.example/clip.mp4" })),
    };
    const resolveReferenceUrl = vi.fn(async (url: string) => `${url}?material_token=secret`);
    const { deps } = fakeDeps(provider, { resolveReferenceUrl });
    const input = { prompt: "private script", input_reference: "/static/uploads/portrait.png" };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runGenerationJob(deps, { ...job, input }, "video");
      expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({ input_reference: "/static/uploads/portrait.png?material_token=secret" }));
      expect(input.input_reference).toBe("/static/uploads/portrait.png");
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/private script|portrait|material_token|secret/);
      resolveReferenceUrl.mockRejectedValue(new Error("expired material"));
      vi.mocked(deps.db.getTaskVendorId).mockResolvedValue("v1");
      await runGenerationJob(deps, { ...job, input }, "video");
      expect(resolveReferenceUrl).toHaveBeenCalledOnce();
      expect(provider.create).toHaveBeenCalledOnce();
      expect(vi.mocked(deps.cache.get).mock.calls[0][0]).toBe(vi.mocked(deps.cache.get).mock.calls[1][0]);
    } finally { log.mockRestore(); }
  });

  it("authorizes image edit references before reading bytes or making a paid request", async () => {
    const provider = { create: vi.fn(), poll: vi.fn() };
    const { deps } = fakeDeps(provider, { resolveReferenceUrl: vi.fn(async () => { throw new Error("素材不存在。"); }) });
    await expect(runGenerationJob(deps, { ...job, input: { ...job.input, media: [{ type: "input_reference", url: "/static/uploads/foreign.png" }] } }, "image")).rejects.toThrow("素材不存在");
    expect(deps.urlToBytes).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
  });

  it.each(["gpt-image-2", "linqu-image"])("puts the selected poster before the brand images for %s", async (vendorModel) => {
    const posterUrl = "https://todoucloud.com/posters/food/design.webp?v=0123456789abcdef";
    const productUrl = "/static/uploads/brand.png";
    const authorizedProductUrl = "https://agent.example/static/uploads/brand.png";
    const provider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "completed" as const, progress: 100 })),
      poll: vi.fn(async () => ({ status: "completed" as const, progress: 100, url: "https://vendor.example/result.png" })),
    };
    const { deps, calls } = fakeDeps(provider, {
      vendorModel,
      resolveImageReferenceUrl: vi.fn(async () => authorizedProductUrl),
      urlToBytes: vi.fn(async (url) => ({ body: Buffer.from(url === posterUrl ? "poster" : "product"), mime: "image/png" })),
    });
    const input = {
      ...job.input, scene: "poster_remix", displayPrompt: "青山茶壶",
      posterReference: { category: "food", filename: "design.webp", revision: "0123456789abcdef" },
      media: [{ type: "reference_image", url: productUrl }],
    };
    await runGenerationJob(deps, { ...job, input }, "image");
    const [poster, product] = vendorModel === "linqu-image"
      ? [posterUrl, authorizedProductUrl]
      : ["data:image/png;base64,cG9zdGVy", "data:image/png;base64,cHJvZHVjdA=="];
    expect(provider.create).toHaveBeenCalledOnce();
    expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({
      media: [poster, product].map((url) => ({ type: "reference_image", url })),
    }));
    expect(calls.message.at(-1).metadata).toMatchObject({ scene: "poster_remix", prompt: "青山茶壶", status: "completed" });
  });

  it("does not call the image model when a selected poster cannot be downloaded", async () => {
    const provider = { create: vi.fn(), poll: vi.fn() };
    const { deps } = fakeDeps(provider, { urlToBytes: vi.fn(async () => { throw new Error("upstream 404"); }) });
    const input = {
      ...job.input, scene: "poster_remix", posterReference: { category: "food", filename: "design.png", revision: "0123456789abcdef" },
    };
    await expect(runGenerationJob(deps, { ...job, input }, "image")).rejects.toThrow("这张爆款参考图已失效，请重新选择");
    expect(provider.create).not.toHaveBeenCalled();
  });

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

  it("stores every requested image, keeps the tier on the message and meters the stored count", async () => {
    const urls = ["https://img.example/1.png", "https://img.example/2.png", "https://img.example/3.png", "https://img.example/4.png"];
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "completed", progress: 100 })),
      poll: vi.fn(async () => ({ status: "completed", progress: 100, url: urls[0], urls })),
    };
    const { deps, calls } = fakeDeps(provider);
    const input = { ...job.input, resolution: "2K", ratio: "4:3", size: "2368x1776", n: 3 };
    const out = await runGenerationJob(deps, { ...job, input }, "image");
    expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({ n: 3, size: "2368x1776" }));
    expect(deps.urlToBytes).toHaveBeenCalledTimes(3);
    expect(out.assetIds).toHaveLength(3);
    expect(deps.db.createAsset).toHaveBeenCalledTimes(3);
    expect(deps.meter.record).toHaveBeenCalledWith(expect.objectContaining({ usage: { inputCount: 0, outputCount: 3 } }));
    expect(calls.message.at(-1).metadata).toMatchObject({ status: "completed", settings: { resolution: "2K", ratio: "4:3", n: 3 } });
    expect(calls.message.at(-1).metadata.assets).toHaveLength(3);
  });

  it("keeps a multi-image result whole: one failed download stores nothing and keeps every source url", async () => {
    const urls = ["https://img.example/1.png", "https://img.example/2.png"];
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "completed", progress: 100 })),
      poll: vi.fn(async () => ({ status: "completed", progress: 100, url: urls[0], urls })),
    };
    const { deps, calls } = fakeDeps(provider, {
      urlToBytes: vi.fn(async (url: string) => {
        if (url.endsWith("2.png")) throw new Error("reset");
        return { body: Buffer.from("x"), mime: "image/png" };
      }),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = await runGenerationJob(deps, { ...job, input: { ...job.input, n: 2 } }, "image");
      expect(out).toMatchObject({ downloadFailed: true, sourceUrl: urls[0], sourceUrls: urls });
      expect(deps.db.createAsset).not.toHaveBeenCalled();
      expect(calls.metered).toBe(false);
      expect(calls.message.at(-1).metadata).toMatchObject({ status: "download_failed", sourceUrls: urls });
    } finally { warn.mockRestore(); }

    vi.mocked(deps.urlToBytes).mockResolvedValue({ body: Buffer.from("x"), mime: "image/png" });
    const retried = await redownloadGenerationJob(deps, { ...job, input: { ...job.input, n: 2, sourceUrl: urls[0], sourceUrls: urls } }, "image");
    expect(retried.assetIds).toHaveLength(2);
    expect(deps.meter.record).toHaveBeenCalledWith(expect.objectContaining({ usage: { inputCount: 0, outputCount: 2 } }));
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

  it("reads an owned generated image from storage for a Base64 edit", async () => {
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "completed", progress: 100, url: "data:image/png;base64,YQ==" })),
    };
    const readOwnOutput = vi.fn(async () => ({ body: Buffer.from("reference"), mime: "image/png" }));
    const { deps } = fakeDeps(provider, { readOwnOutput });
    const url = "/static/assets/reference.png";
    await runGenerationJob(deps, {
      ...job, input: { ...job.input, media: [{ type: "reference_image", url }] },
    }, "image");

    expect(readOwnOutput).toHaveBeenCalledWith(url);
    expect(deps.urlToBytes).not.toHaveBeenCalledWith(url, expect.anything());
    expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({
      media: [{ type: "reference_image", url: "data:image/png;base64,cmVmZXJlbmNl" }],
    }));
  });

  it.each(["linqu-image", "lingqu-image"])("sends %s Agent URLs in the gateway's image array", async (model) => {
    const output = "data:image/png;base64,YQ==";
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ data: [{ b64_json: "YQ==" }] }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const provider = new OpenAIImagesImageProvider({ baseUrl: "https://gateway.example/v1", apiKey: "fixture", model });
      const reference = "/static/assets/reference.png";
      const resolved = "https://agent.example/static/assets/reference.png";
      const resolveImageReferenceUrl = vi.fn(async () => resolved);
      const { deps } = fakeDeps(provider, { vendorModel: model, resolveImageReferenceUrl });
      const media = [{ type: "reference_image", url: reference }];
      await runGenerationJob(deps, { ...job, input: { ...job.input, media } }, "image");

      expect(resolveImageReferenceUrl).toHaveBeenCalledWith(reference);
      const [endpoint, request] = fetcher.mock.calls[0];
      expect(endpoint).toBe("https://gateway.example/v1/images/edits");
      expect(JSON.parse(String(request.body))).toMatchObject({ model, image: [resolved] });
      expect(vi.mocked(deps.urlToBytes).mock.calls.map(([url]) => url)).toEqual([output]);
    } finally {
      vi.unstubAllGlobals();
    }
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
    // Tried three times before giving up.
    expect(deps.urlToBytes).toHaveBeenCalledTimes(3);
    expect(out.downloadFailed).toBe(true);
    expect(out.sourceUrl).toBe("https://vendor.example/out.mp4");
    expect(out.assets).toHaveLength(0);
    expect(calls.metered).toBe(false);
    const last = calls.message.at(-1);
    expect(last).toMatchObject({ id: "m1", status: "download_failed" });
    expect(last.metadata.sourceUrl).toBe("https://vendor.example/out.mp4");
    expect(last.metadata.error).toContain("TRANSPORT_ERROR");
    expect(last.metadata.error).not.toContain("download timed out");
  });

  it("downloads produced media again after a transient failure, logging only fixed fields", async () => {
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: "v1", status: "queued", progress: 0 })),
      poll: vi.fn(async () => ({ status: "completed", progress: 100, url: "https://vendor.example/out.mp4?sig=secret" })),
    };
    const reset = Object.assign(new TypeError("fetch failed https://vendor.example/out.mp4?sig=secret"), { cause: { code: "ECONNRESET" } });
    const urlToBytes = vi.fn()
      .mockRejectedValueOnce(reset)
      .mockRejectedValueOnce(Object.assign(new Error("download failed: HTTP 503"), { status: 503 }))
      .mockResolvedValueOnce({ body: Buffer.from("mp4"), mime: "video/mp4" });
    const sleep = vi.fn(async () => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps, calls } = fakeDeps(provider, { urlToBytes, sleep, extFor: () => "mp4" });
    const out = await runGenerationJob(deps, job, "video");
    expect(urlToBytes).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(sleep).toHaveBeenCalledWith(5000);
    expect(out.downloadFailed).toBeUndefined();
    expect(calls.metered).toBe(true);
    const logged = warn.mock.calls.filter(([tag]) => tag === "[generation.download] failed").map(([, fields]) => fields);
    expect(logged).toEqual([
      { taskId: job.id, attempt: 1, final: false, errorType: "TypeError", errorCode: "ECONNRESET" },
      { taskId: job.id, attempt: 2, final: false, errorType: "Error", httpStatus: 503 },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    warn.mockRestore();
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
          get: async () => null,
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

describe("runGenerationJob image sets", () => {
  const setInput = { ...job.input, prompt: "cover", prompts: ["cover", "detail", "scene"], n: 3, scene: "product_set", displayPrompt: "保温杯套图" };

  it("makes one single-image request per prompt and stores the set together", async () => {
    let next = 0;
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => ({ taskId: `t${++next}`, status: "queued", progress: 0 })),
      poll: vi.fn(async (id: string) => ({ status: "completed", progress: 100, urls: [`https://img.example/${id}.png`] })),
    };
    const { deps, calls } = fakeDeps(provider);
    const out = await runGenerationJob(deps, { ...job, input: setInput }, "image");
    expect(vi.mocked(provider.create).mock.calls.map(([request]) => [request.prompt, request.n])).toEqual([["cover", 1], ["detail", 1], ["scene", 1]]);
    expect(out.assets).toHaveLength(3);
    expect(out.missing).toBeUndefined();
    expect(calls.vendorIdSet).toBe(JSON.stringify(["t1", "t2", "t3"]));
    const done = calls.message.at(-1);
    expect(done.status).toBe("completed");
    expect(done.metadata).toMatchObject({ prompt: "保温杯套图", scene: "product_set" });
  });

  it("keeps the images already made when a later request fails, and does not cache the partial set", async () => {
    let next = 0;
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => {
        if (++next === 2) throw new Error("vendor rejected");
        return { taskId: `t${next}`, status: "queued", progress: 0 };
      }),
      poll: vi.fn(async (id: string) => ({ status: "completed", progress: 100, url: `https://img.example/${id}.png` })),
    };
    const { deps, calls } = fakeDeps(provider);
    const out = await runGenerationJob(deps, { ...job, input: setInput }, "image");
    expect(provider.create).toHaveBeenCalledTimes(2);
    expect(out.assets).toHaveLength(1);
    expect(out.missing).toBe(2);
    expect(calls.cacheSet).toBeNull();
    expect(calls.message.at(-1).metadata).toMatchObject({ status: "completed", missing: 2 });
  });

  it("on a re-delivered job polls the submitted images and never submits again", async () => {
    const provider: JobGenerationProvider = {
      create: vi.fn(),
      poll: vi.fn(async (id: string) => ({ status: "completed", progress: 100, url: `https://img.example/${id}.png` })),
    };
    const { deps } = fakeDeps(provider);
    vi.mocked(deps.db.getTaskVendorId).mockResolvedValue(JSON.stringify(["t1", "t2"]));
    const out = await runGenerationJob(deps, { ...job, input: setInput }, "image");
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.poll).toHaveBeenCalledTimes(2);
    expect(out.missing).toBe(1);
  });
});

async function png(width = 64, height = 64): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#3388cc" } }).png().toBuffer();
}

function setProvider() {
  let next = 0;
  return {
    create: vi.fn(async (_request: Parameters<JobGenerationProvider["create"]>[0]) => ({ taskId: `t${++next}`, status: "queued", progress: 0 })),
    poll: vi.fn(async (id: string) => ({ status: "completed", progress: 100, url: `https://img.example/${id}.png` })),
  } satisfies JobGenerationProvider;
}

describe("image set consistency", () => {
  const setInput = { ...job.input, prompt: "cover", prompts: ["cover", "detail", "scene"], n: 3, scene: "product_set" };

  it("stores the first linqu-image result once and uses its Agent URL for later images", async () => {
    const provider = setProvider();
    const resolveImageReferenceUrl = vi.fn(async (url: string) => `https://agent.example${url}`);
    const { deps } = fakeDeps(provider, { vendorModel: "linqu-image", resolveImageReferenceUrl });
    const out = await runGenerationJob(deps, { ...job, input: setInput }, "image");

    expect(resolveImageReferenceUrl).toHaveBeenCalledOnce();
    expect(resolveImageReferenceUrl).toHaveBeenCalledWith(out.assets[0].url);
    for (const [request] of provider.create.mock.calls.slice(1)) {
      expect(request.media).toEqual([{ type: "reference_image", url: `https://agent.example${out.assets[0].url}` }]);
    }
    expect(deps.urlToBytes).toHaveBeenCalledTimes(3);
    expect(deps.storage.put).toHaveBeenCalledTimes(3);
    expect(deps.meter.record).toHaveBeenCalledWith(expect.objectContaining({ usage: { inputCount: 0, outputCount: 3 } }));
  });

  it("without a user reference, sends the first image as the reference for the rest of the set", async () => {
    const provider = setProvider();
    const first = await png(2400, 1600);
    const { deps } = fakeDeps(provider, { urlToBytes: vi.fn(async () => ({ body: first, mime: "image/png" })) });
    await runGenerationJob(deps, { ...job, input: setInput }, "image");
    const requests = provider.create.mock.calls.map(([request]) => request);
    expect(requests[0]).toMatchObject({ prompt: "cover", media: undefined });
    for (const request of requests.slice(1)) {
      expect(request.prompt.startsWith(SET_REFERENCE_NOTE)).toBe(true);
      expect(request.media).toHaveLength(1);
      expect(request.media?.[0].type).toBe("reference_image");
    }
    expect(requests[1].prompt).toBe(SET_REFERENCE_NOTE + "detail");
    // The reference is shrunk before it is sent.
    const reference = Buffer.from(requests[1].media![0].url.split(",")[1], "base64");
    expect(await sharp(reference).metadata()).toMatchObject({ format: "jpeg", width: 1536, height: 1024 });
    // The first image is read once, not once per request.
    expect(deps.urlToBytes).toHaveBeenCalledWith("https://img.example/t1.png", expect.anything());
  });

  it("keeps the user's own reference and adds nothing to the prompts", async () => {
    const provider = setProvider();
    const upload = await png();
    const { deps } = fakeDeps(provider, { urlToBytes: vi.fn(async () => ({ body: upload, mime: "image/png" })) });
    const media = [{ type: "reference_image", url: "/static/uploads/cup.png" }];
    await runGenerationJob(deps, { ...job, input: { ...setInput, media } }, "image");
    const requests = provider.create.mock.calls.map(([request]) => request);
    expect(requests.map((request) => request.prompt)).toEqual(["cover", "detail", "scene"]);
    expect(requests.every((request) => request.media?.[0].url.startsWith("data:image/png;base64,"))).toBe(true);
  });

  it("still makes the rest of the set when the first image cannot be read as a reference", async () => {
    const provider = setProvider();
    const { deps } = fakeDeps(provider, { urlToBytes: vi.fn(async () => ({ body: Buffer.from("not an image"), mime: "image/png" })) });
    const out = await runGenerationJob(deps, { ...job, input: setInput }, "image");
    expect(provider.create.mock.calls.map(([request]) => request.prompt)).toEqual(["cover", "detail", "scene"]);
    expect(out.assets).toHaveLength(3);
  });
});

describe("image set redo", () => {
  const a = { url: "/static/assets/a.png", mime: "image/png" };
  const b = { url: "/static/assets/b.png", mime: "image/png" };
  const fresh = { url: "/static/assets/new.png", mime: "image/png" };

  it("replaces a position, appends a missing one, and drops composites made from the old images", () => {
    const meta = { status: "completed", assets: [a, b], missing: 2, composites: [{ url: "/c.jpg" }], redo: { status: "running", indexes: [1], taskId: "r1" } };
    expect(applyImageRedo(meta, "r1", [1], [fresh])).toEqual({ status: "completed", assets: [a, fresh], missing: 2 });
    const filled = applyImageRedo({ ...meta, redo: { status: "running", indexes: [2, 3] } }, "r1", [2], [fresh]);
    expect(filled).toEqual({ status: "completed", assets: [a, b, fresh], missing: 1 });
    expect(applyImageRedo({ ...meta, missing: 1 }, "r1", [2], [fresh])).not.toHaveProperty("missing");
  });

  it("leaves a set alone when the redo is no longer this job's", () => {
    const meta = { assets: [a], redo: { status: "running", indexes: [0], taskId: "other" } };
    expect(applyImageRedo(meta, "r1", [0], [fresh])).toBeNull();
    expect(settleImageRedo(meta, "r1", "boom")).toBeNull();
    expect(applyImageRedo({ assets: [a] }, "r1", [0], [fresh])).toBeNull();
  });

  it("keeps a failure on the card and clears a cancel", () => {
    const meta = { assets: [a], redo: { status: "running", indexes: [0], taskId: "r1" } };
    expect(settleImageRedo(meta, "r1", "vendor rejected")).toEqual({ assets: [a], redo: { status: "failed", taskId: "r1", indexes: [0], error: "vendor rejected" } });
    expect(settleImageRedo(meta, "r1")).toEqual({ assets: [a] });
  });

  function redoDeps(provider: JobGenerationProvider, metadata: Record<string, unknown>, over: Partial<RunJobDeps> = {}) {
    const state = { metadata };
    const { deps, calls } = fakeDeps(provider, over);
    deps.db.updateGenerationMetadata = vi.fn(async (_id, _owner, update) => {
      const next = update(state.metadata);
      if (next) state.metadata = next;
      return !!next;
    });
    return { deps, calls, state };
  }
  const redoJob = (input: Record<string, unknown>) => ({
    id: "r1", userId: "u1",
    input: { redoMessageId: "m1", conversationId: "c1", size: "1024x1024", quality: "auto", ...input },
  });

  it("uses the stored reference URL for a linqu-image redo", async () => {
    const provider = setProvider();
    const readOwnOutput = vi.fn();
    const resolved = `https://agent.example${a.url}`;
    const resolveImageReferenceUrl = vi.fn(async () => resolved);
    const metadata = { assets: [a, b], redo: { status: "running", indexes: [1], taskId: "r1" } };
    const { deps } = redoDeps(provider, metadata, { vendorModel: "linqu-image", resolveImageReferenceUrl, readOwnOutput });
    await runImageSetRedo(deps, redoJob({ indexes: [1], prompts: ["other angle"], setReference: a.url }));
    expect(resolveImageReferenceUrl).toHaveBeenCalledWith(a.url);
    expect(readOwnOutput).not.toHaveBeenCalled();
    expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({ media: [{ type: "reference_image", url: resolved }] }));
  });

  it("makes the image again with its original prompt and puts it back in place, using another image of the set", async () => {
    const provider = setProvider();
    const metadata = { status: "completed", assets: [a, b], redo: { status: "running", indexes: [1], taskId: "r1" } };
    const readOwnOutput = vi.fn(async () => ({ body: await png(), mime: "image/png" }));
    const { deps, state } = redoDeps(provider, metadata, { readOwnOutput, extFor: () => "png" });
    const out = await runImageSetRedo(deps, redoJob({ indexes: [1], prompts: ["other angle"], setReference: a.url }));
    expect(readOwnOutput).toHaveBeenCalledWith(a.url);
    const [request] = provider.create.mock.calls[0];
    expect(request).toMatchObject({ prompt: SET_REFERENCE_NOTE + "other angle", n: 1, size: "1024x1024" });
    expect(request.media?.[0].url).toMatch(/^data:image\/jpeg;base64,/);
    expect(out.assets).toHaveLength(1);
    expect(state.metadata.assets).toEqual([a, out.assets[0]]);
    expect(state.metadata.redo).toBeUndefined();
    expect(deps.meter.record).toHaveBeenCalledWith(expect.objectContaining({ taskId: "r1", usage: { inputCount: 0, outputCount: 1 } }));
  });

  it("fills missing images in order and keeps what was made when a later one fails", async () => {
    let next = 0;
    const provider: JobGenerationProvider = {
      create: vi.fn(async () => {
        if (++next === 2) throw new Error("vendor rejected");
        return { taskId: `t${next}`, status: "queued", progress: 0 };
      }),
      poll: vi.fn(async (id: string) => ({ status: "completed", progress: 100, url: `https://img.example/${id}.png` })),
    };
    const metadata = { status: "completed", assets: [a, b], missing: 2, redo: { status: "running", indexes: [2, 3], taskId: "r1" } };
    const { deps, state } = redoDeps(provider, metadata);
    const out = await runImageSetRedo(deps, redoJob({ indexes: [2, 3], prompts: ["scene", "detail"] }));
    expect(provider.create).toHaveBeenCalledTimes(2);
    expect(out.missing).toBe(1);
    expect(state.metadata).toMatchObject({ missing: 1 });
    expect((state.metadata.assets as unknown[]).length).toBe(3);
    expect(state.metadata.redo).toBeUndefined();
  });

  it("records why a redo made nothing, and leaves the set's images as they were", async () => {
    const provider: JobGenerationProvider = { create: vi.fn(async () => { throw new Error("vendor rejected"); }), poll: vi.fn() };
    const metadata = { status: "completed", assets: [a, b], redo: { status: "running", indexes: [0], taskId: "r1" } };
    const { deps, state } = redoDeps(provider, metadata);
    await expect(runImageSetRedo(deps, redoJob({ indexes: [0], prompts: ["main"] }))).rejects.toThrow("vendor rejected");
    expect(state.metadata).toMatchObject({ assets: [a, b], redo: { status: "failed", error: "vendor rejected", indexes: [0] } });
    expect(deps.meter.record).not.toHaveBeenCalled();
  });

  it("clears the redo mark when cancelled", async () => {
    const provider: JobGenerationProvider = { create: vi.fn(), poll: vi.fn() };
    const metadata = { status: "completed", assets: [a, b], redo: { status: "running", indexes: [0], taskId: "r1" } };
    const { deps, state } = redoDeps(provider, metadata);
    vi.mocked(deps.db.getTaskStatus).mockResolvedValue("cancelled");
    await expect(runImageSetRedo(deps, redoJob({ indexes: [0], prompts: ["main"] }))).rejects.toBeInstanceOf(JobCancelledError);
    expect(provider.create).not.toHaveBeenCalled();
    expect(state.metadata).toEqual({ status: "completed", assets: [a, b] });
  });
});

describe("white-background check", () => {
  it("stores the 白底图 with a pure white background and records the check on the message", async () => {
    const grey = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#f0efed" } })
      .composite([{ input: await sharp({ create: { width: 40, height: 40, channels: 3, background: "#c0392b" } }).png().toBuffer(), left: 12, top: 12 }])
      .png().toBuffer();
    const provider = setProvider();
    const { deps, calls } = fakeDeps(provider, { urlToBytes: vi.fn(async () => ({ body: grey, mime: "image/png" })), extFor: () => "png" });
    const put = vi.mocked(deps.storage.put);
    const out = await runGenerationJob(deps, { ...job, input: { ...job.input, scene: "white_background", n: 1 } }, "image");
    const stored = put.mock.calls[0][0].body as Buffer;
    const { data } = await sharp(stored).raw().toBuffer({ resolveWithObject: true });
    expect(Array.from(data.subarray(0, 3))).toEqual([255, 255, 255]);
    expect(out.whiteChecks).toEqual([{ corrected: true, issues: [] }]);
    expect(calls.message.at(-1).metadata).toMatchObject({ status: "completed", whiteChecks: [{ corrected: true, issues: [] }] });
  });

  it("leaves other image types exactly as the model made them", async () => {
    const image = await png();
    const provider = setProvider();
    const { deps } = fakeDeps(provider, { urlToBytes: vi.fn(async () => ({ body: image, mime: "image/png" })) });
    const out = await runGenerationJob(deps, { ...job, input: { ...job.input, n: 1 } }, "image");
    expect((vi.mocked(deps.storage.put).mock.calls[0][0].body as Buffer).equals(image)).toBe(true);
    expect(out.whiteChecks).toBeUndefined();
  });
});

describe("真实字体 posters", () => {
  const poster = { version: 1, template: "bottom_panel", fields: { title: "火锅店盛大开业", subtitle: "", points: [], price: "¥199", originalPrice: "",
    discount: "", date: "", address: "" } };

  it("keeps the text-free picture as its own asset and stores the typeset one as the result", async () => {
    const picture = await sharp({ create: { width: 256, height: 384, channels: 3, background: "#e9dcc3" } }).png().toBuffer();
    const { deps, calls } = fakeDeps(setProvider(), { urlToBytes: vi.fn(async () => ({ body: picture, mime: "image/png" })), extFor: () => "png" });
    const put = vi.mocked(deps.storage.put);
    const out = await runGenerationJob(deps, { ...job, input: { ...job.input, n: 1, poster, displayPrompt: "火锅店开业海报" } }, "image");
    expect(put).toHaveBeenCalledTimes(2);
    expect((put.mock.calls[0][0].body as Buffer).equals(picture)).toBe(true);
    expect((put.mock.calls[1][0].body as Buffer).equals(picture)).toBe(false);
    const background = `/static/assets/${put.mock.calls[0][0].key}`;
    expect(out.assets).toEqual([{ url: `/static/assets/${put.mock.calls[1][0].key}`, mime: "image/png" }]);
    expect(out.posters).toEqual([{ ...poster, background: { url: background } }]);
    expect(calls.message.at(-1).metadata).toMatchObject({ status: "completed", prompt: "火锅店开业海报", poster, posters: out.posters });
    // One image was made and billed; the stored background is not a second result.
    expect(deps.meter.record).toHaveBeenCalledWith(expect.objectContaining({ usage: { inputCount: 0, outputCount: 1 } }));
  });

  it("does not reuse a cached poster for other wording on the same picture prompt", async () => {
    const keys: string[] = [];
    const picture = await png();
    const run = async (title: string) => {
      const { deps } = fakeDeps(setProvider(), { urlToBytes: vi.fn(async () => ({ body: picture, mime: "image/png" })), extFor: () => "png" });
      deps.cache.set = vi.fn(async (key: string) => { keys.push(key); });
      await runGenerationJob(deps, { ...job, input: { ...job.input, n: 1, poster: { ...poster, fields: { ...poster.fields, title } } } }, "image");
    };
    await run("火锅店盛大开业");
    await run("火锅店周年庆");
    expect(new Set(keys).size).toBe(2);
  });
});

