import {
  COMPOSER_TRANSCRIPTION_STATUS_PATH,
  COMPOSER_TRANSCRIPTION_BEGIN_PATH,
  COMPOSER_TRANSCRIPTION_CHUNK_PATH,
  COMPOSER_TRANSCRIPTION_COMMIT_PATH,
  COMPOSER_TRANSCRIPTION_CANCEL_PATH,
  COMPOSER_TRANSCRIPTION_RECEIPT_PATH,
  ComposerTranscriptionStatusSchema,
  ComposerTranscriptionReceiptSchema,
  ComposerTranscriptionBeginSchema,
  ComposerTranscriptionChunkSchema,
  ComposerTranscriptionRequestSchema,
  type ComposerTranscriptionBegin,
  type ComposerTranscriptionChunk,
} from "@clankie/protocol/composer-transcription";
import { parseProtocolResponse } from "@clankie/protocol";

/** The caller supplies the existing encrypted paired-device transport. Never retries a write. */
export function createComposerTranscriptionApi(options: {
  request(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<unknown>;
}) {
  const receipt = async (path: string, requestId: string, signal?: AbortSignal) =>
    parseProtocolResponse(
      ComposerTranscriptionReceiptSchema,
      await options.request("POST", path, ComposerTranscriptionRequestSchema.parse({ requestId }), signal),
    );
  return {
    async status(signal?: AbortSignal) {
      return parseProtocolResponse(
        ComposerTranscriptionStatusSchema,
        await options.request("GET", COMPOSER_TRANSCRIPTION_STATUS_PATH, undefined, signal),
      );
    },
    async begin(input: ComposerTranscriptionBegin, signal?: AbortSignal) {
      return parseProtocolResponse(
        ComposerTranscriptionReceiptSchema,
        await options.request(
          "POST",
          COMPOSER_TRANSCRIPTION_BEGIN_PATH,
          ComposerTranscriptionBeginSchema.parse(input),
          signal,
        ),
      );
    },
    async chunk(input: ComposerTranscriptionChunk, signal?: AbortSignal) {
      return parseProtocolResponse(
        ComposerTranscriptionReceiptSchema,
        await options.request(
          "POST",
          COMPOSER_TRANSCRIPTION_CHUNK_PATH,
          ComposerTranscriptionChunkSchema.parse(input),
          signal,
        ),
      );
    },
    commit: (requestId: string, signal?: AbortSignal) =>
      receipt(COMPOSER_TRANSCRIPTION_COMMIT_PATH, requestId, signal),
    cancel: (requestId: string, signal?: AbortSignal) =>
      receipt(COMPOSER_TRANSCRIPTION_CANCEL_PATH, requestId, signal),
    receipt: (requestId: string, signal?: AbortSignal) =>
      receipt(COMPOSER_TRANSCRIPTION_RECEIPT_PATH, requestId, signal),
  };
}
export type ComposerTranscriptionApi = ReturnType<typeof createComposerTranscriptionApi>;
