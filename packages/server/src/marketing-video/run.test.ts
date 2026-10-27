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
  storeComposedVideo: vi.fn((storage: { putStream: (...args: unknown[]) => unknown }, key: string, video: { file: string; sizeBytes: number }) => storage.putStream(key, video.file, "video/mp4", video.sizeBytes)),
}));
vi.mock("../generation/run-job.js", async importOriginal => ({
  ...await importOriginal<typeof import("../generation/run-job.js")>(),
  runGenerationJob: vi.fn(async (_deps: unknown, job: { id: string }) => ({ assetIds: [`asset-${job.id}`], assets: [] })),
}));

// A composed video left on disk; the mocked store hands its path to storage.
const composed = () => ({ file: "/tmp/composed.mp4", sizeBytes: 7, dispose: vi.fn(async () => {}), durationSec: 30, width: 720, height: 1280 });
function fixture(shots: MarketingShot[], submitted = false) {
  const draft = MarketingDraftSchema.parse({ storyboard: shots, script: storyboardScript(shots), background: "背景".repeat(300) });
  store.get.mockResolvedValue({ id: "project", taskId: "parent" });
  store.segments.mockResolvedValue(shots.map((shot, slot) => ({ slot, task_id: `child-${slot}`, script: shot.script,
    duration_sec: shot.durationSec, status: "running", vendor_task_id: submitted ? `vendor-${slot}` : null, output: null })));
  const connection = { query: vi.fn(async () => ({ rows: [{ locked: true }] })), release: vi.fn() };
  // The job lock holds the first connection; the made video's transaction takes another.
  const storing = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() };
  const db = {
    pool: { connect: vi.fn().mockResolvedValueOnce(connection).mockResolvedValue(storing), query: vi.fn(async () => ({ rows: [] })) },
    getTaskStatus: vi.fn(async () => "running"), updateTaskProgress: vi.fn(), raiseTaskProgress: vi.fn(),
    getTaskVendorId: vi.fn(async (id: string) => `vendor-${id}`),
    getAsset: vi.fn(async () => ({ user_id: "owner" })),
    setTaskResult: vi.fn(), setTaskError: vi.fn(), createAsset: vi.fn(),
  };
  const gen = { modelId: "kling-video-v3-omni", db: {}, provider: {},
    meter: { record: vi.fn() }, storage: { putStream: vi.fn(async () => ({ url: "/static/result.mp4" })) } };
  const generation = vi.fn(async () => gen);
  const compose = vi.fn(async () => composed());
  const deps = { db, dataRoot: "/tmp", generation, compose } as unknown as MarketingRunDeps;
  const job = { id: "parent", userId: "owner", input: { projectId: "project", draft, generate_audio: true } };
  return { deps, job, generation, connection, storing, db, compose };
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

  it("burns the captions of a model-voiced job locally and keeps the cues with the video", async () => {
    vi.mocked(runGenerationJob).mockClear();
    const f = fixture([short, short]);
    Object.assign(f.job.input, { local_subtitles: true });
    const captions = [{ shot: 0, start: 0.2, end: 3, text: "欢迎来喝咖啡" }];
    f.compose.mockResolvedValueOnce({ ...composed(), captions } as never);
    await expect(runMarketingVideo(f.deps, f.job, new AbortController().signal)).resolves.toMatchObject({ captions });
    const input = (f.compose.mock.calls[0] as unknown[])[0] as { subtitles: boolean; speech: boolean; narration?: string[] };
    expect(input).toMatchObject({ subtitles: true, speech: true });
    expect(input.narration).toBeUndefined();
    for (const [, child] of vi.mocked(runGenerationJob).mock.calls) {
      expect(child.input.prompt).toContain("Narrate ONLY confirmedShot.script verbatim");
      expect(child.input.prompt).toContain("Do not add any on-screen text, captions or subtitles");
    }
  });

  it("stores the caption-free copy beside the video and drops the draft's earlier copies (M08)", async () => {
    const f = fixture([short, short]);
    Object.assign(f.job.input, { local_subtitles: true });
    const captionTiming = [0, 1].map(() => ({ script: short.script, durationSec: 15, voiceSec: 3, pauses: [] }));
    f.compose.mockResolvedValueOnce({ ...composed(), captions: [], captionTiming, preview: { file: "/tmp/preview.mp4", sizeBytes: 5 } } as never);
    const output = await runMarketingVideo(f.deps, f.job, new AbortController().signal);
    expect(output).toMatchObject({ captionTiming, preview: { url: "/static/result.mp4" } });
    // Both videos and the full output commit in one transaction.
    const sent = f.storing.query.mock.calls as unknown as [string, unknown[]?][];
    const assets = sent.filter(([sql]) => sql.startsWith("INSERT INTO assets")).map(([sql, params]) => ({ sql, id: params![0], storageKey: params![3] }));
    expect(assets).toHaveLength(2);
    expect(assets[0].storageKey).toBe(`${(output as { assetIds: string[] }).assetIds[0]}.mp4`);
    expect(assets[1].id).toBe((output as { preview: { assetId: string } }).preview.assetId);
    expect(assets[1].storageKey).toMatch(/-preview\.mp4$/);
    expect(assets[1].sql).toContain("true)");
    const stored = sent.find(([sql]) => sql.startsWith("UPDATE tasks SET output"))!;
    expect(JSON.parse(stored[1]![1] as string)).toEqual(output);
    expect(sent.map(([sql]) => sql.split(/[ (]/)[0])).toEqual(["BEGIN", "INSERT", "INSERT", "UPDATE", "COMMIT"]);
    expect(f.storing.release).toHaveBeenCalledOnce();
    expect(f.db.createAsset).not.toHaveBeenCalled();
    const calls = f.db.pool.query.mock.calls as unknown as unknown[][];
    const prune = calls.find(([sql]) => String(sql).startsWith("DELETE FROM assets"));
    expect(prune?.[1]).toEqual(["owner", "project", "parent", "%-preview.mp4"]);
  });

  it("recovers the full output of a video stored before the queue recorded it", async () => {
    const f = fixture([short]);
    const stored = { assetIds: ["final"], assets: [{ url: "/static/final.mp4", mime: "video/mp4" }], quality: { checked: true }, captions: [],
      captionTiming: [], preview: { assetId: "copy", url: "/static/copy.mp4" } };
    f.db.pool.query.mockImplementation((async (sql: string) => ({ rows: sql.startsWith("SELECT * FROM assets") ? [{ id: "final", url: "/static/final.mp4", mime: "video/mp4" }]
      : sql.startsWith("SELECT output FROM tasks") ? [{ output: stored }] : [] })) as never);
    await expect(runMarketingVideo(f.deps, f.job, new AbortController().signal)).resolves.toEqual(stored);
    expect(f.compose).not.toHaveBeenCalled();
  });

  it("reports a draft this worker cannot read as a server problem before any provider is resolved", async () => {
    vi.mocked(runGenerationJob).mockClear();
    const f = fixture([short]);
    Object.assign(f.job.input, { draft: { ...f.job.input.draft, newerField: true } });
    await expect(runMarketingVideo(f.deps, f.job, new AbortController().signal)).rejects.toMatchObject({ errorCode: "CONFIG_MISSING" });
    expect(f.generation).not.toHaveBeenCalled();
    expect(runGenerationJob).not.toHaveBeenCalled();
  });

  it("never moves a clip's progress back when the vendor reports less", async () => {
    vi.mocked(runGenerationJob).mockClear();
    const f = fixture([short, short]);
    vi.mocked(runGenerationJob).mockImplementationOnce(async (deps, job) => {
      for (const value of [40, 0, 20, 60]) await deps.updateProgress(job.id, value);
      return { assetIds: [`asset-${job.id}`], assets: [] } as never;
    });
    await runMarketingVideo(f.deps, f.job, new AbortController().signal);
    const shown = f.db.raiseTaskProgress.mock.calls.map(call => (call as unknown[])[1]);
    expect(shown.slice(0, 4)).toEqual([17, 17, 17, 25]);
    expect(shown).toEqual([...shown].sort((a, b) => Number(a) - Number(b)));
    expect(shown.at(-1)).toBe(90);
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
    f.generation.mockResolvedValue({ modelId: "kling-video-v3-omni", db: {}, provider: { create }, meter: { record: vi.fn() }, storage: { putStream: vi.fn() } } as never);
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
      meter: { record: vi.fn() }, storage: { putStream: vi.fn(async () => ({ url: "/static/result.mp4" })) } } as never);
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
      meter: { record: vi.fn() }, storage: { putStream: vi.fn(async () => ({ url: "/static/result.mp4" })) } } as never);
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
  it("submits four clips at once by default and the configured number otherwise", async () => {
    expect(await peak()).toBe(4);
    expect(await peak(2)).toBe(2);
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
    f.generation.mockResolvedValue({ modelId: "kling-video-v3-omni", db: {}, provider: {}, meter: { record }, storage: { putStream: vi.fn(async () => ({ url: "/static/result.mp4" })) } } as never);
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
    f.compose.mockResolvedValueOnce({ ...composed(), quality } as never);
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
