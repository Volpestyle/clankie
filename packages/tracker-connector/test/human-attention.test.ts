import { compileDoctrine, projectCaptainCeremony } from "@clankie/doctrine";
import type { DomainEvent, HumanAttentionRequest } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import {
  correlateAgentSessionToAttention,
  correlateOutOfSessionIssueComment,
  deliverHumanAttention,
  type AttentionDeliveryAdapter,
  type AttentionDeliveryResult,
  type AttentionDeliveryStore,
} from "../src/human-attention.ts";
import type { TrackerPolicyDecision, TrackerPolicyGateway, TrackerWriteRequest } from "../src/types.ts";
import type { WorkspaceTrackerBinding } from "../src/workspace-binding.ts";

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
        actions: {},
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
          { kind: "surface_notify", principalId: "principal-operator", surface: "operator_inbox" },
          { kind: "direct_notify", principalId: "principal-operator" },
        ],
      },
      reviewer: {
        principalId: "principal-reviewer",
        capabilities: [
          { kind: "surface_notify", principalId: "principal-reviewer", surface: "workspace_surface" },
        ],
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

describe("deliverHumanAttention", () => {
  it("delivers when policy allows and is idempotent for the same fingerprint", async () => {
    const store = new MemoryStore();
    const policy = new RecordedPolicy();
    const adapter = new FakeAdapter();
    const first = await deliverHumanAttention({
      request: request(),
      binding: binding(),
      projection: projection(),
      adapter,
      policy,
      store,
      clock: () => new Date("2026-07-12T13:00:00.000Z"),
    });
    expect(first.aggregate).toBe("delivered");
    expect(first.actions.every((a) => a.status === "succeeded")).toBe(true);
    expect(adapter.attempts).toBeGreaterThan(0);

    const second = await deliverHumanAttention({
      request: request(),
      binding: binding(),
      projection: projection(),
      adapter,
      policy,
      store,
      clock: () => new Date("2026-07-12T13:01:00.000Z"),
    });
    expect(second).toEqual(first);
    expect(adapter.attempts).toBe(first.actions.length);
    expect(policy.requests.length).toBe(first.actions.length);
  });

  it("returns denied actions when policy denies", async () => {
    const policy = new RecordedPolicy();
    policy.decision = { effect: "deny", reason: "blocked by policy" };
    const result = await deliverHumanAttention({
      request: request(),
      binding: binding(),
      projection: projection(),
      adapter: new FakeAdapter(),
      policy,
      store: new MemoryStore(),
    });
    expect(result.actions.every((a) => a.status === "denied")).toBe(true);
    expect(result.aggregate).toBe("unsupported");
  });

  it("returns partial when some actions fail", async () => {
    const adapter = new FakeAdapter();
    adapter.mode = "fail_second";
    const result = await deliverHumanAttention({
      request: request(),
      binding: binding(),
      projection: projection(),
      adapter,
      policy: new RecordedPolicy(),
      store: new MemoryStore(),
    });
    expect(result.aggregate).toBe("partial");
    expect(result.actions.some((a) => a.status === "succeeded")).toBe(true);
    expect(result.actions.some((a) => a.status === "failed")).toBe(true);
  });

  it("returns unsupported when binding has no capabilities for the role", async () => {
    const result = await deliverHumanAttention({
      request: request({ targetRole: "verifier", notificationSurfaces: ["captain_lane"] }),
      binding: {
        schemaVersion: 1,
        workspaceId: "workspace-1",
        revision: "rev-1",
        roles: {
          operator: {
            principalId: "p",
            capabilities: [{ kind: "surface_notify", principalId: "p", surface: "operator_inbox" }],
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
    const adapter = new FakeAdapter();
    const result = await deliverHumanAttention({
      request: request({
        targetRole: "product_steward",
        notificationSurfaces: ["workspace_surface"],
      }),
      binding: binding({
        roles: {
          reviewer: {
            principalId: "principal-reviewer",
            capabilities: [
              {
                kind: "surface_notify",
                principalId: "principal-reviewer",
                surface: "workspace_surface",
              },
            ],
          },
        },
        fallbackRole: "reviewer",
      }),
      projection: projection(),
      adapter,
      policy: new RecordedPolicy(),
      store: new MemoryStore(),
    });
    expect(result.aggregate).toBe("fallback");
    expect(result.actions.every((a) => a.isFallback)).toBe(true);
  });

  it("keeps Linear-specific identity nouns only in binding fixtures, not portable assertions", async () => {
    // Fixture may name Linear principal ids behind the binding boundary.
    const linearishBinding: WorkspaceTrackerBinding = {
      schemaVersion: 1,
      workspaceId: "linear-workspace",
      revision: "r2",
      roles: {
        operator: {
          principalId: "lin_user_opaque_handle",
          capabilities: [
            { kind: "comment_notify", principalId: "lin_user_opaque_handle" },
            { kind: "assign_principal", principalId: "lin_app_opaque_handle" },
          ],
        },
      },
    };
    const result = await deliverHumanAttention({
      request: request({ notificationSurfaces: ["operator_inbox"] }),
      binding: linearishBinding,
      projection: projection(),
      adapter: new FakeAdapter(),
      policy: new RecordedPolicy(),
      store: new MemoryStore(),
    });
    expect(result.aggregate).toBe("delivered");
    // Portable result surface stays free of provider product nouns.
    expect(JSON.stringify(result)).not.toMatch(/@|gmail\.com|label:|Linear/u);
  });
});

describe("attention correlation", () => {
  it("resolves pending attention from verified agent-session prompted events", () => {
    const pendingRequest = request();
    const event = {
      id: "evt-1",
      occurredAt: "2026-07-12T14:00:00.000Z",
      missionId: "mission-1",
      correlationId: "corr-attn-1",
      profileHash: "abc",
      type: "tracker.agent-session.prompted",
      data: {
        issue: { id: "issue-1" },
        session: { id: "session-1", commentId: "root-1" },
        appActor: { id: "app-1" },
        actor: { id: "human-1" },
      },
    } as unknown as DomainEvent;

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

  it("never resolves pending attention from ordinary out-of-session issue comments", () => {
    const pendingRequest = request();
    const response = correlateOutOfSessionIssueComment({
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
    });
    expect(response).toBeUndefined();

    const nonSessionEvent = {
      id: "evt-2",
      occurredAt: "2026-07-12T14:00:00.000Z",
      missionId: "mission-1",
      correlationId: "corr-attn-1",
      profileHash: "abc",
      type: "tracker.comment.observed",
      data: { issueId: "issue-1", body: "ordinary comment" },
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
