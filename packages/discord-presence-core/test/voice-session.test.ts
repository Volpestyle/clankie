import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  VOX_IPC_PROTOCOL_VERSION,
  VoxClientError,
  type VoxClient,
  type VoxControlEvent,
  type VoxDecodedVideoFrame,
  type VoxMusicRequest,
  type VoxProcessStatus,
  type VoxStreamConnect,
  type VoxTtsAudio,
  type VoxUserAudioFrame,
} from "@clankie/vox-client";
import {
  DiscordVoiceEvidenceSchema,
  type CaptainChannelTurnResult,
  type DiscordPresenceChannelTurnRequest,
  type DiscordVoiceEvidence,
} from "@clankie/protocol";
import {
  MAX_REALTIME_AUDIO_APPEND_BYTES,
  type RealtimeSessionCloseReason,
  type RealtimeTimers,
} from "../src/realtime-session.ts";
import type { VoiceFloorOptions } from "../src/voice-floor.ts";
import { DiscordVoiceIngress } from "../src/voice-ingress.ts";
import {
  CAPTAIN_UNREACHABLE_TEXT,
  DiscordVoiceSession,
  ENGAGED_HOLD_MS,
  ENGAGED_TICK_MS,
  SPEAKER_TRANSCRIPTION_IDLE_MS,
  FLOOR_WORK_HEARTBEAT_MS,
  FLOOR_WORK_MAX_MS,
  ADDRESSED_OFFER_TURN_ITEM,
  ENGAGED_OFFER_TURN_ITEM,
  UNPROMPTED_TURN_ITEM,
  type DiscordVoiceBriefingRequest,
  type VoiceConversationOpenInput,
  type VoiceConversationPort,
  type VoiceTranscriptionHandlers,
  type VoiceTranscriptionPort,
} from "../src/voice-session.ts";

// ---------------------------------------------------------------------------
// Vox double: one process with role-scoped readiness and correlated media ids.
// ---------------------------------------------------------------------------

class FakeVox implements VoxClient {
  public readonly available = true;
  public status: VoxProcessStatus = "ready";
  public detail = "fake Vox";
  public autoReady = true;
  public autoBuffer = true;
  public autoDrain = true;
  public autoMusicStart = true;
  public sendAudioError: Error | undefined;
  public finishError: Error | undefined;
  public stopError: Error | undefined;
  public leaveError: Error | undefined;
  public subscribeError: Error | undefined;
  public unsubscribeError: Error | undefined;
  public musicStopError: Error | undefined;
  public readonly joins: {
    connectionId: string;
    guildId: string;
    channelId: string;
    selfMute?: boolean;
  }[] = [];
  public readonly leaves: (string | undefined)[] = [];
  public readonly subscriptions: {
    userId: string;
    captureId: string;
    options?: { silenceDurationMs?: number; sampleRate?: number };
  }[] = [];
  public readonly unsubscriptions: string[] = [];
  public readonly audio: { playbackId: string; pcm: Buffer; sampleRate?: number }[] = [];
  public readonly finishes: string[] = [];
  public readonly stops: string[] = [];
  public readonly musicRequests: VoxMusicRequest[] = [];
  public readonly musicGains: { musicId: string; target: number; fadeMs?: number }[] = [];
  public activePlaybackId: string | undefined;
  public closeCalls = 0;
  private readonly statusListeners = new Set<(status: VoxProcessStatus, detail: string) => void>();
  private readonly eventListeners = new Set<(event: VoxControlEvent) => void>();
  private readonly audioListeners = new Set<(frame: VoxUserAudioFrame) => void>();
  private readonly frameListeners = new Set<(frame: VoxDecodedVideoFrame) => void>();
  private readonly bufferedPlaybackIds = new Set<string>();

  public joinVoice(input: {
    connectionId: string;
    guildId: string;
    channelId: string;
    selfMute?: boolean;
  }): void {
    this.joins.push(input);
    if (!this.autoReady) return;
    this.emit({ type: "ready", connectionId: input.connectionId });
    this.emit({
      type: "transport_state",
      role: "voice",
      connectionId: input.connectionId,
      status: "ready",
    });
    this.emit({
      type: "dave_state",
      role: "voice",
      connectionId: input.connectionId,
      status: "ready",
      protocolVersion: 1,
    });
  }

  public leaveVoice(reason?: string): void {
    this.leaves.push(reason);
    if (this.leaveError !== undefined) throw this.leaveError;
  }

  public sendAudio(input: VoxTtsAudio): void {
    if (this.sendAudioError !== undefined) throw this.sendAudioError;
    this.activePlaybackId = input.playbackId;
    this.audio.push({
      playbackId: input.playbackId,
      pcm: Buffer.from(input.pcmBase64, "base64"),
      ...(input.sampleRate === undefined ? {} : { sampleRate: input.sampleRate }),
    });
    if (this.autoBuffer && !this.bufferedPlaybackIds.has(input.playbackId)) {
      this.bufferedPlaybackIds.add(input.playbackId);
      this.emit({ type: "tts_playback_state", playbackId: input.playbackId, status: "buffered" });
      this.emit({ type: "tts_playback_state", playbackId: input.playbackId, status: "started" });
    }
  }

  public finishTtsPlayback(playbackId: string): void {
    if (this.finishError !== undefined) throw this.finishError;
    this.finishes.push(playbackId);
    if (this.autoDrain) {
      this.activePlaybackId = undefined;
      this.emit({ type: "tts_playback_state", playbackId, status: "drained" });
    }
  }

  public stopTtsPlayback(playbackId: string): void {
    if (this.stopError !== undefined) throw this.stopError;
    this.stops.push(playbackId);
    if (this.activePlaybackId === playbackId) this.activePlaybackId = undefined;
    this.emit({ type: "tts_playback_state", playbackId, status: "stopped" });
  }

  public subscribeUserAudio(
    userId: string,
    captureId: string,
    options?: { silenceDurationMs?: number; sampleRate?: number },
  ): void {
    if (this.subscribeError !== undefined) throw this.subscribeError;
    this.subscriptions.push({ userId, captureId, ...(options === undefined ? {} : { options }) });
  }

  public unsubscribeUserAudio(userId: string): void {
    this.unsubscriptions.push(userId);
    if (this.unsubscribeError !== undefined) throw this.unsubscribeError;
  }

  public emit(event: VoxControlEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  public emitAudio(userId: string, captureId: string, pcm: Buffer): void {
    const samples = Math.floor(pcm.byteLength / 2);
    for (const listener of this.audioListeners) {
      listener({
        userId,
        captureId,
        signalPeakAbs: 0,
        signalActiveSampleCount: samples,
        signalSampleCount: samples,
        pcm,
      });
    }
  }

  public setStatus(status: VoxProcessStatus, detail = this.detail): void {
    this.status = status;
    this.detail = detail;
    for (const listener of this.statusListeners) listener(status, detail);
  }

  public onStatus(listener: (status: VoxProcessStatus, detail: string) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status, this.detail);
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

  public onDecodedFrame(listener: (frame: VoxDecodedVideoFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  public updateVoiceServer(): void {}
  public updateVoiceState(): void {}
  public stopPlayback(): void {}
  public musicPlay(input: VoxMusicRequest): void {
    this.musicRequests.push(input);
    if (this.autoMusicStart) {
      this.emit({ type: "player_state", status: "playing", musicId: input.musicId });
    }
  }
  public musicStop(musicId: string): void {
    if (this.musicStopError !== undefined) throw this.musicStopError;
    this.emit({ type: "music_idle", musicId });
  }
  public musicPause(_musicId: string): void {}
  public musicResume(_musicId: string): void {}
  public musicSetGain(musicId: string, target: number, fadeMs?: number): void {
    this.musicGains.push({ musicId, target, ...(fadeMs === undefined ? {} : { fadeMs }) });
  }
  public streamWatchConnect(_input: VoxStreamConnect): void {}
  public streamWatchDisconnect(_reason?: string): void {}
  public subscribeUserVideo(_userId: string, _maxFramesPerSecond?: number): void {}
  public unsubscribeUserVideo(_userId: string): void {}
  public streamPublishConnect(_input: VoxStreamConnect): void {}
  public streamPublishDisconnect(_reason?: string): void {}
  public streamPublishPlay(_url: string): void {}
  public streamPublishBrowserStart(_mimeType?: "image/png"): void {}
  public streamPublishBrowserFrame(_input: {
    mimeType: "image/png";
    frameBase64: string;
    capturedAtMs?: number;
  }): void {}
  public streamPublishStop(): void {}
  public streamPublishPause(): void {}
  public streamPublishResume(): void {}
  public close(): void {
    this.closeCalls += 1;
  }
}

// ---------------------------------------------------------------------------
// Realtime port fakes: structural VoiceTranscriptionPort / VoiceConversationPort
// implementations that record every call and honor T2's zero-what-you-are-
// handed contract.
// ---------------------------------------------------------------------------

class FakeTranscription implements VoiceTranscriptionPort {
  public isOpen = true;
  public readonly appended: Buffer[] = [];
  public commits = 0;
  public readonly handlers: VoiceTranscriptionHandlers;

  public constructor(handlers: VoiceTranscriptionHandlers) {
    this.handlers = handlers;
  }

  public appendAudio(pcm: Buffer): void {
    if (!this.isOpen) {
      pcm.fill(0);
      throw new Error("Realtime session is closed");
    }
    this.appended.push(Buffer.from(pcm));
    pcm.fill(0);
  }

  public commitAudio(): void {
    if (!this.isOpen) throw new Error("Realtime session is closed");
    this.commits += 1;
  }

  public close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.handlers.onClose("closed");
  }

  public lose(reason: RealtimeSessionCloseReason): void {
    this.isOpen = false;
    this.handlers.onClose(reason);
  }
}

class FakeConversation implements VoiceConversationPort {
  public isOpen = true;
  public readonly appended: Buffer[] = [];
  public readonly textItems: string[] = [];
  public readonly imageItems: string[] = [];
  public responseCreates = 0;
  public readonly truncations: { itemId: string; audioEndMs: number }[] = [];
  public readonly functionResults: { callId: string; output: string }[] = [];
  public readonly input: VoiceConversationOpenInput;

  public constructor(input: VoiceConversationOpenInput) {
    this.input = input;
  }

  public appendAudio(pcm: Buffer): void {
    if (!this.isOpen) {
      pcm.fill(0);
      throw new Error("Realtime session is closed");
    }
    this.appended.push(Buffer.from(pcm));
    pcm.fill(0);
  }

  public createTextItem(text: string): void {
    this.assertOpen();
    this.textItems.push(text);
  }

  public createImageItem(pngBase64: string, _mimeType?: "image/png"): void {
    this.assertOpen();
    this.imageItems.push(pngBase64);
  }

  public createResponse(): void {
    this.assertOpen();
    this.responseCreates += 1;
  }

  public truncate(itemId: string, audioEndMs: number): void {
    this.assertOpen();
    this.truncations.push({ itemId, audioEndMs });
  }

  public submitFunctionResult(callId: string, output: string): void {
    this.assertOpen();
    this.functionResults.push({ callId, output });
  }

  public close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.input.onClose("closed");
  }

  public lose(reason: RealtimeSessionCloseReason): void {
    this.isOpen = false;
    this.input.onClose(reason);
  }

  private assertOpen(): void {
    if (!this.isOpen) throw new Error("Realtime session is closed");
  }
}

class TestTimers implements RealtimeTimers {
  public readonly scheduled: {
    handle: number;
    delayMs: number;
    handler: () => void;
    cleared: boolean;
    fired: boolean;
  }[] = [];
  private nextHandle = 1;

  public setTimeout(handler: () => void, delayMs: number): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.scheduled.push({ handle, delayMs, handler, cleared: false, fired: false });
    return handle;
  }

  public clearTimeout(handle: unknown): void {
    const entry = this.scheduled.find((candidate) => candidate.handle === handle);
    if (entry !== undefined) entry.cleared = true;
  }

  public pending(): { delayMs: number }[] {
    return this.scheduled.filter((candidate) => !candidate.cleared && !candidate.fired);
  }

  public fire(delayMs: number): void {
    const entry = this.scheduled.find(
      (candidate) => !candidate.cleared && !candidate.fired && candidate.delayMs === delayMs,
    );
    if (entry === undefined) throw new Error(`No armed timer with delay ${delayMs.toString()}`);
    entry.fired = true;
    entry.handler();
  }

  public fireLast(delayMs: number): void {
    const entry = this.scheduled.findLast(
      (candidate) => !candidate.cleared && !candidate.fired && candidate.delayMs === delayMs,
    );
    if (entry === undefined) throw new Error(`No armed timer with delay ${delayMs.toString()}`);
    entry.fired = true;
    entry.handler();
  }
}

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

const GUILD = "12345";
const CHANNEL = "67890";
const OWNER = "1000";
const ALICE = "1111";
const BOB = "2222";
const MALLORY = "6666";

/** 350 ms of Vox 24 kHz mono s16le — the sustained-speech barge-in threshold. */
const BARGE_IN_SOURCE_BYTES = 16_800;

