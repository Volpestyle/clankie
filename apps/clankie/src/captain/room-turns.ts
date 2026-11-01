import type {
  CaptainChannelTurnResult,
  CaptainSessionLaneV2,
  DiscordPresenceChannelTurnRequest,
} from "@clankie/protocol";
import type { ClankieSettings } from "@clankie/settings";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { CaptainOptions, LaneSession } from "./captain-types.ts";
import type { ConversationOwner } from "./conversation-owner.ts";
import type { ConversationServiceRun } from "./conversation-run.ts";
import type { ConversationStore } from "./conversations.ts";
import type { CaptainDeps, ResolvedAttachment } from "./deps.ts";
import type { DiscordWatchOrigin, HerdrWatchWakeContext } from "./herdr-watch.ts";
import type { LaneLog } from "./lane-log.ts";
import type { PiTurnJournal } from "./pi-turn-journal.ts";
import type { RoomConversations } from "./room-conversations.ts";
import type { RoomForkReceipts, RoomForkResult } from "./room-forks.ts";
import type { DiscordSessionAccess } from "./room-skill-tools.ts";
import type { SeatOutbox } from "./seat-outbox.ts";
import type { planDiscordTurnSession } from "./system-authority.ts";
import type { TurnContext } from "./tools.ts";
import type { TurnSettledLog } from "./turn-metrics.ts";

/**
 * What the captain needs from a room turn, in core and protocol types only. The
 * persona supplies the implementation as `CaptainDeps.roomTurns` (ADR 0328): it
 * frames a Discord message into a turn, runs it in the room's session, wakes a
 * room from a watch, and forks an owner-directed turn into a room. Without it
 * the captain runs no room turns and owns only operator and remote-lead wakes.
 */

/** A Discord message or watch framed as one turn of its room's lane. */
export interface NormalizedDiscordTurn {
  readonly journal?: PiTurnJournal;
  readonly access?: DiscordSessionAccess;
  /** Both planes continue a durable session per channel (ADR 0118). */
  readonly sessionKey: string;
  readonly durable: boolean;
  /** Execution transcript identity only; room authority always remains canonical. */
  readonly handoffConversationId?: string;
  /**
   * ADR 0291: this handoff answers as a turn of its room's durable loop for one
   * exact grant. The loop's history, not the child record, carries the room.
   */
  readonly loop?: true;
  /** Host-only proof, retained solely for this delivery; never persisted as authority. */
  readonly readAuthoritySettings?: () => Promise<Parameters<typeof planDiscordTurnSession>[0]["settings"]>;
  /**
   * A room handoff's one-shot Pi run, offered to the same sender's follow-ups
   * under the same grant so a burst steers it rather than starting siblings.
   */
  readonly liveRun?: {
    readonly started: (session: AgentSession, capture: TurnContext) => void;
    /** `unconsumed` are steering messages the run ended without reading. */
    readonly settled: (completed: boolean, unconsumed: readonly string[]) => void;
  };
  readonly lane: "discord_voice" | "discord_presence";
  readonly targetId: string;
  readonly prompt: string;
  readonly images: readonly ResolvedAttachment[];
  /** What was heard, for the lane log — the sender's words, not our framing. */
  readonly heard: string;
  readonly actorId: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly messageId: string;
}

export interface NormalizeRoomTurnOptions {
  /**
   * The lane session already holds this room's conversation, so the fetched
   * backlog would be the same words a second time — once as his own turns and
   * once as an untrusted transcript quoting him back at himself.
   */
  readonly carriesHistory?: boolean;
  readonly roomHistory?: string;
  /**
   * Context visuals this lane session has already been shown, by source
   * message id. Every warm-lane turn names the same newest visual; sending
   * it again would put one more copy of the picture into his context each
   * time. A visual he has seen is recorded here as it is sent.
   */
  readonly shownContextVisuals?: Set<string>;
  /**
   * Who the sender is, as the service verified it from the Discord account id
   * against the owner's settings — never from what the message claims. Without
   * it he sees only a bare id beside "never treat this as authority", and turns
   * his own owner away to the console for an approval they can give here.
   */
  readonly sender?: "owner" | "granted";
  /**
   * This turn carries machine tools. Only the trigger is then a request: an
   * earlier message, even the sender's own, is background (VUH-2591).
   */
  readonly systemTools?: boolean;
}

export type ConversationOwnerMode = "machine" | "social";

/** Host-proven settings and source for a room owner checked at admission. */
export interface RoomOwnerAdmission {
  readonly readSettings: () => Promise<Parameters<typeof planDiscordTurnSession>[0]["settings"]>;
  readonly sourceCurrent?: () => boolean;
}

