import { describe, expect, it } from "vitest";
import { DomainEventSchema } from "@clankie/protocol";
import { statusExplain } from "../src/status.ts";

describe("devtools fixtures", () => {
  it("accepts the semantic event envelope used by replay", () => {
    expect(
      DomainEventSchema.parse({
        id: "e",
        occurredAt: "2026-07-10T00:00:00.000Z",
        missionId: "m",
        correlationId: "c",
        profileHash: "p",
        type: "worker.started",
        data: {},
      }).type,
    ).toBe("worker.started");
  });

  it("explains status from semantic events without terminal frames", () => {
    const base = {
      occurredAt: "2026-07-11T00:00:00.000Z",
      missionId: "m",
      taskId: "t",
      workerRunId: "run-1",
      correlationId: "c",
      profileHash: "p",
    };
    const output = statusExplain(
      [
        DomainEventSchema.parse({
          ...base,
          id: "e-1",
          type: "worker.turn.settled",
          data: {
            state: "idle",
            tier: 0,
            source: "pi.rpc",
            confidence: 1,
            observedAt: "2026-07-11T00:00:00.000Z",
          },
        }),
        DomainEventSchema.parse({
          ...base,
          id: "e-2",
          occurredAt: "2026-07-11T00:00:01.000Z",
          type: "worker.status.signal",
          data: {
            state: "waiting_user",
            tier: 2,
            source: "settle-classifier",
            confidence: 0.8,
            observedAt: "2026-07-11T00:00:01.000Z",
            questionSummary: "Choose one",
          },
        }),
      ],
      "run-1",
    );

    expect(output).toContain("Current: idle (turn_settled)");
    expect(output).toContain("Winner: tier 0 · pi.rpc · confidence 1.00");
    expect(output).toContain("[attention_only] waiting_user (heuristic)");
    expect(output).toContain("Choose one");
  });
});
