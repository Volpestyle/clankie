import {
  DiscordPresenceChannelTurnRequestSchema,
  type CaptainChannelTurnResult,
  type DiscordPresenceChannelTurnRequest,
  type DiscordTransportKind,
} from "@clankie/protocol";

export interface DiscordVoiceCaptainPort {
  getHealth(): Promise<{ readonly profileHash: string }>;
  submitDiscordCaptainChannelTurn(
    request: DiscordPresenceChannelTurnRequest,
  ): Promise<CaptainChannelTurnResult>;
}

export interface DiscordVoiceTurn {
  readonly deliveryId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly userId: string;
  readonly transcript: string;
  readonly presenceSessionId: string;
}

export type DiscordVoiceTurnOutcome =
  | { readonly state: "settled"; readonly turnId: string; readonly response: string }
  /** The captain chose silence. Nothing is spoken. */
  | { readonly state: "declined"; readonly turnId: string }
  /** A live run absorbed this utterance; that run's reply speaks for it (ADR 0091). */
  | { readonly state: "absorbed"; readonly turnId: string }
  | {
      readonly state: "waiting_user";
      readonly turnId: string;
      readonly response: string;
      readonly approvalRequired: boolean;
    }
  | { readonly state: "failed"; readonly code: string; readonly turnId?: string };

export interface DiscordVoiceIngressOptions {
  readonly characterId: string;
  readonly credentialRef: string;
  /** Which body heard the utterance. Both planes address the same voice lane. */
  readonly transportKind: DiscordTransportKind;
}

/** Routes one speaker-attributed transcript through the durable Discord voice captain lane. */
export class DiscordVoiceIngress {
  private readonly port: DiscordVoiceCaptainPort;
  private readonly options: DiscordVoiceIngressOptions;

  public constructor(port: DiscordVoiceCaptainPort, options: DiscordVoiceIngressOptions) {
    this.port = port;
    this.options = options;
  }

  public async handle(turn: DiscordVoiceTurn): Promise<DiscordVoiceTurnOutcome> {
    const transcript = turn.transcript.replaceAll(/\s+/gu, " ").trim();
    if (transcript.length === 0) return { state: "failed", code: "voice_transcript_empty" };
    const health = await this.port.getHealth();
    const request = DiscordPresenceChannelTurnRequestSchema.parse({
      schemaVersion: 1,
      deliveryId: turn.deliveryId,
      identity: {
        presenceSessionId: turn.presenceSessionId,
        correlationId: `discord-voice:${turn.deliveryId}`,
        profileHash: health.profileHash,
        characterId: this.options.characterId,
        credentialRef: this.options.credentialRef,
        transportKind: this.options.transportKind,
      },
      trigger: {
        kind: "voice_event",
        id: turn.deliveryId,
        guildId: turn.guildId,
        channelId: turn.channelId,
        actorId: turn.userId,
        body: transcript,
      },
      contextMessages: [],
    });
    const result = await this.port.submitDiscordCaptainChannelTurn(request);
    if (result.state === "failed") {
      return {
        state: "failed",
        code: result.code,
        ...(result.turnId === undefined ? {} : { turnId: result.turnId }),
      };
    }
    if (result.state === "waiting_user") {
      return {
        state: "waiting_user",
        turnId: result.turnId,
        approvalRequired: result.approvalRequired,
        response: result.approvalRequired
          ? "I need you to continue that request on the authenticated operator surface."
          : result.prompt,
      };
    }
    if (result.state === "silent") {
      // Voice does not offer the decline path today — `mayDecline` is only set
      // by text ingress — so reaching here means the captain used the sentinel
      // unprompted. Say nothing rather than read the marker aloud.
      return { state: "declined", turnId: result.turnId };
    }
    if (result.state === "absorbed") {
      return { state: "absorbed", turnId: result.turnId };
    }
    return { state: "settled", turnId: result.turnId, response: result.response };
  }
}
