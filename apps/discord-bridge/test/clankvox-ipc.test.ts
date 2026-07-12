import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  CLANKVOX_FRAME_HEADER_BYTES,
  CLANKVOX_IPC_SCHEMA_VERSION,
  CLANKVOX_STDOUT_MAX_PAYLOAD_BYTES,
  CLANKVOX_USER_AUDIO_HEADER_BYTES,
  ClankVoxFrameDecoder,
  ClankVoxLane,
  createClankVoxAudioCommand,
  decodeClankVoxUserAudio,
  encodeClankVoxCommand,
  parseClankVoxJsonEvent,
  type ClankVoxAudio,
  type ClankVoxHealthRequest,
  type ClankVoxLane as ClankVoxLaneValue,
  type ClankVoxSessionClose,
  type ClankVoxSessionOpen,
} from "../src/clankvox-ipc.js";

interface GoldenFixture {
  commands: {
    sessionOpen: ClankVoxSessionOpen;
    audio: ClankVoxAudio;
    healthRequest: ClankVoxHealthRequest;
    sessionClose: ClankVoxSessionClose;
  };
  events: Record<string, Record<string, unknown>>;
  userAudio: { lane: number; payloadHex: string };
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/clankvox-ipc-v1.json", import.meta.url)), "utf8"),
) as GoldenFixture;

function frame(lane: number, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(CLANKVOX_FRAME_HEADER_BYTES);
  header.writeUInt8(lane, 0);
  header.writeUInt32LE(payload.byteLength, 1);
  return Buffer.concat([header, Buffer.from(payload)]);
}

function userAudioPayload(
  samples: readonly number[],
  signalPeakAbs: number,
  signalActiveSampleCount: number,
  signalSampleCount = samples.length,
): Buffer {
  const payload = Buffer.alloc(CLANKVOX_USER_AUDIO_HEADER_BYTES + samples.length * 2);
  payload.writeBigUInt64LE(42n, 0);
  payload.writeUInt16LE(signalPeakAbs, 8);
  payload.writeUInt32LE(signalActiveSampleCount, 10);
  payload.writeUInt32LE(signalSampleCount, 14);
  samples.forEach((sample, index) =>
    payload.writeInt16LE(sample, CLANKVOX_USER_AUDIO_HEADER_BYTES + index * 2),
  );
  return payload;
}

