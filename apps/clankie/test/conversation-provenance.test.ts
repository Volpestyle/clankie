import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createFileMemory } from "../src/memory.ts";
import {
  HerdrWatchStore,
  type HerdrAgentSnapshot,
  type HerdrWatchRunner,
} from "../src/captain/herdr-watch.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";
import { captainTools, type TurnContext } from "../src/captain/tools.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { LaneLog } from "../src/captain/lane-log.ts";

const roots: string[] = [];
const root = () => {
  const dir = mkdtempSync(join(tmpdir(), "conversation-provenance-"));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const note = {
  schemaVersion: 1,
  episodeId: "note-a",
  lane: "discord_presence",
  targetId: "guild:a",
  sourceConversationId: "room-a",
  summary: "A shared experience",
  visibility: "shareable",
  provenance: {
    characterId: "clankie",
    sessionId: "admitted-session",
    selfAuthored: true,
    rawTranscript: false,
  },
  occurredAt: "2026-10-03T12:00:00.000Z",
};

it("preserves stable memory provenance across sharing, restart and correction; same-lane peers and legacy cannot correct", () => {
  const dataDir = root();
  createFileMemory({ dataDir }).recordEpisode(note);
  const memory = createFileMemory({ dataDir });
  expect(memory.searchEpisodeCard({ lane: "gameplay", query: "shared" })).toContain("source room-a");
  expect(
    memory.correctEpisode({
      lane: "discord_presence",
      sourceConversationId: "room-b",
      episodeId: "note-a",
      summary: "forged",
    }),
  ).toBeUndefined();
  expect(
    memory.correctEpisode({
      lane: "operator",
      sourceConversationId: "console",
      episodeId: "note-a",
      summary: "inspection",
    }),
  ).toBeUndefined();
  expect(
    memory.correctEpisode({
      lane: "discord_presence",
      sourceConversationId: "room-a",
      episodeId: "note-a",
      summary: "corrected",
    }),
  ).toMatchObject({ sourceConversationId: "room-a", targetId: "guild:a", occurredAt: note.occurredAt });
  memory.recordEpisode({ ...note, episodeId: "legacy", sourceConversationId: undefined });
  expect(
    memory.correctEpisode({
      lane: "discord_presence",
      sourceConversationId: "room-a",
      episodeId: "legacy",
      summary: "invented owner",
    }),
  ).toBeUndefined();
  expect(
    memory.updateEpisode("discord_presence", "legacy", { summary: "explicit operator management" })?.summary,
  ).toBe("explicit operator management");
});

it("refuses unbound API provenance and stamps only the authenticated exact source", async () => {
  const memory = createFileMemory({ dataDir: root() });
  let bound = false;
  const service = await createClankieApp({
    captain: createStubCaptain(),
    memory,
    authenticateCaptain: async () => ({
      captainId: "body",
      steerSourceLane: "discord_text",
      ...(bound
        ? {
            episodeSource: {
              conversationId: "room-a",
              lane: "discord_presence" as const,
              targetId: "guild:a",
              sessionId: "admitted-session",
            },
          }
        : {}),
    }),
  });
  try {
    const post = (payload: unknown) =>
      service.app.request("/v1/memory/captain-episodes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    expect((await post(note)).status).toBe(403);
    bound = true;
    expect((await post({ ...note, targetId: "guild:b" })).status).toBe(403);
    expect(
      (
        await post({
          ...note,
          sourceConversationId: "forged-room",
          provenance: { ...note.provenance, sessionId: "forged-session", characterId: "forged-persona" },
        })
      ).status,
    ).toBe(200);
    expect(memory.catalog().captainEpisodes[0]).toMatchObject({
      sourceConversationId: "room-a",
      provenance: note.provenance,
    });
    expect(memory.catalog().captainEpisodes).toHaveLength(1);
  } finally {
    service.close();
  }
});

it("captures memory ownership before asynchronous admission and refuses a replaced turn", async () => {
  let release!: (value: boolean) => void;
  let current = true;
  const appendEpisode = vi.fn(async () => ({ corrected: false, retained: false }));
  const deps = { embodiment: {}, memory: { appendEpisode } } as unknown as CaptainDeps;
  const turn: TurnContext = {
    targetId: "guild:a",
    conversationAuthority: {
      owner: { conversationId: "room-a" },
      current: () => current,
      authorize: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
  };
  const tool = captainTools(deps, turn, {} as LaneLog, "discord_presence").find(
    (entry) => entry.name === "remember_episode",
  )!;
  const pending = tool.execute("remember", { summary: "note" }, undefined, undefined, {} as never);
  turn.targetId = "guild:b";
  turn.conversationAuthority!.owner.conversationId = "room-b";
  release(true);
  await pending;
  expect(appendEpisode).toHaveBeenCalledWith(
    expect.objectContaining({ sourceConversationId: "room-a", targetId: "guild:a" }),
  );
  const stale = tool.execute("stale", { summary: "note" }, undefined, undefined, {} as never);
  current = false;
  release(true);
  await expect(stale).rejects.toThrow("authority");
  expect(appendEpisode).toHaveBeenCalledOnce();
});

it("persists hire intent before discovery and exact pane/seat ownership before completion, including restart", async () => {
  const path = join(root(), "watches.json");
  const agent: HerdrAgentSnapshot = {
    paneId: "w1:p1",
    terminalId: "term_worker",
    agent: "claude",
    status: "working",
    title: "worker",
    session: { source: "herdr:claude", kind: "id", value: "session-one" },
  };
  let settle!: (agent: HerdrAgentSnapshot) => void;
  let waits = 0;
  const runner: HerdrWatchRunner = {
    get: async () => agent,
    resolveTerminal: async () => agent,
    wait: () =>
      new Promise((resolve) => {
        waits += 1;
        settle = resolve;
      }),
    createTab: async () => {
      expect(JSON.parse(readFileSync(`${path}.owners.json`, "utf8"))).toMatchObject({
        hires: [{ owner: { conversationId: "hirer-a" } }],
      });
      return agent.paneId;
    },
    startAgent: async () => {
      expect(new HireOwners(`${path}.owners.json`).pendingOwner(agent.paneId)).toEqual({
        conversationId: "hirer-a",
      });
    },
  };
  const store = new HerdrWatchStore(path, { runner });
  store.start(async () => {});
  const hired = await store.spawnSeat(
    { schemaVersion: 1, harness: "claude", title: "worker", workingDirectory: tmpdir() },
    undefined,
    undefined,
    undefined,
    { owner: { conversationId: "hirer-a" }, current: () => true, authorize: async () => true },
  );
  expect(hired.outcome).toBe("spawned");
  expect(JSON.parse(readFileSync(`${path}.owners.json`, "utf8"))).toMatchObject({
    hires: [{ seatId: "term_worker", occupantId: expect.any(String), owner: { conversationId: "hirer-a" } }],
  });
  await expect(store.watch("hirer-b", agent.paneId, "steal completion")).rejects.toThrow(
    "another admitted conversation",
  );
  await vi.waitFor(() => expect(waits).toBe(1));
  store.close();
  const wake = vi.fn(async () => {});
  const restarted = new HerdrWatchStore(path, { runner });
  restarted.start(wake);
  await vi.waitFor(() => expect(waits).toBe(2));
  settle({ ...agent, status: "blocked" });
  await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce());
  expect(wake).toHaveBeenCalledWith("hirer-a", expect.stringContaining("Harvest the worker"));
  restarted.close();
});

it("refuses a hire after its grant is revoked during pane discovery, preserving uncertain origin", async () => {
  const path = join(root(), "watches.json");
  let allowed = true;
  const startAgent = vi.fn(async () => {});
  const runner: HerdrWatchRunner = {
    get: async () => {
      throw new Error("unused");
    },
    resolveTerminal: async () => undefined,
    wait: async () => {
      throw new Error("unused");
    },
    createTab: async () => {
      allowed = false;
      return "w1:p1";
    },
    startAgent,
  };
  const store = new HerdrWatchStore(path, { runner });
  const result = await store.spawnSeat(
    { schemaVersion: 1, harness: "claude", title: "worker", workingDirectory: tmpdir() },
    undefined,
    undefined,
    undefined,
    { owner: { conversationId: "hirer-a" }, current: () => true, authorize: async () => allowed },
  );
  expect(result.outcome).toBe("failed");
  expect(startAgent).not.toHaveBeenCalled();
  expect(new HireOwners(`${path}.owners.json`).pendingOwner("w1:p1")).toEqual({ conversationId: "hirer-a" });
  store.close();
});

it("validates a persisted exact room against current grants and never falls back from an unavailable owner", async () => {
  const { SettingsStore } = await import("@clankie/settings");
  const { ConversationStore } = await import("../src/captain/conversations.ts");
  const { createCaptain } = await import("../src/captain/captain.ts");
  const census = await import("../src/captain/herdr-census.ts");
  const stateDir = root();
  const conversations = new ConversationStore(join(stateDir, "conversations"), async () => undefined);
  const conversationId = conversations.roomConversation(
    "discord_presence",
    "123456789012345678:456789012345678901",
  );
  conversations.close();
  const settings = new SettingsStore(join(stateDir, "settings.json"));
  await settings.update((current) => ({
    ...current,
    discord: { ...current.discord, systemActorUserIds: ["789012345678901234"] },
  }));
  const start = vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  const censusRead = vi.spyOn(census, "readFleet").mockResolvedValue({ seats: [] });
  const submit = vi.spyOn(ConversationStore.prototype, "submitInternal");
  const captain = createCaptain({} as CaptainDeps, {
    repoRoot: stateDir,
    stateDir,
    settings,
    discordEnvironment: {},
  });
  const owner = {
    conversationId,
    discord: {
      baseSessionKey: "discord:clankie:room-one",
      targetId: "123456789012345678:456789012345678901",
      actorId: "789012345678901234",
      guildId: "123456789012345678",
      channelId: "456789012345678901",
      messageId: "111",
      transportKind: "bot" as const,
    },
  };
  try {
    expect(await captain.validateConversationOwner(owner)).toBe(true);
    expect(
      await captain.validateConversationOwner({
        ...owner,
        conversationId: "discord_presence:123456789012345678:456789012345678901",
      }),
    ).toBe(false);
    expect(
      await captain.validateConversationOwner({ ...owner, discord: { ...owner.discord, channelId: "999" } }),
    ).toBe(false);
    expect(await captain.validateConversationOwner({ conversationId })).toBe(false);
    await settings.update((current) => ({
      ...current,
      discord: { ...current.discord, systemActorUserIds: [] },
    }));
    expect(await captain.validateConversationOwner(owner)).toBe(false);
    expect(await captain.wakeConversation(owner, "worker completed")).toBe(false);
    expect(await captain.wakeConversation({ conversationId: "missing-owner" }, "worker completed")).toBe(
      false,
    );
    await expect(
      captain.wakeConversation({ conversationId: "global-default" }, "queued", async () => {
        throw new Error("queue no longer admitted");
      }),
    ).rejects.toThrow("queue no longer admitted");
    expect(submit).not.toHaveBeenCalled();
    const missingHire = await captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "spawn_seat",
      seat: { schemaVersion: 1, harness: "claude", title: "not launched", workingDirectory: stateDir },
    });
    expect(missingHire).toMatchObject({ result: { outcome: "failed", reason: "not_ready" } });
  } finally {
    captain.close();
    start.mockRestore();
    censusRead.mockRestore();
    submit.mockRestore();
  }
});

