import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { replayConversation } from "./conversation-requests.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import type { LinearActivityEvent } from "../src/linear-webhook.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "linear-chat-wake-"));
  roots.push(root);
  return root;
}

function notice(title: string, overrides: Partial<LinearActivityEvent> = {}): LinearActivityEvent {
  return {
    eventId: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    organizationId: "96d2a27b-950b-4a8a-afae-8776605c0ef1",
    issueId: "593644be-7b60-4a77-9b58-7b0dc20be894",
    deliveryId: undefined,
    type: "Comment",
    action: "create",
    actorName: "James",
    actorEmail: "volpestyle@gmail.com",
    createdAt: new Date().toISOString(),
    url: "https://linear.app/fixture/issue/VUH-1678",
    data: { issue: { identifier: "VUH-1678", title }, body: "Please take a look" },
    updatedFrom: undefined,
    ...overrides,
  };
}

function fixture(root = temporaryRoot()) {
  const wakes: { id: string; prompt: string | undefined }[] = [];
  const store = new ConversationStore(root, async (id, _message, publish, context) => {
    const prompt = store.linearWakePrompt(id, context.runId);
    wakes.push({ id, prompt });
    publish({ type: "message", role: "captain", text: "Reviewed Linear activity", streaming: false });
  });
  return { root, store, wakes };
}

async function chat(store: ConversationStore) {
  const result = await store.serve({
    op: "create",
    schemaVersion: 1,
    scope: { kind: "global" },
    title: "Linear",
  });
  if (result.op !== "create") throw new Error("No conversation");
  return result.conversation.conversationId;
}

async function events(store: ConversationStore, conversationId = "global-default") {
  const result = await replayConversation(store, { conversationId, surfaceClientId: "owner", limit: 100 });
  if (result.op !== "replay" || result.result.status !== "page") throw new Error("No replay");
  return result.result.events;
}

it("writes verified context and wakes the ordinary global-default chat without an inbox protocol", async () => {
  const f = fixture();
  f.store.receiveLinearActivity(notice("Lead notification"), true);
  await f.store.close();
  expect(f.wakes).toEqual([{ id: "global-default", prompt: expect.stringContaining("Lead notification") }]);
  expect(f.wakes[0]?.prompt).toContain("VUH-1678");
  expect(f.wakes[0]?.prompt).toContain("James");
  expect(f.wakes[0]?.prompt).toContain("https://linear.app/fixture/issue/VUH-1678");
  expect(f.wakes[0]?.prompt).not.toContain("inbox");
  const replay = await events(f.store);
  expect(replay).toContainEqual(expect.objectContaining({ type: "message", role: "external" }));
  expect(replay).toContainEqual(expect.objectContaining({ type: "message", role: "captain" }));
  expect(replay).not.toContainEqual(expect.objectContaining({ role: "operator" }));
  expect(existsSync(join(f.root, "linear-inbox"))).toBe(false);
  const listing = await f.store.serve({ op: "list", schemaVersion: 1 });
  expect(listing.op === "list" && listing.conversations.map((item) => item.conversationId)).toEqual([
    "global-default",
  ]);
});

it("uses the selected ordinary chat and ignores old per-issue or native reply recipients", async () => {
  const f = fixture();
  const target = await chat(f.store);
  f.store.receiveLinearActivity(
    notice("Chosen chat", {
      replyRecipient: {
        parentType: "ProjectUpdate",
        parentId: "d9b90f52-0b0e-463d-a1e9-9457d250592c",
        recordedAt: Date.now(),
        recipient: {
          kind: "native",
          paneId: "other/w3",
          seatId: "other/seat",
          occupantId: "other-session",
          binding: "a".repeat(64),
        },
      },
    }),
    true,
    target,
  );
  await f.store.close();
  expect(f.wakes.map((wake) => wake.id)).toEqual([target]);
  expect(await events(f.store, "global-default")).toEqual([]);
  expect(f.store.conversation(target)).toMatchObject({ title: "Linear", scope: { kind: "global" } });
  expect(f.store.linearWakeTargetAllowed("missing")).toBe(false);
  expect(() => f.store.receiveLinearActivity(notice("Missing target"), true, "missing")).toThrow(
    "existing ordinary global chat",
  );
});

it("coalesces deliveries arriving across a burst into one compact chat wake", async () => {
  const f = fixture();
  for (let index = 0; index < 4; index += 1) {
    f.store.receiveLinearActivity(notice(`Burst ${index}`), true);
    if (index < 3) await new Promise((resolve) => setTimeout(resolve, 120));
  }
  await f.store.close();
  expect(f.wakes).toHaveLength(1);
  expect(f.wakes[0]?.prompt).toContain("4 new events");
  for (let index = 0; index < 4; index += 1) expect(f.wakes[0]?.prompt).toContain(`Burst ${index}`);
  expect(
    (await events(f.store)).filter((event) => event.type === "turn" && event.phase === "accepted"),
  ).toHaveLength(1);
});

it("coalesces new deliveries during an active wake into one queued follow-up", async () => {
  const root = temporaryRoot();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prompts: string[] = [];
  const store = new ConversationStore(root, async (id, _message, _publish, context) => {
    prompts.push(store.linearWakePrompt(id, context.runId)!);
    if (prompts.length === 1) await held;
  });
  store.receiveLinearActivity(notice("First active wake"), true);
  const firstClosing = store.close();
  await vi.waitFor(() => expect(prompts).toHaveLength(1));
  for (let index = 0; index < 4; index += 1) store.receiveLinearActivity(notice(`Follow-up ${index}`), true);
  const finalClosing = store.close();
  release();
  await Promise.all([firstClosing, finalClosing]);
  expect(prompts).toHaveLength(2);
  expect(prompts[0]).toContain("1 new event");
  expect(prompts[1]).toContain("4 new events");
  expect(prompts[1]).not.toContain("First active wake");
});

