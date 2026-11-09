import { describe, it, expect } from "vitest";
import {
  billedVideoSeconds,
  finalizeImageSettings,
  IMAGE_RATIOS,
  imageSizeForTier,
  pickGenerationSettings,
  validateImageGenerationSettings,
  pickVideoReferenceInputs,
  resolveVideoGenerateAudio,
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

  it("keeps the video whitelist (size, durationSec, ratio, quality, generate_audio)", () => {
    expect(
      pickGenerationSettings("video", {
        durationSec: 5,
        ratio: "16:9",
        size: "720x1280", // required by the openai-video endpoint
        quality: "720p",
        generate_audio: false,
        n: 3, // image-only — dropped for video
      })
    ).toEqual({ size: "720x1280", durationSec: 5, ratio: "16:9", quality: "720p", generate_audio: false });
  });

  it("accepts string resolutions for video and image tiers", () => {
    expect(pickGenerationSettings("video", { resolution: "1080p" })).toEqual({ resolution: "1080p" });
    expect(pickGenerationSettings("video", { resolution: 1080 })).toEqual({});
    expect(pickGenerationSettings("image", { resolution: "2K", ratio: "4:3", n: 2 })).toEqual({ resolution: "2K", ratio: "4:3", n: 2 });
  });

  it("drops a video audio flag carrying the wrong type", () => {
    expect(pickGenerationSettings("video", { generate_audio: "false" })).toEqual({});
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

  it("maps 1K / 2K / 4K and every ratio to a valid standard size", () => {
    expect(imageSizeForTier("1K", "1:1")).toBe("1024x1024");
    expect(imageSizeForTier("2K", "1:1")).toBe("2048x2048");
    expect(imageSizeForTier("4K", "1:1")).toBe("2880x2880");
    expect(imageSizeForTier("4K", "16:9")).toBe("3840x2160");
    expect(imageSizeForTier("4K", "9:16")).toBe("2160x3840");
    expect(imageSizeForTier("2K", "3:2", "gpt-image-1.5")).toBe("1536x1024");
    expect(imageSizeForTier("8K", "1:1")).toBeNull();
    expect(imageSizeForTier("2K", "7:3")).toBeNull();
    for (const tier of ["1K", "2K", "4K"]) {
      for (const ratio of IMAGE_RATIOS) {
        const size = imageSizeForTier(tier, ratio)!;
        expect(validateImageGenerationSettings({ size }), `${tier} ${ratio} ${size}`).toBeNull();
        const [w, h] = size.split("x").map(Number);
        const [rw, rh] = ratio.split(":").map(Number);
        expect(Math.abs(w / h - rw / rh) / (rw / rh)).toBeLessThan(0.02);
      }
    }
  });

  it("derives the size from a tier and ratio, replacing any client size", () => {
    expect(finalizeImageSettings({ resolution: "4k", ratio: "16:9", size: "1024x1024", n: 3 })).toEqual({
      settings: { resolution: "4K", ratio: "16:9", size: "3840x2160", n: 3, quality: "auto" },
      error: null,
    });
    expect(finalizeImageSettings({ resolution: "2K" }).error).toBe("请选择有效的清晰度和图片比例");
    expect(finalizeImageSettings({ resolution: "2K", ratio: "auto" }).error).toBe("请选择有效的清晰度和图片比例");
  });

  it("allows one to four images", () => {
    expect(finalizeImageSettings({ size: "1024x1024", n: 4 }).error).toBeNull();
    expect(finalizeImageSettings({ size: "1024x1024", n: 5 }).error).toBe("图片张数仅支持 1–4 张");
    expect(finalizeImageSettings({ size: "1024x1024", n: 1.5 }).error).toBe("图片张数仅支持 1–4 张");
    expect(finalizeImageSettings({ size: "1024x1024", n: 0 }).error).toBe("图片张数仅支持 1–4 张");
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

  it("accepts the maximum reference counts and one image per frame", () => {
    const references = {
      input_reference: Array.from({ length: 9 }, (_, i) => `image${i}`),
      reference_video: ["v1", "v2", "v3"],
      reference_audio: ["a1", "a2", "a3"],
      first_frame: "first",
      last_frame: "last",
    };
    expect(pickVideoReferenceInputs(references)).toEqual(references);
    expect(() => pickVideoReferenceInputs({ first_frame: ["a", "b"] })).toThrow();
    expect(() => pickVideoReferenceInputs({ last_frame: ["a", "b"] })).toThrow();
  });

  it("enforces the product limits for video references", () => {
    expect(() => pickVideoReferenceInputs({ input_reference: Array.from({ length: 10 }, (_, i) => String(i)) })).toThrow(/at most 9/);
    expect(() => pickVideoReferenceInputs({ reference_video: ["1", "2", "3", "4"] })).toThrow(/at most 3/);
    expect(() => pickVideoReferenceInputs({ reference_audio: ["1", "2", "3", "4"] })).toThrow(/at most 3/);
  });

  it("enables generated audio when a reference audio is present", () => {
    expect(resolveVideoGenerateAudio(false, "/static/uploads/reference.mp3")).toBe(true);
    expect(resolveVideoGenerateAudio(false, ["/static/uploads/reference.mp3"])).toBe(true);
    expect(resolveVideoGenerateAudio(false, [])).toBe(false);
    expect(resolveVideoGenerateAudio(undefined, undefined)).toBe(false);
    expect(resolveVideoGenerateAudio(true, undefined)).toBe(true);
  });
});
