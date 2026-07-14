import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";
import {
  compileDoctrine,
  createConnectorActionClassifier,
  createNarrativeWritePolicy,
  decideAction,
  decideCapabilityRequest,
  loadDoctrineFile,
  permitsCapabilityGrant,
  resolveAuthorityBinding,
  type ActionClassification,
  type CompiledDoctrine,
} from "@clankie/doctrine";
import type { EventStore } from "@clankie/event-store";
import {
  assertValidMissionPlan,
  MissionEngine,
  RecoveryConflictError,
  WorkerRunConflictError,
  type MissionSnapshot,
  type TaskRuntime,
} from "@clankie/mission-engine";
import { createLogger } from "@clankie/observability";
import {
  DISCORD_PRESENCE_LIVE_PHASE_HEADER,
  DISCORD_PRESENCE_LIVE_REVISION_HEADER,
  DISCORD_PRESENCE_LIVE_SESSION_HEADER,
  DiscordPresenceLiveClaimSchema,
  DiscordPresencePhaseEventSchema,
  isDiscordPresenceActionAvailable,
  resolveDiscordPresencePhaseToolExposure,
  type DiscordPresenceSessionRecord,
} from "@clankie/interactive-environment";
import {
  MemoryFactSchema,
  type ApplyProposalResult,
  type MemoryFact,
  type RecallCardOptions,
} from "@clankie/memory-store";
import {
  ApprovalDecisionInputSchema,
  ApprovalRequestRecordSchema,
  ApprovalRequestStatusSchema,
  ActionResourceSchema,
  ActionRequestSchema,
  CaptainChannelTurnResultSchema,
  CaptainPresenceReportSchema,
  DiscordPresenceChannelTurnRequestSchema,
  DiscordPresenceWriteSchema,
  resolveDiscordPresenceLedgerContent,
  LinearChannelTurnRequestSchema,
  MissionPlanSchema,
  MissionTriggerSchema,
  PairingCompleteRequestSchema,
  PairingRedeemRequestSchema,
  SUPERVISE_GRANTS,
  TaskSpecSchema,
  TrackerNarrativeWriteSchema,
  WorkerResultSchema,
  WorkerStatusProvenanceSchema,
  WorkerStatusStateSchema,
  WorkerTranscriptAuthFailureSchema,
  WorkerTranscriptKeySchema,
  WorkerTurnSettledDataSchema,
  WorkerTurnStartedDataSchema,
  WorkerWaitingUserDataSchema,
  assertValidDag,
  type ActionResource,
  type ActionDecision,
  type ActionRequest,
  type ApprovalRequestRecord,
  type CaptainChannelTurnResult,
  type DeviceGrantSet,
  type DeviceRecord,
  type DeviceSelfResponse,
  type DeviceSessionRefreshResponse,
  type DiscordPresenceWriteResult,
  type PairingCompleteResponse,
  type PairingRedeemResponse,
  type DomainEvent,
  type MissionPlan,
  type MissionTrigger,
  type Risk,
  type TaskSpec,
  type TrackerNarrativeWriteResult,
  type WorkerResult,
  type WorkerTranscriptKey,
  type WorkerTranscriptTailLine,
} from "@clankie/protocol";
import {
  TrackerAuthorityConflictError,
  TRACKER_AUTHORITY_ROLES,
  TrackerIssueMutationSchema,
  TrackerIssueRefSchema,
  TrackerMissionContractSchema,
  TrackerPolicyError,
  type AttentionDeliveryAdapter,
  type AttentionDeliveryStore,
  type LinearAgentRuntimePort,
  type TrackerEventAttribution,
  type TrackerMirrorPort,
} from "@clankie/tracker-connector";
import type {
  WorkerDescriptor,
  WorkerSteerCommand,
  WorkerSteerIntent,
  WorkerSteerSourceLane,
} from "@clankie/worker-sdk";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { CaptainPresenceLeaseConflictError, CaptainPresenceManager } from "./captain-presence.ts";
import {
  InMemoryWorkerSteeringStore,
  type StoredWorkerSteerCommand,
  type WorkerSteeringStore,
  type WorkerSteerOutcome,
} from "./worker-steering.ts";
import type { DiscordPresenceRuntimePort } from "./discord-presence-runtime.ts";
import { DiscordPresenceSessionProjection, discordPresenceDomainEvent } from "./discord-presence-session.ts";
import type { CaptainChannelTurnPort } from "./eve-captain-turn.ts";
import { applyMissionTriggerEvent, dueOccurrences, MissionTriggerInputSchema } from "./mission-triggers.ts";
import { mintPairingOffer, pairingOfferWire, PairingOfferStore } from "./pairing.ts";
import { applyDeviceEvent, deviceListItem, isDevicePendingExpired, type DeviceRegistry } from "./devices.ts";
import {
  COMPLETION_TOKEN_TTL_MS,
  DeviceSessionError,
  DeviceSessionSigner,
  mintDeviceSessionClaims,
} from "./device-session.ts";
import {
  DoctrineAttentionPolicy,
  EventStoreAttentionDeliveryStore,
  UnsupportedAttentionAdapter,
  createTrackerCeremonyRuntime,
  isProjectionEventStore,
  type WorkspaceBindingResolver,
} from "./tracker-ceremony.ts";
import type { WorkerTranscriptReadPort } from "./worker-transcripts.ts";

const logger = createLogger({ service: "clankie-control-plane", version: "0.1.0" });
const LINEAR_DELIVERY_RETENTION_MS = 7 * 60 * 60 * 1_000;

interface MissionRecord {
  id: string;
  goal: string;
  context: Record<string, unknown>;
  state: "draft" | "planned" | "running";
  plan?: MissionPlan;
  createdAt: string;
}

/**
 * A redeemed-but-not-yet-completed pairing, held in memory only (single-use,
 * ~10 min). The token secret is hashed into the map key; the value carries the
 * offered grants and expiry. A control-plane restart drops these, so an
 * in-flight pairing must restart — fail closed, same as an outstanding offer.
 */
interface PendingCompletion {
  deviceId: string;
  offeredGrants: DeviceGrantSet;
  expiresAtMs: number;
  consumed: boolean;
}

/** Index a completion token by hash so the raw secret is never stored. */
function hashCompletionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Drop completion tokens whose window has passed (consumed or not). */
function prunePendingCompletions(pending: Map<string, PendingCompletion>, now: Date): void {
  const nowMs = now.getTime();
  for (const [hash, record] of pending) {
    if (record.expiresAtMs <= nowMs) pending.delete(hash);
  }
}

/** True when every grant the device accepts was actually on offer. */
function isSubsetGrants(accepted: DeviceGrantSet, offered: DeviceGrantSet): boolean {
  return (Object.keys(accepted) as (keyof DeviceGrantSet)[]).every((key) => !accepted[key] || offered[key]);
}

interface StoredMemoryProposal {
  readonly proposalId: string;
  readonly approvalRequestId: string;
  readonly fact: MemoryFact;
  readonly submittedAt: string;
  readonly principal: { kind: "captain" | "worker"; id: string };
}

export interface MemoryStorePort {
  applyApprovedProposal(input: unknown): ApplyProposalResult;
  recallCard(options: RecallCardOptions): string;
  pruneRetention(now?: Date): readonly string[];
}

export interface ControlPlaneDependencies {
  doctrine: CompiledDoctrine;
  /** Durable mission event log; when provided, mission records are rebuilt from it on startup. */
  eventStore?: EventStore;
  /** Runner-owned audited broker boundary. The control plane never receives its signing key or credentials. */
  capabilityBroker?: CapabilityBroker;
  /** Authenticates the caller using runner/session state outside the request body. */
  authenticateWorker?: WorkerAuthenticator;
  /** Resolves policy facts from authoritative mission/check/approval state, never from the worker body. */
  resolveActionContext?: ActionContextProvider;
  /** Resolves risk from trusted connector metadata, never from the worker request body. */
  classifyConnectorAction?: ConnectorActionClassifier;
  /** Trusted metadata classifier for trigger CRUD. Defaults to the built-in trigger action catalog. */
  classifyTriggerAction?: ConnectorActionClassifier;
  /** Trusted bounded memory projection. Its SQLite handle remains private to the control plane. */
  memoryStore?: MemoryStorePort;
  /** Runner-owned privileged connector. Its credential access is not part of this interface. */
  githubConnector?: GithubConnector;
  /** Trusted policy-gated tracker mirror. Its provider credential is not part of this interface. */
  trackerMirror?: TrackerMirrorPort;
  /** Credential-free Linear agent runtime. OAuth remains inside its broker-backed implementation. */
  linearAgentRuntime?: LinearAgentRuntimePort;
  /** Trusted Eve turn adapter. Model credentials remain inside the Eve service. */
  captainChannelTurns?: CaptainChannelTurnPort;
  /**
   * Privileged Discord presence executor gated by the bridge-owned gateway session (ADR 0024).
   * Bot credentials remain inside the trusted runtime module.
   */
  discordPresenceRuntime?: DiscordPresenceRuntimePort;
  /** Authenticates the outbound local runner. Missing configuration leaves execution unavailable. */
  authenticateRunner?: RunnerAuthenticator;
  /** Authenticates the captain/operator starting an already validated plan. */
  authenticateCaptain?: CaptainAuthenticator;
  /** Authenticates a human on an approval-capable operator surface. */
  authenticateOperator?: OperatorAuthenticator;
  /**
   * HMAC key (≥32 bytes) that signs device session tokens (VUH-727). When
   * omitted, device authentication and pairing redemption fail closed (503).
   * Production loads it from a mode-0600 key file; tests inject bytes directly.
   */
  deviceSessionKey?: Uint8Array;
  /** Host name shown on a device's access-review screen. Defaults to the OS hostname. */
  hostDisplayName?: string;
  /** Repository path supplied to mission runtime metadata; providers remain runner-owned. */
  workspacePath?: string;
  workerLeaseDurationMs?: number;
  /** Test-tunable captain lease. Production uses the manager's bounded default. */
  captainLeaseDurationMs?: number;
  /** Test-tunable interval for sparse durable heartbeat records. */
  captainHeartbeatRecordIntervalMs?: number;
  /** Test-tunable memory maintenance cadence. Production defaults to one day. */
  memoryMaintenanceIntervalMs?: number;
  /** Test-tunable approval lifetime. Production defaults to fifteen minutes. */
  approvalRequestTtlMs?: number;
  clock?: () => Date;
  idFactory?: () => string;
  workerSteeringStore?: WorkerSteeringStore;
  authorizeWorkerSteer?: WorkerSteerAuthorizer;
  /**
   * Trusted workspace → binding resolver. Bindings are never taken from request bodies.
   * Required for human-attention delivery routes.
   */
  workspaceBindingResolver?: WorkspaceBindingResolver;
  /** Attention delivery adapter; defaults to unsupported-only when delivery is enabled. */
  attentionDeliveryAdapter?: AttentionDeliveryAdapter;
  /**
   * Durable attention delivery store. When omitted and eventStore is present,
   * EventStoreAttentionDeliveryStore is used. Without a durable store, deliver returns 503.
   * In-memory stores are test-only and must be injected explicitly.
   */
  attentionDeliveryStore?: AttentionDeliveryStore;
  /** Injected runner-owned transcript reader. The control plane never persists transcript entries. */
  workerTranscripts?: WorkerTranscriptReadPort;
}

export type WorkerSteerAuthorizer = (input: {
  principal: { kind: "captain" | "operator"; id: string };
  sourceLane: WorkerSteerSourceLane;
  intent: WorkerSteerIntent;
  commandId: string;
  correlationId: string;
  missionId: string;
  taskId: string;
  workerRunId: string;
  attempt: number;
  runnerId: string;
  profileHash: string;
  inputSha256: string;
  inputLength: number;
}) => Promise<{ allowed: boolean; reason: string }>;

export interface TrustedRunnerIdentity {
  runnerId: string;
}

export type RunnerAuthenticator = (request: Request) => Promise<TrustedRunnerIdentity | undefined>;

export interface TrustedCaptainIdentity {
  captainId: string;
  /** Server-authenticated origin for steering; request bodies cannot elevate it. */
  steerSourceLane?: Exclude<WorkerSteerSourceLane, "tui">;
}

export type CaptainAuthenticator = (request: Request) => Promise<TrustedCaptainIdentity | undefined>;

export interface TrustedOperatorIdentity {
  operatorId: string;
  /** Server-authenticated origin for steering. Defaults to the authenticated TUI lane. */
  steerSourceLane?: "tui" | "api";
}

export type OperatorAuthenticator = (request: Request) => Promise<TrustedOperatorIdentity | undefined>;

export interface TrustedDeviceIdentity {
  deviceId: string;
  grants: DeviceGrantSet;
  /** ISO expiry of the presented session token, echoed back to the device. */
  sessionExpiresAt: string;
}

/** Why a device session token was rejected — all fail closed, but the app renders them differently. */
export type DeviceAuthDenial = { denied: "expired" | "revoked" | "invalid" };

export interface TrustedWorkerIdentity {
  missionId: string;
  workerRunId: string;
  correlationId: string;
  profileHash: string;
  taskId?: string;
}

export type WorkerAuthenticator = (request: Request) => Promise<TrustedWorkerIdentity | undefined>;

export interface CapabilityActionInput {
  id: string;
  action: string;
  resource: ActionResource;
}

export interface TrustedActionContext {
  risk: Risk;
  checksPassed?: boolean;
  humanApprovals?: number;
  changedLines?: number;
  changedPaths?: string[];
  costSoFarUsd?: number;
}

export type ActionContextProvider = (
  identity: TrustedWorkerIdentity,
  request: CapabilityActionInput,
) => Promise<TrustedActionContext | undefined>;

export type ConnectorActionClassifier = (
  request: CapabilityActionInput,
) => ActionClassification | undefined | Promise<ActionClassification | undefined>;

export interface CapabilityGrantInput {
  version: 1;
  grantId: string;
  principalId: string;
  missionId: string;
  profileHash: string;
  capabilities: string[];
  resources: string[];
  obligations: string[];
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export interface CapabilityAuditContext {
  missionId: string;
  workerRunId: string;
  correlationId: string;
  profileHash: string;
  taskId?: string;
}

export interface CapabilityBroker {
  issue(grant: CapabilityGrantInput, context: CapabilityAuditContext): Promise<string>;
  authorizeUse(
    request: { token: string; capability: string; resource?: string },
    context: CapabilityAuditContext,
    nowEpochSeconds?: number,
  ): Promise<{ allowed: boolean; reason: string; grant?: { obligations: string[] } }>;
}

export interface GithubConnectorOperation {
  operationId: string;
  action: string;
  resource: ActionResource;
  missionId: string;
  workerRunId: string;
  correlationId: string;
  obligations: string[];
  taskId?: string;
}

export interface GithubConnector {
  execute(operation: GithubConnectorOperation): Promise<void>;
}

const CapabilityActionSchema = z.object({
  id: z.string().min(1),
  action: z.string().min(1),
  resource: ActionResourceSchema,
});

const CapabilityRequestSchema = z.object({
  request: CapabilityActionSchema,
  ttlSeconds: z
    .number()
    .int()
    .positive()
    .max(15 * 60)
    .default(5 * 60),
});

const ConnectorUseSchema = z.object({
  token: z.string().min(1),
  request: CapabilityActionSchema,
});

const WorkerDescriptorSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  harness: z.enum(["codex", "claude", "pi", "local", "shell", "simulated"]),
  model: z.string().min(1).optional(),
  capabilities: z.object({
    kinds: z.array(
      z.enum([
        "context",
        "planning",
        "research",
        "design",
        "implementation",
        "debugging",
        "verification",
        "review",
        "integration",
        "deployment",
        "evaluation",
      ]),
    ),
    canWrite: z.boolean(),
    supportsStructuredEvents: z.boolean(),
    supportsTerminal: z.boolean(),
    supportsNativeSession: z.boolean(),
  }),
});

const RunnerClaimSchema = z.object({
  claimId: z.string().min(1),
  workers: z.array(WorkerDescriptorSchema).min(1),
});

const RunnerEventSchema = z.object({
  attempt: z.number().int().positive(),
  eventId: z.string().min(1),
  type: z.string().min(1),
  data: z.record(z.string(), z.unknown()).default({}),
});

const RunnerSettleSchema = z.object({
  attempt: z.number().int().positive(),
  result: WorkerResultSchema,
});

const RunnerHeartbeatSchema = z.object({ attempt: z.number().int().positive() });

const WorkerSteerIntentSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("focus"),
      target: z.enum(["current_task", "failing_test", "acceptance_criteria", "scope", "diagnosis"]),
    })
    .strict(),
  z.object({ type: z.literal("continue") }).strict(),
  z.object({ type: z.literal("retry_last_step") }).strict(),
  z.object({ type: z.literal("summarize_status") }).strict(),
]);

const WorkerSteerRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    commandId: z.string().trim().min(1).max(200),
    /** Compatibility assertion only; authenticated identity remains authoritative. */
    sourceLane: z.enum(["tui", "discord_text", "discord_voice", "api"]).optional(),
    correlationId: z.string().trim().min(1).max(200),
    intent: WorkerSteerIntentSchema.optional(),
    input: z.string().trim().min(1).max(20_000).optional(),
  })
  .strict()
  .refine((request) => Number(request.intent !== undefined) + Number(request.input !== undefined) === 1, {
    message: "Exactly one typed intent or legacy canonical input is required",
  });

const RunnerSteerClaimSchema = z
  .object({ workerRunId: z.string().min(1), attempt: z.number().int().positive() })
  .strict();

const WorkerSteerOutcomeSchema = z
  .object({
    code: z.enum([
      "delivered",
      "stale_attempt",
      "wrong_runner",
      "worker_terminal",
      "lease_expired",
      "unsupported_adapter",
      "human_control_active",
      "delivery_failed",
    ]),
    message: z.string().trim().min(1).max(1_000),
  })
  .strict();

