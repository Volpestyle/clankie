import type { VoiceBodyAdmission } from "./body-voice-lease.ts";
import { type VoxClient } from "@clankie/vox-client";
import { Buffer } from "node:buffer";
import type {
  DiscordVoiceEvidence,
  DiscordVoiceTranscriptLogEntry,
  DiscordVoiceResponseTrigger,
  DiscordVoiceWake,
} from "@clankie/protocol";
import {
  SELF_TOOL_NAMES,
  REALTIME_AUDIO_SAMPLE_RATE,
  type RealtimeFunctionCall,
  type RealtimeResponseMeta,
  type RealtimeResponseAttempt,
  type RealtimeSessionCloseDetail,
  type RealtimeSessionCloseReason,
  type RealtimeTimers,
  type RealtimeTranscriptEvent,
} from "./realtime-session.ts";
import { PCM_SAMPLE_BYTES } from "./voice-audio.ts";
import { DiscordVoiceConsentRegistry, type DiscordVoiceConsentPolicy } from "./voice-consent.ts";
import { VoiceFloor, type FloorDecision, type FloorState, type VoiceFloorOptions } from "./voice-floor.ts";
import type { VoiceHandoffPort } from "./voice-ingress.ts";
import { VoiceMusicQueue } from "./voice-music.ts";

/** Shorter than this is noise, not an utterance; it earns no receipt. */
export const MIN_UTTERANCE_MS = 350;

/**
 * How rarely a play narration may make him speak (ADR 0064). A play loop
 * reports constantly — every step, every bump — and answering each one would
 * turn a voice channel into a monologue nobody can talk over. Seeding is
 * unbounded; only the spoken response waits.
 */
export const DEFAULT_NARRATION_MIN_INTERVAL_MS = 12_000;

/**
 * Silence that closes and commits a capture. Audio streams while the speaker
 * talks, but only a final transcript can trigger a reply. Keep a pause allowance
 * without adding the old 800ms to every exchange.
 */
export const CAPTURE_END_SILENCE_MS = 500;

/** Runaway backstop with headroom for an earned 20–30 second riff, not a target. */
export const MAX_SPOKEN_RESPONSE_MS = 45_000;

export const HANDOFF_ACKNOWLEDGMENT_MS = 1_200;

/**
 * How much of a captain answer enters the voice conversation. A spoken turn
 * needs the gist; a report read aloud is a monologue and its full text is
 * context the room keeps paying for. The rest stays with the captain.
 */
export const VOICE_HANDOFF_RESULT_CHARACTERS = 1_500;

/** A handoff answer this late, after the room kept talking, is offered rather than delivered. */
export const STALE_HANDOFF_MS = 30_000;

/** A spoken search lists only its top hits; the model names one or two. */
export const SPOKEN_SEARCH_RESULTS = 3;

/** Near silence only; deliberately far below the 1,200 RMS interruption gate. */
export const CAPTURE_NOISE_RMS = 80;

/** Preserve quiet word onsets before the first above-floor frame (200ms). */
export const CAPTURE_PREROLL_BYTES = (REALTIME_AUDIO_SAMPLE_RATE * PCM_SAMPLE_BYTES) / 5;

/**
 * Speech-level audio required before a consented speaker is treated as talking
 * over him. Only overlapping audio counts, and a substantive transcript must
 * confirm it before playback is truncated.
 */
export const BARGE_IN_PCM_BYTES = Math.round(
  REALTIME_AUDIO_SAMPLE_RATE * PCM_SAMPLE_BYTES * (MIN_UTTERANCE_MS / 1_000),
);

/**
 * How loud capture audio must be, as RMS in raw s16 units (full scale 32_768),
 * before it counts toward {@link BARGE_IN_PCM_BYTES}. An open mic streams room
 * tone continuously — every burst of it clears the duration bar — so duration
 * alone once truncated him mid-sentence on a fan or a keystroke while the
 * transcript for the very same capture came back empty.
 *
 * A calibration knob, not a derived constant: room tone sits near 300 and
 * conversational speech runs 2_000–6_000, but every mic and noise-suppression
 * setting moves both. Raise it if a quiet room still cuts him off; lower it if
 * a soft talker cannot interrupt him.
 */
