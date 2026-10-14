import { createInflate, crc32, deflate } from "node:zlib";
import { promisify } from "node:util";
import { redactSensitiveText } from "@clankie/observability";
import { EVIDENCE_PREVIEW_MAX_BYTES, type EvidenceDevicePreview } from "@clankie/protocol/evidence";
import { logger } from "./app/log.ts";

/**
 * Host-side thumbnails for recorded PNGs over the device preview cap (VUH-1954).
 * A complete downscaled raster under `EVIDENCE_PREVIEW_MAX_BYTES`, or an honest
 * refusal; never a crop, a cap bump or truncated image bytes. Recorded blobs are
 * immutable and content-addressed, so a rendition is cached by the source
 * sha256 alone. Callers authorize the sha256 against a record before asking.
 *
 * Every stage is bounded: source bytes before buffering, IHDR dimensions and
 * pixels before any decode, inflated bytes against the exact IHDR length,
 * memory to one source row plus the rendition (rows stream through a box
 * filter), wall time with cancellation (storage reads included), two renders
 * at a time with a bounded queue, a fixed encode ladder, output bytes and the
 * caches.
 */
export const EVIDENCE_THUMBNAIL_LIMITS = {
  sourceMaxBytes: 16 * 1024 * 1024,
  maxSide: 16_384,
  maxPixels: 16_777_216,
  maxChunks: 65_536,
  /** Longest output edge, largest first; each step is one encode. */
  edges: [768, 640, 512, 384, 256],
  jpegQuality: 80,
  /** A transparent PNG is kept only at this edge or larger; below it the image flattens to JPEG. */
  pngMinEdge: 512,
  outputMaxBytes: EVIDENCE_PREVIEW_MAX_BYTES,
  deadlineMs: 5_000,
  /** A timed-out sha256 answers `timeout` at once for this long instead of rendering again. */
  timeoutRetryMs: 60_000,
  concurrency: 2,
  /** Waiters hold no bytes until admitted; a typical render takes about 100 ms. */
  maxQueued: 32,
  queueWaitMs: 15_000,
  cacheMaxEntries: 256,
  cacheMaxBytes: 8 * 1024 * 1024,
};
export type EvidenceThumbnailLimits = typeof EVIDENCE_THUMBNAIL_LIMITS;

/** A transient refusal (busy, timed out, unreadable bytes); never cached. */
export class EvidenceThumbnailUnavailable extends Error {
  readonly code: "busy" | "timeout" | "unreadable";
  constructor(code: "busy" | "timeout" | "unreadable", options?: ErrorOptions) {
    super(`Evidence thumbnail ${code}`, options);
    this.code = code;
  }
}

