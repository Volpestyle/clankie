import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationStore } from "../src/captain/conversations.ts";
import { InboundSeatReceipts } from "../src/captain/inbound-seat-receipts.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";
import { CONVERSATION_RUN_STALL_MS } from "../src/captain/conversation-run.ts";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "conversation-driver-"));
  roots.push(root);
  const service = vi.fn(async (_message: string) => {});
  let outbox = new SeatOutbox({ boundGraceMs: 100 });
  const select = (conversationId: string, message: string) => {
    const selected = outbox;
    if (!selected.bound() && !selected.uncertain()) return undefined;
    return {
      run: async () => {
        const delivery = await selected.deliver({
          kind: "watch",
          conversationId,
          source: "service",
          content: message,
          wantsReply: false,
        });
        return delivery.outcome === "unbound"
          ? ({ handled: false } as const)
          : ({ handled: true, result: undefined } as const);
      },
    };
  };
  const store: ConversationStore = new ConversationStore(
    join(root, "conversations"),
    (id, message, _publish, context) =>
      store.runWithConversationDriver(
        id,
        () => select(id, message),
        () => service(message),
        context.signal,
      ),
  );
  const drive = (message: string) =>
    store.runWithConversationDriver(
      "global-default",
      () => select("global-default", message),
      () => service(message),
    );
  const poll = (waitMs = 5_000) => {
    const selected = outbox;
    return store.pollConversationDriver("global-default", () => selected.poll(waitMs));
  };
  return {
    root,
    store,
    service,
    drive,
    poll,
    outbox: () => outbox,
    replace: () => (outbox = new SeatOutbox({ boundGraceMs: 100 })),
  };
}

it("an attach admitted with a queued worker message gives it to the seat exactly once", async () => {
  const f = fixture();
  const poll = f.poll();
  const receipts = new InboundSeatReceipts(join(f.root, "inbound.json"), f.store);
  const delivery = { id: randomUUID(), binding: "a".repeat(64) };
  expect(receipts.accept("worker", delivery, "report", "Agent output: report").received).toBe(true);
  const acceptance = f.store.inboundAcceptance(delivery.id)!;
  const [event] = await poll;
  expect(event).toMatchObject({ conversationId: "global-default", content: "Agent output: report" });
  // The same retry reconciles the original acceptance, even during handover.
  expect(receipts.accept("worker", delivery, "report", "replacement").received).toBe(true);
  await f.poll(0);
  await f.store.awaitRun(acceptance.runId);
  expect(f.service).not.toHaveBeenCalled();
  expect(await f.poll(0)).toEqual([]);
  f.outbox().close();
  await f.store.close();
});

it("attachment waits for an admitted service turn, then takes queued work without a second service answer", async () => {
  const f = fixture();
  const entered = deferred();
  const finish = deferred();
  f.service.mockImplementationOnce(async () => {
    entered.resolve();
    await finish.promise;
  });
  const first = f.store.submitInternal("global-default", "first", "watch");
  if (first.status !== "accepted") throw new Error("acceptance missing");
  await entered.promise;
  const poll = f.poll();
  const queued = f.store.submitInternal("global-default", "queued", "wake");
  if (queued.status !== "accepted") throw new Error("acceptance missing");
  expect(f.outbox().bound()).toBe(false);
  finish.resolve();
  const [event] = await poll;
  expect(event?.content).toBe("queued");
  await f.poll(0);
  await f.store.awaitRun(queued.runId);
  expect(f.service.mock.calls).toEqual([["first"]]);
  f.outbox().close();
  await f.store.close();
});