export const BARGE_IN_SPEECH_RMS = 1_200;

/**
 * Sustained talk-over that yields the floor without waiting for a transcript:
 * 700 ms of speech-level audio (the {@link BARGE_IN_SPEECH_RMS} gate) from a
 * recently engaged speaker whose capture began after his reply became audible.
 *
 * The transcript-confirmed path costs the rest of their sentence, 500 ms of
 * packet silence and finalization — 1.5–3 s of him talking over someone. This
 * rule acts on the audio alone, so it is deliberately narrower than that path:
 * a 350 ms loudness rule once cut him off on a short fragment (VUH-1440), and
 * backchannels ("yeah", "mm-hm") and false starts run well under 700 ms of
 * speech-level audio. A capture already open when he started is an open mic or
 * someone he started over; it still waits for its transcript. Calibration
 * knob, untested live.
 */
export const ONSET_YIELD_PCM_BYTES = Math.round(REALTIME_AUDIO_SAMPLE_RATE * PCM_SAMPLE_BYTES * 0.7);

export const VOICE_READY_TIMEOUT_MS = 20_000;

export const DAVE_READY_TIMEOUT_MS = 10_000;

/** A provider that has not confirmed the join probe by then cannot be shown to hear. */
export const PROBE_ACCEPTANCE_TIMEOUT_MS = 5_000;

export const PLAYBACK_TIMEOUT_MS = 2 * 60_000;

/** A continuously open mic is one bounded recording, even when Discord never sends silence. */
export const DEFAULT_VOICE_RECORDING_LIMIT_MS = 3 * 60_000;

/** Enough time for an already audible reply and a short farewell; broken providers cannot hold a call. */
export const DEFAULT_VOICE_GRACEFUL_END_TIMEOUT_MS = 60_000;

// Synthesis can outrun speech. Keep at most one second ahead of real time,
// in 100ms writes, instead of bursting an entire answer into Vox's 15s queue.
export const PLAYBACK_CHUNK_BYTES = (REALTIME_AUDIO_SAMPLE_RATE * PCM_SAMPLE_BYTES) / 10;

export const PLAYBACK_LEAD_MS = 1_000;

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

/** Keeps the floor warm while `ask_clankie` is in flight (ADR 0119). */
export const FLOOR_WORK_HEARTBEAT_MS = 15_000;

/**
 * How long the work heartbeat may hold the floor before it gives up.
 *
 * `stopFloorWork` runs in a `finally`, which never fires for a promise that
 * never settles — a wedged transport, not a slow captain. Without a bound the
 * heartbeat would refresh decay forever, and decay is the *only* self-heal
 * this session has: release arms the hold window, the hold window closes the
 * conversation, and the close drops the stale function call so the next
 * utterance opens a clean session. Matched to the captain's own stall
 * watchdog, so a handoff still working is never cut off by this.
 */
export const FLOOR_WORK_MAX_MS = 5 * 60_000;

/** Close a speaker's metered listener after this much silence. */
export const SPEAKER_TRANSCRIPTION_IDLE_MS = 2 * 60_000;

/**
 * The transcript ring is the only retention inside the voice session: recent
 * final lines used to seed an engaged session, including the one opened to
 * offer him an unprompted turn. An owner-enabled development subscriber may
 * persist the same consented finals outside this core (ADR 0121). ~30 lines /
 * ~4 000 bytes holds the last few minutes of a lively room and stays well
 * inside a single bounded realtime text item.
 */
export const TRANSCRIPT_RING_MAX_LINES = 30;

export const TRANSCRIPT_RING_MAX_BYTES = 4_000;

/**
 * How long a finalized transcript may wait for an earlier-started overlapping
 * capture to finish, so floor order follows who started speaking. Addressed
 * speech is never held — a re-address must cut him off now.
 */
export const UTTERANCE_REORDER_GRACE_MS = 400;

