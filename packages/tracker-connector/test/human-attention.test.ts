import { compileDoctrine, projectCaptainCeremony } from "@clankie/doctrine";
import type { DomainEvent, HumanAttentionRequest } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import {
  correlateAgentSessionToAttention,
  correlateOutOfSessionIssueComment,
  deliverHumanAttention,
  deliveryFingerprint,
  deliveryStoreKey,
  enforceRequiredDirectNotification,
  policyActionForCapability,
  rootCommentIdFromAgentSessionEvent,
  type AttentionActionResult,
  type AttentionDeliveryAdapter,
  type AttentionDeliveryResult,
  type AttentionDeliveryStore,
} from "../src/human-attention.ts";
import type { TrackerPolicyDecision, TrackerPolicyGateway, TrackerWriteRequest } from "../src/types.ts";
import {
  resolveAttentionActions,
  type WorkspaceTrackerBinding,
} from "../src/workspace-binding.ts";

function projection() {
  return projectCaptainCeremony(
    compileDoctrine([
      {
        schemaVersion: "1",
        id: "attention-test",
        description: "test",
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
    ]),
  );
}

function request(overrides?: Partial<HumanAttentionRequest>): HumanAttentionRequest {
  return {
    schemaVersion: 1,
    requestId: "attn-1",
    missionId: "mission-1",
    correlationId: "corr-attn-1",
    targetRole: "operator",
    requestKind: "blocker_resolution",
    actionableAsk: "Confirm whether we may widen the write scope.",
    blocking: true,
    authorityImpact: "narrow",
    urgency: "blocking",
    notificationSurfaces: ["operator_inbox", "captain_lane"],
    directNotification: "required",
    waitForAuthoritativeResponse: true,
    createdAt: "2026-07-12T12:00:00.000Z",
    trackerRef: { correlationId: "corr-attn-1", externalRef: "issue-1" },
    ...overrides,
  };
}

/** Binding uses only capabilities with truthful policy actions. */
function binding(overrides?: Partial<WorkspaceTrackerBinding>): WorkspaceTrackerBinding {
  return {
    schemaVersion: 1,
    workspaceId: "workspace-1",
    revision: "rev-1",
    roles: {
      operator: {
        principalId: "principal-operator",
        capabilities: [
          { kind: "comment_notify", principalId: "principal-operator" },
          { kind: "assign_principal", principalId: "principal-operator" },
        ],
      },
      reviewer: {
        principalId: "principal-reviewer",
        capabilities: [{ kind: "comment_notify", principalId: "principal-reviewer" }],
      },
    },
    fallbackRole: "reviewer",
    ...overrides,
  };
}

class MemoryStore implements AttentionDeliveryStore {
  public readonly entries = new Map<string, { fingerprint: string; result: AttentionDeliveryResult }>();
  public async get(key: string): Promise<AttentionDeliveryResult | undefined> {
    return this.entries.get(key)?.result;
  }
  public async put(key: string, fingerprint: string, result: AttentionDeliveryResult): Promise<void> {
    this.entries.set(key, { fingerprint, result });
  }
}

class RecordedPolicy implements TrackerPolicyGateway {
  public readonly requests: TrackerWriteRequest[] = [];
  public decision: TrackerPolicyDecision = { effect: "allow", reason: "allow" };
  public async authorize(req: TrackerWriteRequest): Promise<TrackerPolicyDecision> {
    this.requests.push(structuredClone(req));
    return structuredClone(this.decision);
  }
}

class FakeAdapter implements AttentionDeliveryAdapter {
  public attempts = 0;
  public mode: "ok" | "fail_second" | "unsupported" = "ok";
  public async attempt(): Promise<{ ok: boolean; unsupported?: boolean; detail?: string }> {
    this.attempts += 1;
    if (this.mode === "unsupported") return { ok: false, unsupported: true, detail: "no capability" };
    if (this.mode === "fail_second" && this.attempts === 2) return { ok: false, detail: "transient" };
    return { ok: true };
  }
}

function sessionEvent(overrides?: {
  readonly occurredAt?: string;
  readonly type?: string;
  readonly data?: Record<string, unknown>;
}): DomainEvent {
  return {
    id: "evt-1",
    occurredAt: overrides?.occurredAt ?? "2026-07-12T14:00:00.000Z",
    missionId: "mission-1",
    correlationId: "corr-attn-1",
    profileHash: "abc",
    type: overrides?.type ?? "tracker.agent-session.prompted",
    data: {
      organization: { id: "workspace-1" },
      issue: { id: "issue-1" },
      session: { id: "session-1", commentId: "root-1" },
      appActor: { id: "app-1" },
      actor: { id: "human-1" },
      ...(overrides?.data ?? {}),
    },
  } as unknown as DomainEvent;
}

describe("policyActionForCapability", () => {
  it("maps only capabilities with truthful side-effect actions", () => {
    expect(policyActionForCapability("assign_principal")).toBe("tracker.assignment.mirror");
    expect(policyActionForCapability("comment_notify")).toBe("tracker.comment.create");
    expect(policyActionForCapability("attention_marker")).toBeUndefined();
    expect(policyActionForCapability("surface_notify")).toBeUndefined();
    expect(policyActionForCapability("direct_notify")).toBeUndefined();
  });
});

describe("enforceRequiredDirectNotification", () => {
  const commentOk: AttentionActionResult = {
    kind: "comment_notify",
    principalId: "p",
    status: "succeeded",
    isFallback: false,
  };
  const directOk: AttentionActionResult = {
    kind: "direct_notify",
    principalId: "p",
    status: "succeeded",
    isFallback: false,
  };
  const markerFallback: AttentionActionResult = {
    kind: "attention_marker",
    principalId: "p",
    status: "succeeded",
    isFallback: true,
  };

  it("demotes delivered/partial to unsupported when required and direct_notify did not succeed", () => {
    expect(enforceRequiredDirectNotification("required", [commentOk], "delivered")).toBe("unsupported");
    expect(enforceRequiredDirectNotification("required", [commentOk], "partial")).toBe("unsupported");
  });

  it("allows fallback when only fallback actions succeeded under required mode", () => {
    expect(enforceRequiredDirectNotification("required", [markerFallback], "delivered")).toBe("fallback");
  });

  it("keeps delivered when required and direct_notify succeeded", () => {
    expect(enforceRequiredDirectNotification("required", [directOk, commentOk], "delivered")).toBe(
      "delivered",
    );
  });

  it("is a no-op when mode is not required", () => {
    expect(enforceRequiredDirectNotification("best_effort", [commentOk], "delivered")).toBe("delivered");
    expect(enforceRequiredDirectNotification("disabled", [commentOk], "delivered")).toBe("delivered");
  });
});

describe("deliverHumanAttention", () => {
  it("delivers when policy allows under preferred mode and is idempotent for the same content fingerprint", async () => {
    const store = new MemoryStore();
    const policy = new RecordedPolicy();
    const adapter = new FakeAdapter();
    const preferred = request({ directNotification: "best_effort" });
    const first = await deliverHumanAttention({
      request: preferred,
      binding: binding(),
      projection: projection(),
      adapter,
      policy,
      store,
      clock: () => new Date("2026-07-12T13:00:00.000Z"),
    });
    expect(first.aggregate).toBe("delivered");
    expect(first.actions.every((a) => a.status === "succeeded")).toBe(true);
    expect(policy.requests.map((r) => r.action).sort()).toEqual(
      ["tracker.assignment.mirror", "tracker.comment.create"].sort(),
    );
    expect(store.entries.has(deliveryStoreKey("attn-1"))).toBe(true);

    const second = await deliverHumanAttention({
      request: preferred,
      binding: binding(),
      projection: projection(),
      adapter,
      policy,
      store,
      clock: () => new Date("2026-07-12T13:01:00.000Z"),
    });
    expect(second).toEqual(first);
    expect(adapter.attempts).toBe(first.actions.length);
  });

  it("counterexample: required + comment/assign-only binding never claims delivered", async () => {
    const result = await deliverHumanAttention({
      request: request({ directNotification: "required" }),
      binding: binding(),
      projection: projection(),
      adapter: new FakeAdapter(),
      policy: new RecordedPolicy(),
      store: new MemoryStore(),
    });
    // Actions may succeed at the adapter, but aggregate must not be "delivered".
    expect(result.actions.every((a) => a.status === "succeeded")).toBe(true);
    expect(result.aggregate).not.toBe("delivered");
    expect(result.aggregate).toBe("unsupported");
  });

  it("counterexample: required + attention_marker-only is unsupported, never delivered", async () => {
    const result = await deliverHumanAttention({
      request: request({
        directNotification: "required",
        notificationSurfaces: ["operator_inbox"],
      }),
      binding: {
        schemaVersion: 1,
        workspaceId: "workspace-1",
        revision: "rev-marker",
        roles: {
          operator: {
            principalId: "p",
            capabilities: [{ kind: "attention_marker", principalId: "p" }],
          },
        },
      },
      projection: projection(),
      adapter: new FakeAdapter(),
      policy: new RecordedPolicy(),
      store: new MemoryStore(),
    });
    expect(result.aggregate).toBe("unsupported");
    expect(result.actions.every((a) => a.status === "unsupported")).toBe(true);
    expect(result.aggregate).not.toBe("delivered");
  });

  it("marks attention_marker unsupported without authorizing tracker.comment.create", async () => {
    const policy = new RecordedPolicy();
    const result = await deliverHumanAttention({
      request: request({
        directNotification: "best_effort",
        notificationSurfaces: ["operator_inbox"],
      }),
      binding: {
        schemaVersion: 1,
        workspaceId: "workspace-1",
        revision: "rev-marker",
        roles: {
          operator: {
            principalId: "p",
            capabilities: [{ kind: "attention_marker", principalId: "p" }],
          },
        },
      },
      projection: projection(),
      adapter: new FakeAdapter(),
      policy,
      store: new MemoryStore(),
    });
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.status).toBe("unsupported");
    expect(result.actions[0]?.detail).toMatch(/No exact doctrine\/policy action/u);
    expect(policy.requests).toEqual([]);
  });

  it("returns denied actions when policy denies (per-action denied ≠ unsupported)", async () => {
    const policy = new RecordedPolicy();
    policy.decision = { effect: "deny", reason: "blocked by policy" };
    const result = await deliverHumanAttention({
      request: request({ directNotification: "best_effort" }),
      binding: binding(),
      projection: projection(),
      adapter: new FakeAdapter(),
      policy,
      store: new MemoryStore(),
    });
    expect(result.actions.every((a) => a.status === "denied")).toBe(true);
    expect(result.actions.some((a) => a.status === "unsupported")).toBe(false);
    // Aggregate vocabulary stays frozen (unsupported), but action rows stay denied.
    expect(result.aggregate).toBe("unsupported");
  });

  it("counterexample: denied remains distinguishable from unsupported on the same delivery", async () => {
    const policy: TrackerPolicyGateway = {
      async authorize(req) {
        if (req.action === "tracker.assignment.mirror") {
          return { effect: "deny", reason: "assignment blocked" };
        }
        return { effect: "allow", reason: "allow" };
      },
    };
    const result = await deliverHumanAttention({
      request: request({ directNotification: "best_effort" }),
      binding: binding(),
      projection: projection(),
      adapter: new FakeAdapter(),
      policy,
      store: new MemoryStore(),
    });
    const statuses = result.actions.map((a) => a.status).sort();
    expect(statuses).toContain("denied");
    expect(statuses).toContain("succeeded");
    expect(result.actions.find((a) => a.kind === "assign_principal")?.status).toBe("denied");
    expect(result.actions.find((a) => a.kind === "comment_notify")?.status).toBe("succeeded");
    expect(result.aggregate).toBe("partial");
  });

  it("returns partial when some actions fail under preferred mode", async () => {
    const adapter = new FakeAdapter();
    adapter.mode = "fail_second";
    const result = await deliverHumanAttention({
      request: request({ directNotification: "best_effort" }),
      binding: binding(),
      projection: projection(),
      adapter,
      policy: new RecordedPolicy(),
      store: new MemoryStore(),
    });
    expect(result.aggregate).toBe("partial");
  });

  it("returns unsupported when binding has no capabilities for the role", async () => {
    const result = await deliverHumanAttention({
      request: request({
        targetRole: "verifier",
        notificationSurfaces: ["captain_lane"],
        directNotification: "best_effort",
      }),
      binding: {
        schemaVersion: 1,
        workspaceId: "workspace-1",
        revision: "rev-1",
        roles: {
          operator: {
            principalId: "p",
            capabilities: [{ kind: "comment_notify", principalId: "p" }],
          },
        },
      },
      projection: projection(),
      adapter: new FakeAdapter(),
      policy: new RecordedPolicy(),
      store: new MemoryStore(),
    });
    expect(result.aggregate).toBe("unsupported");
    expect(result.actions).toEqual([]);
  });

  it("uses fallback role when primary is unsupported", async () => {
    const result = await deliverHumanAttention({
      request: request({
        targetRole: "product_steward",
        notificationSurfaces: ["workspace_surface"],
        // Fallback path is an allowed outcome under required when only fallbacks succeed.
        directNotification: "required",
      }),
      binding: binding({
        roles: {
          reviewer: {
            principalId: "principal-reviewer",
            capabilities: [{ kind: "comment_notify", principalId: "principal-reviewer" }],
          },
        },
        fallbackRole: "reviewer",
      }),
      projection: projection(),
      adapter: new FakeAdapter(),
      policy: new RecordedPolicy(),
      store: new MemoryStore(),
    });
    expect(result.aggregate).toBe("fallback");
    expect(result.actions.every((a) => a.isFallback)).toBe(true);
    expect(result.aggregate).not.toBe("delivered");
  });

  it("counterexample: same requestId with different request content conflicts on idempotency", async () => {
    const store = new MemoryStore();
    const firstReq = request({
      directNotification: "best_effort",
      actionableAsk: "Approve scope A.",
    });
    await deliverHumanAttention({
      request: firstReq,
      binding: binding(),
      projection: projection(),
      adapter: new FakeAdapter(),
      policy: new RecordedPolicy(),
      store,
    });

    const secondReq = request({
      directNotification: "best_effort",
      actionableAsk: "Approve a totally different scope B.",
    });
    const resolved = resolveAttentionActions({
      binding: binding(),
      targetRole: secondReq.targetRole,
      notificationSurfaces: secondReq.notificationSurfaces,
      directNotification: "best_effort",
    });
    expect(deliveryFingerprint(binding(), resolved.actions, firstReq)).not.toBe(
      deliveryFingerprint(binding(), resolved.actions, secondReq),
    );

    await expect(
      deliverHumanAttention({
        request: secondReq,
        binding: binding(),
        projection: projection(),
        adapter: new FakeAdapter(),
        policy: new RecordedPolicy(),
        store,
      }),
    ).rejects.toThrow(/idempotency conflict for request content\/fingerprint/u);
  });
});

