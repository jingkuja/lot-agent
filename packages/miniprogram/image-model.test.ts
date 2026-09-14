import { describe, expect, it } from "vitest";
import { imageModelForQuality } from "./miniprogram/services/config";

describe("imageModelForQuality", () => {
  it("sends slot 1 for 快速 and slot 2 for every other quality", () => {
    expect(imageModelForQuality("low")).toBe("1");
    expect(imageModelForQuality("auto")).toBe("2");
    expect(imageModelForQuality("high")).toBe("2");
    expect(imageModelForQuality("medium")).toBe("2");
  });
});
