import { describe, it, expect } from "vitest";
import {
  filterModels,
  isGptImage15,
  isGptImage2,
  isGptImage25Flare,
  isGptImage25Sunburst,
  isH3MaxModel,
  isKlingModel,
  isMinimaxH3Model,
  isSeedance25Model,
  isSeedanceModel,
  missingSeedanceMentions,
  moveClaudeModelsToEnd,
  seedanceAssetMention,
  visibleImageModels,
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

describe("moveClaudeModelsToEnd", () => {
  it("stably moves every Claude model behind all other models", () => {
    const input = [
      { id: "claude-opus-4.1", type: "llm" as const, provider: "openai" },
      { id: "gpt-5.4", type: "llm" as const, provider: "openai" },
      { id: "Claude-Sonnet-4.5", type: "llm" as const, provider: "openai" },
      { id: "deepseek-v4", type: "llm" as const, provider: "openai" },
      { id: "claude-haiku-4.5", type: "llm" as const, provider: "openai" },
    ];

    expect(moveClaudeModelsToEnd(input).map((model) => model.id)).toEqual([
      "gpt-5.4",
      "deepseek-v4",
      "claude-opus-4.1",
      "Claude-Sonnet-4.5",
      "claude-haiku-4.5",
    ]);
    expect(input.map((model) => model.id)).toEqual([
      "claude-opus-4.1",
      "gpt-5.4",
      "Claude-Sonnet-4.5",
      "deepseek-v4",
      "claude-haiku-4.5",
    ]);
  });
});

const img = (id: string) => ({ id, type: "image" as const, provider: "tokenhub" });

describe("isGptImage25Flare / Sunburst / 2", () => {
  it("matches flare and sunburst across separators", () => {
    expect(isGptImage25Flare("gpt-image-2.5-flare")).toBe(true);
    expect(isGptImage25Flare("GPT-Image-2-5-Flare")).toBe(true);
    expect(isGptImage25Sunburst("gpt-image-2.5-sunburst")).toBe(true);
    expect(isGptImage25Flare("gpt-image-2.5-sunburst")).toBe(false);
    expect(isGptImage25Sunburst("gpt-image-2.5-flare")).toBe(false);
  });

  it("matches gpt-image-2 without treating 2.5 variants as version 2", () => {
    expect(isGptImage2("gpt-image-2")).toBe(true);
    expect(isGptImage2("gpt-image-2-token")).toBe(true);
    expect(isGptImage2("gpt-image-2.5-flare")).toBe(false);
    expect(isGptImage2("gpt-image-2.5-sunburst")).toBe(false);
    expect(isGptImage2("gpt-image-1.5")).toBe(false);
  });
});

describe("visibleImageModels", () => {
  it("shows flare as 默认 and sunburst as 旗舰, hiding other catalog ids", () => {
    const out = visibleImageModels([
      img("wanx-standard"),
      img("gpt-image-2.5-sunburst"),
      img("gpt-image-2"),
      img("gpt-image-2.5-flare"),
    ]);
    expect(out.map((m) => ({ id: m.id, label: m.label }))).toEqual([
      { id: "gpt-image-2.5-flare", label: "默认" },
      { id: "gpt-image-2.5-sunburst", label: "旗舰" },
    ]);
  });

  it("falls back to gpt-image-2 as 默认 when both 2.5 models are missing", () => {
    expect(visibleImageModels([img("wanx-standard"), img("gpt-image-2")])).toEqual([
      { id: "gpt-image-2", type: "image", provider: "tokenhub", label: "默认" },
    ]);
  });

  it("does not fall back to gpt-image-2 when either 2.5 model is present", () => {
    expect(visibleImageModels([img("gpt-image-2.5-sunburst"), img("gpt-image-2")]).map((m) => m.id)).toEqual([
      "gpt-image-2.5-sunburst",
    ]);
    expect(visibleImageModels([img("gpt-image-2.5-flare"), img("gpt-image-2")]).map((m) => m.label)).toEqual([
      "默认",
    ]);
  });

  it("returns empty when none of the three allowed models exist", () => {
    expect(visibleImageModels([img("wanx-standard"), img("qwen-image-2.0")])).toEqual([]);
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

describe("isKlingModel", () => {
  it("matches ids that start with kling, case-insensitively", () => {
    expect(isKlingModel("kling-video-v3-omni")).toBe(true);
    expect(isKlingModel("kling-standard")).toBe(true);
    expect(isKlingModel("Kling-Video-v3")).toBe(true);
  });

  it("does not match other video models or empty ids", () => {
    expect(isKlingModel("doubao-seedance-2.0")).toBe(false);
    expect(isKlingModel("openai-video-kling")).toBe(false);
    expect(isKlingModel("")).toBe(false);
    expect(isKlingModel(null)).toBe(false);
    expect(isKlingModel(undefined)).toBe(false);
  });
});

describe("isH3MaxModel", () => {
  it("matches h3-max ids across separators", () => {
    expect(isH3MaxModel("h3-max")).toBe(true);
    expect(isH3MaxModel("minimax-video-h3-max")).toBe(true);
    expect(isH3MaxModel("MiniMax-H3-Max")).toBe(true);
    expect(isH3MaxModel("h3_max")).toBe(true);
  });

  it("does not match MiniMax H3 or empty ids", () => {
    expect(isH3MaxModel("minimax-video-h3")).toBe(false);
    expect(isH3MaxModel("kling-standard")).toBe(false);
    expect(isH3MaxModel(null)).toBe(false);
    expect(isH3MaxModel(undefined)).toBe(false);
  });
});

describe("isMinimaxH3Model", () => {
  it("matches MiniMax H3 ids and excludes H3 Max", () => {
    expect(isMinimaxH3Model("minimax-video-h3")).toBe(true);
    expect(isMinimaxH3Model("MiniMax-H3")).toBe(true);
    expect(isMinimaxH3Model("minimax-h3")).toBe(true);
    expect(isMinimaxH3Model("h3-max")).toBe(false);
    expect(isMinimaxH3Model("minimax-video-h3-max")).toBe(false);
  });

  it("does not match other video models or empty ids", () => {
    expect(isMinimaxH3Model("kling-video-v3-omni")).toBe(false);
    expect(isMinimaxH3Model("doubao-seedance-2.0")).toBe(false);
    expect(isMinimaxH3Model(null)).toBe(false);
    expect(isMinimaxH3Model(undefined)).toBe(false);
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
