import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { NativeSeatRecipient } from "../src/captain/conversation-owner.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";
import type { LinearActivityEvent } from "../src/linear-webhook.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "linear-conversation-routing-"));
  roots.push(root);
  const wakes: { id: string; prompt: string | undefined }[] = [];
  let store = new ConversationStore(root, async (id) => {
    wakes.push({ id, prompt: store.linearWakePrompt(id) });
  });
  return {
    root,
    wakes,
    get store() {
      return store;
    },
    async restart() {
      await store.close();
      store = new ConversationStore(root, async (id) => {
        wakes.push({ id, prompt: store.linearWakePrompt(id) });
      });
    },
  };
}

async function project(store: ConversationStore) {
  const result = await store.serve({
    op: "create",
    schemaVersion: 1,
    scope: { kind: "global" },
    title: "Issue lead",
  });
  if (result.op !== "create") throw new Error("No conversation");
  return result.conversation.conversationId;
}

const organizationId = "96d2a27b-950b-4a8a-afae-8776605c0ef1";
const issueId = "593644be-7b60-4a77-9b58-7b0dc20be894";
function notice(title: string, overrides: Partial<LinearActivityEvent> = {}): LinearActivityEvent {
  return {
    eventId: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    notification: true,
    organizationId,
    issueId,
    deliveryId: undefined,
    type: "Notification",
    action: "issueNewComment",
    actorName: "James",
    actorEmail: undefined,
    createdAt: new Date().toISOString(),
    url: undefined,
    data: { title },
    updatedFrom: undefined,
    ...overrides,
  };
}
function claim(store: ConversationStore, id: string) {
  return store.bindLinearWorkOwner({ organizationId, issueId, conversationId: id }, { conversationId: id });
}

const remoteAuthor: NativeSeatRecipient = {
  kind: "native",
  paneId: "kh2/w3:pK",
  seatId: "kh2/term-original",
  occupantId: "session-original",
  binding: "a".repeat(64),
};
function approval(overrides: Partial<LinearActivityEvent> = {}): LinearActivityEvent {
  return notice("I APPROVE all!!", {
    issueId: undefined,
    action: "projectUpdateNewComment",
    replyRecipient: {
      parentType: "ProjectUpdate",
      parentId: "d9b90f52-0b0e-463d-a1e9-9457d250592c",
      recordedAt: Date.now(),
      recipient: remoteAuthor,
    },
    ...overrides,
  });
}

it("delivers a retained project reply to its remote native author once, independently of inbox wakes", async () => {
  const f = fixture();
  const calls: { recipient: NativeSeatRecipient; text: string; eventId: string }[] = [];
  f.store.linearNativeRunner = async (recipient, text, eventId, guard) => {
    await guard();
    calls.push({ recipient, text, eventId });
    return { outcome: "delivered" };
  };
  const reply = approval();
  f.store.receiveLinearActivity(notice("Unowned triage", { issueId: undefined }), true);
  expect(f.store.receiveLinearActivity(reply, true)).toBe(true);
  expect(f.store.receiveLinearActivity(reply, true)).toBe(false);
  await f.store.close();
  expect(calls).toEqual([
    { recipient: remoteAuthor, text: expect.stringContaining("I APPROVE all!!"), eventId: reply.eventId },
  ]);
  expect(f.wakes.map((item) => item.id)).toEqual(["linear-inbox"]);
  expect(f.wakes[0]?.prompt).not.toContain("I APPROVE all!!");
  await f.restart();
  f.store.linearNativeRunner = async () => {
    throw new Error("Completed approval must not replay");
  };
  f.store.resumeLinearActivity();
  await f.store.close();
  expect(f.wakes).toHaveLength(1);
});

