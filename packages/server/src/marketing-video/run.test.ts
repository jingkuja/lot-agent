import { describe, expect, it, vi } from "vitest";
import { MarketingDraftSchema, storyboardScript, type MarketingShot } from "@lot-agent/core/marketing-video";
import { runMarketingVideo, type MarketingRunDeps } from "./run.js";
import { mediaCapabilities } from "./media.js";
import { runGenerationJob } from "../generation/run-job.js";
import { ProviderError } from "@lot-agent/core";

const store = vi.hoisted(() => ({ get: vi.fn(), segments: vi.fn() }));
vi.mock("./repository.js", () => ({ PgMarketingProjectStore: class {
  get = store.get;
  segments = store.segments;
} }));
vi.mock("./media.js", () => ({
  composeMarketingVideo: vi.fn(),
  mediaCapabilities: vi.fn(async () => ({ composition: true, subtitles: true })),
  SUBTITLES_UNAVAILABLE: "字幕不可用",
  inspectMedia: vi.fn(async () => ({ video: true, audio: true, duration: 15 })),
  ownedAssetPath: vi.fn(async () => "/tmp/fixture.mp4"),
}));
vi.mock("../generation/run-job.js", async importOriginal => ({
  ...await importOriginal<typeof import("../generation/run-job.js")>(),
  runGenerationJob: vi.fn(async (_deps: unknown, job: { id: string }) => ({ assetIds: [`asset-${job.id}`], assets: [] })),
}));

function fixture(shots: MarketingShot[], submitted = false) {
  const draft = MarketingDraftSchema.parse({ storyboard: shots, script: storyboardScript(shots), background: "背景".repeat(300) });
  store.get.mockResolvedValue({ id: "project", taskId: "parent" });
  store.segments.mockResolvedValue(shots.map((shot, slot) => ({ slot, task_id: `child-${slot}`, script: shot.script,
    duration_sec: shot.durationSec, status: "running", vendor_task_id: submitted ? `vendor-${slot}` : null, output: null })));
  const connection = { query: vi.fn(async () => ({ rows: [{ locked: true }] })), release: vi.fn() };
  const db = {
    pool: { connect: vi.fn(async () => connection), query: vi.fn(async () => ({ rows: [] })) },
    getTaskStatus: vi.fn(async () => "running"), updateTaskProgress: vi.fn(),
    getTaskVendorId: vi.fn(async (id: string) => `vendor-${id}`),
    getAsset: vi.fn(async () => ({ user_id: "owner" })),
    setTaskResult: vi.fn(), setTaskError: vi.fn(), createAsset: vi.fn(),
  };
  const gen = { modelId: "kling-video-v3-omni", db: {}, provider: {},
    meter: { record: vi.fn() }, storage: { put: vi.fn(async () => ({ url: "/static/result.mp4" })) } };
  const generation = vi.fn(async () => gen);
  const compose = vi.fn(async () => ({ body: Buffer.from("fixture"), durationSec: 30, width: 720, height: 1280 }));
  const deps = { db, dataRoot: "/tmp", generation, compose } as unknown as MarketingRunDeps;
  const job = { id: "parent", userId: "owner", input: { projectId: "project", draft, generate_audio: true } };
  return { deps, job, generation, connection, db, compose };
}

