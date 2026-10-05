import { z } from "zod";

const id = z.string().trim().min(1).max(128);
const timestamp = z.number().int().nonnegative();
const player = z.string().min(1).max(64);
const item = z.string().regex(/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]{1,128}$/u);
const count = z.number().int().nonnegative().max(1_000_000);

/** Owner-configured reference only; endpoints and account material stay outside this boundary. */
export const MinecraftServerProfileIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u);
export type MinecraftServerProfileId = z.infer<typeof MinecraftServerProfileIdSchema>;
export const MinecraftServerProfileSchema = z.strictObject({
  id: MinecraftServerProfileIdSchema,
  name: z.string().trim().min(1).max(128),
});
export type MinecraftServerProfile = z.infer<typeof MinecraftServerProfileSchema>;

/** Owner-configured play mind and per-session ceilings; no connection or driver authority. */
export const MinecraftPlaySettingsSchema = z.strictObject({
  enabled: z.boolean().default(true),
  model: z
    .string()
    .trim()
    .min(3)
    .max(256)
    .regex(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.:/-]+$/u, "Expected providerId/modelId")
    .default("openai/gpt-4.1-mini"),
  maxTokens: z.number().int().min(1_000).max(10_000_000).default(100_000),
  maxCostUsd: z.number().positive().max(100).default(1),
  turnIntervalMs: z.number().int().min(100).max(60_000).default(2_000),
  idleBackoffMs: z.number().int().min(100).max(300_000).default(15_000),
  idleStopMs: z.number().int().min(1_000).max(3_600_000).default(900_000),
});
export type MinecraftPlaySettings = z.infer<typeof MinecraftPlaySettingsSchema>;

/** A reconnect creates a new generation, even when the logical session is retained. */
export const MinecraftSessionRefSchema = z.strictObject({
  /** Host-allocated unique logical session identity, never reused for another play session. */
  sessionId: id,
  connectionGeneration: z.number().int().positive(),
});
export type MinecraftSessionRef = z.infer<typeof MinecraftSessionRefSchema>;
export const MinecraftActionIdSchema = id;
export type MinecraftActionId = z.infer<typeof MinecraftActionIdSchema>;

export const MinecraftPhaseSchema = z.enum([
  "connecting",
  "active",
  "pausing",
  "paused",
  "stopping",
  "uncertain",
  "disconnected",
]);
export type MinecraftPhase = z.infer<typeof MinecraftPhaseSchema>;

export const MinecraftTerminationSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("not_requested") }),
  z.strictObject({ state: z.literal("pending"), requestedAt: timestamp }),
  z.strictObject({
    state: z.literal("uncertain"),
    requestedAt: timestamp,
    code: z.enum(["timeout", "connection_lost", "adapter_lost"]),
  }),
  z.strictObject({
    state: z.literal("confirmed"),
    confirmedAt: timestamp,
    /** An exact connection's end, external reconciliation, or proof it never connected. */
    source: z.enum(["connection_end", "server_observer", "not_connected"]),
  }),
]);
export type MinecraftTermination = z.infer<typeof MinecraftTerminationSchema>;

export const MinecraftSessionStatusSchema = z
  .strictObject({
    session: MinecraftSessionRefSchema,
    profileId: MinecraftServerProfileIdSchema,
    phase: MinecraftPhaseSchema,
    termination: MinecraftTerminationSchema,
  })
  .superRefine((value, context) => {
    const expected =
      value.phase === "disconnected"
        ? "confirmed"
        : value.phase === "uncertain"
          ? "uncertain"
          : value.phase === "stopping"
            ? "pending"
            : "not_requested";
    if (value.termination.state !== expected) {
      context.addIssue({
        code: "custom",
        path: ["termination"],
        message: `${value.phase} requires ${expected} termination`,
      });
    }
  });
export type MinecraftSessionStatus = z.infer<typeof MinecraftSessionStatusSchema>;

export const MinecraftJoinRequestSchema = z.strictObject({
  profileId: MinecraftServerProfileIdSchema,
  /** Persist this identity before dispatching join; no model-supplied host or auth options. */
  session: MinecraftSessionRefSchema,
});
export type MinecraftJoinRequest = z.infer<typeof MinecraftJoinRequestSchema>;

