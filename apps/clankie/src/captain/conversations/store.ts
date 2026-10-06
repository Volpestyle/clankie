import type { InboundReport } from "../conversations.ts";
import type { ConversationQuestionAnswer, ConversationQuestionResult } from "@clankie/protocol";
import {
  fleetDeliveryStage,
  OPERATOR_CONVERSATION_SUMMARY_MAX,
  OPERATOR_CONVERSATION_LIST_MAX,
  RoomHandoffMetadataSchema,
  CaptainChannelTurnResultSchema,
  type CaptainChannelTurnResult,
  type RoomHandoffMetadata,
  OPERATOR_CONVERSATION_TEXT_MAX,
  operatorConversationWindow,
  type DeliveryStage,
  type OperatorAttachmentUploadResult,
  type OperatorConversation,
  type OperatorConversationEventBody,
  type OperatorConversationLiveDraft,
  type OperatorConversationReactor,
  type OperatorConversationScope,
  type OperatorConversationStreamEvent,
  type OperatorDeliveredFile,
  type OperatorGoal,
  type ReplayOperatorConversationRequest,
  type ReplayOperatorConversationResult,
  type SubmitOperatorConversationTurn,
  type SubmitOperatorConversationTurnResult,
  type UpsertOperatorChannel,
  type WorkerReportPage,
} from "@clankie/protocol";
import { type ProjectProposalDraft, type ProjectProposalResult } from "@clankie/protocol/projects";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { type StoredOwnerAttachment } from "../../delivered-files.ts";
import { type LinearActivityEvent } from "../../linear-webhook.ts";
import { CHANNEL_ROUND_INTERRUPTED_NOTICE, type ChannelTranscriptEntry } from "../channel-turns.ts";
import { ConversationJournal } from "../conversation-journal.ts";
import {
  authorizeQuestion,
  newQuestionState,
  QuestionStateSchema,
  questionWorkspace,
  type QuestionAuthority,
  type QuestionDraft,
  type QuestionRecord,
} from "../conversation-questions.ts";
import { ConversationRunStalledError, ConversationServiceRun } from "../conversation-run.ts";
import type {
  HerdrSeatTranscript,
  HerdrTranscriptEntry,
  HerdrTranscriptMessage,
} from "../herdr-transcript.ts";
import type { HerdrAgentSnapshot } from "../herdr-watch.ts";
import { type projectOnboarding } from "../project-onboarding.ts";
import { SeatLinkInterruptedError } from "../seat-outbox.ts";
import {
  assertRoomUnclaimed,
  awaitSeatReply,
  channelEntries,
  channelMeta,
  channelRound,
  lastSeatEntry,
  liveProjection,
  projectChannelMessage,
  projectChannelNotice,
  provisionFleetProjection,
  resolveProjection,
  resolveSeatReply,
  submitProjectedMessage,
  upsertChannel,
} from "./channel-projection.ts";
import {
  CURSOR_WIDTH,
  DEFAULT_TAIL_WAIT_MS,
  InboundAcceptanceSchema,
  OPERATOR_CONVERSATION_RETAINED_BYTES_MAX,
  OPERATOR_CONVERSATION_RETAINED_EVENTS_AFTER_TRIM,
  OPERATOR_CONVERSATION_RETAINED_EVENTS_MAX,
  OPERATOR_CONVERSATION_RETAINED_MAX,
  OPERATOR_CONVERSATION_RETENTION_MS,
  PRESENCE_ERROR_MS,
  PRESENCE_NEW_MESSAGE_MS,
  SEAT_CONVERSATION_RETAINED_EVENTS_AFTER_TRIM,
  SEAT_CONVERSATION_RETAINED_EVENTS_MAX,
  ZERO_CURSOR,
} from "./constants.ts";
import { ConversationRefusedError, ConversationResetError, QuestionCommitError } from "./errors.ts";
import {
  directoryBytes,
  messageKey,
  publicChannel,
  publicConversation,
  sameScope,
  transcriptEventBody,
  turnFailureSummary,
  workspaceOf,
} from "./helpers.ts";
import {
  discardLinearWake,
  flushLinearActivity,
  freshLinearEvents,
  linearWakePrompt,
  linearWakeTargetAllowed,
  loadLinearEventReceipts,
  queueLinearActivity,
  receiveLinearActivity,
  retireLinearInbox,
  saveLinearEventReceipts,
} from "./linear-wakes.ts";
import {
  attachedConversationForNative,
  bindPersona,
  conversationForPersona,
  conversationIdForPersona,
  conversationIdForSeat,
  hasNativeSeat,
  metaForPersona,
  nameRoomConversation,
  nativeAnnotations,
  nativeConversationForSeat,
  nativeSource,
  pollConversationDriver,
  publishConversationEvent,
  publishFleetPeerExchange,
  publishHeadEvent,
  publishPersonaEvent,
  publishRoomEvent,
  publishSeatEvent,
  reactToNativeEntry,
  rememberNativeHead,
  rememberNativeSource,
  renamePersona,
  roomConversation,
  runWithConversationDriver,
  seatIds,
  syncHeadTranscript,
  syncNativeSeatTranscript,
  syncRoomTranscript,
  syncSeatTranscript,
} from "./native-seats.ts";
import {
  assertQuestionContext,
  cancelPendingQuestion,
  invalidateQuestionPrincipal,
  projectProposalOperation,
  proposeProjectCreate,
  publishQuestionResolution,
  questionOperation,
  questionResult,
  requestQuestion,
  saveQuestionMeta,
  validQuestionState,
} from "./questions.ts";
import {
  completeTranscriptImage,
  publishImages,
  publishNamedImages,
  publishTranscriptImages,
  queueDeliveredImages,
  resettle,
  syncConversationTranscript,
} from "./transcripts.ts";
import {
  type ChannelProjection,
  type ConversationDriver,
  type ConversationForker,
  type ConversationMeta,
  type ConversationRunner,
  type ConversationServiceRequest,
  type ConversationServiceResult,
  type ConversationTurnContext,
  type DeliveredFilePublisher,
  type DeliveryAdmission,
  type DurableMessageNotice,
  type InboundAcceptance,
  type InboundReceiptInput,
  type OwnerAttachmentHost,
  type PersonaPresentation,
  type PersonaSeatResolver,
  type SeatEdgeReporter,
  type SeatSender,
} from "./types.ts";
import {
  acknowledgeInboundReports,
  hasUnreadInboundReports,
  inboundReports,
  notifyInboundReportChange,
  readInboundReports,
  recordInboundReportDelivery,
  restoreInboundReports,
  retryInboundReport,
} from "./worker-reports.ts";

