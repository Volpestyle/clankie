import { describe, expect, it } from "vitest";
import {
  discordPcmToSpeechPcm,
  encodeMonoPcmWav,
  openAiPcmToDiscordPcm,
  pcmDurationMs,
} from "../src/voice-audio.ts";

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

  it("resamples 24 kHz mono PCM into 48 kHz stereo PCM in memory", () => {
    const source = Buffer.alloc(4);
    source.writeInt16LE(1_000, 0);
    source.writeInt16LE(3_000, 2);
    const output = openAiPcmToDiscordPcm(source);
    expect([...new Int16Array(output.buffer, output.byteOffset, output.byteLength / 2)]).toEqual([
      1_000, 1_000, 2_000, 2_000, 3_000, 3_000, 3_000, 3_000,
    ]);
    expect(pcmDurationMs(output, 48_000, 2)).toBe(pcmDurationMs(source, 24_000, 1));
  });

  it("rejects partial samples and invalid PCM formats", () => {
    expect(() => encodeMonoPcmWav(Buffer.from([1]))).toThrow("whole s16le");
    expect(() => pcmDurationMs(Buffer.alloc(2), 0, 1)).toThrow("format is invalid");
  });
});
