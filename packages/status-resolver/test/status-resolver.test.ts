import { describe, expect, it } from "vitest";
import type { DomainEvent, WorkerStatusState } from "@clankie/protocol";
import {
  AgentStatusResolver,
  STATUS_SIGNAL_EVENT_TYPE,
  explainStatusFromEvents,
  formatStatusExplain,
  type AgentStatusSignalInput,
} from "../src/index.ts";

const KNOWN_STATES: WorkerStatusState[] = [
  "working",
  "idle",
  "waiting_dependency",
  "waiting_user",
  "blocked",
  "failed",
  "completed",
  "offline",
];

function signal(
  state: WorkerStatusState,
  tier: 0 | 1 | 2,
  observedAt = "2026-07-11T12:00:00.000Z",
): AgentStatusSignalInput {
  return {
    state,
    tier,
    source: `tier-${String(tier)}-test`,
    confidence: tier === 2 ? 0.73 : 1,
    observedAt,
  };
}

function event(
  type: string,
  data: Record<string, unknown>,
  index: number,
  workerRunId = "run-1",
): DomainEvent {
  return {
    id: `event-${String(index)}`,
    occurredAt: new Date(Date.UTC(2026, 6, 11, 12, 0, index)).toISOString(),
    missionId: "mission-1",
    taskId: "task-1",
    workerRunId,
    correlationId: "correlation-1",
    profileHash: "profile-1",
    type,
    data,
  };
}

function captainEvent(type: string, data: Record<string, unknown>, index: number): DomainEvent {
  return {
    id: `captain-event-${String(index)}`,
    occurredAt: new Date(Date.UTC(2026, 6, 11, 12, 0, index)).toISOString(),
    missionId: "captain-presence",
    correlationId: "generation-1",
    profileHash: "profile-1",
    type,
    data: {
      schemaVersion: 1,
      subjectId: "captain",
      captainId: "captain-eve",
      leaseId: "lease-1",
      generationId: "generation-1",
      confidence: 1,
      observedAt: new Date(Date.UTC(2026, 6, 11, 12, 0, index)).toISOString(),
      ...data,
    },
  };
}

