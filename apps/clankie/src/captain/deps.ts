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
import type { VoiceSpeechSnapshot } from "../ports/voice.ts";
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
import type { BrowserToolPort } from "../app/types.ts";
import type {
  DiscordActionPort,
  DiscordMusicPort,
  DiscordRoomGuidancePort,
  DiscordTrackingPort,
  DiscordVoicePresencePort,
} from "../ports/discord.ts";
import type { EmailPort } from "../email.ts";
import type { ComputerUseHarness } from "../computer-use-harnesses.ts";
import type { McpHost } from "../mcp-host.ts";
import type { DiagramPort, FinishedRender } from "../ports/media.ts";
import type { WorkItemsService } from "../work-items.ts";
import type { CaptainVoice } from "../ports/voice.ts";
import type { CreateRoomTurns } from "./room-turns.ts";
import type { ChannelProjection } from "./conversations.ts";

/** What the captain lends the persona's channel projection (ADR 0146, ADR 0328). */
interface ChannelProjectionHost {
  /** The owner's current Discord settings, read fresh before each projection write. */
  readonly fleetSettings: () => Promise<import("@clankie/protocol").DiscordSettings>;
  readonly discordActions?: Pick<DiscordActionPort, "serverAction">;
}

export type CreateChannelProjection = (host: ChannelProjectionHost) => ChannelProjection;

/**
 * Everything the captain's tools reach in the rest of the service, as plain
 * in-process function calls.
 */