describe("marketing prompt submission preflight", () => {
  const short: MarketingShot = { durationSec: 15, script: "欢迎来喝咖啡。", visual: "人物展示咖啡", action: "端起杯子", camera: "中景" };
  const long: MarketingShot = { ...short, visual: "画面".repeat(300), action: "动作".repeat(200), camera: "镜头".repeat(200) };

  it("checks every new segment before resolving any chargeable provider", async () => {
    vi.mocked(runGenerationJob).mockClear();
    const f = fixture([short, long]);
    await expect(runMarketingVideo(f.deps, f.job, new AbortController().signal)).rejects.toThrow("生成提示词过长");
    expect(f.generation).not.toHaveBeenCalled();
    expect(runGenerationJob).not.toHaveBeenCalled();
    expect(f.connection.release).toHaveBeenCalledOnce();
  });

  it("continues already-submitted shots without applying new prompt limits to their recovery", async () => {
    vi.mocked(runGenerationJob).mockClear();
    const f = fixture([long, long], true);
    await expect(runMarketingVideo(f.deps, f.job, new AbortController().signal)).resolves.toMatchObject({ assets: [{ url: "/static/result.mp4" }] });
    expect(runGenerationJob).toHaveBeenCalledTimes(2);
    for (const [, child] of vi.mocked(runGenerationJob).mock.calls) expect(child.input.prompt).toBe("");
    expect(f.db.setTaskResult).toHaveBeenCalledTimes(2);
    expect(f.db.setTaskError).not.toHaveBeenCalled();
    expect(f.compose).toHaveBeenCalledOnce();
    expect(f.connection.release).toHaveBeenCalledOnce();
  });
});

describe("marketing segment submission failures", () => {
  const shot: MarketingShot = { durationSec: 15, script: "欢迎来喝咖啡。", visual: "人物展示咖啡", action: "端起杯子", camera: "中景" };
  async function submitWith(error: Error, query = async (_sql: string) => ({ rows: [], rowCount: 1 })) {
    const f = fixture([shot, shot]);
    f.db.pool.query.mockImplementation(query as never);
    const create = vi.fn(async () => { throw error; });
    f.generation.mockResolvedValue({ modelId: "kling-video-v3-omni", db: {}, provider: { create }, meter: { record: vi.fn() }, storage: { put: vi.fn() } } as never);
    vi.mocked(runGenerationJob).mockImplementation(async (deps) => { await deps.provider.create({} as never); throw new Error("unreachable"); });
    const result = runMarketingVideo(f.deps, f.job, new AbortController().signal);
    const released = () => (f.db.pool.query.mock.calls as unknown[][]).some(([sql]) => String(sql).includes("SET vendor_task_id=NULL WHERE id=$1 AND vendor_task_id=$2"));
    return { result, released, db: f.db };
  }
  it("releases the claim after an explicit vendor rejection so the user can retry after fixing it", async () => {
    for (const [error, errorCode] of [[new ProviderError("generation", "create", "HTTP_ERROR", { httpStatus: 429 }), "MODEL_RATE_LIMIT"], [new ProviderError("generation", "create", "REAL_PERSON_REJECTED", { httpStatus: 400 }), "REAL_PERSON_REJECTED"], [new ProviderError("generation", "create", "CONNECT_ERROR"), "CONNECT_FAILED"]] as const) {
      const f = await submitWith(error);
      // The queue stores the code; the original provider error stays as the cause.
      await expect(f.result).rejects.toMatchObject({ errorCode, cause: error, message: error.message });
      expect(f.released()).toBe(true);
    }
  });
  it("counts a gateway 5xx as not charged: records its request ID and releases the clip for the next continue", async () => {
    for (const status of [500, 502]) {
      const error = new ProviderError("generation", "create", "HTTP_ERROR", { httpStatus: status, gatewayRequestId: "20261022054753752798000zwvf9kakt1kd2rFO" });
      const f = await submitWith(error);
      await expect(f.result).rejects.toMatchObject({ errorCode: "GATEWAY_FAILED", cause: error, message: expect.stringContaining("继续生成会重新提交") });
      expect(f.released()).toBe(true);
      const calls = f.db.pool.query.mock.calls as unknown as [string, unknown[]][];
      const recorded = calls.find(([sql]) => sql.includes("INSERT INTO marketing_clip_gateway_failures"));
      expect(recorded?.[1]).toEqual(["owner", "project", "child-0", status, "20261022054753752798000zwvf9kakt1kd2rFO"]);
    }
  });
  it("keeps a gateway 5xx clip unknown when its record cannot be written", async () => {
    const f = await submitWith(new ProviderError("generation", "create", "HTTP_ERROR", { httpStatus: 500 }), async sql => {
      if (sql.includes("marketing_clip_gateway_failures")) throw new Error("db down");
      return { rows: [], rowCount: 1 };
    });
    await expect(f.result).rejects.toThrow();
    expect(f.released()).toBe(false);
  });
  it("keeps ambiguous submissions blocked to avoid paying twice", async () => {
    for (const error of [new ProviderError("generation", "create", "TRANSPORT_ERROR"), new ProviderError("generation", "create", "HTTP_ERROR", { httpStatus: 408 }), new Error("socket hang up")]) {
      const f = await submitWith(error);
      await expect(f.result).rejects.toMatchObject({ errorCode: "SUBMISSION_UNKNOWN", message: expect.stringContaining("片段提交结果未知") });
      expect(f.released()).toBe(false);
    }
    vi.mocked(runGenerationJob).mockReset();
    vi.mocked(runGenerationJob).mockImplementation(async (_deps: unknown, job: { id: string }) => ({ assetIds: [`asset-${job.id}`], assets: [] }) as never);
  });
});

