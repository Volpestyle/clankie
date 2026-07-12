import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { z } from "zod";

export const CLANKVOX_IPC_SCHEMA_VERSION = 1 as const;
export const CLANKVOX_STDIN_MAX_LINE_BYTES = 8 * 1024 * 1024;
export const CLANKVOX_STDOUT_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
export const CLANKVOX_FRAME_HEADER_BYTES = 5;
export const CLANKVOX_USER_AUDIO_HEADER_BYTES = 18;
const CLANKVOX_SIGNAL_ACTIVE_THRESHOLD = 500;

export const ClankVoxLane = {
  control: 0,
  userAudio: 1,
  log: 2,
  health: 3,
} as const;

export type ClankVoxLane = (typeof ClankVoxLane)[keyof typeof ClankVoxLane];

const EnvelopeShape = { schemaVersion: z.literal(CLANKVOX_IPC_SCHEMA_VERSION) } as const;
const NonEmptyStringSchema = z.string().min(1);
const BoundedReasonSchema = NonEmptyStringSchema.max(4_096);
const MAX_UNSIGNED_64_BIT_INTEGER = 18_446_744_073_709_551_615n;
const SnowflakeSchema = NonEmptyStringSchema.max(32)
  .regex(/^\d+$/, "Discord ids must be decimal snowflakes")
  .refine(
    (value) => /^\d+$/.test(value) && BigInt(value) <= MAX_UNSIGNED_64_BIT_INTEGER,
    "Discord ids must fit in an unsigned 64-bit integer",
  );
const SampleRateSchema = z.number().int().min(8_000).max(48_000);
const CounterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const DurationSchema = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER);

const CanonicalPcmBase64Schema = NonEmptyStringSchema.refine(isCanonicalAlignedPcmBase64, {
  message: "PCM must be canonical base64 containing whole s16le samples",
});

export const ClankVoxSessionOpenSchema = z
  .object({
    ...EnvelopeShape,
    type: z.literal("session_open"),
    endpoint: NonEmptyStringSchema.max(2_048),
    token: NonEmptyStringSchema.max(8_192),
    serverId: SnowflakeSchema,
    sessionId: NonEmptyStringSchema.max(512),
    userId: SnowflakeSchema,
    daveChannelId: SnowflakeSchema,
    sampleRate: SampleRateSchema,
  })
  .strict();
export type ClankVoxSessionOpen = z.infer<typeof ClankVoxSessionOpenSchema>;

export const ClankVoxAudioSchema = z
  .object({
    ...EnvelopeShape,
    type: z.literal("audio"),
    encoding: z.literal("pcm_s16le_base64"),
    pcmBase64: CanonicalPcmBase64Schema,
    sampleRate: SampleRateSchema,
  })
  .strict();
export type ClankVoxAudio = z.infer<typeof ClankVoxAudioSchema>;

export const ClankVoxSessionCloseSchema = z
  .object({
    ...EnvelopeShape,
    type: z.literal("session_close"),
    reason: BoundedReasonSchema.optional(),
  })
  .strict();
export type ClankVoxSessionClose = z.infer<typeof ClankVoxSessionCloseSchema>;

export const ClankVoxHealthRequestSchema = z
  .object({ ...EnvelopeShape, type: z.literal("health_request") })
  .strict();
export type ClankVoxHealthRequest = z.infer<typeof ClankVoxHealthRequestSchema>;

export const ClankVoxCommandSchema = z.discriminatedUnion("type", [
  ClankVoxSessionOpenSchema,
  ClankVoxAudioSchema,
  ClankVoxSessionCloseSchema,
  ClankVoxHealthRequestSchema,
]);
export type ClankVoxCommand = z.infer<typeof ClankVoxCommandSchema>;

export type ClankVoxAudioInput =
  | { sampleRate: number; pcm: Uint8Array }
  | { sampleRate: number; pcmBase64: string };

const DaveStateSchema = z.enum(["disabled", "negotiating", "ready", "failed"]);
export type ClankVoxDaveState = z.infer<typeof DaveStateSchema>;
const SessionStateValueSchema = z.enum(["opening", "ready", "closing", "closed", "failed"]);

export const ClankVoxProcessReadySchema = z
  .object({ ...EnvelopeShape, type: z.literal("process_ready") })
  .strict();
export type ClankVoxProcessReady = z.infer<typeof ClankVoxProcessReadySchema>;

export const ClankVoxSessionStateSchema = z
  .object({
    ...EnvelopeShape,
    type: z.literal("session_state"),
    state: SessionStateValueSchema,
    daveState: DaveStateSchema,
    reason: BoundedReasonSchema.optional(),
  })
  .strict();
export type ClankVoxSessionState = z.infer<typeof ClankVoxSessionStateSchema>;

