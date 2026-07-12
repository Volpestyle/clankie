import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileDoctrine } from "@clankie/doctrine";
import { SqliteEventStore } from "@clankie/event-store";
import type { DomainEvent } from "@clankie/protocol";
import type { AttentionDeliveryAttemptInput, WorkspaceTrackerBinding } from "@clankie/tracker-connector";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../src/app.ts";
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
      riskClasses: {
        read: { default: "allow", rules: [] },
        "narrative-write": {
          default: "allow",
          rules: [],
          guardrail: {
            windowSeconds: 60,
            maxWritesPerWindow: 20,
            maxBytesPerWrite: 16384,
            maxBytesPerWindow: 65536,
          },
        },
        "reversible-write": { default: "allow", rules: [] },
        "irreversible-write": { default: "require_approval", rules: [] },
        "publish-external": { default: "require_approval", rules: [] },
        destructive: { default: "require_approval", rules: [] },
      },
      actions: {
        "tracker.assignment.mirror": { default: "allow", rules: [] },
        "tracker.assignment.update": { default: "allow", rules: [] },
        "tracker.attention.marker.apply": { default: "allow", rules: [] },
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
      principalId: "human",
      capabilities: [
        { kind: "comment_notify", principalId: "human" },
        { kind: "assign_principal", principalId: "human" },
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

function testPolicyContent(input: AttentionDeliveryAttemptInput): string | undefined {
  return input.action.capability.kind === "comment_notify" || input.action.capability.kind === "direct_notify"
    ? input.request.actionableAsk
    : undefined;
}

describe("control-plane tracker ceremony runtime", () => {
  it("records delivery and response envelope correlation/task identity from the request", async () => {
    const compiled = doctrine();
    const dir = mkdtempSync(join(tmpdir(), "attn-http-envelope-"));
    const store = new SqliteEventStore(join(dir, "events.sqlite"));
    const verified: DomainEvent = {
      id: "verified-http-response",
      occurredAt: "2026-07-12T15:00:00.000Z",
      missionId: "mission-cp",
      taskId: "task-cp",
      workerRunId: "worker-cp",
      correlationId: "corr-cp",
      profileHash: compiled.profileHash,
      type: "tracker.agent-session.prompted",
      data: {
        organization: { id: "ws-1" },
        issue: { id: "issue-9" },
        actor: { id: "human" },
        activity: {
          id: "activity-http-response",
          body: "clankie-response attn-cp-1 approve: Approved through the bound provider identity.",
        },
      },
    };
    await store.append(verified);
    let id = 0;
    const app = await createControlPlane({
      doctrine: compiled,
      eventStore: store,
      authenticateCaptain: () => Promise.resolve({ captainId: "captain-1", steerSourceLane: "api" }),
      workspaceBindingResolver: { resolve: () => trustedBinding },
      attentionDeliveryAdapter: {
        policyContent: (input) => input.request.actionableAsk,
        attempt: async () => ({ ok: true }),
      },
      idFactory: () => `http-envelope-${String(++id)}`,
      clock: () => new Date("2026-07-12T15:01:00.000Z"),
    });
    const headers = { "content-type": "application/json", authorization: "Bearer captain" };
    const request = attentionRequest({ taskId: "task-cp", workerRunId: "worker-cp" });
    const deliveredResponse = await app.request("/v1/tracker/human-attention/deliver", {
      method: "POST",
      headers,
      body: JSON.stringify({ profileHash: compiled.profileHash, workspaceId: "ws-1", request }),
    });
    expect(deliveredResponse.status).toBe(200);
    const correlatedResponse = await app.request("/v1/tracker/human-attention/correlate", {
      method: "POST",
      headers,
      body: JSON.stringify({
        profileHash: compiled.profileHash,
        requestId: "attn-cp-1",
        verifiedEventId: verified.id,
      }),
    });
    expect(correlatedResponse.status).toBe(200);

    const events = (await store.readAll()).map(({ event }) => event);
    for (const type of ["tracker.human-attention.delivered", "tracker.human-attention.responded"] as const) {
      expect(events.find((event) => event.type === type)).toMatchObject({
        missionId: "mission-cp",
        taskId: "task-cp",
        workerRunId: "worker-cp",
        correlationId: "corr-cp",
        profileHash: compiled.profileHash,
      });
    }
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("validates issue drafts against the compiled projection with profile hash", () => {
    const compiled = doctrine();
    const runtime = createTrackerCeremonyRuntime({
      doctrine: compiled,
      policy: new DoctrineAttentionPolicy(compiled),
      adapter: { policyContent: testPolicyContent, attempt: async () => ({ ok: true }) },
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
      adapter: { policyContent: testPolicyContent, attempt: async () => ({ ok: true }) },
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
          schemaVersion: 1,
          responseId: "resp-1",
          requestId: "attn-cp-1",
          correlationId: "corr-cp",
          actorRole: "operator",
          decision: "approve",
          rationale: "Looks good.",
          trackerRef: { correlationId: "corr-cp", externalRef: "issue-9" },
          createdAt: "2026-07-12T15:00:00.000Z",
        },
      },
    };
    const events = new Map<string, DomainEvent>([[verified.id, verified]]);
    const runtime = createTrackerCeremonyRuntime({
      doctrine: compiled,
      policy: new DoctrineAttentionPolicy(compiled),
      adapter: { policyContent: testPolicyContent, attempt: async () => ({ ok: true }) },
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
    });
    expect(correlated).toMatchObject({ requestId: "attn-cp-1", decision: "approve" });

    await runtime.deliverAttention({
      profileHash: compiled.profileHash,
      workspaceId: "ws-1",
      request: attentionRequest({ requestId: "attn-cp-2" }),
    });
    expect(
      await runtime.correlate({
        profileHash: compiled.profileHash,
        requestId: "attn-cp-2",
        verifiedEventId: "verified-evt-1",
      }),
    ).toEqual({ ok: false, reason: "no_correlation" });

    expect(
      await runtime.correlate({
        profileHash: compiled.profileHash,
        requestId: "attn-cp-1",
        verifiedEventId: "never-stored",
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
          schemaVersion: 1,
          responseId: "resp-attacker",
          requestId: "never-delivered-attn",
          correlationId: "corr-attacker",
          actorRole: "operator",
          decision: "approve",
          rationale: "Attacker-supplied approve.",
          createdAt: "2026-07-12T15:00:00.000Z",
        },
      },
    };
    const events = new Map<string, DomainEvent>([[verified.id, verified]]);
    const runtime = createTrackerCeremonyRuntime({
      doctrine: compiled,
      policy: new DoctrineAttentionPolicy(compiled),
      adapter: { policyContent: testPolicyContent, attempt: async () => ({ ok: true }) },
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
        actorRole: "operator",
        decision: "approve",
        rationale: "Looks good.",
      } as never),
    ).rejects.toThrow();
  });

  it("fails closed when EventStore lacks appendExpected (no durable single-flight)", () => {
    const plainStore = {
      async append() {
        throw new Error("unused");
      },
      async readAll() {
        return [];
      },
      async verify() {
        return { valid: true, count: 0 };
      },
    };
    expect(
      () =>
        new EventStoreAttentionDeliveryStore(plainStore, {
          profileHash: "p",
          idFactory: () => "id",
          clock: () => new Date(),
        }),
    ).toThrow(/attention_delivery_store_requires_projection_event_store/u);
  });

  it("same-SQLite dual-store concurrency: one durable complete; stable adapter tokens", async () => {
    const compiled = doctrine();
    const dir = mkdtempSync(join(tmpdir(), "attn-delivery-"));
    const dbPath = join(dir, "events.sqlite");
    const opts = {
      profileHash: compiled.profileHash,
      idFactory: () => "id",
      clock: () => new Date("2026-07-12T15:00:00.000Z"),
    };
    // Separate store instances + separate SQLite connections — no shared process mutex.
    const backendA = new SqliteEventStore(dbPath);
    const backendB = new SqliteEventStore(dbPath);
    const storeA = new EventStoreAttentionDeliveryStore(backendA, opts);
    const storeB = new EventStoreAttentionDeliveryStore(backendB, {
      ...opts,
      clock: () => new Date("2026-07-12T15:00:00.001Z"),
    });
    expect(storeA.durableSingleFlight).toBe(true);

    const tokens: string[] = [];
    let attempts = 0;
    const adapter = {
      policyContent: testPolicyContent,
      attempt: async (input: AttentionDeliveryAttemptInput) => {
        attempts += 1;
        tokens.push(input.idempotencyToken);
        await new Promise((r) => setTimeout(r, 15));
        return { ok: true as const };
      },
    };

    const runtimeA = createTrackerCeremonyRuntime({
      doctrine: compiled,
      policy: new DoctrineAttentionPolicy(compiled),
      adapter,
      store: storeA,
      bindingResolver: { resolve: () => trustedBinding },
      lookupVerifiedEvent: () => undefined,
      clock: () => new Date("2026-07-12T15:00:00.000Z"),
    });
    const runtimeB = createTrackerCeremonyRuntime({
      doctrine: compiled,
      policy: new DoctrineAttentionPolicy(compiled),
      adapter,
      store: storeB,
      bindingResolver: { resolve: () => trustedBinding },
      lookupVerifiedEvent: () => undefined,
      clock: () => new Date("2026-07-12T15:00:00.000Z"),
    });

    const payload = {
      profileHash: compiled.profileHash,
      workspaceId: "ws-1",
      request: attentionRequest({ requestId: "attn-sqlite-concurrent" }),
    };
    const [a, b] = await Promise.all([
      runtimeA.deliverAttention(payload),
      runtimeB.deliverAttention(payload),
    ]);
    expect(a.requestId).toBe(b.requestId);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.aggregate).toBe(b.aggregate);

    // Claims live on the real mission stream (mission-cp), never a synthetic attention stream.
    const stream = await backendA.readStream("mission-cp");
    const completes = stream.filter(
      (e) =>
        e.event.type === "tracker.human-attention.store" &&
        e.event.data.requestId === "attn-sqlite-concurrent",
    );
    const reserves = stream.filter(
      (e) =>
        e.event.type === "tracker.human-attention.reserve" &&
        e.event.data.requestId === "attn-sqlite-concurrent",
    );
    expect(reserves.length).toBe(1);
    expect(completes.length).toBe(1);
    expect(completes[0]?.event.missionId).toBe("mission-cp");
    expect(reserves[0]?.event.missionId).toBe("mission-cp");
    expect(attempts).toBe(a.actions.length);
    // Every action kind gets a stable token; duplicates under recovery re-use it.
    const uniqueTokens = new Set(tokens);
    expect(uniqueTokens.size).toBe(a.actions.length);
    for (const token of tokens) {
      expect(token.length).toBe(64);
    }

    backendA.close();
    backendB.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("restart after reserve-only reuses provider tokens after lease takeover", async () => {
    const compiled = doctrine();
    const dir = mkdtempSync(join(tmpdir(), "attn-restart-"));
    const dbPath = join(dir, "events.sqlite");
    const opts = {
      profileHash: compiled.profileHash,
      idFactory: () => "id",
      clock: () => new Date("2026-07-12T15:00:00.000Z"),
    };
    const backend1 = new SqliteEventStore(dbPath);
    const store1 = new EventStoreAttentionDeliveryStore(backend1, opts);
    const tokens: string[] = [];
    let crashAfterProviderAttempt = true;
    const adapter = {
      policyContent: testPolicyContent,
      attempt: async (input: AttentionDeliveryAttemptInput) => {
        tokens.push(input.idempotencyToken);
        if (crashAfterProviderAttempt) throw new Error("simulated_process_crash");
        return { ok: true as const };
      },
    };
    const runtime1 = createTrackerCeremonyRuntime({
      doctrine: compiled,
      policy: new DoctrineAttentionPolicy(compiled),
      adapter,
      store: store1,
      bindingResolver: { resolve: () => trustedBinding },
      lookupVerifiedEvent: () => undefined,
      clock: () => new Date("2026-07-12T15:00:00.000Z"),
    });
    const payload = {
      profileHash: compiled.profileHash,
      workspaceId: "ws-1",
      request: attentionRequest({ requestId: "attn-restart" }),
    };
    await expect(runtime1.deliverAttention(payload)).rejects.toThrow(/simulated_process_crash/u);
    expect(tokens.length).toBe(1);
    backend1.close();

    // New process after lease expiry resumes with the exact same provider token.
    crashAfterProviderAttempt = false;
    const backend2 = new SqliteEventStore(dbPath);
    const store2 = new EventStoreAttentionDeliveryStore(backend2, {
      ...opts,
      clock: () => new Date("2026-07-12T15:01:00.000Z"),
    });
    const runtime2 = createTrackerCeremonyRuntime({
      doctrine: compiled,
      policy: new DoctrineAttentionPolicy(compiled),
      adapter,
      store: store2,
      bindingResolver: { resolve: () => trustedBinding },
      lookupVerifiedEvent: () => undefined,
      clock: () => new Date("2026-07-12T16:00:00.000Z"),
    });
    const second = await runtime2.deliverAttention(payload);
    expect(second.requestId).toBe("attn-restart");
    expect(tokens.length).toBeGreaterThan(1);
    expect(new Set(tokens).size).toBe(second.actions.length);

    backend2.close();
    rmSync(dir, { recursive: true, force: true });
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