describe("Kling voice reuse within one parent job", () => {
  const shot: MarketingShot = { durationSec: 10, script: "欢迎来喝咖啡。", visual: "人物展示咖啡", action: "端起杯子", camera: "中景" };
  function voiceFixture(legacy: string[] = []) {
    vi.mocked(runGenerationJob).mockClear();
    const f = fixture([shot, shot, shot]);
    f.job.input = { ...f.job.input, reference_audio: ["/static/uploads/voice.wav"] } as typeof f.job.input;
    vi.mocked(f.db.pool.query as (sql: string) => Promise<{ rows: unknown[] }>).mockImplementation(async sql => ({ rows: sql.includes("generation_voice_tasks") ? legacy.map(task_id => ({ task_id })) : [] }));
    const prepareKlingVoices = vi.fn(async () => ["voice-1"]);
    f.generation.mockResolvedValue({ modelId: "kling-video-v3-omni", vendorModel: "kling-video-v3-omni", db: {}, provider: {}, prepareKlingVoices,
      meter: { record: vi.fn() }, storage: { put: vi.fn(async () => ({ url: "/static/result.mp4" })) } } as never);
    return { ...f, prepareKlingVoices };
  }
  it("creates the voice once for the parent before any clip and scopes every clip to it", async () => {
    const f = voiceFixture();
    await runMarketingVideo(f.deps, f.job, new AbortController().signal);
    expect(f.prepareKlingVoices).toHaveBeenCalledOnce();
    expect(f.prepareKlingVoices).toHaveBeenCalledWith(expect.objectContaining({ taskId: "parent", userId: "owner" }));
    expect(vi.mocked(runGenerationJob).mock.invocationCallOrder[0]).toBeGreaterThan(f.prepareKlingVoices.mock.invocationCallOrder[0]);
    expect(vi.mocked(runGenerationJob).mock.calls.map(([deps]) => deps.voiceScopeTaskId)).toEqual(["parent", "parent", "parent"]);
  });
  it("keeps querying an older per-clip voice checkpoint", async () => {
    const f = voiceFixture(["child-0", "child-1", "child-2"]);
    await runMarketingVideo(f.deps, f.job, new AbortController().signal);
    expect(f.prepareKlingVoices).not.toHaveBeenCalled();
    expect(vi.mocked(runGenerationJob).mock.calls.map(([deps]) => deps.voiceScopeTaskId).sort()).toEqual(["child-0", "child-1", "child-2"]);
  });
  it("does not prepare voices for a non-Kling model", async () => {
    const f = voiceFixture();
    f.generation.mockResolvedValue({ modelId: "grok-imagine-video-1.5", vendorModel: "grok-imagine-video-1.5", db: {}, provider: {}, prepareKlingVoices: f.prepareKlingVoices,
      meter: { record: vi.fn() }, storage: { put: vi.fn(async () => ({ url: "/static/result.mp4" })) } } as never);
    await runMarketingVideo(f.deps, f.job, new AbortController().signal);
    expect(f.prepareKlingVoices).not.toHaveBeenCalled();
  });
});

