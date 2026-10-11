import { decodeReference, encodePNG, checkImageSize, type PixelImage } from "./image.ts";

export interface ReferenceGrid {
  pitch: number;
  x?: number;
  y?: number;
  columns?: number;
  rows?: number;
}
export interface SamplingOptions {
  grid?: ReferenceGrid;
  /** Explicit flat background to make transparent; never infer it from a character's colors. */
  background?: readonly [number, number, number];
  backgroundTolerance?: number;
  colors?: number;
  approvedPalette?: readonly (readonly number[])[];
}
function energy(image: PixelImage, horizontal: boolean): Float64Array {
  const count = horizontal ? image.width : image.height,
    other = horizontal ? image.height : image.width;
  const values = new Float64Array(count);
  for (let i = 1; i < count; i++)
    for (let j = 0; j < other; j += 2) {
      const at = (horizontal ? j * image.width + i : i * image.width + j) * 4;
      const before = at - (horizontal ? 4 : image.width * 4);
      for (let c = 0; c < 3; c++) values[i]! += Math.abs(image.rgba[at + c]! - image.rgba[before + c]!);
    }
  return values;
}
function phaseScore(values: Float64Array, pitch: number) {
  let best = { score: 0, phase: 0 };
  for (let phase = 0; phase < pitch; phase += 0.5) {
    let score = 0,
      count = 0;
    for (let at = phase; at < values.length; at += pitch) {
      score += values[Math.round(at) % values.length]!;
      count++;
    }
    if (count >= 3 && score / count > best.score) best = { score: score / count, phase };
  }
  return best;
}
/** A measurement proposal, not authorization to change character proportions. */
export function detectReferenceGrid(image: PixelImage) {
  checkPixels(image);
  const columns = energy(image, true),
    scored = [];
  for (let step = 40; step <= 400; step++) {
    const pitch = step / 10;
    scored.push({ pitch, ...phaseScore(columns, pitch) });
  }
  const top = Math.max(...scored.map((s) => s.score));
  if (!top) throw new Error("No reference grid edges; supply an explicit grid");
  const chosen = scored.find((s) => s.score >= top * 0.9)!;
  return {
    pitch: chosen.pitch,
    x: chosen.phase,
    y: phaseScore(energy(image, false), chosen.pitch).phase,
    confidence: chosen.score / top,
    estimated: true as const,
  };
}
function checkPixels(image: PixelImage) {
  checkImageSize(image.width, image.height);
  if (image.rgba.length !== image.width * image.height * 4) throw new Error("Invalid RGBA image length");
}
const distance = (a: readonly number[], b: readonly number[]) =>
  a.slice(0, 3).reduce((sum, c, i) => sum + (c - b[i]!) ** 2, 0);
