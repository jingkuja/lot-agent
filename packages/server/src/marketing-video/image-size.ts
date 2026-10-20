import { open } from "node:fs/promises";

export interface ImageInfo { mime: "image/jpeg" | "image/png" | "image/webp"; width: number; height: number }
const HEADER_BYTES = 1024 * 1024;

/** Format comes from the file signature, never the stored MIME. Unknown formats return null; unreadable sizes are 0. */
export function imageInfo(buffer: Buffer): ImageInfo | null {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    const ihdr = buffer.toString("ascii", 12, 16) === "IHDR";
    return { mime: "image/png", width: ihdr ? buffer.readUInt32BE(16) : 0, height: ihdr ? buffer.readUInt32BE(20) : 0 };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    let offset = 2;
    while (offset + 9 <= buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      if (marker === 0xff) { offset++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { mime: "image/jpeg", height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      if (marker === 0xd9 || marker === 0xda) break;
      offset += 2 + buffer.readUInt16BE(offset + 2);
    }
    return { mime: "image/jpeg", width: 0, height: 0 };
  }
  if (buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8 ") return { mime: "image/webp", width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") return { mime: "image/webp", width: 1 + (((buffer[22] & 0x3f) << 8) | buffer[21]), height: 1 + (((buffer[24] & 0x0f) << 10) | (buffer[23] << 2) | ((buffer[22] & 0xc0) >> 6)) };
    if (chunk === "VP8X") return { mime: "image/webp", width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    return { mime: "image/webp", width: 0, height: 0 };
  }
  return null;
}

export async function readImageInfo(path: string): Promise<ImageInfo | null> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    return imageInfo(buffer.subarray(0, bytesRead));
  } finally { await handle.close(); }
}
