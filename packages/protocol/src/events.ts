import { z } from "zod";
import {
  CaptainLaneCompatibilitySchema,
  CharacterIdSchema,
  WorldIdSchema,
  EnvironmentSessionIdSchema,
  MissionIdSchema,
  TaskIdSchema,
  WorkerRunIdSchema,
} from "./captain-lanes.ts";

export const CommandAuthoritySchema = z.object({
  principal: z.object({
    kind: z.enum(["captain", "human", "system"]),
    id: z.string().min(1),
  }),
  tier: z.enum(["authenticated", "ambient", "autonomous", "system"]),
});
export type CommandAuthority = z.infer<typeof CommandAuthoritySchema>;

export const IntentContextSchema = z
  .object({
    sourceLane: CaptainLaneCompatibilitySchema,
    authority: CommandAuthoritySchema,
    correlationId: z.string().min(1),
    causationId: z.string().min(1).optional(),
    expectedGoalVersion: z.number().int().nonnegative(),
  })
  .superRefine((context, refinement) => {
    const { kind } = context.authority.principal;
    const { tier } = context.authority;
    if (kind === "system" && tier === "system") return;
    const expectedTier = {
      tui: "authenticated",
      discord_voice: "ambient",
      discord_presence: "ambient",
      gameplay: "autonomous",
    }[context.sourceLane];
    if (tier !== expectedTier) {
      refinement.addIssue({
        code: "custom",
        path: ["authority", "tier"],
        message: `${context.sourceLane} commands require ${expectedTier} authority`,
      });
    }
  });
export type IntentContext = z.infer<typeof IntentContextSchema>;

export const InteractiveEnvironmentBindingSchema = z.object({
  schemaVersion: z.literal(1),
  environmentKind: z.string().min(1),
  characterId: CharacterIdSchema,
  worldId: WorldIdSchema,
  lane: z.literal("gameplay"),
  environmentSessionId: EnvironmentSessionIdSchema.optional(),
});
export type InteractiveEnvironmentBinding = z.infer<typeof InteractiveEnvironmentBindingSchema>;

// ---------------------------------------------------------------------------
// Event stream identity.
//
// `missionId` is the append-only log's partition key — it is what
// `ProjectionEventStore.readStream` reads and what optimistic concurrency
// counts. The field name is frozen from the mission-era envelope; writers
// mint a namespaced stream id into that slot (presence, embodiment, devices,
// triggers, episodes). `streamKind` is what that partition *is*, so a reader
// never has to infer meaning from the shape of an id.
// ---------------------------------------------------------------------------

export const EVENT_STREAM_KINDS = [
  "mission",
  "captain_presence",
  "captain_episodes",
  "captain_project",
  "discord_presence",
  "discord_user_session",
  "embodiment",
  "person_memory",
  "memory_retention",
  "trigger",
  "pairing",
  "device",
  "character",
  "adoption",
  "diagnostic",
] as const;
export const EventStreamKindSchema = z.enum(EVENT_STREAM_KINDS);
export type EventStreamKind = z.infer<typeof EventStreamKindSchema>;

/**
 * Reserved stream namespaces. A writer picks its namespace here and gets the
 * matching `streamKind` stamped automatically; a reader of a pre-`streamKind`
 * event recovers the same answer. Entries are matched longest-prefix-first, so
 * an exact id and a prefix may coexist. Mission ids must never collide with a
 * reserved namespace — see ADR 0065.
 */