it("keeps uncertain native delivery on its original ID across restart and never falls through to a model", async () => {
  const f = fixture();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const reply = approval();
  const ids: string[] = [];
  f.store.linearNativeRunner = async (_recipient, _text, id) => {
    ids.push(id);
    return {
      outcome: "unconfirmed",
      detail: "Original native receipt is uncertain",
      messageId: "original-message",
    };
  };
  try {
    f.store.receiveLinearActivity(reply, true);
    await f.store.close();
    expect(log).toHaveBeenCalled();
    expect(f.wakes).toEqual([]);
    await f.restart();
    f.store.linearNativeRunner = async (_recipient, _text, id, guard) => {
      await guard();
      ids.push(id);
      return { outcome: "delivered", messageId: "original-message" };
    };
    f.store.resumeLinearActivity();
    await f.store.close();
    expect(ids).toEqual([reply.eventId, reply.eventId]);
    expect(f.wakes).toEqual([]);
  } finally {
    log.mockRestore();
  }
});

it("does not promote passive native replies or replace an exact update author after an issue claim", async () => {
  const f = fixture();
  const id = await project(f.store);
  const calls: string[] = [];
  f.store.linearNativeRunner = async (recipient) => {
    calls.push(recipient.paneId);
    return { outcome: "delivered" };
  };
  const passive = approval();
  f.store.receiveLinearActivity(passive, false);
  expect(f.store.receiveLinearActivity(passive, true)).toBe(false);
  expect(f.store.bindLinearNativeWorkOwner({ organizationId, issueId }, remoteAuthor)).toBe(true);
  await f.restart();
  f.store.linearNativeRunner = async (recipient) => {
    calls.push(recipient.paneId);
    return { outcome: "delivered" };
  };
  f.store.receiveLinearActivity(notice("Native issue"), true);
  await f.store.close();
  claim(f.store, id);
  f.store.receiveLinearActivity(notice("Adopted issue"), true);
  f.store.receiveLinearActivity(approval(), true);
  await f.store.close();
  expect(calls).toEqual([remoteAuthor.paneId, remoteAuthor.paneId]);
  expect(f.wakes.map((item) => item.id)).toEqual([id]);
});

it("hands eligible inbox work to a native owner once without promoting passive history", async () => {
  const f = fixture();
  const calls: string[] = [];
  f.store.linearNativeRunner = async (_recipient, content) => {
    calls.push(content);
    return { outcome: "delivered" };
  };
  f.store.receiveLinearActivity(notice("Native handoff"), true);
  await f.store.close();
  expect(f.store.bindLinearNativeWorkOwner({ organizationId, issueId }, remoteAuthor)).toBe(true);
  expect(f.store.handoffLinearActivity("000000000001")).toBe(true);
  expect(f.store.handoffLinearActivity("000000000001")).toBe(false);
  await f.store.close();
  expect(calls).toEqual([expect.stringContaining("Native handoff")]);
});

it("retains pending native delivery after acknowledgment and trims it only after confirmation", async () => {
  const f = fixture();
  const reply = approval();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    f.store.linearNativeRunner = async () => ({
      outcome: "unconfirmed",
      detail: "Original receipt is pending",
    });
    f.store.receiveLinearActivity(reply, true);
    await f.store.close();
    f.store.receiveLinearActivity(notice("Later inbox wake", { issueId: undefined }), true);
    await f.store.close();
    for (let i = 0; i < 510; i++)
      f.store.receiveLinearActivity(notice(`Passive ${i}`, { issueId: undefined }), false);
    while (f.store.readLinearInbox({ limit: 100, headlines: true }).unreadCount) {
      const page = f.store.readLinearInbox({ limit: 100, headlines: true });
      expect(f.store.acknowledgeLinearInbox(page.ackCursor!)).toBe(true);
    }
    f.store.receiveLinearActivity(notice("Trigger trim", { issueId: undefined }), false);
    const metaPath = join(f.root, "linear-inbox", "meta.json");
    expect(
      JSON.parse(readFileSync(metaPath, "utf8")).linearAdmissions["000000000001"].nativeRecipient,
    ).toEqual(remoteAuthor);
    await f.restart();
    const ids: string[] = [];
    f.store.linearNativeRunner = async (_recipient, _text, eventId) => {
      ids.push(eventId);
      return { outcome: "delivered" };
    };
    f.store.resumeLinearActivity();
    await f.store.close();
    expect(ids).toEqual([reply.eventId]);
    expect(JSON.parse(readFileSync(metaPath, "utf8")).linearAdmissions["000000000001"]).toBeUndefined();
  } finally {
    log.mockRestore();
  }
});

