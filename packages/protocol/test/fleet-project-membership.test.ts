import { expect, it, vi } from "vitest";
import {
  ReadFleetProjectMembershipSchema,
  readFleetProjectMembership,
  fleetProjectMembershipApplies,
  type FleetProjectMembershipSnapshot,
} from "../src/projects.ts";
import { OperatorFleetSnapshotSchema } from "../src/index.ts";
const input = { schemaVersion: 1 as const, seats: [{ seatId: "seat", occupantId: "session-hash" }] };
const result: FleetProjectMembershipSnapshot = {
  schemaVersion: 1,
  projectsRevision: "a".repeat(64),
  observedAt: new Date().toISOString(),
  seats: [{ ...input.seats[0]!, membership: { outcome: "member", source: "hire", projectId: "repo" } }],
};
it("leaves the existing strict fleet DTO compatible and rejects unsolicited membership fields", () => {
  const fleet = { schemaVersion: 1, cursor: "instance:0", seats: [], personas: [], channels: [] };
  expect(OperatorFleetSnapshotSchema.parse(fleet)).toEqual(fleet);
  expect(() => OperatorFleetSnapshotSchema.parse({ ...fleet, memberships: [] })).toThrow();
});
it.each([404, 405, 501])("treats old-host %s as unavailable, never empty membership", async (status) => {
  const send = vi.fn(async () => ({ status, json: async () => ({}) }));
  expect(await readFleetProjectMembership(input, send)).toBeUndefined();
  expect(send).toHaveBeenCalledTimes(1);
});
it.each([401, 403, 409, 503])("preserves failed %s response without retry", async (status) => {
  const send = vi.fn(async () => ({ status, json: async () => result }));
  await expect(readFleetProjectMembership(input, send)).rejects.toThrow();
  expect(send).toHaveBeenCalledTimes(1);
});
it("validates exact response correlation and refuses raw proof additions", async () => {
  expect(
    await readFleetProjectMembership(input, async () => ({ status: 200, json: async () => result })),
  ).toEqual(result);
  for (const bad of [
    { ...result, proof: {} },
    { ...result, seats: [] },
    { ...result, seats: [{ ...result.seats[0], occupantId: "replacement" }] },
  ])
    await expect(
      readFleetProjectMembership(input, async () => ({ status: 200, json: async () => bad })),
    ).rejects.toThrow();
  expect(() => ReadFleetProjectMembershipSchema.parse({ ...input, projectId: "claimed" })).toThrow();
});
it.each(["disconnect", "generation", "settings", "age", "seat", "missing"])(
  "rejects stale %s receipt instead of retaining placement",
  (kind) => {
    const current = {
      connected: true,
      sameGeneration: true,
      projectsRevision: result.projectsRevision,
      ageMs: 0,
      seats: input.seats,
    };
    expect(fleetProjectMembershipApplies(result, input, current)).toBe(true);
    const changed = {
      ...current,
      ...(kind === "disconnect"
        ? { connected: false }
        : kind === "generation"
          ? { sameGeneration: false }
          : kind === "settings"
            ? { projectsRevision: "b".repeat(64) }
            : kind === "age"
              ? { ageMs: 5001 }
              : kind === "seat"
                ? { seats: [{ seatId: "seat", occupantId: "replacement" }] }
                : {}),
    };
    expect(fleetProjectMembershipApplies(kind === "missing" ? undefined : result, input, changed)).toBe(
      false,
    );
  },
);
it("does not publish a response after caller abort", async () => {
  const controller = new AbortController();
  await expect(
    readFleetProjectMembership(
      input,
      async () => {
        controller.abort();
        return { status: 200, json: async () => result };
      },
      controller.signal,
    ),
  ).rejects.toThrow();
});
