import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { HarnessSeatAdapter, SeatControl } from "@clankie/agent-hosts";
import { createFleetSeatControl } from "../src/captain/fleet-seat-control.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "../src/captain/herdr-watch.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-delivery-fence-"));
  roots.push(root);
  let agent: HerdrAgentSnapshot = {
    paneId: "w1:p1",
    terminalId: "seat1",
    agent: "claude",
    status: "idle",
    title: "worker",
    session: { source: "herdr:claude", kind: "id", value: "session1" },
  };
  const entries: { type: "message"; role: "operator"; id: string; text: string }[] = [
    { type: "message", role: "operator", id: "old", text: "original" },
  ];
  const send = vi
    .fn<SeatControl["send"]>()
    .mockResolvedValue({ outcome: "unconfirmed", messageId: "native-id", detail: "lost receipt" });
  const control: SeatControl = {
    ref: { harness: "claude", paneId: agent.paneId, sessionId: "session1" },
    send,
    status: async () => "idle",
    settled: async () => ({ type: "released", at: new Date().toISOString() }),
    interrupt: async () => false,
    close: async () => {},
  };
  const adapter: HarnessSeatAdapter = {
    harness: "claude",
    attach: async () => control,
    start: async () => ({ outcome: "started", control }),
  };
  const runner: HerdrWatchRunner = {
    get: async () => agent,
    resolveTerminal: async () => agent,
    wait: async () => agent,
    transcript: async () => ({ sessionKey: "session1", entries: [...entries] }),
  };
  const create = () =>
    createFleetSeatControl(
      runner,
      new Map([["claude", adapter]]),
      undefined,
      undefined,
      undefined,
      join(root, "receipts.json"),
    );
  return {
    create,
    entries,
    send,
    setSession: (value: string) => {
      agent = { ...agent, session: { source: "herdr:claude", kind: "id", value } };
    },
  };
}
it("blocks explicit native retry across restart until a new full receipt appears in the same session", async () => {
  const { create, entries, send, setSession } = fixture();
  await expect(create().deliverToSeat("seat1", "original")).resolves.toMatchObject({
    deliveryStage: "uncertain",
  });
  const restarted = create();
  const mailbox = vi.fn();
  await expect(restarted.deliverToSeat("seat1", "original", mailbox)).resolves.toMatchObject({
    deliveryStage: "uncertain",
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(mailbox).not.toHaveBeenCalled();
  entries.push({ type: "message", role: "operator", id: "new", text: "original" });
  setSession("different-session");
  await expect(restarted.deliverToSeat("seat1", "original")).resolves.toMatchObject({
    deliveryStage: "uncertain",
  });
  setSession("session1");
  await expect(restarted.deliverToSeat("seat1", "original")).resolves.toMatchObject({
    deliveryStage: "consumed",
    messageId: "new",
  });
  expect(send).toHaveBeenCalledTimes(1);
  send.mockResolvedValueOnce({ outcome: "accepted", messageId: "next", state: "queued" });
  await expect(restarted.deliverToSeat("seat1", "next message")).resolves.toMatchObject({
    deliveryStage: "consumed",
    state: "queued",
  });
  expect(send).toHaveBeenCalledTimes(2);
});
it("does not claim a different follow-up was sent when reconciling the original", async () => {
  const { create, entries, send } = fixture();
  const native = create();
  await native.deliverToSeat("seat1", "original");
  entries.push({ type: "message", role: "operator", id: "new", text: "original" });
  await expect(native.deliverToSeat("seat1", "different")).resolves.toMatchObject({ outcome: "undelivered" });
  expect(send).toHaveBeenCalledTimes(1);
});

it("retains explicit stable native completions across restart and refuses changed content for the same ID", async () => {
  const { create, send } = fixture();
  send.mockResolvedValue({ outcome: "accepted", messageId: "accepted-native", state: "queued" });
  const guard = async () => {};
  expect(
    await create().deliverToSeat("seat1", "approval", undefined, guard, "linear:original-author:event"),
  ).toMatchObject({ outcome: "delivered", messageId: "accepted-native" });
  const restarted = create();
  expect(
    await restarted.deliverToSeat("seat1", "approval", undefined, guard, "linear:original-author:event"),
  ).toMatchObject({ outcome: "delivered", messageId: "accepted-native" });
  expect(
    await restarted.deliverToSeat(
      "seat1",
      "changed approval",
      undefined,
      guard,
      "linear:original-author:event",
    ),
  ).toMatchObject({ outcome: "undelivered" });
  expect(send).toHaveBeenCalledTimes(1);
});

it("keeps a reconciled stable delivery receipt even when the retry supplied conflicting content", async () => {
  const { create, send, entries } = fixture();
  const guard = async () => {};
  await create().deliverToSeat("seat1", "approval", undefined, guard, "linear:event");
  entries.push({ type: "message", role: "operator", id: "native-approval", text: "approval" });
  const restarted = create();
  expect(await restarted.deliverToSeat("seat1", "changed", undefined, guard, "linear:event")).toMatchObject({
    outcome: "undelivered",
  });
  expect(await restarted.deliverToSeat("seat1", "approval", undefined, guard, "linear:event")).toMatchObject({
    outcome: "delivered",
    messageId: "native-approval",
  });
  expect(send).toHaveBeenCalledTimes(1);
});

it("linearizes concurrent stable retries before sending to the native channel", async () => {
  const { create, send } = fixture();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  send.mockImplementation(async () => {
    await pending;
    return { outcome: "accepted", messageId: "once", state: "started" };
  });
  const native = create();
  const guard = async () => {};
  const first = native.deliverToSeat("seat1", "approval", undefined, guard, "linear:event");
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(await native.deliverToSeat("seat1", "approval", undefined, guard, "linear:event")).toMatchObject({
    outcome: "unconfirmed",
  });
  release();
  expect(await first).toMatchObject({ outcome: "delivered" });
  expect(await native.deliverToSeat("seat1", "approval", undefined, guard, "linear:event")).toMatchObject({
    outcome: "delivered",
  });
  expect(send).toHaveBeenCalledTimes(1);
});