export const MinecraftPositionSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});
export type MinecraftPosition = z.infer<typeof MinecraftPositionSchema>;
export const MinecraftBlockPositionSchema = z.strictObject({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
});
const placement = z.strictObject({ position: MinecraftBlockPositionSchema, item });

export const MinecraftActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("chat"), text: z.string().min(1).max(256) }),
  z.strictObject({
    type: z.literal("goto"),
    position: MinecraftPositionSchema,
    tolerance: z.number().nonnegative().max(64),
  }),
  z.strictObject({ type: z.literal("follow"), player, distance: z.number().positive().max(64) }),
  z.strictObject({ type: z.literal("dig"), position: MinecraftBlockPositionSchema }),
  z.strictObject({ type: z.literal("craft"), item, count: count.refine((value) => value > 0) }),
  z.strictObject({ type: z.literal("place"), ...placement.shape }),
  z.strictObject({ type: z.literal("build"), placements: z.array(placement).min(1).max(64) }),
]);
export type MinecraftAction = z.infer<typeof MinecraftActionSchema>;
export const MinecraftActionRequestSchema = z.strictObject({
  session: MinecraftSessionRefSchema,
  actionId: MinecraftActionIdSchema,
  action: MinecraftActionSchema,
});
export type MinecraftActionRequest = z.infer<typeof MinecraftActionRequestSchema>;

/** World content, including chat, is observation data and never grants authority. */
export const MinecraftFactSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("position"), player, position: MinecraftPositionSchema }),
  z.strictObject({ type: z.literal("block"), position: MinecraftBlockPositionSchema, block: item }),
  z.strictObject({ type: z.literal("inventory"), item, count }),
  z.strictObject({ type: z.literal("chat"), player, text: z.string().max(256) }),
  z.strictObject({
    type: z.literal("health"),
    player,
    health: z.number().nonnegative().max(1024),
    food: z.number().nonnegative().max(1024),
  }),
]);
export type MinecraftFact = z.infer<typeof MinecraftFactSchema>;
export const MinecraftObservationSchema = z.strictObject({
  session: MinecraftSessionRefSchema,
  observedAt: timestamp,
  facts: z
    .array(
      z.strictObject({
        source: z.enum(["server_packet", "server_observer", "bot_cache", "adapter_report"]),
        observedAt: timestamp,
        fact: MinecraftFactSchema,
      }),
    )
    .max(256),
});
export type MinecraftObservation = z.infer<typeof MinecraftObservationSchema>;

/** Exact requested postconditions and actual observations, rather than any nearby world change. */
export const MinecraftEffectCheckSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("block"),
    position: MinecraftBlockPositionSchema,
    expected: item,
    observed: item,
  }),
  z.strictObject({ type: z.literal("inventory"), item, expected: count, observed: count }),
  z.strictObject({
    type: z.literal("position"),
    player,
    expected: MinecraftPositionSchema,
    observed: MinecraftPositionSchema,
    tolerance: z.number().nonnegative().max(64),
  }),
  z.strictObject({
    type: z.literal("chat"),
    player,
    expected: z.string().max(256),
    observed: z.string().max(256),
  }),
]);
export type MinecraftEffectCheck = z.infer<typeof MinecraftEffectCheckSchema>;

function effectMatches(check: MinecraftEffectCheck): boolean {
  if (check.type !== "position") return check.expected === check.observed;
  return (
    Math.hypot(
      check.expected.x - check.observed.x,
      check.expected.y - check.observed.y,
      check.expected.z - check.observed.z,
    ) <= check.tolerance
  );
}

