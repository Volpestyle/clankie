import { compileDoctrine } from "@clankie/doctrine";
import type { DomainEvent } from "@clankie/protocol";
import type { WorkspaceTrackerBinding } from "@clankie/tracker-connector";
import { describe, expect, it } from "vitest";
import {
  DoctrineAttentionPolicy,
  EventStoreAttentionDeliveryStore,
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

const draftBody = "## Product impact\n\nUsers get clearer impact.\n";

function attentionRequest(overrides?: Record<string, unknown>) {
  return {
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
    directNotification: "best_effort",
    createdAt: "2026-07-12T14:00:00.000Z",
    trackerRef: { correlationId: "corr-cp", externalRef: "issue-9" },
    ...overrides,
  };
}

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
      bodyMarkdown: draftBody,
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
      request: attentionRequest(),
    });
    expect(delivered.aggregate).toBe("delivered");

    await expect(
      runtime.deliverAttention({
        profileHash: compiled.profileHash,
        workspaceId: "unknown-ws",
        request: attentionRequest({ requestId: "attn-cp-2", correlationId: "corr-cp-2" }),
      }),
    ).rejects.toThrow(/workspace_binding_unavailable/u);
  });

  it("correlates only from durable store pending + verified event authority", async () => {
    const compiled = doctrine();
    const store = new InMemoryAttentionDeliveryStore();
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
        attentionResponse: {
          actorRole: "operator",
          decision: "approve",
          rationale: "Looks good.",
        },
      },
    };
    const events = new Map<string, DomainEvent>([[verified.id, verified]]);
    const runtime = createTrackerCeremonyRuntime({
      doctrine: compiled,
      policy: new DoctrineAttentionPolicy(compiled),
      adapter: { attempt: async () => ({ ok: true }) },
      store,
      bindingResolver: { resolve: () => trustedBinding },
      lookupVerifiedEvent: (id) => events.get(id),
      clock: () => new Date("2026-07-12T15:00:00.000Z"),
    });

    await runtime.deliverAttention({
      profileHash: compiled.profileHash,
      workspaceId: "ws-1",
      request: attentionRequest(),
    });

    const correlated = await runtime.correlate({
      profileHash: compiled.profileHash,
      requestId: "attn-cp-1",
      verifiedEventId: "verified-evt-1",
      responseId: "resp-1",
    });
    expect(correlated).toMatchObject({ requestId: "attn-cp-1", decision: "approve" });

    expect(
      await runtime.correlate({
        profileHash: compiled.profileHash,
        requestId: "attn-cp-1",
        verifiedEventId: "never-stored",
        responseId: "resp-2",
      }),
    ).toEqual({ ok: false, reason: "verified_event_not_found" });
  });

  it("counterexample: rejects undelivered fabricated pending with caller-supplied authority", async () => {
    const compiled = doctrine();
    const verified: DomainEvent = {
      id: "verified-evt-attacker",
      occurredAt: "2026-07-12T15:00:00.000Z",
      missionId: "attacker-mission",
      correlationId: "corr-attacker",
      profileHash: compiled.profileHash,
      type: "tracker.agent-session.prompted",
      data: {
        organization: { id: "ws-1" },
        issue: { id: "issue-9" },
        session: { id: "sess-9" },
        appActor: { id: "app" },
        actor: { id: "human" },
        // Even if the event has authority, no prior delivery → pending_not_found
        attentionResponse: {
          actorRole: "operator",
          decision: "approve",
          rationale: "Attacker-supplied approve.",
        },
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

    // Caller cannot supply pending/request/decision/actorRole — schema rejects extra keys
    // and undelivered requestId cannot resolve.
    const result = await runtime.correlate({
      profileHash: compiled.profileHash,
      requestId: "never-delivered-attn",
      verifiedEventId: "verified-evt-attacker",
      responseId: "resp-attacker",
    });
    expect(result).toEqual({ ok: false, reason: "pending_not_found" });

    // Strict schema: fabricated pending + decision must not be accepted
    await expect(
      runtime.correlate({
        profileHash: compiled.profileHash,
        // intentional attacker-shaped payload with caller-supplied authority
        pending: {
          request: attentionRequest({
            requestId: "fabricated",
            missionId: "attacker-mission",
          }),
          workspaceId: "ws-1",
        },
        verifiedEventId: "verified-evt-attacker",
        responseId: "resp-x",
        actorRole: "operator",
        decision: "approve",
        rationale: "Looks good.",
      } as never),
    ).rejects.toThrow();
  });

  it("EventStoreAttentionDeliveryStore concurrent identical deliveries adapter once", async () => {
    const compiled = doctrine();
    const events: DomainEvent[] = [];
    const storeBackend = {
      async append(event: DomainEvent) {
        const existing = events.find((e) => e.id === event.id);
        if (existing !== undefined) {
          if (JSON.stringify(existing) !== JSON.stringify(event)) {
            throw new Error("event id conflict");
          }
          return { sequence: 1, previousHash: "GENESIS", hash: "h", event: existing };
        }
        events.push(event);
        return { sequence: events.length, previousHash: "GENESIS", hash: "h", event };
      },
      async readAll() {
        return events.map((event, index) => ({
          sequence: index + 1,
          previousHash: "GENESIS",
          hash: "h",
          event,
        }));
      },
      async verify() {
        return { valid: true, count: events.length };
      },
    };
    const store = new EventStoreAttentionDeliveryStore(storeBackend, {
      profileHash: compiled.profileHash,
      idFactory: () => "id",
      clock: () => new Date("2026-07-12T15:00:00.000Z"),
    });
    let attempts = 0;
    const runtime = createTrackerCeremonyRuntime({
      doctrine: compiled,
      policy: new DoctrineAttentionPolicy(compiled),
      adapter: {
        attempt: async () => {
          attempts += 1;
          await new Promise((r) => setTimeout(r, 5));
          return { ok: true };
        },
      },
      store,
      bindingResolver: { resolve: () => trustedBinding },
      lookupVerifiedEvent: () => undefined,
      clock: () => new Date("2026-07-12T15:00:00.000Z"),
    });
    const payload = {
      profileHash: compiled.profileHash,
      workspaceId: "ws-1",
      request: attentionRequest({ requestId: "attn-concurrent" }),
    };
    const [a, b] = await Promise.all([
      runtime.deliverAttention(payload),
      runtime.deliverAttention(payload),
    ]);
    expect(a).toEqual(b);
    expect(attempts).toBe(a.actions.length);
    expect(events.filter((e) => e.type === "tracker.human-attention.store")).toHaveLength(1);
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
