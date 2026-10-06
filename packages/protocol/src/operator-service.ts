import {
  WorkerReportSummarySchema,
  WorkerReportPageSchema,
  type WorkerReportPage,
} from "./worker-reports.ts";
import { ClosedWorkerPaneSchema } from "./operator-conversations.ts";
import { HireReceiptIdSchema, HireReceiptSettlementSchema } from "./hire-receipts.ts";
import { z } from "zod";
import {
  ProjectProposalLocatorSchema,
  ProjectProposalTargetSchema,
  ProjectIdSchema,
  ProjectProposalResultSchema,
  type ProjectProposalLocator,
  type ProjectProposalResult,
  type ProjectProposalTarget,
} from "./projects.ts";
import {
  OperatorConnectionCommandSchema,
  OperatorConnectionResultSchema,
  type OperatorConnectionCommand,
} from "./connections.ts";
import {
  OperatorAgentRoleSchema,
  OperatorAgentRoleSummarySchema,
  OPERATOR_AGENT_ROLES,
  type OperatorAgentRoleSummary,
  type OperatorAgentRole,
} from "./agent-roles.ts";
import {
  WorkRepoSchema,
  WorkItemLabelSchema,
  type WorkItemsResult,
  type WorkRepo,
  WorkSignalSchema,
  WorkReposResultSchema,
  WorkItemsResultSchema,
  WorkProjectResultSchema,
  type WorkProjectResult,
} from "./work-items.ts";
import {
  WorkItemWriteRequestSchema,
  WorkItemWriteReceiptRequestSchema,
  WorkItemWriteReceiptSchema,
  type WorkItemWriteRequest,
  type WorkItemWriteReceipt,
  type WorkItemWriteReceiptRequest,
  uncertainWorkItemWrite,
} from "./work-item-write.ts";
import {
  OperatorPresenceRequestSchema,
  OperatorPresenceResultSchema,
  type OperatorPresenceSnapshot,
} from "./presence.ts";
import {
  StateOperatorAgentWorkSchema,
  StateOperatorAgentWorkResultSchema,
  type StateOperatorAgentWork,
  type StateOperatorAgentWorkResult,
} from "./agent-work.ts";
import {
  OperatorConversationIdSchema,
  ConversationQuestionTargetSchema,
  ConversationQuestionAnswerSchema,
  OperatorConversationScopeSchema,
  OPERATOR_CONVERSATION_TITLE_MAX,
  ReplayOperatorConversationRequestSchema,
  ReplayOperatorSubagentRequestSchema,
  SubmitOperatorConversationTurnSchema,
  OperatorConversationRunIdSchema,
  UpsertOperatorChannelSchema,
  UpdateOperatorAgentPersonaSchema,
  OperatorAgentPersonaIdSchema,
  OperatorConversationEventRefSchema,
  OperatorAutonomyCommandSchema,
  OperatorConversationCursorSchema,
  OPERATOR_FLEET_WAIT_MS_MAX,
  StateOperatorAgentStanceSchema,
  SpawnOperatorSeatSchema,
  MoveOperatorSeatSchema,
  BeginOperatorAttachmentUploadSchema,
  OperatorAttachmentChunkSchema,
  OperatorAttachmentUploadIdSchema,
  ConversationQuestionResultSchema,
  OperatorConversationSchema,
  OPERATOR_CONVERSATION_LIST_MAX,
  ReplayOperatorConversationResultSchema,
  SubmitOperatorConversationTurnResultSchema,
  OperatorChannelSchema,
  OperatorAgentPersonaSchema,
  OPERATOR_AGENT_PERSONA_LIST_MAX,
  DiscordGuildRoomSchema,
  DISCORD_GUILD_ROOM_MAX,
  OperatorAutonomyStatusSchema,
  OperatorFleetSeatSchema,
  OPERATOR_FLEET_ROSTER_MAX,
  OperatorFleetSnapshotSchema,
  OperatorComposerCatalogSchema,
  StateOperatorAgentStanceResultSchema,
  OperatorTerminalSessionSchema,
  OPERATOR_TERMINAL_CATALOG_MAX,
  OperatorSeatSpawnResultSchema,
  OperatorSeatMoveResultSchema,
  OperatorDeliveredFileSchema,
  OperatorAttachmentUploadResultSchema,
  type OperatorConversationStreamEvent,
  type OperatorConversationRecovery,
  type OperatorConversationLiveDraft,
  type ConversationQuestionResult,
  type ConversationQuestionTarget,
  type ConversationQuestionAnswer,
  type OperatorConversationScope,
  type OperatorConversation,
  type OperatorFleetSeat,
  type OperatorFleetSnapshot,
  type OperatorComposerCatalog,
  type StateOperatorAgentStance,
  type StateOperatorAgentStanceResult,
  type OperatorAgentPersona,
  type UpdateOperatorAgentPersona,
  type OperatorTerminalSession,
  type SpawnOperatorSeat,
  type OperatorSeatSpawnResult,
  type MoveOperatorSeat,
  type OperatorSeatMoveResult,
  type UpsertOperatorChannel,
  type OperatorChannel,
  type DiscordGuildRoom,
  type ReplayOperatorConversationRequest,
  type ReplayOperatorConversationResult,
  type ReplayOperatorSubagentRequest,
  type SubmitOperatorConversationTurn,
  type SubmitOperatorConversationTurnResult,
  type OperatorAutonomyCommand,
  type OperatorAutonomyStatus,
  type OperatorDeliveredFile,
  type BeginOperatorAttachmentUpload,
  type OperatorAttachmentUploadResult,
  type OperatorAttachmentChunk,
  type OperatorDeliveredFileDownloadRequest,
  OPERATOR_CONVERSATION_TAIL_WAIT_MS_MAX,
} from "./operator-conversations.ts";
import {
  OperatorTerminalObservationRequestSchema,
  OperatorTerminalControlRequestSchema,
  OperatorTerminalInputRequestSchema,
  OperatorTerminalObservationResultSchema,
  OperatorTerminalControlResultSchema,
  OperatorTerminalInputResultSchema,
  type OperatorTerminalControlRequest,
  type OperatorTerminalControlResult,
  type OperatorTerminalInputRequest,
  type OperatorTerminalInputResult,
} from "./operator-terminal.ts";
import { encodeBase64 } from "./base64.ts";

// ---------------------------------------------------------------------------
// Callable service contract (VUH-769). A transport-neutral request/result
// envelope any authenticated boundary (the service, the relay) mounts and
// any RN/macOS/TUI client calls. This is the callable contract; VUH-864 owns the
// physical HTTP/NDJSON transport that carries it.
// ---------------------------------------------------------------------------

/** The authenticated route path that carries the callable service contract. */
export const OPERATOR_CONVERSATION_DISPATCH_PATH = "/operator/v1/dispatch";

