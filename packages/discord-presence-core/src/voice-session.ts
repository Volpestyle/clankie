/**
 * Single official-bot media owner for one guild voice channel, rewired for
 * [ADR 0057](../../../docs/adr/0057-realtime-voice-with-captain-handoff.md)'s
 * two-tier realtime flow.
 *
 * Discord's receiver supplies per-user Opus streams; only explicitly consented
 * user ids are ever subscribed, so unconsented audio can never reach an
 * `input_audio_buffer.append` (mission criterion 3). Consented audio is
 * converted to 24 kHz mono and streamed into a dormant transcription session —
 * his ears — as it arrives. Final transcripts feed the {@link VoiceFloor}
 * machine, which alone decides when the engaged conversation session opens and
 * when `response.create` is issued: no utterance is ever auto-answered.
 *
 * The captain never sits on the conversational critical path. The engaged
 * session's only tool is `ask_clankie`, which serializes on the turn queue and
 * routes through the unchanged `discord_voice` captain lane
 * ({@link DiscordVoiceIngress}); approval-shaped results still come back as the
 * authenticated-surface handoff, so ambient voice cannot approve privileged
 * work.
 *
 * Speaker attribution comes from the Discord gateway's speaking transitions
 * (criterion 5): capture lifecycle maintains speaking spans, every receipt's
 * `userId` comes from those spans, and identity reaches the engaged model as
 * out-of-band `Speaker: <id>` text items — never inferred from audio.
 */

