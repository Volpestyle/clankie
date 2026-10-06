import { expect, it } from "vitest";
import { OperatorPresenceRequestSchema, OperatorPresenceSnapshotSchema } from "../src/presence.ts";

const snapshot = {
  schemaVersion: 1,
  cursor: "one",
  mood: "thinking",
  detail: "Thinking",
  since: null,
  activeSeats: 0,
};
const activity = { label: "Working", kind: "working", since: null };

it("accepts absent activities and the explicit opt-in with bounded public facts", () => {
  expect(OperatorPresenceSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  expect(OperatorPresenceSnapshotSchema.parse({ ...snapshot, activities: [activity] }).activities).toEqual([
    activity,
  ]);
  expect(
    OperatorPresenceRequestSchema.parse({ op: "presence", schemaVersion: 1, includeActivities: true })
      .includeActivities,
  ).toBe(true);
});

it("rejects overflow, unknown kinds, raw prompts and invalid source timestamps", () => {
  for (const activities of [
    Array(4).fill(activity),
    [{ ...activity, label: "x".repeat(81) }],
    [{ ...activity, label: " " }],
    [{ ...activity, kind: "tool" }],
    [{ ...activity, since: "yesterday" }],
    [{ ...activity, prompt: "private input" }],
  ])
    expect(OperatorPresenceSnapshotSchema.safeParse({ ...snapshot, activities }).success).toBe(false);
  expect(
    OperatorPresenceSnapshotSchema.safeParse({
      ...snapshot,
      activities: [{ ...activity, since: "2026-10-06T20:00:00.000Z" }],
    }).success,
  ).toBe(true);
});
