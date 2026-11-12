/**
 * Joins the images of one generation into a single picture (详情页长图 / 宫格 / 一大多小).
 * Local only: no model request and nothing is metered.
 */
import sharp from "sharp";

export const COMPOSE_LAYOUTS = ["vertical", "grid", "hero"] as const;
export type ComposeLayout = typeof COMPOSE_LAYOUTS[number];

export const COMPOSE_MIN_IMAGES = 2;
export const COMPOSE_MAX_IMAGES = 9;
/** Widest picture written. Sources are at most 3840 px on an edge today (gpt-image); pass `maxWidth` for other models. */
export const COMPOSE_MAX_WIDTH = 2048;
export const COMPOSE_UPLOAD_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
export const COMPOSE_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const COMPOSE_MAX_SOURCE_BYTES = 80 * 1024 * 1024;
const COMPOSE_MAX_PIXELS = 64_000_000;
/** Gap and outer margin as a share of the picture width when 留白 is on. */
const GAP_RATIO = 0.02;
const BACKGROUND = "#ffffff";

export interface ComposeSize { width: number; height: number }
export interface ComposeRect { left: number; top: number; width: number; height: number }
export interface ComposePlan { width: number; height: number; rects: ComposeRect[] }
export interface ComposeOptions { gap?: boolean; maxWidth?: number }

export function parseComposeLayout(value: unknown): ComposeLayout | null {
  return COMPOSE_LAYOUTS.includes(value as ComposeLayout) ? value as ComposeLayout : null;
}

/** 一大多小 needs one large image and at least two small ones. */
export function composeLayoutFits(layout: ComposeLayout, count: number): boolean {
  if (count < COMPOSE_MIN_IMAGES || count > COMPOSE_MAX_IMAGES) return false;
  return layout !== "hero" || count >= 3;
}

function scaledHeight(width: number, size: ComposeSize): number {
  return Math.max(1, Math.round(width * size.height / size.width));
}

/**
 * Where each image goes. 长图 keeps every image whole; 宫格 and the small row of 一大多小 use cells shaped like the
 * first image in them, so a set made with one size is never cropped.
 */
export function composePlan(sizes: ComposeSize[], layout: ComposeLayout, options: ComposeOptions = {}): ComposePlan {
  if (!composeLayoutFits(layout, sizes.length)) throw new Error("layout does not fit the image count");
  if (sizes.some((size) => !(size.width > 0 && size.height > 0))) throw new Error("image size is missing");
  const maxWidth = options.maxWidth ?? COMPOSE_MAX_WIDTH;
  const columns = layout === "vertical" ? 1 : layout === "grid" ? 2 : sizes.length - 1;
  const gap = options.gap ? Math.max(1, Math.round(maxWidth * GAP_RATIO)) : 0;
  // Never upscale: the picture is as wide as its columns of source pixels, up to the limit.
  const width = Math.min(maxWidth, sizes[0].width * (layout === "hero" ? 1 : columns) + gap * 2);
  const inner = width - gap * 2;
  const rects: ComposeRect[] = [];
  let top = gap;
  const fullRow = (size: ComposeSize) => {
    const height = scaledHeight(inner, size);
    rects.push({ left: gap, top, width: inner, height });
    top += height + gap;
  };
  const cellRow = (row: ComposeSize[], cells: number) => {
    const cellWidth = Math.floor((inner - gap * (cells - 1)) / cells);
    const height = scaledHeight(cellWidth, row[0]);
    row.forEach((_, index) => rects.push({ left: gap + index * (cellWidth + gap), top, width: cellWidth, height }));
    top += height + gap;
  };
  if (layout === "vertical") {
    sizes.forEach(fullRow);
  } else if (layout === "grid") {
    for (let index = 0; index < sizes.length; index += 2) {
      const row = sizes.slice(index, index + 2);
      // An odd last image takes the whole row instead of leaving an empty cell.
      if (row.length === 2) cellRow(row, 2);
      else fullRow(row[0]);
    }
  } else {
    fullRow(sizes[0]);
    cellRow(sizes.slice(1), sizes.length - 1);
  }
  // `top` already carries the bottom margin (none without gaps).
  return { width, height: top, rects };
}

