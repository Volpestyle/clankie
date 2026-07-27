/**
 * The ElevenLabs streaming-TTS boundary for Discord voice
 * ([ADR 0070](../../../docs/adr/0070-external-voice-via-streaming-tts.md)).
 *
 * When the owner configures an external voice, the engaged realtime session
 * stops speaking and starts writing: its text deltas stream into one
 * multi-context TTS WebSocket, and the PCM that comes back feeds the same
 * playback path the realtime audio deltas fed. One context per response maps
 * onto the floor machine's one-response-at-a-time discipline — barge-in is
 * `closeContext`, which stops server-side generation instead of letting an
 * interrupted sentence finish billing.
 *
 * The discipline mirrors {@link ../realtime-session.ts}: injected transport so
 * tests are deterministic and offline, WSS-or-loopback endpoints, the API key
 * only ever in connection headers, per-context audio byte caps, per-append
 * text caps, a session lifetime cap, and PCM ownership (with its zeroing
 * duty) transferring to the caller at the callback boundary. Only Clankie's
 * own generated words ever reach this socket — room audio never does.
 */

import { Buffer } from "node:buffer";
import { PCM_SAMPLE_BYTES } from "./voice-audio.ts";
import {
  REALTIME_AUDIO_SAMPLE_RATE,
  openRealtimeWebSocket,
  type RealtimeSocket,
  type RealtimeSocketFactory,
  type RealtimeTimers,
} from "./realtime-session.ts";

/** Flash is the latency tier ElevenLabs builds for conversational use (~75 ms inference). */
const DEFAULT_ELEVENLABS_MODEL = "eleven_flash_v2_5";
const DEFAULT_ELEVENLABS_BASE_URL = "wss://api.elevenlabs.io/v1/text-to-speech";

/**
 * Pinned, never configurable: 24 kHz mono s16le is what the realtime audio
 * path already produces, so TTS output drops into the existing
 * 24k→48k playback resample with no second format seam.
 */
export const ELEVENLABS_OUTPUT_FORMAT = "pcm_24000";

/**
 * The socket closes itself after this much inactivity server-side. 180 is the
 * documented maximum; the session reopens lazily on the next utterance, so a
 * longer idle gap costs one reconnect rather than a protocol keep-alive dance
 * against a context that may not exist.
 */
const DEFAULT_INACTIVITY_TIMEOUT_SECONDS = 180;
const MIN_INACTIVITY_TIMEOUT_SECONDS = 1;
const MAX_INACTIVITY_TIMEOUT_SECONDS = 180;

/**
 * One minute of 24 kHz mono s16le per context — the same runaway-output line
 * the realtime boundary draws per response. A context is one utterance;
 * sixty seconds of it is not conversation.
 */
export const MAX_ELEVENLABS_CONTEXT_AUDIO_BYTES = REALTIME_AUDIO_SAMPLE_RATE * PCM_SAMPLE_BYTES * 60;

/**
 * Bounds one text append. Realtime text deltas are small; an append this
 * large means the caller is buffering text it should have streamed, so it
 * throws rather than silently truncating a sentence mid-word.
 */
export const MAX_ELEVENLABS_TEXT_APPEND_CHARACTERS = 8_000;

/**
 * The floor machine speaks one response at a time, and a barge-in closes the
 * old context before the next opens. Needing more than this many live
 * contexts means responses are leaking, not overlapping.
 */
export const MAX_ELEVENLABS_OPEN_CONTEXTS = 4;

/** Mirrors the realtime session-lifetime discipline: an outliving socket is a leak, not a feature. */
export const DEFAULT_ELEVENLABS_SESSION_LIFETIME_MS = 60 * 60_000;
const MIN_SESSION_LIFETIME_MS = 10_000;
const MAX_SESSION_LIFETIME_MS = 4 * 60 * 60_000;

/** Why the session ended; identical vocabulary to the realtime boundary. */
export type ElevenLabsTtsCloseReason = "closed" | "lifetime" | "socket" | "error";

/**
 * Expressive knobs, all optional. These are owner configuration read from
 * settings, never derived from channel content, for the ADR 0051 reason:
 * caller-controlled context must not redefine how Clankie sounds.
 */
export interface ElevenLabsVoiceSettings {
  readonly stability?: number;
  readonly similarityBoost?: number;
  readonly speed?: number;
}