it("silent service work releases waiting attachment and queued work without replaying its late result", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const f = fixture();
  const entered = deferred();
  const dependency = deferred();
  f.service.mockImplementationOnce(async () => {
    entered.resolve();
    await dependency.promise;
  });
  const first = f.store.submitInternal("global-default", "silent first", "watch");
  if (first.status !== "accepted") throw new Error("acceptance missing");
  await entered.promise;
  const attached = f.poll();
  const queued = f.store.submitInternal("global-default", "queued after silent first", "wake");
  if (queued.status !== "accepted") throw new Error("acceptance missing");
  await vi.advanceTimersByTimeAsync(CONVERSATION_RUN_STALL_MS - 1);
  expect(f.outbox().bound()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect((await attached).map((event) => event.content)).toEqual(["queued after silent first"]);
  await f.poll(0);
  await f.store.awaitRun(first.runId);
  await f.store.awaitRun(queued.runId);
  const journal = new ConversationJournal(join(f.root, "conversations"));
  const settled = journal.read("global-default");
  expect(settled).toContainEqual(
    expect.objectContaining({
      type: "turn",
      runId: first.runId,
      phase: "failed",
      reasonCode: "conversation_turn_stalled",
    }),
  );
  expect(f.service.mock.calls).toEqual([["silent first"]]);
  dependency.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(journal.read("global-default")).toEqual(settled);
  expect(await f.poll(0)).toEqual([]);
  expect(f.service.mock.calls).toEqual([["silent first"]]);
  f.outbox().close();
  await f.store.close();
});

it("cancellation releases an admitted service and its waiting attachment while a dependency stays pending", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const entered = deferred();
  f.service.mockImplementationOnce(async () => {
    entered.resolve();
    await new Promise(() => {});
  });
  const first = f.store.submitInternal("global-default", "cancel this service", "watch");
  if (first.status !== "accepted") throw new Error("acceptance missing");
  await entered.promise;
  const attached = f.poll();
  expect(f.outbox().bound()).toBe(false);
  expect(f.store.cancel("global-default", first.runId)).toBe(true);
  await f.store.awaitRun(first.runId);
  const next = f.store.submitInternal("global-default", "work after cancellation", "wake");
  if (next.status !== "accepted") throw new Error("acceptance missing");
  expect((await attached).map((event) => event.content)).toEqual(["work after cancellation"]);
  await f.poll(0);
  await f.store.awaitRun(next.runId);
  expect(f.service.mock.calls).toEqual([["cancel this service"]]);
  f.outbox().close();
  await f.store.close();
});

it("a cancelled attaching poll releases its reservation and never binds after admitted service settles", async () => {
  const f = fixture();
  const entered = deferred();
  const finish = deferred();
  f.service.mockImplementationOnce(async () => {
    entered.resolve();
    await finish.promise;
  });
  const first = f.store.submitInternal("global-default", "admitted service", "watch");
  if (first.status !== "accepted") throw new Error("acceptance missing");
  await entered.promise;
  const controller = new AbortController();
  const poll = vi.fn(() => f.outbox().poll(5_000));
  const attaching = f.store.pollConversationDriver("global-default", poll, controller.signal);
  const reason = new Error("attaching client disconnected");
  const cancelled = expect(attaching).rejects.toBe(reason);
  controller.abort(reason);
  await cancelled;
  expect(poll).not.toHaveBeenCalled();
  expect(f.outbox().bound()).toBe(false);
  const queued = f.store.submitInternal("global-default", "queued after client disconnected", "wake");
  if (queued.status !== "accepted") throw new Error("acceptance missing");
  finish.resolve();
  await f.store.awaitRun(first.runId);
  await f.store.awaitRun(queued.runId);
  expect(poll).not.toHaveBeenCalled();
  expect(f.outbox().bound()).toBe(false);
  expect(f.service.mock.calls).toEqual([["admitted service"], ["queued after client disconnected"]]);
  expect(await f.poll(0)).toEqual([]);
  f.outbox().close();
  await f.store.close();
});