const RunnerSteerSettlementSchema = z
  .object({
    commandId: z.string().min(1),
    workerRunId: z.string().min(1),
    attempt: z.number().int().positive(),
    outcome: WorkerSteerOutcomeSchema,
  })
  .strict();

const RecoveryRequestSchema = z
  .object({
    commandId: z.string().min(1),
    failedTaskId: z.string().min(1),
    debugger: TaskSpecSchema,
    reverify: TaskSpecSchema,
  })
  .strict();

const RunnerGenericStatusDataSchema = WorkerStatusProvenanceSchema.extend({
  state: WorkerStatusStateSchema,
  basis: z.string().min(1).optional(),
  questionSummary: z.string().trim().min(1).optional(),
})
  .strict()
  .refine((signal) => signal.tier !== 0, "Generic status signals cannot claim Tier 0");

const TrackerImportSchema = z.object({ ref: TrackerIssueRefSchema });
const TrackerMutationRequestSchema = z.object({
  mutation: TrackerIssueMutationSchema,
  idempotencyKey: z.string().min(1),
});

const MemoryProposalRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    proposalId: z.string().min(1).max(256),
    fact: MemoryFactSchema,
  })
  .strict();

const ApprovalStatusQuerySchema = z.object({
  status: ApprovalRequestStatusSchema.default("pending"),
});

const TRACKER_NARRATIVE_ACTION_METADATA = [
  {
    action: "tracker.comment.create",
    riskClass: "narrative-write" as const,
    narrativeKind: "issue-comment" as const,
  },
  {
    action: "tracker.agent-activity.thought.create",
    riskClass: "narrative-write" as const,
    narrativeKind: "agent-activity-thought" as const,
  },
  {
    action: "tracker.agent-activity.response.create",
    riskClass: "narrative-write" as const,
    narrativeKind: "agent-activity-response" as const,
  },
  {
    action: "tracker.agent-activity.elicitation.create",
    riskClass: "narrative-write" as const,
    narrativeKind: "agent-activity-elicitation" as const,
  },
  {
    action: "tracker.reaction.create",
    riskClass: "narrative-write" as const,
    narrativeKind: "emoji-reaction" as const,
  },
] as const;

/** Shared Discord narrative entries — single source for tracker classifier + presence classifier. */
const DISCORD_PRESENCE_NARRATIVE_ACTION_METADATA = [
  {
    action: "discord.presence.reply",
    riskClass: "narrative-write" as const,
    narrativeKind: "discord-reply" as const,
  },
  {
    action: "discord.presence.react",
    riskClass: "narrative-write" as const,
    narrativeKind: "discord-react" as const,
  },
  {
    action: "discord.presence.unreact",
    riskClass: "narrative-write" as const,
    narrativeKind: "discord-unreact" as const,
  },
  {
    action: "discord.presence.send_message",
    riskClass: "narrative-write" as const,
    narrativeKind: "discord-send-message" as const,
  },
  {
    action: "discord.presence.typing_start",
    riskClass: "narrative-write" as const,
    narrativeKind: "discord-typing" as const,
  },
] as const;

const DISCORD_PRESENCE_NON_NARRATIVE_ACTION_METADATA = [
  { action: "discord.presence.edit_own_message", riskClass: "reversible-write" as const },
  { action: "discord.presence.delete_own_message", riskClass: "reversible-write" as const },
  { action: "discord.presence.create_thread", riskClass: "reversible-write" as const },
  { action: "discord.presence.join_thread", riskClass: "reversible-write" as const },
  { action: "discord.presence.voice_join", riskClass: "reversible-write" as const },
  { action: "discord.presence.voice_leave", riskClass: "reversible-write" as const },
  { action: "discord.presence.send_attachment", riskClass: "publish-external" as const },
  { action: "discord.presence.go_live_start", riskClass: "publish-external" as const },
  { action: "discord.presence.go_live_stop", riskClass: "publish-external" as const },
] as const;

const classifyNarrativeAction = createConnectorActionClassifier([
  ...TRACKER_NARRATIVE_ACTION_METADATA,
  ...DISCORD_PRESENCE_NARRATIVE_ACTION_METADATA,
]);

const classifyDiscordPresenceAction = createConnectorActionClassifier([
  ...DISCORD_PRESENCE_NARRATIVE_ACTION_METADATA,
  ...DISCORD_PRESENCE_NON_NARRATIVE_ACTION_METADATA,
]);

const classifyBuiltInTriggerAction = createConnectorActionClassifier([
  { action: "mission.trigger.write", riskClass: "reversible-write" },
]);

const ALLOWED_RUNNER_EVENT_TYPES = new Set([
  "worker.native_session.bound",
  "worker.turn.started",
  "worker.turn.settled",
  "worker.waiting_user",
  "worker.status.signal",
  "worker.command.completed",
  "worker.file_change.completed",
  "worker.plan.updated",
  "worker.diff.updated",
]);

