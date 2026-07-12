import { compileDoctrine } from "@clankie/doctrine";
import type { DomainEvent } from "@clankie/protocol";
import type { WorkspaceTrackerBinding } from "@clankie/tracker-connector";
import { describe, expect, it } from "vitest";
import {
  DoctrineAttentionPolicy,
  InMemoryAttentionDeliveryStore,
  createTrackerCeremonyRuntime,
} from "../src/tracker-ceremony.ts";

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
      actions: {
        "tracker.assignment.mirror": { default: "allow", rules: [] },
        "tracker.comment.create": { default: "allow", rules: [] },
      },
      memory: {
        rawTranscriptRetentionDays: 7,
        inferredFacts: "require_approval",
        publicToPrivatePropagation: false,
      },
    },
  ]);
}

const trustedBinding: WorkspaceTrackerBinding = {
  schemaVersion: 1,
  workspaceId: "ws-1",
  revision: "r1",
  roles: {
    operator: {
      principalId: "principal-op",
      capabilities: [
        { kind: "comment_notify", principalId: "principal-op" },
        { kind: "assign_principal", principalId: "principal-op" },
      ],
    },
  },
};

describe("control-plane tracker ceremony runtime", () => {
  it("validates issue drafts against the compiled projection with profile hash", () => {
    const compiled = doctrine();
    const runtime = createTrackerCeremonyRuntime({
      doctrine: compiled,
      policy: new DoctrineAttentionPolicy(compiled),
      adapter: { attempt: async () => ({ ok: true }) },
      store: new InMemoryAttentionDeliveryStore(),
      bindingResolver: { resolve: () => trustedBinding },
      lookupVerifiedEvent: () => undefined,
    });
    const ok = runtime.validateDraft({
      profileHash: compiled.profileHash,
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
    expect(() =>
      runtime.validateDraft({
        profileHash: "stale-hash",
        draft: {},
      }),
    ).toThrow(/doctrine_hash_mismatch/u);
  });

  it("resolves binding from trusted resolver and rejects client-supplied bindings", async () => {
    const compiled = doctrine();
    const runtime = createTrackerCeremonyRuntime({
      doctrine: compiled,
      policy: new DoctrineAttentionPolicy(compiled),
      adapter: { attempt: async () => ({ ok: true }) },
      store: new InMemoryAttentionDeliveryStore(),
      bindingResolver: {
        resolve: (workspaceId) => (workspaceId === "ws-1" ? trustedBinding : undefined),
      },
      lookupVerifiedEvent: () => undefined,
      clock: () => new Date("2026-07-12T15:00:00.000Z"),
    });

    const delivered = await runtime.deliverAttention({
      profileHash: compiled.profileHash,
      workspaceId: "ws-1",
      request: {
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
        // best_effort: comment/assign-only bindings may claim delivered.
        // required mode forbids delivered without successful direct_notify.
        directNotification: "best_effort",
        createdAt: "2026-07-12T14:00:00.000Z",
        trackerRef: { correlationId: "corr-cp", externalRef: "issue-9" },
      },
    });
    expect(delivered.aggregate).toBe("delivered");

    await expect(
      runtime.deliverAttention({
        profileHash: compiled.profileHash,
        workspaceId: "unknown-ws",
        request: {
          schemaVersion: 1,
          requestId: "attn-cp-2",
          missionId: "mission-cp",
          correlationId: "corr-cp-2",
          targetRole: "operator",
          requestKind: "decision_needed",
          actionableAsk: "Please decide.",
          blocking: true,
          authorityImpact: "narrow",
          urgency: "blocking",
          notificationSurfaces: ["operator_inbox"],
          createdAt: "2026-07-12T14:00:00.000Z",
        },
      }),
    ).rejects.toThrow(/workspace_binding_unavailable/u);
  });

  it("correlates only verified event ids already in the trusted store", () => {
    const compiled = doctrine();
    const verified: DomainEvent = {
      id: "verified-evt-1",
      occurredAt: "2026-07-12T15:00:00.000Z",
      missionId: "mission-cp",
      correlationId: "corr-cp",
      profileHash: compiled.profileHash,
      type: "tracker.agent-session.prompted",
      data: {
        organization: { id: "ws-1" },
        issue: { id: "issue-9" },
        session: { id: "sess-9" },
        appActor: { id: "app" },
        actor: { id: "human" },
      },
    };
    const events = new Map<string, DomainEvent>([[verified.id, verified]]);
    const runtime = createTrackerCeremonyRuntime({
      doctrine: compiled,
      policy: new DoctrineAttentionPolicy(compiled),
      adapter: { attempt: async () => ({ ok: true }) },
      store: new InMemoryAttentionDeliveryStore(),
      bindingResolver: { resolve: () => trustedBinding },
      lookupVerifiedEvent: (id) => events.get(id),
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
      profileHash: compiled.profileHash,
      pending: {
        request: pendingRequest,
        workspaceId: "ws-1",
        issueId: "issue-9",
        agentSessionId: "sess-9",
      },
      verifiedEventId: "verified-evt-1",
      responseId: "resp-1",
      actorRole: "operator",
      decision: "approve",
      rationale: "Looks good.",
    });
    expect(correlated).toMatchObject({ requestId: "attn-cp-1", decision: "approve" });

    // Raw masquerading payload is not accepted — only event ids.
    expect(
      runtime.correlate({
        profileHash: compiled.profileHash,
        pending: {
          request: pendingRequest,
          workspaceId: "ws-1",
          issueId: "issue-9",
        },
        verifiedEventId: "never-stored",
        responseId: "resp-2",
        actorRole: "operator",
      }),
    ).toEqual({ ok: false, reason: "verified_event_not_found" });
  });

  it("DoctrineAttentionPolicy fails closed for unknown tracker actions", async () => {
    const policy = new DoctrineAttentionPolicy(doctrine());
    const denied = await policy.authorize({
      action: "tracker.completion.update",
      riskClass: "irreversible-write",
      missionId: "m",
      ref: { connector: "workspace", workspaceId: "w", issueId: "i" },
      idempotencyKey: "k",
    });
    expect(denied.effect).not.toBe("allow");
  });
});
