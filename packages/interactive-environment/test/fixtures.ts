import type { EnvironmentActionResult, EnvironmentCommand, EnvironmentLease } from "../src/index.ts";

export const baseContext = {
  sourceLane: "gameplay" as const,
  authority: {
    principal: { kind: "captain" as const, id: "clankie" },
    tier: "autonomous" as const,
  },
  correlationId: "corr-minecraft-1",
  expectedGoalVersion: 42,
};

export const validStartActionCommand: EnvironmentCommand = {
  schemaVersion: 1,
  commandId: "command-1",
  type: "start_action",
  context: baseContext,
  requestedAt: "2026-07-11T12:00:00.000Z",
  sessionId: "minecraft-session-1",
  actionId: "minecraft-action-1",
  action: { kind: "collect", block: "oak_log", count: 4 },
};

const resultBase = {
  schemaVersion: 1 as const,
  actionId: "minecraft-action-1",
  sessionId: "minecraft-session-1",
  updatedAt: "2026-07-11T12:00:01.000Z",
};

export const actionResultFixtures = {
  valid: { ...resultBase, status: "running", acceptedGoalVersion: 42 },
  stale: { ...resultBase, status: "stale", expectedGoalVersion: 41, currentGoalVersion: 42 },
  denied: {
    ...resultBase,
    status: "denied",
    requestedGoalVersion: 42,
    reason: "player combat is not granted",
    policyDecisionId: "policy-decision-1",
  },
  cancelled: {
    ...resultBase,
    status: "cancelled",
    acceptedGoalVersion: 42,
    reason: "superseded by authenticated TUI intent",
  },
  failed: {
    ...resultBase,
    status: "failed",
    acceptedGoalVersion: 42,
    errorCode: "path_not_found",
    message: "No bounded path reaches the target",
    retryable: true,
  },
} satisfies Record<string, EnvironmentActionResult>;

export const validEnvironmentLease: EnvironmentLease = {
  schemaVersion: 1,
  leaseId: "lease-1",
  sessionId: "minecraft-session-1",
  holderId: "runner-1",
  missionId: "minecraft-mission",
  taskId: "play-task",
  issuedAt: "2026-07-11T12:00:00.000Z",
  heartbeatAt: "2026-07-11T12:00:05.000Z",
  expiresAt: "2026-07-11T12:01:00.000Z",
  resourceBounds: {
    serverId: "private-paper",
    worldId: "private-paper-world",
    characterId: "clankie",
    allowedDimensions: ["overworld"],
    maxDistanceFromOrigin: 256,
    maxActionDurationMs: 60_000,
    maxBlockChangesPerAction: 16,
    capabilities: ["minecraft.world.observe", "minecraft.world.navigate"],
  },
};