export async function createControlPlane(dependencies: ControlPlaneDependencies): Promise<Hono> {
  const clock = dependencies.clock ?? (() => new Date());
  const idFactory = dependencies.idFactory ?? randomUUID;
  const missions = new Map<string, MissionRecord>();
  const missionTriggers = new Map<string, MissionTrigger>();
  const memoryProposals = new Map<string, StoredMemoryProposal>();
  const committedMemoryProposals = new Set<string>();
  const engines = new Map<string, MissionEngine>();
  const missionLocks = new Map<string, Promise<unknown>>();
  const approvalLocks = new Map<string, Promise<unknown>>();
  const discordPresenceLocks = new Map<string, Promise<unknown>>();
  const discordPresenceSessionLocks = new Map<string, Promise<unknown>>();
  const triggerEvaluationLocks = new Map<string, Promise<unknown>>();
  const claimMissions = new Map<string, string>();
  const approvalRequests = new Map<string, ApprovalRequestRecord>();
  const pairingOffers = new PairingOfferStore();
  const devices: DeviceRegistry = new Map<string, DeviceRecord>();
  const deviceLocks = new Map<string, Promise<unknown>>();
  const completionTokens = new Map<string, PendingCompletion>();
  const deviceSessionSigner =
    dependencies.deviceSessionKey === undefined
      ? undefined
      : new DeviceSessionSigner(dependencies.deviceSessionKey);
  const hostDisplayName = dependencies.hostDisplayName ?? hostname();
  const narrativeResults = new Map<
    string,
    { fingerprint: string; result: TrackerNarrativeWriteResult; expiresAtMs: number }
  >();
  const discordPresenceResults = new Map<
    string,
    { fingerprint: string; result: DiscordPresenceWriteResult; expiresAtMs: number }
  >();
  const DISCORD_PRESENCE_RETENTION_MS = 7 * 60 * 60 * 1_000;
  const APPROVAL_REQUEST_TTL_MS = dependencies.approvalRequestTtlMs ?? 15 * 60 * 1_000;
  const captainTurnResults = new Map<
    string,
    { fingerprint: string; result: Promise<CaptainChannelTurnResult>; expiresAtMs: number }
  >();
  const narrativePolicy = createNarrativeWritePolicy(dependencies.doctrine, {
    now: () => clock().getTime(),
  });
  const consumedApprovalIds = new Set<string>();
  const storedEvents: DomainEvent[] = [];
  const steeringStore = dependencies.workerSteeringStore ?? new InMemoryWorkerSteeringStore();
  // Durable single-flight requires ProjectionEventStore (appendExpected/readStream).
  // Plain EventStore or missing store → deliver fails closed (503), never silent
  // process-local-only production default.
  const attentionStore =
    dependencies.attentionDeliveryStore ??
    (dependencies.eventStore !== undefined && isProjectionEventStore(dependencies.eventStore)
      ? new EventStoreAttentionDeliveryStore(dependencies.eventStore, {
          profileHash: dependencies.doctrine.profileHash,
          idFactory,
          clock,
        })
      : undefined);
  const ceremonyRuntime =
    attentionStore === undefined
      ? undefined
      : createTrackerCeremonyRuntime({
          doctrine: dependencies.doctrine,
          policy: new DoctrineAttentionPolicy(dependencies.doctrine),
          adapter: dependencies.attentionDeliveryAdapter ?? new UnsupportedAttentionAdapter(),
          store: attentionStore,
          bindingResolver: dependencies.workspaceBindingResolver ?? {
            resolve: () => undefined,
          },
          lookupVerifiedEvent: (eventId) => storedEvents.find((event) => event.id === eventId),
          clock,
        });
  if (dependencies.eventStore) {
    for (const stored of await dependencies.eventStore.readAll()) {
      storedEvents.push(stored.event);
      applyMissionEvent(missions, stored.event);
      applyMissionTriggerEvent(missionTriggers, stored.event);
      applyMemoryEvent(memoryProposals, committedMemoryProposals, stored.event);
      applyApprovalEvent(approvalRequests, consumedApprovalIds, stored.event);
      applyDeviceEvent(devices, stored.event);
      if (stored.event.type === "worker.leased" && typeof stored.event.data.claimId === "string") {
        claimMissions.set(stored.event.data.claimId, stored.event.missionId);
      }
    }
    logger.info({ missionCount: missions.size }, "mission records rebuilt from event store");
  }
  const discordPresenceSessions = new DiscordPresenceSessionProjection(storedEvents);
  // Durable replay restores status, but it cannot prove the bridge is still
  // connected. Act gating therefore starts unvalidated after every process
  // boot and remains fail-closed until an authenticated lifecycle delivery
  // re-establishes the live watermark.
  const discordPresenceLiveSessions = new Map<string, DiscordPresenceSessionRecord>();

  if (dependencies.trackerMirror) {
    for (const mission of missions.values()) {
      const parsed = TrackerMissionContractSchema.safeParse(mission.context.trackerContract);
      if (parsed.success) dependencies.trackerMirror.restore(parsed.data);
    }
  }

  const recordEvent = async (
    type: string,
    missionId: string,
    occurredAt: string,
    data: Record<string, unknown>,
    envelope: {
      taskId?: string;
      workerRunId?: string;
      correlationId?: string;
      profileHash?: string;
    } = {},
  ): Promise<DomainEvent> => {
    const event: DomainEvent = {
      id: idFactory(),
      occurredAt,
      missionId,
      correlationId: envelope.correlationId ?? missionId,
      profileHash: envelope.profileHash ?? dependencies.doctrine.profileHash,
      type,
      data,
      ...(envelope.taskId ? { taskId: envelope.taskId } : {}),
      ...(envelope.workerRunId ? { workerRunId: envelope.workerRunId } : {}),
    };
    if (dependencies.eventStore) await dependencies.eventStore.append(event);
    storedEvents.push(event);
    persistedEventIds.add(event.id);
    await syncTrackerEvent(event);
    return event;
  };

  const commitApprovedMemoryProposal = async (
    proposal: StoredMemoryProposal,
    approval: ApprovalRequestRecord,
  ): Promise<ApplyProposalResult | undefined> => {
    if (!dependencies.memoryStore || committedMemoryProposals.has(proposal.proposalId)) return undefined;
    if (
      approval.id !== proposal.approvalRequestId ||
      approval.action !== "memory.profile.write" ||
      approval.status !== "approved" ||
      approval.missionId !== proposal.fact.provenance.missionId ||
      approval.profileHash !== dependencies.doctrine.profileHash ||
      approval.decidedAt === undefined ||
      approval.decidedBy === undefined
    ) {
      throw new Error("Memory proposal approval does not match the authenticated approval projection");
    }
    const result = dependencies.memoryStore.applyApprovedProposal({
      schemaVersion: 1,
      proposalId: proposal.proposalId,
      approval: {
        approvalId: approval.id,
        status: "approved",
        approvedAt: approval.decidedAt,
        approvedBy: approval.decidedBy,
      },
      fact: proposal.fact,
    });
    await recordEvent(
      "memory.proposal.committed",
      proposal.fact.provenance.missionId,
      clock().toISOString(),
      {
        proposalId: proposal.proposalId,
        approvalRequestId: proposal.approvalRequestId,
        factId: result.fact.factId,
        merged: result.merged,
        evictedFactIds: [...result.evictedFactIds],
      },
      { correlationId: proposal.fact.provenance.correlationId },
    );
    committedMemoryProposals.add(proposal.proposalId);
    return result;
  };

  const pruneMemory = async (reason: "doctrine_loaded" | "maintenance"): Promise<readonly string[]> => {
    if (!dependencies.memoryStore) return [];
    const prunedFactIds = dependencies.memoryStore.pruneRetention(clock());
    await recordEvent("memory.retention.pruned", "memory:retention", clock().toISOString(), {
      reason,
      rawTranscriptRetentionDays: dependencies.doctrine.profile.memory.rawTranscriptRetentionDays,
      prunedFactIds: [...prunedFactIds],
    });
    return prunedFactIds;
  };

  const persistApprovalRequest = async (
    request: ActionRequest,
    rationale: ActionDecision,
    correlationId: string,
  ): Promise<ApprovalRequestRecord> =>
    withSerializedLock(approvalLocks, request.id, async () => {
      const existing = approvalRequests.get(request.id);
      if (existing) {
        if (!sameApprovalRequest(existing, request, correlationId)) {
          throw new Error(`Approval request id ${request.id} was reused for a different action`);
        }
        return existing;
      }
      const approval = ApprovalRequestRecordSchema.parse({
        id: request.id,
        missionId: request.context.missionId,
        taskId: request.context.taskId,
        workerRunId: request.principal.kind === "worker" ? request.principal.id : undefined,
        action: request.action,
        resource: request.resource,
        rationale,
        requestedAt: clock().toISOString(),
        status: "pending",
        correlationId,
        profileHash: request.context.profileHash,
      });
      await recordEvent(
        "approval.requested",
        approval.missionId,
        approval.requestedAt,
        { approval },
        approvalEnvelope(approval),
      );
      approvalRequests.set(approval.id, approval);
      return approval;
    });

  const expireApprovalIfNeeded = async (approval: ApprovalRequestRecord): Promise<ApprovalRequestRecord> => {
    if (approval.status !== "pending" || approval.resource.type !== "discord-attachment") return approval;
    const expiresAtMs = Date.parse(approval.requestedAt) + APPROVAL_REQUEST_TTL_MS;
    if (clock().getTime() < expiresAtMs) return approval;
    return withSerializedLock(approvalLocks, approval.id, async () => {
      const current = approvalRequests.get(approval.id);
      if (!current || current.status !== "pending") return current ?? approval;
      const decidedAt = clock().toISOString();
      const expired = ApprovalRequestRecordSchema.parse({
        ...current,
        status: "denied",
        decidedAt,
        decidedBy: "system:approval-expiry",
        reason: "approval_expired",
      });
      await recordEvent(
        "approval.decided",
        expired.missionId,
        decidedAt,
        { approval: expired },
        approvalEnvelope(expired),
      );
      approvalRequests.set(expired.id, expired);
      return expired;
    });
  };

  const persistedEventIds = new Set(storedEvents.map((event) => event.id));
  if (dependencies.memoryStore) {
    for (const proposal of memoryProposals.values()) {
      const approval = approvalRequests.get(proposal.approvalRequestId);
      if (approval?.status === "approved" && !committedMemoryProposals.has(proposal.proposalId)) {
        await commitApprovedMemoryProposal(proposal, approval);
      }
    }
    const previousRetention = [...storedEvents]
      .reverse()
      .find((event) => event.type === "memory.retention.pruned")?.data.rawTranscriptRetentionDays;
    if (previousRetention !== dependencies.doctrine.profile.memory.rawTranscriptRetentionDays) {
      await pruneMemory("doctrine_loaded");
    }
  }

  const memoryMaintenanceTimer = setInterval(
    () => {
      void pruneMemory("maintenance").catch((error: unknown) =>
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "memory retention maintenance failed",
        ),
      );
    },
    dependencies.memoryMaintenanceIntervalMs ?? 24 * 60 * 60 * 1_000,
  );
  memoryMaintenanceTimer.unref();
  const flushEngine = async (engine: MissionEngine): Promise<void> => {
    for (const event of engine.getEvents()) {
      if (persistedEventIds.has(event.id)) continue;
      if (dependencies.eventStore) await dependencies.eventStore.append(event);
      persistedEventIds.add(event.id);
      storedEvents.push(event);
      await syncTrackerEvent(event);
    }
  };

  async function syncTrackerEvent(event: DomainEvent): Promise<void> {
    if (!dependencies.trackerMirror || event.type === "tracker.sync.failed") return;
    try {
      await dependencies.trackerMirror.publish(event, trackerAttribution(event, missions, storedEvents));
    } catch (error) {
      const failure = trackerFailureEvent(event, error, dependencies.doctrine.profileHash, idFactory, clock);
      if (dependencies.eventStore) await dependencies.eventStore.append(failure);
      storedEvents.push(failure);
      persistedEventIds.add(failure.id);
      logger.warn(
        { missionId: event.missionId, taskId: event.taskId, sourceEventId: event.id },
        "tracker mirror write failed closed",
      );
    }
  }

  const captainPresence = new CaptainPresenceManager({
    profileHash: dependencies.doctrine.profileHash,
    replayEvents: storedEvents,
    clock,
    ...(dependencies.captainLeaseDurationMs === undefined
      ? {}
      : { leaseDurationMs: dependencies.captainLeaseDurationMs }),
    ...(dependencies.captainHeartbeatRecordIntervalMs === undefined
      ? {}
      : { recordedHeartbeatIntervalMs: dependencies.captainHeartbeatRecordIntervalMs }),
    emit: async ({ event }) => {
      if (persistedEventIds.has(event.id)) return;
      if (dependencies.eventStore) await dependencies.eventStore.append(event);
      storedEvents.push(event);
      persistedEventIds.add(event.id);
    },
    onBackgroundError: (error) => {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "captain lease reap failed",
      );
    },
  });

  for (const mission of missions.values()) {
    if (!mission.plan || mission.state !== "running") continue;
    if (mission.plan.profileHash !== dependencies.doctrine.profileHash) {
      throw new Error(`Cannot restore mission ${mission.id}: doctrine ${mission.plan.profileHash} is stale`);
    }
    const replayEvents = storedEvents.filter(
      (event) =>
        event.missionId === mission.id &&
        !["mission.drafted", "mission.planned", "mission.execution.started"].includes(event.type),
    );
    const engine = new MissionEngine(mission.plan, dependencies.doctrine, {
      workspacePath: dependencies.workspacePath ?? process.cwd(),
      replayEvents,
    });
    engines.set(mission.id, engine);
    await flushEngine(engine);
  }

  const withMissionLock = async <T>(missionId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = missionLocks.get(missionId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    missionLocks.set(missionId, next);
    try {
      return await next;
    } finally {
      if (missionLocks.get(missionId) === next) missionLocks.delete(missionId);
    }
  };

  const app = new Hono();

  const createMissionDraft = async (
    goal: string,
    missionContext: Record<string, unknown>,
    occurredAt = clock().toISOString(),
    requestedId?: string,
  ): Promise<string> => {
    const id = requestedId ?? `mission-${idFactory().slice(0, 12)}`;
    if (missions.has(id)) return id;
    await recordEvent("mission.drafted", id, occurredAt, { goal, context: missionContext });
    missions.set(id, { id, goal, context: missionContext, state: "draft", createdAt: occurredAt });
    logger.info({ missionId: id }, "mission created");
    return id;
  };

  const authorizeTriggerMutation = async (
    request: Request,
    triggerId: string,
  ): Promise<
    { allowed: true; operatorId: string } | { allowed: false; error: string; status: 401 | 403 | 503 }
  > => {
    const operator = await authenticateOperator(request, dependencies);
    if (operator === "unavailable")
      return { allowed: false, error: "operator_authentication_unavailable", status: 503 };
    if (!operator) return { allowed: false, error: "operator_authentication_required", status: 401 };
    const classifier =
      dependencies.classifyTriggerAction ??
      ((input: CapabilityActionInput) => classifyBuiltInTriggerAction(input.action));
    const input = {
      id: `trigger-write-${triggerId}`,
      action: "mission.trigger.write",
      resource: { type: "mission-trigger", id: triggerId },
    };
    const classification = await classifier(input);
    if (classification === undefined)
      return { allowed: false, error: "trigger_action_unclassified", status: 403 };
    const decision = decideAction(
      dependencies.doctrine,
      ActionRequestSchema.parse({
        ...input,
        principal: { kind: "human", id: operator.operatorId },
        context: {
          missionId: `trigger:${triggerId}`,
          risk: "low",
          humanApprovals: 0,
          profileHash: dependencies.doctrine.profileHash,
        },
      }),
      classification,
    );
    return decision.effect === "allow"
      ? { allowed: true, operatorId: operator.operatorId }
      : { allowed: false, error: `trigger_action_${decision.effect}`, status: 403 };
  };

  const evaluateDueTriggers = async (now: Date): Promise<{ fired: string[]; skipped: string[] }> => {
    return withSerializedLock(triggerEvaluationLocks, "all", async () => {
      const fired: string[] = [];
      const skipped: string[] = [];
      for (const current of [...missionTriggers.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      )) {
        const due = dueOccurrences(current, now);
        if (due.length === 0) continue;
        const scheduledAt = due[0]!.toISOString();
        const isLate =
          current.schedule.kind === "once"
            ? now.getTime() > due[0]!.getTime()
            : now.getTime() - due[0]!.getTime() >= 60_000;
        const shouldFire = !isLate || current.misfirePolicy === "run_once_late";
        const trigger = MissionTriggerSchema.parse({
          ...current,
          lastEvaluatedAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        if (shouldFire) {
          const missionId = await createMissionDraft(
            trigger.goal,
            {
              ...trigger.context,
              scheduledTrigger: { triggerId: trigger.id, scheduledAt },
              doctrineBudgets: {
                maxMissionCostUsd: dependencies.doctrine.profile.budgets.maxMissionCostUsd,
                maxMissionWallMinutes: dependencies.doctrine.scheduler.maxMissionWallMinutes,
                maxParallelWorkers: dependencies.doctrine.scheduler.maxParallelWorkers,
              },
            },
            now.toISOString(),
            `mission-${createHash("sha256").update(`${trigger.id}\0${scheduledAt}`).digest("hex").slice(0, 20)}`,
          );
          await recordEvent("mission.trigger.fired", `trigger:${trigger.id}`, now.toISOString(), {
            trigger,
            scheduledAt,
            missionId,
          });
          fired.push(trigger.id);
        } else {
          await recordEvent("mission.trigger.skipped", `trigger:${trigger.id}`, now.toISOString(), {
            trigger,
            scheduledAt,
          });
          skipped.push(trigger.id);
        }
        missionTriggers.set(trigger.id, trigger);
      }
      return { fired, skipped };
    });
  };

  const triggerTimer = setInterval(() => {
    void evaluateDueTriggers(clock()).catch((error: unknown) =>
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "mission trigger evaluation failed",
      ),
    );
  }, 30_000);
  triggerTimer.unref();

  /**
   * Authenticate a device session token against the durable projection. Returns
   * "unavailable" when no signing key is configured (503), a typed denial when
   * the token is missing/invalid/expired or the device is unknown/pending/revoked
   * (401, all fail closed), or the trusted identity with the device's current
   * grants read from the projection — never from the token.
   */
  const authenticateDevice = async (
    request: Request,
  ): Promise<TrustedDeviceIdentity | "unavailable" | DeviceAuthDenial> => {
    if (deviceSessionSigner === undefined) return "unavailable";
    const header = request.headers.get("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
    if (token === undefined || token.length === 0) return { denied: "invalid" };
    const now = clock();
    let claims;
    try {
      claims = deviceSessionSigner.verify(token, Math.floor(now.getTime() / 1000));
    } catch (error) {
      if (error instanceof DeviceSessionError && error.code === "expired") return { denied: "expired" };
      return { denied: "invalid" };
    }
    const record = devices.get(claims.deviceId);
    if (record === undefined || isDevicePendingExpired(record, now)) return { denied: "invalid" };
    if (record.status === "revoked") return { denied: "revoked" };
    if (record.status !== "active") return { denied: "invalid" };
    return {
      deviceId: record.deviceId,
      grants: record.grants,
      sessionExpiresAt: new Date(claims.expiresAt * 1000).toISOString(),
    };
  };

  const deviceDenialResponse = (context: Context, denial: DeviceAuthDenial) => {
    if (denial.denied === "revoked") return context.json({ error: "revoked" }, 401);
    if (denial.denied === "expired") return context.json({ error: "expired" }, 401);
    return context.json({ error: "device_authentication_required" }, 401);
  };

  const authorizeTranscriptRead = async (context: Context): Promise<Response | undefined> => {
    const identity = await authenticateDevice(context.req.raw);
    if (identity === "unavailable") {
      return context.json({ error: "worker_transcript_authentication_unavailable" }, 503);
    }
    if ("denied" in identity) {
      const reason =
        identity.denied === "expired"
          ? "session_expired"
          : identity.denied === "revoked"
            ? "device_revoked"
            : "authentication_required";
      return context.json(
        WorkerTranscriptAuthFailureSchema.parse({
          schemaVersion: 1,
          outcome: "auth_failed",
          reason,
        }),
        401,
      );
    }
    if (!identity.grants.chat) {
      return context.json(
        WorkerTranscriptAuthFailureSchema.parse({
          schemaVersion: 1,
          outcome: "auth_failed",
          reason: "permission_denied",
        }),
        403,
      );
    }
    return undefined;
  };

  app.get("/health", (context) =>
    context.json({
      ok: true,
      service: "clankie-control-plane",
      doctrine: dependencies.doctrine.profile.id,
      profileHash: dependencies.doctrine.profileHash,
    }),
  );

  app.post("/v1/tracker/narratives", async (context) => {
    if (!dependencies.linearAgentRuntime) {
      return context.json({ error: "linear_agent_runtime_unavailable" }, 503);
    }
    const parsed = TrackerNarrativeWriteSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_tracker_narrative" }, 400);
    const write = parsed.data;
    if (write.identity.profileHash !== dependencies.doctrine.profileHash) {
      return context.json({ error: "doctrine_hash_mismatch" }, 409);
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(write)).digest("hex");
    pruneExpired(narrativeResults, clock().getTime());
    const previous = narrativeResults.get(write.idempotencyKey);
    if (previous !== undefined) {
      if (previous.fingerprint !== fingerprint) {
        return context.json({ error: "narrative_idempotency_conflict" }, 409);
      }
      return context.json(previous.result);
    }
    const classification = classifyNarrativeAction(write.action);
    if (classification === undefined) return context.json({ error: "narrative_action_unclassified" }, 400);
    const request = ActionRequestSchema.parse({
      id: write.idempotencyKey,
      principal: { kind: "worker", id: write.identity.workerRunId, role: "linear-channel-adapter" },
      action: write.action,
      resource: { type: "linear-agent-session", id: write.agentSessionId },
      context: {
        missionId: write.identity.missionId,
        taskId: write.identity.taskId,
        risk: "low",
        profileHash: write.identity.profileHash,
      },
    });
    const decision = narrativePolicy.decide({
      request,
      classification,
      correlationId: write.identity.correlationId,
      content: write.content,
    });
    if (decision.effect !== "allow") {
      logger.warn(
        {
          service: "clankie-control-plane",
          missionId: write.identity.missionId,
          correlationId: write.identity.correlationId,
          action: write.action,
          effect: decision.effect,
        },
        "Linear narrative write denied",
      );
      return context.json({ error: "tracker_narrative_not_allowed", decision }, 403);
    }
    try {
      const result = await dependencies.linearAgentRuntime.writeNarrative(write);
      narrativeResults.set(write.idempotencyKey, {
        fingerprint,
        result,
        expiresAtMs: clock().getTime() + LINEAR_DELIVERY_RETENTION_MS,
      });
      logger.info(
        {
          service: "clankie-control-plane",
          missionId: write.identity.missionId,
          taskId: write.identity.taskId,
          workerRunId: write.identity.workerRunId,
          correlationId: write.identity.correlationId,
          action: write.action,
        },
        "Linear narrative write completed",
      );
      return context.json(result);
    } catch {
      return context.json({ error: "tracker_narrative_failed" }, 502);
    }
  });

  app.post("/v1/tracker/issue-drafts/validate", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_authentication_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    if (ceremonyRuntime === undefined) {
      return context.json({ error: "tracker_ceremony_runtime_unavailable" }, 503);
    }
    try {
      const body = await readJson(context.req.raw);
      const result = ceremonyRuntime.validateDraft(body);
      return context.json(result, result.ok ? 200 : 400);
    } catch (error) {
      if (error instanceof Error && error.message === "doctrine_hash_mismatch") {
        return context.json(
          { error: "doctrine_hash_mismatch", expected: dependencies.doctrine.profileHash },
          409,
        );
      }
      return context.json({ error: "invalid_issue_draft_validation" }, 400);
    }
  });

  app.post("/v1/tracker/human-attention/deliver", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_authentication_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    if (ceremonyRuntime === undefined || attentionStore === undefined) {
      return context.json({ error: "attention_delivery_store_unavailable" }, 503);
    }
    if (dependencies.workspaceBindingResolver === undefined) {
      return context.json({ error: "workspace_binding_resolver_unavailable" }, 503);
    }
    try {
      const body = await readJson(context.req.raw);
      const result = await ceremonyRuntime.deliverAttention(body);
      if (dependencies.eventStore) {
        const delivered = await attentionStore.get(result.requestId);
        await recordEvent(
          "tracker.human-attention.delivered",
          result.missionId,
          clock().toISOString(),
          {
            requestId: result.requestId,
            correlationId: result.correlationId,
            aggregate: result.aggregate,
            fingerprint: result.fingerprint,
            actions: result.actions,
          },
          {
            correlationId: result.correlationId,
            profileHash: dependencies.doctrine.profileHash,
            ...(delivered?.pending.request.taskId === undefined
              ? {}
              : { taskId: delivered.pending.request.taskId }),
            ...(delivered?.pending.request.workerRunId === undefined
              ? {}
              : { workerRunId: delivered.pending.request.workerRunId }),
          },
        );
      }
      return context.json(result);
    } catch (error) {
      if (error instanceof Error && error.message === "doctrine_hash_mismatch") {
        return context.json(
          { error: "doctrine_hash_mismatch", expected: dependencies.doctrine.profileHash },
          409,
        );
      }
      if (error instanceof Error && error.message === "workspace_binding_unavailable") {
        return context.json({ error: "workspace_binding_unavailable" }, 404);
      }
      logger.warn(
        {
          service: "clankie-control-plane",
          error: error instanceof Error ? error.message : String(error),
        },
        "human-attention delivery failed",
      );
      return context.json({ error: "human_attention_delivery_failed" }, 400);
    }
  });

  app.post("/v1/tracker/human-attention/correlate", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_authentication_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    if (ceremonyRuntime === undefined) {
      return context.json({ error: "tracker_ceremony_runtime_unavailable" }, 503);
    }
    try {
      const body = await readJson(context.req.raw);
      const result = await ceremonyRuntime.correlate(body);
      if ("ok" in result && result.ok === false) {
        return context.json(result, 409);
      }
      if (dependencies.eventStore && !("ok" in result) && attentionStore !== undefined) {
        const requestId =
          typeof (body as { requestId?: string }).requestId === "string"
            ? (body as { requestId: string }).requestId
            : result.requestId;
        const pending = await attentionStore.get(requestId);
        const missionId = pending?.result.missionId ?? "unknown";
        await recordEvent(
          "tracker.human-attention.responded",
          missionId,
          clock().toISOString(),
          { ...result },
          {
            correlationId: result.correlationId,
            profileHash: dependencies.doctrine.profileHash,
            ...(pending?.pending.request.taskId === undefined
              ? {}
              : { taskId: pending.pending.request.taskId }),
            ...(pending?.pending.request.workerRunId === undefined
              ? {}
              : { workerRunId: pending.pending.request.workerRunId }),
          },
        );
      }
      return context.json(result);
    } catch (error) {
      if (error instanceof Error && error.message === "doctrine_hash_mismatch") {
        return context.json(
          { error: "doctrine_hash_mismatch", expected: dependencies.doctrine.profileHash },
          409,
        );
      }
      return context.json({ error: "human_attention_correlation_failed" }, 400);
    }
  });

  app.post("/v1/discord/presence-session-events", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    if (captain.steerSourceLane !== "discord_text" && captain.steerSourceLane !== "discord_voice") {
      return context.json({ error: "discord_channel_authority_required" }, 403);
    }
    const parsed = DiscordPresencePhaseEventSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_discord_presence_phase_event" }, 400);
    const event = parsed.data;
    const sessionKey = discordPresenceBindingKey(event.data.session);
    return withSerializedLock(discordPresenceSessionLocks, sessionKey, async () => {
      const domainEvent = discordPresenceDomainEvent(event, dependencies.doctrine.profileHash);
      if (persistedEventIds.has(event.id)) {
        const existing = storedEvents.find((candidate) => candidate.id === event.id);
        if (existing === undefined || JSON.stringify(existing) !== JSON.stringify(domainEvent)) {
          return context.json({ error: "discord_presence_event_id_conflict" }, 409);
        }
        const session = discordPresenceSessions.resolve(event.data.session);
        if (session === undefined) {
          return context.json({ error: "discord_presence_event_id_conflict" }, 409);
        }
        // An idempotent acknowledgement proves only that this event is
        // durable, not that the bridge is live in this control-plane boot.
        // Only a genuinely new validated event below may open the act fence.
        return context.json({ accepted: false, session });
      }
      try {
        const durableBefore = discordPresenceSessions.resolve(event.data.session);
        const observed = discordPresenceSessions.validate(event);
        const advancesDurableRevision =
          durableBefore === undefined || observed.revision > durableBefore.revision;
        // The authenticated lifecycle event is live authority as soon as it
        // validates and strictly advances durable state. Advance this
        // watermark before durable append so a stale active claim cannot race
        // a loss transition awaiting persistence. A novel event id at an
        // already-durable revision is not evidence of liveness in this boot.
        if (advancesDurableRevision) discordPresenceLiveSessions.set(sessionKey, observed);
        if (dependencies.eventStore) await dependencies.eventStore.append(domainEvent);
        const session = discordPresenceSessions.apply(event);
        if (advancesDurableRevision) discordPresenceLiveSessions.set(sessionKey, session);
        storedEvents.push(domainEvent);
        persistedEventIds.add(domainEvent.id);
        return context.json({ accepted: true, session });
      } catch (error) {
        const code = error instanceof Error ? error.message : "discord_presence_session_conflict";
        return context.json({ error: code }, 409);
      }
    });
  });

  app.get("/v1/discord/presence-sessions", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    return context.json(discordPresenceSessions.list());
  });

  app.post("/v1/discord/presence-actions", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "captain_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    const revisionHeader = context.req.header(DISCORD_PRESENCE_LIVE_REVISION_HEADER);
    const liveClaim = DiscordPresenceLiveClaimSchema.safeParse({
      schemaVersion: 1,
      sessionId: context.req.header(DISCORD_PRESENCE_LIVE_SESSION_HEADER),
      phase: context.req.header(DISCORD_PRESENCE_LIVE_PHASE_HEADER),
      revision: revisionHeader === undefined ? undefined : Number(revisionHeader),
    });
    if (!liveClaim.success) {
      return context.json({ error: "discord_presence_live_claim_required" }, 400);
    }
    if (!dependencies.discordPresenceRuntime) {
      return context.json({ error: "discord_presence_runtime_unavailable" }, 503);
    }
    const discordPresenceRuntime = dependencies.discordPresenceRuntime;
    const parsed = DiscordPresenceWriteSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_discord_presence_write" }, 400);
    const write = parsed.data;
    if (write.identity.profileHash !== dependencies.doctrine.profileHash) {
      return context.json({ error: "doctrine_hash_mismatch" }, 409);
    }
    if (write.identity.transportKind !== "bot") {
      return context.json({ error: "discord_presence_transport_unsupported" }, 400);
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(write)).digest("hex");
    return withSerializedLock(discordPresenceLocks, write.idempotencyKey, async () => {
      pruneExpired(discordPresenceResults, clock().getTime());
      const previous = discordPresenceResults.get(write.idempotencyKey);
      if (previous !== undefined) {
        if (previous.fingerprint !== fingerprint) {
          return context.json({ error: "discord_presence_idempotency_conflict" }, 409);
        }
        return context.json(previous.result);
      }

      const classification = classifyDiscordPresenceAction(write.action);
      if (classification === undefined) {
        return context.json({ error: "discord_presence_action_unclassified" }, 400);
      }
      const session = discordPresenceSessions.resolve(write.identity);
      if (session === undefined) {
        return context.json({ error: "discord_presence_session_unavailable" }, 409);
      }
      const advertisedTools = discordPresenceSessions.resolveToolExposure(write.identity, "discord_presence");
      if (
        advertisedTools?.presenceTools.includes("discord_presence_act") !== true ||
        !isDiscordPresenceActionAvailable({ action: write.action, session })
      ) {
        return context.json({ error: "discord_presence_action_unavailable", phase: session.phase }, 409);
      }
      const liveSession = discordPresenceLiveSessions.get(discordPresenceBindingKey(write.identity));
      if (
        liveSession === undefined ||
        liveClaim.data.sessionId !== liveSession.sessionId ||
        liveClaim.data.phase !== liveSession.phase ||
        liveClaim.data.revision !== liveSession.revision
      ) {
        return context.json(
          {
            error: "discord_presence_live_claim_stale",
            claimedRevision: liveClaim.data.revision,
            ...(liveSession === undefined
              ? {}
              : { currentRevision: liveSession.revision, phase: liveSession.phase }),
          },
          409,
        );
      }
      const liveExposure = resolveDiscordPresencePhaseToolExposure(liveClaim.data.phase, "discord_presence");
      if (!liveExposure.presenceTools.includes("discord_presence_act")) {
        return context.json(
          {
            error: "discord_presence_action_unavailable",
            phase: liveClaim.data.phase,
            source: "live_session",
          },
          409,
        );
      }
      const request = ActionRequestSchema.parse({
        id: write.idempotencyKey,
        principal: {
          kind: "worker",
          id: write.identity.workerRunId ?? write.identity.characterId,
          role: "discord-presence-adapter",
        },
        action: write.action,
        resource:
          write.payload.kind === "send_attachment"
            ? {
                type: "discord-attachment",
                id: write.payload.artifactRef,
                repository: `sha256:${fingerprint}`,
                environment: write.payload.channelId,
              }
            : {
                type: "discord-channel",
                id:
                  "channelId" in write.payload
                    ? write.payload.channelId
                    : "guildId" in write.payload
                      ? write.payload.guildId
                      : write.action,
              },
        context: {
          // ActionRequest v1 requires a policy scope in its missionId slot. Ambient
          // narrative writes use a first-class presence attribution in the retained
          // narrative ledger and are never recorded as mission events.
          missionId:
            write.identity.missionId ?? `discord-presence:${write.identity.presenceSessionId ?? "unknown"}`,
          ...(write.identity.taskId === undefined ? {} : { taskId: write.identity.taskId }),
          risk: classification.riskClass === "publish-external" ? "high" : "low",
          profileHash: write.identity.profileHash,
        },
      });

      const ledgerContent = resolveDiscordPresenceLedgerContent(write);
      const priorApprovalRecord = approvalRequests.get(request.id);
      if (
        priorApprovalRecord &&
        !sameApprovalRequest(priorApprovalRecord, request, write.identity.correlationId)
      ) {
        return context.json({ error: "discord_presence_idempotency_conflict" }, 409);
      }
      const priorApproval = priorApprovalRecord
        ? await expireApprovalIfNeeded(priorApprovalRecord)
        : undefined;
      if (priorApproval?.status === "denied") {
        const expired = priorApproval.reason === "approval_expired";
        return context.json(
          {
            error: expired ? "discord_presence_approval_expired" : "discord_presence_approval_denied",
            approval: approvalHandle(priorApproval, APPROVAL_REQUEST_TTL_MS),
          },
          403,
        );
      }
      const evaluatedRequest = priorApproval?.status === "approved" ? withHumanApproval(request) : request;
      const decision =
        priorApproval?.status === "approved"
          ? {
              effect: "allow" as const,
              reason: "The authenticated operator approved this exact Discord presence write.",
              matchedPolicyIds: ["operator-approval:approved"],
              obligations: priorApproval.rationale.obligations,
            }
          : classification.riskClass === "narrative-write"
            ? narrativePolicy.decide({
                request: evaluatedRequest,
                classification,
                correlationId: write.identity.correlationId,
                content: ledgerContent,
                ...(write.identity.missionId === undefined && write.identity.presenceSessionId !== undefined
                  ? {
                      attribution: {
                        kind: "presence" as const,
                        id: write.identity.presenceSessionId,
                      },
                    }
                  : {}),
              })
            : decideAction(dependencies.doctrine, evaluatedRequest, classification);

      if (decision.effect !== "allow") {
        if (decision.effect === "require_approval") {
          const approval = await persistApprovalRequest(request, decision, write.identity.correlationId);
          return context.json(
            {
              error: "discord_presence_approval_required",
              approval: approvalHandle(approval, APPROVAL_REQUEST_TTL_MS),
            },
            202,
          );
        }
        logger.warn(
          {
            service: "clankie-control-plane",
            ...(write.identity.missionId === undefined ? {} : { missionId: write.identity.missionId }),
            ...(write.identity.presenceSessionId === undefined
              ? {}
              : { presenceSessionId: write.identity.presenceSessionId }),
            correlationId: write.identity.correlationId,
            action: write.action,
            effect: decision.effect,
          },
          "Discord presence action denied",
        );
        return context.json({ error: "discord_presence_not_allowed", decision }, 403);
      }

      try {
        const result = await discordPresenceRuntime.execute(write, session);
        discordPresenceResults.set(write.idempotencyKey, {
          fingerprint,
          result,
          expiresAtMs: clock().getTime() + DISCORD_PRESENCE_RETENTION_MS,
        });
        logger.info(
          {
            service: "clankie-control-plane",
            ...(write.identity.missionId === undefined ? {} : { missionId: write.identity.missionId }),
            ...(write.identity.presenceSessionId === undefined
              ? {}
              : { presenceSessionId: write.identity.presenceSessionId }),
            correlationId: write.identity.correlationId,
            action: write.action,
            transportKind: result.transportKind,
          },
          "Discord presence action completed",
        );
        return context.json(result);
      } catch (error) {
        const code =
          error instanceof Error && error.message.startsWith("discord_presence_")
            ? error.message
            : "discord_presence_failed";
        return context.json({ error: code }, 502);
      }
    });
  });

  app.post("/v1/captain/channel-turns", async (context) => {
    if (!dependencies.captainChannelTurns) {
      return context.json({ error: "captain_channel_runtime_unavailable" }, 503);
    }
    const captainChannelTurns = dependencies.captainChannelTurns;
    const body = await readJson(context.req.raw);
    const linear = LinearChannelTurnRequestSchema.safeParse(body);
    const parsedTurn = linear.success
      ? { provider: "linear" as const, request: linear.data }
      : (() => {
          const discord = DiscordPresenceChannelTurnRequestSchema.safeParse(body);
          return discord.success ? { provider: "discord" as const, request: discord.data } : undefined;
        })();
    if (parsedTurn === undefined) {
      return context.json({ error: "invalid_captain_channel_turn" }, 400);
    }
    const { request, provider } = parsedTurn;
    if (provider === "linear" && !dependencies.linearAgentRuntime) {
      return context.json({ error: "linear_agent_runtime_unavailable" }, 503);
    }
    if (provider === "discord") {
      const captain = await authenticateCaptain(context.req.raw, dependencies);
      if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
      if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
      if (captain.steerSourceLane !== "discord_text") {
        return context.json({ error: "discord_channel_authority_required" }, 403);
      }
    }
    if (request.identity.profileHash !== dependencies.doctrine.profileHash) {
      return context.json({ error: "doctrine_hash_mismatch" }, 409);
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    pruneExpired(captainTurnResults, clock().getTime());
    const deliveryKey = `${provider}:${request.deliveryId}`;
    const previous = captainTurnResults.get(deliveryKey);
    if (previous !== undefined && previous.fingerprint !== fingerprint) {
      return context.json({ error: "captain_turn_idempotency_conflict" }, 409);
    }
    const turn =
      previous?.result ??
      (async () => {
        if (parsedTurn.provider === "linear") {
          const thread = await dependencies.linearAgentRuntime!.readThread(parsedTurn.request);
          return CaptainChannelTurnResultSchema.parse(
            await captainChannelTurns.submit({ request: parsedTurn.request, thread }),
          );
        }
        return CaptainChannelTurnResultSchema.parse(
          await captainChannelTurns.submit({ request: parsedTurn.request }),
        );
      })();
    if (previous === undefined) {
      captainTurnResults.set(deliveryKey, {
        fingerprint,
        result: turn,
        expiresAtMs: clock().getTime() + LINEAR_DELIVERY_RETENTION_MS,
      });
    }
    try {
      const result = await turn;
      logger.info(
        {
          service: "clankie-control-plane",
          ...(request.identity.missionId === undefined ? {} : { missionId: request.identity.missionId }),
          ...(request.identity.taskId === undefined ? {} : { taskId: request.identity.taskId }),
          ...(request.identity.workerRunId === undefined
            ? {}
            : { workerRunId: request.identity.workerRunId }),
          ...(!("presenceSessionId" in request.identity) || request.identity.presenceSessionId === undefined
            ? {}
            : { presenceSessionId: request.identity.presenceSessionId }),
          correlationId: request.identity.correlationId,
          deliveryId: request.deliveryId,
          state: result.state,
        },
        `${provider === "linear" ? "Linear" : "Discord"} channel captain turn settled`,
      );
      return context.json(result);
    } catch {
      if (captainTurnResults.get(deliveryKey)?.result === turn) {
        captainTurnResults.delete(deliveryKey);
      }
      return context.json({ error: "captain_channel_turn_failed" }, 502);
    }
  });

  app.post("/v1/tracker/missions", async (context) => {
    if (!dependencies.trackerMirror) return context.json({ error: "tracker_connector_unavailable" }, 503);
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    const parsed = TrackerImportSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_tracker_import" }, 400);
    try {
      assertTrackerAuthorityBindings(dependencies.doctrine, parsed.data.ref.connector);
    } catch {
      return context.json({ error: "tracker_authority_binding_conflict" }, 409);
    }
    const id = `mission-${randomUUID().slice(0, 12)}`;
    try {
      const contract = await dependencies.trackerMirror.importMission(id, parsed.data.ref);
      const createdAt = clock().toISOString();
      const missionContext = { trackerContract: contract };
      await recordEvent("mission.drafted", id, createdAt, {
        goal: contract.source.intent.title,
        context: missionContext,
      });
      missions.set(id, {
        id,
        goal: contract.source.intent.title,
        context: missionContext,
        state: "draft",
        createdAt,
      });
      return context.json({ missionId: id, contract }, 201);
    } catch {
      return context.json({ error: "tracker_import_failed" }, 502);
    }
  });

  app.post("/v1/tracker/missions/:id/reconcile", async (context) => {
    if (!dependencies.trackerMirror) return context.json({ error: "tracker_connector_unavailable" }, 503);
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    const missionId = context.req.param("id");
    if (!missions.has(missionId)) return context.json({ error: "mission_not_found" }, 404);
    try {
      const drift = await dependencies.trackerMirror.reconcile(missionId);
      if (!drift) return context.json({ drift: null });
      const event = await recordEvent("tracker.drift.detected", missionId, clock().toISOString(), {
        ...drift,
      });
      return context.json({ drift, event }, 202);
    } catch {
      return context.json({ error: "tracker_reconcile_failed" }, 502);
    }
  });

  app.post("/v1/tracker/missions/:id/mutate", async (context) => {
    if (!dependencies.trackerMirror) return context.json({ error: "tracker_connector_unavailable" }, 503);
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    const missionId = context.req.param("id");
    if (!missions.has(missionId)) return context.json({ error: "mission_not_found" }, 404);
    const parsed = TrackerMutationRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_tracker_mutation" }, 400);
    try {
      await dependencies.trackerMirror.mutate(missionId, parsed.data.mutation, parsed.data.idempotencyKey);
      const event = await recordEvent("tracker.mutation.accepted", missionId, clock().toISOString(), {
        idempotencyKey: parsed.data.idempotencyKey,
        fields: Object.keys(parsed.data.mutation),
      });
      return context.json({ accepted: true, idempotencyKey: parsed.data.idempotencyKey, event });
    } catch (error) {
      if (error instanceof TrackerPolicyError) {
        return context.json(
          { error: "tracker_mutation_not_allowed", action: error.action, effect: error.effect },
          403,
        );
      }
      return context.json({ error: "tracker_mutation_failed" }, 502);
    }
  });

  app.post("/v1/missions", async (context) => {
    const input = z
      .object({ goal: z.string().min(1), context: z.record(z.string(), z.unknown()).default({}) })
      .parse(await context.req.json());
    const id = await createMissionDraft(input.goal, input.context);
    return context.json({ missionId: id }, 201);
  });

  app.get("/v1/mission-triggers", (context) =>
    context.json({
      triggers: [...missionTriggers.values()].sort((left, right) => left.id.localeCompare(right.id)),
    }),
  );

  app.post("/v1/mission-triggers", async (context) => {
    const body = await readJson(context.req.raw);
    const requested = z.record(z.string(), z.unknown()).safeParse(body);
    const id =
      requested.success && typeof requested.data.id === "string" && requested.data.id.length > 0
        ? requested.data.id
        : `trigger-${idFactory().slice(0, 12)}`;
    const authorization = await authorizeTriggerMutation(context.req.raw, id);
    if (!authorization.allowed) return context.json({ error: authorization.error }, authorization.status);
    if (!dependencies.eventStore) return context.json({ error: "mission_trigger_store_unavailable" }, 503);
    const parsed = MissionTriggerInputSchema.safeParse(body);
    if (!parsed.success)
      return context.json({ error: "invalid_mission_trigger", issues: parsed.error.issues }, 400);
    if (missionTriggers.has(id)) return context.json({ error: "mission_trigger_exists" }, 409);
    const now = clock().toISOString();
    const { id: _requestedId, ...triggerInput } = parsed.data;
    const trigger = MissionTriggerSchema.parse({
      schemaVersion: 1,
      id,
      ...triggerInput,
      createdAt: now,
      updatedAt: now,
    });
    await recordEvent("mission.trigger.created", `trigger:${id}`, now, { trigger });
    missionTriggers.set(id, trigger);
    return context.json({ trigger }, 201);
  });

  app.put("/v1/mission-triggers/:id", async (context) => {
    const id = context.req.param("id");
    const authorization = await authorizeTriggerMutation(context.req.raw, id);
    if (!authorization.allowed) return context.json({ error: authorization.error }, authorization.status);
    if (!dependencies.eventStore) return context.json({ error: "mission_trigger_store_unavailable" }, 503);
    const current = missionTriggers.get(id);
    if (!current) return context.json({ error: "mission_trigger_not_found" }, 404);
    const parsed = MissionTriggerInputSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success)
      return context.json({ error: "invalid_mission_trigger", issues: parsed.error.issues }, 400);
    const now = clock().toISOString();
    const { id: _ignoredId, ...triggerInput } = parsed.data;
    const trigger = MissionTriggerSchema.parse({
      schemaVersion: 1,
      id,
      ...triggerInput,
      createdAt: current.createdAt,
      updatedAt: now,
    });
    await recordEvent("mission.trigger.updated", `trigger:${id}`, now, { trigger });
    missionTriggers.set(id, trigger);
    return context.json({ trigger });
  });

  app.delete("/v1/mission-triggers/:id", async (context) => {
    const id = context.req.param("id");
    const authorization = await authorizeTriggerMutation(context.req.raw, id);
    if (!authorization.allowed) return context.json({ error: authorization.error }, authorization.status);
    if (!dependencies.eventStore) return context.json({ error: "mission_trigger_store_unavailable" }, 503);
    if (!missionTriggers.has(id)) return context.json({ error: "mission_trigger_not_found" }, 404);
    await recordEvent("mission.trigger.deleted", `trigger:${id}`, clock().toISOString(), { triggerId: id });
    missionTriggers.delete(id);
    return context.body(null, 204);
  });

  app.post("/v1/mission-triggers/evaluate", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    if (!dependencies.eventStore) return context.json({ error: "mission_trigger_store_unavailable" }, 503);
    return context.json(await evaluateDueTriggers(clock()));
  });

  app.post("/v1/memory/proposals", async (context) => {
    if (!dependencies.memoryStore || !dependencies.eventStore) {
      return context.json({ error: "memory_store_unavailable" }, 503);
    }
    const parsed = MemoryProposalRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_memory_proposal" }, 400);
    const worker = dependencies.authenticateWorker
      ? await dependencies.authenticateWorker(context.req.raw)
      : undefined;
    const captain = worker ? undefined : await authenticateCaptain(context.req.raw, dependencies);
    if (!dependencies.authenticateWorker && captain === "unavailable") {
      return context.json({ error: "memory_proposal_authentication_unavailable" }, 503);
    }
    if (!worker && (!captain || captain === "unavailable")) {
      return context.json({ error: "memory_proposal_authentication_required" }, 401);
    }
    const proposalInput = parsed.data;
    if (
      worker &&
      (proposalInput.fact.provenance.missionId !== worker.missionId ||
        proposalInput.fact.provenance.correlationId !== worker.correlationId)
    ) {
      return context.json({ error: "memory_proposal_identity_mismatch" }, 403);
    }
    const principal = worker
      ? ({ kind: "worker", id: worker.workerRunId } as const)
      : ({ kind: "captain", id: (captain as TrustedCaptainIdentity).captainId } as const);
    const approvalRequestId = `memory:${proposalInput.proposalId}`;
    const proposal: StoredMemoryProposal = {
      proposalId: proposalInput.proposalId,
      approvalRequestId,
      fact: proposalInput.fact,
      submittedAt: clock().toISOString(),
      principal,
    };
    const existing = memoryProposals.get(proposal.proposalId);
    if (existing) {
      if (
        JSON.stringify({ fact: existing.fact, principal: existing.principal }) !==
        JSON.stringify({ fact: proposal.fact, principal: proposal.principal })
      ) {
        return context.json({ error: "memory_proposal_idempotency_conflict" }, 409);
      }
      return context.json({ proposal: existing, approval: approvalRequests.get(existing.approvalRequestId) });
    }
    const request = ActionRequestSchema.parse({
      id: approvalRequestId,
      principal,
      action: "memory.profile.write",
      resource: { type: "memory-proposal", id: proposal.proposalId },
      context: {
        missionId: proposal.fact.provenance.missionId,
        risk: "low",
        humanApprovals: 0,
        profileHash: dependencies.doctrine.profileHash,
      },
    });
    const decision = decideAction(dependencies.doctrine, request);
    await recordEvent(
      "memory.proposal.submitted",
      proposal.fact.provenance.missionId,
      proposal.submittedAt,
      { proposal },
      { correlationId: proposal.fact.provenance.correlationId },
    );
    memoryProposals.set(proposal.proposalId, proposal);
    if (decision.effect === "deny") {
      await recordEvent(
        "memory.proposal.denied",
        proposal.fact.provenance.missionId,
        clock().toISOString(),
        { proposalId: proposal.proposalId, reason: decision.reason, source: "doctrine" },
        { correlationId: proposal.fact.provenance.correlationId },
      );
      return context.json({ error: "memory_proposal_denied", decision }, 403);
    }
    if (decision.effect !== "require_approval") {
      return context.json({ error: "memory_proposal_approval_required" }, 409);
    }
    const approval = await persistApprovalRequest(request, decision, proposal.fact.provenance.correlationId);
    return context.json({ proposal, approval }, 202);
  });

  app.put("/v1/missions/:id/plan", async (context) => {
    const id = context.req.param("id");
    const body = await readJson(context.req.raw);
    return withMissionLock(id, async () => {
      const mission = missions.get(id);
      if (!mission) return context.json({ error: "mission_not_found" }, 404);
      if (mission.state === "running" || engines.has(id)) {
        return context.json({ error: "mission_plan_immutable_after_start" }, 409);
      }
      const parsedPlan = MissionPlanSchema.safeParse(body);
      if (!parsedPlan.success) return context.json({ error: "invalid_mission_plan" }, 400);
      const plan = parsedPlan.data;
      if (plan.missionId !== id) return context.json({ error: "mission_id_mismatch" }, 409);
      if (plan.profileHash !== dependencies.doctrine.profileHash) {
        return context.json(
          { error: "doctrine_hash_mismatch", expected: dependencies.doctrine.profileHash },
          409,
        );
      }
      try {
        dependencies.trackerMirror?.validatePlan(plan);
      } catch (error) {
        if (error instanceof TrackerAuthorityConflictError) {
          return context.json(
            { error: "tracker_authority_conflict", changedFields: error.changedFields },
            409,
          );
        }
        throw error;
      }
      try {
        assertValidDag(plan.tasks);
        assertSupportedPullPlan(plan);
      } catch (error) {
        return context.json(
          {
            error: "unsupported_mission_plan",
            message: error instanceof Error ? error.message : String(error),
          },
          400,
        );
      }
      const memoryRecall = dependencies.memoryStore?.recallCard({ query: plan.goal });
      const captainMissionContext = [dependencies.doctrine.plannerCard, memoryRecall]
        .filter((value): value is string => value !== undefined)
        .join("\n\n");
      mission.context = { ...mission.context, captainMissionContext };
      await recordEvent("mission.planned", id, clock().toISOString(), {
        plan,
        context: mission.context,
      });
      mission.plan = plan;
      mission.state = "planned";
      logger.info({ missionId: id, taskCount: plan.tasks.length }, "mission planned");
      return context.json(plan);
    });
  });

  app.post("/v1/missions/:id/start", async (context) => {
    if (!dependencies.authenticateCaptain) {
      return context.json({ error: "captain_execution_unavailable" }, 503);
    }
    if (!dependencies.authenticateRunner) {
      return context.json({ error: "runner_execution_unavailable" }, 503);
    }
    const captain = await dependencies.authenticateCaptain(context.req.raw);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    const id = context.req.param("id");
    return withMissionLock(id, async () => {
      const mission = missions.get(id);
      if (!mission) return context.json({ error: "mission_not_found" }, 404);
      if (!mission.plan) return context.json({ error: "mission_plan_required" }, 409);
      const existing = engines.get(id);
      if (existing) return context.json({ missionId: id, snapshot: existing.getSnapshot() });

      let engine: MissionEngine;
      try {
        assertSupportedPullPlan(mission.plan);
        engine = new MissionEngine(mission.plan, dependencies.doctrine, {
          workspacePath: dependencies.workspacePath ?? process.cwd(),
          clock,
          idFactory,
        });
      } catch (error) {
        return context.json(
          { error: "mission_start_invalid", message: error instanceof Error ? error.message : String(error) },
          409,
        );
      }
      const occurredAt = clock().toISOString();
      await flushEngine(engine);
      await recordEvent("mission.execution.started", id, occurredAt, { captainId: captain.captainId });
      mission.state = "running";
      engines.set(id, engine);
      logger.info({ missionId: id, captainId: captain.captainId }, "mission execution started");
      return context.json({ missionId: id, snapshot: engine.getSnapshot() }, 202);
    });
  });

  app.post("/v1/missions/:id/recovery", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "captain_execution_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    const parsed = RecoveryRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_recovery_request" }, 400);
    const missionId = context.req.param("id");
    return withMissionLock(missionId, async () => {
      const engine = engines.get(missionId);
      if (!engine) return context.json({ error: "mission_execution_not_found" }, 404);
      try {
        const pair = engine.addRecoveryPair(parsed.data);
        await flushEngine(engine);
        logger.info(
          {
            missionId,
            captainId: captain.captainId,
            failedTaskId: parsed.data.failedTaskId,
            recoveryCommandId: parsed.data.commandId,
          },
          "bounded recovery pair accepted",
        );
        return context.json({ accepted: true, pair, snapshot: engine.getSnapshot() }, 202);
      } catch (error) {
        if (error instanceof RecoveryConflictError) {
          return context.json({ error: error.code, message: error.message }, 409);
        }
        throw error;
      }
    });
  });

  app.post("/v1/captain/presence", async (context) => {
    if (!dependencies.eventStore) {
      return context.json({ error: "captain_presence_store_unavailable" }, 503);
    }
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    const parsed = CaptainPresenceReportSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_captain_presence" }, 400);
    try {
      const result = await captainPresence.receive(captain.captainId, parsed.data);
      return context.json({ accepted: true, lease: result.lease, events: result.emitted }, 202);
    } catch (error) {
      if (error instanceof CaptainPresenceLeaseConflictError) {
        return context.json({ error: "captain_lease_conflict" }, 409);
      }
      throw error;
    }
  });

  app.get("/v1/missions/:id", (context) => {
    const mission = missions.get(context.req.param("id"));
    if (!mission) return context.json({ error: "mission_not_found" }, 404);
    const snapshot = engines.get(mission.id)?.getSnapshot();
    return context.json(snapshot ? liveMissionRecord(mission, snapshot) : mission);
  });

  app.post("/v1/runner/claims", async (context) => {
    const runner = await authenticateRunner(context.req.raw, dependencies);
    if (runner === "unavailable") return context.json({ error: "runner_execution_unavailable" }, 503);
    if (!runner) return context.json({ error: "runner_authentication_required" }, 401);
    const parsed = RunnerClaimSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_runner_claim" }, 400);
    const claimId = `${runner.runnerId}:${parsed.data.claimId}`;
    const missionIds = claimMissions.has(claimId)
      ? [claimMissions.get(claimId) as string]
      : [...engines.keys()];
    for (const missionId of missionIds) {
      const assignment = await withMissionLock(missionId, async () => {
        const engine = engines.get(missionId);
        if (!engine) return undefined;
        engine.expireAbandonedWorkerRuns(clock());
        const leased = engine.leaseReadyTask(
          parsed.data.workers as WorkerDescriptor[],
          claimId,
          runner.runnerId,
          dependencies.workerLeaseDurationMs,
        );
        await flushEngine(engine);
        if (leased) claimMissions.set(claimId, missionId);
        return leased;
      });
      if (assignment) {
        const memoryRecall = dependencies.memoryStore?.recallCard({
          query: `${assignment.task.title} ${assignment.task.objective}`,
          maxFacts: 6,
          maxCharacters: 2_048,
        });
        if (memoryRecall !== undefined) {
          assignment.task.metadata = { ...assignment.task.metadata, memoryRecall };
        }
        logger.info(
          { runnerId: runner.runnerId, missionId: assignment.missionId, workerRunId: assignment.workerRunId },
          "worker task leased",
        );
        return context.json({ assignment });
      }
      if (claimMissions.has(claimId)) break;
    }
    return context.body(null, 204);
  });

  app.post("/v1/runner/workers/:id/events", async (context) => {
    const runner = await authenticateRunner(context.req.raw, dependencies);
    if (runner === "unavailable") return context.json({ error: "runner_execution_unavailable" }, 503);
    if (!runner) return context.json({ error: "runner_authentication_required" }, 401);
    const parsed = RunnerEventSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_worker_event" }, 400);
    if (!ALLOWED_RUNNER_EVENT_TYPES.has(parsed.data.type)) {
      return context.json({ error: "worker_event_type_not_allowed" }, 400);
    }
    const statusData = normalizeRunnerStatusData(parsed.data.type, parsed.data.data);
    if (isRunnerStatusEvent(parsed.data.type) && !statusData) {
      return context.json({ error: "invalid_worker_status_signal" }, 400);
    }
    const entry = findEngineForWorkerRun(engines, context.req.param("id"));
    if (!entry) return context.json({ error: "unknown_worker_run" }, 404);
    return withMissionLock(entry.missionId, async () => {
      try {
        const event = entry.engine.recordWorkerEvent(
          {
            workerRunId: context.req.param("id"),
            ...parsed.data,
            data: statusData ?? parsed.data.data,
          },
          runner.runnerId,
        );
        await flushEngine(entry.engine);
        return context.json({ accepted: true, event });
      } catch (error) {
        return workerConflictResponse(context, error);
      }
    });
  });

  app.post("/v1/runner/workers/:id/settle", async (context) => {
    const runner = await authenticateRunner(context.req.raw, dependencies);
    if (runner === "unavailable") return context.json({ error: "runner_execution_unavailable" }, 503);
    if (!runner) return context.json({ error: "runner_authentication_required" }, 401);
    const parsed = RunnerSettleSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_worker_settlement" }, 400);
    const entry = findEngineForWorkerRun(engines, context.req.param("id"));
    if (!entry) return context.json({ error: "unknown_worker_run" }, 404);
    return withMissionLock(entry.missionId, async () => {
      try {
        const taskId = taskIdForWorkerRun(entry.engine, context.req.param("id"));
        const taskSpec = taskId ? entry.engine.getTask(taskId).spec : undefined;
        if (
          taskSpec?.kind === "verification" &&
          parsed.data.result.status === "succeeded" &&
          !parsed.data.result.evidence.some((evidence) => evidence.kind === "test_report")
        ) {
          return context.json({ error: "verification_evidence_required" }, 409);
        }
        const requiredRecoveryChecks = taskSpec ? recoveryCheckIdentities(taskSpec) : undefined;
        if (
          requiredRecoveryChecks &&
          taskSpec?.kind === "verification" &&
          parsed.data.result.status === "succeeded" &&
          !sameCheckIdentities(resultCheckIdentities(parsed.data.result), requiredRecoveryChecks)
        ) {
          return context.json(
            {
              error: "recovery_verification_checks_mismatch",
              expected: requiredRecoveryChecks,
              actual: resultCheckIdentities(parsed.data.result),
            },
            409,
          );
        }
        const task = entry.engine.settleWorkerRun(
          context.req.param("id"),
          parsed.data.attempt,
          parsed.data.result,
          runner.runnerId,
        );
        const recovery = recoveryLineage(task.spec);
        if (task.state === "succeeded" && recovery?.debuggerTaskId) {
          entry.engine.resolveFailedVerification(recovery.failedTaskId, task.spec.id);
        }
        if (
          task.spec.kind === "verification" &&
          task.state === "succeeded" &&
          entry.engine.getSnapshot().state !== "succeeded" &&
          entry.engine.isReadyForCompletion()
        ) {
          entry.engine.completeMission("Implementation and deterministic verification succeeded.");
        }
        await flushEngine(entry.engine);
        return context.json({ accepted: true, task, snapshot: entry.engine.getSnapshot() });
      } catch (error) {
        return workerConflictResponse(context, error);
      }
    });
  });

  app.post("/v1/runner/workers/:id/heartbeat", async (context) => {
    const runner = await authenticateRunner(context.req.raw, dependencies);
    if (runner === "unavailable") return context.json({ error: "runner_execution_unavailable" }, 503);
    if (!runner) return context.json({ error: "runner_authentication_required" }, 401);
    const parsed = RunnerHeartbeatSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_worker_heartbeat" }, 400);
    const entry = findEngineForWorkerRun(engines, context.req.param("id"));
    if (!entry) return context.json({ error: "unknown_worker_run" }, 404);
    return withMissionLock(entry.missionId, async () => {
      try {
        const task = entry.engine.heartbeatWorkerRun(
          context.req.param("id"),
          parsed.data.attempt,
          runner.runnerId,
          dependencies.workerLeaseDurationMs,
        );
        await flushEngine(entry.engine);
        return context.json({ accepted: true, leaseExpiresAt: task.leaseExpiresAt });
      } catch (error) {
        return workerConflictResponse(context, error);
      }
    });
  });

  app.post("/v1/runner/steering/claim", async (context) => {
    const runner = await authenticateRunner(context.req.raw, dependencies);
    if (runner === "unavailable") return context.json({ error: "runner_execution_unavailable" }, 503);
    if (!runner) return context.json({ error: "runner_authentication_required" }, 401);
    const parsed = RunnerSteerClaimSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_steer_claim" }, 400);
    const active = activeWorkerRun(engines, parsed.data.workerRunId);
    if (!active) return context.json({ outcome: steerOutcome("worker_terminal") }, 409);
    if (active.runtime.runnerId !== runner.runnerId) {
      return context.json({ outcome: steerOutcome("wrong_runner") }, 409);
    }
    if (active.runtime.attempts !== parsed.data.attempt) {
      return context.json({ outcome: steerOutcome("stale_attempt") }, 409);
    }
    if (!active.runtime.leaseExpiresAt || Date.parse(active.runtime.leaseExpiresAt) <= clock().getTime()) {
      return context.json({ outcome: steerOutcome("lease_expired") }, 409);
    }
    const command = await steeringStore.claim({
      runnerId: runner.runnerId,
      workerRunId: parsed.data.workerRunId,
      attempt: parsed.data.attempt,
    });
    if (!command) return context.body(null, 204);
    return context.json({ command: publicSteerCommand(command) });
  });

  app.post("/v1/runner/steering/settle", async (context) => {
    const runner = await authenticateRunner(context.req.raw, dependencies);
    if (runner === "unavailable") return context.json({ error: "runner_execution_unavailable" }, 503);
    if (!runner) return context.json({ error: "runner_authentication_required" }, 401);
    const parsed = RunnerSteerSettlementSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_steer_settlement" }, 400);
    const existing = await steeringStore.get(parsed.data.commandId);
    if (!existing) return context.json({ error: "unknown_steer_command" }, 404);
    if (existing.runnerId !== runner.runnerId) return context.json({ error: "wrong_runner" }, 409);
    if (existing.workerRunId !== parsed.data.workerRunId || existing.attempt !== parsed.data.attempt) {
      return context.json({ error: "stale_attempt" }, 409);
    }
    const trustedOutcome = steerOutcome(parsed.data.outcome.code);
    const diagnosticSha256 = createHash("sha256").update(parsed.data.outcome.message).digest("hex");
    let settled: StoredWorkerSteerCommand | undefined;
    try {
      settled = await steeringStore.settle(parsed.data.commandId, trustedOutcome);
    } catch {
      return context.json({ error: "conflicting_steer_settlement" }, 409);
    }
    await recordEvent(
      "worker.steer.settled",
      existing.missionId,
      clock().toISOString(),
      {
        ...redactedSteerData(existing, trustedOutcome),
        outcomeDiagnosticSha256: diagnosticSha256,
        outcomeDiagnosticLength: parsed.data.outcome.message.length,
        outcomeDiagnosticRedacted: true,
      },
      {
        taskId: existing.taskId,
        workerRunId: existing.workerRunId,
        correlationId: existing.correlationId,
        profileHash: existing.profileHash,
      },
    );
    return context.json({ command: redactedSteerRecord(settled as StoredWorkerSteerCommand) });
  });

  app.get("/v1/approvals", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable") return context.json({ error: "operator_approval_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const parsed = ApprovalStatusQuerySchema.safeParse({ status: context.req.query("status") });
    if (!parsed.success) return context.json({ error: "invalid_approval_status" }, 400);
    await Promise.all([...approvalRequests.values()].map((approval) => expireApprovalIfNeeded(approval)));
    return context.json(
      [...approvalRequests.values()]
        .filter((approval) => approval.status === parsed.data.status)
        .sort(compareApprovals),
    );
  });

  app.post("/v1/approvals/:id/decision", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable") return context.json({ error: "operator_approval_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const parsed = ApprovalDecisionInputSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_approval_decision" }, 400);
    const pending = approvalRequests.get(context.req.param("id"));
    if (!pending) return context.json({ error: "approval_not_found" }, 404);
    const unexpired = await expireApprovalIfNeeded(pending);
    if (unexpired.status !== "pending") {
      if (unexpired.status === "denied" && unexpired.reason === "approval_expired") {
        return context.json({ error: "approval_already_expired", approval: unexpired }, 409);
      }
      const requestedStatus = parsed.data.decision === "approve" ? "approved" : "denied";
      if (unexpired.status === requestedStatus && unexpired.reason === parsed.data.reason) {
        return context.json(unexpired);
      }
      return context.json({ error: "approval_already_decided", approval: unexpired }, 409);
    }
    return withSerializedLock(approvalLocks, pending.id, async () => {
      const current = approvalRequests.get(pending.id);
      if (!current) return context.json({ error: "approval_not_found" }, 404);
      if (current.status !== "pending") {
        const requestedStatus = parsed.data.decision === "approve" ? "approved" : "denied";
        if (current.status === requestedStatus && current.reason === parsed.data.reason)
          return context.json(current);
        return context.json({ error: "approval_already_decided", approval: current }, 409);
      }
      const status = parsed.data.decision === "approve" ? "approved" : "denied";
      const decidedAt = clock().toISOString();
      const approval = ApprovalRequestRecordSchema.parse({
        ...current,
        status,
        decidedAt,
        decidedBy: operator.operatorId,
        reason: parsed.data.reason,
      });
      await recordEvent(
        "approval.decided",
        approval.missionId,
        decidedAt,
        { approval },
        approvalEnvelope(approval),
      );
      approvalRequests.set(approval.id, approval);
      if (approval.action === "memory.profile.write") {
        const proposal = [...memoryProposals.values()].find(
          (candidate) => candidate.approvalRequestId === approval.id,
        );
        if (!proposal) throw new Error(`Memory approval ${approval.id} has no durable proposal`);
        await recordEvent(
          status === "approved" ? "memory.proposal.approved" : "memory.proposal.denied",
          proposal.fact.provenance.missionId,
          decidedAt,
          {
            proposalId: proposal.proposalId,
            approvalRequestId: approval.id,
            reason: approval.reason,
            source: "operator",
          },
          { correlationId: proposal.fact.provenance.correlationId },
        );
        if (status === "approved") await commitApprovedMemoryProposal(proposal, approval);
      }
      logger.info(
        { missionId: approval.missionId, approvalId: approval.id, status, operatorId: operator.operatorId },
        "approval decided",
      );
      return context.json(approval);
    });
  });

  // Mint the server half of `clankie pair` (VUH-878): short-lived, single-use
  // display data an operator hands to a device. Minting is an operator action;
  // the response is never logged and events carry only the non-secret offer id.
  // A device turns the offer into an identity via POST /v1/pairing/redeem.
  app.post("/v1/pairing/offer", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const now = clock();
    pairingOffers.prune(now);
    const offer = mintPairingOffer({ now, mintedBy: operator.operatorId, idFactory });
    pairingOffers.add(offer);
    await recordEvent("pairing.offer.minted", `pairing:${offer.offerId}`, offer.createdAt, {
      offerId: offer.offerId,
      operatorId: operator.operatorId,
      expiresAt: offer.expiresAt,
    });
    logger.info(
      { offerId: offer.offerId, operatorId: operator.operatorId, expiresAt: offer.expiresAt },
      "pairing offer minted",
    );
    return context.json(pairingOfferWire(offer));
  });

  // Redeem an offer secret or typed code (the secret IS the capability, so the
  // route is unauthenticated) into a PENDING device plus a single-use completion
  // token. The offer is consumed synchronously in the store, so a concurrent
  // redemption of the same offer gets "consumed". No grants are conferred until
  // POST /v1/pairing/complete.
  app.post("/v1/pairing/redeem", async (context) => {
    // Fail closed if sessions can't be signed — never consume an offer for a
    // pairing that could not be completed.
    if (deviceSessionSigner === undefined)
      return context.json({ error: "device_authentication_unavailable" }, 503);
    const parsed = PairingRedeemRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "malformed" }, 400);
    const now = clock();
    pairingOffers.prune(now);
    prunePendingCompletions(completionTokens, now);
    const taken = pairingOffers.take(
      {
        ...(parsed.data.offerSecret !== undefined ? { offerSecret: parsed.data.offerSecret } : {}),
        ...(parsed.data.code !== undefined ? { code: parsed.data.code } : {}),
      },
      now,
    );
    if (!taken.ok) return context.json({ error: taken.error }, taken.error === "consumed" ? 409 : 410);
    const deviceId = `device-${idFactory().slice(0, 12)}`;
    const pendingExpiresAt = new Date(now.getTime() + COMPLETION_TOKEN_TTL_MS).toISOString();
    const redeemed = await recordEvent("device.pairing.redeemed", `device:${deviceId}`, now.toISOString(), {
      schemaVersion: 1,
      deviceId,
      offerId: taken.offer.offerId,
      name: parsed.data.device.name,
      platform: parsed.data.device.platform,
      offeredGrants: SUPERVISE_GRANTS,
      mintedBy: taken.offer.mintedBy,
      pendingExpiresAt,
    });
    applyDeviceEvent(devices, redeemed);
    const completionToken = randomBytes(32).toString("base64url");
    completionTokens.set(hashCompletionToken(completionToken), {
      deviceId,
      offeredGrants: SUPERVISE_GRANTS,
      expiresAtMs: now.getTime() + COMPLETION_TOKEN_TTL_MS,
      consumed: false,
    });
    logger.info({ deviceId, offerId: taken.offer.offerId }, "pairing offer redeemed");
    return context.json({
      deviceId,
      host: { name: hostDisplayName },
      offeredGrants: SUPERVISE_GRANTS,
      completionToken,
      expiresAt: pendingExpiresAt,
    } satisfies PairingRedeemResponse);
  });

  // Activate a pending device with the grants it accepts and issue its session
  // token. Accepting terminalControl (not grantable this slice) is denied WITHOUT
  // consuming the token, so the device can retry with the Supervise preset.
  app.post("/v1/pairing/complete", async (context) => {
    if (deviceSessionSigner === undefined)
      return context.json({ error: "device_authentication_unavailable" }, 503);
    const parsed = PairingCompleteRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "malformed" }, 400);
    const now = clock();
    prunePendingCompletions(completionTokens, now);
    const tokenHash = hashCompletionToken(parsed.data.completionToken);
    const pending = completionTokens.get(tokenHash);
    if (pending === undefined || pending.expiresAtMs <= now.getTime())
      return context.json({ error: "expired" }, 410);
    if (pending.consumed) return context.json({ error: "consumed" }, 409);
    const accepted = parsed.data.acceptedGrants;
    if (accepted.terminalControl) {
      const denied = await recordEvent(
        "device.grant.denied",
        `device:${pending.deviceId}`,
        now.toISOString(),
        {
          schemaVersion: 1,
          deviceId: pending.deviceId,
          requestedGrant: "terminalControl",
          reason: "terminal_control_not_grantable",
          stage: "complete",
        },
      );
      applyDeviceEvent(devices, denied);
      return context.json(
        { error: "terminal_control_not_grantable", offeredGrants: pending.offeredGrants },
        403,
      );
    }
    if (!isSubsetGrants(accepted, pending.offeredGrants)) return context.json({ error: "malformed" }, 400);
    return withSerializedLock(deviceLocks, pending.deviceId, async () => {
      const record = devices.get(pending.deviceId);
      if (record === undefined || isDevicePendingExpired(record, now))
        return context.json({ error: "expired" }, 410);
      if (record.status === "revoked") return context.json({ error: "revoked" }, 403);
      if (record.status !== "pending") return context.json({ error: "consumed" }, 409);
      const current = completionTokens.get(tokenHash);
      if (current === undefined || current.consumed) return context.json({ error: "consumed" }, 409);
      current.consumed = true;
      const claims = mintDeviceSessionClaims({
        deviceId: pending.deviceId,
        nowEpochSeconds: Math.floor(now.getTime() / 1000),
      });
      const deviceToken = deviceSessionSigner.issue(claims);
      const sessionExpiresAt = new Date(claims.expiresAt * 1000).toISOString();
      const activated = await recordEvent(
        "device.activated",
        `device:${pending.deviceId}`,
        now.toISOString(),
        {
          schemaVersion: 1,
          deviceId: pending.deviceId,
          grants: accepted,
          sessionExpiresAt,
        },
      );
      applyDeviceEvent(devices, activated);
      logger.info({ deviceId: pending.deviceId }, "device activated");
      return context.json({
        deviceId: pending.deviceId,
        deviceToken,
        grants: accepted,
        sessionExpiresAt,
      } satisfies PairingCompleteResponse);
    });
  });

  // Renew a device's session token. Grants are always read from the durable
  // projection, so a refresh can never widen access; a revoked device is denied.
  app.post("/v1/devices/self/session/refresh", async (context) => {
    const identity = await authenticateDevice(context.req.raw);
    if (identity === "unavailable") return context.json({ error: "device_authentication_unavailable" }, 503);
    if ("denied" in identity) return deviceDenialResponse(context, identity);
    if (deviceSessionSigner === undefined)
      return context.json({ error: "device_authentication_unavailable" }, 503);
    const signer = deviceSessionSigner;
    return withSerializedLock(deviceLocks, identity.deviceId, async () => {
      const record = devices.get(identity.deviceId);
      const now = clock();
      if (record === undefined || isDevicePendingExpired(record, now) || record.status !== "active") {
        return context.json(
          { error: record?.status === "revoked" ? "revoked" : "device_authentication_required" },
          401,
        );
      }
      const claims = mintDeviceSessionClaims({
        deviceId: identity.deviceId,
        nowEpochSeconds: Math.floor(now.getTime() / 1000),
      });
      const deviceToken = signer.issue(claims);
      const sessionExpiresAt = new Date(claims.expiresAt * 1000).toISOString();
      const refreshed = await recordEvent(
        "device.session.refreshed",
        `device:${identity.deviceId}`,
        now.toISOString(),
        {
          schemaVersion: 1,
          deviceId: identity.deviceId,
          grants: record.grants,
          sessionExpiresAt,
        },
      );
      applyDeviceEvent(devices, refreshed);
      return context.json({
        deviceToken,
        grants: record.grants,
        sessionExpiresAt,
      } satisfies DeviceSessionRefreshResponse);
    });
  });

  // A device reads its own registration to restore a session on launch.
  app.get("/v1/devices/self", async (context) => {
    const identity = await authenticateDevice(context.req.raw);
    if (identity === "unavailable") return context.json({ error: "device_authentication_unavailable" }, 503);
    if ("denied" in identity) return deviceDenialResponse(context, identity);
    const record = devices.get(identity.deviceId);
    if (record === undefined) return context.json({ error: "device_authentication_required" }, 401);
    return context.json({
      deviceId: record.deviceId,
      name: record.name,
      platform: record.platform,
      grants: record.grants,
      host: { name: hostDisplayName },
      sessionExpiresAt: identity.sessionExpiresAt,
    } satisfies DeviceSelfResponse);
  });

  // Operator device management: list and revoke. Revocation is per-device — it
  // invalidates every session token the device holds on the next request.
  app.get("/v1/devices", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const now = clock();
    const items = [...devices.values()]
      .filter((record) => !isDevicePendingExpired(record, now))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(deviceListItem);
    return context.json(items);
  });

  app.post("/v1/devices/:id/revoke", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const deviceId = context.req.param("id");
    return withSerializedLock(deviceLocks, deviceId, async () => {
      const now = clock();
      const record = devices.get(deviceId);
      if (record === undefined || isDevicePendingExpired(record, now))
        return context.json({ error: "device_not_found" }, 404);
      if (record.status === "revoked") return context.json(deviceListItem(record));
      const event = await recordEvent("device.revoked", `device:${deviceId}`, now.toISOString(), {
        schemaVersion: 1,
        deviceId,
        revokedBy: operator.operatorId,
      });
      applyDeviceEvent(devices, event);
      logger.info({ deviceId, operatorId: operator.operatorId }, "device revoked");
      const updated = devices.get(deviceId);
      return context.json(deviceListItem(updated ?? record));
    });
  });

  app.post("/v1/actions/decide", async (context) => {
    const request = ActionRequestSchema.parse(await context.req.json());
    if (request.context.profileHash !== dependencies.doctrine.profileHash) {
      return context.json({
        effect: "deny",
        reason: "The action was requested under a stale doctrine hash.",
        matchedPolicyIds: ["stale-doctrine"],
        obligations: [],
      });
    }
    const previous = approvalRequests.get(request.id);
    if (previous && !sameApprovalRequest(previous, request, request.context.missionId)) {
      return context.json(
        {
          effect: "deny",
          reason: "The action request id belongs to a different approval request.",
          matchedPolicyIds: ["approval-request-binding"],
          obligations: [],
        },
        409,
      );
    }
    if (previous?.status === "denied") {
      return context.json({
        effect: "deny",
        reason: `The authenticated operator denied this request: ${previous.reason ?? "denied"}`,
        matchedPolicyIds: ["operator-approval:denied"],
        obligations: [],
      });
    }
    const evaluatedRequest = previous?.status === "approved" ? withHumanApproval(request) : request;
    const decision = decideAction(dependencies.doctrine, evaluatedRequest);
    if (decision.effect === "require_approval") {
      await persistApprovalRequest(request, decision, request.context.missionId);
    }
    logger.info(
      { missionId: request.context.missionId, action: request.action, effect: decision.effect },
      "action decided",
    );
    return context.json(decision);
  });

  app.post("/v1/workers/:id/capabilities", async (context) => {
    if (
      !dependencies.authenticateWorker ||
      !dependencies.resolveActionContext ||
      !dependencies.classifyConnectorAction ||
      !dependencies.capabilityBroker
    ) {
      return context.json({ error: "capability_exchange_unavailable" }, 503);
    }
    const identity = await dependencies.authenticateWorker(context.req.raw);
    if (!identity) return context.json({ error: "worker_authentication_required" }, 401);

    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "invalid_capability_request" }, 400);
    }
    const parsedInput = CapabilityRequestSchema.safeParse(body);
    if (!parsedInput.success) return context.json({ error: "invalid_capability_request" }, 400);
    const input = parsedInput.data;
    const identityError = validateWorkerBinding(context.req.param("id"), identity, dependencies);
    if (identityError) return context.json({ error: identityError }, 403);
    const trustedContext = await dependencies.resolveActionContext(identity, input.request);
    if (!trustedContext) {
      return context.json({ error: "action_context_unavailable" }, 403);
    }
    const classification = await dependencies.classifyConnectorAction(input.request);
    if (!classification) {
      return context.json({ error: "connector_action_unclassified" }, 403);
    }

    const priorApproval = approvalRequests.get(input.request.id);
    const actionRequest = ActionRequestSchema.parse({
      ...input.request,
      principal: { kind: "worker", id: identity.workerRunId },
      context: {
        ...trustedContext,
        ...(priorApproval?.status === "approved"
          ? { humanApprovals: (trustedContext.humanApprovals ?? 0) + 1 }
          : {}),
        missionId: identity.missionId,
        ...(identity.taskId ? { taskId: identity.taskId } : {}),
        profileHash: identity.profileHash,
      },
    });
    if (priorApproval && !sameApprovalRequest(priorApproval, actionRequest, identity.correlationId)) {
      return context.json({ error: "approval_request_binding_mismatch" }, 409);
    }
    if (priorApproval?.status === "denied") {
      return context.json(
        {
          error: "capability_not_allowed",
          decision: {
            effect: "deny",
            reason: `The authenticated operator denied this request: ${priorApproval.reason ?? "denied"}`,
            matchedPolicyIds: ["operator-approval:denied"],
            obligations: [],
          },
        },
        403,
      );
    }
    if (priorApproval?.status === "approved" && consumedApprovalIds.has(priorApproval.id)) {
      return context.json({ error: "approval_already_consumed" }, 409);
    }
    const decision = decideCapabilityRequest(dependencies.doctrine, actionRequest, classification);
    logger.info(
      {
        missionId: identity.missionId,
        workerRunId: identity.workerRunId,
        action: input.request.action,
        effect: decision.effect,
      },
      "worker capability request decided",
    );
    if (!permitsCapabilityGrant(decision)) {
      if (decision.effect === "require_approval") {
        await persistApprovalRequest(actionRequest, decision, identity.correlationId);
      }
      return context.json({ error: "capability_not_allowed", decision }, 403);
    }

    if (priorApproval?.status === "approved") {
      const consumed = await withSerializedLock(approvalLocks, priorApproval.id, async () => {
        if (consumedApprovalIds.has(priorApproval.id)) return false;
        const consumedAt = clock().toISOString();
        await recordEvent(
          "approval.decided",
          priorApproval.missionId,
          consumedAt,
          { approval: priorApproval, consumedAt, consumedBy: identity.workerRunId },
          approvalEnvelope(priorApproval),
        );
        consumedApprovalIds.add(priorApproval.id);
        return true;
      });
      if (!consumed) return context.json({ error: "approval_already_consumed" }, 409);
    }

    const issuedAt = Math.floor(clock().getTime() / 1000);
    const resource = connectorResourceKey(input.request.resource);
    const grant: CapabilityGrantInput = {
      version: 1,
      grantId: `grant-${idFactory()}`,
      principalId: identity.workerRunId,
      missionId: identity.missionId,
      profileHash: identity.profileHash,
      capabilities: [input.request.action],
      resources: [resource],
      obligations: decision.obligations,
      issuedAt,
      expiresAt: issuedAt + input.ttlSeconds,
      nonce: idFactory(),
    };
    const token = await dependencies.capabilityBroker.issue(grant, auditContext(identity, dependencies));
    return context.json(
      {
        token,
        grant: {
          grantId: grant.grantId,
          capability: input.request.action,
          resource,
          issuedAt: grant.issuedAt,
          expiresAt: grant.expiresAt,
        },
        decision,
      },
      201,
    );
  });

  app.post("/v1/workers/:id/connectors/github/execute", async (context) => {
    if (!dependencies.authenticateWorker || !dependencies.capabilityBroker) {
      return context.json({ error: "capability_exchange_unavailable" }, 503);
    }
    if (!dependencies.githubConnector) {
      return context.json({ error: "github_connector_unavailable" }, 503);
    }
    const identity = await dependencies.authenticateWorker(context.req.raw);
    if (!identity) return context.json({ error: "worker_authentication_required" }, 401);

    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "invalid_connector_request" }, 400);
    }
    const parsedInput = ConnectorUseSchema.safeParse(body);
    if (!parsedInput.success) return context.json({ error: "invalid_connector_request" }, 400);
    const input = parsedInput.data;
    const identityError = validateWorkerBinding(context.req.param("id"), identity, dependencies);
    if (identityError) return context.json({ error: identityError }, 403);
    if (!input.request.action.startsWith("github.")) {
      return context.json({ error: "github_action_required" }, 400);
    }
    const use = await dependencies.capabilityBroker.authorizeUse(
      {
        token: input.token,
        capability: input.request.action,
        resource: connectorResourceKey(input.request.resource),
      },
      auditContext(identity, dependencies),
      Math.floor(clock().getTime() / 1000),
    );
    if (!use.allowed) {
      return context.json({ error: "capability_use_denied", reason: use.reason }, 403);
    }
    if (!use.grant) {
      return context.json({ error: "capability_grant_missing" }, 500);
    }

    const operationId = `github-operation-${idFactory()}`;
    const operation: GithubConnectorOperation = {
      operationId,
      action: input.request.action,
      resource: input.request.resource,
      missionId: identity.missionId,
      workerRunId: identity.workerRunId,
      correlationId: identity.correlationId,
      obligations: use.grant.obligations,
      ...(identity.taskId ? { taskId: identity.taskId } : {}),
    };
    const connectorResult: unknown = await dependencies.githubConnector.execute(operation);
    if (connectorResult !== undefined) {
      return context.json({ error: "invalid_connector_result" }, 502);
    }
    logger.info(
      {
        missionId: identity.missionId,
        workerRunId: identity.workerRunId,
        action: input.request.action,
        operationId,
      },
      "privileged GitHub connector operation completed",
    );
    return context.json({ result: { accepted: true, operationId } });
  });

  app.post("/v1/workers/:id/steer", async (context) => {
    const workerRunId = context.req.param("id");
    const authority = await authenticateSteerPrincipal(context.req.raw, dependencies);
    if (authority === "unavailable") return context.json({ error: "steer_control_unavailable" }, 503);
    if (!authority) return context.json({ error: "steer_control_authority_required" }, 401);
    const parsed = WorkerSteerRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_steer_request" }, 400);
    const normalized = normalizeWorkerSteerIntent(parsed.data);
    if (!normalized) return context.json({ error: "unclassified_steer_intent" }, 400);
    if (parsed.data.sourceLane && parsed.data.sourceLane !== authority.sourceLane) {
      return context.json({ error: "steer_source_lane_mismatch" }, 403);
    }
    if (!dependencies.authorizeWorkerSteer) {
      return context.json({ error: "steer_policy_unavailable" }, 503);
    }
    const active = activeWorkerRun(engines, workerRunId);
    if (!active) return context.json({ outcome: steerOutcome("worker_terminal") }, 409);
    if (!active.runtime.runnerId || !active.runtime.leaseExpiresAt) {
      return context.json({ outcome: steerOutcome("worker_terminal") }, 409);
    }
    if (Date.parse(active.runtime.leaseExpiresAt) <= clock().getTime()) {
      return context.json({ outcome: steerOutcome("lease_expired") }, 409);
    }
    const inputSha256 = createHash("sha256").update(normalized.input).digest("hex");
    const authorization = await dependencies.authorizeWorkerSteer({
      principal: authority.principal,
      sourceLane: authority.sourceLane,
      intent: normalized.intent,
      commandId: parsed.data.commandId,
      correlationId: parsed.data.correlationId,
      missionId: active.missionId,
      taskId: active.runtime.spec.id,
      workerRunId,
      attempt: active.runtime.attempts,
      runnerId: active.runtime.runnerId,
      profileHash: dependencies.doctrine.profileHash,
      inputSha256,
      inputLength: normalized.input.length,
    });
    const previous = await steeringStore.get(parsed.data.commandId);
    if (previous) {
      if (
        !authorization.allowed ||
        !sameWorkerSteerEnvelope(previous, {
          workerRunId,
          attempt: active.runtime.attempts,
          runnerId: active.runtime.runnerId,
          sourceLane: authority.sourceLane,
          principal: authority.principal,
          correlationId: parsed.data.correlationId,
          missionId: active.missionId,
          taskId: active.runtime.spec.id,
          profileHash: dependencies.doctrine.profileHash,
          inputSha256,
        })
      ) {
        return context.json({ error: "duplicate_command_id" }, 409);
      }
      return context.json({ accepted: true, command: redactedSteerRecord(previous) }, 202);
    }
    if (!authorization.allowed) {
      return context.json({ error: "steer_policy_denied", reason: authorization.reason }, 403);
    }
    const requestedAt = clock().toISOString();
    const command: StoredWorkerSteerCommand = {
      schemaVersion: 1,
      commandId: parsed.data.commandId,
      workerRunId,
      attempt: active.runtime.attempts,
      sourceLane: authority.sourceLane,
      intent: normalized.intent,
      principal: authority.principal,
      correlationId: parsed.data.correlationId,
      missionId: active.missionId,
      taskId: active.runtime.spec.id,
      profileHash: dependencies.doctrine.profileHash,
      input: normalized.input,
      runnerId: active.runtime.runnerId,
      leaseExpiresAt: active.runtime.leaseExpiresAt,
      inputSha256,
      inputLength: normalized.input.length,
      requestedAt,
      status: "pending",
      deliveryCount: 0,
    };
    await steeringStore.put(command);
    await recordEvent(
      "worker.steer.requested",
      active.missionId,
      requestedAt,
      { ...redactedSteerData(command), policyReason: authorization.reason },
      {
        taskId: command.taskId,
        workerRunId,
        correlationId: command.correlationId,
        profileHash: command.profileHash,
      },
    );
    logger.info(
      { workerRunId, commandId: command.commandId, inputLength: command.inputLength, inputSha256 },
      "worker steering queued",
    );
    return context.json({ accepted: true, command: redactedSteerRecord(command) }, 202);
  });

  app.get("/v1/workers/:id/transcript", async (context) => {
    const authorization = await authorizeTranscriptRead(context);
    if (authorization) return authorization;
    const key = transcriptKeyFromRequest(context);
    if (!key) return context.json({ error: "invalid_worker_transcript_key" }, 400);
    if (!dependencies.workerTranscripts) {
      return context.json({ error: "worker_transcript_unavailable" }, 503);
    }
    try {
      const outcome = await dependencies.workerTranscripts.snapshot(key, context.req.raw.signal);
      if (outcome.outcome === "snapshot") {
        if (!sameTranscriptKey(outcome.key, key)) {
          return context.json({ error: "worker_transcript_identity_mismatch" }, 502);
        }
        return context.json({
          ...outcome,
          entries: outcome.entries.filter((entry) => entry.visibility === "garden"),
        });
      }
      if (
        outcome.outcome === "run_replaced" &&
        (outcome.replacementKey.missionId !== key.missionId || outcome.replacementKey.taskId !== key.taskId)
      ) {
        return context.json({ error: "worker_transcript_identity_mismatch" }, 502);
      }
      return context.json(outcome, outcome.outcome === "run_replaced" ? 409 : 404);
    } catch {
      return context.json({ error: "worker_transcript_upstream_failure" }, 502);
    }
  });

  app.get("/v1/workers/:id/transcript/tail", async (context) => {
    const authorization = await authorizeTranscriptRead(context);
    if (authorization) return authorization;
    const key = transcriptKeyFromRequest(context);
    if (!key) return context.json({ error: "invalid_worker_transcript_key" }, 400);
    const cursor = context.req.query("cursor");
    if (!cursor || cursor.length > 2_048)
      return context.json({ error: "worker_transcript_cursor_required" }, 400);
    if (!dependencies.workerTranscripts) {
      return context.json({ error: "worker_transcript_unavailable" }, 503);
    }
    const abort = new AbortController();
    const requestAbort = () => abort.abort();
    context.req.raw.signal.addEventListener("abort", requestAbort, { once: true });
    let opened;
    try {
      opened = await dependencies.workerTranscripts.openTail(key, cursor, abort.signal);
    } catch {
      context.req.raw.signal.removeEventListener("abort", requestAbort);
      return context.json({ error: "worker_transcript_upstream_failure" }, 502);
    }
    if (opened.outcome !== "tail") {
      context.req.raw.signal.removeEventListener("abort", requestAbort);
      if (
        opened.outcome === "run_replaced" &&
        (opened.replacementKey.missionId !== key.missionId || opened.replacementKey.taskId !== key.taskId)
      )
        return context.json({ error: "worker_transcript_identity_mismatch" }, 502);
      return context.json(opened, opened.outcome === "not_found" ? 404 : 409);
    }
    const iterator = opened.stream[Symbol.asyncIterator]();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          while (true) {
            const next = await iterator.next();
            if (next.done) {
              controller.close();
              return;
            }
            if (!validTranscriptTailLine(next.value, key)) {
              abort.abort();
              controller.error(new Error("worker_transcript_identity_mismatch"));
              return;
            }
            if (next.value.entry.visibility !== "garden") continue;
            controller.enqueue(new TextEncoder().encode(`${JSON.stringify(next.value)}\n`));
            return;
          }
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        abort.abort();
        await iterator.return?.();
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  });

  return app;
}

