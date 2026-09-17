import { describe, expect, it } from "vitest";
import {
  DEFAULT_MINIPROGRAM_CONFIG,
  downshiftMiniprogramImageSize,
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
  it("defaults to per-tier models and a single gpt-image-2 backup", () => {
    expect(parseMiniprogramConfig(undefined)).toEqual(DEFAULT_MINIPROGRAM_CONFIG);
    expect(DEFAULT_MINIPROGRAM_CONFIG.llm).toBe("deepseek-v4-flash");
    expect(DEFAULT_MINIPROGRAM_CONFIG.image).toEqual({
      "1": seedream,  // 快速
      "2": sunburst,  // 高清
      "3": flare,     // 自动/标准
    });
    expect(DEFAULT_MINIPROGRAM_CONFIG.imageFallbacks).toEqual([gpt2]);
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
      // Slots not overridden fall back to the defaults, so a partial override
      // never silently unmaps a tier.
      image: { "1": "fast-v2", "2": "quality-v2", "3": flare },
      imageFallbacks: ["a", "b"],
    });
  });
});

describe("isMiniprogramImageSlot / client", () => {
  it("recognizes slot ids and the client header", () => {
    expect(isMiniprogramImageSlot("1")).toBe(true);
    expect(isMiniprogramImageSlot("2")).toBe(true);
    expect(isMiniprogramImageSlot("3")).toBe(true);
    expect(isMiniprogramImageSlot("gpt-image-2.5-flare")).toBe(false);
    expect(isMiniprogramClient("miniprogram")).toBe(true);
    expect(isMiniprogramClient("Miniprogram")).toBe(true);
    expect(isMiniprogramClient("web")).toBe(false);
  });
});

describe("resolveMiniprogramImageModel", () => {
  it("maps each slot to its tier model when everything is in the catalog", () => {
    const catalog = [flare, sunburst, gpt2, seedream];
    expect(resolveMiniprogramImageModel("1", catalog)).toBe(seedream);
    expect(resolveMiniprogramImageModel("2", catalog)).toBe(sunburst);
    expect(resolveMiniprogramImageModel("3", catalog)).toBe(flare);
  });

  it("keeps the mapped default when the catalog was not loaded", () => {
    expect(resolveMiniprogramImageModel("1", null)).toBe(seedream);
    expect(resolveMiniprogramImageModel("2", undefined)).toBe(sunburst);
    expect(resolveMiniprogramImageModel("3", undefined)).toBe(flare);
  });

  it("falls back to gpt-image-2 when the preferred model is missing", () => {
    expect(resolveMiniprogramImageModel("1", [gpt2])).toBe(gpt2);
    expect(resolveMiniprogramImageModel("2", [gpt2])).toBe(gpt2);
    expect(resolveMiniprogramImageModel("3", [gpt2])).toBe(gpt2);
  });

  it("does not cross quality tiers when the catalog only has another primary", () => {
    // 快速 preferred missing but 高清 available → still the shared backup,
    // never a silent upgrade that would bill differently.
    expect(resolveMiniprogramImageModel("1", [sunburst, gpt2])).toBe(gpt2);
    expect(resolveMiniprogramImageModel("2", [seedream, gpt2])).toBe(gpt2);
    expect(resolveMiniprogramImageModel("3", [seedream, gpt2])).toBe(gpt2);
  });

  it("keeps the preferred model when nothing is resolvable", () => {
    expect(resolveMiniprogramImageModel("2", ["unrelated-model"])).toBe(sunburst);
  });
});

describe("downshiftMiniprogramImageSize", () => {
  it("快速 drops every ratio one step", () => {
    expect(downshiftMiniprogramImageSize("1", "1024x1024")).toBe("960x960");
    expect(downshiftMiniprogramImageSize("1", "1536x1024")).toBe("1200x800");
    expect(downshiftMiniprogramImageSize("1", "1024x1536")).toBe("800x1200");
    expect(downshiftMiniprogramImageSize("1", "1920x1088")).toBe("1280x720");
    expect(downshiftMiniprogramImageSize("1", "1088x1920")).toBe("720x1280");
  });

  it("keeps every fast-tier rung inside Seedream's pixel window", () => {
    // Vendor constraint (Seedream 5.0 Pro): pixels ∈ [921600, 4624220] and
    // both edges stay multiples of 16. A rung that drifts outside this window
    // fails at the vendor with a 400, not at our own validator.
    const SEEDREAM_MIN = 921_600;
    const SEEDREAM_MAX = 4_624_220;
    for (const size of ["1024x1024", "1536x1024", "1024x1536", "1920x1088", "1088x1920"]) {
      const [w, h] = downshiftMiniprogramImageSize("1", size).split("x").map(Number);
      expect(w % 16).toBe(0);
      expect(h % 16).toBe(0);
      expect(w * h).toBeGreaterThanOrEqual(SEEDREAM_MIN);
      expect(w * h).toBeLessThanOrEqual(SEEDREAM_MAX);
    }
  });

  it("自动/标准 drops only the wide 16:9 and 9:16 ratios", () => {
    expect(downshiftMiniprogramImageSize("3", "1920x1088")).toBe("1536x864");
    expect(downshiftMiniprogramImageSize("3", "1088x1920")).toBe("864x1536");
    expect(downshiftMiniprogramImageSize("3", "1024x1024")).toBe("1024x1024");
    expect(downshiftMiniprogramImageSize("3", "1536x1024")).toBe("1536x1024");
    expect(downshiftMiniprogramImageSize("3", "1024x1536")).toBe("1024x1536");
  });

  it("高清 keeps the original resolution", () => {
    expect(downshiftMiniprogramImageSize("2", "1920x1088")).toBe("1920x1088");
    expect(downshiftMiniprogramImageSize("2", "1024x1024")).toBe("1024x1024");
  });

  it("leaves unknown or malformed sizes untouched for the validator", () => {
    expect(downshiftMiniprogramImageSize("1", "999x999")).toBe("999x999");
    expect(downshiftMiniprogramImageSize("1", "not-a-size")).toBe("not-a-size");
  });
});