import {
  AudioPlayerStatus,
  EndBehaviorType,
  NetworkingStatusCode,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type AudioReceiveStream,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from "@discordjs/voice";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { opus } from "prism-media";
import type { DiscordVoiceEvidence, DiscordVoiceWake } from "@clankie/protocol";
import {
  ASK_CLANKIE_TOOL_NAME,
  MAX_REALTIME_AUDIO_APPEND_BYTES,
  REALTIME_AUDIO_SAMPLE_RATE,
  type RealtimeFunctionCall,
  type RealtimeResponseMeta,
  type RealtimeSessionCloseReason,
  type RealtimeTimers,
  type RealtimeTranscriptEvent,
} from "./realtime-session.ts";
import { voiceAddressesCharacter } from "./voice-address.ts";
import { discordPcmToRealtimePcm, openAiPcmToDiscordPcm, PCM_SAMPLE_BYTES } from "./voice-audio.ts";
import { DiscordVoiceConsentRegistry, type DiscordVoiceConsentPolicy } from "./voice-consent.ts";
import { VoiceFloor, type FloorDecision, type FloorState, type VoiceFloorOptions } from "./voice-floor.ts";
import type { DiscordVoiceIngress, DiscordVoiceTurnOutcome } from "./voice-ingress.ts";

/** Shorter than this is noise, not an utterance; it earns no receipt. */
const MIN_UTTERANCE_MS = 350;
/**
 * How rarely a possessor's narration may make him speak (ADR 0064). A play loop
 * reports constantly — every step, every bump — and answering each one would
 * turn a voice channel into a monologue nobody can talk over. Seeding is
 * unbounded; only the spoken response waits.
 */
export const DEFAULT_NARRATION_MIN_INTERVAL_MS = 12_000;
/**
 * Silence that closes a capture. Unlike the cascade this no longer gates a
 * response — transcription streams while the speaker is still talking — it
 * only bounds the gateway speaking span used for attribution and the
 * per-capture utterance receipt.
 */
const CAPTURE_END_SILENCE_MS = 800;
/**
 * Audio required before a consented speaker is treated as talking over him.
 * Deliberately the same bar as {@link MIN_UTTERANCE_MS}: if it is not enough to
 * count as an utterance, it is not enough to cut him off.
 */
const BARGE_IN_PCM_BYTES = Math.round(48_000 * 2 * 2 * (MIN_UTTERANCE_MS / 1_000));
const VOICE_READY_TIMEOUT_MS = 20_000;
const DAVE_READY_TIMEOUT_MS = 10_000;
const PLAYBACK_TIMEOUT_MS = 2 * 60_000;

/**
 * How long a released engagement keeps its conversation session connected.
 * ADR 0057: the first response after a wake pays session setup, so a
 * conversation that resumes inside this window wakes instantly ("continuing")
 * instead of paying the wake again. Expiry closes the session cleanly.
 */
export const ENGAGED_HOLD_MS = 5 * 60_000;
/**
 * Decay-tick cadence while engaged. The floor machine never sleeps, so a room
 * that goes silent produces no transcript to evaluate decay against; this
 * timer asks "is the floor stale?" often enough that decay fires with no
 * phrase at all, without polling hard.
 */
export const ENGAGED_TICK_MS = 5_000;
/**
 * The transcript ring is the only transcript retention anywhere in the voice
 * path: recent final lines used to seed an engaged session and as the volition
 * decider's room text. ~30 lines / ~4 000 bytes holds the last few minutes of
 * a lively room and stays well inside a single bounded realtime text item.
 */
export const TRANSCRIPT_RING_MAX_LINES = 30;
export const TRANSCRIPT_RING_MAX_BYTES = 4_000;
/** Speaking spans kept for attribution; ids and clock numbers only. */
const MAX_SPEAKING_SPANS = 32;
/**
 * Listener reconnect backoff: 1 s doubling to a 30 s cap, forever while
 * joined. The transcription session is his ears — a mid-call disconnect must
 * not silently deafen him (ADR 0057 risk), so the retry never gives up.
 */
const RECONNECT_BACKOFF_INITIAL_MS = 1_000;
const RECONNECT_BACKOFF_CAP_MS = 30_000;
/**
 * Spoken when the captain handoff fails. Fixed and content-free on purpose:
 * a failure sentence must never echo request or error detail into the room.
 */
export const CAPTAIN_UNREACHABLE_TEXT =
  "I couldn't reach my captain for that just now. Give me a moment and ask again.";

export interface JoinDiscordVoiceInput {
  readonly guildId: string;
  readonly channelId: string;
  /**
   * When present, the slash invoker who saw the join disclosure in their
   * ephemeral reply and is auto-opted-in. An asked join (ADR 0062) omits it:
   * nobody is opted in — the asker included — until they run
   * `/clankie voice-consent opt-in`, which carries the residency disclosure.
   */
  readonly invokingUserId?: string;
  readonly adapterCreator: DiscordGatewayAdapterCreator;
}

export interface DiscordVoiceSessionStatus {
  readonly active: boolean;
  readonly guildId?: string;
  readonly channelId?: string;
  readonly daveProtocolVersion?: number;
  readonly consentedParticipantCount: number;
  readonly activeCaptureCount: number;
  /** Additive (ADR 0057): whether the floor machine currently holds the floor. */
  readonly floorState: FloorState;
  /**
   * Additive (ADR 0057): whether the engaged conversation session is
   * connected. It can outlive the floor across the {@link ENGAGED_HOLD_MS}
   * window, so `engaged` may be true while `floorState` is `"dormant"`.
   */
  readonly engaged: boolean;
}

/**
 * What this media owner needs from the dormant listener. Structural rather
 * than the concrete `RealtimeTranscriptionSession` class so tests can inject
 * a recording fake; the real session satisfies it as-is.
 */
export interface VoiceTranscriptionPort {
  readonly isOpen: boolean;
  appendAudio(pcm: Buffer): void;
  close(): void;
}

/** The engaged tier's surface, structural for the same reason. */
export interface VoiceConversationPort {
  readonly isOpen: boolean;
  appendAudio(pcm: Buffer): void;
  createTextItem(text: string): void;
  createResponse(): void;
  truncate(itemId: string, audioEndMs: number): void;
  submitFunctionResult(callId: string, output: string): void;
  close(): void;
}

export interface VoiceTranscriptionHandlers {
  readonly onTranscript: (event: RealtimeTranscriptEvent) => void;
  readonly onClose: (reason: RealtimeSessionCloseReason) => void;
  readonly onError: (message: string) => void;
}

export interface VoiceConversationOpenInput {
  readonly instructions: string;
  readonly onAudioDelta: (pcm: Buffer, itemId: string) => void;
  readonly onFunctionCall: (call: RealtimeFunctionCall) => void;
  readonly onResponseDone: (meta: RealtimeResponseMeta) => void;
  readonly onClose: (reason: RealtimeSessionCloseReason) => void;
  readonly onError: (message: string) => void;
}

/**
 * The bridge composes the T2 runtimes (credential resolution, socket factory,
 * models) behind these two openers; the session only decides *when* they open
 * and what flows through them.
 */
export interface DiscordVoiceRealtimePorts {
  openTranscription(handlers: VoiceTranscriptionHandlers): Promise<VoiceTranscriptionPort>;
  openConversation(input: VoiceConversationOpenInput): Promise<VoiceConversationPort>;
}

export interface DiscordVoiceBriefingRequest {
  readonly guildId: string;
  readonly channelId: string;
  /** The current explicit consents; the control plane resolves person memory for exactly these ids. */
  readonly consentedUserIds: readonly string[];
}

export interface DiscordVoiceBriefing {
  /** Composed persona + lane + surface rules — the session's identity, never authored here. */
  readonly instructions: string;
  /** The bounded briefing projection, seeded as a text item at engage time. */
  readonly briefing: string;
}

export interface DiscordVoiceSessionOptions {
  /** The UNCHANGED `discord_voice` captain lane; `ask_clankie` is its only voice caller. */
  readonly ingress: DiscordVoiceIngress;
  readonly realtime: DiscordVoiceRealtimePorts;
  /** Fetched at engage time so the wake carries current state, not join-time state. */
  readonly briefing: (request: DiscordVoiceBriefingRequest) => Promise<DiscordVoiceBriefing>;
  readonly floor: VoiceFloorOptions;
  /**
   * The volition call from ADR 0057: given bounded room text, does he have
   * something worth saying? Absent means every offer is suppressed — still
   * accounted, so the counters stay honest. Errors count as suppressed.
   */
  readonly volitionDecider?: (roomText: string) => Promise<boolean>;
  /**
   * Floor for how often a possessor's narration may trigger a spoken response.
   * Seeding is never rate-limited; only speaking is. Defaults to
   * {@link DEFAULT_NARRATION_MIN_INTERVAL_MS}.
   */
  readonly narrationMinIntervalMs?: number;
  readonly presenceSessionId: () => string;
  readonly emit: (evidence: DiscordVoiceEvidence) => Promise<void>;
  /**
   * Who counts as consented to being heard (ADR 0045). Defaults to `explicit`;
   * `presence` is the owner's call for a private room whose participants know
   * he transcribes when he is in it.
   */
  readonly consentPolicy?: DiscordVoiceConsentPolicy;
  /**
   * Who is currently sitting in the voice channel, supplied by whoever holds
   * the gateway. Ids only; this package never touches a Discord client.
   *
   * Needed because "who consented" and "who may be heard" stop being the same
   * set under the `presence` policy (ADR 0071): presence *is* consent there, so
   * the explicit opt-in list stays empty while the whole room is permitted. The
   * briefing resolves person memory for whoever may be heard, and reading the
   * explicit list meant it resolved memory for nobody — he could hear the room
   * and had no idea who was in it. Absent falls back to the explicit list,
   * which is exactly right under the `explicit` policy.
   */
  readonly channelOccupants?: (guildId: string, channelId: string) => readonly string[];
  /** Monotonic milliseconds; defaults to `performance.now`. Injected by tests. */
  readonly clock?: () => number;
  /** Timer seam shared with the realtime runtimes; drives decay ticks, the hold window, and reconnect backoff. */
  readonly timers?: RealtimeTimers;
}

/** One `response.create` decision awaiting its audio; receipts are cut from these. */
interface PendingVoiceResponse {
  readonly deliveryId: string;
  readonly wake: DiscordVoiceWake;
  readonly fastPath: boolean;
  readonly turnId?: string;
  readonly state: "settled" | "waiting_user";
  readonly handoffMs: number;
  readonly decidedAtMs: number;
  firstAudioAtMs?: number;
  /** Set when the server finished the response this decision produced. */
  done: boolean;
}

/** A gateway speaking span: authenticated identity plus capture lifecycle times. */
interface SpeakingSpan {
  readonly userId: string;
  readonly startedAtMs: number;
  endedAtMs?: number;
}

/** One response's streamed playback: a raw-PCM stream fed by deltas, played in order. */
interface PlaybackJob {
  readonly pending: PendingVoiceResponse;
  readonly itemId: string;
  readonly stream: PassThrough;
  /**
   * Every Discord-rate buffer written into the stream. They are zeroed when
   * playback of this job ends rather than at write time: the stream holds the
   * exact buffer reference until the player reads it, so zeroing at write
   * time would silence audio still in flight. End-of-playback zeroing
   * preserves the discipline — nothing outlives its turn — without
   * corrupting it.
   */
  readonly buffers: Buffer[];
  readonly generation: number;
  startedAtMs?: number;
}

const defaultTimers: RealtimeTimers = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export class DiscordVoiceSession {
  private readonly options: DiscordVoiceSessionOptions;
  /** Injectable so latency assertions are deterministic in tests. */
  private readonly clock: () => number;
  private readonly timers: RealtimeTimers;
  private readonly consent: DiscordVoiceConsentRegistry;
  private readonly player: AudioPlayer;
  private floor: VoiceFloor;
  private connection: VoiceConnection | undefined;
  private guildId: string | undefined;
  private channelId: string | undefined;
  private daveProtocolVersion: number | undefined;
  private readonly captures = new Map<string, AudioReceiveStream>();
  /** Serializes `ask_clankie` handoffs so two results never talk over each other. */
  private turnQueue: Promise<void> = Promise.resolve();
  /** Serializes engage/seed/respond so a second wake cannot race session setup. */
  private conversationOps: Promise<void> = Promise.resolve();
  /** Serializes playback so queued responses speak in order. */
  private playbackChain: Promise<void> = Promise.resolve();
  private sessionGeneration = 0;
  private transcription: VoiceTranscriptionPort | undefined;
  private conversation: VoiceConversationPort | undefined;
  private lastAnnouncedSpeakerId: string | undefined;
  private speakingSpans: SpeakingSpan[] = [];
  /** Lines stored as buffers so {@link leave} can zero the bytes, not merely drop references. */
  private transcriptRing: Buffer[] = [];
  /** Possessors listening to the room; see {@link subscribeTranscript}. Never retains. */
  private readonly transcriptListeners = new Set<(line: string) => void>();
  /** Rate-limits possessor narration responses so play does not become a monologue. */
  private lastNarrationResponseAtMs = Number.NEGATIVE_INFINITY;
  private readonly narrationMinIntervalMs: number;
  private pendingResponses: PendingVoiceResponse[] = [];
  /** The job whose stream still receives deltas. */
  private openPlayback: PlaybackJob | undefined;
  /** The job currently at the player. */
  private playingJob: PlaybackJob | undefined;
  private tickHandle: unknown;
  private holdHandle: unknown;
  private reconnectHandle: unknown;
  private reconnectDelayMs = RECONNECT_BACKOFF_INITIAL_MS;

  private readonly onSpeakingStart = (userId: string): void => {
    if (this.guildId === undefined || this.channelId === undefined) return;
    // The consent boundary (ADR 0045/0057, mission criterion 3): an
    // unconsented participant is never subscribed, so their audio can never
    // reach an input_audio_buffer.append.
    if (!this.consent.permits(this.guildId, this.channelId, userId)) return;
    if (this.captures.size > 0 && !this.captures.has(userId)) {
      void this.emitSafely({
        type: "overlap",
        guildId: this.guildId,
        channelId: this.channelId,
        userId,
        activeCaptureCount: this.captures.size + 1,
      });
    }
    void this.capture(userId);
  };

  public constructor(options: DiscordVoiceSessionOptions) {
    this.options = options;
    this.clock = options.clock ?? (() => performance.now());
    this.timers = options.timers ?? defaultTimers;
    this.consent = new DiscordVoiceConsentRegistry(options.consentPolicy);
    this.floor = new VoiceFloor(options.floor);
    this.narrationMinIntervalMs = options.narrationMinIntervalMs ?? DEFAULT_NARRATION_MIN_INTERVAL_MS;
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
  }

  public async join(input: JoinDiscordVoiceInput): Promise<DiscordVoiceSessionStatus> {
    await this.leave();
    this.guildId = input.guildId;
    this.channelId = input.channelId;
    // A fresh floor per call: volition accounting and rate caps are
    // per-session, exactly like consent.
    this.floor = new VoiceFloor(this.options.floor);
    this.consent.open(input.guildId, input.channelId, input.invokingUserId);
    const connection = joinVoiceChannel({
      guildId: input.guildId,
      channelId: input.channelId,
      adapterCreator: input.adapterCreator,
      selfDeaf: false,
      selfMute: false,
      daveEncryption: true,
    });
    this.connection = connection;
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT_MS);
      const protocolVersion = await waitForDave(connection, DAVE_READY_TIMEOUT_MS);
      this.daveProtocolVersion = protocolVersion;
      // The dormant listener is his ears and opens with the call. A join
      // without it would be silent deafness, so failure fails the join.
      await this.openTranscriptionNow();
      connection.receiver.speaking.on("start", this.onSpeakingStart);
      connection.subscribe(this.player);
      await this.emitSafely({
        type: "joined",
        guildId: input.guildId,
        channelId: input.channelId,
        daveProtocolVersion: protocolVersion,
      });
      if (input.invokingUserId !== undefined) {
        await this.emitSafely({
          type: "consent",
          guildId: input.guildId,
          channelId: input.channelId,
          userId: input.invokingUserId,
          consented: true,
          participantCount: 1,
        });
      }
      return this.status();
    } catch (error) {
      await this.leave();
      throw error;
    }
  }

  public async setConsent(
    guildId: string,
    channelId: string,
    userId: string,
    consented: boolean,
  ): Promise<DiscordVoiceSessionStatus> {
    const session = this.consent.set(guildId, channelId, userId, consented);
    // Revocation destroys the live capture, which stops its appends; the
    // decoder's data handler re-checks consent per chunk and zeroes stragglers.
    if (!consented) this.captures.get(userId)?.destroy();
    await this.emitSafely({
      type: "consent",
      guildId,
      channelId,
      userId,
      consented,
      participantCount: session.consentedUserIds.size,
    });
    return this.status();
  }

  public memberChannelChanged(guildId: string, userId: string, channelId: string | undefined): void {
    if (guildId !== this.guildId) return;
    this.consent.memberChannelChanged(userId, channelId);
    if (channelId !== this.channelId) this.captures.get(userId)?.destroy();
  }

  public async leave(): Promise<void> {
    const guildId = this.guildId;
    const channelId = this.channelId;
    const connection = this.connection;
    connection?.receiver.speaking.off("start", this.onSpeakingStart);
    for (const capture of this.captures.values()) capture.destroy();
    this.captures.clear();
    this.player.stop(true);
    this.consent.close();
    this.connection = undefined;
    this.guildId = undefined;
    this.channelId = undefined;
    this.daveProtocolVersion = undefined;
    this.sessionGeneration += 1;
    this.stopTick();
    this.cancelHold();
    if (this.reconnectHandle !== undefined) {
      this.timers.clearTimeout(this.reconnectHandle);
      this.reconnectHandle = undefined;
    }
    this.reconnectDelayMs = RECONNECT_BACKOFF_INITIAL_MS;
    const transcription = this.transcription;
    this.transcription = undefined;
    try {
      transcription?.close();
    } catch {
      // Already closed; leaving is idempotent.
    }
    const conversation = this.conversation;
    this.conversation = undefined;
    try {
      conversation?.close();
    } catch {
      // Already closed; leaving is idempotent.
    }
    this.lastAnnouncedSpeakerId = undefined;
    for (const line of this.transcriptRing) line.fill(0);
    this.transcriptRing = [];
    this.speakingSpans = [];
    this.pendingResponses = [];
    if (this.openPlayback !== undefined) {
      this.openPlayback.stream.end();
      this.openPlayback = undefined;
    }
    // An in-flight playback job finalizes against the bumped generation: it
    // zeroes its buffers and emits nothing.
    if (connection !== undefined && connection.state.status !== VoiceConnectionStatus.Destroyed) {
      connection.destroy();
    }
    if (guildId !== undefined && channelId !== undefined) {
      await this.emitSafely({ type: "left", guildId, channelId });
    }
  }

  /**
   * A possessor's report of what just happened in the body (ADR 0064).
   *
   * The text is seeded as a conversation item and **never spoken verbatim**.
   * What Clankie says about walking into a wall is his to compose, in the voice
   * the briefing already gave him, folded in with whatever the room is saying —
   * the possessor supplies the event, the persona supplies the words. This is
   * ADR 0047's fence restated for speech: possession changes who decides what
   * the body does, never who is present or how he sounds.
   *
   * Rejects when he is not in a voice channel, so a possessor learns that
   * nobody heard it rather than believing it spoke.
   */
  public async narrate(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) throw new Error("voice_narration_empty");
    const guildId = this.guildId;
    const channelId = this.channelId;
    if (guildId === undefined || channelId === undefined) {
      throw new Error("voice_narration_not_in_channel");
    }
    const generation = this.sessionGeneration;
    this.cancelHold();
    const queued = this.conversationOps.then(async () => {
      if (generation !== this.sessionGeneration) return;
      let wake: DiscordVoiceWake = "continuing";
      if (this.conversation === undefined) {
        wake = "waking";
        await this.openConversationNow(guildId, channelId);
        if (generation !== this.sessionGeneration || this.conversation === undefined) return;
      }
      const conversation = this.conversation;
      if (!conversation.isOpen) return;
      try {
        conversation.createTextItem(`While playing, Clankie just: ${trimmed}`);
      } catch {
        // Closed between frames; the close handler owns cleanup.
        return;
      }
      // Decided here rather than at call time, and deliberately: a play loop
      // fires narrations without awaiting them, so a decision made before the
      // queue would let every report in a burst independently conclude it was
      // the one allowed to speak.
      const respond =
        !this.isPlaying() && this.clock() - this.lastNarrationResponseAtMs >= this.narrationMinIntervalMs;
      if (!respond) return;
      this.armTick();
      this.lastNarrationResponseAtMs = this.clock();
      this.pendingResponses.push({
        deliveryId: randomUUID(),
        wake,
        fastPath: false,
        state: "settled",
        handoffMs: 0,
        decidedAtMs: this.clock(),
        done: false,
      });
      try {
        conversation.createResponse();
      } catch {
        this.pendingResponses.pop();
      }
    });
    this.conversationOps = queued.catch(() => undefined);
    await queued;
  }

  /**
   * Push-only access to the attributed transcript, for a possessor that is
   * driving the body and should hear the room it is playing in front of.
   *
   * Push rather than pull is a retention constraint: nothing new is stored to
   * serve this, so the bridge keeps retaining no transcripts. A subscriber sees
   * only lines that already passed the consent boundary and the ring.
   */
  public subscribeTranscript(listener: (line: string) => void): () => void {
    this.transcriptListeners.add(listener);
    return () => this.transcriptListeners.delete(listener);
  }

  public status(): DiscordVoiceSessionStatus {
    return {
      active: this.connection?.state.status === VoiceConnectionStatus.Ready,
      ...(this.guildId === undefined ? {} : { guildId: this.guildId }),
      ...(this.channelId === undefined ? {} : { channelId: this.channelId }),
      ...(this.daveProtocolVersion === undefined ? {} : { daveProtocolVersion: this.daveProtocolVersion }),
      consentedParticipantCount: this.consent.current()?.consentedUserIds.size ?? 0,
      activeCaptureCount: this.captures.size,
      floorState: this.floor.state,
      engaged: this.conversation !== undefined,
    };
  }

  // ------------------------------------------------------------------
  // Capture: per-user Opus → 48 kHz stereo PCM → 24 kHz mono, streamed.
  // ------------------------------------------------------------------

  private async capture(userId: string): Promise<void> {
    const connection = this.connection;
    const guildId = this.guildId;
    const channelId = this.channelId;
    if (
      connection === undefined ||
      guildId === undefined ||
      channelId === undefined ||
      this.captures.has(userId)
    ) {
      return;
    }
    const generation = this.sessionGeneration;
    const stream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: CAPTURE_END_SILENCE_MS },
    });
    this.captures.set(userId, stream);
    const span: SpeakingSpan = { userId, startedAtMs: this.clock() };
    this.speakingSpans.push(span);
    if (this.speakingSpans.length > MAX_SPEAKING_SPANS) {
      this.speakingSpans.splice(0, this.speakingSpans.length - MAX_SPEAKING_SPANS);
    }
    // The out-of-band identity item (ADR 0057): the gateway, not the audio,
    // says who is talking now.
    if (this.floor.state === "engaged") this.announceSpeaker(userId);
    const decoder = new opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
    let sourceBytes = 0;
    let convertedBytes = 0;
    let bargeInChecked = false;
    decoder.on("data", (chunk: Buffer) => {
      // Consent is re-checked per chunk: revocation destroys the capture, and
      // anything the decoder still had in flight is zeroed and dropped here,
      // before it can reach a session.
      if (generation !== this.sessionGeneration || !this.consent.permits(guildId, channelId, userId)) {
        chunk.fill(0);
        return;
      }
      sourceBytes += chunk.byteLength;
      if (!bargeInChecked && sourceBytes >= BARGE_IN_PCM_BYTES) {
        bargeInChecked = true;
        // Barge-in (a): only the floor holder talking over him truncates;
        // crosstalk between other people lets him finish (ADR 0057).
        if (userId === this.floor.floorHolderId) this.truncatePlayback(userId);
      }
      const converted = discordPcmToRealtimePcm(chunk);
      chunk.fill(0);
      convertedBytes += converted.byteLength;
      this.forwardAudio(converted);
    });
    let captureFailed = false;
    try {
      await pipeline(stream, decoder);
    } catch {
      captureFailed = true;
      if (generation === this.sessionGeneration && this.consent.permits(guildId, channelId, userId)) {
        await this.emitSafely({
          type: "failed",
          guildId,
          channelId,
          stage: "capture",
          code: "voice_capture_failed",
        });
      }
    } finally {
      this.captures.delete(userId);
      span.endedAtMs = this.clock();
    }
    if (captureFailed || generation !== this.sessionGeneration) return;
    if (!this.consent.permits(guildId, channelId, userId)) return;
    const durationMs = Math.round((convertedBytes / (REALTIME_AUDIO_SAMPLE_RATE * PCM_SAMPLE_BYTES)) * 1_000);
    if (durationMs < MIN_UTTERANCE_MS) return;
    await this.emitSafely({
      type: "utterance",
      guildId,
      channelId,
      userId,
      deliveryId: randomUUID(),
      durationMs,
    });
  }

  /**
   * Streams one converted 24 kHz mono buffer into the open sessions, sliced
   * to the realtime append cap. Both sessions zero what they are handed (T2's
   * contract), so the conversation gets a copy and the transcription consumes
   * — and thereby zeroes — the original; a slice with no listener to take it
   * is zeroed here. Nothing is ever buffered for later.
   */
  private forwardAudio(converted: Buffer): void {
    const conversation = this.conversation;
    // While engaged the conversation session also hears the room. During the
    // hold window (floor dormant, session kept warm) it deliberately does
    // not: overheard chatter must not grow a priced context.
    const conversationListening =
      this.floor.state === "engaged" && conversation !== undefined && conversation.isOpen;
    for (let offset = 0; offset < converted.byteLength; offset += MAX_REALTIME_AUDIO_APPEND_BYTES) {
      const slice = converted.subarray(
        offset,
        Math.min(offset + MAX_REALTIME_AUDIO_APPEND_BYTES, converted.byteLength),
      );
      if (conversationListening) {
        try {
          conversation.appendAudio(Buffer.from(slice));
        } catch {
          // Closed between frames; appendAudio zeroed the copy either way.
        }
      }
      const transcription = this.transcription;
      if (transcription !== undefined && transcription.isOpen) {
        try {
          transcription.appendAudio(slice);
        } catch {
          slice.fill(0);
        }
      } else {
        // No listener (reconnect in flight): dropped, never buffered.
        slice.fill(0);
      }
    }
  }

  // ------------------------------------------------------------------
  // Transcripts: attribution, the ring, and floor decisions.
  // ------------------------------------------------------------------

  private handleTranscript(event: RealtimeTranscriptEvent): void {
    if (!event.final) return;
    const guildId = this.guildId;
    const channelId = this.channelId;
    if (guildId === undefined || channelId === undefined) return;
    const text = event.text.trim();
    if (text.length === 0) return;
    const speakerId = this.attributeSpeaker();
    // Audio cannot have reached the listener without a consented capture, so
    // a missing span means a stale transcript from before a leave/restart.
    if (speakerId === undefined) return;
    this.pushTranscriptLine(speakerId, text);
    // Barge-in (b): being re-addressed while playing truncates deliberately,
    // whichever consented speaker says it.
    if (this.isPlaying() && voiceAddressesCharacter(text, this.options.floor.names)) {
      this.truncatePlayback(speakerId);
    }
    const decision = this.floor.observeTranscript({ speakerId, text, atMs: this.clock() });
    this.applyFloorDecision(decision, speakerId, guildId, channelId);
  }

  /**
   * Most-recent-active heuristic (ADR 0057): a final transcript is attributed
   * to the gateway speaking span overlapping its arrival — the open span with
   * the latest start or, when every span has closed (VAD finalizes after the
   * silence that ended the capture), the span that ended most recently.
   * Attribution never comes from the audio or the transcript content.
   */
  private attributeSpeaker(): string | undefined {
    let active: SpeakingSpan | undefined;
    let recent: SpeakingSpan | undefined;
    for (const span of this.speakingSpans) {
      if (span.endedAtMs === undefined) {
        if (active === undefined || span.startedAtMs >= active.startedAtMs) active = span;
      } else if (recent?.endedAtMs === undefined || span.endedAtMs >= recent.endedAtMs) {
        recent = span;
      }
    }
    return active?.userId ?? recent?.userId;
  }

  private pushTranscriptLine(speakerId: string, text: string): void {
    const line = `${speakerId}: ${text}`;
    this.transcriptRing.push(Buffer.from(line, "utf8"));
    for (const listener of this.transcriptListeners) {
      try {
        listener(line);
      } catch {
        // A possessor that throws on hearing must not break the room.
      }
    }
    let totalBytes = 0;
    for (const line of this.transcriptRing) totalBytes += line.byteLength;
    while (
      this.transcriptRing.length > TRANSCRIPT_RING_MAX_LINES ||
      (totalBytes > TRANSCRIPT_RING_MAX_BYTES && this.transcriptRing.length > 1)
    ) {
      const evicted = this.transcriptRing.shift();
      if (evicted === undefined) break;
      totalBytes -= evicted.byteLength;
      evicted.fill(0);
    }
  }

  private ringText(): string {
    return this.transcriptRing.map((line) => line.toString("utf8")).join("\n");
  }

  private applyFloorDecision(
    decision: FloorDecision,
    speakerId: string,
    guildId: string,
    channelId: string,
  ): void {
    switch (decision.action) {
      case "wake": {
        void this.emitSafely({
          type: "floor",
          guildId,
          channelId,
          state: "engaged",
          // The evidence enum has no reply-policy variant: a policy wake is
          // still "spoke and was answered", so it reports as addressed.
          reason: decision.reason === "volition" ? "volition" : "addressed",
        });
        this.queueEngagedResponse(speakerId, guildId, channelId);
        return;
      }
      case "hold": {
        this.queueEngagedResponse(speakerId, guildId, channelId);
        return;
      }
      case "release": {
        void this.emitSafely({
          type: "floor",
          guildId,
          channelId,
          state: "dormant",
          reason: decision.reason === "explicit" ? "released" : "decay",
        });
        this.stopTick();
        this.armHold();
        return;
      }
      case "volition_gate_open": {
        this.runVolition(guildId, channelId);
        return;
      }
      case "ignore":
        return;
    }
  }

  private runVolition(guildId: string, channelId: string): void {
    const generation = this.sessionGeneration;
    const decider = this.options.volitionDecider;
    // Absent decider ⇒ every offer suppressed, still accounted; a decider
    // error counts as suppressed and must not crash the session.
    const verdict =
      decider === undefined
        ? Promise.resolve(false)
        : Promise.resolve()
            .then(() => decider(this.ringText()))
            .catch(() => false);
    void verdict.then(async (taken) => {
      if (generation !== this.sessionGeneration) return;
      const outcome = this.floor.noteVolitionOutcome(taken);
      if (outcome.action === "wake") {
        await this.emitSafely({ type: "floor", guildId, channelId, state: "engaged", reason: "volition" });
        const speakerId = this.floor.floorHolderId ?? this.attributeSpeaker();
        if (speakerId !== undefined) this.queueEngagedResponse(speakerId, guildId, channelId);
      }
      await this.emitSafely({ type: "volition", guildId, channelId, ...this.floor.accounting() });
    });
  }

  // ------------------------------------------------------------------
  // The engaged session: open, seed, respond.
  // ------------------------------------------------------------------

  /**
   * Queues one respond-to-the-room decision. Waking (no session) pays
   * briefing + open + seeding; continuing (session held open, including
   * across a release inside the hold window) goes straight to the response.
   * The distinction is receipt-visible per ADR 0057, or the wake cost would
   * be invisible.
   */
  private queueEngagedResponse(speakerId: string, guildId: string, channelId: string): void {
    const generation = this.sessionGeneration;
    this.cancelHold();
    this.armTick();
    this.conversationOps = this.conversationOps
      .then(async () => {
        if (generation !== this.sessionGeneration) return;
        let wake: DiscordVoiceWake = "continuing";
        if (this.conversation === undefined) {
          wake = "waking";
          await this.openConversationNow(guildId, channelId);
          if (generation !== this.sessionGeneration || this.conversation === undefined) return;
        }
        this.announceSpeaker(speakerId);
        this.pendingResponses.push({
          deliveryId: randomUUID(),
          wake,
          fastPath: true,
          state: "settled",
          handoffMs: 0,
          decidedAtMs: this.clock(),
          done: false,
        });
        try {
          this.conversation.createResponse();
        } catch {
          this.pendingResponses.pop();
        }
      })
      .catch(() => undefined);
  }

  private async openConversationNow(guildId: string, channelId: string): Promise<void> {
    const generation = this.sessionGeneration;
    let briefing: DiscordVoiceBriefing;
    try {
      briefing = await this.options.briefing({
        guildId,
        channelId,
        // Who may be heard, not who filled in a form: under the `presence`
        // policy those are different sets and only the first one is the room.
        consentedUserIds: this.consent.permitted(
          guildId,
          channelId,
          this.options.channelOccupants?.(guildId, channelId) ?? [],
        ),
      });
    } catch {
      await this.emitSafely({
        type: "failed",
        guildId,
        channelId,
        stage: "conversation_session",
        code: "voice_briefing_failed",
      });
      return;
    }
    if (generation !== this.sessionGeneration) return;
    let port: VoiceConversationPort;
    try {
      port = await this.options.realtime.openConversation({
        instructions: briefing.instructions,
        onAudioDelta: (pcm, itemId) => {
          if (generation === this.sessionGeneration) this.handleAudioDelta(pcm, itemId);
          else pcm.fill(0);
        },
        onFunctionCall: (call) => {
          if (generation === this.sessionGeneration) this.handleFunctionCall(call, guildId, channelId);
        },
        onResponseDone: () => {
          if (generation === this.sessionGeneration) this.handleResponseDone();
        },
        onClose: (reason) => {
          this.handleConversationClose(reason, generation, guildId, channelId);
        },
        onError: () => undefined,
      });
    } catch {
      await this.emitSafely({
        type: "failed",
        guildId,
        channelId,
        stage: "conversation_session",
        code: "voice_conversation_open_failed",
      });
      return;
    }
    if (generation !== this.sessionGeneration) {
      try {
        port.close();
      } catch {
        // The stale session is gone either way.
      }
      return;
    }
    this.conversation = port;
    this.lastAnnouncedSpeakerId = undefined;
    try {
      // Seed order: what he overheard, then who he is. The ring is the
      // bounded recent-transcript window; the briefing is the projection that
      // keeps the fast path from being ignorant (ADR 0057).
      const ring = this.ringText();
      if (ring.length > 0) port.createTextItem(`Recent room transcript:\n${ring}`);
      const briefingText = briefing.briefing.trim();
      if (briefingText.length > 0) port.createTextItem(briefingText);
    } catch {
      // Closed during seeding; the close handler owns cleanup.
    }
  }

  private announceSpeaker(speakerId: string): void {
    const conversation = this.conversation;
    if (conversation === undefined || !conversation.isOpen) return;
    if (this.lastAnnouncedSpeakerId === speakerId) return;
    try {
      conversation.createTextItem(`Speaker: ${speakerId}`);
      this.lastAnnouncedSpeakerId = speakerId;
    } catch {
      // Closed between frames; the close handler owns cleanup.
    }
  }

  private handleConversationClose(
    reason: RealtimeSessionCloseReason,
    generation: number,
    guildId: string,
    channelId: string,
  ): void {
    if (generation !== this.sessionGeneration) return;
    this.conversation = undefined;
    this.lastAnnouncedSpeakerId = undefined;
    this.cancelHold();
    // Decisions that can no longer produce audio are dropped so a later
    // session's audio cannot be attributed to a dead decision. Whatever is
    // already streaming or playing finishes and receipts normally.
    const keep = new Set<PendingVoiceResponse>();
    if (this.playingJob !== undefined) keep.add(this.playingJob.pending);
    if (this.openPlayback !== undefined) {
      this.openPlayback.stream.end();
      keep.add(this.openPlayback.pending);
      this.openPlayback = undefined;
    }
    this.pendingResponses = this.pendingResponses.filter((pending) => keep.has(pending));
    if (reason === "closed") return;
    void this.emitSafely({
      type: "failed",
      guildId,
      channelId,
      stage: "conversation_session",
      code: "voice_conversation_lost",
    });
    // The floor machine owns floor state and exposes no forced release; after
    // an unexpected session loss it converges on its own — the next wake or
    // hold reopens lazily (it finds no session and pays a fresh wake), and
    // silence decays the floor via the tick.
  }

  // ------------------------------------------------------------------
  // The ability path: ask_clankie → the unchanged captain lane.
  // ------------------------------------------------------------------

  private handleFunctionCall(call: RealtimeFunctionCall, guildId: string, channelId: string): void {
    // ask_clankie is the model's entire tool surface; anything else is
    // hallucinated and ignored.
    if (call.name !== ASK_CLANKIE_TOOL_NAME) return;
    // The decision that produced this call carries the wake classification;
    // the spoken result belongs to the same exchange.
    const wake = this.pendingResponses.find((candidate) => !candidate.done)?.wake ?? "continuing";
    const generation = this.sessionGeneration;
    this.turnQueue = this.turnQueue
      .then(() => this.handleAskClankie(call, wake, generation, guildId, channelId))
      .catch(() => undefined);
  }

  private async handleAskClankie(
    call: RealtimeFunctionCall,
    wake: DiscordVoiceWake,
    generation: number,
    guildId: string,
    channelId: string,
  ): Promise<void> {
    if (generation !== this.sessionGeneration) return;
    const request = parseAskClankieRequest(call.argumentsJson);
    if (request === undefined) {
      this.submitFunctionResultSafely(call.callId, CAPTAIN_UNREACHABLE_TEXT);
      await this.emitSafely({
        type: "failed",
        guildId,
        channelId,
        stage: "captain_handoff",
        code: "voice_ask_clankie_arguments_invalid",
      });
      return;
    }
    // Attribution for the captain turn: the floor holder is who he is
    // talking with; failing that, the most recent gateway speaker. Never the
    // audio, never the transcript content.
    const userId = this.floor.floorHolderId ?? this.attributeSpeaker();
    if (userId === undefined) {
      this.submitFunctionResultSafely(call.callId, CAPTAIN_UNREACHABLE_TEXT);
      await this.emitSafely({
        type: "failed",
        guildId,
        channelId,
        stage: "captain_handoff",
        code: "voice_ask_clankie_no_speaker",
      });
      return;
    }
    const deliveryId = randomUUID();
    const startedAtMs = this.clock();
    let outcome: DiscordVoiceTurnOutcome;
    try {
      outcome = await this.options.ingress.handle({
        deliveryId,
        guildId,
        channelId,
        userId,
        transcript: request,
        presenceSessionId: this.options.presenceSessionId(),
      });
    } catch {
      // The session must not hang on a captain failure: a short fixed
      // sentence goes back so the model can close the exchange.
      if (generation !== this.sessionGeneration) return;
      this.submitFunctionResultSafely(call.callId, CAPTAIN_UNREACHABLE_TEXT);
      await this.emitSafely({
        type: "failed",
        guildId,
        channelId,
        stage: "captain_handoff",
        code: "voice_captain_handoff_failed",
      });
      return;
    }
    const handoffMs = this.clock() - startedAtMs;
    if (generation !== this.sessionGeneration) return;
    if (outcome.state === "failed") {
      this.submitFunctionResultSafely(call.callId, CAPTAIN_UNREACHABLE_TEXT);
      await this.emitSafely({
        type: "failed",
        guildId,
        channelId,
        stage: "captain_handoff",
        code: sanitizeFailureCode(outcome.code),
      });
      return;
    }
    if (outcome.state === "declined") {
      // The captain chose silence (defensive — voice never offers the
      // decline path). Nothing is spoken and nothing is receipted; the
      // function call is left unresolved rather than provoking a response
      // whose audio would only be dropped, because deciding to stay quiet
      // must not cost a response (ADR 0051 via ADR 0057).
      return;
    }
    // waiting_user keeps DiscordVoiceIngress's authenticated-surface handoff
    // text: ambient voice still cannot approve privileged work.
    this.pendingResponses.push({
      deliveryId,
      wake,
      fastPath: false,
      turnId: outcome.turnId,
      state: outcome.state,
      handoffMs,
      decidedAtMs: this.clock(),
      done: false,
    });
    if (!this.submitFunctionResultSafely(call.callId, outcome.response)) {
      this.pendingResponses.pop();
    }
  }

  private submitFunctionResultSafely(callId: string, output: string): boolean {
    const conversation = this.conversation;
    if (conversation === undefined) return false;
    try {
      conversation.submitFunctionResult(callId, output);
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------
  // Playback: streamed deltas, in order, deliberately interruptible.
  // ------------------------------------------------------------------

  private handleAudioDelta(pcm: Buffer, itemId: string): void {
    // Server responses run one at a time, so audio belongs to the oldest
    // decision the server has not finished yet.
    const pending = this.pendingResponses.find((candidate) => !candidate.done);
    if (pending === undefined) {
      // Audio with no outstanding decision is stale; zero and drop.
      pcm.fill(0);
      return;
    }
    if (pending.firstAudioAtMs === undefined) pending.firstAudioAtMs = this.clock();
    let discordPcm: Buffer;
    try {
      discordPcm = openAiPcmToDiscordPcm(pcm);
    } catch {
      pcm.fill(0);
      return;
    }
    // Delta zeroing is this caller's duty per T2's contract.
    pcm.fill(0);
    if (this.openPlayback === undefined || this.openPlayback.pending !== pending) {
      this.openPlayback?.stream.end();
      const job: PlaybackJob = {
        pending,
        itemId,
        stream: new PassThrough(),
        buffers: [],
        generation: this.sessionGeneration,
      };
      this.openPlayback = job;
      this.playbackChain = this.playbackChain.then(() => this.playJob(job)).catch(() => undefined);
    }
    this.openPlayback.buffers.push(discordPcm);
    this.openPlayback.stream.write(discordPcm);
  }

  private handleResponseDone(): void {
    if (this.openPlayback !== undefined) {
      this.openPlayback.stream.end();
      this.openPlayback = undefined;
    }
    const settled = this.pendingResponses.find((candidate) => !candidate.done);
    if (settled === undefined) return;
    settled.done = true;
    if (settled.firstAudioAtMs === undefined) {
      // The response spoke nothing: a function-call round trip (whose
      // follow-up response carries the speech) or a model that chose
      // silence. No audio, nothing to receipt.
      this.pendingResponses = this.pendingResponses.filter((candidate) => candidate !== settled);
    }
  }

  private async playJob(job: PlaybackJob): Promise<void> {
    const guildId = this.guildId;
    const channelId = this.channelId;
    if (job.generation !== this.sessionGeneration || guildId === undefined || channelId === undefined) {
      for (const buffer of job.buffers) buffer.fill(0);
      this.pendingResponses = this.pendingResponses.filter((candidate) => candidate !== job.pending);
      return;
    }
    this.playingJob = job;
    job.startedAtMs = this.clock();
    this.player.play(createAudioResource(job.stream, { inputType: StreamType.Raw }));
    try {
      await entersState(this.player, AudioPlayerStatus.Idle, PLAYBACK_TIMEOUT_MS);
    } catch {
      this.player.stop(true);
      void this.emitSafely({
        type: "failed",
        guildId,
        channelId,
        stage: "playback",
        code: "voice_playback_timeout",
      });
    } finally {
      const playbackMs = Math.max(0, this.clock() - (job.startedAtMs ?? this.clock()));
      this.playingJob = undefined;
      for (const buffer of job.buffers) buffer.fill(0);
      const pending = job.pending;
      const stillTracked = this.pendingResponses.includes(pending);
      this.pendingResponses = this.pendingResponses.filter((candidate) => candidate !== pending);
      if (job.generation === this.sessionGeneration && stillTracked) {
        // His own speech is a reason to hold the floor; playback refreshes
        // decay.
        this.floor.noteAssistantSpokeAt(this.clock());
        await this.emitSafely({
          type: "response",
          guildId,
          channelId,
          deliveryId: pending.deliveryId,
          ...(pending.turnId === undefined ? {} : { turnId: pending.turnId }),
          state: pending.state,
          fastPath: pending.fastPath,
          wake: pending.wake,
          toFirstAudioMs: Math.max(
            0,
            Math.round((pending.firstAudioAtMs ?? pending.decidedAtMs) - pending.decidedAtMs),
          ),
          handoffMs: Math.round(pending.handoffMs),
          playbackMs: Math.round(playbackMs),
        });
      }
    }
  }

  private isPlaying(): boolean {
    return this.playingJob !== undefined && this.player.state.status === AudioPlayerStatus.Playing;
  }

  /**
   * Deliberate barge-in (ADR 0057): `interrupt_response` is off, so nothing
   * truncates him automatically. This stops the player and issues
   * `conversation.item.truncate` at the played offset, so what the room heard
   * and what the conversation context retains agree.
   */
  private truncatePlayback(userId: string): void {
    const job = this.playingJob;
    const guildId = this.guildId;
    const channelId = this.channelId;
    if (job === undefined || guildId === undefined || channelId === undefined) return;
    if (this.player.state.status !== AudioPlayerStatus.Playing) return;
    const playedMs = Math.max(0, Math.round(this.clock() - (job.startedAtMs ?? this.clock())));
    try {
      this.conversation?.truncate(job.itemId, playedMs);
    } catch {
      // The session may have closed; stopping playback still matters.
    }
    this.player.stop(true);
    void this.emitSafely({ type: "interrupted", guildId, channelId, userId, phase: "playing" });
  }

  // ------------------------------------------------------------------
  // The dormant listener: open, reconnect, never silently deaf.
  // ------------------------------------------------------------------

  private async openTranscriptionNow(): Promise<void> {
    const generation = this.sessionGeneration;
    const guildId = this.guildId;
    const channelId = this.channelId;
    if (guildId === undefined || channelId === undefined) {
      throw new Error("Discord voice session is not joined");
    }
    const port = await this.options.realtime.openTranscription({
      onTranscript: (event) => {
        if (generation === this.sessionGeneration) this.handleTranscript(event);
      },
      onClose: (reason) => {
        this.handleTranscriptionClose(reason, generation, guildId, channelId);
      },
      onError: () => undefined,
    });
    if (generation !== this.sessionGeneration) {
      try {
        port.close();
      } catch {
        // The stale session is gone either way.
      }
      throw new Error("Discord voice session ended while its listener was opening");
    }
    this.transcription = port;
    this.reconnectDelayMs = RECONNECT_BACKOFF_INITIAL_MS;
  }

  private handleTranscriptionClose(
    reason: RealtimeSessionCloseReason,
    generation: number,
    guildId: string,
    channelId: string,
  ): void {
    if (generation !== this.sessionGeneration) return;
    this.transcription = undefined;
    // "closed" is a local close — leave() shutting his ears on purpose.
    if (reason === "closed") return;
    void this.emitSafely({
      type: "failed",
      guildId,
      channelId,
      stage: "transcription_session",
      code: "voice_listener_lost",
    });
    this.scheduleListenerReconnect();
  }

  private scheduleListenerReconnect(): void {
    if (this.reconnectHandle !== undefined) return;
    const generation = this.sessionGeneration;
    const delayMs = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_BACKOFF_CAP_MS);
    this.reconnectHandle = this.timers.setTimeout(() => {
      this.reconnectHandle = undefined;
      if (generation !== this.sessionGeneration || this.connection === undefined) return;
      void this.openTranscriptionNow().catch(() => {
        this.scheduleListenerReconnect();
      });
    }, delayMs);
  }

  // ------------------------------------------------------------------
  // Timers: the decay tick and the engaged-hold window.
  // ------------------------------------------------------------------

  private armTick(): void {
    if (this.tickHandle !== undefined) return;
    const generation = this.sessionGeneration;
    this.tickHandle = this.timers.setTimeout(() => {
      this.tickHandle = undefined;
      if (generation !== this.sessionGeneration) return;
      const guildId = this.guildId;
      const channelId = this.channelId;
      if (guildId === undefined || channelId === undefined) return;
      const decision = this.floor.tick(this.clock());
      if (decision.action === "release") {
        void this.emitSafely({ type: "floor", guildId, channelId, state: "dormant", reason: "decay" });
        this.armHold();
        return;
      }
      if (this.floor.state === "engaged") this.armTick();
    }, ENGAGED_TICK_MS);
  }

  private stopTick(): void {
    if (this.tickHandle === undefined) return;
    this.timers.clearTimeout(this.tickHandle);
    this.tickHandle = undefined;
  }

  private armHold(): void {
    this.cancelHold();
    if (this.conversation === undefined) return;
    const generation = this.sessionGeneration;
    this.holdHandle = this.timers.setTimeout(() => {
      this.holdHandle = undefined;
      if (generation !== this.sessionGeneration) return;
      if (this.floor.state === "engaged") return;
      try {
        this.conversation?.close();
      } catch {
        // Already closed.
      }
    }, ENGAGED_HOLD_MS);
  }

  private cancelHold(): void {
    if (this.holdHandle === undefined) return;
    this.timers.clearTimeout(this.holdHandle);
    this.holdHandle = undefined;
  }

  /**
   * Evidence is telemetry: a failing emitter must never eat a reply, stall
   * playback, or leak into the media path.
   */
  private async emitSafely(evidence: DiscordVoiceEvidence): Promise<void> {
    try {
      await this.options.emit(evidence);
    } catch {
      // Deliberately swallowed.
    }
  }
}