function transcriptKeyFromRequest(context: Context): WorkerTranscriptKey | undefined {
  const parsed = WorkerTranscriptKeySchema.safeParse({
    missionId: context.req.query("missionId"),
    taskId: context.req.query("taskId"),
    workerRunId: context.req.param("id"),
  });
  return parsed.success ? parsed.data : undefined;
}

function sameTranscriptKey(left: WorkerTranscriptKey, right: WorkerTranscriptKey): boolean {
  return (
    left.missionId === right.missionId &&
    left.taskId === right.taskId &&
    left.workerRunId === right.workerRunId
  );
}

function validTranscriptTailLine(line: WorkerTranscriptTailLine, key: WorkerTranscriptKey): boolean {
  return sameTranscriptKey(
    {
      missionId: line.entry.missionId,
      taskId: line.entry.taskId,
      workerRunId: line.entry.workerRunId,
    },
    key,
  );
}

function isRunnerStatusEvent(type: string): boolean {
  return [
    "worker.turn.started",
    "worker.turn.settled",
    "worker.waiting_user",
    "worker.status.signal",
  ].includes(type);
}

function normalizeRunnerStatusData(
  type: string,
  data: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const schema =
    type === "worker.turn.started"
      ? WorkerTurnStartedDataSchema.strict()
      : type === "worker.turn.settled"
        ? WorkerTurnSettledDataSchema.strict()
        : type === "worker.waiting_user"
          ? WorkerWaitingUserDataSchema.strict()
          : type === "worker.status.signal"
            ? RunnerGenericStatusDataSchema
            : undefined;
  if (!schema) return undefined;
  const parsed = schema.safeParse(data);
  return parsed.success ? { ...parsed.data } : undefined;
}

