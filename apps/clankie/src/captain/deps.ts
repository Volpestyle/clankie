import type { BodyLeaseRouter } from "../body-lease-router.ts";
import type { FleetShellRun, HerdrFleet, HerdrFleetRun } from "../herdr-fleet.ts";
import type { PiSeatModel } from "./herdr-watch.ts";
import type { AgentSessions } from "../agent-sessions.ts";
import type { ExecutionConnections } from "../herdr-session.ts";
import type {
  ActivityObservationRead,
  PlayStillRead,
  PlayStoryRead,
  DiscordPresenceSessionRecord,
  DiscordVoiceStay,
} from "@clankie/interactive-environment";
import type { VoiceSpeechSnapshot } from "../voice-receipt-activity.ts";
import type {
  CaptainSessionLaneV2,
  CaptainTurnSettledMetrics,
  DiscordPersonIdentity,
  DiscordPresenceAttachment,
  DiscordStreamWatchObservation,
  EmbodimentIntent,
  EmbodimentSession,
  EmbodimentSubmitResult,
  GenerateImageRequest,
  GenerateImageResult,
  GenerateVideoRequest,
  GenerateVideoResult,
} from "@clankie/protocol";
import type { BrowserHost } from "../browser-host.ts";
import type { createDiscordCaptainActionClient } from "../discord-captain-actions.ts";
import type { createDiscordMusicClient } from "../discord-music.ts";
import type { createDiscordVoicePresenceClient } from "../discord-voice-presence.ts";
import type { EmailPort } from "../email.ts";
import type { ComputerUseHarness } from "../computer-use-harnesses.ts";
import type { McpHost } from "../mcp-host.ts";
import type { FinishedRender } from "../media-generation.ts";
import type { TldrawHost } from "../tldraw-host.ts";
import type { RivalsClient } from "../rivals.ts";
import type { WorkItemsService } from "../work-items.ts";
import type { DiscordTracking } from "../discord-tracking.ts";

/**
 * Everything the captain's tools reach in the rest of the service, as plain
 * in-process function calls.
 */