describe("AgentStatusResolver", () => {
  it("property: Tier 2 never overrides a known Tier-0/1 state in either arrival order", () => {
    for (const tier of [0, 1] as const) {
      for (const highState of KNOWN_STATES) {
        for (const tierTwoState of KNOWN_STATES) {
          for (const order of ["higher-first", "tier-two-first"] as const) {
            const resolver = new AgentStatusResolver();
            if (order === "higher-first") {
              resolver.ingest("run", signal(highState, tier));
              resolver.ingest("run", signal(tierTwoState, 2, "2026-07-11T12:00:01.000Z"));
            } else {
              resolver.ingest("run", signal(tierTwoState, 2));
              resolver.ingest("run", signal(highState, tier, "2026-07-11T12:00:01.000Z"));
            }
            const resolved = resolver.explain("run");
            expect(resolved).toMatchObject({ state: highState, winner: { tier } });
          }
        }
      }
    }
  });

  it("lets Tier 2 fill unknown and retain attention without replacing a live fact", () => {
    const resolver = new AgentStatusResolver();
    resolver.ingest("run", signal("unknown", 1));
    expect(resolver.ingest("run", signal("idle", 2))).toMatchObject({
      state: "idle",
      winner: { tier: 2 },
      signalChain: [
        expect.objectContaining({ tier: 1, disposition: "unknown_filled" }),
        expect.objectContaining({ tier: 2, disposition: "winner" }),
      ],
    });

    resolver.ingest("run", signal("working", 0, "2026-07-11T12:00:02.000Z"));
    const attention = resolver.ingest("run", {
      ...signal("waiting_user", 2, "2026-07-11T12:00:03.000Z"),
      questionSummary: "Should I proceed?",
    });
    expect(attention).toMatchObject({
      state: "working",
      winner: { tier: 0 },
      attention: [
        expect.objectContaining({
          state: "waiting_user",
          disposition: "attention_only",
          questionSummary: "Should I proceed?",
        }),
      ],
    });

    const cleared = resolver.ingest("run", signal("idle", 2, "2026-07-11T12:00:04.000Z"));
    expect(cleared).toMatchObject({ state: "working", winner: { tier: 0 }, attention: [] });
  });

  it("distinguishes a settled turn from a terminal settled worker", () => {
    const resolver = new AgentStatusResolver();
    resolver.ingestDomainEvent(
      event(
        "worker.turn.started",
        {
          state: "working",
          tier: 0,
          source: "codex.app_server",
          confidence: 1,
          observedAt: "2026-07-11T12:00:00.000Z",
        },
        0,
      ),
    );
    expect(
      resolver.ingestDomainEvent(
        event(
          "worker.turn.settled",
          {
            state: "idle",
            tier: 0,
            source: "codex.app_server",
            confidence: 1,
            observedAt: "2026-07-11T12:00:01.000Z",
          },
          1,
        ),
      ),
    ).toMatchObject({ state: "idle", basis: "turn_settled", winner: { tier: 0 } });

    expect(
      resolver.ingestDomainEvent(
        event(
          "worker.settled",
          { attempt: 1, result: { status: "succeeded", summary: "done", evidence: [], outputs: {} } },
          2,
        ),
      ),
    ).toMatchObject({
      state: "completed",
      basis: "worker_settled",
      winner: { tier: 1, source: "mission-engine.settlement" },
      signalChain: [
        expect.objectContaining({ basis: "turn_started", disposition: "invalidated" }),
        expect.objectContaining({ basis: "turn_settled", disposition: "invalidated" }),
        expect.objectContaining({ basis: "worker_settled", disposition: "winner" }),
      ],
    });
  });

  it("accepts generic Tier-1/2 control signals but rejects forged Tier 0", () => {
    const resolver = new AgentStatusResolver();
    expect(
      resolver.ingestDomainEvent(
        event(
          STATUS_SIGNAL_EVENT_TYPE,
          {
            state: "waiting_user",
            tier: 2,
            source: "settle-classifier",
            confidence: 0.81,
            observedAt: "2026-07-11T12:00:00.000Z",
            questionSummary: "Choose a path",
          },
          0,
        ),
      ),
    ).toMatchObject({ state: "waiting_user", basis: "heuristic", winner: { tier: 2 } });
    expect(
      resolver.ingestDomainEvent(
        event(
          STATUS_SIGNAL_EVENT_TYPE,
          {
            state: "working",
            tier: 0,
            source: "forged",
            confidence: 1,
            observedAt: "2026-07-11T12:00:01.000Z",
          },
          1,
        ),
      ),
    ).toBeUndefined();

    const lifecycle = new AgentStatusResolver();
    lifecycle.ingest("run-2", signal("working", 0));
    expect(
      lifecycle.ingestDomainEvent(
        event(
          STATUS_SIGNAL_EVENT_TYPE,
          {
            state: "offline",
            tier: 1,
            source: "runner.process_lease",
            confidence: 1,
            observedAt: "2026-07-11T12:00:02.000Z",
          },
          2,
          "run-2",
        ),
      ),
    ).toMatchObject({
      state: "offline",
      basis: "worker_offline",
      signalChain: [
        expect.objectContaining({ tier: 0, disposition: "invalidated" }),
        expect.objectContaining({ tier: 1, disposition: "winner" }),
      ],
    });
  });

  it("replays identical output and renders a complete status explanation", () => {
    const events = [
      event("worker.leased", { claimId: "claim-1" }, 0),
      event(
        "worker.turn.started",
        {
          state: "working",
          tier: 0,
          source: "claude.agent_sdk",
          confidence: 1,
          observedAt: "2026-07-11T12:00:01.000Z",
        },
        1,
      ),
      event(
        STATUS_SIGNAL_EVENT_TYPE,
        {
          state: "waiting_user",
          tier: 2,
          source: "settle-classifier",
          confidence: 0.88,
          observedAt: "2026-07-11T12:00:02.000Z",
          questionSummary: "Need a decision",
        },
        2,
      ),
    ];
    const live = new AgentStatusResolver();
    for (const item of events) live.ingestDomainEvent(item);
    const replayed = explainStatusFromEvents(events, "run-1");
    expect(replayed).toEqual(live.explain("run-1"));

    const output = formatStatusExplain(replayed as NonNullable<typeof replayed>);
    expect(output).toContain("Current: working (turn_started)");
    expect(output).toContain("Winner: tier 0 · claude.agent_sdk · confidence 1.00");
    expect(output).toContain("[attention_only] waiting_user (heuristic) · tier 2");
    expect(output).toContain("2026-07-11T12:00:02.000Z");
    expect(output).toContain("Need a decision");
  });

  it("replays captain lifecycle, attention precedence, expiry, and restart", () => {
    const lease = {
      heartbeatAt: "2026-07-11T12:00:00.000Z",
      expiresAt: "2026-07-11T12:00:30.000Z",
      tier: 1,
      source: "control-plane.captain_lease",
    };
    const turn = {
      sessionId: "session-1",
      turnId: "turn-1",
      tier: 0,
      source: "eve.lifecycle",
    };
    const events = [
      captainEvent("captain.presence.online", { ...lease, state: "idle" }, 0),
      captainEvent("captain.turn.started", { ...turn, state: "working" }, 1),
      captainEvent(
        "captain.turn.settled",
        { ...turn, state: "waiting_user", questionSummary: "Approve the deployment?" },
        2,
      ),
      captainEvent(
        "captain.heartbeat",
        {
          ...lease,
          state: "idle",
          heartbeatAt: "2026-07-11T12:00:03.000Z",
          expiresAt: "2026-07-11T12:00:33.000Z",
        },
        3,
      ),
    ];
    expect(explainStatusFromEvents(events, "captain")).toMatchObject({
      state: "waiting_user",
      basis: "waiting_user",
      tier: 0,
      winner: { questionSummary: "Approve the deployment?" },
    });

    events.push(captainEvent("captain.turn.started", { ...turn, state: "working" }, 4));
    events.push(
      captainEvent("captain.turn.settled", { ...turn, state: "idle" }, 5),
      captainEvent(
        "captain.presence.offline",
        {
          ...lease,
          state: "offline",
          reason: "lease_expired",
          heartbeatAt: "2026-07-11T12:00:03.000Z",
          expiresAt: "2026-07-11T12:00:33.000Z",
        },
        6,
      ),
    );
    expect(explainStatusFromEvents(events, "captain")).toMatchObject({
      state: "offline",
      basis: "captain_offline",
      tier: 1,
    });

    events.push(
      captainEvent(
        "captain.presence.online",
        {
          ...lease,
          state: "idle",
          leaseId: "lease-2",
          generationId: "generation-2",
          heartbeatAt: "2026-07-11T12:00:07.000Z",
          expiresAt: "2026-07-11T12:00:37.000Z",
        },
        7,
      ),
    );
    const replayed = AgentStatusResolver.replay(events).explain("captain");
    expect(replayed).toEqual(explainStatusFromEvents(events, "captain"));
    expect(replayed).toMatchObject({ state: "idle", basis: "captain_presence", tier: 1 });
  });
});
