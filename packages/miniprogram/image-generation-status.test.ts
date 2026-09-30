import { describe, expect, it } from "vitest";
import { createImageGenerationStatus } from "./miniprogram/services/image-generation-status.js";

describe("image generation status", () => {
  it("starts each progress stage with its primary message", () => {
    const status = createImageGenerationStatus();
    expect(status(0, 0)).toBe("正在构思画面");
    expect(status(20, 6000)).toBe("正在勾勒构图");
    expect(status(50, 16000)).toBe("正在描绘画面");
    expect(status(80, 35000)).toBe("正在润色图片");
    expect(status(90, 48000)).toBe("正在优化图片细节");
  });

  it("rotates while progress is capped without returning to an earlier stage", () => {
    const status = createImageGenerationStatus();
    expect(status(95, 60000)).toBe("正在优化图片细节");
    expect(status(95, 64999)).toBe("正在优化图片细节");
    expect(status(95, 65000)).toBe("正在优化整体风格");
    expect(status(95, 70000)).toBe("正在打磨画面质感");
    expect(status(95, 75000)).toBe("正在优化图片细节");
  });

  it("keeps independent rotation state for each generation", () => {
    const first = createImageGenerationStatus();
    first(95, 0);
    expect(first(95, 5000)).toBe("正在优化整体风格");
    expect(createImageGenerationStatus()(95, 5000)).toBe("正在优化图片细节");
  });
});
