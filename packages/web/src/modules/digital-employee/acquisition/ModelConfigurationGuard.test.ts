import { describe, expect, it } from "vitest";
import { listedAcquisitionModels, pickAcquisitionModel } from "./acquisition-models.js";

describe("pickAcquisitionModel", () => {
  const models = [{ id: "gpt-image-2.0" }, { id: "flux-pro", label: "Flux" }];

  it("keeps a preferred model that is still in the catalog", () => {
    expect(pickAcquisitionModel(models, "flux-pro", "gpt-image-2.0")).toBe("flux-pro");
  });

  it("falls back to the catalog default when the stored model is gone", () => {
    expect(pickAcquisitionModel(models, "missing", "gpt-image-2.0")).toBe("gpt-image-2.0");
  });

  it("returns empty when no image or video models are available", () => {
    expect(pickAcquisitionModel([], "flux-pro", "gpt-image-2.0")).toBe("");
  });
});

describe("listedAcquisitionModels", () => {
  it("shows flare as 默认 and sunburst as 旗舰, hiding other image ids", () => {
    expect(listedAcquisitionModels({
      llm: true, llmModelId: "gpt-5.4", llmModels: [{ id: "gpt-5.4" }],
      image: true, video: false, imageModelId: "gpt-image-2", videoModelId: null,
      imageModels: [
        { id: "flux-pro" },
        { id: "gpt-image-2.5-sunburst" },
        { id: "gpt-image-2" },
        { id: "gpt-image-2.5-flare" },
      ], videoModels: [],
      configurationUrl: "https://wetok.ai/",
    }, "image")).toEqual([
      { id: "gpt-image-2.5-flare", label: "默认" },
      { id: "gpt-image-2.5-sunburst", label: "旗舰" },
    ]);
  });

  it("falls back to gpt-image-2 as 默认 when both 2.5 models are missing", () => {
    expect(listedAcquisitionModels({
      llm: true, llmModelId: "gpt-5.4", llmModels: [{ id: "gpt-5.4" }],
      image: true, video: false, imageModelId: "gpt-image-2", videoModelId: null,
      imageModels: [{ id: "gpt-image-2" }, { id: "flux-pro" }], videoModels: [],
      configurationUrl: "https://wetok.ai/",
    }, "image")).toEqual([{ id: "gpt-image-2", label: "默认" }]);
  });

  it("labels a selected gpt-image-2 as 默认 when the catalog list is empty", () => {
    expect(listedAcquisitionModels({
      llm: true, llmModelId: "gpt-5.4", llmModels: [{ id: "gpt-5.4" }],
      image: true, video: false, imageModelId: "gpt-image-2", videoModelId: null,
      imageModels: [], videoModels: [],
      configurationUrl: "https://wetok.ai/",
    }, "image")).toEqual([{ id: "gpt-image-2", label: "默认" }]);
  });

  it("returns empty when none of the allowed image models exist", () => {
    expect(listedAcquisitionModels({
      llm: true, llmModelId: "gpt-5.4", llmModels: [{ id: "gpt-5.4" }],
      image: true, video: false, imageModelId: "flux-pro", videoModelId: null,
      imageModels: [{ id: "flux-pro" }, { id: "qwen-image-2.0" }], videoModels: [],
      configurationUrl: "https://wetok.ai/",
    }, "image")).toEqual([]);
  });

  it("falls back to the selected id when the catalog list is empty", () => {
    expect(listedAcquisitionModels({
      llm: true, llmModelId: "gpt-5.4", llmModels: [{ id: "gpt-5.4" }],
      image: false, video: true, imageModelId: null, videoModelId: "seedance 2.0",
      imageModels: [], videoModels: [],
      configurationUrl: "https://wetok.ai/",
    }, "video")).toEqual([{ id: "seedance 2.0" }]);
  });

  it("lists LLM models for the copy composer", () => {
    expect(listedAcquisitionModels({
      llm: true, image: false, video: false,
      llmModelId: "gpt-5.4", imageModelId: null, videoModelId: null,
      llmModels: [{ id: "gpt-5.4" }, { id: "claude-sonnet", label: "Claude Sonnet" }],
      imageModels: [], videoModels: [], configurationUrl: "https://wetok.ai/",
    }, "llm")).toEqual([{ id: "gpt-5.4" }, { id: "claude-sonnet", label: "Claude Sonnet" }]);
  });
});