async function flush(rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Byte fill whose s16le samples land at conversational speech level (0x1010 = 4_112). */
const SPEECH_FILL = 0x10;
/** Byte fill whose s16le samples land at room-tone level (0x0101 = 257). */
const ROOM_TONE_FILL = 0x01;

function monoPcm(bytes: number, fill: number = SPEECH_FILL): Buffer {
  return Buffer.alloc(bytes, fill);
}

function pcmDelta(bytes: number, fill = 3): Buffer {
  return Buffer.alloc(bytes, fill);
}

const settledResult = (turnId: string, response: string): CaptainChannelTurnResult =>
  ({ state: "settled", captainSessionId: "session-1", turnId, response }) as CaptainChannelTurnResult;

interface HarnessOptions {
  readonly narrationMinIntervalMs?: number;
  readonly floorOverrides?: Partial<VoiceFloorOptions>;
  readonly captain?: (request: DiscordPresenceChannelTurnRequest) => Promise<CaptainChannelTurnResult>;
  readonly lookAtScreen?: () => Promise<import("../src/voice-session.ts").LookAtScreenResult>;
  readonly speakerTranscriptionGate?: Promise<void>;
  readonly occupants?: readonly { readonly userId: string; readonly displayName?: string }[];
}

function buildHarness(options: HarnessOptions = {}) {
  const clock = { now: 0 };
  const timers = new TestTimers();
  const evidence: DiscordVoiceEvidence[] = [];
  const vox = new FakeVox();
  const transcriptions: FakeTranscription[] = [];
  const speakerTranscriptions = new Map<string, FakeTranscription>();
  const conversations: FakeConversation[] = [];
  const briefingCalls: DiscordVoiceBriefingRequest[] = [];
  const submitCalls: DiscordPresenceChannelTurnRequest[] = [];
  const ports = {
    failTranscriptionOpens: 0,
    openTranscription: async (handlers: VoiceTranscriptionHandlers): Promise<VoiceTranscriptionPort> => {
      if (ports.failTranscriptionOpens > 0) {
        ports.failTranscriptionOpens -= 1;
        throw new Error("listener open refused");
      }
      // The first open is join's fail-fast probe. Tests can hold later,
      // speaker-bound opens across a consent transition.
      if (transcriptions.length > 0 && options.speakerTranscriptionGate !== undefined) {
        await options.speakerTranscriptionGate;
      }
      const transcription = new FakeTranscription(handlers);
      transcriptions.push(transcription);
      return transcription;
    },
    openConversation: (input: VoiceConversationOpenInput): Promise<VoiceConversationPort> => {
      const conversation = new FakeConversation(input);
      conversations.push(conversation);
      return Promise.resolve(conversation);
    },
  };
  const captain = options.captain ?? (() => Promise.resolve(settledResult("turn-1", "All good.")));
  const ingress = new DiscordVoiceIngress(
    {
      getHealth: () => Promise.resolve({ profileHash: "profile-1" }),
      submitDiscordCaptainChannelTurn: (request) => {
        submitCalls.push(request);
        return captain(request);
      },
    },
    { characterId: "clankie", credentialRef: "discord_bot", transportKind: "bot" },
  );
  const session = new DiscordVoiceSession({
    vox,
    ingress,
    realtime: ports,
    briefing: (request) => {
      briefingCalls.push(request);
      return Promise.resolve({
        instructions: "Be Clankie, in the social register.",
        briefing: "Right now: tending the garden.",
      });
    },
    ...(options.lookAtScreen === undefined ? {} : { lookAtScreen: options.lookAtScreen }),
    floor: {
      names: ["clankie"],
      replyPolicy: "addressed",
      chattiness: "balanced",
      decayWindowMs: 60_000,
      ...options.floorOverrides,
    },
    ...(options.narrationMinIntervalMs === undefined
      ? {}
      : { narrationMinIntervalMs: options.narrationMinIntervalMs }),
    presenceSessionId: () => "presence-1",
    emit: (event) => {
      // Every emission must be protocol-valid, including the fastPath/turnId
      // invariant — the schema is the reviewer here.
      DiscordVoiceEvidenceSchema.parse(event);
      evidence.push(event);
      return Promise.resolve();
    },
    clock: () => clock.now,
    timers,
    ...(options.occupants === undefined ? {} : { channelOccupants: () => options.occupants ?? [] }),
  });
  let itemSequence = 0;
  const harness = {
    session,
    clock,
    timers,
    evidence,
    transcriptions,
    conversations,
    briefingCalls,
    submitCalls,
    ports,
    vox,
    transcription: (): FakeTranscription => at(transcriptions, -1),
    transcriptionFor: (userId: string): FakeTranscription => {
      let transcription = speakerTranscriptions.get(userId);
      if (transcription === undefined) {
        transcription = [...transcriptions].reverse().find((candidate) => candidate.isOpen);
        if (transcription !== undefined) speakerTranscriptions.set(userId, transcription);
      }
      if (transcription === undefined) throw new Error(`No transcription session for ${userId}`);
      return transcription;
    },
    conversation: (): FakeConversation => at(conversations, -1),
    ofType: <T extends DiscordVoiceEvidence["type"]>(type: T): Extract<DiscordVoiceEvidence, { type: T }>[] =>
      evidence.filter((event): event is Extract<DiscordVoiceEvidence, { type: T }> => event.type === type),
    join: async () => {
      await session.join({
        guildId: GUILD,
        channelId: CHANNEL,
        invokingUserId: OWNER,
      });
    },
    consent: async (userId: string) => {
      await session.setConsent(GUILD, CHANNEL, userId, true);
    },
    startCapture: (userId: string) => {
      const subscriptionStart = vox.subscriptions.length;
      const unsubscribeStart = vox.unsubscriptions.length;
      vox.emit({ type: "speaking_start", userId });
      if (speakerTranscriptions.get(userId)?.isOpen !== true) {
        speakerTranscriptions.set(userId, at(transcriptions, -1));
      }
      const captureId = (): string | undefined => {
        const subscription = vox.subscriptions
          .slice(subscriptionStart)
          .findLast((candidate) => candidate.userId === userId);
        return subscription?.captureId;
      };
      return {
        userId,
        captureId,
        stream: {
          write(pcm: Buffer): boolean {
            setImmediate(() => {
              const id = captureId();
              if (id === undefined) pcm.fill(0);
              else vox.emitAudio(userId, id, pcm);
            });
            return true;
          },
          end(): void {
            setImmediate(() => {
              const id = captureId();
              if (id !== undefined) vox.emit({ type: "user_audio_end", userId, captureId: id });
            });
          },
          on(_event: string, _listener: () => void): void {},
          get destroyed(): boolean {
            return vox.unsubscriptions.slice(unsubscribeStart).includes(userId);
          },
        },
      };
    },
    transcribe: (userId: string, text: string): void => {
      itemSequence += 1;
      harness
        .transcriptionFor(userId)
        .handlers.onTranscript({ itemId: `item_${itemSequence.toString()}`, text, final: true });
    },
    /** One short spoken utterance: capture opens, PCM flows, capture ends, the transcript lands. */
    say: async (userId: string, text: string): Promise<void> => {
      const capture = harness.startCapture(userId);
      capture.stream.write(monoPcm(BARGE_IN_SOURCE_BYTES));
      await flush();
      capture.stream.end();
      await flush();
      harness.transcribe(userId, text);
      await flush();
    },
  };
  return harness;
}

function at<T>(items: readonly T[], index: number): T {
  const item = items.at(index);
  if (item === undefined) throw new Error("Expected an element and found none");
  return item;
}

async function joinedHarness(options: HarnessOptions = {}) {
  const harness = buildHarness(options);
  await harness.join();
  return harness;
}

/** Join, consent alice, and wake him with an addressed utterance. */
async function engagedHarness(options: HarnessOptions = {}) {
  const harness = await joinedHarness(options);
  await harness.consent(ALICE);
  await harness.say(ALICE, "hey clankie you there");
  return harness;
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("lifecycle", () => {
  it("joins with DAVE, opens the dormant listener, and reports the two-tier status", async () => {
    const harness = await joinedHarness();
    expect(harness.transcriptions).toHaveLength(1);
    expect(harness.session.status()).toMatchObject({
      active: true,
      guildId: GUILD,
      channelId: CHANNEL,
      daveProtocolVersion: 1,
      consentedParticipantCount: 1,
      activeCaptureCount: 0,
      floorState: "dormant",
      engaged: false,
    });
    expect(harness.session.canHear(OWNER)).toBe(true);
    expect(harness.evidence.map((event) => event.type)).toEqual(["joined", "consent"]);
  });

  it("does not join on Vox process readiness without voice transport and positive DAVE readiness", async () => {
    const harness = buildHarness();
    harness.vox.autoReady = false;
    let settled = false;
    const joining = harness.join().then(() => {
      settled = true;
    });
    await flush();
    const connectionId = at(harness.vox.joins, -1).connectionId;
    harness.vox.emit({ type: "process_ready", protocolVersion: VOX_IPC_PROTOCOL_VERSION });
    await flush();
    expect(settled).toBe(false);
    harness.vox.emit({ type: "transport_state", role: "voice", connectionId, status: "ready" });
    harness.vox.emit({
      type: "dave_state",
      role: "voice",
      connectionId,
      status: "ready",
      protocolVersion: 0,
    });
    await flush();
    expect(settled).toBe(false);
    harness.vox.emit({
      type: "dave_state",
      role: "voice",
      connectionId,
      status: "ready",
      protocolVersion: 2,
    });
    await joining;
    expect(harness.session.status()).toMatchObject({ active: true, daveProtocolVersion: 2 });
  });

  it("rejects join only for a matching primary voice error", async () => {
    const harness = buildHarness();
    harness.vox.autoReady = false;
    let settled = false;
    const joining = harness.join();
    void joining.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush();
    const connectionId = at(harness.vox.joins, -1).connectionId;
    harness.vox.emit({
      type: "error",
      code: "stream_watch_connect_failed",
      message: "watch failed",
      role: "stream_watch",
    });
    harness.vox.emit({
      type: "error",
      code: "voice_runtime_error",
      message: "publish failed",
      role: "stream_publish",
    });
    harness.vox.emit({
      type: "error",
      code: "voice_connect_failed",
      message: "old voice failed",
      role: "voice",
      connectionId: "old-connection",
    });
    await flush();
    expect(settled).toBe(false);

    harness.vox.emit({
      type: "error",
      code: "voice_connect_failed",
      message: "current voice failed",
      role: "voice",
      connectionId,
    });
    await expect(joining).rejects.toThrow("Discord voice transport failed");
    expect(harness.session.status().active).toBe(false);
    expect(harness.ofType("left")).toHaveLength(1);
  });

  it("an asked join (no invoker) opts in nobody until explicit opt-in", async () => {
    const harness = buildHarness();
    await harness.session.join({
      guildId: GUILD,
      channelId: CHANNEL,
    });
    expect(harness.session.status().consentedParticipantCount).toBe(0);
    expect(harness.session.canHear(OWNER)).toBe(false);
    // No auto-granted consent means no consent evidence either.
    expect(harness.evidence.map((event) => event.type)).toEqual(["joined"]);
    // The asker consents like everyone else: speaking before opt-in is never
    // subscribed, and opting in restores the ordinary path.
    harness.vox.emit({ type: "speaking_start", userId: OWNER });
    expect(harness.vox.subscriptions).toHaveLength(0);
    await harness.consent(OWNER);
    expect(harness.session.status().consentedParticipantCount).toBe(1);
    expect(harness.session.canHear(OWNER)).toBe(true);
    harness.vox.emit({ type: "speaking_start", userId: OWNER });
    await flush();
    expect(harness.vox.subscriptions).toHaveLength(1);
  });

  it("fails the join when the listener cannot open, and leaves cleanly", async () => {
    const harness = buildHarness();
    harness.ports.failTranscriptionOpens = 1;
    await expect(harness.join()).rejects.toThrow("listener open refused");
    expect(harness.session.status().active).toBe(false);
    expect(harness.vox.leaves).toContain("join_failed");
    expect(harness.evidence.map((event) => event.type)).toEqual(["left"]);
  });

  it("preserves the join failure when the cleanup leave command also throws", async () => {
    const harness = buildHarness();
    harness.ports.failTranscriptionOpens = 1;
    harness.vox.leaveError = new VoxClientError("not_ready", "Vox failed during cleanup");
    await expect(harness.join()).rejects.toThrow("listener open refused");
    expect(harness.session.status()).toMatchObject({
      active: false,
      activeCaptureCount: 0,
      engaged: false,
      floorState: "dormant",
    });
    expect(harness.ofType("left")).toHaveLength(1);
  });

  it("leave closes both sessions with reason closed, cancels timers, and zeroes the ring", async () => {
    const harness = await engagedHarness();
    const transcription = harness.transcription();
    const conversation = harness.conversation();
    await harness.session.leave();
    expect(transcription.isOpen).toBe(false);
    expect(conversation.isOpen).toBe(false);
    expect(harness.ofType("failed")).toHaveLength(0);
    expect(harness.ofType("left")).toHaveLength(1);
    expect(harness.timers.pending()).toHaveLength(0);
    // A rejoin engages with a clean ring: nothing from the earlier call may
    // seed the new session.
    await harness.join();
    await harness.consent(ALICE);
    await harness.say(ALICE, "clankie fresh start");
    const seed = at(harness.conversation().textItems, 0);
    expect(seed).toContain("fresh start");
    expect(seed).not.toContain("you there");
  });

  it("clears all local voice state before terminal cleanup commands can throw", async () => {
    const harness = await engagedHarness();
    harness.vox.autoDrain = false;
    harness.conversation().input.onAudioDelta(pcmDelta(480), "item_cleanup");
    await flush();
    await harness.session.handleMusic({ kind: "play", url: "https://youtu.be/cleanup" }, OWNER);
    const capture = harness.startCapture(ALICE);
    await flush();
    const captureId = capture.captureId();
    expect(captureId).toEqual(expect.any(String));
    harness.vox.unsubscribeError = new VoxClientError("not_ready", "capture cleanup failed");
    harness.vox.stopError = new VoxClientError("not_ready", "playback cleanup failed");
    harness.vox.musicStopError = new VoxClientError("not_ready", "music cleanup failed");
    harness.vox.leaveError = new VoxClientError("not_ready", "leave cleanup failed");

    await expect(harness.session.leave()).resolves.toBeUndefined();
    expect(harness.session.status()).toMatchObject({
      active: false,
      activeCaptureCount: 0,
      engaged: false,
      floorState: "dormant",
    });
    expect(harness.session.status().guildId).toBeUndefined();
    expect(harness.session.status().channelId).toBeUndefined();
    expect(harness.session.music.snapshot()).toEqual({
      current: undefined,
      queued: [],
      paused: false,
      starting: false,
      sink: "audio",
    });
    expect(harness.transcriptions.every((transcription) => !transcription.isOpen)).toBe(true);
    expect(harness.ofType("left")).toHaveLength(1);

    const stale = monoPcm(3_840);
    harness.vox.emitAudio(ALICE, captureId ?? "missing", stale);
    expect(stale.equals(Buffer.alloc(stale.byteLength))).toBe(true);
  });

  it("contains leave rejection from a terminal Vox status callback", async () => {
    const harness = await joinedHarness();
    harness.vox.leaveError = new VoxClientError("closed", "Vox is closed");
    harness.vox.setStatus("error", "Vox exited");
    await flush();
    expect(harness.session.status()).toMatchObject({ active: false, floorState: "dormant" });
    expect(harness.ofType("left")).toHaveLength(1);
  });

  it("ignores listener callbacks that arrive after leave", async () => {
    const harness = await joinedHarness();
    const transcription = harness.transcription();
    await harness.session.leave();
    const evidenceCount = harness.evidence.length;
    transcription.handlers.onTranscript({ itemId: "item_stale", text: "hey clankie", final: true });
    transcription.handlers.onClose("socket");
    await flush();
    expect(harness.conversations).toHaveLength(0);
    expect(harness.evidence).toHaveLength(evidenceCount);
    expect(harness.timers.pending()).toHaveLength(0);
  });

  it("leaves and rejoins without closing the shared Vox process", async () => {
    const harness = await joinedHarness();
    await harness.session.leave();
    expect(harness.vox.closeCalls).toBe(0);
    await harness.join();
    expect(harness.session.status().active).toBe(true);
    expect(harness.vox.joins).toHaveLength(2);
    expect(harness.vox.joins[1]?.connectionId).not.toBe(harness.vox.joins[0]?.connectionId);
    expect(harness.vox.closeCalls).toBe(0);
  });

  it("ignores delayed leave events from an old connection while a reordered rejoin becomes ready", async () => {
    const harness = buildHarness();
    harness.vox.autoReady = false;
    const firstJoin = harness.join();
    await flush();
    const firstConnectionId = at(harness.vox.joins, -1).connectionId;
    harness.vox.emit({
      type: "dave_state",
      role: "voice",
      connectionId: firstConnectionId,
      status: "ready",
      protocolVersion: 1,
    });
    harness.vox.emit({
      type: "transport_state",
      role: "voice",
      connectionId: firstConnectionId,
      status: "ready",
    });
    await firstJoin;
    await harness.session.leave();

    let rejoined = false;
    const secondJoin = harness.join().then(() => {
      rejoined = true;
    });
    await flush();
    const secondConnectionId = at(harness.vox.joins, -1).connectionId;
    expect(secondConnectionId).not.toBe(firstConnectionId);
    harness.vox.emit({
      type: "transport_state",
      role: "voice",
      connectionId: firstConnectionId,
      status: "disconnected",
    });
    harness.vox.emit({
      type: "dave_state",
      role: "voice",
      connectionId: firstConnectionId,
      status: "cleared",
    });
    harness.vox.emit({
      type: "dave_state",
      role: "voice",
      connectionId: secondConnectionId,
      status: "ready",
      protocolVersion: 2,
    });
    await flush();
    expect(rejoined).toBe(false);
    harness.vox.emit({
      type: "transport_state",
      role: "voice",
      connectionId: secondConnectionId,
      status: "ready",
    });
    await secondJoin;

    harness.vox.emit({
      type: "dave_state",
      role: "voice",
      connectionId: firstConnectionId,
      status: "cleared",
    });
    await flush();
    expect(harness.session.status()).toMatchObject({ active: true, daveProtocolVersion: 2 });
  });

  it("clears the current session when the voice transport disconnects", async () => {
    const harness = await joinedHarness();
    harness.vox.emit({
      type: "transport_state",
      role: "voice",
      connectionId: at(harness.vox.joins, -1).connectionId,
      status: "disconnected",
    });
    await flush();
    expect(harness.session.status().active).toBe(false);
    expect(harness.ofType("left")).toHaveLength(1);
    expect(harness.vox.closeCalls).toBe(0);
  });

  it("clears the current session when matching DAVE state is cleared", async () => {
    const harness = await joinedHarness();
    harness.vox.emit({
      type: "dave_state",
      role: "voice",
      connectionId: at(harness.vox.joins, -1).connectionId,
      status: "cleared",
    });
    await flush();
    expect(harness.session.status().active).toBe(false);
    expect(harness.ofType("left")).toHaveLength(1);
  });
});

describe("consent boundary", () => {
  // Required mission evidence (criterion 3): unconsented audio is dropped
  // before the socket boundary because the user is never subscribed at all.
  it("never subscribes an unconsented participant, so appendAudio is never called", async () => {
    const harness = await joinedHarness();
    harness.vox.emit({ type: "speaking_start", userId: MALLORY });
    await flush();
    expect(harness.vox.subscriptions).toHaveLength(0);
    expect(harness.session.status().activeCaptureCount).toBe(0);
    expect(harness.transcription().appended).toHaveLength(0);
  });

  it("subscribes consented speakers as correlated 24 kHz Vox captures", async () => {
    const harness = await joinedHarness();
    await harness.consent(ALICE);
    harness.startCapture(ALICE);
    await flush();
    expect(at(harness.vox.subscriptions, -1)).toMatchObject({
      userId: ALICE,
      captureId: expect.any(String),
      options: { sampleRate: 24_000, silenceDurationMs: 800 },
    });
  });

  it("finalizes a capture only for its matching native capture id", async () => {
    const harness = await joinedHarness();
    await harness.consent(ALICE);
    harness.startCapture(ALICE);
    await flush();
    const captureId = at(harness.vox.subscriptions, -1).captureId;
    harness.vox.emit({ type: "user_audio_end", userId: ALICE, captureId: "stale-capture" });
    await flush();
    expect(harness.session.status().activeCaptureCount).toBe(1);
    expect(harness.vox.unsubscriptions).not.toContain(ALICE);

    harness.vox.emit({ type: "user_audio_end", userId: ALICE, captureId });
    await flush();
    expect(harness.session.status().activeCaptureCount).toBe(0);
    expect(harness.vox.unsubscriptions).toContain(ALICE);
  });

  it("disarms an ended capture before an immediate speaking follow-up rearms a new id", async () => {
    const harness = await joinedHarness();
    await harness.consent(ALICE);
    harness.startCapture(ALICE);
    await flush();
    const firstCaptureId = at(harness.vox.subscriptions, -1).captureId;
    harness.vox.unsubscribeError = new VoxClientError("not_ready", "Vox ended while disarming");

    harness.vox.emit({ type: "user_audio_end", userId: ALICE, captureId: firstCaptureId });
    harness.vox.emit({ type: "speaking_start", userId: ALICE });
    await flush();

    const secondCaptureId = at(harness.vox.subscriptions, -1).captureId;
    expect(secondCaptureId).not.toBe(firstCaptureId);
    expect(harness.session.status().activeCaptureCount).toBe(1);
    expect(at(harness.ofType("failed"), -1)).toMatchObject({
      stage: "capture",
      code: "voice_capture_unsubscribe_failed",
    });
  });

  it("clears a capture whose Vox subscription throws and recovers on the next speaking start", async () => {
    const harness = await joinedHarness();
    await harness.consent(ALICE);
    harness.vox.subscribeError = new VoxClientError("not_ready", "Vox cannot subscribe");
    harness.vox.emit({ type: "speaking_start", userId: ALICE });
    await flush();
    expect(harness.session.status().activeCaptureCount).toBe(0);
    expect(at(harness.ofType("failed"), -1)).toMatchObject({
      stage: "capture",
      code: "voice_capture_subscribe_failed",
    });

    harness.vox.subscribeError = undefined;
    harness.vox.emit({ type: "speaking_start", userId: ALICE });
    await flush();
    expect(harness.session.status().activeCaptureCount).toBe(1);
    expect(harness.vox.subscriptions).toHaveLength(1);
  });

  it("forwards an ordered final PCM tail before the matching audio-end finalizes capture", async () => {
    const harness = await joinedHarness();
    await harness.consent(ALICE);
    harness.startCapture(ALICE);
    await flush();
    const captureId = at(harness.vox.subscriptions, -1).captureId;
    const tail = monoPcm(3_840, 7);
    const expected = Buffer.from(tail);
    harness.vox.emitAudio(ALICE, captureId, tail);
    harness.vox.emit({ type: "user_audio_end", userId: ALICE, captureId });
    await flush();

    expect(harness.transcriptionFor(ALICE).appended).toContainEqual(expected);
    expect(harness.transcriptionFor(ALICE).commits).toBe(1);
    expect(harness.session.status().activeCaptureCount).toBe(0);
    expect(tail.equals(Buffer.alloc(tail.byteLength))).toBe(true);
  });

  it("revoking consent mid-capture destroys the capture and stops appends", async () => {
    const harness = await joinedHarness();
    await harness.consent(BOB);
    const capture = harness.startCapture(BOB);
    capture.stream.on("error", () => undefined);
    capture.stream.write(monoPcm(3_840));
    await flush();
    expect(harness.transcription().appended).toHaveLength(1);
    expect(harness.transcription().commits).toBe(0);
    await harness.session.setConsent(GUILD, CHANNEL, BOB, false);
    await flush();
    expect(capture.stream.destroyed).toBe(true);
    try {
      capture.stream.write(monoPcm(3_840));
    } catch {
      // Writing into a destroyed capture may throw; the point is below.
    }
    await flush();
    expect(harness.transcription().appended).toHaveLength(1);
    // Revocation is not a capture failure: no failed evidence is emitted.
    expect(harness.ofType("failed")).toHaveLength(0);
  });

  it("does not install a speaker listener that resolves after consent is revoked", async () => {
    let openSpeaker: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      openSpeaker = resolve;
    });
    const harness = await joinedHarness({ speakerTranscriptionGate: gate });
    await harness.consent(ALICE);
    const capture = harness.startCapture(ALICE);
    capture.stream.on("error", () => undefined);

    await harness.session.setConsent(GUILD, CHANNEL, ALICE, false);
    openSpeaker?.();
    await flush();

    expect(harness.transcriptions).toHaveLength(2);
    expect(at(harness.transcriptions, -1).isOpen).toBe(false);
    expect(harness.session.status().activeCaptureCount).toBe(0);
    expect(at(harness.ofType("failed"), -1)).toMatchObject({
      stage: "transcription_session",
      code: "voice_listener_open_failed",
    });

    // A later opt-in opens a new listener rather than reviving the invalid one.
    await harness.consent(ALICE);
    harness.startCapture(ALICE);
    await flush();
    expect(harness.transcriptions).toHaveLength(3);
    expect(at(harness.transcriptions, -1).isOpen).toBe(true);
  });

  it("drops late PCM from an invalidated capture epoch after re-consent", async () => {
    const harness = await joinedHarness();
    await harness.consent(ALICE);
    harness.startCapture(ALICE);
    await flush();
    const staleCaptureId = at(harness.vox.subscriptions, -1).captureId;
    await harness.session.setConsent(GUILD, CHANNEL, ALICE, false);
    await harness.consent(ALICE);
    harness.startCapture(ALICE);
    await flush();
    const currentCaptureId = at(harness.vox.subscriptions, -1).captureId;
    expect(currentCaptureId).not.toBe(staleCaptureId);
    const stale = monoPcm(3_840);
    harness.vox.emitAudio(ALICE, staleCaptureId, stale);
    expect(stale.equals(Buffer.alloc(stale.byteLength))).toBe(true);
    expect(harness.transcriptionFor(ALICE).appended).toHaveLength(0);
  });

  it("leaving the channel revokes consent and destroys the capture", async () => {
    const harness = await joinedHarness();
    await harness.consent(BOB);
    const capture = harness.startCapture(BOB);
    capture.stream.on("error", () => undefined);
    harness.session.memberChannelChanged(GUILD, BOB, "99999");
    await flush();
    expect(capture.stream.destroyed).toBe(true);
    expect(harness.session.status().consentedParticipantCount).toBe(1);
  });

  it("refreshes the shared briefing for a newly permitted participant and purges it on opt-out", async () => {
    const harness = await engagedHarness();
    const conversation = harness.conversation();

    await harness.consent(BOB);
    await flush();
    expect(harness.conversations).toHaveLength(1);
    expect(at(harness.briefingCalls, -1).consentedUserIds).toEqual([OWNER, ALICE, BOB]);
    expect(at(conversation.textItems, -1)).toBe(
      "Room participant briefing refresh:\nRight now: tending the garden.",
    );

    await harness.session.setConsent(GUILD, CHANNEL, BOB, false);
    await flush();
    expect(conversation.isOpen).toBe(false);
    expect(harness.session.status().engaged).toBe(false);
  });
});