export interface ComposedImage {
  body: Buffer;
  mime: "image/jpeg";
  width: number;
  height: number;
  sliceBoundaries?: number[];
}

export async function composeImages(images: Buffer[], layout: ComposeLayout, options: ComposeOptions = {}): Promise<ComposedImage> {
  const sizes = await Promise.all(images.map(async (image) => {
    const { autoOrient: { width, height }, format } = await sharp(image, { limitInputPixels: COMPOSE_MAX_PIXELS }).metadata();
    if (!width || !height || !format || !["jpeg", "png", "webp", "gif", "heif", "tiff", "avif"].includes(format)) {
      throw new Error("unsupported image");
    }
    return { width, height };
  }));
  if (sizes.reduce((total, size) => total + size.width * size.height, 0) > 96_000_000) {
    throw new Error("source images are too large");
  }
  const plan = composePlan(sizes, layout, options);
  if (plan.width * plan.height > COMPOSE_MAX_PIXELS) throw new Error("composed image is too large");
  const layers = await Promise.all(images.map(async (image, index) => {
    const rect = plan.rects[index];
    const input = await sharp(image, { limitInputPixels: COMPOSE_MAX_PIXELS }).rotate()
      .resize(rect.width, rect.height, { fit: "cover" }).flatten({ background: BACKGROUND }).png().toBuffer();
    return { input, left: rect.left, top: rect.top };
  }));
  const body = await sharp({ create: { width: plan.width, height: plan.height, channels: 3, background: BACKGROUND } })
    .composite(layers)
    .jpeg({ quality: 92 })
    .toBuffer();
  const sliceBoundaries = layout === "vertical" ? plan.rects.slice(1).map((rect) => rect.top) : undefined;
  return { body, mime: "image/jpeg", width: plan.width, height: plan.height, ...(sliceBoundaries ? { sliceBoundaries } : {}) };
}

/** Longest edge of an image sent back to the model as a reference: enough to keep the product's look, small enough to send. */
export const REFERENCE_MAX_EDGE = 1536;

/** An image as a JPEG data URL for an image-edit request, shrunk to `REFERENCE_MAX_EDGE` (never enlarged). */
export async function referenceDataUrl(image: Buffer): Promise<string> {
  const body = await sharp(image).rotate()
    .resize(REFERENCE_MAX_EDGE, REFERENCE_MAX_EDGE, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: BACKGROUND }).jpeg({ quality: 90 }).toBuffer();
  return `data:image/jpeg;base64,${body.toString("base64")}`;
}

const OUTPUT_URL = /\/static\/assets\/([^/?#]+)(?:[?#].*)?$/;

/** Storage key of a generated file URL (`…/static/assets/<key>`), or null for anything else. */
export function outputStorageKey(url: unknown): string | null {
  const match = typeof url === "string" && url.length <= 2048 ? OUTPUT_URL.exec(url) : null;
  if (!match) return null;
  try {
    const key = decodeURIComponent(match[1]);
    return key && !/[\\/\u0000-\u001f\u007f]/.test(key) && !key.includes("..") ? key : null;
  } catch { return null; }
}

export interface GenerationComposite {
  url: string; mime: string; layout: ComposeLayout; gap: boolean; sliceBoundaries?: number[];
}

export function storedSliceBoundaries(value: unknown): number[] | undefined {
  return Array.isArray(value) && value.length < COMPOSE_MAX_IMAGES && value.every((item) => Number.isSafeInteger(item) && item > 0)
    ? value : undefined;
}

/** Composites already stored on a generation message, dropping anything malformed. */
export function storedComposites(value: unknown): GenerationComposite[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const { url, mime, layout, gap, sliceBoundaries } = (item ?? {}) as Record<string, unknown>;
    const parsed = parseComposeLayout(layout);
    if (typeof url !== "string" || !url || typeof mime !== "string" || !parsed) return [];
    const boundaries = storedSliceBoundaries(sliceBoundaries);
    return [{ url, mime, layout: parsed, gap: gap === true, ...(boundaries ? { sliceBoundaries: boundaries } : {}) }];
  });
}
