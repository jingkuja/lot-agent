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
}

const KB = 1024;
const MB = 1024 * KB;

/** `original` keeps every file as it is. */
export const IMAGE_EXPORT_PRESETS: Record<string, ImageExportPreset | null> = {
  original: null,
  taobao: { width: 800, height: 800, maxBytes: 500 * KB, detailWidth: 750 },
  pinduoduo: { width: 800, height: 800, maxBytes: 1 * MB, detailWidth: 750 },
  douyin: { width: 800, height: 800, maxBytes: 1 * MB, detailWidth: 750 },
  shopee: { width: 1024, height: 1024, maxBytes: 2 * MB, detailWidth: 1024 },
  tiktok: { width: 1080, height: 1080, maxBytes: 2 * MB, detailWidth: 1080 },
};

export function parseExportPreset(value: unknown): string | null {
  return typeof value === "string" && Object.hasOwn(IMAGE_EXPORT_PRESETS, value) ? value : null;
}

const WHITE = { r: 255, g: 255, b: 255 };
const QUALITIES = [90, 85, 80, 72, 64, 56, 50];

async function jpegUnder(pipeline: () => Sharp, maxBytes: number): Promise<Buffer> {
  for (const quality of QUALITIES.slice(0, -1)) {
    const body = await pipeline().jpeg({ quality, mozjpeg: true }).toBuffer();
    if (body.byteLength <= maxBytes) return body;
  }
  // Still too big: hand over the lowest quality rather than fail the whole pack.
  return pipeline().jpeg({ quality: QUALITIES[QUALITIES.length - 1], mozjpeg: true }).toBuffer();
}

/** A gallery image: the whole image on a white square of the platform's size (never cropped). */
export function fitMainImage(image: Buffer, preset: ImageExportPreset): Promise<Buffer> {
  return jpegUnder(() => sharp(image).rotate().flatten({ background: WHITE })
    .resize(preset.width, preset.height, { fit: "contain", background: WHITE }), preset.maxBytes);
}

/** A detail-page image: the platform's width, its own height. */
export function fitDetailImage(image: Buffer, preset: ImageExportPreset): Promise<Buffer> {
  return jpegUnder(() => sharp(image).rotate().flatten({ background: WHITE }).resize({ width: preset.detailWidth }), preset.maxBytes);
}

export interface ExportSource { name: string; body: Buffer; ext: string; detail: boolean }

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
    const body = !preset ? source.body : source.detail ? await fitDetailImage(source.body, preset) : await fitMainImage(source.body, preset);
    const ext = preset ? "jpg" : source.ext;
    let name = `${source.name}.${ext}`;
    for (let n = 2; used.has(name); n++) name = `${source.name}_${n}.${ext}`;
    used.add(name);
    zip.file(name, body);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
}