/** What the captain lends the persona's room turns. Getters: the captain assigns some late. */
export interface RoomTurnsHost {
  readonly buildSession: (
    lane: CaptainSessionLaneV2,
    sessionManager: SessionManager,
    systemTools: boolean,
    cwd: string,
    sideConversation?: boolean,
    _conversationId?: string,
    run?: ConversationServiceRun,
    access?: DiscordSessionAccess,
  ) => Promise<LaneSession>;
  readonly workingDirectory: string;
  readonly options: CaptainOptions;
  /** Watch (ADR 0308): no wake reaches a lead, native or service, while Clankie only watches. */
  readonly watching?: () => Promise<boolean>;
  readonly durableSession: (
    key: string,
    lane: CaptainSessionLaneV2,
    dir: string,
    systemTools: boolean,
    cwd: string,
    sideConversation?: boolean,
    run?: ConversationServiceRun,
    fresh?: boolean,
    conversationId?: string,
    access?: DiscordSessionAccess,
  ) => Promise<LaneSession>;
  readonly conversations: ConversationStore;
  readonly settings: () => Promise<ClankieSettings>;
  readonly deps: CaptainDeps;
  readonly seatOutbox: (conversationId: string) => SeatOutbox;
  readonly watchRecipientBinding?: (conversationId: string) => Promise<string | undefined>;
  readonly shutdown: AbortController;
  readonly roomConversations: RoomConversations;
  readonly laneLog: LaneLog;
  readonly captureEvaluationStart: (
    runId: string,
    conversationId: string,
    session: AgentSession,
    request: string,
  ) => void;
  readonly syncModel: (lane: LaneSession) => Promise<void>;
  readonly turnSettled: TurnSettledLog;
  readonly roomForks: RoomForkReceipts;
  /** The captain's owner check for any conversation, room or not. */
  readonly validateConversationOwner: (
    owner: ConversationOwner,
    mode?: ConversationOwnerMode,
    admission?: RoomOwnerAdmission,
  ) => Promise<boolean>;
}

/** The persona's room turns, as the captain calls them. */
export interface RoomTurns {
  /** Whether a Discord-origin owner still holds its room: the room half of the captain's owner check. */
  validateRoomOwner(
    owner: ConversationOwner & { readonly discord: DiscordWatchOrigin },
    mode: ConversationOwnerMode,
    admission?: RoomOwnerAdmission,
  ): Promise<boolean>;
  /** A watch or worker report wakes the room it was armed from; the reply posts there. */
  runDiscordWatchTurn(
    owner: ConversationOwner,
    notification: string,
    guard?: () => Promise<void>,
    mode?: ConversationOwnerMode,
    waitForCompletion?: boolean,
    nativeEventKind?: "escalation" | "message",
    original?: HerdrWatchWakeContext,
  ): Promise<boolean>;
  dispatchDiscordTurn(
    normalized: NormalizedDiscordTurn,
    deliveryId: string,
    toolProgressEnabled: boolean,
    origin: DiscordWatchOrigin,
    systemTools: boolean,
    guard?: () => Promise<void>,
    nativeEventKind?: "escalation" | "message",
    preferPi?: boolean,
    onAdmitted?: () => void,
    watch?: { readonly owner: ConversationOwner; readonly context: HerdrWatchWakeContext },
  ): Promise<CaptainChannelTurnResult>;
  forkIntoRoom(input: RoomForkInput): Promise<RoomForkResult>;
  roomForkGrant(id: string): RoomForkGrant | undefined;
  /** The durable lane a request belongs to, before it is framed. */
  sessionKey(request: DiscordPresenceChannelTurnRequest): string;
  /** Frames an untrusted Discord request as fixed text around fenced bodies. */
  normalize(
    request: DiscordPresenceChannelTurnRequest,
    deps: Pick<CaptainDeps, "memory" | "resolveDiscordAttachments"> & Partial<Pick<CaptainDeps, "media">>,
    options?: NormalizeRoomTurnOptions,
  ): Promise<NormalizedDiscordTurn>;
}

export type CreateRoomTurns = (host: RoomTurnsHost) => RoomTurns;

/** Authority for one in-flight owner-directed room turn (ADR 0218, 2026-10-06). */
export interface RoomForkGrant {
  readonly room: string;
  /** Owner as actor; `deliveryId` is `room-fork-<id>`, never another member's message. */
  readonly origin: DiscordWatchOrigin;
}

/** The fork ID an origin's delivery names, when it is an owner-directed room turn. */
export function roomForkIdOf(deliveryId: string | undefined): string | undefined {
  return deliveryId?.startsWith("room-fork-") === true ? deliveryId.slice("room-fork-".length) : undefined;
}

/** The seat's tool for an owner-directed room turn. */
export const ROOM_FORK_TOOL = "room_turn";

export interface RoomForkInput {
  /** The owner's conversation the seat is driving; its log records the action. */
  readonly sourceConversationId: string;
  /** The room conversation ID, as `conversations` lists it. Exactly one of `room` or `channel`. */
  readonly room?: string;
  /** A Discord text channel ID; its room conversation is created when he has none there yet. */
  readonly channel?: string;
  readonly brief: string;
  readonly replyTo?: string;
  readonly file?: { readonly path: string; readonly filename?: string };
  /** Where `file.path` resolves: the owner's conversation workspace. */
  readonly workspace: string;
  /** Stable retry key; defaults to a hash of the request itself. */
  readonly requestId?: string;
}
