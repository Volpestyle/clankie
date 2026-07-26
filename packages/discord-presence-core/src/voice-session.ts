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
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { opus } from "prism-media";
import { discordPcmToSpeechPcm, openAiPcmToDiscordPcm, pcmDurationMs } from "./voice-audio.ts";
import { DiscordVoiceConsentRegistry } from "./voice-consent.ts";
import type { DiscordVoiceIngress } from "./voice-ingress.ts";
import type { VoiceSpeechRuntime } from "./voice-speech.ts";

const MIN_UTTERANCE_MS = 350;
/** Silence proving the speaker finished. Paid on every turn before work starts. */
const SPEAKING_END_SILENCE_MS = 800;
/**
 * Audio required before a consented speaker is treated as talking over him.
 * Deliberately the same bar as {@link MIN_UTTERANCE_MS}: if it is not enough to
 * become an utterance, it is not enough to cut him off.
 */
const BARGE_IN_PCM_BYTES = Math.round(48_000 * 2 * 2 * (MIN_UTTERANCE_MS / 1_000));
const MAX_UTTERANCE_MS = 30_000;
const MAX_DISCORD_PCM_BYTES = 48_000 * 2 * 2 * (MAX_UTTERANCE_MS / 1_000);
const VOICE_READY_TIMEOUT_MS = 20_000;
const DAVE_READY_TIMEOUT_MS = 10_000;
const PLAYBACK_TIMEOUT_MS = 2 * 60_000;

export type DiscordVoiceEvidence =
  | {
      readonly type: "joined";
      readonly guildId: string;
      readonly channelId: string;
      readonly daveProtocolVersion: number;
    }
  | {
      readonly type: "consent";
      readonly guildId: string;
      readonly channelId: string;
      readonly userId: string;
      readonly consented: boolean;
      readonly participantCount: number;
    }
  | {
      readonly type: "utterance";
      readonly guildId: string;
      readonly channelId: string;
      readonly userId: string;
      readonly deliveryId: string;
      readonly durationMs: number;
    }
  | {
      readonly type: "response";
      readonly guildId: string;
      readonly channelId: string;
      readonly deliveryId: string;
      readonly turnId: string;
      readonly state: "settled" | "waiting_user";
      /**
       * Per-stage latency, content-free and flat.
       *
       * "It feels slow" is not actionable, and the stages have very different
       * fixes — transcription and synthesis are provider round trips, the
       * captain turn is model and prompt size, and `silenceHoldMs` is a fixed
       * local cost paid before any of it starts. Without the split every
       * investigation begins by guessing which one to attack.
       *
       * Flat rather than nested because receipts accept scalars only; that
       * constraint is what keeps content out of evidence and is not worth
       * widening for tidier shape.
       */
      /** Fixed wait proving the speaker stopped, before the turn can begin. */
      readonly silenceHoldMs: number;
      readonly transcribeMs: number;
      readonly captainMs: number;
      readonly synthesizeMs: number;
      /** Wall clock from end of capture to the first audio frame going out. */
      readonly toFirstAudioMs: number;
      readonly playbackMs: number;
    }
  | {
      readonly type: "overlap";
      readonly guildId: string;
      readonly channelId: string;
      readonly userId: string;
      readonly activeCaptureCount: number;
    }
  | {
      readonly type: "interrupted";
      readonly guildId: string;
      readonly channelId: string;
      readonly userId: string;
      readonly phase: "synthesizing" | "playing";
    }
  | {
      readonly type: "failed";
      readonly guildId: string;
      readonly channelId: string;
      readonly stage: "capture" | "speech_to_text" | "captain_turn" | "text_to_speech";
      readonly code: string;
    }
  | { readonly type: "left"; readonly guildId: string; readonly channelId: string };

export interface JoinDiscordVoiceInput {
  readonly guildId: string;
  readonly channelId: string;
  readonly invokingUserId: string;
  readonly adapterCreator: DiscordGatewayAdapterCreator;
}

export interface DiscordVoiceSessionStatus {
  readonly active: boolean;
  readonly guildId?: string;
  readonly channelId?: string;
  readonly daveProtocolVersion?: number;
  readonly consentedParticipantCount: number;
  readonly activeCaptureCount: number;
}