it("a cancelled invocation waiting for attachment admission cannot later start service or dispatch", async () => {
  const f = fixture();
  const started = deferred();
  const neverSettles = deferred();
  const occupying = f.store.runWithConversationDriver(
    "global-default",
    () => undefined,
    async () => {
      started.resolve();
      await neverSettles.promise;
    },
  );
  await started.promise;
  const attached = f.poll();
  const controller = new AbortController();
  const selected = vi.fn(() => undefined);
  const service = vi.fn(async () => {});
  const waiting = f.store.runWithConversationDriver("global-default", selected, service, controller.signal);
  const reason = new Error("cancelled while waiting for attachment");
  const failed = expect(waiting).rejects.toBe(reason);
  controller.abort(reason);
  await failed;
  expect(selected).not.toHaveBeenCalled();
  expect(service).not.toHaveBeenCalled();
  neverSettles.resolve();
  await occupying;
  f.outbox().close();
  expect(await attached).toEqual([]);
  expect(selected).not.toHaveBeenCalled();
  expect(service).not.toHaveBeenCalled();
  await f.store.close();
});

it("definite refusal during detach resumes service once when no driver remains", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const empty = f.poll(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await empty).toEqual([]);
  const run = f.drive("handover");
  await vi.advanceTimersByTimeAsync(100);
  await run;
  expect(f.service.mock.calls).toEqual([["handover"]]);
  expect(await f.poll(0)).toEqual([]);
  f.outbox().close();
  await f.store.close();
});

it("rechecks a replacement attachment after the old driver definitely refuses", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const empty = f.poll(1);
  await vi.advanceTimersByTimeAsync(1);
  await empty;
  const old = f.outbox();
  const run = f.drive("replacement takes this");
  // The old dispatch is already waiting in its re-poll grace.
  await vi.advanceTimersByTimeAsync(1);
  f.replace();
  const replacement = f.poll();
  await vi.advanceTimersByTimeAsync(100);
  const [event] = await replacement;
  expect(event?.content).toBe("replacement takes this");
  await f.poll(0);
  await run;
  expect(f.service).not.toHaveBeenCalled();
  expect(await old.poll(0)).toEqual([]);
  old.close();
  f.outbox().close();
  await f.store.close();
});

it("pins a taken delivery across detach and replacement even when its acknowledgement is lost", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const poll = f.poll();
  const run = f.drive("taken once");
  const [event] = await poll;
  expect(event?.content).toBe("taken once");
  const old = f.outbox();
  f.replace();
  const replacement = f.poll();
  await vi.advanceTimersByTimeAsync(100);
  await run;
  expect(old.uncertain()).toBe(true);
  expect(f.service).not.toHaveBeenCalled();
  expect(old.acknowledge(event!.id)).toBe(true);
  f.outbox().close();
  expect(await replacement).toEqual([]);
  old.close();
  await f.store.close();
});

it("a failing service invocation releases a waiting attachment and does not block other conversations", async () => {
  const f = fixture();
  const entered = deferred();
  const finish = deferred();
  const failure = f.store.runWithConversationDriver(
    "global-default",
    () => undefined,
    async () => {
      entered.resolve();
      await finish.promise;
      throw new Error("service failed");
    },
  );
  const failed = expect(failure).rejects.toThrow("service failed");
  await entered.promise;
  const poll = f.poll();
  const room = f.store.roomConversation("discord_presence", "guild:channel");
  const other = vi.fn(async () => "room answer");
  await expect(f.store.runWithConversationDriver(room, () => undefined, other)).resolves.toBe("room answer");
  expect(other).toHaveBeenCalledOnce();
  expect(f.outbox().bound()).toBe(false);
  finish.resolve();
  await failed;
  const run = f.drive("after failure");
  expect((await poll)[0]?.content).toBe("after failure");
  await f.poll(0);
  await run;
  f.outbox().close();
  await f.store.close();
});