export const OperatorConversationServiceRequestSchema = z.discriminatedUnion("op", [
  ProjectProposalLocatorSchema.extend({
    op: z.literal("project_proposal_get"),
    schemaVersion: z.literal(1),
  }).strict(),
  ProjectProposalTargetSchema.extend({
    op: z.literal("project_proposal_confirm"),
    schemaVersion: z.literal(1),
  }).strict(),
  z
    .object({
      op: z.literal("input_get"),
      schemaVersion: z.literal(1),
      conversationId: OperatorConversationIdSchema,
      requestId: z.string().uuid().optional(),
    })
    .strict(),
  ConversationQuestionTargetSchema.extend({
    op: z.literal("input_answer"),
    schemaVersion: z.literal(1),
    answer: ConversationQuestionAnswerSchema,
  }).strict(),
  ConversationQuestionTargetSchema.extend({
    op: z.literal("input_cancel"),
    schemaVersion: z.literal(1),
  }).strict(),

  z
    .object({
      op: z.literal("connections"),
      schemaVersion: z.literal(1),
      command: OperatorConnectionCommandSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("list"),
      schemaVersion: z.literal(1),
      scope: OperatorConversationScopeSchema.optional(),
      includeWork: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("get"),
      schemaVersion: z.literal(1),
      conversationId: OperatorConversationIdSchema,
      includeWork: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("create"),
      schemaVersion: z.literal(1),
      scope: OperatorConversationScopeSchema,
      title: z.string().trim().min(1).max(OPERATOR_CONVERSATION_TITLE_MAX),
    })
    .strict(),
  z
    .object({
      op: z.literal("fork"),
      schemaVersion: z.literal(1),
      parentConversationId: OperatorConversationIdSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("reset"),
      schemaVersion: z.literal(1),
      conversationId: OperatorConversationIdSchema,
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      op: z.literal("close"),
      schemaVersion: z.literal(1),
      conversationId: OperatorConversationIdSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("replay"),
      schemaVersion: z.literal(1),
      replay: ReplayOperatorConversationRequestSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("subagent_replay"),
      schemaVersion: z.literal(1),
      replay: ReplayOperatorSubagentRequestSchema,
    })
    .strict(),
  // `tail` shares the replay request/result shape (per-surface cursor + typed
  // recovery). The transport long-polls it; the client exposes it as an async
  // iterable via `OperatorConversationTailClient`.
  z
    .object({
      op: z.literal("tail"),
      schemaVersion: z.literal(1),
      tail: ReplayOperatorConversationRequestSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("send"),
      schemaVersion: z.literal(1),
      turn: SubmitOperatorConversationTurnSchema,
    })
    .strict(),
  // `cancel` interrupts one accepted run: the captain aborts the live model
  // turn and the durable log settles that run as `cancelled`. Cancelling a run
  // that is unknown or already settled reports `cancelled: false`.
  z
    .object({
      op: z.literal("cancel"),
      schemaVersion: z.literal(1),
      conversationId: OperatorConversationIdSchema,
      runId: OperatorConversationRunIdSchema,
    })
    .strict(),
  /**
   * Create a channel, or restate an existing one's title and membership
   * (ADR 0146). A channel is a fan-out amplifier for anything an agent can do,
   * so this operator-only op is the only way a roster changes: nothing on the
   * agent side reaches it, and no member can add itself or another seat.
   */
  z
    .object({
      op: z.literal("channel"),
      schemaVersion: z.literal(1),
      channel: UpsertOperatorChannelSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("channels"),
      schemaVersion: z.literal(1),
    })
    .strict(),
  z
    .object({
      op: z.literal("personas"),
      schemaVersion: z.literal(1),
    })
    .strict(),
  /** Built-in roles plus the custom roles personas hold, with counts (ADR 0208). */
  z
    .object({
      op: z.literal("roles"),
      schemaVersion: z.literal(1),
    })
    .strict(),
  z
    .object({
      op: z.literal("update_persona"),
      schemaVersion: z.literal(1),
      persona: UpdateOperatorAgentPersonaSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("set_persona_role"),
      schemaVersion: z.literal(1),
      personaId: OperatorAgentPersonaIdSchema,
      role: OperatorAgentRoleSchema.nullable(),
      projectId: ProjectIdSchema.optional(),
    })
    .strict(),
  /**
   * The managed server's rooms, so choosing where a channel is projected is a pick
   * rather than a snowflake typed from memory. Empty where no Discord runtime
   * can list them, and empty when no managed server is set.
   */
  z
    .object({
      op: z.literal("discord_rooms"),
      schemaVersion: z.literal(1),
    })
    .strict(),
  /**
   * The repos this machine registered for work tracking, and one repo's items
   * in its own convention (ADR 0191). Writes below require exact owner authority.
   */
  z
    .object({
      op: z.literal("work_repos"),
      schemaVersion: z.literal(1),
    })
    .strict(),
  z
    .object({ op: z.literal("work_project"), schemaVersion: z.literal(1), repoId: WorkRepoSchema.shape.id })
    .strict(),
  z
    .object({
      op: z.literal("work_items"),
      schemaVersion: z.literal(1),
      statusVersion: z.literal(2).optional(),
      repoId: WorkRepoSchema.shape.id,
      /** Only items carrying this label, case-insensitively (a role station's backlog). */
      label: WorkItemLabelSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("work_item_write"),
      schemaVersion: z.literal(1),
      request: WorkItemWriteRequestSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("work_item_write_receipt"),
      schemaVersion: z.literal(1),
      ...WorkItemWriteReceiptRequestSchema.shape,
    })
    .strict(),
  // `react` is the operator's own reaction only. An agent reacts through the
  // captain, which is the boundary that can vouch for which seat it is.
  z
    .object({
      op: z.literal("react"),
      schemaVersion: z.literal(1),
      conversationId: OperatorConversationIdSchema,
      entryRef: OperatorConversationEventRefSchema,
      emoji: z.string().trim().min(1).max(64),
      remove: z.boolean(),
    })
    .strict(),
  z
    .object({
      op: z.literal("autonomy"),
      schemaVersion: z.literal(1),
      conversationId: OperatorConversationIdSchema,
      command: OperatorAutonomyCommandSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("roster"),
      schemaVersion: z.literal(1),
      includeCheckouts: z.boolean().optional(),
      includeWork: z.boolean().optional(),
    })
    .strict(),
  /**
   * One cursor-based live fleet read. An absent/old cursor returns now; the
   * current cursor parks until Herdr or fleet-owned state changes.
   */
  OperatorPresenceRequestSchema,
  z
    .object({
      op: z.literal("fleet"),
      schemaVersion: z.literal(1),
      /** Opt-in keeps older strict response schemas usable. */
      includeWork: z.boolean().optional(),
      includeClosedPanes: z.boolean().optional(),
      includeCheckouts: z.boolean().optional(),
      /** Omitted preserves the full durable directory for existing clients. */
      view: z.literal("home").optional(),
      cursor: OperatorConversationCursorSchema.optional(),
      waitMs: z.number().int().min(0).max(OPERATOR_FLEET_WAIT_MS_MAX).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("composer_catalog"),
      schemaVersion: z.literal(1),
      conversationId: OperatorConversationIdSchema,
      includeQuickActions: z.boolean().optional(),
    })
    .strict(),
  /**
   * An agent stating what it is doing with its own figure (ADR 0148). Unlike
   * `channel` and `spawn_seat`, this one is meant to be reached from the agent
   * side, and it is safe there for the reason those are not: it names no seat,
   * so the only figure a caller can move is the one it is sitting in.
   */
  z
    .object({ op: z.literal("state_work"), schemaVersion: z.literal(1), work: StateOperatorAgentWorkSchema })
    .strict(),
  z
    .object({
      op: z.literal("state_stance"),
      schemaVersion: z.literal(1),
      stance: StateOperatorAgentStanceSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("terminal_catalog"),
      schemaVersion: z.literal(1),
    })
    .strict(),
  z
    .object({
      op: z.literal("readopt_seat"),
      schemaVersion: z.literal(1),
      conversationId: OperatorConversationIdSchema,
      seatId: OperatorConversationEventRefSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("worker_reports"),
      schemaVersion: z.literal(1),
      conversationId: OperatorConversationIdSchema,
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("acknowledge_worker_reports"),
      schemaVersion: z.literal(1),
      conversationId: OperatorConversationIdSchema,
      deliveryIds: z.array(z.string().uuid()).min(1).max(100),
    })
    .strict(),
  z
    .object({
      op: z.literal("acknowledge_worker_report_history"),
      schemaVersion: z.literal(1),
      conversationId: OperatorConversationIdSchema,
      deliveryIds: z.array(z.string().uuid()).min(1).max(1000),
    })
    .strict(),
  z
    .object({
      op: z.literal("close_seat"),
      schemaVersion: z.literal(1),
      seatId: OperatorConversationEventRefSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("settle_hire_receipt"),
      schemaVersion: z.literal(1),
      receiptId: HireReceiptIdSchema,
      disposition: z.enum(["not-launched", "delivered", "abandoned"]).optional(),
    })
    .strict(),
  /**
   * Staff the fleet by starting a conversation (ADR 0013). Operator-only for
   * the same reason `channel` is: an agent that can hire is an agent that can
   * multiply itself.
   */
  z
    .object({
      op: z.literal("spawn_seat"),
      schemaVersion: z.literal(1),
      /** Selected hiring conversation; the host must independently authorize its exact route. */
      conversationId: z.string().trim().min(1).max(256).optional(),
      seat: SpawnOperatorSeatSchema,
      brief: z.string().min(1).max(32_768).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("move_seat"),
      schemaVersion: z.literal(1),
      move: MoveOperatorSeatSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("terminal_tail"),
      schemaVersion: z.literal(1),
      observation: OperatorTerminalObservationRequestSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("terminal_control"),
      schemaVersion: z.literal(1),
      control: OperatorTerminalControlRequestSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("terminal_input"),
      schemaVersion: z.literal(1),
      input: OperatorTerminalInputRequestSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("publish_file"),
      schemaVersion: z.literal(1),
      conversationId: OperatorConversationIdSchema,
      path: z.string().trim().min(1).max(4096),
      filename: z.string().trim().min(1).max(256).optional(),
      mediaType: z.string().trim().min(1).max(256).optional(),
    })
    .strict(),
  /**
   * Owner attachments (ADR 0209): declare a file, send its bytes in order in
   * chunks of at most `OPERATOR_ATTACHMENT_CHUNK_BYTES_MAX`, then commit. The
   * committed file is named in a later `send` by its `artifactId`.
   */
  z
    .object({
      op: z.literal("upload_begin"),
      schemaVersion: z.literal(1),
      upload: BeginOperatorAttachmentUploadSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("upload_chunk"),
      schemaVersion: z.literal(1),
      chunk: OperatorAttachmentChunkSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("upload_commit"),
      schemaVersion: z.literal(1),
      conversationId: OperatorConversationIdSchema,
      uploadId: OperatorAttachmentUploadIdSchema,
    })
    .strict(),
]);
export type OperatorConversationServiceRequest = z.infer<typeof OperatorConversationServiceRequestSchema>;