it("does not harvest a rebound native occupant or move an unowned worker", async () => {
  const path = join(root(), "watches.json");
  const first: HerdrAgentSnapshot = {
    paneId: "w1:p1",
    terminalId: "term_one",
    agent: "claude",
    status: "working",
    title: "first",
    session: { source: "herdr:claude", kind: "id", value: "original" },
  };
  let settle!: (agent: HerdrAgentSnapshot) => void;
  const closePane = vi.fn(async () => {});
  const runner: HerdrWatchRunner = {
    get: async () => first,
    resolveTerminal: async () => first,
    wait: () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
    closePane,
  };
  const wake = vi.fn(async () => {});
  const store = new HerdrWatchStore(path, { runner });
  store.start(wake);
  await store.watch("owner-one", first.paneId, "exact worker");
  await vi.waitFor(() => expect(settle).toBeTypeOf("function"));
  settle({ ...first, status: "done", session: { ...first.session!, value: "replacement" } });
  await vi.waitFor(() => expect(JSON.parse(readFileSync(path, "utf8")).watches).toEqual([]));
  expect(wake).not.toHaveBeenCalled();
  expect(
    await store.moveSeat({
      seatId: first.terminalId,
      subject: "worker",
      harness: "claude",
      title: "worker",
      workingDirectory: tmpdir(),
    }),
  ).toMatchObject({ outcome: "failed", reason: "not_ready" });
  expect(closePane).not.toHaveBeenCalled();
  store.close();
});

