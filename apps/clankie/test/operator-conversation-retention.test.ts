import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConversationStore,
  OPERATOR_CONVERSATION_RETAINED_BYTES_MAX,
  OPERATOR_CONVERSATION_RETAINED_EVENTS_MAX,
  OPERATOR_CONVERSATION_RETAINED_MAX,
  OPERATOR_CONVERSATION_RETENTION_MS,
} from "../src/captain/conversations.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clankie-conversation-retention-"));
  roots.push(root);
  return root;
}

describe("operator conversation retention", () => {
  it("closes whole inactive conversations but protects active and default rooms", async () => {
    const root = await temporaryRoot();
    let release!: () => void;
    const running = new Promise<void>((resolve) => {
      release = resolve;
    });
    const removed: string[] = [];
    const store = new ConversationStore(
      root,
      async () => running,
      (conversationId) => {
        removed.push(conversationId);
      },
    );
    const created = await store.serve({
      op: "create",
      schemaVersion: 1,
      scope: { kind: "global" },
      title: "temporary",
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
        message: "stay alive",
      },
    });
    if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("turn was not accepted");

    await expect(
      store.serve({ op: "close", schemaVersion: 1, conversationId: "global-default" }),
    ).resolves.toMatchObject({ op: "close", closed: false });
    await expect(store.serve({ op: "close", schemaVersion: 1, conversationId })).resolves.toMatchObject({
      op: "close",
      closed: false,
    });

    release();
    await store.awaitRun(sent.result.runId);
    await expect(store.serve({ op: "close", schemaVersion: 1, conversationId })).resolves.toMatchObject({
      op: "close",
      closed: true,
    });
    expect(removed).toContain(conversationId);
    await expect(store.serve({ op: "get", schemaVersion: 1, conversationId })).resolves.toEqual({
      op: "get",
      schemaVersion: 1,
    });
    await store.close();
  });

  it("bounds replay while keeping cursors monotonic", async () => {
    const root = await temporaryRoot();
    const store = new ConversationStore(root, async (_conversationId, _message, publish) => {
      for (let index = 0; index < OPERATOR_CONVERSATION_RETAINED_EVENTS_MAX; index += 1) {
        publish({ type: "activity", phase: "thinking" });
      }
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
        message: "fill the retained event window",
      },
    });
    if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("turn was not accepted");
    await store.awaitRun(sent.result.runId);

    const expired = await store.serve({
      op: "replay",
      schemaVersion: 1,
      replay: {
        schemaVersion: 1,
        conversationId: "global-default",
        surfaceClientId: "test",
      },
    });
    expect(expired.op === "replay" ? expired.result : undefined).toMatchObject({
      status: "recover",
      code: "cursor_expired",
      recoverable: true,
    });
    if (expired.op !== "replay" || expired.result.status !== "recover") {
      throw new Error("expired cursor did not recover");
    }
    const replay = await store.serve({
      op: "replay",
      schemaVersion: 1,
      replay: {
        schemaVersion: 1,
        conversationId: "global-default",
        surfaceClientId: "test",
        cursor: expired.result.resetCursor,
        limit: 500,
      },
    });
    expect(
      replay.op === "replay" && replay.result.status === "page" ? replay.result.events : [],
    ).toHaveLength(400);
    const next = await store.serve({
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId: "global-default",
        surfaceClientId: "test",
        expectedRevision: 1,
        message: "continue after trimming",
      },
    });
    expect(next.op === "send" && next.result.status === "accepted" ? next.result.safeCursor : undefined).toBe(
      "000000000503",
    );
    if (next.op === "send" && next.result.status === "accepted") await store.awaitRun(next.result.runId);
    await store.close();
  });

  it("prunes whole inactive conversation directories by count, age, and retained bytes", async () => {
    const root = await temporaryRoot();
    const pruned: string[] = [];
    const store = new ConversationStore(
      root,
      async () => undefined,
      (conversationId) => {
        pruned.push(conversationId);
      },
    );
    let oldest = "";
    for (let index = 0; index < OPERATOR_CONVERSATION_RETAINED_MAX; index += 1) {
      const result = await store.serve({
        op: "create",
        schemaVersion: 1,
        scope: { kind: "global" },
        title: `conversation ${index}`,
      });
      if (result.op !== "create") throw new Error("conversation was not created");
      if (index === 0) oldest = result.conversation.conversationId;
    }
    expect(pruned).toContain(oldest);

    const aged = await store.serve({
      op: "create",
      schemaVersion: 1,
      scope: { kind: "global" },
      title: "aged conversation",
    });
    if (aged.op !== "create") throw new Error("conversation was not created");
    const agedMetaPath = join(root, aged.conversation.conversationId, "meta.json");
    const agedMeta = JSON.parse(await readFile(agedMetaPath, "utf8")) as { updatedAt: string };
    agedMeta.updatedAt = new Date(Date.now() - OPERATOR_CONVERSATION_RETENTION_MS - 1).toISOString();
    await writeFile(agedMetaPath, JSON.stringify(agedMeta), "utf8");
    await store.close();
    const restarted = new ConversationStore(
      root,
      async () => undefined,
      (conversationId) => {
        pruned.push(conversationId);
      },
    );
    expect(pruned).toContain(aged.conversation.conversationId);

    const large = await restarted.serve({
      op: "create",
      schemaVersion: 1,
      scope: { kind: "global" },
      title: "large conversation",
    });
    if (large.op !== "create") throw new Error("conversation was not created");
    const pi = join(root, large.conversation.conversationId, "pi");
    await mkdir(pi);
    await writeFile(join(pi, "session.jsonl"), "");
    await truncate(join(pi, "session.jsonl"), OPERATOR_CONVERSATION_RETAINED_BYTES_MAX + 1);
    await restarted.serve({
      op: "create",
      schemaVersion: 1,
      scope: { kind: "global" },
      title: "protected newest conversation",
    });
    expect(pruned).toContain(large.conversation.conversationId);
    await restarted.close();
  });
});
