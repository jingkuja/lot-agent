import { describe, expect, it, vi } from "vitest";
import { MarketingDraftSchema, storyboardScript, type MarketingShot } from "@lot-agent/core/marketing-video";
import { runMarketingVideo, type MarketingRunDeps } from "./run.js";
import { runGenerationJob } from "../generation/run-job.js";
import { ProviderError } from "@lot-agent/core";

const store = vi.hoisted(() => ({ get: vi.fn(), segments: vi.fn() }));
vi.mock("./repository.js", () => ({ PgMarketingProjectStore: class {
  get = store.get;
  segments = store.segments;
} }));
vi.mock("./media.js", () => ({
  composeMarketingVideo: vi.fn(),
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
  async function submitWith(error: Error) {
    const f = fixture([shot, shot]);
    f.db.pool.query.mockImplementation(async () => ({ rows: [], rowCount: 1 }) as never);
    const create = vi.fn(async () => { throw error; });
    f.generation.mockResolvedValue({ modelId: "kling-video-v3-omni", db: {}, provider: { create }, meter: { record: vi.fn() }, storage: { put: vi.fn() } } as never);
    vi.mocked(runGenerationJob).mockImplementation(async (deps) => { await deps.provider.create({} as never); throw new Error("unreachable"); });
    const result = runMarketingVideo(f.deps, f.job, new AbortController().signal);
    const released = () => (f.db.pool.query.mock.calls as unknown[][]).some(([sql]) => String(sql).includes("SET vendor_task_id=NULL WHERE id=$1 AND vendor_task_id=$2"));
    return { result, released };
  }
  it("releases the claim after an explicit vendor rejection so the user can retry after fixing it", async () => {
    for (const error of [new ProviderError("generation", "create", "HTTP_ERROR", { httpStatus: 429 }), new ProviderError("generation", "create", "REAL_PERSON_REJECTED", { httpStatus: 400 }), new ProviderError("generation", "create", "CONNECT_ERROR")]) {
      const f = await submitWith(error);
      await expect(f.result).rejects.toBe(error);
      expect(f.released()).toBe(true);
    }
  });
  it("keeps ambiguous submissions blocked to avoid paying twice", async () => {
    for (const error of [new ProviderError("generation", "create", "TRANSPORT_ERROR"), new ProviderError("generation", "create", "HTTP_ERROR", { httpStatus: 502 }), new Error("socket hang up")]) {
      const f = await submitWith(error);
      await expect(f.result).rejects.toThrow("片段提交结果未知");
      expect(f.released()).toBe(false);
    }
    vi.mocked(runGenerationJob).mockReset();
    vi.mocked(runGenerationJob).mockImplementation(async (_deps: unknown, job: { id: string }) => ({ assetIds: [`asset-${job.id}`], assets: [] }) as never);
  });
});
