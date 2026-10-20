import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { imageInfo, readImageInfo } from "./image-size.js";

const riff = (chunk: string, body: number[]) => { const b = Buffer.alloc(30); b.write("RIFF", 0); b.write("WEBP", 8); b.write(chunk, 12); Buffer.from(body).copy(b, 20); return b; };

describe("reference image headers", () => {
  it("reads WebP lossy, lossless and extended sizes", () => {
    const lossy = riff("VP8 ", [0, 0, 0, 0, 0, 0]); lossy.writeUInt16LE(640, 26); lossy.writeUInt16LE(480, 28);
    expect(imageInfo(lossy)).toEqual({ mime: "image/webp", width: 640, height: 480 });
    // VP8L packs (width-1, height-1) as 14-bit fields after the 0x2f signature byte.
    const w = 299, h = 99, bits = (w - 1) | ((h - 1) << 14);
    expect(imageInfo(riff("VP8L", [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff])))
      .toEqual({ mime: "image/webp", width: w, height: h });
    const extended = riff("VP8X", []); extended.writeUIntLE(1999, 24, 3); extended.writeUIntLE(999, 27, 3);
    expect(imageInfo(extended)).toEqual({ mime: "image/webp", width: 2000, height: 1000 });
  });
  it("skips JPEG metadata segments before the frame header and ignores the claimed MIME", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x58, 0x03]);
    expect(imageInfo(jpeg)).toEqual({ mime: "image/jpeg", width: 600, height: 300 });
    expect(imageInfo(Buffer.from("GIF89a....................."))).toBeNull();
    expect(imageInfo(Buffer.from([0xff, 0xd8, 0xff, 0xda]))).toEqual({ mime: "image/jpeg", width: 0, height: 0 });
  });
  it.skipIf(spawnSync("ffmpeg", ["-version"]).status !== 0)("matches real PNG and JPEG files", async () => {
    const root = await mkdtemp(join(tmpdir(), "marketing-image-test-"));
    try {
      for (const [name, size] of [["a.png", "320x200"], ["a.jpg", "321x203"]]) {
        expect(spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=red:s=${size}`, "-frames:v", "1", join(root, name)]).status).toBe(0);
        const [width, height] = size.split("x").map(Number);
        expect(await readImageInfo(join(root, name))).toEqual({ mime: name.endsWith("png") ? "image/png" : "image/jpeg", width, height });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
