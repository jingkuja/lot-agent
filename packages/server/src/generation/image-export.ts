/**
 * 打包下载: one finished generation's images (and its composites) resized for a selling platform and zipped, with
 * the file names the card shows. Local work only: no model request and nothing is metered.
 *
 * Platform numbers are the strictest values found in seller guides in 2026-11 (they disagree with each other and
 * change). Correct a platform here; the web lists only the ids and names (`web/src/lib/image-settings.ts`).
 */
import sharp, { type Sharp } from "sharp";
import JSZip from "jszip";

export interface ImageExportPreset {
  /** Main / gallery images: placed whole on a white square of this size. */
  width: number;
  height: number;
  /** Largest file the platform accepts; JPEG quality steps down to fit. */
  maxBytes: number;
  /** Width of long detail-page images (长图); their height follows. */
  detailWidth: number;
  detailMaxHeight: number;
}

const KB = 1024;
const MB = 1024 * KB;
// Shared export default until a platform requires a different height.
const DETAIL_SLICE_HEIGHT = 1500;

/** `original` keeps every file as it is. */
export const IMAGE_EXPORT_PRESETS: Record<string, ImageExportPreset | null> = {
  original: null,
  taobao: { width: 800, height: 800, maxBytes: 500 * KB, detailWidth: 750, detailMaxHeight: DETAIL_SLICE_HEIGHT },
  pinduoduo: { width: 800, height: 800, maxBytes: 1 * MB, detailWidth: 750, detailMaxHeight: DETAIL_SLICE_HEIGHT },
  douyin: { width: 800, height: 800, maxBytes: 1 * MB, detailWidth: 750, detailMaxHeight: DETAIL_SLICE_HEIGHT },
  shopee: { width: 1024, height: 1024, maxBytes: 2 * MB, detailWidth: 1024, detailMaxHeight: DETAIL_SLICE_HEIGHT },
  tiktok: { width: 1080, height: 1080, maxBytes: 2 * MB, detailWidth: 1080, detailMaxHeight: DETAIL_SLICE_HEIGHT },
};

export function parseExportPreset(value: unknown): string | null {
  return typeof value === "string" && Object.hasOwn(IMAGE_EXPORT_PRESETS, value) ? value : null;
}

const WHITE = { r: 255, g: 255, b: 255 };
const QUALITIES = [90, 85, 80, 72, 64, 56, 50];
const DETAIL_QUALITIES = [90, 72, 56];

async function jpegUnder(pipeline: () => Sharp, maxBytes: number, qualities = QUALITIES): Promise<Buffer> {
  for (const quality of qualities.slice(0, -1)) {
    const body = await pipeline().jpeg({ quality, mozjpeg: true }).toBuffer();
    if (body.byteLength <= maxBytes) return body;
  }
  // Still too big: hand over the lowest quality rather than fail the whole pack.
  return pipeline().jpeg({ quality: qualities[qualities.length - 1], mozjpeg: true }).toBuffer();
}

/** A gallery image: the whole image on a white square of the platform's size (never cropped). */
export function fitMainImage(image: Buffer, preset: ImageExportPreset): Promise<Buffer> {
  return jpegUnder(() => sharp(image).rotate().flatten({ background: WHITE })
    .resize(preset.width, preset.height, { fit: "contain", background: WHITE }), preset.maxBytes);
}

/** Resize once, then cut in reading order. Keep source-image boundaries when they fall near the end of a slice. */
export async function fitDetailImages(image: Buffer, preset: ImageExportPreset, boundaries: number[] = []): Promise<Buffer[]> {
  const source = sharp(image);
  const { autoOrient } = await source.metadata();
  const projectedPixels = Math.ceil(autoOrient.height * preset.detailWidth / autoOrient.width) * preset.detailWidth;
  if (!Number.isFinite(projectedPixels) || projectedPixels > 64_000_000) throw new Error("detail image is too large");
  const { data, info } = await source.rotate().flatten({ background: WHITE })
    .resize({ width: preset.detailWidth }).toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const cuts = boundaries.map((y) => Math.round(y * height / autoOrient.height))
    .filter((y) => y > 0 && y < height).sort((a, b) => b - a);
  const slices: Buffer[] = [];
  const rowBytes = width * channels;
  const appendSlice = async (top: number, bottom: number): Promise<void> => {
    const body = await jpegUnder(() => sharp(data.subarray(top * rowBytes, bottom * rowBytes), {
      raw: { width, height: bottom - top, channels },
    }), preset.maxBytes, DETAIL_QUALITIES);
    if (body.byteLength <= preset.maxBytes) {
      slices.push(body);
      return;
    }
    if (bottom - top <= 1) throw new Error("detail slice exceeds preset byte limit");
    const middle = Math.floor((top + bottom) / 2);
    const boundary = cuts.find((y) => y > top && y < bottom && Math.abs(y - middle) <= (bottom - top) / 4);
    await appendSlice(top, boundary ?? middle);
    await appendSlice(boundary ?? middle, bottom);
  };
  for (let top = 0; top < height;) {
    const limit = Math.min(top + preset.detailMaxHeight, height);
    const boundary = limit < height ? cuts.find((y) => y > top + preset.detailMaxHeight / 2 && y <= limit) : undefined;
    const bottom = boundary ?? limit;
    await appendSlice(top, bottom);
    top = bottom;
  }
  return slices;
}

export interface ExportSource { name: string; body: Buffer; ext: string; detail: boolean; sliceBoundaries?: number[] }

/** A file name the user can see: no path separators or control characters, at most 60 characters. */
export function safeExportName(value: unknown, fallback: string): string {
  const name = typeof value === "string" ? value.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "").trim().slice(0, 60) : "";
  return name || fallback;
}

export async function buildExportZip(sources: ExportSource[], presetId: string): Promise<Buffer> {
  const preset = IMAGE_EXPORT_PRESETS[presetId];
  const zip = new JSZip();
  const used = new Set<string>();
  for (const source of sources) {
    const bodies = !preset ? [source.body]
      : source.detail ? await fitDetailImages(source.body, preset, source.sliceBoundaries) : [await fitMainImage(source.body, preset)];
    const ext = preset ? "jpg" : source.ext;
    for (const [index, body] of bodies.entries()) {
      const suffix = bodies.length > 1 ? `_${String(index + 1).padStart(Math.max(2, String(bodies.length).length), "0")}` : "";
      const base = source.name + suffix;
      let name = `${base}.${ext}`;
      for (let n = 2; used.has(name); n++) name = `${base}_${n}.${ext}`;
      used.add(name);
      zip.file(name, body);
    }
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
}