const verifiedObservation = {
  /** Inbound authoritative packets or independent server observations, never optimistic cache updates. */
  source: z.enum(["server_packet", "server_observer"]),
  observedAt: timestamp,
  checks: z.array(MinecraftEffectCheckSchema).min(1).max(64),
};
export const MinecraftEffectEvidenceSchema = z
  .discriminatedUnion("outcome", [
    z.strictObject({
      outcome: z.literal("unknown"),
      reason: z.enum([
        "not_observed",
        "local_report_only",
        "optimistic_cache",
        "stale_observation",
        "interrupted",
        "connection_lost",
      ]),
    }),
    z.strictObject({ outcome: z.literal("verified"), ...verifiedObservation }),
    z.strictObject({ outcome: z.literal("refuted"), ...verifiedObservation }),
  ])
  .superRefine((value, context) => {
    if (value.outcome === "unknown") return;
    const matches = value.checks.every(effectMatches);
    if ((value.outcome === "verified") !== matches) {
      context.addIssue({
        code: "custom",
        path: ["checks"],
        message: "Evidence outcome must agree with the exact postcondition checks",
      });
    }
  });
export type MinecraftEffectEvidence = z.infer<typeof MinecraftEffectEvidenceSchema>;

/** Adapter settlement and world-effect verification are independent; completed is not success. */
export const MinecraftActionStateSchema = z.enum([
  "running",
  "cancel_requested",
  "completed",
  "cancelled",
  "failed",
  "uncertain",
]);
export type MinecraftActionState = z.infer<typeof MinecraftActionStateSchema>;
export const MinecraftActionStatusSchema = z
  .strictObject({
    session: MinecraftSessionRefSchema,
    actionId: MinecraftActionIdSchema,
    requested: MinecraftActionSchema,
    state: MinecraftActionStateSchema,
    requestedAt: timestamp,
    updatedAt: timestamp,
    /** The producer derives checks from this exact request and authenticates their world provenance. */
    evidence: MinecraftEffectEvidenceSchema,
  })
  .superRefine((value, context) => {
    if (value.updatedAt < value.requestedAt) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "Action updates cannot precede the request",
      });
    }
    if (
      value.evidence.outcome !== "unknown" &&
      (value.evidence.observedAt < value.requestedAt || value.evidence.observedAt > value.updatedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidence", "observedAt"],
        message: "Effect evidence must be observed between request and update",
      });
    }
  });
export type MinecraftActionStatus = z.infer<typeof MinecraftActionStatusSchema>;
/** Bounded action history for the current connection only, not a cross-session audit log. */
export const MinecraftStatusSchema = z
  .strictObject({
    session: MinecraftSessionStatusSchema.nullable(),
    actions: z.array(MinecraftActionStatusSchema).max(64),
  })
  .superRefine((value, context) => {
    for (const [index, action] of value.actions.entries()) {
      if (
        value.session === null ||
        action.session.sessionId !== value.session.session.sessionId ||
        action.session.connectionGeneration !== value.session.session.connectionGeneration
      ) {
        context.addIssue({
          code: "custom",
          path: ["actions", index, "session"],
          message: "Action history belongs to the current connection",
        });
      }
    }
  });
export type MinecraftStatus = z.infer<typeof MinecraftStatusSchema>;

/** Operator and captain commands share profile references; only owner settings contain endpoints. */
export const MinecraftCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("driver"),
    driver: z
      .discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("mind") }),
        z.strictObject({ kind: z.literal("owner") }),
        z.strictObject({ kind: z.literal("worker"), principalId: z.string().min(1).max(256) }),
      ])
      .optional(),
  }),
  z.strictObject({ action: z.literal("status") }),
  z.strictObject({ action: z.literal("profiles") }),
  z.strictObject({ action: z.literal("join"), profileId: MinecraftServerProfileIdSchema }),
  z.strictObject({ action: z.literal("observe") }),
  z.strictObject({ action: z.literal("pause") }),
  z.strictObject({ action: z.literal("resume") }),
  z.strictObject({ action: z.literal("leave") }),
  z.strictObject({ action: z.literal("cancel"), actionId: MinecraftActionIdSchema.optional() }),
  z.strictObject({ action: z.literal("action_status"), actionId: MinecraftActionIdSchema }),
  z.strictObject({
    action: z.literal("act"),
    request: MinecraftActionSchema,
    actionId: MinecraftActionIdSchema.optional(),
  }),
]);
export type MinecraftCommand = z.infer<typeof MinecraftCommandSchema>;