/** A repo's work items as a device sees them (ADR 0191). */
export type OperatorWorkProjectOutcome =
  | (WorkProjectResult & { readonly outcome: "ready" })
  | { readonly outcome: "unavailable"; readonly message: string };

export type OperatorWorkItemsOutcome =
  | (WorkItemsResult & { readonly outcome: "ready" })
  | {
      readonly outcome: "needs_decision";
      readonly repo: WorkRepo;
      readonly question: string;
      readonly signals: readonly z.infer<typeof WorkSignalSchema>[];
    }
  | { readonly outcome: "unavailable"; readonly message: string };

export const OperatorConversationServiceResultSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("project_proposal_get"),
      schemaVersion: z.literal(1),
      result: ProjectProposalResultSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("project_proposal_confirm"),
      schemaVersion: z.literal(1),
      result: ProjectProposalResultSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("input_get"),
      schemaVersion: z.literal(1),
      result: ConversationQuestionResultSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("input_answer"),
      schemaVersion: z.literal(1),
      result: ConversationQuestionResultSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("input_cancel"),
      schemaVersion: z.literal(1),
      result: ConversationQuestionResultSchema,
    })
    .strict(),

  z
    .object({
      op: z.literal("connections"),
      schemaVersion: z.literal(1),
      result: OperatorConnectionResultSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("list"),
      schemaVersion: z.literal(1),
      conversations: z.array(OperatorConversationSchema).max(OPERATOR_CONVERSATION_LIST_MAX),
    })
    .strict(),
  z
    .object({
      op: z.literal("get"),
      schemaVersion: z.literal(1),
      conversation: OperatorConversationSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("create"),
      schemaVersion: z.literal(1),
      conversation: OperatorConversationSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("fork"),
      schemaVersion: z.literal(1),
      conversation: OperatorConversationSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("reset"),
      schemaVersion: z.literal(1),
      conversation: OperatorConversationSchema,
      archiveId: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      op: z.literal("close"),
      schemaVersion: z.literal(1),
      conversationId: OperatorConversationIdSchema,
      closed: z.boolean(),
    })
    .strict(),
  z
    .object({
      op: z.literal("replay"),
      schemaVersion: z.literal(1),
      result: ReplayOperatorConversationResultSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("subagent_replay"),
      schemaVersion: z.literal(1),
      subagentId: ReplayOperatorSubagentRequestSchema.shape.subagentId,
      result: ReplayOperatorConversationResultSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("tail"),
      schemaVersion: z.literal(1),
      result: ReplayOperatorConversationResultSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("send"),
      schemaVersion: z.literal(1),
      result: SubmitOperatorConversationTurnResultSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("cancel"),
      schemaVersion: z.literal(1),
      conversationId: OperatorConversationIdSchema,
      runId: OperatorConversationRunIdSchema,
      cancelled: z.boolean(),
    })
    .strict(),
  z
    .object({
      op: z.literal("channel"),
      schemaVersion: z.literal(1),
      channel: OperatorChannelSchema,
      /** The shared conversation, so a freshly created channel opens without a second call. */
      conversation: OperatorConversationSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("channels"),
      schemaVersion: z.literal(1),
      channels: z.array(OperatorChannelSchema).max(OPERATOR_CONVERSATION_LIST_MAX),
    })
    .strict(),
  z
    .object({
      op: z.literal("personas"),
      schemaVersion: z.literal(1),
      personas: z.array(OperatorAgentPersonaSchema).max(OPERATOR_AGENT_PERSONA_LIST_MAX),
    })
    .strict(),
  z
    .object({
      op: z.literal("roles"),
      schemaVersion: z.literal(1),
      roles: z
        .array(OperatorAgentRoleSummarySchema)
        .max(OPERATOR_AGENT_PERSONA_LIST_MAX + OPERATOR_AGENT_ROLES.length),
    })
    .strict(),
  z
    .object({
      op: z.literal("update_persona"),
      schemaVersion: z.literal(1),
      persona: OperatorAgentPersonaSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("set_persona_role"),
      schemaVersion: z.literal(1),
      persona: OperatorAgentPersonaSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("discord_rooms"),
      schemaVersion: z.literal(1),
      rooms: z.array(DiscordGuildRoomSchema).max(DISCORD_GUILD_ROOM_MAX),
    })
    .strict(),
  z
    .object({
      op: z.literal("work_repos"),
      schemaVersion: z.literal(1),
      repos: WorkReposResultSchema.shape.repos,
    })
    .strict(),
  z
    .object({
      op: z.literal("work_project"),
      schemaVersion: z.literal(1),
      result: z.discriminatedUnion("outcome", [
        WorkProjectResultSchema.extend({ outcome: z.literal("ready") }).strict(),
        z.object({ outcome: z.literal("unavailable"), message: z.string().max(1000) }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      op: z.literal("work_items"),
      schemaVersion: z.literal(1),
      result: z.discriminatedUnion("outcome", [
        WorkItemsResultSchema.extend({ outcome: z.literal("ready") }).strict(),
        z
          .object({
            outcome: z.literal("needs_decision"),
            repo: WorkRepoSchema,
            question: z.string().max(2000),
            signals: z.array(WorkSignalSchema).max(20),
          })
          .strict(),
        z.object({ outcome: z.literal("unavailable"), message: z.string().max(1000) }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      op: z.literal("work_item_write"),
      schemaVersion: z.literal(1),
      outcome: z.literal("accepted"),
      receipt: WorkItemWriteReceiptSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("work_item_write_receipt"),
      schemaVersion: z.literal(1),
      outcome: z.literal("accepted"),
      receipt: WorkItemWriteReceiptSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("react"),
      schemaVersion: z.literal(1),
      conversationId: OperatorConversationIdSchema,
      entryRef: OperatorConversationEventRefSchema,
      /** False when the entry is not in this conversation's retained log. */
      reacted: z.boolean(),
    })
    .strict(),
  z
    .object({
      op: z.literal("autonomy"),
      schemaVersion: z.literal(1),
      status: OperatorAutonomyStatusSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("roster"),
      schemaVersion: z.literal(1),
      closedPanes: z.array(ClosedWorkerPaneSchema).max(128).optional(),
      seats: z.array(OperatorFleetSeatSchema).max(OPERATOR_FLEET_ROSTER_MAX),
      workerReports: z.array(WorkerReportSummarySchema).max(1000).optional(),
    })
    .strict(),
  OperatorPresenceResultSchema,
  z
    .object({
      op: z.literal("fleet"),
      schemaVersion: z.literal(1),
      snapshot: OperatorFleetSnapshotSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("composer_catalog"),
      schemaVersion: z.literal(1),
      catalog: OperatorComposerCatalogSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("state_work"),
      schemaVersion: z.literal(1),
      result: StateOperatorAgentWorkResultSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("state_stance"),
      schemaVersion: z.literal(1),
      result: StateOperatorAgentStanceResultSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("terminal_catalog"),
      schemaVersion: z.literal(1),
      sessions: z.array(OperatorTerminalSessionSchema).max(OPERATOR_TERMINAL_CATALOG_MAX),
    })
    .strict(),
  z
    .object({
      op: z.literal("readopt_seat"),
      schemaVersion: z.literal(1),
      seatId: OperatorConversationEventRefSchema,
      adopted: z.boolean(),
    })
    .strict(),
  z
    .object({
      op: z.literal("worker_reports"),
      schemaVersion: z.literal(1),
      page: WorkerReportPageSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("acknowledge_worker_reports"),
      schemaVersion: z.literal(1),
      conversationId: OperatorConversationIdSchema,
      acknowledged: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      op: z.literal("acknowledge_worker_report_history"),
      schemaVersion: z.literal(1),
      conversationId: OperatorConversationIdSchema,
      acknowledged: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      op: z.literal("close_seat"),
      schemaVersion: z.literal(1),
      seatId: OperatorConversationEventRefSchema,
      closed: z.boolean(),
    })
    .strict(),
  z
    .object({
      op: z.literal("settle_hire_receipt"),
      schemaVersion: z.literal(1),
      result: HireReceiptSettlementSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("spawn_seat"),
      schemaVersion: z.literal(1),
      result: OperatorSeatSpawnResultSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("move_seat"),
      schemaVersion: z.literal(1),
      result: OperatorSeatMoveResultSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("terminal_tail"),
      schemaVersion: z.literal(1),
      result: OperatorTerminalObservationResultSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("terminal_control"),
      schemaVersion: z.literal(1),
      result: OperatorTerminalControlResultSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("terminal_input"),
      schemaVersion: z.literal(1),
      result: OperatorTerminalInputResultSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("publish_file"),
      schemaVersion: z.literal(1),
      file: OperatorDeliveredFileSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("upload_begin"),
      schemaVersion: z.literal(1),
      result: OperatorAttachmentUploadResultSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("upload_chunk"),
      schemaVersion: z.literal(1),
      result: OperatorAttachmentUploadResultSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("upload_commit"),
      schemaVersion: z.literal(1),
      result: OperatorAttachmentUploadResultSchema,
    })
    .strict(),
]);
export type OperatorConversationServiceResult = z.infer<typeof OperatorConversationServiceResultSchema>;

/**
 * Transport-neutral dispatch of one service request to its result. RN/macOS
 * supply an authenticated HTTP transport (VUH-864); tests and co-located
 * surfaces supply an in-process dispatch to the captain-owned service handler.
 */
export type OperatorConversationServiceDispatch = (
  request: OperatorConversationServiceRequest,
  /**
   * Aborts the in-flight request. A parked `tail` is the one call that outlives
   * a surface going away (backgrounded app, unmounted view), so a transport
   * that can cancel is handed the caller's signal rather than stranding it.
   */
  signal?: AbortSignal,
) => Promise<OperatorConversationServiceResult>;

/**
 * One item yielded by the client `tail` iterable: either a durable event or a
 * typed recovery outcome. The iterable STOPS after yielding a recovery item so
 * the caller decides whether to reset — RN/TUI can distinguish cursor_invalid/
 * expired/reset from an ordinary empty tail and never silently replay past a
 * reset boundary.
 */
export type OperatorConversationTailItem =
  | { readonly kind: "event"; readonly event: OperatorConversationStreamEvent }
  | { readonly kind: "recovery"; readonly recovery: OperatorConversationRecovery }
  /**
   * The live draft changed: `draft` is the message being typed, or `undefined`
   * once it settles into a durable `message` event. Carries no cursor — a
   * surface that only wants the record ignores this kind entirely.
   */
  | { readonly kind: "live"; readonly draft: OperatorConversationLiveDraft | undefined };

/**
 * The named public client any RN/macOS/TUI surface uses. It depends only on
 * `@clankie/protocol` types and an injected dispatch — never on Node-only
 * captain-runtime internals — so every surface calls one identical contract.
 */
export interface OperatorConversationServiceClient {
  projectProposalGet?(target: ProjectProposalLocator): Promise<ProjectProposalResult>;
  projectProposalConfirm?(target: ProjectProposalTarget): Promise<ProjectProposalResult>;
  inputGet?(conversationId: string, requestId?: string): Promise<ConversationQuestionResult>;
  inputAnswer?(
    target: ConversationQuestionTarget & { answer: ConversationQuestionAnswer },
  ): Promise<ConversationQuestionResult>;
  inputCancel?(target: ConversationQuestionTarget): Promise<ConversationQuestionResult>;

  connections?(command?: OperatorConnectionCommand): Promise<z.infer<typeof OperatorConnectionResultSchema>>;
  list(scope?: OperatorConversationScope): Promise<readonly OperatorConversation[]>;
  roster(): Promise<readonly OperatorFleetSeat[]>;
  readoptSeat?(seatId: string, conversationId: string): Promise<boolean>;
  workerReports?(conversationId: string, limit?: number): Promise<WorkerReportPage>;
  acknowledgeWorkerReports?(conversationId: string, deliveryIds: readonly string[]): Promise<number>;
  /** Owner-only retirement of explicitly selected retained history. */
  acknowledgeWorkerReportHistory?(conversationId: string, deliveryIds: readonly string[]): Promise<number>;
  /** Park until the fleet cursor changes, then return one coherent snapshot. */
  fleet?(cursor?: string, signal?: AbortSignal): Promise<OperatorFleetSnapshot>;
  /** Park until present-tense activity changes. */
  presence?(cursor?: string, signal?: AbortSignal): Promise<OperatorPresenceSnapshot>;
  /** Commands and skills accepted by this exact conversation target. */
  composerCatalog?(
    conversationId: string,
    options?: { readonly includeQuickActions?: boolean },
  ): Promise<OperatorComposerCatalog>;
  /**
   * An agent saying what it is doing with its own figure (ADR 0148). The seat
   * comes from the pane the caller sits in, never from the caller's word for it.
   */
  stateWork?(input: StateOperatorAgentWork): Promise<StateOperatorAgentWorkResult>;
  stateStance?(input: StateOperatorAgentStance): Promise<StateOperatorAgentStanceResult>;
  /** Durable fleet characters, including those with no live Herdr seat. */
  personas?(): Promise<readonly OperatorAgentPersona[]>;
  /** Built-in roles first, then custom roles in use, most held first (ADR 0208). */
  roles?(): Promise<readonly OperatorAgentRoleSummary[]>;
  /** Rename or restyle one character for every surface, including Discord. */
  updatePersona?(input: UpdateOperatorAgentPersona): Promise<OperatorAgentPersona>;
  /** Assign or clear a persona's team role (ADR 0208). */
  setPersonaRole?(
    personaId: string,
    role: OperatorAgentRole | null,
    projectId?: string,
  ): Promise<OperatorAgentPersona>;
  /** Observable terminals in Herdr's native hierarchy; absent on older injected clients. */
  terminalCatalog?(): Promise<readonly OperatorTerminalSession[]>;
  /** Acquire, renew, or release the exclusive input lease on one terminal; absent on older injected clients. */
  terminalControl?(request: OperatorTerminalControlRequest): Promise<OperatorTerminalControlResult>;
  /** Write raw VT bytes under a live input lease; absent on older injected clients. */
  terminalInput?(request: OperatorTerminalInputRequest): Promise<OperatorTerminalInputResult>;
  /** Close the live Herdr seat without deleting its occupying persona. */
  closeSeat(seatId: string): Promise<boolean>;
  /**
   * Open a pane in a working directory and start a harness in it, returning the
   * seat to open a thread on. Absent on older injected clients; failures come
   * back typed rather than thrown.
   */
  spawnSeat?(input: SpawnOperatorSeat, conversationId?: string): Promise<OperatorSeatSpawnResult>;
  /**
   * Close a seat and hire it again in another working directory under the
   * same persona name (ADR 0166). Absent on older injected clients.
   */
  moveSeat?(input: MoveOperatorSeat): Promise<OperatorSeatMoveResult>;
  get(conversationId: string): Promise<OperatorConversation | undefined>;
  create(input: {
    readonly scope: OperatorConversationScope;
    readonly title: string;
  }): Promise<OperatorConversation>;
  /** Clone the current Pi branch into an ephemeral child conversation. */
  fork(parentConversationId: string): Promise<OperatorConversation>;
  /**
   * Create a channel, or restate its title, roster, and projection (ADR 0146).
   * Absent on older injected clients. Membership is an operator decision, so
   * this is the only way a roster changes.
   */
  channel?(input: UpsertOperatorChannel): Promise<{
    readonly channel: OperatorChannel;
    readonly conversation: OperatorConversation;
  }>;
  /** Every channel that exists here; absent on older injected clients. */
  channels?(): Promise<readonly OperatorChannel[]>;
  /** The managed server's rooms, to pick which one a channel is projected onto. */
  discordRooms?(): Promise<readonly DiscordGuildRoom[]>;
  /** Repos registered for work tracking on this machine (ADR 0191). */
  workRepos?(): Promise<readonly WorkRepo[]>;
  /** One repo's work items, or why they cannot be read yet. */
  workProject?(repoId: string): Promise<OperatorWorkProjectOutcome>;
  workItems?(
    repoId: string,
    options?: { readonly label?: string; readonly statusVersion?: 2 },
  ): Promise<OperatorWorkItemsOutcome>;
  /** One owner-authorized intent; transport loss returns its original ID without replay. */
  workItemWrite?(input: WorkItemWriteRequest): Promise<WorkItemWriteReceipt>;
  /** Read the original intent's receipt; never dispatch or retry a mutation. */
  workItemWriteReceipt?(input: WorkItemWriteReceiptRequest): Promise<WorkItemWriteReceipt>;
  /**
   * Put the operator's reaction on one transcript entry, or take it back off.
   * False when the entry is not in the conversation's retained log.
   */
  react?(input: {
    readonly conversationId: string;
    readonly entryRef: string;
    readonly emoji: string;
    readonly remove: boolean;
  }): Promise<boolean>;
  reset?(
    conversationId: string,
    expectedRevision: number,
  ): Promise<{
    conversation: OperatorConversation;
    archiveId: string;
  }>;
  close(conversationId: string): Promise<boolean>;
  replay(request: ReplayOperatorConversationRequest): Promise<ReplayOperatorConversationResult>;
  /** Read-only native child history; absent on older clients/hosts. */
  readSubagent?(
    request: ReplayOperatorSubagentRequest,
    signal?: AbortSignal,
  ): Promise<ReplayOperatorConversationResult>;
  /**
   * Yields durable events, then a single `recovery` item and STOPS if the server
   * returns a typed recovery outcome. The caller inspects the recovery and, if it
   * chooses, resumes `tail` from `recovery.resetCursor`. The client never
   * auto-resyncs across a reset.
   */
  tail(
    request: ReplayOperatorConversationRequest,
    signal?: AbortSignal,
  ): AsyncIterable<OperatorConversationTailItem>;
  send(turn: SubmitOperatorConversationTurn): Promise<SubmitOperatorConversationTurnResult>;
  /** Interrupt one accepted run; false when it is unknown or already settled. */
  cancel(conversationId: string, runId: string): Promise<boolean>;
  autonomy(conversationId: string, command: OperatorAutonomyCommand): Promise<OperatorAutonomyStatus>;
  /** Local-only publication of one deliberate file from this conversation's working directory. */
  publishFile?(input: {
    readonly conversationId: string;
    readonly path: string;
    readonly filename?: string;
    readonly mediaType?: string;
  }): Promise<OperatorDeliveredFile>;
  /** Declare one owner attachment (ADR 0209). */
  beginUpload?(upload: BeginOperatorAttachmentUpload): Promise<OperatorAttachmentUploadResult>;
  /** Append the next chunk of an open upload. */
  uploadChunk?(chunk: OperatorAttachmentChunk): Promise<OperatorAttachmentUploadResult>;
  /** Verify and store a fully received upload. */
  commitUpload?(conversationId: string, uploadId: string): Promise<OperatorAttachmentUploadResult>;
  /**
   * Upload one file end to end: begin, every chunk in order, commit. The caller
   * supplies the hex SHA-256, since this package has no hashing dependency.
   * Returns the commit result, or the first refusal.
   */
  uploadAttachment?(
    input: BeginOperatorAttachmentUpload & { readonly bytes: Uint8Array },
    options?: { readonly onProgress?: (receivedBytes: number, byteCount: number) => void },
  ): Promise<OperatorAttachmentUploadResult>;
  /** Authenticated raw-byte retrieval; supplied by HTTP transports that expose the file route. */
  downloadFile?(
    request: OperatorDeliveredFileDownloadRequest,
    signal?: AbortSignal,
  ): Promise<{ readonly mediaType: string; readonly bytes: Uint8Array }>;
}

export function createOperatorConversationServiceClient(
  dispatch: OperatorConversationServiceDispatch,
  options: {
    readonly tailIdleMs?: number;
    readonly tailWaitMs?: number;
    readonly fleetWaitMs?: number;
    readonly includeWork?: boolean;
    readonly includeClosedPanes?: boolean;
    readonly includeCheckouts?: boolean;
  } = {},
): OperatorConversationServiceClient {
  const tailIdleMs = options.tailIdleMs ?? 250;
  // A service that honours `waitMs` parks the request instead of answering
  // empty, so the idle sleep below only pays out the remainder it did not
  // spend waiting — an older service that ignores it keeps today's cadence.
  const tailWaitMs = Math.min(options.tailWaitMs ?? 10_000, OPERATOR_CONVERSATION_TAIL_WAIT_MS_MAX);
  const fleetWaitMs = Math.min(options.fleetWaitMs ?? 20_000, OPERATOR_FLEET_WAIT_MS_MAX);
  const workProjection = options.includeWork === true ? { includeWork: true } : {};
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    async projectProposalGet(target) {
      const result = await dispatch({ op: "project_proposal_get", schemaVersion: 1, ...target });
      if (result.op !== "project_proposal_get") throw new Error("Unexpected proposal response");
      return result.result;
    },
    async projectProposalConfirm(target) {
      const result = await dispatch({ op: "project_proposal_confirm", schemaVersion: 1, ...target });
      if (result.op !== "project_proposal_confirm") throw new Error("Unexpected proposal response");
      return result.result;
    },
    async inputGet(conversationId, requestId) {
      const result = await dispatch({
        op: "input_get",
        schemaVersion: 1,
        conversationId,
        ...(requestId === undefined ? {} : { requestId }),
      });
      if (result.op !== "input_get") throw new Error("Unexpected question response");
      return result.result;
    },
    async inputAnswer(target) {
      const result = await dispatch({ op: "input_answer", schemaVersion: 1, ...target });
      if (result.op !== "input_answer") throw new Error("Unexpected question response");
      return result.result;
    },
    async inputCancel(target) {
      const result = await dispatch({ op: "input_cancel", schemaVersion: 1, ...target });
      if (result.op !== "input_cancel") throw new Error("Unexpected question response");
      return result.result;
    },
    async connections(command = { action: "list" }) {
      const result = await dispatch({ op: "connections", schemaVersion: 1, command });
      if (result.op !== "connections") throw new Error(`Unexpected ${result.op} result for connections`);
      return result.result;
    },
    async list(scope) {
      const result = await dispatch({
        op: "list",
        schemaVersion: 1,
        ...workProjection,
        ...(scope === undefined ? {} : { scope }),
      });
      if (result.op !== "list") throw new Error(`Unexpected ${result.op} result for list`);
      return result.conversations;
    },
    async readoptSeat(seatId, conversationId) {
      const result = await dispatch({ op: "readopt_seat", schemaVersion: 1, seatId, conversationId });
      if (result.op !== "readopt_seat") throw new Error(`Unexpected ${result.op} result for re-adoption`);
      return result.adopted;
    },
    async workerReports(conversationId, limit) {
      const result = await dispatch({
        op: "worker_reports",
        schemaVersion: 1,
        conversationId,
        ...(limit === undefined ? {} : { limit }),
      });
      if (result.op !== "worker_reports")
        throw new Error(`Unexpected ${result.op} result for worker reports`);
      return result.page;
    },
    async acknowledgeWorkerReports(conversationId, deliveryIds) {
      const result = await dispatch({
        op: "acknowledge_worker_reports",
        schemaVersion: 1,
        conversationId,
        deliveryIds: [...deliveryIds],
      });
      if (result.op !== "acknowledge_worker_reports")
        throw new Error(`Unexpected ${result.op} result for worker report acknowledgment`);
      return result.acknowledged;
    },
    async acknowledgeWorkerReportHistory(conversationId, deliveryIds) {
      const result = await dispatch({
        op: "acknowledge_worker_report_history",
        schemaVersion: 1,
        conversationId,
        deliveryIds: [...deliveryIds],
      });
      if (result.op !== "acknowledge_worker_report_history")
        throw new Error(`Unexpected ${result.op} result for worker report history acknowledgment`);
      return result.acknowledged;
    },
    async roster() {
      const result = await dispatch({
        op: "roster",
        schemaVersion: 1,
        ...workProjection,
        ...(options.includeCheckouts === true ? { includeCheckouts: true } : {}),
      });
      if (result.op !== "roster") throw new Error(`Unexpected ${result.op} result for roster`);
      return result.seats;
    },
    async fleet(cursor, signal) {
      const result = await dispatch(
        {
          op: "fleet",
          schemaVersion: 1,
          ...workProjection,
          ...(cursor === undefined ? {} : { cursor }),
          waitMs: fleetWaitMs,
          ...(options.includeClosedPanes === true ? { includeClosedPanes: true } : {}),
          ...(options.includeCheckouts === true ? { includeCheckouts: true } : {}),
        },
        signal,
      );
      if (result.op !== "fleet") throw new Error(`Unexpected ${result.op} result for fleet`);
      return result.snapshot;
    },
    async presence(cursor, signal) {
      const result = await dispatch(
        {
          op: "presence",
          schemaVersion: 1,
          ...(cursor === undefined ? {} : { cursor }),
          waitMs: fleetWaitMs,
        },
        signal,
      );
      if (result.op !== "presence") throw new Error(`Unexpected ${result.op} result for presence`);
      return result.snapshot;
    },
    async composerCatalog(conversationId, options) {
      const result = await dispatch({
        op: "composer_catalog",
        schemaVersion: 1,
        conversationId,
        ...(options?.includeQuickActions === true ? { includeQuickActions: true } : {}),
      });
      if (result.op !== "composer_catalog") {
        throw new Error(`Unexpected ${result.op} result for composer_catalog`);
      }
      return result.catalog;
    },
    async stateWork(input) {
      const result = await dispatch({ op: "state_work", schemaVersion: 1, work: input });
      if (result.op !== "state_work") throw new Error(`Unexpected ${result.op} result for state_work`);
      return result.result;
    },
    async stateStance(input) {
      const result = await dispatch({ op: "state_stance", schemaVersion: 1, stance: input });
      if (result.op !== "state_stance") {
        throw new Error(`Unexpected ${result.op} result for state_stance`);
      }
      return result.result;
    },
    async roles() {
      const result = await dispatch({ op: "roles", schemaVersion: 1 });
      if (result.op !== "roles") throw new Error(`Unexpected ${result.op} result for roles`);
      return result.roles;
    },
    async personas() {
      const result = await dispatch({ op: "personas", schemaVersion: 1 });
      if (result.op !== "personas") throw new Error(`Unexpected ${result.op} result for personas`);
      return result.personas;
    },
    async updatePersona(input) {
      const result = await dispatch({ op: "update_persona", schemaVersion: 1, persona: input });
      if (result.op !== "update_persona") {
        throw new Error(`Unexpected ${result.op} result for update_persona`);
      }
      return result.persona;
    },
    async setPersonaRole(personaId, role, projectId) {
      const result = await dispatch({
        op: "set_persona_role",
        schemaVersion: 1,
        personaId,
        role,
        ...(projectId === undefined ? {} : { projectId }),
      });
      if (result.op !== "set_persona_role") {
        throw new Error(`Unexpected ${result.op} result for set_persona_role`);
      }
      return result.persona;
    },
    async terminalCatalog() {
      const result = await dispatch({ op: "terminal_catalog", schemaVersion: 1 });
      if (result.op !== "terminal_catalog") {
        throw new Error(`Unexpected ${result.op} result for terminal_catalog`);
      }
      return result.sessions;
    },
    async terminalControl(request) {
      const result = await dispatch({ op: "terminal_control", schemaVersion: 1, control: request });
      if (result.op !== "terminal_control") {
        throw new Error(`Unexpected ${result.op} result for terminal_control`);
      }
      return result.result;
    },
    async terminalInput(request) {
      const result = await dispatch({ op: "terminal_input", schemaVersion: 1, input: request });
      if (result.op !== "terminal_input") {
        throw new Error(`Unexpected ${result.op} result for terminal_input`);
      }
      return result.result;
    },
    async closeSeat(seatId) {
      const result = await dispatch({ op: "close_seat", schemaVersion: 1, seatId });
      if (result.op !== "close_seat") throw new Error(`Unexpected ${result.op} result for close_seat`);
      return result.closed;
    },
    async spawnSeat(input, conversationId) {
      const result = await dispatch({
        op: "spawn_seat",
        schemaVersion: 1,
        seat: input,
        ...(conversationId === undefined ? {} : { conversationId }),
      });
      if (result.op !== "spawn_seat") throw new Error(`Unexpected ${result.op} result for spawn_seat`);
      return result.result;
    },
    async moveSeat(input) {
      const result = await dispatch({ op: "move_seat", schemaVersion: 1, move: input });
      if (result.op !== "move_seat") throw new Error(`Unexpected ${result.op} result for move_seat`);
      return result.result;
    },
    async channel(input) {
      const result = await dispatch({ op: "channel", schemaVersion: 1, channel: input });
      if (result.op !== "channel") throw new Error(`Unexpected ${result.op} result for channel`);
      return { channel: result.channel, conversation: result.conversation };
    },
    async channels() {
      const result = await dispatch({ op: "channels", schemaVersion: 1 });
      if (result.op !== "channels") throw new Error(`Unexpected ${result.op} result for channels`);
      return result.channels;
    },
    async workRepos() {
      const result = await dispatch({ op: "work_repos", schemaVersion: 1 });
      if (result.op !== "work_repos") throw new Error(`Unexpected ${result.op} result for work_repos`);
      return result.repos;
    },
    async workProject(repoId) {
      const result = await dispatch({ op: "work_project", schemaVersion: 1, repoId });
      if (result.op !== "work_project") throw new Error(`Unexpected ${result.op} result for work_project`);
      return result.result;
    },
    async workItems(repoId, options) {
      const result = await dispatch({
        op: "work_items",
        schemaVersion: 1,
        repoId,
        ...(options?.label === undefined ? {} : { label: options.label }),
        ...(options?.statusVersion === undefined ? {} : { statusVersion: options.statusVersion }),
      });
      if (result.op !== "work_items") throw new Error(`Unexpected ${result.op} result for work_items`);
      return result.result;
    },
    async workItemWrite(input) {
      const request = WorkItemWriteRequestSchema.parse(input);
      try {
        const result = await dispatch({ op: "work_item_write", schemaVersion: 1, request });
        if (result.op !== "work_item_write") throw new Error("Unexpected work-item write receipt");
        const receipt = WorkItemWriteReceiptSchema.parse(result.receipt);
        if (receipt.requestId !== request.requestId) throw new Error("Unexpected work-item write receipt");
        return receipt;
      } catch {
        return uncertainWorkItemWrite(
          request.requestId,
          "The write response was lost or invalid. It may have happened; read this request's receipt, never resend it.",
        );
      }
    },
    async workItemWriteReceipt(input) {
      const request = WorkItemWriteReceiptRequestSchema.parse(input);
      try {
        const result = await dispatch({ op: "work_item_write_receipt", schemaVersion: 1, ...request });
        if (result.op !== "work_item_write_receipt") throw new Error("Unexpected work-item write receipt");
        const receipt = WorkItemWriteReceiptSchema.parse(result.receipt);
        if (receipt.requestId !== request.requestId) throw new Error("Unexpected work-item write receipt");
        return receipt;
      } catch {
        return uncertainWorkItemWrite(
          request.requestId,
          "The original receipt could not be read. Nothing was resent; inspect the item and read this request's receipt again.",
        );
      }
    },
    async discordRooms() {
      const result = await dispatch({ op: "discord_rooms", schemaVersion: 1 });
      if (result.op !== "discord_rooms") {
        throw new Error(`Unexpected ${result.op} result for discord_rooms`);
      }
      return result.rooms;
    },
    async react(input) {
      const result = await dispatch({ op: "react", schemaVersion: 1, ...input });
      if (result.op !== "react") throw new Error(`Unexpected ${result.op} result for react`);
      return result.reacted;
    },
    async get(conversationId) {
      const result = await dispatch({ op: "get", schemaVersion: 1, conversationId, ...workProjection });
      if (result.op !== "get") throw new Error(`Unexpected ${result.op} result for get`);
      return result.conversation;
    },
    async create(input) {
      const result = await dispatch({
        op: "create",
        schemaVersion: 1,
        scope: input.scope,
        title: input.title,
      });
      if (result.op !== "create") throw new Error(`Unexpected ${result.op} result for create`);
      return result.conversation;
    },
    async fork(parentConversationId) {
      const result = await dispatch({ op: "fork", schemaVersion: 1, parentConversationId });
      if (result.op !== "fork") throw new Error(`Unexpected ${result.op} result for fork`);
      return result.conversation;
    },
    async reset(conversationId, expectedRevision) {
      const result = await dispatch({ op: "reset", schemaVersion: 1, conversationId, expectedRevision });
      if (result.op !== "reset") throw new Error(`Unexpected ${result.op} result for reset`);
      return { conversation: result.conversation, archiveId: result.archiveId };
    },
    async close(conversationId) {
      const result = await dispatch({ op: "close", schemaVersion: 1, conversationId });
      if (result.op !== "close") throw new Error(`Unexpected ${result.op} result for close`);
      return result.closed;
    },
    async replay(request) {
      const result = await dispatch({ op: "replay", schemaVersion: 1, replay: request });
      if (result.op !== "replay") throw new Error(`Unexpected ${result.op} result for replay`);
      return result.result;
    },
    async readSubagent(request, signal) {
      const result = await dispatch({ op: "subagent_replay", schemaVersion: 1, replay: request }, signal);
      if (result.op !== "subagent_replay" || result.subagentId !== request.subagentId)
        throw new Error("Unexpected subagent history result");
      if (result.result.conversationId !== request.conversationId)
        throw new Error("Subagent history belongs to another parent");
      return result.result;
    },
    async *tail(request, signal) {
      let cursor = request.cursor;
      let liveSequence = 0;
      while (signal?.aborted !== true) {
        const startedAt = Date.now();
        const result = await dispatch(
          {
            op: "tail",
            schemaVersion: 1,
            tail: {
              ...request,
              ...(cursor === undefined ? {} : { cursor }),
              liveSequence,
              waitMs: tailWaitMs,
            },
          },
          signal,
        );
        if (result.op !== "tail") throw new Error(`Unexpected ${result.op} result for tail`);
        const page = result.result;
        if (page.status === "recover") {
          // Surface the typed recovery and stop; the caller decides whether to
          // reset. Never silently resync past a reset boundary.
          yield { kind: "recovery", recovery: page };
          return;
        }
        for (const event of page.events) yield { kind: "event", event };
        cursor = page.nextCursor;
        // A settled message clears the draft, so an absent `live` after one was
        // showing is itself the news: the surface takes its live block down.
        const draftSequence = page.live?.sequence ?? 0;
        const draftChanged = draftSequence !== liveSequence;
        if (draftChanged) {
          liveSequence = draftSequence;
          yield { kind: "live", draft: page.live };
        }
        if (page.events.length === 0 && !draftChanged) {
          const remaining = tailIdleMs - (Date.now() - startedAt);
          if (remaining > 0) await sleep(remaining);
        }
      }
    },
    async send(turn) {
      const result = await dispatch({ op: "send", schemaVersion: 1, turn });
      if (result.op !== "send") throw new Error(`Unexpected ${result.op} result for send`);
      return result.result;
    },
    async cancel(conversationId, runId) {
      const result = await dispatch({ op: "cancel", schemaVersion: 1, conversationId, runId });
      if (result.op !== "cancel") throw new Error(`Unexpected ${result.op} result for cancel`);
      return result.cancelled;
    },
    async autonomy(conversationId, command) {
      const result = await dispatch({ op: "autonomy", schemaVersion: 1, conversationId, command });
      if (result.op !== "autonomy") throw new Error(`Unexpected ${result.op} result for autonomy`);
      return result.status;
    },
    async publishFile(input) {
      const result = await dispatch({ op: "publish_file", schemaVersion: 1, ...input });
      if (result.op !== "publish_file") {
        throw new Error(`Unexpected ${result.op} result for publish_file`);
      }
      return result.file;
    },
    beginUpload,
    uploadChunk,
    commitUpload,
    async uploadAttachment(input, uploadOptions) {
      const { bytes, ...upload } = input;
      if (bytes.byteLength !== upload.byteCount)
        throw new Error("byteCount does not match the bytes supplied");
      let state = await beginUpload(upload);
      while (state.status === "uploading" && state.receivedBytes < state.byteCount) {
        const offset = state.receivedBytes;
        const end = Math.min(offset + state.chunkBytes, state.byteCount);
        const next = await uploadChunk({
          conversationId: upload.conversationId,
          uploadId: state.uploadId,
          offset,
          dataBase64: encodeBase64(bytes.subarray(offset, end)),
        });
        if (
          next.status === "refused" &&
          next.reason === "offset_mismatch" &&
          next.receivedBytes !== undefined
        ) {
          state = { ...state, receivedBytes: next.receivedBytes };
          continue;
        }
        if (next.status !== "uploading") return next;
        state = next;
        uploadOptions?.onProgress?.(state.receivedBytes, state.byteCount);
      }
      if (state.status !== "uploading") return state;
      return commitUpload(upload.conversationId, state.uploadId);
    },
  };

  async function beginUpload(upload: BeginOperatorAttachmentUpload): Promise<OperatorAttachmentUploadResult> {
    const result = await dispatch({ op: "upload_begin", schemaVersion: 1, upload });
    if (result.op !== "upload_begin") throw new Error(`Unexpected ${result.op} result for upload_begin`);
    return result.result;
  }
  async function uploadChunk(chunk: OperatorAttachmentChunk): Promise<OperatorAttachmentUploadResult> {
    const result = await dispatch({ op: "upload_chunk", schemaVersion: 1, chunk });
    if (result.op !== "upload_chunk") throw new Error(`Unexpected ${result.op} result for upload_chunk`);
    return result.result;
  }
  async function commitUpload(
    conversationId: string,
    uploadId: string,
  ): Promise<OperatorAttachmentUploadResult> {
    const result = await dispatch({ op: "upload_commit", schemaVersion: 1, conversationId, uploadId });
    if (result.op !== "upload_commit") throw new Error(`Unexpected ${result.op} result for upload_commit`);
    return result.result;
  }
}
