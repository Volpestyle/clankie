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
import { captainLaneInstructions } from "@clankie/captain-runtime";
import type { EventStore, StoredEvent } from "@clankie/event-store";
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
  ActivityObservationReadSchema,
  isDiscordPresenceActionAvailable,
  resolveDiscordPresencePhaseToolExposure,
  type DiscordPresenceSessionRecord,
} from "@clankie/interactive-environment";
import {
  DiscordPersonIdentitySchema,
  DiscordPersonMemoryFactSchema,
  MemoryFactSchema,
  type ApplyDiscordPersonProposalResult,
  type ApplyProposalResult,
  type CaptainEpisode,
  type DiscordPersonIdentity,
  type EpisodeRecallOptions,
  type DiscordPersonMemoryExport,
  type DiscordPersonMemoryFact,
  type DiscordPersonMemoryReadOptions,
  type DiscordPersonRecallOptions,
  type MemoryFact,
  type RecallCardOptions,
} from "@clankie/memory-store";
import {
  AdoptWorkerRequestSchema,
  DirectAdoptedWorkerRequestSchema,
  ApprovalDecisionInputSchema,
  ApprovalRequestRecordSchema,
  ApprovalRequestStatusSchema,
  ActionResourceSchema,
  ActionRequestSchema,
  ReleaseWorkerAdoptionRequestSchema,
  CaptainChannelTurnResultSchema,
  CaptainEpisodeSchema,
  CaptainPresenceReportSchema,
  CaptainSessionLaneV2Schema,
  DiscordPresenceChannelTurnRequestSchema,
  DiscordPresenceWriteSchema,
  DISCORD_TRANSPORT_ACTION_RISK_CLASS,
  DiscordUserSessionOptInRequestSchema,
  DiscordUserSessionOptInSchema,
  EmbodimentClaimSchema,
  type EmbodimentEnvironmentId,
  EmbodimentIntentSchema,
  EmbodimentLifecycleReportSchema,
  type EmbodimentSession,
  resolveDiscordPresenceLedgerContent,
  LinearChannelTurnRequestSchema,
  SlackChannelTurnRequestSchema,
  MissionEventAuthFailureSchema,
  MissionEventTailAuthLineSchema,
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
  type BodyPossession,
  type CaptainChannelTurnResult,
  type DeviceGrantSet,
  type DeviceRecord,
  type DeviceSelfResponse,
  type DeviceSessionRefreshResponse,
  type DiscordPresenceWriteResult,
  type DiscordTransportKind,
  type PairingCompleteResponse,
  type PairingRedeemResponse,
  type DomainEvent,
  type MissionEventAuthFailure,
  type MissionPlan,
  type MissionTrigger,
  type Risk,
  type TaskSpec,
  type TrackerNarrativeWriteResult,
  type WorkerResult,
  type WorkerAdoptionPrincipal,
  type WorkerTranscriptKey,
  type WorkerTranscriptTailLine,
  DISCORD_PRESENCE_ACTION_RISK_CLASS,
  DiscordPresenceActionSchema,
  eventStreamKindForId,
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
  WorkerScopeReservation,
  WorkerSteerCommand,
  WorkerSteerIntent,
  WorkerSteerPrincipal,
  WorkerSteerSourceLane,
} from "@clankie/worker-sdk";
import { personaInstructions, SettingsStore, type ClankieSettings } from "@clankie/settings";
import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  CaptainPresenceLeaseConflictError,
  CaptainPresenceManager,
  type CaptainPresenceLease,
} from "./captain-presence.ts";
import {
  InMemoryWorkerSteeringStore,
  type StoredWorkerSteerCommand,
  type WorkerSteeringStore,
  type WorkerSteerOutcome,
} from "./worker-steering.ts";
import type { DiscordPresenceRuntimePort } from "./discord-presence-runtime.ts";
import {
  DiscordPresenceSessionProjection,
  deriveDiscordVoiceHistory,
  discordPresenceDomainEvent,
} from "./discord-presence-session.ts";
import {
  DISCORD_USER_SESSION_OPT_IN_MISSION_ID,
  DISCORD_USER_SESSION_OPT_IN_RECORDED,
  DISCORD_USER_SESSION_OPT_IN_REVOKED,
  DiscordUserSessionOptInProjection,
} from "./discord-user-session-opt-in.ts";
import type { CaptainChannelTurnPort } from "./eve-captain-turn.ts";
import { EmbodimentManager, embodimentEventScope, isEmbodimentEventType } from "./embodiment.ts";
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
import type { ActivityObservationReadPort } from "./activity-observations.ts";
import type { AgentCensusReadPort } from "./agent-census.ts";
import { MissionEventFeed, type MissionEventFeedTailRead } from "./mission-event-feed.ts";

const logger = createLogger({ service: "clankie-control-plane", version: "0.1.0" });
const LINEAR_DELIVERY_RETENTION_MS = 7 * 60 * 60 * 1_000;

/** Log labels for the channel-turn providers; the union grows here, not inline. */
const CHANNEL_PROVIDER_LABELS = {
  linear: "Linear",
  discord: "Discord",
  slack: "Slack",
} as const;

function logMissionEventFeedAuthorityFailure(error: unknown, missionId?: string): void {
  logger.error(
    {
      error: error instanceof Error ? error.message : String(error),
      ...(missionId === undefined ? {} : { missionId }),
    },
    "mission event feed reconciliation failed closed",
  );
}

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

interface StoredDiscordPersonMemoryProposal {
  readonly proposalId: string;
  readonly approvalRequestId: string;
  readonly fact: DiscordPersonMemoryFact;
  readonly submittedAt: string;
  readonly eventMissionId: string;
  readonly principal: { kind: "captain"; id: string };
}

export interface MemoryStorePort {
  applyApprovedProposal(input: unknown): ApplyProposalResult;
  applyApprovedDiscordPersonProposal(input: unknown): ApplyDiscordPersonProposalResult;
  deleteDiscordPerson(identity: DiscordPersonIdentity): readonly string[];
  exportDiscordPerson(identity: DiscordPersonIdentity, now?: Date): DiscordPersonMemoryExport;
  listDiscordPerson(
    identity: DiscordPersonIdentity,
    options?: DiscordPersonMemoryReadOptions,
  ): readonly DiscordPersonMemoryFact[];
  recallDiscordPersonCard(identity: DiscordPersonIdentity, options: DiscordPersonRecallOptions): string;
  recallCard(options: RecallCardOptions): string;
  recordEpisode(input: unknown): CaptainEpisode;
  episodeRecallCard(options: EpisodeRecallOptions): string;
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
  /**
   * Owner-authored persona source for the realtime voice briefing (ADR 0057).
   * Defaults to the operator settings file; a request body can never supply it,
   * for the reason ADR 0051 gives: caller-controlled context must not redefine
   * who Clankie is. Tests inject a fixed settings document.
   */
  settings?: { load(): Promise<ClankieSettings> };
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
  /**
   * Privileged executor for the personal-lab user-session transport (ADR 0048).
   * Separate from the bot runtime so a deployment that never configures it
   * cannot execute a user-session write even if one is somehow authenticated.
   */
  discordUserPresenceRuntime?: DiscordPresenceRuntimePort;
  /**
   * Read-only view of the cross-process body lock (VUH-938): who holds
   * Clankie's body right now, liveness-checked. The composition root wires the
   * shared body root; tests inject a fake. Absent means unwired, which reads
   * as "nobody" — a missing observer must never invent a holder.
   */
  bodyPossession?: () => BodyPossession | null;
  /** Authenticates the outbound local runner. Missing configuration leaves execution unavailable. */
  authenticateRunner?: RunnerAuthenticator;
  /** Authenticates the captain/operator starting an already validated plan. */
  authenticateCaptain?: CaptainAuthenticator;
  /** Authenticates a human on an approval-capable operator surface. */
  authenticateOperator?: OperatorAuthenticator;
  /**
   * HMAC key (≥32 bytes) that signs device session tokens and, under a separate
   * domain, opaque mission-event cursors (VUH-727/VUH-909). When omitted,
   * device authentication, pairing redemption, and mission-event reads fail
   * closed (503). Production loads it from a mode-0600 key file; tests inject
   * bytes directly.
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
  /** Injected runner-owned activity reader. The control plane never persists activity content. */
  activityObservations?: ActivityObservationReadPort;
  /** Runner-owned view of agents this control plane did not start (ADR 0078). */
  agentCensus?: AgentCensusReadPort;
}

export type WorkerSteerAuthorizer = (input: {
  principal: WorkerSteerPrincipal;
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
  /**
   * Which Discord body this bearer speaks for (ADR 0048). Absent for non-Discord
   * captains. Defaults to `bot` at the gate so an older bearer keeps working.
   */
  discordTransportKind?: DiscordTransportKind;
}

/** Transport a captain bearer is entitled to, never read from a request body. */
function captainTransportKind(captain: TrustedCaptainIdentity): DiscordTransportKind {
  return captain.discordTransportKind ?? "bot";
}

/**
 * Broker provider id the opt-in binds to. Kept as a literal so the control
 * plane never imports the credential broker just to name a reference.
 */
const DISCORD_USER_SESSION_CREDENTIAL_REF = "discord_user_session";
const DISCORD_TRANSPORT_USER_SESSION_CONNECT = "discord.transport.user_session_connect" as const;

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
  reservations: z
    .array(
      z
        .object({
          id: z.string().min(1).max(200),
          workspaceRoot: z.string().min(1).max(1024),
          writeScope: z.array(z.string().min(1).max(400)).min(1).max(64),
        })
        .strict(),
    )
    .max(256)
    .default([]),
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

const DiscordPersonMemoryProposalRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    proposalId: z.string().min(1).max(256),
    fact: DiscordPersonMemoryFactSchema,
  })
  .strict();