/**
 * Turn gating for crosstalk. An unaddressed response opportunity waits while
 * another participant is still talking or their final transcript is due, so a
 * busy room asks him once per lull instead of once per utterance — a newer
 * line replaces the waiting one, and he still decides whether to speak.
 * Addressed and name-mention turns never wait.
 *
 * Bounds keep the wait from becoming silence: a capture older than
 * {@link TURN_GATE_CAPTURE_MAX_MS} (an open mic, a monologue) stops counting,
 * a final more than {@link TURN_GATE_FINAL_WAIT_MS} overdue stops counting,
 * and continuous crosstalk still yields one opportunity per
 * {@link TURN_GATE_MAX_WAIT_MS}.
 */
export const TURN_GATE_CAPTURE_MAX_MS = 8_000;

export const TURN_GATE_FINAL_WAIT_MS = 2_500;

export const TURN_GATE_MAX_WAIT_MS = 8_000;

/** The service schema bounds person-memory projection to this many room members. */
export const MAX_BRIEFING_SPEAKERS = 25;

/** A broken transcriber cannot retain content-free capture ids without bound. */
export const MAX_PENDING_TRANSCRIPT_TURNS = 32;

/** Failed provider item ids retained only long enough to reject late PCM. */
export const MAX_INVALID_PLAYBACK_ITEM_IDS = 32;

/** Matches the service's bounded participant projection and caps live sockets. */
export const MAX_SPEAKER_TRANSCRIPTION_SESSIONS = 25;

/**
 * Listener reconnect backoff: 1 s doubling to a 30 s cap, forever while
 * joined. The transcription session is his ears — a mid-call disconnect must
 * not silently deafen him (ADR 0057 risk), so the retry never gives up.
 */
export const RECONNECT_BACKOFF_INITIAL_MS = 1_000;

export const RECONNECT_BACKOFF_CAP_MS = 30_000;

/**
 * Spoken when the captain handoff fails. Fixed and content-free on purpose:
 * a failure sentence must never echo request or error detail into the room.
 */
export const CAPTAIN_UNREACHABLE_TEXT =
  "I couldn't reach my captain for that just now. Give me a moment and ask again.";

export const SPEAKERLESS_ASK_RESULT =
  "No person asked for an action in this response. Continue without using ask_clankie.";

/**
 * What the room's own Clankie is told when the floor machine offers him an
 * unprompted turn (ADR 0057). The mechanical half — may a turn be offered at
 * all — is the rate cap's; *this* is the half that needs a personality, so it
 * is asked of the realtime session that has one rather than of a bounded
 * yes/no model that has none. Marked as a system note so the model cannot read
 * it as something a participant said, and explicit that saying nothing is a
 * real answer: a response the model declines to fill produces no audio, which
 * the session accounts as a suppressed offer.
 */
export const UNPROMPTED_TURN_ITEM =
  "System note, not spoken by anyone in the room: nobody addressed you. You may say something on " +
  "your own if you actually have something worth saying to these people right now. If you do not, " +
  "produce no output at all — staying quiet is a normal, correct answer, and most of these are.";

/**
 * Every room utterance is available for his judgment. The line is already in
 * the session; he may stay silent for crosstalk or answer a contextual request.
 */
export const ENGAGED_OFFER_TURN_ITEM =
  "System note, not spoken by anyone in the room: this room utterance is an opportunity to respond. " +
  "Decide from the attributed conversation whether it is directed to you or worth answering anyway. " +
  "If it is clearly for someone else, produce no output at all. Silence is the correct answer then.";

/**
 * Offered when his name came up. Address matching is deliberately loose so a
 * garbled "hey clankie" still opens the session; talking-about-him vs talking
 * to him is this turn's job. Silence is correct when they mentioned him to
 * someone else.
 */
export const ADDRESSED_OFFER_TURN_ITEM =
  "System note, not spoken by anyone in the room: your name came up. " +
  "Speak if they are talking to you. If they mentioned you while talking to someone else, " +
  "produce no output at all. Silence is the correct answer then.";