describe("attention correlation", () => {
  it("resolves pending attention from verified agent-session prompted events", () => {
    const pendingRequest = request();
    const event = sessionEvent({
      data: {
        organization: { id: "workspace-1" },
        comment: { id: "cmt-leaf", rootId: "root-1" },
        session: { id: "session-1" },
      },
    });

    expect(rootCommentIdFromAgentSessionEvent(event)).toBe("root-1");

    const response = correlateAgentSessionToAttention({
      pending: {
        request: pendingRequest,
        workspaceId: "workspace-1",
        issueId: "issue-1",
        agentSessionId: "session-1",
        rootCommentId: "root-1",
      },
      event,
      responseId: "resp-1",
      actorRole: "operator",
      decision: "approve",
      rationale: "Approved the write-scope expansion.",
      clock: () => new Date("2026-07-12T14:00:01.000Z"),
    });
    expect(response).toMatchObject({
      requestId: "attn-1",
      decision: "approve",
      actorRole: "operator",
    });
  });

  it("counterexample: rejects when organization.id does not match pending.workspaceId", () => {
    const response = correlateAgentSessionToAttention({
      pending: {
        request: request(),
        workspaceId: "workspace-1",
        issueId: "issue-1",
      },
      event: sessionEvent({
        data: { organization: { id: "other-org" } },
      }),
      responseId: "resp-1",
      actorRole: "operator",
    });
    expect(response).toBeUndefined();
  });

  it("counterexample: rejects events older than the pending request", () => {
    const response = correlateAgentSessionToAttention({
      pending: {
        request: request({ createdAt: "2026-07-12T12:00:00.000Z" }),
        workspaceId: "workspace-1",
        issueId: "issue-1",
      },
      event: sessionEvent({ occurredAt: "2026-07-12T11:59:59.000Z" }),
      responseId: "resp-1",
      actorRole: "operator",
    });
    expect(response).toBeUndefined();
  });

  it("counterexample: rejects when root comment fields do not match", () => {
    const event = sessionEvent({
      data: {
        organization: { id: "workspace-1" },
        comment: { id: "other-leaf", rootId: "other-root" },
        session: { id: "session-1", commentId: "session-root" },
      },
    });
    expect(rootCommentIdFromAgentSessionEvent(event)).toBe("other-root");

    const response = correlateAgentSessionToAttention({
      pending: {
        request: request(),
        workspaceId: "workspace-1",
        issueId: "issue-1",
        agentSessionId: "session-1",
        rootCommentId: "root-1",
      },
      event,
      responseId: "resp-1",
      actorRole: "operator",
    });
    expect(response).toBeUndefined();
  });

  it("uses event comment/root fields preferring comment.rootId over session.commentId", () => {
    const event = sessionEvent({
      data: {
        organization: { id: "workspace-1" },
        comment: { id: "leaf-9", rootId: "from-comment-root" },
        session: { id: "session-1", commentId: "from-session" },
      },
    });
    expect(rootCommentIdFromAgentSessionEvent(event)).toBe("from-comment-root");
    expect(
      correlateAgentSessionToAttention({
        pending: {
          request: request(),
          workspaceId: "workspace-1",
          issueId: "issue-1",
          agentSessionId: "session-1",
          rootCommentId: "from-comment-root",
        },
        event,
        responseId: "resp-1",
        actorRole: "operator",
      }),
    ).toMatchObject({ requestId: "attn-1" });
  });

  it("never resolves pending attention from ordinary out-of-session issue comments", () => {
    const pendingRequest = request();
    expect(
      correlateOutOfSessionIssueComment({
        pending: {
          request: pendingRequest,
          workspaceId: "workspace-1",
          issueId: "issue-1",
        },
        comment: {
          issueId: "issue-1",
          body: "I approve this from a normal issue comment.",
          actorId: "human-1",
        },
      }),
    ).toBeUndefined();

    const nonSessionEvent = {
      id: "evt-2",
      occurredAt: "2026-07-12T14:00:00.000Z",
      missionId: "mission-1",
      correlationId: "corr-attn-1",
      profileHash: "abc",
      type: "tracker.comment.observed",
      data: {
        organization: { id: "workspace-1" },
        issueId: "issue-1",
        body: "ordinary comment",
      },
    } as unknown as DomainEvent;
    expect(
      correlateAgentSessionToAttention({
        pending: {
          request: pendingRequest,
          workspaceId: "workspace-1",
          issueId: "issue-1",
        },
        event: nonSessionEvent,
        responseId: "resp-x",
        actorRole: "operator",
      }),
    ).toBeUndefined();
  });
});
