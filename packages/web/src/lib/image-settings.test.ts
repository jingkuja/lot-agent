import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_IMAGE_SIZE,
  IMAGE_PRESET_SIZES,
  IMAGE_QUALITY_VALUES,
  imageSizeError,
  nearestImageRatio,
  parseImageSize,
} from "./image-settings.js";

describe("nearestImageRatio", () => {
  it("picks the listed ratio closest to a reference image", () => {
    expect(nearestImageRatio(1920, 1080)).toBe("16:9");
    expect(nearestImageRatio(1080, 1350)).toBe("4:5");
    expect(nearestImageRatio(3000, 2000)).toBe("3:2");
    expect(nearestImageRatio(500, 510)).toBe("1:1");
    expect(nearestImageRatio(2560, 1080)).toBe("21:9");
    expect(nearestImageRatio(0, 0)).toBe("1:1");
  });
});

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

describe("image sets", () => {
  it("starts 产品套图 at 4 images and 主副图 at 2, and leaves the other types alone", async () => {
    const { IMAGE_SCENES } = await import("./image-settings.js");
    const counts = Object.fromEntries(IMAGE_SCENES.map((scene) => [scene.value, scene.count]));
    expect(counts).toEqual({ free: undefined, product_set: 4, main_images: 2, white_background: undefined });
  });

  it("names each image of a set and nothing else", async () => {
    const { imageSetRole } = await import("./image-settings.js");
    expect([0, 1, 2, 3].map((index) => imageSetRole("product_set", index))).toEqual(["封面", "卖点", "使用场景", "细节"]);
    expect([0, 1, 2, 3].map((index) => imageSetRole("main_images", index))).toEqual(["主图", "其他角度", "细节", "使用场景"]);
    expect(imageSetRole("product_set", 4)).toBeUndefined();
    expect(imageSetRole("white_background", 0)).toBeUndefined();
    expect(imageSetRole(undefined, 0)).toBeUndefined();
  });

  it("reads stored composites and drops malformed ones", async () => {
    const { generationComposites } = await import("./image-settings.js");
    expect(generationComposites([{ url: "/a.jpg", mime: "image/jpeg", layout: "grid", gap: true }, { url: "/b.jpg", mime: "image/jpeg", layout: "spiral" }]))
      .toEqual([{ url: "/a.jpg", mime: "image/jpeg", layout: "grid", gap: true }]);
    expect(generationComposites(undefined)).toBeUndefined();
    expect(generationComposites([])).toBeUndefined();
  });
});

describe("generationRedo", () => {
  it("reads a running or failed redo and drops anything else", async () => {
    const { generationRedo } = await import("./image-settings.js");
    expect(generationRedo({ status: "running", indexes: [1, "x", -1], taskId: "r1" })).toEqual({ status: "running", indexes: [1], taskId: "r1" });
    expect(generationRedo({ status: "failed", indexes: [0], error: "boom" })).toEqual({ status: "failed", indexes: [0], error: "boom" });
    expect(generationRedo({ status: "done", indexes: [0] })).toBeUndefined();
    expect(generationRedo(null)).toBeUndefined();
  });
});
