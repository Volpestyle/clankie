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
  it("streams and persists the latest context occupancy", async () => {
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
