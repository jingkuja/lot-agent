import { describe, it, expect } from "vitest";
import {
  billedVideoSeconds,
  finalizeImageSettings,
  pickGenerationSettings,
  pickVideoReferenceInputs,
} from "./input.js";

describe("pickGenerationSettings", () => {
  it("keeps only the image whitelist (size, n, quality) with matching types", () => {
    expect(
      pickGenerationSettings("image", {
        size: "1024x1024",
        n: 2,
        quality: "high",
        durationSec: 5, // video-only — dropped for image
        extra: "x",
      })
    ).toEqual({ size: "1024x1024", n: 2, quality: "high" });
  });

  it("keeps the video whitelist (size, durationSec, ratio)", () => {
    expect(
      pickGenerationSettings("video", {
        durationSec: 5,
        ratio: "16:9",
        size: "720x1280", // required by the openai-video endpoint
        n: 3, // image-only — dropped for video
      })
    ).toEqual({ size: "720x1280", durationSec: 5, ratio: "16:9" });
  });

  it("keeps seedance reference-video adaptive settings (durationSec -1, ratio adaptive)", () => {
    expect(
      pickGenerationSettings("video", {
        durationSec: -1,
        ratio: "adaptive",
        size: "720x1280",
      })
    ).toEqual({ size: "720x1280", durationSec: -1, ratio: "adaptive" });
  });

  it("bills adaptive duration as the default 5 seconds", () => {
    expect(billedVideoSeconds(-1)).toBe(5);
    expect(billedVideoSeconds(10)).toBe(10);
    expect(billedVideoSeconds(undefined)).toBe(5);
  });

  it("drops server identity fields no matter what the client sends", () => {
    expect(
      pickGenerationSettings("image", {
        n: 1,
        assistantMessageId: "victim-message",
        conversationId: "victim-conversation",
        userId: "victim-user",
        taskId: "victim-task",
      })
    ).toEqual({ n: 1 });
  });

  it("drops whitelisted keys carrying the wrong type", () => {
    expect(
      pickGenerationSettings("image", { size: 123, n: "two" })
    ).toEqual({});
  });

  it("handles a missing settings object", () => {
    expect(pickGenerationSettings("video", undefined)).toEqual({});
  });

  it("defaults image quality to auto and accepts the three presets", () => {
    expect(finalizeImageSettings({ size: "1536x1024" })).toEqual({
      settings: { size: "1536x1024", quality: "auto" },
      error: null,
    });
    expect(finalizeImageSettings({ size: "1024x1536", quality: "low" }).error).toBeNull();
  });

  it("rejects custom sizes that are not multiples of 16 or exceed 1:3 / 3:1", () => {
    expect(finalizeImageSettings({ size: "1000x1000" }).error).toBe("宽和高都必须能被 16 整除");
    expect(finalizeImageSettings({ size: "1000x1024" }).error).toBe("宽度必须能被 16 整除");
    expect(finalizeImageSettings({ size: "1024x1000" }).error).toBe("高度必须能被 16 整除");
    expect(finalizeImageSettings({ size: "1024x768" }).error).toBeNull();
    expect(finalizeImageSettings({ size: "1024x576" }).error).toBe("分辨率过低，宽×高不能小于 655360 像素");
    expect(finalizeImageSettings({ size: "512x2048" }).error).toBe("宽高比不能超过 1:3 或 3:1");
  });

  it("rejects custom sizes on gpt-image 1.5", () => {
    expect(finalizeImageSettings({ size: "1280x720" }, "gpt-image-1.5").error).toBe(
      "当前模型不支持自定义分辨率"
    );
    expect(finalizeImageSettings({ size: "1024x1024" }, "gpt-image-1.5").error).toBeNull();
    expect(finalizeImageSettings({ size: "1280x720" }, "gpt-image-2").error).toBeNull();
  });

  it("rejects unknown quality values", () => {
    expect(finalizeImageSettings({ quality: "hd" }).error).toBe("质量仅支持 auto、low、medium、high");
  });

  it("keeps video references and frame fields with their API shape", () => {
    expect(pickVideoReferenceInputs({
      input_reference: ["a", "b"],
      reference_video: "v",
      reference_audio: ["a1", "a2"],
      first_frame: "first",
      last_frame: "last",
      assistantMessageId: "forged",
    })).toEqual({
      input_reference: ["a", "b"],
      reference_video: "v",
      reference_audio: ["a1", "a2"],
      first_frame: "first",
      last_frame: "last",
    });
  });

  it("enforces the product limits for video references", () => {
    expect(() => pickVideoReferenceInputs({ input_reference: ["1", "2", "3", "4", "5", "6"] })).toThrow(/at most 5/);
    expect(() => pickVideoReferenceInputs({ reference_video: ["1", "2", "3"] })).toThrow(/at most 2/);
    expect(() => pickVideoReferenceInputs({ reference_audio: ["1", "2", "3"] })).toThrow(/at most 2/);
  });
});
