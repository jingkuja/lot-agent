import { describe, it, expect } from "vitest";
import { filterModels, isSeedanceModel } from "./model-filter.js";

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

describe("isSeedanceModel", () => {
  it("matches seedance ids case-insensitively", () => {
    expect(isSeedanceModel("doubao-seedance-2.0")).toBe(true);
    expect(isSeedanceModel("Seedance-2.0")).toBe(true);
    expect(isSeedanceModel("kling-standard")).toBe(false);
    expect(isSeedanceModel(null)).toBe(false);
    expect(isSeedanceModel(undefined)).toBe(false);
  });
});