it("keeps the native route durable if the process stops after appending its eligible event", async () => {
  const f = fixture();
  f.store.linearInboxConversationId();
  const reply = approval();
  const original = ConversationJournal.prototype.rewrite;
  const crash = vi
    .spyOn(ConversationJournal.prototype, "rewrite")
    .mockImplementationOnce(function (this: ConversationJournal, id, event) {
      original.call(this, id, event);
      throw new Error("Simulated crash after journal commit");
    });
  try {
    expect(() => f.store.receiveLinearActivity(reply, true)).toThrow("Simulated crash");
  } finally {
    crash.mockRestore();
  }
  await f.restart();
  const ids: string[] = [];
  f.store.linearNativeRunner = async (_recipient, _text, id) => {
    ids.push(id);
    return { outcome: "delivered" };
  };
  f.store.resumeLinearActivity();
  await f.store.close();
  expect(ids).toEqual([reply.eventId]);
  expect(f.wakes).toEqual([]);
});

it("does not repeat a committed handoff after a crash or a subsequent owner change", async () => {
  const f = fixture();
  f.store.receiveLinearActivity(notice("Triage item"), false);
  const first = await project(f.store);
  claim(f.store, first);
  const original = ConversationJournal.prototype.rewrite;
  const crash = vi
    .spyOn(ConversationJournal.prototype, "rewrite")
    .mockImplementationOnce(function (this: ConversationJournal, id, event) {
      original.call(this, id, event);
      throw new Error("Simulated crash after handoff commit");
    });
  try {
    expect(() => f.store.handoffLinearActivity("000000000001")).toThrow("Simulated crash");
  } finally {
    crash.mockRestore();
  }
  await f.restart();
  claim(f.store, await project(f.store));
  expect(f.store.handoffLinearActivity("000000000001")).toBe(false);
});

it("keeps explicit unbinding newer than delayed signed conversation or native write receipts", async () => {
  const f = fixture();
  const id = await project(f.store);
  const old = Date.now() - 1000;
  f.store.bindLinearWorkOwner({ organizationId, issueId, conversationId: id }, { conversationId: id }, old);
  expect(f.store.unbindLinearWorkOwner(organizationId, issueId)).toBe(true);
  await f.restart();
  expect(f.store.linearWorkOwners()).toEqual([]);
  expect(
    f.store.bindLinearWorkOwner(
      { organizationId, issueId, conversationId: id },
      { conversationId: id },
      old,
      true,
    ),
  ).toBe(false);
  expect(f.store.bindLinearNativeWorkOwner({ organizationId, issueId }, remoteAuthor, old, true)).toBe(false);
  f.store.receiveLinearActivity(notice("Unbound issue"), true);
  await f.store.close();
  expect(f.wakes.map((wake) => wake.id)).toEqual(["linear-inbox"]);
});

