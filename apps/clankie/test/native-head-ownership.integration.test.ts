import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ConversationStore } from "../src/captain/conversations.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("retains observed native head ownership across restart and retires it only on explicit reset", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-native-head-"));
  roots.push(root);
  const conversationRoot = join(root, "conversations");
  const store = new ConversationStore(conversationRoot, async () => {});
  const id = store.defaultGlobalConversationId();
  store.syncHeadTranscript("head-seat", {
    sessionKey: "native-head-transcript",
    entries: [{ type: "message", id: "entry-1", role: "agent", text: "A settled head response." }],
  });
  const path = join(conversationRoot, id, "meta.json");
  const checkpoint = JSON.parse(await readFile(path, "utf8")).seatTranscript;
  store.rememberNativeHead(id, "native-occupant-1");
  expect(store.hasNativeSeat(id)).toBe(true);
  expect(JSON.parse(await readFile(path, "utf8")).seatTranscript).toEqual(checkpoint);
  await store.close();
  const restarted = new ConversationStore(conversationRoot, async () => {});
  try {
    expect(restarted.hasNativeSeat(id)).toBe(true);
    await restarted.serve({
      schemaVersion: 1,
      op: "reset",
      conversationId: id,
      expectedRevision: restarted.conversation(id)!.revision,
    });
    expect(restarted.hasNativeSeat(id)).toBe(false);
    const current = JSON.parse(await readFile(path, "utf8"));
    expect(current.nativeSeatSessions).toEqual({ "native-occupant-1": "retired" });
  } finally {
    await restarted.close();
  }
});
