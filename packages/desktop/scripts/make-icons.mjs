/**
 * Generates the app's placeholder icons with zero dependencies (a minimal
 * PNG encoder over node:zlib). Replace with real artwork when available —
 * the packaging config only cares about the file paths.
 *
 * Outputs:
 *   build/icon.png      512×512 — violet→blue gradient rounded square (app icon)
 *   build/tray-icon.png 32×32   — simple orb for the menu-bar / taskbar tray
 *
 * Run: node scripts/make-icons.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "build");

// ── Minimal PNG encoder (8-bit RGBA, no filtering) ────────────────────────────
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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter: none
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

// ── Icon art ──────────────────────────────────────────────────────────────────
// Brand gradient from the web theme: #8b5cf6 → #3b82f6.
const FROM = [0x8b, 0x5c, 0xf6];
const TO = [0x3b, 0x82, 0xf6];
const lerp = (a, b, t) => Math.round(a + (b - a) * t);

function roundedSquareContains(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function appIconPixel(size) {
  const radius = size * 0.22;
  // White orb (the "empty-chat logo orb" motif from the web theme).
  const orbCx = size * 0.5;
  const orbCy = size * 0.42;
  const orbR = size * 0.16;
  return (x, y) => {
    if (!roundedSquareContains(x + 0.5, y + 0.5, size, radius)) return [0, 0, 0, 0];
    const t = (x + y) / (2 * size);
    const dx = x - orbCx;
    const dy = y - orbCy;
    if (dx * dx + dy * dy <= orbR * orbR) return [255, 255, 255, 255];
    return [lerp(FROM[0], TO[0], t), lerp(FROM[1], TO[1], t), lerp(FROM[2], TO[2], t), 255];
  };
}

function trayIconPixel(size) {
  const c = size / 2;
  const r = size * 0.4;
  return (x, y) => {
    const dx = x + 0.5 - c;
    const dy = y + 0.5 - c;
    if (dx * dx + dy * dy > r * r) return [0, 0, 0, 0];
    const t = (x + y) / (2 * size);
    return [lerp(FROM[0], TO[0], t), lerp(FROM[1], TO[1], t), lerp(FROM[2], TO[2], t), 255];
  };
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "icon.png"), encodePng(512, 512, appIconPixel(512)));
fs.writeFileSync(path.join(outDir, "tray-icon.png"), encodePng(32, 32, trayIconPixel(32)));
console.log("icons written to", outDir);