const RESERVED_EVENT_STREAM_NAMESPACES: readonly {
  readonly match: string;
  readonly exact: boolean;
  readonly kind: EventStreamKind;
}[] = [
  { match: "captain-presence", exact: true, kind: "captain_presence" },
  { match: "captain:episodes", exact: true, kind: "captain_episodes" },
  { match: "captain-project:", exact: false, kind: "captain_project" },
  { match: "discord-presence:", exact: false, kind: "discord_presence" },
  { match: "discord-user-session:", exact: false, kind: "discord_user_session" },
  { match: "discord-person:", exact: false, kind: "person_memory" },
  { match: "embodiment:", exact: false, kind: "embodiment" },
  { match: "memory:retention", exact: true, kind: "memory_retention" },
  { match: "trigger:", exact: false, kind: "trigger" },
  { match: "pairing:", exact: false, kind: "pairing" },
  { match: "device:", exact: false, kind: "device" },
  { match: "character:", exact: false, kind: "character" },
  // An adoption has no mission of its own (ADR 0078): the agent existed before
  // any mission wanted it, and may outlive the one that borrows it.
  { match: "adoption:", exact: false, kind: "adoption" },
  { match: "provider-readiness", exact: true, kind: "diagnostic" },
  { match: "media-readiness", exact: true, kind: "diagnostic" },
];

/**
 * The kind a stream id declares by its namespace. Writers call this so the kind
 * is stamped once, at append time, rather than re-derived by every reader.
 */
export function eventStreamKindForId(streamId: string): EventStreamKind {
  for (const entry of RESERVED_EVENT_STREAM_NAMESPACES) {
    if (entry.exact ? streamId === entry.match : streamId.startsWith(entry.match)) return entry.kind;
  }
  return "mission";
}

export const EventBaseSchema = z.object({
  id: z.string().min(1),
  occurredAt: z.string().datetime(),
  missionId: MissionIdSchema,
  // Optional, never defaulted: `seal()` re-parses before hashing, so a default
  // would materialize a field absent from historical JSON and break
  // `verifyChain` on every event already on disk.
  streamKind: EventStreamKindSchema.optional(),
  taskId: TaskIdSchema.optional(),
  workerRunId: WorkerRunIdSchema.optional(),
  correlationId: z.string().min(1),
  causationId: z.string().min(1).optional(),
  profileHash: z.string().min(1),
});