describe("configurable clip concurrency", () => {
  const shot: MarketingShot = { durationSec: 5, script: "欢迎来喝咖啡。", visual: "人物展示咖啡", action: "端起杯子", camera: "中景" };
  async function peak(segmentConcurrency?: number) {
    const f = fixture(Array.from({ length: 6 }, () => shot));
    f.job.input.draft = MarketingDraftSchema.parse({ ...f.job.input.draft, durationSec: 30 });
    if (segmentConcurrency) Object.assign(f.deps, { segmentConcurrency });
    let running = 0, max = 0;
    vi.mocked(runGenerationJob).mockReset();
    vi.mocked(runGenerationJob).mockImplementation(async (_deps: unknown, job: { id: string }) => {
      max = Math.max(max, ++running);
      await new Promise(done => setTimeout(done, 5));
      running--;
      return { assetIds: [`asset-${job.id}`], assets: [] } as never;
    });
    await runMarketingVideo(f.deps, f.job, new AbortController().signal);
    expect(runGenerationJob).toHaveBeenCalledTimes(6);
    return max;
  }
  it("submits two clips at once by default and the configured number otherwise", async () => {
    expect(await peak()).toBe(2);
    expect(await peak(4)).toBe(4);
    // Never more workers than clips.
    expect(await peak(15)).toBe(6);
  });
});

describe("clips kept by a shot redo", () => {
  const shot: MarketingShot = { durationSec: 15, script: "欢迎来喝咖啡。", visual: "人物展示咖啡", action: "端起杯子", camera: "中景" };
  it("composes a kept clip without submitting or metering it again", async () => {
    vi.mocked(runGenerationJob).mockClear();
    const f = fixture([shot, shot]);
    const record = vi.fn();
    f.generation.mockResolvedValue({ modelId: "kling-video-v3-omni", db: {}, provider: {}, meter: { record }, storage: { put: vi.fn(async () => ({ url: "/static/result.mp4" })) } } as never);
    store.segments.mockResolvedValue([
      { slot: 0, task_id: "child-0", script: shot.script, duration_sec: 15, status: "succeeded", vendor_task_id: null, output: { assetIds: ["kept"], assets: [], reusedFrom: "old-child-0" } },
      { slot: 1, task_id: "child-1", script: shot.script, duration_sec: 15, status: "pending", vendor_task_id: null, output: null },
    ]);
    await expect(runMarketingVideo(f.deps, f.job, new AbortController().signal)).resolves.toMatchObject({ assets: [{ url: "/static/result.mp4" }] });
    expect(runGenerationJob).toHaveBeenCalledOnce();
    expect(vi.mocked(runGenerationJob).mock.calls[0][1].id).toBe("child-1");
    expect(record).not.toHaveBeenCalled();
    expect(f.db.getAsset).toHaveBeenCalledWith("kept");
    expect(f.compose).toHaveBeenCalledOnce();
  });
});

