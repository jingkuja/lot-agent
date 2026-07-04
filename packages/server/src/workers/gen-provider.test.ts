import { describe, it, expect } from "vitest";
import { pickGenModel } from "./gen-provider.js";

describe("pickGenModel", () => {
  it("uses input.modelId when present", () => {
    expect(pickGenModel("image", { modelId: "gpt-image-2" }, "fallback")).toBe("gpt-image-2");
  });
  it("falls back when absent", () => {
    expect(pickGenModel("video", {}, "happyhorse-1.0-t2v")).toBe("happyhorse-1.0-t2v");
  });
});
