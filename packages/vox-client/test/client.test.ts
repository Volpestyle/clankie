import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  VoxFrameDecoder,
  decodeVoxControlEvent,
  decodeVoxUserAudio,
  decodeVoxVideoFrame,
  resolveVoxBin,
  sanitizeVoxLog,
} from "../src/index.ts";

function framed(format: number, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(format, 0);
  header.writeUInt32LE(payload.byteLength, 1);
  return Buffer.concat([header, payload]);
}

describe("Vox client framing", () => {
  it("reassembles split control frames", () => {
    const payload = Buffer.from(JSON.stringify({ type: "process_ready" }));
    const input = framed(0, payload);
    const decoder = new VoxFrameDecoder();

    expect(decoder.push(input.subarray(0, 3)).frames).toEqual([]);
    const result = decoder.push(input.subarray(3));

    expect(result.fault).toBeUndefined();
    expect(decodeVoxControlEvent(result.frames[0]!.payload)).toEqual({ type: "process_ready" });
  });

  it("decodes video and binary user-audio events", () => {
    const video = decodeVoxVideoFrame({
      type: "decoded_video_frame",
      userId: "42",
      width: 1920,
      height: 1080,
      jpegBase64: "anBlZw==",
    });
    expect(video).toEqual({
      userId: "42",
      width: 1920,
      height: 1080,
      jpegBase64: "anBlZw==",
    });

    const audio = Buffer.alloc(22);
    audio.writeBigUInt64LE(42n, 0);
    audio.writeUInt16LE(700, 8);
    audio.writeUInt32LE(1, 10);
    audio.writeUInt32LE(2, 14);
    audio.set([1, 2, 3, 4], 18);
    expect(decodeVoxUserAudio(audio)).toEqual({
      userId: "42",
      signalPeakAbs: 700,
      signalActiveSampleCount: 1,
      signalSampleCount: 2,
      pcm: Buffer.from([1, 2, 3, 4]),
    });

    audio.writeUInt32LE(3, 14);
    expect(decodeVoxUserAudio(audio)).toBeUndefined();
  });

  it("resolves an owned candidate without requiring environment configuration", () => {
    expect(resolveVoxBin({}, [process.execPath])).toBe(process.execPath);
  });

  it("redacts transport credentials and signed URLs from child diagnostics", () => {
    expect(
      sanitizeVoxLog(
        'endpoint="stream.discord.gg" session_id=abc token: secret url=https://cdn.example/a?sig=secret connected=true',
      ),
    ).toBe("endpoint=[redacted] session_id=[redacted] token: [redacted] url=[redacted-url] connected=true");
  });
});
