// Deterministic RGBA8 PNG encoding: filter 0, zlib level 9, no ancillary chunks.
// Deflate bytes can change with Node's bundled zlib, so
// freshness compares decoded pixels rather than compression implementation.
// Decoder handles only what this pipeline emits/authors: 8-bit RGBA or RGB,
// non-interlaced.

import zlib from "node:zlib";
import jpeg from "jpeg-js";
import { LEAD_SKIN_LIMITS } from "./contract.ts";
export interface PixelImage {
  width: number;
  height: number;
  rgba: Buffer;
}
export const IMAGE_LIMITS = { dimension: 32768, pixels: 16 * 1024 * 1024, bytes: 16 * 1024 * 1024 };
export function checkImageSize(width: number, height: number) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > IMAGE_LIMITS.dimension ||
    height > IMAGE_LIMITS.dimension ||
    width * height > IMAGE_LIMITS.pixels
  )
    throw new Error("Image dimensions exceed limits");
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function encodePNG(width: number, height: number, rgba: Buffer) {
  checkImageSize(width, height);
  if (rgba.length !== width * height * 4) throw new Error("Invalid RGBA length");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = 0; // filter: none
    rgba.copy(raw, o + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Decode an 8-bit RGB/RGBA non-interlaced PNG to flat RGBA. */
export function decodePNG(buf: Buffer, label = "png", leadAtlas = false): PixelImage {
  if (buf.length > IMAGE_LIMITS.bytes) throw new Error(`${label}: image bytes exceed limit`);
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error(`${label}: not a PNG`);
  let o = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  let ended = false;
  while (o < buf.length) {
    if (o + 12 > buf.length) throw new Error(`${label}: truncated PNG`);
    const size = buf.readUInt32BE(o);
    if (size > buf.length - o - 12) throw new Error(`${label}: truncated chunk`);
    const type = buf.toString("ascii", o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + size);
    if (buf.readUInt32BE(o + 8 + size) !== crc32(buf.subarray(o + 4, o + 8 + size)))
      throw new Error(`${label}: PNG CRC mismatch`);
    if (o === 8 && type !== "IHDR") throw new Error(`${label}: missing header`);
    if (type === "IHDR") {
      if (o !== 8 || size !== 13) throw new Error(`${label}: invalid header`);
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      checkImageSize(width, height);
      if (
        leadAtlas &&
        (width * height > LEAD_SKIN_LIMITS.atlasPixels || height > LEAD_SKIN_LIMITS.cellHeight)
      )
        throw new Error("Lead atlas dimensions exceed limits");
      const depth = data[8];
      const color = data[9];
      if (depth !== 8 || (color !== 6 && color !== 2) || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error(`${label}: unsupported PNG (depth ${depth}, color ${color})`);
      }
      channels = color === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      if (size !== 0 || o + 12 !== buf.length) throw new Error(`${label}: trailing PNG data`);
      ended = true;
      break;
    }
    o += 12 + size;
  }
  if (!ended || !channels || !idat.length) throw new Error(`${label}: incomplete PNG`);
  const stride = width * channels;
  const expected = (stride + 1) * height;
  const raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  if (raw.length !== expected) throw new Error(`${label}: decoded length mismatch`);
  const rgba = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    raw.copy(line, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? line[x - channels]! : 0;
      const up = prev[x]!;
      const ul = x >= channels ? prev[x - channels]! : 0;
      if (filter === 1) line[x] = (line[x]! + left) & 0xff;
      else if (filter === 2) line[x] = (line[x]! + up) & 0xff;
      else if (filter === 3) line[x] = (line[x]! + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) line[x] = (line[x]! + paeth(left, up, ul)) & 0xff;
      else if (filter !== 0) throw new Error(`${label}: unknown filter ${filter}`);
    }
    for (let x = 0; x < width; x++) {
      const si = x * channels;
      const di = (y * width + x) * 4;
      rgba[di] = line[si]!;
      rgba[di + 1] = line[si + 1]!;
      rgba[di + 2] = line[si + 2]!;
      rgba[di + 3] = channels === 4 ? line[si + 3]! : 255;
    }
    line.copy(prev);
  }
  return { width, height, rgba };
}

/** Compare canonical image content while ignoring zlib stream drift. */
export function pngPixelsEqual(leftBuffer: Buffer, rightBuffer: Buffer) {
  try {
    const left = decodePNG(leftBuffer, "existing png");
    const right = decodePNG(rightBuffer, "generated png");
    return left.width === right.width && left.height === right.height && left.rgba.equals(right.rgba);
  } catch {
    return false;
  }
}

/** Pure-JS bounded decoding; no ImageMagick or platform binary is needed. */
export function decodeReference(bytes: Buffer): PixelImage {
  if (bytes.length > IMAGE_LIMITS.bytes) throw new Error("Reference bytes exceed limit");
  if (bytes.subarray(0, 8).equals(SIG)) return decodePNG(bytes);
  if (bytes[0] === 255 && bytes[1] === 216) {
    const image = jpeg.decode(bytes, {
      tolerantDecoding: false,
      maxResolutionInMP: IMAGE_LIMITS.pixels / 1_000_000,
      maxMemoryUsageInMB: 128,
    });
    checkImageSize(image.width, image.height);
    return { width: image.width, height: image.height, rgba: Buffer.from(image.data) };
  }
  throw new Error("Reference must be an 8-bit RGB/RGBA PNG or JPEG");
}
/** Validate the downloaded atlas before any client binds it for rendering. */
export function decodeLeadAtlas(bytes: Buffer): PixelImage {
  if (bytes.length > LEAD_SKIN_LIMITS.bytes) throw new Error("Lead atlas byte limit exceeded");
  return decodePNG(bytes, "lead atlas", true);
}
