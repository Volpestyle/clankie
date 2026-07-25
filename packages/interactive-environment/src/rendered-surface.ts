import { DiscordActivitySurfaceSchema } from "@clankie/protocol";
import { z } from "zod";
import { INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION } from "./environment.ts";

/**
 * Frame transport for the activity plane ([ADR 0047](../../../docs/adr/0047-discord-activity-presence-plane.md)).
 *
 * The core stays on the host: the ROM, the WASM core, and the savestate never
 * cross this seam — only encoded frames do. That preserves the pinned-digest
 * fail-closed model and keeps copyrighted bytes off every viewer's client.
 *
 * Raw frames never enter semantic event streams. Evidence keeps carrying the
 * framebuffer digest it already carries; this envelope is the separate media
 * channel, mirroring the boundary ADR 0024 sets for stream receive.
 */

/** Hard ceiling for one encoded frame. A GBA PNG is normally single-digit KB. */
export const RENDERED_SURFACE_FRAME_MAX_BYTES = 256 * 1024;

/** Ceiling on frames buffered for a slow viewer before the oldest are dropped. */
export const RENDERED_SURFACE_QUEUE_MAX = 4;

export const RenderedSurfaceFrameSchema = z
  .object({
    schemaVersion: z.literal(INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION),
    surface: DiscordActivitySurfaceSchema,
    /** Monotonic per-stream sequence. Viewers drop anything out of order. */
    sequence: z.number().int().nonnegative(),
    /** Emulator frame counter the image was captured at. */
    frame: z.number().int().nonnegative(),
    width: z.number().int().positive().max(4_096),
    height: z.number().int().positive().max(4_096),
    encoding: z.literal("png"),
    /** Base64 PNG bytes. Decoded length is bounded by RENDERED_SURFACE_FRAME_MAX_BYTES. */
    data: z.string().min(1),
    byteLength: z.number().int().positive().max(RENDERED_SURFACE_FRAME_MAX_BYTES),
    /** Digest of the encoded bytes so a viewer can detect a corrupted frame. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    capturedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Buffer.from(value.data, "base64").byteLength !== value.byteLength) {
      context.addIssue({
        code: "custom",
        path: ["byteLength"],
        message: "encoded frame length does not match its payload",
      });
    }
  });
export type RenderedSurfaceFrame = z.infer<typeof RenderedSurfaceFrameSchema>;

/**
 * The sidecar rendered beside the canvas. This is what an activity can show
 * that a flat video stream cannot: why Clankie did what he did.
 *
 * **Bounded model text may cross this seam**, and that is the point — his
 * monologue is the payload ([ADR 0049](../../../docs/adr/0049-free-play-agency-and-non-deterministic-evidence.md)).
 * An earlier revision of this comment said no model output crossed at all,
 * which contradicted ADR 0049 and would have made the overlay useless for the
 * thing it exists to do.
 *
 * What holds instead: every line is length-capped and count-capped here, the
 * text stays untrusted, and it reaches a viewer only through this schema — never
 * as raw model output posted straight to a channel.
 */
export const RenderedSurfaceOverlaySchema = z
  .object({
    schemaVersion: z.literal(INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION),
    surface: DiscordActivitySurfaceSchema,
    sequence: z.number().int().nonnegative(),
    /** Short human-readable lines, e.g. party summary or the chosen move. */
    lines: z.array(z.string().min(1).max(256)).max(16),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type RenderedSurfaceOverlay = z.infer<typeof RenderedSurfaceOverlaySchema>;

export const RenderedSurfaceMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("frame"), frame: RenderedSurfaceFrameSchema }).strict(),
  z.object({ kind: z.literal("overlay"), overlay: RenderedSurfaceOverlaySchema }).strict(),
  z.object({ kind: z.literal("stopped"), reason: z.enum(["operator_stop", "session_ended"]) }).strict(),
]);
export type RenderedSurfaceMessage = z.infer<typeof RenderedSurfaceMessageSchema>;
