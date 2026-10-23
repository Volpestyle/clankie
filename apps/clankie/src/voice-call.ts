import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  DiscordVoiceSession,
  pcmRms,
  type DiscordVoiceBriefing,
  type DiscordVoiceRealtimePorts,
  type DiscordVoiceSessionStatus,
  type DiscordVoiceTurn,
  type DiscordVoiceTurnOutcome,
  type LookAtScreenResult,
  type VoiceFloorOptions,
  type VoiceHandoffPort,
  type VoiceMediaPort,
  type VoiceSelfToolCall,
} from "@clankie/discord-presence-core";
import {
  VOICE_CALL_SAMPLE_RATE,
  VoiceCallClientEventSchema,
  VoiceCallServerEventSchema,
  type CaptainChannelTurnResult,
  type DiscordVoiceEvidence,
  type VoiceCallEndReason,
  type VoiceCallServerEvent,
  type VoiceCallState,
} from "@clankie/protocol";

/**
 * A device voice call (VUH-2682): his Discord rooms' own realtime session, with
 * a paired device's microphone and speaker as its media. Nothing here decides
 * what he says or when; the session does, exactly as in Discord. This module
 * only turns a WebSocket peer into the media that session drives, holds his
 * one voice for the length of the call, and routes `ask_clankie` into the main
 * conversation.
 */

type VoxControlEvent = Parameters<Parameters<VoiceMediaPort["onEvent"]>[0]>[0];
type VoxUserAudioFrame = Parameters<Parameters<VoiceMediaPort["onUserAudio"]>[0]>[0];
type VoxProcessStatus = VoiceMediaPort["status"];

/** The one person on a device call. Not a Discord id; it only keys the session's capture state. */
const VOICE_CALL_SPEAKER_ID = "owner";
/** Rooms a call is not in: a fixed key the session's per-room state is bound to. */
const VOICE_CALL_ROOM = "device-call";
/** One voice at a time (ADR 0215): renewed while the call runs, released when it ends. */
const VOICE_LEASE_RENEW_MS = 10_000;
const STATE_TICK_MS = 250;
/** A device streams microphone frames the whole call; this long with nothing from it, it is gone. */
const DEFAULT_SILENT_PEER_MS = 15_000;
/** A peer that stops reading for this long is gone; playback fails instead of queueing without bound. */
const PEER_BACKPRESSURE_BYTES = 512 * 1024;
const FRAME_BYTES_PER_MS = (VOICE_CALL_SAMPLE_RATE * 2) / 1_000;

/**
 * Speech detection on an open device microphone. Discord's own clients only
 * send packets while someone talks; a device streams continuously, so the
 * call supplies the speaking edges Vox otherwise reports. Calibration knobs,
 * untested live: macOS voice processing (echo cancellation, gain control)
 * keeps room tone low, and the session's own noise floor and barge-in gates
 * still apply after this.
 */
const SPEECH_ONSET_RMS = 600;
const SPEECH_CONTINUE_RMS = 300;
const SPEECH_ONSET_MS = 60;
const DEFAULT_CAPTURE_SILENCE_MS = 500;
/** Lead-in kept before an onset, and the most audio held while the session opens a capture. */
const LEAD_IN_MS = 300;
const PENDING_CAPTURE_MAX_MS = 5_000;

interface VoiceCallPeer {
  readonly bufferedAmount: number;
  sendEvent(event: VoiceCallServerEvent): void;
  sendAudio(pcm: Uint8Array): void;
  close(code: number, reason: string): void;
}

/**
 * The device as a voice media port: microphone audio becomes the speaking
 * edges and correlated capture frames Vox reports for a Discord member, and
 * his playback becomes framed PCM the device acknowledges. Audio is zeroed
 * once forwarded and never retained.
 */
class LocalCallMedia implements VoiceMediaPort {
  public readonly available = true;
  public readonly requiresDave = false;
  public status: VoxProcessStatus = "ready";
  public detail = "device voice call";
  private readonly peer: VoiceCallPeer;
  private readonly onLeave: (reason: string) => void;
  private readonly statusListeners = new Set<(status: VoxProcessStatus, detail: string) => void>();
  private readonly eventListeners = new Set<(event: VoxControlEvent) => void>();
  private readonly audioListeners = new Set<(frame: VoxUserAudioFrame) => void>();
  private connectionId: string | undefined;
  private playbackId: string | undefined;
  /**
   * `speech`: an utterance is being heard; `awaiting`: it ended before the
   * session opened its capture, and is held whole until it does.
   */
  private phase: "idle" | "speech" | "awaiting" = "idle";
  private onsetMs = 0;
  private silentMs = 0;
  private silenceLimitMs = DEFAULT_CAPTURE_SILENCE_MS;
  private captureId: string | undefined;
  private leadIn: Buffer[] = [];
  private pending: Buffer[] = [];

