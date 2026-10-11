import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  LEAD_SKIN_LIMITS,
  validateSkinLeadPackForReview,
  type SkinFrame,
  type SkinLeadBody,
  type SkinLeadPackManifest,
} from "./contract.ts";
import { decodeLeadAtlas, encodePNG } from "./image.ts";
export const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export interface GridFrame {
  duration: number;
  rows: string[];
}
export interface GridTag {
  name: string;
  direction: string;
  repeat: number | undefined;
  frames: GridFrame[];
}
export interface LeadSkinRecipe {
  id: string;
  version: string;
  displayName: string;
  cell: { width: number; height: number };
  scale: number;
  animations: string[];
}
export interface LeadSkinSource {
  skin: LeadSkinRecipe;
  palette: Record<string, number[]>;
  tags: GridTag[];
}
function checkSource({ skin, palette, tags }: LeadSkinSource) {
  const { width, height } = skin.cell;
  if (
    !Number.isSafeInteger(width) ||
    width < 1 ||
    width > LEAD_SKIN_LIMITS.cellWidth ||
    !Number.isSafeInteger(height) ||
    height < 1 ||
    height > LEAD_SKIN_LIMITS.cellHeight
  )
    throw new Error("Cell must fit the native lead grid limits; never squash a reference");
  if (
    !Array.isArray(tags) ||
    tags.length > 128 ||
    !tags.length ||
    new Set(tags.map((t) => t.name)).size !== tags.length
  )
    throw new Error("Invalid or duplicate animations");
  let frames = 0;
  for (const t of tags) {
    if (
      !/^[a-z][a-z0-9_]{0,63}$/u.test(t.name) ||
      !["forward", "reverse", "pingpong", "pingpong_reverse"].includes(t.direction) ||
      (t.repeat !== undefined && t.repeat !== 0 && t.repeat !== 1) ||
      !Array.isArray(t.frames) ||
      !t.frames.length
    )
      throw new Error("Invalid animation metadata");
    frames += t.frames.length;
    if (
      frames > LEAD_SKIN_LIMITS.frames ||
      frames * width > LEAD_SKIN_LIMITS.atlasDimension ||
      frames * width * height > LEAD_SKIN_LIMITS.atlasPixels
    )
      throw new Error("Atlas frame limit exceeded");
    for (const f of t.frames) {
      if (
        !(Number.isFinite(f.duration) && f.duration > 0) ||
        f.rows.length !== height ||
        f.rows.some((r) => r.length !== width)
      )
        throw new Error("Invalid grid or frame timing");
      for (const row of f.rows)
        for (const key of row) {
          const color = palette[key];
          if (
            key.length !== 1 ||
            !color ||
            color.length !== 4 ||
            color.some((c) => !Number.isInteger(c) || c < 0 || c > 255) ||
            (color[3] !== 0 && color[3] !== 255) ||
            (key !== "." && color[3] !== 255)
          )
            throw new Error("Invalid palette cell");
        }
    }
  }
  if (!palette["."] || palette["."].length !== 4 || palette["."].some((c) => c !== 0))
    throw new Error("The dot palette cell must be transparent");
  const idle = tags.find((t) => t.name === "idle");
  if (!idle || idle.frames[0]!.rows.every((r) => /^\.+$/u.test(r)))
    throw new Error("Idle must contain a visible body");
}
/** Frame indices a tag plays, honouring Aseprite's direction. */
export function tagFrames(tag: { from: number; to: number; direction: string }) {
  const forward = [];
  for (let i = tag.from; i <= tag.to; i += 1) forward.push(i);
  const reverse = [...forward].reverse();
  switch (tag.direction) {
    case "reverse":
      return reverse;
    case "pingpong":
      return [...forward, ...reverse.slice(1, -1)];
    case "pingpong_reverse":
      return [...reverse, ...forward.slice(1, -1)];
    default:
      return forward;
  }
}

/**
 * Where the feet meet the ground: the bottom opaque row of the first idle
 * frame, centred on that row's opaque span.
 */
export function feetOrigin(mask: { width: number; height: number; rows: string[] }) {
  for (let y = mask.rows.length - 1; y >= 0; y -= 1) {
    const bits = BigInt(`0x${mask.rows[y]}`);
    if (bits === 0n) continue;
    let left = -1;
    let right = -1;
    for (let x = 0; x < mask.width; x += 1) {
      if ((bits >> BigInt(x)) & 1n) {
        if (left < 0) left = x;
        right = x;
      }
    }
    return { x: Math.round((left + right + 1) / 2), y: y + 1 };
  }
  return { x: Math.round(mask.width / 2), y: mask.height };
}

/** Attention glyphs perch above the head's right edge: its top opaque row, rightmost pixel. */
export function glyphAnchor(mask: { width: number; height: number; rows: string[] }) {
  for (let y = 0; y < mask.rows.length; y += 1) {
    const bits = BigInt(`0x${mask.rows[y]}`);
    if (bits === 0n) continue;
    let right = 0;
    for (let x = 0; x < mask.width; x += 1) if ((bits >> BigInt(x)) & 1n) right = x;
    return { x: right - 3, y: y - 7 };
  }
  return { x: mask.width - 8, y: -7 };
}