describe("typed voice-room input (ADR 0124)", () => {
  it("lets the active room persona answer attributed text without publishing a fake voice transcript", async () => {
    const harness = await joinedHarness({
      occupants: [{ userId: OWNER, displayName: "James" }],
    });
    const publishedTranscripts: string[] = [];
    harness.session.subscribeTranscript((line) => publishedTranscripts.push(line));

    expect(
      harness.session.receiveRoomText({
        guildId: GUILD,
        channelId: CHANNEL,
        userId: ALICE,
        displayName: "Alice",
        deliveryId: "message-1",
        text: "say something in vc clankie",
      }),
    ).toBe(true);
    await flush();

    expect(harness.ofType("text_input")).toMatchObject([
      {
        guildId: GUILD,
        channelId: CHANNEL,
        userId: ALICE,
        deliveryId: "message-1",
        characters: 27,
        addressed: true,
      },
    ]);
    expect(harness.ofType("floor_decision")).toMatchObject([
      { userId: ALICE, deliveryId: "message-1", action: "wake", reason: "addressed" },
    ]);
    expect(harness.conversation().textItems).toContain(
      `Recent room conversation (JSONL; speakerId is gateway-authenticated):\n${JSON.stringify({
        speakerId: ALICE,
        displayName: "Alice",
        text: "say something in vc clankie",
        source: "text",
      })}`,
    );
    expect(harness.conversation().responseCreates).toBe(1);
    expect(publishedTranscripts).toEqual([]);

    // Gateway redelivery remains owned by voice but cannot create a second response.
    expect(
      harness.session.receiveRoomText({
        guildId: GUILD,
        channelId: CHANNEL,
        userId: ALICE,
        deliveryId: "message-1",
        text: "say something in vc clankie",
      }),
    ).toBe(true);
    await flush();
    expect(harness.ofType("text_input")).toHaveLength(1);
    expect(harness.conversation().responseCreates).toBe(1);
  });

  it("leaves text to ordinary ingress when this voice session does not own the room", async () => {
    const harness = await joinedHarness();
    expect(
      harness.session.receiveRoomText({
        guildId: GUILD,
        channelId: "somewhere-else",
        userId: ALICE,
        deliveryId: "message-2",
        text: "hey clankie",
      }),
    ).toBe(false);
    expect(harness.ofType("text_input")).toHaveLength(0);
    expect(harness.conversations).toHaveLength(0);
  });
});