function auditContext(
  identity: TrustedWorkerIdentity,
  dependencies: ControlPlaneDependencies,
): CapabilityAuditContext {
  return {
    missionId: identity.missionId,
    workerRunId: identity.workerRunId,
    correlationId: identity.correlationId,
    profileHash: dependencies.doctrine.profileHash,
    ...(identity.taskId ? { taskId: identity.taskId } : {}),
  };
}

function validateWorkerBinding(
  routeWorkerRunId: string,
  identity: TrustedWorkerIdentity,
  dependencies: ControlPlaneDependencies,
): string | undefined {
  if (routeWorkerRunId !== identity.workerRunId) return "worker_route_mismatch";
  if (identity.profileHash !== dependencies.doctrine.profileHash) return "stale_doctrine";
  return undefined;
}

function connectorResourceKey(resource: ActionResource): string {
  return JSON.stringify([
    resource.type,
    resource.id,
    resource.repository ?? null,
    resource.environment ?? null,
  ]);
}

async function authenticateRunner(
  request: Request,
  dependencies: ControlPlaneDependencies,
): Promise<TrustedRunnerIdentity | "unavailable" | undefined> {
  if (!dependencies.authenticateRunner) return "unavailable";
  return dependencies.authenticateRunner(request);
}

async function authenticateCaptain(
  request: Request,
  dependencies: ControlPlaneDependencies,
): Promise<TrustedCaptainIdentity | "unavailable" | undefined> {
  if (!dependencies.authenticateCaptain) return "unavailable";
  return dependencies.authenticateCaptain(request);
}

