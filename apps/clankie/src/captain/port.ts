import type {
  FleetSeatToolCatalog,
  FleetSeatToolCatalogHealth,
  FleetToolCatalogHealthPage,
} from "@clankie/protocol/tool-catalog";
import type { QuestionAuthority } from "./conversation-questions.ts";
import type { ProjectProcessProof } from "../project-process-proof.ts";
import type {
  ProjectHireAssignment,
  ProjectHireProcessProof,
  ProjectHireMembershipCandidate,
} from "./project-hires.ts";
import type { ConversationOwner, ConversationAuthority, WorkerWriteAuthority } from "./conversation-owner.ts";
import type { SeatTranscriptUpload } from "@clankie/agent-transcript";
import type { FleetSeatDelivery } from "./fleet-seat.ts";
import type { PeerSeatAuthority } from "./peer-seat-messages.ts";
import type { InboundSeatRequest } from "./inbound-seat-receipts.ts";
import type {
  DeliveryStage,
  EvaluatorCommand,
  EvaluatorStatus,
  CaptainChannelTurnResult,
  CaptainLaneObservationEntry,
  CaptainSessionLaneV2,
  CaptainTurnMedia,
  CaptainTurnSettledMetrics,
  IssueMetricsQuery,
  IssueMetricsReport,
  DiscordChannelProjectionMessage,
  DiscordChannelProjectionMessageResult,
  DiscordPresenceChannelTurnRequest,
  FleetSeatHook,
  ClaudeChannelPermissionRequest,
  FleetSeatMessageDelivery,
  FleetSeatMessageReceipt,
  FleetSeatMessageStatus,
  FleetPeerMessage,
  FleetPeerReceipt,
  FleetPeerSeats,
  ObservableCaptainLane,
  OperatorConversation,
  OperatorConversationServiceRequest,
  OperatorConversationServiceResult,
  OperatorSeatEvent,
  OperatorSeatSpawnResult,
  SpawnOperatorSeat,
} from "@clankie/protocol";
import type { DurableMessageNotice } from "./conversations.ts";
import type { LinearActivityEvent } from "../linear-webhook.ts";

/**
 * The pieces a lane's system prompt is assembled from. `identity`, `persona`,
 * `reach`, `fleet`, and `address` are what a pi session starts with; `model` is
 * the card a hidden extension refreshes per run. A seat that carries the
 * identity some other way (a Claude Code output style) asks for the rest by name.
 */
/** `conversation` is the operator seat's bounded log projection at session start (ADR 0218). */
export const CAPTAIN_PROMPT_SECTIONS = [
  "identity",
  "persona",
  "reach",
  "fleet",
  "address",
  "model",
  "conversation",
] as const;
export type CaptainPromptSection = (typeof CAPTAIN_PROMPT_SECTIONS)[number];

/** A seat harness that loads some project instruction files itself. */
export type PromptHarness = "claude";

/**
 * One authored tool as a harness that is not pi sees it: a name, a description,
 * the raw JSON Schema pi validates against, and a call. The captain's registry
 * stays the single source of truth — this is a projection of it, never a second
 * catalog to keep in step.
 */
export interface LaneTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  call(args: Record<string, unknown>, context?: { readonly callId: string }): Promise<LaneToolResult>;
}

/**
 * A hire with the captain's wiring around it: persona adoption, conversation
 * binding, and a watch from the first breath (ADR 0187) — never a bare
 * `herdr agent start`, which lands a stranger the roster has to notice. The
 * brief is submitted after startup readiness and verified against the native
 * transcript before the hire succeeds; an unverifiable receipt fails typed.
 */
export type HireSeat = (
  seat: SpawnOperatorSeat,
  brief?: string,
  authority?: ConversationAuthority,
) => Promise<OperatorSeatSpawnResult>;

/**
 * The captain's own message into a hired seat, down the same lane an operator
 * DM takes (harness control, native queue, or bound mailbox). This
 * is how he follows up with one (VUH-1373). `seat` is the seatId,
 * personaId, or conversationId `hire_agent` returned.
 */