function userEventSchema<T extends "speaking_start" | "speaking_end" | "user_audio_end">(type: T) {
  return z.object({ ...EnvelopeShape, type: z.literal(type), userId: SnowflakeSchema }).strict();
}

export const ClankVoxSpeakingStartSchema = userEventSchema("speaking_start");
export type ClankVoxSpeakingStart = z.infer<typeof ClankVoxSpeakingStartSchema>;
export const ClankVoxSpeakingEndSchema = userEventSchema("speaking_end");
export type ClankVoxSpeakingEnd = z.infer<typeof ClankVoxSpeakingEndSchema>;
export const ClankVoxUserAudioEndSchema = userEventSchema("user_audio_end");
export type ClankVoxUserAudioEnd = z.infer<typeof ClankVoxUserAudioEndSchema>;

const TickStatsSchema = z
  .object({
    total: CounterSchema,
    skipped: CounterSchema,
    slipEvents: CounterSchema,
    maxGapMs: DurationSchema,
  })
  .strict();
const IpcLaneStatsSchema = z
  .object({
    controlDropped: CounterSchema,
    audioDropped: CounterSchema,
    logDropped: CounterSchema,
  })
  .strict();
const InboundAudioStatsSchema = z
  .object({
    packets: CounterSchema,
    transportDecryptFail: CounterSchema,
    daveDecryptFail: CounterSchema,
    forwardLossGaps: CounterSchema,
    concealedFrames: CounterSchema,
  })
  .strict();
const OutboundStatsSchema = z
  .object({ rtpAudioSent: CounterSchema, daveEncryptFail: CounterSchema })
  .strict();
const TransportStatsBodySchema = z
  .object({
    uptimeMs: CounterSchema,
    tick: TickStatsSchema,
    ipcLanes: IpcLaneStatsSchema,
    inboundAudio: InboundAudioStatsSchema.optional(),
    outbound: OutboundStatsSchema,
  })
  .strict();

export const ClankVoxTransportStatsSchema = z
  .object({ ...EnvelopeShape, type: z.literal("transport_stats"), ...TransportStatsBodySchema.shape })
  .strict();
export type ClankVoxTransportStats = z.infer<typeof ClankVoxTransportStatsSchema>;

export const ClankVoxHealthSnapshotSchema = z
  .object({
    ...EnvelopeShape,
    type: z.literal("health_snapshot"),
    status: z.enum(["starting", "ready", "degraded", "closed"]),
    sessionState: SessionStateValueSchema,
    daveState: DaveStateSchema,
    transportStats: TransportStatsBodySchema.optional(),
  })
  .strict();
export type ClankVoxHealthSnapshot = z.infer<typeof ClankVoxHealthSnapshotSchema>;

const StructuredLogFieldsSchema = z.record(z.string(), z.unknown()).superRefine((fields, context) => {
  const violation = logFieldsViolation(fields);
  if (violation) context.addIssue({ code: "custom", message: violation });
});

export const ClankVoxLogSchema = z
  .object({
    ...EnvelopeShape,
    type: z.literal("log"),
    level: z.enum(["info", "warn", "error"]),
    target: NonEmptyStringSchema.max(256),
    message: NonEmptyStringSchema.max(16_384),
    fields: StructuredLogFieldsSchema,
  })
  .strict();
export type ClankVoxLog = z.infer<typeof ClankVoxLogSchema>;

export const ClankVoxErrorSchema = z
  .object({
    ...EnvelopeShape,
    type: z.literal("error"),
    code: z.enum([
      "invalid_request",
      "invalid_json",
      "input_too_large",
      "incompatible_schema",
      "voice_connect_failed",
      "voice_runtime_error",
    ]),
    message: NonEmptyStringSchema.max(16_384),
  })
  .strict();
export type ClankVoxError = z.infer<typeof ClankVoxErrorSchema>;

export const ClankVoxControlEventSchema = z.discriminatedUnion("type", [
  ClankVoxProcessReadySchema,
  ClankVoxSessionStateSchema,
  ClankVoxSpeakingStartSchema,
  ClankVoxSpeakingEndSchema,
  ClankVoxUserAudioEndSchema,
  ClankVoxErrorSchema,
]);
export type ClankVoxControlEvent = z.infer<typeof ClankVoxControlEventSchema>;
export const ClankVoxHealthEventSchema = z.discriminatedUnion("type", [
  ClankVoxTransportStatsSchema,
  ClankVoxHealthSnapshotSchema,
]);
export type ClankVoxHealthEvent = z.infer<typeof ClankVoxHealthEventSchema>;
export const ClankVoxJsonEventSchema = z.discriminatedUnion("type", [
  ...ClankVoxControlEventSchema.options,
  ...ClankVoxHealthEventSchema.options,
  ClankVoxLogSchema,
]);
export type ClankVoxJsonEvent = z.infer<typeof ClankVoxJsonEventSchema>;

