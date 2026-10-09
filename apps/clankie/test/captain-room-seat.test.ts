import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { OperatorSeatEventKindSchema, type DiscordPresenceChannelTurnRequest } from "@clankie/protocol";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { ConversationOwner } from "../src/captain/conversation-owner.ts";
import {
  HerdrWatchStore,
  type HerdrAgentSnapshot,
  type HerdrWatchRunner,
} from "../src/captain/herdr-watch.ts";
import { DeliveryFence } from "../src/captain/delivery-fence.ts";
import { SeatLinkInterruptedError } from "../src/captain/seat-outbox.ts";
import { planDiscordTurnSession } from "../src/captain/system-authority.ts";
import type { NativeRoomHandoffExecutor } from "../src/captain/native-room-handoffs.ts";
import type { LinearActivityEvent } from "../src/linear-webhook.ts";

const fake = vi.hoisted(() => ({
  prompts: [] as string[],
  banks: [] as unknown[],
  response: "Service answer",
}));
vi.mock("../src/captain/model.ts", () => ({
  createCaptainModelRuntime: async () => ({
    runtime: {},
    resolveRoute: async () => ({
      selection: { model: { id: "fake", provider: "fake", contextWindow: 1000 }, thinkingLevel: "off" },
    }),
  }),
}));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
  createAgentSession: async () => {
    const listeners = new Set<(event: unknown) => void>();
    return {
      session: {
        isStreaming: false,
        state: { messages: [] },
        model: { id: "fake", provider: "fake", contextWindow: 1000 },
        thinkingLevel: "off",
        bindExtensions: async () => {},
        subscribe: (listener: (event: unknown) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        getContextUsage: () => undefined,
        abort: async () => {},
        dispose: () => {},
        prompt: async (text: string) => {
          fake.prompts.push(text);
          for (const listener of listeners)
            listener({
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text: fake.response }] },
            });
        },
      },
    };
  },
  DefaultResourceLoader: class {
    async reload() {}
    getExtensions() {
      return { extensions: [] };
    }
    getSkills() {
      return { skills: [] };
    }
  },
}));
vi.mock("../src/captain/lane-tools.ts", () => ({
  laneAuthoredTools: () => [],
  buildLaneToolBank: (_deps: unknown, capture: unknown, _log: unknown, lane: string) => {
    fake.banks.push({ capture, lane });
    return { lane, tools: [] };
  },
}));

