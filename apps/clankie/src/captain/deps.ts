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
  DiscordCaptainActionInput,
  DiscordCaptainActionResult,
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
import type { McpCallResult, McpToolDescriptor } from "../mcp-host.ts";
import type { FinishedRender } from "../media-generation.ts";

/**
 * Everything the captain's tools reach in the rest of the service, as plain
 * in-process function calls.
 */
export interface CaptainDeps {
  /** Tools on his connected MCP servers. The lane is passed on every call. */
  readonly mcp: {
    catalog(lane: CaptainSessionLaneV2): Promise<readonly McpToolDescriptor[]>;
    call(input: {
      readonly lane: CaptainSessionLaneV2;
      readonly server: string;
      readonly tool: string;
      readonly arguments: Record<string, unknown>;
    }): Promise<McpCallResult>;
  };
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
  /**
   * Discord DJ desk on the active body (search / play / queue). Absent when
   * the live Discord process is not accepting music.
   */
  readonly discordMusic?: {
    search(input: {
      query: string;
      next?: boolean;
      authorId: string;
    }): Promise<{ ok: boolean; message: string }>;
    play(input: {
      url?: string;
      index?: number;
      authorId: string;
    }): Promise<{ ok: boolean; message: string }>;
    queue(input: {
      url?: string;
      index?: number;
      authorId: string;
    }): Promise<{ ok: boolean; message: string }>;
    skip(): Promise<{ ok: boolean; message: string }>;
    pause(): Promise<{ ok: boolean; message: string }>;
    resume(): Promise<{ ok: boolean; message: string }>;
    stop(): Promise<{ ok: boolean; message: string }>;
    now(): Promise<{ ok: boolean; message: string }>;
  };
  /** Voice membership on the active Discord body; the body resolves and authorizes the target. */
  readonly discordVoicePresence?: {
    join(input: { guildId?: string; actorId?: string }): Promise<DiscordVoicePresenceResult>;
    leave(input: { guildId?: string; actorId?: string }): Promise<DiscordVoicePresenceResult>;
  };
  /** Grounded social actions on the message and body belonging to the active turn. */
  readonly discordActions?: {
    execute(input: DiscordCaptainActionInput): Promise<DiscordCaptainActionResult>;
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
  readonly frameIndex?: number;
  readonly frameCount?: number;
}
