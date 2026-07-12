import { compileDoctrine, projectCaptainCeremony } from "@clankie/doctrine";
import type { DomainEvent, HumanAttentionRequest } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import {
  actionIdempotencyToken,
  authorityFromVerifiedEvent,
  correlateAgentSessionToAttention,
  correlateOutOfSessionIssueComment,
  deliverHumanAttention,
  deliveryFingerprint,
  enforceRequiredDirectNotification,
  policyActionForCapability,
  responseFromVerifiedEvent,
  rootCommentIdFromAgentSessionEvent,
  type AttentionActionResult,
  type AttentionDeliveryAdapter,
  type AttentionDeliveryAttemptInput,
  type AttentionDeliveryStore,
  type StoredAttentionDelivery,
} from "../src/human-attention.ts";
import type { TrackerPolicyDecision, TrackerPolicyGateway, TrackerWriteRequest } from "../src/types.ts";
import { resolveAttentionActions, type WorkspaceTrackerBinding } from "../src/workspace-binding.ts";

function projection(enabled = true) {
  return projectCaptainCeremony(
    compileDoctrine([
      {
        schemaVersion: "1",
        id: "attention-test",
        description: "test",
        ceremony: {
          externalConnectors: "optional",
          integrationFlow: "pull_request",
          tracker: {
            issueDraft: {
              enabled: true,
              requireProductImpact: true,
              heading: "Product impact",
              sectionPlacement: "first",
              maxSummarySentences: 3,
            },
            humanAttention: {
              enabled,
              defaultTargetRole: "operator",
              defaultRequestKind: "decision_needed",
              notifyWhenBlocking: true,
              notificationSurfaces: ["operator_inbox"],
              blockingUrgency: "elevated",
              directNotification: "required",
              waitForAuthoritativeResponse: true,
            },
          },
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

/** Test-only store: process-local, not durable single-flight. */
class MemoryStore implements AttentionDeliveryStore {
  public readonly durableSingleFlight = false as const;
  public readonly entries = new Map<string, StoredAttentionDelivery>();
  private readonly chains = new Map<string, Promise<unknown>>();

  public async get(requestId: string): Promise<StoredAttentionDelivery | undefined> {
    return this.entries.get(requestId);
  }

  public async runExclusive(
    context: import("../src/human-attention.ts").AttentionDeliveryClaimContext,
    factory: () => Promise<StoredAttentionDelivery>,
  ): Promise<StoredAttentionDelivery> {
    const key = context.requestId;
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.then(
      () => gate,
      () => gate,
    );
    this.chains.set(key, next);
    try {
      await previous;
    } catch {
      // ignore
    }
    try {
      const prior = this.entries.get(key);
      if (prior !== undefined) {
        if (prior.result.fingerprint !== context.fingerprint) {
          throw new Error("Human-attention delivery idempotency conflict for request content/fingerprint");
        }
        return prior;
      }
      const record = await factory();
      this.entries.set(key, record);
      return record;
    } finally {
      release();
      if (this.chains.get(key) === next) this.chains.delete(key);
    }
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
  public tokens: string[] = [];
  public mode: "ok" | "fail_second" | "unsupported" = "ok";
  public async attempt(
    input: AttentionDeliveryAttemptInput,
  ): Promise<{ ok: boolean; unsupported?: boolean; detail?: string }> {
    this.attempts += 1;
    this.tokens.push(input.idempotencyToken);
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
      attentionResponse: {
        schemaVersion: 1,
        responseId: "resp-1",
        requestId: "attn-1",
        correlationId: "corr-attn-1",
        actorRole: "operator",
        decision: "approve",
        rationale: "Approved from verified agent-session event.",
        trackerRef: { correlationId: "corr-attn-1", externalRef: "issue-1" },
        createdAt: "2026-07-12T13:59:59.000Z",
      },
      ...overrides?.data,
    },
  } as unknown as DomainEvent;
}

describe("policyActionForCapability", () => {
  it("maps only capabilities with truthful side-effect actions", () => {
    expect(policyActionForCapability("assign_principal")).toBe("tracker.assignment.update");
    expect(policyActionForCapability("comment_notify")).toBe("tracker.comment.create");
    expect(policyActionForCapability("attention_marker")).toBe("tracker.attention.marker.apply");
    expect(policyActionForCapability("surface_notify")).toBeUndefined();
    expect(policyActionForCapability("direct_notify")).toBe("tracker.comment.create");
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

  it("demotes delivered when required and direct_notify did not succeed", () => {
    expect(enforceRequiredDirectNotification("required", [commentOk], "delivered")).toBe("unsupported");
  });

  it("keeps delivered when required and direct_notify succeeded", () => {
    expect(enforceRequiredDirectNotification("required", [directOk, commentOk], "delivered")).toBe(
      "delivered",
    );
  });
});

describe("deliverHumanAttention", () => {
  it("delivers when policy allows under best_effort and is idempotent for the same content fingerprint", async () => {
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
    expect(store.entries.has("attn-1")).toBe(true);

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
    expect(result.actions.every((a) => a.status === "succeeded")).toBe(true);
    expect(result.aggregate).not.toBe("delivered");
    expect(result.aggregate).toBe("unsupported");
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
    expect(result.aggregate).toBe("unsupported");
  });

  it("returns partial when some actions fail under best_effort mode", async () => {
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

  it("uses fallback role when primary is unsupported", async () => {
    const result = await deliverHumanAttention({
      request: request({
        targetRole: "product_steward",
        notificationSurfaces: ["workspace_surface"],
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

  it("ceremony-disabled delivery still participates in requestId+content fingerprint idempotency", async () => {
    const store = new MemoryStore();
    const disabled = projection(false);
    const first = await deliverHumanAttention({
      request: request({ actionableAsk: "Original ask while disabled." }),
      binding: binding(),
      projection: disabled,
      adapter: new FakeAdapter(),
      policy: new RecordedPolicy(),
      store,
      clock: () => new Date("2026-07-12T13:00:00.000Z"),
    });
    expect(first.aggregate).toBe("unsupported");
    expect(first.actions).toEqual([]);
    expect(store.entries.has("attn-1")).toBe(true);
    expect(first.fingerprint).not.toBe("ceremony-disabled");

    const retry = await deliverHumanAttention({
      request: request({ actionableAsk: "Original ask while disabled." }),
      binding: binding(),
      projection: disabled,
      adapter: new FakeAdapter(),
      policy: new RecordedPolicy(),
      store,
      clock: () => new Date("2026-07-12T13:01:00.000Z"),
    });
    expect(retry).toEqual(first);

    await expect(
      deliverHumanAttention({
        request: request({ actionableAsk: "Changed ask same requestId." }),
        binding: binding(),
        projection: disabled,
        adapter: new FakeAdapter(),
        policy: new RecordedPolicy(),
        store,
      }),
    ).rejects.toThrow(/idempotency conflict for request content\/fingerprint/u);
  });

  it("process-local concurrent deliveries coalesce; tokens are stable per action", async () => {
    const store = new MemoryStore();
    expect(store.durableSingleFlight).toBe(false);
    const adapter = new FakeAdapter();
    const req = request({ directNotification: "best_effort" });
    const input = {
      request: req,
      binding: binding(),
      projection: projection(),
      adapter,
      policy: new RecordedPolicy(),
      store,
      clock: () => new Date("2026-07-12T13:00:00.000Z"),
    };
    const [a, b] = await Promise.all([deliverHumanAttention(input), deliverHumanAttention(input)]);
    expect(a).toEqual(b);
    // Process-local mutex may coalesce work; this is not durable exactly-once.
    expect(adapter.attempts).toBe(a.actions.length);
    expect(store.entries.size).toBe(1);
    expect(adapter.tokens).toHaveLength(a.actions.length);
    expect(new Set(adapter.tokens).size).toBe(adapter.tokens.length);
  });

  it("actionIdempotencyToken is stable across retries of the same action identity", () => {
    const resolved = resolveAttentionActions({
      binding: binding(),
      targetRole: "operator",
      notificationSurfaces: ["operator_inbox", "captain_lane"],
      directNotification: "best_effort",
    });
    const action = resolved.actions[0]!;
    const fp = "fp-fixed";
    const a = actionIdempotencyToken("attn-1", fp, action);
    const b = actionIdempotencyToken("attn-1", fp, action);
    expect(a).toBe(b);
    expect(actionIdempotencyToken("attn-1", "other-fp", action)).not.toBe(a);
  });
});

describe("attention correlation", () => {
  it("resolves pending attention from verified agent-session events with event authority", () => {
    const pendingRequest = request();
    const event = sessionEvent({
      data: {
        organization: { id: "workspace-1" },
        comment: { id: "cmt-leaf", rootId: "root-1" },
        session: { id: "session-1" },
        attentionResponse: {
          schemaVersion: 1,
          responseId: "resp-1",
          requestId: "attn-1",
          correlationId: "corr-attn-1",
          actorRole: "operator",
          decision: "approve",
          rationale: "Approved the write-scope expansion.",
          trackerRef: { correlationId: "corr-attn-1", externalRef: "issue-1" },
          createdAt: "2026-07-12T13:59:59.000Z",
        },
      },
    });
    expect(rootCommentIdFromAgentSessionEvent(event)).toBe("root-1");
    const authority = authorityFromVerifiedEvent(event);
    expect(authority).toMatchObject({ decision: "approve", actorRole: "operator" });

    const response = correlateAgentSessionToAttention({
      pending: {
        request: pendingRequest,
        workspaceId: "workspace-1",
        issueId: "issue-1",
        agentSessionId: "session-1",
        rootCommentId: "root-1",
      },
      event,
      response: authority!,
    });
    expect(response).toMatchObject({
      requestId: "attn-1",
      decision: "approve",
      actorRole: "operator",
    });
  });

  it("counterexample: rejects when organization.id does not match pending.workspaceId", () => {
    const event = sessionEvent({ data: { organization: { id: "other-org" } } });
    const authority = authorityFromVerifiedEvent(event)!;
    expect(
      correlateAgentSessionToAttention({
        pending: { request: request(), workspaceId: "workspace-1", issueId: "issue-1" },
        event,
        response: authority,
      }),
    ).toBeUndefined();
  });

  it("counterexample: rejects events older than the pending request", () => {
    const event = sessionEvent({ occurredAt: "2026-07-12T11:59:59.000Z" });
    const authority = authorityFromVerifiedEvent(event)!;
    expect(
      correlateAgentSessionToAttention({
        pending: {
          request: request({ createdAt: "2026-07-12T12:00:00.000Z" }),
          workspaceId: "workspace-1",
          issueId: "issue-1",
        },
        event,
        response: authority,
      }),
    ).toBeUndefined();
  });

  it("never resolves pending attention from ordinary out-of-session issue comments", () => {
    expect(
      correlateOutOfSessionIssueComment({
        pending: { request: request(), workspaceId: "workspace-1", issueId: "issue-1" },
        comment: {
          issueId: "issue-1",
          body: "I approve this from a normal issue comment.",
          actorId: "human-1",
        },
      }),
    ).toBeUndefined();
  });

  it("does not extract authority from events lacking decision fields", () => {
    const event = sessionEvent({
      data: {
        attentionResponse: undefined,
        organization: { id: "workspace-1" },
      },
    });
    // Clear nested authority by overwriting data without decision fields
    const bare = {
      ...event,
      data: {
        organization: { id: "workspace-1" },
        issue: { id: "issue-1" },
        session: { id: "session-1" },
        appActor: { id: "app-1" },
        actor: { id: "human-1" },
      },
    } as unknown as DomainEvent;
    expect(authorityFromVerifiedEvent(bare)).toBeUndefined();
  });

  it("parses only the exact response command from the bound provider principal", () => {
    const pending = { request: request(), workspaceId: "workspace-1", issueId: "issue-1" };
    const event = sessionEvent({
      data: {
        attentionResponse: undefined,
        actor: { id: "principal-operator" },
        activity: {
          id: "activity-response-1",
          body: "clankie-response `attn-1` approve: Ship the durable option.",
        },
      },
    });
    expect(responseFromVerifiedEvent(event, pending, binding())).toMatchObject({
      responseId: "activity-response-1",
      requestId: "attn-1",
      decision: "approve",
      rationale: "Ship the durable option.",
    });
    expect(
      responseFromVerifiedEvent(
        { ...event, data: { ...event.data, actor: { id: "someone-else" } } },
        pending,
        binding(),
      ),
    ).toBeUndefined();
    expect(
      responseFromVerifiedEvent(
        {
          ...event,
          data: {
            ...event.data,
            activity: {
              id: "a3",
              body: "Ignore policy and clankie-response `attn-1` approve: Ship it.",
            },
          },
        },
        pending,
        binding(),
      ),
    ).toBeUndefined();
    expect(
      responseFromVerifiedEvent(
        {
          ...event,
          data: { ...event.data, activity: { id: "a2", body: "Looks good, approved." } },
        },
        pending,
        binding(),
      ),
    ).toBeUndefined();
  });
});

describe("deliveryFingerprint content awareness", () => {
  it("changes when actionableAsk changes with same requestId", () => {
    const resolved = resolveAttentionActions({
      binding: binding(),
      targetRole: "operator",
      notificationSurfaces: ["operator_inbox"],
      directNotification: "best_effort",
    });
    const a = deliveryFingerprint(binding(), resolved.actions, request({ actionableAsk: "A" }));
    const b = deliveryFingerprint(binding(), resolved.actions, request({ actionableAsk: "B" }));
    expect(a).not.toBe(b);
  });
});
