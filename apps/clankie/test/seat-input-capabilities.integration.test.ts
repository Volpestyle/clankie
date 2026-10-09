import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import type { HarnessSeatAdapter, SeatControl } from "@clankie/agent-hosts";
import { OperatorFleetSeatSchema, parseProtocolResponse } from "@clankie/protocol";
import {
  HerdrWatchStore,
  type HerdrAgentSnapshot,
  type HerdrWatchRunner,
} from "../src/captain/herdr-watch.ts";
import { NextTurnMailbox } from "../src/captain/next-turn-mailbox.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

// Recorded controller declarations cross the real delivery fence, mailboxes,
// Herdr watch boundary and public roster schema. No model or terminal input.
function fixture(harness: string, owned = true) {
  const root = mkdtempSync(join(tmpdir(), "seat-input-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let agent: HerdrAgentSnapshot = {
    agent: harness,
    paneId: "w1:p1",
    terminalId: "seat1",
    title: "worker",
    status: "working",
    session: { source: `herdr:${harness}`, kind: "id", value: randomUUID() },
  };
  const next = new NextTurnMailbox(join(root, "next.json"));
  const live = new SeatOutbox();
  cleanup.push(() => live.close());
  const binding = () => agent.session!.value;
  const receiver = () => next.messageReceiver("seat1", binding(), live.boundTo(binding()));
  const writes: string[] = [];
  const control: SeatControl = {
    ref: { harness: harness as SeatControl["ref"]["harness"], sessionId: binding(), paneId: agent.paneId },
    ...(harness === "codex"
      ? {
          deliveryModes: ["steer" as const],
          stopTask: async (guard: () => Promise<void>) => {
            await guard();
            writes.push("stop");
            return { outcome: "stopped" as const, taskId: "original" };
          },
        }
      : harness === "opencode"
        ? { deliveryModes: ["queue" as const] }
        : {}),
    status: async () => "working",
    send: async (_text, options) => {
      await options?.beforeDispatch?.();
      writes.push(`native:${options?.delivery ?? "send"}`);
      return { outcome: "accepted", messageId: randomUUID(), deliveryStage: "delivered", state: "started" };
    },
    interrupt: async () => true, // Generic interrupt is deliberately not exact-task Stop.
    settled: async () => ({ type: "released", at: new Date().toISOString() }),
    close: async () => {},
  };
  const adapter: HarnessSeatAdapter = {
    harness: control.ref.harness,
    attach: async () => (owned ? control : undefined),
    start: async () => ({ outcome: "started", control }),
  };
  const runner: HerdrWatchRunner = {
    get: async () => agent,
    resolveTerminal: async () => agent,
    wait: async () => agent,
    paneProcesses: async () => [
      { pid: 123, name: "codex", argv: ["codex", "--remote", "unix:///tmp/recorded.sock"] },
    ],
    openFiles: async () => "",
    codexQueue: async () => {
      writes.push("queue");
      return true;
    },
    codexControl: async () => {
      writes.push("steer");
      return { outcome: "delivered", deliveryStage: "delivered" };
    },
  };
  const watch = new HerdrWatchStore(join(root, "watch.json"), {
    runner,
    seatAdapters: [adapter],
    messageReceiver: receiver,
  });
  cleanup.push(() => watch.close());
  const fallback = async () => {
    writes.push("mailbox");
    return next.store("seat1", binding(), "next prompt");
  };
  return {
    watch,
    next,
    live,
    binding,
    writes,
    fallback,
    runner,
    control,
    agent: () => agent,
    replace: () => {
      agent = { ...agent, session: { ...agent.session!, value: randomUUID() } };
    },
    roster: async () =>
      OperatorFleetSeatSchema.parse({
        seatId: "seat1",
        occupantId: binding(),
        personaId: "agent-1",
        harness,
        status: agent.status,
        title: "worker",
        inputCapabilities: await watch.inputCapabilities(agent),
      }),
  };
}

it.each([
  { harness: "codex", owned: true, modes: ["steer", "queue"], interrupt: true },
  { harness: "codex", owned: false, modes: ["queue", "steer"], interrupt: false },
  { harness: "opencode", owned: true, modes: ["queue"], interrupt: false },
  { harness: "pi", owned: true, modes: [], interrupt: false },
  { harness: "grok", owned: true, modes: [], interrupt: false },
  { harness: "pi", owned: false, modes: [], interrupt: false },
])(
  "publishes real native choices and refuses older-client unsupported choices: $harness owned=$owned",
  async ({ harness, owned, modes, interrupt }) => {
    const f = fixture(harness, owned);
    expect((await f.roster()).inputCapabilities).toEqual({
      deliveryModes: modes,
      interrupt,
      nextTurnOnly: false,
    });
    for (const delivery of ["steer", "queue"] as const) {
      const result = await f.watch.deliverToSeat("seat1", delivery, undefined, { delivery });
      expect(result.outcome).toBe(modes.includes(delivery) ? "delivered" : "undelivered");
      if (!modes.includes(delivery)) expect(result).toMatchObject({ deliveryStage: "rejected" });
    }
    const observed = await f.watch.nativeTaskObservation("seat1");
    if (observed)
      expect((await f.watch.stopNativeTask("seat1", observed.binding, async () => {})).outcome).toBe(
        interrupt ? "stopped" : "unsupported",
      );
    if (!modes.length) expect(f.writes).toEqual([]);
  },
);

it("a next-turn-only Claude refuses explicit Steer without writing or holding, while Queue remains available", async () => {
  const f = fixture("claude", false);
  f.next.observe("seat1", f.binding());
  expect((await f.roster()).inputCapabilities).toEqual({
    deliveryModes: ["queue"],
    interrupt: false,
    nextTurnOnly: true,
  });
  expect(await f.watch.deliverToSeat("seat1", "correction", f.fallback, { delivery: "steer" })).toMatchObject(
    { outcome: "undelivered", deliveryStage: "rejected" },
  );
  expect(f.writes).toEqual([]);
  expect(f.next.waiting("seat1", f.binding())).toBeUndefined();
  expect(
    await f.watch.deliverToSeat("seat1", "next prompt", f.fallback, { delivery: "queue" }),
  ).toMatchObject({ outcome: "delivered", deliveryStage: "stored" });
  expect(f.next.waiting("seat1", f.binding())?.stored).toBe(1);
});

it("a live Claude offers both modes only for its current poll binding, then loses Steer on replacement", async () => {
  const f = fixture("claude");
  const abort = new AbortController();
  const poll = f.live.poll(1000, abort.signal, f.binding());
  expect((await f.roster()).inputCapabilities).toEqual({
    deliveryModes: ["steer", "queue"],
    interrupt: false,
    nextTurnOnly: false,
  });
  expect(
    await f.watch.deliverToSeat(
      "seat1",
      "correction",
      async () => {
        f.writes.push("live");
        return { outcome: "delivered", deliveryStage: "delivered" };
      },
      { delivery: "steer" },
    ),
  ).toMatchObject({ outcome: "delivered" });
  f.replace();
  expect((await f.roster()).inputCapabilities?.deliveryModes).toEqual([]);
  expect(await f.watch.deliverToSeat("seat1", "changed", f.fallback, { delivery: "steer" })).toMatchObject({
    outcome: "undelivered",
    deliveryStage: "rejected",
  });
  expect(f.writes).toEqual(["live"]);
  abort.abort();
  await poll;
});

it("an unverified Claude or mailbox-only seat advertises no mode, and old response readers discard the additive field", async () => {
  const f = fixture("claude", false);
  const seat = await f.roster();
  expect(seat.inputCapabilities).toEqual({ deliveryModes: [], interrupt: false, nextTurnOnly: false });
  const old = OperatorFleetSeatSchema.omit({ inputCapabilities: true });
  expect(parseProtocolResponse(old, seat)).not.toHaveProperty("inputCapabilities");
  expect(old.safeParse(seat).success).toBe(false);
  for (const delivery of ["steer", "queue"] as const)
    expect(await f.watch.deliverToSeat("seat1", delivery, f.fallback, { delivery })).toMatchObject({
      outcome: "undelivered",
      deliveryStage: "rejected",
    });
  expect(f.writes).toEqual([]);
});

it("a generic mailbox does not make an unsupported explicit Queue available", async () => {
  const f = fixture("pi", false);
  expect(await f.watch.deliverToSeat("seat1", "next", f.fallback, { delivery: "queue" })).toMatchObject({
    outcome: "undelivered",
    deliveryStage: "rejected",
  });
  expect(f.writes).toEqual([]);
});

it("unowned Codex loses Steer without a reachable native endpoint and Queue without its queue route", async () => {
  const f = fixture("codex", false);
  f.runner.paneProcesses = async () => [{ pid: 123, name: "codex", argv: ["codex", "--no-daemon"] }];
  expect((await f.roster()).inputCapabilities?.deliveryModes).toEqual(["queue"]);
  expect(await f.watch.deliverToSeat("seat1", "steer", undefined, { delivery: "steer" })).toMatchObject({
    deliveryStage: "rejected",
  });
  delete f.runner.codexQueue;
  expect((await f.roster()).inputCapabilities?.deliveryModes).toEqual([]);
  expect(f.writes).toEqual([]);
});

it("capabilities do not bypass Stop authorization, and a mid-observation occupant change clears them", async () => {
  const f = fixture("codex");
  const observed = await f.watch.nativeTaskObservation("seat1");
  expect(observed).toBeDefined();
  await expect(
    f.watch.stopNativeTask("seat1", observed!.binding, async () => {
      throw new Error("revoked");
    }),
  ).rejects.toThrow("revoked");
  expect(f.writes).toEqual([]);
  f.control.status = async () => {
    f.replace();
    return "working";
  };
  expect(await f.watch.inputCapabilities(f.agent())).toEqual({
    deliveryModes: [],
    interrupt: false,
    nextTurnOnly: false,
  });
});