export type MessageSeat = (
  seat: string,
  message: string,
  /** Host-captured leading conversation; never a worker-selected route. */
  authority?: ConversationAuthority,
  /** A response to one observed native request, never a new worker turn. */
  questionAnswer?: import("@clankie/agent-hosts").SeatQuestionAnswer,
) => Promise<SeatMessageResult>;
type SeatMessageResult = { readonly deliveryStage?: DeliveryStage } & (
  | (Extract<FleetSeatDelivery, { outcome: "delivered" }> & {
      readonly seatId: string;
      readonly status: string;
      /** Set when another conversation leads this hire; messaging it did not change that (VUH-1763). */
      readonly ownerConversationId?: string;
    })
  | (Extract<FleetSeatDelivery, { outcome: "unconfirmed" | "undelivered" }> & { readonly seatId: string })
  | { readonly outcome: "seat_offline"; readonly seatId: string }
  | { readonly outcome: "unknown_seat"; readonly seat: string }
);

export const VOICE_SELF_TOOL_NAMES = ["recall_episodes", "get_self_state", "remember_episode"] as const;
type VoiceSelfToolName = (typeof VOICE_SELF_TOOL_NAMES)[number];
interface VoiceSelfToolInput {
  readonly guildId: string;
  readonly channelId: string;
  /** Authenticated Discord speaker whose request led to the call, when there was one. */
  readonly speakerId?: string;
  readonly name: VoiceSelfToolName;
  readonly arguments: Record<string, unknown>;
}

export interface LaneToolResult {
  readonly content: readonly (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  )[];
  readonly isError?: boolean;
  /** Media the call attached, exactly as a pi turn would carry it on the reply. */
  readonly media?: CaptainTurnMedia;
}

/** One harness-neutral view of a lane's tools, with its own turn context (VUH-1085). */
export interface LaneToolBank {
  readonly lane: CaptainSessionLaneV2;
  readonly tools: readonly LaneTool[];
}

/** Exact health attempt settlement; submitted uncertainty is never acceptance. */
export type FleetHealthAlertDelivery =
  | { outcome: "accepted" }
  | { outcome: "unavailable" }
  | { outcome: "unconfirmed"; acknowledged?: () => boolean };

/**
 * The seam between the HTTP app and the pi-based captain. The app layer parses
 * and authenticates; the captain owns sessions, tools, and persona.
 */
