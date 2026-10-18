import { describe, expect, it } from "vitest";
import { assetTextFileName, feedbackCount, generationStateLabel, generationStopped } from "./asset-delivery.js";

describe("generationStateLabel", () => {
  it("does not show cancelled or queued assets as generating", () => {
    expect(generationStateLabel("cancelled")).toBe("已取消");
    expect(generationStateLabel("pending")).toBe("排队中");
    expect(generationStateLabel("running")).toBe("正在生成");
    expect(generationStopped("cancelled")).toBe(true);
    expect(generationStopped("running")).toBe(false);
  });
});

describe("feedbackCount", () => {
  it("keeps blank fields empty and accepts non-negative integers", () => {
    expect(feedbackCount("")).toBeNull();
    expect(feedbackCount(" 50 ")).toBe(50);
    expect(feedbackCount("0")).toBe(0);
  });

  it("rejects values that would otherwise be silently rewritten", () => {
    for (const value of ["-3", "1.5", "1e3x", "abc"]) expect(() => feedbackCount(value)).toThrow("非负整数");
  });
});

describe("assetTextFileName", () => {
  it("strips characters that are invalid in file names", () => {
    expect(assetTextFileName("国庆/到店:活动")).toBe("国庆 到店 活动.txt");
    expect(assetTextFileName("  ")).toBe("营销文案.txt");
  });
});