export interface JoinDiscordVoiceInput {
  /** Host-only admission, acquired before any gateway/session effect. */
  readonly bodyLease?: VoiceBodyAdmission;
  readonly guildId: string;
  readonly channelId: string;
  /**
   * When present, the slash invoker who saw the join disclosure in their
   * ephemeral reply and is auto-opted-in, or the authenticated owner in the
   * owner-only lab body. An official-bot asked join (ADR 0062) omits it:
   * invitation context never opts anyone into capture.
   */
  readonly invokingUserId?: string;
  /** Invitation context only: independent of capture consent and tool authority. */
  readonly arrival?: {
    readonly requestedBy: string;
    readonly requestText?: string;
  };
}

export interface DiscordVoiceSessionStatus {
  readonly outputMuted: boolean;
  readonly handoffCount: number;
  readonly activity: "speaking" | "listening" | "thinking" | "idle" | "unknown";
  readonly outputControlUncertain?: boolean;
  readonly speakers?: readonly { userId: string; displayName?: string }[];
  readonly active: boolean;
  readonly guildId?: string;
  readonly channelId?: string;
  readonly daveProtocolVersion?: number;
  /** Content-free id for this join→leave; absent when he is not in a channel. */
  readonly stayId?: string;
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
  /** Host cap/sleep shutdown has stopped admitting new captures and replies. */
  readonly ending?: boolean;
}

export interface DiscordVoiceAnnouncementResult {
  /** Spoken means correlated Vox playback drained; provider generation alone is insufficient. */
  readonly outcome: "spoken" | "incomplete" | "inactive";
}

export interface DiscordVoiceGracefulEndResult {
  readonly outcome: "finished" | "incomplete" | "inactive";
  readonly announcement: DiscordVoiceAnnouncementResult["outcome"];
}

/** Exact final speech after consent and authenticated Discord attribution. */
export interface DiscordVoiceTranscript {
  readonly occurredAt: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly stayId?: string;
  readonly deliveryId: string;
  readonly speakerId: string;
  readonly displayName?: string;
  readonly text: string;
}

/**
 * One side of the conversation as it is spoken (VUH-2752): the owner's speech
 * as it is transcribed, or his reply as it is generated. Each event is the whole
 * line so far and replaces the previous one with the same `lineId`; `final`
 * closes it, and a final line with no text retracts it.
 */
export interface DiscordVoiceLiveTranscript {
  readonly speaker: "owner" | "clankie";
  readonly lineId: string;
  readonly text: string;
  readonly final: boolean;
}

export type DiscordVoiceSpokenTranscript = Omit<
  Extract<DiscordVoiceTranscriptLogEntry, { role: "assistant" }>,
  "schemaVersion" | "body"
>;

/**
 * What this media owner needs from the dormant listener. Structural rather
 * than the concrete `RealtimeTranscriptionSession` class so tests can inject
 * a recording fake; the real session satisfies it as-is.
 */
export interface VoiceTranscriptionPort {
  readonly isOpen: boolean;
  /** Settles when the provider confirms the session; rejects when it refuses first. */
  readonly accepted?: Promise<void>;
  appendAudio(pcm: Buffer): void;
  commitAudio(): void;
  close(): void;
}

/** The engaged tier's surface, structural for the same reason. */
export interface VoiceConversationPort {
  readonly isOpen: boolean;
  appendAudio(pcm: Buffer): void;
  createTextItem(text: string): void;
  /** Replace trusted persona instructions while preserving an admitted response/playback. */
  updateInstructions?(text: string): void;
  createImageItem(pngBase64: string, mimeType?: "image/png"): void;
  createResponse(context?: string, shouldStart?: () => boolean): void;
  /** Stops the provider generating (and an external mouth voicing) a reply nobody will hear. */
  cancelResponse(requestEventId: string): void;
  truncate(itemId: string, audioEndMs: number): void;
  submitFunctionResult(callId: string, output: string, shouldRespond?: false | (() => boolean)): void;
  /** Settle without a new continuation; only an already-waiting admitted turn may resume. */
  settleFunctionCallSilently?(callId: string, resume?: false): void;
  close(): void;
}

export interface VoiceTranscriptionHandlers {
  readonly onTranscript: (event: RealtimeTranscriptEvent) => void;
  readonly onClose: (reason: RealtimeSessionCloseReason, detail?: RealtimeSessionCloseDetail) => void;
  readonly onError: (message: string) => void;
}