export interface CaptainDeps {
  readonly skinDrafts?: import("../ports/media.ts").SkinDraftPort;
  readonly harnessProcesses?: import("../fleet-harness-processes.ts").FleetHarnessProcesses;
  gameExtensions?: Pick<import("../game-extension-projection.ts").InstalledGameExtensions, "projections">;
  readonly refreshWorkerCatalogs?: import("../worker-tool-refresh.ts").RefreshWorkerCatalogs;
  /** World's PokeAgent play tools for a turn, which its extension supplies (ADR 0328). */
  readonly playTools?: (
    deps: CaptainDeps,
    turn: import("./tools.ts").TurnContext,
    lane: CaptainSessionLaneV2,
    gameplay: import("@clankie/settings").GameplaySettings,
  ) => import("@earendil-works/pi-coding-agent").ToolDefinition[];
  /** The persona's Discord body tools for a turn, which its extension supplies (ADR 0328). */
  readonly personaTools?: (
    deps: CaptainDeps,
    turn: import("./tools.ts").TurnContext,
    lane: CaptainSessionLaneV2,
  ) => import("@earendil-works/pi-coding-agent").ToolDefinition[];
  /** The persona's room turns: Discord messages, room wakes and owner forks (ADR 0328). */
  readonly roomTurns?: CreateRoomTurns;
  /** Voice's lane instructions and device-call handoff, which its extension supplies while on (ADR 0328). */
  readonly voice?: CaptainVoice;
  /** The persona's projection of channels onto Discord rooms (ADR 0146, ADR 0328). */
  readonly channelProjection?: CreateChannelProjection;
  /** World's Activity sharing tools for a turn, which its extension supplies (ADR 0328). */
  readonly activityTools?: (
    turn: import("./tools.ts").TurnContext,
    launcher: import("../ports/activity.ts").ActivityRoomLauncher | undefined,
  ) => import("@earendil-works/pi-coding-agent").ToolDefinition[];
  /** The app note board's read (ADR 0301): notes connector apps left, information never orders. */
  readonly appNotes?: {
    read(
      input: import("./fleet-room.ts").AppNotesReadInput,
    ): Promise<import("@clankie/protocol").AppNotesResult>;
  };
  /** A self-hosted official bot admits Activity viewers itself, so room turns may launch shares (VUH-2835). */
  readonly activitySelfHostedLaunch?: {
    reserveLaunch(callId: string, guildId: string, channelId: string): void;
    revokeLaunches(guildId: string, channelId: string): void;
    settleRevoked(guildId: string, channelId: string, timeoutMs: number): Promise<boolean>;
  };
  /** Non-secret wake settings, shared by the CLI, API and Clankie's own tool. */
  readonly linearWake?: {
    readonly settings: Pick<import("@clankie/settings").SettingsStore, "load" | "update">;
    targetAllowed(conversationId: string): boolean;
    received?(conversationId: string, wakeId: string): Promise<unknown>;
  };
  /** Which optional services are set up; tools for the rest stay out of the model's request. */
  readonly serviceReadiness?: () => Promise<import("./service-tools.ts").ServiceReadiness>;
  readonly discordTracking?: DiscordTrackingPort;
  /** This captain's fresh settings and explicit environment, supplied by its host. */
  readonly discordSettings?: () => Promise<import("@clankie/protocol").DiscordSettings>;
  /** Exact conversation-owned Minecraft stay, sharing the Pokémon play lease. */
  readonly desktop?: import("./desktop.ts").DesktopExpressions;
  /** Retain the rollback reader's report layout until initial cutover is durably healthy. */
  readonly inboundReportMigrationReady?: () => boolean;
  readonly runtimeUpdater?: import("../../../tui/bin/runtime-updater.ts").RuntimeUpdater;
  /** Current deploy holds, shown in the lead round with holder, age and time left. */
  readonly deployHolds?: () => Promise<import("@clankie/protocol/integrate").DeployHold[]>;
  readonly commitHandoffs?: (
    path: string,
    commits: readonly string[],
  ) => Promise<{ commit: string; requestId: string }[]>;
  readonly roomObservations?: DiscordRoomGuidancePort;
  /** Host-proven original body account, presence, source receipt and opt-in. */
  readonly conversationRouteAuthorized?: (
    owner: import("./conversation-owner.ts").ConversationOwner,
  ) => boolean;
  readonly bodyLeases?: BodyLeaseRouter;
  /** Trusted hosted body: provider credentials are repaired by the service operator. */
  readonly modelCredentialsOperatorManaged?: boolean;
  /**
   * Service-log timings for each worker channel or head seat delivery:
   * identifiers and durations, never content (VUH-2034, VUH-2196).
   */
  readonly onSeatDeliveryEvent?: (
    event: import("./seat-outbox.ts").SeatDeliveryEvent &
      ({ readonly seatId: string } | { readonly conversationId: string }),
  ) => void;
  /** Durable service-log metadata for local and hosted real-turn credential recovery. */
  readonly onModelCredentialEvent?: (
    event: import("./model-credential-health.ts").ModelCredentialEvent,
  ) => void;
  /** Service-log line per seat bridge bind/unbind/state change (VUH-2036). */
  readonly onSeatBridgeState?: (
    change: { readonly conversationId: string } & import("./seat-outbox.ts").SeatBridgeStateChange,
  ) => void;
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
  /** Host policy: local native workers cannot use customer subscription stores. */
  readonly localNativeHireRefusal?: string;
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
  /** Claude/Codex transcripts on this machine and owner-configured SSH hosts. */
  readonly agentSessions?: Pick<AgentSessions, "list" | "read"> &
    Partial<Pick<AgentSessions, "resolve" | "subagents" | "readSubagent">>;
  /** Work items in each repo's own tracking convention (ADR 0191). */
  readonly workItems?: Pick<WorkItemsService, "handle"> &
    Partial<Pick<WorkItemsService, "prepareSeatIssueTracker">>;
  /** Tools on his connected MCP servers. The lane is passed on every call. */
  readonly mcp: Pick<McpHost, "catalog" | "catalogStatus" | "call">;
  /** The mail tools only; the account catalog owns status and disconnect. */
  readonly email: Pick<EmailPort, "list" | "read" | "search" | "send">;
  readonly browser: BrowserToolPort;
  /** Image and video generation; absent while the media extension is off (ADR 0328). */
  readonly media?: {
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
  readonly diagrams?: DiagramPort;
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
  readonly discordMusic?: DiscordMusicPort;
  /** Voice membership on the active Discord body; the body resolves and authorizes the target. */
  readonly discordVoicePresence?: DiscordVoicePresencePort;
  /** Grounded social actions on the message and body belonging to the active turn. */
  readonly discordActions?: DiscordActionPort;
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
