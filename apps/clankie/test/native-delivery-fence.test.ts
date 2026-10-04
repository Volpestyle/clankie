import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { HarnessSeatAdapter, SeatControl } from "@clankie/agent-hosts";
import { createFleetSeatControl } from "../src/captain/fleet-seat-control.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import type { PeerDeliveryOptions } from "../src/captain/peer-seat-messages.ts";
import type { ExternalCodexControl } from "../src/captain/external-codex-control.ts";
import type { FleetSeatDelivery } from "../src/captain/fleet-seat.ts";
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
    adapter,
    runner,
    setSession: (value: string) => {
      agent = { ...agent, session: { source: "herdr:claude", kind: "id", value } };
    },
  };
}
function barrier() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release: () => release() };
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
    await create().deliverToSeat("seat1", "approval", undefined, {
      guard,
      stableReceiptKey: "linear:original-author:event",
    }),
  ).toMatchObject({ outcome: "delivered", messageId: "accepted-native" });
  const restarted = create();
  expect(
    await restarted.deliverToSeat("seat1", "approval", undefined, {
      guard,
      stableReceiptKey: "linear:original-author:event",
    }),
  ).toMatchObject({ outcome: "delivered", messageId: "accepted-native" });
  expect(
    await restarted.deliverToSeat("seat1", "changed approval", undefined, {
      guard,
      stableReceiptKey: "linear:original-author:event",
    }),
  ).toMatchObject({ outcome: "undelivered" });
  expect(send).toHaveBeenCalledTimes(1);
});

it("keeps stable delivery fenced until an exact retry can reconcile its original receipt", async () => {
  const { create, send, entries } = fixture();
  const guard = async () => {};
  await create().deliverToSeat("seat1", "approval", undefined, { guard, stableReceiptKey: "linear:event" });
  entries.push({ type: "message", role: "operator", id: "native-approval", text: "approval" });
  const restarted = create();
  expect(
    await restarted.deliverToSeat("seat1", "changed", undefined, { guard, stableReceiptKey: "linear:event" }),
  ).toMatchObject({
    outcome: "undelivered",
  });
  expect(
    await restarted.deliverToSeat("seat1", "approval", undefined, {
      guard,
      stableReceiptKey: "linear:event",
    }),
  ).toMatchObject({
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
  const first = native.deliverToSeat("seat1", "approval", undefined, {
    guard,
    stableReceiptKey: "linear:event",
  });
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(
    await native.deliverToSeat("seat1", "approval", undefined, { guard, stableReceiptKey: "linear:event" }),
  ).toMatchObject({
    outcome: "unconfirmed",
  });
  release();
  expect(await first).toMatchObject({ outcome: "delivered" });
  expect(
    await native.deliverToSeat("seat1", "approval", undefined, { guard, stableReceiptKey: "linear:event" }),
  ).toMatchObject({
    outcome: "delivered",
  });
  expect(send).toHaveBeenCalledTimes(1);
});

it.each([
  ["two stable events", { stableReceiptKey: "linear:first" }, { stableReceiptKey: "linear:second" }],
  ["stable event before peer", { stableReceiptKey: "linear:first" }, { fence: async () => true }],
  ["peer before stable event", { fence: async () => true }, { stableReceiptKey: "linear:second" }],
] satisfies [string, PeerDeliveryOptions, PeerDeliveryOptions][])(
  "reserves the recipient across held attachment for %s",
  async (_name, firstOptions, secondOptions) => {
    const { create, send, adapter } = fixture();
    const attaching = [barrier(), barrier()];
    const sending = barrier();
    const originalAttach = adapter.attach;
    let attached = 0;
    const attach = vi.fn(async (...args: Parameters<HarnessSeatAdapter["attach"]>) => {
      const held = attaching[attached];
      attached += 1;
      await held!.pending;
      return originalAttach(...args);
    });
    adapter.attach = attach;
    send.mockImplementation(async () => {
      await sending.pending;
      return { outcome: "accepted", messageId: "first-only", state: "started" };
    });
    const native = create();
    const first = native.deliverToSeat("seat1", "first", undefined, firstOptions);
    const second = native.deliverToSeat("seat1", "second", undefined, secondOptions);
    try {
      await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(2));
      attaching[0]!.release();
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      attaching[1]!.release();
      expect(await second).toMatchObject({ outcome: "undelivered", deliveryStage: "unavailable" });
      // The losing caller must not clear the active winner's uncertainty.
      expect(await native.deliverToSeat("seat1", "first", undefined, firstOptions)).toMatchObject({
        outcome: "unconfirmed",
      });
    } finally {
      for (const held of attaching) held.release();
      sending.release();
    }
    expect(await first).toMatchObject({ outcome: "delivered", messageId: "first-only" });
    expect(send).toHaveBeenCalledOnce();
  },
);

it("does not reconcile a different stable event from another event's same-content receipt", async () => {
  const { create, entries, send } = fixture();
  await create().deliverToSeat("seat1", "approval", undefined, { stableReceiptKey: "linear:first" });
  entries.push({ type: "message", role: "operator", id: "accepted-original", text: "approval" });
  const restarted = create();
  expect(
    await restarted.deliverToSeat("seat1", "approval", undefined, { stableReceiptKey: "linear:second" }),
  ).toMatchObject({ outcome: "undelivered", deliveryStage: "unavailable" });
  expect(
    await restarted.deliverToSeat("seat1", "approval", undefined, { stableReceiptKey: "linear:first" }),
  ).toMatchObject({ outcome: "delivered", messageId: "accepted-original" });
  expect(send).toHaveBeenCalledOnce();
});

it.each(["native", "peer"] as const)(
  "composes native and peer fences when %s authority changes during native preparation",
  async (revoked) => {
    const { create, send } = fixture();
    const preparing = barrier();
    let nativeLive = true;
    let peerLive = true;
    const mutation = vi.fn();
    const guard = vi.fn(async () => {
      if (!nativeLive) throw new Error("Original native author changed");
    });
    const fence = vi.fn(async () => peerLive);
    send.mockImplementation(async (_text, options) => {
      await preparing.pending;
      if (!(await options!.beforeDispatch!().catch(() => false)))
        return { outcome: "released", detail: "Authority changed before dispatch" };
      mutation();
      return { outcome: "accepted", messageId: "accepted", state: "started" };
    });
    const delivery = create().deliverToSeat("seat1", "approval", undefined, {
      guard,
      fence,
      stableReceiptKey: "linear:event",
      recipientBinding: "original-binding",
    });
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      expect(send.mock.calls[0]![1]).toMatchObject({
        source: "peer",
        recipientBinding: "original-binding",
      });
      if (revoked === "native") nativeLive = false;
      else peerLive = false;
    } finally {
      preparing.release();
    }
    expect(await delivery).toMatchObject({ outcome: "undelivered" });
    expect(guard).toHaveBeenCalledTimes(2);
    expect(mutation).not.toHaveBeenCalled();
  },
);

