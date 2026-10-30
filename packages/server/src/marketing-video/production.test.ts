import { describe, expect, it, vi } from "vitest";
import { GROK_MARKETING_PROFILE, MarketingDraftSchema, SEEDANCE_MARKETING_PROFILE, storyboardScript, type MarketingProject } from "@lot-agent/core/marketing-video";
import { MarketingProduction, newJobInput, type MarketingProductionDeps } from "./production.js";
import type { OwnedMaterial } from "./materials.js";

vi.mock("./media.js", () => ({ mediaCapabilities: vi.fn(async () => ({ composition: true, subtitles: true })), SUBTITLES_UNAVAILABLE: "字幕不可用" }));

const id = "11111111-1111-4111-8111-111111111111";
const shots = [1, 2].map(() => ({ durationSec: 15, script: "欢迎来到转角咖啡店，现磨咖啡等你来。", visual: "咖啡店", action: "展示咖啡", camera: "中景" }));
const draft = MarketingDraftSchema.parse({ durationSec: 30, script: storyboardScript(shots), storyboard: shots, publishTitle: "咖啡", tags: "#咖啡" });
const material = (assetId: string): OwnedMaterial => ({ id: assetId, url: `/static/uploads/${assetId}.png`, name: assetId, mime: "image/png" });

function fixture(project: Partial<MarketingProject> = {}) {
  const p = { id, version: 2, draft, taskId: null, status: "draft", review: null, reviewedScript: null, progress: 0, updatedAt: "", knowledgeItemId: null,
    ...project } as MarketingProject;
  const deps = {
    service: {
      db: { getTask: vi.fn(async () => null), getAsset: vi.fn(async () => null) },
      jobQueue: { deliverPersisted: vi.fn(async () => {}), canResumePersisted: vi.fn(async () => true) },
      usageMeter: { checkQuota: vi.fn(async () => ({ ok: true })) },
      modelRegistry: { getConfig: () => undefined }, modelCatalog: { defaultPricing: {}, pricing: {} },
    },
    store: { segments: vi.fn(async () => []), reserve: vi.fn(async () => "task"), get: vi.fn(async () => p), revise: vi.fn(async () => "redo") },
    narrator: { frozen: vi.fn(), synthesize: vi.fn() },
    keyArtist: { frozen: vi.fn(async () => undefined) },
    materials: { check: vi.fn(async () => ({})) },
    activeProfile: GROK_MARKETING_PROFILE,
  };
  return { p, deps, production: new MarketingProduction(deps as unknown as MarketingProductionDeps) };
}
const signal = new AbortController().signal;

describe("new job input", () => {
  it("sizes the frame like composition and submits the chosen images before the key-art still", () => {
    const portrait = "22222222-2222-4222-8222-222222222222", product = "33333333-3333-4333-8333-333333333333";
    const withImages = MarketingDraftSchema.parse({ ...draft, quality: "1080p", ratio: "16:9", assets: { product: [product], portrait: [portrait] } });
    const input = newJobInput(withImages, GROK_MARKETING_PROFILE, { [portrait]: material(portrait), [product]: material(product) }, { id: "still", url: "/static/uploads/still.png" });
    expect(input.size).toBe("1920x1080");
    expect(input.input_reference).toEqual([`/static/uploads/${portrait}.png`, `/static/uploads/${product}.png`, "/static/uploads/still.png"]);
    expect(input).toMatchObject({ key_art: "still", local_subtitles: true, generate_audio: true, modelId: GROK_MARKETING_PROFILE.modelId });
    for (const [quality, ratio, size] of [["720p", "9:16", "720x1280"], ["720p", "1:1", "720x720"], ["1080p", "9:16", "1080x1920"]] as const) {
      expect(newJobInput(MarketingDraftSchema.parse({ ...draft, quality, ratio }), GROK_MARKETING_PROFILE, {}).size).toBe(size);
    }
  });
  it("keeps a voice sample only for the model's own speech", () => {
    const voice = { id: "voice", url: "/static/uploads/voice.wav", name: "voice", mime: "audio/wav" };
    expect(newJobInput(draft, GROK_MARKETING_PROFILE, { voice }).reference_audio).toEqual([voice.url]);
    const narrated = MarketingDraftSchema.parse({ ...draft, narration: {} });
    expect(newJobInput(narrated, GROK_MARKETING_PROFILE, { voice })).toMatchObject({ generate_audio: false, reference_audio: undefined });
  });
});

