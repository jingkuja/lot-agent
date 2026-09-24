/**
 * 81×81 tab-bar glyphs for the mini program. Zero-dependency PNG encoder.
 * Run: node scripts/make-tab-icons.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "miniprogram", "assets");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, pixelAt) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      const o = rowStart + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function stroke(px, py, x, y, w, h, t) {
  return (
    (px >= x && px < x + w && py >= y && py < y + t) ||
    (px >= x && px < x + w && py >= y + h - t && py < y + h) ||
    (px >= x && px < x + t && py >= y && py < y + h) ||
    (px >= x + w - t && px < x + w && py >= y && py < y + h)
  );
}

function inCircle(px, py, cx, cy, r) {
  const dx = px + 0.5 - cx;
  const dy = py + 0.5 - cy;
  return dx * dx + dy * dy <= r * r;
}

function studio(px, py) {
  return (
    stroke(px, py, 18, 20, 45, 42, 4) ||
    inCircle(px, py, 30, 34, 5) ||
    (py > px * 0.45 + 18 && py < 58 && px > 28 && px < 58 && py > 38)
  );
}

function poster(px, py) {
  return (
    stroke(px, py, 22, 16, 38, 48, 4) ||
    stroke(px, py, 18, 20, 38, 48, 3) ||
    (px >= 30 && px < 50 && py >= 30 && py < 34) ||
    (px >= 30 && px < 46 && py >= 40 && py < 44)
  );
}

function gallery(px, py) {
  return (
    stroke(px, py, 16, 16, 22, 22, 4) ||
    stroke(px, py, 43, 16, 22, 22, 4) ||
    stroke(px, py, 16, 43, 22, 22, 4) ||
    stroke(px, py, 43, 43, 22, 22, 4)
  );
}

function mine(px, py) {
  return inCircle(px, py, 40, 28, 10) || (inCircle(px, py, 40, 62, 20) && py > 44 && py < 68 && px > 22 && px < 58);
}

function video(px, py) {
  return stroke(px, py, 15, 22, 50, 38, 4) || (px >= 34 && px <= 49 && Math.abs(py - 41) <= (49 - px) * 0.7);
}

const glyphs = { studio, poster, video, gallery, mine };
const fog = [0x82, 0x76, 0x6c, 255];
const brand = [0xc8, 0x6b, 0x4b, 255];

fs.mkdirSync(outDir, { recursive: true });
for (const [name, hit] of Object.entries(glyphs)) {
  const paint = (color) => (x, y) => (hit(x, y) ? color : [0, 0, 0, 0]);
  fs.writeFileSync(path.join(outDir, `tab-${name}.png`), encodePng(81, 81, paint(fog)));
  fs.writeFileSync(path.join(outDir, `tab-${name}-active.png`), encodePng(81, 81, paint(brand)));
}
console.log("tab icons written to", outDir);