const fixtures: { captain: ReturnType<typeof createCaptain>; root: string }[] = [];
const watchStores: HerdrWatchStore[] = [];
const startWatchStore = HerdrWatchStore.prototype.start;
afterEach(async () => {
  for (const store of watchStores.splice(0)) store.close();
  for (const fixture of fixtures.splice(0)) {
    await fixture.captain.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  fake.prompts.splice(0);
  fake.banks.splice(0);
  fake.response = "Service answer";
});

function request(id: string, channelId = "67890"): DiscordPresenceChannelTurnRequest {
  return {
    schemaVersion: 1,
    deliveryId: id,
    identity: {
      presenceSessionId: `body:${channelId}`,
      correlationId: id,
      profileHash: "hash",
      characterId: "clankie",
      credentialRef: "fake",
      transportKind: "bot",
    },
    trigger: {
      kind: "message",
      id,
      guildId: "12345",
      channelId,
      actorId: "11111",
      body: id,
      attachments: [],
    },
    contextMessages: [],
  };
}

async function fixture(granted = false, runNativeRoomHandoff?: NativeRoomHandoffExecutor) {
  const root = mkdtempSync(join(tmpdir(), "captain-room-seat-"));
  let watchWake!: Parameters<HerdrWatchStore["start"]>[0];
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation((wake) => {
    watchWake = wake;
  });
  const settings = new SettingsStore(join(root, "settings.json"));
  if (granted)
    await settings.update((current) => ({
      ...current,
      discord: {
        ...current.discord,
        ownerUserId: "11111",
        servers: [{ serverId: "12345", role: "participant", owners: "me" }],
        systemActorUserIds: ["11111"],
      },
    }));
  const route = vi.fn(() => true);
  const execute = vi.fn(async (_input: unknown, guard?: () => Promise<void>) => {
    await guard?.();
    return { ok: true, message: "sent" };
  });
  const captain = createCaptain(
    {
      herdrAvailable: () => false,
      memory: {},
      conversationRouteAuthorized: route,
      discordActions: {
        execute,
        serverAction: async (action: { path: string }) => ({
          ok: true,
          message: "metadata",
          data:
            action.path === "/users/@me"
              ? { id: "22222", bot: true }
              : action.path === "/guilds/12345"
                ? { id: "12345", owner_id: "11111" }
                : action.path === "/guilds/12345/roles"
                  ? [{ id: "12345", permissions: "0" }]
                  : {
                      id: action.path.split("/").at(-1),
                      guild_id: "12345",
                      permission_overwrites: [{ id: "12345", type: 0, allow: "0", deny: "1024" }],
                    },
        }),
      },
    } as unknown as CaptainDeps,
    {
      ...(runNativeRoomHandoff === undefined ? {} : { runNativeRoomHandoff }),
      repoRoot: root,
      stateDir: root,
      workingDirectory: root,
      settings,
      discordEnvironment: {},
      personaImages: async () => ({ images: [], hash: "fake", files: [] }),
    },
  );
  fixtures.push({ captain, root });
  const conversationId = captain.bodyRoomConversation("discord_presence", "12345:67890");
  const owner: ConversationOwner = {
    conversationId,
    discord: {
      baseSessionKey: "discord:clankie:body:67890",
      targetId: "12345:67890",
      actorId: "11111",
      guildId: "12345",
      channelId: "67890",
      messageId: "original-message",
      transportKind: "bot",
    },
  };
  return { captain, settings, route, execute, conversationId, owner, root, watchWake };
}

async function durableRoomWatch(f: Awaited<ReturnType<typeof fixture>>) {
  // The established watch runner fixture supplies a stable observed session;
  // Captain's room authorization, outbox and receipt writes remain real.
  let current: HerdrAgentSnapshot = {
    paneId: "w18:p1",
    terminalId: "term_abcd",
    agent: "claude",
    status: "working",
    title: "Room worker completion",
    session: { source: "herdr:claude", kind: "id", value: "room-worker-original-session" },
  };
  let finish!: (agent: HerdrAgentSnapshot) => void;
  const completion = new Promise<HerdrAgentSnapshot>((resolve) => {
    finish = resolve;
  });
  const runner: HerdrWatchRunner = {
    get: async () => current,
    resolveTerminal: async () => current,
    wait: async () => completion,
  };
  const path = join(f.root, "room-worker-watches.json");
  let store = new HerdrWatchStore(path, { runner });
  watchStores.push(store);
  let attempts = 0;
  let finishedAttempts = 0;
  const wake: Parameters<HerdrWatchStore["start"]>[0] = async (...args) => {
    attempts++;
    try {
      return await f.watchWake(...args);
    } finally {
      finishedAttempts++;
    }
  };
  startWatchStore.call(store, wake);
  const armed = await store.watch(
    f.conversationId,
    current.paneId,
    "Harvest the exact room completion",
    f.owner.discord,
  );
  if (armed.outcome !== "watching") throw new Error("Working fixture did not arm its durable watch");
  const original = JSON.parse(readFileSync(path, "utf8")).watches[0];
  return {
    original,
    records: () => JSON.parse(readFileSync(path, "utf8")).watches,
    attempts: () => attempts,
    finishedAttempts: () => finishedAttempts,
    restart: () => {
      store.close();
      store = new HerdrWatchStore(path, { runner });
      watchStores.push(store);
      startWatchStore.call(store, wake);
    },
    settle: () => {
      current = { ...current, status: "done" };
      finish(current);
    },
  };
}

function roomReceipts(f: Awaited<ReturnType<typeof fixture>>, acknowledged = false) {
  return new DeliveryFence(
    join(
      f.root,
      "delivery-receipts",
      "head",
      `${encodeURIComponent(f.conversationId)}.json${acknowledged ? ".delivered" : ""}`,
    ),
  );
}

const organizationId = "96d2a27b-950b-4a8a-afae-8776605c0ef1";
const issueId = "593644be-7b60-4a77-9b58-7b0dc20be894";
function linearNotice(title: string): LinearActivityEvent {
  return {
    eventId: "a".repeat(64),
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
  };
}

it("discovery persists observed text, voice and DM names and retains names across nameless turns", async () => {
  const { captain, root, conversationId } = await fixture();
  const text = request("named-text");
  await captain.submitDiscordTurn({ ...text, room: { guildName: "Friends", channelName: "general" } });
  await captain.submitDiscordTurn(request("later-nameless-text"));
  await captain.submitDiscordTurn({
    ...request("named-voice", "voice-channel"),
    trigger: { ...request("named-voice", "voice-channel").trigger, kind: "voice_event" },
    room: { guildName: "Friends", channelName: "Lobby" },
  });
  await captain.submitDiscordTurn({
    ...request("named-dm"),
    identity: { ...text.identity, presenceSessionId: "body:dm-channel" },
    trigger: {
      kind: "dm",
      id: "named-dm",
      channelId: "dm-channel",
      actorId: "11111",
      body: "named-dm",
      attachments: [],
    },
    room: { peerName: "James" },
  });
  const listing = await captain.serveOperatorConversation({ schemaVersion: 1, op: "list" });
  if (listing.op !== "list") throw new Error("Expected list");
  const rooms = listing.conversations.filter(
    (item) => item.scope.kind === "room" && item.roomHandoff === undefined,
  );
  expect(rooms.map((item) => item.title).sort()).toEqual([
    "Discord DM · James",
    "Discord text · Friends / #general",
    "Discord voice · Friends / Lobby",
  ]);
  for (const room of rooms) {
    const persisted = JSON.parse(
      readFileSync(join(root, "conversations", room.conversationId, "meta.json"), "utf8"),
    );
    expect(persisted.title).toBe(room.title);
  }
  expect(rooms.find((item) => item.conversationId === conversationId)?.scope).toEqual({
    kind: "room",
    lane: "discord_presence",
    targetId: "12345:67890",
  });
});

it("a social room bypasses an unproven native poller while global retains its driver", async () => {
  const { captain, conversationId } = await fixture();
  expect(captain.seatContext(conversationId)?.conversationId).toBe(conversationId);
  const controller = new AbortController();
  const poll = captain.pollSeatEvents(1000, controller.signal, conversationId);
  expect(await captain.submitDiscordTurn(request("room-request"))).toMatchObject({
    state: "settled",
    response: "Service answer",
  });
  controller.abort();
  expect(await poll).toEqual([]);
  expect(fake.prompts).toHaveLength(1);
  expect(fake.prompts[0]).toContain("room-request");
  expect(await captain.submitDiscordTurn(request("other-room-request", "98765"))).toMatchObject({
    state: "settled",
    response: "Service answer",
  });
  const globalPoll = captain.pollSeatEvents(1000, undefined, undefined, {
    schemaVersion: 1,
    eventKinds: [...OperatorSeatEventKindSchema.options],
    ownerOrigin: true,
  });
  await captain.serveOperatorConversation({
    schemaVersion: 1,
    op: "send",
    turn: {
      schemaVersion: 1,
      kind: "message",
      conversationId: "global-default",
      expectedRevision: 0,
      surfaceClientId: "owner",
      message: "global-request",
    },
  });
  const [globalEvent] = await globalPoll;
  expect(globalEvent).toMatchObject({ conversationId: "global-default" });
  expect(await captain.replySeatEvent(globalEvent!.id, "Global answer")).toBe(true);
  expect(await captain.pollSeatEvents(0, undefined, conversationId)).toEqual([]);
  expect(fake.prompts).toHaveLength(2);
  expect(fake.prompts[1]).toContain("other-room-request");
});

it("attaching a room never grants operator send, reset or tools to that external room", async () => {
  const { captain, conversationId } = await fixture();
  const pollController = new AbortController();
  const poll = captain.pollSeatEvents(1000, pollController.signal, conversationId);
  await expect(
    captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "send",
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId,
        expectedRevision: 0,
        surfaceClientId: "owner",
        message: "post directly to the room",
      },
    }),
  ).rejects.toThrow("read-only");
  await expect(
    captain.serveOperatorConversation({ schemaVersion: 1, op: "reset", conversationId, expectedRevision: 0 }),
  ).rejects.toThrow();
  await captain.laneToolBank("operator", conversationId);
  expect(fake.banks).toMatchObject([{ lane: "discord_presence", capture: { shell: false } }]);
  expect(
    (fake.banks[0] as { capture: Record<string, unknown> }).capture.conversationAuthority,
  ).toBeUndefined();
  pollController.abort();
  await poll;
});

