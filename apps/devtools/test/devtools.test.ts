import { describe, expect, it } from "vitest";
import { DomainEventSchema } from "@sapling/protocol";

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
});