export interface VoiceConversationOpenInput {
  /** Trusted admission checked after socket acquisition, before private configuration. */
  readonly guard?: () => Promise<void>;
  /** Synchronous final fence before provider construction after the awaited guard. */
  readonly current?: () => boolean;
  /** Private generated wording; separate from content-free receipts. */
  readonly onOutputTranscript?: (event: RealtimeTranscriptEvent, source: "native_audio" | "tts_text") => void;
  readonly instructions: string;
  readonly onAudioDelta: (pcm: Buffer, itemId: string) => void;
  /** Content-free notification before external synthesis waits for a clause. */
  readonly onFirstText?: (itemId: string) => void;
  readonly onFunctionCall: (call: RealtimeFunctionCall) => void;
  readonly onResponseStarted?: (attempt: RealtimeResponseAttempt) => void;
  readonly onResponseAbandoned?: (attempt: RealtimeResponseAttempt) => void;
  readonly onResponseDone: (meta: RealtimeResponseMeta) => void;
  readonly onClose: (reason: RealtimeSessionCloseReason, detail?: RealtimeSessionCloseDetail) => void;
  /** null explicitly means an idle mouth failure, with no utterance to attribute. */
  readonly onError: (message: string, itemId?: string | null) => void;
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
  /** Captured authenticated initiator; the host keeps tenant/persona owner separate. */
  readonly actorId?: string;
  /** The current explicit consents; the service resolves person memory for exactly these ids. */
  readonly consentedUserIds: readonly string[];
}

export interface DiscordVoiceBriefing {
  /** Composed persona + lane + surface rules — the session's identity, never authored here. */
  readonly instructions: string;
  /** The bounded briefing projection, seeded as a text item at engage time. */
  readonly briefing: string;
}

/** One self-tool call for the service's discord_voice lane (recall_episodes, get_self_state, remember_episode). */
export interface VoiceSelfToolCall {
  readonly guildId: string;
  readonly channelId: string;
  readonly speakerId?: string;
  readonly name: (typeof SELF_TOOL_NAMES)[number];
  readonly arguments: Record<string, unknown>;
}

export type LookAtScreenResult =
  | { readonly outcome: "not_playing" }
  | { readonly outcome: "pending" }
  | { readonly outcome: "still"; readonly pngBase64: string; readonly mimeType: "image/png" };

/** A person sitting in the channel. Display name is optional: some transports only have ids. */
export interface VoiceRoomOccupant {
  readonly userId: string;
  readonly displayName?: string;
  readonly isBot?: boolean;
}

/**
 * The media one voice session drives: exactly the Vox calls it makes. Vox, the
 * sole Discord media owner, is one; a device call (VUH-2682) is another, so
 * every room runs this one session rather than a second voice runtime.
 */
export type VoiceMediaPort = Pick<
  VoxClient,
  | "available"
  | "status"
  | "detail"
  | "onStatus"
  | "onEvent"
  | "onUserAudio"
  | "joinVoice"
  | "leaveVoice"
  | "sendAudio"
  | "finishTtsPlayback"
  | "stopTtsPlayback"
  | "subscribeUserAudio"
  | "unsubscribeUserAudio"
  | "musicPlay"
  | "musicStop"
  | "musicPause"
  | "musicResume"
  | "musicSetGain"
> & {
  /** Only Discord media is DAVE-encrypted; omitted means Discord, which must reach DAVE before speech. */
  readonly requiresDave?: boolean;
};