export interface DiscordVoiceSessionOptions {
  readonly ingress: DiscordVoiceIngress;
  readonly speech: VoiceSpeechRuntime;
  readonly presenceSessionId: () => string;
  readonly emit: (evidence: DiscordVoiceEvidence) => Promise<void>;
  /** Monotonic milliseconds; defaults to `performance.now`. Injected by tests. */
  readonly clock?: () => number;
}

/**
 * Single official-bot media owner for one guild voice channel. Discord's
 * receiver supplies per-user Opus streams; only explicitly consented user ids
 * are subscribed, and raw PCM is discarded after a bounded brokered turn.
 */
export class DiscordVoiceSession {
  private readonly options: DiscordVoiceSessionOptions;
  /** Injectable so latency assertions are deterministic in tests. */
  private readonly clock: () => number;
  private readonly consent = new DiscordVoiceConsentRegistry();
  private readonly player: AudioPlayer;
  private connection: VoiceConnection | undefined;
  private guildId: string | undefined;
  private channelId: string | undefined;
  private daveProtocolVersion: number | undefined;
  private readonly captures = new Map<string, AudioReceiveStream>();
  private turnQueue: Promise<void> = Promise.resolve();
  private sessionGeneration = 0;
  private playbackGeneration = 0;
  private synthesizing = false;
  private readonly onSpeakingStart = (userId: string): void => {
    if (this.guildId === undefined || this.channelId === undefined) return;
    if (!this.consent.permits(this.guildId, this.channelId, userId)) return;
    if (this.captures.size > 0 && !this.captures.has(userId)) {
      void this.options.emit({
        type: "overlap",
        guildId: this.guildId,
        channelId: this.channelId,
        userId,
        activeCaptureCount: this.captures.size + 1,
      });
    }
    // Capture always starts on the first packet — nothing said while he is
    // talking should be lost. Whether it *interrupts* him is decided later, once
    // there is enough audio to tell speech from noise.
    //
    // Discord raises `speaking` on any RTP frame, so an open mic reports a
    // breath, a keystroke, or a cough identically to a word. Cutting playback
    // here meant he was chopped off mid-sentence by ambient room noise, with the
    // speaker having said nothing at all.
    void this.capture(userId, () => this.interruptPlayback(userId));
  };

  /**
   * Stop playback because a consented speaker is genuinely talking over him.
   * Called once a capture has accumulated real speech, not on the first frame.
   */
  private interruptPlayback(userId: string): void {
    if (this.guildId === undefined || this.channelId === undefined) return;
    const phase =
      this.player.state.status === AudioPlayerStatus.Playing
        ? "playing"
        : this.synthesizing
          ? "synthesizing"
          : undefined;
    this.playbackGeneration += 1;
    if (phase !== undefined) {
      this.player.stop(true);
      void this.options.emit({
        type: "interrupted",
        guildId: this.guildId,
        channelId: this.channelId,
        userId,
        phase,
      });
    }
  }

  public constructor(options: DiscordVoiceSessionOptions) {
    this.options = options;
    this.clock = options.clock ?? (() => performance.now());
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
  }

