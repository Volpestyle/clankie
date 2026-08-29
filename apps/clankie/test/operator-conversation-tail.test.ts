import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationStore } from "../src/captain/conversations.ts";

const roots: string[] = [];

afterEach(async () => {
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
  const created = await store.serve({
    op: "create",
    schemaVersion: 1,
    scope: { kind: "global" },
    title: "tail",
  });
  if (created.op !== "create") throw new Error("conversation was not created");
  const conversationId = created.conversation.conversationId;
  const sent = await store.serve({
    op: "send",
    schemaVersion: 1,
    turn: {
      schemaVersion: 1,
      kind: "message",
      conversationId,
      surfaceClientId: "test",
      expectedRevision: 0,
      message: "first",
    },
  });
  if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("turn was not accepted");
  // The run settles asynchronously; its terminal event must land before the
  // end cursor is read, or the tail under test finds it instead of parking.
  await store.awaitRun(sent.result.runId);
  const replayed = await store.serve({
    op: "replay",
    schemaVersion: 1,
    replay: { schemaVersion: 1, conversationId, surfaceClientId: "test" },
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
    const tailed = await store.serve({
      op: "tail",
      schemaVersion: 1,
      tail: { schemaVersion: 1, conversationId, surfaceClientId: "test" },
    });
    if (tailed.op !== "tail" || tailed.result.status !== "page") throw new Error("tail failed");
    expect(tailed.result.events.length).toBeGreaterThan(0);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("parks an empty tail and wakes it on the next append", async () => {
    const { store, conversationId, revision, endCursor } = await storeWithOneMessage(60_000);
    const parked = store.serve({
      op: "tail",
      schemaVersion: 1,
      tail: {
        schemaVersion: 1,
        conversationId,
        surfaceClientId: "test",
        cursor: endCursor,
        waitMs: 60_000,
      },
    });
    // Let the tail reach its parked wait before the append that wakes it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const sent = await store.serve({
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId,
        surfaceClientId: "test",
        expectedRevision: revision,
        message: "second",
      },
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
    const tailed = await store.serve({
      op: "tail",
      schemaVersion: 1,
      tail: {
        schemaVersion: 1,
        conversationId,
        surfaceClientId: "test",
        cursor: endCursor,
        waitMs: 60_000,
      },
    });
    if (tailed.op !== "tail" || tailed.result.status !== "page") throw new Error("tail failed");
    expect(tailed.result.events).toEqual([]);
    expect(tailed.result.nextCursor).toBe(endCursor);
  });

  it("answers a tail that asks for no wait immediately", async () => {
    const { store, conversationId, endCursor } = await storeWithOneMessage(60_000);
    const startedAt = Date.now();
    const tailed = await store.serve({
      op: "tail",
      schemaVersion: 1,
      tail: { schemaVersion: 1, conversationId, surfaceClientId: "test", cursor: endCursor },
    });
    if (tailed.op !== "tail" || tailed.result.status !== "page") throw new Error("tail failed");
    expect(tailed.result.events).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

describe("operator conversation live drafts", () => {
  it("wakes a parked tail with the message being typed, and never logs it", async () => {
    const { store, conversationId, endCursor } = await storeWithOneMessage(60_000);
    const parked = store.serve({
      op: "tail",
      schemaVersion: 1,
      tail: {
        schemaVersion: 1,
        conversationId,
        surfaceClientId: "test",
        cursor: endCursor,
        waitMs: 60_000,
      },
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
    const seen = await store.serve({
      op: "tail",
      schemaVersion: 1,
      tail: {
        schemaVersion: 1,
        conversationId,
        surfaceClientId: "test",
        cursor: endCursor,
        waitMs: 60_000,
      },
    });
    if (seen.op !== "tail" || seen.result.status !== "page") throw new Error("tail failed");
    const sequence = seen.result.live?.sequence ?? 0;
    expect(sequence).toBeGreaterThan(0);
    const startedAt = Date.now();
    const again = await store.serve({
      op: "tail",
      schemaVersion: 1,
      tail: {
        schemaVersion: 1,
        conversationId,
        surfaceClientId: "test",
        cursor: endCursor,
        liveSequence: sequence,
        waitMs: 60_000,
      },
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
    const replayed = await store.serve({
      op: "replay",
      schemaVersion: 1,
      replay: { schemaVersion: 1, conversationId, surfaceClientId: "test" },
    });
    if (replayed.op !== "replay" || replayed.result.status !== "page") throw new Error("replay failed");
    expect(replayed.result.live).toBeUndefined();
    expect(replayed.result.events.some((event) => JSON.stringify(event).includes("typing"))).toBe(false);
  });
});
