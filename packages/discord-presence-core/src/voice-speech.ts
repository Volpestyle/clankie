import { encodeMonoPcmWav, SPEECH_SAMPLE_RATE } from "./voice-audio.ts";

const DEFAULT_STT_MODEL = "gpt-4o-mini-transcribe";
const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
const DEFAULT_TTS_VOICE = "marin";
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_SPEECH_TEXT_CHARACTERS = 2_000;
const MAX_TRANSCRIPTION_RESPONSE_BYTES = 64 * 1_024;
const MAX_TTS_PCM_BYTES = 24_000 * 2 * 60;

export interface VoiceSpeechReadiness {
  readonly ready: boolean;
  readonly provider: "openai";
  readonly sttModel: string;
  readonly ttsModel: string;
  readonly voice: string;
  readonly responseFormat: "pcm";
}

export interface SynthesizedVoiceAudio {
  /** Raw 24 kHz mono signed 16-bit little-endian PCM. */
  readonly pcm24KhzMono: Buffer;
}

export interface VoiceSpeechRuntime {
  readiness(): Promise<VoiceSpeechReadiness>;
  transcribe(pcm16KhzMono: Uint8Array): Promise<string | undefined>;
  synthesize(text: string): Promise<SynthesizedVoiceAudio>;
}

export interface OpenAiVoiceSpeechRuntimeOptions {
  /** Broker-resolved API key. It must never be persisted or logged by this runtime. */
  readonly apiKey: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
  readonly sttModel?: string;
  readonly ttsModel?: string;
  readonly voice?: string;
  readonly requestTimeoutMs?: number;
}

/**
 * Memory-only OpenAI speech boundary. Raw audio is sent directly from memory,
 * responses are size bounded, and neither raw PCM nor transcripts touch disk.
 */
export class OpenAiVoiceSpeechRuntime implements VoiceSpeechRuntime {
  private readonly apiKey: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly sttModel: string;
  private readonly ttsModel: string;
  private readonly voice: string;
  private readonly requestTimeoutMs: number;

  public constructor(options: OpenAiVoiceSpeechRuntimeOptions) {
    this.apiKey = nonEmpty(options.apiKey, "OpenAI API key");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://api.openai.com/v1");
    this.sttModel = nonEmpty(options.sttModel ?? DEFAULT_STT_MODEL, "OpenAI STT model");
    this.ttsModel = nonEmpty(options.ttsModel ?? DEFAULT_TTS_MODEL, "OpenAI TTS model");
    this.voice = nonEmpty(options.voice ?? DEFAULT_TTS_VOICE, "OpenAI TTS voice");
    this.requestTimeoutMs = boundedTimeout(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  }

  public readiness(): Promise<VoiceSpeechReadiness> {
    return Promise.resolve({
      ready: true,
      provider: "openai",
      sttModel: this.sttModel,
      ttsModel: this.ttsModel,
      voice: this.voice,
      responseFormat: "pcm",
    });
  }

  public async transcribe(pcm16KhzMono: Uint8Array): Promise<string | undefined> {
    if (pcm16KhzMono.byteLength === 0) return undefined;
    const wav = encodeMonoPcmWav(pcm16KhzMono, SPEECH_SAMPLE_RATE);
    const form = new FormData();
    form.set("model", this.sttModel);
    form.set("response_format", "json");
    form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "utterance.wav");
    try {
      const body = await this.requestBytes(
        "/audio/transcriptions",
        {
          method: "POST",
          body: form,
        },
        MAX_TRANSCRIPTION_RESPONSE_BYTES,
      );
      const parsed = parseTranscription(body);
      return parsed.length === 0 ? undefined : parsed.slice(0, MAX_SPEECH_TEXT_CHARACTERS);
    } finally {
      wav.fill(0);
    }
  }

  public async synthesize(textInput: string): Promise<SynthesizedVoiceAudio> {
    const text = normalizeSpeechText(textInput);
    if (text.length === 0) throw new Error("Voice response text is empty");
    const pcm24KhzMono = await this.requestBytes(
      "/audio/speech",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.ttsModel,
          voice: this.voice,
          input: text,
          response_format: "pcm",
        }),
      },
      MAX_TTS_PCM_BYTES,
    );
    if (pcm24KhzMono.byteLength === 0 || pcm24KhzMono.byteLength % 2 !== 0) {
      pcm24KhzMono.fill(0);
      throw new Error("OpenAI speech response did not contain whole PCM samples");
    }
    return { pcm24KhzMono };
  }

  private async requestBytes(path: string, init: RequestInit, maximumBytes: number): Promise<Buffer> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetch(new URL(path.replace(/^\/+/u, ""), `${this.baseUrl}/`), {
        ...init,
        signal: controller.signal,
        headers: {
          ...init.headers,
          authorization: `Bearer ${this.apiKey}`,
        },
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`OpenAI speech request failed with status ${response.status.toString()}`);
      }
      return await readBounded(response, maximumBytes);
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readBounded(response: Response, maximumBytes: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("OpenAI speech response exceeded the configured byte limit");
  }
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maximumBytes) {
        throw new Error("OpenAI speech response exceeded the configured byte limit");
      }
      chunks.push(Buffer.from(result.value));
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseTranscription(body: Buffer): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("OpenAI transcription response was not valid JSON");
  } finally {
    body.fill(0);
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>).text !== "string"
  ) {
    throw new Error("OpenAI transcription response did not contain text");
  }
  return normalizeSpeechText((parsed as { text: string }).text);
}

function normalizeSpeechText(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim().slice(0, MAX_SPEECH_TEXT_CHARACTERS);
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !isLoopback(url)) {
    throw new Error("OpenAI speech base URL must use HTTPS unless it is loopback");
  }
  return url.toString().replace(/\/+$/u, "");
}

function isLoopback(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 5 * 60_000) {
    throw new Error("Voice request timeout must be between 1 second and 5 minutes");
  }
  return value;
}
