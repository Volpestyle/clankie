import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { ConversationStore } from "../src/captain/conversations.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() {
  const home = await mkdtemp(join(tmpdir(), "clankie-reset-"));
  roots.push(home);
  return home;
}

it("archives transcript and Pi context, retains identity, invalidates cursors, and resumes fresh after restart", async () => {
  const home = await root();
  const path = join(home, "conversations");
  const evicted: string[] = [];
  const store = new ConversationStore(
    path,
    async (_id, message, publish) => {
      publish({ type: "message", role: "captain", text: message, streaming: false });
    },
    (id) => {
      evicted.push(id);
    },
  );
  const id = store.defaultGlobalConversationId();
  const accepted = store.submitInternal(id, "old context", "wake");
  if (accepted.status !== "accepted") throw new Error("not accepted");
  await store.awaitRun(accepted.runId);
  const before = store.conversation(id)!;
  const events = await readFile(join(path, id, "events.jsonl"), "utf8");
  const last = JSON.parse(events.trim().split("\n").at(-1)!);
  await mkdir(join(path, id, "pi"));
  await writeFile(join(path, id, "pi", "session.jsonl"), "old model context");
  const result = await store.serve({
    op: "reset",
    schemaVersion: 1,
    conversationId: id,
    expectedRevision: before.revision,
  });
  if (result.op !== "reset") throw new Error("wrong response");
  expect(result.conversation).toMatchObject({
    conversationId: id,
    title: before.title,
    isDefault: true,
    revision: before.revision + 1,
    sessionState: "unbound",
  });
  expect(result.conversation.contextUsage).toBeUndefined();
  expect(evicted).toEqual([id]);
  const archive = join(home, "conversation-archives", result.archiveId);
  expect(await readFile(join(archive, "events.jsonl"), "utf8")).toBe(events);
  expect(await readFile(join(archive, "pi", "session.jsonl"), "utf8")).toBe("old model context");
  await expect(readFile(join(path, id, "pi", "session.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  const replay = await store.serve({
    op: "replay",
    schemaVersion: 1,
    replay: {
      schemaVersion: 1,
      conversationId: id,
      surfaceClientId: "test",
      cursor: last.cursor,
      limit: 20,
    },
  });
  expect(replay).toMatchObject({ op: "replay", result: { status: "recover", code: "cursor_expired" } });
  await store.close();
  const reopened = new ConversationStore(path, async () => {});
  expect(reopened.conversation(id)).toEqual(result.conversation);
  await reopened.close();
});

it("refuses active turns and stale revisions without changing the session", async () => {
  const path = join(await root(), "conversations");
  let finish!: () => void;
  const running = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const store = new ConversationStore(path, async () => running);
  const id = store.defaultGlobalConversationId();
  const accepted = store.submitInternal(id, "work", "wake");
  if (accepted.status !== "accepted") throw new Error("not accepted");
  const reset = () =>
    store.serve({
      op: "reset",
      schemaVersion: 1,
      conversationId: id,
      expectedRevision: store.conversation(id)!.revision,
    });
  await expect(reset()).rejects.toThrow("Wait for the current turn");
  finish();
  await store.awaitRun(accepted.runId);
  await expect(
    store.serve({ op: "reset", schemaVersion: 1, conversationId: id, expectedRevision: 0 }),
  ).rejects.toThrow("Conversation changed");
  expect(store.conversation(id)?.revision).toBe(1);
  await store.close();
});

it("finishes an interrupted archive swap on startup", async () => {
  const home = await root();
  const path = join(home, "conversations");
  const store = new ConversationStore(path, async () => {});
  await store.close();
  const archived = join(home, "conversation-archives", "reset-aaaaaaaa");
  const pending = `${archived}.pending`;
  await mkdir(pending, { recursive: true });
  const meta = JSON.parse(await readFile(join(path, "global-default", "meta.json"), "utf8"));
  await writeFile(
    join(pending, "meta.json"),
    JSON.stringify({ ...meta, revision: 1, retainedFromCursor: "000000000001" }),
  );
  await rename(join(path, "global-default"), archived);
  const reopened = new ConversationStore(path, async () => {});
  expect(reopened.conversation("global-default")?.revision).toBe(1);
  expect(JSON.parse(await readFile(join(archived, "meta.json"), "utf8")).revision).toBe(0);
  await reopened.close();
});

it("restores the live transcript when reset cleanup fails", async () => {
  const home = await root();
  const path = join(home, "conversations");
  const store = new ConversationStore(
    path,
    async () => {},
    () => {
      throw new Error("cleanup failed");
    },
  );
  const id = store.defaultGlobalConversationId();
  const before = await readFile(join(path, id, "meta.json"), "utf8");
  await expect(
    store.serve({ op: "reset", schemaVersion: 1, conversationId: id, expectedRevision: 0 }),
  ).rejects.toThrow("cleanup failed");
  expect(await readFile(join(path, id, "meta.json"), "utf8")).toBe(before);
  await store.close();
  const reopened = new ConversationStore(path, async () => {});
  expect(reopened.conversation(id)?.revision).toBe(0);
  await reopened.close();
});
