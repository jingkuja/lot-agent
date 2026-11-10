import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { whitenBackground } from "./white-background.js";

/** A `size`² image of `background` with a `product`-colored square of `box` pixels at (`x`, `y`). */
async function scene(size: number, background: string, box: { x: number; y: number; w: number; h: number; color?: string }) {
  const product = await sharp({ create: { width: box.w, height: box.h, channels: 3, background: box.color ?? "#c0392b" } }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 3, background } })
    .composite([{ input: product, left: box.x, top: box.y }]).png().toBuffer();
}

async function pixel(image: Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return Array.from(data.subarray(offset, offset + 3));
}

describe("whitenBackground", () => {
  it("turns an off-white background pure white and leaves the product alone", async () => {
    const image = await scene(200, "#f2f1ef", { x: 30, y: 30, w: 140, h: 140 });
    const { body, mime, check } = await whitenBackground(image);
    expect(mime).toBe("image/png");
    expect(check).toEqual({ corrected: true, issues: [] });
    expect(await pixel(body, 5, 5)).toEqual([255, 255, 255]);
    expect(await pixel(body, 100, 100)).toEqual([0xc0, 0x39, 0x2b]);
  });

  it("does not whiten a near-white area the background cannot reach (inside the product)", async () => {
    const product = await scene(140, "#c0392b", { x: 50, y: 50, w: 40, h: 40, color: "#f2f1ef" });
    const image = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#f2f1ef" } })
      .composite([{ input: product, left: 30, top: 30 }]).png().toBuffer();
    const { body } = await whitenBackground(image);
    expect(await pixel(body, 100, 100)).toEqual([0xf2, 0xf1, 0xef]);
  });

  it("reports nothing to fix on a background that is already pure white", async () => {
    const { check } = await whitenBackground(await scene(200, "#ffffff", { x: 30, y: 30, w: 140, h: 140 }));
    expect(check).toEqual({ corrected: false, issues: [] });
  });

  it("flags a background that is not white, a small product and a product cut by the edge", async () => {
    expect((await whitenBackground(await scene(200, "#8fb8de", { x: 30, y: 30, w: 140, h: 140 }))).check.issues).toEqual(["busy_background"]);
    expect((await whitenBackground(await scene(200, "#ffffff", { x: 80, y: 80, w: 40, h: 40 }))).check.issues).toEqual(["small_subject"]);
    expect((await whitenBackground(await scene(200, "#ffffff", { x: 0, y: 40, w: 150, h: 120 }))).check.issues).toEqual(["cropped"]);
    // A light grey studio sweep is not near-white anywhere along the edge.
    expect((await whitenBackground(await scene(200, "#d9d9d9", { x: 30, y: 30, w: 140, h: 140 }))).check).toEqual({ corrected: false, issues: ["busy_background"] });
  });
});
