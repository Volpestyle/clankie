import { replayConversation, sendMessage, tailConversation } from "./conversation-requests.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationStore } from "../src/captain/conversations.ts";

const roots: string[] = [];
const stores: ConversationStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clankie-conversation-tail-"));
  roots.push(root);
  return root;
}

async function storeWithOneMessage(tailWaitMs: number): Promise<{
  store: ConversationStore;
  conversationId: string;
  revision: number;
  endCursor: string;
}> {
  const store = new ConversationStore(
    await temporaryRoot(),
    async () => undefined,
    undefined,
    undefined,
    tailWaitMs,
  );
  stores.push(store);
  const created = await store.serve({
    op: "create",
    schemaVersion: 1,
    scope: { kind: "global" },
    title: "tail",
  });
  if (created.op !== "create") throw new Error("conversation was not created");
  const conversationId = created.conversation.conversationId;
  const sent = await sendMessage(store, {
    conversationId,
    surfaceClientId: "test",
    expectedRevision: 0,
    message: "first",
  });
  if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("turn was not accepted");
  // The run settles asynchronously; its terminal event must land before the
  // end cursor is read, or the tail under test finds it instead of parking.
  await store.awaitRun(sent.result.runId);
  const replayed = await replayConversation(store, {
    conversationId,
    surfaceClientId: "test",
  });
  if (replayed.op !== "replay" || replayed.result.status !== "page") throw new Error("replay failed");
  return {
    store,
    conversationId,
    revision: sent.result.revision,
    endCursor: replayed.result.safeCursor,
  };
}