it("treats a successful void native guard as permission without changing the native channel source", async () => {
  const { create, send } = fixture();
  const guard = vi.fn(async () => {});
  send.mockImplementation(async (_text, options) => {
    expect(options!.source).toBeUndefined();
    expect(options!.recipientBinding).toBe("author-binding");
    expect(await options!.beforeDispatch!()).toBe(true);
    return { outcome: "accepted", messageId: "accepted", state: "started" };
  });
  expect(
    await create().deliverToSeat("seat1", "approval", undefined, {
      guard,
      stableReceiptKey: "linear:event",
      recipientBinding: "author-binding",
    }),
  ).toMatchObject({ outcome: "delivered" });
  expect(guard).toHaveBeenCalledTimes(2);
});

it.each([
  ["local native", "native"],
  ["local native", "peer"],
  ["remote native", "native"],
  ["remote native", "peer"],
  ["remote queue", "native"],
  ["remote queue", "peer"],
] as const)("passes the composed final fence to %s when %s authority changes", async (path, revoked) => {
  const preparing = barrier();
  const mutation = vi.fn();
  const localQueue = vi.fn(async () => true);
  let nativeLive = true;
  let peerLive = true;
  const agent: HerdrAgentSnapshot = {
    paneId: path === "local native" ? "w1:p1" : "pc/w1:p1",
    terminalId: "codex-seat",
    agent: "codex",
    status: "idle",
    title: "original author",
    session: { source: "herdr:codex", kind: "id", value: "original-thread" },
  };
  const dispatch = vi.fn(async (authorized?: () => Promise<boolean>): Promise<FleetSeatDelivery> => {
    await preparing.pending;
    if (!(await authorized!().catch(() => false)))
      return { outcome: "undelivered", deliveryStage: "rejected", detail: "Changed before dispatch" };
    mutation();
    return { outcome: "delivered", state: "started", messageId: "accepted" };
  });
  const control: ExternalCodexControl = (_session, _text, _home, _endpoint, authorized) =>
    dispatch(authorized);
  const remoteQueue: NonNullable<Parameters<typeof createFleetSeatControl>[3]> = (
    _fleet,
    _session,
    _text,
    authorized,
  ) => dispatch(authorized);
  const runner: HerdrWatchRunner = {
    get: async () => agent,
    resolveTerminal: async () => agent,
    wait: async () => agent,
    paneProcesses: async () => [{ pid: 101, name: "codex", argv: ["codex", "resume", "original-thread"] }],
    openFiles: async () => "",
    codexControl: control,
    codexQueue: localQueue,
  };
  const native = createFleetSeatControl(runner, new Map(), undefined, remoteQueue, () =>
    path === "remote queue" ? async () => undefined : control,
  );
  const options: PeerDeliveryOptions = {
    guard: async () => {
      if (!nativeLive) throw new Error("Original author changed");
    },
    fence: async () => peerLive,
    stableReceiptKey: "linear:event",
  };
  const delivery = native.deliverToSeat(agent.terminalId, "approval", undefined, options);
  try {
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    if (revoked === "native") nativeLive = false;
    else peerLive = false;
  } finally {
    preparing.release();
  }
  expect(await delivery).toMatchObject({ outcome: "undelivered", deliveryStage: "unavailable" });
  expect(mutation).not.toHaveBeenCalled();
  expect(localQueue).not.toHaveBeenCalled();
  nativeLive = peerLive = true;
  expect(await native.deliverToSeat(agent.terminalId, "approval", undefined, options)).toMatchObject({
    outcome: "delivered",
  });
  expect(await native.deliverToSeat(agent.terminalId, "approval", undefined, options)).toMatchObject({
    outcome: "delivered",
  });
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(mutation).toHaveBeenCalledOnce();
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
