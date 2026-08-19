/**
 * The OpenAI-compatible realtime API boundaries for Discord voice
 * ([ADR 0057](../../../docs/adr/0057-realtime-voice-with-captain-handoff.md)).
 *
 * Two session kinds, one discipline:
 *
 * - **Transcription** — the dormant tier. Each instance hears one consented
 *   Discord speaker through OpenAI transcription or xAI streaming STT, surfaces transcripts, and is
 *   structurally incapable of answering: the class has no response path at
 *   all, so "hears everything, answers nothing" is a property of the type
 *   rather than a promise of the caller.
 * - **Conversation** — the engaged tier on `gpt-realtime-2.1`. Server VAD is
 *   kept for boundaries only: `turn_detection.create_response` and
 *   `turn_detection.interrupt_response` are both forced `false`, because the
 *   1:1 defaults answer and truncate on every voice in a group room. Every
 *   response is an explicit {@link RealtimeConversationSession.createResponse}
 *   decision by the floor logic that owns this session, and `ask_clankie` is
 *   the model's only privileged tool — everything else it can call (music, a
 *   read-only glance at his own screen) is local to this call and reaches no
 *   shell, no filesystem, and no room but this one, so a charmed or
 *   prompt-injected model has nothing to escalate with.
 *
 * The transport is injected ({@link RealtimeSocketFactory}) so tests are
 * deterministic and offline; {@link openRealtimeWebSocket} is the production
 * path over Node's global WebSocket. The memory rules: outbound PCM is zeroed
 * the moment it is encoded, inbound response audio is byte-capped per response,
 * outbound text is length-capped, sessions are lifetime-capped, the endpoint
 * must be WSS or loopback, and the API key exists only in the connection
 * headers — never in frames, logs, or error text.
 */

import { Buffer } from "node:buffer";
import { PCM_SAMPLE_BYTES } from "./voice-audio.ts";

const DEFAULT_TRANSCRIPTION_MODEL = "gpt-realtime-whisper";
const DEFAULT_CONVERSATION_MODEL = "gpt-realtime-2.1";
const DEFAULT_REALTIME_BASE_URL = "wss://api.openai.com/v1/realtime";
export const XAI_REALTIME_BASE_URL = "wss://api.x.ai/v1/realtime";
export const XAI_STREAMING_STT_BASE_URL = "wss://api.x.ai/v1/stt";
/** The voice the cascade already used, so the architecture swap does not change how he sounds. */
const DEFAULT_VOICE = "marin";
/**
 * Without a pinned language the transcriber
 * auto-detects per utterance, and short conversational turns are its worst
 * case — the documented failure mode is a fluent transcript in the wrong
 * language. Empty restores auto-detection for a genuinely multilingual room.
 */
const DEFAULT_TRANSCRIPTION_LANGUAGE = "en";

/** Realtime audio is 24 kHz mono s16le in both directions (ADR 0057). */
export const REALTIME_AUDIO_SAMPLE_RATE = 24_000;

/**
 * Five minutes of 24 kHz mono s16le. Read-aloud answers and briefings
 * legitimately cross one minute; five still bounds server-controlled output
 * and the playback queue without cutting ordinary long-form speech in half.
 */
export const MAX_REALTIME_RESPONSE_AUDIO_BYTES = REALTIME_AUDIO_SAMPLE_RATE * PCM_SAMPLE_BYTES * 5 * 60;

/**
 * Five seconds of audio per append. The media loop streams small frames; an
 * append larger than this means the caller is buffering audio it should have
 * streamed — or leaking it — and a bounded chunk keeps the base64 encode from
 * ballooning a single frame.
 */
export const MAX_REALTIME_AUDIO_APPEND_BYTES = REALTIME_AUDIO_SAMPLE_RATE * PCM_SAMPLE_BYTES * 5;

/**
 * Outbound text items are speaker-change markers, transcript seeds, briefing
 * refreshes, and `ask_clankie` results. 8 000 characters (~2 000 tokens)
 * holds the largest of those comfortably; anything bigger is a context leak
 * into a metered session, so it throws instead of silently truncating —
 * clipping a briefing mid-sentence is worse than making the caller bound it.
 */
export const MAX_REALTIME_TEXT_ITEM_CHARACTERS = 8_000;

/**
 * A 720×480 GBA PNG (3× native) is single-digit kilobytes; this cap is a
 * leak fence, not a typical frame size.
 */
export const MAX_REALTIME_IMAGE_CHARACTERS = 400_000;

/**
 * Instructions are persona + lane + realtime surface rules, composed from the
 * same sources the captain uses. Three authored layers fit well under this;
 * beyond it something other than identity is being smuggled into instructions.
 */
export const MAX_REALTIME_INSTRUCTIONS_CHARACTERS = 24_000;

/**
 * A single utterance's transcript has no business being longer, and the
 * bound keeps a hostile or broken server from growing callback payloads
 * without limit.
 */
const MAX_TRANSCRIPT_CHARACTERS = 2_000;

/**
 * Per-response output text cap for text-modality sessions ([ADR 0070](../../../docs/adr/0070-external-voice-via-streaming-tts.md)).
 * Everything a response says is synthesized and spoken aloud; more than this
 * is runaway output, not an utterance, and it fails closed exactly as the
 * audio byte cap does.
 */
export const MAX_REALTIME_RESPONSE_TEXT_CHARACTERS = 8_000;

/** Same bound as text items; `ask_clankie` takes one plain-language request. */
const MAX_FUNCTION_ARGUMENTS_CHARACTERS = 8_000;