describe("ClankVox IPC v1", () => {
  test("golden commands encode as capped NDJSON with schemaVersion 1", () => {
    for (const command of Object.values(fixture.commands)) {
      const encoded = encodeClankVoxCommand(command);
      expect(encoded.at(-1)).toBe(0x0a);
      expect(JSON.parse(encoded.toString("utf8"))).toEqual(command);
      expect(command.schemaVersion).toBe(CLANKVOX_IPC_SCHEMA_VERSION);
    }
  });

  test("binary audio input lowers to base64 on the NDJSON wire", () => {
    expect(
      createClankVoxAudioCommand({
        sampleRate: 24_000,
        pcm: Buffer.from([1, 0, 255, 255]),
      }),
    ).toEqual(fixture.commands.audio);
    expect(() => createClankVoxAudioCommand({ sampleRate: 24_000, pcm: Buffer.from([1]) })).toThrow(
      "whole s16le samples",
    );
  });

  test("oversized NDJSON is rejected before writing stdin", () => {
    expect(() =>
      encodeClankVoxCommand({
        ...fixture.commands.audio!,
        type: "audio",
        pcmBase64: "A".repeat(8 * 1024 * 1024),
      }),
    ).toThrow("maximum is 8388608");
  });

  test("stdout decoder handles arbitrary chunking and multiple lanes", () => {
    const ready = Buffer.from(JSON.stringify(fixture.events.processReady));
    const stats = Buffer.from(JSON.stringify(fixture.events.transportStats));
    const combined = Buffer.concat([frame(ClankVoxLane.control, ready), frame(ClankVoxLane.health, stats)]);
    const decoder = new ClankVoxFrameDecoder();

    expect(decoder.push(combined.subarray(0, 3))).toEqual([]);
    expect(decoder.push(combined.subarray(3, 11))).toEqual([]);
    const decoded = decoder.push(combined.subarray(11));

    expect(decoded).toHaveLength(2);
    expect(parseClankVoxJsonEvent(decoded[0]!.lane, decoded[0]!.payload)).toEqual(
      fixture.events.processReady,
    );
    expect(parseClankVoxJsonEvent(decoded[1]!.lane, decoded[1]!.payload)).toEqual(
      fixture.events.transportStats,
    );
  });

  test("user_audio preserves the v1 18-byte little-endian header", () => {
    expect(fixture.userAudio.lane).toBe(ClankVoxLane.userAudio);
    const decoded = decodeClankVoxUserAudio(Buffer.from(fixture.userAudio.payloadHex, "hex"));

    expect(decoded.userId).toBe(42n);
    expect(decoded.signalPeakAbs).toBe(1_027);
    expect(decoded.signalActiveSampleCount).toBe(2);
    expect(decoded.signalSampleCount).toBe(2);
    expect(decoded.pcm).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  test("framing faults fail closed before allocating oversized payloads", () => {
    const header = Buffer.alloc(CLANKVOX_FRAME_HEADER_BYTES);
    header.writeUInt8(ClankVoxLane.control, 0);
    header.writeUInt32LE(CLANKVOX_STDOUT_MAX_PAYLOAD_BYTES + 1, 1);
    const decoder = new ClankVoxFrameDecoder();

    expect(() => decoder.push(header)).toThrow("exceeds cap");
    expect(decoder.push(frame(ClankVoxLane.control, Buffer.from("{}")))).toEqual([]);
  });

  test("JSON events fail closed on wrong schema or lane", () => {
    expect(() =>
      parseClankVoxJsonEvent(
        ClankVoxLane.control,
        Buffer.from(JSON.stringify({ schemaVersion: 2, type: "process_ready" })),
      ),
    ).toThrow("incompatible schemaVersion");
    expect(() =>
      parseClankVoxJsonEvent(
        ClankVoxLane.control,
        Buffer.from(JSON.stringify(fixture.events.transportStats)),
      ),
    ).toThrow("expected 3");
    expect(() =>
      parseClankVoxJsonEvent(
        ClankVoxLane.control,
        Buffer.from(JSON.stringify({ schemaVersion: 1, type: "future_event" })),
      ),
    ).toThrow("unsupported ClankVox event type");
  });

  test("accepts every strict schema-1 JSON event on its declared lane", () => {
    const events: Array<[lane: ClankVoxLaneValue, event: Record<string, unknown>]> = [
      [ClankVoxLane.control, fixture.events.processReady!],
      [ClankVoxLane.control, fixture.events.sessionReady!],
      [ClankVoxLane.control, fixture.events.speakingStart!],
      [ClankVoxLane.control, { schemaVersion: 1, type: "speaking_end", userId: "42" }],
      [ClankVoxLane.control, { schemaVersion: 1, type: "user_audio_end", userId: "42" }],
      [ClankVoxLane.control, { schemaVersion: 1, type: "error", code: "invalid_request", message: "MARKER" }],
      [ClankVoxLane.health, fixture.events.transportStats!],
      [
        ClankVoxLane.health,
        {
          schemaVersion: 1,
          type: "health_snapshot",
          status: "ready",
          sessionState: "ready",
          daveState: "ready",
        },
      ],
      [
        ClankVoxLane.log,
        {
          schemaVersion: 1,
          type: "log",
          level: "info",
          target: "ipc",
          message: "MARKER",
          fields: { count: 1 },
        },
      ],
    ];

    for (const [lane, event] of events) {
      expect(parseClankVoxJsonEvent(lane, Buffer.from(JSON.stringify(event)))).toEqual(event);
    }
  });

  test("strict command schemas reject unknown keys, versions, field types, and malformed PCM", () => {
    expect(() =>
      encodeClankVoxCommand({
        schemaVersion: 1,
        type: "health_request",
        extra: "MARKER",
      } as never),
    ).toThrow();
    expect(() => encodeClankVoxCommand({ schemaVersion: 2, type: "health_request" } as never)).toThrow();
    expect(() =>
      encodeClankVoxCommand({
        ...fixture.commands.sessionOpen,
        token: 7,
      } as never),
    ).toThrow();
    expect(() => encodeClankVoxCommand({ ...fixture.commands.audio, pcmBase64: "AQ==" })).toThrow();
    expect(() => createClankVoxAudioCommand({ sampleRate: 24_000, pcmBase64: "AQ==" })).toThrow();
    expect(() => createClankVoxAudioCommand({ sampleRate: 24_000, pcmBase64: "AQI" })).toThrow();
    expect(createClankVoxAudioCommand({ sampleRate: 24_000, pcmBase64: "AQI=" }).pcmBase64).toBe("AQI=");
  });

  test("Discord ids stay within the unsigned 64-bit domain without number coercion", () => {
    expect(() =>
      encodeClankVoxCommand({
        ...fixture.commands.sessionOpen,
        daveChannelId: "18446744073709551615",
      }),
    ).not.toThrow();
    expect(() =>
      encodeClankVoxCommand({
        ...fixture.commands.sessionOpen,
        daveChannelId: "18446744073709551616",
      }),
    ).toThrow("Discord ids must fit in an unsigned 64-bit integer");
  });

  test("strict event schemas reject malformed known events, numeric bounds, extras, and sensitive logs", () => {
    const invalid: Array<[lane: ClankVoxLaneValue, event: Record<string, unknown>]> = [
      [ClankVoxLane.control, { schemaVersion: 1, type: "session_state" }],
      [ClankVoxLane.control, { schemaVersion: 1, type: "speaking_start", userId: 42 }],
      [ClankVoxLane.health, { schemaVersion: 1, type: "transport_stats", uptimeMs: -0.5 }],
      [ClankVoxLane.health, { ...fixture.events.transportStats!, uptimeMs: 0.5 }],
      [ClankVoxLane.control, { schemaVersion: 1, type: "process_ready", extra: "MARKER" }],
      [
        ClankVoxLane.log,
        {
          schemaVersion: 1,
          type: "log",
          level: "info",
          target: "ipc",
          message: "MARKER",
          fields: { voiceToken: "MARKER" },
        },
      ],
    ];

    for (const [lane, event] of invalid) {
      expect(() => parseClankVoxJsonEvent(lane, Buffer.from(JSON.stringify(event)))).toThrow(
        "payload is invalid",
      );
    }
  });

  test("rejects normalized secret-bearing structured log keys", () => {
    const secretKeys = [
      "apiKey",
      "password",
      "authorization",
      "cookie",
      "clientSecret",
      "credential",
      "client-secret",
    ];

    for (const key of secretKeys) {
      const event = {
        schemaVersion: 1,
        type: "log",
        level: "info",
        target: "ipc",
        message: "MARKER",
        fields: { nested: { [key]: "MARKER" } },
      };
      expect(() => parseClankVoxJsonEvent(ClankVoxLane.log, Buffer.from(JSON.stringify(event)))).toThrow(
        "payload is invalid",
      );
    }
  });

  test("rejects malformed UTF-8 instead of replacement-decoding it", () => {
    const prefix = Buffer.from('{"schemaVersion":1,"type":"log","level":"info","target":"ipc","message":"');
    const suffix = Buffer.from('","fields":{}}');
    expect(() =>
      parseClankVoxJsonEvent(ClankVoxLane.log, Buffer.concat([prefix, Buffer.from([0xff]), suffix])),
    ).toThrow("JSON frame is malformed");
  });

  test("finalizes clean framing and rejects truncated headers and payloads at EOF", () => {
    const clean = new ClankVoxFrameDecoder();
    expect(clean.push(frame(ClankVoxLane.control, Buffer.from("{}")))).toHaveLength(1);
    expect(() => clean.finish()).not.toThrow();
    expect(clean.push(frame(ClankVoxLane.control, Buffer.from("{}")))).toEqual([]);

    const header = new ClankVoxFrameDecoder();
    expect(header.push(Buffer.from([ClankVoxLane.control, 1]))).toEqual([]);
    expect(() => header.finish()).toThrow("truncated header");

    const payload = new ClankVoxFrameDecoder();
    const partial = Buffer.alloc(6);
    partial.writeUInt8(ClankVoxLane.control, 0);
    partial.writeUInt32LE(3, 1);
    partial.writeUInt8(0x7b, 5);
    expect(payload.push(partial)).toEqual([]);
    expect(() => payload.finish()).toThrow("declared 3 byte(s), received 1");
  });

  test("rejects inconsistent user_audio signal counters", () => {
    const payload = Buffer.alloc(18);
    payload.writeBigUInt64LE(42n, 0);
    payload.writeUInt16LE(7, 8);
    payload.writeUInt32LE(2, 10);
    payload.writeUInt32LE(1, 14);
    expect(() => decodeClankVoxUserAudio(payload)).toThrow("active sample count exceeds");

    const mismatchedPcm = Buffer.alloc(22);
    mismatchedPcm.writeBigUInt64LE(42n, 0);
    mismatchedPcm.writeUInt16LE(7, 8);
    mismatchedPcm.writeUInt32LE(1, 10);
    mismatchedPcm.writeUInt32LE(99, 14);
    expect(() => decodeClankVoxUserAudio(mismatchedPcm)).toThrow("does not match PCM payload");
  });

  for (const [name, samples, peak, active] of [
    ["empty nonzero peak", [], 1, 0],
    ["silent PCM wrong peak", [0, 0], 1, 0],
    ["signal wrong peak", [100, 600, -700], 699, 2],
    ["signal wrong active count", [100, 600, -700], 700, 1],
    ["active PCM zero peak", [600], 0, 1],
  ] satisfies Array<[string, number[], number, number]>) {
    test(`rejects inconsistent user_audio signal metadata: ${name}`, () => {
      expect(() => decodeClankVoxUserAudio(userAudioPayload(samples, peak, active))).toThrow(
        "does not match PCM payload",
      );
    });
  }

  test("computes unsigned absolute signal metadata for the i16 minimum", () => {
    const decoded = decodeClankVoxUserAudio(userAudioPayload([-32_768, -500, 501], 32_768, 2));

    expect(decoded.signalPeakAbs).toBe(32_768);
    expect(decoded.signalActiveSampleCount).toBe(2);
  });
});
