import {
  ProjectProposalDraftSchema,
  ProjectProposalTargetSchema,
  type ProjectProposalDraft,
  type ProjectProposalResult,
} from "@clankie/protocol/projects";
import { projectsRevision, ProjectTrackerUnavailable } from "@clankie/settings";
import {
  ProjectCreationSchema,
  proposalHash,
  proposalResult,
  type projectOnboarding,
} from "./project-onboarding.ts";
import {
  authorizeQuestion,
  QuestionDraftSchema,
  QuestionStateSchema,
  newQuestionState,
  questionWorkspace,
  sameQuestionWorkspace,
  answerMessage,
  type QuestionAuthority,
  type QuestionDraft,
  type QuestionState,
  type QuestionRecord,
  type QuestionWorkspace,
} from "./conversation-questions.ts";
import type { ConversationQuestionResult, ConversationQuestionAnswer } from "@clankie/protocol";
import { SeatLinkInterruptedError } from "./seat-outbox.ts";
import {
  ConversationRunStalledError,
  ConversationServiceRun,
  waitForConversationRun,
} from "./conversation-run.ts";
import { fleetDeliveryStage, WorkerReportRoutingSchema, type DeliveryStage } from "@clankie/protocol";
import { createHash, randomUUID } from "node:crypto";
import type { HerdrAgentSnapshot } from "./herdr-watch.ts";
import type { FleetSeatDelivery } from "./fleet-seat.ts";
import { z } from "zod";
import {
  ConversationOwnerSchema,
  NativeSeatRecipientSchema,
  type ConversationOwner,
  type NativeSeatRecipient,
} from "./conversation-owner.ts";
import {
  LinearWorkOwnerSchema,
  LinearNativeWorkOwnerSchema,
  linearActivityPrompt,
  linearActivityIssueId,
  LINEAR_REPLY_MARK,
  type LinearActivityEvent,
  type LinearWorkOwner,
  type LinearWorkOwnership,
} from "../linear-webhook.ts";
import {
  openSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  operatorConversationWindow,
  OPERATOR_CHANNEL_MEMBER_MAX,
  OPERATOR_CONVERSATION_SUMMARY_MAX,
  OPERATOR_CONVERSATION_TEXT_MAX,
  type DiscordGuildRoom,
  type DiscordGuildRoomTarget,
  type OperatorChannel,
  type OperatorChannelMember,
  type OperatorConversation,
  type OperatorConversationContextUsage,
  type OperatorConversationEventBody,
  type OperatorDeliveredFile,
  type OperatorAttachmentUploadResult,
  type BeginOperatorAttachmentUpload,
  type OperatorAttachmentChunk,
  type OperatorConversationLiveDraft,
  type OperatorConversationReactor,
  type OperatorConversationScope,
  type OperatorConversationServiceRequest,
  type OperatorConversationServiceResult,
  type OperatorConversationStreamEvent,
  type ReplayOperatorConversationRequest,
  type ReplayOperatorConversationResult,
  type SubmitOperatorConversationTurn,
  type SubmitOperatorConversationTurnResult,
  type UpsertOperatorChannel,
} from "@clankie/protocol";
import { parseDiscordWebhookUrl } from "@clankie/discord-presence-core";
import { isDeliveredImagePath, namedImagePaths, type StoredOwnerAttachment } from "../delivered-files.ts";
import {
  CHANNEL_NOTICE_AUTHOR,
  CHANNEL_ROUND_INTERRUPTED_NOTICE,
  channelRoundNotice,
  channelTurnReply,
  nextChannelTurn,
  renderChannelTurnPrompt,
  type ChannelTranscriptEntry,
  type ChannelTurnRecord,
} from "./channel-turns.ts";
import { ConversationJournal } from "./conversation-journal.ts";
import type {
  HerdrSeatTranscript,
  HerdrTranscriptEntry,
  HerdrTranscriptMessage,
} from "./herdr-transcript.ts";

type ConversationServiceRequest = Exclude<
  OperatorConversationServiceRequest,
  | { op: "connections" }
  | { op: "work_repos" }
  | { op: "work_items" }
  | { op: "autonomy" }
  | { op: "roster" }
  | { op: "fleet" }
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
  | { op: "spawn_seat" }
  | { op: "move_seat" }
  | { op: "terminal_tail" }
  | { op: "terminal_control" }
  | { op: "terminal_input" }
>;
type ConversationServiceResult = Exclude<
  OperatorConversationServiceResult,
  | { op: "connections" }
  | { op: "work_repos" }
  | { op: "work_items" }
  | { op: "autonomy" }
  | { op: "roster" }
  | { op: "fleet" }
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
  | { op: "spawn_seat" }
  | { op: "move_seat" }
  | { op: "terminal_tail" }
  | { op: "terminal_control" }
  | { op: "terminal_input" }
>;

/** A native delivery that was accepted or uncertain is handled and never replayed. */
interface ConversationDriver<T> {
  run(): Promise<{ readonly handled: true; readonly result: T } | { readonly handled: false }>;
}

const CURSOR_WIDTH = 12;
const ZERO_CURSOR = "0".repeat(CURSOR_WIDTH);
/** The stable room for opt-in Linear awareness (ADR 0168). */
export const LINEAR_INBOX_CONVERSATION_ID = "linear-inbox";

const LINEAR_PAGE_DEFAULT = 20;
const LINEAR_PAGE_MAX = 100;
const LINEAR_PAGE_BYTES = 30_000;
const LINEAR_WAKE_HEADLINES_MAX = 40;

export interface LinearInboxReadOptions {
  readonly conversationId?: string;
  /** Events per page, 1..100; default 20. */
  readonly limit?: number;
  /** Page backward: the events immediately before this cursor, read or not. */
  readonly before?: string;
  /** One line per event instead of the quoted payload. */
  readonly headlines?: boolean;
}

export interface LinearInboxPage {
  readonly items: readonly unknown[];
  readonly unreadCount: number;
  /** More events lie beyond this page in the direction it was read. */
  readonly hasMore: boolean;
  /** Cursor of the first item, for the next `before` step. */
  readonly oldestCursor: string | null;
  readonly ackCursor: string | null;
  readonly next: string | null;
}

/** The first line of an external message is its headline (`linearActivityPrompt`). */
function headlineOf(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}
/** Under the relay's 30s upstream dispatch timeout, with headroom. */
const DEFAULT_TAIL_WAIT_MS = 25_000;
export const OPERATOR_CONVERSATION_RETAINED_MAX = 64;
export const OPERATOR_CONVERSATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const OPERATOR_CONVERSATION_RETAINED_BYTES_MAX = 256 * 1024 * 1024;
export const OPERATOR_CONVERSATION_RETAINED_EVENTS_MAX = 500;
const OPERATOR_CONVERSATION_RETAINED_EVENTS_AFTER_TRIM = 400;
const SEAT_CONVERSATION_RETAINED_EVENTS_MAX = 10_000;
const SEAT_CONVERSATION_RETAINED_EVENTS_AFTER_TRIM = 9_000;
/**
 * How long one member's turn may hold up the round before it counts as a pass.
 * A member that never answers must not wedge the room: the operator is waiting
 * on the whole round, not on any one seat.
 */
const CHANNEL_TURN_TIMEOUT_MS = 5 * 60 * 1_000;

interface SeatTranscriptCheckpoint {
  readonly sessionKey: string;
  readonly entryIds?: readonly string[];
  /** Pre-tool transcript checkpoints; read once and rewritten as `entryIds`. */
  readonly messageIds?: readonly string[];
}

const InboundAcceptanceSchema = z
  .object({
    deliveryId: z.string().uuid(),
    binding: z.string(),
    fingerprint: z.string(),
    paneId: z.string(),
    text: z.string(),
    message: z.string(),
    runId: z.string(),
    acceptedCursor: z.string(),
    workerReportRouting: WorkerReportRoutingSchema.optional(),
  })
  .strict();
type InboundAcceptance = z.infer<typeof InboundAcceptanceSchema>;

interface ConversationMeta {
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
  /** Exclusive replay boundary immediately before the oldest retained event. */
  retainedFromCursor?: string;
  linearReadCursor?: string;
  linearOfferedCursor?: string;
  linearAckVersion?: 1;
  /** Newest external event whose headline a hook wake has already carried. */
  linearWokeCursor?: string;
  linearWakePending?: { previous: string; cursor: string; runId?: string };
  /** Trimmed deliveries remain deduplicated through the provider retry window. */
  linearSeen?: Record<string, number>;
  /** Host-stamped issue identity and original route proof in the existing inbox journal. */
  linearAdmissions?: Record<
    string,
    {
      owner: ConversationOwner;
      nativeRecipient?: NativeSeatRecipient;
      organizationId?: string;
      issueId?: string;
      handedOff?: boolean;
      handoffOf?: string;
      delivered?: boolean;
    }
  >;
  /** Harness-native messages already folded into this durable persona thread. */
  seatTranscript?: SeatTranscriptCheckpoint;
  roomTranscripts?: Record<string, SeatTranscriptCheckpoint>;
  /** Native launcher sessions are pinned to one service conversation. */
  nativeSeatSessions?: Record<string, "current" | "retired">;
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
}

/** Optional seat for a turn that arrived from a herdr-hosted console. */
interface ConversationTurnSeat {
  readonly herdrPaneId: string;
}