const DiscordPersonMemoryReadQuerySchema = z
  .object({
    channelId: z.string().min(1).max(64).optional(),
    query: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

/** Discord snowflakes only: the voice-briefing request carries ids, never content. */
const DiscordSnowflakeSchema = z.string().regex(/^\d{5,32}$/u, "must be a numeric Discord id");

/**
 * Realtime voice briefing request (ADR 0057). Strict by construction: every
 * field is a literal or a snowflake-shaped id and unknown keys are rejected, so
 * a bridge request structurally cannot smuggle a person-memory projection,
 * briefing text, or instructions into the control-plane-side composition.
 */
const DiscordVoiceBriefingRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    guildId: DiscordSnowflakeSchema,
    channelId: DiscordSnowflakeSchema,
    consentedUserIds: z.array(DiscordSnowflakeSchema).max(25),
  })
  .strict();

/**
 * Hard cap on each voice-briefing string. Both projections list newest content
 * first, so dropping whole trailing lines beyond the bound sheds oldest-first.
 */
const DISCORD_VOICE_BRIEFING_MAX_CHARACTERS = 8_000;
/** Approved facts projected per consented speaker; mirrors the recall-card scale. */
const DISCORD_VOICE_BRIEFING_MAX_FACTS_PER_PERSON = 8;

/**
 * What the realtime surface allows, appended after persona and lane identity.
 * Authored here because the control plane owns the realtime session's whole
 * instruction composition; the bridge only transports it.
 */
const DISCORD_VOICE_REALTIME_SURFACE_RULES = [
  "# This surface",
  "You are the live voice in a Discord voice channel; people hear you speak in real time.",
  "- Your only tool is `ask_clankie`. Anything that touches the world — missions, workers, code, messages, memory, settings, anything this briefing cannot answer — goes through it. You hold no other capability and never imply otherwise.",
  "- Speech can never approve privileged work. When a request is approval-shaped — merge, deploy, publish, delete, grant, confirm — say it has to happen on an authenticated surface, and pass it through `ask_clankie` so it lands in the captain lane.",
  "- Answer briefly in a spoken register: short sentences, no lists, no headers, no markdown — nothing you would not say out loud.",
  '- A leading "Speaker: <id>" text item names who currently has the floor. It comes from the authenticated Discord gateway and is ground truth; never infer who is talking from the audio itself.',
].join("\n");

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

const DISCORD_PRESENCE_NARRATIVE_ACTIONS = new Set<string>(
  DISCORD_PRESENCE_NARRATIVE_ACTION_METADATA.map((entry) => entry.action),
);

/**
 * Derived, not hand-listed.
 *
 * Every presence action that is not narrative is classified straight from the
 * protocol's frozen risk-class map, so an action added to
 * `DiscordPresenceActionSchema` is classifiable the moment it exists. The
 * previous hand-maintained list silently drifted: the ADR 0047 activity actions
 * reached the executor but 400'd at the route as `unclassified`, because unit
 * tests called the executor directly and never crossed this boundary.
 *
 * Narrative entries stay explicit because they carry a `narrativeKind` that the
 * risk-class map does not model.
 */
const DISCORD_PRESENCE_NON_NARRATIVE_ACTION_METADATA = DiscordPresenceActionSchema.options
  .filter((action) => !DISCORD_PRESENCE_NARRATIVE_ACTIONS.has(action))
  .map((action) => {
    const riskClass = DISCORD_PRESENCE_ACTION_RISK_CLASS[action];
    if (riskClass === "narrative-write") {
      // A narrative-classed action must be listed above, because the ledger
      // needs the `narrativeKind` the risk-class map cannot supply. Failing at
      // module load beats classifying it without that attribution.
      throw new Error(`discord_presence_narrative_action_missing_metadata:${action}`);
    }
    return { action, riskClass };
  });

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

/**
 * Transport lifecycle classifier (ADR 0048). Separate from the presence
 * classifier because connecting a body is not a write to any channel; sharing
 * one classifier would put a lifecycle action into the narrative ledger's
 * vocabulary.
 */
