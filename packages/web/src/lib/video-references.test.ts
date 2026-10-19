import { describe, expect, it } from "vitest";
import { durationsUpTo, grokReferencesIssue, klingReferenceImageIssue, klingReferenceVideoIssue, validateReferenceMedia } from "./video-references.js";

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

describe("Kling reference video limits", () => {
  const mp4 = { name: "ref.mp4", type: "video/mp4", size: 10 * 1024 * 1024 };
  const meta = (width: number, height: number, duration = 5) => ({ duration, width, height });
  it("accepts the inclusive boundaries", () => {
    expect(klingReferenceVideoIssue(mp4, meta(720, 1280, 3))).toBeUndefined();
    expect(klingReferenceVideoIssue({ ...mp4, name: "ref.MOV", type: "" }, meta(3840, 2160, 15.5))).toBeUndefined();
    expect(klingReferenceVideoIssue(mp4, meta(700, 1400))).toBeUndefined();
    expect(klingReferenceVideoIssue({ ...mp4, size: 200 * 1024 * 1024 }, meta(1080, 1920))).toBeUndefined();
  });
  it("rejects each official limit", () => {
    expect(klingReferenceVideoIssue({ ...mp4, name: "ref.webm", type: "video/webm" }, meta(1080, 1920))).toContain("MP4、MOV");
    expect(klingReferenceVideoIssue({ ...mp4, size: 200 * 1024 * 1024 + 1 }, meta(1080, 1920))).toContain("200MB");
    expect(klingReferenceVideoIssue(mp4, meta(1080, 1920, 2.9))).toContain("3–15.5 秒");
    expect(klingReferenceVideoIssue(mp4, meta(1080, 1920, 15.6))).toContain("3–15.5 秒");
    expect(klingReferenceVideoIssue(mp4, meta(699, 1280))).toContain("700–4553px");
    expect(klingReferenceVideoIssue(mp4, meta(1000, 4554))).toContain("700–4553px");
    expect(klingReferenceVideoIssue(mp4, meta(3000, 3000))).toContain("8294400");
    expect(klingReferenceVideoIssue(mp4, meta(1000, 2600))).toContain("0.4–2");
    expect(klingReferenceVideoIssue(mp4, meta(0, 0))).toContain("分辨率");
  });
});

describe("Kling reference image limits", () => {
  const png = { name: "ref.png", type: "image/png", size: 1024 * 1024 };
  it("accepts the inclusive boundaries", () => {
    expect(klingReferenceImageIssue(png, { width: 300, height: 300 })).toBeUndefined();
    expect(klingReferenceImageIssue(png, { width: 750, height: 300 })).toBeUndefined();
    expect(klingReferenceImageIssue({ ...png, name: "ref.JPEG", type: "", size: 50 * 1024 * 1024 }, { width: 300, height: 750 })).toBeUndefined();
  });
  it("rejects each official limit", () => {
    expect(klingReferenceImageIssue({ ...png, name: "ref.webp", type: "image/webp" }, { width: 800, height: 800 })).toContain("JPG、JPEG、PNG");
    expect(klingReferenceImageIssue({ ...png, size: 50 * 1024 * 1024 + 1 }, { width: 800, height: 800 })).toContain("50MB");
    expect(klingReferenceImageIssue(png, { width: 299, height: 600 })).toContain("300px");
    expect(klingReferenceImageIssue(png, { width: 751, height: 300 })).toContain("1:2.5–2.5:1");
    expect(klingReferenceImageIssue(png, { width: 300, height: 751 })).toContain("1:2.5–2.5:1");
    expect(klingReferenceImageIssue(png, { width: 0, height: 0 })).toContain("无法读取");
  });
});

describe("Grok reference rules", () => {
  it("rejects references that a Grok reference video would ignore", () => {
    const none = { images: 0, videos: 0, audios: 0, frames: 0 };
    expect(grokReferencesIssue({ ...none, images: 9, audios: 3, frames: 2 })).toBeUndefined();
    expect(grokReferencesIssue({ ...none, videos: 1 })).toBeUndefined();
    expect(grokReferencesIssue({ ...none, videos: 2 })).toContain("1 段");
    for (const extra of [{ images: 1 }, { audios: 1 }, { frames: 1 }]) {
      expect(grokReferencesIssue({ ...none, videos: 1, ...extra })).toContain("不会使用");
    }
  });
});

describe("Grok reference video duration", () => {
  it("keeps only choices up to 8 seconds and rejects longer requests", () => {
    expect(durationsUpTo(["4秒", "8秒", "9秒", "15秒"], 8)).toEqual(["4秒", "8秒"]);
    expect(grokReferencesIssue({ images: 0, videos: 1, audios: 0, frames: 0, durationSec: 8 })).toBeUndefined();
    expect(grokReferencesIssue({ images: 0, videos: 1, audios: 0, frames: 0, durationSec: 9 })).toContain("8 秒");
  });
});
