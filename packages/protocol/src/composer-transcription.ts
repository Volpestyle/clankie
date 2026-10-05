import { z } from "zod";

export const COMPOSER_TRANSCRIPTION_ROOT = "/v1/composer/transcription";
export const COMPOSER_TRANSCRIPTION_STATUS_PATH = `${COMPOSER_TRANSCRIPTION_ROOT}/status`;
export const COMPOSER_TRANSCRIPTION_BEGIN_PATH = `${COMPOSER_TRANSCRIPTION_ROOT}/begin`;
export const COMPOSER_TRANSCRIPTION_CHUNK_PATH = `${COMPOSER_TRANSCRIPTION_ROOT}/chunk`;
export const COMPOSER_TRANSCRIPTION_COMMIT_PATH = `${COMPOSER_TRANSCRIPTION_ROOT}/commit`;
export const COMPOSER_TRANSCRIPTION_CANCEL_PATH = `${COMPOSER_TRANSCRIPTION_ROOT}/cancel`;
export const COMPOSER_TRANSCRIPTION_RECEIPT_PATH = `${COMPOSER_TRANSCRIPTION_ROOT}/receipt`;
export const COMPOSER_TRANSCRIPTION_DURATION_MS_MAX = 180_000;
export const COMPOSER_TRANSCRIPTION_CHUNK_BYTES_MAX = 256 * 1024;
export const COMPOSER_TRANSCRIPTION_AUDIO_BYTES_MAX = 180 * 16_000 * 2 + 64 * 1024 + 44;
export const ComposerTranscriptionRequestIdSchema = z.uuid();
const Base64 = z
  .string()
  .regex(/^[A-Za-z0-9+/]*={0,2}$/u)
  .refine((value) => value.length % 4 === 0);
export const ComposerTranscriptionStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.enum(["local", "managed"]),
    state: z.enum(["available", "unavailable", "ineligible", "allowance_exhausted"]),
    maxDurationMs: z.number().int().positive().max(COMPOSER_TRANSCRIPTION_DURATION_MS_MAX),
    maxAudioBytes: z.number().int().positive().max(COMPOSER_TRANSCRIPTION_AUDIO_BYTES_MAX),
    maxChunkBytes: z.number().int().positive().max(COMPOSER_TRANSCRIPTION_CHUNK_BYTES_MAX),
    allowance: z
      .object({
        limitMs: z.number().int().nonnegative(),
        remainingMs: z.number().int().nonnegative(),
        resetsAt: z.iso.datetime(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ComposerTranscriptionStatus = z.infer<typeof ComposerTranscriptionStatusSchema>;
export const ComposerTranscriptionRequestSchema = z
  .object({ requestId: ComposerTranscriptionRequestIdSchema })
  .strict();
export const ComposerTranscriptionBeginSchema = ComposerTranscriptionRequestSchema.extend({
  audioBytes: z.number().int().min(46).max(COMPOSER_TRANSCRIPTION_AUDIO_BYTES_MAX),
}).strict();
export const ComposerTranscriptionChunkSchema = ComposerTranscriptionRequestSchema.extend({
  offset: z.number().int().nonnegative().max(COMPOSER_TRANSCRIPTION_AUDIO_BYTES_MAX),
  dataBase64: Base64.min(4).max(Math.ceil(COMPOSER_TRANSCRIPTION_CHUNK_BYTES_MAX / 3) * 4),
}).strict();
export const ComposerTranscriptionErrorCodeSchema = z.enum([
  "authentication_required",
  "forbidden",
  "unavailable",
  "ineligible",
  "allowance_exhausted",
  "invalid_request",
  "invalid_audio",
  "capacity",
  "not_found",
  "conflict",
  "cancelled",
  "uncertain",
  "provider_failed",
]);
export const ComposerTranscriptionErrorSchema = z
  .object({ error: ComposerTranscriptionErrorCodeSchema })
  .strict();
export const ComposerTranscriptionReceiptSchema = ComposerTranscriptionRequestSchema.extend({
  schemaVersion: z.literal(1),
  state: z.enum(["uploading", "transcribing", "complete", "cancelled", "failed", "uncertain"]),
  receivedBytes: z.number().int().nonnegative().max(COMPOSER_TRANSCRIPTION_AUDIO_BYTES_MAX).optional(),
  text: z.string().max(16_000).optional(),
  error: ComposerTranscriptionErrorCodeSchema.optional(),
})
  .strict()
  .superRefine((value, context) => {
    if ((value.state === "complete") !== (value.text !== undefined))
      context.addIssue({ code: "custom", message: "Only a complete receipt contains draft text" });
  });
export type ComposerTranscriptionReceipt = z.infer<typeof ComposerTranscriptionReceiptSchema>;
export type ComposerTranscriptionBegin = z.infer<typeof ComposerTranscriptionBeginSchema>;
export type ComposerTranscriptionChunk = z.infer<typeof ComposerTranscriptionChunkSchema>;
/** Bound the actual RIFF sample data; client duration and container labels grant no allowance. */
export function parseComposerWav(audio: Uint8Array): { durationMs: number; dataBytes: number } {
  const invalid = () => new Error("invalid_audio");
  if (audio.byteLength < 46 || audio.byteLength > COMPOSER_TRANSCRIPTION_AUDIO_BYTES_MAX) throw invalid();
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const label = (offset: number) => String.fromCharCode(...audio.subarray(offset, offset + 4));
  if (label(0) !== "RIFF" || label(8) !== "WAVE" || view.getUint32(4, true) + 8 !== audio.byteLength)
    throw invalid();
  let position = 12,
    format = false,
    dataBytes: number | undefined,
    metadataBytes = 0;
  while (position < audio.byteLength) {
    if (position + 8 > audio.byteLength) throw invalid();
    const kind = label(position),
      size = view.getUint32(position + 4, true),
      start = position + 8;
    if (start + size + (size % 2) > audio.byteLength) throw invalid();
    if (kind === "fmt ") {
      if (
        format ||
        size < 16 ||
        size > 40 ||
        view.getUint16(start, true) !== 1 ||
        view.getUint16(start + 2, true) !== 1 ||
        view.getUint32(start + 4, true) !== 16_000 ||
        view.getUint32(start + 8, true) !== 32_000 ||
        view.getUint16(start + 12, true) !== 2 ||
        view.getUint16(start + 14, true) !== 16
      )
        throw invalid();
      format = true;
    } else if (kind === "data") {
      if (dataBytes !== undefined || size === 0 || size % 2 !== 0 || size > 180 * 16_000 * 2) throw invalid();
      dataBytes = size;
    } else {
      metadataBytes += size + 8 + (size % 2);
      if (metadataBytes > 64 * 1024) throw invalid();
    }
    position = start + size + (size % 2);
  }
  if (!format || dataBytes === undefined) throw invalid();
  return { durationMs: Math.ceil(dataBytes / 32), dataBytes };
}
