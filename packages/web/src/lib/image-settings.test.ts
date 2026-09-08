import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_IMAGE_SIZE,
  IMAGE_PRESET_SIZES,
  IMAGE_QUALITY_VALUES,
  imageSizeError,
  parseImageSize,
} from "./image-settings.js";

describe("image size presets", () => {
  it("offers the three default resolutions", () => {
    expect(IMAGE_PRESET_SIZES).toEqual(["1024x1024", "1536x1024", "1024x1536"]);
  });

  it("defaults quality to auto", () => {
    expect(DEFAULT_IMAGE_SIZE).toBe("1024x1024");
    expect(DEFAULT_IMAGE_QUALITY).toBe("auto");
    expect(IMAGE_QUALITY_VALUES).toEqual(["auto", "low", "medium", "high"]);
  });
});

describe("parseImageSize", () => {
  it("parses WxH", () => {
    expect(parseImageSize("1536x1024")).toEqual({ width: 1536, height: 1024 });
  });

  it("rejects malformed values", () => {
    expect(parseImageSize("")).toBeNull();
    expect(parseImageSize("1024")).toBeNull();
    expect(parseImageSize("1024*1024")).toBeNull();
    expect(parseImageSize("0x1024")).toBeNull();
  });
});

describe("imageSizeError", () => {
  it("accepts the three presets", () => {
    for (const size of IMAGE_PRESET_SIZES) {
      expect(imageSizeError(size)).toBeNull();
      expect(imageSizeError(size, "gpt-image-1.5")).toBeNull();
    }
  });

  it("requires width and height to each be divisible by 16", () => {
    expect(imageSizeError("1000x1000")).toBe("宽和高都必须能被 16 整除");
    expect(imageSizeError("1000x1024")).toBe("宽度必须能被 16 整除");
    expect(imageSizeError("1024x1000")).toBe("高度必须能被 16 整除");
    expect(imageSizeError("1025x1025")).toBe("宽和高都必须能被 16 整除");
    expect(imageSizeError("1280x720")).toBeNull();
  });

  it("rejects sizes below the vendor pixel budget (e.g. old 16:9 1024x576)", () => {
    expect(imageSizeError("1024x576")).toBe("分辨率过低，宽×高不能小于 655360 像素");
    expect(imageSizeError("576x1024")).toBe("分辨率过低，宽×高不能小于 655360 像素");
    expect(imageSizeError("16x16")).toBe("分辨率过低，宽×高不能小于 655360 像素");
    expect(imageSizeError("1024x640")).toBeNull();
  });

  it("allows any ratio between 1:3 and 3:1, not only those two extremes", () => {
    expect(imageSizeError("1024x1024")).toBeNull(); // 1:1
    expect(imageSizeError("1280x720")).toBeNull(); // 16:9
    expect(imageSizeError("1024x768")).toBeNull(); // 4:3
    expect(imageSizeError("768x1024")).toBeNull(); // 3:4
    expect(imageSizeError("512x1536")).toBeNull(); // 1:3 boundary
    expect(imageSizeError("1536x512")).toBeNull(); // 3:1 boundary
    expect(imageSizeError("512x2048")).toBe("宽高比不能超过 1:3 或 3:1");
    expect(imageSizeError("2048x512")).toBe("宽高比不能超过 1:3 或 3:1");
  });

  it("blocks custom sizes on gpt-image 1.5", () => {
    expect(imageSizeError("1280x720", "gpt-image-1.5")).toBe("当前模型不支持自定义分辨率");
    expect(imageSizeError("1280x720", "gpt-image-2")).toBeNull();
  });

  it("rejects empty / malformed size", () => {
    expect(imageSizeError("x1024")).toBe("请输入有效的分辨率");
  });
});
