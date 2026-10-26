import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import {
  OperatorSeatEventKindSchema,
  type DiscordPresenceChannelTurnRequest,
  type OperatorSeatEvent,
} from "@clankie/protocol";
import { pumpSeatEvents } from "../../tui/src/command/mcp.ts";
import { AutonomyStore } from "../src/captain/autonomy.ts";
import { createCaptain } from "../src/captain/captain.ts";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";

// VUH-2874 (2026-10-26): while the native head ran one long turn, the owner's
// Discord messages waited behind it (one ~38 minutes) and each later got its
// own late answer, while Clankie's service lane ran lead turns beside the live
// head. The real captain, room admission, conversation runner and outbox, and
// the real channel pump the seat bridge runs. Discord's permission reads are
// the boundary fixture; a service-lane turn would show up as a model prompt.

const fake = vi.hoisted(() => ({ prompts: [] as string[] }));
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
    const session = {
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
      resourceLoader: { getSkills: () => ({ skills: [] }) },
      abort: async () => {},
      dispose: () => {},
      // Any service-lane lead turn, and so any service `message_seat`, starts here.
      prompt: async (text: string) => {
        fake.prompts.push(text);
      },
    };
    return { session };
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
  buildLaneToolBank: () => ({ lane: "operator", tools: [] }),
}));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  fake.prompts.length = 0;
  vi.restoreAllMocks();
});

async function fixture(holds: { readonly headBoundGraceMs?: number; readonly headLaneHoldMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "owner-delivery-busy-head-"));
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    discord: {
      ...current.discord,
      ownerUserId: "11111",
      servers: [{ serverId: "12345", role: "admin", owners: "me" }],
      systemActorUserIds: ["11111"],
      mainConversationChannelIds: ["67890"],
    },
  }));
  let autonomous!: Parameters<AutonomyStore["start"]>[0];
  vi.spyOn(AutonomyStore.prototype, "start").mockImplementation((run) => {
    autonomous = run;
  });
  const captain = createCaptain(
    {
      herdrAvailable: () => false,
      embodiment: {},
      conversationRouteAuthorized: () => true,
      discordActions: {
        serverAction: async (action: { path: string }) => ({
          ok: true,
          data:
            action.path === "/users/@me"
              ? { id: "30001", bot: true }
              : action.path === "/guilds/12345"
                ? { id: "12345", owner_id: "11111" }
                : action.path === "/guilds/12345/roles"
                  ? [{ id: "12345", permissions: "0" }]
                  : {
                      id: "67890",
                      guild_id: "12345",
                      permission_overwrites: [{ id: "12345", type: 0, allow: "0", deny: "1024" }],
                    },
        }),
      },
    } as unknown as CaptainDeps,
    {
      repoRoot: root,
      stateDir: root,
      workingDirectory: root,
      settings,
      discordEnvironment: {},
      seatAdapters: [],
      personaImages: async () => ({ images: [], hash: "fixture", files: [] }),
      ...holds,
    },
  );
  cleanup.push(async () => {
    await captain.close();
    await rm(root, { recursive: true, force: true });
  });
  const ownerMessage = (n: number, body: string): DiscordPresenceChannelTurnRequest => ({
    schemaVersion: 1,
    deliveryId: `owner-delivery-${String(n)}`,
    identity: {
      presenceSessionId: "body:room",
      correlationId: `correlation-${String(n)}`,
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
      profileHash: "fixture",
    },
    trigger: {
      kind: "message",
      id: `message-${String(n)}`,
      guildId: "12345",
      channelId: "67890",
      actorId: "11111",
      body,
      attachments: [],
    },
    contextMessages: [],
  });
  return {
    captain,
    ownerMessage,
    autonomous: (prompt: string) => autonomous("global-default", prompt),
    journal: new ConversationJournal(join(root, "conversations")),
  };
}