/**
 * The platform ends realtime sessions around the hour mark anyway; a session
 * that outlives its call is a leak, and the cap turns a silent leak into an
 * observable `onClose("lifetime")` the owner can react to by reopening.
 */
export const DEFAULT_REALTIME_SESSION_LIFETIME_MS = 60 * 60_000;
const MIN_SESSION_LIFETIME_MS = 10_000;
const MAX_SESSION_LIFETIME_MS = 4 * 60 * 60_000;

/**
 * `session.truncation` defaults (ADR 0057 makes truncation required, not
 * optional — context re-billing is the cost term that actually grows).
 * Retaining 70 % drops the oldest third of the conversation each time the
 * limit trips, and 12 000 post-instructions tokens is roughly twenty minutes
 * of held audio context — a long exchange, but a bounded bill.
 */
export const DEFAULT_REALTIME_TRUNCATION_RETENTION_RATIO = 0.7;
export const DEFAULT_REALTIME_POST_INSTRUCTIONS_TOKEN_LIMIT = 12_000;

export const ASK_CLANKIE_TOOL_NAME = "ask_clankie";
/** Read-only glance at his own live play screen. Not a controller (ADR 0099). */
export const LOOK_AT_SCREEN_TOOL_NAME = "look_at_screen";
export const YOUTUBE_SEARCH_TOOL_NAME = "youtube_search";
export const MUSIC_PLAY_TOOL_NAME = "music_play";
export const MUSIC_QUEUE_TOOL_NAME = "music_queue";
export const MUSIC_SKIP_TOOL_NAME = "music_skip";
export const MUSIC_PAUSE_TOOL_NAME = "music_pause";
export const MUSIC_RESUME_TOOL_NAME = "music_resume";
export const MUSIC_STOP_TOOL_NAME = "music_stop";
export const MUSIC_NOW_TOOL_NAME = "music_now";

const REALTIME_PCM_FORMAT = { type: "audio/pcm", rate: REALTIME_AUDIO_SAMPLE_RATE } as const;

/**
 * Privileged actions still go through `ask_clankie` (ADR 0057). Music and
 * looking at his own screen are local to this call and never reach a shell.
 */
const ASK_CLANKIE_TOOL = {
  type: "function",
  name: ASK_CLANKIE_TOOL_NAME,
  description:
    "Ask Clankie's captain to act or to look something up. The captain holds every tool and " +
    "memory; use this for anything beyond conversation — actions, files, the story of this " +
    "playthrough, or facts the briefing does not cover. Do not use it just to look at your screen. " +
    "Do not use it for songs or YouTube — those are youtube_search and music_play.",
  parameters: {
    type: "object",
    properties: {
      request: {
        type: "string",
        description: "What is being asked of Clankie, as one plain-language request.",
      },
    },
    required: ["request"],
    additionalProperties: false,
  },
} as const;

const LOOK_AT_SCREEN_TOOL = {
  type: "function",
  name: LOOK_AT_SCREEN_TOOL_NAME,
  description:
    "Look at your own live game screen. Returns one still of what is on the emulator right now. " +
    "Read-only — it does not press buttons or change the game. Use it when someone asks what is " +
    "on screen, what you see, or you need the picture to talk about the play.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
} as const;

const YOUTUBE_SEARCH_TOOL = {
  type: "function",
  name: YOUTUBE_SEARCH_TOOL_NAME,
  description:
    "Search YouTube for a song or video to play in this call. Returns numbered results. " +
    "Read them to the room. A reply like '1 please' or 'the second one' is music_play or music_queue " +
    "with that index — do not ask_clankie and do not treat a song as a game.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to search for, e.g. Migos Bad and Boujee." },
      queue: {
        type: "boolean",
        description: "True if they asked to play it next / queue it instead of starting it now.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
} as const;

const MUSIC_URL_PROPERTIES = {
  url: { type: "string", description: "A youtube.com or youtu.be URL." },
  index: { type: "integer", description: "1-based index from the last youtube_search for this speaker." },
} as const;

const MUSIC_PLAY_TOOL = {
  type: "function",
  name: MUSIC_PLAY_TOOL_NAME,
  description:
    "Play a YouTube track now, replacing whatever is playing. Use index from the last youtube_search " +
    "for this speaker ('1 please' → index 1), or a url.",
  parameters: { type: "object", properties: MUSIC_URL_PROPERTIES, additionalProperties: false },
} as const;

const MUSIC_QUEUE_TOOL = {
  type: "function",
  name: MUSIC_QUEUE_TOOL_NAME,
  description: "Queue a YouTube track to play after the current one.",
  parameters: { type: "object", properties: MUSIC_URL_PROPERTIES, additionalProperties: false },
} as const;

const emptyMusicTool = (name: string, description: string) =>
  ({
    type: "function",
    name,
    description,
    parameters: { type: "object", properties: {}, additionalProperties: false },
  }) as const;

const MUSIC_SKIP_TOOL = emptyMusicTool(MUSIC_SKIP_TOOL_NAME, "Skip the current track.");
const MUSIC_PAUSE_TOOL = emptyMusicTool(MUSIC_PAUSE_TOOL_NAME, "Pause the current track.");
const MUSIC_RESUME_TOOL = emptyMusicTool(MUSIC_RESUME_TOOL_NAME, "Resume a paused track.");
const MUSIC_STOP_TOOL = emptyMusicTool(MUSIC_STOP_TOOL_NAME, "Stop playback and clear the queue.");
const MUSIC_NOW_TOOL = emptyMusicTool(MUSIC_NOW_TOOL_NAME, "What is playing and what is queued.");