export interface ElevenLabsTtsSessionOptions {
  /** Broker-resolved ElevenLabs key. Connection headers only — never frames, logs, or error text. */
  readonly apiKey: string;
  /** The owner-configured voice. Path-embedded, so it is validated to a safe charset. */
  readonly voiceId: string;
  readonly modelId?: string;
  readonly voiceSettings?: ElevenLabsVoiceSettings;
  /** Must be WSS unless loopback. */
  readonly baseUrl?: string;
  /** Injected transport; defaults to the same WebSocket wrapper the realtime boundary uses. */
  readonly socketFactory?: RealtimeSocketFactory;
  readonly timers?: RealtimeTimers;
  readonly maxLifetimeMs?: number;
  readonly inactivityTimeoutSeconds?: number;
  /**
   * Decoded 24 kHz mono s16le synthesized audio. Buffer ownership transfers
   * to the caller, and with it the zeroing duty once the audio is handed to
   * playback — the same contract as the realtime audio delta callback.
   */
  readonly onAudio: (pcm: Buffer, contextId: string) => void;
  /** The server finished synthesizing everything appended to this context. */
  readonly onContextDone?: (contextId: string) => void;
  readonly onClose?: (reason: ElevenLabsTtsCloseReason) => void;
  /** Sanitized, content-free messages only. */
  readonly onError?: (message: string) => void;
}

/**
 * One multi-context TTS WebSocket. Contexts are utterances: the caller opens
 * one per realtime response, streams text deltas into it, flushes it when the
 * response's text is done, and closes it early on barge-in.
 */
export class ElevenLabsTtsSession {
  private readonly socket: RealtimeSocket;
  private readonly timers: RealtimeTimers;
  private readonly lifetimeHandle: unknown;
  private readonly onAudioCallback: (pcm: Buffer, contextId: string) => void;
  private readonly onContextDoneCallback: ((contextId: string) => void) | undefined;
  private readonly onCloseCallback: ((reason: ElevenLabsTtsCloseReason) => void) | undefined;
  private readonly onErrorCallback: ((message: string) => void) | undefined;
  private readonly voiceSettings: ElevenLabsVoiceSettings | undefined;
  private readonly contextAudioBytes = new Map<string, number>();
  /**
   * Base64 chunk boundaries do not respect s16le sample alignment, and the
   * playback resampler throws on partial samples. A trailing odd byte is held
   * here and prepended to the context's next chunk, so the callback's
   * "decoded 24 kHz mono s16le" claim is true by construction.
   */
  private readonly contextCarry = new Map<string, number>();
  private closed = false;

  public constructor(socket: RealtimeSocket, options: ElevenLabsTtsSessionOptions) {
    this.socket = socket;
    this.timers = options.timers ?? globalTimers;
    this.onAudioCallback = options.onAudio;
    this.onContextDoneCallback = options.onContextDone;
    this.onCloseCallback = options.onClose;
    this.onErrorCallback = options.onError;
    this.voiceSettings = options.voiceSettings;
    socket.onMessage((data) => {
      this.receive(data);
    });
    socket.onClose(() => {
      this.closeWith("socket");
    });
    socket.onError(() => {
      // The transport error object can carry connection detail; it is never
      // inspected or forwarded, exactly as the realtime boundary treats it.
      this.onErrorCallback?.("ElevenLabs transport error");
      this.closeWith("error");
    });
    this.lifetimeHandle = this.timers.setTimeout(
      () => {
        this.closeWith("lifetime");
      },
      boundedSessionLifetime(options.maxLifetimeMs ?? DEFAULT_ELEVENLABS_SESSION_LIFETIME_MS),
    );
  }

  public get isOpen(): boolean {
    return !this.closed;
  }

  /**
   * Starts an utterance. The initial single-space text is the documented
   * context-initialization handshake, and voice settings ride along here so a
   * mid-call settings change cannot restyle an utterance already in flight.
   */
  public openContext(contextId: string): void {
    this.assertOpen();
    const id = boundedContextId(contextId);
    if (this.contextAudioBytes.has(id)) {
      throw new Error("ElevenLabs context id is already open");
    }
    if (this.contextAudioBytes.size >= MAX_ELEVENLABS_OPEN_CONTEXTS) {
      throw new Error("ElevenLabs open-context limit reached; responses are leaking contexts");
    }
    this.contextAudioBytes.set(id, 0);
    this.sendFrame({
      text: " ",
      context_id: id,
      ...(this.voiceSettings === undefined ? {} : { voice_settings: wireVoiceSettings(this.voiceSettings) }),
    });
  }

