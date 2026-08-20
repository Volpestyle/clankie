import { describe, expect, it } from "vitest";
import { discordPcmToSpeechPcm, encodeMonoPcmWav, pcmDurationMs, pcmRms } from "../src/voice-audio.ts";

describe("Discord voice PCM", () => {
  it("downmixes stereo and downsamples 48 kHz to 16 kHz", () => {
    const source = Buffer.alloc(6 * 4);
    const frames = [
      [1_000, 3_000],
      [5_000, 7_000],
      [-1_000, 1_000],
      [-3_000, -1_000],
      [8_000, 10_000],
      [2_000, 4_000],
    ];
    for (const [index, frame] of frames.entries()) {
      source.writeInt16LE(frame[0]!, index * 4);
      source.writeInt16LE(frame[1]!, index * 4 + 2);
    }
    const output = discordPcmToSpeechPcm(source);
    expect([...new Int16Array(output.buffer, output.byteOffset, output.byteLength / 2)]).toEqual([
      2_000, -2_000,
    ]);
    expect(pcmDurationMs(output, 16_000, 1)).toBe(0.125);
  });

  it("writes a canonical mono PCM WAV header", () => {
    const wav = encodeMonoPcmWav(Buffer.from([1, 0, 2, 0]));
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt32LE(40)).toBe(4);
    expect(wav.subarray(44)).toEqual(Buffer.from([1, 0, 2, 0]));
  });

  it("rejects partial samples and invalid PCM formats", () => {
    expect(() => encodeMonoPcmWav(Buffer.from([1]))).toThrow("whole s16le");
    expect(() => pcmDurationMs(Buffer.alloc(2), 0, 1)).toThrow("format is invalid");
  });
});

describe("PCM loudness", () => {
  function level(samples: number, value: number): Buffer {
    const buffer = Buffer.alloc(samples * 2);
    for (let index = 0; index < samples; index += 1) buffer.writeInt16LE(value, index * 2);
    return buffer;
  }

  it("measures amplitude in raw s16 units and ignores sign", () => {
    expect(pcmRms(level(64, 4_000))).toBeCloseTo(4_000, 6);
    expect(pcmRms(level(64, -4_000))).toBeCloseTo(4_000, 6);
    expect(pcmRms(Buffer.alloc(0))).toBe(0);
    expect(pcmRms(Buffer.alloc(64))).toBe(0);
  });

  it("separates room tone from speech, which byte count alone cannot", () => {
    // The live failure: 350 ms of either clears any duration bar, but only one
    // of them is somebody talking.
    expect(pcmRms(level(16_800, 257))).toBeLessThan(1_200);
    expect(pcmRms(level(16_800, 4_112))).toBeGreaterThan(1_200);
  });

  it("reads a subarray view without spilling into neighbouring bytes", () => {
    const backing = Buffer.concat([level(16, 9_000), level(16, 100)]);
    expect(pcmRms(backing.subarray(32))).toBeCloseTo(100, 6);
  });
});