describe("audio path", () => {
  it("streams native Vox audio to the listener as it arrives, zeroes the source, and receipts the utterance", async () => {
    const harness = await joinedHarness();
    await harness.consent(ALICE);
    const chunk = monoPcm(BARGE_IN_SOURCE_BYTES, 2);
    const expected = Buffer.from(chunk);
    const capture = harness.startCapture(ALICE);
    capture.stream.write(chunk);
    await flush();
    // Streaming, not utterance-batched: the append happened before the
    // capture closed.
    expect(harness.transcription().appended).toHaveLength(1);
    expect(at(harness.transcription().appended, 0).equals(expected)).toBe(true);
    expect(chunk.equals(Buffer.alloc(chunk.byteLength))).toBe(true);
    capture.stream.end();
    await flush();
    expect(harness.transcription().commits).toBe(1);
    const utterances = harness.ofType("utterance");
    expect(utterances).toHaveLength(1);
    expect(utterances[0]).toMatchObject({ userId: ALICE, durationMs: 350 });
    expect(utterances[0]?.deliveryId.length).toBeGreaterThan(0);
  });

  it("slices oversized Vox buffers to the realtime append cap", async () => {
    const harness = await joinedHarness();
    await harness.consent(ALICE);
    const capture = harness.startCapture(ALICE);
    // 480 000 native mono bytes split into two capped realtime appends.
    capture.stream.write(monoPcm(480_000));
    await flush();
    const appended = harness.transcription().appended;
    expect(appended.map((buffer) => buffer.byteLength)).toEqual([
      MAX_REALTIME_AUDIO_APPEND_BYTES,
      MAX_REALTIME_AUDIO_APPEND_BYTES,
    ]);
  });

  it("keeps room audio in speaker-bound transcription and sends attributed text to the conversation", async () => {
    const harness = await engagedHarness();
    const conversation = harness.conversation();
    const heardWhileEngaged = conversation.appended.length;
    const capture = harness.startCapture(ALICE);
    capture.stream.write(monoPcm(3_840, 4));
    await flush();
    expect(conversation.appended.length).toBe(heardWhileEngaged);
    expect(at(harness.transcriptionFor(ALICE).appended, -1).byteLength).toBeGreaterThan(0);
    capture.stream.end();
    await flush();
    harness.transcribe(ALICE, "one more detail");
    await flush();
    expect(conversation.textItems).toContain(
      `Room utterance (authenticated Discord speaker): ${JSON.stringify({
        speakerId: ALICE,
        text: "one more detail",
        source: "speech",
      })}`,
    );
    expect(at(conversation.textItems, -1)).toBe(ENGAGED_OFFER_TURN_ITEM);
    // Let the floor decay; the session stays warm but stops hearing the room.
    harness.clock.now = 61_000;
    harness.timers.fire(ENGAGED_TICK_MS);
    await flush();
    const heardAtRelease = conversation.appended.length;
    const listenerHeard = harness.transcriptionFor(ALICE).appended.length;
    const idleCapture = harness.startCapture(ALICE);
    idleCapture.stream.write(monoPcm(3_840, 5));
    await flush();
    expect(conversation.appended.length).toBe(heardAtRelease);
    expect(harness.transcriptionFor(ALICE).appended.length).toBe(listenerHeard + 1);
  });
});

describe("floor decisions", () => {
  it("keeps an all-policy silent turn dormant so the next line gets a fresh offer", async () => {
    const harness = await joinedHarness({ floorOverrides: { replyPolicy: "all" } });
    await harness.consent(ALICE);
    await harness.say(ALICE, "thank you");
    const conversation = harness.conversation();
    expect(at(harness.ofType("floor_decision"), -1)).toMatchObject({
      action: "offer",
      reason: "reply_policy_all",
      state: "dormant",
    });
    expect(at(conversation.textItems, -1)).toBe(ENGAGED_OFFER_TURN_ITEM);
    conversation.input.onResponseDone({
      responseId: "resp_silent",
      status: "completed",
      audioBytes: 0,
      textCharacters: 0,
    });
    await flush();
    expect(harness.session.status().floorState).toBe("dormant");
    expect(harness.timers.pending().map((timer) => timer.delayMs)).toContain(ENGAGED_HOLD_MS);

    await harness.say(ALICE, "are you there?");
    expect(at(harness.ofType("floor_decision"), -1)).toMatchObject({
      action: "offer",
      reason: "reply_policy_all",
      state: "dormant",
    });
    expect(conversation.responseCreates).toBe(2);
    expect(at(conversation.textItems, -1)).toBe(ENGAGED_OFFER_TURN_ITEM);
    conversation.input.onAudioDelta(pcmDelta(480), "item_reply");
    await flush();
    expect(harness.session.status().floorState).toBe("engaged");
  });

  it("an addressed wake briefs, opens, seeds an attributed ring, and responds", async () => {
    const harness = await engagedHarness();
    const deliveryId = at(harness.ofType("utterance"), 0).deliveryId;
    expect(harness.ofType("transcription")).toMatchObject([
      {
        userId: ALICE,
        deliveryId,
        outcome: "accepted",
        addressed: true,
        characters: 21,
      },
    ]);
    expect(harness.ofType("floor_decision")).toMatchObject([
      { userId: ALICE, deliveryId, action: "wake", reason: "addressed", state: "engaged" },
    ]);
    expect(harness.ofType("model_response")).toMatchObject([
      { deliveryId, userId: ALICE, phase: "requested" },
    ]);
    expect(harness.ofType("floor")).toMatchObject([
      { type: "floor", guildId: GUILD, channelId: CHANNEL, state: "engaged", reason: "addressed" },
    ]);
    expect(harness.briefingCalls).toEqual([
      { guildId: GUILD, channelId: CHANNEL, consentedUserIds: [OWNER, ALICE] },
    ]);
    const conversation = harness.conversation();
    expect(conversation.input.instructions).toBe("Be Clankie, in the social register.");
    expect(conversation.textItems).toEqual([
      `Recent room conversation (JSONL; speakerId is gateway-authenticated):\n${JSON.stringify({
        speakerId: ALICE,
        text: "hey clankie you there",
        source: "speech",
      })}`,
      "Right now: tending the garden.",
      ADDRESSED_OFFER_TURN_ITEM,
    ]);
    expect(conversation.responseCreates).toBe(1);
    expect(harness.session.status()).toMatchObject({ floorState: "engaged", engaged: true });
  });

  it("bounds a large room briefing without preventing later speakers from being heard", async () => {
    const harness = await joinedHarness();
    const participants = Array.from({ length: 30 }, (_, index) => String(10_000 + index));
    for (const participant of participants) await harness.consent(participant);

    const speaker = at(participants, -1);
    await harness.say(speaker, "clankie can you hear the back of the room");
    expect(at(harness.briefingCalls, 0).consentedUserIds).toHaveLength(25);
    expect(at(harness.briefingCalls, 0).consentedUserIds[0]).toBe(speaker);
    expect(at(harness.conversation().textItems, 0)).toContain(`"speakerId":"${speaker}"`);
  });

  it("the floor holder continuing gets another response without reopening or re-briefing", async () => {
    const harness = await engagedHarness();
    await harness.say(ALICE, "how are the tests going");
    expect(harness.conversations).toHaveLength(1);
    expect(harness.briefingCalls).toHaveLength(1);
    expect(harness.conversation().responseCreates).toBe(2);
    expect(at(harness.ofType("floor_decision"), -1)).toMatchObject({ action: "offer", userId: ALICE });
    expect(harness.conversation().textItems).toContain(ENGAGED_OFFER_TURN_ITEM);
    harness.conversation().input.onResponseDone({
      responseId: "resp_a",
      status: "completed",
      audioBytes: 0,
      textCharacters: 0,
    });
    harness.conversation().input.onResponseDone({
      responseId: "resp_b",
      status: "completed",
      audioBytes: 0,
      textCharacters: 0,
    });
    await flush();
    expect(harness.ofType("volition")).toHaveLength(0);
    expect(harness.ofType("model_response").filter((event) => event.outcome === "silent")).toHaveLength(2);
  });

  it("a same-breath pivot is an offer the model may refuse, and silence does not refresh decay", async () => {
    const harness = await engagedHarness();
    const conversation = harness.conversation();
    await harness.say(ALICE, "yeah thanks. bob did you finish that thing");
    expect(conversation.responseCreates).toBe(2);
    expect(at(harness.ofType("floor_decision"), -1)).toMatchObject({ action: "offer", userId: ALICE });
    expect(at(conversation.textItems, -1)).toBe(ENGAGED_OFFER_TURN_ITEM);
    conversation.input.onResponseDone({
      responseId: "resp_silent",
      status: "completed",
      audioBytes: 0,
      textCharacters: 0,
    });
    await flush();
    expect(harness.ofType("volition")).toHaveLength(0);
    harness.clock.now = 61_000;
    harness.timers.fire(ENGAGED_TICK_MS);
    await flush();
    expect(at(harness.ofType("floor"), -1)).toMatchObject({ state: "dormant", reason: "decay" });
  });

  it("a name mention from someone else is an offer he may refuse", async () => {
    const harness = await engagedHarness();
    const conversation = harness.conversation();
    await harness.consent(BOB);
    await harness.say(BOB, "clankie did you see that");
    expect(at(harness.ofType("floor_decision"), -1)).toMatchObject({
      action: "offer",
      reason: "mentioned",
      userId: BOB,
    });
    expect(conversation.responseCreates).toBe(2);
    expect(at(conversation.textItems, -1)).toBe(ADDRESSED_OFFER_TURN_ITEM);
    conversation.input.onResponseDone({
      responseId: "resp_about",
      status: "completed",
      audioBytes: 0,
      textCharacters: 0,
    });
    await flush();
    expect(harness.session.status().floorState).toBe("engaged");
    expect(harness.ofType("model_response").some((event) => event.outcome === "silent")).toBe(true);
  });

  it("another speaker's undirected talk is injected into the open session without a response", async () => {
    const harness = await engagedHarness();
    const conversation = harness.conversation();
    await harness.consent(BOB);
    await harness.say(BOB, "so anyway the meeting moved");
    expect(conversation.responseCreates).toBe(1);
    expect(at(conversation.textItems, -1)).toContain("so anyway the meeting moved");
    expect(at(harness.ofType("floor_decision"), -1)).toMatchObject({ action: "listen", userId: BOB });
  });

  it("labels room speech with the occupant's display name", async () => {
    const harness = await engagedHarness({
      occupants: [
        { userId: OWNER, displayName: "James" },
        { userId: ALICE, displayName: "Alice" },
      ],
    });
    expect(at(harness.conversation().textItems, 0)).toContain('"displayName":"Alice"');
    expect(at(harness.conversation().textItems, 0)).toContain(`"speakerId":"${ALICE}"`);
    expect(
      harness
        .conversation()
        .textItems.some((item) => item.includes(JSON.stringify({ speakerId: ALICE, displayName: "Alice" }))),
    ).toBe(true);
  });

  it("applies overlapping finals in start-of-speech order", async () => {
    const harness = await joinedHarness();
    await harness.consent(ALICE);
    await harness.consent(BOB);
    harness.clock.now = 0;
    const alice = harness.startCapture(ALICE);
    alice.stream.write(monoPcm(BARGE_IN_SOURCE_BYTES));
    await flush();
    harness.clock.now = 50;
    const bob = harness.startCapture(BOB);
    bob.stream.write(monoPcm(BARGE_IN_SOURCE_BYTES));
    await flush();
    bob.stream.end();
    await flush();
    harness.transcribe(BOB, "yeah that tracks");
    await flush();
    expect(harness.conversations).toHaveLength(0);
    alice.stream.end();
    await flush();
    harness.transcribe(ALICE, "hey clankie you there");
    await flush();
    expect(harness.conversations).toHaveLength(1);
    const seed = at(harness.conversation().textItems, 0);
    expect(seed).toContain("hey clankie you there");
    expect(seed).toContain("yeah that tracks");
    expect(seed.indexOf("hey clankie you there")).toBeLessThan(seed.indexOf("yeah that tracks"));
    expect(harness.conversation().responseCreates).toBe(1);
  });

  // Required mission evidence: no response path exists without a floor
  // decision — dormant crosstalk opens nothing and creates nothing.
  it("dormant crosstalk with volition off never opens a session and never creates a response", async () => {
    const harness = await joinedHarness({ floorOverrides: { volition: { maxPerHour: 0 } } });
    await harness.consent(BOB);
    await harness.say(BOB, "nice weather this weekend maybe");
    expect(harness.conversations).toHaveLength(0);
    expect(harness.ofType("volition")).toHaveLength(0);
    expect(harness.ofType("floor")).toHaveLength(0);
  });

  it("no phrase releases the floor: a goodbye is answered and decay ends the exchange", async () => {
    const harness = await engagedHarness();
    const conversation = harness.conversation();
    await harness.say(ALICE, "thanks clankie");
    // He gets to say goodbye back rather than being cut off by a word list.
    expect(conversation.responseCreates).toBe(2);
    expect(at(harness.ofType("floor_decision"), -1)).toMatchObject({ action: "hold" });
    expect(harness.session.status().floorState).toBe("engaged");

    harness.clock.now = 61_000;
    harness.timers.fire(ENGAGED_TICK_MS);
    await flush();
    expect(at(harness.ofType("floor"), -1)).toMatchObject({ state: "dormant", reason: "decay" });
    expect(conversation.isOpen).toBe(true);
    expect(harness.session.status()).toMatchObject({ floorState: "dormant", engaged: true });
    harness.timers.fire(ENGAGED_HOLD_MS);
    await flush();
    expect(conversation.isOpen).toBe(false);
    expect(harness.session.status().engaged).toBe(false);
    expect(harness.ofType("failed")).toHaveLength(0);
  });

  it("a wake inside the hold window reuses the held session instead of paying setup again", async () => {
    const harness = await engagedHarness();
    harness.clock.now = 61_000;
    harness.timers.fire(ENGAGED_TICK_MS);
    await flush();
    await harness.say(ALICE, "clankie actually one more thing");
    expect(harness.conversations).toHaveLength(1);
    expect(harness.briefingCalls).toHaveLength(1);
    expect(harness.conversation().responseCreates).toBe(2);
    expect(harness.conversation().textItems.join("\n")).toContain("clankie actually one more thing");
    expect(at(harness.conversation().textItems, -1)).toBe(ADDRESSED_OFFER_TURN_ITEM);
    expect(at(harness.ofType("floor"), -1)).toMatchObject({ state: "engaged", reason: "addressed" });
  });

  it("decay fires from the timer tick with no phrase at all", async () => {
    const harness = await engagedHarness();
    expect(harness.timers.pending().map((timer) => timer.delayMs)).toContain(ENGAGED_TICK_MS);
    harness.clock.now = 61_000;
    harness.timers.fire(ENGAGED_TICK_MS);
    await flush();
    expect(at(harness.ofType("floor"), -1)).toMatchObject({ state: "dormant", reason: "decay" });
    expect(harness.session.status().floorState).toBe("dormant");
    // The warm session now sits behind the hold window.
    expect(harness.timers.pending().map((timer) => timer.delayMs)).toContain(ENGAGED_HOLD_MS);
  });
});

