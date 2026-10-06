import type { ConversationQuestionAnswer } from "@clankie/protocol";
import {
  type BeginOperatorAttachmentUpload,
  type DeliveryStage,
  type DiscordGuildRoom,
  type DiscordGuildRoomTarget,
  type OperatorAttachmentChunk,
  type OperatorAttachmentUploadResult,
  type OperatorChannelMember,
  type OperatorConversation,
  type OperatorConversationContextUsage,
  type OperatorConversationEventBody,
  type OperatorConversationScope,
  type OperatorConversationServiceRequest,
  type OperatorConversationServiceResult,
  type OperatorDeliveredFile,
  type OperatorGoal,
  type RoomHandoffMetadata,
  type CaptainChannelTurnResult,
} from "@clankie/protocol";
import { z } from "zod";
import { type StoredOwnerAttachment } from "../../delivered-files.ts";
import {
  type QuestionAuthority,
  type QuestionState,
  type QuestionWorkspace,
} from "../conversation-questions.ts";
import type { FleetSeatDelivery } from "../fleet-seat.ts";
import type { HerdrAgentSnapshot } from "../herdr-watch.ts";
import {
  InboundAcceptanceSchema,
  InboundReportRecipientSchema,
  InboundReportDeliverySchema,
} from "./constants.ts";

export type ConversationServiceRequest = Exclude<
  OperatorConversationServiceRequest,
  | { op: "connections" }
  | { op: "work_repos" }
  | { op: "work_items" }
  | { op: "work_project" }
  | { op: "work_item_write" }
  | { op: "work_item_write_receipt" }
  | { op: "autonomy" }
  | { op: "roster" }
  | { op: "fleet" }
  | { op: "readopt_seat" }
  | { op: "worker_reports" }
  | { op: "acknowledge_worker_reports" }
  | { op: "acknowledge_worker_report_history" }
  | { op: "presence" }
  | { op: "subagent_replay" }
  | { op: "composer_catalog" }
  | { op: "state_stance" }
  | { op: "state_work" }
  | { op: "personas" }
  | { op: "roles" }
  | { op: "update_persona" }
  | { op: "set_persona_role" }
  | { op: "terminal_catalog" }
  | { op: "close_seat" }
  | { op: "settle_hire_receipt" }
  | { op: "spawn_seat" }
  | { op: "move_seat" }
  | { op: "terminal_tail" }
  | { op: "terminal_control" }
  | { op: "terminal_input" }
>;

export type ConversationServiceResult = Exclude<
  OperatorConversationServiceResult,
  | { op: "connections" }
  | { op: "work_repos" }
  | { op: "work_items" }
  | { op: "work_project" }
  | { op: "work_item_write" }
  | { op: "work_item_write_receipt" }
  | { op: "autonomy" }
  | { op: "roster" }
  | { op: "fleet" }
  | { op: "readopt_seat" }
  | { op: "worker_reports" }
  | { op: "acknowledge_worker_reports" }
  | { op: "acknowledge_worker_report_history" }
  | { op: "presence" }
  | { op: "composer_catalog" }
  | { op: "state_stance" }
  | { op: "state_work" }
  | { op: "personas" }
  | { op: "roles" }
  | { op: "update_persona" }
  | { op: "set_persona_role" }
  | { op: "terminal_catalog" }
  | { op: "close_seat" }
  | { op: "settle_hire_receipt" }
  | { op: "spawn_seat" }
  | { op: "move_seat" }
  | { op: "terminal_tail" }
  | { op: "terminal_control" }
  | { op: "terminal_input" }
>;

/** A native delivery that was accepted or uncertain is handled and never replayed. */
export interface ConversationDriver<T> {
  run(): Promise<{ readonly handled: true; readonly result: T } | { readonly handled: false }>;
}

interface SeatTranscriptCheckpoint {
  readonly sessionKey: string;
  readonly entryIds?: readonly string[];
  /** Pre-tool transcript checkpoints; read once and rewritten as `entryIds`. */
  readonly messageIds?: readonly string[];
}

export type InboundReportRecipient = z.infer<typeof InboundReportRecipientSchema>;