/** Where a turn runs and who it arrived from. */
export interface ConversationTurnContext {
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

type SeatSender = (
  seatId: string,
  message: string,
  context: { readonly conversationId: string; readonly source: string },
) => Promise<boolean | FleetSeatDelivery>;
type PersonaSeatResolver = (personaId: string) => string | undefined;
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
type PersonaPresentation = (personaId: string) => Promise<{
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
   * `Manage Webhooks` in the swarm home, which is the one case the manual
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
  /** The swarm home's rooms, so an existing one can be picked to project onto. */
  rooms?: () => Promise<readonly DiscordGuildRoom[]>;
  /** The one guild rooms may live in, which a pasted webhook is held to. */
  swarmGuildId?: () => string | undefined;
  /**
   * Delete one webhook in Discord — the cleanup half of `provision`, called
   * when a room is unprojected or removed. Authenticated by the token itself,
   * like `resolve`, so it needs no bot grant. Best-effort: a webhook already
   * gone is success, and a failure never blocks the local change.
   */
  remove?: (credential: { readonly webhookId: string; readonly webhookToken: string }) => Promise<void>;
}
type ConversationForker = (input: {
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

type DeliveredFilePublisher = (input: {
  readonly conversationId: string;
  readonly sourceRoot: string;
  readonly path: string;
  readonly filename?: string;
  readonly mediaType?: string;
}) => Promise<OperatorDeliveredFile>;

/**
 * A workspace scope names the directory the conversation's session works in.
 * That directory becomes the cwd of an unsandboxed shell, so the registry
 * refuses anything but an absolute path that already resolves to a directory —
 * a conversation is never created pointing at a path the caller invented.
 */
function workspaceOf(scope: OperatorConversationScope): string | undefined {
  if (scope.kind !== "workspace") return undefined;
  const workspace = scope.workspaceId;
  if (!isAbsolute(workspace)) {
    throw new Error(`Workspace ${workspace} is not an absolute path`);
  }
  return workspace;
}

function messageKey(role: "operator" | "agent", text: string): string {
  return `${role}\u0000${text}`;
}

function transcriptImageKey(meta: ConversationMeta, sessionKey: string, entryId: string): string {
  return `${meta.conversationId}\u0000${sessionKey}\u0000${entryId}`;
}

function transcriptEventBody(
  entry: Exclude<HerdrTranscriptEntry, { readonly type: "viewed_image" }>,
  agentRole: "agent" | "captain",
): OperatorConversationEventBody {
  if (entry.type === "message") {
    return {
      type: "message",
      role: entry.role === "agent" ? agentRole : entry.role,
      text: entry.text,
      streaming: false,
    };
  }
  return {
    type: "tool",
    toolCallId: entry.toolCallId,
    name: entry.name,
    phase: entry.phase,
    ...(entry.detail === undefined ? {} : { detail: entry.detail }),
  };
}

/** Metadata about a durable message that just landed. Never carries its text. */
export interface DurableMessageNotice {
  readonly conversationId: string;
  readonly role: "captain" | "agent";
}

export class ConversationResetError extends Error {}
/** A request the conversation understood and declines; its message is the answer. */
export class ConversationRefusedError extends Error {}

/**
 * File-backed conversation registry: `meta.json` + append-only `events.jsonl`
 * per conversation. The wire contract (list/get/create/close/replay/tail/send with
 * revision fencing and cursored pages) is the one the TUI and relay speak.
 * Cursors are zero-padded line counts.
 */
export class ConversationStore {
  private readonly metas = new Map<string, ConversationMeta>();
  /**
   * Live durable-message observers, for delivery that happens outside the
   * conversation (push wakes, ADR 0159). Per store: a second store — another
   * service instance, or a test's own — has its own transcripts, and a wake it
   * caused would name a conversation this one's devices cannot open.
   */
  private readonly durableMessageListeners = new Set<(notice: DurableMessageNotice) => void>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly runs = new Map<string, Promise<boolean>>();
  /** Live (accepted, unsettled) runs an operator `cancel` can interrupt. */
  private readonly runControllers = new Map<
    string,
    { readonly conversationId: string; readonly controller: AbortController }
  >();
  private readonly cancelRequests = new Set<string>();
  private readonly seatSends = new Map<string, Promise<void>>();
  /**
   * Rounds parked on what a seat says next (ADR 0146). A seat may sit in more
   * than one channel, and every round waiting on it hears the same reply rather
   * than one round queueing behind another and stalling the room.
   */
  private readonly seatReplyWaiters = new Map<string, Set<(reply: string | undefined) => void>>();
  private readonly runCounts = new Map<string, number>();
  /** A Linear hook turn accepted and not yet started; later deliveries ride it. */
  private readonly linearHookQueued = new Set<string>();
  private linearOwners: ((
    | LinearWorkOwnership
    | { organizationId: string; issueId: string; unboundAt: number }
  ) & {
    owner?: ConversationOwner | undefined;
    claimedAt?: number | undefined;
  })[] = [];
  /** Internal turns whose `invoke()` has begun and not yet settled — not merely queued. */
  private readonly internalRuns = new Map<string, number>();
  private readonly activeInvocations = new Map<string, number>();
  /** Admission fences only; the captain's existing live mailbox selects the native driver. */
  private readonly serviceDrives = new Map<string, Set<Promise<void>>>();
  private readonly driverAdmissions = new Map<string, Set<Promise<void>>>();

  private readonly root: string;
  private readonly journal: ConversationJournal;
  private readonly runner: ConversationRunner;
  private readonly onPrune: ((conversationId: string, scope: OperatorConversationScope) => void) | undefined;
  private readonly sendToSeat: SeatSender | undefined;
  private readonly reportSeatEdge: SeatEdgeReporter | undefined;
  private readonly publishDeliveredFile: DeliveredFilePublisher | undefined;
  private readonly defaultWorkingDirectory: string;
  private readonly ownerAttachments: OwnerAttachmentHost | undefined;
  private readonly forkConversation: ConversationForker | undefined;
  private readonly projection: ChannelProjection | undefined;
  private readonly seatForPersona: PersonaSeatResolver | undefined;
  private readonly personaPresentation: PersonaPresentation | undefined;
  /** Longest a parked tail may wait here, whatever a caller asks for. */
  private readonly tailWaitMs: number;
  /** Per-conversation parked tails, woken by `append` and by a live draft. */
  private readonly tailListeners = new Map<string, Set<() => void>>();
  /** The message the captain is typing right now, per conversation. Never durable. */
  private readonly drafts = new Map<string, OperatorConversationLiveDraft>();
  /** Serializes host file reads so transcript order survives async publication. */
  private readonly deliveredFilePublishes = new Map<string, Promise<void>>();
  private readonly pendingTranscriptImages = new Set<string>();
  private readonly transcriptImageAttempts = new Map<string, number>();
  private draftSequence = 0;
  private readonly questionIssuers = new Map<string, QuestionAuthority>();
  private readonly corruptQuestions = new Set<string>();
  /** Native seat binding is owned by captain; no native question continuation. */
  public questionEligible: (id: string) => boolean = () => true;
  public projectOnboarding: ReturnType<typeof projectOnboarding> | undefined;
  /** Rooms retain their existing Discord admission and reply runner. */
  public linearRoomRunner:
    | ((
        owner: ConversationOwner,
        prompt: string,
        guard: () => Promise<void>,
        owners: readonly ConversationOwner[],
      ) => Promise<void>)
    | undefined;
  public linearNativeRunner:
    | ((
        recipient: NativeSeatRecipient,
        content: string,
        eventId: string,
        guard: () => Promise<void>,
      ) => Promise<FleetSeatDelivery>)
    | undefined;
  public linearFollowing: (() => Promise<boolean>) | undefined;

  public constructor(
    root: string,
    runner: ConversationRunner,
    onPrune?: (conversationId: string, scope: OperatorConversationScope) => void,
    sendToSeat?: SeatSender,
    tailWaitMs = DEFAULT_TAIL_WAIT_MS,
    forkConversation?: ConversationForker,
    projection?: ChannelProjection,
    seatForPersona?: PersonaSeatResolver,
    personaPresentation?: PersonaPresentation,
    reportSeatEdge?: SeatEdgeReporter,
    publishDeliveredFile?: DeliveredFilePublisher,
    defaultWorkingDirectory = process.cwd(),
    ownerAttachments?: OwnerAttachmentHost,
  ) {
    this.root = root;
    this.journal = new ConversationJournal(root);
    this.runner = runner;
    this.onPrune = onPrune;
    this.sendToSeat = sendToSeat;
    this.tailWaitMs = tailWaitMs;
    this.forkConversation = forkConversation;
    this.projection = projection;
    this.seatForPersona = seatForPersona;
    this.personaPresentation = personaPresentation;
    this.reportSeatEdge = reportSeatEdge;
    this.publishDeliveredFile = publishDeliveredFile;
    this.defaultWorkingDirectory = defaultWorkingDirectory;
    this.ownerAttachments = ownerAttachments;
    mkdirSync(root, { recursive: true });
    // Complete a reset interrupted after archiving but before installing fresh metadata.
    const archives = join(dirname(root), "conversation-archives");
    if (statSync(archives, { throwIfNoEntry: false })?.isDirectory()) {
      for (const entry of readdirSync(archives, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^reset-[a-f0-9-]+\.pending$/u.test(entry.name)) continue;
        const staging = join(archives, entry.name);
        const archived = join(archives, entry.name.slice(0, -8));
        if (!statSync(archived, { throwIfNoEntry: false })?.isDirectory()) continue;
        const pending = JSON.parse(readFileSync(join(staging, "meta.json"), "utf8")) as ConversationMeta;
        if (!/^[a-zA-Z0-9_-]+$/u.test(pending.conversationId))
          throw new Error("Invalid pending reset conversation");
        const destination = join(root, pending.conversationId);
        if (!statSync(destination, { throwIfNoEntry: false })) {
          this.onPrune?.(pending.conversationId, pending.scope);
          renameSync(staging, destination);
        }
      }
    }
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const meta = JSON.parse(
          readFileSync(join(root, entry.name, "meta.json"), "utf8"),
        ) as ConversationMeta;
        // A crash mid-run leaves "active"; on boot nothing is running.
        if (meta.sessionState === "active" || meta.inboundAcceptances !== undefined) {
          if (meta.sessionState === "active") meta.sessionState = "waiting";
          // Settling the run stops a tailing client hanging forever, but the
          // room it was answering hears nothing at all — which is how an
          // operator came to type into a dead round five times. One line, once
          // per room however many runs it lost, and never fatal to boot.
          if (this.failOrphanedRuns(meta) > 0 && meta.scope.kind === "channel") {
            void this.projectChannelNotice(meta, CHANNEL_ROUND_INTERRUPTED_NOTICE);
          }
        }
        this.metas.set(meta.conversationId, meta);
        if (meta.questions !== undefined) {
          const checked = QuestionStateSchema.safeParse(meta.questions);
          if (!checked.success) this.corruptQuestions.add(meta.conversationId);
          else {
            meta.questions = checked.data;
            const cancelledQuestions: QuestionRecord[] = [];
            for (const record of meta.questions.records) {
              const q = record.question;
              if (q.status === "pending") {
                q.status = "cancelled";
                q.resolvedAt = new Date().toISOString();
                q.reason = "service_restarted";
                cancelledQuestions.push(record);
              }
              if (q.continuation?.state === "accepted") {
                q.continuation.state = "failed";
                q.continuation.reasonCode = "service_restarted";
              }
            }
            this.saveQuestionMeta(meta);
            for (const record of cancelledQuestions) this.publishQuestionResolution(meta, record);
          }
        }
      } catch {
        // An unreadable conversation is skipped, never fatal to boot.
      }
    }
    // Side forks have no resumable console owner after a service restart.
    for (const meta of this.metas.values()) {
      if (meta.parentConversationId !== undefined) this.remove(meta);
    }
    this.ensureDefaultGlobalConversation();
    try {
      this.linearOwners = z
        .array(
          z.union([
            LinearWorkOwnerSchema.extend({
              owner: ConversationOwnerSchema.optional(),
              claimedAt: z.number().nonnegative().optional(),
            }),
            LinearNativeWorkOwnerSchema.extend({ claimedAt: z.number().nonnegative().optional() }),
            z
              .object({
                organizationId: z.string().uuid(),
                issueId: z.string().uuid(),
                unboundAt: z.number().nonnegative(),
                claimedAt: z.number().nonnegative(),
              })
              .strict(),
          ]),
        )
        .parse(JSON.parse(readFileSync(join(root, "linear-work.json"), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const meta of this.metas.values()) {
      if (meta.linearWakePending) {
        const completed =
          meta.linearWakePending.runId &&
          this.readEvents(meta.conversationId).some(
            (event) =>
              event.type === "turn" &&
              event.runId === meta.linearWakePending!.runId &&
              event.phase === "completed",
          );
        if (!completed) meta.linearWokeCursor = meta.linearWakePending.previous;
        delete meta.linearWakePending;
        this.saveMeta(meta);
      }
    }
    this.prune();
  }

  /**
   * Remote clients may still explicitly select the default global conversation,
   * so the store guarantees exactly one even though each TUI process starts a
   * fresh conversation.
   */
  private ensureDefaultGlobalConversation(): void {
    const defaults = [...this.metas.values()]
      .filter((meta) => meta.scope.kind === "global" && meta.isDefault)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const demoted of defaults.slice(1)) {
      demoted.isDefault = false;
      this.saveMeta(demoted);
    }
    if (defaults.length > 0) return;
    const now = new Date().toISOString();
    const meta: ConversationMeta = {
      conversationId: "global-default",
      scope: { kind: "global" },
      title: "Clankie",
      isDefault: true,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      sessionState: "unbound",
    };
    mkdirSync(join(this.root, meta.conversationId), { recursive: true });
    this.metas.set(meta.conversationId, meta);
    this.saveMeta(meta);
  }

  /**
   * A turn accepted before a crash never got its terminal event, and a client
   * mid-tail would wait on it forever. Close each orphan out as failed.
   */
  private failOrphanedRuns(meta: ConversationMeta): number {
    const terminal = new Set<string>();
    const accepted: string[] = [];
    for (const event of this.readEvents(meta.conversationId)) {
      if (event.type !== "turn") continue;
      if (event.phase === "accepted") accepted.push(event.runId);
      else terminal.add(event.runId);
    }
    // Metadata is the durable acceptance boundary. If the process died before
    // publishing that accepted turn, expose it and its interruption on boot;
    // never replay the stored input or claim the model ran.
    for (const receipt of Object.values(meta.inboundAcceptances ?? {})) {
      const value = InboundAcceptanceSchema.parse(receipt);
      if (
        !accepted.includes(value.runId) &&
        Number(value.acceptedCursor) > Number(meta.retainedFromCursor ?? 0)
      ) {
        this.append(meta, { type: "turn", runId: value.runId, phase: "accepted", deliveryStage: "stored" });
        accepted.push(value.runId);
      }
    }
    const questions = QuestionStateSchema.safeParse(meta.questions);
    if (questions.success)
      for (const record of questions.data.records) {
        const receipt = record.question.continuation;
        if (receipt && receipt.state !== "accepted") terminal.add(receipt.runId);
        else if (receipt && !accepted.includes(receipt.runId)) accepted.push(receipt.runId);
      }
    const orphans = accepted.filter((id) => !terminal.has(id));
    for (const runId of orphans) {
      this.append(meta, {
        type: "turn",
        runId,
        phase: "failed",
        reasonCode: "service_restarted",
        summary:
          "The service restarted and interrupted this run's link. A native seat may still be working; its reply target is gone. Check the seat before sending the request again.",
      });
    }
    return orphans.length;
  }

  public async serve(
    request: ConversationServiceRequest,
    authority?: QuestionAuthority,
  ): Promise<ConversationServiceResult> {
    switch (request.op) {
      case "project_proposal_get":
      case "project_proposal_confirm":
        return {
          op: request.op,
          schemaVersion: 1,
          result: await this.projectProposalOperation(request, authority),
        };
      case "input_get":
      case "input_answer":
      case "input_cancel":
        return { op: request.op, schemaVersion: 1, result: await this.questionOperation(request, authority) };

      case "list": {
        const conversations = [...this.metas.values()]
          .filter((meta) => request.scope === undefined || sameScope(meta.scope, request.scope))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map((meta) => publicConversation(meta));
        return { op: "list", schemaVersion: 1, conversations };
      }
      case "get": {
        const meta = this.metas.get(request.conversationId);
        return {
          op: "get",
          schemaVersion: 1,
          ...(meta === undefined ? {} : { conversation: publicConversation(meta) }),
        };
      }
      case "create":
        if (request.scope.kind === "room")
          throw new Error("Room conversations are discovered from their transport");
        // A channel is created with its membership or not at all — an empty
        // room nobody is in is a conversation with no counterpart. Selecting a
        // channel that already exists is just selecting it.
        if (request.scope.kind === "channel" && this.channelMeta(request.scope.channelId) === undefined) {
          throw new Error("Create a channel with the channel op, which carries its membership");
        }
        return {
          op: "create",
          schemaVersion: 1,
          conversation: publicConversation(this.create(request.scope, request.title)),
        };
      case "channel": {
        const meta = await this.upsertChannel(request.channel);
        return {
          op: "channel",
          schemaVersion: 1,
          channel: publicChannel(meta),
          conversation: publicConversation(meta),
        };
      }
      case "channels":
        return {
          op: "channels",
          schemaVersion: 1,
          channels: [...this.metas.values()]
            .filter((meta) => meta.scope.kind === "channel")
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .map((meta) => publicChannel(meta)),
        };
      case "discord_rooms":
        return {
          op: "discord_rooms",
          schemaVersion: 1,
          // Empty rather than an error where no Discord runtime can list them,
          // or where no swarm home is set: the compose screen still opens, and
          // says what it can offer rather than failing to draw.
          rooms: [...((await this.projection?.rooms?.()) ?? [])],
        };
      case "react":
        return {
          op: "react",
          schemaVersion: 1,
          conversationId: request.conversationId,
          entryRef: request.entryRef,
          reacted: this.react(
            request.conversationId,
            request.entryRef,
            request.emoji,
            { kind: "operator" },
            request.remove,
          ),
        };
      case "fork":
        return {
          op: "fork",
          schemaVersion: 1,
          conversation: await this.fork(request.parentConversationId),
        };
      case "reset":
        return this.resetConversation(request.conversationId, request.expectedRevision);
      case "close":
        return {
          op: "close",
          schemaVersion: 1,
          conversationId: request.conversationId,
          closed: await this.removeConversation(request.conversationId),
        };
      case "replay":
        return { op: "replay", schemaVersion: 1, result: this.replay(request.replay) };
      case "tail": {
        // Hanging long-poll: a page with no news parks until this conversation
        // changes (or the wait elapses), so an idle tail costs one request per
        // wait window instead of one per client poll interval, and a live draft
        // reaches the surface as fast as the round trip allows. "No news" means
        // no unseen event AND no draft the caller has not already drawn.
        let result = this.replay(request.tail);
        const waitMs = Math.min(request.tail.waitMs ?? 0, this.tailWaitMs);
        if (waitMs > 0 && result.status === "page" && result.events.length === 0 && !result.hasMore) {
          if ((result.live?.sequence ?? 0) === (request.tail.liveSequence ?? 0)) {
            await this.waitForChange(request.tail.conversationId, waitMs);
            result = this.replay(request.tail);
          }
        }
        return { op: "tail", schemaVersion: 1, result };
      }
      case "send":
        return { op: "send", schemaVersion: 1, result: await this.send(request.turn, authority) };
      case "upload_begin":
        return {
          op: "upload_begin",
          schemaVersion: 1,
          result: await this.upload(request.upload.conversationId, (host) =>
            host.beginUpload(request.upload),
          ),
        };
      case "upload_chunk":
        return {
          op: "upload_chunk",
          schemaVersion: 1,
          result: await this.upload(request.chunk.conversationId, (host) => host.appendUpload(request.chunk)),
        };
      case "upload_commit":
        return {
          op: "upload_commit",
          schemaVersion: 1,
          result: await this.upload(request.conversationId, (host) =>
            host.commitUpload(request.conversationId, request.uploadId),
          ),
        };
      case "publish_file":
        return {
          op: "publish_file",
          schemaVersion: 1,
          file: await this.publishFile(request),
        };
      case "cancel":
        return {
          op: "cancel",
          schemaVersion: 1,
          conversationId: request.conversationId,
          runId: request.runId,
          cancelled: this.cancel(request.conversationId, request.runId),
        };
      default: {
        const exhaustive: never = request;
        throw new Error(`Unknown operator conversation op ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /**
   * Interrupt one accepted run. A live run's abort signal fires (the captain
   * stops the model turn); a still-queued run settles as cancelled without ever
   * invoking the runner. Unknown or already settled runs report false.
   */
  public cancel(conversationId: string, runId: string): boolean {
    const entry = this.runControllers.get(runId);
    if (entry === undefined || entry.conversationId !== conversationId) return false;
    this.cancelPendingQuestion(conversationId, "operator_interrupt", runId);
    this.cancelRequests.add(runId);
    entry.controller.abort();
    return true;
  }

  /** An upload op, refused where this conversation cannot take attachments. */
  private async upload(
    conversationId: string,
    run: (host: OwnerAttachmentHost) => Promise<OperatorAttachmentUploadResult>,
  ): Promise<OperatorAttachmentUploadResult> {
    const meta = this.metas.get(conversationId);
    const refused = (
      reason: "unknown_conversation" | "unsupported_conversation" | "unavailable",
      message: string,
    ): OperatorAttachmentUploadResult => ({ status: "refused", conversationId, reason, message });
    if (meta === undefined) return refused("unknown_conversation", "That conversation does not exist.");
    if (meta.scope.kind === "room" || meta.scope.kind === "channel")
      return refused(
        "unsupported_conversation",
        "Attachments go to Clankie or one agent, not a room or channel.",
      );
    if (this.ownerAttachments === undefined)
      return refused("unavailable", "This Clankie cannot store attachments.");
    return run(this.ownerAttachments);
  }

  /** The send's attachments, every one committed to this conversation, or a refusal. */
  private async sendAttachments(
    meta: ConversationMeta,
    turn: SubmitOperatorConversationTurn,
  ): Promise<readonly StoredOwnerAttachment[] | undefined> {
    if (turn.attachments === undefined) return undefined;
    if (meta.scope.kind === "channel")
      throw new ConversationRefusedError("Attachments go to Clankie or one agent, not a channel.");
    const host = this.ownerAttachments;
    if (host === undefined) throw new ConversationRefusedError("This Clankie cannot store attachments.");
    const stored = await Promise.all(
      turn.attachments.map((reference) => host.attachment(meta.conversationId, reference.artifactId)),
    );
    if (stored.some((attachment) => attachment === undefined))
      throw new ConversationRefusedError(
        "An attachment is not uploaded to this conversation; upload it again.",
      );
    return stored as StoredOwnerAttachment[];
  }

  public async publishFile(input: {
    readonly conversationId: string;
    readonly path: string;
    readonly filename?: string | undefined;
    readonly mediaType?: string | undefined;
  }): Promise<OperatorDeliveredFile> {
    const meta = this.metas.get(input.conversationId);
    if (meta === undefined) throw new Error("Unknown conversation");
    if (this.publishDeliveredFile === undefined) throw new Error("Delivered files are unavailable");
    const published = await this.publishDeliveredFile({
      conversationId: input.conversationId,
      sourceRoot: workspaceOf(meta.scope) ?? this.defaultWorkingDirectory,
      path: input.path,
      ...(input.filename === undefined ? {} : { filename: input.filename }),
      ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
    });
    const file = {
      artifactId: published.artifactId,
      filename: published.filename,
      mediaType: published.mediaType,
      byteCount: published.byteCount,
      sha256: published.sha256,
    };
    meta.revision += 1;
    this.append(meta, { type: "file", file });
    meta.updatedAt = new Date().toISOString();
    this.saveMeta(meta);
    return file;
  }

  /** Keeps an accepted detached run alive for the transport's waitUntil. */
  public awaitRun(runId: string): Promise<void> {
    return this.runs.get(runId)?.then(() => undefined) ?? Promise.resolve();
  }

  public awaitRunResult(runId: string): Promise<boolean> {
    return this.runs.get(runId) ?? Promise.resolve(false);
  }

  public has(conversationId: string): boolean {
    return this.metas.has(conversationId);
  }

  public conversation(conversationId: string): OperatorConversation | undefined {
    const meta = this.metas.get(conversationId);
    return meta === undefined ? undefined : publicConversation(meta);
  }

  /**
   * Whether Clankie himself answers here. He does in his own global and
   * workspace rooms; he does not in a persona thread, where the counterpart is
   * that agent, nor in a channel, where the members answer (ADR 0146). Every
   * caller that would hand him a turn asks this first.
   */
  public designatedHead(conversationId: string): string | undefined {
    const head = this.metas.get(conversationId)?.designatedHeadConversationId;
    return this.canDesignateHead(conversationId) &&
      head !== undefined &&
      head !== conversationId &&
      this.runsCaptainTurns(head)
      ? head
      : undefined;
  }

  private canDesignateHead(id: string): boolean {
    const scope = this.metas.get(id)?.scope;
    return (
      this.runsCaptainTurns(id) ||
      (scope?.kind === "room" &&
        id ===
          `room-${createHash("sha256").update(`${scope.lane}:${scope.targetId}`).digest("hex").slice(0, 24)}`)
    );
  }

  /** Administrative routing metadata; it grants neither the source nor the head new authority. */
  public setDesignatedHead(conversationId: string, headConversationId: string | null): OperatorConversation {
    const previous = this.metas.get(conversationId);
    if (previous === undefined || !this.canDesignateHead(conversationId))
      throw new Error("Owner conversation is not writable");
    if (headConversationId !== null) {
      if (!this.runsCaptainTurns(headConversationId)) throw new Error("Head conversation is not writable");
      const visited = new Set([conversationId]);
      for (
        let next: string | undefined = headConversationId;
        next !== undefined;
        next = this.metas.get(next)?.designatedHeadConversationId
      ) {
        if (visited.has(next)) throw new Error("Conversation head cycle");
        visited.add(next);
      }
    }
    const meta = { ...previous, updatedAt: new Date().toISOString(), revision: previous.revision + 1 };
    if (headConversationId === null) delete meta.designatedHeadConversationId;
    else meta.designatedHeadConversationId = headConversationId;
    this.saveMeta(meta);
    const file = openSync(join(this.root, conversationId, "meta.json"), "r");
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    const directory = openSync(join(this.root, conversationId), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    this.metas.set(conversationId, meta);
    return publicConversation(meta);
  }

  public runsCaptainTurns(conversationId: string): boolean {
    const kind = this.metas.get(conversationId)?.scope.kind;
    return kind === "global" || kind === "workspace";
  }

  /**
   * Subscribe to durable messages this store writes, as they are written.
   * Returns an unsubscribe; a throwing listener cannot fail the write.
   */
  public observeDurableMessages(listener: (notice: DurableMessageNotice) => void): () => void {
    this.durableMessageListeners.add(listener);
    return () => {
      this.durableMessageListeners.delete(listener);
    };
  }

  /** Oldest unanswered owner preference, read from canonical question receipts. */
  public pendingPresenceOwnerItem(): import("../../../../packages/protocol/src/presence.ts").OperatorPresenceSnapshot["pendingOwnerItem"] {
    const questions = [...this.metas.values()].flatMap((meta) =>
      (meta.questions?.records ?? []).flatMap(({ question }) =>
        question.status === "pending"
          ? [
              {
                conversationId: meta.conversationId,
                questionId: question.requestId,
                title: question.prompt.slice(0, 200),
                since: question.createdAt,
              },
            ]
          : [],
      ),
    );
    return questions.sort(
      (a, b) => a.since.localeCompare(b.since) || a.questionId.localeCompare(b.questionId),
    )[0];
  }

  /**
   * The one default global conversation — his own room, and the head a seat
   * outside any delivery attributes to. The store guarantees it exists.
   */
  public defaultGlobalConversationId(): string {
    for (const meta of this.metas.values()) {
      if (meta.scope.kind === "global" && meta.isDefault) return meta.conversationId;
    }
    return "global-default";
  }

  /** A separate, resumable room for opt-in Linear awareness. Normal retention applies. */
  public linearInboxConversationId(): string {
    const id = LINEAR_INBOX_CONVERSATION_ID;
    if (!this.metas.has(id)) this.create({ kind: "global" }, "Linear inbox", id);
    return id;
  }

  public linearWorkOwners(): readonly LinearWorkOwnership[] {
    return this.linearOwners.filter(
      (item): item is LinearWorkOwnership & { owner?: ConversationOwner; claimedAt?: number } =>
        !("unboundAt" in item),
    );
  }

  public bindLinearWorkOwner(
    binding: LinearWorkOwner,
    owner: ConversationOwner,
    claimedAt = Date.now(),
    replayed = false,
  ): boolean {
    const checked = LinearWorkOwnerSchema.parse({
      ...binding,
      organizationId: binding.organizationId.toLowerCase(),
      issueId: binding.issueId.toLowerCase(),
    });
    const proof = ConversationOwnerSchema.parse(owner);
    if (!Number.isFinite(claimedAt) || claimedAt < 0) return false;
    const prior = this.linearOwners.find(
      (item) =>
        item.organizationId.toLowerCase() === checked.organizationId &&
        item.issueId.toLowerCase() === checked.issueId,
    );
    if (
      (prior?.claimedAt ?? 0) > claimedAt ||
      (replayed && prior?.claimedAt === claimedAt && JSON.stringify(prior.owner) !== JSON.stringify(proof))
    )
      return false;
    const meta = this.metas.get(checked.conversationId);
    if (
      !meta ||
      proof.conversationId !== checked.conversationId ||
      (!this.runsCaptainTurns(checked.conversationId) && (meta.scope.kind !== "room" || !proof.discord))
    )
      return false;
    const next = this.linearOwners.filter(
      (item) =>
        item.organizationId.toLowerCase() !== checked.organizationId ||
        item.issueId.toLowerCase() !== checked.issueId,
    );
    next.push({ ...checked, owner: proof, claimedAt });
    this.saveLinearOwners(next);
    return true;
  }

  public bindLinearNativeWorkOwner(
    issue: Pick<LinearWorkOwner, "organizationId" | "issueId">,
    nativeRecipient: NativeSeatRecipient,
    claimedAt = Date.now(),
    replayed = false,
  ): boolean {
    const nextOwner = LinearNativeWorkOwnerSchema.parse({
      organizationId: issue.organizationId.toLowerCase(),
      issueId: issue.issueId.toLowerCase(),
      nativeRecipient,
    });
    if (!Number.isFinite(claimedAt) || claimedAt < 0) return false;
    const prior = this.linearOwners.find(
      (item) =>
        item.organizationId.toLowerCase() === nextOwner.organizationId &&
        item.issueId.toLowerCase() === nextOwner.issueId,
    );
    if (
      (prior?.claimedAt ?? 0) > claimedAt ||
      (replayed &&
        prior?.claimedAt === claimedAt &&
        JSON.stringify(prior) !== JSON.stringify({ ...nextOwner, claimedAt }))
    )
      return false;
    this.saveLinearOwners([
      ...this.linearOwners.filter(
        (item) =>
          item.organizationId.toLowerCase() !== nextOwner.organizationId ||
          item.issueId.toLowerCase() !== nextOwner.issueId,
      ),
      { ...nextOwner, claimedAt },
    ]);
    return true;
  }

  public unbindLinearWorkOwner(organizationId: string, issueId: string): boolean {
    const organization = organizationId.toLowerCase(),
      issue = issueId.toLowerCase();
    const prior = this.linearOwners.find(
      (item) => item.organizationId.toLowerCase() === organization && item.issueId.toLowerCase() === issue,
    );
    const next = this.linearOwners.filter(
      (item) =>
        item.organizationId.toLowerCase() !== organizationId.toLowerCase() ||
        item.issueId.toLowerCase() !== issueId.toLowerCase(),
    );
    const now = Date.now();
    next.push({ organizationId: organization, issueId: issue, unboundAt: now, claimedAt: now });
    this.saveLinearOwners(next);
    return prior !== undefined && !("unboundAt" in prior);
  }

  private saveLinearOwners(next: typeof this.linearOwners): void {
    const path = join(this.root, "linear-work.json");
    writeFileSync(path + ".tmp", JSON.stringify(next), { mode: 0o600 });
    renameSync(path + ".tmp", path);
    this.linearOwners = next;
  }

  private linearOwner(organizationId?: string, issueId?: string): ConversationOwner {
    const binding = this.linearOwners.find(
      (item) =>
        item.organizationId.toLowerCase() === organizationId?.toLowerCase() &&
        item.issueId.toLowerCase() === issueId?.toLowerCase(),
    );
    return binding && "conversationId" in binding && this.metas.has(binding.conversationId)
      ? (binding.owner ?? { conversationId: binding.conversationId })
      : { conversationId: this.linearInboxConversationId() };
  }

  private linearNativeOwner(organizationId?: string, issueId?: string): NativeSeatRecipient | undefined {
    const binding = this.linearOwners.find(
      (item) =>
        item.organizationId.toLowerCase() === organizationId?.toLowerCase() &&
        item.issueId.toLowerCase() === issueId?.toLowerCase(),
    );
    return binding && "nativeRecipient" in binding ? binding.nativeRecipient : undefined;
  }

  private linearAdmission(event: OperatorConversationStreamEvent & { type: "message" }): ConversationOwner {
    const proof = this.metas.get(this.linearInboxConversationId())?.linearAdmissions?.[event.cursor]?.owner;
    const id = proof?.conversationId ?? event.linear?.conversationId ?? this.linearInboxConversationId();
    return this.metas.has(id)
      ? (proof ?? { conversationId: id })
      : { conversationId: this.linearInboxConversationId() };
  }

  public receiveLinearActivity(input: string | LinearActivityEvent, following: boolean): boolean {
    const message = typeof input === "string" ? input : linearActivityPrompt(input);
    const id = this.linearInboxConversationId();
    const issueId =
      typeof input === "string"
        ? undefined
        : (input.issueId ?? (input.notification === true ? undefined : linearActivityIssueId(input)));
    const organizationId = typeof input === "string" ? undefined : input.organizationId;
    const reply = typeof input === "string" ? undefined : input.replyRecipient?.recipient;
    const nativeRecipient =
      reply?.kind === "native"
        ? NativeSeatRecipientSchema.parse(reply)
        : reply
          ? undefined
          : this.linearNativeOwner(organizationId, issueId);
    const owner =
      nativeRecipient || (reply?.kind === "conversation" && !this.metas.has(reply.owner.conversationId))
        ? { conversationId: this.linearInboxConversationId() }
        : reply?.kind === "conversation"
          ? ConversationOwnerSchema.parse(reply.owner)
          : this.linearOwner(organizationId, issueId);
    const source =
      typeof input !== "string" && input.eventId
        ? {
            eventId: input.eventId,
            notification: input.notification === true,
            conversationId: owner.conversationId,
          }
        : undefined;
    const meta = this.metas.get(id)!;
    if (
      source &&
      (this.readEvents(id).some(
        (event) => event.type === "message" && event.linear?.eventId === source.eventId,
      ) ||
        (meta.linearSeen?.[source.eventId] ?? 0) > Date.now() - 7 * 24 * 60 * 60 * 1000)
    ) {
      // The original admission wins. A passive duplicate never acquires a wake.
      if (following) this.resumeLinearActivity();
      return false;
    }
    meta.revision += 1;
    const cursor = String(this.eventSequence(meta) + 1).padStart(CURSOR_WIDTH, "0");
    if (source) {
      meta.linearAdmissions ??= {};
      meta.linearAdmissions[cursor] = {
        owner,
        ...(nativeRecipient ? { nativeRecipient } : {}),
        ...(organizationId ? { organizationId } : {}),
        ...(issueId ? { issueId } : {}),
      };
      // Commit the route before its eligible journal row becomes recoverable.
      // A failed append leaves an inert proof, never an event with lost authority.
      this.saveMeta(meta);
    }
    this.append(meta, {
      type: "message",
      role: "external",
      text: message,
      streaming: false,
      ...(source ? { linear: { ...source, following } } : {}),
    });
    meta.updatedAt = new Date().toISOString();
    this.saveMeta(meta);
    if (following && (typeof input === "string" || input.notification === true)) {
      if (nativeRecipient) this.queueLinearNativeActivity(cursor);
      else this.queueLinearActivity(owner.conversationId);
    }
    return true;
  }

  public handoffLinearActivity(cursor: string): boolean {
    const meta = this.metas.get(this.linearInboxConversationId())!;
    const event = this.readEvents(meta.conversationId).find((item) => item.cursor === cursor);
    if (
      event?.type !== "message" ||
      !event.linear ||
      this.linearAdmission(event).conversationId !== meta.conversationId
    )
      return false;
    const admission = meta.linearAdmissions?.[cursor];
    if (!admission || admission.nativeRecipient) return false;
    if (
      Object.entries(meta.linearAdmissions ?? {}).some(
        ([derived, proof]) =>
          proof.handoffOf === cursor &&
          this.readEvents(meta.conversationId).some(
            (item) => item.cursor === derived && item.type === "message" && item.linear,
          ),
      )
    )
      return false;
    const owner = this.linearOwner(admission.organizationId, admission.issueId);
    const nativeRecipient = this.linearNativeOwner(admission.organizationId, admission.issueId);
    if (owner.conversationId === meta.conversationId && !nativeRecipient) return false;
    if (admission.handedOff) return false;
    // A handoff is a new explicit admission, with a stable derived ID. Its new
    // cursor can wake an owner that has already read later provider events.
    const eventId = createHash("sha256")
      .update(
        `linear-handoff:${event.linear.eventId}:${nativeRecipient ? JSON.stringify(nativeRecipient) : owner.conversationId}`,
      )
      .digest("hex");
    const existing = this.readEvents(meta.conversationId).find(
      (item) => item.type === "message" && item.linear?.eventId === eventId,
    );
    if (existing) return false;
    const nextCursor = String(this.eventSequence(meta) + 1).padStart(CURSOR_WIDTH, "0");
    meta.revision += 1;
    meta.linearAdmissions![nextCursor] = {
      ...admission,
      owner,
      ...(nativeRecipient ? { nativeRecipient } : {}),
      handedOff: false,
      handoffOf: cursor,
      delivered: false,
    };
    this.saveMeta(meta);
    this.append(meta, {
      type: "message",
      role: "external",
      text: event.text,
      streaming: false,
      linear: { ...event.linear, eventId, conversationId: owner.conversationId },
    });
    admission.handedOff = true;
    this.saveMeta(meta);
    if (event.linear.following && event.linear.notification === true) {
      if (nativeRecipient) this.queueLinearNativeActivity(nextCursor);
      else this.queueLinearActivity(owner.conversationId);
    }
    return true;
  }

  private queueLinearActivity(id: string): void {
    if (this.linearHookQueued.has(id) || !this.metas.has(id)) return;
    this.linearHookQueued.add(id);
    const meta = this.metas.get(id)!;
    const runner: ConversationRunner =
      meta.scope.kind === "room"
        ? async (_id, _message, _publish, context) => {
            if (this.linearFollowing && !(await this.linearFollowing())) return;
            const events = this.freshLinearEvents(id);
            if (!events.length || !this.linearRoomRunner) return;
            const owners = events.map((event) => this.linearAdmission(event));
            const owner = owners[0]!;
            if (!owner.discord) throw new Error("Linear room ownership lacks original route authority");
            const prompt = this.linearWakePrompt(id, context.runId);
            if (!prompt) return;
            await this.linearRoomRunner(
              owner,
              prompt,
              async () => {
                if (context.signal.aborted || !this.metas.has(id))
                  throw new Error("Linear conversation admission changed");
              },
              owners,
            );
          }
        : this.runner;
    const result = this.enqueue(meta, "Linear activity arrived.", undefined, false, runner, {
      origin: "hook",
    });
    if (result.status !== "accepted") {
      this.linearHookQueued.delete(id);
      throw new Error("Linear activity was not accepted");
    }
  }

  private freshLinearEvents(id: string) {
    const meta = this.metas.get(id)!;
    return this.readEvents(this.linearInboxConversationId()).filter(
      (event): event is OperatorConversationStreamEvent & { type: "message" } =>
        event.type === "message" &&
        event.role === "external" &&
        event.linear?.following === true &&
        event.linear.notification === true &&
        this.metas.get(this.linearInboxConversationId())?.linearAdmissions?.[event.cursor]
          ?.nativeRecipient === undefined &&
        this.metas.get(this.linearInboxConversationId())?.linearAdmissions?.[event.cursor]?.delivered !==
          true &&
        this.linearAdmission(event).conversationId === id &&
        event.cursor > (meta.linearWokeCursor ?? ZERO_CURSOR),
    );
  }

  /** Resume only original eligible admissions, never passive backlog. */
  public resumeLinearActivity(): void {
    const events = this.readEvents(this.linearInboxConversationId());
    for (const event of events) {
      const admission = this.metas.get(this.linearInboxConversationId())?.linearAdmissions?.[event.cursor];
      if (
        event.type === "message" &&
        event.linear?.following &&
        event.linear.notification === true &&
        admission?.nativeRecipient &&
        !admission.delivered
      )
        this.queueLinearNativeActivity(event.cursor);
    }
    const destinations = new Set(
      events.flatMap((event) =>
        event.type === "message" && event.linear?.following && event.linear.notification === true
          ? [this.linearAdmission(event).conversationId]
          : [],
      ),
    );
    for (const id of destinations) if (this.freshLinearEvents(id).length) this.queueLinearActivity(id);
  }

  private queueLinearNativeActivity(cursor: string): void {
    const meta = this.metas.get(this.linearInboxConversationId())!;
    const event = this.readEvents(meta.conversationId).find((item) => item.cursor === cursor);
    const admission = meta.linearAdmissions?.[cursor];
    if (event?.type !== "message" || !event.linear || !admission?.nativeRecipient || admission.delivered)
      return;
    const key = `native:${event.linear.eventId}`;
    if (this.linearHookQueued.has(key)) return;
    this.linearHookQueued.add(key);
    const recipient = NativeSeatRecipientSchema.parse(admission.nativeRecipient);
    const runner: ConversationRunner = async (_id, _message, _publish, context) => {
      if (this.linearFollowing && !(await this.linearFollowing())) return;
      const guard = async () => {
        if (this.linearFollowing && !(await this.linearFollowing()))
          throw new Error("Linear following was disabled before native delivery");
        const admissionAge = Date.now() - Date.parse(event.occurredAt);
        if (!Number.isFinite(admissionAge) || admissionAge < 0 || admissionAge >= 7 * 24 * 60 * 60 * 1000)
          throw new Error(
            "Linear native admission exceeds retained receipt history; reconcile its original delivery before another attempt",
          );
        if (
          context.signal.aborted ||
          this.metas.get(meta.conversationId) !== meta ||
          meta.linearAdmissions?.[cursor] !== admission ||
          admission.delivered ||
          JSON.stringify(admission.nativeRecipient) !== JSON.stringify(recipient)
        )
          throw new Error("Linear native admission changed");
      };
      await guard();
      if (!this.linearNativeRunner) throw new Error("Linear native delivery is unavailable");
      const outcome = await this.linearNativeRunner(recipient, event.text, event.linear!.eventId, guard);
      if (outcome.outcome !== "delivered")
        throw new Error(`Linear native delivery ${outcome.outcome}: ${outcome.detail}`);
      admission.delivered = true;
      this.saveMeta(meta);
    };
    // Native delivery uses the inbox's existing durable run and receipt, without
    // taking its model turn or advancing a conversation's Linear wake cursor.
    const result = this.enqueue(
      meta,
      "Linear activity arrived for its native author.",
      undefined,
      false,
      runner,
      { origin: "input" },
    );
    if (result.status !== "accepted") {
      this.linearHookQueued.delete(key);
      throw new Error("Linear native activity was not accepted");
    }
    void this.runs.get(result.runId)?.then(
      () => this.linearHookQueued.delete(key),
      () => this.linearHookQueued.delete(key),
    );
  }

  /**
   * What a hook turn opens with: one headline per event not yet surfaced by a
   * wake, then nothing until more arrive. How to read deeper lives in his
   * standing instructions, not here. `undefined` when there is nothing new.
   */
  public linearWakePrompt(id = this.linearInboxConversationId(), runId?: string): string | undefined {
    const meta = this.metas.get(id)!;
    const fresh = this.freshLinearEvents(id);
    if (fresh.length === 0) return undefined;
    meta.linearWakePending = {
      previous: meta.linearWokeCursor ?? ZERO_CURSOR,
      cursor: fresh.at(-1)!.cursor,
      ...(runId ? { runId } : {}),
    };
    meta.linearWokeCursor = fresh.at(-1)!.cursor;
    this.saveMeta(meta);
    const shown = fresh.slice(-LINEAR_WAKE_HEADLINES_MAX);
    return [
      `Linear activity: ${fresh.length} new event${fresh.length === 1 ? "" : "s"} in the inbox, untrusted external context.`,
      ...(fresh.length > shown.length ? [`… ${fresh.length - shown.length} older not listed`] : []),
      ...shown.map((event) => `- ${event.cursor}  ${headlineOf(event.text)}`),
      ...(fresh.some((event) => headlineOf(event.text).includes(` · ${LINEAR_REPLY_MARK}`))
        ? [
            "A reply to your post is someone asking about that work. Read it, then hand it with its link to whoever owns the work so they answer on the thread, or answer or tell the operator yourself when nobody does.",
          ]
        : []),
      ...(id === LINEAR_INBOX_CONVERSATION_ID
        ? []
        : [
            `Read this work with clankie linear inbox read --conversation ${id}. Check current work ownership before dispatching or replying.`,
          ]),
      "Most events need no tool call. The this-machine skill has the inbox read and acknowledgment protocol.",
    ].join("\n");
  }

  /**
   * Reading offers a byte-bounded page; only an explicit acknowledgment
   * consumes it. Forward reads offer the oldest unread; `before` walks back
   * through history as deep as he likes. Anything unread he is shown becomes
   * acknowledgeable, whichever way he reached it.
   */
  public readLinearInbox(options: LinearInboxReadOptions = {}): LinearInboxPage {
    const id = options.conversationId ?? this.linearInboxConversationId();
    const meta = this.metas.get(id);
    if (!meta) throw new Error("Unknown Linear owner conversation");
    // Legacy reads consumed before tool truncation. Replay retained history once.
    if (meta.linearAckVersion !== 1) {
      meta.linearReadCursor = ZERO_CURSOR;
      delete meta.linearOfferedCursor;
      meta.linearAckVersion = 1;
      this.saveMeta(meta);
    }
    const readCursor = meta.linearReadCursor ?? ZERO_CURSOR;
    const limit = Math.min(LINEAR_PAGE_MAX, Math.max(1, options.limit ?? LINEAR_PAGE_DEFAULT));
    const external = this.readEvents(this.linearInboxConversationId()).filter(
      (event): event is OperatorConversationStreamEvent & { type: "message" } =>
        event.type === "message" &&
        event.role === "external" &&
        (id === LINEAR_INBOX_CONVERSATION_ID || this.linearAdmission(event).conversationId === id),
    );
    const unreadCount = external.filter((event) => event.cursor > readCursor).length;
    const before = options.before;
    const candidates =
      before === undefined
        ? external.filter((event) => event.cursor > readCursor)
        : external.filter((event) => event.cursor < before).slice(-limit);
    const window = candidates.slice(0, limit);
    const items: unknown[] = [];
    let bytes = 0;
    for (const event of window) {
      const item =
        options.headlines === true
          ? { cursor: event.cursor, occurredAt: event.occurredAt, headline: headlineOf(event.text) }
          : event;
      const size = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
      if (bytes + size > LINEAR_PAGE_BYTES) break;
      items.push(item);
      bytes += size;
    }
    if (items.length === 0 && window.length > 0) {
      throw new Error(
        "Linear event exceeds the inbox output budget; it remains unread. Read its conversation history.",
      );
    }
    const shown = window.slice(0, items.length);
    const newestUnreadShown = shown.filter((event) => event.cursor > readCursor).at(-1)?.cursor;
    if (newestUnreadShown !== undefined && newestUnreadShown > (meta.linearOfferedCursor ?? ZERO_CURSOR)) {
      meta.linearOfferedCursor = newestUnreadShown;
      this.saveMeta(meta);
    }
    const offered = meta.linearOfferedCursor ?? ZERO_CURSOR;
    const ackCursor = offered > readCursor ? offered : null;
    const oldestCursor = shown[0]?.cursor ?? null;
    const hasMore =
      before === undefined
        ? candidates.length > items.length
        : oldestCursor !== null && external.some((event) => event.cursor < oldestCursor);
    return {
      items,
      unreadCount,
      hasMore,
      oldestCursor,
      ackCursor,
      next:
        ackCursor === null
          ? null
          : `After reviewing every item, run: clankie linear inbox ack ${ackCursor}${id === LINEAR_INBOX_CONVERSATION_ID ? "" : ` --conversation ${id}`}`,
    };
  }

  public acknowledgeLinearInbox(cursor: string, conversationId = this.linearInboxConversationId()): boolean {
    const meta = this.metas.get(conversationId);
    if (!meta) return false;
    if (
      !/^\d{12}$/u.test(cursor) ||
      meta.linearAckVersion !== 1 ||
      cursor > (meta.linearOfferedCursor ?? ZERO_CURSOR)
    )
      return false;
    if (cursor <= (meta.linearReadCursor ?? ZERO_CURSOR)) return true;
    if (
      !this.readEvents(this.linearInboxConversationId()).some(
        (event) =>
          event.cursor === cursor &&
          event.type === "message" &&
          event.role === "external" &&
          (conversationId === LINEAR_INBOX_CONVERSATION_ID ||
            this.linearAdmission(event).conversationId === conversationId),
      )
    )
      return false;
    meta.linearReadCursor = cursor;
    this.saveMeta(meta);
    return true;
  }

  public conversationIdForSeat(seatId: string): string | undefined {
    return [...this.metas.values()].find((meta) => meta.scope.kind === "seat" && meta.scope.seatId === seatId)
      ?.conversationId;
  }

  private metaForPersona(personaId: string): ConversationMeta | undefined {
    return [...this.metas.values()].find(
      (meta) => meta.scope.kind === "persona" && meta.scope.personaId === personaId,
    );
  }

  public conversationIdForPersona(personaId: string): string | undefined {
    return this.metaForPersona(personaId)?.conversationId;
  }

  /**
   * The persona's durable thread, for surfaces that order an inbox by what
   * happened last. `updatedAt` is the whole record's last activity — an
   * operator turn, a run settling, or a folded seat transcript all move it —
   * so it says when this thread last had something to show.
   */
  public conversationForPersona(personaId: string): OperatorConversation | undefined {
    const meta = this.metaForPersona(personaId);
    return meta === undefined ? undefined : publicConversation(meta);
  }

  public renamePersona(personaId: string, title: string): void {
    const conversationId = this.conversationIdForPersona(personaId);
    const meta = conversationId === undefined ? undefined : this.metas.get(conversationId);
    if (meta === undefined || meta.title === title) return;
    meta.title = title;
    meta.updatedAt = new Date().toISOString();
    this.saveMeta(meta);
  }

  /**
   * Bind a durable character to its current seat and carry any legacy seat DM
   * and channel membership forward without copying or splitting transcripts.
   */
  public bindPersona(personaId: string, seatId: string, title: string): string {
    const current = this.conversationIdForPersona(personaId);
    if (current !== undefined) this.renamePersona(personaId, title);
    const legacy =
      current === undefined
        ? [...this.metas.values()].find((meta) => meta.scope.kind === "seat" && meta.scope.seatId === seatId)
        : undefined;
    if (legacy !== undefined && current === undefined) {
      legacy.scope = { kind: "persona", personaId };
      legacy.title = title;
      legacy.updatedAt = new Date().toISOString();
      this.saveMeta(legacy);
    }
    for (const channel of this.metas.values()) {
      if (channel.scope.kind !== "channel" || channel.channelMembers === undefined) continue;
      let changed = false;
      channel.channelMembers = channel.channelMembers.map((member) => {
        const raw = member as OperatorChannelMember & { readonly seatId?: string };
        if (raw.seatId !== seatId) return member;
        changed = true;
        return { personaId, position: member.position, joinedAt: member.joinedAt };
      });
      if (changed) this.saveMeta(channel);
    }
    return (
      current ?? legacy?.conversationId ?? this.create({ kind: "persona", personaId }, title).conversationId
    );
  }

  public seatIds(): readonly string[] {
    return [...this.metas.values()].flatMap((meta) =>
      meta.scope.kind === "seat" ? [meta.scope.seatId] : [],
    );
  }

  public publishPersonaEvent(personaId: string, seatId: string, body: OperatorConversationEventBody): void {
    // Before the seat's own thread, and regardless of whether it has one: a
    // channel round offered this seat a turn and is waiting on exactly this.
    if (body.type === "message" && body.role === "agent") this.resolveSeatReply(seatId, body.text);
    const conversationId = this.conversationIdForPersona(personaId);
    this.publishConversationEvent(conversationId, body);
  }

  /** Legacy test/API path while persisted seat scopes migrate on discovery. */
  public publishSeatEvent(seatId: string, body: OperatorConversationEventBody): void {
    if (body.type === "message" && body.role === "agent") this.resolveSeatReply(seatId, body.text);
    this.publishConversationEvent(this.conversationIdForSeat(seatId), body);
  }

  /** Peer exchanges are visible context, never inbound owner turns or seat replies. */
  public publishFleetPeerExchange(text: string): void {
    this.publishConversationEvent(this.defaultGlobalConversationId(), {
      type: "message",
      role: "agent",
      text,
      streaming: false,
    });
  }

  private publishConversationEvent(
    conversationId: string | undefined,
    body: OperatorConversationEventBody,
  ): void {
    const meta = conversationId === undefined ? undefined : this.metas.get(conversationId);
    if (meta === undefined) return;
    const events = this.readEvents(meta.conversationId);
    if (body.type === "activity") {
      const previous = events.findLast((event) => event.type === "activity");
      if (previous?.type === "activity" && previous.phase === body.phase) return;
    }
    if (body.type === "message" && body.role === "agent") {
      const previous = events.findLast((event) => event.type === "message" && event.role === "agent");
      if (previous?.type === "message" && previous.role === "agent" && previous.text === body.text) return;
    }
    this.append(meta, body);
    meta.updatedAt = new Date().toISOString();
    this.saveMeta(meta);
  }

  public nativeAnnotations(conversationId: string): readonly OperatorConversationStreamEvent[] {
    return this.readEvents(conversationId).filter(
      (event) => event.type === "reaction" || event.type === "file",
    );
  }

  public reactToNativeEntry(
    conversationId: string,
    entryRef: string,
    emoji: string,
    remove: boolean,
  ): boolean {
    const meta = this.metas.get(conversationId);
    if (meta === undefined) return false;
    this.append(meta, { type: "reaction", entryRef, emoji, reactor: { kind: "operator" }, removed: remove });
    meta.updatedAt = new Date().toISOString();
    this.saveMeta(meta);
    return true;
  }

  public nativeSource(conversationId: string): HerdrAgentSnapshot | undefined {
    return this.metas.get(conversationId)?.nativeSource;
  }

  /** Reuse the current persona thread after legacy seat-scope migration. */
  public nativeConversationForSeat(source: HerdrAgentSnapshot): OperatorConversation | undefined {
    const matches = [...this.metas.values()].filter((meta) => {
      if (meta.scope.kind === "seat") return meta.scope.seatId === source.terminalId;
      if (meta.scope.kind !== "persona") return false;
      if (this.seatForPersona?.(meta.scope.personaId) === source.terminalId) return true;
      const native = meta.nativeSource;
      return (
        native?.paneId === source.paneId &&
        native.terminalId === source.terminalId &&
        JSON.stringify(native.session) === JSON.stringify(source.session)
      );
    });
    if (matches.length > 1) throw new Error("Native lead has ambiguous existing conversation threads");
    return matches[0] === undefined ? undefined : publicConversation(matches[0]);
  }

  /** Existing authenticated transcript attachment, never a pane/title guess. */
  public attachedConversationForNative(source: HerdrAgentSnapshot): string | undefined {
    if (!source.session) return undefined;
    const sessionId =
      source.session.kind === "id"
        ? source.session.value
        : source.session.value
            .split(/[\\/]/u)
            .at(-1)
            ?.replace(/\.jsonl$/u, "");
    const matches = [...this.metas.values()].filter((meta) => {
      if (meta.scope.kind !== "global" && meta.scope.kind !== "workspace" && meta.scope.kind !== "room")
        return false;
      const native = meta.nativeSource;
      if (
        native &&
        (native.paneId !== source.paneId ||
          native.terminalId !== source.terminalId ||
          JSON.stringify(native.session) !== JSON.stringify(source.session))
      )
        return false;
      return (
        native !== undefined ||
        (sessionId !== undefined && meta.nativeSeatSessions?.[sessionId] === "current")
      );
    });
    if (matches.length > 1) throw new Error("Native parent has ambiguous conversation attachment");
    return matches[0]?.conversationId;
  }

  public rememberNativeSource(conversationId: string, source: HerdrAgentSnapshot): void {
    const meta = this.metas.get(conversationId);
    if (meta === undefined || JSON.stringify(meta.nativeSource) === JSON.stringify(source)) return;
    this.cancelPendingQuestion(conversationId, "native_seat_takeover");
    meta.nativeSource = source;
    this.saveMeta(meta);
  }

  /**
   * Reserve attachment before awaiting any service work. Polling itself remains
   * the existing mailbox's proof of liveness; a remembered transcript alone is
   * never a driver. A service invocation admitted before this reservation owns
   * its turn through settlement, so its answer cannot race an attached seat.
   */
  public async pollConversationDriver<T>(
    conversationId: string,
    poll: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.metas.has(conversationId)) throw new Error(`Unknown conversation ${conversationId}`);
    let ready!: () => void;
    const admission = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const admissions = this.driverAdmissions.get(conversationId) ?? new Set<Promise<void>>();
    admissions.add(admission);
    this.driverAdmissions.set(conversationId, admissions);
    // Capture only work already admitted. Later work waits on this reservation.
    const service = [...(this.serviceDrives.get(conversationId) ?? [])];
    let started: Promise<T>;
    try {
      const ready = Promise.all(service);
      if (signal === undefined) await ready;
      else await waitForConversationRun(ready, signal);
      signal?.throwIfAborted();
      if (!this.metas.has(conversationId)) throw new Error(`Unknown conversation ${conversationId}`);
      // The callback establishes mailbox binding synchronously, before the
      // reservation is released. Never await the parked long poll here.
      started = poll();
    } finally {
      admissions.delete(admission);
      if (admissions.size === 0 && this.driverAdmissions.get(conversationId) === admissions)
        this.driverAdmissions.delete(conversationId);
      ready();
    }
    return started;
  }

  /**
   * Choose the live execution driver at admission, then pin its exact dispatch.
   * Only a definite pre-delivery refusal may choose again. The selection and
   * service reservation have no await between them, closing the attach race.
   * Both stored operator runs and Discord's existing room turns use this fence.
   */
  public async runWithConversationDriver<T>(
    conversationId: string,
    driver: () => ConversationDriver<T> | undefined,
    service: (run: ConversationServiceRun) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    for (;;) {
      for (;;) {
        const admissions = this.driverAdmissions.get(conversationId);
        if (admissions === undefined || admissions.size === 0) break;
        const ready = Promise.all(admissions);
        if (signal === undefined) await ready;
        else await waitForConversationRun(ready, signal);
      }
      signal?.throwIfAborted();
      if (!this.metas.has(conversationId)) throw new Error(`Unknown conversation ${conversationId}`);
      const selected = driver();
      if (selected !== undefined) {
        const delivery = await selected.run();
        if (delivery.handled) return delivery.result;
        // A replacement may have attached while the old mailbox refused.
        // Recheck its admission and current liveness before starting service.
        continue;
      }
      let settled!: () => void;
      const invocation = new Promise<void>((resolve) => {
        settled = resolve;
      });
      const serviceRuns = this.serviceDrives.get(conversationId) ?? new Set<Promise<void>>();
      serviceRuns.add(invocation);
      this.serviceDrives.set(conversationId, serviceRuns);
      const run = new ConversationServiceRun(signal);
      try {
        return await waitForConversationRun(service(run), run.signal);
      } finally {
        run.close();
        serviceRuns.delete(invocation);
        if (serviceRuns.size === 0 && this.serviceDrives.get(conversationId) === serviceRuns)
          this.serviceDrives.delete(conversationId);
        settled();
      }
    }
  }

  /** One inspectable conversation per room, irrespective of its execution authority. */
  public roomConversation(lane: "discord_presence" | "discord_voice", targetId: string): string {
    const id = `room-${createHash("sha256").update(`${lane}:${targetId}`).digest("hex").slice(0, 24)}`;
    if (!this.metas.has(id)) {
      this.create(
        { kind: "room", lane, targetId },
        `Discord ${lane === "discord_voice" ? "voice" : "text"} · ${targetId}`,
        id,
      );
    }
    return id;
  }

  /** Host-observed Discord names affect discovery only, never room authority. */
  public nameRoomConversation(conversationId: string, title: string): void {
    const meta = this.metas.get(conversationId);
    if (meta?.scope.kind !== "room") throw new Error("Expected a room conversation");
    const name = title.trim();
    if (!name || name.includes("\0") || name.length > 200) throw new Error("Invalid room title");
    if (meta.title === name) return;
    meta.title = name;
    meta.updatedAt = new Date().toISOString();
    this.saveMeta(meta);
  }

  public syncRoomTranscript(conversationId: string, transcript: HerdrSeatTranscript): void {
    if (this.metas.get(conversationId)?.scope.kind !== "room")
      throw new Error("Expected a room conversation");
    this.syncConversationTranscript(conversationId, conversationId, transcript, "captain");
  }

  public publishRoomEvent(conversationId: string, body: OperatorConversationEventBody): void {
    const meta = this.metas.get(conversationId);
    if (meta?.scope.kind !== "room") throw new Error("Expected a room conversation");
    if (body.type === "turn") {
      const count = Math.max(
        0,
        (this.runCounts.get(conversationId) ?? 0) + (body.phase === "accepted" ? 1 : -1),
      );
      this.runCounts.set(conversationId, count);
      meta.sessionState = count > 0 ? "active" : body.phase === "failed" ? "failed" : "waiting";
    }
    meta.updatedAt = new Date().toISOString();
    this.append(meta, body);
    this.saveMeta(meta);
  }

  /**
   * The seat's head is the default global conversation, the thread the app
   * pins as Clankie (ADR 0152). A seated harness's transcript folds into it
   * as his own words — `captain`, not `agent` — and always appends: this
   * thread already holds his pi turns, so nothing here replaces them.
   */
  public syncHeadTranscript(
    seatId: string,
    transcript: HerdrSeatTranscript,
    workingDirectory?: string,
  ): void {
    this.syncConversationTranscript(
      this.defaultGlobalConversationId(),
      seatId,
      transcript,
      "captain",
      workingDirectory,
    );
  }

  public syncNativeSeatTranscript(
    conversationId: string,
    sessionId: string,
    entries: HerdrSeatTranscript["entries"],
    activity?: "responding" | "waiting",
  ): boolean {
    const meta = this.metas.get(conversationId);
    if (
      !meta ||
      (meta.scope.kind !== "global" && meta.scope.kind !== "workspace" && meta.scope.kind !== "room")
    )
      return false;
    for (const candidate of this.metas.values()) {
      if (
        candidate.conversationId !== conversationId &&
        candidate.nativeSeatSessions?.[sessionId] !== undefined
      )
        return false;
    }
    if (meta.nativeSeatSessions?.[sessionId] === "retired") return false;
    if (meta.nativeSeatSessions?.[sessionId] === undefined) {
      (meta.nativeSeatSessions ??= {})[sessionId] = "current";
      this.saveMeta(meta);
    }
    this.syncConversationTranscript(
      conversationId,
      `native:${sessionId}`,
      { sessionKey: `${sessionId.startsWith("ses_") ? "opencode" : "claude"}:${sessionId}`, entries },
      "captain",
    );
    // Native hooks provide display activity even without a Herdr presence feed.
    // This does not finish or change ownership of a service-managed run.
    if (activity !== undefined)
      this.publishConversationEvent(conversationId, { type: "activity", phase: activity });
    return true;
  }

  public publishHeadEvent(body: OperatorConversationEventBody): void {
    this.publishConversationEvent(this.defaultGlobalConversationId(), body);
  }

  /** Legacy test/API path while persisted seat scopes migrate on discovery. */
  public syncSeatTranscript(seatId: string, transcript: HerdrSeatTranscript): void {
    this.syncConversationTranscript(this.conversationIdForSeat(seatId), seatId, transcript);
  }

  private syncConversationTranscript(
    conversationId: string | undefined,
    seatId: string,
    transcript: HerdrSeatTranscript,
    agentRole: "agent" | "captain" = "agent",
    workingDirectory?: string,
  ): void {
    const meta = conversationId === undefined ? undefined : this.metas.get(conversationId);
    if (meta === undefined || transcript.entries.length === 0) return;
    transcript = {
      ...transcript,
      entries: transcript.entries.filter((entry) => entry.type !== "message" || !entry.internal),
    };
    const room = meta.scope.kind === "room";
    const checkpoint = room ? meta.roomTranscripts?.[transcript.sessionKey] : meta.seatTranscript;
    // A persona thread seeded before native transcripts existed is rebuilt
    // from the transcript once; the head thread is his own history and only
    // ever grows.
    if (
      agentRole === "agent" &&
      checkpoint === undefined &&
      this.retainedEventCount(meta.conversationId) > 0
    ) {
      this.replaceSeatEntries(meta, transcript.entries);
      meta.seatTranscript = {
        sessionKey: transcript.sessionKey,
        entryIds: transcript.entries.flatMap((entry) =>
          entry.type === "viewed_image" && isDeliveredImagePath(entry.path) ? [] : [entry.id],
        ),
      };
      this.saveMeta(meta);
      this.publishTranscriptImages(meta, transcript, workingDirectory);
      return;
    }

    // ponytail: legacy checkpoints append their newly typed historical tools once;
    // add a cursor/reaction-remapping migration only if pre-upgrade ordering matters.
    const checkpointIds = checkpoint?.entryIds ?? checkpoint?.messageIds ?? [];
    // Native IDs are unique across sessions. Captain history keeps their IDs when
    // a seat resumes or both the native hook and Herdr observe the same record.
    const captainThread = meta.scope.kind === "global" || meta.scope.kind === "workspace";
    const seen = new Set(
      captainThread || checkpoint?.sessionKey === transcript.sessionKey ? checkpointIds : [],
    );
    let latestAgentReply: string | undefined;
    const added: HerdrTranscriptEntry[] = [];
    // A tailing seat re-publishes the same transcript while it works; without
    // this the checkpoint would be rewritten to disk on every quiet pass.
    let advanced = false;
    for (const entry of transcript.entries) {
      if (seen.has(entry.id)) continue;
      if (entry.type === "viewed_image") {
        if (!isDeliveredImagePath(entry.path)) {
          advanced = true;
          seen.add(entry.id);
          continue;
        }
        if (workingDirectory === undefined) continue;
        if (this.pendingTranscriptImages.has(transcriptImageKey(meta, transcript.sessionKey, entry.id))) {
          continue;
        }
      }
      advanced = true;
      added.push(entry);
      if (entry.type === "message" && entry.role === "agent") {
        latestAgentReply = entry.text;
      }
      if (entry.type === "viewed_image") {
        continue;
      }
      if (entry.type !== "message" || entry.role !== "operator" || !this.matchesRecentSeatSend(meta, entry)) {
        const body = transcriptEventBody(entry, agentRole);
        this.append(
          meta,
          room && body.type === "message" && body.role === "operator" ? { ...body, role: "external" } : body,
          entry.occurredAt,
        );
      }
      seen.add(entry.id);
    }
    if (!advanced) return;
    this.resettle(meta);
    const nextCheckpoint = { sessionKey: transcript.sessionKey, entryIds: [...seen] };
    if (room) (meta.roomTranscripts ??= {})[transcript.sessionKey] = nextCheckpoint;
    else meta.seatTranscript = nextCheckpoint;
    meta.updatedAt = room ? (added.at(-1)?.occurredAt ?? meta.updatedAt) : new Date().toISOString();
    this.saveMeta(meta);
    this.publishTranscriptImages(
      meta,
      { sessionKey: transcript.sessionKey, entries: added },
      workingDirectory,
    );
    if (latestAgentReply !== undefined) this.resolveSeatReply(seatId, latestAgentReply);
  }

  /**
   * A seat's `waiting` is written when its pane's status changes, and a surface
   * reads everything after it as a turn still in progress. A harness flushes
   * entries after its pane has settled, and a named image lands later still, so
   * a thread that was settled before them is settled again behind them. While
   * the seat works its last activity is `responding`, and this does nothing.
   */
  private resettle(meta: ConversationMeta): void {
    const events = this.readEvents(meta.conversationId);
    const settled = events.findLastIndex((event) => event.type === "activity");
    if (settled === events.length - 1) return;
    const last = events[settled];
    if (last?.type === "activity" && last.phase === "waiting") {
      this.append(meta, { type: "activity", phase: "waiting" });
    }
  }

  /**
   * A path on the Mac shows the phone nothing (ADR 0174), so an image a seat
   * names in its reply follows the message as a delivered file. The seat's
   * working directory is the containment root; anything the store refuses — a
   * path that is not a file, escapes the directory, or is too large — stays
   * prose. Transcript folds never fence operator sends, so no revision moves.
   */
  private publishTranscriptImages(
    meta: ConversationMeta,
    transcript: HerdrSeatTranscript,
    workingDirectory: string | undefined,
  ): void {
    if (workingDirectory === undefined) return;
    for (const entry of transcript.entries) {
      if (entry.type === "viewed_image") {
        if (!isDeliveredImagePath(entry.path)) continue;
        const key = transcriptImageKey(meta, transcript.sessionKey, entry.id);
        if (this.pendingTranscriptImages.has(key)) continue;
        this.pendingTranscriptImages.add(key);
        const attempts = (this.transcriptImageAttempts.get(key) ?? 0) + 1;
        this.transcriptImageAttempts.set(key, attempts);
        void this.queueDeliveredImages(meta, [entry.path], workingDirectory).then((published) => {
          this.pendingTranscriptImages.delete(key);
          if (published || attempts >= 2) {
            this.transcriptImageAttempts.delete(key);
            this.completeTranscriptImage(meta, transcript.sessionKey, entry.id);
          }
        });
      } else if (entry.type === "message" && entry.role === "agent") {
        this.publishNamedImages(meta, entry.text, workingDirectory);
      }
    }
  }

  private publishNamedImages(meta: ConversationMeta, text: string, workingDirectory: string): void {
    // ponytail: four per message, the visual cap a Discord turn uses; raise it if seats show more at once.
    void this.queueDeliveredImages(meta, namedImagePaths(text).slice(0, 4), workingDirectory);
  }

  private queueDeliveredImages(
    meta: ConversationMeta,
    paths: readonly string[],
    workingDirectory: string,
  ): Promise<boolean> {
    if (this.publishDeliveredFile === undefined || paths.length === 0) return Promise.resolve(false);
    const conversationId = meta.conversationId;
    const previous = this.deliveredFilePublishes.get(conversationId) ?? Promise.resolve();
    const result = previous.then(() => this.publishImages(meta, paths, workingDirectory));
    const queued = result.then(() => undefined);
    this.deliveredFilePublishes.set(conversationId, queued);
    void queued.finally(() => {
      if (this.deliveredFilePublishes.get(conversationId) === queued) {
        this.deliveredFilePublishes.delete(conversationId);
      }
    });
    return result;
  }

  private async publishImages(
    meta: ConversationMeta,
    paths: readonly string[],
    workingDirectory: string,
  ): Promise<boolean> {
    let published = false;
    for (const path of paths) {
      try {
        const { artifactId, filename, mediaType, byteCount, sha256 } = await this.publishDeliveredFile!({
          conversationId: meta.conversationId,
          sourceRoot: workingDirectory,
          path,
        });
        if (!this.metas.has(meta.conversationId)) return published;
        const shown = this.readEvents(meta.conversationId).some(
          (event) => event.type === "file" && event.file.artifactId === artifactId,
        );
        if (shown) {
          published = true;
          continue;
        }
        this.append(meta, { type: "file", file: { artifactId, filename, mediaType, byteCount, sha256 } });
        this.resettle(meta);
        published = true;
      } catch {
        // Named, but not deliverable from here.
      }
    }
    return published;
  }

  private completeTranscriptImage(meta: ConversationMeta, sessionKey: string, entryId: string): void {
    if (this.metas.get(meta.conversationId) !== meta || meta.seatTranscript?.sessionKey !== sessionKey) {
      return;
    }
    const entryIds = meta.seatTranscript.entryIds ?? meta.seatTranscript.messageIds ?? [];
    if (entryIds.includes(entryId)) return;
    meta.seatTranscript = { sessionKey, entryIds: [...entryIds, entryId] };
    this.saveMeta(meta);
  }

  /** Queue a host-authored continuation without forging an operator message. */
  public submitInternal(
    conversationId: string,
    message: string,
    origin: NonNullable<ConversationTurnContext["origin"]>,
  ): SubmitOperatorConversationTurnResult {
    const meta = this.metas.get(conversationId);
    if (meta === undefined) throw new Error(`Unknown conversation ${conversationId}`);
    if (!this.runsCaptainTurns(conversationId)) {
      throw new Error(`Conversation ${conversationId} does not run captain turns`);
    }
    return this.enqueue(meta, message, undefined, false, this.runner, { origin });
  }

  /** Read actual on-disk acceptance, never an in-memory success guess. */
  public inboundAcceptance(id: string): InboundAcceptance | undefined {
    let receipt: InboundAcceptance | undefined;
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const raw = JSON.parse(readFileSync(join(this.root, entry.name, "meta.json"), "utf8"));
      const entries = z.record(z.string(), InboundAcceptanceSchema).parse(raw.inboundAcceptances ?? {});
      const candidate = entries[id];
      if (candidate === undefined) continue;
      if (candidate.deliveryId !== id) throw new Error("Mismatched acceptance ID");
      if (receipt !== undefined) throw new Error("Inbound delivery accepted by multiple conversations");
      receipt = candidate;
    }
    return receipt;
  }

  public submitInbound(
    message: string,
    receipt: Omit<InboundAcceptance, "message" | "runId" | "acceptedCursor">,
    /** The service resolves this target; inbound worker content cannot select it. */
    conversationId = "global-default",
    /** Host-selected room/native runner; clients cannot select execution authority. */
    admittedRunner?: ConversationRunner,
  ): SubmitOperatorConversationTurnResult {
    const meta = this.metas.get(conversationId);
    if (!meta) throw new Error(`Unknown conversation ${conversationId}`);
    const native = meta.scope.kind === "seat" || meta.scope.kind === "persona";
    const runner = meta.scope.kind === "room" || native ? admittedRunner : this.runner;
    if (
      runner === undefined ||
      (!this.runsCaptainTurns(conversationId) && meta.scope.kind !== "room" && !native)
    )
      throw new ConversationRefusedError("This conversation cannot accept inbound worker messages.");
    return this.enqueue(meta, message, undefined, false, runner, {
      origin: "message",
      inboundReceipt: receipt,
    });
  }

  public async close(): Promise<void> {
    await Promise.allSettled([
      ...this.runs.values(),
      ...this.seatSends.values(),
      ...this.deliveredFilePublishes.values(),
    ]);
  }

  private create(
    scope: OperatorConversationScope,
    title: string,
    conversationId: string = `conv-${randomUUID()}`,
  ): ConversationMeta {
    if (scope.kind === "persona") {
      const existing = this.conversationIdForPersona(scope.personaId);
      if (existing !== undefined) return this.metas.get(existing)!;
    }
    if (scope.kind === "seat") {
      const existing = this.conversationIdForSeat(scope.seatId);
      if (existing !== undefined) return this.metas.get(existing)!;
    }
    if (scope.kind === "channel") {
      const existing = this.channelMeta(scope.channelId);
      if (existing !== undefined) return existing;
    }
    const workspace = workspaceOf(scope);
    if (workspace !== undefined && !statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Workspace ${workspace} is not a directory on this machine`);
    }
    const now = new Date().toISOString();
    const meta: ConversationMeta = {
      conversationId,
      scope,
      title,
      // The boot-seeded global conversation owns default; created ones never do.
      isDefault: false,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      sessionState: "unbound",
    };
    mkdirSync(join(this.root, meta.conversationId), { recursive: true });
    this.metas.set(meta.conversationId, meta);
    this.saveMeta(meta);
    this.prune(meta.conversationId);
    return meta;
  }

  /**
   * Create a channel, or restate an existing one's title and roster (ADR 0146).
   * Membership arrives as the whole list the operator wants, in turn order, so
   * a join, a leave, and a reorder are the same write; a member already in the
   * room keeps the `joinedAt` it had.
   */
  private async upsertChannel(request: UpsertOperatorChannel): Promise<ConversationMeta> {
    const personaIds = [...new Set(request.members)];
    if (personaIds.length > OPERATOR_CHANNEL_MEMBER_MAX) {
      throw new Error(`A channel holds at most ${OPERATOR_CHANNEL_MEMBER_MAX} members`);
    }
    const channelId = request.channelId ?? `channel-${randomUUID()}`;
    // Everything that can fail happens before a single byte of local state
    // moves. A projection that cannot be reached must not leave behind a room
    // the operator never got, nor a half-applied roster on one they already had.
    const discord =
      request.discord === undefined || request.discord.kind === "off"
        ? undefined
        : await this.resolveProjection(request.discord, channelId, request.title);
    const meta = this.create({ kind: "channel", channelId }, request.title);
    const previous = new Map(
      (meta.channelMembers ?? []).map((member) => [channelMemberPersonaId(member), member]),
    );
    const now = new Date().toISOString();
    meta.title = request.title;
    meta.channelMembers = personaIds.map((personaId, position) => ({
      personaId,
      position,
      joinedAt: previous.get(personaId)?.joinedAt ?? now,
    }));
    if (request.discord?.kind === "off") {
      this.discardProjection(meta.channelDiscord);
      delete meta.channelDiscord;
    } else if (discord !== undefined) {
      // Re-projecting elsewhere retires the old credential the same way
      // unprojecting does; nothing keeps posting through a webhook no room uses.
      if (meta.channelDiscord?.webhookId !== discord.webhookId) {
        this.discardProjection(meta.channelDiscord);
      }
      meta.channelDiscord = discord;
    }
    meta.updatedAt = now;
    this.saveMeta(meta);
    // A member is someone the operator can also reach on their own.
    for (const personaId of personaIds) this.create({ kind: "persona", personaId }, personaId);
    return meta;
  }

  /**
   * Settle where a room is going in Discord without touching anything local
   * (ADR 0146), so a refusal here costs the operator nothing but the message.
   *
   * One Clankie room per message-bearing Discord location is an invariant, not
   * a preference: inbound guild text is routed by its channel id, which is the
   * direct channel or the forum post's thread. A second room bound to the same
   * location would silently steal or split delivery. Existing locations are
   * checked before provisioning creates anything, and every result is checked
   * again. Forum parents are containers and may hold several distinct posts.
   */
  private async resolveProjection(
    choice: Exclude<NonNullable<UpsertOperatorChannel["discord"]>, { kind: "off" }>,
    channelId: string,
    title: string,
  ): Promise<NonNullable<ConversationMeta["channelDiscord"]>> {
    if (this.projection === undefined) throw new Error("Discord projection is unavailable here");
    // Required before either path resolves, never merely compared against when
    // it happens to be set: an unset swarm home is not "no opinion", it is no
    // server Clankie controls, and the fleet may not be put anywhere at all.
    const swarmGuildId = this.projection.swarmGuildId?.();
    if (swarmGuildId === undefined) {
      throw new Error("Clankie has no swarm server set, so a room cannot go to Discord.");
    }
    if (choice.kind === "webhook") {
      const credential = parseDiscordWebhookUrl(choice.webhookUrl);
      // Resolved before anything is saved: a webhook that cannot be reached is
      // a projection that would silently never post.
      const resolved = { ...(await this.projection.resolve(credential)), ...credential };
      // A pasted URL is otherwise the back door around the swarm fence: a
      // webhook from a guild Clankie merely inhabits would put his agents in a
      // server he does not control, without any grant being involved.
      if (resolved.guildId !== swarmGuildId) {
        throw new Error("That webhook is not in Clankie’s swarm server.");
      }
      const resolvedRoom = (await this.projection.rooms?.())?.find(
        (room) => room.channelId === resolved.channelId,
      );
      if (resolvedRoom?.kind === "forum") {
        throw new Error("A forum webhook does not identify a post; choose the forum from Clankie’s server.");
      }
      this.assertRoomUnclaimed(resolved.channelId, channelId);
      return resolved;
    }
    if (this.projection.provision === undefined) {
      throw new Error("Clankie cannot make Discord channels here; paste one from your swarm server instead");
    }
    // Checked first for a named room: provisioning makes a webhook in Discord,
    // and a refusal afterwards would leave one behind that nothing posts to.
    if (choice.room?.kind === "channel") this.assertRoomUnclaimed(choice.room.channelId, channelId);
    const provisioned = await this.projection.provision({
      name: title,
      ...(choice.room === undefined ? {} : { room: choice.room }),
    });
    // Held to the same fence as a paste. The trusted module answers for the
    // swarm home, but a room is only a room here if it landed in the guild this
    // side was told about — a disagreement is a refusal, not a projection.
    if (provisioned.guildId !== swarmGuildId) {
      throw new Error("That Discord room is not in Clankie’s swarm server.");
    }
    if (choice.room?.kind === "forum" && provisioned.threadId === undefined) {
      throw new Error("Discord did not create a post in that forum.");
    }
    this.assertRoomUnclaimed(provisioned.threadId ?? provisioned.channelId, channelId);
    return { ...provisioned, provisioned: true };
  }

  /** Refuses a Discord channel or forum post another Clankie room already uses. */
  private assertRoomUnclaimed(discordRoomId: string, exceptChannelId: string): void {
    const claimed = [...this.metas.values()].find(
      (meta) =>
        (meta.channelDiscord?.threadId ?? meta.channelDiscord?.channelId) === discordRoomId &&
        !(meta.scope.kind === "channel" && meta.scope.channelId === exceptChannelId),
    );
    if (claimed !== undefined) {
      // Ends in a full stop deliberately: the operator surface shows a host
      // message verbatim only when it reads as a finished sentence, and the
      // generic fallback here would blame permissions for a naming conflict.
      throw new Error(`That Discord room already holds “${claimed.title}”.`);
    }
  }

  /**
   * A room's projection, but only while it still points inside the swarm home.
   * Records outlive the setting that admitted them: a guild dropped as the
   * swarm home, or one projected before this fence existed, must stop routing
   * and stop posting immediately rather than at the next edit. No swarm home
   * set means no projection is live at all.
   */
  private liveProjection(meta: ConversationMeta): ConversationMeta["channelDiscord"] {
    const swarmGuildId = this.projection?.swarmGuildId?.();
    return swarmGuildId !== undefined && meta.channelDiscord?.guildId === swarmGuildId
      ? meta.channelDiscord
      : undefined;
  }

  private channelMeta(channelId: string): ConversationMeta | undefined {
    return [...this.metas.values()].find(
      (meta) => meta.scope.kind === "channel" && meta.scope.channelId === channelId,
    );
  }

  /**
   * Put a reaction on one entry, or take it back off (ADR 0146). The entry is
   * never rewritten: the reaction is its own append-only event, and the set
   * standing on an entry is the fold of those.
   */
  private react(
    conversationId: string,
    entryRef: string,
    emoji: string,
    reactor: OperatorConversationReactor,
    remove: boolean,
  ): boolean {
    const meta = this.metas.get(conversationId);
    if (meta === undefined) return false;
    if (!this.readEvents(conversationId).some((event) => event.cursor === entryRef)) return false;
    this.append(meta, { type: "reaction", entryRef, emoji, reactor, removed: remove });
    meta.updatedAt = new Date().toISOString();
    this.saveMeta(meta);
    return true;
  }

  private async fork(parentConversationId: string): Promise<OperatorConversation> {
    const parent = this.metas.get(parentConversationId);
    if (parent === undefined) throw new Error(`Unknown conversation ${parentConversationId}`);
    if (!this.runsCaptainTurns(parentConversationId)) {
      throw new Error("Only Clankie's own conversations can be forked");
    }
    if (parent.parentConversationId !== undefined) throw new Error("A side conversation is already open");
    if ([...this.metas.values()].some((meta) => meta.parentConversationId === parentConversationId)) {
      throw new Error("A side conversation is already open");
    }
    if (this.forkConversation === undefined) throw new Error("Side conversations are unavailable");

    const now = new Date().toISOString();
    const meta: ConversationMeta = {
      conversationId: `conv-${randomUUID()}`,
      scope: parent.scope,
      title: "BTW",
      isDefault: false,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      sessionState: "waiting",
      parentConversationId,
      ...(parent.contextUsage === undefined ? {} : { contextUsage: parent.contextUsage }),
    };
    mkdirSync(join(this.root, meta.conversationId), { recursive: true });
    this.metas.set(meta.conversationId, meta);
    this.saveMeta(meta);
    try {
      const workspace = workspaceOf(parent.scope);
      await this.forkConversation({
        parentConversationId,
        conversationId: meta.conversationId,
        ...(workspace === undefined ? {} : { workspace }),
      });
    } catch (error) {
      this.remove(meta);
      throw error;
    }
    this.prune(meta.conversationId);
    return publicConversation(meta);
  }

  private replay(request: ReplayOperatorConversationRequest): ReplayOperatorConversationResult {
    const meta = this.metas.get(request.conversationId);
    if (meta === undefined) {
      return {
        schemaVersion: 1,
        status: "recover",
        conversationId: request.conversationId,
        code: "unknown_conversation",
        recoverable: false,
        resetCursor: ZERO_CURSOR,
        message: "No conversation with that id exists here.",
      };
    }
    const events = this.readEvents(meta.conversationId);
    const retainedFromCursor = meta.retainedFromCursor ?? ZERO_CURSOR;
    const safeCursor = events.length === 0 ? retainedFromCursor : events[events.length - 1]!.cursor;
    const backward = request.direction === "backward";
    const rawFrom = request.cursor ?? (backward ? safeCursor : ZERO_CURSOR);
    if (!/^\d+$/u.test(rawFrom) || rawFrom.length > CURSOR_WIDTH) {
      return {
        schemaVersion: 1,
        status: "recover",
        conversationId: meta.conversationId,
        code: "cursor_invalid",
        recoverable: true,
        resetCursor: retainedFromCursor,
        message: "That cursor is not from this conversation; replay from the start.",
      };
    }
    // Cursors compare lexically, so a short numeric cursor pads first.
    const from = rawFrom.padStart(CURSOR_WIDTH, "0");
    if (from < retainedFromCursor) {
      return {
        schemaVersion: 1,
        status: "recover",
        conversationId: meta.conversationId,
        code: "cursor_expired",
        recoverable: true,
        resetCursor: retainedFromCursor,
        message: "Older conversation events expired; replay from the retained boundary.",
      };
    }
    if (from > safeCursor) {
      return {
        schemaVersion: 1,
        status: "recover",
        conversationId: meta.conversationId,
        code: "cursor_reset",
        recoverable: true,
        resetCursor: safeCursor,
        message: "That cursor is ahead of this conversation; resume from its latest event.",
      };
    }
    if (backward) {
      const window = operatorConversationWindow(events, {
        ...(request.cursor === undefined ? {} : { before: from }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
        ...(request.turnLimit === undefined ? {} : { turnLimit: request.turnLimit }),
      });
      return {
        schemaVersion: 1,
        status: "page",
        conversationId: meta.conversationId,
        surfaceClientId: request.surfaceClientId,
        events: window.events,
        retainedFromCursor,
        previousCursor: window.events[0]?.cursor ?? retainedFromCursor,
        nextCursor: window.events.at(-1)?.cursor ?? from,
        safeCursor,
        hasOlder: window.hasOlder,
        hasMore: window.hasOlder,
        ...(this.drafts.has(meta.conversationId) ? { live: this.drafts.get(meta.conversationId)! } : {}),
      };
    }
    const limit = request.limit ?? 200;
    const { events: page, remaining } = this.journal.after(
      meta.conversationId,
      from,
      limit,
      meta.conversationId === LINEAR_INBOX_CONVERSATION_ID,
    );
    return {
      schemaVersion: 1,
      status: "page",
      conversationId: meta.conversationId,
      surfaceClientId: request.surfaceClientId,
      events: page,
      retainedFromCursor,
      nextCursor: page.length === 0 ? from : page[page.length - 1]!.cursor,
      safeCursor,
      hasMore: page.length < remaining,
      // The volatile half of the page: what he is typing right now. A surface
      // that ignores it still gets every settled message from `events`.
      ...(this.drafts.has(meta.conversationId) ? { live: this.drafts.get(meta.conversationId)! } : {}),
    };
  }

  private async send(
    turn: SubmitOperatorConversationTurn,
    authority?: QuestionAuthority,
  ): Promise<SubmitOperatorConversationTurnResult> {
    const meta = this.metas.get(turn.conversationId);
    if (meta === undefined) {
      throw new Error(`Unknown conversation ${turn.conversationId}`);
    }
    if (meta.scope.kind === "room")
      throw new ConversationRefusedError(
        "This is a read-only room transcript. Send messages in Discord; work started from a Discord room reports back through that room.",
      );
    const attachments = await this.sendAttachments(meta, turn);
    if (meta.scope.kind === "seat") {
      return this.queueSeatSend(meta, meta.scope.seatId, turn, { seatId: meta.scope.seatId }, attachments);
    }
    if (meta.scope.kind === "persona") {
      const seatId =
        this.seatForPersona === undefined ? meta.scope.personaId : this.seatForPersona(meta.scope.personaId);
      return this.queueSeatSend(meta, seatId, turn, { personaId: meta.scope.personaId }, attachments);
    }
    const safeCursor = this.lastCursor(meta);
    if (turn.expectedRevision !== meta.revision) {
      return {
        schemaVersion: 1,
        status: "revision_conflict",
        conversationId: meta.conversationId,
        expectedRevision: turn.expectedRevision,
        currentRevision: meta.revision,
        safeCursor,
      };
    }
    let questionBinding: ConversationTurnContext["questionBinding"];
    if (!authority && meta.questions?.records.some((r) => r.question.status === "pending"))
      this.cancelPendingQuestion(meta.conversationId, "owner_context_lost");
    if (
      authority &&
      meta.scope.kind === "workspace" &&
      !meta.parentConversationId &&
      !meta.nativeSource &&
      this.questionEligible(meta.conversationId)
    ) {
      await authorizeQuestion(authority);
      if (this.metas.get(meta.conversationId) !== meta || turn.expectedRevision !== meta.revision)
        throw new Error("Conversation changed during owner admission");
      this.validQuestionState(meta);
      meta.questions ??= newQuestionState();
      questionBinding = {
        incarnationId: meta.questions.incarnationId,
        workspace: questionWorkspace(meta.scope.workspaceId),
      };
    }
    // In a channel the members answer, not Clankie. The run is the sequenced
    // round; everything else about an accepted turn — revision, cancellation,
    // settlement, retention — is the same as any other.
    return this.enqueue(
      meta,
      turn.message,
      turn.herdrPaneId,
      true,
      meta.scope.kind === "channel" ? this.channelRound(true) : this.runner,
      {
        surfaceClientId: turn.surfaceClientId,
        ...(authority === undefined ? {} : { ownerAuthority: authority }),
        ...(questionBinding === undefined ? {} : { questionBinding }),
        ...(turn.delivery === undefined || meta.scope.kind === "channel" ? {} : { delivery: turn.delivery }),
        ...(attachments === undefined ? {} : { attachments }),
      },
    );
  }

  /**
   * A message typed in the guild a channel is projected onto (ADR 0146). It is
   * the same conversation, so it lands in the shared transcript and runs a round
   * exactly as one sent from the app does — Discord participates, it does not
   * keep a second conversation of its own.
   *
   * Nothing is fenced against a revision here: a surface writing into the one
   * conversation is not a second writer racing the first, and there is no
   * client-held revision on the far side of the gateway to fence with.
   *
   * Who is allowed to speak here is settled before this is called. Discord
   * identity policy lives on the bridge, which is the seat that knows who sent
   * a message; a channel fans one message out to every seat in it, so that
   * decision is never taken on this side.
   */
  public submitProjectedMessage(
    guildId: string,
    channelId: string,
    message: string,
  ): { readonly conversationId: string; readonly runId: string } | undefined {
    const meta = [...this.metas.values()].find((candidate) => {
      const live = this.liveProjection(candidate);
      return live?.guildId === guildId && (live.threadId ?? live.channelId) === channelId;
    });
    if (meta === undefined) return undefined;
    // Already on screen in the room it was typed in, so it is not echoed back.
    const result = this.enqueue(meta, message, undefined, true, this.channelRound(false));
    return result.status === "accepted"
      ? { conversationId: meta.conversationId, runId: result.runId }
      : undefined;
  }

  /**
   * One round of turn-taking (ADR 0146). Members are offered a turn in position
   * order, each prompted with the transcript as it stands at that moment —
   * including a reply that landed a second earlier, which is what lets a member
   * see its point already made and stay quiet.
   *
   * Every member gets at most one turn per operator message. Without that bound
   * two members that each found the other worth replying to would trade
   * messages until something ran out of money; a member with more to say waits
   * for the operator, exactly as a person in a group chat does.
   */
  private channelRound(echoOperator: boolean): ConversationRunner {
    return async (conversationId, message, publish, context) => {
      const meta = this.metas.get(conversationId);
      if (meta === undefined) return;
      // A room that showed only the answers would be answering invisible
      // questions, so a message sent from the app is shown in the guild too.
      if (echoOperator) await this.projectChannelMessage(meta, "operator", message);
      const members = meta.channelMembers ?? [];
      const names = new Map(
        await Promise.all(
          members.map(async (member) => {
            const personaId = channelMemberPersonaId(member);
            const presentation = await this.personaPresentation?.(personaId);
            return [personaId, presentation?.username ?? personaId] as const;
          }),
        ),
      );
      const taken: ChannelTurnRecord[] = [];
      // A member that was never asked, or asked and never heard from, is not
      // the same as one that passed — and telling them apart is the whole
      // difference between a quiet room and a broken one.
      const unreachable: string[] = [];
      const deliveryFailures: string[] = [];
      let spoke = 0;
      for (;;) {
        if (context.signal.aborted) return;
        const member = nextChannelTurn({ members, taken });
        if (member === undefined) break;
        const prompt = renderChannelTurnPrompt({
          title: meta.title,
          member,
          members,
          entries: this.channelEntries(conversationId),
          nameOf: (personaId) => names.get(personaId) ?? personaId,
        });
        // An offline seat passes: the room carries on without it rather than
        // stalling on a pane that is not there to answer.
        const personaId = channelMemberPersonaId(member);
        const seatId = this.seatForPersona === undefined ? personaId : this.seatForPersona(personaId);
        // Whoever spoke last in the room is who this turn answers, so the edge
        // is drawn from them — captured before the send, because the send is
        // what makes it the previous line.
        const answering = this.lastSeatEntry(conversationId);
        const replyController = new AbortController();
        const pendingReply =
          seatId === undefined
            ? undefined
            : this.awaitSeatReply(seatId, AbortSignal.any([context.signal, replyController.signal]));
        const delivery =
          seatId === undefined
            ? undefined
            : await this.sendToSeat?.(seatId, prompt, { conversationId, source: "room" });
        const asked = delivery === true || (typeof delivery === "object" && delivery.outcome === "delivered");
        if (asked && seatId !== undefined && answering !== undefined) {
          const fromSeatId =
            this.seatForPersona === undefined
              ? answering.personaId
              : this.seatForPersona(answering.personaId);
          if (fromSeatId !== undefined && fromSeatId !== seatId) {
            this.reportSeatEdge?.({
              type: "message",
              fromSeatId,
              toSeatId: seatId,
              conversationId,
              entryId: answering.entryId,
            });
          }
        }
        if (!asked) replyController.abort();
        const reply = await pendingReply;
        replyController.abort();
        const spokenText = channelTurnReply(reply);
        if (spokenText === undefined) {
          const name = names.get(personaId) ?? personaId;
          if (
            typeof delivery === "object" &&
            (delivery.outcome === "unconfirmed" || delivery.outcome === "undelivered")
          ) {
            deliveryFailures.push(
              `${name}: ${delivery.outcome === "unconfirmed" ? "delivery unconfirmed; it may still arrive" : "message not delivered"}. ${delivery.detail}`,
            );
          } else if (!asked || reply === undefined) unreachable.push(name);
          taken.push({ personaId, outcome: "passed" });
          continue;
        }
        publish({ type: "message", role: "agent", text: spokenText, streaming: false, personaId });
        // Published synchronously, so the newest cursor is this line's. Whether
        // it answers anything is the window's to decide.
        if (seatId !== undefined) {
          this.reportSeatEdge?.({
            type: "turn",
            seatId,
            conversationId,
            entryId: this.lastCursor(meta),
          });
        }
        spoke += 1;
        taken.push({ personaId, outcome: "spoke" });
        await this.projectChannelMessage(meta, personaId, spokenText);
      }
      const notice = channelRoundNotice({ spoke, unreachable, members: members.length });
      if (notice !== undefined && deliveryFailures.length === 0)
        await this.projectChannelNotice(meta, notice);
      if (deliveryFailures.length > 0)
        await this.projectChannelNotice(
          meta,
          `${deliveryFailures.join("\n")}\nInspect the native sessions before resending; no terminal input was sent.`,
        );
    };
  }

  /**
   * Say in the guild what the transcript has no business recording: that a
   * round reached nobody. It is authored by the room rather than by a member,
   * because no member said it, and it is deliberately not published — the
   * record holds what was said, not why nothing was.
   */
  private async projectChannelNotice(meta: ConversationMeta, notice: string): Promise<void> {
    await this.projectChannelMessage(meta, CHANNEL_NOTICE_AUTHOR, notice);
  }

  /**
   * Show one member's words in the guild, as that member. A webhook renders
   * each agent under its own name from one per-channel credential, which is why
   * no seat needs a bot application and certainly not a user account
   * (ADR 0048). Discord is a second surface, so a projection that fails is
   * logged by its absence there and changes nothing here.
   */
  private async projectChannelMessage(
    meta: ConversationMeta,
    personaId: string,
    content: string,
  ): Promise<void> {
    const target = this.liveProjection(meta);
    if (target === undefined || this.projection === undefined) return;
    try {
      const presentation =
        personaId === "operator" || personaId === CHANNEL_NOTICE_AUTHOR
          ? { username: personaId }
          : ((await this.personaPresentation?.(personaId)) ?? { username: personaId });
      const { provisioned: _provisioned, ...credential } = target;
      await this.projection.post({ ...credential, ...presentation, content });
    } catch {
      // The transcript is the record; the room in Discord is a view of it.
    }
  }

  /** The shared transcript as a member sees it: who said what, oldest first. */
  /**
   * The last thing a fleet character said in this thread, and which entry it
   * was. A room turn hands the reader everything said so far, so this is the
   * line the next member is answering — and the one an edge is about.
   *
   * `role` decides authorship: only `agent` is a seat speaking. The operator's
   * own message and the captain's are messages from outside the fleet, and a
   * turn that follows one is nobody's reply.
   */
  private lastSeatEntry(
    conversationId: string,
  ): { readonly personaId: string; readonly entryId: string } | undefined {
    const events = this.readEvents(conversationId);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!;
      if (event.type !== "message" || event.role !== "agent") continue;
      const personaId = event.personaId ?? event.seatId;
      if (personaId === undefined) continue;
      return { personaId, entryId: event.cursor };
    }
    return undefined;
  }

  private channelEntries(conversationId: string): readonly ChannelTranscriptEntry[] {
    return this.readEvents(conversationId).flatMap((event) => {
      if (event.type !== "message" || event.text.trim().length === 0) return [];
      const personaId = event.personaId ?? event.seatId;
      return [{ ...(personaId === undefined ? {} : { personaId }), text: event.text }];
    });
  }

  /**
   * Park until this seat says its next thing, or until the turn times out and
   * counts as a pass. The reply arrives through the same herdr projection that
   * feeds the seat's own thread, so a channel adds no second way of listening
   * to an agent.
   */
  private awaitSeatReply(seatId: string, signal: AbortSignal): Promise<string | undefined> {
    return new Promise((resolve) => {
      let waiters = this.seatReplyWaiters.get(seatId);
      if (waiters === undefined) {
        waiters = new Set();
        this.seatReplyWaiters.set(seatId, waiters);
      }
      const registered = waiters;
      const settle = (reply: string | undefined): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        registered.delete(settle);
        if (registered.size === 0) this.seatReplyWaiters.delete(seatId);
        resolve(reply);
      };
      const onAbort = (): void => {
        settle(undefined);
      };
      const timer = setTimeout(() => {
        settle(undefined);
      }, CHANNEL_TURN_TIMEOUT_MS);
      timer.unref?.();
      signal.addEventListener("abort", onAbort, { once: true });
      registered.add(settle);
    });
  }

  private resolveSeatReply(seatId: string, text: string): void {
    const waiters = this.seatReplyWaiters.get(seatId);
    if (waiters === undefined) return;
    // One reply answers one offered turn, oldest first. Two messages sent close
    // together run two rounds, and both offer the same seat a turn — handing
    // this text to every waiter would publish the seat's single answer once per
    // round, so the room hears it twice and Discord shows it twice. The seat
    // said it once; the other round keeps waiting for its own answer.
    const [oldest] = waiters;
    oldest?.(text);
  }

  private queueSeatSend(
    meta: ConversationMeta,
    seatId: string | undefined,
    turn: SubmitOperatorConversationTurn,
    offlineIdentity: { readonly seatId: string } | { readonly personaId: string },
    attachments?: readonly StoredOwnerAttachment[],
  ): Promise<SubmitOperatorConversationTurnResult> {
    const previous = this.seatSends.get(meta.conversationId) ?? Promise.resolve();
    const pending = previous.then(() =>
      this.deliverSeatTurn(meta, seatId, offlineIdentity, turn, attachments),
    );
    const settled = pending.then(
      () => undefined,
      () => undefined,
    );
    this.seatSends.set(meta.conversationId, settled);
    void settled.finally(() => {
      if (this.seatSends.get(meta.conversationId) === settled) this.seatSends.delete(meta.conversationId);
    });
    return pending;
  }

  private async deliverSeatTurn(
    meta: ConversationMeta,
    seatId: string | undefined,
    offlineIdentity: { readonly seatId: string } | { readonly personaId: string },
    turn: SubmitOperatorConversationTurn,
    attachments?: readonly StoredOwnerAttachment[],
  ): Promise<SubmitOperatorConversationTurnResult> {
    const safeCursor = this.lastCursor(meta);
    if (turn.expectedRevision !== meta.revision) {
      return {
        schemaVersion: 1,
        status: "revision_conflict",
        conversationId: meta.conversationId,
        expectedRevision: turn.expectedRevision,
        currentRevision: meta.revision,
        safeCursor,
      };
    }
    // Files go into the seat's own workspace before the message that names
    // them; a seat that cannot take them gets nothing, and the owner keeps
    // the draft (ADR 0209).
    let message = turn.message;
    if (attachments !== undefined && seatId !== undefined) {
      const prepared = (await this.ownerAttachments?.forSeat?.(seatId, meta.conversationId, attachments)) ?? {
        undeliverable: "This Clankie cannot hand files to agents.",
      };
      if ("undeliverable" in prepared)
        return {
          schemaVersion: 1,
          status: "seat_undelivered",
          deliveryStage: "unavailable",
          conversationId: meta.conversationId,
          ...offlineIdentity,
          detail: prepared.undeliverable.slice(0, OPERATOR_CONVERSATION_SUMMARY_MAX),
          currentRevision: meta.revision,
          safeCursor,
        };
      message = [turn.message, prepared.note].filter((part) => part.length > 0).join("\n\n");
    }
    const delivery =
      seatId === undefined
        ? undefined
        : await this.sendToSeat?.(seatId, message, {
            conversationId: meta.conversationId,
            source: "operator",
          });
    if (typeof delivery === "object" && delivery.outcome !== "delivered" && delivery.outcome !== "offline") {
      return {
        schemaVersion: 1,
        status: delivery.outcome === "unconfirmed" ? "seat_delivery_unconfirmed" : "seat_undelivered",
        deliveryStage: fleetDeliveryStage(delivery),
        conversationId: meta.conversationId,
        ...offlineIdentity,
        detail: delivery.detail.slice(0, OPERATOR_CONVERSATION_SUMMARY_MAX),
        ...(delivery.outcome === "unconfirmed" && delivery.messageId !== undefined
          ? { messageId: delivery.messageId }
          : {}),
        currentRevision: meta.revision,
        safeCursor,
      };
    }
    if (delivery !== true && !(typeof delivery === "object" && delivery.outcome === "delivered")) {
      return {
        schemaVersion: 1,
        status: "seat_offline",
        deliveryStage: "unavailable",
        conversationId: meta.conversationId,
        ...offlineIdentity,
        currentRevision: meta.revision,
        safeCursor,
      };
    }
    const runId = `run-${randomUUID()}`;
    meta.revision += 1;
    meta.updatedAt = new Date().toISOString();
    this.saveMeta(meta);
    this.append(meta, {
      type: "message",
      role: "operator",
      text: turn.message,
      streaming: false,
      ...(attachments === undefined ? {} : { attachments: attachments.map((attachment) => attachment.file) }),
    });
    if (typeof delivery === "object" && delivery.state === "queued" && delivery.detail)
      this.append(meta, { type: "message", role: "captain", text: delivery.detail, streaming: false });
    this.append(meta, { type: "turn", runId, phase: "accepted" });
    this.append(meta, {
      type: "turn",
      runId,
      phase: "completed",
      deliveryStage: typeof delivery === "object" ? fleetDeliveryStage(delivery) : "delivered",
    });
    this.prune(meta.conversationId);
    return {
      schemaVersion: 1,
      status: "accepted",
      conversationId: meta.conversationId,
      runId,
      revision: meta.revision,
      safeCursor,
      deliveryStage: typeof delivery === "object" ? fleetDeliveryStage(delivery) : "delivered",
      ...(typeof delivery === "object" && delivery.state !== undefined
        ? {
            seatDelivery: {
              state: delivery.state,
              ...(delivery.detail === undefined
                ? {}
                : { detail: delivery.detail.slice(0, OPERATOR_CONVERSATION_SUMMARY_MAX) }),
            },
          }
        : {}),
    };
  }

  private enqueue(
    meta: ConversationMeta,
    message: string,
    herdrPaneId: string | undefined,
    publishOperatorMessage: boolean,
    runner: ConversationRunner = this.runner,
    provenance: Pick<
      ConversationTurnContext,
      "origin" | "surfaceClientId" | "attachments" | "ownerAuthority" | "questionBinding" | "inputAnswer"
    > & {
      questionAnswer?: {
        readonly record: QuestionRecord;
        readonly answer: ConversationQuestionAnswer;
        readonly authority: QuestionAuthority;
      };
      delivery?: SubmitOperatorConversationTurn["delivery"];
      inboundReceipt?: Omit<InboundAcceptance, "message" | "runId" | "acceptedCursor">;
    } = {},
  ): SubmitOperatorConversationTurnResult {
    if (provenance.questionAnswer?.record.projectCreation?.claim)
      throw new Error("project_confirmation_consumed");
    const workspace = workspaceOf(meta.scope);
    const safeCursor = this.lastCursor(meta);
    const questionBefore = provenance.questionAnswer ? structuredClone(meta) : undefined;
    meta.revision += 1;
    meta.sessionState = "active";
    meta.updatedAt = new Date().toISOString();
    const runId = `run-${randomUUID()}`;
    if (provenance.questionAnswer) {
      const { record, answer, authority } = provenance.questionAnswer;
      record.question = {
        ...record.question,
        status: "submitted",
        answer,
        resolvedAt: new Date().toISOString(),
        continuation: { runId, state: "accepted" },
      };
      record.responder = { ...authority.principal };
      record.message = message;
    }
    const previousAcceptances = meta.inboundAcceptances;
    if (provenance.inboundReceipt) {
      // This atomic conversation write is the acceptance boundary. A crash after
      // it may prevent execution, but the exact original input is retained.
      meta.inboundAcceptances = {
        ...meta.inboundAcceptances,
        [provenance.inboundReceipt.deliveryId]: {
          ...provenance.inboundReceipt,
          message,
          runId,
          acceptedCursor: String(this.eventSequence(meta) + 1).padStart(CURSOR_WIDTH, "0"),
        },
      };
    }
    try {
      if (provenance.questionAnswer) this.saveQuestionMeta(meta);
      else this.saveMeta(meta);
    } catch (error) {
      if (questionBefore && !(error instanceof QuestionCommitError && error.committed)) {
        Object.assign(meta, questionBefore);
      }
      if (previousAcceptances === undefined) delete meta.inboundAcceptances;
      else meta.inboundAcceptances = previousAcceptances;
      throw error;
    }
    if (provenance.questionAnswer) this.publishQuestionResolution(meta, provenance.questionAnswer.record);
    if (publishOperatorMessage) {
      this.append(meta, {
        type: "message",
        role: "operator",
        text: message,
        streaming: false,
        ...(provenance.attachments === undefined
          ? {}
          : { attachments: provenance.attachments.map((attachment) => attachment.file) }),
      });
    }
    this.append(meta, {
      type: "turn",
      runId,
      phase: "accepted",
      ...(provenance.inboundReceipt?.workerReportRouting === undefined
        ? {}
        : {
            workerReportRouting: provenance.inboundReceipt.workerReportRouting,
          }),
    });

    const conversationId = meta.conversationId;
    this.runCounts.set(conversationId, (this.runCounts.get(conversationId) ?? 0) + 1);
    const controller = new AbortController();
    this.runControllers.set(runId, { conversationId, controller });
    // Explicit steering joins the active invocation, including its Pi startup.
    // An explicit queue always waits; older callers retain automatic steering
    // into autonomous turns. Merely queued work never opens a live lane.
    const joinLive =
      publishOperatorMessage &&
      (provenance.delivery === "steer"
        ? (this.activeInvocations.get(conversationId) ?? 0) > 0
        : provenance.delivery !== "queue" && (this.internalRuns.get(conversationId) ?? 0) > 0);

    const previous = this.chains.get(conversationId) ?? Promise.resolve();
    let invoked = false;
    let deliveryStage: DeliveryStage | undefined;
    const invoke = async (): Promise<void> => {
      if (provenance.questionAnswer) {
        const preparation = new ConversationServiceRun(controller.signal);
        try {
          await preparation.wait(
            "question authority",
            authorizeQuestion(provenance.questionAnswer.authority),
          );
        } finally {
          preparation.close();
        }
        this.assertQuestionContext(meta, provenance.questionAnswer.record);
      }
      if (provenance.origin === "hook") this.linearHookQueued.delete(conversationId);
      // Cancelled while still queued: settle without ever invoking the runner.
      if (controller.signal.aborted) return Promise.resolve();
      invoked = true;
      this.activeInvocations.set(conversationId, (this.activeInvocations.get(conversationId) ?? 0) + 1);
      if (!publishOperatorMessage) {
        this.internalRuns.set(conversationId, (this.internalRuns.get(conversationId) ?? 0) + 1);
      }
      meta.sessionState = "active";
      this.saveMeta(meta);
      return runner(
        conversationId,
        message,
        (event) => {
          this.append(meta, event);
        },
        {
          runId,
          ...(provenance.ownerAuthority === undefined ? {} : { ownerAuthority: provenance.ownerAuthority }),
          ...(provenance.questionBinding === undefined
            ? {}
            : { questionBinding: provenance.questionBinding }),
          ...(provenance.inputAnswer === undefined ? {} : { inputAnswer: provenance.inputAnswer }),
          acceptedAt: meta.updatedAt,
          deliveryReceipt: (stage) => {
            deliveryStage = stage;
          },
          signal: controller.signal,
          draft: (text) => {
            this.setLiveDraft(conversationId, text);
          },
          ...(publishOperatorMessage ? {} : { internal: true as const }),
          ...(provenance.origin === undefined ? {} : { origin: provenance.origin }),
          ...(provenance.surfaceClientId === undefined
            ? {}
            : { surfaceClientId: provenance.surfaceClientId }),
          ...(meta.parentConversationId === undefined ? {} : { side: true as const }),
          ...(provenance.attachments === undefined ? {} : { attachments: provenance.attachments }),
          ...(workspace === undefined ? {} : { workspace }),
          ...(herdrPaneId === undefined ? {} : { seat: { herdrPaneId } }),
        },
      );
    };
    const work = joinLive ? invoke() : previous.then(invoke);
    const run = work
      .then(() => {
        const cancelled = this.cancelRequests.has(runId);
        this.append(
          meta,
          cancelled
            ? {
                type: "turn",
                runId,
                phase: "cancelled",
                reasonCode: "operator_interrupt",
                deliveryStage: deliveryStage ?? "expired",
              }
            : { type: "turn", runId, phase: "completed", deliveryStage: deliveryStage ?? "responded" },
        );
        if (provenance.origin === "hook" && meta.linearWakePending) {
          if (cancelled) meta.linearWokeCursor = meta.linearWakePending.previous;
          else {
            const inbox = this.metas.get(this.linearInboxConversationId())!;
            for (const event of this.readEvents(inbox.conversationId))
              if (
                event.type === "message" &&
                event.cursor > meta.linearWakePending.previous &&
                event.cursor <= meta.linearWakePending.cursor &&
                this.linearAdmission(event).conversationId === conversationId
              ) {
                const admission = inbox.linearAdmissions?.[event.cursor];
                if (admission && !admission.nativeRecipient) admission.delivered = true;
              }
            this.saveMeta(inbox);
          }
          delete meta.linearWakePending;
        }
        if ((this.runCounts.get(conversationId) ?? 0) <= 1) meta.sessionState = "waiting";
        return !cancelled;
      })
      .catch((error: unknown) => {
        if (provenance.origin === "hook" && meta.linearWakePending) {
          meta.linearWokeCursor = meta.linearWakePending.previous;
          delete meta.linearWakePending;
        }
        // An interrupt that surfaces as a runner throw is still a cancellation,
        // not a failure.
        if (this.cancelRequests.has(runId)) {
          this.append(meta, { type: "turn", runId, phase: "cancelled", reasonCode: "operator_interrupt" });
          if ((this.runCounts.get(conversationId) ?? 0) <= 1) meta.sessionState = "waiting";
          return false;
        }
        // A bare class name ("Error") tells the operator nothing. The message is
        // the only thing that names the actual failure, so it rides along; the
        // stack goes to the service log for anything the summary truncates.
        console.error(`operator turn ${runId} in ${conversationId} failed`, error);
        this.append(meta, {
          type: "turn",
          runId,
          phase: "failed",
          reasonCode:
            provenance.questionAnswer &&
            error instanceof Error &&
            ["question_owner_unavailable", "question_context_lost"].includes(error.message)
              ? "owner_context_lost"
              : error instanceof ConversationRunStalledError
                ? "conversation_turn_stalled"
                : error instanceof SeatLinkInterruptedError
                  ? "service_restarted"
                  : error instanceof Error
                    ? error.constructor.name
                    : "run_failed",
          summary: turnFailureSummary(error),
        });
        if ((this.runCounts.get(conversationId) ?? 0) <= 1) meta.sessionState = "failed";
        return false;
      })
      .finally(() => {
        meta.updatedAt = new Date().toISOString();
        this.saveMeta(meta);
        this.trimEventLog(meta);
        this.runs.delete(runId);
        this.runControllers.delete(runId);
        this.cancelRequests.delete(runId);
        const remaining = (this.runCounts.get(conversationId) ?? 1) - 1;
        if (remaining <= 0) this.runCounts.delete(conversationId);
        else this.runCounts.set(conversationId, remaining);
        // Nothing is typing here any more: a draft stranded by a failed or
        // interrupted turn comes down with the last run, not on the next one.
        if (remaining <= 0) this.setLiveDraft(conversationId, undefined);
        if (invoked) {
          const active = (this.activeInvocations.get(conversationId) ?? 1) - 1;
          if (active <= 0) this.activeInvocations.delete(conversationId);
          else this.activeInvocations.set(conversationId, active);
        }
        if (invoked && !publishOperatorMessage) {
          const remainingInternal = (this.internalRuns.get(conversationId) ?? 1) - 1;
          if (remainingInternal <= 0) this.internalRuns.delete(conversationId);
          else this.internalRuns.set(conversationId, remainingInternal);
        }
        this.prune(conversationId);
      });
    this.chains.set(
      conversationId,
      joinLive
        ? Promise.all([previous, run.then(() => undefined)]).then(() => undefined)
        : run.then(() => undefined),
    );
    this.runs.set(runId, run);
    return {
      schemaVersion: 1,
      status: "accepted",
      deliveryStage: "stored",
      conversationId: meta.conversationId,
      runId,
      revision: meta.revision,
      safeCursor,
    };
  }

  private append(meta: ConversationMeta, body: OperatorConversationEventBody, occurredAt?: string): void {
    if (
      body.type === "turn" &&
      body.phase !== "accepted" &&
      !this.corruptQuestions.has(meta.conversationId)
    ) {
      const record = meta.questions?.records.find((r) => r.question.continuation?.runId === body.runId);
      if (record?.question.continuation) {
        record.question.continuation.state = body.phase;
        if ("reasonCode" in body && body.reasonCode)
          record.question.continuation.reasonCode = body.reasonCode.slice(0, 100);
        this.saveQuestionMeta(meta);
      }
    }
    const retainedCount = this.retainedEventCount(meta.conversationId);
    const sequence = this.eventSequence(meta) + 1;
    const cursor = String(sequence).padStart(CURSOR_WIDTH, "0");
    const event: OperatorConversationStreamEvent = {
      schemaVersion: 1,
      conversationId: meta.conversationId,
      cursor,
      revision: meta.revision,
      occurredAt: occurredAt ?? new Date().toISOString(),
      ...body,
    } as OperatorConversationStreamEvent;
    if (meta.conversationId === LINEAR_INBOX_CONVERSATION_ID) {
      // ponytail: atomic inbox rewrites; append in place if unread histories make this costly.
      this.journal.rewrite(meta.conversationId, [...this.readEvents(meta.conversationId), event]);
    } else this.journal.append(meta.conversationId, event);
    this.counts.set(meta.conversationId, retainedCount + 1);
    this.sequences.set(meta.conversationId, sequence);
    if (body.type === "context") {
      meta.contextUsage = body.usage;
      this.saveMeta(meta);
    }
    if (meta.sessionState !== "active") this.trimEventLog(meta);
    this.wakeTails(meta.conversationId);
    // A supplied `occurredAt` means this already happened somewhere else — a
    // folded Herdr transcript replaying history. Only what is being said now
    // wakes a sleeping device, so a first seat attach cannot become a burst of
    // notifications about old messages.
    if (occurredAt === undefined && body.type === "message" && body.streaming !== true) {
      if (body.role === "captain" || body.role === "agent") {
        const notice: DurableMessageNotice = { conversationId: meta.conversationId, role: body.role };
        for (const listener of this.durableMessageListeners) {
          try {
            listener(notice);
          } catch {
            // Delivery is downstream of the transcript: it must never fail a write.
          }
        }
      }
    }
  }

  private waitForChange(conversationId: string, waitMs: number): Promise<void> {
    return new Promise((resolve) => {
      let listeners = this.tailListeners.get(conversationId);
      if (listeners === undefined) {
        listeners = new Set();
        this.tailListeners.set(conversationId, listeners);
      }
      const registered = listeners;
      const done = (): void => {
        clearTimeout(timer);
        registered.delete(done);
        if (registered.size === 0) this.tailListeners.delete(conversationId);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      timer.unref?.();
      registered.add(done);
    });
  }

  private wakeTails(conversationId: string): void {
    const listeners = this.tailListeners.get(conversationId);
    if (listeners === undefined) return;
    // Each listener removes only itself as it resolves, and a set never
    // revisits an element it has already yielded, so this walks the live set.
    for (const listener of listeners) listener();
  }

  /**
   * The captain's answer as it is being typed ([ADR 0141](../../../../docs/adr/0141-the-console-watches-him-type.md)).
   * A draft is volatile: it lives in memory, never in `events.jsonl`, so replay,
   * retention, cursors, and every surface that only wants the record are
   * untouched by streaming. `undefined` takes the draft down — the durable
   * `message` event that settles it is the record. Callers throttle; every call
   * wakes the parked tails.
   */
  public setLiveDraft(conversationId: string, text: string | undefined): void {
    if (!this.metas.has(conversationId)) return;
    if (text === undefined || text.length === 0) {
      if (this.drafts.delete(conversationId)) this.wakeTails(conversationId);
      return;
    }
    this.draftSequence += 1;
    this.drafts.set(conversationId, {
      sequence: this.draftSequence,
      role: "captain",
      text: text.slice(0, OPERATOR_CONVERSATION_TEXT_MAX),
    });
    this.wakeTails(conversationId);
  }

  private readonly counts = new Map<string, number>();
  private readonly sequences = new Map<string, number>();

  private retainedEventCount(conversationId: string): number {
    const cached = this.counts.get(conversationId);
    if (cached !== undefined) return cached;
    const count = this.readEvents(conversationId).length;
    this.counts.set(conversationId, count);
    return count;
  }

  private eventSequence(meta: ConversationMeta): number {
    const cached = this.sequences.get(meta.conversationId);
    if (cached !== undefined) return cached;
    const events = this.readEvents(meta.conversationId);
    const cursor = events[events.length - 1]?.cursor ?? meta.retainedFromCursor ?? ZERO_CURSOR;
    const sequence = Number.parseInt(cursor, 10);
    this.sequences.set(meta.conversationId, sequence);
    return sequence;
  }

  private lastCursor(meta: ConversationMeta): string {
    return String(this.eventSequence(meta)).padStart(CURSOR_WIDTH, "0");
  }

  private trimEventLog(meta: ConversationMeta): void {
    // A persona thread and a channel are both durable rooms an agent keeps talking
    // in; Clankie's own conversations turn over with his sessions.
    const room =
      meta.scope.kind === "room" ||
      meta.scope.kind === "seat" ||
      meta.scope.kind === "persona" ||
      meta.scope.kind === "channel";
    const maximum = room ? SEAT_CONVERSATION_RETAINED_EVENTS_MAX : OPERATOR_CONVERSATION_RETAINED_EVENTS_MAX;
    const retainedCount = room
      ? SEAT_CONVERSATION_RETAINED_EVENTS_AFTER_TRIM
      : OPERATOR_CONVERSATION_RETAINED_EVENTS_AFTER_TRIM;
    if (this.retainedEventCount(meta.conversationId) <= maximum) {
      return;
    }
    const events = this.readEvents(meta.conversationId);
    let trimCount = Math.max(0, events.length - retainedCount);
    if (meta.conversationId === LINEAR_INBOX_CONVERSATION_ID) {
      const firstUnread = events.findIndex(
        (event) =>
          event.type === "message" &&
          event.role === "external" &&
          (() => {
            const owner = event.linear && this.metas.get(this.linearAdmission(event).conversationId);
            const read = [meta.linearReadCursor ?? ZERO_CURSOR, owner?.linearReadCursor ?? ZERO_CURSOR]
              .sort()
              .at(-1)!;
            const woke = owner?.linearWakePending?.previous ?? owner?.linearWokeCursor ?? ZERO_CURSOR;
            const admission = meta.linearAdmissions?.[event.cursor];
            const pending =
              event.linear?.following === true &&
              event.linear.notification === true &&
              admission?.delivered !== true &&
              (admission?.nativeRecipient !== undefined || event.cursor > woke);
            return event.cursor > read || pending;
          })(),
      );
      if (firstUnread >= 0) trimCount = Math.min(trimCount, firstUnread);
    }
    if (trimCount === 0) return;
    const dropped = events.slice(0, trimCount);
    const retained = events.slice(trimCount);
    if (meta.conversationId === LINEAR_INBOX_CONVERSATION_ID) {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      meta.linearSeen = Object.fromEntries(
        Object.entries(meta.linearSeen ?? {}).filter(([, at]) => at > cutoff),
      );
      for (const event of dropped)
        if (event.type === "message" && event.linear && Date.parse(event.occurredAt) > cutoff)
          meta.linearSeen[event.linear.eventId] = Date.parse(event.occurredAt);
      for (const event of dropped) delete meta.linearAdmissions?.[event.cursor];
      this.saveMeta(meta);
    }
    meta.retainedFromCursor = dropped[dropped.length - 1]?.cursor ?? meta.retainedFromCursor ?? ZERO_CURSOR;
    this.journal.rewrite(meta.conversationId, retained);
    this.counts.set(meta.conversationId, retained.length);
    this.saveMeta(meta);
  }

  private matchesRecentSeatSend(meta: ConversationMeta, message: HerdrTranscriptMessage): boolean {
    const previous = this.readEvents(meta.conversationId).findLast(
      (event) => event.type === "message" && event.role === "operator",
    );
    if (previous?.type !== "message" || previous.role !== "operator" || previous.text !== message.text) {
      return false;
    }
    const nativeAt = Date.parse(message.occurredAt ?? "");
    return !Number.isFinite(nativeAt) || Math.abs(Date.parse(previous.occurredAt) - nativeAt) < 60_000;
  }

  /** One-time migration from the old last-answer projection to the native ordered transcript. */
  private replaceSeatEntries(meta: ConversationMeta, transcript: readonly HerdrTranscriptEntry[]): void {
    const events = this.readEvents(meta.conversationId);
    const covered = new Map<string, number>();
    for (const message of transcript) {
      if (message.type !== "message") continue;
      const key = messageKey(message.role, message.text);
      covered.set(key, (covered.get(key) ?? 0) + 1);
    }
    const preserved = events.flatMap((event) => {
      if (event.type !== "message") return [];
      const role = event.role === "agent" ? "agent" : event.role === "operator" ? "operator" : undefined;
      if (role === undefined) return [];
      const key = messageKey(role, event.text);
      const remaining = covered.get(key) ?? 0;
      if (remaining > 0) {
        covered.set(key, remaining - 1);
        return [];
      }
      return [
        {
          body: { type: "message" as const, role, text: event.text, streaming: false as const },
          occurredAt: event.occurredAt,
        },
      ];
    });
    const projected = transcript.flatMap((entry) =>
      entry.type === "viewed_image"
        ? []
        : [
            {
              body: transcriptEventBody(entry, "agent"),
              occurredAt: entry.occurredAt ?? new Date().toISOString(),
            },
          ],
    );
    const previousSequence = this.eventSequence(meta);
    let sequence = previousSequence + 1;
    meta.retainedFromCursor = String(sequence).padStart(CURSOR_WIDTH, "0");
    const rebuilt = [...preserved, ...projected].map(({ body, occurredAt }) => {
      sequence += 1;
      return {
        schemaVersion: 1 as const,
        conversationId: meta.conversationId,
        cursor: String(sequence).padStart(CURSOR_WIDTH, "0"),
        revision: meta.revision,
        occurredAt,
        ...body,
      } as OperatorConversationStreamEvent;
    });
    this.journal.rewrite(meta.conversationId, rebuilt);
    this.counts.set(meta.conversationId, rebuilt.length);
    this.sequences.set(meta.conversationId, sequence);
    this.wakeTails(meta.conversationId);
  }

  private readEvents(conversationId: string): readonly OperatorConversationStreamEvent[] {
    // Losing the inbox would silently drop unread Linear work, so it fails loudly.
    return this.journal.read(conversationId, conversationId === LINEAR_INBOX_CONVERSATION_ID);
  }

  private validQuestionState(meta: ConversationMeta): void {
    if (this.corruptQuestions.has(meta.conversationId)) throw new Error("question_state_unavailable");
    if (meta.questions !== undefined) {
      const parsed = QuestionStateSchema.safeParse(meta.questions);
      if (
        !parsed.success ||
        parsed.data.records.some((r) => r.question.conversationId !== meta.conversationId)
      ) {
        this.corruptQuestions.add(meta.conversationId);
        throw new Error("question_state_unavailable");
      }
    }
  }

  private assertQuestionContext(meta: ConversationMeta, record: QuestionRecord): void {
    if (
      this.metas.get(meta.conversationId) !== meta ||
      meta.scope.kind !== "workspace" ||
      meta.parentConversationId ||
      meta.nativeSource ||
      !this.questionEligible(meta.conversationId) ||
      meta.questions?.incarnationId !== record.question.incarnationId ||
      !sameQuestionWorkspace(meta.scope.workspaceId, record.workspace)
    )
      throw new Error("question_context_lost");
  }

  public async requestQuestion(
    conversationId: string,
    draft: QuestionDraft,
    context: ConversationTurnContext,
    projectDraft?: ProjectProposalDraft,
  ): Promise<ConversationQuestionResult> {
    const input = QuestionDraftSchema.parse(draft);
    await authorizeQuestion(context.ownerAuthority);
    const meta = this.metas.get(conversationId);
    if (
      !meta ||
      !context.questionBinding ||
      context.signal.aborted ||
      context.questionCurrent?.() === false ||
      this.runControllers.get(context.runId)?.conversationId !== conversationId ||
      (context.internal && context.origin !== "input")
    )
      throw new Error("question_turn_unavailable");
    this.validQuestionState(meta);
    const record: QuestionRecord = {
      issuer: { ...context.ownerAuthority!.principal },
      workspace: { ...context.questionBinding.workspace },
      question: {
        requestId: randomUUID(),
        incarnationId: context.questionBinding.incarnationId,
        conversationId,
        workspace: context.questionBinding.workspace.path,
        purpose: "preference",
        kind: input.kind,
        prompt: input.prompt,
        options: input.options.map((o) => ({ ...o, optionId: randomUUID() })),
        allowFreeform: input.kind === "text" || input.allowFreeform,
        createdAt: new Date().toISOString(),
        originRunId: context.runId,
        status: "pending",
      },
    };
    this.assertQuestionContext(meta, record);
    const existing = meta.questions!.records.find((r) => r.question.status === "pending");
    if (existing) return this.questionResult(meta, existing, "ready", "already_pending");
    if (meta.questions!.records.some((r) => r.projectCreation?.status === "committing"))
      throw new Error("project_confirmation_consumed");
    if (projectDraft) {
      const onboarding = this.projectOnboarding;
      if (!onboarding) throw new Error("project_onboarding_unavailable");
      const revision = meta.revision;
      const parsed = ProjectProposalDraftSchema.parse(projectDraft);
      const { prompt: _prompt, evidence, ...policy } = parsed;
      const settings = await onboarding.load();
      const command = {
        ...policy,
        workspacePath: record.workspace.path,
        expectedRevision: projectsRevision(settings.projects),
      };
      let prepared: Awaited<ReturnType<typeof onboarding.prepare>>;
      try {
        prepared = await onboarding.prepare(command);
      } catch (error) {
        return this.questionResult(
          meta,
          undefined,
          "refused",
          error instanceof ProjectTrackerUnavailable
            ? "project_tracker_unavailable"
            : "project_proposal_conflict",
        );
      }
      await authorizeQuestion(context.ownerAuthority);
      this.assertQuestionContext(meta, record);
      if (
        meta.revision !== revision ||
        context.signal.aborted ||
        context.questionCurrent?.() === false ||
        this.runControllers.get(context.runId)?.conversationId !== conversationId ||
        meta.questions!.records.some(
          (r) => r.question.status === "pending" || r.projectCreation?.status === "committing",
        )
      )
        throw new Error("project_proposal_context_changed");
      const immutable = {
        version: 1 as const,
        proposalId: randomUUID(),
        requestId: record.question.requestId,
        incarnationId: record.question.incarnationId,
        conversationId,
        originRunId: context.runId,
        workspace: record.workspace,
        command,
        ...prepared,
        evidence,
      };
      record.projectCreation = ProjectCreationSchema.parse({
        immutable,
        artifactSha256: proposalHash(immutable),
        status: "pending",
      });
    }
    const previous = meta.questions;
    const next = {
      ...previous!,
      records: [...previous!.records.filter((r) => r.question.status !== "pending").slice(-32), record],
    };
    // Pure validation before publishing the in-memory slot: bounded-state refusal has no IO.
    if (projectDraft) QuestionStateSchema.parse(next);
    meta.questions = next;
    try {
      this.saveQuestionMeta(meta);
    } catch (error) {
      // Project artifacts retain their slot after ANY uncertain writer outcome. No issuer
      // closure is installed on failure, so neither an in-process nor cold retry can CREATE.
      if (!projectDraft && !(error instanceof QuestionCommitError && error.committed))
        meta.questions = previous!;
      throw error;
    }
    this.questionIssuers.set(record.question.requestId, context.ownerAuthority!);
    this.append(meta, {
      type: "input_requested",
      requestId: record.question.requestId,
      prompt: input.prompt,
      inputKind: input.kind,
      options: input.options.map((o) => o.label),
    });
    return this.questionResult(meta, record, "ready");
  }

  public async proposeProjectCreate(
    conversationId: string,
    draft: ProjectProposalDraft,
    context: ConversationTurnContext,
  ): Promise<ConversationQuestionResult> {
    const parsed = ProjectProposalDraftSchema.parse(draft);
    return this.requestQuestion(
      conversationId,
      QuestionDraftSchema.parse({ kind: "text", prompt: parsed.prompt }),
      context,
      parsed,
    );
  }

  private async projectProposalOperation(
    request: Extract<ConversationServiceRequest, { op: "project_proposal_get" | "project_proposal_confirm" }>,
    authority: QuestionAuthority | undefined,
  ): Promise<ProjectProposalResult> {
    await authorizeQuestion(authority);
    const meta = this.metas.get(request.conversationId);
    if (!meta) return { status: "refused", reason: "unknown_conversation" };
    this.validQuestionState(meta);
    const record = meta.questions?.records.find((r) => r.question.requestId === request.requestId);
    const creation = record?.projectCreation;
    const sameRecord = () =>
      this.metas.get(request.conversationId) === meta &&
      meta.questions?.incarnationId === request.incarnationId &&
      meta.questions.records.find((r) => r.question.requestId === request.requestId) === record &&
      record?.projectCreation === creation;
    if (!record || !creation || !sameRecord()) return { status: "refused", reason: "stale_proposal" };
    const originalPrincipal = () =>
      authority?.principal.kind === record.issuer.kind && authority.principal.id === record.issuer.id;
    if (!originalPrincipal()) throw new Error("question_owner_unavailable");
    const target =
      request.op === "project_proposal_confirm"
        ? ProjectProposalTargetSchema.parse({
            conversationId: request.conversationId,
            incarnationId: request.incarnationId,
            requestId: request.requestId,
            expectedRevision: request.expectedRevision,
            proposalId: request.proposalId,
            artifactSha256: request.artifactSha256,
            expectedProjectsRevision: request.expectedProjectsRevision,
          })
        : undefined;
    const exactTarget = () =>
      !target ||
      proposalHash(target) === proposalHash(proposalResult(creation, meta.revision).proposal!.target);
    // Consumed receipts deliberately outlive the original request/JWT closure.
    if (creation.claim || creation.status !== "pending") {
      await authorizeQuestion(authority);
      if (!sameRecord() || !originalPrincipal() || !exactTarget())
        return { status: "refused", reason: "stale_proposal" };
      return proposalResult(creation, meta.revision);
    }
    const issuer = this.questionIssuers.get(record.question.requestId);
    const revision = meta.revision;
    const assertCurrent = () => {
      this.assertQuestionContext(meta, record);
      if (
        !sameRecord() ||
        !originalPrincipal() ||
        record.question.status !== "pending" ||
        meta.revision !== revision ||
        this.questionIssuers.get(record.question.requestId) !== issuer ||
        !exactTarget()
      )
        throw new Error("project_proposal_context_changed");
    };
    const guard = async () => {
      assertCurrent();
      await authorizeQuestion(issuer);
      assertCurrent();
      await authorizeQuestion(authority);
      assertCurrent();
    };
    try {
      await guard();
    } catch {
      return { status: "refused", reason: "owner_context_lost" };
    }
    if (!target) return proposalResult(creation, meta.revision);
    // Another caller may have claimed while this caller was awaiting authorization.
    if (creation.claim) return proposalResult(creation, meta.revision);
    if (!this.projectOnboarding) return { status: "refused", reason: "project_onboarding_unavailable" };
    creation.claim = target;
    creation.status = "committing";
    try {
      this.saveQuestionMeta(meta);
    } catch {
      // A throwing rename does not prove no OS effect. Consume every ambiguous claim write;
      // a cold pending record without its live issuer also cannot restart this mutation.
      creation.status = "uncertain";
      return { ...proposalResult(creation, meta.revision), reason: "claim_persistence_unavailable" };
    }
    try {
      const result = await this.projectOnboarding.apply(creation, guard);
      await guard();
      creation.status = "created";
      creation.receipt = {
        projectId: creation.immutable.command.projectId,
        projectsRevision: result.revision,
      };
      record.question.status = "cancelled";
      record.question.reason = "project_created";
      record.question.resolvedAt = new Date().toISOString();
      meta.revision += 1;
      this.saveQuestionMeta(meta);
      this.questionIssuers.delete(record.question.requestId);
      this.publishQuestionResolution(meta, record);
      return proposalResult(creation, meta.revision);
    } catch {
      // A generic settings/receipt error may follow rename. Never replay or claim no write.
      if (
        sameRecord() &&
        ((record.question.status === "pending" && meta.revision === revision) ||
          (creation.status === "created" && record.question.reason === "project_created"))
      ) {
        creation.status = "uncertain";
        delete creation.receipt;
        try {
          this.saveQuestionMeta(meta);
        } catch {
          /* durable committing is already consumed */
        }
      }
      if (!sameRecord()) return { status: "uncertain", reason: "receipt_context_lost" };
      // Do not report an unpersisted success receipt from the catch path.
      return {
        ...proposalResult(creation, meta.revision),
        status: "uncertain",
        receipt: undefined,
        reason: "confirmation_uncertain",
      };
    }
  }

  private questionResult(
    meta: ConversationMeta,
    record: QuestionRecord | undefined,
    status: ConversationQuestionResult["status"],
    reason?: string,
  ): ConversationQuestionResult {
    return {
      status,
      conversationId: meta.conversationId,
      revision: meta.revision,
      safeCursor: this.lastCursor(meta),
      ...(meta.questions ? { incarnationId: meta.questions.incarnationId } : {}),
      ...(record ? { question: structuredClone(record.question) } : {}),
      ...(reason ? { reason } : {}),
    };
  }

  public cancelPendingQuestion(conversationId: string, reason: string, originRunId?: string): void {
    const meta = this.metas.get(conversationId);
    if (!meta) return;
    this.validQuestionState(meta);
    const record = meta.questions?.records.find(
      (r) =>
        r.question.status === "pending" &&
        (originRunId === undefined || r.question.originRunId === originRunId),
    );
    if (!record) return;
    const before = structuredClone(meta);
    record.question.status = "cancelled";
    record.question.reason = reason;
    record.question.resolvedAt = new Date().toISOString();
    meta.revision += 1;
    try {
      this.saveQuestionMeta(meta);
    } catch (error) {
      if (!(error instanceof QuestionCommitError && error.committed)) Object.assign(meta, before);
      throw error;
    }
    this.questionIssuers.delete(record.question.requestId);
    this.publishQuestionResolution(meta, record);
  }

  public invalidateQuestionPrincipal(deviceId: string): void {
    for (const meta of this.metas.values()) {
      if (
        meta.questions?.records.some(
          (r) => r.question.status === "pending" && r.issuer.kind === "device" && r.issuer.id === deviceId,
        )
      )
        this.cancelPendingQuestion(meta.conversationId, "owner_context_lost");
    }
  }

  private publishQuestionResolution(meta: ConversationMeta, record: QuestionRecord): void {
    this.append(meta, {
      type: "input_resolved",
      requestId: record.question.requestId,
      outcome: record.question.status === "submitted" ? "submitted" : "cancelled",
    });
  }

  private async questionOperation(
    request: Extract<ConversationServiceRequest, { op: "input_get" | "input_answer" | "input_cancel" }>,
    authority: QuestionAuthority | undefined,
  ): Promise<ConversationQuestionResult> {
    await authorizeQuestion(authority);
    let meta = this.metas.get(request.conversationId);
    if (!meta)
      return { status: "refused", conversationId: request.conversationId, reason: "unknown_conversation" };
    this.validQuestionState(meta);
    let record = meta.questions?.records.find((r) =>
      request.requestId ? r.question.requestId === request.requestId : r.question.status === "pending",
    );
    if (record?.question.status === "pending") {
      const checkedRequestId = record.question.requestId;
      const issuer = this.questionIssuers.get(checkedRequestId);
      let lost = false;
      try {
        this.assertQuestionContext(meta, record);
        if (issuer) await authorizeQuestion(issuer);
        else lost = true;
      } catch {
        lost = true;
      }
      await authorizeQuestion(authority);
      meta = this.metas.get(request.conversationId);
      if (!meta)
        return { status: "refused", conversationId: request.conversationId, reason: "unknown_conversation" };
      this.validQuestionState(meta);
      record = meta.questions?.records.find((r) =>
        request.requestId ? r.question.requestId === request.requestId : r.question.status === "pending",
      );
      if (record && record.question.requestId !== checkedRequestId)
        return this.questionResult(meta, undefined, "refused", "context_changed");
      if (lost && record?.question.status === "pending")
        this.cancelPendingQuestion(meta.conversationId, "owner_context_lost");
    }
    if (request.op === "input_get")
      return this.questionResult(meta, record, "ready", record ? undefined : "unknown_request");
    if (!record || request.incarnationId !== meta.questions?.incarnationId)
      return this.questionResult(meta, undefined, "refused", "stale_request");
    if (record.projectCreation?.claim)
      return this.questionResult(meta, record, "refused", "project_confirmation_consumed");
    // Authenticated duplicate reconciliation precedes revision checks, never enqueue.
    if (record.question.status !== "pending") {
      if (
        request.op === "input_answer" &&
        record.question.status === "submitted" &&
        JSON.stringify(request.answer) !== JSON.stringify(record.question.answer)
      )
        return this.questionResult(meta, record, "refused", "conflicting_answer");
      return this.questionResult(meta, record, "resolved");
    }
    try {
      this.assertQuestionContext(meta, record);
    } catch {
      this.cancelPendingQuestion(meta.conversationId, "owner_context_lost");
      return this.questionResult(meta, record, "refused", "owner_context_lost");
    }
    if (request.expectedRevision !== meta.revision)
      return this.questionResult(meta, record, "revision_conflict");
    if (request.op === "input_cancel") {
      this.cancelPendingQuestion(meta.conversationId, "owner_cancelled");
      return this.questionResult(meta, record, "resolved");
    }
    const answer = request.answer;
    if (
      (answer.kind === "choice" && !record.question.options.some((o) => o.optionId === answer.optionId)) ||
      (answer.kind === "text" && !record.question.allowFreeform)
    )
      return this.questionResult(meta, record, "refused", "invalid_answer");
    const message = answerMessage(record.question, answer);
    try {
      this.enqueue(meta, message, undefined, false, this.runner, {
        origin: "input",
        delivery: "queue",
        ownerAuthority: authority!,
        questionBinding: { incarnationId: request.incarnationId, workspace: record.workspace },
        inputAnswer: { requestId: request.requestId, answer },
        questionAnswer: { record, answer, authority: authority! },
      });
    } catch (error) {
      // Read the durable boundary. An uncertain post-rename answer is consumed, never resubmitted.
      const stored = JSON.parse(
        readFileSync(join(this.root, meta.conversationId, "meta.json"), "utf8"),
      ) as ConversationMeta;
      const checked = QuestionStateSchema.parse(stored.questions);
      const receipt = checked.records.find((r) => r.question.requestId === request.requestId);
      if (!receipt || receipt.question.status !== "submitted") throw error;
      meta.questions = checked;
      record = receipt;
      meta.sessionState = (this.runCounts.get(meta.conversationId) ?? 0) > 0 ? "active" : "failed";
      if (record.question.continuation) {
        record.question.continuation.state = "failed";
        record.question.continuation.reasonCode = "acceptance_interrupted";
      }
      this.saveQuestionMeta(meta);
      this.wakeTails(meta.conversationId);
      return this.questionResult(meta, record, "resolved", "acceptance_interrupted");
    }
    this.questionIssuers.delete(request.requestId);
    return this.questionResult(meta, record, "resolved");
  }

  /** Narrow durable question commit; failure after rename is consumption uncertainty. */
  private saveQuestionMeta(meta: ConversationMeta): void {
    if (meta.questions) QuestionStateSchema.parse(meta.questions);
    const path = join(this.root, meta.conversationId, "meta.json");
    const temporary = `${path}.${randomUUID()}.tmp`;
    let committed = false;
    try {
      const file = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(file, JSON.stringify(meta, null, 2));
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      renameSync(temporary, path);
      committed = true;
      const directory = openSync(join(this.root, meta.conversationId), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch (error) {
      throw new QuestionCommitError(committed, error);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private saveMeta(meta: ConversationMeta): void {
    const path = join(this.root, meta.conversationId, "meta.json");
    writeFileSync(path + ".tmp", JSON.stringify(meta, null, 2), { mode: 0o600 });
    renameSync(path + ".tmp", path);
  }

  /**
   * Conversation is the sole session/log lifetime. Recent inactive rooms are
   * retained for explicit `--chat` resume; old rooms leave as one directory,
   * including their public event log and their one Pi session tree.
   */
  private prune(protectedConversationId?: string): void {
    const sideParents = new Set(
      [...this.metas.values()].flatMap((meta) =>
        meta.parentConversationId === undefined ? [] : [meta.parentConversationId],
      ),
    );
    const removable = (): ConversationMeta[] =>
      [...this.metas.values()]
        .filter(
          (meta) =>
            !meta.isDefault &&
            meta.conversationId !== LINEAR_INBOX_CONVERSATION_ID &&
            meta.sessionState !== "active" &&
            !this.seatSends.has(meta.conversationId) &&
            !sideParents.has(meta.conversationId) &&
            meta.conversationId !== protectedConversationId,
        )
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const cutoff = Date.now() - OPERATOR_CONVERSATION_RETENTION_MS;
    for (const meta of removable().filter((candidate) => Date.parse(candidate.updatedAt) < cutoff)) {
      this.remove(meta);
    }
    while (this.metas.size > OPERATOR_CONVERSATION_RETAINED_MAX) {
      const oldest = removable()[0];
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    while (this.retainedBytes() > OPERATOR_CONVERSATION_RETAINED_BYTES_MAX) {
      const oldest = removable()[0];
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  /**
   * Retire a projection's webhook in Discord, when it is one Clankie made. A
   * pasted webhook is the operator's and stays. Fire-and-forget: the local
   * change this rides on (unproject, re-project, delete) never waits on
   * Discord, and a webhook that cannot be reached now is deleted the next time
   * the operator prunes Server Settings, not a reason to keep the projection.
   */
  private discardProjection(discord: ConversationMeta["channelDiscord"]): void {
    if (discord?.provisioned !== true) return;
    void this.projection
      ?.remove?.({ webhookId: discord.webhookId, webhookToken: discord.webhookToken })
      .catch(() => {});
  }

  private remove(meta: ConversationMeta): void {
    if (!this.corruptQuestions.has(meta.conversationId))
      for (const record of meta.questions?.records ?? [])
        this.questionIssuers.delete(record.question.requestId);
    this.corruptQuestions.delete(meta.conversationId);
    this.discardProjection(meta.channelDiscord);
    rmSync(join(this.root, meta.conversationId), { recursive: true, force: true });
    this.metas.delete(meta.conversationId);
    this.chains.delete(meta.conversationId);
    this.runCounts.delete(meta.conversationId);
    this.internalRuns.delete(meta.conversationId);
    this.counts.delete(meta.conversationId);
    this.sequences.delete(meta.conversationId);
    this.journal.forget(meta.conversationId);
    this.onPrune?.(meta.conversationId, meta.scope);
  }

  private resetConversation(conversationId: string, expectedRevision: number): ConversationServiceResult {
    const meta = this.metas.get(conversationId);
    if (meta === undefined) throw new ConversationResetError("Unknown conversation");
    if (!this.runsCaptainTurns(conversationId) || meta.parentConversationId !== undefined) {
      throw new ConversationResetError(
        "Only Clankie's own global and workspace conversations can reset context",
      );
    }
    if (meta.revision !== expectedRevision)
      throw new ConversationResetError("Conversation changed; refresh before resetting context");
    if (
      (this.runCounts.get(conversationId) ?? 0) > 0 ||
      this.seatSends.has(conversationId) ||
      [...this.metas.values()].some((candidate) => candidate.parentConversationId === conversationId)
    ) {
      throw new ConversationResetError(
        "Wait for the current turn to finish and close side conversations before resetting context",
      );
    }
    this.cancelPendingQuestion(conversationId, "context_reset");
    const archiveId = `reset-${randomUUID()}`;
    const archiveRoot = join(dirname(this.root), "conversation-archives");
    const archive = join(archiveRoot, archiveId);
    const staging = join(archiveRoot, `${archiveId}.pending`);
    const live = join(this.root, conversationId);
    // Advance the replay boundary so every old cursor must recover, even the latest.
    const boundary = this.eventSequence(meta) + 1;
    const fresh: ConversationMeta = {
      conversationId,
      scope: meta.scope,
      title: meta.title,
      isDefault: meta.isDefault,
      createdAt: meta.createdAt,
      updatedAt: new Date().toISOString(),
      revision: meta.revision + 1,
      sessionState: "unbound",
      retainedFromCursor: String(boundary).padStart(CURSOR_WIDTH, "0"),
      questions: newQuestionState(),
      ...(meta.linearReadCursor === undefined ? {} : { linearReadCursor: meta.linearReadCursor }),
      ...(meta.linearWokeCursor === undefined ? {} : { linearWokeCursor: meta.linearWokeCursor }),
      ...(meta.linearAckVersion === undefined ? {} : { linearAckVersion: meta.linearAckVersion }),
      ...(meta.nativeSeatSessions === undefined
        ? {}
        : {
            nativeSeatSessions: Object.fromEntries(
              Object.keys(meta.nativeSeatSessions).map((id) => [id, "retired" as const]),
            ),
          }),
    };
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    writeFileSync(join(staging, "meta.json"), JSON.stringify(fresh, null, 2), { mode: 0o600 });
    renameSync(live, archive);
    try {
      this.onPrune?.(conversationId, meta.scope);
      renameSync(staging, live);
    } catch (error) {
      renameSync(archive, live);
      throw error;
    }
    this.metas.set(conversationId, fresh);
    this.chains.delete(conversationId);
    this.journal.forget(conversationId);
    this.counts.set(conversationId, 0);
    this.sequences.set(conversationId, boundary);
    this.drafts.delete(conversationId);
    this.wakeTails(conversationId);
    return { op: "reset", schemaVersion: 1, conversation: publicConversation(fresh), archiveId };
  }

  private async removeConversation(conversationId: string): Promise<boolean> {
    const meta = this.metas.get(conversationId);
    if (
      meta === undefined ||
      meta.isDefault ||
      meta.scope.kind === "room" ||
      this.seatSends.has(conversationId) ||
      [...this.metas.values()].some((candidate) => candidate.parentConversationId === conversationId)
    ) {
      return false;
    }
    if (meta.sessionState === "active" && meta.parentConversationId === undefined) return false;
    if (meta.parentConversationId !== undefined) {
      const activeRuns = [...this.runControllers.entries()].filter(
        ([, entry]) => entry.conversationId === conversationId,
      );
      for (const [runId, entry] of activeRuns) {
        this.cancelRequests.add(runId);
        entry.controller.abort();
      }
      await Promise.allSettled(
        activeRuns.flatMap(([runId]) => {
          const run = this.runs.get(runId);
          return run === undefined ? [] : [run];
        }),
      );
    }
    this.cancelPendingQuestion(conversationId, "conversation_closed");
    this.remove(meta);
    return true;
  }

  private retainedBytes(): number {
    return [...this.metas.keys()].reduce(
      (total, conversationId) => total + directoryBytes(join(this.root, conversationId)),
      0,
    );
  }
}

/**
 * The failure in words, cause chain included — an API rejection routinely puts
 * the only useful detail on `cause`, not on the outer error's own message.
 */
function turnFailureSummary(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    const text = current instanceof Error ? current.message.trim() : String(current).trim();
    if (text.length > 0 && parts[parts.length - 1] !== text) parts.push(text);
    current = current instanceof Error ? current.cause : undefined;
  }
  const summary = parts.join(": ");
  if (summary.length === 0) return "Turn failed with no error message.";
  return summary.length > OPERATOR_CONVERSATION_SUMMARY_MAX
    ? `${summary.slice(0, OPERATOR_CONVERSATION_SUMMARY_MAX - 1)}\u2026`
    : summary;
}

function directoryBytes(path: string): number {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return 0;
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path, { withFileTypes: true }).reduce(
    (total, entry) => total + (entry.isSymbolicLink() ? 0 : directoryBytes(join(path, entry.name))),
    0,
  );
}

function sameScope(a: OperatorConversationScope, b: OperatorConversationScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "room" && b.kind === "room") return a.lane === b.lane && a.targetId === b.targetId;
  if (a.kind === "workspace" && b.kind === "workspace") return a.workspaceId === b.workspaceId;
  if (a.kind === "persona" && b.kind === "persona") return a.personaId === b.personaId;
  if (a.kind === "seat" && b.kind === "seat") return a.seatId === b.seatId;
  if (a.kind === "channel" && b.kind === "channel") return a.channelId === b.channelId;
  return true;
}

function publicChannel(meta: ConversationMeta): OperatorChannel {
  if (meta.scope.kind !== "channel") {
    throw new Error(`Conversation ${meta.conversationId} is not a channel`);
  }
  return {
    schemaVersion: 1,
    channelId: meta.scope.channelId,
    conversationId: meta.conversationId,
    title: meta.title,
    members: (meta.channelMembers ?? []).map((member) => ({
      personaId: channelMemberPersonaId(member),
      position: member.position,
      joinedAt: member.joinedAt,
    })),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...(meta.channelDiscord === undefined
      ? {}
      : {
          discord: {
            guildId: meta.channelDiscord.guildId,
            channelId: meta.channelDiscord.channelId,
            ...(meta.channelDiscord.threadId === undefined ? {} : { threadId: meta.channelDiscord.threadId }),
            webhookId: meta.channelDiscord.webhookId,
          },
        }),
  };
}

/** Reads pre-ADR-0147 channel records without keeping seat identity in the public model. */
function channelMemberPersonaId(member: OperatorChannelMember): string {
  return member.personaId ?? (member as OperatorChannelMember & { readonly seatId: string }).seatId;
}

function publicConversation(meta: ConversationMeta): OperatorConversation {
  return {
    schemaVersion: 1,
    conversationId: meta.conversationId,
    scope: meta.scope,
    title: meta.title,
    isDefault: meta.isDefault,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    sessionState: meta.sessionState,
    revision: meta.revision,
    ...(meta.designatedHeadConversationId === undefined
      ? {}
      : { designatedHeadConversationId: meta.designatedHeadConversationId }),
    ...(meta.contextUsage === undefined ? {} : { contextUsage: meta.contextUsage }),
    ...(meta.parentConversationId === undefined ? {} : { parentConversationId: meta.parentConversationId }),
  };
}

class QuestionCommitError extends Error {
  readonly committed: boolean;
  constructor(committed: boolean, cause: unknown) {
    super("Question persistence unavailable; read its receipt before any further action", { cause });
    this.committed = committed;
  }
}
