import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

export const PERSONA_IMAGE_LIMITS = {
  count: 8,
  sourceBytes: 10 * 1024 * 1024,
  videoBytes: 256 * 1024 * 1024,
  videoSeconds: 600,
  framesPerVideo: 10,
  sheetColumns: 5,
  sheetRows: 2,
  sheetTileEdge: 400,
  sheetEdge: 2000,
  edge: 1024,
  encodedBytes: 128 * 1024,
} as const;
// Version covers processing, frame selection, deduplication and caption role semantics.
export const VERSION = "persona-images-v3-filmstrip";
export const PixelSchema = z.object({
  data: z.string().min(1).max(PERSONA_IMAGE_LIMITS.encodedBytes),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  width: z.number().int().positive().max(PERSONA_IMAGE_LIMITS.edge),
  height: z.number().int().positive().max(PERSONA_IMAGE_LIMITS.edge),
});
export const SheetPixelSchema = PixelSchema.extend({
  width: z.number().int().positive().max(PERSONA_IMAGE_LIMITS.sheetEdge),
  height: z
    .number()
    .int()
    .positive()
    .max(PERSONA_IMAGE_LIMITS.sheetTileEdge * PERSONA_IMAGE_LIMITS.sheetRows),
});
export async function atomicBytes(path: string, value: Buffer): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, value, { mode: 0o600 });
  await rename(temp, path);
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, path);
}
export async function processImage(bytes: Buffer, contactSheet = false) {
  const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? "image/jpeg"
      : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
        ? "image/webp"
        : undefined;
  if (!mime) throw new Error("unreadable_or_unsupported_image");
  const resized = await resizeImage(bytes, mime, {
    maxWidth: contactSheet ? PERSONA_IMAGE_LIMITS.sheetEdge : PERSONA_IMAGE_LIMITS.edge,
    maxHeight: contactSheet
      ? PERSONA_IMAGE_LIMITS.sheetTileEdge * PERSONA_IMAGE_LIMITS.sheetRows
      : PERSONA_IMAGE_LIMITS.edge,
    maxBytes: PERSONA_IMAGE_LIMITS.encodedBytes,
  });
  if (!resized) throw new Error("unreadable_or_unsupported_image");
  return (contactSheet ? SheetPixelSchema : PixelSchema).parse(resized);
}
