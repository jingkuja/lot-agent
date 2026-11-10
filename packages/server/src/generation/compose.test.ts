import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { composeImages, composeLayoutFits, composePlan, outputStorageKey, parseComposeLayout, storedComposites } from "./compose.js";

const square = { width: 1024, height: 1024 };

async function solid(width: number, height: number, background: string): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
}

describe("composePlan", () => {
  it("stacks a long image without gaps", () => {
    const plan = composePlan([square, square, square, square], "vertical");
    expect(plan).toMatchObject({ width: 1024, height: 4096 });
    expect(plan.rects.map((rect) => rect.top)).toEqual([0, 1024, 2048, 3072]);
  });

  it("keeps each image's own shape in a long image", () => {
    const plan = composePlan([square, { width: 1024, height: 1536 }], "vertical");
    expect(plan.rects[1]).toEqual({ left: 0, top: 1024, width: 1024, height: 1536 });
    expect(plan.height).toBe(2560);
  });

  it("lays four images out as a 2×2 grid", () => {
    const plan = composePlan([square, square, square, square], "grid");
    expect(plan).toMatchObject({ width: 2048, height: 2048 });
    expect(plan.rects[3]).toEqual({ left: 1024, top: 1024, width: 1024, height: 1024 });
  });

  it("puts two images side by side and gives an odd last image the whole row", () => {
    expect(composePlan([square, square], "grid")).toMatchObject({ width: 2048, height: 1024 });
    const three = composePlan([square, square, square], "grid");
    expect(three.rects[2]).toEqual({ left: 0, top: 1024, width: 2048, height: 2048 });
  });

  it("puts one large image above a row of small ones", () => {
    const plan = composePlan([square, square, square, square], "hero");
    expect(plan.rects[0]).toEqual({ left: 0, top: 0, width: 1024, height: 1024 });
    expect(plan.rects.slice(1).map((rect) => [rect.left, rect.top, rect.width])).toEqual([[0, 1024, 341], [341, 1024, 341], [682, 1024, 341]]);
    expect(plan.height).toBe(1024 + 341);
  });

  it("scales large sources down to the width limit and adds margins when asked", () => {
    const plan = composePlan([{ width: 2880, height: 2880 }, { width: 2880, height: 2880 }], "vertical", { gap: true });
    expect(plan.width).toBe(2048);
    const [first, second] = plan.rects;
    expect(first).toEqual({ left: 41, top: 41, width: 1966, height: 1966 });
    expect(second.top).toBe(41 + 1966 + 41);
    expect(plan.height).toBe(second.top + 1966 + 41);
  });

  it("accepts another width limit for models with other sizes", () => {
    expect(composePlan([{ width: 4096, height: 4096 }, { width: 4096, height: 4096 }], "vertical", { maxWidth: 3000 }).width).toBe(3000);
  });

  it("rejects a layout the image count cannot fill", () => {
    expect(composeLayoutFits("hero", 2)).toBe(false);
    expect(composeLayoutFits("vertical", 1)).toBe(false);
    expect(() => composePlan([square, square], "hero")).toThrow();
  });
});

describe("composeImages", () => {
  it("writes one JPEG with every image in its place", async () => {
    const out = await composeImages([await solid(64, 64, "#ff0000"), await solid(64, 64, "#0000ff")], "vertical");
    expect(out).toMatchObject({ mime: "image/jpeg", width: 64, height: 128 });
    const { data, info } = await sharp(out.body).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([64, 128]);
    const pixel = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3));
    const [topRed, , topBlue] = pixel(32, 16);
    const [bottomRed, , bottomBlue] = pixel(32, 112);
    expect(topRed).toBeGreaterThan(200);
    expect(topBlue).toBeLessThan(60);
    expect(bottomBlue).toBeGreaterThan(200);
    expect(bottomRed).toBeLessThan(60);
  });

  it("fills the margins with white", async () => {
    const out = await composeImages([await solid(200, 200, "#000000"), await solid(200, 200, "#000000")], "grid", { gap: true });
    const { data } = await sharp(out.body).raw().toBuffer({ resolveWithObject: true });
    expect(Array.from(data.subarray(0, 3)).every((value) => value > 240)).toBe(true);
  });
});

describe("compose helpers", () => {
  it("reads the storage key from stored output URLs only", () => {
    expect(outputStorageKey("/static/assets/abc.png")).toBe("abc.png");
    expect(outputStorageKey("https://app.example/static/assets/abc.png?material_token=x")).toBe("abc.png");
    expect(outputStorageKey("https://vendor.example/out.png")).toBeNull();
    expect(outputStorageKey("/static/assets/..%2Fsecret")).toBeNull();
    expect(outputStorageKey("/static/uploads/abc.png")).toBeNull();
  });

  it("parses layouts and stored composites", () => {
    expect(parseComposeLayout("grid")).toBe("grid");
    expect(parseComposeLayout("spiral")).toBeNull();
    expect(storedComposites([{ url: "/static/assets/a.jpg", mime: "image/jpeg", layout: "hero" }, { url: "", layout: "grid" }, null]))
      .toEqual([{ url: "/static/assets/a.jpg", mime: "image/jpeg", layout: "hero", gap: false }]);
  });
});
