import type {
  ActivityObservationRead,
  PlayStillRead,
  PlayStoryRead,
  DiscordPresenceSessionRecord,
  DiscordVoiceStay,
} from "@clankie/interactive-environment";
import type { VoiceSpeechSnapshot } from "../voice-receipt-activity.ts";
import type {
  BodyPossession,
  BrowserToolCatalog,
  CallBrowserToolRequest,
  CallBrowserToolResult,
  CaptainEpisodeVisibility,
  CaptainSessionLaneV2,
  DiscordPersonIdentity,
  DiscordPresenceAttachment,
  DiscordStreamWatchObservation,
  DiscordVoicePresenceResult,
  DrawDiagramResult,
  DrawErDiagramRequest,
  DrawSequenceDiagramRequest,
  EmbodimentIntent,
  EmbodimentSession,
  EmbodimentSubmitResult,
  GenerateImageRequest,
  GenerateImageResult,
  GenerateVideoRequest,
  GenerateVideoResult,
} from "@clankie/protocol";
import type { EmailPort } from "../email.ts";
import type { LinearPort } from "../linear.ts";
import type { FinishedRender } from "../media-generation.ts";

/**
 * Everything the captain's tools reach in the rest of the service, as plain
 * in-process function calls.
 */
export interface CaptainDeps {
  readonly linear: LinearPort;
  readonly email: EmailPort;
  readonly browser: {
    catalog(): Promise<BrowserToolCatalog>;
    call(request: CallBrowserToolRequest): Promise<CallBrowserToolResult>;
  };
  readonly media: {
    generateImage(request: GenerateImageRequest): Promise<GenerateImageResult>;
    /** `room` tags the render so the room that asked is told when it lands. */
    generateVideo(request: GenerateVideoRequest, room?: string): Promise<GenerateVideoResult>;
    /** Renders this room started that outlived the call and have since landed. */
    finishedRenders(room: string): Promise<readonly FinishedRender[]>;
  };
  /**
   * His drawing hand (ADR 0096). Absent when the capability is switched off;
   * the tools then say so rather than disappearing.
   */
  readonly diagrams?: {
    drawErDiagram(request: DrawErDiagramRequest): Promise<DrawDiagramResult>;
    drawSequenceDiagram(request: DrawSequenceDiagramRequest): Promise<DrawDiagramResult>;
  };
  readonly embodiment: {
    submitIntent(intent: EmbodimentIntent): Promise<EmbodimentSubmitResult>;
    getSession(sessionId: string): Promise<EmbodimentSession | undefined>;
    getLiveSession(): Promise<EmbodimentSession | undefined>;
    getPossession(): Promise<BodyPossession | undefined>;
  };
  readonly activity: {
    current(): Promise<ActivityObservationRead>;
  };
  /** Live still and journal story. Absent reads as not playing. */
  readonly playSight?: {
    still(): Promise<PlayStillRead>;
    story(): Promise<PlayStoryRead>;
  };
  readonly streamWatch: {
    current(): Promise<DiscordStreamWatchObservation>;
  };
  /** Voice membership on the active Discord body; the body resolves and authorizes the target. */
  readonly discordVoicePresence?: {
    join(input: { guildId: string; actorId: string }): Promise<DiscordVoicePresenceResult>;
    leave(input: { guildId: string; actorId: string }): Promise<DiscordVoicePresenceResult>;
  };
  readonly presence: {
    listSessions(): Promise<DiscordPresenceSessionRecord[]>;
    listVoiceHistory(limit?: number): Promise<DiscordVoiceStay[]>;
    listRecentVoiceSpeech(limit?: number): Promise<VoiceSpeechSnapshot>;
  };
  readonly memory: {
    appendEpisode(input: {
      readonly lane: CaptainSessionLaneV2;
      readonly targetId: string;
      readonly summary: string;
      readonly visibility?: CaptainEpisodeVisibility;
    }): Promise<void>;
    recallEpisodeCard(lane: CaptainSessionLaneV2): Promise<string>;
    recallDiscordPerson?(
      identity: DiscordPersonIdentity,
      options: { readonly channelId: string; readonly query: string },
    ): string | undefined;
  };
  /** Resolves Discord attachment references into data URLs at the last hop. */
  readonly resolveDiscordAttachments?: (
    attachments: readonly DiscordPresenceAttachment[],
  ) => Promise<readonly ResolvedAttachment[]>;
}

export interface ResolvedAttachment {
  readonly id: string;
  readonly dataUrl: string;
  readonly mediaType: string;
  readonly filename?: string;
}