  /** Streams one text delta into an open context, verbatim — deltas can split words, and joining them is the server's job. */
  public appendText(contextId: string, text: string): void {
    this.assertOpen();
    const id = this.requireOpenContext(contextId);
    if (text.length === 0) return;
    if (text.length > MAX_ELEVENLABS_TEXT_APPEND_CHARACTERS) {
      throw new Error("ElevenLabs text append exceeded the character limit");
    }
    this.sendFrame({ text, context_id: id });
  }

  /** The response's text is complete; synthesize whatever the chunk scheduler is still holding. */
  public flush(contextId: string): void {
    this.assertOpen();
    const id = this.requireOpenContext(contextId);
    this.sendFrame({ text: " ", context_id: id, flush: true });
  }

  /**
   * Ends an utterance. On barge-in this is called before the flush would
   * have been, which stops server-side generation of speech nobody will hear.
   */
  public closeContext(contextId: string): void {
    this.assertOpen();
    const id = this.requireOpenContext(contextId);
    this.contextAudioBytes.delete(id);
    this.contextCarry.delete(id);
    this.sendFrame({ context_id: id, close_context: true });
  }

  public close(): void {
    if (this.closed) return;
    try {
      this.sendFrame({ close_socket: true });
    } catch {
      // The socket is already unusable; closeWith below still runs.
    }
    this.closeWith("closed");
  }

  private receive(data: string): void {
    if (this.closed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      this.onErrorCallback?.("ElevenLabs server sent an unparseable frame");
      return;
    }
    const event = asRecord(parsed);
    if (event === undefined) return;
    if (typeof event.error === "string" || typeof event.message === "string") {
      // ElevenLabs error frames carry prose that can echo submitted text;
      // only a short machine-readable code is ever surfaced.
      this.onErrorCallback?.(describeServerError(event));
      return;
    }
    const contextId = asString(event.contextId);
    if (contextId === undefined) return;
    if (event.isFinal === true) {
      // A dangling carry byte at the end of a context is a truncated final
      // sample nothing can play; it is dropped, not surfaced.
      this.contextCarry.delete(contextId);
      this.contextAudioBytes.delete(contextId);
      this.onContextDoneCallback?.(contextId);
      return;
    }
    const audio = asString(event.audio);
    if (audio === undefined || audio.length === 0) return;
    const tracked = this.contextAudioBytes.get(contextId);
    // Audio for a context the caller already closed is late server output;
    // dropping it here is what makes closeContext an effective barge-in.
    if (tracked === undefined) return;
    const decoded = Buffer.from(audio, "base64");
    const total = tracked + decoded.byteLength;
    if (total > MAX_ELEVENLABS_CONTEXT_AUDIO_BYTES) {
      // Fail closed like every audio byte cap in this package: zero what was
      // decoded and end the session rather than stream unbounded
      // server-controlled audio into memory.
      decoded.fill(0);
      this.onErrorCallback?.("ElevenLabs context audio exceeded the byte limit");
      this.closeWith("error");
      return;
    }
    this.contextAudioBytes.set(contextId, total);
    const pcm = this.alignToWholeSamples(contextId, decoded);
    if (pcm.byteLength === 0) return;
    this.onAudioCallback(pcm, contextId);
  }

  /** Prepends the context's carried byte (if any) and holds back a new trailing odd byte. */
  private alignToWholeSamples(contextId: string, decoded: Buffer): Buffer {
    const carried = this.contextCarry.get(contextId);
    let combined = decoded;
    if (carried !== undefined) {
      combined = Buffer.concat([Buffer.from([carried]), decoded]);
      decoded.fill(0);
      this.contextCarry.delete(contextId);
    }
    if (combined.byteLength % PCM_SAMPLE_BYTES === 0) return combined;
    const lastByte = combined[combined.byteLength - 1];
    if (lastByte !== undefined) this.contextCarry.set(contextId, lastByte);
    const aligned = Buffer.from(combined.subarray(0, combined.byteLength - 1));
    combined.fill(0);
    return aligned;
  }

  private sendFrame(frame: Record<string, unknown>): void {
    this.assertOpen();
    const raw = JSON.stringify(frame);
    try {
      this.socket.send(raw);
    } catch {
      this.closeWith("error");
      throw new Error("ElevenLabs socket send failed");
    }
  }

  private requireOpenContext(contextId: string): string {
    const id = boundedContextId(contextId);
    if (!this.contextAudioBytes.has(id)) {
      throw new Error("ElevenLabs context is not open");
    }
    return id;
  }