async function authenticateOperator(
  request: Request,
  dependencies: ControlPlaneDependencies,
): Promise<TrustedOperatorIdentity | "unavailable" | undefined> {
  if (!dependencies.authenticateOperator) return "unavailable";
  return dependencies.authenticateOperator(request);
}

async function authenticateSteerPrincipal(
  request: Request,
  dependencies: ControlPlaneDependencies,
): Promise<
  | {
      principal: { kind: "captain" | "operator"; id: string };
      sourceLane: WorkerSteerSourceLane;
    }
  | "unavailable"
  | undefined
> {
  const captain = await authenticateCaptain(request, dependencies);
  if (captain && captain !== "unavailable") {
    return {
      principal: { kind: "captain", id: captain.captainId },
      sourceLane: captain.steerSourceLane ?? "api",
    };
  }
  const operator = await authenticateOperator(request, dependencies);
  if (operator && operator !== "unavailable") {
    return {
      principal: { kind: "operator", id: operator.operatorId },
      sourceLane: operator.steerSourceLane ?? "tui",
    };
  }
  return captain === "unavailable" && operator === "unavailable" ? "unavailable" : undefined;
}

function approvalEnvelope(approval: ApprovalRequestRecord): {
  taskId?: string;
  workerRunId?: string;
  correlationId: string;
  profileHash: string;
} {
  return {
    correlationId: approval.correlationId,
    profileHash: approval.profileHash,
    ...(approval.taskId ? { taskId: approval.taskId } : {}),
    ...(approval.workerRunId ? { workerRunId: approval.workerRunId } : {}),
  };
}