it("an uncertain native child receipt never starts a second service answer", async () => {
  const { captain } = await fixture(true, async () => ({
    outcome: "uncertain",
    detail: "Native task taken",
  }));
  expect(await captain.submitDiscordTurn(request("uncertain-room-request"))).toMatchObject({
    state: "failed",
    code: "captain_seat_delivery_uncertain",
  });
  expect(fake.prompts).toEqual([]);
});

it("a room-owned watch reaches its attached seat and replies on its original guarded route", async () => {
  const { captain, conversationId, owner, execute } = await fixture(true);
  const poll = captain.pollSeatEvents(1000, undefined, conversationId);
  const wake = captain.wakeConversation(owner, "The room's worker settled");
  const [event] = await poll;
  expect(event).toMatchObject({ conversationId });
  expect(event?.content).toContain("The room's worker settled");
  expect(await captain.acknowledgeSeatEvent(event!.id, conversationId)).toBe(true);
  expect(await wake).toBe(true);
  expect(await captain.replySeatEvent(event!.id, "Room harvest answer", conversationId)).toBe(true);
  await vi.waitFor(() =>
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "send_reply",
        actorId: owner.discord!.actorId,
        channelId: owner.discord!.channelId,
        messageId: owner.discord!.messageId,
        text: "Room harvest answer",
      }),
      expect.any(Function),
    ),
  );
  expect(fake.prompts).toEqual([]);
});