  public constructor(peer: VoiceCallPeer, onLeave: (reason: string) => void) {
    this.peer = peer;
    this.onLeave = onLeave;
  }

  /** Whether the device's own speech is being heard right now. */
  public get hearing(): boolean {
    return this.phase === "speech";
  }

  public onStatus(listener: (status: VoxProcessStatus, detail: string) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  public onEvent(listener: (event: VoxControlEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  public onUserAudio(listener: (frame: VoxUserAudioFrame) => void): () => void {
    this.audioListeners.add(listener);
    return () => this.audioListeners.delete(listener);
  }

  public joinVoice(input: { connectionId: string }): void {
    this.connectionId = input.connectionId;
    // The socket is already open: the device is in the call once the session asks.
    queueMicrotask(() => {
      if (this.connectionId !== input.connectionId) return;
      this.emit({
        type: "transport_state",
        role: "voice",
        connectionId: input.connectionId,
        status: "ready",
      });
    });
  }

  public leaveVoice(reason?: string): void {
    if (this.connectionId === undefined) return;
    this.connectionId = undefined;
    this.resetCapture();
    this.onLeave(reason ?? "session_leave");
  }

  public sendAudio(input: { playbackId: string; pcmBase64: string }): void {
    if (this.peer.bufferedAmount > PEER_BACKPRESSURE_BYTES) throw new Error("voice_call_peer_backpressure");
    if (this.playbackId !== input.playbackId) {
      this.playbackId = input.playbackId;
      this.peer.sendEvent({
        schemaVersion: 1,
        type: "playback",
        playbackId: input.playbackId,
        action: "start",
      });
    }
    const pcm = Buffer.from(input.pcmBase64, "base64");
    try {
      this.peer.sendAudio(pcm);
    } finally {
      pcm.fill(0);
    }
  }

  public finishTtsPlayback(playbackId: string): void {
    this.peer.sendEvent({ schemaVersion: 1, type: "playback", playbackId, action: "finish" });
  }

  public stopTtsPlayback(playbackId: string): void {
    if (this.playbackId === playbackId) this.playbackId = undefined;
    this.peer.sendEvent({ schemaVersion: 1, type: "playback", playbackId, action: "stop" });
  }

  public subscribeUserAudio(
    userId: string,
    captureId: string,
    options?: { silenceDurationMs?: number; sampleRate?: number },
  ): void {
    if (userId !== VOICE_CALL_SPEAKER_ID) return;
    if (options?.sampleRate !== undefined && options.sampleRate !== VOICE_CALL_SAMPLE_RATE)
      throw new Error("voice_call_sample_rate_unsupported");
    this.silenceLimitMs = options?.silenceDurationMs ?? DEFAULT_CAPTURE_SILENCE_MS;
    const ended = this.phase !== "speech";
    this.captureId = captureId;
    const held = this.pending;
    this.pending = [];
    for (const pcm of held) this.forward(pcm);
    if (!ended) return;
    // The utterance finished before the session asked for it: deliver it whole, then close it.
    this.resetCapture();
    queueMicrotask(() => this.emit({ type: "user_audio_end", userId, captureId }));
  }

  public unsubscribeUserAudio(userId: string): void {
    // The session closed this capture (ended, revoked or at its length cap); speech after it is a new one.
    if (userId === VOICE_CALL_SPEAKER_ID) this.resetCapture();
  }

  public musicPlay(input: { musicId: string }): void {
    // A call has no music player; the session reports it like any other music failure.
    queueMicrotask(() =>
      this.emit({
        type: "music_error",
        musicId: input.musicId,
        code: "pipeline_failed",
        message: "A device call has no music player.",
      }),
    );
  }
  public musicStop(musicId: string): void {
    queueMicrotask(() => this.emit({ type: "music_idle", musicId }));
  }
  public musicPause(): void {}
  public musicResume(): void {}
  public musicSetGain(): void {}

  /** One frame of microphone audio from the device. */
  public receiveMicrophone(input: Uint8Array): void {
    if (this.connectionId === undefined || input.byteLength < 2) return;
    const pcm = Buffer.from(input.subarray(0, input.byteLength - (input.byteLength % 2)));
    const frameMs = pcm.byteLength / FRAME_BYTES_PER_MS;
    const rms = pcmRms(pcm);
    if (this.phase === "idle") {
      this.onsetMs = rms >= SPEECH_ONSET_RMS ? this.onsetMs + frameMs : 0;
      this.leadIn.push(pcm);
      this.trim(this.leadIn, LEAD_IN_MS);
      if (this.onsetMs < SPEECH_ONSET_MS) return;
      this.phase = "speech";
      this.silentMs = 0;
      this.pending = this.leadIn;
      this.leadIn = [];
      this.emit({ type: "speaking_start", userId: VOICE_CALL_SPEAKER_ID });
      return;
    }
    if (this.phase === "awaiting") {
      // Talking again before the session opened the capture continues the same utterance.
      if (rms < SPEECH_CONTINUE_RMS) {
        pcm.fill(0);
        return;
      }
      this.phase = "speech";
      this.silentMs = 0;
    }
    this.silentMs = rms < SPEECH_CONTINUE_RMS ? this.silentMs + frameMs : 0;
    if (this.captureId === undefined) {
      this.pending.push(pcm);
      this.trim(this.pending, PENDING_CAPTURE_MAX_MS);
    } else this.forward(pcm);
    if (this.silentMs < this.silenceLimitMs) return;
    const captureId = this.captureId;
    if (captureId === undefined) {
      this.phase = "awaiting";
      return;
    }
    this.resetCapture();
    this.emit({ type: "user_audio_end", userId: VOICE_CALL_SPEAKER_ID, captureId });
  }

  /** The device's report on his playback. Started means audible; drained means every frame played. */
  public receivePlayback(playbackId: string, status: "started" | "drained" | "stopped" | "failed"): void {
    if ((status === "drained" || status === "stopped") && this.playbackId === playbackId)
      this.playbackId = undefined;
    this.emit({ type: "tts_playback_state", playbackId, status });
  }

  /** The socket closed under the session: the media process is gone, exactly as a lost Vox. */
  public lost(detail: string): void {
    this.status = "closed";
    this.detail = detail;
    for (const listener of this.statusListeners) listener("closed", detail);
  }

  private forward(pcm: Buffer): void {
    const captureId = this.captureId;
    if (captureId === undefined) {
      pcm.fill(0);
      return;
    }
    let peak = 0;
    let active = 0;
    const samples = Math.floor(pcm.byteLength / 2);
    for (let index = 0; index < samples; index += 1) {
      const sample = Math.abs(pcm.readInt16LE(index * 2));
      if (sample > peak) peak = sample;
      if (sample >= SPEECH_CONTINUE_RMS) active += 1;
    }
    const frame: VoxUserAudioFrame = {
      userId: VOICE_CALL_SPEAKER_ID,
      captureId,
      signalPeakAbs: peak,
      signalActiveSampleCount: active,
      signalSampleCount: samples,
      pcm,
    };
    // The session zeroes each frame once it has forwarded it, as it does Vox's.
    for (const listener of this.audioListeners) listener(frame);
  }

  private resetCapture(): void {
    this.phase = "idle";
    this.onsetMs = 0;
    this.silentMs = 0;
    this.captureId = undefined;
    this.zero(this.pending);
    this.zero(this.leadIn);
    this.pending = [];
    this.leadIn = [];
  }

  private trim(buffers: Buffer[], maxMs: number): void {
    let total = buffers.reduce((sum, pcm) => sum + pcm.byteLength, 0);
    while (buffers.length > 1 && total > maxMs * FRAME_BYTES_PER_MS) {
      const dropped = buffers.shift()!;
      total -= dropped.byteLength;
      dropped.fill(0);
    }
  }

  private zero(buffers: readonly Buffer[]): void {
    for (const pcm of buffers) pcm.fill(0);
  }

  private emit(event: VoxControlEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }
}

/** The main conversation's answer to one call handoff, in the channel-turn shape Discord voice already speaks. */
type VoiceCallHandoff = (input: {
  readonly deliveryId: string;
  readonly request: string;
  readonly context?: string;
}) => Promise<CaptainChannelTurnResult>;

/** Maps the main conversation's result onto the outcomes the voice session speaks, as Discord's ingress does. */
function voiceCallHandoffPort(handoff: VoiceCallHandoff): VoiceHandoffPort {
  return {
    async handle(turn: DiscordVoiceTurn): Promise<DiscordVoiceTurnOutcome> {
      if (turn.isCurrent?.() === false) return { state: "failed", code: "voice_session_stale" };
      const request = turn.transcript.replaceAll(/\s+/gu, " ").trim();
      if (request.length === 0) return { state: "failed", code: "voice_transcript_empty" };
      // Once submitted, the main conversation owns the work: a hang-up only stops the voice hearing it.
      const result = await handoff({
        deliveryId: turn.deliveryId,
        request,
        ...(turn.roomContext === undefined ? {} : { context: turn.roomContext }),
      });
      if (result.state === "failed")
        return {
          state: "failed",
          code: result.code,
          ...(result.turnId === undefined ? {} : { turnId: result.turnId }),
        };
      if (result.state === "waiting_user")
        return {
          state: "waiting_user",
          turnId: result.turnId,
          approvalRequired: result.approvalRequired,
          response: result.approvalRequired
            ? "That needs your approval in the main conversation, in the app or the console."
            : result.prompt,
        };
      if (result.state === "silent") return { state: "declined", turnId: result.turnId };
      if (result.state === "absorbed") return { state: "absorbed", turnId: result.turnId };
      return { state: "settled", turnId: result.turnId, response: result.response };
    },
  };
}

export interface VoiceCallLease {
  /** Busy names the room his voice is in, by its readable conversation name when known. */
  acquire(): Promise<
    { outcome: "acquired" } | { outcome: "busy"; room?: string } | { outcome: "unavailable" }
  >;
  renew(): boolean;
  release(): void;
}

interface VoiceCallOptions {
  readonly peer: VoiceCallPeer;
  readonly lease: VoiceCallLease;
  /** Resolved when the call starts, so nothing reads provider keys until someone calls. */
  readonly realtime: () => Promise<DiscordVoiceRealtimePorts | undefined>;
  readonly briefing: () => Promise<DiscordVoiceBriefing>;
  readonly floor: () => Promise<VoiceFloorOptions>;
  readonly handoff: VoiceCallHandoff;
  readonly selfTool?: (call: Pick<VoiceSelfToolCall, "name" | "arguments">) => Promise<string>;
  readonly lookAtScreen?: () => Promise<LookAtScreenResult>;
  /** Content-free receipts, the same evidence a Discord stay records. */
  readonly record?: (evidence: DiscordVoiceEvidence, callId: string) => void;
  readonly ownerName?: string;
  readonly onEnded?: (reason: VoiceCallEndReason) => void;
  /** Ends a call whose device stopped sending anything. Defaults to 15 seconds. */
  readonly silentPeerMs?: number;
  /** Injected by tests; production uses real timers. */
  readonly timers?: {
    setInterval(handler: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
}

const defaultTimers = {
  setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
  clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** One call from connect to hang-up. */
export class VoiceCall {
  public readonly callId = randomUUID();
  private readonly options: VoiceCallOptions;
  private readonly media: LocalCallMedia;
  private readonly timers: NonNullable<VoiceCallOptions["timers"]>;
  private session: DiscordVoiceSession | undefined;
  private state: VoiceCallState | undefined;
  private leaseHeld = false;
  private renewTimer: unknown;
  private stateTimer: unknown;
  private livenessTimer: unknown;
  private heardAt = Date.now();
  private ended = false;
  private ending: Promise<void> | undefined;

  public constructor(options: VoiceCallOptions) {
    this.options = options;
    this.timers = options.timers ?? defaultTimers;
    this.media = new LocalCallMedia(options.peer, (reason) => {
      // The session left on its own: he ended his stay (voice_leave) or lost his media.
      void this.end(reason === "self_decided" ? "left" : "failed");
    });
  }

  /** Takes his voice, opens the session and joins it. Ends the call itself when any step refuses. */
  public async start(): Promise<void> {
    this.publishState("connecting");
    // A half-open socket never closes on its own: a silent device ends the call.
    const silentPeerMs = this.options.silentPeerMs ?? DEFAULT_SILENT_PEER_MS;
    this.heardAt = Date.now();
    this.livenessTimer = this.timers.setInterval(
      () => {
        if (Date.now() - this.heardAt > silentPeerMs) void this.end("failed");
      },
      Math.min(1_000, silentPeerMs / 2),
    );
    const lease = await this.options.lease.acquire();
    if (lease.outcome === "busy") return this.end("voice_busy", lease.room);
    if (lease.outcome !== "acquired") return this.end("unavailable");
    this.leaseHeld = true;
    if (this.ended) return this.releaseLease();
    this.renewTimer = this.timers.setInterval(() => {
      if (!this.options.lease.renew()) void this.end("failed");
    }, VOICE_LEASE_RENEW_MS);
    let realtime: DiscordVoiceRealtimePorts | undefined;
    let floor: VoiceFloorOptions;
    try {
      realtime = await this.options.realtime();
      floor = await this.options.floor();
    } catch {
      return this.end("unavailable");
    }
    if (realtime === undefined) return this.end("unavailable");
    if (this.ended) return;
    const { selfTool, lookAtScreen, ownerName } = this.options;
    const session = new DiscordVoiceSession({
      vox: this.media,
      ingress: voiceCallHandoffPort(this.options.handoff),
      realtime,
      briefing: () => this.options.briefing(),
      floor,
      consentPolicy: "explicit",
      channelOccupants: () => [
        { userId: VOICE_CALL_SPEAKER_ID, ...(ownerName === undefined ? {} : { displayName: ownerName }) },
      ],
      roomNames: () => ({ guildName: "Device call", channelName: "Private call" }),
      ...(selfTool === undefined
        ? {}
        : {
            selfTool: (call: VoiceSelfToolCall) => selfTool({ name: call.name, arguments: call.arguments }),
          }),
      ...(lookAtScreen === undefined ? {} : { lookAtScreen }),
      presenceSessionId: () => this.callId,
      emit: (evidence) => {
        this.options.record?.(evidence, this.callId);
        this.refreshState();
        return Promise.resolve();
      },
    });
    this.session = session;
    try {
      await session.join({
        guildId: VOICE_CALL_ROOM,
        channelId: this.callId,
        // Calling is the consent: the device's owner opted in by pressing call.
        invokingUserId: VOICE_CALL_SPEAKER_ID,
      });
    } catch {
      return this.end("failed");
    }
    if (this.ended) return;
    this.stateTimer = this.timers.setInterval(() => this.refreshState(), STATE_TICK_MS);
    this.refreshState();
  }

  public receiveAudio(pcm: Uint8Array): void {
    if (this.ended) return;
    this.heardAt = Date.now();
    const wasHearing = this.media.hearing;
    this.media.receiveMicrophone(pcm);
    if (this.media.hearing !== wasHearing) this.refreshState();
  }

  public receiveText(text: string): void {
    if (this.ended) return;
    this.heardAt = Date.now();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const event = VoiceCallClientEventSchema.safeParse(parsed);
    if (!event.success) return;
    if (event.data.type === "hangup") {
      void this.end("hung_up");
      return;
    }
    this.media.receivePlayback(event.data.playbackId, event.data.status);
    this.refreshState();
  }

  /** The peer's socket closed: nobody is left to hear him. */
  public closed(): void {
    if (this.ended) return;
    this.media.lost("device call disconnected");
    void this.end("hung_up");
  }

  public end(reason: VoiceCallEndReason, room?: string): Promise<void> {
    // Disposal below re-enters through the media's leave; the first reason stands.
    if (this.ended) return this.ending ?? Promise.resolve();
    this.ended = true;
    this.ending = (async () => {
      if (this.stateTimer !== undefined) this.timers.clearInterval(this.stateTimer);
      if (this.livenessTimer !== undefined) this.timers.clearInterval(this.livenessTimer);
      if (this.renewTimer !== undefined) this.timers.clearInterval(this.renewTimer);
      try {
        await this.session?.dispose();
      } catch {
        // Disposal is idempotent; the lease below is released only after it settles.
      }
      this.releaseLease();
      this.send({ schemaVersion: 1, type: "ended", reason, ...(room === undefined ? {} : { room }) });
      this.options.peer.close(1000, reason);
      this.options.onEnded?.(reason);
    })();
    return this.ending;
  }

  public status(): DiscordVoiceSessionStatus | undefined {
    return this.session?.status();
  }

  private releaseLease(): void {
    if (this.leaseHeld) this.options.lease.release();
    this.leaseHeld = false;
  }

  private refreshState(): void {
    if (this.ended) return;
    const status = this.session?.status();
    if (status?.active !== true) return;
    const state: VoiceCallState =
      status.activity === "speaking"
        ? "speaking"
        : this.media.hearing
          ? "hearing"
          : status.activity === "thinking" || status.handoffCount > 0
            ? "thinking"
            : "listening";
    this.publishState(state);
  }

  private publishState(state: VoiceCallState): void {
    if (this.state === state) return;
    this.state = state;
    this.send({ schemaVersion: 1, type: "state", state });
  }

  private send(event: VoiceCallServerEvent): void {
    try {
      this.options.peer.sendEvent(VoiceCallServerEventSchema.parse(event));
    } catch {
      // A closed peer cannot hear state; the call still ends through its own path.
    }
  }
}