function approvalHandle(
  approval: ApprovalRequestRecord,
  ttlMs: number,
): {
  id: string;
  status: ApprovalRequestRecord["status"];
  fingerprint?: string;
  artifactRef?: string;
  expiresAt: string;
} {
  return {
    id: approval.id,
    status: approval.status,
    ...(approval.resource.repository?.startsWith("sha256:")
      ? { fingerprint: approval.resource.repository }
      : {}),
    ...(approval.resource.type === "discord-attachment" ? { artifactRef: approval.resource.id } : {}),
    expiresAt: new Date(Date.parse(approval.requestedAt) + ttlMs).toISOString(),
  };
}

function sameApprovalRequest(
  approval: ApprovalRequestRecord,
  request: ActionRequest,
  correlationId: string,
): boolean {
  return (
    approval.missionId === request.context.missionId &&
    approval.taskId === request.context.taskId &&
    approval.workerRunId === (request.principal.kind === "worker" ? request.principal.id : undefined) &&
    approval.action === request.action &&
    connectorResourceKey(approval.resource) === connectorResourceKey(request.resource) &&
    approval.correlationId === correlationId &&
    approval.profileHash === request.context.profileHash
  );
}

function withHumanApproval(request: ActionRequest): ActionRequest {
  return ActionRequestSchema.parse({
    ...request,
    context: {
      ...request.context,
      humanApprovals: (request.context.humanApprovals ?? 0) + 1,
    },
  });
}

function compareApprovals(left: ApprovalRequestRecord, right: ApprovalRequestRecord): number {
  return left.requestedAt.localeCompare(right.requestedAt) || left.id.localeCompare(right.id);
}

async function withSerializedLock<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}

function applyApprovalEvent(
  approvals: Map<string, ApprovalRequestRecord>,
  consumedApprovalIds: Set<string>,
  event: DomainEvent,
): void {
  if (event.type !== "approval.requested" && event.type !== "approval.decided") return;
  const approval = ApprovalRequestRecordSchema.parse(event.data.approval);
  if (approval.missionId !== event.missionId || approval.profileHash !== event.profileHash) {
    throw new Error(`Approval event ${event.id} has a mismatched mission or doctrine profile`);
  }
  approvals.set(approval.id, approval);
  if (
    event.type === "approval.decided" &&
    typeof event.data.consumedAt === "string" &&
    typeof event.data.consumedBy === "string"
  ) {
    consumedApprovalIds.add(approval.id);
  }
}

