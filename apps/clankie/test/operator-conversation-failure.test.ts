import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationStore } from "../src/captain/conversations.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function failingStore(error: unknown): Promise<ConversationStore> {
  const root = await mkdtemp(join(tmpdir(), "clankie-conversation-failure-"));
  roots.push(root);
  return new ConversationStore(root, () => Promise.reject(error));
}

async function failedTurn(store: ConversationStore, message: string) {
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
  await store.awaitRun(sent.result.runId);
  const replay = await store.serve({
    op: "replay",
    schemaVersion: 1,
    replay: { schemaVersion: 1, conversationId: "global-default", surfaceClientId: "test", limit: 50 },
  });
  if (replay.op !== "replay" || replay.result.status !== "page") throw new Error("replay failed");
  const failure = replay.result.events.find((event) => event.type === "turn" && event.phase === "failed");
  if (failure === undefined || failure.type !== "turn") throw new Error("no failed turn recorded");
  return failure;
}

describe("operator turn failure", () => {
  it("carries the error message, not just its class name", async () => {
    const store = await failingStore(new Error("model runtime has no credential for anthropic"));
    const failure = await failedTurn(store, "hiii");
    expect(failure.reasonCode).toBe("Error");
    expect(failure.summary).toBe("model runtime has no credential for anthropic");
  });

  it("unwraps the cause chain, where the real detail usually hides", async () => {
    const store = await failingStore(
      new Error("session start failed", { cause: new Error("401 invalid api key") }),
    );
    const failure = await failedTurn(store, "hiii");
    expect(failure.summary).toBe("session start failed: 401 invalid api key");
  });

  it("truncates a summary too long for the protocol", async () => {
    const store = await failingStore(new Error("x".repeat(900)));
    const failure = await failedTurn(store, "hiii");
    expect(failure.summary?.length).toBe(512);
    expect(failure.summary?.endsWith("…")).toBe(true);
  });
});
