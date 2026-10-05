import { createHash } from "node:crypto";
import { z } from "zod";
import { RENDERED_SURFACE_AUDIO_MAX_BYTES, RENDERED_SURFACE_FRAME_MAX_BYTES } from "./rendered-surface.ts";

/** General media is separate from the legacy, game-specific v1 stream. */
export const ACTIVITY_SHARE_SCHEMA_VERSION = 2 as const;
export const ACTIVITY_SHARE_AUDIO_MAX_DURATION_MS = 200;
export const ACTIVITY_SHARE_MAX_BUFFERED_BYTES = 512 * 1024;

const identity = z.string().min(1).max(128);
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Authenticated management chooses this scope; a viewer cannot claim it. */
export const ActivityShareScopeSchema = z
  .object({
    tenantId: identity,
    installationId: identity,
    guildId: identity,
    channelId: identity,
  })
  .strict();
export type ActivityShareScope = z.infer<typeof ActivityShareScopeSchema>;

/** A source names media, and never grants authority to capture a file or screen. */
export const ActivityShareSourceSchema = z
  .object({
    kind: z.enum(["game", "image", "animation", "demo"]),
    id: identity,
    title: z.string().min(1).max(256),
  })
  .strict();
export type ActivityShareSource = z.infer<typeof ActivityShareSourceSchema>;

export const ActivityShareSessionSchema = z
  .object({
    shareId: z.string().uuid(),
    generation,
    scope: ActivityShareScopeSchema,
    source: ActivityShareSourceSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();
export type ActivityShareSession = z.infer<typeof ActivityShareSessionSchema>;

const base64 = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .max(4 * Math.ceil(maxBytes / 3));

function decodeCanonicalBase64(data: string, maxBytes: number): Buffer | undefined {
  if (data.length > 4 * Math.ceil(maxBytes / 3)) return undefined;
  const decoded = Buffer.from(data, "base64");
  return decoded.toString("base64") === data ? decoded : undefined;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Encoded PNG with an optional capture counter for game producers. */
export const ActivityShareFrameSchema = z
  .object({
    schemaVersion: z.literal(ACTIVITY_SHARE_SCHEMA_VERSION),
    sequence,
    frame: sequence.optional(),
    width: z.number().int().positive().max(4_096),
    height: z.number().int().positive().max(4_096),
    encoding: z.literal("png"),
    data: base64(RENDERED_SURFACE_FRAME_MAX_BYTES),
    byteLength: z.number().int().positive().max(RENDERED_SURFACE_FRAME_MAX_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    capturedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    const bytes = decodeCanonicalBase64(value.data, RENDERED_SURFACE_FRAME_MAX_BYTES);
    if (bytes === undefined || bytes.byteLength !== value.byteLength) {
      context.addIssue({
        code: "custom",
        path: ["data"],
        message: "PNG must use canonical base64 with the declared byte length",
      });
      return;
    }
    if (
      bytes.byteLength < 33 ||
      !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString("ascii", 12, 16) !== "IHDR" ||
      bytes.readUInt32BE(16) !== value.width ||
      bytes.readUInt32BE(20) !== value.height
    ) {
      context.addIssue({
        code: "custom",
        path: ["data"],
        message: "PNG signature and IHDR dimensions must match the frame",
      });
    }
    if (createHash("sha256").update(bytes).digest("hex") !== value.sha256) {
      context.addIssue({ code: "custom", path: ["sha256"], message: "PNG digest does not match" });
    }
  });
export type ActivityShareFrame = z.infer<typeof ActivityShareFrameSchema>;

/** Live sound packets never retain more than 200 ms of audio. */
export const ActivityShareAudioSchema = z
  .object({
    schemaVersion: z.literal(ACTIVITY_SHARE_SCHEMA_VERSION),
    sequence,
    frame: sequence.optional(),
    encoding: z.literal("pcm_s16le"),
    sampleRate: z.number().int().min(8_000).max(192_000),
    channels: z.literal(2),
    frames: z.number().int().positive().max(16_384),
    data: base64(RENDERED_SURFACE_AUDIO_MAX_BYTES),
    byteLength: z.number().int().positive().max(RENDERED_SURFACE_AUDIO_MAX_BYTES),
    capturedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    const bytes = decodeCanonicalBase64(value.data, RENDERED_SURFACE_AUDIO_MAX_BYTES);
    if (
      bytes === undefined ||
      bytes.byteLength !== value.byteLength ||
      bytes.byteLength !== value.frames * value.channels * 2
    ) {
      context.addIssue({
        code: "custom",
        path: ["data"],
        message: "PCM must use canonical base64 matching its byte length and frame count",
      });
    }
    if (value.frames * 1_000 > value.sampleRate * ACTIVITY_SHARE_AUDIO_MAX_DURATION_MS) {
      context.addIssue({
        code: "custom",
        path: ["frames"],
        message: "PCM packet duration exceeds the live audio limit",
      });
    }
  });
export type ActivityShareAudio = z.infer<typeof ActivityShareAudioSchema>;

const overlayText = z.string().min(1).max(256).nullable();
export const ActivityShareOverlaySchema = z
  .object({
    schemaVersion: z.literal(ACTIVITY_SHARE_SCHEMA_VERSION),
    sequence,
    objective: overlayText,
    intent: overlayText,
    monologue: overlayText,
    effect: overlayText,
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ActivityShareOverlay = z.infer<typeof ActivityShareOverlaySchema>;

export const ActivityShareStatusSchema = z
  .object({
    schemaVersion: z.literal(ACTIVITY_SHARE_SCHEMA_VERSION),
    phase: z.enum(["thinking", "acting"]),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ActivityShareStatus = z.infer<typeof ActivityShareStatusSchema>;

const fence = { shareId: z.string().uuid(), generation };
const frameMessage = z
  .object({ kind: z.literal("frame"), ...fence, frame: ActivityShareFrameSchema })
  .strict();
const audioMessage = z
  .object({ kind: z.literal("audio"), ...fence, audio: ActivityShareAudioSchema })
  .strict();
const overlayMessage = z
  .object({ kind: z.literal("overlay"), ...fence, overlay: ActivityShareOverlaySchema })
  .strict();
const statusMessage = z
  .object({ kind: z.literal("status"), ...fence, status: ActivityShareStatusSchema })
  .strict();
const stoppedMessage = z
  .object({
    kind: z.literal("stopped"),
    ...fence,
    reason: z.enum(["operator_stop", "session_ended", "expired"]),
  })
  .strict();

/** A producer cannot establish or change the authoritative session. */
export const ActivityShareProducerMessageSchema = z.discriminatedUnion("kind", [
  frameMessage,
  audioMessage,
  overlayMessage,
  statusMessage,
  stoppedMessage,
]);
export type ActivityShareProducerMessage = z.infer<typeof ActivityShareProducerMessageSchema>;

export const ActivityShareMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session"), session: ActivityShareSessionSchema }).strict(),
  frameMessage,
  audioMessage,
  overlayMessage,
  statusMessage,
  stoppedMessage,
]);
export type ActivityShareMessage = z.infer<typeof ActivityShareMessageSchema>;

export const ActivityShareStartResultSchema = z
  .object({ session: ActivityShareSessionSchema, producerToken: z.string().min(1).max(512) })
  .strict();
export type ActivityShareStartResult = z.infer<typeof ActivityShareStartResultSchema>;

export const ActivityShareGrantSchema = z
  .object({ grant: z.string().min(1).max(512), expiresAt: z.string().datetime() })
  .strict();
export type ActivityShareGrant = z.infer<typeof ActivityShareGrantSchema>;
