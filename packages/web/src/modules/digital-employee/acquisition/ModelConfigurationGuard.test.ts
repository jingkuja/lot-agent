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
  it("prefers the catalog list over a single selected id", () => {
    expect(listedAcquisitionModels({
      llm: true, llmModelId: "gpt-5.4", llmModels: [{ id: "gpt-5.4" }],
      image: true, video: false, imageModelId: "gpt-image-2.0", videoModelId: null,
      imageModels: [{ id: "gpt-image-2.0" }, { id: "flux-pro" }], videoModels: [],
      configurationUrl: "https://wetok.ai/",
    }, "image")).toEqual([{ id: "gpt-image-2.0" }, { id: "flux-pro" }]);
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