export type InboundAcceptance = z.infer<typeof InboundAcceptanceSchema>;

export type InboundReceiptInput = Omit<
  InboundAcceptance,
  "message" | "runId" | "acceptedCursor" | "acceptedAt" | "reportDelivery"
>;

export interface InboundReport extends InboundAcceptance {
  readonly conversationId: string;
  readonly acceptedAt: string;
  readonly reportDelivery: z.infer<typeof InboundReportDeliverySchema>;
}

export interface ServiceHandoffSpan {
  /** Exclusive log cursor: the harness already holds everything up to here. */
  fromCursor: string;
  /** `attempting` is persisted before transport; restart turns it into `unresolved`. */
  state: "open" | "attempting" | "unresolved";
  spanId?: string;
  text?: string;
  /** Inclusive end of the sealed projection. */
  toCursor?: string;
  /** A service turn began after sealing; it carries into the next span. */
  pendingAfter?: boolean;
}

export interface ConversationMeta {
  questions?: QuestionState;
  designatedHeadConversationId?: string;
  /** Retained accepted inbound payloads; independent of event-log trimming. */
  inboundAcceptances?: Record<string, InboundAcceptance>;
  nativeSource?: HerdrAgentSnapshot;
  readonly conversationId: string;
  scope: OperatorConversationScope;
  title: string;
  isDefault: boolean;
  readonly createdAt: string;
  updatedAt: string;
  revision: number;
  sessionState: OperatorConversation["sessionState"];
  contextUsage?: OperatorConversationContextUsage;
  readonly parentConversationId?: string;
  roomHandoff?: RoomHandoffMetadata;
  roomHandoffFingerprint?: string;
  roomHandoffResult?: CaptainChannelTurnResult;
  /** Exclusive replay boundary immediately before the oldest retained event. */
  retainedFromCursor?: string;
  /** Newest external event already carried by a Linear hook turn. */
  linearWakeCursor?: string;
  linearWakeCheckpoint?: { previous: string; cursor: string; runId?: string; wakeId?: string };
  /** Exact offered batches; a native transport ACK alone does not mark provider notifications read. */
  linearWakeReceipts?: Record<
    string,
    {
      runId?: string;
      eventIds: string[];
      offeredAt: string;
      receivedAt?: string;
      native?: { messageId: string; fingerprint: string; recipientBinding?: string };
    }
  >;
  /** Harness-native messages already folded into this durable persona thread. */
  seatTranscript?: SeatTranscriptCheckpoint;
  roomTranscripts?: Record<string, SeatTranscriptCheckpoint>;
  /** Native launcher sessions are pinned to one service conversation. */
  nativeSeatSessions?: Record<string, "current" | "retired">;
  /** Bumped whenever harness transcript entries are folded into this conversation. */
  nativeTranscriptRevision?: number;
  /** The native transcript revision the service session was last seeded from. */
  serviceContextRevision?: number;
  /** Newest log cursor a harness is known to hold (its sync, a handoff, or a start seed). */
  harnessCursor?: string;
  /** Service-run turns not yet handed to a returning harness (ADR 0218). */
  serviceHandoff?: ServiceHandoffSpan;
  /** The last handoff whose native take could not be proven; never resent. */
  serviceHandoffUncertain?: { spanId: string; at: string; text?: string };
  /**
   * The channel roster, in turn order. Present exactly on a `channel` scope
   * (ADR 0146); it lives on the meta so pruning the conversation takes the
   * membership with it and the two can never disagree.
   */
  channelMembers?: readonly OperatorChannelMember[];
  /**
   * Where this channel is projected, and the credential to post there. The
   * token lives here and nowhere else: `publicChannel` carries the webhook id
   * so a surface can tell a projected channel from an unprojected one, and
   * never the half that can post.
   */
  channelDiscord?: {
    readonly guildId: string;
    /** The direct channel, or the parent forum that owns the webhook. */
    readonly channelId: string;
    /** The forum post carrying this room, when projected into a forum. */
    readonly threadId?: string;
    readonly webhookId: string;
    readonly webhookToken: string;
    /**
     * Clankie made this webhook, so unprojecting or deleting the room deletes
     * it in Discord too. Absent on a pasted webhook — the operator made that
     * one by hand and keeps it — and on records from before the flag existed,
     * which are treated as pasted rather than guessed at.
     */
    readonly provisioned?: true;
  };
  /** An explicit disconnect or uncertain creation must never silently create a duplicate. */
  channelDiscordAutoProvision?: "disabled" | "uncertain";
}

