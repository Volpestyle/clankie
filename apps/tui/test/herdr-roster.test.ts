import { expect, it } from "vitest";
import { OperatorFleetSeatSchema } from "@clankie/protocol";
import { HerdrRoster } from "../src/observation/herdr-roster.ts";

it("shows the service fleet in every console and reports a failed read", async () => {
  let failed = false;
  const seat = OperatorFleetSeatSchema.parse({
    seatId: "terminal-1",
    occupantId: "agent-1",
    personaId: "persona-1",
    harness: "codex",
    status: "working",
    title: "fixing tests",
  });
  const client = {
    roster: async () => {
      if (failed) throw new Error("service unavailable");
      return [seat];
    },
    terminalCatalog: async () => [
      {
        terminalId: "terminal-1",
        label: "tests",
        workspace: { id: "w1", number: 1, label: "work" },
        tab: { id: "w1:t1", number: 1, label: "work" },
        pane: { id: "w1:p1" },
      },
    ],
  };
  // No caller environment or local CLI enters this path.
  const consoles = [new HerdrRoster(client), new HerdrRoster(client)];
  for (const console of consoles) {
    expect(await console.poll()).toBe(true);
    expect(console.snapshot()).toEqual({
      agents: [{ paneId: "w1:p1", agent: "codex", status: "working", title: "fixing tests" }],
    });
    expect(await console.poll()).toBe(false);
  }
  failed = true;
  await consoles[0]!.poll();
  expect(consoles[0]!.snapshot()).toEqual({ agents: [], error: "service unavailable" });
});