describe("operator conversation tail long-poll", () => {
  it("returns immediately when events are already available", async () => {
    const { store, conversationId } = await storeWithOneMessage(60_000);
    const startedAt = Date.now();
    const tailed = await tailConversation(store, {
      conversationId,
      surfaceClientId: "test",
    });
    if (tailed.op !== "tail" || tailed.result.status !== "page") throw new Error("tail failed");
    expect(tailed.result.events.length).toBeGreaterThan(0);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("parks an empty tail and wakes it on the next append", async () => {
    const { store, conversationId, revision, endCursor } = await storeWithOneMessage(60_000);
    const parked = tailConversation(store, {
      conversationId,
      surfaceClientId: "test",
      cursor: endCursor,
      waitMs: 60_000,
    });
    // Let the tail reach its parked wait before the append that wakes it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const sent = await sendMessage(store, {
      conversationId,
      surfaceClientId: "test",
      expectedRevision: revision,
      message: "second",
    });
    if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("turn was not accepted");
    const tailed = await parked;
    if (tailed.op !== "tail" || tailed.result.status !== "page") throw new Error("tail failed");
    expect(tailed.result.events.length).toBeGreaterThan(0);
    expect(tailed.result.events.some((event) => event.type === "message" && event.text === "second")).toBe(
      true,
    );
  });

  it("returns an empty page once the wait elapses with no appends", async () => {
    // The store's cap (20ms) is below what this caller asks for, so the cap wins.
    const { store, conversationId, endCursor } = await storeWithOneMessage(20);
    const controller = new AbortController();
    const pending = store.serve(
      {
        op: "tail",
        schemaVersion: 1,
        tail: {
          schemaVersion: 1,
          conversationId,
          surfaceClientId: "test",
          cursor: endCursor,
          waitMs: 20_000,
        },
      },
      undefined,
      controller.signal,
    );
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    const tailed = await pending;
    if (tailed.op !== "tail" || tailed.result.status !== "page") throw new Error("tail failed");
    expect(tailed.result.events).toEqual([]);
    expect(tailed.result.nextCursor).toBe(endCursor);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("answers a tail that asks for no wait immediately", async () => {
    const { store, conversationId, endCursor } = await storeWithOneMessage(60_000);
    const startedAt = Date.now();
    const tailed = await tailConversation(store, {
      conversationId,
      surfaceClientId: "test",
      cursor: endCursor,
    });
    if (tailed.op !== "tail" || tailed.result.status !== "page") throw new Error("tail failed");
    expect(tailed.result.events).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("refuses an already-aborted read without registering a waiter or changing the transcript", async () => {
    const { store, conversationId, endCursor } = await storeWithOneMessage(20_000);
    const before = await replayConversation(store, { conversationId, surfaceClientId: "test" });
    const controller = new AbortController();
    const reason = new Error("Reader is gone");
    controller.abort(reason);
    await expect(
      store.serve(
        {
          op: "tail",
          schemaVersion: 1,
          tail: {
            schemaVersion: 1,
            conversationId,
            surfaceClientId: "test",
            cursor: endCursor,
            waitMs: 20_000,
          },
        },
        undefined,
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(await replayConversation(store, { conversationId, surfaceClientId: "test" })).toEqual(before);
  });

  it("releases a parked tail immediately on disconnect and leaves its conversation readable", async () => {
    const { store, conversationId, endCursor } = await storeWithOneMessage(20_000);
    const before = await replayConversation(store, { conversationId, surfaceClientId: "test" });
    const controller = new AbortController();
    const pending = store.serve(
      {
        op: "tail",
        schemaVersion: 1,
        tail: {
          schemaVersion: 1,
          conversationId,
          surfaceClientId: "test",
          cursor: endCursor,
          waitMs: 20_000,
        },
      },
      undefined,
      controller.signal,
    );
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    const reason = new Error("Device disconnected");
    const rejected = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(await replayConversation(store, { conversationId, surfaceClientId: "test" })).toEqual(before);
    expect(
      await tailConversation(store, { conversationId, surfaceClientId: "reconnected", cursor: endCursor }),
    ).toMatchObject({
      op: "tail",
      result: { events: [], nextCursor: endCursor, surfaceClientId: "reconnected" },
    });
  });

  it("cancels only one reader while another reader receives the next live draft", async () => {
    const { store, conversationId, endCursor } = await storeWithOneMessage(20_000);
    const before = await replayConversation(store, { conversationId, surfaceClientId: "test" });
    const disconnected = new AbortController();
    const surviving = new AbortController();
    const readers = [disconnected, surviving].map((controller, index) =>
      store.serve(
        {
          op: "tail",
          schemaVersion: 1,
          tail: {
            schemaVersion: 1,
            conversationId,
            surfaceClientId: `reader-${index}`,
            cursor: endCursor,
            waitMs: 20_000,
          },
        },
        undefined,
        controller.signal,
      ),
    );
    expect(getEventListeners(disconnected.signal, "abort")).toHaveLength(1);
    expect(getEventListeners(surviving.signal, "abort")).toHaveLength(1);
    const rejection = expect(readers[0]).rejects.toMatchObject({ name: "AbortError" });
    disconnected.abort();
    await rejection;
    expect(getEventListeners(disconnected.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(surviving.signal, "abort")).toHaveLength(1);
    store.setLiveDraft(conversationId, "Still typing for the other reader");
    expect(await readers[1]).toMatchObject({
      op: "tail",
      result: {
        events: [],
        nextCursor: endCursor,
        surfaceClientId: "reader-1",
        live: { text: "Still typing for the other reader" },
      },
    });
    expect(getEventListeners(surviving.signal, "abort")).toHaveLength(0);
    store.setLiveDraft(conversationId, undefined);
    expect(await replayConversation(store, { conversationId, surfaceClientId: "test" })).toEqual(before);
  });

  it("releases every parked reader on store shutdown and refuses a new tail", async () => {
    const { store, conversationId, endCursor } = await storeWithOneMessage(20_000);
    const controller = new AbortController();
    const request = {
      op: "tail" as const,
      schemaVersion: 1 as const,
      tail: {
        schemaVersion: 1 as const,
        conversationId,
        surfaceClientId: "test",
        cursor: endCursor,
        waitMs: 20_000,
      },
    };
    const readers = [
      store.serve(request, undefined, controller.signal),
      store.serve(request, undefined, controller.signal),
    ];
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(2);
    const rejections = readers.map((reader) => expect(reader).rejects.toMatchObject({ name: "AbortError" }));
    await store.close();
    await Promise.all(rejections);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(controller.signal.aborted).toBe(false);
    await expect(store.serve(request, undefined, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("lets an accepted turn complete when its observing reader disconnects", async () => {
    let finish!: () => void;
    let started!: () => void;
    let runSignal: AbortSignal | undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const release = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const store = new ConversationStore(await temporaryRoot(), async (_id, _message, publish, context) => {
      runSignal = context.signal;
      started();
      await release;
      publish({
        type: "message",
        role: "captain",
        text: "Turn completed after reader left",
        streaming: false,
      });
    });
    stores.push(store);
    const controller = new AbortController();
    try {
      const sent = await store.serve(
        {
          op: "send",
          schemaVersion: 1,
          turn: {
            schemaVersion: 1,
            kind: "message",
            conversationId: "global-default",
            surfaceClientId: "test",
            expectedRevision: 0,
            message: "Keep working",
          },
        },
        undefined,
        controller.signal,
      );
      if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("Turn was not accepted");
      await running;
      const replay = await replayConversation(store, {
        conversationId: "global-default",
        surfaceClientId: "test",
      });
      if (replay.op !== "replay" || replay.result.status !== "page") throw new Error("Replay failed");
      const pending = store.serve(
        {
          op: "tail",
          schemaVersion: 1,
          tail: {
            schemaVersion: 1,
            conversationId: "global-default",
            surfaceClientId: "test",
            cursor: replay.result.safeCursor,
            waitMs: 20_000,
          },
        },
        undefined,
        controller.signal,
      );
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
      const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      controller.abort();
      await rejection;
      expect(runSignal?.aborted).toBe(false);
      finish();
      await expect(store.awaitRunResult(sent.result.runId)).resolves.toBe(true);
      const completed = await replayConversation(store, {
        conversationId: "global-default",
        surfaceClientId: "test",
      });
      if (completed.op !== "replay" || completed.result.status !== "page") throw new Error("Replay failed");
      expect(completed.result.events).toContainEqual(
        expect.objectContaining({ type: "message", text: "Turn completed after reader left" }),
      );
      expect(completed.result.events).toContainEqual(
        expect.objectContaining({ type: "turn", phase: "completed" }),
      );
      expect(completed.result.events).not.toContainEqual(
        expect.objectContaining({ type: "turn", phase: "cancelled" }),
      );
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      finish();
    }
  });
});

describe("operator conversation live drafts", () => {
  it("wakes a parked tail with the message being typed, and never logs it", async () => {
    const { store, conversationId, endCursor } = await storeWithOneMessage(60_000);
    const parked = tailConversation(store, {
      conversationId,
      surfaceClientId: "test",
      cursor: endCursor,
      waitMs: 60_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    store.setLiveDraft(conversationId, "half a thou");
    const tailed = await parked;
    if (tailed.op !== "tail" || tailed.result.status !== "page") throw new Error("tail failed");
    // The draft rides the page; the durable log and the cursor are untouched.
    expect(tailed.result.live?.text).toBe("half a thou");
    expect(tailed.result.live?.role).toBe("captain");
    expect(tailed.result.events).toEqual([]);
    expect(tailed.result.nextCursor).toBe(endCursor);
  });

  it("parks again once the surface has drawn the draft it holds", async () => {
    const { store, conversationId, endCursor } = await storeWithOneMessage(30);
    store.setLiveDraft(conversationId, "typing");
    const seen = await tailConversation(store, {
      conversationId,
      surfaceClientId: "test",
      cursor: endCursor,
      waitMs: 60_000,
    });
    if (seen.op !== "tail" || seen.result.status !== "page") throw new Error("tail failed");
    const sequence = seen.result.live?.sequence ?? 0;
    expect(sequence).toBeGreaterThan(0);
    const startedAt = Date.now();
    const again = await tailConversation(store, {
      conversationId,
      surfaceClientId: "test",
      cursor: endCursor,
      liveSequence: sequence,
      waitMs: 60_000,
    });
    if (again.op !== "tail" || again.result.status !== "page") throw new Error("tail failed");
    // Nothing new to draw, so this one waited out the store's 30ms cap.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20);
    expect(again.result.live?.sequence).toBe(sequence);
  });

  it("takes the draft down and leaves no trace in replay", async () => {
    const { store, conversationId } = await storeWithOneMessage(60_000);
    store.setLiveDraft(conversationId, "typing");
    store.setLiveDraft(conversationId, undefined);
    const replayed = await replayConversation(store, {
      conversationId,
      surfaceClientId: "test",
    });
    if (replayed.op !== "replay" || replayed.result.status !== "page") throw new Error("replay failed");
    expect(replayed.result.live).toBeUndefined();
    expect(replayed.result.events.some((event) => JSON.stringify(event).includes("typing"))).toBe(false);
  });
});