const MUSIC_TOOLS = [
  YOUTUBE_SEARCH_TOOL,
  MUSIC_PLAY_TOOL,
  MUSIC_QUEUE_TOOL,
  MUSIC_SKIP_TOOL,
  MUSIC_PAUSE_TOOL,
  MUSIC_RESUME_TOOL,
  MUSIC_STOP_TOOL,
  MUSIC_NOW_TOOL,
] as const;

/** Minimal transport seam. Production wraps a WebSocket; tests inject a fake. */
export interface RealtimeSocket {
  send(data: string | Uint8Array): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (error: unknown) => void): void;
}

/** Resolves once the socket is open. Headers carry the API key and nothing else does. */
export type RealtimeSocketFactory = (
  url: string,
  headers: Readonly<Record<string, string>>,
) => Promise<RealtimeSocket>;

/** Injected timer seam so the session lifetime cap is testable without wall-clock time. */
export interface RealtimeTimers {
  setTimeout(handler: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Why the session ended: `closed` is a local `close()`, `lifetime` is the
 * session lifetime cap, `socket` is a remote close, and `error` covers
 * transport failures and safety-bound violations such as the response audio
 * byte cap.
 */
export type RealtimeSessionCloseReason = "closed" | "lifetime" | "socket" | "error";

export interface RealtimeTranscriptEvent {
  readonly itemId: string;
  readonly text: string;
  readonly final: boolean;
}

export interface RealtimeFunctionCall {
  readonly callId: string;
  readonly name: string;
  readonly argumentsJson: string;
}

/** Content-free by construction: ids, status, and scalar counters only. */
export interface RealtimeResponseMeta {
  readonly responseId: string;
  readonly status: string;
  /** Total decoded response audio bytes observed for this response. */
  readonly audioBytes: number;
  /** Total response text characters observed for this response (text modality). */
  readonly textCharacters: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface RealtimeSessionCommonOptions {
  /** Broker-resolved API key. It goes into the connection headers and must never be persisted, logged, or echoed in error text. */
  readonly apiKey: string;
  /** Injected transport. Defaults to {@link openRealtimeWebSocket} over Node's global WebSocket. */
  readonly socketFactory?: RealtimeSocketFactory;
  /** Must be WSS unless loopback — the WebSocket form of the HTTPS-or-loopback rule. */
  readonly baseUrl?: string;
  /** Session lifetime cap in milliseconds; the session closes itself and reports `onClose("lifetime")`. */
  readonly maxLifetimeMs?: number;
  readonly timers?: RealtimeTimers;
  readonly onClose?: (reason: RealtimeSessionCloseReason) => void;
  /** Sanitized, content-free error messages only; never transport detail, never the key. */
  readonly onError?: (message: string) => void;
}

export interface RealtimeTranscriptionSessionOptions extends RealtimeSessionCommonOptions {
  readonly model?: string;
  /** ISO-639-1 expected speech language. Empty restores per-utterance auto-detection. */
  readonly language?: string;
  readonly onTranscript: (event: RealtimeTranscriptEvent) => void;
}

export type XaiStreamingTranscriptionSessionOptions = Omit<RealtimeTranscriptionSessionOptions, "model">;

export interface RealtimeConversationSessionOptions extends RealtimeSessionCommonOptions {
  /** Wire-level session dialect. The event stream remains OpenAI-compatible. */
  readonly provider?: "openai" | "xai";
  readonly model?: string;
  readonly voice?: string;
  /** xAI Voice reasoning control; omitted for OpenAI. */
  readonly reasoningEffort?: "high" | "none";
  /**
   * What the responses are made of ([ADR 0070](../../../docs/adr/0070-external-voice-via-streaming-tts.md)).
   * `"audio"` (the default) is the model's own voice; `"text"` takes the
   * mouth away — deltas stream to {@link onTextDelta} for an external
   * synthesizer, `voice` is ignored, and the input side (native audio ears,
   * boundary-only VAD) is unchanged.
   */
  readonly outputModality?: "audio" | "text";
  /** Composed persona + lane + surface rules, supplied by the caller — never authored here. */
  readonly instructions: string;
  readonly truncationRetentionRatio?: number;
  readonly postInstructionsTokenLimit?: number;
  /**
   * Decoded 24 kHz mono s16le response audio. Ownership of the buffer
   * transfers to the caller, and with it the zeroing duty: the caller must
   * `fill(0)` each delta once it has been handed off to playback, exactly as
   * the cascade zeroed synthesized PCM after each turn.
   */
  readonly onAudioDelta: (pcm: Buffer, itemId: string) => void;
  /**
   * Response text deltas, only in `"text"` modality. This is what Clankie is
   * about to say out loud through the external voice — bounded per response
   * by {@link MAX_REALTIME_RESPONSE_TEXT_CHARACTERS} and never logged.
   */
  readonly onTextDelta?: (delta: string, itemId: string) => void;
  readonly onResponseDone?: (meta: RealtimeResponseMeta) => void;
  readonly onFunctionCall?: (call: RealtimeFunctionCall) => void;
}

/**
 * Production socket factory over the global WebSocket (Node ≥ 22 ships one via
 * undici, whose init object accepts extra headers). Never used by tests —
 * they inject a fake — so this stays a thin, obviously-correct wrapper.
 */
export const openRealtimeWebSocket: RealtimeSocketFactory = (url, headers) => {
  // The DOM lib types WebSocket's second parameter as protocols only; Node's
  // undici implementation additionally accepts an init object with headers,
  // which is the only way to attach the bearer token — hence the cast.
  const WebSocketCtor = (
    globalThis as unknown as {
      WebSocket?: new (
        url: string,
        init: { readonly headers: Readonly<Record<string, string>> },
      ) => WebSocket;
    }
  ).WebSocket;
  if (WebSocketCtor === undefined) {
    return Promise.reject(new Error("globalThis.WebSocket is unavailable; inject a RealtimeSocketFactory"));
  }
  return new Promise<RealtimeSocket>((resolve, reject) => {
    const socket = new WebSocketCtor(url, { headers });
    const messageHandlers: ((data: string) => void)[] = [];
    const closeHandlers: (() => void)[] = [];
    const errorHandlers: ((error: unknown) => void)[] = [];
    socket.addEventListener("message", (event) => {
      // The realtime protocol is JSON text frames; binary frames are ignored.
      if (typeof event.data === "string") {
        for (const handler of messageHandlers) handler(event.data);
      }
    });
    socket.addEventListener("close", () => {
      for (const handler of closeHandlers) handler();
    });
    socket.addEventListener("error", (event) => {
      for (const handler of errorHandlers) handler(event);
    });
    socket.addEventListener(
      "open",
      () => {
        resolve({
          send: (data) => {
            socket.send(data);
          },
          close: () => {
            socket.close();
          },
          onMessage: (handler) => {
            messageHandlers.push(handler);
          },
          onClose: (handler) => {
            closeHandlers.push(handler);
          },
          onError: (handler) => {
            errorHandlers.push(handler);
          },
        });
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      // Deliberately content-free: a connection error must not leak the URL,
      // headers, or the key into error text.
      () => {
        reject(new Error("Realtime WebSocket connection failed"));
      },
      { once: true },
    );
  });
};

interface RealtimeSessionCoreInit {
  readonly socket: RealtimeSocket;
  readonly timers: RealtimeTimers;
  readonly maxLifetimeMs: number;
  readonly onClose: ((reason: RealtimeSessionCloseReason) => void) | undefined;
  readonly onError: ((message: string) => void) | undefined;
}

/** Shared socket wiring, lifetime cap, close semantics, and audio append discipline. */
abstract class RealtimeSessionCore {
  private readonly socket: RealtimeSocket;
  private readonly timers: RealtimeTimers;
  private readonly lifetimeHandle: unknown;
  private readonly onCloseCallback: ((reason: RealtimeSessionCloseReason) => void) | undefined;
  protected readonly onErrorCallback: ((message: string) => void) | undefined;
  private closed = false;

  protected constructor(init: RealtimeSessionCoreInit) {
    this.socket = init.socket;
    this.timers = init.timers;
    this.onCloseCallback = init.onClose;
    this.onErrorCallback = init.onError;
    init.socket.onMessage((data) => {
      this.receive(data);
    });
    init.socket.onClose(() => {
      this.closeWith("socket");
    });
    init.socket.onError(() => {
      // The transport error object is deliberately not inspected, logged, or
      // rethrown: it can carry connection detail, and the key must never
      // reach error text.
      this.onErrorCallback?.("Realtime transport error");
      this.closeWith("error");
    });
    this.lifetimeHandle = init.timers.setTimeout(() => {
      this.closeWith("lifetime");
    }, init.maxLifetimeMs);
  }

  public get isOpen(): boolean {
    return !this.closed;
  }

  /**
   * Appends 24 kHz mono s16le PCM as a base64 `input_audio_buffer.append`.
   * The caller's buffer is zeroed on every path out of this method — success,
   * validation failure, or closed session — so raw room audio never lingers
   * in memory it does not need to occupy.
   */
  public appendAudio(pcm: Buffer): void {
    try {
      this.assertOpen();
      if (pcm.byteLength === 0) return;
      if (pcm.byteLength % PCM_SAMPLE_BYTES !== 0) {
        throw new Error("Realtime audio must contain whole s16le samples");
      }
      if (pcm.byteLength > MAX_REALTIME_AUDIO_APPEND_BYTES) {
        throw new Error("Realtime audio append exceeded the chunk byte limit");
      }
      this.sendAudio(pcm);
    } finally {
      pcm.fill(0);
    }
  }

  protected sendAudio(pcm: Buffer): void {
    this.sendFrame({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
  }

  public close(): void {
    this.closeWith("closed");
  }

  protected abstract handleServerEvent(type: string, event: Record<string, unknown>): void;

  /** Provider-specific cleanup for content buffered before the server is ready. */
  protected handleClosing(): void {}

  protected sendFrame(frame: Record<string, unknown>): void {
    this.sendRaw(JSON.stringify(frame));
  }

  protected sendRaw(data: string | Uint8Array): void {
    this.assertOpen();
    try {
      this.socket.send(data);
    } catch {
      // The raw transport error is dropped for the same reason onError's is.
      this.closeWith("error");
      throw new Error("Realtime socket send failed");
    }
  }

  protected closeWith(reason: RealtimeSessionCloseReason): void {
    if (this.closed) return;
    this.closed = true;
    this.timers.clearTimeout(this.lifetimeHandle);
    this.handleClosing();
    try {
      this.socket.close();
    } catch {
      // Already closing; the reason we report is the one that got here first.
    }
    this.onCloseCallback?.(reason);
  }

  protected assertOpen(): void {
    if (this.closed) throw new Error("Realtime session is closed");
  }

  private receive(data: string): void {
    if (this.closed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      this.onErrorCallback?.("Realtime server sent an unparseable frame");
      return;
    }
    const event = asRecord(parsed);
    if (event === undefined) return;
    const type = asString(event.type);
    if (type === undefined) return;
    if (type === "error") {
      this.onErrorCallback?.(describeServerError(event));
      return;
    }
    this.handleServerEvent(type, event);
  }
}

/**
 * The dormant tier: a `"type": "transcription"` session that hears one
 * caller-bound speaker input and surfaces transcripts. It never produces a response of any
 * kind — there is no method on this class that can emit `response.create` or
 * `conversation.item.create`, which is the structural form of "answers
 * nothing".
 */
export class RealtimeTranscriptionSession extends RealtimeSessionCore {
  private readonly onTranscriptCallback: (event: RealtimeTranscriptEvent) => void;

  public constructor(socket: RealtimeSocket, options: RealtimeTranscriptionSessionOptions) {
    const model = nonEmpty(options.model ?? DEFAULT_TRANSCRIPTION_MODEL, "Realtime transcription model");
    // Empty is meaningful — auto-detect — so it deliberately skips nonEmpty.
    const language = (options.language ?? DEFAULT_TRANSCRIPTION_LANGUAGE).trim();
    super(coreInit(socket, options));
    this.onTranscriptCallback = options.onTranscript;
    this.sendFrame({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: REALTIME_PCM_FORMAT,
            transcription: {
              model,
              ...(language.length > 0 ? { language } : {}),
            },
            // Discord already supplies authenticated per-speaker turn bounds.
            // gpt-realtime-whisper rejects VAD, so the caller commits each turn.
            turn_detection: null,
          },
        },
      },
    });
  }

  protected override handleServerEvent(type: string, event: Record<string, unknown>): void {
    switch (type) {
      case "conversation.item.input_audio_transcription.delta": {
        this.emitTranscript(event, asString(event.delta) ?? "", false);
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        this.emitTranscript(event, asString(event.transcript) ?? "", true);
        return;
      }
      default:
      // Session acks, VAD boundaries, and anything unrecognized are ignored;
      // the dormant tier reacts to nothing but transcripts.
    }
  }

  public commitAudio(): void {
    this.sendFrame({ type: "input_audio_buffer.commit" });
  }

  private emitTranscript(event: Record<string, unknown>, text: string, final: boolean): void {
    const itemId = asString(event.item_id);
    if (itemId === undefined) return;
    this.onTranscriptCallback({ itemId, text: text.slice(0, MAX_TRANSCRIPT_CHARACTERS), final });
  }
}

/**
 * xAI's dedicated streaming STT endpoint. Unlike the OpenAI-compatible voice
 * socket it accepts raw PCM binary frames and has no model selector or setup
 * message. Audio offered before `transcript.created` is held behind the same
 * five-second append bound, then zeroed as soon as it is sent.
 */
export class XaiStreamingTranscriptionSession extends RealtimeSessionCore {
  private readonly onTranscriptCallback: (event: RealtimeTranscriptEvent) => void;
  private readonly pendingAudio: Buffer[] = [];
  private pendingAudioBytes = 0;
  private ready = false;
  private utterance = 1;

  public constructor(socket: RealtimeSocket, options: XaiStreamingTranscriptionSessionOptions) {
    super(coreInit(socket, options));
    this.onTranscriptCallback = options.onTranscript;
  }

  protected override sendAudio(pcm: Buffer): void {
    if (this.ready) {
      this.sendRaw(pcm);
      return;
    }
    if (this.pendingAudioBytes + pcm.byteLength > MAX_REALTIME_AUDIO_APPEND_BYTES) {
      this.onErrorCallback?.("xAI streaming transcription did not become ready before the audio bound");
      this.closeWith("error");
      throw new Error("xAI streaming transcription readiness audio bound exceeded");
    }
    const copy = Buffer.from(pcm);
    this.pendingAudio.push(copy);
    this.pendingAudioBytes += copy.byteLength;
  }

  public commitAudio(): void {
    // xAI's streaming STT endpoint owns turn finalization.
  }

  protected override handleServerEvent(type: string, event: Record<string, unknown>): void {
    if (type === "transcript.created") {
      if (this.ready) return;
      this.ready = true;
      this.flushPendingAudio();
      return;
    }
    if (type !== "transcript.partial") return;
    const text = asString(event.text);
    if (text === undefined) return;
    const final = asBoolean(event.is_final) === true && asBoolean(event.speech_final) === true;
    this.onTranscriptCallback({
      itemId: `xai-stt-${this.utterance.toString()}`,
      text: text.slice(0, MAX_TRANSCRIPT_CHARACTERS),
      final,
    });
    if (final) this.utterance += 1;
  }

  protected override handleClosing(): void {
    for (const pcm of this.pendingAudio) pcm.fill(0);
    this.pendingAudio.length = 0;
    this.pendingAudioBytes = 0;
  }

  private flushPendingAudio(): void {
    try {
      for (const pcm of this.pendingAudio) {
        try {
          this.sendRaw(pcm);
        } finally {
          pcm.fill(0);
        }
      }
    } finally {
      for (const pcm of this.pendingAudio) pcm.fill(0);
      this.pendingAudio.length = 0;
      this.pendingAudioBytes = 0;
    }
  }
}

/**
 * The engaged tier: speaks and listens, holds no controller. Responses only
 * ever happen through {@link createResponse}; VAD cannot create or interrupt
 * one, and the single `ask_clankie` tool is the only route to any ability.
 */
export class RealtimeConversationSession extends RealtimeSessionCore {
  private readonly onAudioDeltaCallback: (pcm: Buffer, itemId: string) => void;
  private readonly onTextDeltaCallback: ((delta: string, itemId: string) => void) | undefined;
  private readonly onResponseDoneCallback: ((meta: RealtimeResponseMeta) => void) | undefined;
  private readonly onFunctionCallCallback: ((call: RealtimeFunctionCall) => void) | undefined;
  private currentResponseId = "";
  private currentResponseAudioBytes = 0;
  private currentResponseTextCharacters = 0;
  private readonly provider: "openai" | "xai";

  public constructor(socket: RealtimeSocket, options: RealtimeConversationSessionOptions) {
    const provider = options.provider ?? "openai";
    const model = nonEmpty(options.model ?? DEFAULT_CONVERSATION_MODEL, "Realtime conversation model");
    const outputModality = options.outputModality ?? "audio";
    const voice = nonEmpty(options.voice ?? DEFAULT_VOICE, "Realtime voice");
    if (outputModality === "text" && options.onTextDelta === undefined) {
      // A text-modality session with no text sink would speak into the void;
      // failing at construction beats a silently mute Clankie.
      throw new Error("Realtime text modality requires an onTextDelta callback");
    }
    if (provider === "xai" && outputModality === "text") {
      throw new Error("xAI realtime voice does not expose a text-only output modality");
    }
    const instructions = boundedText(
      options.instructions,
      MAX_REALTIME_INSTRUCTIONS_CHARACTERS,
      "Realtime session instructions",
    );
    const retentionRatio = boundedRetentionRatio(
      options.truncationRetentionRatio ?? DEFAULT_REALTIME_TRUNCATION_RETENTION_RATIO,
    );
    const postInstructionsTokenLimit = boundedTokenLimit(
      options.postInstructionsTokenLimit ?? DEFAULT_REALTIME_POST_INSTRUCTIONS_TOKEN_LIMIT,
    );
    super(coreInit(socket, options));
    this.onAudioDeltaCallback = options.onAudioDelta;
    this.onTextDeltaCallback = options.onTextDelta;
    this.onResponseDoneCallback = options.onResponseDone;
    this.onFunctionCallCallback = options.onFunctionCall;
    this.provider = provider;
    this.sendFrame({
      type: "session.update",
      session:
        provider === "xai"
          ? {
              voice,
              instructions,
              reasoning: { effort: options.reasoningEffort ?? "high" },
              // The engaged tier receives attributed text from the dormant
              // per-speaker transcribers. Manual turns prevent xAI's VAD from
              // becoming a second, conflicting floor owner.
              turn_detection: null,
              audio: { output: { format: REALTIME_PCM_FORMAT } },
              tools: [ASK_CLANKIE_TOOL, LOOK_AT_SCREEN_TOOL, ...MUSIC_TOOLS],
            }
          : {
              type: "realtime",
              model,
              output_modalities: [outputModality],
              instructions,
              audio: {
                input: {
                  format: REALTIME_PCM_FORMAT,
                  // ADR 0057: the 1:1 defaults are wrong in a group room. VAD is
                  // kept for boundaries only; the floor machine this repository
                  // owns decides when he speaks and when he is interrupted.
                  turn_detection: {
                    type: "server_vad",
                    create_response: false,
                    interrupt_response: false,
                  },
                },
                // In text modality there is no model mouth to configure; the
                // external synthesizer owns how he sounds (ADR 0070).
                ...(outputModality === "audio"
                  ? {
                      output: {
                        format: REALTIME_PCM_FORMAT,
                        voice,
                      },
                    }
                  : {}),
              },
              tools: [ASK_CLANKIE_TOOL, LOOK_AT_SCREEN_TOOL, ...MUSIC_TOOLS],
              tool_choice: "auto",
              truncation: {
                type: "retention_ratio",
                retention_ratio: retentionRatio,
                post_instructions_token_limit: postInstructionsTokenLimit,
              },
            },
    });
  }

  /**
   * The only method in this module that emits `response.create`. Speaker
   * items, transcripts, and audio never trigger a response on their own —
   * {@link submitFunctionResult} resumes a tool round trip by calling this.
   */
  public createResponse(): void {
    this.sendFrame({ type: "response.create" });
  }

  /** User-role text item: speaker-change markers, transcript seeding, briefing refresh. */
  public createTextItem(text: string): void {
    const bounded = boundedText(text, MAX_REALTIME_TEXT_ITEM_CHARACTERS, "Realtime text item");
    this.sendFrame({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: bounded }],
      },
    });
  }