it("retains passive events as ordinary history without upgrading duplicates into wakes", async () => {
  const f = fixture();
  const passive = notice("Passive history");
  expect(f.store.receiveLinearActivity(passive, false)).toBe(true);
  expect(f.store.receiveLinearActivity(passive, true)).toBe(false);
  await f.store.close();
  expect(f.wakes).toEqual([]);
  const reopened = fixture(f.root);
  reopened.store.receiveLinearActivity(notice("New attention"), true);
  await reopened.store.close();
  expect(reopened.wakes[0]?.prompt).toContain("New attention");
  expect(reopened.wakes[0]?.prompt).not.toContain("Passive history");
  expect(
    (await events(reopened.store)).filter((event) => event.type === "message" && event.role === "external"),
  ).toHaveLength(2);
});

it("keeps replay dedupe across restart, chat changes, and removed conversation history", async () => {
  const f = fixture();
  const activity = notice("Retained receipt");
  f.store.receiveLinearActivity(activity, false);
  const target = await chat(f.store);
  await f.store.close();
  writeFileSync(join(f.root, "global-default", "events.jsonl"), "");
  const reopened = fixture(f.root);
  expect(reopened.store.receiveLinearActivity(activity, true, target)).toBe(false);
  await reopened.store.close();
  expect(reopened.wakes).toEqual([]);
  expect(JSON.parse(readFileSync(join(f.root, "linear-event-receipts.json"), "utf8"))).toHaveProperty(
    activity.eventId!,
  );
});

it("drops legacy unread inbox items once, removes routing and read/ack state, and preserves unrelated chats", async () => {
  const f = fixture();
  const target = await chat(f.store);
  await f.store.close();
  const metaPath = join(f.root, target, "meta.json");
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  Object.assign(meta, {
    linearReadCursor: "000000000001",
    linearOfferedCursor: "000000000002",
    linearAckVersion: 1,
  });
  writeFileSync(metaPath, JSON.stringify(meta));
  const legacyPath = join(f.root, "linear-inbox");
  mkdirSync(legacyPath);
  writeFileSync(join(legacyPath, "meta.json"), JSON.stringify({ linearReadCursor: "000000000000" }));
  const old = notice("Legacy unread");
  writeFileSync(
    join(legacyPath, "events.jsonl"),
    JSON.stringify({
      schemaVersion: 1,
      conversationId: "linear-inbox",
      cursor: "000000000001",
      revision: 1,
      occurredAt: new Date().toISOString(),
      type: "message",
      role: "external",
      text: "Legacy unread",
      linear: { eventId: old.eventId, conversationId: "linear-inbox", following: true, notification: true },
    }) + "\n",
  );
  writeFileSync(join(f.root, "linear-work.json"), "[]");
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const migrated = fixture(f.root);
  await migrated.store.close();
  expect(migrated.wakes).toEqual([]);
  expect(migrated.store.conversation(target)?.title).toBe("Linear");
  expect(existsSync(legacyPath)).toBe(false);
  expect(existsSync(join(f.root, "linear-work.json"))).toBe(false);
  expect(log).toHaveBeenCalledWith(
    "Retired Linear inbox: dropped 1 unread event(s); removed legacy conversation state.",
  );
  const cleaned = JSON.parse(readFileSync(metaPath, "utf8"));
  expect(cleaned).not.toHaveProperty("linearReadCursor");
  expect(cleaned).not.toHaveProperty("linearOfferedCursor");
  expect(cleaned).not.toHaveProperty("linearAckVersion");
  expect(migrated.store.receiveLinearActivity(old, true)).toBe(false);
  const callCount = log.mock.calls.length;
  const again = fixture(f.root);
  await again.store.close();
  expect(log).toHaveBeenCalledTimes(callCount);
  expect(again.wakes).toEqual([]);
});

it("keeps an interrupted offered wake consumed when no definite delivery refusal was saved", async () => {
  const root = temporaryRoot();
  const snapshot = temporaryRoot();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prompts: string[] = [];
  const original = new ConversationStore(root, async (id, _message, _publish, context) => {
    prompts.push(original.linearWakePrompt(id, context.runId)!);
    await held;
  });
  const activity = notice("Crash recovery");
  original.receiveLinearActivity(activity, true);
  const closing = original.close();
  await vi.waitFor(() => expect(prompts).toHaveLength(1));
  cpSync(root, snapshot, { recursive: true });
  release();
  await closing;
  const reopened = fixture(snapshot);
  await reopened.store.close();
  expect(reopened.wakes).toEqual([]);
  expect(await events(reopened.store)).toContainEqual(
    expect.objectContaining({ type: "message", role: "external" }),
  );
  expect(reopened.store.receiveLinearActivity(activity, true)).toBe(false);
  const again = fixture(snapshot);
  await again.store.close();
  expect(again.wakes).toEqual([]);
});

it("drops a queued wake when following turns off and leaves its ordinary history visible", async () => {
  const f = fixture();
  f.store.linearFollowing = async () => false;
  f.store.receiveLinearActivity(notice("Following disabled"), true);
  await f.store.close();
  expect(f.wakes).toEqual([]);
  const reopened = fixture(f.root);
  await reopened.store.close();
  expect(reopened.wakes).toEqual([]);
  expect(await events(reopened.store)).toContainEqual(
    expect.objectContaining({ type: "message", role: "external" }),
  );
});
