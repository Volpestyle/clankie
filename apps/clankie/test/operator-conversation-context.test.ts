import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDurableTurn } from "../src/captain/captain.ts";
import { ConversationStore } from "../src/captain/conversations.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class OperatorSteerSession {
  public isStreaming = false;
  public readonly calls: { text: string; behavior: string | undefined }[] = [];
  /** Every run here settles clean; pi's failure shape is covered in captain-voice-steer. */
  public readonly state: {
    messages: { role: string; stopReason?: string; errorMessage?: string }[];
  } = { messages: [] };
  private readonly runs: { resolve: () => void }[] = [];

  public prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void> {
    this.calls.push({ text, behavior: options?.streamingBehavior });
    if (this.isStreaming && options?.streamingBehavior === "steer") return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.runs.push({
        resolve: () => {
          this.isStreaming = false;
          resolve();
        },
      });
    });
  }

  public startStreaming(): void {
    this.isStreaming = true;
  }

  public settleRun(): void {
    this.runs.shift()?.resolve();
  }
}

async function drain(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("operator conversation context", () => {
  it("queues internal turns without forging an operator message", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-conversation-internal-"));
    roots.push(root);
    const store = new ConversationStore(root, async (_conversationId, message, publish) => {
      publish({ type: "message", role: "captain", text: `ran: ${message}`, streaming: false });
    });

    const accepted = store.submitInternal("global-default", "scheduled wake", "wake");
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

  it("runs signed activity in a separate resumable Linear inbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-conversation-hook-"));
    roots.push(root);
    const origins: (string | undefined)[] = [];
    const store = new ConversationStore(root, async (_conversationId, message, publish, context) => {
      origins.push(context.origin);
      publish({ type: "message", role: "captain", text: `ran: ${message}`, streaming: false });
    });

    const inbox = store.linearInboxConversationId();
    expect(inbox).toBe("linear-inbox");
    expect(store.linearInboxConversationId()).toBe(inbox);
    expect(inbox).not.toBe(store.defaultGlobalConversationId());
    const accepted = store.submitInternal(inbox, "Linear activity on VUH-1234", "hook");
    if (accepted.status !== "accepted") throw new Error("hook turn was not accepted");
    await store.awaitRun(accepted.runId);

    // A distinct origin, so the turn can say the comment came from Linear
    // rather than passing as one of his own self-wakes.
    expect(origins).toEqual(["hook"]);
    const replay = await store.serve({
      op: "replay",
      schemaVersion: 1,
      replay: {
        schemaVersion: 1,
        conversationId: inbox,
        surfaceClientId: "test",
        limit: 20,
      },
    });
    if (replay.op !== "replay" || replay.result.status !== "page") throw new Error("replay failed");
    // He wrote the comment in Linear, not here: nothing may appear as though
    // he typed it into this conversation.
    expect(replay.result.events).not.toContainEqual(expect.objectContaining({ role: "operator" }));
    await store.close();
    const reopened = new ConversationStore(root, async () => {});
    expect(reopened.linearInboxConversationId()).toBe(inbox);
    expect(reopened.conversation("global-default")?.revision).toBe(0);
    await reopened.close();
  });

  it("keeps off-period Linear messages across restart without running a model or sending reply notifications", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-conversation-inbox-"));
    roots.push(root);
    let runs = 0;
    let notifications = 0;
    const store = new ConversationStore(root, async () => {
      runs += 1;
    });
    store.observeDurableMessages(() => {
      notifications += 1;
    });
    store.receiveLinearActivity("Linear issue created", false);
    store.receiveLinearActivity("Swarm comment added", false);
    expect(runs).toBe(0);
    expect(notifications).toBe(0);
    expect(store.conversation("global-default")?.revision).toBe(0);
    await store.close();
    const reopened = new ConversationStore(root, async () => {
      runs += 1;
    });
    const replay = await reopened.serve({
      op: "replay",
      schemaVersion: 1,
      replay: {
        schemaVersion: 1,
        conversationId: "linear-inbox",
        surfaceClientId: "test",
        limit: 20,
      },
    });
    if (replay.op !== "replay" || replay.result.status !== "page") throw new Error("replay failed");
    expect(replay.result.events.map((event) => event.type)).toEqual(["message", "message"]);
    expect(replay.result.events).toMatchObject([
      { role: "external", text: "Linear issue created" },
      { role: "external", text: "Swarm comment added" },
    ]);
    expect(runs).toBe(0);
    expect(reopened.readLinearInbox().unreadCount).toBe(2);
    const page = reopened.readLinearInbox();
    expect(reopened.readLinearInbox()).toEqual(page);
    expect(reopened.acknowledgeLinearInbox("999999999999")).toBe(false);
    expect(reopened.acknowledgeLinearInbox(page.ackCursor!)).toBe(true);
    expect(reopened.acknowledgeLinearInbox(page.ackCursor!)).toBe(true);
    expect(reopened.readLinearInbox().items).toHaveLength(0);
    reopened.receiveLinearActivity("New live activity", true);
    await reopened.close();
    expect(runs).toBe(1);
    const again = new ConversationStore(root, async () => {});
    expect(again.readLinearInbox().items).toMatchObject([{ text: "New live activity" }]);
    expect(again.acknowledgeLinearInbox(again.readLinearInbox().ackCursor!)).toBe(true);
    for (let i = 0; i < 25; i += 1) again.receiveLinearActivity(`event ${i}`, false);
    const offered = again.readLinearInbox();
    expect(offered).toMatchObject({ unreadCount: 25, hasMore: true });
    again.receiveLinearActivity("Arrived after the read", false);
    expect(again.acknowledgeLinearInbox(offered.ackCursor!)).toBe(true);
    expect(again.readLinearInbox()).toMatchObject({ unreadCount: 6, hasMore: false });
    again.acknowledgeLinearInbox(again.readLinearInbox().ackCursor!);
    for (let i = 0; i < 510; i += 1) again.receiveLinearActivity(`retained ${i}`, false);
    expect(again.readLinearInbox().unreadCount).toBe(510);
    await again.close();
  });

  it("bounds serialized output in bytes and preserves an unacknowledged page across restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-inbox-budget-"));
    roots.push(root);
    const store = new ConversationStore(root, async () => {});
    for (let i = 0; i < 20; i += 1) store.receiveLinearActivity("🍀".repeat(2000), false);
    const page = store.readLinearInbox();
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.length).toBeLessThan(20);
    expect(Buffer.byteLength(JSON.stringify({ schemaVersion: 1, ...page }))).toBeLessThan(31_000);
    await store.close();
    const reopened = new ConversationStore(root, async () => {});
    expect(reopened.readLinearInbox()).toEqual(page);
    expect(reopened.acknowledgeLinearInbox(page.ackCursor!)).toBe(true);
    expect(reopened.readLinearInbox().unreadCount).toBe(20 - page.items.length);
    await reopened.close();
  });

  it("reoffers legacy consumed history once, then preserves explicit acknowledgments", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-inbox-legacy-"));
    roots.push(root);
    const store = new ConversationStore(root, async () => {});
    store.receiveLinearActivity("Previously truncated", false);
    const page = store.readLinearInbox();
    store.acknowledgeLinearInbox(page.ackCursor!);
    await store.close();
    const path = join(root, "linear-inbox", "meta.json");
    const meta = JSON.parse(await readFile(path, "utf8"));
    delete meta.linearAckVersion;
    delete meta.linearOfferedCursor;
    await writeFile(path, JSON.stringify(meta));
    const reopened = new ConversationStore(root, async () => {});
    expect(reopened.readLinearInbox().unreadCount).toBe(1);
    reopened.acknowledgeLinearInbox(reopened.readLinearInbox().ackCursor!);
    await reopened.close();
    const again = new ConversationStore(root, async () => {});
    expect(again.readLinearInbox().unreadCount).toBe(0);
    await again.close();
  });

  it("steers a human send into an in-flight internal turn instead of queuing behind it", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-conversation-steer-"));
    roots.push(root);
    const session = new OperatorSteerSession();
    const lane = { session, capture: {}, running: undefined as Promise<boolean> | undefined };
    const started: string[] = [];
    const store = new ConversationStore(root, async (_conversationId, message, publish) => {
      started.push(message);
      const role = await runDurableTurn(lane, message, []);
      if (role === "absorbed") return;
      publish({
        type: "message",
        role: "captain",
        text: `reply:${session.calls.map((call) => call.text).join("|")}`,
        streaming: false,
      });
    });

    const internal = store.submitInternal("global-default", "autonomy", "goal");
    if (internal.status !== "accepted") throw new Error("internal turn was not accepted");
    await drain();
    expect(started).toEqual(["autonomy"]);
    session.startStreaming();

    const sent = await store.serve({
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId: "global-default",
        surfaceClientId: "test",
        expectedRevision: 1,
        message: "human",
      },
    });
    expect(sent.op).toBe("send");
    if (sent.op !== "send" || sent.result.status !== "accepted")
      throw new Error("human turn was not accepted");
    await drain();
    expect(started).toEqual(["autonomy", "human"]);
    expect(session.calls).toEqual([
      { text: "autonomy", behavior: undefined },
      { text: "human", behavior: "steer" },
    ]);

    session.settleRun();
    await store.awaitRun(internal.runId);
    await store.awaitRun(sent.result.runId);

    const replay = await store.serve({
      op: "replay",
      schemaVersion: 1,
      replay: {
        schemaVersion: 1,
        conversationId: "global-default",
        surfaceClientId: "test",
        limit: 40,
      },
    });
    if (replay.op !== "replay" || replay.result.status !== "page") throw new Error("replay failed");
    const captainMessages = replay.result.events.filter(
      (event) => event.type === "message" && event.role === "captain",
    );
    expect(captainMessages).toEqual([
      expect.objectContaining({ type: "message", role: "captain", text: "reply:autonomy|human" }),
    ]);
    expect(replay.result.events).toContainEqual(expect.objectContaining({ role: "operator", text: "human" }));
    await store.close();
  });

  it("still serializes a second human send behind an in-flight human turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-conversation-fifo-"));
    roots.push(root);
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const store = new ConversationStore(root, async (_conversationId, message) => {
      started.push(`start:${message}`);
      if (message === "first") await firstGate;
      started.push(`end:${message}`);
    });

    const first = await store.serve({
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId: "global-default",
        surfaceClientId: "test",
        expectedRevision: 0,
        message: "first",
      },
    });
    if (first.op !== "send" || first.result.status !== "accepted")
      throw new Error("first turn was not accepted");
    await drain();
    const second = await store.serve({
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId: "global-default",
        surfaceClientId: "test",
        expectedRevision: 1,
        message: "second",
      },
    });
    if (second.op !== "send" || second.result.status !== "accepted")
      throw new Error("second turn was not accepted");
    await drain();
    expect(started).toEqual(["start:first"]);
    releaseFirst();
    await store.awaitRun(first.result.runId);
    await store.awaitRun(second.result.runId);
    expect(started).toEqual(["start:first", "end:first", "start:second", "end:second"]);
    await store.close();
  });

  it("keeps FIFO when a human send arrives while a continuation is only queued", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-conversation-queued-internal-"));
    roots.push(root);
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const store = new ConversationStore(root, async (_conversationId, message) => {
      started.push(`start:${message}`);
      if (message === "first") await firstGate;
      started.push(`end:${message}`);
    });

    const first = await store.serve({
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId: "global-default",
        surfaceClientId: "test",
        expectedRevision: 0,
        message: "first",
      },
    });
    if (first.op !== "send" || first.result.status !== "accepted")
      throw new Error("first turn was not accepted");
    await drain();
    expect(started).toEqual(["start:first"]);

    const internal = store.submitInternal("global-default", "queued-wake", "wake");
    if (internal.status !== "accepted") throw new Error("internal turn was not accepted");
    await drain();
    expect(started).toEqual(["start:first"]);

    const second = await store.serve({
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId: "global-default",
        surfaceClientId: "test",
        expectedRevision: 2,
        message: "second",
      },
    });
    if (second.op !== "send" || second.result.status !== "accepted")
      throw new Error("second turn was not accepted");
    await drain();
    expect(started).toEqual(["start:first"]);

    releaseFirst();
    await store.awaitRun(first.result.runId);
    await store.awaitRun(internal.runId);
    await store.awaitRun(second.result.runId);
    expect(started).toEqual([
      "start:first",
      "end:first",
      "start:queued-wake",
      "end:queued-wake",
      "start:second",
      "end:second",
    ]);
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