  /**
   * One still of his own play. PNG base64, no data-URL prefix — this method
   * wraps it. Throws rather than silently clipping; a truncated picture is
   * worse than making the caller bound the capture.
   */
  public createImageItem(pngBase64: string, mimeType: "image/png" = "image/png"): void {
    const data = nonEmpty(pngBase64, "Realtime image");
    if (data.length > MAX_REALTIME_IMAGE_CHARACTERS) {
      throw new Error("Realtime image exceeds the still bound");
    }
    this.sendFrame({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: `data:${mimeType};base64,${data}` }],
      },
    });
  }

  /**
   * Deliberate barge-in (`conversation.item.truncate`). With
   * `interrupt_response: false` nothing truncates him automatically; the
   * floor logic calls this when the floor holder talks over him or he is
   * re-addressed.
   */
  public truncate(itemId: string, audioEndMs: number): void {
    const id = nonEmpty(itemId, "Realtime item id");
    if (!Number.isSafeInteger(audioEndMs) || audioEndMs < 0) {
      throw new Error("Realtime truncation point must be a non-negative whole number of milliseconds");
    }
    this.sendFrame({
      type: "conversation.item.truncate",
      item_id: id,
      content_index: 0,
      audio_end_ms: audioEndMs,
    });
  }

  /** Replaces session instructions in place (briefing-driven refresh) without reopening. */
  public updateInstructions(text: string): void {
    const instructions = boundedText(
      text,
      MAX_REALTIME_INSTRUCTIONS_CHARACTERS,
      "Realtime session instructions",
    );
    this.sendFrame({
      type: "session.update",
      session: this.provider === "xai" ? { instructions } : { type: "realtime", instructions },
    });
  }

  /**
   * Completes an `ask_clankie` round trip: the captain-produced result goes
   * back as a `function_call_output` item and the session resumes speaking it
   * via an explicit response.
   */
  public submitFunctionResult(callId: string, output: string): void {
    const id = nonEmpty(callId, "Realtime function call id");
    const bounded = boundedText(output, MAX_REALTIME_TEXT_ITEM_CHARACTERS, "Realtime function result");
    this.sendFrame({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: id, output: bounded },
    });
    this.createResponse();
  }

  protected override handleServerEvent(type: string, event: Record<string, unknown>): void {
    switch (type) {
      case "response.output_audio.delta":
      // Pre-GA name, handled until a live run confirms it is gone.
      case "response.audio.delta": {
        this.handleAudioDelta(event);
        return;
      }
      case "response.output_text.delta":
      // Pre-GA name, same treatment as the audio pair above.
      case "response.text.delta": {
        this.handleTextDelta(event);
        return;
      }
      case "response.done": {
        this.handleResponseDone(event);
        return;
      }
      case "response.output_item.done": {
        if (this.provider === "openai") this.handleOutputItemDone(event);
        return;
      }
      case "response.function_call_arguments.done": {
        if (this.provider === "xai") this.handleFunctionCallDone(event);
        return;
      }
      default:
      // Everything else — acks, VAD boundaries, item lifecycle — is state the
      // caller does not need and content this boundary refuses to surface.
    }
  }

  private handleTextDelta(event: Record<string, unknown>): void {
    if (this.onTextDeltaCallback === undefined) return;
    const delta = asString(event.delta);
    if (delta === undefined || delta.length === 0) return;
    const itemId = asString(event.item_id) ?? "";
    const responseId = asString(event.response_id) ?? "";
    if (responseId !== this.currentResponseId) {
      this.currentResponseId = responseId;
      this.currentResponseAudioBytes = 0;
      this.currentResponseTextCharacters = 0;
    }
    this.currentResponseTextCharacters += delta.length;
    if (this.currentResponseTextCharacters > MAX_REALTIME_RESPONSE_TEXT_CHARACTERS) {
      // Fail closed like the audio byte cap: everything surfaced here is
      // spoken aloud, and unbounded server text means unbounded speech.
      this.onErrorCallback?.("Realtime response text exceeded the character limit");
      this.closeWith("error");
      return;
    }
    this.onTextDeltaCallback(delta, itemId);
  }

  private handleAudioDelta(event: Record<string, unknown>): void {
    const delta = asString(event.delta);
    if (delta === undefined || delta.length === 0) return;
    const itemId = asString(event.item_id) ?? "";
    const responseId = asString(event.response_id) ?? "";
    if (responseId !== this.currentResponseId) {
      this.currentResponseId = responseId;
      this.currentResponseAudioBytes = 0;
      this.currentResponseTextCharacters = 0;
    }
    const pcm = Buffer.from(delta, "base64");
    this.currentResponseAudioBytes += pcm.byteLength;
    if (this.currentResponseAudioBytes > MAX_REALTIME_RESPONSE_AUDIO_BYTES) {
      // Fail closed, exactly like the cascade's TTS byte cap: zero what was
      // decoded, report, and end the session rather than stream unbounded
      // server-controlled audio into memory.
      pcm.fill(0);
      this.onErrorCallback?.("Realtime response audio exceeded the byte limit");
      this.closeWith("error");
      return;
    }
    this.onAudioDeltaCallback(pcm, itemId);
  }

  private handleResponseDone(event: Record<string, unknown>): void {
    const response = asRecord(event.response);
    const responseId = asString(response?.id) ?? "";
    const status = asString(response?.status) ?? "unknown";
    const usage = asRecord(response?.usage);
    const inputTokens = asCount(usage?.input_tokens);
    const outputTokens = asCount(usage?.output_tokens);
    const isCurrent = responseId === this.currentResponseId;
    const audioBytes = isCurrent ? this.currentResponseAudioBytes : 0;
    const textCharacters = isCurrent ? this.currentResponseTextCharacters : 0;
    if (isCurrent) {
      this.currentResponseId = "";
      this.currentResponseAudioBytes = 0;
      this.currentResponseTextCharacters = 0;
    }
    this.onResponseDoneCallback?.({
      responseId,
      status,
      audioBytes,
      textCharacters,
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
    });
  }

  private handleOutputItemDone(event: Record<string, unknown>): void {
    const item = asRecord(event.item);
    if (item === undefined || asString(item.type) !== "function_call") return;
    const callId = asString(item.call_id);
    const name = asString(item.name);
    if (callId === undefined || name === undefined) return;
    const argumentsJson = asString(item.arguments) ?? "";
    if (argumentsJson.length > MAX_FUNCTION_ARGUMENTS_CHARACTERS) {
      this.onErrorCallback?.("Realtime function call arguments exceeded the character limit");
      return;
    }
    this.onFunctionCallCallback?.({ callId, name, argumentsJson });
  }

  private handleFunctionCallDone(event: Record<string, unknown>): void {
    const callId = asString(event.call_id);
    const name = asString(event.name);
    if (callId === undefined || name === undefined) return;
    const argumentsJson = asString(event.arguments) ?? "";
    if (argumentsJson.length > MAX_FUNCTION_ARGUMENTS_CHARACTERS) {
      this.onErrorCallback?.("Realtime function call arguments exceeded the character limit");
      return;
    }
    this.onFunctionCallCallback?.({ callId, name, argumentsJson });
  }
}