describe("unprompted turns", () => {
  /** Nobody addressed him, the rate cap allows it: the gate opens and he is asked. */
  async function offeredHarness() {
    const harness = await joinedHarness();
    await harness.consent(BOB);
    await harness.say(BOB, "the garden bot has been quiet");
    return harness;
  }

  it("asks his own realtime session rather than a separate yes/no model", async () => {
    const harness = await offeredHarness();
    expect(harness.ofType("floor_decision").map((event) => event.action)).toContain("volition_gate_open");
    // One session, seeded with the room he is deciding about, then asked.
    expect(harness.conversations).toHaveLength(1);
    const conversation = harness.conversation();
    expect(conversation.responseCreates).toBe(1);
    expect(at(conversation.textItems, 0)).toContain(
      JSON.stringify({ speakerId: BOB, text: "the garden bot has been quiet", source: "speech" }),
    );
    expect(at(conversation.textItems, -1)).toBe(UNPROMPTED_TURN_ITEM);
    // Nothing is decided until he answers: the floor has not moved yet.
    expect(harness.session.status().floorState).toBe("dormant");
    expect(harness.ofType("volition")).toHaveLength(0);
  });

  it("speaking takes the offer, engages on the provoking speaker, and is accounted", async () => {
    const harness = await offeredHarness();
    const conversation = harness.conversation();
    conversation.input.onAudioDelta(pcmDelta(480), "item_1");
    await flush();
    // He has the floor from the first syllable, so the nameless reply that
    // follows his interjection is conversation rather than crosstalk.
    expect(harness.session.status().floorState).toBe("engaged");
    expect(at(harness.ofType("floor"), -1)).toMatchObject({ state: "engaged", reason: "volition" });
    expect(at(harness.ofType("volition"), -1)).toMatchObject({ offered: 1, taken: 1, suppressed: 0 });
    conversation.input.onResponseDone({
      responseId: "resp_1",
      status: "completed",
      audioBytes: 480,
      textCharacters: 0,
    });
    await flush();
    // The outcome is recorded exactly once, however the response finishes.
    expect(harness.ofType("volition")).toHaveLength(1);
    await harness.say(BOB, "huh good point");
    expect(harness.conversation().textItems.join("\n")).toContain("huh good point");
    expect(at(harness.conversation().textItems, -1)).toBe(ENGAGED_OFFER_TURN_ITEM);
  });

  it("counts a response that played as audio even when the realtime model sent none", async () => {
    const harness = await offeredHarness();
    const conversation = harness.conversation();
    conversation.input.onAudioDelta(pcmDelta(480), "item_1");
    await flush();
    // The external-TTS shape: the realtime model answers in text and the
    // audible bytes come from the TTS engine, so the response meta reports
    // none. He still spoke, and the receipt has to say so.
    conversation.input.onResponseDone({
      responseId: "resp_tts",
      status: "completed",
      audioBytes: 0,
      textCharacters: 96,
    });
    await flush();
    expect(at(harness.ofType("model_response"), -1)).toMatchObject({ phase: "completed", outcome: "audio" });
  });

  it("an empty response is him passing: suppressed, still dormant, session parked on the hold", async () => {
    const harness = await offeredHarness();
    harness.conversation().input.onResponseDone({
      responseId: "resp_1",
      status: "completed",
      audioBytes: 0,
      textCharacters: 0,
    });
    await flush();
    expect(harness.ofType("volition")).toMatchObject([
      { type: "volition", guildId: GUILD, channelId: CHANNEL, offered: 1, taken: 0, suppressed: 1 },
    ]);
    expect(harness.ofType("floor")).toHaveLength(0);
    expect(harness.session.status().floorState).toBe("dormant");
    // Nothing is left running on his behalf: the warm session sits behind the
    // hold window and closes itself when it expires.
    expect(harness.timers.pending().map((timer) => timer.delayMs)).toContain(ENGAGED_HOLD_MS);
    harness.timers.fire(ENGAGED_HOLD_MS);
    await flush();
    expect(harness.conversation().isOpen).toBe(false);
  });

  it("a session that dies before he answers counts the offer as suppressed", async () => {
    const harness = await offeredHarness();
    harness.conversation().lose("error");
    await flush();
    expect(harness.ofType("volition")).toMatchObject([{ offered: 1, taken: 0, suppressed: 1 }]);
    expect(harness.session.status().floorState).toBe("dormant");
    // Still alive: an addressed wake works afterwards.
    await harness.consent(ALICE);
    await harness.say(ALICE, "hey clankie");
    expect(harness.conversations).toHaveLength(2);
  });
});

describe("speaker attribution", () => {
  it("keeps overlapping transcripts bound to their authenticated Discord streams", async () => {
    const harness = await joinedHarness();
    await harness.consent(ALICE);
    await harness.consent(BOB);
    // Both streams overlap. Alice's final arrives while Bob is still active,
    // but her dedicated transcriber keeps it attached to Alice.
    const alice = harness.startCapture(ALICE);
    alice.stream.write(monoPcm(3_840));
    await flush();
    alice.stream.end();
    await flush();
    harness.startCapture(BOB).stream.write(monoPcm(3_840));
    await flush();
    harness.transcribe(ALICE, "hey clankie what do you think");
    await flush();
    expect(at(harness.conversation().textItems, 0)).toContain(
      JSON.stringify({ speakerId: ALICE, text: "hey clankie what do you think", source: "speech" }),
    );

    // Bob's transcript comes from Bob's listener and moves the floor only when
    // it addresses Clankie; merely opening a stream creates no model input.
    harness.transcribe(BOB, "clankie, I have a different question");
    await flush();
    expect(harness.conversation().textItems.join("\n")).toContain(`"speakerId":"${BOB}"`);
    expect(harness.conversation().textItems.join("\n")).toContain("I have a different question");
    expect(at(harness.conversation().textItems, -1)).toBe(ADDRESSED_OFFER_TURN_ITEM);
  });
});

describe("fast path responses", () => {
  it("measures toFirstAudioMs and playbackMs, reports waking then continuing, and zeroes playback buffers", async () => {
    const harness = await joinedHarness();
    await harness.consent(ALICE);
    harness.clock.now = 1_000;
    await harness.say(ALICE, "hey clankie you there");
    const conversation = harness.conversation();
    expect(conversation.responseCreates).toBe(1);
    harness.clock.now = 1_120;
    const delta = pcmDelta(480);
    const expectedPlayback = Buffer.from(delta);
    conversation.input.onAudioDelta(delta, "item_1");
    // Delta zeroing is the session's duty once it converted the audio.
    expect(delta.equals(Buffer.alloc(480))).toBe(true);
    await flush();
    harness.clock.now = 1_150;
    conversation.input.onResponseDone({
      responseId: "resp_1",
      status: "completed",
      audioBytes: 480,
      textCharacters: 0,
    });
    await flush();
    const first = at(harness.ofType("response"), 0);
    expect(first).toMatchObject({
      fastPath: true,
      state: "settled",
      wake: "waking",
      handoffMs: 0,
      toFirstAudioMs: 120,
      playbackMs: 30,
    });
    expect(first.turnId).toBeUndefined();
    expect(at(harness.vox.audio, 0).pcm.equals(expectedPlayback)).toBe(true);

    // The next turn in the same exchange is a continuing response.
    harness.clock.now = 2_000;
    await harness.say(ALICE, "and how are the tests");
    harness.clock.now = 2_100;
    conversation.input.onAudioDelta(pcmDelta(480), "item_2");
    await flush();
    harness.clock.now = 2_130;
    conversation.input.onResponseDone({
      responseId: "resp_2",
      status: "completed",
      audioBytes: 480,
      textCharacters: 0,
    });
    await flush();
    expect(at(harness.ofType("response"), 1)).toMatchObject({
      fastPath: true,
      wake: "continuing",
      toFirstAudioMs: 100,
      playbackMs: 30,
    });
  });

  it("starts first-audio and played-time evidence at started, not buffered", async () => {
    const harness = await engagedHarness();
    harness.vox.autoBuffer = false;
    harness.vox.autoDrain = false;
    const conversation = harness.conversation();
    harness.clock.now = 1_000;
    conversation.input.onAudioDelta(pcmDelta(480), "item_delayed");
    await flush();
    const playbackId = at(harness.vox.audio, -1).playbackId;
    harness.clock.now = 1_100;
    conversation.input.onResponseDone({
      responseId: "resp_delayed",
      status: "completed",
      audioBytes: 480,
      textCharacters: 0,
    });
    await flush();
    expect(harness.ofType("response")).toHaveLength(0);
    expect(at(harness.ofType("model_response"), -1).phase).toBe("requested");

    harness.clock.now = 1_300;
    harness.vox.emit({ type: "tts_playback_state", playbackId, status: "buffered" });
    await flush();
    expect(at(harness.ofType("model_response"), -1).phase).toBe("requested");
    expect(harness.ofType("response")).toHaveLength(0);

    harness.clock.now = 1_600;
    harness.vox.emit({ type: "tts_playback_state", playbackId, status: "started" });
    await flush();
    expect(at(harness.ofType("model_response"), -1)).toMatchObject({ phase: "completed", outcome: "audio" });
    harness.clock.now = 1_900;
    harness.vox.emit({ type: "tts_playback_state", playbackId, status: "drained" });
    await flush();
    expect(at(harness.ofType("response"), -1)).toMatchObject({
      toFirstAudioMs: 1_600,
      playbackMs: 300,
    });
  });

  it("does not count buffered then drained playback as audible without started", async () => {
    const harness = await engagedHarness();
    harness.vox.autoBuffer = false;
    harness.vox.autoDrain = false;
    const conversation = harness.conversation();
    conversation.input.onAudioDelta(pcmDelta(480), "item_never_started");
    await flush();
    const playbackId = at(harness.vox.audio, -1).playbackId;
    conversation.input.onResponseDone({
      responseId: "resp_never_started",
      status: "completed",
      audioBytes: 480,
      textCharacters: 0,
    });
    harness.vox.emit({ type: "tts_playback_state", playbackId, status: "buffered" });
    harness.vox.emit({ type: "tts_playback_state", playbackId, status: "drained" });
    await flush();

    expect(harness.ofType("response")).toHaveLength(0);
    expect(at(harness.ofType("model_response"), -1)).toMatchObject({
      phase: "completed",
      outcome: "silent",
    });
  });

  it("does not count IPC or prebuffer latency in barge-in truncation", async () => {
    const harness = await engagedHarness();
    harness.vox.autoBuffer = false;
    harness.vox.autoDrain = false;
    const conversation = harness.conversation();
    harness.clock.now = 5_000;
    conversation.input.onAudioDelta(pcmDelta(480), "item_prebuffered");
    await flush();
    const playbackId = at(harness.vox.audio, -1).playbackId;
    harness.clock.now = 5_400;
    const capture = harness.startCapture(ALICE);
    capture.stream.write(monoPcm(BARGE_IN_SOURCE_BYTES));
    await flush();
    expect(conversation.truncations).toHaveLength(0);

    harness.clock.now = 6_000;
    harness.vox.emit({ type: "tts_playback_state", playbackId, status: "buffered" });
    harness.clock.now = 6_400;
    capture.stream.write(monoPcm(2));
    await flush();
    expect(conversation.truncations).toHaveLength(0);

    harness.clock.now = 7_000;
    harness.vox.emit({ type: "tts_playback_state", playbackId, status: "started" });
    harness.clock.now = 7_400;
    capture.stream.write(monoPcm(2));
    await flush();
    expect(conversation.truncations).toEqual([{ itemId: "item_prebuffered", audioEndMs: 400 }]);
  });

  it("settles playback evidence only on the matching Vox drain", async () => {
    const harness = await engagedHarness();
    harness.vox.autoDrain = false;
    const conversation = harness.conversation();
    conversation.input.onAudioDelta(pcmDelta(480), "item_correlated");
    await flush();
    const playbackId = at(harness.vox.audio, -1).playbackId;
    conversation.input.onResponseDone({
      responseId: "resp_correlated",
      status: "completed",
      audioBytes: 480,
      textCharacters: 0,
    });
    await flush();
    expect(harness.ofType("response")).toHaveLength(0);
    harness.vox.emit({ type: "tts_playback_state", playbackId: "stale-playback", status: "drained" });
    await flush();
    expect(harness.ofType("response")).toHaveLength(0);
    harness.vox.emit({ type: "tts_playback_state", playbackId, status: "drained" });
    await flush();
    expect(harness.ofType("response")).toHaveLength(1);
  });

  it("settles a matching Vox playback failure without a response receipt", async () => {
    const harness = await engagedHarness();
    harness.vox.autoDrain = false;
    const conversation = harness.conversation();
    conversation.input.onAudioDelta(pcmDelta(480), "item_failed");
    await flush();
    const playbackId = at(harness.vox.audio, -1).playbackId;
    harness.vox.emit({
      type: "tts_playback_state",
      playbackId,
      status: "failed",
      reason: "transport_send_failed",
    });
    await flush();
    expect(harness.ofType("response")).toHaveLength(0);
    expect(at(harness.ofType("failed"), -1)).toMatchObject({
      stage: "playback",
      code: "transport_send_failed",
    });
  });

  it("removes a failed playback response immediately so the next response can start", async () => {
    const harness = await engagedHarness({ narrationMinIntervalMs: 0 });
    harness.vox.autoDrain = false;
    const conversation = harness.conversation();
    conversation.input.onAudioDelta(pcmDelta(480), "item_failed_pending");
    await flush();
    const playbackId = at(harness.vox.audio, -1).playbackId;
    harness.vox.emit({
      type: "tts_playback_state",
      playbackId,
      status: "failed",
      reason: "native_playback_failed",
    });
    await flush();

    const responseCount = conversation.responseCreates;
    await harness.session.narrate("walked into the lab");
    expect(conversation.responseCreates).toBe(responseCount + 1);
  });

  it("treats a correlated native TTS buffer overflow as failed playback", async () => {
    const harness = await engagedHarness();
    harness.vox.autoDrain = false;
    const conversation = harness.conversation();
    conversation.input.onAudioDelta(pcmDelta(480), "item_overflow");
    await flush();
    const playbackId = at(harness.vox.audio, -1).playbackId;
    conversation.input.onResponseDone({
      responseId: "resp_overflow",
      status: "completed",
      audioBytes: 480,
      textCharacters: 0,
    });
    harness.vox.emit({
      type: "tts_buffer_overflow",
      playbackId,
      droppedSamples: 240,
      droppedMs: 10,
      bufferSamples: 48_000,
      bufferMs: 2_000,
    });
    await flush();
    harness.vox.emit({ type: "tts_playback_state", playbackId, status: "drained" });
    await flush();
    expect(harness.ofType("response")).toHaveLength(0);
    expect(at(harness.ofType("failed"), -1)).toMatchObject({
      deliveryId: at(harness.ofType("utterance"), -1).deliveryId,
      stage: "playback",
      code: "tts_buffer_overflow",
    });
  });

  it("fails the correlated playback when Vox rejects a synchronous audio command", async () => {
    const harness = await engagedHarness();
    harness.vox.sendAudioError = new VoxClientError(
      "stdin_queue_overflow",
      "reliable queue unavailable",
      "test-playback",
    );
    const conversation = harness.conversation();
    conversation.input.onAudioDelta(pcmDelta(480), "item_send_rejected");
    await flush();
    expect(harness.vox.audio).toHaveLength(0);
    expect(at(harness.ofType("failed"), -1)).toMatchObject({
      deliveryId: at(harness.ofType("utterance"), -1).deliveryId,
      stage: "playback",
      code: "stdin_queue_overflow",
    });
    expect(harness.ofType("response")).toHaveLength(0);
  });

  it("fails the correlated playback when Vox rejects synchronous finish", async () => {
    const harness = await engagedHarness();
    harness.vox.autoDrain = false;
    const conversation = harness.conversation();
    conversation.input.onAudioDelta(pcmDelta(480), "item_finish_rejected");
    await flush();
    harness.vox.finishError = new VoxClientError("not_ready", "Vox became unavailable", "test-playback");
    conversation.input.onResponseDone({
      responseId: "resp_finish_rejected",
      status: "completed",
      audioBytes: 480,
      textCharacters: 0,
    });
    await flush();
    expect(at(harness.ofType("failed"), -1)).toMatchObject({
      deliveryId: at(harness.ofType("utterance"), -1).deliveryId,
      stage: "playback",
      code: "not_ready",
    });
    expect(harness.ofType("response")).toHaveLength(0);
  });

  it.each(["failed", "timeout"] as const)(
    "invalidates a response after playback %s, drops its late PCM, and plays the next response",
    async (failure) => {
      const harness = await engagedHarness();
      harness.vox.autoDrain = false;
      harness.vox.autoBuffer = failure !== "timeout";
      const conversation = harness.conversation();
      conversation.input.onAudioDelta(pcmDelta(480), "item_failed_response");
      await flush();
      const failedPlaybackId = at(harness.vox.audio, -1).playbackId;
      if (failure === "failed") {
        harness.vox.emit({
          type: "tts_playback_state",
          playbackId: failedPlaybackId,
          status: "failed",
          reason: "native_playback_failed",
        });
      } else {
        harness.timers.fireLast(2 * 60_000);
      }
      await flush();
      conversation.input.onResponseDone({
        responseId: "resp_failed_response",
        status: "completed",
        audioBytes: 480,
        textCharacters: 0,
      });
      await flush();

      await harness.say(ALICE, "clankie try the next response");
      const nextDeliveryId = at(harness.ofType("utterance"), -1).deliveryId;
      const audioCount = harness.vox.audio.length;
      const late = pcmDelta(480);
      conversation.input.onAudioDelta(late, "item_failed_response");
      await flush();
      expect(late.equals(Buffer.alloc(late.byteLength))).toBe(true);
      expect(harness.vox.audio).toHaveLength(audioCount);

      harness.vox.autoBuffer = true;
      harness.vox.autoDrain = true;
      conversation.input.onAudioDelta(pcmDelta(480), "item_recovered_response");
      await flush();
      conversation.input.onResponseDone({
        responseId: "resp_recovered_response",
        status: "completed",
        audioBytes: 480,
        textCharacters: 0,
      });
      await flush();
      expect(harness.ofType("response")).toContainEqual(
        expect.objectContaining({ deliveryId: nextDeliveryId }),
      );
    },
  );
});