it("retains the original hire receipt when authority expires after startup, and reconciles without another launch", async () => {
  const path = join(root(), "watches.json");
  let allowed = true;
  let agent: HerdrAgentSnapshot = {
    paneId: "w1:p1",
    terminalId: "term_one",
    agent: "claude",
    status: "working",
    title: "worker",
    session: { source: "herdr:claude", kind: "id", value: "10000000-0000-4000-8000-000000000001" },
  };
  const createTab = vi.fn(async () => agent.paneId);
  const startAgent = vi.fn(async (input: { name: string }) => {
    agent = { ...agent, name: input.name };
    allowed = false;
  });
  const runner: HerdrWatchRunner = {
    get: async () => agent,
    resolveTerminal: async () => agent,
    wait: () => new Promise(() => {}),
    createTab,
    startAgent,
  };
  const store = new HerdrWatchStore(path, { runner });
  const authority = {
    owner: { conversationId: "owner-a" },
    current: () => true,
    authorize: async () => allowed,
  };
  const request = {
    schemaVersion: 1 as const,
    harness: "claude" as const,
    title: "worker",
    workingDirectory: tmpdir(),
  };
  const adopt = vi.fn();
  expect(await store.spawnSeat(request, undefined, undefined, undefined, authority, adopt)).toMatchObject({
    outcome: "failed",
    reason: "start_unconfirmed",
  });
  expect(adopt).not.toHaveBeenCalled();
  allowed = true;
  const original = agent;
  agent = { ...agent, session: { ...agent.session!, value: "rebound-session" } };
  expect(await store.spawnSeat(request, undefined, undefined, undefined, authority, adopt)).toMatchObject({
    outcome: "failed",
    reason: "delivery_unconfirmed",
  });
  expect(adopt).not.toHaveBeenCalled();
  agent = original;
  expect(await store.spawnSeat(request, undefined, undefined, undefined, authority, adopt)).toMatchObject({
    outcome: "spawned",
  });
  expect(createTab).toHaveBeenCalledOnce();
  expect(startAgent).toHaveBeenCalledOnce();
  expect(adopt).toHaveBeenCalledOnce();
  store.close();
});