it("an unresolved original room outbox never redispatches its original while an unrelated completion watch still settles", async () => {
  const f = await fixture(true);
  const poll = f.captain.pollSeatEvents(1000, undefined, f.conversationId);
  const originalTurn = f.captain.wakeConversation(f.owner, "unresolved-original-room-turn");
  const originalUncertain = expect(originalTurn).rejects.toBeInstanceOf(SeatLinkInterruptedError);
  const [originalEvent] = await poll;
  expect(originalEvent?.content).toContain("unresolved-original-room-turn");
  // Leave a genuine taken event past its native acknowledgment deadline.
  await originalUncertain;
  const receipt = roomReceipts(f).pending(originalEvent!.id);
  expect(receipt?.messageId).toBe(originalEvent!.id);
  const watch = await durableRoomWatch(f);
  watch.settle();
  await vi.waitFor(() => expect(watch.finishedAttempts()).toBe(1));
  // VUH-1779: the unrelated watch is no longer held behind another delivery's receipt.
  expect(watch.records()).toEqual([]);
  expect(roomReceipts(f).pending(originalEvent!.id)).toEqual(receipt);
  expect(JSON.stringify(await f.captain.pollSeatEvents(0, undefined, f.conversationId))).not.toContain(
    "unresolved-original-room-turn",
  );
  expect(JSON.stringify(fake.prompts)).not.toContain("unresolved-original-room-turn");
  expect(JSON.stringify(f.execute.mock.calls)).not.toContain("unresolved-original-room-turn");
});

it("a taken unacknowledged room wake retains its original watch and late acknowledgment settles retry without redispatch", async () => {
  const f = await fixture(true);
  const poll = f.captain.pollSeatEvents(1000, undefined, f.conversationId);
  const watch = await durableRoomWatch(f);
  watch.settle();
  const [originalEvent] = await poll;
  expect(originalEvent?.content).toContain("Harvest the exact room completion");
  await vi.waitFor(() => expect(watch.finishedAttempts()).toBe(1), { timeout: 4000 });
  expect(watch.records()).toEqual([expect.objectContaining(watch.original)]);
  const receipt = roomReceipts(f).pending(originalEvent!.id);
  expect(receipt?.messageId).toBe(originalEvent!.id);
  expect(roomReceipts(f).all()).toHaveLength(1);
  expect(await f.captain.acknowledgeSeatEvent(originalEvent!.id, f.conversationId)).toBe(true);
  expect(roomReceipts(f).pending(originalEvent!.id)).toBeUndefined();
  expect(roomReceipts(f, true).pending(originalEvent!.id)).toEqual(receipt);
  const controller = new AbortController();
  const retryPoll = f.captain.pollSeatEvents(8000, controller.signal, f.conversationId);
  try {
    // Exercise the store's real five-second retry, not a second synthetic wake.
    await vi.waitFor(() => expect(watch.finishedAttempts()).toBe(2), { timeout: 9000 });
    controller.abort();
    expect(await retryPoll).toEqual([]);
    expect(watch.records()).toEqual([]);
    expect(roomReceipts(f, true).all()).toHaveLength(1);
    expect(roomReceipts(f, true).pending(originalEvent!.id)).toEqual(receipt);
    expect(f.execute).not.toHaveBeenCalled();
    expect(fake.prompts).toEqual([]);
  } finally {
    controller.abort();
    await retryPoll;
  }
});

