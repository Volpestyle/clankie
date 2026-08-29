import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationStore } from "../src/captain/conversations.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function sendTurn(store: ConversationStore, message: string): Promise<string> {
  const got = await store.serve({ op: "get", schemaVersion: 1, conversationId: "global-default" });
  if (got.op !== "get" || got.conversation === undefined) throw new Error("default conversation missing");
  const sent = await store.serve({
    op: "send",
    schemaVersion: 1,
    turn: {
      schemaVersion: 1,
      kind: "message",
      conversationId: "global-default",
      surfaceClientId: "test",
      expectedRevision: got.conversation.revision,
      message,
    },
  });
  if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("turn was not accepted");
  return sent.result.runId;
}

async function replayEvents(store: ConversationStore) {
  const replay = await store.serve({
    op: "replay",
    schemaVersion: 1,
    replay: { schemaVersion: 1, conversationId: "global-default", surfaceClientId: "test", limit: 50 },
  });
  if (replay.op !== "replay" || replay.result.status !== "page") throw new Error("replay failed");
  return replay.result.events;
}

describe("operator conversation cancel", () => {
  it("interrupts a live run: the signal aborts and the turn settles cancelled", async () => {
    const root = await tempRoot("clankie-conversation-cancel-");
    const store = new ConversationStore(root, async (_conversationId, _message, publish, context) => {
      publish({ type: "message", role: "captain", text: "partial words", streaming: false });
      // Simulate the captain: the run ends only when the interrupt lands.
      await new Promise<void>((resolve) => {
        context.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });

    const runId = await sendTurn(store, "long think");
    const cancel = await store.serve({
      op: "cancel",
      schemaVersion: 1,
      conversationId: "global-default",
      runId,
    });
    if (cancel.op !== "cancel") throw new Error("unexpected result op");
    expect(cancel.cancelled).toBe(true);
    await expect(store.awaitRunResult(runId)).resolves.toBe(false);

    const events = await replayEvents(store);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn",
        runId,
        phase: "cancelled",
        reasonCode: "operator_interrupt",
      }),
    );
    // Partial output published before the interrupt stays in the transcript.
    expect(events).toContainEqual(expect.objectContaining({ type: "message", text: "partial words" }));
    // An interrupt is not a failure: the session comes back to waiting.
    const got = await store.serve({ op: "get", schemaVersion: 1, conversationId: "global-default" });
    if (got.op !== "get") throw new Error("get failed");
    expect(got.conversation?.sessionState).toBe("waiting");
    await store.close();
  });

  it("cancels a queued run without ever invoking the runner", async () => {
    const root = await tempRoot("clankie-conversation-cancel-queued-");
    const invoked: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const store = new ConversationStore(root, async (_conversationId, message) => {
      invoked.push(message);
      if (releaseFirst === undefined) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
    });

    const first = await sendTurn(store, "first");
    const second = await sendTurn(store, "second");
    const cancel = await store.serve({
      op: "cancel",
      schemaVersion: 1,
      conversationId: "global-default",
      runId: second,
    });
    if (cancel.op !== "cancel") throw new Error("unexpected result op");
    expect(cancel.cancelled).toBe(true);
    releaseFirst?.();
    await store.awaitRun(first);
    await store.awaitRun(second);

    expect(invoked).toEqual(["first"]);
    const events = await replayEvents(store);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn", runId: second, phase: "cancelled" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn", runId: first, phase: "completed" }),
    );
    await store.close();
  });

  it("reports false for unknown, settled, or cross-conversation runs", async () => {
    const root = await tempRoot("clankie-conversation-cancel-miss-");
    const store = new ConversationStore(root, async () => {});
    const runId = await sendTurn(store, "quick");
    await store.awaitRun(runId);

    for (const [conversationId, target] of [
      ["global-default", "run-nonexistent"],
      ["global-default", runId],
      ["other-conversation", runId],
    ] as const) {
      const cancel = await store.serve({ op: "cancel", schemaVersion: 1, conversationId, runId: target });
      if (cancel.op !== "cancel") throw new Error("unexpected result op");
      expect(cancel.cancelled).toBe(false);
    }
    const events = await replayEvents(store);
    expect(events).toContainEqual(expect.objectContaining({ type: "turn", runId, phase: "completed" }));
    await store.close();
  });
});
