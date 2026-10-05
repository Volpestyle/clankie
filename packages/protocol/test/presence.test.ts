import { expect, it } from "vitest";
import { OperatorPresenceRequestSchema, OperatorPresenceResultSchema } from "../src/presence.ts";

it("accepts legacy presence and optional desktop faces independently of mood over JSON", () => {
  const legacy = {
    op: "presence",
    schemaVersion: 1,
    snapshot: {
      schemaVersion: 1,
      cursor: "legacy",
      mood: "idle",
      detail: "Taking a break",
      since: null,
      activeSeats: 0,
    },
  };
  const receive = (value: unknown) => OperatorPresenceResultSchema.parse(JSON.parse(JSON.stringify(value)));
  expect(
    OperatorPresenceRequestSchema.parse({ op: "presence", schemaVersion: 1 }).includeFace,
  ).toBeUndefined();
  expect(
    OperatorPresenceRequestSchema.parse({ op: "presence", schemaVersion: 1, includeFace: true }).includeFace,
  ).toBe(true);
  expect(receive(legacy).snapshot.face).toBeUndefined();
  for (const face of ["working", "new_message", "needs_you", "error", "voice"])
    expect(receive({ ...legacy, snapshot: { ...legacy.snapshot, face } }).snapshot).toMatchObject({
      mood: "idle",
      face,
    });
  expect(() => receive({ ...legacy, snapshot: { ...legacy.snapshot, face: "offline" } })).toThrow();
});
