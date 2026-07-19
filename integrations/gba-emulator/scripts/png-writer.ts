import { writeFileSync } from "node:fs";
import zlib from "node:zlib";
import type { MgbaFramebuffer } from "../src/mgba-core.ts";

/** Write an RGB565 framebuffer as a truecolor PNG (no external encoder). */
export function writeFramebufferPng(frame: MgbaFramebuffer, outPath: string): void {
  const { width, height, bytes } = frame;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const low = bytes[i * 2] ?? 0;
      const high = bytes[i * 2 + 1] ?? 0;
      const value = low | (high << 8);
      raw[row + 1 + x * 3] = Math.round((((value >> 11) & 0x1f) * 255) / 31);
      raw[row + 2 + x * 3] = Math.round((((value >> 5) & 0x3f) * 255) / 63);
      raw[row + 3 + x * 3] = Math.round(((value & 0x1f) * 255) / 31);
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  writeFileSync(
    outPath,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}