describe("ability path", () => {
  it("settles narration-triggered ask_clankie locally without inventing a speaker", async () => {
    const harness = await joinedHarness({ narrationMinIntervalMs: 0 });
    await harness.session.narrate("the battle helper keeps refusing");
    await flush();
    const conversation = harness.conversation();

    conversation.input.onFunctionCall({
      callId: "call_narration",
      name: "ask_clankie",
      argumentsJson: '{"request":"fix the battle helper"}',
    });
    await flush();

    expect(harness.submitCalls).toHaveLength(0);
    expect(at(conversation.functionResults, 0)).toMatchObject({
      callId: "call_narration",
      output: expect.stringContaining("No person asked for an action"),
    });
    expect(harness.ofType("failed")).not.toContainEqual(
      expect.objectContaining({ code: "voice_ask_clankie_no_speaker" }),
    );
    expect(harness.ofType("realtime_tool")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callId: "call_narration", phase: "called" }),
        expect.objectContaining({
          callId: "call_narration",
          phase: "completed",
          code: "speakerless_trigger",
        }),
      ]),
    );
  });

  it("keeps the triggering speaker immutable when another participant takes the floor", async () => {
    const harness = await joinedHarness();
    await harness.consent(ALICE);
    await harness.consent(BOB);

    await harness.say(ALICE, "clankie check the deploy");
    const conversation = harness.conversation();
    await harness.say(BOB, "clankie, before that, check the runner");
    conversation.input.onFunctionCall({
      callId: "call_alice",
      name: "ask_clankie",
      argumentsJson: '{"request":"check the deploy"}',
    });
    await flush();

    expect(at(harness.submitCalls, 0).trigger).toMatchObject({
      kind: "voice_event",
      actorId: ALICE,
      body: "check the deploy",
    });
  });

  // Required mission evidence: two ask_clankie calls serialize on the turn
  // queue, and their spoken results never talk over each other.
  it("serializes ask_clankie through the unchanged captain lane with evidence", async () => {
    const resolvers: ((result: CaptainChannelTurnResult) => void)[] = [];
    const harness = await joinedHarness({
      captain: () =>
        new Promise<CaptainChannelTurnResult>((resolve) => {
          resolvers.push(resolve);
        }),
    });
    await harness.consent(ALICE);
    harness.clock.now = 1_000;
    await harness.say(ALICE, "hey clankie check on the deploy");
    const conversation = harness.conversation();
    conversation.input.onFunctionCall({
      callId: "call_1",
      name: "ask_clankie",
      argumentsJson: '{"request":"check the deploy status"}',
    });
    conversation.input.onFunctionCall({
      callId: "call_2",
      name: "ask_clankie",
      argumentsJson: '{"request":"and restart the runner"}',
    });
    // The function-call response itself settles with no audio.
    conversation.input.onResponseDone({
      responseId: "resp_fn",
      status: "completed",
      audioBytes: 0,
      textCharacters: 0,
    });
    await flush();
    // Serialized: the second handoff waits for the first to finish.
    expect(harness.submitCalls).toHaveLength(1);
    expect(at(harness.submitCalls, 0).trigger).toMatchObject({
      kind: "voice_event",
      guildId: GUILD,
      channelId: CHANNEL,
      actorId: ALICE,
      body: "check the deploy status",
    });
    harness.clock.now = 1_200;
    at(resolvers, 0)(settledResult("turn-1", "Deploy is green."));
    await flush();
    expect(conversation.functionResults).toEqual([{ callId: "call_1", output: "Deploy is green." }]);
    expect(harness.submitCalls).toHaveLength(2);
    harness.clock.now = 1_300;
    at(resolvers, 1)(settledResult("turn-2", "Runner restarted."));
    await flush();
    expect(at(conversation.functionResults, 1)).toEqual({ callId: "call_2", output: "Runner restarted." });

    // Their spoken results play and receipt in order.
    conversation.input.onAudioDelta(pcmDelta(480), "item_r1");
    await flush();
    conversation.input.onResponseDone({
      responseId: "resp_r1",
      status: "completed",
      audioBytes: 480,
      textCharacters: 0,
    });
    await flush();
    conversation.input.onAudioDelta(pcmDelta(480), "item_r2");
    await flush();
    conversation.input.onResponseDone({
      responseId: "resp_r2",
      status: "completed",
      audioBytes: 480,
      textCharacters: 0,
    });
    await flush();
    const responses = harness.ofType("response");
    expect(responses.map((event) => event.turnId)).toEqual(["turn-1", "turn-2"]);
    const utterance = at(
      harness.ofType("utterance").filter((event) => event.userId === ALICE),
      0,
    );
    expect(responses[0]).toMatchObject({ deliveryId: utterance.deliveryId, userId: ALICE });
    expect(responses[0]).toMatchObject({ fastPath: false, state: "settled", wake: "waking", handoffMs: 200 });
    // Both calls came from the same waking response, so both spoken results
    // carry that decision's wake classification.
    expect(responses[1]).toMatchObject({ fastPath: false, state: "settled", wake: "waking", handoffMs: 100 });
  });

  // Required mission evidence (criterion 4): approval-shaped outcomes speak
  // only the authenticated-surface handoff — ambient voice cannot approve.
  it("keeps the authenticated-surface handoff for approval-shaped results", async () => {
    const harness = await joinedHarness({
      captain: () =>
        Promise.resolve({
          state: "waiting_user",
          captainSessionId: "session-1",
          turnId: "turn-9",
          prompt: "Approve secret operation launch-codes?",
          approvalRequired: true,
        } as CaptainChannelTurnResult),
    });
    await harness.consent(ALICE);
    await harness.say(ALICE, "hey clankie merge the release");
    const conversation = harness.conversation();
    conversation.input.onFunctionCall({
      callId: "call_1",
      name: "ask_clankie",
      argumentsJson: '{"request":"merge the release"}',
    });
    conversation.input.onResponseDone({
      responseId: "resp_fn",
      status: "completed",
      audioBytes: 0,
      textCharacters: 0,
    });
    await flush();
    const result = at(conversation.functionResults, 0);
    expect(result.output).toBe("I need you to continue that request on the authenticated operator surface.");
    expect(result.output).not.toContain("secret");
    conversation.input.onAudioDelta(pcmDelta(480), "item_r1");
    await flush();
    conversation.input.onResponseDone({
      responseId: "resp_r1",
      status: "completed",
      audioBytes: 480,
      textCharacters: 0,
    });
    await flush();
    expect(at(harness.ofType("response"), 0)).toMatchObject({
      fastPath: false,
      turnId: "turn-9",
      state: "waiting_user",
    });
  });

  it("answers a captain failure with the fixed sentence and keeps the queue alive", async () => {
    let calls = 0;
    const harness = await joinedHarness({
      captain: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("captain exploded: secret detail"));
        return Promise.resolve(settledResult("turn-2", "Back online."));
      },
    });
    await harness.consent(ALICE);
    await harness.say(ALICE, "hey clankie do the thing");
    const conversation = harness.conversation();
    conversation.input.onFunctionCall({
      callId: "call_1",
      name: "ask_clankie",
      argumentsJson: '{"request":"do the thing"}',
    });
    await flush();
    expect(at(conversation.functionResults, 0).output).toBe(CAPTAIN_UNREACHABLE_TEXT);
    expect(harness.ofType("failed")).toMatchObject([
      {
        type: "failed",
        guildId: GUILD,
        channelId: CHANNEL,
        stage: "captain_handoff",
        code: "voice_captain_handoff_failed",
      },
    ]);
    // The queue is not hung: the next call reaches the captain and speaks.
    conversation.input.onFunctionCall({
      callId: "call_2",
      name: "ask_clankie",
      argumentsJson: '{"request":"try again"}',
    });
    await flush();
    expect(at(conversation.functionResults, 1)).toEqual({ callId: "call_2", output: "Back online." });
  });

  it("correlates a realtime music tool through its queue and spoken result", async () => {
    const harness = await engagedHarness();
    const conversation = harness.conversation();
    const deliveryId = at(harness.ofType("utterance"), 0).deliveryId;
    conversation.input.onFunctionCall({
      callId: "music-call-1",
      name: "music_play",
      argumentsJson: '{"url":"https://youtu.be/video-1"}',
    });
    conversation.input.onResponseDone({
      responseId: "music-function-response",
      status: "completed",
      audioBytes: 0,
      textCharacters: 0,
    });
    await flush();
    expect(harness.ofType("realtime_tool")).toMatchObject([
      { deliveryId, callId: "music-call-1", name: "music_play", phase: "called" },
      { deliveryId, callId: "music-call-1", name: "music_play", phase: "completed" },
    ]);
    expect(harness.ofType("music")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deliveryId,
          callId: "music-call-1",
          source: "realtime",
          operation: "play",
          component: "queue",
          outcome: "started",
        }),
      ]),
    );
    expect(at(harness.ofType("model_response"), 1)).toMatchObject({
      deliveryId,
      phase: "completed",
      outcome: "tool",
    });
    expect(at(harness.ofType("model_response"), -1)).toMatchObject({ deliveryId, phase: "requested" });
    expect(JSON.stringify(harness.evidence)).not.toContain("youtu.be");
  });

  it("look_at_screen seeds a still and does not call the captain", async () => {
    const harness = await engagedHarness({
      lookAtScreen: () => Promise.resolve({ outcome: "still", pngBase64: "aaa", mimeType: "image/png" }),
    });
    const conversation = harness.conversation();
    conversation.input.onFunctionCall({ callId: "look_1", name: "look_at_screen", argumentsJson: "{}" });
    await flush();
    expect(harness.submitCalls).toHaveLength(0);
    expect(conversation.imageItems).toEqual(["aaa"]);
    expect(at(conversation.functionResults, 0)).toMatchObject({
      callId: "look_1",
      output: expect.stringContaining("looking at your own screen"),
    });
  });

  it("look_at_screen says so when he is not playing", async () => {
    const harness = await engagedHarness({
      lookAtScreen: () => Promise.resolve({ outcome: "not_playing" }),
    });
    const conversation = harness.conversation();
    conversation.input.onFunctionCall({ callId: "look_1", name: "look_at_screen", argumentsJson: "{}" });
    await flush();
    expect(conversation.imageItems).toEqual([]);
    expect(at(conversation.functionResults, 0).output).toContain("not playing");
  });

  it("receipts a mouth failure, so a Clankie who cannot be heard is not read as a quiet one", async () => {
    const harness = await engagedHarness();
    const conversation = harness.conversation();
    const deliveryId = at(harness.ofType("utterance"), 0).deliveryId;
    // An utterance that dies in synthesis plays no audio, so it leaves no
    // `response` receipt. Without this one there is no trail at all.
    conversation.input.onError("ElevenLabs context id is already open");
    await flush();
    expect(at(harness.ofType("failed"), 0)).toMatchObject({
      deliveryId,
      userId: ALICE,
      stage: "speech_synthesis",
      code: "elevenlabs_context_id_is_already_open",
    });
  });

  it("rejects malformed ask_clankie arguments without hanging", async () => {
    const harness = await engagedHarness();
    const conversation = harness.conversation();
    conversation.input.onFunctionCall({ callId: "call_1", name: "ask_clankie", argumentsJson: "not json" });
    await flush();
    expect(harness.submitCalls).toHaveLength(0);
    expect(at(conversation.functionResults, 0).output).toBe(CAPTAIN_UNREACHABLE_TEXT);
    expect(at(harness.ofType("failed"), 0)).toMatchObject({
      stage: "captain_handoff",
      code: "voice_ask_clankie_arguments_invalid",
    });
  });

  it("speaks the fixed sentence on a failed captain outcome and receipts only the failure", async () => {
    const harness = await joinedHarness({
      captain: () =>
        Promise.resolve({
          state: "failed",
          captainSessionId: "session-1",
          turnId: "turn-1",
          code: "captain_session_failed",
        } as CaptainChannelTurnResult),
    });
    await harness.consent(ALICE);
    await harness.say(ALICE, "hey clankie check the queue");
    const conversation = harness.conversation();
    conversation.input.onFunctionCall({
      callId: "call_1",
      name: "ask_clankie",
      argumentsJson: '{"request":"check the queue"}',
    });
    await flush();
    // The model gets the fixed sentence so the exchange can close; no
    // response receipt exists for a turn that never produced one, so the
    // fastPath/turnId invariant is never in play.
    expect(at(conversation.functionResults, 0).output).toBe(CAPTAIN_UNREACHABLE_TEXT);
    expect(at(harness.ofType("failed"), 0)).toMatchObject({
      stage: "captain_handoff",
      code: "captain_session_failed",
    });
    expect(harness.ofType("response")).toHaveLength(0);
  });

  it("a silent captain outcome says nothing, receipts nothing, and leaves the session healthy", async () => {
    let calls = 0;
    const harness = await joinedHarness({
      captain: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({
            state: "silent",
            captainSessionId: "session-1",
            turnId: "turn-1",
          } as CaptainChannelTurnResult);
        }
        return Promise.resolve(settledResult("turn-2", "Still here."));
      },
    });
    await harness.consent(ALICE);
    await harness.say(ALICE, "hey clankie whats new");
    const conversation = harness.conversation();
    conversation.input.onFunctionCall({
      callId: "call_1",
      name: "ask_clankie",
      argumentsJson: '{"request":"whats new"}',
    });
    await flush();
    // Deliberate silence: no function result, no response receipt, no
    // failure — deciding to stay quiet must not cost a response.
    expect(conversation.functionResults).toHaveLength(0);
    expect(harness.ofType("response")).toHaveLength(0);
    expect(harness.ofType("failed")).toHaveLength(0);
    // The turn queue is not wedged: the next ask_clankie round-trips.
    conversation.input.onFunctionCall({
      callId: "call_2",
      name: "ask_clankie",
      argumentsJson: '{"request":"still there?"}',
    });
    await flush();
    expect(at(conversation.functionResults, 0)).toEqual({ callId: "call_2", output: "Still here." });
  });

  it("receipts absorbed as absorbed, not as a decline", async () => {
    const harness = await joinedHarness({
      captain: () =>
        Promise.resolve({
          state: "absorbed",
          captainSessionId: "session-1",
          turnId: "turn-abs",
        } as CaptainChannelTurnResult),
    });
    await harness.consent(ALICE);
    await harness.say(ALICE, "hey clankie look this up");
    harness.conversation().input.onFunctionCall({
      callId: "call_abs",
      name: "ask_clankie",
      argumentsJson: '{"request":"look this up"}',
    });
    await flush();
    expect(harness.ofType("realtime_tool").some((event) => event.code === "captain_absorbed")).toBe(true);
    expect(harness.ofType("realtime_tool").some((event) => event.code === "captain_declined")).toBe(false);
    expect(harness.conversation().functionResults).toHaveLength(0);
  });

  it("keeps the floor warm while ask_clankie is in flight", async () => {
    let release: ((result: CaptainChannelTurnResult) => void) | undefined;
    const harness = await joinedHarness({
      captain: () =>
        new Promise<CaptainChannelTurnResult>((resolve) => {
          release = resolve;
        }),
    });
    await harness.consent(ALICE);
    await harness.say(ALICE, "hey clankie look this up");
    harness.conversation().input.onFunctionCall({
      callId: "call_slow",
      name: "ask_clankie",
      argumentsJson: '{"request":"look this up"}',
    });
    await flush();
    expect(harness.session.status().floorState).toBe("engaged");
    harness.clock.now = 61_000;
    harness.timers.fire(FLOOR_WORK_HEARTBEAT_MS);
    harness.timers.fire(ENGAGED_TICK_MS);
    await flush();
    expect(harness.session.status().floorState).toBe("engaged");
    release?.(settledResult("turn-slow", "Found it."));
    await flush();
    expect(at(harness.conversation().functionResults, 0).output).toBe("Found it.");
  });

  // A handoff that never settles is not a slow one: `stopFloorWork` lives in a
  // `finally` that a hung promise never reaches, so the heartbeat has to stop
  // itself. Decay is the only self-heal here — it arms the hold window, which
  // closes the conversation and drops the stale call — so the floor must be
  // allowed to lapse rather than be pinned engaged until the session ages out.
  it("lets the floor lapse when a captain handoff never returns", async () => {
    const harness = await joinedHarness({
      captain: () => new Promise<CaptainChannelTurnResult>(() => undefined),
    });
    await harness.consent(ALICE);
    await harness.say(ALICE, "hey clankie look this up");
    harness.conversation().input.onFunctionCall({
      callId: "call_wedged",
      name: "ask_clankie",
      argumentsJson: '{"request":"look this up"}',
    });
    await flush();
    expect(harness.session.status().floorState).toBe("engaged");
    // Still held while the work is plausibly alive.
    harness.clock.now = FLOOR_WORK_MAX_MS - 1_000;
    harness.timers.fire(FLOOR_WORK_HEARTBEAT_MS);
    harness.timers.fire(ENGAGED_TICK_MS);
    await flush();
    expect(harness.session.status().floorState).toBe("engaged");
    // Past the bound the heartbeat gives up and stops re-arming, so the next
    // decay tick past the window releases.
    harness.clock.now = 2 * FLOOR_WORK_MAX_MS;
    harness.timers.fire(FLOOR_WORK_HEARTBEAT_MS);
    expect(harness.timers.pending().some((entry) => entry.delayMs === FLOOR_WORK_HEARTBEAT_MS)).toBe(false);
    harness.timers.fire(ENGAGED_TICK_MS);
    await flush();
    expect(harness.session.status().floorState).toBe("dormant");
  });
});

