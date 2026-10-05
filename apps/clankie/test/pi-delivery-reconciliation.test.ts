import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { HarnessSeatAdapter, SeatControl } from "@clankie/agent-hosts";
import { parseHerdrSeatTranscript } from "@clankie/agent-transcript";
import { createFleetSeatControl } from "../src/captain/fleet-seat-control.ts";
import { DeliveryFence, deliveryFingerprint } from "../src/captain/delivery-fence.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "../src/captain/herdr-watch.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-reconcile-"));
  roots.push(root);
  const sessionId = randomUUID();
  const requestId = randomUUID();
  const nativePath = `/native/timestamp_${sessionId}.jsonl`;
  let agent: HerdrAgentSnapshot = {
    paneId: "w1:p1",
    terminalId: "seat",
    agent: "pi",
    status: "idle",
    title: "worker",
    session: { source: "herdr:pi", kind: "path", value: nativePath },
  };
  const rows: unknown[] = [{ type: "session", version: 3, id: sessionId }];
  const send = vi
    .fn<SeatControl["send"]>()
    .mockResolvedValue({ outcome: "unconfirmed", messageId: requestId, detail: "lost native receipt" });
  const control: SeatControl = {
    ref: { harness: "pi", sessionId, paneId: agent.paneId },
    send,
    status: async () => "idle",
    settled: async () => ({ type: "released", at: "now" }),
    interrupt: async () => false,
    close: async () => {},
  };
  const adapter: HarnessSeatAdapter = {
    harness: "pi",
    start: async () => ({ outcome: "started", control }),
    attach: async (ref) => (ref.sessionId === sessionId && ref.paneId === agent.paneId ? control : undefined),
  };
  const runner: HerdrWatchRunner = {
    get: async () => agent,
    resolveTerminal: async () => agent,
    wait: async () => agent,
    transcript: async () => ({
      sessionKey: nativePath,
      entries: parseHerdrSeatTranscript("pi", rows.map((row) => JSON.stringify(row)).join("\n")),
    }),
  };
  const receipts = join(root, "receipts.json");
  const create = () =>
    createFleetSeatControl(runner, new Map([["pi", adapter]]), undefined, undefined, undefined, receipts);
  const append = (fields: Record<string, unknown> = {}) =>
    rows.push({
      type: "custom_message",
      id: `entry-${rows.length}`,
      parentId: null,
      customType: "clankie-worker-message",
      content: "original",
      display: true,
      details: { sessionId, requestId },
      ...fields,
    });
  return {
    create,
    append,
    rows,
    send,
    receipts,
    sessionId,
    requestId,
    nativePath,
    path: (value: string) => {
      agent = { ...agent, session: { source: "herdr:pi", kind: "path", value } };
    },
  };
}

test("Pi exact semantic native receipt reconciles after restart without resending", async () => {
  const f = await fixture();
  expect(await f.create().deliverToSeat("seat", "original")).toMatchObject({ outcome: "unconfirmed" });
  expect(new DeliveryFence(f.receipts).pending("seat")).toMatchObject({
    nativeMessageId: f.requestId,
    nativeSessionPath: f.nativePath,
    sessionId: f.sessionId,
  });
  f.append();
  expect(await f.create().deliverToSeat("seat", "original")).toMatchObject({
    outcome: "delivered",
    deliveryStage: "consumed",
    messageId: "pi:entry-1",
  });
  expect(f.send).toHaveBeenCalledOnce();
});

test.each(["owner-text", "custom-type", "session", "request", "path"])(
  "Pi %s cannot reconcile uncertain delivery by equal text",
  async (mode) => {
    const f = await fixture();
    await f.create().deliverToSeat("seat", "original");
    if (mode === "owner-text")
      f.rows.push({
        type: "message",
        id: "owner",
        parentId: null,
        message: { role: "user", content: "original" },
      });
    else
      f.append(
        mode === "custom-type"
          ? { customType: "other-extension" }
          : mode === "session"
            ? { details: { sessionId: randomUUID(), requestId: f.requestId } }
            : mode === "request"
              ? { details: { sessionId: f.sessionId, requestId: randomUUID() } }
              : {},
      );
    if (mode === "path") f.path(`/different/timestamp_${f.sessionId}.jsonl`);
    const mailbox = vi.fn();
    expect(await f.create().deliverToSeat("seat", "original", mailbox)).toMatchObject({
      outcome: "unconfirmed",
    });
    expect(f.send).toHaveBeenCalledOnce();
    expect(mailbox).not.toHaveBeenCalled();
  },
);

test("old Pi receipts without semantic ID and original path remain uncertain", async () => {
  const f = await fixture();
  const fence = new DeliveryFence(f.receipts);
  fence.begin("seat", {
    sessionId: f.sessionId,
    paneId: "w1:p1",
    fingerprint: deliveryFingerprint("original"),
    beforeIds: [],
  });
  f.append();
  expect(await f.create().deliverToSeat("seat", "original")).toMatchObject({ outcome: "unconfirmed" });
  expect(f.send).not.toHaveBeenCalled();
});