function trackerAttribution(
  event: DomainEvent,
  missions: ReadonlyMap<string, MissionRecord>,
  events: readonly DomainEvent[],
): TrackerEventAttribution {
  const role = event.taskId
    ? (missions.get(event.missionId)?.plan?.tasks.find((task) => task.id === event.taskId)?.role ?? "system")
    : "system";
  const nativeSessionIds = event.workerRunId
    ? events
        .filter(
          (candidate) =>
            candidate.workerRunId === event.workerRunId && candidate.type === "worker.native_session.bound",
        )
        .flatMap((candidate) => {
          for (const key of ["nativeSessionId", "sessionId", "providerSessionId"]) {
            const value = candidate.data[key];
            if (typeof value === "string") return [value];
          }
          return [];
        })
    : [];
  return nativeSessionIds.length > 0 ? { role, nativeSessionIds } : { role };
}

function trackerFailureEvent(
  source: DomainEvent,
  error: unknown,
  profileHash: string,
  idFactory: () => string,
  clock: () => Date,
): DomainEvent {
  const failure =
    error instanceof TrackerPolicyError
      ? { kind: "policy", action: error.action, effect: error.effect }
      : { kind: "connector" };
  return {
    id: idFactory(),
    occurredAt: clock().toISOString(),
    missionId: source.missionId,
    correlationId: source.correlationId,
    causationId: source.id,
    profileHash,
    type: "tracker.sync.failed",
    data: { sourceEventId: source.id, ...failure },
    ...(source.taskId ? { taskId: source.taskId } : {}),
    ...(source.workerRunId ? { workerRunId: source.workerRunId } : {}),
  };
}

function assertTrackerAuthorityBindings(doctrine: CompiledDoctrine, connector: string): void {
  const connected = new Set([connector]);
  for (const role of TRACKER_AUTHORITY_ROLES) {
    const binding = resolveAuthorityBinding(doctrine, role, connected);
    if (binding.kind !== "connector" || binding.connector !== connector) {
      throw new Error(`Authority role ${role} is not bound to ${connector}`);
    }
  }
}

function pruneExpired<T extends { expiresAtMs: number }>(entries: Map<string, T>, now: number): void {
  for (const [key, record] of entries) {
    if (record.expiresAtMs <= now) entries.delete(key);
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function findEngineForWorkerRun(
  engines: ReadonlyMap<string, MissionEngine>,
  workerRunId: string,
): { missionId: string; engine: MissionEngine } | undefined {
  for (const [missionId, engine] of engines) {
    const leased = engine
      .getEvents()
      .find((event) => event.type === "worker.leased" && event.workerRunId === workerRunId);
    if (leased) return { missionId, engine };
  }
  return undefined;
}

function activeWorkerRun(
  engines: ReadonlyMap<string, MissionEngine>,
  workerRunId: string,
): { missionId: string; engine: MissionEngine; runtime: TaskRuntime } | undefined {
  const entry = findEngineForWorkerRun(engines, workerRunId);
  if (!entry) return undefined;
  const taskId = taskIdForWorkerRun(entry.engine, workerRunId);
  if (!taskId) return undefined;
  const runtime = entry.engine.getTask(taskId);
  if (runtime.workerRunId !== workerRunId || runtime.state !== "running") return undefined;
  return { ...entry, runtime };
}

function publicSteerCommand(command: StoredWorkerSteerCommand): WorkerSteerCommand {
  return {
    schemaVersion: 1,
    commandId: command.commandId,
    workerRunId: command.workerRunId,
    attempt: command.attempt,
    sourceLane: command.sourceLane,
    intent: command.intent,
    principal: command.principal,
    correlationId: command.correlationId,
    missionId: command.missionId,
    taskId: command.taskId,
    profileHash: command.profileHash,
    input: command.input,
  };
}

function redactedSteerData(
  command: StoredWorkerSteerCommand,
  outcome?: WorkerSteerOutcome,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    commandId: command.commandId,
    attempt: command.attempt,
    runnerId: command.runnerId,
    sourceLane: command.sourceLane,
    intent: command.intent,
    principal: command.principal,
    inputSha256: command.inputSha256,
    inputLength: command.inputLength,
    contentRedacted: true,
    ...(outcome ? { outcome } : {}),
  };
}

function redactedSteerRecord(command: StoredWorkerSteerCommand): Record<string, unknown> {
  return {
    ...redactedSteerData(command, command.outcome),
    workerRunId: command.workerRunId,
    missionId: command.missionId,
    taskId: command.taskId,
    correlationId: command.correlationId,
    profileHash: command.profileHash,
    requestedAt: command.requestedAt,
    status: command.status,
    deliveryCount: command.deliveryCount,
  };
}

function steerOutcome(code: WorkerSteerOutcome["code"]): WorkerSteerOutcome {
  const messages: Record<WorkerSteerOutcome["code"], string> = {
    delivered: "The typed worker adapter accepted the command.",
    stale_attempt: "The command does not target the active worker attempt.",
    wrong_runner: "The authenticated runner does not own this worker attempt.",
    worker_terminal: "The worker run is no longer active.",
    lease_expired: "The worker attempt lease is missing or expired.",
    unsupported_adapter: "The active provider adapter does not support typed steering.",
    human_control_active: "Automated steering is paused while a human control lease is active.",
    delivery_failed: "The typed provider steering request failed.",
  };
  return { code, message: messages[code] };
}

interface NormalizedWorkerSteerIntent {
  intent: WorkerSteerIntent;
  input: string;
}

function sameWorkerSteerEnvelope(
  previous: StoredWorkerSteerCommand,
  current: Pick<
    StoredWorkerSteerCommand,
    | "workerRunId"
    | "attempt"
    | "runnerId"
    | "sourceLane"
    | "principal"
    | "correlationId"
    | "missionId"
    | "taskId"
    | "profileHash"
    | "inputSha256"
  >,
): boolean {
  return (
    previous.workerRunId === current.workerRunId &&
    previous.attempt === current.attempt &&
    previous.runnerId === current.runnerId &&
    previous.sourceLane === current.sourceLane &&
    previous.principal.kind === current.principal.kind &&
    previous.principal.id === current.principal.id &&
    previous.correlationId === current.correlationId &&
    previous.missionId === current.missionId &&
    previous.taskId === current.taskId &&
    previous.profileHash === current.profileHash &&
    previous.inputSha256 === current.inputSha256
  );
}

function normalizeWorkerSteerIntent(request: {
  intent?: WorkerSteerIntent | undefined;
  input?: string | undefined;
}): NormalizedWorkerSteerIntent | undefined {
  if (request.intent) {
    return { intent: structuredClone(request.intent), input: renderWorkerSteerIntent(request.intent) };
  }
  if (!request.input || containsControlCharacter(request.input)) return undefined;
  const intent = LEGACY_WORKER_STEER_INTENTS.get(request.input.trim().toLowerCase());
  return intent ? { intent: structuredClone(intent), input: renderWorkerSteerIntent(intent) } : undefined;
}

function containsControlCharacter(input: string): boolean {
  for (const character of input) {
    const codePoint = character.codePointAt(0) as number;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}

function renderWorkerSteerIntent(intent: WorkerSteerIntent): string {
  if (intent.type === "focus") {
    const targets: Record<Extract<WorkerSteerIntent, { type: "focus" }>["target"], string> = {
      current_task: "Focus on the current task.",
      failing_test: "Focus on the failing unit test first.",
      acceptance_criteria: "Focus on the acceptance criteria.",
      scope: "Focus on the declared scope.",
      diagnosis: "Focus on diagnosing the current failure.",
    };
    return targets[intent.target];
  }
  const commands: Record<Exclude<WorkerSteerIntent["type"], "focus">, string> = {
    continue: "Continue the current task.",
    retry_last_step: "Retry the last failed step.",
    summarize_status: "Summarize the current status.",
  };
  return commands[intent.type];
}

const LEGACY_WORKER_STEER_INTENTS = new Map<string, WorkerSteerIntent>([
  ["focus on the current task.", { type: "focus", target: "current_task" }],
  ["focus on the failing test.", { type: "focus", target: "failing_test" }],
  ["focus on the failing unit test first.", { type: "focus", target: "failing_test" }],
  ["focus only on the failing test.", { type: "focus", target: "failing_test" }],
  ["focus on the exact failing assertion.", { type: "focus", target: "failing_test" }],
  ["inspect the exact failing assertion.", { type: "focus", target: "failing_test" }],
  ["focus on the acceptance criteria.", { type: "focus", target: "acceptance_criteria" }],
  ["focus on scope.", { type: "focus", target: "scope" }],
  ["focus on diagnosis.", { type: "focus", target: "diagnosis" }],
  ["continue.", { type: "continue" }],
  ["retry the last step.", { type: "retry_last_step" }],
  ["summarize status.", { type: "summarize_status" }],
]);

export function createDeterministicWorkerSteerAuthorizer(): WorkerSteerAuthorizer {
  return (input) => {
    if (input.principal.kind === "captain" && input.sourceLane === "tui") {
      return Promise.resolve({ allowed: false, reason: "Captain authority cannot assert the TUI lane." });
    }
    if (
      input.principal.kind === "operator" &&
      (input.sourceLane === "discord_text" || input.sourceLane === "discord_voice")
    ) {
      return Promise.resolve({ allowed: false, reason: "Operator authority cannot assert an ambient lane." });
    }
    return Promise.resolve({ allowed: true, reason: "Authenticated typed steering intent is allowed." });
  };
}

function taskIdForWorkerRun(engine: MissionEngine, workerRunId: string): string | undefined {
  return engine
    .getEvents()
    .find((event) => event.type === "worker.leased" && event.workerRunId === workerRunId)?.taskId;
}

function recoveryLineage(spec: TaskSpec): { failedTaskId: string; debuggerTaskId?: string } | undefined {
  const value = spec.metadata.recovery;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.failedTaskId !== "string") return undefined;
  return {
    failedTaskId: record.failedTaskId,
    ...(typeof record.debuggerTaskId === "string" ? { debuggerTaskId: record.debuggerTaskId } : {}),
  };
}

function recoveryCheckIdentities(spec: TaskSpec): string[] | undefined {
  const value = spec.metadata.recovery;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const identities = (value as Record<string, unknown>).requiredCheckIdentities;
  if (!Array.isArray(identities) || !identities.every((identity) => typeof identity === "string")) {
    return undefined;
  }
  return [...identities].sort();
}

function resultCheckIdentities(result: WorkerResult): string[] {
  const identityPattern = /^runner-check:.+:sha256:[0-9a-f]{64}$/u;
  return [
    ...new Set(
      result.evidence
        .filter((evidence) => evidence.kind === "test_report" && identityPattern.test(evidence.label))
        .map((evidence) => evidence.label),
    ),
  ].sort();
}

function sameCheckIdentities(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function workerConflictResponse(context: Context, error: unknown): Response {
  if (!(error instanceof WorkerRunConflictError)) throw error;
  const status = error.code === "unknown_worker_run" ? 404 : 409;
  return context.json({ error: error.code, message: error.message }, status);
}

function liveMissionRecord(mission: MissionRecord, snapshot: MissionSnapshot): Record<string, unknown> {
  return {
    ...mission,
    state: snapshot.state,
    tasks: snapshot.tasks,
    approvals: snapshot.approvals,
    workerStatuses: snapshot.workerStatuses,
    eventCount: snapshot.eventCount,
    snapshot,
  };
}

/**
 * Admit only the retained-candidate shapes the runner pull executor supports
 * (ADR 0019). Two shapes are accepted:
 *
 *   1. the implementation + verification slice, and
 *   2. the full frozen-scenario graph
 *      (context -> implementation -> verification -> debugging -> re-verification).
 *
 * Verifier independence, read-only verification, acyclicity, role coupling, and
 * parallel write-scope isolation are enforced once, by the mission-engine plan
 * validator (VUH-697); this gate adds only the structural pull-executor shape.
 */
function assertSupportedPullPlan(plan: MissionPlan): void {
  const isFrozenScenarioShape =
    plan.tasks.some((task) => task.kind === "context" || task.kind === "debugging") ||
    plan.tasks.filter((task) => task.kind === "verification").length > 1;
  if (isFrozenScenarioShape) {
    assertFrozenScenarioGraph(plan);
  } else {
    assertImplementationVerificationSlice(plan);
  }
  assertValidMissionPlan(plan);
}

function assertImplementationVerificationSlice(plan: MissionPlan): void {
  if (plan.tasks.length !== 2) {
    throw new Error("Runner pull execution currently requires exactly implementation + verification tasks");
  }
  const implementation = plan.tasks.find((task) => task.kind === "implementation");
  const verification = plan.tasks.find((task) => task.kind === "verification");
  if (!implementation || !verification) {
    throw new Error("Runner pull execution requires one implementation and one verification task");
  }
  assertRootImplementation(implementation);
  if (
    verification.writeScope.length !== 0 ||
    verification.dependsOn.length !== 1 ||
    verification.dependsOn[0] !== implementation.id
  ) {
    throw new Error("The read-only verifier must depend only on the implementation candidate");
  }
}

function assertFrozenScenarioGraph(plan: MissionPlan): void {
  const context = plan.tasks.filter((task) => task.kind === "context");
  const implementations = plan.tasks.filter((task) => task.kind === "implementation");
  const verifications = plan.tasks.filter((task) => task.kind === "verification");
  const debuggings = plan.tasks.filter((task) => task.kind === "debugging");
  if (
    plan.tasks.length !== 5 ||
    context.length !== 1 ||
    implementations.length !== 1 ||
    verifications.length !== 2 ||
    debuggings.length !== 1
  ) {
    throw new Error(
      "The frozen scenario graph requires exactly one context, one implementation, two verification, and one debugging task",
    );
  }
  const contextTask = context[0]!;
  const implementation = implementations[0]!;
  const debugging = debuggings[0]!;
  if (contextTask.dependsOn.length !== 0 || contextTask.writeScope.length !== 0) {
    throw new Error("The context task must be the read-only root of the frozen scenario graph");
  }
  if (implementation.dependsOn.length !== 1 || implementation.dependsOn[0] !== contextTask.id) {
    throw new Error("The implementation task must depend only on the context task");
  }
  assertRootImplementation(implementation, { requireRoot: false });
  const initialVerification = verifications.find(
    (task) => task.dependsOn.length === 1 && task.dependsOn[0] === implementation.id,
  );
  if (!initialVerification) {
    throw new Error("The initial verifier must depend only on the implementation candidate");
  }
  if (debugging.role !== "debugger" || debugging.writeScope.length === 0) {
    throw new Error("The debugging task must use the debugger role and declare a non-empty write scope");
  }
  if (!debugging.dependsOn.includes(initialVerification.id)) {
    throw new Error(
      "The debugging task must depend on the verification task whose failure evidence it repairs",
    );
  }
  const repairVerification = verifications.find((task) => task.id !== initialVerification.id)!;
  if (repairVerification.dependsOn.length !== 1 || repairVerification.dependsOn[0] !== debugging.id) {
    throw new Error("The re-verification task must depend only on the debugging repair");
  }
}

function assertRootImplementation(implementation: TaskSpec, options: { requireRoot?: boolean } = {}): void {
  const requireRoot = options.requireRoot ?? true;
  if (
    implementation.role !== "implementer" ||
    (requireRoot && implementation.dependsOn.length !== 0) ||
    implementation.writeScope.length === 0
  ) {
    throw new Error(
      requireRoot
        ? "The implementation task must use the implementer role, be the root, and declare a non-empty write scope"
        : "The implementation task must use the implementer role and declare a non-empty write scope",
    );
  }
}

export function createBearerAuthenticator<T>(
  token: string,
  identity: T,
): (request: Request) => Promise<T | undefined> {
  if (token.length === 0) throw new Error("Authentication token must not be empty");
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  return (request) => {
    const actual = createHash("sha256")
      .update(request.headers.get("authorization") ?? "")
      .digest();
    return Promise.resolve(timingSafeEqual(actual, expected) ? identity : undefined);
  };
}

function applyMissionEvent(missions: Map<string, MissionRecord>, event: DomainEvent): void {
  if (event.type === "mission.drafted") {
    const data = z
      .object({ goal: z.string().min(1), context: z.record(z.string(), z.unknown()).default({}) })
      .parse(event.data);
    missions.set(event.missionId, {
      id: event.missionId,
      goal: data.goal,
      context: data.context,
      state: "draft",
      createdAt: event.occurredAt,
    });
    return;
  }
  if (event.type === "mission.planned") {
    const mission = missions.get(event.missionId);
    if (!mission) {
      logger.warn({ missionId: event.missionId }, "mission.planned event without a drafted mission");
      return;
    }
    mission.plan = MissionPlanSchema.parse(event.data.plan);
    const context = z.record(z.string(), z.unknown()).safeParse(event.data.context);
    if (context.success) mission.context = context.data;
    mission.state = "planned";
    return;
  }
  if (event.type === "mission.execution.started") {
    const mission = missions.get(event.missionId);
    if (mission) mission.state = "running";
  }
}

function applyMemoryEvent(
  proposals: Map<string, StoredMemoryProposal>,
  committed: Set<string>,
  event: DomainEvent,
): void {
  if (event.type === "memory.proposal.submitted") {
    const proposal = z
      .object({
        proposalId: z.string().min(1),
        approvalRequestId: z.string().min(1),
        fact: MemoryFactSchema,
        submittedAt: z.string().datetime(),
        principal: z.object({ kind: z.enum(["captain", "worker"]), id: z.string().min(1) }),
      })
      .parse(event.data.proposal);
    proposals.set(proposal.proposalId, proposal);
    return;
  }
  if (event.type === "memory.proposal.committed") {
    committed.add(z.string().min(1).parse(event.data.proposalId));
  }
}

function discordPresenceBindingKey(identity: {
  readonly transportKind: "bot" | "user_session";
  readonly characterId: string;
  readonly credentialRef: string;
}): string {
  return JSON.stringify([identity.transportKind, identity.characterId, identity.credentialRef]);
}

export async function loadDefaultDoctrine(): Promise<CompiledDoctrine> {
  const doctrinePath = resolve(process.env.CLANKIE_DOCTRINE ?? "doctrine/profiles/self-build-lab.yaml");
  return compileDoctrine([await loadDoctrineFile(doctrinePath)]);
}