describe("marketing production", () => {
  it("delivers a new video's job after the checks, without a quota for an unpriced model", async () => {
    const f = fixture();
    expect(await f.production.generate("owner", f.p, { version: 2, retry: false }, signal)).toEqual({ project: f.p });
    expect(f.deps.materials.check).toHaveBeenCalledWith("owner", draft, GROK_MARKETING_PROFILE, 4, true, signal);
    expect(f.deps.store.reserve).toHaveBeenCalledWith("owner", id, 2, expect.objectContaining({ size: "720x1280", local_subtitles: true }), false);
    expect(f.deps.service.jobQueue.deliverPersisted).toHaveBeenCalledWith("task", "marketing.video");
  });
  it("makes a 1080p video with its key-art still with Seedance 2.5", async () => {
    const f = fixture({ draft: MarketingDraftSchema.parse({ ...draft, quality: "1080p" }) });
    f.deps.keyArtist.frozen.mockResolvedValueOnce({ id: "still", url: "/static/uploads/still.png" } as never);
    expect(await f.production.generate("owner", f.p, { version: 2, retry: false }, signal)).toEqual({ project: f.p });
    expect(f.deps.materials.check).toHaveBeenCalledWith("owner", f.p.draft, SEEDANCE_MARKETING_PROFILE, 4, true, signal);
    expect(f.deps.store.reserve).toHaveBeenCalledWith("owner", id, 2, expect.objectContaining({ modelId: "doubao-seedance-2-5", key_art: "still",
      size: "1080x1920" }), false);
  });
  it("counts the key-art still against the 720p limit of references when a stopped Grok shot is redone", async () => {
    const task = { user_id: "owner", type: "marketing.video", status: "succeeded", input: { projectId: id, modelId: GROK_MARKETING_PROFILE.modelId,
      marketingInputVersion: 4, key_art: "still", local_subtitles: true } };
    const f = fixture({ taskId: "done", status: "succeeded", revision: { modelId: GROK_MARKETING_PROFILE.modelId } as never,
      draft: MarketingDraftSchema.parse({ ...draft, quality: "1080p" }) });
    f.deps.service.db.getTask.mockResolvedValueOnce(task as never);
    await expect(f.production.revise("owner", f.p, { version: 2, shots: [0] }, signal))
      .rejects.toMatchObject({ status: 400, message: "使用定妆图时最高支持 720p，请将画质改为 720p。" });
    expect(f.deps.store.revise).not.toHaveBeenCalled();
  });
  it("redelivers a queued job instead of creating another one", async () => {
    const f = fixture({ taskId: "queued", status: "pending" });
    expect(await f.production.generate("owner", f.p, { version: 1, retry: true }, signal)).toEqual({ project: f.p });
    expect(f.deps.service.jobQueue.deliverPersisted).toHaveBeenCalledWith("queued", "marketing.video");
    expect(f.deps.store.reserve).not.toHaveBeenCalled();
  });
  it("returns the quota refusal and saves nothing", async () => {
    const f = fixture();
    f.deps.service.usageMeter.checkQuota.mockResolvedValueOnce({ ok: false, reason: "daily limit", code: "DAILY_LIMIT_EXCEEDED" } as never);
    expect(await f.production.generate("owner", f.p, { version: 2, retry: false }, signal)).toEqual({ quota: { error: "daily limit", code: "DAILY_LIMIT_EXCEEDED" } });
    expect(f.deps.store.reserve).not.toHaveBeenCalled();
  });
  it("refuses a stale version and a stopped job that cannot continue", async () => {
    const f = fixture();
    await expect(f.production.generate("owner", f.p, { version: 1, retry: false }, signal)).rejects.toMatchObject({ status: 409 });
    const stopped = fixture({ taskId: "old", status: "failed" });
    await expect(stopped.production.generate("owner", stopped.p, { version: 2, retry: true }, signal)).rejects.toMatchObject({ status: 409, message: "原任务不可恢复。" });
    expect(stopped.deps.store.reserve).not.toHaveBeenCalled();
  });
  it("redoes shots only of a video that offers a revision", async () => {
    const f = fixture({ taskId: "done", status: "succeeded" });
    await expect(f.production.revise("owner", f.p, { version: 2, shots: [0] }, signal)).rejects.toMatchObject({ status: 409 });
    expect(f.deps.store.revise).not.toHaveBeenCalled();
  });
});