export function visibleBounds(mask: { width: number; height: number; rows: string[] }) {
  let left = mask.width;
  let right = -1;
  let top = mask.height;
  let bottom = -1;
  for (let y = 0; y < mask.rows.length; y += 1) {
    const bits = BigInt(`0x${mask.rows[y]}`);
    for (let x = 0; x < mask.width; x += 1) {
      if (((bits >> BigInt(x)) & 1n) === 0n) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  return right < 0
    ? { x: 0, y: 0, width: mask.width, height: mask.height }
    : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

export function parsePalette(text: string) {
  const palette: Record<string, number[]> = { ".": [0, 0, 0, 0] };
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const [key, hex] = line.trim().split(/\s+/);
    if (key!.length !== 1 || Object.hasOwn(palette, key!) || !/^[0-9a-f]{6}$/i.test(hex ?? ""))
      throw new Error(`palette: bad entry ${JSON.stringify(line)}`);
    palette[key!] = [0, 2, 4].map((at) => Number.parseInt(hex!.slice(at, at + 2), 16)).concat(255);
  }
  return palette;
}

/** One animation file: optional `direction` and `repeat`, then `frame <ms>` blocks of rows. */
export function parseTag(name: string, text: string, cell: { width: number; height: number }) {
  const meta: { direction: string; repeat: number | undefined } = { direction: "forward", repeat: undefined };
  const frames: GridFrame[] = [];
  let current: GridFrame | undefined;
  text.split("\n").forEach((raw, index) => {
    const line = raw.trimEnd();
    const where = `${name}.txt:${index + 1}`;
    if (!line || line.startsWith("#")) return;
    const [word, value] = line.split(/\s+/);
    if (word === "direction") meta.direction = value!;
    else if (word === "repeat") meta.repeat = Number(value);
    else if (word === "frame") {
      const duration = Number(value);
      if (!(duration > 0)) throw new Error(`${where}: frame duration must be positive`);
      current = { duration, rows: [] };
      frames.push(current);
    } else {
      if (!current) throw new Error(`${where}: pixel row before any 'frame' line`);
      if (line.length !== cell.width)
        throw new Error(`${where}: row is ${line.length} wide, want ${cell.width}`);
      current.rows.push(line);
    }
  });
  if (frames.length === 0) throw new Error(`${name}.txt: no frames`);
  frames.forEach((frame, index) => {
    if (frame.rows.length !== cell.height)
      throw new Error(`${name}.txt: frame ${index} has ${frame.rows.length} rows, want ${cell.height}`);
  });
  return { name, ...meta, frames };
}

function frameMask(rows: string[]) {
  const width = rows[0]!.length;
  return {
    width,
    height: rows.length,
    rows: rows.map((row) => {
      let bits = 0n;
      for (let x = 0; x < width; x += 1) if (row[x] !== ".") bits |= 1n << BigInt(x);
      return bits.toString(16);
    }),
  };
}

/** The atlas is one row of cells in animation order; frame ids are `lead.<index>`. */
export function buildLeadSkin({ skin, palette, tags }: LeadSkinSource) {
  checkSource({ skin, palette, tags });
  const { width, height } = skin.cell;
  const cells = tags.flatMap((tag) => tag.frames);
  const rgba = Buffer.alloc(cells.length * width * height * 4);
  const stride = cells.length * width * 4;
  cells.forEach((cell, index) =>
    cell.rows.forEach((row, y) =>
      [...row].forEach((key, x) => {
        palette[key!]!.forEach((channel, c) => {
          rgba[y * stride + (index * width + x) * 4 + c] = channel;
        });
      }),
    ),
  );
  const frames: Record<string, SkinFrame> = {};
  cells.forEach((_, index) => {
    frames[`lead.${index}`] = { x: index * width, y: 0, width, height };
  });
  const animations: SkinLeadBody["animations"] = {} as SkinLeadBody["animations"];
  let start = 0;
  for (const tag of tags) {
    const order = tagFrames({ from: start, to: start + tag.frames.length - 1, direction: tag.direction });
    animations[tag.name] = {
      frames: order.map((index) => `lead.${index}`),
      playback: tag.repeat === 1 ? "once" : "loop",
      frameDurationsMs: order.map((index) => cells[index]!.duration),
    };
    start += tag.frames.length;
  }
  const idle = frameMask(tags.find((tag) => tag.name === "idle")!.frames[0]!.rows);
  const manifest = validateSkinLeadPackForReview({
    contractVersion: 1,
    id: skin.id,
    version: skin.version,
    displayName: skin.displayName,
    lead: {
      atlas: { image: "pending", width: cells.length * width, height, frames },
      animations,
      scale: skin.scale,
      bounds: visibleBounds(idle),
      origin: feetOrigin(idle),
      glyph: glyphAnchor(idle),
    },
  });
  const png = encodePNG(cells.length * width, height, rgba);
  manifest.lead.atlas.image = `sha256:${digest(png)}`;
  return { manifest, png };
}

/** Read bounded data files only. No executable recipe, package path or remote URL is followed. */
export async function readLeadSkin(dir: string): Promise<LeadSkinSource> {
  let totalBytes = 0;
  const bounded = async (file: string, max: number) => {
    const { open } = await import("node:fs/promises");
    const f = await open(file, "r");
    try {
      if ((await f.stat()).size > max) throw new Error("Source byte limit exceeded");
      const b = Buffer.alloc(max + 1);
      let bytesRead = 0;
      while (bytesRead < b.length) {
        const part = await f.read(b, bytesRead, b.length - bytesRead, bytesRead);
        if (!part.bytesRead) break;
        bytesRead += part.bytesRead;
      }
      totalBytes += bytesRead;
      if (bytesRead > max || totalBytes > LEAD_SKIN_LIMITS.bytes)
        throw new Error("Source byte limit exceeded");
      return b.subarray(0, bytesRead).toString("utf8");
    } finally {
      await f.close();
    }
  };
  const skin = JSON.parse(await bounded(join(dir, "skin.json"), 16384)) as LeadSkinRecipe;
  if (
    !Array.isArray(skin.animations) ||
    skin.animations.length > 128 ||
    skin.animations.some((n) => typeof n !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(n))
  )
    throw new Error("Invalid animation names");
  const palette = parsePalette(await bounded(join(dir, "palette.txt"), 16384));
  const tags = [];
  for (const name of skin.animations)
    tags.push(
      parseTag(
        name,
        await bounded(join(dir, "src", `${name}.txt`), LEAD_SKIN_LIMITS.manifestBytes),
        skin.cell,
      ),
    );
  checkSource({ skin, palette, tags });
  return { skin, palette, tags };
}
/** Paginated diagnostic sheets cover every played frame at exact nearest-neighbour scale.
 * Row metadata supplies animation names, frame ids, timing and playback; no font or art is bundled.
 */
export function* renderLeadSkinSheets(manifest: SkinLeadPackManifest, png: Buffer) {
  const lead = validateSkinLeadPackForReview(manifest).lead,
    image = decodeLeadAtlas(png);
  if (image.width !== lead.atlas.width || image.height !== lead.atlas.height)
    throw new Error("Review atlas does not match the manifest");
  const cell = lead.atlas.frames[lead.animations.idle.frames[0]!]!;
  const scale = 3,
    columns = 8,
    pageRows = 8;
  const rows = Object.entries(lead.animations).flatMap(([animation, sequence]) => {
    const chunks = [];
    for (let at = 0; at < sequence!.frames.length; at += columns)
      chunks.push({
        animation,
        firstFrame: at,
        frameIds: sequence!.frames.slice(at, at + columns),
        durationsMs: sequence!.frameDurationsMs?.slice(at, at + columns),
        fps: sequence!.fps,
        playback: sequence!.playback,
      });
    return chunks;
  });
  for (let page = 0; page < rows.length; page += pageRows) {
    const selected = rows.slice(page, page + pageRows);
    const width = (cell.width + 2) * scale * columns,
      height = (cell.height + 2) * scale * selected.length;
    const rgba = Buffer.alloc(width * height * 4, 255);
    selected.forEach((row, yRow) =>
      row.frameIds.forEach((id, col) => {
        const f = lead.atlas.frames[id]!;
        for (let y = 0; y < f.height; y++)
          for (let x = 0; x < f.width; x++) {
            const at = ((f.y + y) * image.width + f.x + x) * 4;
            if (!image.rgba[at + 3]) continue;
            for (let dy = 0; dy < scale; dy++)
              for (let dx = 0; dx < scale; dx++)
                image.rgba.copy(
                  rgba,
                  (((yRow * (cell.height + 2) + y) * scale + dy) * width +
                    (col * (cell.width + 2) + x) * scale +
                    dx) *
                    4,
                  at,
                  at + 4,
                );
          }
      }),
    );
    yield { png: encodePNG(width, height, rgba), rows: selected };
  }
}
/** Expected hashes come from the authorized catalog; this proves integrity, not owner approval. */
export function verifyLeadSkinArtifact(
  manifestBytes: Buffer,
  png: Buffer,
  expected: { manifestSha256: string; atlasSha256: string },
): SkinLeadPackManifest {
  if (
    manifestBytes.length > LEAD_SKIN_LIMITS.manifestBytes ||
    png.length > LEAD_SKIN_LIMITS.bytes ||
    !/^[0-9a-f]{64}$/u.test(expected.manifestSha256) ||
    !/^[0-9a-f]{64}$/u.test(expected.atlasSha256) ||
    digest(manifestBytes) !== expected.manifestSha256 ||
    digest(png) !== expected.atlasSha256
  )
    throw new Error("Lead skin digest or manifest byte limit mismatch");
  const manifest = validateSkinLeadPackForReview(JSON.parse(manifestBytes.toString("utf8")));
  const image = decodeLeadAtlas(png);
  if (
    image.width !== manifest.lead.atlas.width ||
    image.height !== manifest.lead.atlas.height ||
    manifest.lead.atlas.image !== `sha256:${expected.atlasSha256}`
  )
    throw new Error("Lead atlas does not match the manifest");
  return manifest;
}