export interface CaptainDeps {
  readonly refreshWorkerCatalogs?: import("../worker-tool-refresh.ts").RefreshWorkerCatalogs;
  readonly activitySharing?: import("../activity-sharing.ts").ActivitySharing;
  /** Non-secret wake settings, shared by the CLI, API and Clankie's own tool. */
  readonly linearWake?: {
    readonly settings: Pick<import("@clankie/settings").SettingsStore, "load" | "update">;
    targetAllowed(conversationId: string): boolean;
    received?(conversationId: string, wakeId: string): Promise<unknown>;
  };
  readonly discordTracking?: Pick<DiscordTracking, "configureProject">;
  /** This captain's fresh settings and explicit environment, supplied by its host. */
  readonly discordSettings?: () => Promise<import("@clankie/protocol").DiscordSettings>;
  /** Exact conversation-owned Minecraft stay, sharing the Pokémon play lease. */
  readonly minecraft?: import("../minecraft.ts").MinecraftService;
  readonly minecraftHost?: import("../minecraft-host.ts").MinecraftHostService;
  readonly desktop?: import("./desktop.ts").DesktopExpressions;
  readonly runtimeUpdater?: import("../../../tui/bin/runtime-updater.ts").RuntimeUpdater;
  readonly roomObservations?: import("../discord-room-observations.ts").DiscordRoomObservations;
  /** Host-proven original body account, presence, source receipt and opt-in. */
  readonly conversationRouteAuthorized?: (
    owner: import("./conversation-owner.ts").ConversationOwner,
  ) => boolean;
  readonly bodyLeases?: BodyLeaseRouter;
  /** Trusted hosted body: provider credentials are repaired by the service operator. */
  readonly modelCredentialsOperatorManaged?: boolean;
  readonly onModelCredentialRejection?: (event: {
    providerId: string;
    outcome: "refreshed" | "reconnect_required" | "operator_required";
  }) => void;
  /** Called once per settled turn with its bounded metrics. */
  readonly onTurnSettled?: (metrics: CaptainTurnSettledMetrics) => void;
  /** Execution is optional; checked again when a terminal tool is called. */
  readonly herdrAvailable?: () => boolean;
  /** An optional host-selected model for Pi workers; absent, Pi keeps its own. */
  readonly piSeatModel?: () => Promise<PiSeatModel | undefined>;
  /**
   * Harnesses on this machine that can drive the owner's apps and browser
   * (ADR 0199). Absent on a hosted body, which has no owner desktop.
   */
  readonly computerUseHarnesses?: () => Promise<readonly ComputerUseHarness[]>;
  /** Optional host capacity; absent, hires are not counted. */
  readonly hireCapacity?: () => Promise<{ readonly live: number; readonly limit: number } | undefined>;
  readonly runtimes?: Pick<ExecutionConnections, "list" | "configuredBinding" | "onChange"> &
    Partial<Pick<ExecutionConnections, "namedLocal" | "runNamed">>;
  /**
   * The initial fleet seed and a live provider. Production reads current
   * named connections per use; static seeds support isolated embeddings.
   */
  readonly fleets?: {
    readonly list: readonly HerdrFleet[];
    current?(): Promise<readonly HerdrFleet[]>;
    run(fleet: HerdrFleet): HerdrFleetRun;
    /** Non-Herdr commands on the fleet's machine, for its native seat channels (VUH-1527). */
    shell?(fleet: HerdrFleet): FleetShellRun;
    remoteWorkspace(fleet: string, directory: string): Promise<boolean>;
  };
  readonly rivals?: RivalsClient;
  /** Claude/Codex transcripts on this machine and owner-configured SSH hosts. */
  readonly agentSessions?: Pick<AgentSessions, "list" | "read"> &
    Partial<Pick<AgentSessions, "resolve" | "subagents" | "readSubagent">>;
  /** Work items in each repo's own tracking convention (ADR 0191). */
  readonly workItems?: Pick<WorkItemsService, "handle">;
  /** Tools on his connected MCP servers. The lane is passed on every call. */
  readonly mcp: Pick<McpHost, "catalog" | "call">;
  /** The mail tools only; the account catalog owns status and disconnect. */
  readonly email: Pick<EmailPort, "list" | "read" | "search" | "send">;
  readonly browser: Pick<BrowserHost, "catalog" | "call">;
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
  readonly diagrams?: TldrawHost;
  readonly embodiment: {
    submitIntent(
      intent: EmbodimentIntent,
      identity?: import("../body-lease-router.ts").BodyConversationIdentity,
    ): Promise<EmbodimentSubmitResult>;
    getSession(sessionId: string): Promise<EmbodimentSession | undefined>;
    getLiveSession(): Promise<EmbodimentSession | undefined>;
  };
  readonly activity: {
    current(): Promise<ActivityObservationRead>;
  };
  /** Live still and current-or-latest journey story. */
  readonly playSight?: {
    still(): Promise<PlayStillRead>;
    story(): Promise<PlayStoryRead>;
  };
  /** Granted hosted-world operations while a PokeAgents body is live. */
  readonly hostedWorld?: {
    guide?(
      text: string,
      identity?: import("../body-lease-router.ts").BodyConversationIdentity,
    ): Promise<unknown>;
    inspect():
      | { readonly outcome: "not_playing" }
      | {
          readonly outcome: "playing";
          readonly grantedOperations: readonly string[];
          readonly session:
            | {
                readonly worldId: string;
                readonly playerId: string;
                readonly sessionId: string;
                readonly gameId: string;
              }
            | undefined;
        };
    invoke(
      name: string,
      input?: Record<string, unknown>,
      identity?: import("../body-lease-router.ts").BodyConversationIdentity,
    ): Promise<unknown>;
  };
  /** Screen shares a live Discord body is watching. Absent when no Discord body is in the loadout. */
  readonly streamWatch?: {
    current(): Promise<DiscordStreamWatchObservation>;
  };
  /**
   * Discord DJ desk on the active body (search / play / queue). Absent when
   * the live Discord process is not accepting music.
   */
  readonly discordMusic?: ReturnType<typeof createDiscordMusicClient>;
  /** Voice membership on the active Discord body; the body resolves and authorizes the target. */
  readonly discordVoicePresence?: ReturnType<typeof createDiscordVoicePresenceClient>;
  /** Grounded social actions on the message and body belonging to the active turn. */
  readonly discordActions?: Omit<ReturnType<typeof createDiscordCaptainActionClient>, "execute"> & {
    /** Producer retains this host guard through its final authenticated body effect. */
    execute(
      input: Parameters<ReturnType<typeof createDiscordCaptainActionClient>["execute"]>[0],
      guard?: () => Promise<void>,
    ): ReturnType<ReturnType<typeof createDiscordCaptainActionClient>["execute"]>;
  };
  readonly presence: {
    listSessions(): Promise<DiscordPresenceSessionRecord[]>;
    listVoiceHistory(limit?: number): Promise<DiscordVoiceStay[]>;
    listRecentVoiceSpeech(limit?: number): Promise<VoiceSpeechSnapshot>;
  };
  readonly memory: {
    writeMemory(input: {
      readonly sourceConversationId: string;
      readonly lane: CaptainSessionLaneV2;
      readonly targetId: string;
      readonly text: string;
    }): Promise<{ readonly id: string; readonly text: string }>;
    recallMemoryCard(lane: CaptainSessionLaneV2, query?: string): Promise<string>;
    /** On-demand recall past the automatic card, scoped to what this lane may see. */
    searchMemory(lane: CaptainSessionLaneV2, query: string): Promise<string>;
    /** Reading a memory grants no right to edit it: the exact source conversation owns it. */
    editMemory(input: {
      readonly sourceConversationId: string;
      readonly lane: CaptainSessionLaneV2;
      readonly id: string;
      readonly text: string;
    }): Promise<{ readonly id: string; readonly text: string } | undefined>;
    /** The same authorship fence as edit; an inaccessible id is indistinguishable from a missing one. */
    forgetMemory(input: {
      readonly sourceConversationId: string;
      readonly lane: CaptainSessionLaneV2;
      readonly id: string;
    }): Promise<boolean>;
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