it("starts nothing when durable owner intent cannot be written", async () => {
  const path = join(root(), "watches.json");
  const createTab = vi.fn(async () => "w1:p1");
  const runner: HerdrWatchRunner = {
    get: async () => {
      throw new Error("unused");
    },
    resolveTerminal: async () => undefined,
    wait: async () => {
      throw new Error("unused");
    },
    createTab,
    startAgent: vi.fn(async () => {}),
  };
  const store = new HerdrWatchStore(path, { runner });
  mkdirSync(`${path}.owners.json.${String(process.pid)}.tmp`);
  await expect(
    store.spawnSeat(
      { schemaVersion: 1, harness: "claude", title: "worker", workingDirectory: tmpdir() },
      undefined,
      undefined,
      undefined,
      { owner: { conversationId: "owner-a" }, current: () => true, authorize: async () => true },
    ),
  ).rejects.toThrow();
  expect(createTab).not.toHaveBeenCalled();
  store.close();
});

it("keeps an unobserved native start uncertain even when pane, harness and name match", async () => {
  const path = join(root(), "watches.json");
  let agent: HerdrAgentSnapshot = {
    paneId: "w1:p1",
    terminalId: "term_one",
    agent: "claude",
    status: "working",
    title: "worker",
    session: { source: "herdr:claude", kind: "id", value: "unproven-replacement" },
  };
  const createTab = vi.fn(async () => agent.paneId);
  const startAgent = vi.fn(async (input: { name: string }) => {
    agent = { ...agent, name: input.name };
    throw new Error("startup acknowledgment lost");
  });
  const store = new HerdrWatchStore(path, {
    runner: {
      get: async () => agent,
      resolveTerminal: async () => agent,
      wait: () => new Promise(() => {}),
      createTab,
      startAgent,
    },
  });
  const request = {
    schemaVersion: 1 as const,
    harness: "claude" as const,
    title: "worker",
    workingDirectory: tmpdir(),
  };
  const authority = {
    owner: { conversationId: "owner-a" },
    current: () => true,
    authorize: async () => true,
  };
  expect(await store.spawnSeat(request, undefined, undefined, undefined, authority)).toMatchObject({
    outcome: "failed",
    reason: "start_unconfirmed",
  });
  expect(await store.spawnSeat(request, undefined, undefined, undefined, authority)).toMatchObject({
    outcome: "failed",
    reason: "delivery_unconfirmed",
  });
  expect(createTab).toHaveBeenCalledOnce();
  expect(startAgent).toHaveBeenCalledOnce();
  store.close();
});
