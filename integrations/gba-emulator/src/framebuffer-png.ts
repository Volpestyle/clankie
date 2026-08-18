import zlib from "node:zlib";
import { drawTileGrid, type FrameGridAnchor } from "./frame-grid.ts";
import type { MgbaFramebuffer } from "./mgba-core.ts";

/**
 * Encode an RGB565 framebuffer as a truecolor PNG with no external encoder.
 *
 * GBA output is 240x160 flat-palette pixel art, which deflates hard — a typical
 * frame lands in single-digit kilobytes. That is what makes per-frame PNG a
 * sufficient transport for the activity plane ([ADR 0047](../../../docs/adr/0047-discord-activity-presence-plane.md))
 * without pulling in a video encoder.
 */
export function encodeFramebufferPng(
  frame: MgbaFramebuffer,
  scale = 1,
  grid?: FrameGridAnchor | undefined,
): Buffer {
  if (!Number.isSafeInteger(scale) || scale < 1 || scale > 8) {
    throw new Error("gba_framebuffer_scale_invalid");
  }
  const { width, height, bytes } = frame;
  if (width <= 0 || height <= 0) throw new Error("gba_framebuffer_dimensions_invalid");
  if (bytes.length < width * height * 2) throw new Error("gba_framebuffer_truncated");

  // Nearest-neighbour upscale. 240x160 is small enough that a vision model can
  // struggle to read tiles; duplicating pixels costs almost nothing, adds no
  // information, and invents none — the picture is identical, just larger.
  const gameWidth = width * scale;
  const gameHeight = height * scale;
  const game = new Uint8Array(gameWidth * gameHeight * 3);
  for (let y = 0; y < gameHeight; y += 1) {
    const sourceY = Math.floor(y / scale);
    for (let x = 0; x < gameWidth; x += 1) {
      const i = sourceY * width + Math.floor(x / scale);
      const low = bytes[i * 2] ?? 0;
      const high = bytes[i * 2 + 1] ?? 0;
      const value = low | (high << 8);
      const at = (y * gameWidth + x) * 3;
      game[at] = Math.round((((value >> 11) & 0x1f) * 255) / 31);
      game[at + 1] = Math.round((((value >> 5) & 0x3f) * 255) / 63);
      game[at + 2] = Math.round(((value & 0x1f) * 255) / 31);
    }
  }

  // Labelled tile axes in an added margin, never over the game pixels — the
  // same frame is what the room watches (ADR 0047).
  const canvas =
    grid === undefined
      ? { rgb: game, width: gameWidth, height: gameHeight }
      : drawTileGrid({ rgb: game, width: gameWidth, height: gameHeight }, scale, grid);

  const outWidth = canvas.width;
  const outHeight = canvas.height;
  const raw = Buffer.alloc(outHeight * (1 + outWidth * 3));
  for (let y = 0; y < outHeight; y += 1) {
    const row = y * (1 + outWidth * 3);
    raw[row] = 0; // filter: none
    raw.set(canvas.rgb.subarray(y * outWidth * 3, (y + 1) * outWidth * 3), row + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(outWidth, 0);
  ihdr.writeUInt32BE(outHeight, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}
