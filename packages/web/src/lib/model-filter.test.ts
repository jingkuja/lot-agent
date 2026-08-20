import { describe, it, expect } from "vitest";
import {
  filterModels,
  isGptImage15,
  isSeedance25Model,
  isSeedanceModel,
  missingSeedanceMentions,
  seedanceAssetMention,
} from "./model-filter.js";

const models = [
  { id: "gpt-5.4", type: "llm" as const, provider: "openai" },
  { id: "deepseek-v4-pro", type: "llm" as const, provider: "openai" },
  { id: "GLM-5.2", type: "llm" as const, provider: "openai" },
];

describe("filterModels", () => {
  it("returns all when query empty", () => {
    expect(filterModels(models, "")).toHaveLength(3);
  });
  it("matches case-insensitive substring on id", () => {
    expect(filterModels(models, "deep").map((m) => m.id)).toEqual(["deepseek-v4-pro"]);
    expect(filterModels(models, "glm").map((m) => m.id)).toEqual(["GLM-5.2"]);
    expect(filterModels(models, "5").map((m) => m.id)).toEqual(["gpt-5.4", "GLM-5.2"]);
  });
});

describe("isGptImage15", () => {
  it("matches gpt-image 1.5 ids across separators", () => {
    expect(isGptImage15("gpt-image-1.5")).toBe(true);
    expect(isGptImage15("gpt-image-1-5")).toBe(true);
    expect(isGptImage15("GPT-Image 1.5")).toBe(true);
    expect(isGptImage15("gpt-image1.5")).toBe(true);
  });

  it("does not match other gpt-image models", () => {
    expect(isGptImage15("gpt-image-1")).toBe(false);
    expect(isGptImage15("gpt-image-2")).toBe(false);
    expect(isGptImage15("gpt-image-2.0")).toBe(false);
    expect(isGptImage15(null)).toBe(false);
    expect(isGptImage15(undefined)).toBe(false);
  });
});

describe("isSeedanceModel", () => {
  it("matches seedance ids case-insensitively", () => {
    expect(isSeedanceModel("doubao-seedance-2.0")).toBe(true);
    expect(isSeedanceModel("Seedance-2.0")).toBe(true);
    expect(isSeedanceModel("kling-standard")).toBe(false);
    expect(isSeedanceModel(null)).toBe(false);
    expect(isSeedanceModel(undefined)).toBe(false);
  });
});

describe("isSeedance25Model", () => {
  it("matches 2.5 ids across separators", () => {
    expect(isSeedance25Model("doubao-seedance-2.5")).toBe(true);
    expect(isSeedance25Model("doubao-seedance-2-5")).toBe(true);
    expect(isSeedance25Model("Seedance-2.5-pro")).toBe(true);
    expect(isSeedance25Model("seedance25")).toBe(true);
  });
  it("does not match 2.0 or non-seedance ids", () => {
    expect(isSeedance25Model("doubao-seedance-2.0")).toBe(false);
    expect(isSeedance25Model("doubao-seedance-2-0")).toBe(false);
    expect(isSeedance25Model("kling-standard")).toBe(false);
    expect(isSeedance25Model(null)).toBe(false);
    expect(isSeedance25Model(undefined)).toBe(false);
  });
});

describe("seedanceAssetMention", () => {
  it("numbers from upload order (1-based)", () => {
    expect(seedanceAssetMention("Image", 0)).toBe("@Image1");
    expect(seedanceAssetMention("Video", 1)).toBe("@Video2");
    expect(seedanceAssetMention("Audio", 0)).toBe("@Audio1");
  });
});

describe("missingSeedanceMentions", () => {
  it("returns tags not present in the prompt", () => {
    expect(missingSeedanceMentions("用 @Image1 生成", { images: 2, videos: 1 })).toEqual([
      "@Image2",
      "@Video1",
    ]);
  });
  it("is case-insensitive and empty when all mentions exist", () => {
    expect(
      missingSeedanceMentions("@image1 参考 @VIDEO1 和 @audio1", {
        images: 1,
        videos: 1,
        audios: 1,
      })
    ).toEqual([]);
  });
});