describe("twin-narrated jobs", () => {
  const shot: MarketingShot = { durationSec: 15, script: "欢迎来喝咖啡。", visual: "人物展示咖啡", action: "端起杯子", camera: "中景" };
  const projectId = "11111111-1111-4111-8111-111111111111";
  async function narrated(writeFiles: boolean) {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "marketing-run-narration-"));
    const takes = [0, 1].map(slot => ({ slot, key: `k${slot}`, storageKey: `${projectId}/0000000${slot}-0000-4000-8000-000000000000.wav`, durationMs: 4000 }));
    await mkdir(join(root, "marketing-narration", projectId), { recursive: true });
    if (writeFiles) for (const take of takes) await writeFile(join(root, "marketing-narration", take.storageKey), "wav");
    const f = fixture([shot, shot]);
    store.get.mockResolvedValue({ id: projectId, taskId: "parent" });
    Object.assign(f.deps, { dataRoot: root });
    Object.assign(f.job.input, { marketingInputVersion: 4, generate_audio: false, narration: takes, draft: { ...f.job.input.draft, narration: { twinItemId: projectId } } });
    return { ...f, root };
  }
  it("composes the frozen takes in place of the clips' audio", async () => {
    vi.mocked(runGenerationJob).mockReset().mockImplementation(async (_deps: unknown, job: { id: string }) => ({ assetIds: [`asset-${job.id}`], assets: [] }) as never);
    const f = await narrated(true);
    try {
      await runMarketingVideo(f.deps, f.job, new AbortController().signal);
      const input = (f.compose.mock.calls[0] as unknown[])[0] as { narration: string[]; subtitles: boolean; speech: boolean };
      expect(input.narration).toHaveLength(2);
      // The takes are speech, so long silences in the joined film are reported.
      expect(input.speech).toBe(true);
      expect(input.narration[1]).toContain(`${projectId}/00000001-`);
      // Submitted before local captions: the model drew them, so none are burned in.
      expect(input.subtitles).toBe(false);
      for (const [, child] of vi.mocked(runGenerationJob).mock.calls) {
        expect(child.input.generate_audio).toBe(false);
        expect(child.input.prompt).toContain("Caption ONLY confirmedShot.script verbatim");
      }
    } finally { const { rm } = await import("node:fs/promises"); await rm(f.root, { recursive: true, force: true }); }
  });
  it("asks for clips without text and burns the captions in when the job has local subtitles", async () => {
    vi.mocked(runGenerationJob).mockReset().mockImplementation(async (_deps: unknown, job: { id: string }) => ({ assetIds: [`asset-${job.id}`], assets: [] }) as never);
    const f = await narrated(true);
    Object.assign(f.job.input, { local_subtitles: true, key_art: "still" });
    const quality = { checked: true, durationSec: 30, expectedSec: 30, subtitles: "burned", captions: 4, speech: true, issues: [] };
    f.compose.mockResolvedValueOnce({ body: Buffer.from("fixture"), durationSec: 30, width: 720, height: 1280, quality } as never);
    try {
      // The local check result is kept with the video for the result page.
      await expect(runMarketingVideo(f.deps, f.job, new AbortController().signal)).resolves.toMatchObject({ quality });
      expect(((f.compose.mock.calls[0] as unknown[])[0] as { subtitles: boolean }).subtitles).toBe(true);
      for (const [, child] of vi.mocked(runGenerationJob).mock.calls) {
        expect(child.input.prompt).toContain("Do not add any on-screen text, captions or subtitles");
        expect(child.input.prompt).not.toContain("Caption ONLY");
        // The frozen key-art still is named in every clip prompt.
        expect(child.input.prompt).toContain("is the key-art still shared by every shot");
      }
    } finally { const { rm } = await import("node:fs/promises"); await rm(f.root, { recursive: true, force: true }); }
  });
  it("stops before any clip is paid for when this worker cannot burn captions", async () => {
    vi.mocked(runGenerationJob).mockClear();
    vi.mocked(mediaCapabilities).mockResolvedValueOnce({ composition: true, subtitles: false });
    const f = await narrated(true);
    Object.assign(f.job.input, { local_subtitles: true });
    try {
      await expect(runMarketingVideo(f.deps, f.job, new AbortController().signal)).rejects.toMatchObject({ errorCode: "CONFIG_MISSING", message: "字幕不可用" });
      expect(runGenerationJob).not.toHaveBeenCalled();
    } finally { const { rm } = await import("node:fs/promises"); await rm(f.root, { recursive: true, force: true }); }
  });
  it("stops before any clip is paid for when a frozen take is gone", async () => {
    vi.mocked(runGenerationJob).mockClear();
    const f = await narrated(false);
    try {
      await expect(runMarketingVideo(f.deps, f.job, new AbortController().signal)).rejects.toMatchObject({ errorCode: "NARRATION_INVALID" });
      expect(runGenerationJob).not.toHaveBeenCalled();
    } finally { const { rm } = await import("node:fs/promises"); await rm(f.root, { recursive: true, force: true }); }
  });
});