/** A deterministic answer for these bytes under these limits; cached. */
class Refusal extends Error {
  readonly reason: "too_large" | "not_previewable";
  constructor(reason: "too_large" | "not_previewable") {
    super(reason);
    this.reason = reason;
  }
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

interface Png {
  width: number;
  height: number;
  depth: number;
  colorType: number;
  /** RGBA per palette entry (type 3). */
  palette: Uint8Array | undefined;
  paletteSize: number;
  /** The single transparent sample for types 0 and 2, at source depth. */
  key: number[] | undefined;
  idat: Buffer;
}

/** Walks the chunks with CRCs and checks IHDR before anything is decoded. */
function parsePng(bytes: Buffer, limits: EvidenceThumbnailLimits, check: () => void): Png {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Refusal("too_large");
  let offset = 8;
  let header: Omit<Png, "palette" | "paletteSize" | "key" | "idat"> | undefined;
  let palette: Uint8Array | undefined;
  let paletteSize = 0;
  let key: number[] | undefined;
  const idat: Buffer[] = [];
  let idatClosed = false;
  for (let chunks = 0; ; chunks++) {
    // Real encoders write a few thousand chunks; millions of empty ones are an attack on this loop.
    if (chunks > limits.maxChunks) throw new Refusal("not_previewable");
    if (chunks % 1024 === 1023) check();
    if (offset + 12 > bytes.length) throw new Refusal("not_previewable");
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (length > 0x7fffffff || end > bytes.length) throw new Refusal("not_previewable");
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length))
      throw new Refusal("not_previewable");
    offset = end;
    if (header === undefined) {
      if (type !== "IHDR" || length !== 13) throw new Refusal("not_previewable");
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      const [depth, colorType, compression, filter, interlace] = data.subarray(8, 13);
      if (width === 0 || height === 0 || !DEPTHS[colorType!]?.includes(depth!) || compression || filter)
        throw new Refusal("not_previewable");
      // Dimensions bound every later allocation and loop, so they are checked first.
      if (width > limits.maxSide || height > limits.maxSide || width * height > limits.maxPixels)
        throw new Refusal("too_large");
      // Adam7 interlacing is declared unsupported rather than decoded whole.
      if (interlace) throw new Refusal("not_previewable");
      header = { width, height, depth: depth!, colorType: colorType! };
      continue;
    }
    if (type === "IEND") break;
    if (type === "IDAT") {
      if (idatClosed) throw new Refusal("not_previewable");
      idat.push(data);
      continue;
    }
    if (idat.length > 0) idatClosed = true;
    if (type === "PLTE") {
      if (length === 0 || length % 3 || length > 768 || idat.length > 0) throw new Refusal("not_previewable");
      paletteSize = length / 3;
      palette = new Uint8Array(256 * 4);
      for (let index = 0; index < paletteSize; index++) {
        palette.set(data.subarray(index * 3, index * 3 + 3), index * 4);
        palette[index * 4 + 3] = 255;
      }
    } else if (type === "tRNS") {
      if (header.colorType === 3) {
        if (!palette || length > paletteSize) throw new Refusal("not_previewable");
        for (let index = 0; index < length; index++) palette[index * 4 + 3] = data[index]!;
      } else if (header.colorType === 0 && length === 2) key = [data.readUInt16BE(0)];
      else if (header.colorType === 2 && length === 6)
        key = [data.readUInt16BE(0), data.readUInt16BE(2), data.readUInt16BE(4)];
      else throw new Refusal("not_previewable");
    } else if (((type.charCodeAt(0) >> 5) & 1) === 0) {
      // An unknown critical chunk changes how the image must be read.
      throw new Refusal("not_previewable");
    }
  }
  if (header === undefined || idat.length === 0) throw new Refusal("not_previewable");
  if (header.colorType === 3 && palette === undefined) throw new Refusal("not_previewable");
  return { ...header, palette, paletteSize, key, idat: Buffer.concat(idat) };
}

/** Area-averaging downscale fed one RGBA8 row at a time; alpha-weighted so edges don't darken. */
class BoxScaler {
  readonly output: Uint8Array;
  readonly width: number;
  readonly height: number;
  opaque = true;
  private readonly sourceWidth: number;
  private readonly sourceHeight: number;
  private readonly column: Uint32Array;
  private readonly columnWeight: Float64Array;
  private readonly sums: Float64Array;
  private currentRow = 0;
  private rowsInBin = 0;
  private sourceRow = 0;

  constructor(sourceWidth: number, sourceHeight: number, width: number, height: number) {
    this.sourceWidth = sourceWidth;
    this.sourceHeight = sourceHeight;
    this.width = width;
    this.height = height;
    this.output = new Uint8Array(width * height * 4);
    this.column = new Uint32Array(sourceWidth);
    this.columnWeight = new Float64Array(width);
    for (let x = 0; x < sourceWidth; x++) {
      const target = Math.min(width - 1, Math.floor((x * width) / sourceWidth));
      this.column[x] = target;
      this.columnWeight[target]!++;
    }
    this.sums = new Float64Array(width * 4);
  }

  add(row: Uint8Array): void {
    const target = Math.min(this.height - 1, Math.floor((this.sourceRow * this.height) / this.sourceHeight));
    if (target !== this.currentRow) this.flush();
    this.currentRow = target;
    this.sourceRow++;
    this.rowsInBin++;
    const { sums, column } = this;
    for (let x = 0; x < this.sourceWidth; x++) {
      const at = x * 4;
      const alpha = row[at + 3]!;
      if (alpha !== 255) this.opaque = false;
      const bin = column[x]! * 4;
      sums[bin] = sums[bin]! + row[at]! * alpha;
      sums[bin + 1] = sums[bin + 1]! + row[at + 1]! * alpha;
      sums[bin + 2] = sums[bin + 2]! + row[at + 2]! * alpha;
      sums[bin + 3] = sums[bin + 3]! + alpha;
    }
    if (this.sourceRow === this.sourceHeight) this.flush();
  }