export interface DiscordVoiceSessionOptions {
  /** The room's media owner: Vox for Discord. The session never closes this shared process. */
  readonly vox: VoiceMediaPort;
  /** The UNCHANGED `discord_voice` captain lane for Discord; `ask_clankie` is its privileged caller. */
  readonly ingress: VoiceHandoffPort;
  /**
   * Read-only glance at the live play screen (ADR 0099). Absent or a
   * not-playing result is spoken as "I cannot see the screen."
   */
  readonly lookAtScreen?: () => Promise<LookAtScreenResult>;
  /** His own memory/self tools, answered by the service; absent says they are unavailable. */
  readonly selfTool?: (call: VoiceSelfToolCall) => Promise<string>;
  readonly realtime: DiscordVoiceRealtimePorts;
  /** Fetched at engage time so the wake carries current state, not join-time state. */
  readonly briefing: (request: DiscordVoiceBriefingRequest) => Promise<DiscordVoiceBriefing>;
  readonly floor: VoiceFloorOptions;
  /**
   * Floor for how often a play narration may trigger a spoken response.
   * Seeding is never rate-limited; only speaking is. Defaults to
   * {@link DEFAULT_NARRATION_MIN_INTERVAL_MS}.
   */
  readonly narrationMinIntervalMs?: number;
  /** Bounds each consented per-speaker capture by both elapsed time and PCM duration. */
  readonly recordingLimitMs?: number;
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
   * the gateway. This package never touches a Discord client.
   *
   * Needed because "who consented" and "who may be heard" stop being the same
   * set under the `presence` policy (ADR 0071): presence *is* consent there, so
   * the explicit opt-in list stays empty while the whole room is permitted. The
   * briefing resolves person memory for whoever may be heard, and reading the
   * explicit list meant it resolved memory for nobody — he could hear the room
   * and had no idea who was in it. Display names ride the same snapshot so
   * utterances can be labeled as "Alice", not only a snowflake. Absent falls
   * back to the explicit list, which is exactly right under the `explicit`
   * policy.
   */
  readonly channelOccupants?: (guildId: string, channelId: string) => readonly VoiceRoomOccupant[];
  /** Optional gateway-observed room names, used only for conversation discovery. */
  readonly roomNames?: (
    guildId: string,
    channelId: string,
  ) => { readonly guildName?: string; readonly channelName?: string } | undefined;
  /** Monotonic milliseconds; defaults to `performance.now`. Injected by tests. */
  readonly clock?: () => number;
  /** Timer seam shared with the realtime runtimes; drives decay ticks, the hold window, and reconnect backoff. */
  readonly timers?: RealtimeTimers;
}

/** One `response.create` decision awaiting its audio; receipts are cut from these. */
export interface PendingVoiceResponse {
  requestEventId?: string;
  /** Allocated only for an explicit spoken-transcript subscriber. */
  outputTranscript?: {
    guildId: string;
    channelId: string;
    stayId?: string;
    itemId: string;
    text: string;
    textSource: "native_audio" | "tts_text";
    textComplete: boolean;
    emitted?: boolean;
    failed?: boolean;
  };
  readonly deliveryId: string;
  readonly wake: DiscordVoiceWake;
  readonly fastPath: boolean;
  /** Who prompted it: the room, or a play report from the body. */
  readonly trigger: DiscordVoiceResponseTrigger;
  /** Immutable gateway identity for the utterance that caused this exchange. */
  readonly speakerId?: string;
  readonly turnId?: string;
  readonly sourceText?: string;
  readonly state: "settled" | "waiting_user";
  readonly handoffMs: number;
  readonly decidedAtMs: number;
  /**
   * How the floor framed this turn. Settlement is per pending, not session-wide:
   * two quick offers must each settle, or the second loses armHold and volition
   * accounting (ADR 0057).
   */
  readonly offer?: "volition" | "engaged" | "addressed";
  /** Set once {@link DiscordVoiceSession.settleOffer} has recorded this turn. */
  offerSettled?: boolean;
  firstAudioAtMs?: number;
  audioBytes?: number;
  audioLimitReached?: boolean;
  /** Short-lived status opportunities expire when their work settles. */
  isCurrent?: () => boolean;
  firstTextAtMs?: number;
  firstAudioChunkAtMs?: number;
  readonly inputTiming?: VoiceInputTiming;
  inputTokens?: number;
  outputTokens?: number;
  /** No longer awaiting provider output: terminal event or explicit abandonment. */
  done: boolean;
  /** Playback failed before response.done; late media must not bind to this decision. */
  invalidated?: boolean;
  /** A newer interruption replaced this reply; retain its FIFO slot until done. */
  superseded?: boolean;
  responseMeta?: RealtimeResponseMeta;
  modelResponseEmitted?: boolean;
  /** Set synchronously when this response chose a function instead of speech. */
  toolCalled?: boolean;
  /** Only this host-authored response may start during a graceful cap/sleep ending. */
  hostNotice?: boolean;
  playbackOutcome?: PlaybackJob["outcome"];
}

