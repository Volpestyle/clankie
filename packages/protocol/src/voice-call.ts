import { z } from "zod";

// ---------------------------------------------------------------------------
// Device voice call (VUH-2682).
//
// A paired device calls Clankie: the same realtime voice session that runs
// his Discord rooms, with the device's microphone and speaker as its media.
// One WebSocket carries the call. Binary frames are 24 kHz mono signed 16-bit
// little-endian PCM in both directions: microphone audio up, his speech down.
// Text frames are the JSON events below. Audio is never retained.
//
// The device opens `VOICE_CALL_PATH` on its relay with its device bearer; the
// relay authorizes the device and carries the frames to the service's
// `OPERATOR_VOICE_CALL_PATH` with the captain bearer.
// ---------------------------------------------------------------------------

/** Relay route a paired device opens (WebSocket upgrade, device bearer). */
export const VOICE_CALL_PATH = "/v1/voice-call";
/** Service route the relay opens on the device's behalf (WebSocket upgrade, captain bearer). */
export const OPERATOR_VOICE_CALL_PATH = "/operator/v1/voice-call";
export const VOICE_CALL_SAMPLE_RATE = 24_000;
/** Largest binary frame either side sends: 200 ms of audio. Devices send 20 ms frames. */
export const VOICE_CALL_AUDIO_FRAME_MAX_BYTES = (VOICE_CALL_SAMPLE_RATE * 2) / 5;

const PlaybackIdSchema = z.string().min(1).max(128).regex(/^\S+$/u);

/**
 * What the call is doing, for the device to show. `hearing` means the device's
 * own speech is being captured; `speaking` means his reply is audible.
 */
export const VoiceCallStateSchema = z.enum(["connecting", "listening", "hearing", "thinking", "speaking"]);
export type VoiceCallState = z.infer<typeof VoiceCallStateSchema>;

/**
 * Why a call ended. `hung_up` is the device; `left` is Clankie ending his own
 * stay; `voice_busy` means his voice is in another room (`room` names it);
 * `unavailable` means voice is not set up on this host.
 */
export const VoiceCallEndReasonSchema = z.enum([
  "hung_up",
  "left",
  "voice_busy",
  "unavailable",
  "revoked",
  "failed",
  "service_stopping",
]);
export type VoiceCallEndReason = z.infer<typeof VoiceCallEndReasonSchema>;

/** Device → service. Playback acks drive his turn-taking: started means audible, drained means finished. */
export const VoiceCallClientEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      schemaVersion: z.literal(1),
      type: z.literal("playback"),
      playbackId: PlaybackIdSchema,
      status: z.enum(["started", "drained", "stopped", "failed"]),
    })
    .strict(),
  z.object({ schemaVersion: z.literal(1), type: z.literal("hangup") }).strict(),
]);
export type VoiceCallClientEvent = z.infer<typeof VoiceCallClientEventSchema>;

/**
 * Service → device. A `playback` start precedes that reply's binary frames;
 * `finish` follows its last frame; `stop` discards whatever is still queued
 * (he was interrupted). Binary frames always belong to the latest started
 * playback.
 */
export const VoiceCallServerEventSchema = z.discriminatedUnion("type", [
  z.object({ schemaVersion: z.literal(1), type: z.literal("state"), state: VoiceCallStateSchema }).strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      type: z.literal("playback"),
      playbackId: PlaybackIdSchema,
      action: z.enum(["start", "finish", "stop"]),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      type: z.literal("ended"),
      reason: VoiceCallEndReasonSchema,
      /** For `voice_busy`: the room his voice is in, by its readable conversation name. */
      room: z.string().min(1).max(200).optional(),
    })
    .strict(),
]);
export type VoiceCallServerEvent = z.infer<typeof VoiceCallServerEventSchema>;
