import { z } from "zod";
import { EvidenceSha256Schema } from "./evidence.ts";

/**
 * Media embedded in tracker items, shown on the owner's devices (VUH-2666). A
 * device names the media links it found in items the service returned to it;
 * the service resolves each to a recorded evidence blob the device reads with
 * evidence_preview and evidence_fetch. Linear uploads are downloaded once by the
 * service with its connected app; the device never holds a Linear credential and
 * never asks the service to fetch an arbitrary URL.
 */
export const WORK_MEDIA_REQUEST_MAX = 32;
export const WorkMediaUrlSchema = z.string().min(1).max(4096);
export const WorkMediaEntrySchema = z.discriminatedUnion("state", [
  z
    .object({
      url: WorkMediaUrlSchema,
      state: z.literal("ready"),
      sha256: EvidenceSha256Schema,
      contentType: z.string().max(200),
      kind: z.enum(["image", "video", "file"]),
      size: z.number().int().min(0),
    })
    .strict(),
  /** Being downloaded; ask again shortly. */
  z.object({ url: WorkMediaUrlSchema, state: z.literal("pending") }).strict(),
  z
    .object({
      url: WorkMediaUrlSchema,
      state: z.literal("failed"),
      /** not_returned: no item the service returned carries this link; nothing is fetched for it. */
      reason: z.enum(["not_returned", "not_found", "too_large", "unavailable"]),
    })
    .strict(),
]);
export type WorkMediaEntry = z.infer<typeof WorkMediaEntrySchema>;
export const WorkMediaRequestSchema = z
  .object({ urls: z.array(WorkMediaUrlSchema).min(1).max(WORK_MEDIA_REQUEST_MAX) })
  .strict();
