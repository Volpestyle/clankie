/**
 * Transport-neutral policy coordinator for one guild voice channel, rewired for
 * [ADR 0057](../../../docs/adr/0057-realtime-voice-with-captain-handoff.md)'s
 * two-tier realtime flow.
 *
 * Vox supplies authenticated per-user PCM streams; only explicitly consented
 * user ids are ever subscribed, so unconsented audio can never reach an
 * `input_audio_buffer.append` (mission criterion 3). Each consented speaker has
 * a separate transcription session: Discord's authenticated per-user streams
 * stay separate all the way through transcription, including during overlap.
 * Final attributed transcripts feed the {@link VoiceFloor}
 * machine, which alone decides when the engaged conversation session opens and
 * when `response.create` is issued. An open session hears every consented
 * utterance; only a wake, an in-window follow-up, or a volition offer spends
 * a turn.
 *
 * The captain never sits on the conversational critical path. The engaged
 * session's only privileged tool is `ask_clankie`, which serializes on the turn
 * queue and routes through the unchanged `discord_voice` captain lane
 * ({@link DiscordVoiceIngress}); approval-shaped results still come back as the
 * authenticated-surface handoff, so ambient voice cannot approve privileged
 * work.
 *
 * Speaker attribution comes from the Discord gateway's per-user streams
 * (criterion 5): every transcript callback is permanently bound to the user id
 * whose stream fed that transcriber, and the engaged model receives one
 * structured text item per utterance. Identity is never inferred from audio.
 */

import type { VoiceBodyAdmission } from "./body-voice-lease.ts";
import { type VoxControlEvent, type VoxUserAudioFrame } from "@clankie/vox-client";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { DiscordVoiceEvidence, DiscordVoiceWake } from "@clankie/protocol";
import {
  MAX_REALTIME_TEXT_ITEM_CHARACTERS,
  type RealtimeFunctionCall,
  type RealtimeResponseMeta,
  type RealtimeResponseAttempt,
  type RealtimeTimers,
} from "./realtime-session.ts";
import { VOICE_JOIN_REQUEST_MAX_CHARS } from "./voice-control.ts";
import { voiceAddressesCharacter } from "./voice-address.ts";
import { DiscordVoiceConsentRegistry } from "./voice-consent.ts";
import { VoiceFloor, type FloorDecision } from "./voice-floor.ts";
import { DISCORD_ROOM_TEXT_MAX_CHARS, type DiscordVoiceRoomTextInput } from "./room-text.ts";
import {
  createVoxMusicSink,
  VoiceMusicQueue,
  type VoiceMusicCommand,
  type VoiceMusicTraceEvent,
} from "./voice-music.ts";
import {
  DEFAULT_NARRATION_MIN_INTERVAL_MS,
  VOICE_READY_TIMEOUT_MS,
  DAVE_READY_TIMEOUT_MS,
  DEFAULT_VOICE_RECORDING_LIMIT_MS,
  DEFAULT_VOICE_GRACEFUL_END_TIMEOUT_MS,
  type JoinDiscordVoiceInput,
  type DiscordVoiceSessionStatus,
  type DiscordVoiceAnnouncementResult,
  type DiscordVoiceGracefulEndResult,
  type DiscordVoiceTranscript,
  type DiscordVoiceLiveTranscript,
  type DiscordVoiceSpokenTranscript,
  type VoiceTranscriptionPort,
  type VoiceConversationPort,
  type VoiceRoomOccupant,
  type DiscordVoiceSessionOptions,
  type PendingVoiceResponse,
  type RoomTurn,
  type PendingTranscriptTurn,
  type FinalizedUtterance,
  type RoomInputSource,
  type PlaybackJob,
  type ActiveCapture,
} from "./voice-session-context.ts";
import { waitForVoxEvent, sanitizeFailureCode } from "./voice-session-utils.ts";
import type { VoiceSessionContext } from "./voice-session-context.ts";
import { createVoiceInput } from "./voice-session-input.ts";
import { createVoiceConversation } from "./voice-session-conversation.ts";
import { createVoiceTools } from "./voice-session-tools.ts";
import { createVoicePlayback } from "./voice-session-playback.ts";

export {
  PROBE_ACCEPTANCE_TIMEOUT_MS,
  DEFAULT_VOICE_RECORDING_LIMIT_MS,
  DEFAULT_VOICE_GRACEFUL_END_TIMEOUT_MS,
  ENGAGED_HOLD_MS,
  ENGAGED_TICK_MS,
  FLOOR_WORK_HEARTBEAT_MS,
  FLOOR_WORK_MAX_MS,
  SPEAKER_TRANSCRIPTION_IDLE_MS,
  TRANSCRIPT_RING_MAX_LINES,
  TRANSCRIPT_RING_MAX_BYTES,
  UTTERANCE_REORDER_GRACE_MS,
  TURN_GATE_CAPTURE_MAX_MS,
  TURN_GATE_FINAL_WAIT_MS,
  CAPTAIN_UNREACHABLE_TEXT,
  UNPROMPTED_TURN_ITEM,
  ENGAGED_OFFER_TURN_ITEM,
  ADDRESSED_OFFER_TURN_ITEM,
  type JoinDiscordVoiceInput,
  type DiscordVoiceSessionStatus,
  type DiscordVoiceAnnouncementResult,
  type DiscordVoiceGracefulEndResult,
  type DiscordVoiceTranscript,
  type DiscordVoiceLiveTranscript,
  type DiscordVoiceSpokenTranscript,
  type VoiceTranscriptionPort,
  type VoiceConversationPort,
  type VoiceTranscriptionHandlers,
  type VoiceConversationOpenInput,
  type DiscordVoiceRealtimePorts,
  type DiscordVoiceBriefingRequest,
  type DiscordVoiceBriefing,
  type VoiceSelfToolCall,
  type LookAtScreenResult,
  type VoiceRoomOccupant,
  type VoiceMediaPort,
  type DiscordVoiceSessionOptions,
} from "./voice-session-context.ts";