/** The head's seat bridge: the real pump, polling and acknowledging through the captain. */
function seat(captain: ReturnType<typeof createCaptain>) {
  const pages: OperatorSeatEvent[][] = [];
  const events = () => pages.flat();
  const capabilities = {
    schemaVersion: 1 as const,
    eventKinds: [...OperatorSeatEventKindSchema.options],
    ownerOrigin: true,
  };
  let stop = new AbortController();
  let pump: Promise<void> | undefined;
  const start = () => {
    stop = new AbortController();
    let page: OperatorSeatEvent[] = [];
    pump = pumpSeatEvents(
      {
        notification: async () => {},
      },
      {
        pollEvents: async (waitMs, signal) => {
          if (page.length > 0) pages.push(page);
          page = [];
          const got = await captain.pollSeatEvents(waitMs, signal, "global-default", capabilities);
          page = [...got];
          return got;
        },
        acknowledge: (id) => captain.acknowledgeSeatEvent(id, "global-default"),
      },
      stop.signal,
      { waitMs: 200, retryMs: 20 },
    ).finally(() => {
      if (page.length > 0) pages.push(page);
    });
  };
  const halt = async () => {
    stop.abort();
    await pump;
  };
  cleanup.push(halt);
  /** Resolves once a poll is parked: the head holds its seat. */
  const bound = () =>
    vi.waitFor(async () => {
      const read = await captain.serveOperatorConversation({ op: "seat_bridges", schemaVersion: 1 });
      if (read.op !== "seat_bridges") throw new Error("seat bridges unavailable");
      expect(read.bridges.find((bridge) => bridge.conversationId === "global-default")?.state).toBe(
        "current",
      );
    });
  start();
  return { pages, events, start: () => (start(), bound()), halt, bound };
}