it("a late room reply without a durable original acknowledgment cannot redispatch its restored watch", async () => {
  const f = await fixture(true);
  const poll = f.captain.pollSeatEvents(1000, undefined, f.conversationId);
  const watch = await durableRoomWatch(f);
  watch.settle();
  const [originalEvent] = await poll;
  expect(originalEvent?.content).toContain("Harvest the exact room completion");
  await vi.waitFor(() => expect(watch.finishedAttempts()).toBe(1), { timeout: 4000 });
  expect(watch.records()).toEqual([expect.objectContaining(watch.original)]);
  expect(roomReceipts(f).pending(originalEvent!.id)?.messageId).toBe(originalEvent!.id);
  expect(await f.captain.replySeatEvent(originalEvent!.id, "Late native answer", f.conversationId)).toBe(
    false,
  );
  expect(roomReceipts(f).pending(originalEvent!.id)).toBeUndefined();
  expect(roomReceipts(f, true).pending(originalEvent!.id)).toBeUndefined();
  const controller = new AbortController();
  const restoredPoll = f.captain.pollSeatEvents(1000, controller.signal, f.conversationId);
  try {
    watch.restart();
    await vi.waitFor(() => expect(watch.finishedAttempts()).toBe(2));
    controller.abort();
    expect(await restoredPoll).toEqual([]);
    expect(watch.records()).toEqual([expect.objectContaining(watch.original)]);
    expect(roomReceipts(f).all()).toEqual([]);
    expect(roomReceipts(f, true).all()).toEqual([]);
    expect(f.execute).not.toHaveBeenCalled();
    expect(fake.prompts).toEqual([]);
  } finally {
    controller.abort();
    await restoredPoll;
  }
});

it("an individually granted room watch that starts one-shot Pi but has no response never replays or wakes its head", async () => {
  const f = await fixture(true);
  await f.captain.setDesignatedConversationHead(f.conversationId, "global-default");
  expect(
    planDiscordTurnSession({
      baseSessionKey: f.owner.discord!.baseSessionKey,
      actorId: f.owner.discord!.actorId,
      channelId: f.owner.discord!.channelId,
      transportKind: f.owner.discord!.transportKind,
      ...(f.owner.discord!.guildId === undefined ? {} : { guildId: f.owner.discord!.guildId }),
      durable: true,
      settings: (await f.settings.load()).discord,
    }),
  ).toMatchObject({ kind: "system_turn", durable: false, systemTools: true });
  fake.response = "";
  const watch = await durableRoomWatch(f);
  watch.settle();
  await vi.waitFor(() => expect(watch.finishedAttempts()).toBe(1));
  const journal = join(f.root, "conversations", f.conversationId, "events.jsonl");
  await vi.waitFor(() => expect(readFileSync(journal, "utf8")).toContain("captain_response_missing"));
  expect(fake.prompts).toHaveLength(1);
  expect(fake.prompts[0]).toContain("Harvest the exact room completion");
  expect(watch.records()).toEqual([]);
  watch.restart();
  expect(watch.attempts()).toBe(1);
  expect(await f.captain.pollSeatEvents(0, undefined, "global-default")).toEqual([]);
  const headJournal = join(f.root, "conversations", "global-default", "events.jsonl");
  if (existsSync(headJournal))
    expect(readFileSync(headJournal, "utf8")).not.toContain("Harvest the exact room completion");
  expect(fake.prompts).toHaveLength(1);
  expect(f.execute).not.toHaveBeenCalled();
});