function parseAskClankieRequest(argumentsJson: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const request = (parsed as Record<string, unknown>).request;
    if (typeof request !== "string") return undefined;
    const trimmed = request.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

/** Evidence codes are machine tokens; a captain code is normalized, never trusted. */
function sanitizeFailureCode(code: string): string {
  const normalized = code
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]/gu, "_")
    .slice(0, 64);
  return normalized.length === 0 ? "voice_captain_turn_failed" : normalized;
}

async function waitForDave(connection: VoiceConnection, timeoutMs: number): Promise<number> {
  const current = (): number | undefined => {
    if (
      connection.state.status !== VoiceConnectionStatus.Ready ||
      connection.state.networking.state.code !== NetworkingStatusCode.Ready
    ) {
      return undefined;
    }
    const version = connection.state.networking.state.dave?.protocolVersion;
    return version !== undefined && version > 0 ? version : undefined;
  };
  const ready = current();
  if (ready !== undefined) return ready;
  return new Promise((resolvePromise, reject) => {
    const onChange = (): void => {
      const version = current();
      if (version !== undefined) settle(() => resolvePromise(version));
    };
    const timeout = setTimeout(
      () => settle(() => reject(new Error("Discord DAVE encryption did not become ready"))),
      timeoutMs,
    );
    const settle = (finish: () => void): void => {
      clearTimeout(timeout);
      connection.off("transitioned", onChange);
      connection.off("stateChange", onChange);
      finish();
    };
    connection.on("transitioned", onChange);
    connection.on("stateChange", onChange);
  });
}
