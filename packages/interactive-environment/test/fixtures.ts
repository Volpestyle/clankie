import type { EnvironmentActionResult, EnvironmentLease } from "../src/index.ts";

const resultBase = {
  schemaVersion: 1 as const,
  actionId: "environment-action-1",
  sessionId: "environment-session-1",
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
  sessionId: "environment-session-1",
  holderId: "runner-1",
  missionId: "environment-mission",
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
    capabilities: ["environment.test"],
  },
};
