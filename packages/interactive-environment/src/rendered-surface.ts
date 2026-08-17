import { DiscordActivitySurfaceSchema } from "@clankie/protocol";
import { z } from "zod";
import { INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION } from "./environment.ts";

/**
 * Frame transport for the activity plane ([ADR 0047](../../../docs/adr/0047-discord-activity-presence-plane.md)).
 *
 * The core stays on the host: the ROM, the WASM core, and the savestate never
 * cross this seam — only bounded encoded frames and live PCM do. That
 * preserves the pinned-digest fail-closed model and keeps copyrighted bytes
 * off every viewer's client.
 *
 * Raw media never enters semantic event streams. Evidence keeps carrying the
 * framebuffer digest it already carries; this envelope is the separate media
 * channel, mirroring the boundary ADR 0024 sets for stream receive.
 */

/** Hard ceiling for one encoded frame. A GBA PNG is normally single-digit KB. */
export const RENDERED_SURFACE_FRAME_MAX_BYTES = 256 * 1024;

/** Hard ceiling for one live PCM packet (normally about 4 KiB at GBA rate). */
export const RENDERED_SURFACE_AUDIO_MAX_BYTES = 64 * 1024;

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

export const RenderedSurfaceAudioSchema = z
  .object({
    schemaVersion: z.literal(INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION),
    surface: DiscordActivitySurfaceSchema,
    /** Monotonic per audio stream; gaps mean stale sound was dropped. */
    sequence: z.number().int().nonnegative(),
    /** Emulator frame that produced this packet. */
    frame: z.number().int().nonnegative(),
    encoding: z.literal("pcm_s16le"),
    sampleRate: z.number().int().min(8_000).max(192_000),
    channels: z.literal(2),
    frames: z.number().int().positive().max(16_384),
    data: z.string().min(1),
    byteLength: z.number().int().positive().max(RENDERED_SURFACE_AUDIO_MAX_BYTES),
    capturedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    const decoded = Buffer.from(value.data, "base64").byteLength;
    if (decoded !== value.byteLength || decoded !== value.frames * value.channels * 2) {
      context.addIssue({
        code: "custom",
        path: ["byteLength"],
        message: "PCM byte length does not match its payload and frame count",
      });
    }
  });
export type RenderedSurfaceAudio = z.infer<typeof RenderedSurfaceAudioSchema>;

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
 *
 * The overlay is versioned independently of the package constant: v1 carried
 * free-form `lines`; v2 carries the structured turn fields. The hub and client
 * accept both so an old producer keeps its lower third during a rolling
 * upgrade, but a new producer always puts an honest 2 on the wire.
 */
export const RENDERED_SURFACE_OVERLAY_SCHEMA_VERSION = 2 as const;

/** The legacy v1 overlay: short free-form lines. Accepted, never produced. */
export const RenderedSurfaceOverlayV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    surface: DiscordActivitySurfaceSchema,
    sequence: z.number().int().nonnegative(),
    /** Short human-readable lines, e.g. party summary or the chosen move. */
    lines: z.array(z.string().min(1).max(256)).max(16),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type RenderedSurfaceOverlayV1 = z.infer<typeof RenderedSurfaceOverlayV1Schema>;

export const RenderedSurfaceOverlayV2Schema = z
  .object({
    // Producers built while the overlay still shared the package-wide version
    // stamp 1 on this structured shape. The shapes are disjoint (v1 carries
    // `lines`), so the stale stamp is unambiguous: parsing normalizes it here
    // and a structured overlay labelled 1 never reaches the wire, because both
    // producers publish the output of this parse. Drop the tolerance for 1
    // once every producer stamps 2 itself.
    schemaVersion: z
      .union([z.literal(1), z.literal(2)])
      .transform(() => RENDERED_SURFACE_OVERLAY_SCHEMA_VERSION),
    surface: DiscordActivitySurfaceSchema,
    sequence: z.number().int().nonnegative(),
    /** Clankie's standing goal, authored by the mind and carried across turns. */
    objective: z.string().min(1).max(256).nullable(),
    /** The concrete next action Clankie intends to take. */
    intent: z.string().min(1).max(256).nullable(),
    /** Why Clankie chose the current action, in his own bounded words. */
    monologue: z.string().min(1).max(256).nullable(),
    /** What the runner observed after the action settled. */
    effect: z.string().min(1).max(256).nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type RenderedSurfaceOverlayV2 = z.infer<typeof RenderedSurfaceOverlayV2Schema>;

/** Any overlay accepted on the wire: the current v2, or the legacy v1 lines. */
export const RenderedSurfaceOverlaySchema = z.union([
  RenderedSurfaceOverlayV2Schema,
  RenderedSurfaceOverlayV1Schema,
]);
export type RenderedSurfaceOverlay = z.infer<typeof RenderedSurfaceOverlaySchema>;

/** Present-tense work state while the next completed-turn overlay is pending. */
export const RenderedSurfaceStatusSchema = z
  .object({
    schemaVersion: z.literal(INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION),
    surface: DiscordActivitySurfaceSchema,
    phase: z.enum(["thinking", "acting"]),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type RenderedSurfaceStatus = z.infer<typeof RenderedSurfaceStatusSchema>;

export const RenderedSurfaceMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("frame"), frame: RenderedSurfaceFrameSchema }).strict(),
  z.object({ kind: z.literal("audio"), audio: RenderedSurfaceAudioSchema }).strict(),
  z.object({ kind: z.literal("overlay"), overlay: RenderedSurfaceOverlaySchema }).strict(),
  z.object({ kind: z.literal("status"), status: RenderedSurfaceStatusSchema }).strict(),
  z.object({ kind: z.literal("stopped"), reason: z.enum(["operator_stop", "session_ended"]) }).strict(),
]);
export type RenderedSurfaceMessage = z.infer<typeof RenderedSurfaceMessageSchema>;
