import { describe, expect, it } from "vitest";
import { imageModelForQuality } from "./miniprogram/services/config";

describe("imageModelForQuality", () => {
  it("maps each quality tier to its server-side slot", () => {
    // "1" 快速 → seedream, "2" 高清 → sunburst, "3" 自动/标准 → flare
    expect(imageModelForQuality("low")).toBe("1");
    expect(imageModelForQuality("high")).toBe("2");
    expect(imageModelForQuality("auto")).toBe("3");
    expect(imageModelForQuality("medium")).toBe("3");
  });

  it("treats unknown qualities as the standard tier", () => {
    expect(imageModelForQuality("")).toBe("3");
    expect(imageModelForQuality("ultra")).toBe("3");
  });
});