it("a long native turn hears the owner at once, absorbs messages that waited together, and keeps the service lane out", async () => {
  const f = await fixture();
  const head = seat(f.captain);
  await head.bound();
  const turn = (activity: "responding" | "waiting", turnStart = false) =>
    f.captain.syncSeatTranscript("global-default", {
      sessionId: "head-session",
      entries: [],
      activity,
      ...(turnStart ? { turnStart: true as const } : {}),
    });

  // The head starts a long turn of its own and keeps working through it.
  expect(turn("responding", true)).toBe(true);

  // Auto and a watch arrive mid-turn and reach the head, not the service lane.
  await f.autonomous("Auto round: check the board.");
  expect(await f.captain.wakeConversation({ conversationId: "global-default" }, "Watch: w1 settled.")).toBe(
    true,
  );
  await vi.waitFor(() =>
    expect(head.events().map((event) => event.kind)).toEqual(expect.arrayContaining(["wake", "watch"])),
  );

  // The owner speaks during that same turn. It reaches the head within a short
  // bound without the turn ending, as a steer, instead of waiting for it.
  const startedAt = Date.now();
  const first = f.captain.submitDiscordTurn(f.ownerMessage(1, "Any update from TCM?"));
  await vi.waitFor(
    () => expect(head.events().some((event) => event.content.includes("Any update from TCM?"))).toBe(true),
    { timeout: 3_000 },
  );
  expect(Date.now() - startedAt).toBeLessThan(3_000);
  const firstEvent = head.events().find((event) => event.content.includes("Any update from TCM?"))!;
  expect(firstEvent).toMatchObject({ kind: "escalation", source: "discord-main" });

  // The bridge drops between polls (a restart of its transport). Two more owner
  // messages, a watch and an Auto round arrive while it is away, still inside
  // the head's lane hold: none of them runs on the service lane.
  await head.halt();
  const pagesBefore = head.pages.length;
  const second = f.captain.submitDiscordTurn(f.ownerMessage(2, "Also, the heap files?"));
  const third = f.captain.submitDiscordTurn(f.ownerMessage(3, "Never mind TCM, just the heap files."));
  const watch = f.captain.wakeConversation({ conversationId: "global-default" }, "Watch: w2 settled.");
  const auto = f.autonomous("Auto round: second check.");
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(fake.prompts).toEqual([]);

  // The head comes back mid-turn. The owner's waiting messages arrive first, as
  // one input, each still attributed, the later one framed as context.
  void head.start();
  await vi.waitFor(() => expect(head.pages.length).toBeGreaterThan(pagesBefore));
  const [batch] = head.pages[pagesBefore]!;
  expect(batch).toMatchObject({ kind: "escalation", source: "discord-main" });
  expect(batch!.content).toContain("2 owner messages from the same channel arrived together");
  expect(batch!.content).toContain("Later messages are context for earlier ones");
  expect(batch!.content.indexOf("Also, the heap files?")).toBeLessThan(
    batch!.content.indexOf("Never mind TCM, just the heap files."),
  );
  expect(head.events().filter((event) => event.kind === "escalation")).toHaveLength(2);

  // One answer, with everything in view, closes all three. It posts once, on
  // the newest message; the older ones record that this reply answered them.
  expect(
    await f.captain.replySeatEvent(batch!.id, "Heap files are in VUH-2870; TCM can wait.", "global-default"),
  ).toBe(true);
  const [one, two, three] = await Promise.all([first, second, third]);
  expect(three).toMatchObject({
    state: "settled",
    response: "Heap files are in VUH-2870; TCM can wait.",
    captainSessionId: "global-default",
  });
  for (const covered of [one, two])
    expect(covered).toMatchObject({
      state: "absorbed",
      replyDeliveryId: "owner-delivery-3",
      deliveryStage: "responded",
      captainSessionId: "global-default",
    });
  // The answer is not re-posted for the earlier messages, and their receipts
  // are stable on a repeat delivery.
  expect(JSON.stringify([one, two])).not.toContain("TCM can wait");
  expect(await f.captain.submitDiscordTurn(f.ownerMessage(1, "Any update from TCM?"))).toEqual(one);

  // The lower-priority watch and Auto round follow the owner, still to the head.
  expect(await watch).toBe(true);
  await auto;
  await vi.waitFor(() =>
    expect(head.events().map((event) => event.content)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Watch: w2 settled."),
        expect.stringContaining("Auto round: second check."),
      ]),
    ),
  );
  const order = head.events().map((event) => event.content);
  expect(order.findIndex((content) => content.includes("Never mind TCM"))).toBeLessThan(
    order.findIndex((content) => content.includes("Watch: w2 settled.")),
  );

  // No service-lane turn ran beside the live head, so no service message_seat
  // could have, and no takeover was recorded.
  expect(fake.prompts).toEqual([]);
  expect(
    f.journal
      .read("global-default")
      .some((event) => event.type === "message" && event.text.includes("service lane took over")),
  ).toBe(false);
  expect(turn("waiting")).toBe(true);
});

it("a native head that stays silent past its lane hold is taken over explicitly", async () => {
  const f = await fixture({ headBoundGraceMs: 200, headLaneHoldMs: 1_500 });
  const head = seat(f.captain);
  await head.bound();
  expect(await f.captain.wakeConversation({ conversationId: "global-default" }, "Watch: w1 settled.")).toBe(
    true,
  );
  await vi.waitFor(() => expect(head.events()).toHaveLength(1));
  await head.halt();
  const leftAt = Date.now();
  expect(await f.captain.wakeConversation({ conversationId: "global-default" }, "Watch: w2 settled.")).toBe(
    true,
  );
  // Inside the hold the input waits for the head.
  await new Promise((resolve) => setTimeout(resolve, 800));
  expect(fake.prompts).toEqual([]);
  // Past it, the service lane takes over and says so in the conversation.
  await vi.waitFor(() => expect(fake.prompts).toEqual([expect.stringContaining("Watch: w2 settled.")]), {
    timeout: 5_000,
  });
  expect(Date.now() - leftAt).toBeGreaterThanOrEqual(1_400);
  expect(f.journal.read("global-default")).toContainEqual(
    expect.objectContaining({
      type: "message",
      text: expect.stringContaining("Clankie's service lane took over this conversation"),
    }),
  );
});