  private flush(): void {
    if (this.rowsInBin === 0) return;
    const { sums, output } = this;
    const base = this.currentRow * this.width * 4;
    for (let x = 0; x < this.width; x++) {
      const at = x * 4;
      const alpha = sums[at + 3]!;
      if (alpha > 0) {
        output[base + at] = Math.round(sums[at]! / alpha);
        output[base + at + 1] = Math.round(sums[at + 1]! / alpha);
        output[base + at + 2] = Math.round(sums[at + 2]! / alpha);
        output[base + at + 3] = Math.round(alpha / (this.columnWeight[x]! * this.rowsInBin));
      }
    }
    sums.fill(0);
    this.rowsInBin = 0;
  }
}

function fit(width: number, height: number, edge: number) {
  const scale = Math.min(1, edge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Expands one unfiltered scanline to RGBA8 (16-bit samples keep their high byte). */
function expand(png: Png, line: Uint8Array, out: Uint8Array): void {
  const { width, depth, colorType, palette, paletteSize, key } = png;
  // Screenshots are almost always 8-bit RGBA or RGB.
  if (depth === 8 && colorType === 6) {
    out.set(line);
    return;
  }
  if (depth === 8 && colorType === 2 && key === undefined) {
    for (let x = 0, at = 0, o = 0; x < width; x++, at += 3, o += 4) {
      out[o] = line[at]!;
      out[o + 1] = line[at + 1]!;
      out[o + 2] = line[at + 2]!;
      out[o + 3] = 255;
    }
    return;
  }
  const wide = depth === 16;
  for (let x = 0; x < width; x++) {
    const o = x * 4;
    if (colorType === 0 || colorType === 3) {
      let sample: number;
      if (depth < 8) {
        const bit = x * depth;
        sample = (line[bit >> 3]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
      } else sample = wide ? (line[x * 2]! << 8) | line[x * 2 + 1]! : line[x]!;
      if (colorType === 3) {
        if (sample >= paletteSize) throw new Refusal("not_previewable");
        out.set(palette!.subarray(sample * 4, sample * 4 + 4), o);
      } else {
        const gray =
          depth < 8 ? Math.round((sample * 255) / ((1 << depth) - 1)) : wide ? sample >> 8 : sample;
        out[o] = out[o + 1] = out[o + 2] = gray;
        out[o + 3] = key !== undefined && key[0] === sample ? 0 : 255;
      }
      continue;
    }
    // Each sample is one byte, or two with the high byte first.
    const bytes = wide ? 2 : 1;
    const at = x * CHANNELS[colorType]! * bytes;
    if (colorType === 2) {
      out[o] = line[at]!;
      out[o + 1] = line[at + bytes]!;
      out[o + 2] = line[at + 2 * bytes]!;
      out[o + 3] =
        key !== undefined &&
        key[0] === sampleAt(line, at, wide) &&
        key[1] === sampleAt(line, at + bytes, wide) &&
        key[2] === sampleAt(line, at + 2 * bytes, wide)
          ? 0
          : 255;
    } else if (colorType === 4) {
      out[o] = out[o + 1] = out[o + 2] = line[at]!;
      out[o + 3] = line[at + bytes]!;
    } else {
      out[o] = line[at]!;
      out[o + 1] = line[at + bytes]!;
      out[o + 2] = line[at + 2 * bytes]!;
      out[o + 3] = line[at + 3 * bytes]!;
    }
  }
}

function sampleAt(line: Uint8Array, at: number, wide: boolean) {
  return wide ? (line[at]! << 8) | line[at + 1]! : line[at]!;
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a),
    pb = Math.abs(p - b),
    pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function unfilter(filter: number, line: Uint8Array, previous: Uint8Array, bpp: number): void {
  if (filter === 0) return;
  if (filter > 4) throw new Refusal("not_previewable");
  for (let index = 0; index < line.length; index++) {
    const left = index >= bpp ? line[index - bpp]! : 0;
    const up = previous[index]!;
    const corner = index >= bpp ? previous[index - bpp]! : 0;
    const add =
      filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, corner);
    line[index] = (line[index]! + add) & 255;
  }
}

/**
 * Streams IDAT through an async inflater, row by row into the box filter. The
 * inflated length must equal the IHDR's exactly; extra bytes stop the decode.
 */
async function decodeScaled(
  png: Png,
  width: number,
  height: number,
  check: () => void,
  signal: AbortSignal,
): Promise<BoxScaler> {
  const bitsPerPixel = CHANNELS[png.colorType]! * png.depth;
  const stride = Math.ceil((png.width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const scaler = new BoxScaler(png.width, png.height, width, height);
  let line = new Uint8Array(stride + 1);
  let previous = new Uint8Array(stride + 1);
  const rgba = new Uint8Array(png.width * 4);
  let filled = 0;
  let rows = 0;
  const inflater = createInflate();
  const abort = () => inflater.destroy(signal.reason as Error);
  signal.addEventListener("abort", abort, { once: true });
  try {
    inflater.end(png.idat);
    for await (const chunk of inflater as AsyncIterable<Buffer>) {
      check();
      let read = 0;
      while (read < chunk.length) {
        if (rows === png.height) throw new Refusal("not_previewable");
        const take = Math.min(stride + 1 - filled, chunk.length - read);
        line.set(chunk.subarray(read, read + take), filled);
        filled += take;
        read += take;
        if (filled < stride + 1) continue;
        const body = line.subarray(1);
        unfilter(line[0]!, body, previous.subarray(1), bpp);
        expand(png, body, rgba);
        scaler.add(rgba);
        [line, previous] = [previous, line];
        filled = 0;
        rows++;
      }
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    // Corrupt deflate data is a property of these bytes; anything else is not.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "Z_DATA_ERROR" || code === "Z_BUF_ERROR") throw new Refusal("not_previewable");
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    inflater.destroy();
  }
  if (rows !== png.height || filled !== 0) throw new Refusal("not_previewable");
  return scaler;
}

function rescale(source: BoxScaler, width: number, height: number): BoxScaler {
  const scaler = new BoxScaler(source.width, source.height, width, height);
  const stride = source.width * 4;
  for (let y = 0; y < source.height; y++) scaler.add(source.output.subarray(y * stride, (y + 1) * stride));
  return scaler;
}

const deflateAsync = promisify(deflate);

/** Settles with `work`, or rejects as soon as the deadline aborts; bounded work left behind finishes unobserved. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  work.catch(() => undefined);
  return Promise.race([work, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

interface Raster {
  readonly output: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** The raster over a white matte, for a JPEG when a transparent PNG cannot fit. */
function flatten(image: Raster): Raster {
  const output = new Uint8Array(image.output.length);
  for (let at = 0; at < output.length; at += 4) {
    const alpha = image.output[at + 3]!;
    for (let channel = 0; channel < 3; channel++)
      output[at + channel] = Math.round((image.output[at + channel]! * alpha + 255 * (255 - alpha)) / 255);
    output[at + 3] = 255;
  }
  return { output, width: image.width, height: image.height };
}

/** RGBA8 PNG with the minimum-sum filter per row; used only for images with transparency. */
async function encodePng(image: Raster, signal: AbortSignal): Promise<Buffer> {
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  const candidate = new Uint8Array(stride);
  for (let y = 0; y < image.height; y++) {
    const row = image.output.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? image.output.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
    let best = Infinity;
    for (let filter = 0; filter <= 4; filter++) {
      let cost = 0;
      for (let index = 0; index < stride; index++) {
        const left = index >= 4 ? row[index - 4]! : 0;
        const corner = index >= 4 ? up[index - 4]! : 0;
        const predict =
          filter === 0
            ? 0
            : filter === 1
              ? left
              : filter === 2
                ? up[index]!
                : filter === 3
                  ? (left + up[index]!) >> 1
                  : paeth(left, up[index]!, corner);
        const value = (row[index]! - predict) & 255;
        candidate[index] = value;
        cost += value < 128 ? value : 256 - value;
      }
      if (cost < best) {
        best = cost;
        raw[y * (stride + 1)] = filter;
        raw.set(candidate, y * (stride + 1) + 1);
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", await untilAborted(deflateAsync(raw, { level: 6 }), signal)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function encodeJpeg(image: Raster, quality: number): Promise<Buffer> {
  // The pure-JS encoder loads only when a thumbnail is actually rendered.
  const { encode } = await import("jpeg-js");
  return Buffer.from(
    encode(
      {
        data: Buffer.from(image.output.buffer, image.output.byteOffset, image.output.byteLength),
        width: image.width,
        height: image.height,
      },
      quality,
    ).data,
  );
}

/** Reads exactly `size` bytes within the deadline; stops at the first non-PNG bytes. */
async function readSource(
  body: ReadableStream<Uint8Array>,
  size: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const reader = body.getReader();
  const cancel = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener("abort", cancel, { once: true });
  const bytes = Buffer.alloc(size);
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (total + value.byteLength > size) throw new EvidenceThumbnailUnavailable("unreadable");
      bytes.set(value, total);
      const before = total;
      total += value.byteLength;
      if (before < 8 && total >= 8 && !bytes.subarray(0, 8).equals(PNG_SIGNATURE))
        throw new Refusal("too_large");
    }
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  if (total !== size) throw new EvidenceThumbnailUnavailable("unreadable");
  return bytes;
}

export class EvidenceThumbnails {
  private readonly cache = new Map<string, EvidenceDevicePreview>();
  private cacheBytes = 0;
  private readonly inflight = new Map<string, Promise<EvidenceDevicePreview>>();
  private readonly timedOut = new Map<string, number>();
  private readonly logged = new Set<string>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  /** Renders actually performed, for observing reuse. */
  renders = 0;

  private readonly limits: EvidenceThumbnailLimits;
  private readonly clock: () => number;

  constructor(
    limits: EvidenceThumbnailLimits = EVIDENCE_THUMBNAIL_LIMITS,
    options: { clock?: () => number } = {},
  ) {
    this.limits = limits;
    this.clock = options.clock ?? (() => performance.now());
  }

  /**
   * The preview for a recorded blob over the device cap. `open` is called only
   * on a cache miss, after a render slot is admitted.
   */
  async preview(
    sha256: string,
    size: number,
    open: () => Promise<{ size: number; body: ReadableStream<Uint8Array> } | undefined>,
  ): Promise<EvidenceDevicePreview> {
    const cached = this.cache.get(sha256);
    if (cached !== undefined) {
      this.cache.delete(sha256);
      this.cache.set(sha256, cached);
      return cached;
    }
    if (size > this.limits.sourceMaxBytes)
      return this.remember(sha256, { sha256, available: false, reason: "too_large" });
    const retryAt = this.timedOut.get(sha256);
    if (retryAt !== undefined) {
      if (Date.now() < retryAt) throw new EvidenceThumbnailUnavailable("timeout");
      this.timedOut.delete(sha256);
    }
    const pending = this.inflight.get(sha256);
    if (pending) return pending;
    const render = this.admitted(() => this.render(sha256, size, open)).finally(() =>
      this.inflight.delete(sha256),
    );
    this.inflight.set(sha256, render);
    return render;
  }

  private async admitted<T>(run: () => Promise<T>): Promise<T> {
    if (this.active < this.limits.concurrency) this.active++;
    else {
      if (this.waiting.length >= this.limits.maxQueued) throw new EvidenceThumbnailUnavailable("busy");
      await new Promise<void>((resolve, reject) => {
        const admit = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          const index = this.waiting.indexOf(admit);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new EvidenceThumbnailUnavailable("busy"));
        }, this.limits.queueWaitMs);
        this.waiting.push(admit);
      });
    }
    try {
      return await run();
    } finally {
      // Hand the slot straight to the next waiter, or free it.
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  private async render(
    sha256: string,
    size: number,
    open: () => Promise<{ size: number; body: ReadableStream<Uint8Array> } | undefined>,
  ): Promise<EvidenceDevicePreview> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new EvidenceThumbnailUnavailable("timeout")),
      this.limits.deadlineMs,
    );
    const { signal } = controller;
    // The timer cancels awaited I/O; codec work runs synchronously between
    // awaits, so elapsed time is also checked after every step and before any
    // result is cached.
    const started = this.clock();
    const check = () => {
      if (!signal.aborted && this.clock() - started > this.limits.deadlineMs)
        controller.abort(new EvidenceThumbnailUnavailable("timeout"));
      signal.throwIfAborted();
    };
    try {
      this.renders++;
      // Storage can stall; the deadline frees this slot even if the read never answers.
      const opening = open();
      let onAbort = () => {};
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      aborted.catch(() => undefined);
      const blob = await Promise.race([opening, aborted])
        .catch((error: unknown) => {
          // A late answer still holds a stream; release it.
          void opening.then((late) => late?.body.cancel()).catch(() => undefined);
          throw error;
        })
        .finally(() => signal.removeEventListener("abort", onAbort));
      if (!blob || blob.size !== size) {
        await blob?.body.cancel();
        throw new EvidenceThumbnailUnavailable("unreadable");
      }
      try {
        check();
      } catch (error) {
        // The stream is ours until readSource takes it.
        void blob.body.cancel().catch(() => undefined);
        throw error;
      }
      const source = await readSource(blob.body, size, signal);
      check();
      const png = parsePng(source, this.limits, check);
      check();
      const first = fit(png.width, png.height, this.limits.edges[0]!);
      const decoded = await decodeScaled(png, first.width, first.height, check, signal);
      check();
      // Transparency is kept when a PNG fits at a large enough edge; otherwise the ladder flattens to JPEG.
      const passes = decoded.opaque ? (["jpeg"] as const) : (["png", "flattened"] as const);
      for (const pass of passes)
        for (const edge of this.limits.edges) {
          if (pass === "png" && edge < this.limits.pngMinEdge) continue;
          check();
          const target = fit(png.width, png.height, edge);
          const image =
            target.width === decoded.width && target.height === decoded.height
              ? decoded
              : rescale(decoded, target.width, target.height);
          check();
          const bytes =
            pass === "png"
              ? await encodePng(image, signal)
              : await encodeJpeg(pass === "jpeg" ? image : flatten(image), this.limits.jpegQuality);
          // A rendition that finished past the deadline is not an answer.
          check();
          if (bytes.length <= this.limits.outputMaxBytes)
            return this.remember(sha256, {
              sha256,
              available: true,
              contentType: pass === "png" ? "image/png" : "image/jpeg",
              data: bytes.toString("base64"),
            });
        }
      throw new Refusal("too_large");
    } catch (error) {
      if (error instanceof Refusal)
        return this.remember(sha256, { sha256, available: false, reason: error.reason });
      if (error instanceof EvidenceThumbnailUnavailable) {
        if (error.code === "timeout") this.noteTimeout(sha256);
        throw error;
      }
      // Not a property of the bytes: leave it uncached, but visible once per sha256.
      if (!this.logged.has(sha256) && this.logged.size < this.limits.cacheMaxEntries) {
        this.logged.add(sha256);
        logger.warn(
          {
            event: "evidence.thumbnail.failed",
            sha256,
            error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
          },
          "evidence thumbnail render failed",
        );
      }
      throw new EvidenceThumbnailUnavailable("unreadable", { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  private noteTimeout(sha256: string): void {
    this.timedOut.delete(sha256);
    this.timedOut.set(sha256, Date.now() + this.limits.timeoutRetryMs);
    for (const key of this.timedOut.keys()) {
      if (this.timedOut.size <= this.limits.cacheMaxEntries) break;
      this.timedOut.delete(key);
    }
  }

  private remember(sha256: string, preview: EvidenceDevicePreview): EvidenceDevicePreview {
    const bytes = preview.data?.length ?? 0;
    if (bytes > this.limits.cacheMaxBytes) return preview;
    const previous = this.cache.get(sha256);
    if (previous !== undefined) {
      this.cache.delete(sha256);
      this.cacheBytes -= previous.data?.length ?? 0;
    }
    this.cache.set(sha256, preview);
    this.cacheBytes += bytes;
    for (const [key, value] of this.cache) {
      if (this.cache.size <= this.limits.cacheMaxEntries && this.cacheBytes <= this.limits.cacheMaxBytes)
        break;
      this.cache.delete(key);
      this.cacheBytes -= value.data?.length ?? 0;
    }
    return preview;
  }
}

/** One per process: content addressing makes a rendition valid for every store holding that sha256. */
export const evidenceThumbnails = new EvidenceThumbnails();
