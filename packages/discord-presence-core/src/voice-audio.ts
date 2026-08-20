import { Buffer } from "node:buffer";

export const DISCORD_VOICE_SAMPLE_RATE = 48_000;
export const DISCORD_VOICE_CHANNELS = 2;
export const SPEECH_SAMPLE_RATE = 16_000;
export const OPENAI_TTS_SAMPLE_RATE = 24_000;
export const PCM_SAMPLE_BYTES = 2;

/** Converts interleaved 48 kHz stereo s16le into 16 kHz mono s16le for speech recognition. */
export function discordPcmToSpeechPcm(input: Uint8Array): Buffer {
  const source = Buffer.from(input);
  const frameBytes = PCM_SAMPLE_BYTES * DISCORD_VOICE_CHANNELS;
  const sourceFrames = Math.floor(source.byteLength / frameBytes);
  const outputFrames = Math.floor(sourceFrames / 3);
  const output = Buffer.allocUnsafe(outputFrames * PCM_SAMPLE_BYTES);
  for (let outputFrame = 0; outputFrame < outputFrames; outputFrame += 1) {
    const sourceOffset = outputFrame * 3 * frameBytes;
    const left = source.readInt16LE(sourceOffset);
    const right = source.readInt16LE(sourceOffset + PCM_SAMPLE_BYTES);
    output.writeInt16LE(Math.trunc((left + right) / 2), outputFrame * PCM_SAMPLE_BYTES);
  }
  return output;
}

/** Wraps mono s16le samples in the canonical PCM WAV container accepted by whisper.cpp. */
export function encodeMonoPcmWav(pcmInput: Uint8Array, sampleRate = SPEECH_SAMPLE_RATE): Buffer {
  const pcm = Buffer.from(pcmInput);
  if (pcm.byteLength % PCM_SAMPLE_BYTES !== 0) {
    throw new Error("Voice PCM must contain whole s16le samples");
  }
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 48_000) {
    throw new Error("Voice PCM sample rate is invalid");
  }
  const wav = Buffer.allocUnsafe(44 + pcm.byteLength);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + pcm.byteLength, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * PCM_SAMPLE_BYTES, 28);
  wav.writeUInt16LE(PCM_SAMPLE_BYTES, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(pcm.byteLength, 40);
  pcm.copy(wav, 44);
  return wav;
}

/**
 * Root-mean-square amplitude of s16le PCM, in raw sample units (full scale
 * 32_768). Channel layout does not matter — every sample weighs the same — so
 * this reads interleaved capture audio as-is, without a downmix.
 *
 * This is the only thing that separates a room from a sentence. Duration
 * cannot: an open mic streams fans, keystrokes, and breath continuously, and
 * all of it clears any duration bar.
 */
export function pcmRms(input: Uint8Array): number {
  // A view, not a copy: this runs on every decoded capture chunk.
  const source = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const samples = Math.floor(source.byteLength / PCM_SAMPLE_BYTES);
  if (samples === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples; index += 1) {
    const sample = source.readInt16LE(index * PCM_SAMPLE_BYTES);
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}

export function pcmDurationMs(pcm: Uint8Array, sampleRate: number, channels: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(channels) || channels <= 0) {
    throw new Error("Voice PCM format is invalid");
  }
  return (pcm.byteLength / (PCM_SAMPLE_BYTES * sampleRate * channels)) * 1_000;
}