/** Optional seat for a turn that arrived from a herdr-hosted console. */
interface ConversationTurnSeat {
  readonly herdrPaneId: string;
}

/** Where a turn runs and who it arrived from. */
export interface ConversationTurnContext {
  readonly delivery?: "steer" | "queue";
  /** Actual native admission, independent of the model turn's eventual result. */
  readonly deliveryOutcome?: (outcome: DeliveryAdmission) => void;
  readonly ownerAuthority?: QuestionAuthority;
  readonly questionCurrent?: () => boolean;
  readonly questionBinding?: { readonly incarnationId: string; readonly workspace: QuestionWorkspace };
  readonly inputAnswer?: { readonly requestId: string; readonly answer: ConversationQuestionAnswer };

  /**
   * Absolute directory the conversation's session works in, from a workspace
   * scope. Absent for a global conversation, which works in the service repo.
   */
  readonly workspace?: string;
  readonly seat?: ConversationTurnSeat;
  readonly internal?: true;
  /**
   * What queued an internal turn: a goal continuation, a due self-wake, a
   * settled herdr watch, an authenticated worker message, or a signed inbound
   * hook. A hook is its own origin rather than another wake because its turn
   * concerns something outside this machine, and the prompt says so.
   */
  readonly origin?: "goal" | "wake" | "watch" | "message" | "hook" | "input";
  /** Host-only goal identity; queued work cannot claim a replacement goal. */
  readonly expectedGoal?: OperatorGoal;
  /** The surface a human send arrived from, as it named itself. */
  readonly surfaceClientId?: string;
  /** Side conversations inherit a Pi branch but never continue their parent's active task. */
  readonly side?: true;
  /** Files the owner attached to this message (ADR 0209); owner content, never instructions. */
  readonly attachments?: readonly StoredOwnerAttachment[];
  /** Conversation-store run id; one metrics line uses this, including absorbed steers. */
  readonly runId: string;
  readonly acceptedAt: string;
  /** Receipt of this delivery, separate from completion of the local run. */
  readonly deliveryReceipt?: (stage: DeliveryStage) => void;
  /** Aborts when the operator interrupts this run (`cancel` op); the runner stops the live model turn. */
  readonly signal: AbortSignal;
  /**
   * Show the message being typed, or `undefined` to take it down. Volatile: it
   * reaches watching surfaces through the tail's `live` field and never becomes
   * a durable event. The runner throttles; the store just holds the latest.
   */
  readonly draft: (text: string | undefined) => void;
}

/** Runs one accepted operator turn against the captain's model session. */
export type ConversationRunner = (
  conversationId: string,
  message: string,
  publish: (event: OperatorConversationEventBody) => void,
  context: ConversationTurnContext,
) => Promise<void>;

export type DeliveryAdmission =
  | { readonly state: "started" | "steered" | "queued"; readonly detail?: string }
  | { readonly state: "rejected"; readonly detail: string }
  | { readonly state: "uncertain"; readonly detail: string };

export type SeatSender = (
  seatId: string,
  message: string,
  context: {
    readonly conversationId: string;
    readonly source: string;
    readonly delivery?: "steer" | "queue";
  },
) => Promise<boolean | FleetSeatDelivery>;

export type PersonaSeatResolver = (personaId: string) => string | undefined;

/**
 * What one seat said to another, as it happens (ADR 0163). The store reports;
 * the captain decides what to do with it, and holds the window.
 */
export type SeatEdgeReporter = (
  event:
    | {
        readonly type: "message";
        readonly fromSeatId: string;
        readonly toSeatId: string;
        readonly conversationId: string;
        readonly entryId: string;
      }
    | {
        readonly type: "turn";
        readonly seatId: string;
        readonly conversationId: string;
        readonly entryId: string;
      },
) => void;

