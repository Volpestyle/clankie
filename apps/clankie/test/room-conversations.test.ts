import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OperatorConversationServiceResultSchema } from "@clankie/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationStore } from "../src/captain/conversations.ts";
import { RoomConversations } from "../src/captain/room-conversations.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const at = new Date().toISOString();
const line = (id: string, parentId: string | null, message: unknown) =>
  JSON.stringify({ type: "message", id, parentId, timestamp: at, message }) + "\n";
const user = {
  role: "user",
  content: [{ type: "text", text: "Trigger message from <42>:\nshow us houses" }],
};
const tool = {
  role: "assistant",
  content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "homes list" } }],
};

it("discovers trusted, one-shot and voice histories, then tails tool results without replaying them after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-room-conversations-"));
  roots.push(root);
  const path = join(
    root,
    "rooms",
    encodeURIComponent("discord:clankie:discord:123:456:authority:system"),
    "session.jsonl",
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, line("u", null, user) + line("a", "u", tool));
  const original = await readFile(path, "utf8");
  const runner = vi.fn(async () => undefined);
  let store = new ConversationStore(join(root, "conversations"), runner);
  let rooms = new RoomConversations(store);
  rooms.discover(root);
  const conversationId = store.roomConversation("discord_presence", "123:456");
  const replay = async () => {
    const response = await store.serve({
      op: "replay",
      schemaVersion: 1,
      replay: { schemaVersion: 1, conversationId, surfaceClientId: "test", limit: 100 },
    });
    OperatorConversationServiceResultSchema.parse(response);
    if (response.op !== "replay" || response.result.status !== "page") throw new Error("expected replay");
    return response.result;
  };
  const first = await replay();
  expect(
    first.events.some(
      (event) => event.type === "tool" && event.phase === "started" && event.detail?.includes("homes list"),
    ),
  ).toBe(true);
  expect(
    first.events.some(
      (event) =>
        event.type === "message" && event.role === "external" && event.text.includes("show us houses"),
    ),
  ).toBe(true);
  expect(await readFile(path, "utf8")).toBe(original);
  const pending = store.serve({
    op: "tail",
    schemaVersion: 1,
    tail: {
      schemaVersion: 1,
      conversationId,
      surfaceClientId: "test",
      cursor: first.nextCursor,
      waitMs: 1000,
    },
  });
  await appendFile(
    path,
    line("r", "a", {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "Durham Dr, $525000" }],
    }),
  );
  rooms.sync(conversationId, path);
  const tailed = await pending;
  expect(
    tailed.op === "tail" &&
      tailed.result.status === "page" &&
      tailed.result.events.some(
        (event) => event.type === "tool" && event.phase === "completed" && event.detail?.includes("Durham"),
      ),
  ).toBe(true);
  const before = (await replay()).events;
  await store.close();
  store = new ConversationStore(join(root, "conversations"), runner);
  rooms = new RoomConversations(store);
  rooms.discover(root);
  expect((await replay()).events).toEqual(before);
  const shot = join(root, "turns", "discord_presence~123%3A456", "oneshot.jsonl");
  await mkdir(dirname(shot), { recursive: true });
  await writeFile(shot, line("u", null, user));
  const voice = join(root, "voice", encodeURIComponent("discord-voice:clankie:123:456"), "voice.jsonl");
  await mkdir(dirname(voice), { recursive: true });
  await writeFile(voice, line("v", null, user));
  rooms.discover(root);
  const after = await replay();
  expect(
    after.events.filter((event) => event.type === "message" && event.text.includes("show us houses")),
  ).toHaveLength(2);
  const list = await store.serve({ op: "list", schemaVersion: 1 });
  expect(list.op === "list" && list.conversations.filter((item) => item.scope.kind === "room")).toHaveLength(
    2,
  );
  await expect(
    store.serve({
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId,
        expectedRevision: 0,
        surfaceClientId: "test",
        message: "secret",
      },
    }),
  ).rejects.toThrow("read-only");
  await expect(
    store.serve({ op: "fork", schemaVersion: 1, parentConversationId: conversationId }),
  ).rejects.toThrow();
  await expect(
    store.serve({ op: "reset", schemaVersion: 1, conversationId, expectedRevision: 0 }),
  ).rejects.toThrow();
  expect(runner).not.toHaveBeenCalled();
  store.publishRoomEvent(conversationId, { type: "turn", runId: "one", phase: "accepted" });
  store.publishRoomEvent(conversationId, { type: "turn", runId: "two", phase: "accepted" });
  store.publishRoomEvent(conversationId, { type: "turn", runId: "one", phase: "completed" });
  expect(store.conversation(conversationId)?.sessionState).toBe("active");
  store.publishRoomEvent(conversationId, {
    type: "turn",
    runId: "two",
    phase: "failed",
    reasonCode: "test_failure",
  });
  expect(store.conversation(conversationId)?.sessionState).toBe("failed");
  await store.close();
});