  public async join(input: JoinDiscordVoiceInput): Promise<DiscordVoiceSessionStatus> {
    await this.leave();
    this.guildId = input.guildId;
    this.channelId = input.channelId;
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
      connection.receiver.speaking.on("start", this.onSpeakingStart);
      connection.subscribe(this.player);
      await this.options.emit({
        type: "joined",
        guildId: input.guildId,
        channelId: input.channelId,
        daveProtocolVersion: protocolVersion,
      });
      await this.options.emit({
        type: "consent",
        guildId: input.guildId,
        channelId: input.channelId,
        userId: input.invokingUserId,
        consented: true,
        participantCount: 1,
      });
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
    if (!consented) this.captures.get(userId)?.destroy();
    await this.options.emit({
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
    this.playbackGeneration += 1;
    this.synthesizing = false;
    if (connection !== undefined && connection.state.status !== VoiceConnectionStatus.Destroyed) {
      connection.destroy();
    }
    if (guildId !== undefined && channelId !== undefined) {
      await this.options.emit({ type: "left", guildId, channelId });
    }
  }

  public status(): DiscordVoiceSessionStatus {
    return {
      active: this.connection?.state.status === VoiceConnectionStatus.Ready,
      ...(this.guildId === undefined ? {} : { guildId: this.guildId }),
      ...(this.channelId === undefined ? {} : { channelId: this.channelId }),
      ...(this.daveProtocolVersion === undefined ? {} : { daveProtocolVersion: this.daveProtocolVersion }),
      consentedParticipantCount: this.consent.current()?.consentedUserIds.size ?? 0,
      activeCaptureCount: this.captures.size,
    };
  }

  private async capture(userId: string, onSustainedSpeech?: () => void): Promise<void> {
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
    const stream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SPEAKING_END_SILENCE_MS },
    });
    this.captures.set(userId, stream);
    const decoder = new opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let capped = false;
    let interrupted = false;
    decoder.on("data", (chunk: Buffer) => {
      if (capped) return;
      bytes += chunk.byteLength;
      if (bytes > MAX_DISCORD_PCM_BYTES) {
        capped = true;
        stream.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
      // Interrupt only once this is as much audio as it takes to count as an
      // utterance at all. Anything shorter is discarded downstream anyway, so
      // letting it stop playback would cut him off for a sound that never
      // produces a turn.
      if (!interrupted && onSustainedSpeech !== undefined && bytes >= BARGE_IN_PCM_BYTES) {
        interrupted = true;
        onSustainedSpeech();
      }
    });
    try {
      await pipeline(stream, decoder);
    } catch {
      if (!capped && this.consent.permits(guildId, channelId, userId)) {
        await this.options.emit({
          type: "failed",
          guildId,
          channelId,
          stage: "capture",
          code: "voice_capture_failed",
        });
      }
      for (const chunk of chunks) chunk.fill(0);
      return;
    } finally {
      this.captures.delete(userId);
    }
    if (!this.consent.permits(guildId, channelId, userId)) {
      for (const chunk of chunks) chunk.fill(0);
      return;
    }
    const discordPcm = Buffer.concat(chunks);
    const durationMs = Math.round(pcmDurationMs(discordPcm, 48_000, 2));
    if (durationMs < MIN_UTTERANCE_MS) {
      discordPcm.fill(0);
      for (const chunk of chunks) chunk.fill(0);
      return;
    }
    let speechPcm: Buffer;
    try {
      speechPcm = discordPcmToSpeechPcm(discordPcm);
    } catch {
      await this.options.emit({
        type: "failed",
        guildId,
        channelId,
        stage: "capture",
        code: "voice_pcm_conversion_failed",
      });
      return;
    } finally {
      discordPcm.fill(0);
      for (const chunk of chunks) chunk.fill(0);
    }
    const sessionGeneration = this.sessionGeneration;
    const responseGeneration = this.playbackGeneration;
    this.turnQueue = this.turnQueue
      .then(() =>
        this.processTurn({
          guildId,
          channelId,
          userId,
          durationMs,
          speechPcm,
          sessionGeneration,
          responseGeneration,
        }),
      )
      .catch(() => undefined);
    await this.turnQueue;
  }