export const DomainEventSchema = EventBaseSchema.extend({
  type: z.string().min(1),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type DomainEvent = z.infer<typeof DomainEventSchema>;

export const CAPTAIN_PRESENCE_SCHEMA_VERSION = 1 as const;
export const CAPTAIN_STATUS_SUBJECT_ID = "captain" as const;

const CaptainLeaseIdentitySchema = z
  .object({
    schemaVersion: z.literal(CAPTAIN_PRESENCE_SCHEMA_VERSION),
    subjectId: z.literal(CAPTAIN_STATUS_SUBJECT_ID),
    captainId: z.string().min(1),
    leaseId: z.string().min(1),
    generationId: z.string().min(1),
    heartbeatAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

export const CaptainPresenceOnlineDataSchema = CaptainLeaseIdentitySchema.extend({
  state: z.literal("idle"),
  tier: z.literal(1),
  source: z.literal("control-plane.captain_lease"),
  confidence: z.literal(1),
  observedAt: z.string().datetime(),
}).strict();
export type CaptainPresenceOnlineData = z.infer<typeof CaptainPresenceOnlineDataSchema>;

export const CaptainPresenceOfflineDataSchema = CaptainLeaseIdentitySchema.extend({
  state: z.literal("offline"),
  tier: z.literal(1),
  source: z.literal("control-plane.captain_lease"),
  confidence: z.literal(1),
  observedAt: z.string().datetime(),
  reason: z.enum(["lease_expired", "superseded"]),
}).strict();
export type CaptainPresenceOfflineData = z.infer<typeof CaptainPresenceOfflineDataSchema>;

export const CaptainHeartbeatDataSchema = CaptainLeaseIdentitySchema.extend({
  state: z.literal("idle"),
  tier: z.literal(1),
  source: z.literal("control-plane.captain_lease"),
  confidence: z.literal(1),
  observedAt: z.string().datetime(),
}).strict();
export type CaptainHeartbeatData = z.infer<typeof CaptainHeartbeatDataSchema>;

const CaptainTurnIdentitySchema = z
  .object({
    schemaVersion: z.literal(CAPTAIN_PRESENCE_SCHEMA_VERSION),
    subjectId: z.literal(CAPTAIN_STATUS_SUBJECT_ID),
    captainId: z.string().min(1),
    leaseId: z.string().min(1),
    generationId: z.string().min(1),
    sessionId: z.string().min(1),
    turnId: z.string().min(1),
    tier: z.literal(0),
    source: z.literal("eve.lifecycle"),
    confidence: z.literal(1),
    observedAt: z.string().datetime(),
  })
  .strict();

export const CaptainTurnStartedDataSchema = CaptainTurnIdentitySchema.extend({
  state: z.literal("working"),
}).strict();
export type CaptainTurnStartedData = z.infer<typeof CaptainTurnStartedDataSchema>;

export const CaptainTurnSettledDataSchema = z.discriminatedUnion("state", [
  CaptainTurnIdentitySchema.extend({ state: z.literal("idle") }).strict(),
  CaptainTurnIdentitySchema.extend({
    state: z.literal("waiting_user"),
    questionSummary: z.string().trim().min(1).max(512),
  }).strict(),
]);
export type CaptainTurnSettledData = z.infer<typeof CaptainTurnSettledDataSchema>;

export const CaptainWaitingDependencyDataSchema = CaptainTurnIdentitySchema.extend({
  state: z.literal("waiting_dependency"),
  summary: z.string().trim().min(1).max(512),
}).strict();
export type CaptainWaitingDependencyData = z.infer<typeof CaptainWaitingDependencyDataSchema>;

export const CaptainPresenceEventSchema = z.discriminatedUnion("type", [
  EventBaseSchema.extend({
    type: z.literal("captain.presence.online"),
    data: CaptainPresenceOnlineDataSchema,
  }),
  EventBaseSchema.extend({
    type: z.literal("captain.presence.offline"),
    data: CaptainPresenceOfflineDataSchema,
  }),
  EventBaseSchema.extend({ type: z.literal("captain.heartbeat"), data: CaptainHeartbeatDataSchema }),
  EventBaseSchema.extend({ type: z.literal("captain.turn.started"), data: CaptainTurnStartedDataSchema }),
  EventBaseSchema.extend({ type: z.literal("captain.turn.settled"), data: CaptainTurnSettledDataSchema }),
  EventBaseSchema.extend({
    type: z.literal("captain.waiting_dependency"),
    data: CaptainWaitingDependencyDataSchema,
  }),
]);
export type CaptainPresenceEvent = z.infer<typeof CaptainPresenceEventSchema>;

const CaptainPresenceReportBaseSchema = z
  .object({
    schemaVersion: z.literal(CAPTAIN_PRESENCE_SCHEMA_VERSION),
    eventId: z.string().min(1),
    leaseId: z.string().min(1),
    generationId: z.string().min(1),
    occurredAt: z.string().datetime(),
  })
  .strict();

const CaptainTurnReportBaseSchema = CaptainPresenceReportBaseSchema.extend({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
});

export const CaptainPresenceReportSchema = z.union([
  CaptainPresenceReportBaseSchema.extend({ type: z.literal("captain.heartbeat") }).strict(),
  CaptainTurnReportBaseSchema.extend({ type: z.literal("captain.turn.started") }).strict(),
  CaptainTurnReportBaseSchema.extend({
    type: z.literal("captain.turn.settled"),
    state: z.literal("idle"),
  }).strict(),
  CaptainTurnReportBaseSchema.extend({
    type: z.literal("captain.turn.settled"),
    state: z.literal("waiting_user"),
    questionSummary: z.string().trim().min(1).max(512),
  }).strict(),
  CaptainTurnReportBaseSchema.extend({
    type: z.literal("captain.waiting_dependency"),
    summary: z.string().trim().min(1).max(512),
  }).strict(),
]);
export type CaptainPresenceReport = z.infer<typeof CaptainPresenceReportSchema>;