interface VoiceInputTiming {
  lastAudioAtMs?: number;
  captureEndedAtMs?: number;
  transcriptFinalAtMs?: number;
}

export interface RoomTurn {
  readonly inputTiming?: VoiceInputTiming;
  readonly sourceText?: string;
  readonly userId: string;
  readonly deliveryId: string;
  readonly startedAtMs: number;
  readonly displayName?: string;
}

/** One gateway capture waiting for its speaker-bound final transcript. */
export interface PendingTranscriptTurn extends RoomTurn {
  /**
   * Loudest RMS seen while capturing, so an empty transcript can be told apart
   * from a silent one. Written by the capture loop, read once by the receipt.
   */
  peakRms?: number;
  overlapPlaybackId?: string;
  overlapSpeechBytes?: number;
}

export interface FinalizedUtterance {
  readonly turn: PendingTranscriptTurn;
  readonly text: string;
  readonly addressed: boolean;
  readonly finalizedAtMs: number;
}

export type RoomInputSource = "speech" | "text";

/** One response's correlated native Vox playback, queued in provider response order. */
export interface PlaybackJob {
  readonly pending: PendingVoiceResponse;
  readonly itemId: string;
  readonly playbackId: string;
  readonly encodedChunks: string[];
  readonly generation: number;
  providerDone: boolean;
  stopping: boolean;
  outcome?: "drained" | "stopped" | "failed" | "timeout";
  settle: ((result: "drained" | "stopped" | "failed" | "timeout") => void) | undefined;
  failureReason: string | undefined;
  startedAtMs?: number;
  sentUntilMs?: number;
  pumpTimer?: unknown;
  finishSent?: boolean;
}

export interface ActiveCapture {
  readonly userId: string;
  readonly captureId: string;
  readonly epoch: number;
  readonly generation: number;
  readonly turn: PendingTranscriptTurn;
  transcription?: VoiceTranscriptionPort;
  audioBytes: number;
  /** Bounded, private lead-in; wiped on forwarding, filtering, or cancellation. */
  preroll: Buffer;
  forwarding: boolean;
  limitTimer?: unknown;
}