it("rechecks follow permission at the native dispatch boundary", async () => {
  const f = fixture();
  let following = true;
  let dispatched = false;
  f.store.linearFollowing = async () => following;
  f.store.linearNativeRunner = async (_recipient, _content, _id, guard) => {
    await guard();
    following = false;
    await guard();
    dispatched = true;
    return { outcome: "delivered" };
  };
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    f.store.receiveLinearActivity(approval(), true);
    await f.store.close();
    expect(dispatched).toBe(false);
    expect(f.wakes).toEqual([]);
    expect(log).toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

it("does not redispatch old unresolved native admissions after their receipt retention window", async () => {
  const f = fixture();
  f.store.receiveLinearActivity(approval(), false);
  // Keep the original eligible admission pending without crossing a native boundary.
  const reply = approval();
  f.store.linearNativeRunner = async () => ({ outcome: "unconfirmed", detail: "Original receipt uncertain" });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    f.store.receiveLinearActivity(reply, true);
    await f.store.close();
    await f.restart();
    const admitted = f.store
      .readLinearInbox()
      .items.map((item) => item as { occurredAt: string; linear?: { eventId: string } })
      .find((item) => item.linear?.eventId === reply.eventId)!;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(admitted.occurredAt) + 7 * 24 * 60 * 60 * 1000);
    let dispatched = false;
    f.store.linearNativeRunner = async () => {
      dispatched = true;
      return { outcome: "delivered" };
    };
    f.store.resumeLinearActivity();
    await f.store.close();
    expect(dispatched).toBe(false);
    expect(f.wakes).toEqual([]);
    expect(log.mock.calls.some((call) => String(call[1]).includes("exceeds retained receipt history"))).toBe(
      true,
    );
  } finally {
    vi.useRealTimers();
    log.mockRestore();
  }
});

it("persists ownership and isolates canonical issue/workspace events from the default conversation", async () => {
  const f = fixture();
  const id = await project(f.store);
  expect(
    f.store.bindLinearWorkOwner(
      { organizationId: organizationId.toUpperCase(), issueId: issueId.toUpperCase(), conversationId: id },
      { conversationId: id },
    ),
  ).toBe(true);
  await f.restart();
  f.store.receiveLinearActivity(notice("Owned"), true);
  f.store.receiveLinearActivity(notice("Other workspace", { organizationId: randomUUID() }), true);
  f.store.receiveLinearActivity(notice("Project event", { issueId: undefined }), true);
  await f.store.close();
  expect(f.wakes.map((item) => item.id)).toEqual([id, "linear-inbox"]);
  expect(f.wakes[0]?.prompt).toContain("Owned");
  expect(f.wakes[1]?.prompt).toContain("Other workspace");
  expect(f.wakes[1]?.prompt).toContain("Project event");
  expect(f.store.readLinearInbox({ conversationId: "global-default" }).unreadCount).toBe(0);
});

it("keeps passive and filtered events quiet after claims and duplicate eligible retries", async () => {
  const f = fixture();
  const id = await project(f.store);
  const filtered = notice("Filtered");
  f.store.receiveLinearActivity(filtered, false);
  claim(f.store, id);
  expect(f.store.handoffLinearActivity("000000000001")).toBe(true);
  expect(f.store.receiveLinearActivity(filtered, true)).toBe(false);
  f.store.resumeLinearActivity();
  await f.store.close();
  expect(f.wakes).toEqual([]);
});

it("refuses unsigned notification issue fields when signed identity is missing or ambiguous", async () => {
  const f = fixture();
  const id = await project(f.store);
  claim(f.store, id);
  f.store.receiveLinearActivity(
    notice("Unattributed issue", { issueId: undefined, data: { issueId, title: "Unattributed issue" } }),
    true,
  );
  await f.store.close();
  expect(f.wakes.map((item) => item.id)).toEqual(["linear-inbox"]);
});

it("hands an inbox event to its current owner even after the owner processed a newer cursor, once", async () => {
  const f = fixture();
  const old = notice("Needs triage");
  f.store.receiveLinearActivity(old, true);
  await f.store.close();
  const oldCursor = (f.store.readLinearInbox().items[0] as { cursor: string }).cursor;
  const id = await project(f.store);
  claim(f.store, id);
  f.store.receiveLinearActivity(notice("Newer event"), true);
  await f.store.close();
  expect(f.store.handoffLinearActivity(oldCursor)).toBe(true);
  expect(f.store.handoffLinearActivity(oldCursor)).toBe(false);
  expect(f.store.receiveLinearActivity(old, true)).toBe(false);
  await f.store.close();
  expect(f.wakes.map((item) => item.id)).toEqual(["linear-inbox", id, id]);
  expect(f.wakes[2]?.prompt).toContain("Needs triage");
  await f.restart();
  f.store.resumeLinearActivity();
  await f.store.close();
  expect(f.wakes).toHaveLength(3);
});