const defaultTimers: RealtimeTimers = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export class DiscordVoiceSession {
  private readonly voiceInput: ReturnType<typeof createVoiceInput>;
  private readonly voiceConversation: ReturnType<typeof createVoiceConversation>;
  private readonly voiceTools: ReturnType<typeof createVoiceTools>;
  private readonly voicePlayback: ReturnType<typeof createVoicePlayback>;
  private readonly options: DiscordVoiceSessionOptions;
  /** Injectable so latency assertions are deterministic in tests. */
  private readonly clock: () => number;
  private readonly timers: RealtimeTimers;
  private readonly consent: DiscordVoiceConsentRegistry;
  public readonly music: VoiceMusicQueue;
  private floor: VoiceFloor;
  private guildId: string | undefined;
  private channelId: string | undefined;
  private connectionId: string | undefined;
  private voiceReady = false;
  private daveProtocolVersion: number | undefined;
  private readonly captures = new Map<string, ActiveCapture>();
  private readonly captureEpochs = new Map<string, number>();
  private readonly voxUnsubscribes: (() => void)[];
  private disposed = false;
  /** Serializes local music/screen operations; captain work never blocks these. */
  private turnQueue: Promise<void> = Promise.resolve();
  /** Serializes engage/seed/respond so a second wake cannot race session setup. */
  private conversationOps: Promise<void> = Promise.resolve();
  /** Serializes playback so queued responses speak in order. */
  private playbackChain: Promise<void> = Promise.resolve();
  private sessionGeneration = 0;
  /** One persistent transcription input per Discord user who has spoken. */
  private readonly transcriptions = new Map<string, VoiceTranscriptionPort>();
  private readonly transcriptionOpens = new Map<string, Promise<VoiceTranscriptionPort>>();
  /** Invalidates an open that resolves after revoke, departure, or idle eviction. */
  private readonly transcriptionEpochs = new Map<string, number>();
  private readonly transcriptTurns = new Map<string, PendingTranscriptTurn[]>();
  private readonly finalizedUtterances: FinalizedUtterance[] = [];
  private reorderHandle: unknown;
  /** The latest unaddressed opportunity, waiting for the room to pause (turn gating). */
  private deferredOffer:
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
  private deferredOfferHandle: unknown;
  private readonly speakerIdleHandles = new Map<string, unknown>();
  private readonly speakerLastActiveAtMs = new Map<string, number>();
  private conversation: VoiceConversationPort | undefined;
  private roomRoster = new Map<string, VoiceRoomOccupant>();
  private roomEvents: string[] = [];
  private roomEventUpdates: string[] = [];
  private membershipDeliveryId: string | undefined;
  /** Room lines stored as buffers so {@link leave} can zero the bytes, not merely drop references. */
  private transcriptRing: Buffer[] = [];
  /** Live consumers of the room; see {@link subscribeTranscript}. Never retains by itself. */
  private readonly spokenTranscriptListeners = new Set<(transcript: DiscordVoiceSpokenTranscript) => void>();
  /** Live lines as they are spoken; see {@link subscribeLiveTranscript}. Never retains by itself. */
  private readonly liveTranscriptListeners = new Set<(line: DiscordVoiceLiveTranscript) => void>();
  /** A speaker's line so far, by transcription item, for providers that stream deltas. */
  private readonly liveSpeechLines = new Map<string, string>();
  private readonly transcriptListeners = new Set<
    (line: string, transcript: DiscordVoiceTranscript) => void
  >();
  /** Rate-limits play narration responses so play does not become a monologue. */
  private lastNarrationResponseAtMs = Number.NEGATIVE_INFINITY;
  private readonly narrationMinIntervalMs: number;
  private readonly recordingLimitMs: number;
  private ending = false;
  private gracefulEnd: Promise<DiscordVoiceGracefulEndResult> | undefined;
  private stayId: string | undefined;
  private bodyLease: VoiceBodyAdmission | undefined;
  private stayInputTokens = 0;
  private stayOutputTokens = 0;
  private staySpokenCount = 0;
  private stayNarrationSuppressed = 0;
  private pendingResponses: PendingVoiceResponse[] = [];
  /** Selected by the existing queue guard, consumed when that exact request dispatches. */
  private startingResponse: PendingVoiceResponse | undefined;
  private hasResponseIdentity = false;
  private readonly speakerResponseEpochs = new Map<string, number>();
  private roomResponseEpoch = 0;
  private quietEpoch = 0;
  private readonly handoffs = new Map<
    string,
    {
      userId: string;
      request: string;
      timer: unknown;
      quietEpoch: number;
      conversation: VoiceConversationPort | undefined;
    }
  >();
  private readonly invalidPlaybackItemIds = new Set<string>();
  /** The job whose stream still receives deltas. */
  private openPlayback: PlaybackJob | undefined;
  /** The job currently active in Vox. */
  private playingJob: PlaybackJob | undefined;
  private tickHandle: unknown;
  private workHeartbeatHandle: unknown;
  private readonly floorWork = new Map<string, { speakerId: string; startedAtMs: number }>();
  private holdHandle: unknown;
  private readonly reconnectHandles = new Map<string, unknown>();
  private readonly reconnectDelays = new Map<string, number>();
  private lastRoomUserId: string | undefined;
  /** Bounded idempotency window for gateway MESSAGE_CREATE redelivery. */
  private readonly roomTextDeliveryIds = new Set<string>();

  private readonly onSpeakingStart = (userId: string): void => {
    if (this.ending || !this.voiceReady || this.guildId === undefined || this.channelId === undefined) return;
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
    this.recordingLimitMs = options.recordingLimitMs ?? DEFAULT_VOICE_RECORDING_LIMIT_MS;
    if (!Number.isSafeInteger(this.recordingLimitMs) || this.recordingLimitMs < 1)
      throw new Error("voice_recording_limit_invalid");
    const context = DiscordVoiceSession.voiceContext(this);
    this.voiceInput = createVoiceInput(context);
    this.voiceConversation = createVoiceConversation(context);
    this.voiceTools = createVoiceTools(context);
    this.voicePlayback = createVoicePlayback(context);
    const traceMusic = (event: VoiceMusicTraceEvent): void => this.handleMusicTrace(event);
    this.music = new VoiceMusicQueue({
      sinkKind: "audio",
      trace: traceMusic,
      sink: createVoxMusicSink({
        vox: options.vox,
        trace: traceMusic,
        onEnded: () => {
          void this.music.ended();
        },
      }),
    });
    this.music.setTrace(traceMusic);
    this.voxUnsubscribes = [
      options.vox.onEvent((event) => this.handleVoxEvent(event)),
      options.vox.onUserAudio((frame) => this.handleUserAudio(frame)),
      options.vox.onStatus((status) => {
        if (
          (status === "error" || status === "closed" || status === "missing") &&
          this.guildId !== undefined
        ) {
          this.leaveSafely("vox_process_lost");
        }
      }),
    ];
  }

  public async join(input: JoinDiscordVoiceInput): Promise<DiscordVoiceSessionStatus> {
    if (this.disposed) throw new Error("Discord voice session is disposed");
    await input.bodyLease?.guard();
    input.bodyLease?.start?.();
    await this.leave();
    await input.bodyLease?.guard();
    this.bodyLease = input.bodyLease;
    this.guildId = input.guildId;
    this.channelId = input.channelId;
    const connectionId = randomUUID();
    this.connectionId = connectionId;
    this.stayId = input.bodyLease?.stay.stayId ?? randomUUID();
    this.stayInputTokens = 0;
    this.stayOutputTokens = 0;
    this.staySpokenCount = 0;
    this.stayNarrationSuppressed = 0;
    // A fresh floor per call: offer accounting and rate caps are per-session,
    // exactly like consent.
    this.floor = new VoiceFloor(this.options.floor);
    this.consent.open(input.guildId, input.channelId, input.invokingUserId);
    const generation = this.sessionGeneration;
    const readinessAbort = new AbortController();
    const transportReady = waitForVoxEvent(
      this.options.vox,
      (event): event is Extract<VoxControlEvent, { type: "transport_state" }> =>
        event.type === "transport_state" &&
        event.role === "voice" &&
        event.connectionId === connectionId &&
        event.status === "ready",
      VOICE_READY_TIMEOUT_MS,
      "Discord voice transport did not become ready",
      readinessAbort.signal,
      connectionId,
    );
    const requiresDave = this.options.vox.requiresDave !== false;
    const daveReady = !requiresDave
      ? Promise.resolve(undefined)
      : waitForVoxEvent(
          this.options.vox,
          (event): event is Extract<VoxControlEvent, { type: "dave_state" }> =>
            event.type === "dave_state" &&
            event.role === "voice" &&
            event.connectionId === connectionId &&
            event.status === "ready" &&
            (event.protocolVersion ?? 0) > 0,
          DAVE_READY_TIMEOUT_MS,
          "Discord DAVE encryption did not become ready",
          readinessAbort.signal,
          connectionId,
        );
    const readiness = Promise.all([transportReady, daveReady]);
    try {
      this.options.vox.joinVoice({
        connectionId,
        guildId: input.guildId,
        channelId: input.channelId,
        selfMute: false,
      });
      const [, dave] = await readiness;
      // Zero records media without DAVE; Discord media must have negotiated a version.
      const protocolVersion = dave === undefined ? 0 : (dave.protocolVersion ?? 0);
      if (requiresDave && protocolVersion <= 0) {
        throw new Error("Discord DAVE encryption did not become ready");
      }
      if (requiresDave) this.daveProtocolVersion = protocolVersion;
      // Prove the transcription boundary at join time. Actual ears are opened
      // per authenticated speaker, so overlap can never corrupt attribution.
      await this.probeTranscription(input.guildId, input.channelId);
      if (
        generation !== this.sessionGeneration ||
        this.connectionId !== connectionId ||
        this.guildId !== input.guildId ||
        this.channelId !== input.channelId
      ) {
        throw new Error("Discord voice session ended while joining");
      }
      this.voiceReady = true;
      this.roomRoster = new Map(
        (this.options.channelOccupants?.(input.guildId, input.channelId) ?? []).map((occupant) => [
          occupant.userId,
          occupant,
        ]),
      );
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
      const requestedBy = input.arrival?.requestedBy ?? input.invokingUserId;
      const arrival = JSON.stringify({
        event: "self_joined",
        context: "You have arrived in this voice channel. You may speak or stay quiet.",
        ...(requestedBy === undefined ? {} : { requestedBy }),
        ...(input.arrival?.requestText === undefined
          ? {}
          : {
              requestText: input.arrival.requestText.slice(0, VOICE_JOIN_REQUEST_MAX_CHARS),
            }),
      });
      this.roomEvents.push(arrival);
      this.roomEventUpdates.push(arrival);
      this.membershipDeliveryId = randomUUID();
      this.queueMembershipResponse();
      return this.status();
    } catch (error) {
      readinessAbort.abort();
      await readiness.catch(() => undefined);
      await this.leave("join_failed");
      throw error;
    } finally {
      readinessAbort.abort();
    }
  }

  public async setConsent(
    guildId: string,
    channelId: string,
    userId: string,
    consented: boolean,
  ): Promise<DiscordVoiceSessionStatus> {
    const wasPermitted = this.consent.permits(guildId, channelId, userId);
    const session = this.consent.set(guildId, channelId, userId, consented);
    // Revocation invalidates the capture id before any late native PCM can
    // reach a transcription append.
    if (!consented) {
      this.cancelCapture(userId);
      this.releaseSpeakerTranscription(userId);
    }
    const isPermitted = this.consent.permits(guildId, channelId, userId);
    if (!wasPermitted && isPermitted) {
      this.refreshConversationBriefing(userId);
    } else if (wasPermitted && !isPermitted) {
      this.invalidateConversationForRosterChange();
    }
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
    const activeChannelId = this.channelId;
    if (guildId !== this.guildId || activeChannelId === undefined) return;
    this.consent.memberChannelChanged(userId, channelId);
    if (channelId !== activeChannelId) {
      this.cancelCapture(userId);
      this.releaseSpeakerTranscription(userId);
    }
    // Only the gateway knows membership. Vox disconnects can refer to a media
    // subscription and self voice updates must not masquerade as human events.
    const occupants = this.options.channelOccupants?.(guildId, activeChannelId);
    if (!this.voiceReady || occupants === undefined) return;
    const before = this.roomRoster.get(userId);
    const after = occupants.find((occupant) => occupant.userId === userId);
    this.roomRoster = new Map(occupants.map((occupant) => [occupant.userId, occupant]));
    if ((before === undefined) === (after === undefined)) return;
    const participant = after ?? before;
    if (participant === undefined) return;
    const humanCount = occupants.filter((occupant) => occupant.isBot !== true).length;
    const action = after === undefined ? "left" : "joined";
    const event = JSON.stringify({
      event: `participant_${action}`,
      userId,
      ...(participant.displayName === undefined
        ? {}
        : { displayName: participant.displayName.slice(0, 100) }),
      isBot: participant.isBot === true,
      humanCount,
      ...(humanCount === 0 ? { roomState: "You are alone with no humans in the channel." } : {}),
    });
    this.roomEvents.push(event);
    this.roomEvents = this.roomEvents.slice(-12);
    this.roomEventUpdates.push(event);
    this.roomEventUpdates = this.roomEventUpdates.slice(-12);
    const deliveryId = randomUUID();
    this.membershipDeliveryId = deliveryId;
    void this.emitSafely({
      type: "participant",
      guildId,
      channelId: activeChannelId,
      userId,
      action,
      humanCount,
      deliveryId,
    });
    // Departure revokes capture, not the conversation. Closing it here used
    // to discard in-flight captain results before Clankie could decide anything.
    if (after !== undefined && this.consent.permits(guildId, activeChannelId, userId)) {
      this.refreshConversationBriefing(userId);
    }
    this.queueMembershipResponse();
  }
  private queueMembershipResponse(): void {
    return this.voiceConversation.queueMembershipResponse();
  }

  public handleMusic(command: VoiceMusicCommand, requestedBy?: string): Promise<string> {
    return this.music.handle(command, requestedBy);
  }

  public async leave(reason = "session_leave"): Promise<void> {
    const guildId = this.guildId;
    const channelId = this.channelId;
    const stayId = this.stayId;
    const inputTokens = this.stayInputTokens;
    const outputTokens = this.stayOutputTokens;
    const spokenCount = this.staySpokenCount;
    const narrationSuppressed = this.stayNarrationSuppressed;
    const captureUserIds = [...this.captures.keys()];
    const transcriptions = [...this.transcriptions.values()];
    const conversation = this.conversation;
    const playbackJobs = new Set([this.openPlayback, this.playingJob]);
    for (const pending of this.pendingResponses) {
      const job = [...playbackJobs].find((candidate) => candidate?.pending === pending);
      this.emitSpokenTranscript(
        pending,
        pending.firstAudioAtMs === undefined ? "suppressed" : "interrupted",
        job,
      );
    }
    const transcriptRing = this.transcriptRing;

    // Vox commands are synchronous and may throw after process loss. Make the
    // local session inactive first so no failing cleanup command can preserve
    // stale authority, content, or media correlation.
    this.voiceReady = false;
    this.ending = false;
    this.gracefulEnd = undefined;
    this.outputMuted = false;
    this.outputControlUncertain = false;
    this.outputStops.clear();
    this.connectionId = undefined;
    this.guildId = undefined;
    this.channelId = undefined;
    this.stayId = undefined;
    this.bodyLease = undefined;
    this.stayInputTokens = 0;
    this.stayOutputTokens = 0;
    this.staySpokenCount = 0;
    this.stayNarrationSuppressed = 0;
    this.lastNarrationResponseAtMs = Number.NEGATIVE_INFINITY;
    this.daveProtocolVersion = undefined;
    this.sessionGeneration += 1;
    this.consent.close();
    for (const capture of this.captures.values()) {
      capture.preroll.fill(0);
      if (capture.limitTimer !== undefined) this.timers.clearTimeout(capture.limitTimer);
    }
    this.captures.clear();
    this.captureEpochs.clear();
    this.transcriptions.clear();
    this.transcriptionOpens.clear();
    this.transcriptionEpochs.clear();
    this.transcriptTurns.clear();
    this.finalizedUtterances.length = 0;
    this.conversation = undefined;
    this.transcriptRing = [];
    this.roomRoster.clear();
    this.roomEvents = [];
    this.roomEventUpdates = [];
    this.membershipDeliveryId = undefined;
    this.lastRoomUserId = undefined;
    this.roomTextDeliveryIds.clear();
    this.pendingResponses = [];
    this.roomResponseEpoch += 1;
    this.quietEpoch += 1;
    for (const handoff of this.handoffs.values()) this.timers.clearTimeout(handoff.timer);
    this.handoffs.clear();
    this.speakerResponseEpochs.clear();
    this.invalidPlaybackItemIds.clear();
    this.openPlayback = undefined;
    this.playingJob = undefined;
    this.playbackChain = Promise.resolve();
    this.turnQueue = Promise.resolve();
    this.conversationOps = Promise.resolve();
    this.floor = new VoiceFloor(this.options.floor);
    this.stopFloorWork();
    this.stopTick();
    this.cancelHold();
    for (const handle of this.reconnectHandles.values()) this.timers.clearTimeout(handle);
    this.reconnectHandles.clear();
    this.reconnectDelays.clear();
    for (const handle of this.speakerIdleHandles.values()) this.timers.clearTimeout(handle);
    this.speakerIdleHandles.clear();
    this.speakerLastActiveAtMs.clear();
    this.cancelReorderWait();
    this.dropDeferredOffer();
    for (const line of transcriptRing) line.fill(0);
    for (const job of playbackJobs) {
      if (job === undefined) continue;
      job.stopping = true;
      job.encodedChunks.length = 0;
      this.settlePlayback(job, "stopped");
    }

    for (const transcription of transcriptions) {
      try {
        transcription.close();
      } catch {
        // Already closed; leaving is idempotent.
      }
    }
    try {
      conversation?.close();
    } catch {
      // Already closed; leaving is idempotent.
    }
    this.music.stop();
    for (const userId of captureUserIds) {
      try {
        this.options.vox.unsubscribeUserAudio(userId);
      } catch {
        // Local capture state was already revoked.
      }
    }
    for (const job of playbackJobs) {
      if (job === undefined) continue;
      try {
        this.options.vox.stopTtsPlayback(job.playbackId);
      } catch {
        // Local playback state was already settled.
      }
    }
    if (guildId !== undefined || channelId !== undefined) {
      try {
        this.options.vox.leaveVoice(reason);
      } catch {
        // Local voice authority was already cleared; the left receipt remains valid.
      }
    }
    if (guildId !== undefined && channelId !== undefined) {
      await this.emitSafely({
        type: "left",
        reason: sanitizeFailureCode(reason),
        guildId,
        channelId,
        ...(stayId === undefined ? {} : { stayId }),
        inputTokens,
        outputTokens,
        spokenCount,
        narrationSuppressed,
      });
    }
  }

  /** Tears down this coordinator's listeners without owning the shared Vox process. */
  public async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.leave("session_disposed");
    this.disposed = true;
    try {
      this.music.dispose();
    } catch {
      // Local music state was already cleared by leave.
    }
    for (const unsubscribe of this.voxUnsubscribes) {
      try {
        unsubscribe();
      } catch {
        // Listener teardown is best effort after local disposal.
      }
    }
  }

  /** Host call limits are context for his own voice; they never supply a scripted utterance. */
  public announce(
    text: string,
    options?: { readonly timeoutMs?: number },
  ): Promise<DiscordVoiceAnnouncementResult> {
    if (this.ending) return Promise.resolve({ outcome: "inactive" });
    return this.announceNow(text, options?.timeoutMs ?? DEFAULT_VOICE_GRACEFUL_END_TIMEOUT_MS, false);
  }

  /** Refresh a warm conversation after its body wakes, without cancelling current speech. */
  public refreshBriefing(): Promise<boolean> {
    const conversation = this.conversation,
      guildId = this.guildId,
      channelId = this.channelId;
    const generation = this.sessionGeneration;
    const lease = this.bodyLease;
    const actorId = this.lastRoomUserId ?? lease?.stay.target.actorId;
    if (!conversation?.updateInstructions || guildId === undefined || channelId === undefined || this.ending)
      return Promise.resolve(false);
    const current = (): boolean =>
      !this.ending &&
      generation === this.sessionGeneration &&
      this.conversation === conversation &&
      conversation.isOpen &&
      this.bodyLease === lease &&
      lease?.current(actorId) !== false;
    const refresh = this.conversationOps.then(async () => {
      if (!current()) return false;
      await lease?.guard(actorId);
      if (!current()) return false;
      const briefing = await this.options.briefing({
        guildId,
        channelId,
        ...(actorId === undefined ? {} : { actorId }),
        consentedUserIds: this.briefingUserIds(guildId, channelId),
      });
      await lease?.guard(actorId);
      if (!current()) return false;
      conversation.updateInstructions!(briefing.instructions);
      const text = briefing.briefing.trim();
      if (text.length > 0) {
        const prefix = "Private body is ready; current briefing:\n";
        conversation.createTextItem(
          prefix + text.slice(0, MAX_REALTIME_TEXT_ITEM_CHARACTERS - prefix.length),
        );
      }
      return true;
    });
    this.conversationOps = refresh.then(
      () => undefined,
      () => undefined,
    );
    return refresh;
  }

  /**
   * Stop new work immediately, let admitted speech drain, then give the existing
   * voice an opportunity to close politely. Timeout is reported as incomplete;
   * the caller still needs the gateway's leave confirmation before releasing a stay.
   */
  public endGracefully(input: {
    readonly reason: string;
    readonly message: string;
    readonly timeoutMs?: number;
  }): Promise<DiscordVoiceGracefulEndResult> {
    if (input.message.trim().length === 0) throw new Error("voice_announcement_empty");
    const timeoutMs = input.timeoutMs ?? DEFAULT_VOICE_GRACEFUL_END_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      throw new Error("voice_announcement_timeout_invalid");
    if (this.gracefulEnd !== undefined) return this.gracefulEnd;
    if (!this.voiceReady) return Promise.resolve({ outcome: "inactive", announcement: "inactive" });
    const generation = this.sessionGeneration;
    this.ending = true;
    this.stopTick();
    this.cancelHold();
    this.dropDeferredOffer();
    this.music.stop();
    const ending = (async (): Promise<DiscordVoiceGracefulEndResult> => {
      const announcement = await this.announceNow(input.message, timeoutMs, true);
      if (generation !== this.sessionGeneration)
        return { outcome: "inactive", announcement: announcement.outcome };
      if (announcement.outcome !== "spoken" && this.guildId !== undefined && this.channelId !== undefined)
        await this.emitSafely({
          type: "failed",
          guildId: this.guildId,
          channelId: this.channelId,
          stage: "playback",
          code: "voice_graceful_end_incomplete",
        });
      await this.leave(input.reason);
      return {
        outcome: announcement.outcome === "spoken" ? "finished" : "incomplete",
        announcement: announcement.outcome,
      };
    })();
    this.gracefulEnd = ending;
    return ending;
  }

  private async announceNow(
    text: string,
    timeoutMs: number,
    allowEnding: boolean,
  ): Promise<DiscordVoiceAnnouncementResult> {
    const trimmed = text.trim();
    if (trimmed.length === 0) throw new Error("voice_announcement_empty");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      throw new Error("voice_announcement_timeout_invalid");
    if (!this.voiceReady) return { outcome: "inactive" };
    const generation = this.sessionGeneration;
    const guildId = this.guildId!;
    const channelId = this.channelId!;
    let active = true;
    let pending: PendingVoiceResponse | undefined;
    let polling: unknown;
    let stopWaiting: (() => void) | undefined;
    const current = () =>
      active && generation === this.sessionGeneration && this.voiceReady && (allowEnding || !this.ending);
    const waitUntil = (ready: () => boolean): Promise<boolean> =>
      new Promise((resolve) => {
        const poll = () => {
          polling = undefined;
          if (!current() || ready()) {
            stopWaiting = undefined;
            resolve(current());
          } else polling = this.timers.setTimeout(poll, 100);
        };
        stopWaiting = () => resolve(false);
        poll();
      });
    const idle = () =>
      this.captures.size === 0 &&
      this.pendingResponses.length === 0 &&
      this.playingJob === undefined &&
      this.openPlayback === undefined;
    let timeout: unknown;
    const expired = new Promise<DiscordVoiceAnnouncementResult>((resolve) => {
      timeout = this.timers.setTimeout(() => {
        active = false;
        stopWaiting?.();
        resolve({ outcome: "incomplete" });
      }, timeoutMs);
    });
    const work = (async (): Promise<DiscordVoiceAnnouncementResult> => {
      await this.conversationOps;
      if (!(await waitUntil(idle))) return { outcome: "incomplete" };
      const requested = this.conversationOps.then(async () => {
        if (!current() || !idle() || this.outputMuted) return;
        this.cancelHold();
        const wake: DiscordVoiceWake = this.conversation === undefined ? "waking" : "continuing";
        if (this.conversation === undefined) await this.openConversationNow(guildId, channelId);
        if (!current() || this.conversation?.isOpen !== true) return;
        pending = {
          deliveryId: randomUUID(),
          wake,
          fastPath: true,
          trigger: "narration",
          state: "settled",
          handoffMs: 0,
          decidedAtMs: this.clock(),
          done: false,
          hostNotice: true,
          isCurrent: current,
        };
        this.pendingResponses.push(pending);
        const prefix = "Call status from the host (operational context, not participant speech):\n";
        this.conversation.createTextItem(
          prefix + trimmed.slice(0, MAX_REALTIME_TEXT_ITEM_CHARACTERS - prefix.length),
        );
        void this.emitSafely({
          type: "model_response",
          guildId,
          channelId,
          deliveryId: pending.deliveryId,
          phase: "requested",
        });
        this.conversation.createResponse(
          "Briefly tell the room this call status in your own words. Keep it polite and clear.",
          this.responseGuard(pending),
        );
      });
      this.conversationOps = requested.catch(() => undefined);
      await requested;
      if (pending === undefined) return { outcome: "incomplete" };
      const notice = pending;
      if (!(await waitUntil(() => !this.pendingResponses.includes(notice)))) return { outcome: "incomplete" };
      return {
        outcome:
          notice.playbackOutcome === "drained" &&
          notice.firstAudioAtMs !== undefined &&
          !notice.audioLimitReached &&
          !notice.invalidated &&
          (notice.responseMeta === undefined || notice.responseMeta.status === "completed")
            ? "spoken"
            : "incomplete",
      };
    })().catch((): DiscordVoiceAnnouncementResult => ({ outcome: "incomplete" }));
    try {
      return await Promise.race([work, expired]);
    } finally {
      active = false;
      this.timers.clearTimeout(timeout);
      if (polling !== undefined) this.timers.clearTimeout(polling);
      stopWaiting?.();
      if (
        generation === this.sessionGeneration &&
        pending !== undefined &&
        this.pendingResponses.includes(pending)
      ) {
        pending.invalidated = true;
        this.cancelInFlight(pending);
        for (const job of new Set([this.openPlayback, this.playingJob])) {
          if (job?.pending !== pending || job.outcome !== undefined) continue;
          this.failPlayback(job, "voice_announcement_incomplete");
        }
        // A provider without a correlated cancellation must not speak a late warning.
        try {
          this.conversation?.close();
        } catch {
          // The caller records the incomplete announcement and may still end the call.
        }
      }
    }
  }

  /**
   * A bounded play update from another body (ADR 0064 / ADR 0123).
   *
   * The text is seeded as a conversation item and **never spoken verbatim**.
   * The update may quietly preserve continuity or ask for a response. What
   * Clankie says is his to compose, in the voice the briefing already gave him,
   * folded in with whatever the room is saying — the body supplies experience,
   * the persona supplies words. This is
   * ADR 0047's fence restated for speech: play changes what the body does,
   * never who is present or how he sounds.
   *
   * Rejects when he is not in a voice channel, so play learns that
   * nobody heard it rather than believing it spoke.
   */
  public async narrate(
    text: string,
    options?: { readonly deliveryId?: string; readonly respond?: boolean },
  ): Promise<void> {
    if (this.ending) throw new Error("voice_call_ending");
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
      if (this.ending || generation !== this.sessionGeneration) return;
      let wake: DiscordVoiceWake = "continuing";
      if (this.conversation === undefined) {
        wake = "waking";
        await this.openConversationNow(guildId, channelId);
        if (this.ending || generation !== this.sessionGeneration || this.conversation === undefined) return;
      }
      const conversation = this.conversation;
      if (!conversation.isOpen) return;
      try {
        conversation.createTextItem(`Your own game-side experience updated:\n${trimmed}`);
      } catch {
        // Closed between frames; the close handler owns cleanup.
        return;
      }
      // Experience is continuous; speech is selective. The game keeps this
      // persona situated every turn without turning every turn into narration.
      if (options?.respond === false) return;
      // Decided here rather than at call time, and deliberately: a play loop
      // fires narrations without awaiting them, so a decision made before the
      // queue would let every report in a burst independently conclude it was
      // the one allowed to speak.
      const deliveryId = options?.deliveryId ?? randomUUID();
      const playing = this.isPlaying();
      const startingTrack = this.music.snapshot().starting;
      const rateLimited = this.clock() - this.lastNarrationResponseAtMs < this.narrationMinIntervalMs;
      // A response already asked for is not audible yet, so `playing` cannot
      // see it, and the narration rate limit only clocks other narrations —
      // a room turn in flight passes both. Asking for a second response earns
      // "conversation already has active response" from the server and the
      // narration is lost, so the wait is taken here where it is receipted.
      // A requested track awaiting Vox's correlated playing event is the same:
      // speaking would overlap its startup. Receipt as `playing`.
      const responding = this.pendingResponses.some((candidate) => !candidate.done);
      if (playing || startingTrack || rateLimited || responding) {
        this.stayNarrationSuppressed += 1;
        await this.emitSafely({
          type: "play_narration_suppressed",
          guildId,
          channelId,
          deliveryId,
          reason: playing || startingTrack ? "playing" : rateLimited ? "rate_limited" : "responding",
        });
        return;
      }
      this.armTick();
      this.lastNarrationResponseAtMs = this.clock();
      const pending: PendingVoiceResponse = {
        deliveryId,
        wake,
        fastPath: true,
        trigger: "narration",
        state: "settled",
        handoffMs: 0,
        decidedAtMs: this.clock(),
        done: false,
      };
      this.pendingResponses.push(pending);
      void this.emitSafely({
        type: "model_response",
        guildId,
        channelId,
        deliveryId,
        phase: "requested",
      });
      try {
        conversation.createResponse(undefined, this.responseGuard(pending));
      } catch {
        this.pendingResponses.pop();
        void this.emitSafely({
          type: "model_response",
          guildId,
          channelId,
          deliveryId,
          phase: "failed",
        });
      }
    });
    this.conversationOps = queued.catch(() => undefined);
    await queued;
  }

  /**
   * Let the active voice room hear one message from its attached text chat.
   *
   * Text and speech enter the same floor machine. The realtime room persona
   * therefore decides whether to answer aloud, use `ask_clankie`, or stay
   * silent; no sentence is supplied for it to repeat. Returns false when this
   * session does not own the message's room so ordinary text ingress can take
   * the turn instead.
   */
  public receiveRoomText(input: DiscordVoiceRoomTextInput): boolean {
    if (input.guildId !== this.guildId || input.channelId !== this.channelId) return false;
    if (this.ending) return true;
    const text = input.text.trim().slice(0, DISCORD_ROOM_TEXT_MAX_CHARS);
    if (text.length === 0) return false;
    if (this.roomTextDeliveryIds.has(input.deliveryId)) return true;
    this.roomTextDeliveryIds.add(input.deliveryId);
    if (this.roomTextDeliveryIds.size > 1_024) {
      const oldest = this.roomTextDeliveryIds.values().next().value as string | undefined;
      if (oldest !== undefined) this.roomTextDeliveryIds.delete(oldest);
    }

    const turn: RoomTurn = {
      userId: input.userId,
      deliveryId: input.deliveryId,
      startedAtMs: this.clock(),
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    };
    const addressed = voiceAddressesCharacter(text, this.options.floor.names);
    void this.emitSafely({
      type: "text_input",
      guildId: input.guildId,
      channelId: input.channelId,
      userId: input.userId,
      deliveryId: input.deliveryId,
      characters: text.length,
      addressed,
    });
    if (this.isPlaying() && addressed) this.truncatePlayback(input.userId);
    this.applyRoomUtterance(turn, text, "text");
    return true;
  }

  /**
   * Push-only access to the attributed transcript, for play that is
   * driving the body and should hear the room it is playing in front of.
   *
   * Push rather than pull keeps this core retention-free. A subscriber sees
   * only lines that already passed the consent boundary and the ring, then may
   * forward or retain them under its own explicit policy.
   */
  public subscribeTranscript(
    listener: (line: string, transcript: DiscordVoiceTranscript) => void,
  ): () => void {
    this.transcriptListeners.add(listener);
    return () => this.transcriptListeners.delete(listener);
  }

  /** Retention is opt-in; this never feeds Clankie's own words into the room listener. */
  public subscribeSpokenTranscript(listener: (transcript: DiscordVoiceSpokenTranscript) => void): () => void {
    this.spokenTranscriptListeners.add(listener);
    return () => {
      this.spokenTranscriptListeners.delete(listener);
      if (this.spokenTranscriptListeners.size === 0) {
        for (const pending of this.pendingResponses) delete pending.outputTranscript;
      }
    };
  }

  /**
   * Both sides as they are spoken, for a surface that shows the conversation
   * live (a device call, VUH-2752). Like the other transcript feeds this keeps
   * nothing: a subscriber decides what, if anything, to retain.
   */
  public subscribeLiveTranscript(listener: (line: DiscordVoiceLiveTranscript) => void): () => void {
    this.liveTranscriptListeners.add(listener);
    return () => {
      this.liveTranscriptListeners.delete(listener);
      if (this.liveTranscriptListeners.size === 0) this.liveSpeechLines.clear();
    };
  }
  private publishLiveTranscript(line: DiscordVoiceLiveTranscript): void {
    return this.voiceInput.publishLiveTranscript(line);
  }

  /**
   * Whether he is receiving voice now: the transport is up and at least one
   * person in the channel can be heard under the consent policy. Joining alone
   * is not hearing (#371).
   */
  public capturing(): boolean {
    const guildId = this.guildId;
    const channelId = this.channelId;
    if (!this.voiceReady || guildId === undefined || channelId === undefined) return false;
    const people = (this.options.channelOccupants?.(guildId, channelId) ?? [])
      .filter((occupant) => occupant.isBot !== true)
      .map((occupant) => occupant.userId);
    return this.consent.permitted(guildId, channelId, people).length > 0;
  }

  public canHear(userId: string): boolean {
    return (
      this.guildId !== undefined &&
      this.channelId !== undefined &&
      this.consent.permits(this.guildId, this.channelId, userId)
    );
  }

  public async leaveControlled(stayId: string, guard: () => Promise<void>): Promise<void> {
    if (this.stayId !== stayId || !this.voiceReady) throw new Error("voice_stay_stale");
    await this.bodyLease?.guard();
    await guard();
    if (this.stayId !== stayId || !this.voiceReady || this.bodyLease?.current() === false)
      throw new Error("voice_stay_stale");
    await this.leave("owner_voice_leave");
  }
  private outputMuted = false;
  private outputControlUncertain = false;
  private readonly outputStops = new Map<string, PlaybackJob>();
  /** Stops Clankie's speech only. It does not mute room input or change consent. */
  public async setOutputMuted(stayId: string, muted: boolean, guard: () => Promise<void>): Promise<void> {
    if (this.stayId !== stayId || !this.voiceReady) throw new Error("voice_stay_stale");
    await this.bodyLease?.guard();
    await guard();
    if (this.stayId !== stayId || !this.voiceReady || this.bodyLease?.current() === false)
      throw new Error("voice_stay_stale");
    if (this.outputControlUncertain) throw new Error("voice_output_uncertain");
    this.outputMuted = muted;
    if (!muted) return;
    for (const pending of this.pendingResponses) {
      pending.superseded = true;
      this.cancelInFlight(pending);
    }
    for (const job of new Set([this.openPlayback, this.playingJob])) {
      if (job === undefined) continue;
      job.encodedChunks.length = 0;
      job.stopping = true;
      if (job !== this.playingJob) {
        // This queued job never reached native playback.
        this.settlePlayback(job, "stopped");
        continue;
      }
      // Reliable IPC submission is not native silence. Keep exact playback
      // correlation even after local timeout/failure until native confirms it.
      this.outputStops.set(job.playbackId, job);
      this.outputControlUncertain = true;
      try {
        this.options.vox.stopTtsPlayback(job.playbackId);
      } catch {
        // Status remains unknown; unmute cannot replay into an uncertain mouth.
      }
    }
  }

  public status(): DiscordVoiceSessionStatus {
    return {
      active: this.voiceReady,
      ending: this.ending,
      outputMuted: this.outputMuted,
      ...(this.voiceReady &&
      this.guildId !== undefined &&
      this.channelId !== undefined &&
      this.options.channelOccupants !== undefined
        ? {
            speakers: [...this.captures.keys()]
              .filter(
                (userId) =>
                  this.roomRoster.has(userId) && this.consent.permits(this.guildId!, this.channelId!, userId),
              )
              .slice(0, 64)
              .map((userId) => {
                const displayName = this.roomRoster.get(userId)?.displayName;
                return {
                  userId,
                  ...(displayName === undefined ? {} : { displayName: displayName.slice(0, 128) }),
                };
              }),
          }
        : {}),
      outputControlUncertain: this.outputControlUncertain,
      handoffCount: this.handoffs.size,
      activity: this.outputControlUncertain
        ? "unknown"
        : this.playingJob !== undefined && !this.playingJob.stopping
          ? "speaking"
          : this.captures.size > 0
            ? "listening"
            : this.pendingResponses.some((response) => !response.done)
              ? "thinking"
              : "idle",
      ...(this.guildId === undefined ? {} : { guildId: this.guildId }),
      ...(this.channelId === undefined ? {} : { channelId: this.channelId }),
      ...(this.daveProtocolVersion === undefined ? {} : { daveProtocolVersion: this.daveProtocolVersion }),
      consentedParticipantCount: this.consent.current()?.consentedUserIds.size ?? 0,
      activeCaptureCount: this.captures.size,
      ...(this.stayId === undefined ? {} : { stayId: this.stayId }),
      floorState: this.floor.state,
      engaged: this.conversation !== undefined,
    };
  }

  // ------------------------------------------------------------------
  // Capture: correlated per-user Vox 24 kHz mono PCM, streamed unchanged.
  // ------------------------------------------------------------------

  private handleVoxEvent(event: VoxControlEvent): void {
    if (
      (event.type === "transport_state" || event.type === "dave_state") &&
      event.role === "voice" &&
      event.connectionId !== this.connectionId
    ) {
      return;
    }
    if (event.type === "error") {
      if (
        event.role === "voice" &&
        event.connectionId === this.connectionId &&
        (event.code === "voice_connect_failed" || event.code === "voice_runtime_error") &&
        this.guildId !== undefined
      ) {
        this.leaveSafely("vox_voice_error");
      }
      return;
    }
    if (event.type === "speaking_start" && event.captureId === undefined) {
      this.onSpeakingStart(event.userId);
      return;
    }
    if (event.type === "user_audio_end") {
      void this.finishCapture(event.userId, event.captureId);
      return;
    }
    if (event.type === "client_disconnect") {
      this.cancelCapture(event.userId);
      this.releaseSpeakerTranscription(event.userId);
      return;
    }
    if (event.type === "tts_playback_state") {
      this.handlePlaybackState(event);
      return;
    }
    if (event.type === "tts_buffer_overflow") {
      const job = this.playingJob;
      if (job === undefined || event.playbackId !== job.playbackId) return;
      this.failPlayback(job, "tts_buffer_overflow");
      return;
    }
    if (
      event.type === "transport_state" &&
      event.role === "voice" &&
      (event.status === "disconnected" || event.status === "failed" || event.status === "closed") &&
      this.guildId !== undefined
    ) {
      this.leaveSafely("vox_voice_transport_lost");
      return;
    }
    if (
      event.type === "dave_state" &&
      event.role === "voice" &&
      (event.status === "disabled" || event.status === "cleared") &&
      this.guildId !== undefined
    ) {
      this.leaveSafely("vox_dave_lost");
    }
  }
  private capture(userId: string): Promise<void> {
    return this.voiceInput.capture(userId);
  }

  private handleUserAudio(frame: VoxUserAudioFrame): void {
    return this.voiceInput.handleUserAudio(frame);
  }

  private finishCapture(userId: string, captureId: string): Promise<void> {
    return this.voiceInput.finishCapture(userId, captureId);
  }

  private cancelCapture(userId: string): void {
    return this.voiceInput.cancelCapture(userId);
  }

  private cancelReorderWait(): void {
    return this.voiceInput.cancelReorderWait();
  }

  private applyRoomUtterance(turn: RoomTurn, text: string, source: RoomInputSource): void {
    return this.voiceInput.applyRoomUtterance(turn, text, source);
  }

  private dropDeferredOffer(): void {
    return this.voiceInput.dropDeferredOffer();
  }

  private ringText(): string {
    return this.voiceInput.ringText();
  }

  private applyFloorDecision(
    decision: FloorDecision,
    turn: RoomTurn,
    guildId: string,
    channelId: string,
  ): void {
    return this.voiceConversation.applyFloorDecision(decision, turn, guildId, channelId);
  }

  private settleOffer(pending: PendingVoiceResponse, taken: boolean): void {
    return this.voiceConversation.settleOffer(pending, taken);
  }

  private queueEngagedResponse(
    turn: RoomTurn,
    guildId: string,
    channelId: string,
    offer?: "volition" | "engaged" | "addressed",
    responseContext?: string,
    isCurrent?: () => boolean,
  ): void {
    return this.voiceConversation.queueEngagedResponse(
      turn,
      guildId,
      channelId,
      offer,
      responseContext,
      isCurrent,
    );
  }

  private responseGuard(pending: PendingVoiceResponse): () => boolean {
    return this.voiceConversation.responseGuard(pending);
  }

  private openConversationNow(
    guildId: string,
    channelId: string,
    preferredSpeakerId?: string,
  ): Promise<void> {
    return this.voiceConversation.openConversationNow(guildId, channelId, preferredSpeakerId);
  }

  private hearIfOpen(turn: RoomTurn, text: string, source: RoomInputSource): void {
    return this.voiceConversation.hearIfOpen(turn, text, source);
  }

  private labeledSpeech(
    speakerId: string,
    text: string,
    suppliedDisplayName?: string,
  ): { speakerId: string; displayName?: string; text: string } {
    return this.voiceConversation.labeledSpeech(speakerId, text, suppliedDisplayName);
  }

  private rosterText(guildId: string, channelId: string): string | undefined {
    return this.voiceConversation.rosterText(guildId, channelId);
  }

  private handleFunctionCall(call: RealtimeFunctionCall, guildId: string, channelId: string): void {
    return this.voiceTools.handleFunctionCall(call, guildId, channelId);
  }

  private handleAudioDelta(pcm: Buffer, itemId: string): void {
    return this.voicePlayback.handleAudioDelta(pcm, itemId);
  }

  private handleResponseAbandoned(attempt: RealtimeResponseAttempt): void {
    return this.voicePlayback.handleResponseAbandoned(attempt);
  }

  private handleResponseDone(meta?: RealtimeResponseMeta): void {
    return this.voicePlayback.handleResponseDone(meta);
  }

  private emitModelResponseCompletion(
    pending: PendingVoiceResponse,
    missingResponsePhase: "completed" | "failed" = "completed",
  ): void {
    return this.voicePlayback.emitModelResponseCompletion(pending, missingResponsePhase);
  }

  private pumpPlayback(job: PlaybackJob): void {
    return this.voicePlayback.pumpPlayback(job);
  }

  private handlePlaybackState(event: Extract<VoxControlEvent, { type: "tts_playback_state" }>): void {
    return this.voicePlayback.handlePlaybackState(event);
  }

  private failPlayback(job: PlaybackJob, failure: unknown): void {
    return this.voicePlayback.failPlayback(job, failure);
  }

  private emitSpokenTranscript(
    pending: PendingVoiceResponse,
    outcome: DiscordVoiceSpokenTranscript["outcome"],
    job?: PlaybackJob,
  ): void {
    return this.voicePlayback.emitSpokenTranscript(pending, outcome, job);
  }

  private settlePlayback(job: PlaybackJob, outcome: "drained" | "stopped" | "failed" | "timeout"): void {
    return this.voicePlayback.settlePlayback(job, outcome);
  }

  private cancelInFlight(pending: PendingVoiceResponse): void {
    return this.voicePlayback.cancelInFlight(pending);
  }

  private isPlaying(): boolean {
    return this.voicePlayback.isPlaying();
  }

  private truncatePlayback(userId: string): void {
    return this.voicePlayback.truncatePlayback(userId);
  }

  private probeTranscription(guildId: string, channelId: string): Promise<void> {
    return this.voiceInput.probeTranscription(guildId, channelId);
  }

  private releaseSpeakerTranscription(userId: string): void {
    return this.voiceInput.releaseSpeakerTranscription(userId);
  }

  private invalidateConversationForRosterChange(): void {
    return this.voiceConversation.invalidateConversationForRosterChange();
  }

  private refreshConversationBriefing(preferredSpeakerId?: string): void {
    return this.voiceConversation.refreshConversationBriefing(preferredSpeakerId);
  }

  private briefingUserIds(guildId: string, channelId: string, preferredSpeakerId?: string): string[] {
    return this.voiceConversation.briefingUserIds(guildId, channelId, preferredSpeakerId);
  }

  private armTick(): void {
    return this.voiceConversation.armTick();
  }

  private stopTick(): void {
    return this.voiceConversation.stopTick();
  }

  private startFloorWork(callId: string, speakerId: string): void {
    return this.voiceConversation.startFloorWork(callId, speakerId);
  }

  private stopFloorWork(callId?: string): void {
    return this.voiceConversation.stopFloorWork(callId);
  }

  private cancelHold(): void {
    return this.voiceConversation.cancelHold();
  }

  private addStayTokens(pending: Pick<PendingVoiceResponse, "inputTokens" | "outputTokens">): void {
    this.stayInputTokens += pending.inputTokens ?? 0;
    this.stayOutputTokens += pending.outputTokens ?? 0;
  }

  private handleMusicTrace(event: VoiceMusicTraceEvent): void {
    const guildId = this.guildId;
    const channelId = this.channelId;
    if (guildId === undefined || channelId === undefined) return;
    void this.emitSafely({ type: "music", guildId, channelId, ...event });
  }

  private leaveSafely(reason: string): void {
    void this.leave(reason).catch(() => undefined);
  }

  /**
   * Evidence is telemetry: a failing emitter must never eat a reply, stall
   * playback, or leak into the media path.
   */
  private async emitSafely(evidence: DiscordVoiceEvidence): Promise<void> {
    const stamped =
      evidence.stayId !== undefined || this.stayId === undefined
        ? evidence
        : { ...evidence, stayId: this.stayId };
    try {
      await this.options.emit(stamped);
    } catch {
      // Deliberately swallowed.
    }
  }

  private static voiceContext(session: DiscordVoiceSession): VoiceSessionContext {
    return {
      get guildId() {
        return session.guildId;
      },
      set guildId(value: string | undefined) {
        session.guildId = value;
      },
      get channelId() {
        return session.channelId;
      },
      set channelId(value: string | undefined) {
        session.channelId = value;
      },
      get ending() {
        return session.ending;
      },
      set ending(value: boolean) {
        session.ending = value;
      },
      get voiceReady() {
        return session.voiceReady;
      },
      set voiceReady(value: boolean) {
        session.voiceReady = value;
      },
      get captures() {
        return session.captures;
      },
      get sessionGeneration() {
        return session.sessionGeneration;
      },
      set sessionGeneration(value: number) {
        session.sessionGeneration = value;
      },
      get captureEpochs() {
        return session.captureEpochs;
      },
      get speakerLastActiveAtMs() {
        return session.speakerLastActiveAtMs;
      },
      clock: () => session.clock(),
      get transcriptTurns() {
        return session.transcriptTurns;
      },
      get consent() {
        return session.consent;
      },
      get options() {
        return session.options;
      },
      get timers() {
        return session.timers;
      },
      get recordingLimitMs() {
        return session.recordingLimitMs;
      },
      get playingJob() {
        return session.playingJob;
      },
      set playingJob(value: PlaybackJob | undefined) {
        session.playingJob = value;
      },
      get floor() {
        return session.floor;
      },
      set floor(value: VoiceFloor) {
        session.floor = value;
      },
      get roomResponseEpoch() {
        return session.roomResponseEpoch;
      },
      set roomResponseEpoch(value: number) {
        session.roomResponseEpoch = value;
      },
      get quietEpoch() {
        return session.quietEpoch;
      },
      set quietEpoch(value: number) {
        session.quietEpoch = value;
      },
      get pendingResponses() {
        return session.pendingResponses;
      },
      set pendingResponses(value: PendingVoiceResponse[]) {
        session.pendingResponses = value;
      },
      get handoffs() {
        return session.handoffs;
      },
      get finalizedUtterances() {
        return session.finalizedUtterances;
      },
      get reorderHandle() {
        return session.reorderHandle;
      },
      set reorderHandle(value: unknown) {
        session.reorderHandle = value;
      },
      get conversation() {
        return session.conversation;
      },
      set conversation(value: VoiceConversationPort | undefined) {
        session.conversation = value;
      },
      get lastRoomUserId() {
        return session.lastRoomUserId;
      },
      set lastRoomUserId(value: string | undefined) {
        session.lastRoomUserId = value;
      },
      get deferredOffer() {
        return session.deferredOffer;
      },
      set deferredOffer(
        value:
          | {
              readonly turn: RoomTurn;
              readonly guildId: string;
              readonly channelId: string;
              readonly offer: "engaged" | "addressed";
              readonly roomEpoch: number;
              readonly generation: number;
              readonly firstDeferredAtMs: number;
            }
          | undefined,
      ) {
        session.deferredOffer = value;
      },
      get deferredOfferHandle() {
        return session.deferredOfferHandle;
      },
      set deferredOfferHandle(value: unknown) {
        session.deferredOfferHandle = value;
      },
      get transcriptRing() {
        return session.transcriptRing;
      },
      set transcriptRing(value: Buffer[]) {
        session.transcriptRing = value;
      },
      get stayId() {
        return session.stayId;
      },
      set stayId(value: string | undefined) {
        session.stayId = value;
      },
      get transcriptListeners() {
        return session.transcriptListeners;
      },
      get transcriptions() {
        return session.transcriptions;
      },
      get transcriptionOpens() {
        return session.transcriptionOpens;
      },
      get transcriptionEpochs() {
        return session.transcriptionEpochs;
      },
      get reconnectDelays() {
        return session.reconnectDelays;
      },
      get reconnectHandles() {
        return session.reconnectHandles;
      },
      get speakerIdleHandles() {
        return session.speakerIdleHandles;
      },
      get liveTranscriptListeners() {
        return session.liveTranscriptListeners;
      },
      get liveSpeechLines() {
        return session.liveSpeechLines;
      },
      get membershipDeliveryId() {
        return session.membershipDeliveryId;
      },
      set membershipDeliveryId(value: string | undefined) {
        session.membershipDeliveryId = value;
      },
      get conversationOps() {
        return session.conversationOps;
      },
      set conversationOps(value: Promise<void>) {
        session.conversationOps = value;
      },
      get roomEventUpdates() {
        return session.roomEventUpdates;
      },
      set roomEventUpdates(value: string[]) {
        session.roomEventUpdates = value;
      },
      get workHeartbeatHandle() {
        return session.workHeartbeatHandle;
      },
      set workHeartbeatHandle(value: unknown) {
        session.workHeartbeatHandle = value;
      },
      get speakerResponseEpochs() {
        return session.speakerResponseEpochs;
      },
      get startingResponse() {
        return session.startingResponse;
      },
      set startingResponse(value: PendingVoiceResponse | undefined) {
        session.startingResponse = value;
      },
      get bodyLease() {
        return session.bodyLease;
      },
      set bodyLease(value: VoiceBodyAdmission | undefined) {
        session.bodyLease = value;
      },
      get invalidPlaybackItemIds() {
        return session.invalidPlaybackItemIds;
      },
      get spokenTranscriptListeners() {
        return session.spokenTranscriptListeners;
      },
      get hasResponseIdentity() {
        return session.hasResponseIdentity;
      },
      set hasResponseIdentity(value: boolean) {
        session.hasResponseIdentity = value;
      },
      get openPlayback() {
        return session.openPlayback;
      },
      set openPlayback(value: PlaybackJob | undefined) {
        session.openPlayback = value;
      },
      get roomEvents() {
        return session.roomEvents;
      },
      set roomEvents(value: string[]) {
        session.roomEvents = value;
      },
      get tickHandle() {
        return session.tickHandle;
      },
      set tickHandle(value: unknown) {
        session.tickHandle = value;
      },
      get floorWork() {
        return session.floorWork;
      },
      get holdHandle() {
        return session.holdHandle;
      },
      set holdHandle(value: unknown) {
        session.holdHandle = value;
      },
      get turnQueue() {
        return session.turnQueue;
      },
      set turnQueue(value: Promise<void>) {
        session.turnQueue = value;
      },
      get music() {
        return session.music;
      },
      get roomRoster() {
        return session.roomRoster;
      },
      set roomRoster(value: Map<string, VoiceRoomOccupant>) {
        session.roomRoster = value;
      },
      get outputMuted() {
        return session.outputMuted;
      },
      set outputMuted(value: boolean) {
        session.outputMuted = value;
      },
      get playbackChain() {
        return session.playbackChain;
      },
      set playbackChain(value: Promise<void>) {
        session.playbackChain = value;
      },
      get staySpokenCount() {
        return session.staySpokenCount;
      },
      set staySpokenCount(value: number) {
        session.staySpokenCount = value;
      },
      get outputStops() {
        return session.outputStops;
      },
      get outputControlUncertain() {
        return session.outputControlUncertain;
      },
      set outputControlUncertain(value: boolean) {
        session.outputControlUncertain = value;
      },
      emitSafely: (evidence) => session.emitSafely(evidence),
      isPlaying: () => session.isPlaying(),
      truncatePlayback: (userId) => session.truncatePlayback(userId),
      cancelInFlight: (pending) => session.cancelInFlight(pending),
      hearIfOpen: (turn, text, source) => session.hearIfOpen(turn, text, source),
      applyFloorDecision: (decision, turn, guildId, channelId) =>
        session.applyFloorDecision(decision, turn, guildId, channelId),
      queueEngagedResponse: (turn, guildId, channelId, offer, responseContext, isCurrent) =>
        session.queueEngagedResponse(turn, guildId, channelId, offer, responseContext, isCurrent),
      labeledSpeech: (speakerId, text, suppliedDisplayName) =>
        session.labeledSpeech(speakerId, text, suppliedDisplayName),
      emitModelResponseCompletion: (pending, missingResponsePhase) =>
        session.emitModelResponseCompletion(pending, missingResponsePhase),
      publishLiveTranscript: (line) => session.publishLiveTranscript(line),
      handleAudioDelta: (pcm, itemId) => session.handleAudioDelta(pcm, itemId),
      handleFunctionCall: (call, guildId, channelId) => session.handleFunctionCall(call, guildId, channelId),
      handleResponseAbandoned: (attempt) => session.handleResponseAbandoned(attempt),
      handleResponseDone: (meta) => session.handleResponseDone(meta),
      ringText: () => session.ringText(),
      pumpPlayback: (job) => session.pumpPlayback(job),
      emitSpokenTranscript: (pending, outcome, job) => session.emitSpokenTranscript(pending, outcome, job),
      leave: (reason) => session.leave(reason),
      startFloorWork: (callId, speakerId) => session.startFloorWork(callId, speakerId),
      rosterText: (guildId, channelId) => session.rosterText(guildId, channelId),
      stopFloorWork: (callId) => session.stopFloorWork(callId),
      responseGuard: (pending) => session.responseGuard(pending),
      leaveSafely: (reason) => session.leaveSafely(reason),
      settleOffer: (pending, taken) => session.settleOffer(pending, taken),
      addStayTokens: (pending) => session.addStayTokens(pending),
      queueMembershipResponse: () => session.queueMembershipResponse(),
    };
  }
}
