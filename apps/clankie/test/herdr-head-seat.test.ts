import { describe, expect, it } from "vitest";
import { readFleet } from "../src/captain/herdr-census.ts";

const list = {
  result: {
    agents: [
      {
        pane_id: "w1:p2",
        name: "clankie",
        agent: "claude",
        agent_status: "working",
        title: "Clankie",
        terminal_id: "term-seat",
        cwd: "/Users/me/dev/project",
        agent_session: { source: "herdr:claude", kind: "id", value: "abc" },
      },
      {
        pane_id: "w1:p3",
        name: "atlas",
        agent: "codex",
        agent_status: "idle",
        title: "atlas",
        terminal_id: "term-atlas",
        agent_session: { source: "herdr:codex", kind: "id", value: "def" },
      },
      {
        pane_id: "w1:p4",
        agent: "clankie",
        agent_status: "idle",
        title: "Clankie console",
        terminal_id: "term-console",
        agent_session: { source: "clankie", kind: "id", value: "conv" },
      },
    ],
  },
};

/** A pane named clankie is his head, never a fleet contact (ADR 0152). */
describe("the head seat in the census", () => {
  it("lifts the pane named clankie out of the fleet as the head", async () => {
    const fleet = await readFleet({ runCommand: async () => ({ stdout: JSON.stringify(list), stderr: "" }) });
    expect(fleet.head).toEqual({
      seatId: "term-seat",
      paneId: "w1:p2",
      occupantId: expect.stringMatching(/^session-[a-f0-9]{64}$/u),
      harness: "claude",
      status: "working",
    });
    expect(fleet.seats.map((seat) => seat.seatId)).toEqual(["term-atlas"]);
  });

  it("reports no head when no pane holds the name, and nothing at all when herdr is down", async () => {
    const withoutHead = { result: { agents: list.result.agents.slice(1) } };
    const fleet = await readFleet({
      runCommand: async () => ({ stdout: JSON.stringify(withoutHead), stderr: "" }),
    });
    expect(fleet.head).toBeUndefined();
    expect(fleet.seats).toHaveLength(1);
    const down = await readFleet({
      runCommand: async () => {
        throw new Error("socket down");
      },
    });
    expect(down).toEqual({ seats: [] });
  });
});