export type PersonaPresentation = (personaId: string) => Promise<{
  readonly username: string;
  readonly avatarUrl?: string;
}>;

/**
 * Posts one agent's words into the guild a channel is projected onto
 * (ADR 0146). Discord renders and participates; it owns nothing. A post that
 * fails must therefore never cost the conversation its own record of what was
 * said, so the round treats this as best-effort.
 */
export interface ChannelProjection {
  /** Fresh Admin fleet settings allow existing local groups to acquire their first destination. */
  autoProvision?: () => Promise<boolean>;
  /** Participant fleets share one designated channel and never need webhooks. */
  participantPost?: (message: { readonly username: string; readonly content: string }) => Promise<boolean>;
  post: (post: {
    readonly guildId: string;
    readonly channelId: string;
    readonly threadId?: string;
    readonly webhookId: string;
    readonly webhookToken: string;
    readonly username: string;
    readonly avatarUrl?: string;
    readonly content: string;
  }) => Promise<void>;
  /** Which room a webhook points at, so the operator supplies only its URL. */
  resolve: (credential: { readonly webhookId: string; readonly webhookToken: string }) => Promise<{
    readonly guildId: string;
    readonly channelId: string;
  }>;
  /**
   * Make the webhook rather than being handed one — on a fresh room, or on an
   * existing container named by `room`. A forum container gets one new post.
   * Absent where the bot lacks
   * `Manage Webhooks` in the managed server, which is the one case the manual
   * pasted webhook is for; a host with no Discord runtime at all has no swarm
   * home either, and projects nothing by any path.
   */
  provision?: (input: { readonly name: string; readonly room?: DiscordGuildRoomTarget }) => Promise<{
    readonly guildId: string;
    readonly channelId: string;
    readonly threadId?: string;
    readonly webhookId: string;
    readonly webhookToken: string;
  }>;
  /** The managed server's rooms, so an existing one can be picked to project onto. */
  rooms?: () => Promise<readonly DiscordGuildRoom[]>;
  /** The one guild rooms may live in, which a pasted webhook is held to. */
  swarmGuildId?: () => string | undefined;
  /** Refresh the connected server before any explicit or automatic projection mutation. */
  currentGuildId?: () => Promise<string | undefined>;
  /**
   * Delete one webhook in Discord — the cleanup half of `provision`, called
   * when a room is unprojected or removed. Authenticated by the token itself,
   * like `resolve`, so it needs no bot grant. Best-effort: a webhook already
   * gone is success, and a failure never blocks the local change.
   */
  remove?: (credential: { readonly webhookId: string; readonly webhookToken: string }) => Promise<void>;
}

export type ConversationForker = (input: {
  readonly parentConversationId: string;
  readonly conversationId: string;
  readonly workspace?: string;
}) => Promise<void>;

/**
 * Owner attachments (ADR 0209): the upload store, and how a seat receives
 * files. `forSeat` copies them into the seat's own workspace and returns the
 * note its message carries, or the reason they cannot reach it.
 */
export interface OwnerAttachmentHost {
  beginUpload(upload: BeginOperatorAttachmentUpload): Promise<OperatorAttachmentUploadResult>;
  appendUpload(chunk: OperatorAttachmentChunk): Promise<OperatorAttachmentUploadResult>;
  commitUpload(conversationId: string, uploadId: string): Promise<OperatorAttachmentUploadResult>;
  attachment(conversationId: string, artifactId: string): Promise<StoredOwnerAttachment | undefined>;
  forSeat?(
    seatId: string,
    conversationId: string,
    attachments: readonly StoredOwnerAttachment[],
  ): Promise<{ readonly note: string } | { readonly undeliverable: string }>;
}

export type DeliveredFilePublisher = (input: {
  readonly conversationId: string;
  readonly sourceRoot: string;
  readonly path: string;
  readonly filename?: string;
  readonly mediaType?: string;
}) => Promise<OperatorDeliveredFile>;

/** Metadata about a durable message that just landed. Never carries its text. */
export interface DurableMessageNotice {
  readonly conversationId: string;
  readonly role: "captain" | "agent";
}
