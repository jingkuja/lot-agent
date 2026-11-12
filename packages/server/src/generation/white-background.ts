/**
 * 白底图 check and correction, after the model and before the image is stored. Models often leave the "white"
 * background slightly grey or with a gradient, which listing checks reject. The background is found by filling from
 * the edges over near-white pixels, then set to pure white; the product and its shadow are left alone.
 * No model request: plain pixel work.
 */
import sharp from "sharp";

/** Why an image may still not pass a marketplace's white-background check. */
export type WhiteBackgroundIssue = "busy_background" | "small_subject" | "cropped";
export interface WhiteBackgroundCheck { corrected: boolean; issues: WhiteBackgroundIssue[]; unknown?: boolean }

/** Near-white: bright and nearly grey. A faint contact shadow is darker than this and stays. */
const MIN_CHANNEL = 228;
const MAX_SPREAD = 18;
/** Share of edge pixels that must be near-white for the background to count as white. A product touching an edge
 * takes part of the border (reported as cropped); a background that is not white takes nearly all of it. */
const EDGE_WHITE_SHARE = 0.6;
/** The product's longer side should cover at least this share of the image. */
const MIN_SUBJECT_SHARE = 0.5;

export async function whitenBackground(image: Buffer, apply = true): Promise<{ body: Buffer; mime: "image/png"; check: WhiteBackgroundCheck }> {
  const { data, info } = await sharp(image).rotate().flatten({ background: "#ffffff" }).removeAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const total = width * height;
  const near = (pixel: number) => {
    const offset = pixel * 3;
    const r = data[offset], g = data[offset + 1], b = data[offset + 2];
    const low = Math.min(r, g, b);
    return low >= MIN_CHANNEL && Math.max(r, g, b) - low <= MAX_SPREAD;
  };

  const background = new Uint8Array(total);
  const queue = new Int32Array(total);
  let tail = 0;
  let edgePixels = 0;
  let edgeWhite = 0;
  const seed = (pixel: number) => {
    edgePixels++;
    if (!near(pixel)) return;
    edgeWhite++;
    if (!background[pixel]) {
      background[pixel] = 1;
      queue[tail++] = pixel;
    }
  };
  for (let x = 0; x < width; x++) {
    seed(x);
    if (height > 1) seed((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    seed(y * width);
    if (width > 1) seed(y * width + width - 1);
  }
  for (let head = 0; head < tail; head++) {
    const pixel = queue[head];
    const x = pixel % width;
    const neighbours = [x > 0 ? pixel - 1 : -1, x < width - 1 ? pixel + 1 : -1, pixel - width, pixel + width];
    for (const next of neighbours) {
      if (next < 0 || next >= total || background[next] || !near(next)) continue;
      background[next] = 1;
      queue[tail++] = next;
    }
  }

  let changed = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let pixel = 0; pixel < total; pixel++) {
    const offset = pixel * 3;
    if (background[pixel]) {
      if (data[offset] !== 255 || data[offset + 1] !== 255 || data[offset + 2] !== 255) {
        data[offset] = data[offset + 1] = data[offset + 2] = 255;
        changed++;
      }
      continue;
    }
    const x = pixel % width;
    const y = (pixel - x) / width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const issues: WhiteBackgroundIssue[] = [];
  if (edgePixels && edgeWhite / edgePixels < EDGE_WHITE_SHARE) issues.push("busy_background");
  if (maxX >= 0) {
    const share = Math.max((maxX - minX + 1) / width, (maxY - minY + 1) / height);
    if (share < MIN_SUBJECT_SHARE) issues.push("small_subject");
    const margin = Math.max(1, Math.round(Math.min(width, height) * 0.005));
    const touches = minX < margin || minY < margin || maxX > width - 1 - margin || maxY > height - 1 - margin;
    if (touches && !issues.includes("busy_background")) issues.push("cropped");
  }
  const body = apply ? await sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer() : image;
  return { body, mime: "image/png", check: { corrected: apply && changed > 0, issues } };
}