it.each(["before dispatch", "before reply"])(
  "a room attachment cannot preserve a revoked machine grant %s",
  async (boundary) => {
    const { captain, settings, conversationId, owner, execute } = await fixture(true);
    const revoke = () =>
      settings.update((current) => ({
        ...current,
        discord: { ...current.discord, ownerUserId: undefined, systemActorUserIds: [] },
      }));
    const controller = new AbortController();
    const poll = captain.pollSeatEvents(1000, controller.signal, conversationId);
    if (boundary === "before dispatch") {
      await revoke();
      expect(await captain.wakeConversation(owner, "worker report")).toBe(false);
      controller.abort();
      expect(await poll).toEqual([]);
    } else {
      const wake = captain.wakeConversation(owner, "worker report");
      const [event] = await poll;
      expect(await captain.acknowledgeSeatEvent(event!.id, conversationId)).toBe(true);
      expect(await wake).toBe(true);
      await revoke();
      expect(await captain.replySeatEvent(event!.id, "Must not post after revocation", conversationId)).toBe(
        true,
      );
      await vi.waitFor(async () => {
        const result = await captain.serveOperatorConversation({ schemaVersion: 1, op: "list" });
        if (result.op !== "list") throw new Error("Expected list");
        expect(
          result.conversations.find((item) => item.conversationId === conversationId)?.sessionState,
        ).not.toBe("active");
      });
    }
    expect(execute).not.toHaveBeenCalled();
    expect(fake.prompts).toEqual([]);
  },
);

it("retains a room-owned watch through the delayed final census and native acknowledgment, without waiting for its reply", async () => {
  const { captain, conversationId, owner, execute } = await fixture(true);
  const poll = captain.pollSeatEvents(1000, undefined, conversationId);
  let enter!: () => void;
  let release!: () => void;
  const finalCensus = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let watchCurrent = true;
  let guards = 0;
  let returned = false;
  const guard = async () => {
    if (++guards === 2) {
      enter();
      await held;
    }
    if (!watchCurrent) throw new Error("Original watch was removed before acceptance");
  };
  const wake = captain.wakeConversation(owner, "Exact native completion", guard).then((result) => {
    returned = true;
    watchCurrent = false;
    return result;
  });
  await finalCensus;
  expect(returned).toBe(false);
  release();
  const [event] = await poll;
  expect(event?.content).toContain("Exact native completion");
  expect(returned).toBe(false);
  expect(await captain.acknowledgeSeatEvent(event!.id, conversationId)).toBe(true);
  expect(await wake).toBe(true);
  expect(guards).toBe(2);
  expect(execute).not.toHaveBeenCalled();
  expect(await captain.replySeatEvent(event!.id, "Accepted completion reply", conversationId)).toBe(true);
  await vi.waitFor(() =>
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "send_reply", text: "Accepted completion reply" }),
      expect.any(Function),
    ),
  );
  expect(fake.prompts).toEqual([]);
});

it("refuses a room wake when its machine actor is revoked during the final census", async () => {
  const { captain, conversationId, owner, settings, execute } = await fixture(true);
  const abort = new AbortController();
  const poll = captain.pollSeatEvents(1000, abort.signal, conversationId);
  let enter!: () => void;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const wake = captain.wakeConversation(owner, "Must retain actor authority", async () => {
    if (++calls === 2) {
      enter();
      await held;
    }
  });
  const denied = expect(wake).rejects.toThrow("Conversation wake authority was revoked");
  await pending;
  await settings.update((current) => ({
    ...current,
    discord: { ...current.discord, ownerUserId: undefined, systemActorUserIds: [] },
  }));
  release();
  await denied;
  abort.abort();
  expect(await poll).toEqual([]);
  expect(execute).not.toHaveBeenCalled();
  expect(fake.prompts).toEqual([]);
});

it("refuses a Discord room as the configured Linear wake target", async () => {
  const { captain, conversationId, execute } = await fixture(true);
  expect(() =>
    captain.receiveLinearActivity(linearNotice("Room cannot receive Linear wakes"), true, conversationId),
  ).toThrow("Linear wake target must be an existing ordinary global or workspace chat");
  expect(execute).not.toHaveBeenCalled();
  expect(fake.prompts).toEqual([]);
});

it("a Linear wake reaches the lead chat through its normal native operator driver", async () => {
  const { captain, settings, execute } = await fixture(true);
  await settings.update((current) => ({
    ...current,
    linearWebhook: { ...current.linearWebhook, following: true },
  }));
  const poll = captain.pollSeatEvents(3000);
  const activity = linearNotice("Lead chat notification");
  expect(captain.receiveLinearActivity(activity, true)).toBe(true);
  const [event] = await poll;
  expect(event).toMatchObject({ conversationId: "global-default", kind: "wake" });
  expect(event?.content).toContain("Lead chat notification");
  expect(captain.receiveLinearActivity(activity, true)).toBe(false);
  expect(fake.prompts).toEqual([]);
  expect(execute).not.toHaveBeenCalled();
  await captain.acknowledgeSeatEvent(event!.id, "global-default");
});
