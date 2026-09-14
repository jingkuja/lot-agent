import { describe, expect, it } from "vitest";
import {
  DEFAULT_MINIPROGRAM_CONFIG,
  isMiniprogramClient,
  isMiniprogramImageSlot,
  parseMiniprogramConfig,
  resolveMiniprogramImageModel,
} from "./models.js";

const flare = "gpt-image-2.5-flare";
const sunburst = "gpt-image-2.5-sunburst";
const gpt2 = "gpt-image-2";
const seedream = "doubao-seedream-5-0-pro";

describe("parseMiniprogramConfig", () => {
  it("defaults to 2.5 flare/sunburst, deepseek-v4-flash, and ordered fallbacks", () => {
    expect(parseMiniprogramConfig(undefined)).toEqual(DEFAULT_MINIPROGRAM_CONFIG);
    expect(DEFAULT_MINIPROGRAM_CONFIG.llm).toBe("deepseek-v4-flash");
    expect(DEFAULT_MINIPROGRAM_CONFIG.image).toEqual({ "1": flare, "2": sunburst });
    expect(DEFAULT_MINIPROGRAM_CONFIG.imageFallbacks).toEqual([gpt2, seedream]);
  });

  it("lets the server override mapped models without a client change", () => {
    expect(
      parseMiniprogramConfig({
        llm: "other-llm",
        image: { "1": "fast-v2", "2": "quality-v2" },
        imageFallbacks: ["a", "b"],
      })
    ).toEqual({
      llm: "other-llm",
      image: { "1": "fast-v2", "2": "quality-v2" },
      imageFallbacks: ["a", "b"],
    });
  });
});

describe("isMiniprogramImageSlot / client", () => {
  it("recognizes slot ids and the client header", () => {
    expect(isMiniprogramImageSlot("1")).toBe(true);
    expect(isMiniprogramImageSlot("2")).toBe(true);
    expect(isMiniprogramImageSlot("gpt-image-2.5-flare")).toBe(false);
    expect(isMiniprogramClient("miniprogram")).toBe(true);
    expect(isMiniprogramClient("Miniprogram")).toBe(true);
    expect(isMiniprogramClient("web")).toBe(false);
  });
});

describe("resolveMiniprogramImageModel", () => {
  it("maps 1 to flare and 2 to sunburst when both 2.5 models are in the catalog", () => {
    const catalog = [flare, sunburst, gpt2, seedream];
    expect(resolveMiniprogramImageModel("1", catalog)).toBe(flare);
    expect(resolveMiniprogramImageModel("2", catalog)).toBe(sunburst);
  });

  it("keeps the mapped default when the catalog was not loaded", () => {
    expect(resolveMiniprogramImageModel("1", null)).toBe(flare);
    expect(resolveMiniprogramImageModel("2", undefined)).toBe(sunburst);
  });

  it("falls back to gpt-image-2 then seedream when both 2.5 models are missing", () => {
    expect(resolveMiniprogramImageModel("1", [gpt2, seedream])).toBe(gpt2);
    expect(resolveMiniprogramImageModel("2", [gpt2, seedream])).toBe(gpt2);
    expect(resolveMiniprogramImageModel("1", [seedream])).toBe(seedream);
    expect(resolveMiniprogramImageModel("2", [seedream])).toBe(seedream);
  });

  it("uses the other 2.5 model when only one of the pair is in the catalog", () => {
    expect(resolveMiniprogramImageModel("2", [flare, gpt2])).toBe(flare);
    expect(resolveMiniprogramImageModel("1", [sunburst])).toBe(sunburst);
  });
});
