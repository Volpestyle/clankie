import { expect, it } from "vitest";
import { OperatorSeatMoveResultSchema, OperatorSeatSpawnResultSchema } from "../src/index.ts";

it.each([
  { mode: "channel" },
  { mode: "adapter" },
  { mode: "terminal", reason: "no_brief", detail: "No brief supplied." },
  { mode: "terminal", reason: "consent_required", detail: "Not approved.", fix: "Approve the channel." },
])("preserves hire control metadata through the public result schema: $mode", (control) => {
  const result = {
    outcome: "spawned",
    seat: {
      seatId: "seat",
      occupantId: "occupant",
      personaId: "worker",
      harness: "claude",
      status: "idle",
      title: "Worker",
    },
    control,
  };
  expect(OperatorSeatSpawnResultSchema.parse(result)).toEqual(result);
});

it("preserves folder trust blockers and their selected lane for hires and moves", () => {
  const result = {
    outcome: "failed",
    reason: "trust_required",
    detail: "Review folder trust.",
    control: { mode: "channel" },
  };
  expect(OperatorSeatSpawnResultSchema.parse(result)).toEqual(result);
  expect(OperatorSeatMoveResultSchema.parse(result)).toEqual(result);
});