export interface ClankVoxRawFrame {
  lane: ClankVoxLane;
  payload: Buffer;
}

export interface ClankVoxUserAudioFrame {
  userId: bigint;
  signalPeakAbs: number;
  signalActiveSampleCount: number;
  signalSampleCount: number;
  pcm: Buffer;
}

export function createClankVoxAudioCommand(input: ClankVoxAudioInput): ClankVoxAudio {
  SampleRateSchema.parse(input.sampleRate);
  if ("pcm" in input && input.pcm.byteLength % 2 !== 0) {
    throw new Error("ClankVox audio PCM must contain whole s16le samples");
  }
  const pcmBase64 = "pcm" in input ? Buffer.from(input.pcm).toString("base64") : input.pcmBase64;
  return ClankVoxAudioSchema.parse({
    schemaVersion: CLANKVOX_IPC_SCHEMA_VERSION,
    type: "audio",
    encoding: "pcm_s16le_base64",
    pcmBase64,
    sampleRate: input.sampleRate,
  });
}

export function encodeClankVoxCommand(command: ClankVoxCommand): Buffer {
  const candidate = encodeCommandLine(command);
  assertCommandLineCap(candidate);
  const parsed = ClankVoxCommandSchema.parse(command);
  const encoded = encodeCommandLine(parsed);
  assertCommandLineCap(encoded);
  return encoded;
}