  private async processTurn(input: {
    readonly guildId: string;
    readonly channelId: string;
    readonly userId: string;
    readonly durationMs: number;
    readonly speechPcm: Buffer;
    readonly sessionGeneration: number;
    readonly responseGeneration: number;
  }): Promise<void> {
    if (!this.turnStillPermitted(input)) {
      input.speechPcm.fill(0);
      return;
    }
    // Stage clocks. Started here rather than at capture so the numbers describe
    // work this turn actually did, with the fixed silence hold reported beside
    // them rather than folded in.
    const turnStartedMs = this.clock();
    let transcribeMs = 0;
    let captainMs = 0;
    let synthesizeMs = 0;
    let toFirstAudioMs = 0;
    let playbackMs = 0;
    let transcript: string | undefined;
    try {
      const startedMs = this.clock();
      transcript = await this.options.speech.transcribe(input.speechPcm);
      transcribeMs = this.clock() - startedMs;
    } catch {
      await this.options.emit({
        type: "failed",
        guildId: input.guildId,
        channelId: input.channelId,
        stage: "speech_to_text",
        code: "voice_transcription_failed",
      });
      return;
    } finally {
      input.speechPcm.fill(0);
    }
    if (transcript === undefined || !this.turnStillPermitted(input)) return;
    const deliveryId = randomUUID();
    await this.options.emit({
      type: "utterance",
      guildId: input.guildId,
      channelId: input.channelId,
      userId: input.userId,
      deliveryId,
      durationMs: input.durationMs,
    });
    if (!this.turnStillPermitted(input)) return;
    let turn: Awaited<ReturnType<DiscordVoiceIngress["handle"]>>;
    const captainStartedMs = this.clock();
    try {
      turn = await this.options.ingress.handle({
        deliveryId,
        guildId: input.guildId,
        channelId: input.channelId,
        userId: input.userId,
        transcript,
        presenceSessionId: this.options.presenceSessionId(),
      });
    } catch {
      await this.options.emit({
        type: "failed",
        guildId: input.guildId,
        channelId: input.channelId,
        stage: "captain_turn",
        code: "voice_captain_turn_failed",
      });
      return;
    } finally {
      captainMs = this.clock() - captainStartedMs;
      transcript = undefined;
    }
    if (!this.turnStillPermitted(input)) return;
    if (turn.state === "failed") {
      await this.options.emit({
        type: "failed",
        guildId: input.guildId,
        channelId: input.channelId,
        stage: "captain_turn",
        code: turn.code,
      });
      return;
    }
    // Nothing to synthesize, and nothing to say. Returning before the speech
    // path also means a declined turn costs no TTS.
    if (turn.state === "declined") return;
    if (input.responseGeneration !== this.playbackGeneration) return;
    try {
      this.synthesizing = true;
      const synthesizeStartedMs = this.clock();
      const audio = await this.options.speech.synthesize(turn.response);
      synthesizeMs = this.clock() - synthesizeStartedMs;
      this.synthesizing = false;
      try {
        if (!this.turnStillPermitted(input) || input.responseGeneration !== this.playbackGeneration) {
          audio.pcm24KhzMono.fill(0);
          return;
        }
        const discordPcm = openAiPcmToDiscordPcm(audio.pcm24KhzMono);
        audio.pcm24KhzMono.fill(0);
        try {
          toFirstAudioMs = this.clock() - turnStartedMs;
          const playbackStartedMs = this.clock();
          this.player.play(createAudioResource(Readable.from([discordPcm]), { inputType: StreamType.Raw }));
          await entersState(this.player, AudioPlayerStatus.Idle, PLAYBACK_TIMEOUT_MS);
          playbackMs = this.clock() - playbackStartedMs;
        } finally {
          if (this.player.state.status !== AudioPlayerStatus.Idle) this.player.stop(true);
          discordPcm.fill(0);
        }
        if (!this.turnStillPermitted(input) || input.responseGeneration !== this.playbackGeneration) {
          return;
        }
      } finally {
        audio.pcm24KhzMono.fill(0);
      }
      await this.options.emit({
        type: "response",
        guildId: input.guildId,
        channelId: input.channelId,
        deliveryId,
        turnId: turn.turnId,
        state: turn.state,
        silenceHoldMs: SPEAKING_END_SILENCE_MS,
        transcribeMs: Math.round(transcribeMs),
        captainMs: Math.round(captainMs),
        synthesizeMs: Math.round(synthesizeMs),
        toFirstAudioMs: Math.round(toFirstAudioMs),
        playbackMs: Math.round(playbackMs),
      });
    } catch {
      this.synthesizing = false;
      await this.options.emit({
        type: "failed",
        guildId: input.guildId,
        channelId: input.channelId,
        stage: "text_to_speech",
        code: "voice_synthesis_failed",
      });
    }
  }

  private turnStillPermitted(input: {
    readonly guildId: string;
    readonly channelId: string;
    readonly userId: string;
    readonly sessionGeneration: number;
  }): boolean {
    return (
      input.sessionGeneration === this.sessionGeneration &&
      input.guildId === this.guildId &&
      input.channelId === this.channelId &&
      this.connection?.state.status === VoiceConnectionStatus.Ready &&
      this.consent.permits(input.guildId, input.channelId, input.userId)
    );
  }
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
