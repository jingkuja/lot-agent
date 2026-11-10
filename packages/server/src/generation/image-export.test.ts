import { describe, expect, it } from "vitest";
import sharp from "sharp";
import JSZip from "jszip";
import { buildExportZip, fitDetailImage, fitMainImage, IMAGE_EXPORT_PRESETS, parseExportPreset, safeExportName } from "./image-export.js";

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

  it("scales a long image to the detail-page width", async () => {
    const out = await fitDetailImage(await noisy(1024, 4096), taobao);
    expect(await sharp(out).metadata()).toMatchObject({ width: 750, height: 3000 });
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