describe("barge-in", () => {
  async function playingHarness() {
    const harness = await engagedHarness();
    const conversation = harness.conversation();
    harness.clock.now = 5_000;
    conversation.input.onAudioDelta(pcmDelta(480), "item_play");
    await flush();
    expect(harness.vox.activePlaybackId).toEqual(expect.any(String));
    return { harness, conversation };
  }

  it("sustained speech from the floor holder truncates deliberately at the played offset", async () => {
    const { harness, conversation } = await playingHarness();
    const playbackId = harness.vox.activePlaybackId;
    harness.clock.now = 5_400;
    const capture = harness.startCapture(ALICE);
    capture.stream.write(monoPcm(BARGE_IN_SOURCE_BYTES));
    await flush();
    expect(conversation.truncations).toEqual([{ itemId: "item_play", audioEndMs: 400 }]);
    expect(harness.vox.activePlaybackId).toBeUndefined();
    expect(harness.vox.stops).toContain(playbackId);
    expect(harness.ofType("interrupted")).toMatchObject([
      { type: "interrupted", guildId: GUILD, channelId: CHANNEL, userId: ALICE, phase: "playing" },
    ]);
  });

  it("settles barge-in locally when the terminal Vox stop command throws", async () => {
    const { harness, conversation } = await playingHarness();
    harness.vox.stopError = new VoxClientError("closed", "Vox is closed");
    harness.clock.now = 5_400;
    const capture = harness.startCapture(ALICE);
    capture.stream.write(monoPcm(BARGE_IN_SOURCE_BYTES));
    await flush();
    expect(conversation.truncations).toEqual([{ itemId: "item_play", audioEndMs: 400 }]);
    expect(harness.ofType("interrupted")).toHaveLength(1);
    expect(at(harness.ofType("failed"), -1)).toMatchObject({ stage: "playback", code: "closed" });

    capture.stream.write(monoPcm(2));
    await flush();
    expect(conversation.truncations).toHaveLength(1);
  });

  it("a re-address from any consented speaker truncates and moves the floor", async () => {
    const { harness, conversation } = await playingHarness();
    await harness.consent(BOB);
    harness.clock.now = 5_250;
    const capture = harness.startCapture(BOB);
    capture.stream.write(monoPcm(3_840));
    await flush();
    harness.transcribe(BOB, "clankie hold on a second");
    await flush();
    expect(conversation.truncations).toEqual([{ itemId: "item_play", audioEndMs: 250 }]);
    expect(at(harness.ofType("interrupted"), 0)).toMatchObject({ userId: BOB });
    // The re-address is also a floor decision: he answers bob next.
    expect(conversation.responseCreates).toBe(2);
  });

  // Regression: an open mic streams room tone continuously, and counting bytes
  // alone truncated him mid-sentence on audio that transcribed to nothing.
  it("room tone from the floor holder never truncates, however long it runs", async () => {
    const { harness, conversation } = await playingHarness();
    harness.clock.now = 5_400;
    const capture = harness.startCapture(ALICE);
    capture.stream.write(monoPcm(BARGE_IN_SOURCE_BYTES * 8, ROOM_TONE_FILL));
    await flush();
    expect(conversation.truncations).toHaveLength(0);
    expect(harness.ofType("interrupted")).toHaveLength(0);
    expect(harness.vox.activePlaybackId).toEqual(expect.any(String));
  });

  it("speech that follows room tone from the floor holder still truncates", async () => {
    const { harness, conversation } = await playingHarness();
    harness.clock.now = 5_400;
    const capture = harness.startCapture(ALICE);
    capture.stream.write(monoPcm(BARGE_IN_SOURCE_BYTES, ROOM_TONE_FILL));
    await flush();
    expect(conversation.truncations).toHaveLength(0);
    capture.stream.write(monoPcm(BARGE_IN_SOURCE_BYTES));
    await flush();
    expect(conversation.truncations).toEqual([{ itemId: "item_play", audioEndMs: 400 }]);
    expect(harness.vox.activePlaybackId).toBeUndefined();
  });

  it("speech already underway when playback starts still truncates", async () => {
    const harness = await engagedHarness({ narrationMinIntervalMs: 0 });
    const conversation = harness.conversation();
    conversation.input.onResponseDone({
      responseId: "resp_wake",
      status: "completed",
      audioBytes: 0,
      textCharacters: 0,
    });
    await flush();

    const capture = harness.startCapture(ALICE);
    capture.stream.write(monoPcm(BARGE_IN_SOURCE_BYTES));
    await flush();

    await harness.session.narrate("walked into the lab");
    conversation.input.onAudioDelta(pcmDelta(480), "item_narration");
    await flush();
    expect(harness.vox.activePlaybackId).toEqual(expect.any(String));

    harness.clock.now = 400;
    capture.stream.write(monoPcm(3_840));
    await flush();
    expect(conversation.truncations).toEqual([{ itemId: "item_narration", audioEndMs: 400 }]);
    expect(harness.vox.activePlaybackId).toBeUndefined();
  });

  // Required mission evidence: crosstalk between other people lets him finish.
  it("crosstalk from a non-holder that does not address him never truncates", async () => {
    const { harness, conversation } = await playingHarness();
    await harness.consent(BOB);
    const capture = harness.startCapture(BOB);
    capture.stream.write(monoPcm(BARGE_IN_SOURCE_BYTES));
    await flush();
    harness.transcribe(BOB, "no I meant the blue one");
    await flush();
    expect(conversation.truncations).toHaveLength(0);
    expect(harness.ofType("interrupted")).toHaveLength(0);
    expect(harness.vox.activePlaybackId).toEqual(expect.any(String));
    expect(conversation.responseCreates).toBe(1);
  });
});