/** Live state and cross-domain calls; factories select only the capabilities they use. */
export interface VoiceSessionContext {
  guildId: string | undefined;
  channelId: string | undefined;
  ending: boolean;
  voiceReady: boolean;
  readonly captures: Map<string, ActiveCapture>;
  sessionGeneration: number;
  readonly captureEpochs: Map<string, number>;
  readonly speakerLastActiveAtMs: Map<string, number>;
  readonly clock: () => number;
  readonly transcriptTurns: Map<string, PendingTranscriptTurn[]>;
  readonly consent: DiscordVoiceConsentRegistry;
  readonly options: DiscordVoiceSessionOptions;
  readonly timers: RealtimeTimers;
  readonly recordingLimitMs: number;
  playingJob: PlaybackJob | undefined;
  floor: VoiceFloor;
  roomResponseEpoch: number;
  quietEpoch: number;
  pendingResponses: PendingVoiceResponse[];
  readonly handoffs: Map<
    string,
    {
      userId: string;
      request: string;
      timer: unknown;
      quietEpoch: number;
      conversation: VoiceConversationPort | undefined;
    }
  >;
  readonly finalizedUtterances: FinalizedUtterance[];
  reorderHandle: unknown;
  conversation: VoiceConversationPort | undefined;
  lastRoomUserId: string | undefined;
  deferredOffer:
    | {
        readonly turn: RoomTurn;
        readonly guildId: string;
        readonly channelId: string;
        readonly offer: "engaged" | "addressed";
        readonly roomEpoch: number;
        readonly generation: number;
        readonly firstDeferredAtMs: number;
      }
    | undefined;
  deferredOfferHandle: unknown;
  transcriptRing: Buffer[];
  stayId: string | undefined;
  readonly transcriptListeners: Set<(line: string, transcript: DiscordVoiceTranscript) => void>;
  readonly transcriptions: Map<string, VoiceTranscriptionPort>;
  readonly transcriptionOpens: Map<string, Promise<VoiceTranscriptionPort>>;
  readonly transcriptionEpochs: Map<string, number>;
  readonly reconnectDelays: Map<string, number>;
  readonly reconnectHandles: Map<string, unknown>;
  readonly speakerIdleHandles: Map<string, unknown>;
  readonly liveTranscriptListeners: Set<(line: DiscordVoiceLiveTranscript) => void>;
  readonly liveSpeechLines: Map<string, string>;
  membershipDeliveryId: string | undefined;
  conversationOps: Promise<void>;
  roomEventUpdates: string[];
  workHeartbeatHandle: unknown;
  readonly speakerResponseEpochs: Map<string, number>;
  startingResponse: PendingVoiceResponse | undefined;
  bodyLease: VoiceBodyAdmission | undefined;
  readonly invalidPlaybackItemIds: Set<string>;
  readonly spokenTranscriptListeners: Set<(transcript: DiscordVoiceSpokenTranscript) => void>;
  hasResponseIdentity: boolean;
  openPlayback: PlaybackJob | undefined;
  roomEvents: string[];
  tickHandle: unknown;
  readonly floorWork: Map<string, { speakerId: string; startedAtMs: number }>;
  holdHandle: unknown;
  turnQueue: Promise<void>;
  readonly music: VoiceMusicQueue;
  roomRoster: Map<string, VoiceRoomOccupant>;
  outputMuted: boolean;
  playbackChain: Promise<void>;
  staySpokenCount: number;
  readonly outputStops: Map<string, PlaybackJob>;
  outputControlUncertain: boolean;
  emitSafely(evidence: DiscordVoiceEvidence): Promise<void>;
  isPlaying(): boolean;
  truncatePlayback(userId: string): void;
  cancelInFlight(pending: PendingVoiceResponse): void;
  hearIfOpen(turn: RoomTurn, text: string, source: RoomInputSource): void;
  applyFloorDecision(decision: FloorDecision, turn: RoomTurn, guildId: string, channelId: string): void;
  queueEngagedResponse(
    turn: RoomTurn,
    guildId: string,
    channelId: string,
    offer?: "volition" | "engaged" | "addressed",
    responseContext?: string,
    isCurrent?: () => boolean,
  ): void;
  labeledSpeech(
    speakerId: string,
    text: string,
    suppliedDisplayName?: string,
  ): { speakerId: string; displayName?: string; text: string };
  emitModelResponseCompletion(
    pending: PendingVoiceResponse,
    missingResponsePhase?: "completed" | "failed",
  ): void;
  publishLiveTranscript(line: DiscordVoiceLiveTranscript): void;
  handleAudioDelta(pcm: Buffer, itemId: string): void;
  handleFunctionCall(call: RealtimeFunctionCall, guildId: string, channelId: string): void;
  handleResponseAbandoned(attempt: RealtimeResponseAttempt): void;
  handleResponseDone(meta?: RealtimeResponseMeta): void;
  ringText(): string;
  pumpPlayback(job: PlaybackJob): void;
  emitSpokenTranscript(
    pending: PendingVoiceResponse,
    outcome: DiscordVoiceSpokenTranscript["outcome"],
    job?: PlaybackJob,
  ): void;
  leave(reason?: string): Promise<void>;
  startFloorWork(callId: string, speakerId: string): void;
  rosterText(guildId: string, channelId: string): string | undefined;
  stopFloorWork(callId?: string): void;
  responseGuard(pending: PendingVoiceResponse): () => boolean;
  leaveSafely(reason: string): void;
  settleOffer(pending: PendingVoiceResponse, taken: boolean): void;
  addStayTokens(pending: Pick<PendingVoiceResponse, "inputTokens" | "outputTokens">): void;
  queueMembershipResponse(): void;
}