/** Deterministic weighted k-means. A supplied palette maps poses to their approved base colors. */
export function quantizeReference(
  image: PixelImage,
  colors = 16,
  approvedPalette?: readonly (readonly number[])[],
) {
  checkPixels(image);
  if (image.width * image.height > 65536)
    throw new Error("Quantize only a sampled grid of at most 65536 pixels");
  if (!Number.isInteger(colors) || colors < 1 || colors > 64) throw new Error("Palette size must be 1–64");
  const counts = new Map<string, { color: number[]; count: number }>();
  for (let at = 0; at < image.rgba.length; at += 4)
    if (image.rgba[at + 3]! >= 128) {
      const color = [...image.rgba.subarray(at, at + 3)],
        key = color.join(","),
        v = counts.get(key);
      if (v) v.count++;
      else counts.set(key, { color, count: 1 });
    }
  const entries = [...counts.values()].sort(
    (a, b) => b.count - a.count || a.color.join(",").localeCompare(b.color.join(","), "en"),
  );
  let palette = approvedPalette?.map((c) => c.slice(0, 3)) ?? [];
  if (
    approvedPalette &&
    (!palette.length ||
      palette.length > 64 ||
      approvedPalette.some(
        (c) => c.length !== 3 || c.slice(0, 3).some((n) => !Number.isInteger(n) || n < 0 || n > 255),
      ))
  )
    throw new Error("Invalid approved palette");
  if (!approvedPalette && entries.length) {
    palette = [entries[0]!.color];
    while (palette.length < Math.min(colors, entries.length)) {
      const next = entries.reduce(
        (best, e) =>
          Math.min(...palette.map((c) => distance(e.color, c))) >
          Math.min(...palette.map((c) => distance(best.color, c)))
            ? e
            : best,
        entries[0]!,
      );
      palette.push(next.color);
    }
    for (let iteration = 0; iteration < 12; iteration++) {
      const sums = palette.map(() => [0, 0, 0, 0]);
      for (const e of entries) {
        let index = 0;
        for (let i = 1; i < palette.length; i++)
          if (distance(e.color, palette[i]!) < distance(e.color, palette[index]!)) index = i;
        const s = sums[index]!;
        for (let c = 0; c < 3; c++) s[c]! += e.color[c]! * e.count;
        s[3]! += e.count;
      }
      const next = palette.map((old, i) =>
        sums[i]![3] ? sums[i]!.slice(0, 3).map((n) => Math.round(n / sums[i]![3]!)) : old,
      );
      if (JSON.stringify(next) === JSON.stringify(palette)) break;
      palette = next;
    }
  }
  const rgba = Buffer.alloc(image.rgba.length);
  for (let at = 0; at < image.rgba.length; at += 4)
    if (image.rgba[at + 3]! >= 128 && palette.length) {
      const color = [...image.rgba.subarray(at, at + 3)];
      let index = 0;
      for (let i = 1; i < palette.length; i++)
        if (distance(color, palette[i]!) < distance(color, palette[index]!)) index = i;
      rgba.set([...palette[index]!, 255], at);
    }
  return { image: { width: image.width, height: image.height, rgba }, palette };
}
/** Sample cell centers without resizing the character into a fixed lead cell. */
export function sampleReference(bytes: Buffer, options: SamplingOptions = {}) {
  const image = decodeReference(bytes),
    detected = options.grid ?? detectReferenceGrid(image);
  const pitch = detected.pitch,
    x = detected.x ?? 0,
    y = detected.y ?? 0;
  if (
    !Number.isFinite(pitch) ||
    pitch < 1 ||
    pitch > image.width ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0
  )
    throw new Error("Invalid explicit reference grid");
  const width = options.grid?.columns ?? Math.floor((image.width - x) / pitch),
    height = options.grid?.rows ?? Math.floor((image.height - y) / pitch);
  checkImageSize(width, height);
  if (width > 256 || height > 256 || x + width * pitch > image.width || y + height * pitch > image.height)
    throw new Error("Reference grid is outside the image or exceeds sampling limits");
  const tolerance = options.backgroundTolerance ?? 0;
  if (
    !Number.isFinite(tolerance) ||
    tolerance < 0 ||
    tolerance > 255 ||
    (options.background &&
      (options.background.length !== 3 ||
        options.background.some((c) => !Number.isInteger(c) || c < 0 || c > 255)))
  )
    throw new Error("Invalid background cleanup options");
  const rgba = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row++)
    for (let col = 0; col < width; col++) {
      const pixels: number[][] = [];
      for (
        let sy = Math.floor(y + row * pitch + pitch * 0.3);
        sy < Math.ceil(y + row * pitch + pitch * 0.7);
        sy++
      )
        for (
          let sx = Math.floor(x + col * pitch + pitch * 0.3);
          sx < Math.ceil(x + col * pitch + pitch * 0.7);
          sx++
        ) {
          if (sx >= image.width || sy >= image.height) continue;
          const at = (sy * image.width + sx) * 4;
          pixels.push([...image.rgba.subarray(at, at + 4)]);
        }
      pixels.sort((a, b) => a[0]! + a[1]! + a[2]! - b[0]! - b[1]! - b[2]!);
      const color = pixels[pixels.length >> 1] ?? [0, 0, 0, 0];
      if (color[3]! < 128) continue;
      rgba.set([...color.slice(0, 3), 255], (row * width + col) * 4);
    }
  // Only edge-connected flat background becomes transparent. Matching interior clothing survives.
  if (options.background) {
    const visited = new Uint8Array(width * height),
      queue: number[] = [];
    const visit = (index: number) => {
      if (visited[index]) return;
      visited[index] = 1;
      const at = index * 4;
      if (rgba[at + 3] && distance([...rgba.subarray(at, at + 3)], options.background!) > tolerance ** 2)
        return;
      rgba.fill(0, at, at + 4);
      queue.push(index);
    };
    for (let x = 0; x < width; x++) {
      visit(x);
      visit((height - 1) * width + x);
    }
    for (let y = 0; y < height; y++) {
      visit(y * width);
      visit(y * width + width - 1);
    }
    for (let at = 0; at < queue.length; at++) {
      const index = queue[at]!,
        x = index % width,
        y = Math.floor(index / width);
      if (x) visit(index - 1);
      if (x + 1 < width) visit(index + 1);
      if (y) visit(index - width);
      if (y + 1 < height) visit(index + width);
    }
  }
  const quantized = quantizeReference({ width, height, rgba }, options.colors ?? 16, options.approvedPalette);
  return {
    grid: { ...detected, columns: width, rows: height },
    ...quantized,
    png: encodePNG(width, height, quantized.image.rgba),
  };
}
