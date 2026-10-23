import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OperatorConversationStreamEventSchema } from "@clankie/protocol";
import { SeatTranscriptUploadSchema, parseHerdrSeatTranscript } from "@clankie/agent-transcript";
import { ConversationStore } from "../src/captain/conversations.ts";
import { nativeConversationPage } from "../src/captain/native-conversation.ts";
import { replayConversation } from "./conversation-requests.ts";

// VUH-2680: Claude records an interrupt as a user record. It is the durable
// "stopped" marker every device should see, not the owner's own words. The
// fixtures are real Claude records, trimmed to the fields the reader uses:
// the live Stop proof's interrupt (2.1.309), a rejected tool use (2.1.295) and
// an interrupt from before `interruptedMessageId` existed (2.1.283).

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const golden = (name: string) =>
  readFile(new URL(`./fixtures/claude-interrupt/${name}.jsonl`, import.meta.url), "utf8");
const marker = (entryId: string) => ({
  type: "turn",
  runId: `native-interrupt:${entryId}`,
  phase: "cancelled",
  reasonCode: "native_interrupted",
  summary: "Stopped before it finished.",
});

it("reads every Claude interrupt shape as an interrupt, never as the owner's message", async () => {
  const plain = parseHerdrSeatTranscript("claude", await golden("plain"));
  expect(plain).toEqual([
    expect.objectContaining({ type: "message", role: "agent" }),
    {
      type: "interrupted",
      id: "claude:5ad19b2a-b9b3-4573-afce-f67be891281b",
      occurredAt: "2026-10-23T03:59:33.161Z",
    },
    expect.objectContaining({
      type: "message",
      role: "operator",
      text: "Queued while you worked: reply with just the word RECEIVED.",
    }),
  ]);
  const tool = parseHerdrSeatTranscript("claude", await golden("tool-use"));
  expect(tool.map((entry) => [entry.type, "phase" in entry ? entry.phase : undefined])).toEqual([
    ["tool", "started"],
    // The rejected tool keeps its own failed row; the interrupt follows it.
    ["tool", "failed"],
    ["interrupted", undefined],
  ]);
  const legacy = parseHerdrSeatTranscript("claude", await golden("legacy"));
  expect(legacy).toEqual([
    {
      type: "interrupted",
      id: "claude:0557c972-952b-407c-ae46-31cdc2af6170",
      occurredAt: "2026-09-27T15:56:26.517Z",
    },
  ]);
  for (const entries of [plain, tool, legacy])
    expect(
      entries.some((entry) => entry.type === "message" && entry.text.includes("[Request interrupted")),
    ).toBe(false);
  // The owner typing the same words is plain string content: still their message.
  const typed = parseHerdrSeatTranscript(
    "claude",
    `${JSON.stringify({
      type: "user",
      uuid: "typed-1",
      parentUuid: null,
      timestamp: "2026-10-23T04:00:00.000Z",
      message: { role: "user", content: "[Request interrupted by user]" },
    })}\n`,
  );
  expect(typed).toEqual([expect.objectContaining({ type: "message", role: "operator" })]);
  // A seat hook may upload it.
  expect(
    SeatTranscriptUploadSchema.parse({ sessionId: crypto.randomUUID(), entries: plain }).entries,
  ).toHaveLength(3);
});

it("publishes one cancelled turn per interrupt, idempotently, without counting a run", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-interrupt-"));
  roots.push(root);
  const store = new ConversationStore(root, vi.fn());
  const id = store.defaultGlobalConversationId();
  const before = store.conversation(id)!;
  const entries = parseHerdrSeatTranscript("claude", await golden("plain"));
  const sessionId = "10000000-0000-4000-8000-000000000001";

  expect(store.syncNativeSeatTranscript(id, sessionId, entries, "waiting")).toBe(true);
  // The same records arrive again from the next hook and from Herdr's own tail.
  expect(store.syncNativeSeatTranscript(id, sessionId, entries)).toBe(true);
  store.syncNativeSeatTranscript(id, sessionId, parseHerdrSeatTranscript("claude", await golden("tool-use")));

  const page = await replayConversation(store, { conversationId: id, surfaceClientId: "test" });
  if (page.op !== "replay" || page.result.status !== "page") throw new Error(JSON.stringify(page));
  const events = page.result.events;
  // Every event still parses under the strict protocol schema older builds use.
  for (const event of events) OperatorConversationStreamEventSchema.parse(event);
  const turns = events.filter((event) => event.type === "turn");
  expect(turns).toEqual([
    expect.objectContaining(marker("claude:5ad19b2a-b9b3-4573-afce-f67be891281b")),
    expect.objectContaining(marker("claude:63672f39-4b42-4e78-a69c-949f22aa2340")),
  ]);
  expect(
    events.some((event) => event.type === "message" && event.text.includes("[Request interrupted")),
  ).toBe(false);
  // A marker is history, not a service run: nothing is left active or failed.
  expect(store.serviceTrackedIdle(id)).toBe(true);
  expect(store.conversation(id)!.sessionState).toBe(before.sessionState);
  await store.close();
});

it("shows the same single marker in a native read-through page, at a stable cursor", async () => {
  const transcript = {
    sessionKey: "claude:session",
    entries: parseHerdrSeatTranscript("claude", await golden("plain")),
  };
  const conversation = {
    schemaVersion: 1 as const,
    conversationId: "native-chat",
    scope: { kind: "persona" as const, personaId: "agent" },
    title: "Native agent",
    isDefault: false,
    createdAt: "2026-10-23T00:00:00Z",
    updatedAt: "2026-10-23T00:00:00Z",
    revision: 0,
    sessionState: "waiting" as const,
  };
  const request = { schemaVersion: 1 as const, conversationId: "native-chat", surfaceClientId: "app" };
  const [first, again] = await Promise.all([
    nativeConversationPage(conversation, transcript, "idle", request),
    nativeConversationPage(conversation, transcript, "idle", request),
  ]);
  if (first.status !== "page") throw new Error("page expected");
  const turns = first.events.filter((event) => event.type === "turn");
  expect(turns).toEqual([expect.objectContaining(marker("claude:5ad19b2a-b9b3-4573-afce-f67be891281b"))]);
  for (const event of first.events) OperatorConversationStreamEventSchema.parse(event);
  expect(again).toEqual(first);
});