it("falls back to inbox after owner removal without replaying its completed notification", async () => {
  const f = fixture();
  const id = await project(f.store);
  claim(f.store, id);
  f.store.receiveLinearActivity(notice("Already delivered"), true);
  await f.store.close();
  await f.store.serve({ op: "close", schemaVersion: 1, conversationId: id });
  await f.restart();
  f.store.receiveLinearActivity(notice("Owner removed"), true);
  f.store.resumeLinearActivity();
  await f.store.close();
  expect(f.wakes.map((item) => item.id)).toEqual([id, "linear-inbox"]);
  expect(f.wakes[1]?.prompt).toContain("Owner removed");
  expect(f.wakes[1]?.prompt).not.toContain("Already delivered");
});

it("retains a room's frozen actor proof and never invokes the generic operator runner", async () => {
  const f = fixture();
  const id = f.store.roomConversation("discord_presence", "guild:channel");
  const owner = {
    conversationId: id,
    discord: {
      baseSessionKey: "room",
      targetId: "guild:channel",
      actorId: "actor",
      guildId: "guild",
      channelId: "channel",
      messageId: "original",
      transportKind: "bot" as const,
    },
  };
  expect(f.store.bindLinearWorkOwner({ organizationId, issueId, conversationId: id }, owner)).toBe(true);
  await f.restart();
  const roomCalls: unknown[] = [];
  f.store.linearRoomRunner = async (route, prompt, guard) => {
    await guard();
    roomCalls.push({ route, prompt });
  };
  f.store.receiveLinearActivity(notice("Room issue"), true);
  await f.store.close();
  expect(f.wakes).toEqual([]);
  expect(roomCalls).toEqual([{ route: owner, prompt: expect.stringContaining("Room issue") }]);
});

it("leaves revoked room admission pending without redirecting it to another conversation", async () => {
  const f = fixture();
  const id = f.store.roomConversation("discord_presence", "guild:channel");
  const owner = {
    conversationId: id,
    discord: {
      baseSessionKey: "room",
      targetId: "guild:channel",
      actorId: "actor",
      guildId: "guild",
      channelId: "channel",
      messageId: "original",
      transportKind: "bot" as const,
    },
  };
  f.store.bindLinearWorkOwner({ organizationId, issueId, conversationId: id }, owner);
  f.store.linearRoomRunner = async () => {
    throw new Error("Original actor grant revoked");
  };
  f.store.receiveLinearActivity(notice("Revoked room"), true);
  await f.store.close();
  expect(f.wakes).toEqual([]);
  expect(f.store.linearWakePrompt("linear-inbox")).toBeUndefined();
  expect(f.store.linearWakePrompt(id)).toContain("Revoked room");
});

it("a delayed signed write receipt cannot undo a newer explicit ownership claim", async () => {
  const f = fixture();
  const original = await project(f.store);
  const adopted = await project(f.store);
  const binding = { organizationId, issueId, conversationId: original };
  expect(f.store.bindLinearWorkOwner(binding, { conversationId: original }, 100)).toBe(true);
  expect(
    f.store.bindLinearWorkOwner({ ...binding, conversationId: adopted }, { conversationId: adopted }, 200),
  ).toBe(true);
  await f.restart();
  expect(f.store.bindLinearWorkOwner(binding, { conversationId: original }, 100, true)).toBe(false);
  expect(f.store.bindLinearWorkOwner(binding, { conversationId: original }, 200, true)).toBe(false);
  f.store.receiveLinearActivity(notice("Current work owner"), true);
  await f.store.close();
  expect(f.wakes.map((item) => item.id)).toEqual([adopted]);
});