it("reconciles a worker acceptance in its original conversation after adoption and restart", async () => {
  const f = fixture();
  const created = await f.store.serve({
    op: "create",
    schemaVersion: 1,
    scope: { kind: "workspace", workspaceId: f.root },
    title: "Hiring project",
  });
  if (created.op !== "create") throw new Error("creation missing");
  const id = created.conversation.conversationId;
  const receiptPath = join(f.root, "inbound.json");
  const receipts = new InboundSeatReceipts(receiptPath, f.store);
  const delivery = { id: randomUUID(), binding: "a".repeat(64) };
  expect(receipts.accept("worker", delivery, "report", "Agent output: report", id).received).toBe(true);
  await f.store.close();
  const service = vi.fn(async () => {});
  const restarted = new ConversationStore(join(f.root, "conversations"), service);
  const retried = new InboundSeatReceipts(receiptPath, restarted);
  expect(retried.accept("worker", delivery, "report", "new owner", "global-default").received).toBe(true);
  expect(service).not.toHaveBeenCalled();
  expect(f.service.mock.calls).toEqual([["Agent output: report"]]);
  // Duplicate proof across conversations fails closed instead of choosing one.
  const globalPath = join(f.root, "conversations/global-default/meta.json");
  const global = JSON.parse(readFileSync(globalPath, "utf8"));
  const original = JSON.parse(readFileSync(join(f.root, "conversations", id, "meta.json"), "utf8"));
  global.inboundAcceptances = original.inboundAcceptances;
  writeFileSync(globalPath, JSON.stringify(global));
  expect(() => restarted.inboundAcceptance(delivery.id)).toThrow("multiple conversations");
  expect(retried.accept("worker", delivery, "report", "new owner").received).toBe(false);
  await restarted.close();
});

it("room worker input requires an explicit room runner and cannot gain the operator runner", async () => {
  const f = fixture();
  const room = f.store.roomConversation("discord_presence", "guild:channel");
  const receipt = {
    deliveryId: randomUUID(),
    binding: "a".repeat(64),
    fingerprint: "b".repeat(64),
    paneId: "worker",
    text: "report",
  };
  expect(() => f.store.submitInbound("Agent output: report", receipt, room)).toThrow("cannot accept");
  expect(f.store.inboundAcceptance(receipt.deliveryId)).toBeUndefined();
  const roomRunner = vi.fn(async () => {});
  const accepted = f.store.submitInbound("Agent output: report", receipt, room, roomRunner);
  if (accepted.status !== "accepted") throw new Error("acceptance missing");
  await f.store.awaitRun(accepted.runId);
  expect(roomRunner).toHaveBeenCalledOnce();
  expect(f.service).not.toHaveBeenCalled();
  await f.store.close();
});

it("attached room hooks append to that room, retain native session isolation and deduplicate across restart", async () => {
  const f = fixture();
  const room = f.store.roomConversation("discord_presence", "guild:channel");
  const other = f.store.roomConversation("discord_presence", "guild:other");
  f.store.nameRoomConversation(room, "Server / channel");
  const operator = {
    type: "message" as const,
    id: "native-room-input",
    role: "operator" as const,
    text: "Room prompt",
  };
  const agent = {
    type: "message" as const,
    id: "native-room-answer",
    role: "agent" as const,
    text: "Room answer",
  };
  expect(f.store.syncNativeSeatTranscript(room, "room-native-session", [operator, agent], "waiting")).toBe(
    true,
  );
  expect(f.store.syncNativeSeatTranscript(other, "room-native-session", [agent])).toBe(false);
  expect(f.store.syncNativeSeatTranscript("global-default", "room-native-session", [agent])).toBe(false);
  const journal = new ConversationJournal(join(f.root, "conversations"));
  const original = journal.read(room);
  expect(original).toMatchObject([
    { type: "message", role: "external", text: "Room prompt" },
    { type: "message", role: "captain", text: "Room answer" },
    { type: "activity", phase: "waiting" },
  ]);
  expect(journal.read(other)).toEqual([]);
  expect(journal.read("global-default")).toEqual([]);
  expect(f.store.runsCaptainTurns(room)).toBe(false);
  expect(() => f.store.submitInternal(room, "ungranted machine turn", "wake")).toThrow();
  await f.store.close();
  const restarted = new ConversationStore(join(f.root, "conversations"), f.service);
  expect(restarted.conversation(room)?.title).toBe("Server / channel");
  expect(restarted.syncNativeSeatTranscript(room, "room-native-session", [operator, agent], "waiting")).toBe(
    true,
  );
  expect(journal.read(room)).toEqual(original);
  expect(restarted.syncNativeSeatTranscript(other, "room-native-session", [agent])).toBe(false);
  await restarted.close();
});