/**
 * File-backed conversation registry: `meta.json` + append-only `events.jsonl`
 * per conversation. The wire contract (list/get/create/close/replay/tail/send with
 * revision fencing and cursored pages) is the one the TUI and relay speak.
 * Cursors are zero-padded line counts.
 */
export function roomHandoffConversationId(roomConversationId: string, deliveryId: string): string {
  return `handoff-${createHash("sha256").update(`${roomConversationId}:${deliveryId}`).digest("hex").slice(0, 32)}`;
}

export class ConversationStore {
  /** Live outbox binding, never inferred from a remembered transcript. */
  public nativeTurnDelivery?: (conversationId: string) => boolean;
  /** Roster/inbox observers see progress independently of a worker's pane lifetime. */
  public onInboundReportChange?: () => void;
  private readonly metas = new Map<string, ConversationMeta>();
  /**
   * Live durable-message observers, for delivery that happens outside the
   * conversation (push wakes, ADR 0159). Per store: a second store — another
   * service instance, or a test's own — has its own transcripts, and a wake it
   * caused would name a conversation this one's devices cannot open.
   */
  private readonly durableMessageListeners = new Set<(notice: DurableMessageNotice) => void>();
  /** Live owner-facing activity only; never rebuilt by scanning retained transcripts. */
  private recentPresenceMessage: number | undefined;
  private recentPresenceError: { conversationId: string; at: number } | undefined;
  private readonly chains = new Map<string, Promise<void>>();
  private readonly runs = new Map<string, Promise<boolean>>();
  private readonly deliveryAdmissions = new Map<
    string,
    {
      readonly promise: Promise<DeliveryAdmission>;
      readonly resolve: (outcome: DeliveryAdmission) => void;
    }
  >();
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
  private readonly linearHookTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Provider delivery receipts outlive conversation history and target changes. */
  private linearEventReceipts: Record<string, number> = {};
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
  /** Releases waiting readers while close drains the already accepted work. */
  private readonly tailShutdown = new AbortController();
  /** The message the captain is typing right now, per conversation. Never durable. */
  private readonly drafts = new Map<string, OperatorConversationLiveDraft>();
  /** Serializes host file reads so transcript order survives async publication. */
  private readonly deliveredFilePublishes = new Map<string, Promise<void>>();
  private readonly channelProjectionCreates = new Map<string, Promise<void>>();
  private readonly pendingTranscriptImages = new Set<string>();
  private readonly transcriptImageAttempts = new Map<string, number>();
  private draftSequence = 0;
  private readonly questionIssuers = new Map<string, QuestionAuthority>();
  private readonly corruptQuestions = new Set<string>();
  /** Native seat binding is owned by captain; no native question continuation. */
  public questionEligible: (id: string) => boolean = () => true;
  public projectOnboarding: ReturnType<typeof projectOnboarding> | undefined;
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
    this.loadLinearEventReceipts();
    this.retireLinearInbox();
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
        this.restoreInboundReports(meta);
        const legacy = meta as unknown as Record<string, unknown>;
        const retired = [
          "linearReadCursor",
          "linearOfferedCursor",
          "linearAckVersion",
          "linearWokeCursor",
          "linearWakePending",
          "linearSeen",
          "linearAdmissions",
        ];
        if (retired.some((key) => key in legacy)) {
          for (const key of retired) delete legacy[key];
          this.saveMeta(meta);
        }
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
        if (meta.roomHandoff !== undefined) {
          meta.roomHandoff = RoomHandoffMetadataSchema.parse(meta.roomHandoff);
          if (["pending", "running", "waiting_user"].includes(meta.roomHandoff.state)) {
            meta.roomHandoff = {
              ...meta.roomHandoff,
              state: "failed",
              doing: undefined,
              result: "Service restarted; this handoff was not replayed.",
            };
            meta.sessionState = "failed";
            meta.roomHandoffResult = {
              state: "failed",
              code: "room_handoff_interrupted",
              turnId: meta.conversationId,
            };
            meta.updatedAt = new Date().toISOString();
            meta.revision += 1;
            this.append(meta, { type: "session", phase: "failed" });
            this.saveMeta(meta);
          }
        }
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
      if (meta.parentConversationId !== undefined && !this.hasUnreadInboundReports(meta)) this.remove(meta);
    }
    this.ensureDefaultGlobalConversation();
    for (const meta of this.metas.values()) {
      if (meta.linearWakeCheckpoint) {
        const completed =
          meta.linearWakeCheckpoint.runId &&
          this.readEvents(meta.conversationId).some(
            (event) =>
              event.type === "turn" &&
              event.runId === meta.linearWakeCheckpoint!.runId &&
              event.phase === "completed",
          );
        if (!completed) meta.linearWakeCursor = meta.linearWakeCheckpoint.previous;
        delete meta.linearWakeCheckpoint;
        this.saveMeta(meta);
      }
    }
    this.prune();
    for (const meta of this.metas.values())
      if (
        this.linearWakeTargetAllowed(meta.conversationId) &&
        this.freshLinearEvents(meta.conversationId).length
      )
        this.queueLinearActivity(meta.conversationId);
  }

  private loadLinearEventReceipts(): void {
    return loadLinearEventReceipts(this);
  }

  private saveLinearEventReceipts(): void {
    return saveLinearEventReceipts(this);
  }

  /** Retire the old reading room once; retained IDs still prevent provider replay. */
  private retireLinearInbox(): void {
    return retireLinearInbox(this);
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
    readSignal?: AbortSignal,
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
          // or where no managed server is set: the compose screen still opens, and
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
        readSignal?.throwIfAborted();
        this.tailShutdown.signal.throwIfAborted();
        // Hanging long-poll: a page with no news parks until this conversation
        // changes (or the wait elapses), so an idle tail costs one request per
        // wait window instead of one per client poll interval, and a live draft
        // reaches the surface as fast as the round trip allows. "No news" means
        // no unseen event AND no draft the caller has not already drawn.
        let result = this.replay(request.tail);
        const waitMs = Math.min(request.tail.waitMs ?? 0, this.tailWaitMs);
        if (waitMs > 0 && result.status === "page" && result.events.length === 0 && !result.hasMore) {
          if ((result.live?.sequence ?? 0) === (request.tail.liveSequence ?? 0)) {
            await this.waitForChange(request.tail.conversationId, waitMs, readSignal);
            readSignal?.throwIfAborted();
            this.tailShutdown.signal.throwIfAborted();
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

  /** A native head remains native while its channel is offline. */
  public hasNativeSeat(conversationId: string): boolean {
    return hasNativeSeat(this, conversationId);
  }

  /** Retain host-observed head ownership without changing transcript checkpoints. */
  public rememberNativeHead(conversationId: string, occupantId: string): void {
    return rememberNativeHead(this, conversationId, occupantId);
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

  /** Bounded event signals; an unrelated successful thread cannot hide a failed turn. */
  public recentPresenceActivity(): { newMessage: boolean; error: boolean } {
    const now = Date.now();
    return {
      newMessage:
        this.recentPresenceMessage !== undefined &&
        now >= this.recentPresenceMessage &&
        now - this.recentPresenceMessage < PRESENCE_NEW_MESSAGE_MS,
      error:
        this.recentPresenceError !== undefined &&
        this.metas.has(this.recentPresenceError.conversationId) &&
        now >= this.recentPresenceError.at &&
        now - this.recentPresenceError.at < PRESENCE_ERROR_MS,
    };
  }

  /** Oldest unanswered owner preference, read from canonical question receipts. */
  public pendingPresenceOwnerItem(): import("../../../../../packages/protocol/src/presence.ts").OperatorPresenceSnapshot["pendingOwnerItem"] {
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

  /** A configured Linear target is an ordinary owner-openable global chat. */
  public linearWakeTargetAllowed(conversationId: string): boolean {
    return linearWakeTargetAllowed(this, conversationId);
  }

  public receiveLinearActivity(
    input: LinearActivityEvent,
    following: boolean,
    conversationId = "global-default",
  ): boolean {
    return receiveLinearActivity(this, input, following, conversationId);
  }

  private queueLinearActivity(id: string): void {
    return queueLinearActivity(this, id);
  }

  private flushLinearActivity(id: string): void {
    return flushLinearActivity(this, id);
  }

  private freshLinearEvents(id: string) {
    return freshLinearEvents(this, id);
  }

  /** Following disabled before admission consumes the queued wake without running it. */
  public discardLinearWake(id: string): void {
    return discardLinearWake(this, id);
  }

  /** Compact verified context is prepared when the queued chat turn starts. */
  public linearWakePrompt(id = "global-default", runId?: string): string | undefined {
    return linearWakePrompt(this, id, runId);
  }

  public conversationIdForSeat(seatId: string): string | undefined {
    return conversationIdForSeat(this, seatId);
  }

  private metaForPersona(personaId: string): ConversationMeta | undefined {
    return metaForPersona(this, personaId);
  }

  public conversationIdForPersona(personaId: string): string | undefined {
    return conversationIdForPersona(this, personaId);
  }

  /**
   * The persona's durable thread, for surfaces that order an inbox by what
   * happened last. `updatedAt` is the whole record's last activity — an
   * operator turn, a run settling, or a folded seat transcript all move it —
   * so it says when this thread last had something to show.
   */
  public conversationForPersona(personaId: string): OperatorConversation | undefined {
    return conversationForPersona(this, personaId);
  }

  public renamePersona(personaId: string, title: string): void {
    return renamePersona(this, personaId, title);
  }

  /**
   * Bind a durable character to its current seat and carry any legacy seat DM
   * and channel membership forward without copying or splitting transcripts.
   */
  public bindPersona(personaId: string, seatId: string, title: string): string {
    return bindPersona(this, personaId, seatId, title);
  }

  public seatIds(): readonly string[] {
    return seatIds(this);
  }

  public publishPersonaEvent(personaId: string, seatId: string, body: OperatorConversationEventBody): void {
    return publishPersonaEvent(this, personaId, seatId, body);
  }

  /** Legacy test/API path while persisted seat scopes migrate on discovery. */
  public publishSeatEvent(seatId: string, body: OperatorConversationEventBody): void {
    return publishSeatEvent(this, seatId, body);
  }

  /** Peer exchanges are visible context, never inbound owner turns or seat replies. */
  public publishFleetPeerExchange(text: string): void {
    return publishFleetPeerExchange(this, text);
  }

  private publishConversationEvent(
    conversationId: string | undefined,
    body: OperatorConversationEventBody,
  ): void {
    return publishConversationEvent(this, conversationId, body);
  }

  public nativeAnnotations(conversationId: string): readonly OperatorConversationStreamEvent[] {
    return nativeAnnotations(this, conversationId);
  }

  public reactToNativeEntry(
    conversationId: string,
    entryRef: string,
    emoji: string,
    remove: boolean,
  ): boolean {
    return reactToNativeEntry(this, conversationId, entryRef, emoji, remove);
  }

  public nativeSource(conversationId: string): HerdrAgentSnapshot | undefined {
    return nativeSource(this, conversationId);
  }

  /** Reuse the current persona thread after legacy seat-scope migration. */
  public nativeConversationForSeat(source: HerdrAgentSnapshot): OperatorConversation | undefined {
    return nativeConversationForSeat(this, source);
  }

  /** Existing authenticated transcript attachment, never a pane/title guess. */
  public attachedConversationForNative(source: HerdrAgentSnapshot): string | undefined {
    return attachedConversationForNative(this, source);
  }

  public rememberNativeSource(conversationId: string, source: HerdrAgentSnapshot): void {
    return rememberNativeSource(this, conversationId, source);
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
    prepare?: () => Promise<void>,
  ): Promise<T> {
    return pollConversationDriver(this, conversationId, poll, signal, prepare);
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
    return runWithConversationDriver(this, conversationId, driver, service, signal);
  }

  /** One inspectable conversation per room, irrespective of its execution authority. */
  public roomConversation(lane: "discord_presence" | "discord_voice", targetId: string): string {
    return roomConversation(this, lane, targetId);
  }

  /** Host-observed Discord names affect discovery only, never room authority. */
  public nameRoomConversation(conversationId: string, title: string): void {
    return nameRoomConversation(this, conversationId, title);
  }

  /** Metadata changes are part of the fleet cursor as well as the child event journal. */
  public onRoomHandoffChange?: () => void;
  private readonly liveRoomHandoffs = new Set<string>();

  public findRoomHandoff(
    roomConversationId: string,
    deliveryId: string,
    fingerprint: string,
  ): { conversation: OperatorConversation; result?: CaptainChannelTurnResult } | undefined {
    const meta = this.metas.get(roomHandoffConversationId(roomConversationId, deliveryId));
    if (meta === undefined) return undefined;
    if (meta.roomHandoffFingerprint !== fingerprint) throw new Error("room_handoff_delivery_conflict");
    return {
      conversation: publicConversation(meta),
      ...(meta.roomHandoffResult === undefined
        ? {}
        : { result: CaptainChannelTurnResultSchema.parse(meta.roomHandoffResult) }),
    };
  }

  public beginRoomHandoff(
    metadata: RoomHandoffMetadata,
    fingerprint: string,
    admitted = false,
  ): OperatorConversation {
    const checked = RoomHandoffMetadataSchema.parse(metadata);
    const room = this.metas.get(checked.roomConversationId);
    if (room?.scope.kind !== "room" || room.roomHandoff !== undefined)
      throw new Error("Expected canonical parent room");
    const id = roomHandoffConversationId(room.conversationId, checked.deliveryId);
    const existing = this.metas.get(id);
    if (existing !== undefined) {
      if (existing.roomHandoffFingerprint !== fingerprint) throw new Error("room_handoff_delivery_conflict");
      if (admitted) this.liveRoomHandoffs.add(id);
      return publicConversation(existing);
    }
    if (admitted) this.liveRoomHandoffs.add(id);
    const meta = this.create(
      room.scope,
      `${checked.actorName ?? checked.actorId} · ${checked.request}`.slice(0, 200),
      id,
      checked,
    );
    meta.roomHandoffFingerprint = fingerprint;
    meta.sessionState = "waiting";
    meta.revision += 1;
    this.append(meta, { type: "message", role: "external", text: checked.request, streaming: false });
    this.saveMeta(meta);
    this.onRoomHandoffChange?.();
    return publicConversation(meta);
  }

  public updateRoomHandoff(
    conversationId: string,
    patch: Partial<Pick<RoomHandoffMetadata, "state" | "doing" | "host" | "nativeChildSessionId" | "result">>,
    result?: CaptainChannelTurnResult,
  ): void {
    const meta = this.metas.get(conversationId);
    if (meta?.roomHandoff === undefined) throw new Error("Unknown room handoff");
    const next = RoomHandoffMetadataSchema.parse({ ...meta.roomHandoff, ...patch });
    if (JSON.stringify(meta.roomHandoff) === JSON.stringify(next) && result === undefined) return;
    meta.roomHandoff = next;
    if (result !== undefined) {
      meta.roomHandoffResult = CaptainChannelTurnResultSchema.parse(result);
      this.liveRoomHandoffs.delete(conversationId);
    }
    meta.sessionState =
      next.state === "running"
        ? "active"
        : next.state === "completed"
          ? "completed"
          : next.state === "failed"
            ? "failed"
            : "waiting";
    meta.updatedAt = new Date().toISOString();
    meta.revision += 1;
    this.append(meta, {
      type: "session",
      phase:
        next.state === "running"
          ? "started"
          : next.state === "completed"
            ? "completed"
            : next.state === "failed"
              ? "failed"
              : "waiting",
    });
    this.saveMeta(meta);
    if (result !== undefined) this.prune(conversationId);
    this.onRoomHandoffChange?.();
  }

  public roomHandoffs(): OperatorConversation[] {
    return [...this.metas.values()]
      .filter((meta) => meta.roomHandoff !== undefined)
      .sort((a, b) => {
        const live = (meta: ConversationMeta) =>
          ["pending", "running", "waiting_user"].includes(meta.roomHandoff!.state);
        return Number(live(b)) - Number(live(a)) || b.updatedAt.localeCompare(a.updatedAt);
      })
      .slice(0, OPERATOR_CONVERSATION_LIST_MAX)
      .map(publicConversation);
  }

  /** Bounded room history is quoted context; no tool bank or grant crosses this boundary. */
  public roomHandoffContext(roomConversationId: string, excludeDeliveryId: string): string {
    const oldMessages = this.readEvents(roomConversationId)
      .filter((event) => event.type === "message")
      .slice(-12)
      .map((event) =>
        event.type === "message" ? `[${event.occurredAt}] ${event.role}: ${event.text.slice(0, 1_000)}` : "",
      );
    const handoffs = [...this.metas.values()]
      .filter(
        (meta) =>
          meta.roomHandoff?.roomConversationId === roomConversationId &&
          meta.roomHandoff.deliveryId !== excludeDeliveryId,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-12)
      .map((meta) => {
        const handoff = meta.roomHandoff!;
        return (
          `[${meta.createdAt}] <${handoff.actorId}> ${handoff.request.slice(0, 1_000)}\n` +
          `Handoff ${handoff.state}${handoff.result === undefined ? "" : `: ${handoff.result.slice(0, 1_000)}`}`
        );
      });
    return [...oldMessages, ...handoffs].join("\n\n").slice(-12_000);
  }

  public syncRoomTranscript(conversationId: string, transcript: HerdrSeatTranscript): void {
    return syncRoomTranscript(this, conversationId, transcript);
  }

  public publishRoomEvent(conversationId: string, body: OperatorConversationEventBody): void {
    return publishRoomEvent(this, conversationId, body);
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
    return syncHeadTranscript(this, seatId, transcript, workingDirectory);
  }

  public syncNativeSeatTranscript(
    conversationId: string,
    sessionId: string,
    entries: HerdrSeatTranscript["entries"],
    activity?: "responding" | "waiting",
  ): boolean {
    return syncNativeSeatTranscript(this, conversationId, sessionId, entries, activity);
  }

  public publishHeadEvent(body: OperatorConversationEventBody): void {
    return publishHeadEvent(this, body);
  }

  /** Legacy test/API path while persisted seat scopes migrate on discovery. */
  public syncSeatTranscript(seatId: string, transcript: HerdrSeatTranscript): void {
    return syncSeatTranscript(this, seatId, transcript);
  }

  private syncConversationTranscript(
    conversationId: string | undefined,
    seatId: string,
    transcript: HerdrSeatTranscript,
    agentRole: "agent" | "captain" = "agent",
    workingDirectory?: string,
  ): void {
    return syncConversationTranscript(this, conversationId, seatId, transcript, agentRole, workingDirectory);
  }

  /**
   * A seat's `waiting` is written when its pane's status changes, and a surface
   * reads everything after it as a turn still in progress. A harness flushes
   * entries after its pane has settled, and a named image lands later still, so
   * a thread that was settled before them is settled again behind them. While
   * the seat works its last activity is `responding`, and this does nothing.
   */
  private resettle(meta: ConversationMeta): void {
    return resettle(this, meta);
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
    return publishTranscriptImages(this, meta, transcript, workingDirectory);
  }

  private publishNamedImages(meta: ConversationMeta, text: string, workingDirectory: string): void {
    return publishNamedImages(this, meta, text, workingDirectory);
  }

  private queueDeliveredImages(
    meta: ConversationMeta,
    paths: readonly string[],
    workingDirectory: string,
  ): Promise<boolean> {
    return queueDeliveredImages(this, meta, paths, workingDirectory);
  }

  private async publishImages(
    meta: ConversationMeta,
    paths: readonly string[],
    workingDirectory: string,
  ): Promise<boolean> {
    return publishImages(this, meta, paths, workingDirectory);
  }

  private completeTranscriptImage(meta: ConversationMeta, sessionKey: string, entryId: string): void {
    return completeTranscriptImage(this, meta, sessionKey, entryId);
  }

  /** Queue a host-authored continuation without forging an operator message. */
  public submitInternal(
    conversationId: string,
    message: string,
    origin: NonNullable<ConversationTurnContext["origin"]>,
    expectedGoal?: OperatorGoal,
    delivery?: ConversationTurnContext["delivery"],
  ): SubmitOperatorConversationTurnResult {
    const meta = this.metas.get(conversationId);
    if (meta === undefined) throw new Error(`Unknown conversation ${conversationId}`);
    if (!this.runsCaptainTurns(conversationId)) {
      throw new Error(`Conversation ${conversationId} does not run captain turns`);
    }
    return this.enqueue(meta, message, undefined, false, this.runner, {
      origin,
      ...(expectedGoal === undefined ? {} : { expectedGoal }),
      ...(delivery === undefined ? {} : { delivery }),
    });
  }

  private restoreInboundReports(meta: ConversationMeta): void {
    return restoreInboundReports(this, meta);
  }

  private hasUnreadInboundReports(meta: ConversationMeta): boolean {
    return hasUnreadInboundReports(meta);
  }

  private notifyInboundReportChange(): void {
    return notifyInboundReportChange(this);
  }

  /** Retained reports survive event trimming, restart and a vanished worker pane. */
  public inboundReports(conversationId?: string, options: { includeRead?: boolean } = {}): InboundReport[] {
    return inboundReports(this, conversationId, options);
  }

  /** Offering full, bounded payloads does not mark them read. */
  public readInboundReports(
    conversationId: string,
    options: { limit?: number | undefined } = {},
  ): WorkerReportPage {
    return readInboundReports(this, conversationId, options);
  }

  /** An authenticated recipient explicitly acknowledges only reports it was offered. */
  public acknowledgeInboundReports(conversationId: string, deliveryIds: readonly string[]): boolean {
    return acknowledgeInboundReports(this, conversationId, deliveryIds);
  }

  /** A native transport receipt is progress, never an acknowledgment that the lead read it. */
  public recordInboundReportDelivery(deliveryId: string, stage: DeliveryStage): boolean {
    return recordInboundReportDelivery(this, deliveryId, stage);
  }

  /** Retry only definite non-dispatch; the host must revalidate the saved recipient first. */
  public retryInboundReport(
    deliveryId: string,
    admittedRunner: ConversationRunner,
  ): SubmitOperatorConversationTurnResult | undefined {
    return retryInboundReport(this, deliveryId, admittedRunner);
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
    receipt: InboundReceiptInput,
    /** The service resolves this target; inbound worker content cannot select it. */
    conversationId = "global-default",
    /** Host-selected room/native runner; clients cannot select execution authority. */
    admittedRunner?: ConversationRunner,
  ): SubmitOperatorConversationTurnResult {
    const meta = this.metas.get(conversationId);
    if (!meta) throw new Error(`Unknown conversation ${conversationId}`);
    const native = meta.scope.kind === "seat" || meta.scope.kind === "persona";
    const runner = admittedRunner ?? (meta.scope.kind === "room" || native ? undefined : this.runner);
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
    this.tailShutdown.abort(new DOMException("Conversation tails are closed", "AbortError"));
    for (const conversationId of this.tailListeners.keys()) this.wakeTails(conversationId);
    for (const id of this.linearHookTimers.keys()) this.flushLinearActivity(id);
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
    roomHandoff?: RoomHandoffMetadata,
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
      ...(roomHandoff === undefined ? {} : { roomHandoff }),
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
    return upsertChannel(this, request);
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
    return resolveProjection(this, choice, channelId, title);
  }

  /** Refuses a Discord channel or forum post another Clankie room already uses. */
  private assertRoomUnclaimed(discordRoomId: string, exceptChannelId: string): void {
    return assertRoomUnclaimed(this, discordRoomId, exceptChannelId);
  }

  /**
   * A room's projection, but only while it still points inside the managed server.
   * Records outlive the setting that admitted them: a guild dropped as the
   * managed server, or one projected before this fence existed, must stop routing
   * and stop posting immediately rather than at the next edit. No managed server
   * set means no projection is live at all.
   */
  private liveProjection(meta: ConversationMeta): ConversationMeta["channelDiscord"] {
    return liveProjection(this, meta);
  }

  private channelMeta(channelId: string): ConversationMeta | undefined {
    return channelMeta(this, channelId);
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
    const { events: page, remaining } = this.journal.after(meta.conversationId, from, limit);
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
    const result = this.enqueue(
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
    if (
      turn.delivery === undefined ||
      meta.scope.kind === "channel" ||
      result.status !== "accepted" ||
      result.seatDelivery
    )
      return result;
    const admission = this.deliveryAdmissions.get(result.runId);
    if (!admission) return result;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        admission.promise,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), 10_000);
        }),
      ]);
      if (outcome === undefined || outcome.state === "rejected" || outcome.state === "uncertain")
        return {
          schemaVersion: 1,
          status:
            outcome === undefined || outcome.state === "uncertain"
              ? "seat_delivery_unconfirmed"
              : "seat_undelivered",
          deliveryStage: outcome === undefined || outcome.state === "uncertain" ? "uncertain" : "rejected",
          conversationId: meta.conversationId,
          currentRevision: meta.revision,
          safeCursor: this.lastCursor(meta),
          detail:
            outcome?.detail ??
            "The original native send has no acknowledgment. Check the thread before sending again.",
        };
      return {
        ...result,
        deliveryStage: outcome.state === "queued" ? "stored" : "delivered",
        seatDelivery: outcome,
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.deliveryAdmissions.delete(result.runId);
    }
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
    return submitProjectedMessage(this, guildId, channelId, message);
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
    return channelRound(this, echoOperator);
  }

  /**
   * Say in the guild what the transcript has no business recording: that a
   * round reached nobody. It is authored by the room rather than by a member,
   * because no member said it, and it is deliberately not published — the
   * record holds what was said, not why nothing was.
   */
  private async projectChannelNotice(meta: ConversationMeta, notice: string): Promise<void> {
    return projectChannelNotice(this, meta, notice);
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
    return projectChannelMessage(this, meta, personaId, content);
  }

  private async provisionFleetProjection(meta: ConversationMeta): Promise<void> {
    return provisionFleetProjection(this, meta);
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
    return lastSeatEntry(this, conversationId);
  }

  private channelEntries(conversationId: string): readonly ChannelTranscriptEntry[] {
    return channelEntries(this, conversationId);
  }

  /**
   * Park until this seat says its next thing, or until the turn times out and
   * counts as a pass. The reply arrives through the same herdr projection that
   * feeds the seat's own thread, so a channel adds no second way of listening
   * to an agent.
   */
  private awaitSeatReply(seatId: string, signal: AbortSignal): Promise<string | undefined> {
    return awaitSeatReply(this, seatId, signal);
  }

  private resolveSeatReply(seatId: string, text: string): void {
    return resolveSeatReply(this, seatId, text);
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
            ...(turn.delivery === undefined ? {} : { delivery: turn.delivery }),
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
      | "origin"
      | "expectedGoal"
      | "surfaceClientId"
      | "attachments"
      | "ownerAuthority"
      | "questionBinding"
      | "inputAnswer"
    > & {
      questionAnswer?: {
        readonly record: QuestionRecord;
        readonly answer: ConversationQuestionAnswer;
        readonly authority: QuestionAuthority;
      };
      delivery?: SubmitOperatorConversationTurn["delivery"];
      inboundReceipt?: InboundReceiptInput;
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
          acceptedAt:
            meta.inboundAcceptances?.[provenance.inboundReceipt.deliveryId]?.acceptedAt ?? meta.updatedAt,
          reportDelivery: {
            ...meta.inboundAcceptances?.[provenance.inboundReceipt.deliveryId]?.reportDelivery,
            state: "pending",
            stage: "stored",
          },
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
    if (provenance.inboundReceipt) this.notifyInboundReportChange();
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

    const nativeDelivery =
      provenance.delivery !== undefined && this.nativeTurnDelivery?.(meta.conversationId) === true;
    const queued =
      !nativeDelivery &&
      provenance.delivery === "queue" &&
      (this.runCounts.get(meta.conversationId) ?? 0) > 0;
    if (provenance.delivery !== undefined && !queued) {
      let resolve!: (outcome: DeliveryAdmission) => void;
      const promise = new Promise<DeliveryAdmission>((settle) => {
        resolve = settle;
      });
      this.deliveryAdmissions.set(runId, { promise, resolve });
    }
    const conversationId = meta.conversationId;
    this.runCounts.set(conversationId, (this.runCounts.get(conversationId) ?? 0) + 1);
    const controller = new AbortController();
    this.runControllers.set(runId, { conversationId, controller });
    // Explicit steering joins the active invocation, including its Pi startup.
    // An explicit queue always waits; older callers retain automatic steering
    // into autonomous turns. Merely queued work never opens a live lane.
    const joinLive =
      publishOperatorMessage &&
      (nativeDelivery ||
        (provenance.delivery === "steer"
          ? (this.activeInvocations.get(conversationId) ?? 0) > 0
          : provenance.delivery !== "queue" && (this.internalRuns.get(conversationId) ?? 0) > 0));

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
      // Cancelled while still queued: settle without ever invoking the runner.
      if (controller.signal.aborted) return Promise.resolve();
      if (provenance.inboundReceipt) {
        const receipt = meta.inboundAcceptances![provenance.inboundReceipt.deliveryId]!;
        if (receipt.reportDelivery?.state === "read") return Promise.resolve();
        const previousDelivery = receipt.reportDelivery;
        // This is the last durable boundary before calling the transport. A
        // crash after it leaves uncertainty, which cannot authorize a replay.
        receipt.reportDelivery = {
          ...receipt.reportDelivery,
          state: "attempting",
          stage: "uncertain",
          attemptedAt: new Date().toISOString(),
        };
        try {
          this.saveMeta(meta);
        } catch (error) {
          receipt.reportDelivery = previousDelivery;
          throw error;
        }
        this.notifyInboundReportChange();
      }
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
          ...(provenance.delivery === undefined ? {} : { delivery: provenance.delivery }),
          deliveryOutcome: (outcome) => this.deliveryAdmissions.get(runId)?.resolve(outcome),
          deliveryReceipt: (stage) => {
            deliveryStage = stage;
            if (provenance.inboundReceipt)
              this.recordInboundReportDelivery(provenance.inboundReceipt.deliveryId, stage);
          },
          signal: controller.signal,
          draft: (text) => {
            this.setLiveDraft(conversationId, text);
          },
          ...(publishOperatorMessage ? {} : { internal: true as const }),
          ...(provenance.origin === undefined ? {} : { origin: provenance.origin }),
          ...(provenance.expectedGoal === undefined ? {} : { expectedGoal: provenance.expectedGoal }),
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
        if (provenance.inboundReceipt && invoked && deliveryStage === undefined)
          this.recordInboundReportDelivery(provenance.inboundReceipt.deliveryId, "uncertain");
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
        if (provenance.origin === "hook" && !invoked) this.linearHookQueued.delete(conversationId);
        if (provenance.origin === "hook" && meta.linearWakeCheckpoint) {
          if (cancelled) meta.linearWakeCursor = meta.linearWakeCheckpoint.previous;
          delete meta.linearWakeCheckpoint;
        }
        if ((this.runCounts.get(conversationId) ?? 0) <= 1) meta.sessionState = "waiting";
        return !cancelled;
      })
      .catch((error: unknown) => {
        if (provenance.inboundReceipt && invoked && deliveryStage === undefined)
          this.recordInboundReportDelivery(provenance.inboundReceipt.deliveryId, "uncertain");
        if (provenance.origin === "hook" && !meta.linearWakeCheckpoint)
          this.linearHookQueued.delete(conversationId);
        if (provenance.origin === "hook" && meta.linearWakeCheckpoint) {
          meta.linearWakeCursor = meta.linearWakeCheckpoint.previous;
          delete meta.linearWakeCheckpoint;
        }
        this.deliveryAdmissions.get(runId)?.resolve({
          state: "uncertain",
          detail: turnFailureSummary(error).slice(0, OPERATOR_CONVERSATION_SUMMARY_MAX),
        });
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
        this.deliveryAdmissions.get(runId)?.resolve({
          state: "uncertain",
          detail:
            "The native turn ended without acknowledging this message. Check the thread before sending again.",
        });
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
      ...(queued ? { seatDelivery: { state: "queued" as const } } : {}),
      conversationId: meta.conversationId,
      runId,
      revision: meta.revision,
      safeCursor,
    };
  }

  private append(
    meta: ConversationMeta,
    body: OperatorConversationEventBody,
    occurredAt?: string,
    livePresence = occurredAt === undefined,
  ): void {
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
    this.journal.append(meta.conversationId, event);
    // Captain owner threads are private to the authenticated operator. Room,
    // channel, worker and side-fork activity must not become a desktop notice.
    if (
      (meta.scope.kind === "global" || meta.scope.kind === "workspace") &&
      meta.parentConversationId === undefined &&
      livePresence
    ) {
      const at = Date.parse(event.occurredAt);
      if (Number.isFinite(at) && at <= Date.now()) {
        if (
          body.type === "message" &&
          body.role === "captain" &&
          !body.streaming &&
          body.text.trim() &&
          at >= (this.recentPresenceMessage ?? 0)
        )
          this.recentPresenceMessage = at;
        if (body.type === "turn" && body.phase === "failed")
          this.recentPresenceError = { conversationId: meta.conversationId, at };
        if (
          body.type === "turn" &&
          body.phase === "completed" &&
          this.recentPresenceError?.conversationId === meta.conversationId
        )
          this.recentPresenceError = undefined;
      }
    }
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

  private waitForChange(conversationId: string, waitMs: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      let listeners = this.tailListeners.get(conversationId);
      if (listeners === undefined) {
        listeners = new Set();
        this.tailListeners.set(conversationId, listeners);
      }
      const registered = listeners;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        registered.delete(done);
        if (registered.size === 0) this.tailListeners.delete(conversationId);
      };
      const done = (): void => {
        cleanup();
        resolve();
      };
      const aborted = (): void => {
        cleanup();
        reject(signal?.reason);
      };
      const timer = setTimeout(done, waitMs);
      timer.unref?.();
      registered.add(done);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
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
    const trimCount = Math.max(0, events.length - retainedCount);
    if (trimCount === 0) return;
    const dropped = events.slice(0, trimCount);
    const retained = events.slice(trimCount);
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
    return this.journal.read(conversationId);
  }

  private validQuestionState(meta: ConversationMeta): void {
    return validQuestionState(this, meta);
  }

  private assertQuestionContext(meta: ConversationMeta, record: QuestionRecord): void {
    return assertQuestionContext(this, meta, record);
  }

  public async requestQuestion(
    conversationId: string,
    draft: QuestionDraft,
    context: ConversationTurnContext,
    projectDraft?: ProjectProposalDraft,
  ): Promise<ConversationQuestionResult> {
    return requestQuestion(this, conversationId, draft, context, projectDraft);
  }

  public async proposeProjectCreate(
    conversationId: string,
    draft: ProjectProposalDraft,
    context: ConversationTurnContext,
  ): Promise<ConversationQuestionResult> {
    return proposeProjectCreate(this, conversationId, draft, context);
  }

  private async projectProposalOperation(
    request: Extract<ConversationServiceRequest, { op: "project_proposal_get" | "project_proposal_confirm" }>,
    authority: QuestionAuthority | undefined,
  ): Promise<ProjectProposalResult> {
    return projectProposalOperation(this, request, authority);
  }

  private questionResult(
    meta: ConversationMeta,
    record: QuestionRecord | undefined,
    status: ConversationQuestionResult["status"],
    reason?: string,
  ): ConversationQuestionResult {
    return questionResult(this, meta, record, status, reason);
  }

  public cancelPendingQuestion(conversationId: string, reason: string, originRunId?: string): void {
    return cancelPendingQuestion(this, conversationId, reason, originRunId);
  }

  public invalidateQuestionPrincipal(deviceId: string): void {
    return invalidateQuestionPrincipal(this, deviceId);
  }

  private publishQuestionResolution(meta: ConversationMeta, record: QuestionRecord): void {
    return publishQuestionResolution(this, meta, record);
  }

  private async questionOperation(
    request: Extract<ConversationServiceRequest, { op: "input_get" | "input_answer" | "input_cancel" }>,
    authority: QuestionAuthority | undefined,
  ): Promise<ConversationQuestionResult> {
    return questionOperation(this, request, authority);
  }

  /** Narrow durable question commit; failure after rename is consumption uncertainty. */
  private saveQuestionMeta(meta: ConversationMeta): void {
    return saveQuestionMeta(this, meta);
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
      [...this.metas.values()].flatMap((meta) => [
        ...(meta.parentConversationId === undefined ? [] : [meta.parentConversationId]),
        ...(meta.roomHandoff === undefined ? [] : [meta.roomHandoff.roomConversationId]),
      ]),
    );
    const removable = (): ConversationMeta[] =>
      [...this.metas.values()]
        .filter(
          (meta) =>
            !meta.isDefault &&
            !this.hasUnreadInboundReports(meta) &&
            meta.sessionState !== "active" &&
            !this.liveRoomHandoffs.has(meta.conversationId) &&
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
      ...(meta.inboundAcceptances === undefined ? {} : { inboundAcceptances: meta.inboundAcceptances }),
      ...(meta.linearWakeCursor === undefined ? {} : { linearWakeCursor: meta.linearWakeCursor }),
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
      this.hasUnreadInboundReports(meta) ||
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
