import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationStore } from "../src/captain/conversations.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("operator conversation context", () => {
  it("queues internal turns without forging an operator message", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-conversation-internal-"));
    roots.push(root);
    const store = new ConversationStore(root, async (_conversationId, message, publish) => {
      publish({ type: "message", role: "captain", text: `ran: ${message}`, streaming: false });
    });

    const accepted = store.submitInternal("global-default", "scheduled wake");
    if (accepted.status !== "accepted") throw new Error("internal turn was not accepted");
    await store.awaitRun(accepted.runId);
    const replay = await store.serve({
      op: "replay",
      schemaVersion: 1,
      replay: {
        schemaVersion: 1,
        conversationId: "global-default",
        surfaceClientId: "test",
        limit: 20,
      },
    });
    if (replay.op !== "replay" || replay.result.status !== "page") throw new Error("replay failed");
    expect(replay.result.events).toContainEqual(
      expect.objectContaining({ type: "message", role: "captain", text: "ran: scheduled wake" }),
    );
    expect(replay.result.events).not.toContainEqual(expect.objectContaining({ role: "operator" }));
    await store.close();
  });

  it("streams context, persists it, and fences stale revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-conversation-context-"));
    roots.push(root);
    const store = new ConversationStore(root, async (_conversationId, _message, publish) => {
      publish({ type: "context", usage: { tokens: 72_400, contextWindow: 200_000 } });
    });

    const sent = await store.serve({
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId: "global-default",
        surfaceClientId: "test",
        expectedRevision: 0,
        message: "hello",
      },
    });
    expect(sent.op).toBe("send");
    if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("turn was not accepted");
    await store.awaitRun(sent.result.runId);
    const stale = await store.serve({
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId: "global-default",
        surfaceClientId: "test",
        expectedRevision: 0,
        message: "stale",
      },
    });
    expect(stale.op === "send" ? stale.result : undefined).toMatchObject({
      status: "revision_conflict",
      expectedRevision: 0,
      currentRevision: 1,
    });
    await store.close();

    const restarted = new ConversationStore(root, async () => undefined);

    const current = await restarted.serve({
      op: "get",
      schemaVersion: 1,
      conversationId: "global-default",
    });
    expect(current.op === "get" ? current.conversation?.contextUsage : undefined).toEqual({
      tokens: 72_400,
      contextWindow: 200_000,
    });

    const replay = await restarted.serve({
      op: "replay",
      schemaVersion: 1,
      replay: {
        schemaVersion: 1,
        conversationId: "global-default",
        surfaceClientId: "test",
        limit: 20,
      },
    });
    expect(
      replay.op === "replay" && replay.result.status === "page"
        ? replay.result.events.find((event) => event.type === "context")
        : undefined,
    ).toMatchObject({ type: "context", usage: { tokens: 72_400, contextWindow: 200_000 } });

    await restarted.close();
  });
});