  private closeWith(reason: ElevenLabsTtsCloseReason): void {
    if (this.closed) return;
    this.closed = true;
    this.timers.clearTimeout(this.lifetimeHandle);
    this.contextAudioBytes.clear();
    this.contextCarry.clear();
    try {
      this.socket.close();
    } catch {
      // Already closing; the first reason wins.
    }
    this.onCloseCallback?.(reason);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("ElevenLabs session is closed");
  }
}

/** Opens the multi-context TTS session. */
export async function openElevenLabsTtsSession(
  options: ElevenLabsTtsSessionOptions,
): Promise<ElevenLabsTtsSession> {
  const url = buildElevenLabsUrl(options);
  const apiKey = nonEmpty(options.apiKey, "ElevenLabs API key");
  const factory = options.socketFactory ?? openRealtimeWebSocket;
  const socket = await factory(url, Object.freeze({ "xi-api-key": apiKey }));
  try {
    return new ElevenLabsTtsSession(socket, options);
  } catch (error) {
    try {
      socket.close();
    } catch {
      // The construction error is the one worth reporting.
    }
    throw error;
  }
}

const globalTimers: RealtimeTimers = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** WSS-or-loopback, and the voice id is charset-checked because it is embedded in the URL path. */
function buildElevenLabsUrl(options: ElevenLabsTtsSessionOptions): string {
  const voiceId = safeIdentifier(options.voiceId, "ElevenLabs voice id");
  const modelId = safeIdentifier(options.modelId ?? DEFAULT_ELEVENLABS_MODEL, "ElevenLabs model id");
  const base = (options.baseUrl ?? DEFAULT_ELEVENLABS_BASE_URL).replace(/\/+$/, "");
  const url = new URL(`${base}/${voiceId}/multi-stream-input`);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && isLoopback(url))) {
    throw new Error("ElevenLabs base URL must use WSS unless it is loopback");
  }
  url.searchParams.set("model_id", modelId);
  url.searchParams.set("output_format", ELEVENLABS_OUTPUT_FORMAT);
  // Sentence-boundary generation instead of the 120-character chunk floor:
  // short conversational replies should not wait for a buffer to fill.
  url.searchParams.set("auto_mode", "true");
  url.searchParams.set(
    "inactivity_timeout",
    boundedInactivityTimeout(
      options.inactivityTimeoutSeconds ?? DEFAULT_INACTIVITY_TIMEOUT_SECONDS,
    ).toString(),
  );
  return url.toString();
}

function isLoopback(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
}

function wireVoiceSettings(settings: ElevenLabsVoiceSettings): Record<string, number> {
  const wire: Record<string, number> = {};
  if (settings.stability !== undefined)
    wire.stability = boundedUnit(settings.stability, "ElevenLabs stability");
  if (settings.similarityBoost !== undefined) {
    wire.similarity_boost = boundedUnit(settings.similarityBoost, "ElevenLabs similarity boost");
  }
  if (settings.speed !== undefined) {
    if (!Number.isFinite(settings.speed) || settings.speed < 0.7 || settings.speed > 1.2) {
      throw new Error("ElevenLabs speed must be within [0.7, 1.2]");
    }
    wire.speed = settings.speed;
  }
  return wire;
}

function describeServerError(event: Record<string, unknown>): string {
  const code = asString(event.error);
  // Codes are short identifiers; anything longer is prose and stays behind
  // this boundary.
  if (code !== undefined && code.length <= 64 && /^[\w-]+$/.test(code)) {
    return `ElevenLabs session error (${code})`;
  }
  return "ElevenLabs session error";
}

function boundedSessionLifetime(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_SESSION_LIFETIME_MS || value > MAX_SESSION_LIFETIME_MS) {
    throw new Error("ElevenLabs session lifetime must be between 10 seconds and 4 hours");
  }
  return value;
}

function boundedInactivityTimeout(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_INACTIVITY_TIMEOUT_SECONDS ||
    value > MAX_INACTIVITY_TIMEOUT_SECONDS
  ) {
    throw new Error("ElevenLabs inactivity timeout must be between 1 and 180 seconds");
  }
  return value;
}

function boundedUnit(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be within [0, 1]`);
  }
  return value;
}

function boundedContextId(value: string): string {
  return safeIdentifier(value, "ElevenLabs context id");
}

/** Identifiers travel in the URL path or protocol frames; a constrained charset keeps them inert. */
function safeIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must be non-empty`);
  if (normalized.length > 128 || !/^[\w-]+$/.test(normalized)) {
    throw new Error(`${label} must be at most 128 word characters or hyphens`);
  }
  return normalized;
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
