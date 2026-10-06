import { expect, test, vi } from "vitest";
import type { SeatControl } from "@clankie/agent-hosts";
import { fenceFleetSeatAdapter } from "../src/captain/fleet-seat-boundary.ts";
import { readFleet, readHerdrSessionCensus } from "../src/captain/herdr-census.ts";

test("retained controller loses authority after removal and same-id replacement without stopping worker", async () => {
  let revision = 1;
  const send = vi.fn(async () => ({ outcome: "released" as const }));
  const close = vi.fn(async () => {});
  const interrupt = vi.fn(async () => true);
  const control: SeatControl = {
    ref: { harness: "codex", sessionId: "old", paneId: "pc/p1" },
    send,
    close,
    interrupt,
    status: async () => "idle",
    settled: async () => ({ type: "released", at: "now" }),
  };
  const attach = vi.fn(async () => control);
  const start = vi.fn(async () => ({ outcome: "started" as const, control }));
  const adapter = fenceFleetSeatAdapter({ harness: "codex", start, attach }, async () => revision === 1);
  const retained = (await adapter.attach(control.ref))!;
  await retained.send("first");
  revision = 3;
  expect(await retained.send("must not reach replacement")).toMatchObject({ outcome: "offline" });
  expect(await retained.status()).toBe("offline");
  expect(await retained.interrupt()).toBe(false);
  await retained.close();
  expect(await retained.settled()).toMatchObject({ type: "released" });
  expect(await adapter.attach(control.ref)).toBeUndefined();
  expect(
    await adapter.start(
      { harness: "codex", cwd: "/tmp", brief: "no" },
      { paneId: "pc/p1", run: async () => {} },
    ),
  ).toMatchObject({ outcome: "failed" });
  expect(send).toHaveBeenCalledTimes(1);
  expect(close).not.toHaveBeenCalled();
  expect(interrupt).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});

test("disabled default does not hide connected fleet census or probe the default socket", async () => {
  const local = vi.fn(async () => {
    throw new Error("must not query default");
  });
  const agents = [
    {
      pane_id: "w2:p1",
      terminal_id: "term",
      agent: "codex",
      agent_status: "idle",
      agent_session: { source: "herdr:codex", kind: "id", value: "native-session" },
    },
  ];
  const remote = vi.fn(async (args: readonly string[]) => {
    if (args.join(" ") === "agent list")
      return JSON.stringify({ result: { agents: structuredClone(agents) } });
    if (args.join(" ") === "api snapshot")
      return JSON.stringify({ result: { snapshot: { agents: structuredClone(agents) } } });
    throw new Error(`Unexpected remote census command: ${args.join(" ")}`);
  });
  const fleets = [{ id: "pc", host: "pc", session: "work", run: remote }];
  const fleet = await readFleet({ localAvailable: false, runCommand: local, fleets });
  expect(fleet.seats.map((seat) => seat.seatId)).toContain("pc/term");
  const census = await readHerdrSessionCensus(undefined, {
    localAvailable: false,
    runCommand: local,
    fleets,
  });
  expect(census).toMatchObject({ outcome: "ok", text: expect.stringContaining("HERDR FLEET pc") });
  expect(remote).toHaveBeenCalled();
  expect(local).not.toHaveBeenCalled();
});
