import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { cloneSideConversationSession } from "../src/captain/captain.ts";
import { ConversationStore, type ConversationTurnContext } from "../src/captain/conversations.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const reply: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "parent answer" }],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "test",
  stopReason: "stop",
  timestamp: 0,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};

describe("side conversations", () => {
  it("forks Pi's current branch and discards the active child without touching its parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-side-conversation-"));
    roots.push(root);
    let childSession: SessionManager | undefined;
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    let turnContext: ConversationTurnContext | undefined;
    const store = new ConversationStore(
      root,
      async (_conversationId, _message, _publish, context) => {
        turnContext = context;
        started();
        await new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
      undefined,
      undefined,
      undefined,
      async ({ parentConversationId, conversationId }) => {
        const source = SessionManager.continueRecent(
          root,
          join(root, parentConversationId, "pi"),
        ).getSessionFile();
        if (source === undefined) throw new Error("parent session missing");
        childSession = cloneSideConversationSession(source, root, join(root, conversationId, "pi"));
      },
    );
    const created = await store.serve({
      op: "create",
      schemaVersion: 1,
      scope: { kind: "global" },
      title: "Main",
    });
    if (created.op !== "create") throw new Error("conversation was not created");
    const parentId = created.conversation.conversationId;
    const parentSession = SessionManager.create(root, join(root, parentId, "pi"));
    parentSession.appendMessage({ role: "user", content: "parent context", timestamp: 0 });
    parentSession.appendMessage(reply);

    const forked = await store.serve({
      op: "fork",
      schemaVersion: 1,
      parentConversationId: parentId,
    });
    if (forked.op !== "fork") throw new Error("conversation was not forked");
    const childId = forked.conversation.conversationId;
    const childMessages = childSession?.buildSessionContext().messages ?? [];
    expect(forked.conversation.parentConversationId).toBe(parentId);
    expect(childMessages).toHaveLength(3);
    expect(childMessages[0]).toMatchObject({ role: "user", content: "parent context" });
    expect(childMessages[1]).toMatchObject({ role: "assistant" });
    expect(childMessages[2]).toMatchObject({
      role: "custom",
      customType: "clankie.side-conversation-boundary",
    });
    await expect(
      store.serve({ op: "fork", schemaVersion: 1, parentConversationId: parentId }),
    ).rejects.toThrow("already open");

    const sent = await store.serve({
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId: childId,
        surfaceClientId: "test",
        expectedRevision: 0,
        message: "side question",
      },
    });
    if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("turn was not accepted");
    await running;
    expect(turnContext?.side).toBe(true);

    await expect(
      store.serve({ op: "close", schemaVersion: 1, conversationId: childId }),
    ).resolves.toMatchObject({ op: "close", closed: true });
    await expect(
      store.serve({ op: "get", schemaVersion: 1, conversationId: parentId }),
    ).resolves.toMatchObject({ op: "get", conversation: { conversationId: parentId } });

    const orphaned = await store.serve({
      op: "fork",
      schemaVersion: 1,
      parentConversationId: parentId,
    });
    if (orphaned.op !== "fork") throw new Error("conversation was not forked");
    await store.close();
    const restarted = new ConversationStore(root, async () => undefined);
    await expect(
      restarted.serve({
        op: "get",
        schemaVersion: 1,
        conversationId: orphaned.conversation.conversationId,
      }),
    ).resolves.toEqual({ op: "get", schemaVersion: 1 });
    await restarted.close();
  });
});
