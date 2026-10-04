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

it("peer receipt reads never dispatch, even when no pending native fence remains", async () => {
  const { create, entries, send } = fixture();
  const native = create();
  const mailbox = vi.fn();
  expect(await native.deliverToSeat("seat1", "original", mailbox, { reconcileOnly: true })).toMatchObject({
    deliveryStage: "uncertain",
  });
  expect(send).not.toHaveBeenCalled();
  expect(mailbox).not.toHaveBeenCalled();
  await native.deliverToSeat("seat1", "original");
  entries.push({ type: "message", role: "operator", id: "new", text: "original" });
  expect(await native.deliverToSeat("seat1", "different", mailbox, { reconcileOnly: true })).toMatchObject({
    deliveryStage: "uncertain",
  });
  expect(await native.deliverToSeat("seat1", "original", mailbox, { reconcileOnly: true })).toMatchObject({
    deliveryStage: "consumed",
  });
  expect(await native.deliverToSeat("seat1", "original", mailbox, { reconcileOnly: true })).toMatchObject({
    deliveryStage: "uncertain",
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(mailbox).not.toHaveBeenCalled();
});

it("peer authority is rechecked after awaited native attachment before any send", async () => {
  const { create, send } = fixture();
  const fence = vi.fn(async () => false);
  expect(await create().deliverToSeat("seat1", "peer", undefined, { fence })).toMatchObject({
    outcome: "undelivered",
  });
  expect(fence).toHaveBeenCalledOnce();
  expect(send).not.toHaveBeenCalled();
});

it("refuses a different sender's unsent original without inheriting another delivery's uncertainty", async () => {
  const { create, send } = fixture();
  const native = create();
  expect(await native.deliverToSeat("seat1", "sender one original")).toMatchObject({
    deliveryStage: "uncertain",
  });
  expect(await native.deliverToSeat("seat1", "sender two original")).toMatchObject({
    outcome: "undelivered",
    deliveryStage: "unavailable",
  });
  expect(
    await native.deliverToSeat("seat1", "sender one original", undefined, { reconcileOnly: true }),
  ).toMatchObject({ deliveryStage: "uncertain" });
  expect(send).toHaveBeenCalledTimes(1);
});

it("reconciles a cleared native receipt only from the complete original UUID-bearing peer message", async () => {
  const { create, entries, send } = fixture();
  const originalId = "10000000-0000-4000-8000-000000000001";
  const text = `Peer message ${originalId} from seat one to seat two.\nAgent output.\nhello`;
  entries.push({ type: "message", role: "operator", id: "accepted-before-restart", text });
  const native = create();
  expect(
    await native.deliverToSeat("seat1", text, undefined, { reconcileOnly: true, originalId }),
  ).toMatchObject({
    deliveryStage: "consumed",
    messageId: "accepted-before-restart",
  });
  expect(
    await native.deliverToSeat("seat1", text, undefined, {
      reconcileOnly: true,
      originalId: "20000000-0000-4000-8000-000000000002",
    }),
  ).toMatchObject({ deliveryStage: "uncertain" });
  expect(send).not.toHaveBeenCalled();
});
