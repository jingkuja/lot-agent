import { describe, expect, it } from "vitest";
import { validateReferenceMedia } from "./video-references.js";

describe("video reference uploads", () => {
  const read = async (value: number) => value;
  it("accepts three clips totaling exactly 15 seconds", async () => {
    await expect(validateReferenceMedia([4, 5, 6], "视频", read)).resolves.toBeUndefined();
  });
  it("rejects excess count and combined duration", async () => {
    await expect(validateReferenceMedia([1, 1, 1, 1], "音频", read)).rejects.toThrow("最多 3 段");
    await expect(validateReferenceMedia([8, 7.1], "视频", read)).rejects.toThrow("总时长不能超过 15 秒");
  });
  it("rejects unreadable and invalid durations", async () => {
    for (const duration of [NaN, Infinity, 0, -1]) {
      await expect(validateReferenceMedia([duration], "音频", read)).rejects.toThrow("无法读取");
    }
    await expect(validateReferenceMedia([1], "视频", async () => { throw new Error("decode"); })).rejects.toThrow();
  });
});
