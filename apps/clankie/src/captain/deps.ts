import type {
  ActivityObservationRead,
  DiscordPresenceSessionRecord,
  DiscordVoiceStay,
} from "@clankie/interactive-environment";
import type {
  BodyPossession,
  BrowserToolCatalog,
  CallBrowserToolRequest,
  CallBrowserToolResult,
  DiscordPersonIdentity,
  DiscordPresenceAttachment,
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
  readonly embodiment: {
    submitIntent(intent: EmbodimentIntent): Promise<EmbodimentSubmitResult>;
    getSession(sessionId: string): Promise<EmbodimentSession | undefined>;
    getLiveSession(): Promise<EmbodimentSession | undefined>;
    getPossession(): Promise<BodyPossession | undefined>;
  };
  readonly activity: {
    current(): Promise<ActivityObservationRead>;
  };
  readonly presence: {
    listSessions(): Promise<DiscordPresenceSessionRecord[]>;
    listVoiceHistory(limit?: number): Promise<DiscordVoiceStay[]>;
  };
  readonly memory: {
    appendEpisode(lane: string, episode: string): Promise<void>;
    recallEpisodes(lane: string, limit: number): Promise<readonly string[]>;
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
  readonly dataUrl: string;
  readonly mediaType: string;
  readonly filename?: string;
}
