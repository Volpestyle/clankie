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
}

/**
 * Single official-bot media owner for one guild voice channel. Discord's
 * receiver supplies per-user Opus streams; only explicitly consented user ids
 * are subscribed, and raw PCM is discarded after a bounded brokered turn.
 */
export class DiscordVoiceSession {
  private readonly options: DiscordVoiceSessionOptions;
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
    void this.capture(userId);
  };

  public constructor(options: DiscordVoiceSessionOptions) {
    this.options = options;
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
    const stream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
    });
    this.captures.set(userId, stream);
    const decoder = new opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let capped = false;
    decoder.on("data", (chunk: Buffer) => {
      if (capped) return;
      bytes += chunk.byteLength;
      if (bytes > MAX_DISCORD_PCM_BYTES) {
        capped = true;
        stream.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
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
    let transcript: string | undefined;
    try {
      transcript = await this.options.speech.transcribe(input.speechPcm);
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
    if (input.responseGeneration !== this.playbackGeneration) return;
    try {
      this.synthesizing = true;
      const audio = await this.options.speech.synthesize(turn.response);
      this.synthesizing = false;
      try {
        if (!this.turnStillPermitted(input) || input.responseGeneration !== this.playbackGeneration) {
          audio.pcm24KhzMono.fill(0);
          return;
        }
        const discordPcm = openAiPcmToDiscordPcm(audio.pcm24KhzMono);
        audio.pcm24KhzMono.fill(0);
        try {
          this.player.play(createAudioResource(Readable.from([discordPcm]), { inputType: StreamType.Raw }));
          await entersState(this.player, AudioPlayerStatus.Idle, PLAYBACK_TIMEOUT_MS);
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
