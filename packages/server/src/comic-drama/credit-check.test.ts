import { describe, expect, it, vi } from "vitest";
import type { ComicFrozenGenerationInput } from "@lot-agent/core/comic-drama";
import { createComicVideoCreditCheck } from "./credit-check.js";

const image = { mediaId: "media", version: 1, mime: "image/png", width: 720, height: 1280, sizeBytes: 100 } as const;
const input: ComicFrozenGenerationInput = {
  schemaVersion: 1, promptVersion: 1,
  seriesId: "series", seriesRevision: 1, clipId: "clip", clipRevision: 1, mode: "from_keyframe", modelId: "doubao-seedance-2-5",
  aspectRatio: "9:16", durationMs: 8000, styleKey: "webtoon", firstFrame: { ...image, takeId: null },
  references: [{ ...image, kind: "scene", label: "Scene" }, { ...image, kind: "prop", label: "Prop" }], prompt: "Do not send this to pricing",
};

function setup(managed = true, managedKey: string | null = "managed-key") {
  const db = {
    getUserById: vi.fn(async () => ({ external_user_id: 42, api_key: "own-key", managed_api_key: managedKey })),
  };
  const quote = { model: input.modelId, pricingScheme: "video_per_second", estimatedPoints: 100, estimatedQuota: 500_000 };
  const gateway = {
    listModels: vi.fn(async () => ({ llm: [], image: [], video: [input.modelId] })),
    estimateModelCost: vi.fn(async () => quote),
    getManagedBalance: vi.fn(async () => ({ remainAmount: 1, allowBalanceFallback: false })),
  };
  return { db, gateway, quote, check: createComicVideoCreditCheck(db, gateway, managed) };
}

describe("comic video preflight", () => {
  it("uses the user's key, frozen media counts and fresh managed balance for each segment", async () => {
    const { db, gateway, check } = setup();
    const signal = new AbortController().signal;
    expect(await check("owner", input, signal)).toBeNull();
    expect(db.getUserById).toHaveBeenCalledWith("owner");
    expect(gateway.estimateModelCost).toHaveBeenCalledWith("managed-key", {
      model: input.modelId, video: { resolution: "720p", seconds: 8, has_video_input: false, input_image_count: 3 },
      request_parameters: { resolution: "720p", generate_audio: false, ratio: "adaptive", estimate_ratio: "16:9" },
    }, expect.any(AbortSignal));
    expect(gateway.getManagedBalance).toHaveBeenCalledWith(42, expect.any(AbortSignal));
    gateway.getManagedBalance.mockResolvedValueOnce({ remainAmount: 0.8, allowBalanceFallback: false });
    expect(await check("owner", input, signal)).toEqual({ reason: "insufficient", availablePoints: 80, requiredPoints: 100 });
    expect(await check("owner", input, signal)).toBeNull();
  });

  it("follows the managed key even in non-managed mode and compares fractional costs at full precision", async () => {
    const { quote, gateway, check } = setup(false);
    const signal = new AbortController().signal;
    gateway.getManagedBalance.mockResolvedValue({ remainAmount: 0.29, allowBalanceFallback: false });
    gateway.estimateModelCost.mockResolvedValueOnce({ ...quote, estimatedPoints: 29 });
    expect(await check("owner", input, signal)).toBeNull();
    gateway.estimateModelCost.mockResolvedValueOnce({ ...quote, estimatedPoints: 29.00001 });
    expect(await check("owner", input, signal)).toEqual({ reason: "insufficient", availablePoints: 29, requiredPoints: 29.00001 });
    gateway.getManagedBalance.mockResolvedValue({ remainAmount: 0, allowBalanceFallback: false });
    expect(await check("owner", input, signal)).toEqual({ reason: "insufficient", availablePoints: 0, requiredPoints: 100 });
    gateway.estimateModelCost.mockResolvedValueOnce({ ...quote, estimatedPoints: 0 });
    expect(await check("owner", input, signal)).toBeNull();
  });

  it("quotes the frozen H3 resolution and only the approved first frame", async () => {
    const { quote, gateway, check } = setup();
    const model = "minimax-video-h3";
    gateway.estimateModelCost.mockResolvedValueOnce({ ...quote, model });
    await expect(check("owner", { ...input, modelId: model, resolution: "768P", references: [] }, new AbortController().signal)).resolves.toBeNull();
    expect(gateway.estimateModelCost).toHaveBeenCalledWith("managed-key", {
      model, video: { resolution: "768P", seconds: 8, has_video_input: false, input_image_count: 1 },
      request_parameters: { resolution: "768P", generate_audio: false, ratio: "adaptive", estimate_ratio: "16:9" },
    }, expect.any(AbortSignal));
  });

  it("lets TokenHub check wallet funding when fallback is enabled, even with zero managed credits", async () => {
    const { gateway, check } = setup();
    gateway.getManagedBalance.mockResolvedValue({ remainAmount: 0, allowBalanceFallback: true });
    expect(await check("owner", input, new AbortController().signal)).toBeNull();
    expect(gateway.estimateModelCost).not.toHaveBeenCalled();
  });

  it("uses gateway admission for an ordinary key and requires the managed key in managed mode", async () => {
    const signal = new AbortController().signal;
    const ordinary = setup(false, null);
    expect(await ordinary.check("owner", input, signal)).toBeNull();
    expect(ordinary.gateway.getManagedBalance).not.toHaveBeenCalled();
    expect(ordinary.gateway.estimateModelCost).not.toHaveBeenCalled();
    const managed = setup(true, null);
    expect(await managed.check("owner", input, signal)).toEqual({ reason: "unavailable" });
    expect(managed.gateway.getManagedBalance).not.toHaveBeenCalled();
  });

  it("distinguishes lookup failures from low balance, and preserves cancellation", async () => {
    const { gateway, check } = setup();
    const controller = new AbortController();
    gateway.estimateModelCost.mockRejectedValueOnce(new Error("pricing down"));
    expect(await check("owner", input, controller.signal)).toEqual({ reason: "unavailable" });
    expect(gateway.getManagedBalance).toHaveBeenCalledOnce();
    gateway.getManagedBalance.mockRejectedValueOnce(new Error("balance down"));
    expect(await check("owner", input, controller.signal)).toEqual({ reason: "unavailable" });
    gateway.getManagedBalance.mockResolvedValueOnce({ remainAmount: NaN, allowBalanceFallback: false });
    expect(await check("owner", input, controller.signal)).toEqual({ reason: "unavailable" });
    controller.abort();
    await expect(check("owner", input, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
