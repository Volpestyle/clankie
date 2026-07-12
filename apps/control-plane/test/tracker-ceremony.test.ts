import { compileDoctrine } from "@clankie/doctrine";
import { describe, expect, it } from "vitest";
import { InMemoryAttentionDeliveryStore, createTrackerCeremonyRuntime } from "../src/tracker-ceremony.ts";
import type { AttentionDeliveryAdapter, TrackerPolicyGateway } from "@clankie/tracker-connector";

function doctrine() {
  return compileDoctrine([
    {
      schemaVersion: "1",
      id: "cp-ceremony",
      description: "control-plane ceremony tests",
      ceremony: {
        externalConnectors: "optional",
        integrationFlow: "pull_request",
      },
      planning: {
        requirePlanApproval: true,
        scopeExpansion: "ask",
        targetReviewMinutes: 20,
        softChangedLines: 300,
        hardChangedLines: 800,
        maxLogicalConcernsPerPr: 1,
      },
      topology: {
        maxParallelWorkers: 2,
        maxDelegationDepth: 1,
        defaultExecution: "automatic",
        route: [],
      },
      verification: {
        independentVerifier: true,
        differentHarnessPreferred: true,
        requireEvidence: true,
        requiredChecks: ["typecheck"],
      },
      budgets: { maxMissionCostUsd: 10, maxTaskRetries: 1, maxMissionWallMinutes: 60 },
      authority: {},
      actions: {},
      memory: {
        rawTranscriptRetentionDays: 7,
        inferredFacts: "require_approval",
        publicToPrivatePropagation: false,
      },
    },
  ]);
}

describe("control-plane tracker ceremony runtime", () => {
  it("validates issue drafts against the compiled projection", () => {
    const runtime = createTrackerCeremonyRuntime({
      doctrine: doctrine(),
      policy: { authorize: async () => ({ effect: "allow", reason: "ok" }) },
      adapter: { attempt: async () => ({ ok: true }) },
      store: new InMemoryAttentionDeliveryStore(),
    });
    const ok = runtime.validateDraft({
      draft: {
        schemaVersion: 1,
        draftId: "d1",
        missionId: "m1",
        correlationId: "c1",
        title: "Title",
        objective: "Objective text",
        productImpact: {
          schemaVersion: 1,
          summary: "Users get clearer impact.",
          userVisibleChange: true,
          risk: "low",
          authorityImpact: "none",
        },
        acceptanceCriteria: ["Impact is present."],
        writeScope: [],
        createdAt: "2026-07-12T12:00:00.000Z",
      },
    });
    expect(ok.ok).toBe(true);
  });

  it("correlates agent-session prompted events and rejects ordinary comment shapes", async () => {
    const allow: TrackerPolicyGateway = {
      authorize: async () => ({ effect: "allow", reason: "ok" }),
    };
    const adapter: AttentionDeliveryAdapter = {
      attempt: async () => ({ ok: true }),
    };
    const runtime = createTrackerCeremonyRuntime({
      doctrine: doctrine(),
      policy: allow,
      adapter,
      store: new InMemoryAttentionDeliveryStore(),
      clock: () => new Date("2026-07-12T15:00:00.000Z"),
    });

    const pendingRequest = {
      schemaVersion: 1,
      requestId: "attn-cp-1",
      missionId: "mission-cp",
      correlationId: "corr-cp",
      targetRole: "operator",
      requestKind: "decision_needed",
      actionableAsk: "Please decide.",
      blocking: true,
      authorityImpact: "narrow",
      urgency: "blocking",
      notificationSurfaces: ["operator_inbox"],
      createdAt: "2026-07-12T14:00:00.000Z",
    };

    const correlated = runtime.correlate({
      pending: {
        request: pendingRequest,
        workspaceId: "ws-1",
        issueId: "issue-9",
        agentSessionId: "sess-9",
      },
      event: {
        id: "e1",
        occurredAt: "2026-07-12T15:00:00.000Z",
        missionId: "mission-cp",
        correlationId: "corr-cp",
        profileHash: "h",
        type: "tracker.agent-session.prompted",
        data: {
          issue: { id: "issue-9" },
          session: { id: "sess-9" },
          appActor: { id: "app" },
          actor: { id: "human" },
        },
      },
      responseId: "resp-1",
      actorRole: "operator",
      decision: "approve",
      rationale: "Looks good.",
    });
    expect(correlated).toMatchObject({ requestId: "attn-cp-1", decision: "approve" });

    const rejected = runtime.correlate({
      pending: {
        request: pendingRequest,
        workspaceId: "ws-1",
        issueId: "issue-9",
      },
      event: {
        id: "e2",
        occurredAt: "2026-07-12T15:00:00.000Z",
        missionId: "mission-cp",
        correlationId: "corr-cp",
        profileHash: "h",
        type: "tracker.comment.observed",
        data: { issueId: "issue-9" },
      },
      responseId: "resp-2",
      actorRole: "operator",
    });
    expect(rejected).toEqual({ ok: false, reason: "no_correlation" });
  });
});