const classifyDiscordTransportAction = createConnectorActionClassifier([
  {
    action: DISCORD_TRANSPORT_USER_SESSION_CONNECT,
    riskClass: DISCORD_TRANSPORT_ACTION_RISK_CLASS[DISCORD_TRANSPORT_USER_SESSION_CONNECT],
  },
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
  // Read per briefing rather than cached: the owner edits persona in the TUI and
  // a refreshed voice session must pick it up without a control-plane restart.
  const settingsSource = dependencies.settings ?? new SettingsStore();
  const instanceId = randomUUID();
  const missions = new Map<string, MissionRecord>();
  const missionTriggers = new Map<string, MissionTrigger>();
  const memoryProposals = new Map<string, StoredMemoryProposal>();
  const committedMemoryProposals = new Set<string>();
  const discordPersonMemoryProposals = new Map<string, StoredDiscordPersonMemoryProposal>();
  const committedDiscordPersonMemoryProposals = new Set<string>();
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
  const workerSteerCommandLocks = new Map<string, Promise<unknown>>();
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
  const initialStoredEvents: StoredEvent[] = [];
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
      initialStoredEvents.push(stored);
      storedEvents.push(stored.event);
      applyMissionEvent(missions, stored.event);
      applyMissionTriggerEvent(missionTriggers, stored.event);
      applyMemoryEvent(memoryProposals, committedMemoryProposals, stored.event);
      applyDiscordPersonMemoryEvent(
        discordPersonMemoryProposals,
        committedDiscordPersonMemoryProposals,
        stored.event,
      );
      applyApprovalEvent(approvalRequests, consumedApprovalIds, stored.event);
      applyDeviceEvent(devices, stored.event);
      if (stored.event.type === "worker.leased" && typeof stored.event.data.claimId === "string") {
        claimMissions.set(stored.event.data.claimId, stored.event.missionId);
      }
    }
    logger.info({ missionCount: missions.size }, "mission records rebuilt from event store");
  }
  const missionEventFeed =
    dependencies.eventStore && dependencies.deviceSessionKey
      ? new MissionEventFeed({
          cursorKey: dependencies.deviceSessionKey,
          readCanonicalEvents: () => dependencies.eventStore!.readAll(),
          initialEvents: initialStoredEvents,
        })
      : undefined;
  const discordPresenceSessions = new DiscordPresenceSessionProjection(storedEvents);
  const discordUserSessionOptIns = new DiscordUserSessionOptInProjection(storedEvents);
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
      streamKind: eventStreamKindForId(missionId),
      correlationId: envelope.correlationId ?? missionId,
      profileHash: envelope.profileHash ?? dependencies.doctrine.profileHash,
      type,
      data,
      ...(envelope.taskId ? { taskId: envelope.taskId } : {}),
      ...(envelope.workerRunId ? { workerRunId: envelope.workerRunId } : {}),
    };
    const stored = dependencies.eventStore ? await dependencies.eventStore.append(event) : undefined;
    storedEvents.push(event);
    if (stored) await missionEventFeed?.publish(stored);
    persistedEventIds.add(event.id);
    await syncTrackerEvent(event);
    return event;
  };

  // Asked play is classified, not action-listed: a bounded, stoppable,
  // checkpointed session is a reversible write, and the profiles' risk-class
  // posture already encodes who may start one (lab allows, high assurance
  // requires approval, which an ambient surface renders as a refusal). Listing
  // `environment.play.*` explicitly in a profile stays available to the owner
  // as the doctrine-owned restriction path — it shifts the profile hash, so it
  // comes with an eval-baseline regeneration, deliberately.
  const embodimentClassifier = createConnectorActionClassifier([
    { action: "environment.play.start", riskClass: "reversible-write" },
    { action: "environment.play.stop", riskClass: "reversible-write" },
  ]);
  const embodiment = new EmbodimentManager({
    clock,
    idFactory: () => `embodiment-${idFactory()}`,
    emit: async (type, sessionId, data) => {
      await recordEvent(type, embodimentEventScope(sessionId), clock().toISOString(), data);
    },
    decide: (intent) => {
      const action = intent.kind === "start" ? "environment.play.start" : "environment.play.stop";
      const request = ActionRequestSchema.parse({
        id: idFactory(),
        principal: { kind: "captain", id: "captain-eve", role: "captain" },
        action,
        resource: {
          type: "environment",
          id: intent.kind === "start" ? intent.environmentId : intent.sessionId,
        },
        context: {
          // ActionRequest v1 requires a policy scope in its missionId slot;
          // embodiment sessions live outside any mission (ADR 0063).
          missionId: embodimentEventScope(intent.intentId),
          risk: "low",
          profileHash: dependencies.doctrine.profileHash,
        },
      });
      return decideAction(dependencies.doctrine, request, embodimentClassifier(action)).effect;
    },
  });
  for (const event of storedEvents) {
    if (isEmbodimentEventType(event.type)) embodiment.applyEvent(event);
  }

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

  const commitApprovedDiscordPersonMemoryProposal = async (
    proposal: StoredDiscordPersonMemoryProposal,
    approval: ApprovalRequestRecord,
  ): Promise<ApplyDiscordPersonProposalResult | undefined> => {
    if (!dependencies.memoryStore || committedDiscordPersonMemoryProposals.has(proposal.proposalId)) {
      return undefined;
    }
    if (
      approval.id !== proposal.approvalRequestId ||
      approval.action !== "memory.profile.write" ||
      approval.resource.type !== "discord-person-memory-proposal" ||
      approval.status !== "approved" ||
      approval.missionId !== proposal.eventMissionId ||
      approval.profileHash !== dependencies.doctrine.profileHash ||
      approval.decidedAt === undefined ||
      approval.decidedBy === undefined
    ) {
      throw new Error(
        "Discord person-memory proposal approval does not match the authenticated approval projection",
      );
    }
    const result = dependencies.memoryStore.applyApprovedDiscordPersonProposal({
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
      "discord.person-memory.proposal.committed",
      proposal.eventMissionId,
      clock().toISOString(),
      {
        proposalId: proposal.proposalId,
        approvalRequestId: proposal.approvalRequestId,
        factId: result.fact.factId,
        merged: result.merged,
        evictedFactIds: [...result.evictedFactIds],
        ...(result.supersededFactId === undefined ? {} : { supersededFactId: result.supersededFactId }),
      },
      { correlationId: proposal.fact.provenance.correlationId },
    );
    committedDiscordPersonMemoryProposals.add(proposal.proposalId);
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
    for (const proposal of discordPersonMemoryProposals.values()) {
      const approval = approvalRequests.get(proposal.approvalRequestId);
      if (
        approval?.status === "approved" &&
        !committedDiscordPersonMemoryProposals.has(proposal.proposalId)
      ) {
        await commitApprovedDiscordPersonMemoryProposal(proposal, approval);
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
      const stored = dependencies.eventStore ? await dependencies.eventStore.append(event) : undefined;
      persistedEventIds.add(event.id);
      storedEvents.push(event);
      if (stored) await missionEventFeed?.publish(stored);
      await syncTrackerEvent(event);
    }
  };

  async function syncTrackerEvent(event: DomainEvent): Promise<void> {
    if (!dependencies.trackerMirror || event.type === "tracker.sync.failed") return;
    try {
      await dependencies.trackerMirror.publish(event, trackerAttribution(event, missions, storedEvents));
    } catch (error) {
      const failure = trackerFailureEvent(event, error, dependencies.doctrine.profileHash, idFactory, clock);
      const stored = dependencies.eventStore ? await dependencies.eventStore.append(failure) : undefined;
      storedEvents.push(failure);
      if (stored) await missionEventFeed?.publish(stored);
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
      const stored = dependencies.eventStore ? await dependencies.eventStore.append(event) : undefined;
      storedEvents.push(event);
      if (stored) await missionEventFeed?.publish(stored);
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

  type TranscriptReadDenial =
    | {
        body: ReturnType<typeof WorkerTranscriptAuthFailureSchema.parse>;
        status: 401 | 403;
      }
    | { body: { error: "worker_transcript_authentication_unavailable" }; status: 503 };

  const transcriptReadDenial = async (context: Context): Promise<TranscriptReadDenial | undefined> => {
    const identity = await authenticateDevice(context.req.raw);
    if (identity === "unavailable") {
      return { body: { error: "worker_transcript_authentication_unavailable" }, status: 503 };
    }
    if ("denied" in identity) {
      const reason =
        identity.denied === "expired"
          ? "session_expired"
          : identity.denied === "revoked"
            ? "device_revoked"
            : "authentication_required";
      return {
        body: WorkerTranscriptAuthFailureSchema.parse({
          schemaVersion: 1,
          outcome: "auth_failed",
          reason,
        }),
        status: 401,
      };
    }
    if (!identity.grants.chat) {
      return {
        body: WorkerTranscriptAuthFailureSchema.parse({
          schemaVersion: 1,
          outcome: "auth_failed",
          reason: "permission_denied",
        }),
        status: 403,
      };
    }
    return undefined;
  };

  const authorizeTranscriptRead = async (context: Context): Promise<Response | undefined> => {
    const denial = await transcriptReadDenial(context);
    return denial ? context.json(denial.body, denial.status) : undefined;
  };

  type MissionEventReadDenial =
    | { body: MissionEventAuthFailure; status: 401 | 403 }
    | { body: { error: "mission_event_authentication_unavailable" }; status: 503 };

  const missionEventReadDenial = async (context: Context): Promise<MissionEventReadDenial | undefined> => {
    const identity = await authenticateDevice(context.req.raw);
    if (identity === "unavailable") {
      return { body: { error: "mission_event_authentication_unavailable" }, status: 503 };
    }
    if ("denied" in identity) {
      return {
        body: MissionEventAuthFailureSchema.parse({
          schemaVersion: 1,
          outcome: "auth_failed",
          reason:
            identity.denied === "expired"
              ? "session_expired"
              : identity.denied === "revoked"
                ? "device_revoked"
                : "authentication_required",
        }),
        status: 401,
      };
    }
    if (!identity.grants.chat) {
      return {
        body: MissionEventAuthFailureSchema.parse({
          schemaVersion: 1,
          outcome: "auth_failed",
          reason: "permission_denied",
        }),
        status: 403,
      };
    }
    return undefined;
  };

  const authorizeMissionEventRead = async (context: Context): Promise<Response | undefined> => {
    const denial = await missionEventReadDenial(context);
    return denial ? context.json(denial.body, denial.status) : undefined;
  };

  /**
   * Census access (ADR 0078): the captain or an authenticated operator. Knowing
   * which agents are running is a read the owner should never have to
   * authorize, so it sits at the same tier as reading current activity. The
   * extra authority `directed` adoption needs is checked at that route, not
   * here.
   */
  const authenticateAgentCensusPrincipal = async (
    context: Context,
  ): Promise<{ principal: WorkerAdoptionPrincipal } | { denial: Response }> => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain && captain !== "unavailable") {
      return { principal: { kind: "captain", id: captain.captainId } };
    }
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable") {
      if (captain === "unavailable") {
        return { denial: context.json({ error: "agent_census_authentication_unavailable" }, 503) };
      }
      return { denial: context.json({ error: "agent_census_authentication_required" }, 401) };
    }
    if (!operator) {
      return { denial: context.json({ error: "agent_census_authentication_required" }, 401) };
    }
    return { principal: { kind: "operator", id: operator.operatorId } };
  };

  app.get("/health", (context) =>
    context.json({
      ok: true,
      service: "clankie-control-plane",
      doctrine: dependencies.doctrine.profile.id,
      profileHash: dependencies.doctrine.profileHash,
    }),
  );

  app.get("/v1/discord/readiness", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "captain_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    if (captain.steerSourceLane !== "discord_text" && captain.steerSourceLane !== "discord_voice") {
      return context.json({ error: "discord_channel_authority_required" }, 403);
    }
    const checks = {
      captainChannelTurns: dependencies.captainChannelTurns !== undefined,
      discordPresenceRuntime: dependencies.discordPresenceRuntime !== undefined,
      eventStore: dependencies.eventStore !== undefined,
    };
    const ready = Object.values(checks).every(Boolean);
    return context.json(
      {
        schemaVersion: 1 as const,
        ready,
        service: "clankie-control-plane" as const,
        instanceId,
        profileHash: dependencies.doctrine.profileHash,
        checks,
      },
      ready ? 200 : 503,
    );
  });

  /**
   * Realtime voice briefing (ADR 0057): the bounded projection seeded into the
   * long-lived realtime session, composed entirely control-plane-side.
   *
   * The request carries only ids — the strict schema makes a bridge-supplied
   * person-memory projection structurally impossible. Persona comes from the
   * owner-authored settings file, lane identity from the shared
   * `captainLaneInstructions`, self-state from the control plane's own captain
   * presence lease and Discord presence projection (ADR 0054), episodes from
   * the memory store's ambient-lane recall card, and person memory from the
   * same control-plane-owned store `EveCaptainChannelTurnPort` resolves
   * `approvedPersonMemory` from — ids in, store out, nothing widened.
   *
   * Read-only: nothing here commits memory or any other state; the only write
   * is a content-free egress audit event. Both response strings are capped at
   * DISCORD_VOICE_BRIEFING_MAX_CHARACTERS, shedding whole trailing (oldest)
   * lines beyond the bound.
   */
  app.post("/v1/discord/voice-briefing", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "captain_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    if (captain.steerSourceLane !== "discord_voice") {
      return context.json({ error: "discord_voice_authority_required" }, 403);
    }
    const parsed = DiscordVoiceBriefingRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_discord_voice_briefing" }, 400);
    const request = parsed.data;
    let persona: ClankieSettings["persona"];
    try {
      persona = (await settingsSource.load()).persona;
    } catch {
      // A malformed settings file fails closed rather than briefing a default
      // character the owner did not author.
      return context.json({ error: "voice_briefing_persona_unavailable" }, 503);
    }
    const now = clock();
    const instructions = boundVoiceBriefingText(
      [
        personaInstructions(persona, "social"),
        captainLaneInstructions({
          metadata: {
            captainLane: "discord_voice",
            captainTargetId: `${request.guildId}:${request.channelId}`,
          },
        }),
        DISCORD_VOICE_REALTIME_SURFACE_RULES,
      ].join("\n\n"),
      DISCORD_VOICE_BRIEFING_MAX_CHARACTERS,
    );
    const sections = [
      renderVoiceBriefingSelfState(captainPresence.snapshot(), discordPresenceSessions.list()),
    ];
    // What his body is doing, if anything. Without this the room hears a
    // persona that does not know it is mid-playthrough, so every report from
    // the play loop arrives with no frame of reference to remark against.
    const embodimentCard = renderVoiceBriefingEmbodiment(embodiment.liveSession());
    if (embodimentCard !== undefined) sections.push(embodimentCard);
    // Same visibility fence as every ambient lane: non-operator lanes only ever
    // see `shareable` episodes (`MemoryStore.recallEpisodes`).
    const episodeCard = dependencies.memoryStore?.episodeRecallCard({ lane: "discord_voice" }) ?? "";
    if (episodeCard.length > 0) sections.push(episodeCard);
    let personMemoryUserCount = 0;
    for (const userId of new Set(request.consentedUserIds)) {
      // Ambient default visibility only — guild-scoped plus this channel's
      // facts, never operator_private — exactly what the Discord surfaces
      // already receive from GET /v1/memory/discord-people/:guildId/:userId.
      const facts =
        dependencies.memoryStore?.listDiscordPerson(
          { guildId: request.guildId, userId },
          { channelId: request.channelId, now },
        ) ?? [];
      const card = renderVoiceBriefingPersonMemory(userId, facts);
      if (card !== undefined) {
        sections.push(card);
        personMemoryUserCount += 1;
      }
    }
    const briefing = boundVoiceBriefingText(sections.join("\n\n"), DISCORD_VOICE_BRIEFING_MAX_CHARACTERS);
    if (dependencies.eventStore) {
      // Content-free egress receipt: this is a new path for approved person
      // memory into a long-lived third-party session, so leaving it unlogged
      // would make the risk note unauditable. Counts and lengths only.
      await recordEvent(
        "discord.voice-briefing.projected",
        `discord-voice:${request.guildId}:${request.channelId}`,
        now.toISOString(),
        {
          consentedUserCount: request.consentedUserIds.length,
          personMemoryUserCount,
          instructionsLength: instructions.length,
          briefingLength: briefing.length,
        },
        { correlationId: `discord-voice-briefing:${idFactory()}` },
      );
    }
    return context.json({
      schemaVersion: 1 as const,
      instructions,
      briefing,
      refreshedAt: now.toISOString(),
    });
  });

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
        const stored = dependencies.eventStore
          ? await dependencies.eventStore.append(domainEvent)
          : undefined;
        const session = discordPresenceSessions.apply(event);
        if (advancesDurableRevision) discordPresenceLiveSessions.set(sessionKey, session);
        storedEvents.push(domainEvent);
        if (stored) await missionEventFeed?.publish(stored);
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

  /**
   * Completed voice stays with the room context captured at join time
   * (VUH-940): where he was, when, and who shared the channel. A read-side
   * projection over the durable phase stream — nothing is written, so "who was
   * I just with" stays presence-class data and the episode ring (ADR 0054)
   * remains reserved for notes Clankie composes himself.
   */
  app.get("/v1/discord/voice-history", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    const rawLimit = context.req.query("limit");
    const parsedLimit = rawLimit === undefined ? 5 : Number.parseInt(rawLimit, 10);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 32) {
      return context.json({ error: "invalid_voice_history_limit" }, 400);
    }
    return context.json({
      schemaVersion: 1 as const,
      stays: deriveDiscordVoiceHistory(storedEvents, parsedLimit),
    });
  });

  /**
   * Operator-readable presence status for `clankie status`.
   *
   * ADR 0024 requires operator status to come from the semantic phase stream
   * rather than bot log text, but the full session records above are captain
   * scoped — they carry the identity an action must claim. So this projects only
   * the fields an operator needs to answer "is the bridge actually present?":
   * phase, gateway flag, and counts. No session id, credential ref, character
   * id, or revision, so reading status can never supply what acting requires.
   */
  app.get("/v1/discord/presence-status", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable") {
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    }
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    return context.json({
      schemaVersion: 1 as const,
      sessions: discordPresenceSessions.list().map((session) => ({
        phase: session.phase,
        gatewayConnected: session.gatewayConnected,
        transportKind: session.transportKind,
        voiceGuildCount: session.voiceGuildIds.length,
        activityCount: session.activityInstances.length,
        updatedAt: session.updatedAt,
      })),
    });
  });

  /**
   * Records the owner's acceptance of user-session transport risk (ADR 0048).
   *
   * Operator-authenticated on purpose: this is the one gate that cannot be an
   * ambient or captain decision, because it is the human accepting Discord ToS
   * and account risk on their own account. Binding it to the current doctrine
   * hash means a later policy change forces a fresh, informed acceptance.
   */
  app.post("/v1/discord/user-session/opt-in", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable") {
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    }
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    if (!dependencies.eventStore) return context.json({ error: "event_store_unavailable" }, 503);
    const parsed = DiscordUserSessionOptInRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_discord_user_session_opt_in" }, 400);
    const recordedAt = clock().toISOString();
    // Doctrine decides whether this deployment may wear a human account at all.
    // Evaluating it here, at the moment of acceptance, is what makes a
    // high-assurance profile's denial real: the opt-in never exists, so the
    // plane can never start rather than being refused action-by-action later.
    const connectRequest = ActionRequestSchema.parse({
      id: `discord-user-session-connect:${dependencies.doctrine.profileHash}`,
      principal: { kind: "human", id: operator.operatorId, role: "discord-user-session-owner" },
      action: DISCORD_TRANSPORT_USER_SESSION_CONNECT,
      resource: { type: "discord-transport", id: DISCORD_USER_SESSION_CREDENTIAL_REF },
      context: {
        missionId: DISCORD_USER_SESSION_OPT_IN_MISSION_ID,
        risk: "high",
        humanApprovals: 1,
        profileHash: dependencies.doctrine.profileHash,
      },
    });
    const connectDecision = decideAction(
      dependencies.doctrine,
      connectRequest,
      classifyDiscordTransportAction(DISCORD_TRANSPORT_USER_SESSION_CONNECT),
    );
    if (connectDecision.effect === "deny") {
      return context.json(
        { error: "discord_user_session_denied_by_doctrine", decision: connectDecision },
        403,
      );
    }
    const optIn = DiscordUserSessionOptInSchema.parse({
      schemaVersion: 1,
      optInId: `discord-user-session-opt-in-${idFactory()}`,
      characterId: parsed.data.characterId,
      credentialRef: DISCORD_USER_SESSION_CREDENTIAL_REF,
      profileHash: dependencies.doctrine.profileHash,
      acknowledgement: parsed.data.acknowledgement,
      guildIds: parsed.data.guildIds,
      channelIds: parsed.data.channelIds,
      dmPolicy: parsed.data.dmPolicy,
      recordedAt,
    });
    const event = await recordEvent(
      DISCORD_USER_SESSION_OPT_IN_RECORDED,
      DISCORD_USER_SESSION_OPT_IN_MISSION_ID,
      recordedAt,
      { optIn, operatorId: operator.operatorId },
    );
    discordUserSessionOptIns.apply(event);
    return context.json({ schemaVersion: 1, optIn }, 201);
  });

  app.delete("/v1/discord/user-session/opt-in", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable") {
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    }
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    if (!dependencies.eventStore) return context.json({ error: "event_store_unavailable" }, 503);
    const existing = discordUserSessionOptIns.resolve();
    if (existing === undefined || existing.revokedAt !== undefined) {
      return context.json({ error: "discord_user_session_opt_in_not_active" }, 409);
    }
    const revokedAt = clock().toISOString();
    const event = await recordEvent(
      DISCORD_USER_SESSION_OPT_IN_REVOKED,
      DISCORD_USER_SESSION_OPT_IN_MISSION_ID,
      revokedAt,
      { optInId: existing.optInId, revokedAt, operatorId: operator.operatorId },
    );
    discordUserSessionOptIns.apply(event);
    return context.json({ schemaVersion: 1, optIn: discordUserSessionOptIns.resolve() });
  });

  /** Read by the user-session bridge before it opens a gateway. */
  app.get("/v1/discord/user-session/opt-in", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    return context.json({ schemaVersion: 1, optIn: discordUserSessionOptIns.resolve() ?? null });
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
    const parsed = DiscordPresenceWriteSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_discord_presence_write" }, 400);
    const write = parsed.data;
    if (write.identity.profileHash !== dependencies.doctrine.profileHash) {
      return context.json({ error: "doctrine_hash_mismatch" }, 409);
    }
    // Transport is bound to *authentication*, never to the request body: the
    // planes hold different broker bearers, so a compromised or confused bot
    // bridge cannot claim the user session's capabilities (or vice versa).
    if (write.identity.transportKind !== captainTransportKind(captain)) {
      return context.json({ error: "discord_presence_transport_not_authenticated" }, 403);
    }
    if (write.identity.transportKind === "user_session") {
      const optIn = discordUserSessionOptIns.resolveActive(dependencies.doctrine.profileHash);
      if (optIn === undefined) {
        return context.json({ error: "discord_user_session_opt_in_required" }, 403);
      }
      if (optIn.characterId !== write.identity.characterId) {
        return context.json({ error: "discord_user_session_opt_in_character_mismatch" }, 403);
      }
    }
    const discordPresenceRuntime =
      write.identity.transportKind === "user_session"
        ? dependencies.discordUserPresenceRuntime
        : dependencies.discordPresenceRuntime;
    if (!discordPresenceRuntime) {
      return context.json({ error: "discord_presence_runtime_unavailable" }, 503);
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
        // The generic code alone is a dead end: every transport, permission, and
        // runtime failure collapses into `discord_presence_failed`, and the
        // bridge surfaces exactly that to the operator. Whatever actually went
        // wrong was being discarded here, so a silent Discord reply could not be
        // diagnosed from the logs at all. Bounded, and never the raw stack.
        logger.error(
          {
            service: "clankie-control-plane",
            ...(write.identity.missionId === undefined ? {} : { missionId: write.identity.missionId }),
            ...(write.identity.presenceSessionId === undefined
              ? {}
              : { presenceSessionId: write.identity.presenceSessionId }),
            correlationId: write.identity.correlationId,
            action: write.action,
            code,
            errorName: error instanceof Error ? error.name.slice(0, 64) : "Error",
            errorMessage: error instanceof Error ? error.message.slice(0, 256) : String(error).slice(0, 256),
          },
          "Discord presence action failed",
        );
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
          if (discord.success) return { provider: "discord" as const, request: discord.data };
          // Slack is a sibling family, never a widening of Linear's (ADR 0080).
          const slack = SlackChannelTurnRequestSchema.safeParse(body);
          return slack.success ? { provider: "slack" as const, request: slack.data } : undefined;
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
      const expectedLane =
        parsedTurn.request.trigger.kind === "voice_event" ? "discord_voice" : "discord_text";
      if (captain.steerSourceLane !== expectedLane) {
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
        // One branch per provider: narrowing `{ request: A | B }` does not
        // narrow the submission union, and a cast here would let a future
        // provider reach the wrong normalizer without a type error.
        if (parsedTurn.provider === "slack") {
          return CaptainChannelTurnResultSchema.parse(
            await captainChannelTurns.submit({ request: parsedTurn.request }),
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
        `${CHANNEL_PROVIDER_LABELS[provider]} channel captain turn settled`,
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

  app.post("/v1/memory/discord-people/proposals", async (context) => {
    if (!dependencies.memoryStore || !dependencies.eventStore) {
      return context.json({ error: "memory_store_unavailable" }, 503);
    }
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "memory_proposal_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "memory_proposal_authentication_required" }, 401);
    if (captain.steerSourceLane !== "discord_text" && captain.steerSourceLane !== "discord_voice") {
      return context.json({ error: "discord_channel_authority_required" }, 403);
    }
    const parsed = DiscordPersonMemoryProposalRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_discord_person_memory_proposal" }, 400);
    const proposalInput = parsed.data;
    const eventMissionId = discordPersonMemoryEventMissionId(proposalInput.fact.subject);
    const approvalRequestId = `memory:discord-person:${proposalInput.proposalId}`;
    const proposal: StoredDiscordPersonMemoryProposal = {
      proposalId: proposalInput.proposalId,
      approvalRequestId,
      fact: proposalInput.fact,
      submittedAt: clock().toISOString(),
      eventMissionId,
      principal: { kind: "captain", id: captain.captainId },
    };
    const existing = discordPersonMemoryProposals.get(proposal.proposalId);
    if (existing) {
      if (
        JSON.stringify({ fact: existing.fact, principal: existing.principal }) !==
        JSON.stringify({ fact: proposal.fact, principal: proposal.principal })
      ) {
        return context.json({ error: "memory_proposal_idempotency_conflict" }, 409);
      }
      return context.json({
        proposal: existing,
        approval: approvalRequests.get(existing.approvalRequestId),
      });
    }
    const request = ActionRequestSchema.parse({
      id: approvalRequestId,
      principal: proposal.principal,
      action: "memory.profile.write",
      resource: { type: "discord-person-memory-proposal", id: proposal.proposalId },
      context: {
        missionId: eventMissionId,
        risk: "low",
        humanApprovals: 0,
        profileHash: dependencies.doctrine.profileHash,
      },
    });
    const decision = decideAction(dependencies.doctrine, request);
    await recordEvent(
      "discord.person-memory.proposal.submitted",
      eventMissionId,
      proposal.submittedAt,
      { proposal },
      { correlationId: proposal.fact.provenance.correlationId },
    );
    discordPersonMemoryProposals.set(proposal.proposalId, proposal);
    if (decision.effect === "deny") {
      await recordEvent(
        "discord.person-memory.proposal.denied",
        eventMissionId,
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

  app.get("/v1/memory/discord-people/:guildId/:userId/export", async (context) => {
    if (!dependencies.memoryStore || !dependencies.eventStore) {
      return context.json({ error: "memory_store_unavailable" }, 503);
    }
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable") {
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    }
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const identity = DiscordPersonIdentitySchema.safeParse({
      guildId: context.req.param("guildId"),
      userId: context.req.param("userId"),
    });
    if (!identity.success) return context.json({ error: "invalid_discord_person_identity" }, 400);
    const exported = dependencies.memoryStore.exportDiscordPerson(identity.data, clock());
    await recordEvent(
      "discord.person-memory.exported",
      discordPersonMemoryEventMissionId(identity.data),
      clock().toISOString(),
      { factCount: exported.facts.length, operatorId: operator.operatorId },
    );
    return context.json(exported);
  });

  app.delete("/v1/memory/discord-people/:guildId/:userId", async (context) => {
    if (!dependencies.memoryStore || !dependencies.eventStore) {
      return context.json({ error: "memory_store_unavailable" }, 503);
    }
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable") {
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    }
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const identity = DiscordPersonIdentitySchema.safeParse({
      guildId: context.req.param("guildId"),
      userId: context.req.param("userId"),
    });
    if (!identity.success) return context.json({ error: "invalid_discord_person_identity" }, 400);
    const deletedFactIds = dependencies.memoryStore.deleteDiscordPerson(identity.data);
    await recordEvent(
      "discord.person-memory.deleted",
      discordPersonMemoryEventMissionId(identity.data),
      clock().toISOString(),
      { deletedFactIds, operatorId: operator.operatorId },
    );
    return context.json({ schemaVersion: 1, subject: identity.data, deletedFactIds });
  });

  app.get("/v1/memory/discord-people/:guildId/:userId", async (context) => {
    if (!dependencies.memoryStore || !dependencies.eventStore) {
      return context.json({ error: "memory_store_unavailable" }, 503);
    }
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "memory_recall_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "memory_recall_authentication_required" }, 401);
    if (captain.steerSourceLane !== "discord_text" && captain.steerSourceLane !== "discord_voice") {
      return context.json({ error: "discord_channel_authority_required" }, 403);
    }
    const identity = DiscordPersonIdentitySchema.safeParse({
      guildId: context.req.param("guildId"),
      userId: context.req.param("userId"),
    });
    const query = DiscordPersonMemoryReadQuerySchema.safeParse(context.req.query());
    if (!identity.success || !query.success) {
      return context.json({ error: "invalid_discord_person_memory_recall" }, 400);
    }
    const options = {
      ...(query.data.channelId === undefined ? {} : { channelId: query.data.channelId }),
      now: clock(),
    };
    const facts = dependencies.memoryStore.listDiscordPerson(identity.data, options);
    const recallCard =
      query.data.query === undefined
        ? undefined
        : dependencies.memoryStore.recallDiscordPersonCard(identity.data, {
            ...options,
            query: query.data.query,
          });
    await recordEvent(
      "discord.person-memory.recalled",
      discordPersonMemoryEventMissionId(identity.data),
      clock().toISOString(),
      {
        factCount: facts.length,
        querySupplied: query.data.query !== undefined,
      },
      { correlationId: `discord-person-memory:recall:${idFactory()}` },
    );
    return context.json({
      schemaVersion: 1,
      subject: identity.data,
      facts,
      ...(recallCard === undefined ? {} : { recallCard }),
    });
  });

  app.post("/v1/memory/captain-episodes", async (context) => {
    if (!dependencies.memoryStore || !dependencies.eventStore) {
      return context.json({ error: "memory_store_unavailable" }, 503);
    }
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "episode_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "episode_authentication_required" }, 401);
    const episode = CaptainEpisodeSchema.safeParse(await readJson(context.req.raw));
    if (!episode.success) return context.json({ error: "invalid_captain_episode" }, 400);
    const recorded = dependencies.memoryStore.recordEpisode(episode.data);
    await recordEvent(
      "captain.episode.recorded",
      CAPTAIN_EPISODE_MISSION_ID,
      clock().toISOString(),
      {
        lane: recorded.lane,
        visibility: recorded.visibility,
        // The summary itself is deliberately absent: the event log is a
        // different retention regime than the bounded episode ring.
        summaryLength: recorded.summary.length,
      },
      { correlationId: `captain-episode:record:${idFactory()}` },
    );
    return context.json({ schemaVersion: 1, episodeId: recorded.episodeId });
  });

  /**
   * Recall is scoped by the lane the *caller declares*, and that is deliberate:
   * inside captain-eve a Discord turn and an operator turn authenticate with the
   * same process credential, so the server cannot derive the lane from the
   * bearer. The fence that matters is upstream — the lane is read from the eve
   * channel the control plane itself stamped, in an instruction hook the model
   * cannot reach, and never from a tool the model could aim at `operator`.
   */
  app.get("/v1/memory/captain-episodes", async (context) => {
    if (!dependencies.memoryStore) {
      return context.json({ error: "memory_store_unavailable" }, 503);
    }
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "episode_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "episode_authentication_required" }, 401);
    const lane = CaptainSessionLaneV2Schema.safeParse(context.req.query("lane"));
    if (!lane.success) return context.json({ error: "invalid_captain_episode_lane" }, 400);
    // A Discord-scoped bearer can never be in the operator lane, whatever it
    // asks for. This does not cover the in-process case above, but it does stop
    // a compromised bridge credential from reading operator-private episodes.
    const discordBearer =
      captain.steerSourceLane === "discord_text" || captain.steerSourceLane === "discord_voice";
    if (discordBearer && lane.data === "operator") {
      return context.json({ error: "operator_lane_recall_forbidden" }, 403);
    }
    return context.json({
      schemaVersion: 1,
      lane: lane.data,
      recallCard: dependencies.memoryStore.episodeRecallCard({ lane: lane.data }),
    });
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

  app.get("/v1/missions/active", async (context) => {
    const authorization = await authorizeMissionEventRead(context);
    if (authorization) return authorization;
    if (!missionEventFeed) return context.json({ error: "mission_event_feed_unavailable" }, 503);
    try {
      return context.json(await missionEventFeed.selection(), 200, { "cache-control": "no-store" });
    } catch (error) {
      logMissionEventFeedAuthorityFailure(error);
      return context.json({ error: "mission_event_feed_reconciliation_failed" }, 503, {
        "cache-control": "no-store",
      });
    }
  });

  app.get("/v1/missions/:id/events", async (context) => {
    const authorization = await authorizeMissionEventRead(context);
    if (authorization) return authorization;
    if (!missionEventFeed) return context.json({ error: "mission_event_feed_unavailable" }, 503);
    try {
      const outcome = await missionEventFeed.snapshot(context.req.param("id"));
      return context.json(outcome, outcome.outcome === "snapshot" ? 200 : 409, {
        "cache-control": "no-store",
      });
    } catch (error) {
      logMissionEventFeedAuthorityFailure(error, context.req.param("id"));
      return context.json({ error: "mission_event_feed_reconciliation_failed" }, 503, {
        "cache-control": "no-store",
      });
    }
  });

  app.get("/v1/missions/:id/events/tail", async (context) => {
    const authorization = await authorizeMissionEventRead(context);
    if (authorization) return authorization;
    if (!missionEventFeed) return context.json({ error: "mission_event_feed_unavailable" }, 503);
    const cursor = context.req.query("cursor");
    if (!cursor) return context.json({ error: "mission_event_cursor_required" }, 400);
    const abort = new AbortController();
    const requestAbort = () => abort.abort();
    context.req.raw.signal.addEventListener("abort", requestAbort, { once: true });
    let opened: MissionEventFeedTailRead;
    try {
      opened = await missionEventFeed.openTail(context.req.param("id"), cursor, abort.signal);
    } catch (error) {
      context.req.raw.signal.removeEventListener("abort", requestAbort);
      logMissionEventFeedAuthorityFailure(error, context.req.param("id"));
      return context.json({ error: "mission_event_feed_reconciliation_failed" }, 503, {
        "cache-control": "no-store",
      });
    }
    if (opened.outcome !== "tail") {
      context.req.raw.signal.removeEventListener("abort", requestAbort);
      return context.json(opened, 409, { "cache-control": "no-store" });
    }
    const iterator = opened.stream[Symbol.asyncIterator]();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) {
            context.req.raw.signal.removeEventListener("abort", requestAbort);
            controller.close();
            return;
          }
          const denial = await missionEventReadDenial(context);
          if (denial) {
            abort.abort();
            await iterator.return?.();
            if ("outcome" in denial.body) {
              const line = MissionEventTailAuthLineSchema.parse({
                schemaVersion: 1,
                type: "mission_event.auth_failed",
                failure: denial.body,
              });
              controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
              controller.close();
            } else {
              controller.error(new Error(denial.body.error));
            }
            return;
          }
          controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        context.req.raw.signal.removeEventListener("abort", requestAbort);
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

  app.get("/v1/missions/:id", (context) => {
    const mission = missions.get(context.req.param("id"));
    if (!mission) return context.json({ error: "mission_not_found" }, 404);
    const snapshot = engines.get(mission.id)?.getSnapshot();
    return context.json(snapshot ? liveMissionRecord(mission, snapshot) : mission);
  });

  app.post("/v1/embodiment/intents", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "captain_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    const parsed = EmbodimentIntentSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_embodiment_intent" }, 400);
    const result = await embodiment.submit(parsed.data);
    if (result.outcome === "refused") {
      logger.info(
        { intentId: parsed.data.intentId, reason: result.reason, sessionId: result.sessionId },
        "embodiment intent refused",
      );
    } else {
      logger.info(
        { intentId: parsed.data.intentId, sessionId: result.session.sessionId, kind: parsed.data.kind },
        "embodiment intent accepted",
      );
    }
    return context.json(result);
  });

  /**
   * Operator kill-switch for the live playthrough (asked play, ADR 0063). A
   * stuck game must be stoppable from the machine that runs it without going
   * through Discord: this submits an ordinary stop intent under the operator
   * lane, so the runner winds the session down at the next turn boundary and
   * mints its checkpoint exactly as an asked stop would — never a kill.
   */
  app.post("/v1/embodiment/sessions/live/stop", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable") {
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    }
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const live = embodiment.liveSession();
    if (live === undefined) return context.json({ error: "not_playing" }, 404);
    const result = await embodiment.submit({
      kind: "stop",
      schemaVersion: 1,
      intentId: `operator-stop-${idFactory()}`,
      originLane: "operator",
      requestedBy: operator.operatorId,
      requestedAt: clock().toISOString(),
      sessionId: live.sessionId,
    });
    logger.info(
      { sessionId: live.sessionId, operatorId: operator.operatorId, outcome: result.outcome },
      "operator embodiment stop submitted",
    );
    return context.json(result);
  });

  // Read by the captain tool and self-state, by the runner's startup
  // reconciliation — a dead runner's live session is only its own to disclaim —
  // and by the operator's `clankie play status`.
  app.get("/v1/embodiment/sessions/live", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain !== "unavailable" && captain) {
      return context.json({ session: embodiment.liveSession() ?? null });
    }
    const runner = await authenticateRunner(context.req.raw, dependencies);
    if (runner !== "unavailable" && runner) {
      return context.json({ session: embodiment.liveSession() ?? null });
    }
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator !== "unavailable" && operator) {
      return context.json({ session: embodiment.liveSession() ?? null });
    }
    if (captain === "unavailable" && runner === "unavailable" && operator === "unavailable") {
      return context.json({ error: "captain_authentication_unavailable" }, 503);
    }
    return context.json({ error: "captain_authentication_required" }, 401);
  });

  /**
   * Present-tense self-observation for the captain and authenticated operator.
   * The runner owns the latest snapshot; this route validates its identity
   * against the authoritative live embodiment session and never persists it.
   */
  app.get("/v1/embodiment/sessions/live/activity", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable" || !captain) {
      const operator = await authenticateOperator(context.req.raw, dependencies);
      if (operator === "unavailable") {
        if (captain === "unavailable") {
          return context.json({ error: "activity_observation_authentication_unavailable" }, 503);
        }
        return context.json({ error: "activity_observation_authentication_required" }, 401);
      }
      if (!operator) return context.json({ error: "activity_observation_authentication_required" }, 401);
    }

    const live = embodiment.liveSession();
    if (live === undefined) {
      return context.json(ActivityObservationReadSchema.parse({ schemaVersion: 1, outcome: "not_playing" }));
    }
    if (dependencies.activityObservations === undefined) {
      return context.json({ error: "activity_observation_unavailable" }, 503);
    }
    let snapshot;
    try {
      snapshot = await dependencies.activityObservations.current(context.req.raw.signal);
    } catch {
      return context.json({ error: "activity_observation_upstream_failure" }, 502);
    }
    if (snapshot === undefined) {
      return context.json(
        ActivityObservationReadSchema.parse({
          schemaVersion: 1,
          outcome: "pending",
          sessionId: live.sessionId,
          environmentId: live.environmentId,
          state: live.state,
          updatedAt: live.updatedAt,
        }),
      );
    }
    if (snapshot.sessionId !== live.sessionId || snapshot.environmentId !== live.environmentId) {
      return context.json({ error: "activity_observation_identity_mismatch" }, 502);
    }
    return context.json(
      ActivityObservationReadSchema.parse({ schemaVersion: 1, outcome: "snapshot", snapshot }),
    );
  });

  /**
   * What is running on this machine (ADR 0078). Readable by the captain or an
   * authenticated operator, because "which agents exist" is a question the
   * owner should never have to authorize. The control plane proxies the runner
   * and stores nothing: a cached census would be a second, staler authority.
   */
  app.get("/v1/agents/census", async (context) => {
    const authorization = await authenticateAgentCensusPrincipal(context);
    if ("denial" in authorization) return authorization.denial;
    if (dependencies.agentCensus === undefined) {
      return context.json({ error: "agent_census_unavailable" }, 503);
    }
    try {
      return context.json({ census: await dependencies.agentCensus.census(context.req.raw.signal) }, 200, {
        "cache-control": "no-store",
      });
    } catch {
      return context.json({ error: "agent_census_upstream_failure" }, 502);
    }
  });

  /**
   * Adoption (ADR 0078). `observed` grants knowledge only and needs no more
   * authority than reading the census does. `directed` grants steering and
   * reserves a workspace against new mission writers, so it is an operator
   * decision: a captain bearer alone is refused with `approval_required`.
   */
  app.post("/v1/agents/adopt", async (context) => {
    const authorization = await authenticateAgentCensusPrincipal(context);
    if ("denial" in authorization) return authorization.denial;
    if (dependencies.agentCensus === undefined) {
      return context.json({ error: "agent_census_unavailable" }, 503);
    }
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "invalid_adopt_request" }, 400);
    }
    const parsed = AdoptWorkerRequestSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: "invalid_adopt_request" }, 400);
    let principal = authorization.principal;
    let approval;
    if (parsed.data.grade === "directed") {
      const operator = await authenticateOperator(context.req.raw, dependencies);
      if (operator === "unavailable") {
        return context.json({ error: "agent_adoption_authentication_unavailable" }, 503);
      }
      if (!operator) {
        return context.json({ result: { outcome: "refused", reason: "approval_required" } }, 200);
      }
      principal = { kind: "operator", id: operator.operatorId };
      approval = {
        receiptId: `agent-adoption-approval:${idFactory()}`,
        approvedBy: principal,
        approvedAt: clock().toISOString(),
      };
    }
    try {
      return context.json(
        {
          result: await dependencies.agentCensus.adopt(
            {
              ...parsed.data,
              adoptedBy: principal,
              ...(approval === undefined ? {} : { approval }),
            },
            context.req.raw.signal,
          ),
        },
        200,
      );
    } catch {
      return context.json({ error: "agent_census_upstream_failure" }, 502);
    }
  });

  /**
   * Direct an adopted agent (ADR 0078). This is the operator-parity vocabulary
   * a human already has — bounded steering text — and it carries the same
   * authority ceiling: an instruction may arrive here, an approval may not.
   */
  app.post("/v1/agents/direct", async (context) => {
    const authorization = await authenticateAgentCensusPrincipal(context);
    if ("denial" in authorization) return authorization.denial;
    if (dependencies.agentCensus === undefined) {
      return context.json({ error: "agent_census_unavailable" }, 503);
    }
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "invalid_direct_request" }, 400);
    }
    const parsed = DirectAdoptedWorkerRequestSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: "invalid_direct_request" }, 400);
    try {
      return context.json(
        {
          result: await dependencies.agentCensus.direct(
            { ...parsed.data, directedBy: authorization.principal },
            context.req.raw.signal,
          ),
        },
        200,
      );
    } catch {
      return context.json({ error: "agent_census_upstream_failure" }, 502);
    }
  });

  /** Give an adopted agent back. Releasing is always allowed to the adopter's tier. */
  app.post("/v1/agents/release", async (context) => {
    const authorization = await authenticateAgentCensusPrincipal(context);
    if ("denial" in authorization) return authorization.denial;
    if (dependencies.agentCensus === undefined) {
      return context.json({ error: "agent_census_unavailable" }, 503);
    }
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "invalid_release_request" }, 400);
    }
    const parsed = ReleaseWorkerAdoptionRequestSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: "invalid_release_request" }, 400);
    try {
      await dependencies.agentCensus.release(
        { ...parsed.data, releasedBy: authorization.principal },
        context.req.raw.signal,
      );
      return context.json({ released: true }, 200);
    } catch {
      return context.json({ error: "agent_census_upstream_failure" }, 502);
    }
  });

  app.get("/v1/embodiment/sessions/:id", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "captain_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    const session = embodiment.getSession(context.req.param("id"));
    if (session === undefined) return context.json({ error: "embodiment_session_not_found" }, 404);
    return context.json({ session });
  });

  /**
   * Who holds Clankie's body right now (VUH-938). The embodiment registry only
   * knows sessions it minted; the body lock sees every suitor, including an
   * MCP possessor no session ever recorded (ADR 0053, ADR 0063). An unwired
   * observer reports nobody rather than failing: this surface exists so the
   * captain can say his body is busy, and it must never invent a holder.
   */
  app.get("/v1/embodiment/possession", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "captain_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    return context.json({
      schemaVersion: 1 as const,
      possession: dependencies.bodyPossession?.() ?? null,
    });
  });

  app.post("/v1/embodiment/claims", async (context) => {
    const runner = await authenticateRunner(context.req.raw, dependencies);
    if (runner === "unavailable") return context.json({ error: "runner_execution_unavailable" }, 503);
    if (!runner) return context.json({ error: "runner_authentication_required" }, 401);
    const parsed = EmbodimentClaimSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_embodiment_claim" }, 400);
    if (parsed.data.runnerId !== runner.runnerId) {
      return context.json({ error: "embodiment_claim_runner_mismatch" }, 403);
    }
    const assignment = await embodiment.claim(parsed.data);
    if (assignment === undefined) return context.body(null, 204);
    logger.info(
      {
        runnerId: runner.runnerId,
        kind: assignment.kind,
        sessionId: assignment.kind === "start" ? assignment.session.sessionId : assignment.sessionId,
      },
      "embodiment work claimed",
    );
    return context.json({ assignment });
  });

  app.post("/v1/embodiment/sessions/:id/report", async (context) => {
    const runner = await authenticateRunner(context.req.raw, dependencies);
    if (runner === "unavailable") return context.json({ error: "runner_execution_unavailable" }, 503);
    if (!runner) return context.json({ error: "runner_authentication_required" }, 401);
    const parsed = EmbodimentLifecycleReportSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_embodiment_report" }, 400);
    if (parsed.data.sessionId !== context.req.param("id")) {
      return context.json({ error: "embodiment_report_session_mismatch" }, 400);
    }
    if (parsed.data.runnerId !== runner.runnerId) {
      return context.json({ error: "embodiment_report_runner_mismatch" }, 403);
    }
    const result = await embodiment.report(parsed.data);
    if (result.outcome === "rejected") {
      const status =
        result.error === "unknown_session" ? 404 : result.error === "runner_mismatch" ? 403 : 409;
      return context.json({ error: `embodiment_${result.error}` }, status);
    }
    return context.json({ accepted: true, session: result.session });
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
          parsed.data.reservations as WorkerScopeReservation[],
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
          task.state === "succeeded" &&
          entry.engine.getSnapshot().state !== "succeeded" &&
          entry.engine.isReadyForCompletion()
        ) {
          entry.engine.completeMission(
            "Every planned task and required deterministic verification succeeded.",
          );
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
        if (approval.resource.type === "discord-person-memory-proposal") {
          const proposal = [...discordPersonMemoryProposals.values()].find(
            (candidate) => candidate.approvalRequestId === approval.id,
          );
          if (!proposal) {
            throw new Error(`Discord person-memory approval ${approval.id} has no durable proposal`);
          }
          await recordEvent(
            status === "approved"
              ? "discord.person-memory.proposal.approved"
              : "discord.person-memory.proposal.denied",
            proposal.eventMissionId,
            decidedAt,
            {
              proposalId: proposal.proposalId,
              approvalRequestId: approval.id,
              reason: approval.reason,
              source: "operator",
            },
            { correlationId: proposal.fact.provenance.correlationId },
          );
          if (status === "approved") {
            await commitApprovedDiscordPersonMemoryProposal(proposal, approval);
          }
        } else {
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
    const higherAuthority = await authenticateSteerPrincipal(context.req.raw, dependencies);
    let authority: { principal: WorkerSteerPrincipal; sourceLane: WorkerSteerSourceLane };
    if (higherAuthority && higherAuthority !== "unavailable") {
      authority = higherAuthority;
    } else {
      // Device tokens carry identity only. Authentication re-reads the durable
      // device projection so revocation and grant changes take effect now,
      // before request parsing, policy evaluation, or command persistence.
      const device = await authenticateDevice(context.req.raw);
      if (device === "unavailable") {
        return higherAuthority === "unavailable"
          ? context.json({ error: "steer_control_unavailable" }, 503)
          : context.json({ error: "steer_control_authority_required" }, 401);
      }
      if ("denied" in device) {
        const error =
          device.denied === "expired"
            ? "steer_device_session_expired"
            : device.denied === "revoked"
              ? "steer_device_revoked"
              : "steer_device_session_invalid";
        return context.json({ error }, 401);
      }
      if (!device.grants.steer) {
        return context.json({ error: "steer_device_grant_required" }, 403);
      }
      authority = {
        principal: { kind: "device", id: device.deviceId },
        sourceLane: "api",
      };
    }
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
    const runnerId = active.runtime.runnerId;
    const leaseExpiresAt = active.runtime.leaseExpiresAt;
    const attempt = active.runtime.attempts;
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
    const decideAndPersist = async () => {
      // Device revocation and the final authority check share the same lock.
      // Therefore either this command commits before revoke returns, or the
      // re-read observes the revoked/reduced projection and fails closed.
      if (authority.principal.kind === "device") {
        const currentDevice = await authenticateDevice(context.req.raw);
        if (currentDevice === "unavailable") {
          return context.json({ error: "steer_control_unavailable" }, 503);
        }
        if ("denied" in currentDevice || currentDevice.deviceId !== authority.principal.id) {
          const error =
            "denied" in currentDevice && currentDevice.denied === "expired"
              ? "steer_device_session_expired"
              : "denied" in currentDevice && currentDevice.denied === "revoked"
                ? "steer_device_revoked"
                : "steer_device_session_invalid";
          return context.json({ error }, 401);
        }
        if (!currentDevice.grants.steer) {
          return context.json({ error: "steer_device_grant_required" }, 403);
        }
      }

      const previous = await steeringStore.get(parsed.data.commandId);
      if (previous) {
        if (
          !authorization.allowed ||
          !sameWorkerSteerEnvelope(previous, {
            workerRunId,
            attempt,
            runnerId,
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
        attempt,
        sourceLane: authority.sourceLane,
        intent: normalized.intent,
        principal: authority.principal,
        correlationId: parsed.data.correlationId,
        missionId: active.missionId,
        taskId: active.runtime.spec.id,
        profileHash: dependencies.doctrine.profileHash,
        input: normalized.input,
        runnerId,
        leaseExpiresAt,
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
    };

    const serializeCommand = () =>
      withSerializedLock(workerSteerCommandLocks, parsed.data.commandId, decideAndPersist);
    return authority.principal.kind === "device"
      ? withSerializedLock(deviceLocks, authority.principal.id, serializeCommand)
      : serializeCommand();
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
            const denial = await transcriptReadDenial(context);
            if (denial) {
              abort.abort();
              await iterator.return?.();
              if ("outcome" in denial.body) {
                controller.enqueue(new TextEncoder().encode(`${JSON.stringify(denial.body)}\n`));
                controller.close();
              } else {
                controller.error(new Error(denial.body.error));
              }
              return;
            }
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
      principal: WorkerSteerPrincipal;
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
 * Admit general task graphs whose writing work is covered by downstream
 * verification. Task-scoped candidates and deterministic dependency merges
 * make graph shape a scheduler concern rather than a frozen executor special
 * case (ADR 0041).
 */
function assertSupportedPullPlan(plan: MissionPlan): void {
  assertValidMissionPlan(plan);
  const taskById = new Map(plan.tasks.map((task) => [task.id, task]));
  for (const task of plan.tasks) {
    if ((task.kind === "implementation" || task.kind === "integration") && task.role !== "implementer") {
      throw new Error(`Task "${task.id}" must use the implementer role for ${task.kind} work`);
    }
    if (
      task.kind === "debugging" &&
      !task.dependsOn.some((dependencyId) => taskById.get(dependencyId)?.kind === "verification")
    ) {
      throw new Error(
        `Debugging task "${task.id}" must directly depend on the verification failure it repairs`,
      );
    }
    if (!pullTaskWritesCandidate(task)) continue;
    const pending = plan.tasks
      .filter((candidate) => candidate.dependsOn.includes(task.id))
      .map((candidate) => candidate.id);
    const visited = new Set<string>();
    let covered = false;
    while (pending.length > 0) {
      const descendantId = pending.pop();
      if (!descendantId || visited.has(descendantId)) continue;
      visited.add(descendantId);
      const descendant = taskById.get(descendantId);
      if (descendant?.kind === "verification") {
        covered = true;
        break;
      }
      pending.push(
        ...plan.tasks
          .filter((candidate) => candidate.dependsOn.includes(descendantId))
          .map((candidate) => candidate.id),
      );
    }
    if (!covered) {
      throw new Error(`Writing task "${task.id}" must have a downstream independent verification task`);
    }
  }
}

function pullTaskWritesCandidate(task: TaskSpec): boolean {
  return (
    task.writeScope.length > 0 ||
    task.role === "implementer" ||
    task.role === "debugger" ||
    task.kind === "implementation" ||
    task.kind === "debugging" ||
    task.kind === "integration"
  );
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

function applyDiscordPersonMemoryEvent(
  proposals: Map<string, StoredDiscordPersonMemoryProposal>,
  committed: Set<string>,
  event: DomainEvent,
): void {
  if (event.type === "discord.person-memory.proposal.submitted") {
    const proposal = z
      .object({
        proposalId: z.string().min(1),
        approvalRequestId: z.string().min(1),
        fact: DiscordPersonMemoryFactSchema,
        submittedAt: z.string().datetime(),
        eventMissionId: z.string().min(1),
        principal: z.object({ kind: z.literal("captain"), id: z.string().min(1) }),
      })
      .parse(event.data.proposal);
    proposals.set(proposal.proposalId, proposal);
    return;
  }
  if (event.type === "discord.person-memory.proposal.committed") {
    committed.add(z.string().min(1).parse(event.data.proposalId));
  }
}

/**
 * Keep whole lines while the budget lasts. Every voice-briefing projection
 * lists newest content first, so the lines this drops are the oldest.
 */
function boundVoiceBriefingText(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text;
  const kept: string[] = [];
  let length = 0;
  for (const line of text.split("\n")) {
    const next = length === 0 ? line.length : length + 1 + line.length;
    if (next > maxCharacters) break;
    kept.push(line);
    length = next;
  }
  return kept.length === 0 ? text.slice(0, maxCharacters) : kept.join("\n");
}

/**
 * Cross-lane self-state from the control plane's own stores (ADR 0054): the
 * captain presence lease and the durable Discord presence projection. His own
 * whereabouts, never another room's contents — no session ids, no transcripts.
 */
function renderVoiceBriefingSelfState(
  lease: CaptainPresenceLease | undefined,
  sessions: readonly DiscordPresenceSessionRecord[],
): string {
  const lines = [
    "# Your own status",
    "Your presence across surfaces, from the control plane's own records — never from anything said in the room.",
  ];
  if (lease === undefined) lines.push("- Captain: not currently reporting presence.");
  else if (lease.state === "live") lines.push(`- Captain: live, last heartbeat ${lease.heartbeatAt}.`);
  else lines.push(`- Captain: offline, last heartbeat ${lease.heartbeatAt}.`);
  for (const session of sessions) {
    const voice =
      session.voiceGuildIds.length > 0 ? `, voice active in guild ${session.voiceGuildIds.join(", ")}` : "";
    lines.push(
      `- Discord ${session.transportKind} presence: ${session.phase}${voice} (updated ${session.updatedAt}).`,
    );
  }
  return lines.join("\n");
}

/** Human names for the environments a body can occupy, for the room's benefit. */
const EMBODIMENT_ENVIRONMENT_NAMES: Record<EmbodimentEnvironmentId, string> = {
  "pokemon-firered": "Pokémon FireRed on a Game Boy Advance emulator",
};

/**
 * What his body is doing right now.
 *
 * The play loop reports events into the voice conversation as they happen, and
 * a persona with no idea it is mid-playthrough has nothing to hang them on —
 * which is how a report of one game event became a 39-second invention on
 * 2026-08-02. This card is the frame of reference those reports land against.
 *
 * Only live sessions render: a finished playthrough is history, and history
 * belongs to the episode card, not to "right now".
 */
function renderVoiceBriefingEmbodiment(session: EmbodimentSession | undefined): string | undefined {
  if (session === undefined) return undefined;
  if (session.state !== "running" && session.state !== "stopping") return undefined;
  const name = EMBODIMENT_ENVIRONMENT_NAMES[session.environmentId];
  return [
    "# What you are doing right now",
    `You are playing ${name}. This is really happening — you are at the controls as you speak, and`,
    "the people in this room can watch the screen live on the Discord activity surface.",
    'Reports of what you just did arrive as text items beginning "While playing, Clankie just:".',
    "They are notes about your own play, not something anyone said to you — react the way a person",
    "half-narrating their own game would, or let one pass without comment. Never read one aloud.",
  ].join("\n");
}

/**
 * One consented speaker's approved memory, rendered like the recall card the
 * captain lane already receives. A speaker with no visible approved facts
 * contributes nothing — not even a header naming them.
 */
function renderVoiceBriefingPersonMemory(
  userId: string,
  facts: readonly DiscordPersonMemoryFact[],
): string | undefined {
  if (facts.length === 0) return undefined;
  const lines = [`## What you know about user ${userId}`];
  for (const fact of facts.slice(0, DISCORD_VOICE_BRIEFING_MAX_FACTS_PER_PERSON)) {
    lines.push(`- ${fact.kind} (${fact.confidence.toFixed(2)}): ${fact.body}`);
  }
  return lines.join("\n");
}

/** Episodes are the captain's own, not any one mission's, so they share one stream. */
const CAPTAIN_EPISODE_MISSION_ID = "captain:episodes";

function discordPersonMemoryEventMissionId(identity: DiscordPersonIdentity): string {
  const subject = DiscordPersonIdentitySchema.parse(identity);
  return `discord-person:${subject.guildId}:${subject.userId}`;
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
