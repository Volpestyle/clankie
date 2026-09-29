import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

export const PERSONA_IMAGE_LIMITS = {
  count: 8,
  sourceBytes: 10 * 1024 * 1024,
  videoBytes: 256 * 1024 * 1024,
  videoSeconds: 600,
  framesPerVideo: 3,
  edge: 1024,
  encodedBytes: 128 * 1024,
} as const;
// Version covers processing, frame selection, deduplication and caption role semantics.
export const VERSION = "persona-images-v2";
export const PixelSchema = z.object({
  data: z.string().min(1).max(PERSONA_IMAGE_LIMITS.encodedBytes),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  width: z.number().int().positive().max(PERSONA_IMAGE_LIMITS.edge),
  height: z.number().int().positive().max(PERSONA_IMAGE_LIMITS.edge),
});
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, path);
}
export async function processImage(bytes: Buffer) {
  const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? "image/jpeg"
      : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
        ? "image/webp"
        : undefined;
  if (!mime) throw new Error("unreadable_or_unsupported_image");
  const resized = await resizeImage(bytes, mime, {
    maxWidth: PERSONA_IMAGE_LIMITS.edge,
    maxHeight: PERSONA_IMAGE_LIMITS.edge,
    maxBytes: PERSONA_IMAGE_LIMITS.encodedBytes,
  });
  if (!resized) throw new Error("unreadable_or_unsupported_image");
  return PixelSchema.parse(resized);
}
