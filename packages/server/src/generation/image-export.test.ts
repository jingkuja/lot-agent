import { describe, expect, it } from "vitest";
import sharp from "sharp";
import JSZip from "jszip";
import { buildExportZip, fitDetailImages, fitMainImage, IMAGE_EXPORT_PRESETS, parseExportPreset, safeExportName } from "./image-export.js";

async function noisy(width: number, height: number): Promise<Buffer> {
  // Random pixels compress badly, so the size limit is really exercised.
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(Math.random() * 256);
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe("image export", () => {
  const taobao = IMAGE_EXPORT_PRESETS.taobao!;

  it("puts a whole image on the platform's white square, under its file limit", async () => {
    const out = await fitMainImage(await noisy(1536, 1024), taobao);
    expect(await sharp(out).metadata()).toMatchObject({ format: "jpeg", width: 800, height: 800 });
    expect(out.byteLength).toBeLessThanOrEqual(taobao.maxBytes);
    // 3:2 on a square: the top band is white padding, not cropped image.
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect(Array.from(data.subarray(0, 3)).every((value) => value > 245)).toBe(true);
  });

  it("keeps the detail width and splits at a nearby source-image boundary", async () => {
    const image = await sharp({ create: { width: 1024, height: 4096, channels: 3, background: "teal" } }).png().toBuffer();
    const slices = await fitDetailImages(image, taobao, [1800]);
    const sizes = await Promise.all(slices.map((slice) => sharp(slice).metadata()));
    expect(sizes.map(({ width, height }) => [width, height])).toEqual([[750, 1318], [750, 1500], [750, 182]]);
  });

  it("splits further until every slice fits the byte cap", async () => {
    const image = await noisy(320, 800);
    const maxBytes = 24_000;
    const slices = await fitDetailImages(image, { ...taobao, detailWidth: 320, maxBytes });
    expect(slices.length).toBeGreaterThan(1);
    expect(slices.every((body) => body.byteLength <= maxBytes)).toBe(true);
    const sizes = await Promise.all(slices.map((slice) => sharp(slice).metadata()));
    expect(sizes.reduce((height, slice) => height + (slice.height ?? 0), 0)).toBe(800);
  });

  it("numbers long-detail files in top-to-bottom order and leaves the original whole", async () => {
    const image = await sharp({ create: { width: 750, height: 3100, channels: 3, background: "teal" } }).jpeg().toBuffer();
    const source = { name: "长图", body: image, ext: "jpg", detail: true };
    const platform = await JSZip.loadAsync(await buildExportZip([source], "taobao"));
    expect(Object.keys(platform.files)).toEqual(["长图_01.jpg", "长图_02.jpg", "长图_03.jpg"]);
    const original = await JSZip.loadAsync(await buildExportZip([source], "original"));
    expect(Object.keys(original.files)).toEqual(["长图.jpg"]);
  });

  it("zips the files under their names, original bytes for 原图 and JPEG for a platform", async () => {
    const red = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#ff0000" } }).png().toBuffer();
    const sources = [
      { name: "主图_01", body: red, ext: "png", detail: false },
      { name: "主图_01", body: red, ext: "png", detail: false },
      { name: "长图", body: red, ext: "jpg", detail: true },
    ];
    const original = await JSZip.loadAsync(await buildExportZip(sources, "original"));
    expect(Object.keys(original.files)).toEqual(["主图_01.png", "主图_01_2.png", "长图.jpg"]);
    expect(Buffer.from(await original.file("主图_01.png")!.async("uint8array")).equals(red)).toBe(true);
    const sized = await JSZip.loadAsync(await buildExportZip(sources, "douyin"));
    expect(Object.keys(sized.files)).toEqual(["主图_01.jpg", "主图_01_2.jpg", "长图.jpg"]);
    const main = Buffer.from(await sized.file("主图_01.jpg")!.async("uint8array"));
    expect(await sharp(main).metadata()).toMatchObject({ width: 800, height: 800 });
  });

  it("accepts only known presets and keeps file names safe", () => {
    expect(parseExportPreset("taobao")).toBe("taobao");
    expect(parseExportPreset("toString")).toBeNull();
    expect(parseExportPreset("amazon")).toBeNull();
    expect(safeExportName("../../etc/主图:01", "x")).toBe("....etc主图01");
    expect(safeExportName("", "图片_01")).toBe("图片_01");
    expect(safeExportName(42, "图片_01")).toBe("图片_01");
  });
});
