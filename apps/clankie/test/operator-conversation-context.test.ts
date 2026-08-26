import { mkdtemp, rm } from "node:fs/promises";
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

    const internal = store.submitInternal("global-default", "autonomy");
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