/** Opens the dormant-tier transcription session. */
export async function openRealtimeTranscriptionSession(
  options: RealtimeTranscriptionSessionOptions,
): Promise<RealtimeTranscriptionSession> {
  const socket = await connect(options, { intent: "transcription" });
  return construct(socket, () => new RealtimeTranscriptionSession(socket, options));
}

/** Opens xAI's raw-binary streaming speech-to-text listener. */
export async function openXaiStreamingTranscriptionSession(
  options: XaiStreamingTranscriptionSessionOptions,
): Promise<XaiStreamingTranscriptionSession> {
  const socket = await connect(
    { ...options, baseUrl: options.baseUrl ?? XAI_STREAMING_STT_BASE_URL },
    {
      sample_rate: REALTIME_AUDIO_SAMPLE_RATE.toString(),
      encoding: "pcm",
      interim_results: "false",
      ...((options.language ?? DEFAULT_TRANSCRIPTION_LANGUAGE).trim().length === 0
        ? {}
        : { language: (options.language ?? DEFAULT_TRANSCRIPTION_LANGUAGE).trim() }),
    },
  );
  return construct(socket, () => new XaiStreamingTranscriptionSession(socket, options));
}

/** Opens the engaged-tier conversation session. */
export async function openRealtimeConversationSession(
  options: RealtimeConversationSessionOptions,
): Promise<RealtimeConversationSession> {
  const model = nonEmpty(options.model ?? DEFAULT_CONVERSATION_MODEL, "Realtime conversation model");
  const socket = await connect(options, { model });
  return construct(socket, () => new RealtimeConversationSession(socket, options));
}

