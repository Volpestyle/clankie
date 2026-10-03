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