describe("reconnect", () => {
  it("drops pending delivery ids when a listener is lost so the next capture realigns", async () => {
    const harness = await joinedHarness();
    await harness.consent(ALICE);

    const first = harness.startCapture(ALICE);
    first.stream.write(monoPcm(BARGE_IN_SOURCE_BYTES));
    await flush();
    first.stream.end();
    await flush();
    const firstDeliveryId = at(harness.ofType("utterance"), -1).deliveryId;

    // No final transcript arrives for the first capture.
    harness.transcriptionFor(ALICE).lose("socket");
    harness.timers.fire(1_000);
    await flush();

    await harness.say(ALICE, "clankie check the realigned turn");
    const secondDeliveryId = at(harness.ofType("utterance"), -1).deliveryId;
    expect(secondDeliveryId).not.toBe(firstDeliveryId);
    const conversation = harness.conversation();
    conversation.input.onFunctionCall({
      callId: "call_realigned",
      name: "ask_clankie",
      argumentsJson: '{"request":"check the realigned turn"}',
    });
    await flush();

    expect(at(harness.submitCalls, -1).deliveryId).toBe(secondDeliveryId);
  });

  it("a lost listener emits failed evidence and reopens with bounded backoff, resetting on success", async () => {
    const harness = await joinedHarness();
    await harness.consent(ALICE);
    const capture = harness.startCapture(ALICE);
    capture.stream.write(monoPcm(3_840));
    await flush();
    capture.stream.end();
    await flush();
    harness.transcribe(ALICE, "background chatter");
    harness.transcriptionFor(ALICE).lose("socket");
    expect(harness.ofType("failed")).toMatchObject([
      {
        type: "failed",
        guildId: GUILD,
        channelId: CHANNEL,
        stage: "transcription_session",
        code: "voice_listener_lost",
      },
    ]);
    expect(harness.timers.pending().map((timer) => timer.delayMs)).toContain(1_000);
    // First retry fails; the next is scheduled at twice the delay.
    harness.ports.failTranscriptionOpens = 1;
    harness.timers.fire(1_000);
    await flush();
    expect(harness.transcriptions).toHaveLength(2);
    expect(harness.timers.pending().map((timer) => timer.delayMs)).toContain(2_000);
    harness.timers.fire(2_000);
    await flush();
    expect(harness.transcriptions).toHaveLength(3);
    // The new listener is his ears again.
    harness.startCapture(ALICE).stream.write(monoPcm(3_840));
    await flush();
    expect(harness.transcriptionFor(ALICE).appended).toHaveLength(1);
    // Success reset the backoff: a later loss starts back at one second.
    harness.transcriptionFor(ALICE).lose("error");
    expect(harness.timers.pending().map((timer) => timer.delayMs)).toContain(1_000);
  });

  it("a conversation lost mid-engagement emits failed evidence and reopens lazily on the next wake", async () => {
    const harness = await engagedHarness();
    harness.conversation().lose("error");
    await flush();
    expect(at(harness.ofType("failed"), 0)).toMatchObject({
      stage: "conversation_session",
      code: "voice_conversation_lost",
    });
    expect(harness.session.status().engaged).toBe(false);
    // The floor holder keeps talking: the session reopens with fresh setup.
    await harness.say(ALICE, "are you still with me");
    expect(harness.conversations).toHaveLength(2);
    expect(harness.briefingCalls).toHaveLength(2);
    expect(harness.conversation().responseCreates).toBe(1);
  });
});

describe("speaker listener bounds", () => {
  it("closes an inactive speaker listener and reopens it on their next utterance", async () => {
    const harness = await joinedHarness({ floorOverrides: { volition: { maxPerHour: 0 } } });
    await harness.consent(ALICE);
    await harness.say(ALICE, "background chatter");
    const first = harness.transcriptionFor(ALICE);

    harness.timers.fire(SPEAKER_TRANSCRIPTION_IDLE_MS);
    await flush();
    expect(first.isOpen).toBe(false);

    await harness.say(ALICE, "more background chatter");
    expect(harness.transcriptionFor(ALICE)).not.toBe(first);
    expect(harness.transcriptionFor(ALICE).isOpen).toBe(true);
  });

  it("caps retained speaker listeners by evicting the least recently active idle speaker", async () => {
    const harness = await joinedHarness({ floorOverrides: { volition: { maxPerHour: 0 } } });
    const participants = Array.from({ length: 26 }, (_, index) => String(20_000 + index));
    for (const participant of participants) {
      await harness.consent(participant);
      harness.clock.now += 1;
      await harness.say(participant, `background-${participant}`);
    }

    expect(harness.transcriptions.filter((transcription) => transcription.isOpen)).toHaveLength(25);
    expect(harness.transcriptionFor(at(participants, 0)).isOpen).toBe(false);
    expect(harness.transcriptionFor(at(participants, -1)).isOpen).toBe(true);
  });
});

describe("transcript ring", () => {
  it("caps the seed to the recent window", async () => {
    const harness = await joinedHarness({ floorOverrides: { volition: { maxPerHour: 0 } } });
    await harness.consent(ALICE);
    for (let line = 0; line < 35; line += 1) {
      await harness.say(ALICE, `line-${line.toString()} of idle chatter`);
    }
    await harness.say(ALICE, "hey clankie summarize that");
    const seed = at(harness.conversation().textItems, 0);
    expect(seed.startsWith("Recent room conversation (JSONL;")).toBe(true);
    expect(seed).toContain("line-34");
    expect(seed).not.toContain("line-0 ");
    expect(seed.split("\n")).toHaveLength(31);
  });
});

describe("play narration and hearing (ADR 0064)", () => {
  it("refuses to narrate when he is not in a voice channel", async () => {
    const harness = buildHarness();
    await expect(harness.session.narrate("walked into a wall")).rejects.toThrow(
      /voice_narration_not_in_channel/u,
    );
  });

  it("refuses an empty report rather than seeding nothing", async () => {
    const harness = await joinedHarness();
    await expect(harness.session.narrate("   ")).rejects.toThrow(/voice_narration_empty/u);
  });

  it("seeds the report as context and lets the persona compose the words", async () => {
    const harness = await joinedHarness();
    await harness.session.narrate("walked into a wall by the lab");
    await flush();

    const conversation = harness.conversation();
    // The play text is seeded, never queued as speech to synthesize.
    const seeded = conversation.textItems.filter((item) => item.includes("walked into a wall by the lab"));
    expect(seeded).toHaveLength(1);
    expect(at(seeded, 0)).toBe("Your own game-side experience updated:\nwalked into a wall by the lab");
    // A response was requested; what he actually says is the model's.
    expect(conversation.responseCreates).toBe(1);
  });

  it("inherits game experience without narrating every turn", async () => {
    const harness = await joinedHarness();
    await harness.session.narrate("turn=12\nthought=Oak is not in the lab\nnext=look outside", {
      respond: false,
    });
    await flush();

    expect(harness.conversation().textItems).toContain(
      "Your own game-side experience updated:\nturn=12\nthought=Oak is not in the lab\nnext=look outside",
    );
    expect(harness.conversation().responseCreates).toBe(0);
    expect(harness.ofType("play_narration_suppressed")).toHaveLength(0);
  });

  it("keeps seeding but stops responding inside the narration interval", async () => {
    const harness = await joinedHarness({ narrationMinIntervalMs: 10_000 });
    await harness.session.narrate("left the lab");
    await flush();
    expect(harness.conversation().responseCreates).toBe(1);
    // The server runs one response at a time, so the later reports here are
    // measuring the interval rather than that first response still being open.
    harness.conversation().input.onResponseDone({
      responseId: "resp_narration",
      status: "completed",
      audioBytes: 0,
      textCharacters: 0,
    });
    await flush();

    harness.clock.now += 1_000;
    await harness.session.narrate("took one step north");
    await harness.session.narrate("took another step north");
    await flush();

    const conversation = harness.conversation();
    // Every step is still seeded — he must not narrate a past he never saw.
    expect(
      conversation.textItems.filter((item) => item.startsWith("Your own game-side experience")),
    ).toHaveLength(3);
    // But the room is not monologued at.
    expect(conversation.responseCreates).toBe(1);

    harness.clock.now += 10_000;
    await harness.session.narrate("found a pokeball");
    await flush();
    expect(harness.conversation().responseCreates).toBe(2);
  });

  it("pushes attributed room lines to subscribed play", async () => {
    const harness = await joinedHarness({ floorOverrides: { volition: { maxPerHour: 0 } } });
    await harness.consent(ALICE);
    const heard: string[] = [];
    const transcripts: unknown[] = [];
    const unsubscribe = harness.session.subscribeTranscript((line, transcript) => {
      heard.push(line);
      transcripts.push(transcript);
    });

    await harness.say(ALICE, "go left instead");
    expect(heard).toEqual([JSON.stringify({ speakerId: ALICE, text: "go left instead", source: "speech" })]);
    expect(transcripts).toEqual([
      expect.objectContaining({
        guildId: GUILD,
        channelId: CHANNEL,
        speakerId: ALICE,
        text: "go left instead",
      }),
    ]);

    unsubscribe();
    await harness.say(ALICE, "no seriously go left");
    expect(heard).toHaveLength(1);
  });

  it("never pushes what an unconsented participant said", async () => {
    const harness = await joinedHarness({ floorOverrides: { volition: { maxPerHour: 0 } } });
    const heard: string[] = [];
    harness.session.subscribeTranscript((line) => heard.push(line));

    // Mallory never consented, so no capture opens and no transcript exists.
    harness.vox.emit({ type: "speaking_start", userId: MALLORY });
    await flush();
    expect(harness.vox.subscriptions.some((capture) => capture.userId === MALLORY)).toBe(false);
    expect(heard).toEqual([]);
  });

  it("survives a subscriber that throws", async () => {
    const harness = await joinedHarness({ floorOverrides: { volition: { maxPerHour: 0 } } });
    await harness.consent(ALICE);
    const heard: string[] = [];
    harness.session.subscribeTranscript(() => {
      throw new Error("play listener died mid-line");
    });
    harness.session.subscribeTranscript((line) => heard.push(line));

    await harness.say(ALICE, "still listening");
    expect(heard).toEqual([JSON.stringify({ speakerId: ALICE, text: "still listening", source: "speech" })]);
  });
});

describe("play narration bursts (ADR 0064)", () => {
  it("lets only one un-awaited report in a burst reach a response", async () => {
    const harness = await joinedHarness({ narrationMinIntervalMs: 10_000 });
    // A play loop fires and forgets; nothing awaits between these.
    const reports = [
      harness.session.narrate("stepped north"),
      harness.session.narrate("stepped north again"),
      harness.session.narrate("bumped the fence"),
    ];
    await Promise.all(reports);
    await flush();

    const conversation = harness.conversation();
    expect(
      conversation.textItems.filter((item) => item.startsWith("Your own game-side experience")),
    ).toHaveLength(3);
    expect(conversation.responseCreates).toBe(1);
    const suppressed = harness.ofType("play_narration_suppressed");
    expect(suppressed).toHaveLength(2);
    expect(suppressed.every((event) => event.reason === "rate_limited")).toBe(true);
    expect(new Set(suppressed.map((event) => event.deliveryId)).size).toBe(2);
  });

  it("holds a report while a requested track is still starting", async () => {
    const harness = await joinedHarness({ narrationMinIntervalMs: 0 });
    harness.vox.autoMusicStart = false;
    const started = harness.session.music.play("https://youtu.be/one", "u1");
    await flush();
    expect(harness.session.music.snapshot().starting).toBe(true);

    await harness.session.narrate("walked into the lab", { deliveryId: "play-turn-start" });
    await flush();
    expect(harness.ofType("play_narration_suppressed")).toMatchObject([
      { deliveryId: "play-turn-start", reason: "playing" },
    ]);

    harness.vox.emit({
      type: "player_state",
      status: "playing",
      musicId: at(harness.vox.musicRequests, -1).musicId,
    });
    await started;
    expect(harness.session.music.snapshot().starting).toBe(false);
  });

  it("holds a report while a room response is still in flight", async () => {
    // The room turn's response is asked for but not yet audible, so neither
    // the playback check nor the narration rate limit sees it. Asking anyway
    // earns "conversation already has active response" and the report is lost
    // with nothing in the trail to say why.
    const harness = await engagedHarness({ narrationMinIntervalMs: 0 });
    const conversation = harness.conversation();
    const before = conversation.responseCreates;

    await harness.session.narrate("walked into the lab", { deliveryId: "play-turn-1" });
    await flush();

    expect(conversation.responseCreates).toBe(before);
    expect(harness.ofType("play_narration_suppressed")).toMatchObject([
      { deliveryId: "play-turn-1", reason: "responding" },
    ]);
  });
});

describe("voice stay correlation", () => {
  it("stamps one stay id from join through leave and joins suppressed narration to the caller's delivery id", async () => {
    const harness = await joinedHarness({ narrationMinIntervalMs: 10_000 });
    const stayId = harness.session.status().stayId;
    expect(stayId).toEqual(expect.any(String));
    expect(at(harness.ofType("joined"), 0).stayId).toBe(stayId);

    await harness.session.narrate("left the lab", { deliveryId: "play-turn-1" });
    await flush();
    await harness.session.narrate("took one step north", { deliveryId: "play-turn-2" });
    await flush();

    expect(harness.ofType("play_narration_suppressed")).toMatchObject([
      { deliveryId: "play-turn-2", reason: "rate_limited", stayId },
    ]);

    await harness.session.leave();
    expect(at(harness.ofType("left"), 0)).toMatchObject({
      stayId,
      spokenCount: 0,
      narrationSuppressed: 1,
    });
  });

  it("carries realtime token counts onto the spoken response receipt", async () => {
    const harness = await joinedHarness();
    await harness.session.narrate("walked into a wall");
    await flush();
    const conversation = harness.conversation();
    conversation.input.onAudioDelta(pcmDelta(480), "item_play");
    await flush();
    conversation.input.onResponseDone({
      responseId: "resp_play",
      status: "completed",
      audioBytes: 480,
      textCharacters: 0,
      inputTokens: 640,
      outputTokens: 80,
    });
    await flush();
    expect(at(harness.ofType("response"), 0)).toMatchObject({
      trigger: "narration",
      inputTokens: 640,
      outputTokens: 80,
      stayId: harness.session.status().stayId,
    });
    await harness.session.leave();
    expect(at(harness.ofType("left"), 0)).toMatchObject({
      spokenCount: 1,
      inputTokens: 640,
      outputTokens: 80,
    });
  });
});