export function parseClankVoxJsonEvent(lane: ClankVoxLane, payload: Uint8Array): ClankVoxJsonEvent {
  if (lane === ClankVoxLane.userAudio) {
    throw new Error("user_audio is binary and must be decoded with decodeClankVoxUserAudio");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch (error) {
    throw new Error("ClankVox JSON frame is malformed", { cause: error });
  }
  if (!isRecord(value) || value.schemaVersion !== CLANKVOX_IPC_SCHEMA_VERSION) {
    throw new Error("ClankVox JSON frame has an incompatible schemaVersion");
  }
  if (typeof value.type !== "string") throw new Error("ClankVox JSON frame is missing type");

  const expectedLane = laneForJsonType(value.type);
  if (expectedLane !== lane) {
    throw new Error(`ClankVox ${value.type} event arrived on lane ${lane}, expected ${expectedLane}`);
  }
  try {
    return ClankVoxJsonEventSchema.parse(value);
  } catch (error) {
    throw new Error(`ClankVox ${value.type} event payload is invalid`, { cause: error });
  }
}

export function decodeClankVoxUserAudio(payload: Uint8Array): ClankVoxUserAudioFrame {
  const buffer = Buffer.from(payload);
  if (buffer.byteLength < CLANKVOX_USER_AUDIO_HEADER_BYTES) {
    throw new Error(
      `ClankVox user_audio payload is ${buffer.byteLength} bytes; header requires ${CLANKVOX_USER_AUDIO_HEADER_BYTES}`,
    );
  }
  const pcm = buffer.subarray(CLANKVOX_USER_AUDIO_HEADER_BYTES);
  if (pcm.byteLength % 2 !== 0) throw new Error("ClankVox user_audio PCM must contain whole s16le samples");
  const signalPeakAbs = buffer.readUInt16LE(8);
  const signalActiveSampleCount = buffer.readUInt32LE(10);
  const signalSampleCount = buffer.readUInt32LE(14);
  if (signalActiveSampleCount > signalSampleCount) {
    throw new Error("ClankVox user_audio active sample count exceeds total sample count");
  }
  if (signalSampleCount !== pcm.byteLength / 2) {
    throw new Error("ClankVox user_audio total sample count does not match PCM payload");
  }
  let computedPeakAbs = 0;
  let computedActiveSampleCount = 0;
  for (let offset = 0; offset < pcm.byteLength; offset += 2) {
    const sampleAbs = Math.abs(pcm.readInt16LE(offset));
    computedPeakAbs = Math.max(computedPeakAbs, sampleAbs);
    if (sampleAbs > CLANKVOX_SIGNAL_ACTIVE_THRESHOLD) computedActiveSampleCount += 1;
  }
  if (signalPeakAbs !== computedPeakAbs) {
    throw new Error("ClankVox user_audio signal peak does not match PCM payload");
  }
  if (signalActiveSampleCount !== computedActiveSampleCount) {
    throw new Error("ClankVox user_audio active sample count does not match PCM payload");
  }
  return {
    userId: buffer.readBigUInt64LE(0),
    signalPeakAbs,
    signalActiveSampleCount,
    signalSampleCount,
    pcm,
  };
}

export class ClankVoxFrameDecoder {
  #pending = Buffer.alloc(0);
  #faulted = false;

  push(chunk: Uint8Array): ClankVoxRawFrame[] {
    if (this.#faulted) return [];
    this.#pending = Buffer.concat([this.#pending, Buffer.from(chunk)]);
    const frames: ClankVoxRawFrame[] = [];

    while (this.#pending.byteLength >= CLANKVOX_FRAME_HEADER_BYTES) {
      const lane = this.#pending.readUInt8(0);
      if (!isLane(lane)) return this.#fail(`unknown lane ${lane}`);
      const length = this.#pending.readUInt32LE(1);
      if (length > CLANKVOX_STDOUT_MAX_PAYLOAD_BYTES) {
        return this.#fail(`payload length ${length} exceeds cap ${CLANKVOX_STDOUT_MAX_PAYLOAD_BYTES}`);
      }
      const frameLength = CLANKVOX_FRAME_HEADER_BYTES + length;
      if (this.#pending.byteLength < frameLength) break;
      frames.push({
        lane,
        payload: this.#pending.subarray(CLANKVOX_FRAME_HEADER_BYTES, frameLength),
      });
      this.#pending = this.#pending.subarray(frameLength);
    }

    return frames;
  }

  finish(): void {
    if (this.#faulted) return;
    if (this.#pending.byteLength === 0) {
      this.#faulted = true;
      return;
    }
    if (this.#pending.byteLength < CLANKVOX_FRAME_HEADER_BYTES) {
      return this.#fail(`truncated header with ${this.#pending.byteLength} byte(s)`);
    }
    const length = this.#pending.readUInt32LE(1);
    return this.#fail(
      `truncated payload: declared ${length} byte(s), received ${this.#pending.byteLength - CLANKVOX_FRAME_HEADER_BYTES}`,
    );
  }

  #fail(message: string): never {
    this.#faulted = true;
    this.#pending = Buffer.alloc(0);
    throw new Error(`ClankVox stdout framing fault: ${message}`);
  }
}

function isCanonicalAlignedPcmBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  const firstPadding = value.indexOf("=");
  const bodyEnd = firstPadding === -1 ? value.length : firstPadding;
  const paddingLength = value.length - bodyEnd;
  if (paddingLength > 2) return false;
  for (let index = 0; index < bodyEnd; index += 1) {
    const code = value.charCodeAt(index);
    const base64Character =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (!base64Character) return false;
  }
  for (let index = bodyEnd; index < value.length; index += 1) if (value[index] !== "=") return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.byteLength > 0 && decoded.byteLength % 2 === 0 && decoded.toString("base64") === value;
}

function encodeCommandLine(command: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(command)}\n`, "utf8");
}

function assertCommandLineCap(encoded: Buffer): void {
  if (encoded.byteLength > CLANKVOX_STDIN_MAX_LINE_BYTES) {
    throw new Error(
      `ClankVox command is ${encoded.byteLength} bytes; maximum is ${CLANKVOX_STDIN_MAX_LINE_BYTES}`,
    );
  }
}

function logFieldsViolation(fields: Record<string, unknown>): string | undefined {
  let encoded: string;
  try {
    encoded = JSON.stringify(fields);
  } catch {
    return "ClankVox log fields must be JSON-serializable";
  }
  if (Buffer.byteLength(encoded, "utf8") > 65_536) {
    return "ClankVox log fields exceed the 65536-byte structured-field cap";
  }

  const stack: Array<{ value: unknown; depth: number }> = [{ value: fields, depth: 0 }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;
    if (entry.depth > 8) return "ClankVox log fields exceed the maximum nesting depth";
    if (typeof entry.value !== "object" || entry.value === null) continue;
    for (const [key, value] of Object.entries(entry.value)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (
        normalized.includes("token") ||
        normalized.includes("endpoint") ||
        normalized.includes("sessionid") ||
        normalized.includes("rawaudio") ||
        normalized.includes("pcmbase64") ||
        normalized.includes("prompt") ||
        normalized.includes("apikey") ||
        normalized.includes("password") ||
        normalized.includes("authorization") ||
        normalized.includes("cookie") ||
        normalized.includes("clientsecret") ||
        normalized.includes("credential")
      ) {
        return `ClankVox log field ${key} is forbidden by the redaction contract`;
      }
      stack.push({ value, depth: entry.depth + 1 });
    }
  }
  return undefined;
}

function laneForJsonType(type: string): ClankVoxLane {
  switch (type) {
    case "process_ready":
    case "session_state":
    case "speaking_start":
    case "speaking_end":
    case "user_audio_end":
    case "error":
      return ClankVoxLane.control;
    case "log":
      return ClankVoxLane.log;
    case "transport_stats":
    case "health_snapshot":
      return ClankVoxLane.health;
    default:
      throw new Error(`unsupported ClankVox event type ${type}`);
  }
}

function isLane(value: number): value is ClankVoxLane {
  return Object.values(ClankVoxLane).includes(value as ClankVoxLane);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