async function connect(
  options: RealtimeSessionCommonOptions,
  query: Readonly<Record<string, string>>,
): Promise<RealtimeSocket> {
  const url = buildRealtimeUrl(options.baseUrl, query);
  const apiKey = nonEmpty(options.apiKey, "Realtime API key");
  const factory = options.socketFactory ?? openRealtimeWebSocket;
  return factory(url, Object.freeze({ authorization: `Bearer ${apiKey}` }));
}

/** If session construction fails after the socket opened, the socket must not leak. */
function construct<T>(socket: RealtimeSocket, build: () => T): T {
  try {
    return build();
  } catch (error) {
    try {
      socket.close();
    } catch {
      // The construction error is the one worth reporting.
    }
    throw error;
  }
}

function coreInit(socket: RealtimeSocket, options: RealtimeSessionCommonOptions): RealtimeSessionCoreInit {
  return {
    socket,
    timers: options.timers ?? globalTimers,
    maxLifetimeMs: boundedSessionLifetime(options.maxLifetimeMs ?? DEFAULT_REALTIME_SESSION_LIFETIME_MS),
    onClose: options.onClose,
    onError: options.onError,
  };
}

const globalTimers: RealtimeTimers = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** WSS-or-loopback: the WebSocket form of the HTTPS-or-loopback rule. */
function buildRealtimeUrl(baseUrl: string | undefined, query: Readonly<Record<string, string>>): string {
  const url = new URL(baseUrl ?? DEFAULT_REALTIME_BASE_URL);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && isLoopback(url))) {
    throw new Error("Realtime base URL must use WSS unless it is loopback");
  }
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

function isLoopback(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
}

function describeServerError(event: Record<string, unknown>): string {
  // Only the machine-readable code is surfaced. The server's message field
  // can echo conversation or request content, which this boundary never
  // forwards into logs or error text.
  const code = asString(asRecord(event.error)?.code);
  return code === undefined ? "Realtime session error" : `Realtime session error (${code})`;
}

function boundedSessionLifetime(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_SESSION_LIFETIME_MS || value > MAX_SESSION_LIFETIME_MS) {
    throw new Error("Realtime session lifetime must be between 10 seconds and 4 hours");
  }
  return value;
}

function boundedRetentionRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error("Realtime truncation retention ratio must be within (0, 1]");
  }
  return value;
}

function boundedTokenLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 128_000) {
    throw new Error("Realtime post-instructions token limit must be between 1000 and 128000");
  }
  return value;
}

function boundedText(value: string, maximumCharacters: number, label: string): string {
  const text = value.trim();
  if (text.length === 0) throw new Error(`${label} must be non-empty`);
  if (text.length > maximumCharacters) {
    throw new Error(`${label} exceeded the ${maximumCharacters.toString()} character limit`);
  }
  return text;
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

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
