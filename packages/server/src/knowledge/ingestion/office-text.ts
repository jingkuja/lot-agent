import { createHash } from "node:crypto";
import JSZip from "jszip";
import * as XLSX from "xlsx";

export const EXCEL_MIMES: ReadonlySet<string> = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);

export const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** 把 Excel 工作簿转成纯文本：每个工作表渲染为 CSV，便于模型阅读。 */
export function excelToText(bytes: Buffer): string {
  const wb = XLSX.read(bytes, { type: "buffer" });
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
    parts.push(`### Worksheet: ${name}\n${csv}`);
  }
  return parts.join("\n\n");
}

/** 抽出 pptx 各页的可读文本（旧 PPT 作为内容素材时用）。 */
export async function pptxToText(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]));
  const pages: string[] = [];
  for (const n of names) {
    const xml = await zip.file(n)!.async("string");
    const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)]
      .map((m) => m[1])
      .filter(Boolean);
    const num = n.match(/(\d+)/)![1];
    if (texts.length) pages.push(`### Slide ${num}\n${texts.join("\n")}`);
  }
  return pages.join("\n\n");
}

export interface EmbeddedImage {
  mime: string;
  bytes: Uint8Array;
  /** Where it sits, when the format says; added to the text so sources stay findable. */
  label?: string;
}

const IMAGE_MIMES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
const MEDIA_FOLDER = /^(?:word|ppt|xl)\/media\/[^/]+$/;
/** Logos, bullets and dividers have nothing to read; a price table is rarely smaller than this. */
const MIN_IMAGE_SIDE = 200;
const MAX_ASPECT_RATIO = 6;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** A picture on this many slides is part of the template. */
const TEMPLATE_SLIDES = 3;

/** Reads the size from the file header, so filtering decodes nothing. Null when the header is not understood. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length > 24 && view.getUint32(0) === 0x89504e47) return { width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
    offset += 2 + view.getUint16(offset + 2);
  }
  return null;
}

function worthReading(bytes: Uint8Array): boolean {
  if (bytes.length > MAX_IMAGE_BYTES) return false;
  const size = imageSize(bytes);
  if (!size) return true;
  const [short, long] = [size.width, size.height].sort((left, right) => left - right);
  return short >= MIN_IMAGE_SIDE && long / short <= MAX_ASPECT_RATIO;
}

async function slideOrder(zip: JSZip): Promise<Map<string, string[]>> {
  const names = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name))
    .sort((left, right) => Number(left.match(/(\d+)/)![1]) - Number(right.match(/(\d+)/)![1]));
  const slides = new Map<string, string[]>();
  for (const name of names) {
    const slide = name.match(/(\d+)/)![1];
    const rels = await zip.file(name)!.async("string");
    for (const match of rels.matchAll(/Target="\.\.\/media\/([^"]+)"/g)) {
      const path = `ppt/media/${match[1]}`;
      slides.set(path, [...(slides.get(path) ?? []), slide]);
    }
  }
  return slides;
}

/** Pictures inside a Word, PowerPoint or Excel file, in reading order, without decoration or repeats. */
export async function embeddedImages(bytes: Buffer): Promise<EmbeddedImage[]> {
  const zip = await JSZip.loadAsync(bytes).catch(() => null);
  if (!zip) return [];
  const slides = await slideOrder(zip);
  const firstSlide = (name: string) => Number(slides.get(name)?.[0] ?? Number.MAX_SAFE_INTEGER);
  const names = Object.keys(zip.files).filter((name) => MEDIA_FOLDER.test(name))
    .sort((left, right) => firstSlide(left) - firstSlide(right) || left.localeCompare(right, "en", { numeric: true }));
  const seen = new Set<string>();
  const images: EmbeddedImage[] = [];
  for (const name of names) {
    const mime = IMAGE_MIMES[name.split(".").pop()?.toLowerCase() ?? ""];
    if (!mime || (slides.get(name)?.length ?? 0) >= TEMPLATE_SLIDES) continue;
    const data = await zip.file(name)!.async("uint8array");
    const hash = createHash("sha256").update(data).digest("hex");
    if (seen.has(hash) || !worthReading(data)) continue;
    seen.add(hash);
    const slide = slides.get(name)?.[0];
    images.push({ mime, bytes: data, ...(slide ? { label: `Slide ${slide}` } : {}) });
  }
  return images;
}