export interface CaptainPort {
  prepareWorkHandoffIntent?(
    intent: import("@clankie/protocol").WorkHandoffIntent,
  ): ReturnType<typeof import("./free-agent-intent.ts").prepareWorkHandoffIntent>;
  prepareFreeAgentIntent?(
    intent: import("@clankie/protocol").FreeAgentIntent,
  ): ReturnType<typeof import("./free-agent-intent.ts").prepareFreeAgentIntent>;
  restartWorkerTools?(
    input: import("@clankie/protocol/tool-catalog").FleetWorkerToolRestartRequest,
    authority: import("../worker-tool-refresh.ts").WorkerCatalogRefreshAuthority,
  ): Promise<import("@clankie/protocol/tool-catalog").FleetWorkerToolRestartResult>;
  workerCatalogSeats?(): Promise<
    readonly {
      paneId: string;
      seatId: string;
      harness: string;
      sessionId?: string;
      status?: string;
      ownerConversationId?: string;
    }[]
  >;
  refreshNativeWorkerCatalog?(
    paneId: string,
    input: { revision: string; beforeDispatch?: () => Promise<void> },
  ): Promise<{ outcome: "refreshed" | "skipped-busy" | "failed"; reason: string }>;
  fleetEfficiency?(
    conversationId: string,
    review?: import("./fleet-efficiency-tools.ts").FleetEfficiencyReview,
  ): Promise<{ conversationId: string; seats: readonly import("@clankie/protocol").OperatorFleetSeat[] }>;
  checkoutReport?(): Promise<import("@clankie/protocol").CheckoutReport>;
  syncCheckouts?(repository?: string): Promise<import("@clankie/settings").CheckoutSyncResult[]>;
  /** Record worth_landing or safe_to_drop for one linked worktree's unlanded work (VUH-1814). */
  decideWorktree?(input: {
    repository: string;
    path: string;
    decision: "worth_landing" | "safe_to_drop";
    reason: string;
  }): Promise<import("@clankie/protocol").WorktreeDecision>;
  pruneWorktree?(
    repository: string,
    path: string,
  ): Promise<import("./prune-worktree.ts").PruneWorktreeResult>;
  tidyWorktrees?(
    repository: string,
    mergedInto?: string,
  ): ReturnType<import("./pane-tidy.ts").PaneTidy["worktrees"]>;
  harnessProcesses?(retire?: boolean): Promise<unknown>;
  /** A live native operator bridge can answer independently of the fallback model (default: the global chat). */
  operatorSeatReady?(conversationId?: string): boolean;
  /** Current host-bound persona for the exact native seat and occupant. */
  personaForFleetOccupant(seatId: string, occupantId: string): string | undefined;
  projectHireMembershipCandidate(fleet: string, pane: string): ProjectHireMembershipCandidate;
  confirmedProjectHireAssignment(
    fleet: string,
    pane: string,
    revision: string,
    proof: ProjectHireProcessProof,
  ): ProjectHireAssignment;
  lookupProjectHire(proof: ProjectHireProcessProof): Promise<ProjectHireAssignment>;
  /** Host-only persisted ownership. Inspection and caller-supplied IDs grant no route authority. */
  designatedConversationHead(conversationId: string): ConversationOwner | undefined;
  setDesignatedConversationHead(
    conversationId: string,
    headConversationId: string | null,
  ): Promise<OperatorConversation>;
  validateConversationOwner(owner: ConversationOwner, mode?: "machine" | "social"): Promise<boolean>;
  /** Native lead delivery, or default owner for aggregate health; never a service model turn. */
  notifyFleetHealthAlert(
    pane: string | undefined,
    text: string,
    observe?: (delivery: FleetHealthAlertDelivery) => void,
  ): Promise<boolean>;
  notifyRuntimeHealthAlert(text: string): Promise<boolean>;
  /** Record a service notice in the owner's default conversation; never a model turn (VUH-1702). */
  recordRuntimeHealthNotice(text: string): boolean;
  wakeConversation(
    owner: ConversationOwner,
    text: string,
    guard?: () => Promise<void>,
    mode?: "machine" | "social",
    allowHeadFallback?: boolean,
  ): Promise<boolean>;
  bodyRoomConversation(lane: "discord_presence" | "discord_voice", targetId: string): string;
  evaluatorStatus(): EvaluatorStatus;
  evaluatorCommand(command: EvaluatorCommand): Promise<EvaluatorStatus>;
  /**
   * One Discord text/voice message becomes one captain turn, unless a text
   * follow-up steers the same sender's running handoff under the same grant.
   */
  submitDiscordTurn(
    request: DiscordPresenceChannelTurnRequest,
    authority?: {
      readonly verifiedOwner: boolean;
      /** Host-only current source proof from authenticated hosted ingress. */
      readonly sourceCurrent?: () => boolean;
    },
  ): Promise<CaptainChannelTurnResult>;
  /**
   * One message from a guild channel a Clankie channel is projected onto
   * (ADR 0146). Answers whether this service took it: a channel projected here
   * runs its round, and anything else is left for ordinary Discord ingress.
   */
  submitChannelProjectionMessage(
    request: DiscordChannelProjectionMessage,
  ): Promise<DiscordChannelProjectionMessageResult>;
  /** Callable operator service; read cancellation stops conversation tails without interrupting turns. */
  serveOperatorConversation(
    request: OperatorConversationServiceRequest,
    authority?: QuestionAuthority,
    readSignal?: AbortSignal,
  ): Promise<OperatorConversationServiceResult>;
  invalidateQuestionPrincipal?(deviceId: string): void;
  /** Lane transcript snapshots for the TUI lanes view. */
  observeLanes(): Promise<readonly ObservableCaptainLane[]>;
  /**
   * Recent settled-turn metrics, newest first, from the durable JSONL the
   * captain already appends (VUH-1115). Counters and execution identity only —
   * no transcript, tool arguments, or credentials.
   */
  readTurnMetrics(query: {
    readonly limit?: number;
    readonly runId?: string;
  }): Promise<readonly CaptainTurnSettledMetrics[]>;
  readIssueMetrics(query: IssueMetricsQuery): Promise<IssueMetricsReport>;
  /** Prompt fragment describing the voice lane, for the realtime voice briefing. */
  voiceLaneInstructions(): string;
  /**
   * One of the captain's own self tools (`recall_episodes`, `get_self_state`,
   * `remember_episode`) run in the `discord_voice` lane for this voice room,
   * from that lane's tool bank, so visibility and defaults are the lane's own.
   */
  voiceSelfTool(input: VoiceSelfToolInput): Promise<LaneToolResult>;
  /**
   * The system prompt a lane's pi session starts from, readable outside a pi
   * session so a seat launcher or a per-turn hook can carry it into another
   * harness. Sections default to what the session itself is built with.
   */
  syncSeatTranscript(conversationId: string, transcript: SeatTranscriptUpload): boolean;
  seatContext(conversationId?: string): { conversationId: string; cwd: string } | undefined;
  /** Service-observed turn/driver completion; unavailable evidence must not authorize automatic body stop. */
  conversationTurnIdle(conversationId: string): boolean;
  /** A native seat's turn end is never service-observed, so its expired bodies wait for its own recovery. */
  conversationHasNativeSeat(conversationId: string): boolean;
  lanePrompt(input: {
    readonly lane: CaptainSessionLaneV2;
    readonly sections?: readonly CaptainPromptSection[];
    readonly conversationId?: string;
    /** The seat's harness, so instructions it already loads natively are left out. */
    readonly harness?: PromptHarness;
  }): Promise<string>;
  /** The memory card that lane's next run would inject, filtered the same way. */
  laneMemoryCard(lane: CaptainSessionLaneV2): Promise<string>;
  /**
   * The seat's outbox (ADR 0152): wakes, watches, and escalations for a bound
   * head, long-polled by its bridge. Polling is what binds the head.
   */
  acknowledgeSeatEvent(eventId: string, conversationId?: string): Promise<boolean>;
  acknowledgeFleetSeatEvent(paneId: string, eventId: string): Promise<boolean>;
  pollSeatEvents(
    waitMs: number,
    signal?: AbortSignal,
    conversationId?: string,
    capabilities?: import("@clankie/protocol").OperatorSeatCapabilities,
  ): Promise<readonly OperatorSeatEvent[]>;
  /**
   * A fleet seat's mailbox (ADR 0161): a DM or room turn for the agent in that
   * pane, long-polled by `clankie mcp --seat`. `undefined` when no messageable
   * agent is in the pane — a normal early state the bridge retries. Polling is
   * what binds the mailbox.
   */
  pollFleetSeatEvents(
    paneId: string,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<readonly OperatorSeatEvent[] | undefined>;
  /** Session-bound native acceptance evidence. Reports grant no tool authority. */
  recordSeatToolCatalog(
    paneId: string,
    report: FleetSeatToolCatalog,
    workerTools: readonly string[],
    proof?: ProjectProcessProof,
  ): Promise<FleetSeatToolCatalogHealth | undefined>;
  toolCatalogHealth(): Promise<FleetToolCatalogHealthPage>;
  /**
   * One lifecycle hook from a hired seat's worker plugin (VUH-1458). False
   * when the pane holds no seat with that session.
   */
  /** Typed native channel prompt; the host observes its session and never accepts a verdict here. */
  recordSeatPermission(
    paneId: string,
    request: ClaudeChannelPermissionRequest,
    bridgeId: string,
    signal?: AbortSignal,
  ): Promise<false | { readonly sessionId: string; readonly hookOutput: Record<string, unknown> }>;
  recordSeatHook(
    paneId: string,
    hook: FleetSeatHook,
    proof?: ProjectProcessProof,
    signal?: AbortSignal,
  ): Promise<
    | boolean
    | { readonly recorded: true; readonly additionalContext: string; readonly messageIds: readonly string[] }
    | { readonly recorded: true; readonly hookOutput: Record<string, unknown> }
  >;
  /**
   * An agent in that pane writing to him (ADR 0213 phase 2). It wakes his
   * operator conversation as untrusted agent output; false when the pane
   * holds no messageable agent.
   */
  fleetSeatMessageBinding(paneId: string): Promise<string | undefined>;
  fleetSeatMessageStatus(paneId: string, deliveryId: string): Promise<FleetSeatMessageStatus | undefined>;
  reconcileFleetSeatMessage(
    paneId: string,
    delivery: FleetSeatMessageDelivery,
    fingerprint: string,
  ): Promise<FleetSeatMessageReceipt>;
  receiveFleetSeatMessage(
    paneId: string,
    text: string,
    delivery?: FleetSeatMessageDelivery,
    /** Host request budget/cancellation, never worker-supplied authority. */
    request?: InboundSeatRequest,
  ): Promise<boolean | FleetSeatMessageReceipt>;
  listFleetPeerSeats(authority: PeerSeatAuthority): Promise<FleetPeerSeats | undefined>;
  sendFleetPeerMessage(authority: PeerSeatAuthority, input: FleetPeerMessage): Promise<FleetPeerReceipt>;
  reconcileFleetPeerMessage(
    authority: PeerSeatAuthority,
    delivery: FleetSeatMessageDelivery,
    fingerprint: string,
  ): Promise<FleetPeerReceipt | undefined>;
  /** The seat's answer to an escalation; false when nothing waits on that id. */
  replySeatEvent(eventId: string, text: string, conversationId?: string): Promise<boolean>;
  /**
   * That lane's authority plan as callable tools, for a seat in another harness
   * (VUH-1085). Each call opens its own turn context, so one seat's attachments
   * and room never leak into another's.
   */
  laneToolBank(lane: CaptainSessionLaneV2, conversationId?: string): Promise<LaneToolBank>;
  /** Read-only exact native delivery reconciliation; operator conversation only. */
  reconcileSeatDelivery?(id: string, conversationId?: string): Promise<FleetSeatDelivery | undefined>;
  /**
   * The in-flight owner-directed room turn (`room_turn`, ADR 0218) a Discord
   * route names by fork ID. Its authority replaces a delivery receipt.
   */
  roomForkGrant?(id: string): import("./captain-discord-turns.ts").RoomForkGrant | undefined;
  /**
   * Subscribe to durable messages this captain's conversations write, for
   * delivery that happens outside the conversation (push wakes, ADR 0159). The
   * notice is metadata; the subscription is this captain's, so a second service
   * instance in one process never hears another's transcripts. Returns an
   * unsubscribe.
   */
  observeDurableMessages(listener: (notice: DurableMessageNotice) => void): () => void;
  /** Settled owner asks, after they are durable. Returns an unsubscribe. */
  observeQuestionResolutions(
    listener: (question: import("@clankie/protocol").ConversationQuestion) => void,
  ): () => void;
  /** Raise an owner ask from the host in an existing chat (ADR 0245 surface ask). */
  requestOwnerAsk(
    conversationId: string,
    draft: import("./conversation-questions.ts").QuestionDraft,
  ): Promise<import("@clankie/protocol").ConversationQuestionResult>;
  fleetConversationAuthority(principalId: string): Promise<ConversationAuthority | undefined>;
  fleetWriteAuthority(
    principalId: string,
    nativeWriteProof?: () => Promise<ProjectProcessProof | undefined>,
  ): Promise<WorkerWriteAuthority | undefined>;
  /** True for an existing ordinary global or workspace chat that may receive Linear wakes. */
  linearWakeTargetAllowed(conversationId: string): boolean;
  linearWakeDeliveries(): ReturnType<import("./conversations.ts").ConversationStore["linearWakeDeliveries"]>;
  /** Append verified external context to the selected ordinary chat and optionally wake it. */
  receiveLinearActivity(
    activity: LinearActivityEvent,
    following: boolean,
    conversationId?: string,
  ): boolean | void;
  /** Graceful shutdown: waits for in-flight turns. */
  close(): Promise<void>;
}

export type LaneObservationEntry = CaptainLaneObservationEntry;

/** A direct room read accepts a model-supplied lane before visibility checks. */
export interface LaneObservation {
  readonly lane: string;
  readonly targetId: string;
  readonly entries: readonly LaneObservationEntry[];
}

/** Test stand-in so the app layer can be exercised without a model. */
export function createStubCaptain(overrides: Partial<CaptainPort> = {}): CaptainPort {
  return {
    personaForFleetOccupant: () => undefined,
    projectHireMembershipCandidate: () => ({ state: "none" }),
    confirmedProjectHireAssignment: () => ({ state: "invalid" }),
    lookupProjectHire: async () => ({ state: "none" }),
    evaluatorStatus: () => ({
      schemaVersion: 1,
      enabled: false,
      harness: "codex",
      directory: "",
      queued: 0,
      jobs: [],
    }),
    evaluatorCommand: async () => ({
      schemaVersion: 1,
      enabled: false,
      harness: "codex",
      directory: "",
      queued: 0,
      jobs: [],
    }),
    submitDiscordTurn: async () => ({
      state: "settled",
      captainSessionId: "stub-session",
      turnId: "stub-turn",
      response: "stub response",
    }),
    submitChannelProjectionMessage: async () => ({ schemaVersion: 1, state: "not_projected" }),
    serveOperatorConversation: async () => {
      throw new Error("stub captain: serveOperatorConversation not overridden");
    },
    observeLanes: async () => [],
    readTurnMetrics: async () => [],
    readIssueMetrics: async () => {
      throw new Error("Issue metrics unavailable");
    },
    voiceLaneInstructions: () => "You are in a voice room.",
    voiceSelfTool: async () => {
      throw new Error("stub captain: voiceSelfTool not overridden");
    },
    syncSeatTranscript: () => true,
    seatContext: (conversationId) => ({ conversationId: conversationId ?? "global-default", cwd: "/tmp" }),
    conversationTurnIdle: () => false,
    conversationHasNativeSeat: () => false,
    lanePrompt: async ({ lane }) => `stub prompt for ${lane}`,
    designatedConversationHead: () => undefined,
    setDesignatedConversationHead: async () => {
      throw new Error("Conversation head configuration unavailable");
    },
    validateConversationOwner: async () => false,
    wakeConversation: async () => false,
    notifyFleetHealthAlert: async () => false,
    notifyRuntimeHealthAlert: async () => false,
    recordRuntimeHealthNotice: () => false,
    laneMemoryCard: async () => "",
    acknowledgeSeatEvent: async () => false,
    acknowledgeFleetSeatEvent: async () => false,
    pollSeatEvents: async () => [],
    pollFleetSeatEvents: async () => undefined,
    recordSeatToolCatalog: async () => undefined,
    toolCatalogHealth: async () => ({ schemaVersion: 1, seats: [] }),
    recordSeatHook: async () => false,
    recordSeatPermission: async () => false,
    fleetSeatMessageBinding: async () => undefined,
    fleetSeatMessageStatus: async () => undefined,
    reconcileFleetSeatMessage: async (_pane, delivery, fingerprint) => ({
      schemaVersion: 1,
      received: false,
      deliveryStage: "uncertain",
      deliveryId: delivery.id,
      binding: delivery.binding,
      fingerprint,
    }),
    receiveFleetSeatMessage: async () => false,
    listFleetPeerSeats: async () => undefined,
    sendFleetPeerMessage: async () => {
      throw new Error("Peer delivery unavailable");
    },
    reconcileFleetPeerMessage: async () => undefined,
    replySeatEvent: async () => false,
    bodyRoomConversation: (lane, targetId) => `room:${lane}:${targetId}`,
    laneToolBank: async (lane) => ({ lane, tools: [] }),
    // A stub writes no transcripts, so it has nothing to announce. A test that
    // wants the trigger passes its own store's observer through `overrides`.
    observeDurableMessages: () => () => {},
    observeQuestionResolutions: () => () => {},
    requestOwnerAsk: async (conversationId) => ({
      status: "refused",
      conversationId,
      reason: "owner_asks_unavailable",
    }),
    linearWakeTargetAllowed: (conversationId) => conversationId === "global-default",
    linearWakeDeliveries: () => [],
    receiveLinearActivity: () => true,
    fleetConversationAuthority: async () => undefined,
    fleetWriteAuthority: async () => undefined,
    close: async () => {},
    ...overrides,
  };
}
