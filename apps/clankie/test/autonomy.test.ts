import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutonomyStore } from "../src/captain/autonomy.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { LaneLog } from "../src/captain/lane-log.ts";
import { captainTools } from "../src/captain/tools.ts";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("captain autonomy", () => {
  it("exposes continuity controls only in the operator lane", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-autonomy-tools-"));
    roots.push(root);
    const autonomy = new AutonomyStore(join(root, "autonomy.json"));
    const deps = {
      embodiment: {
        submitIntent: () => Promise.reject(new Error("unused")),
        getSession: () => Promise.resolve(undefined),
        getLiveSession: () => Promise.resolve(undefined),
      },
    } as unknown as CaptainDeps;
    const herdrWatches = {
      watch: vi.fn((_conversationId: string, target: string, _reason: string) =>
        Promise.resolve({
          outcome: "watching" as const,
          watchId: "watch-1",
          target,
          paneId: target,
          terminalId: "term-1",
          alreadyWatching: false,
          createdAt: "2026-08-26T19:00:00.000Z",
        }),
      ),
    };
    const operator = captainTools(
      deps,
      {
        targetId: "global-default",
        conversationAuthority: {
          owner: { conversationId: "global-default" },
          current: () => true,
          authorize: async () => true,
        },
      },
      {} as LaneLog,
      "operator",
      undefined,
      autonomy,
      herdrWatches,
    );
    const names = operator.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(["get_wake", "schedule_wake", "cancel_wake", "herdr_watch"]),
    );
    expect(names).not.toEqual(expect.arrayContaining(["create_goal"]));
    expect(captainTools(deps, {}, {} as LaneLog, "discord_presence", undefined, autonomy)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "schedule_wake" })]),
    );

    const watch = operator.find((tool) => tool.name === "herdr_watch");
    if (watch === undefined) throw new Error("herdr_watch is missing");
    await watch.execute(
      "call-watch",
      { agent: "w18:p1", reason: "Harvest the finished analysis" },
      undefined,
      undefined,
      {} as never,
    );
    expect(herdrWatches.watch).toHaveBeenCalledWith(
      "global-default",
      "w18:p1",
      "Harvest the finished analysis",
      undefined,
      expect.any(Function),
    );

    autonomy.close();
  });

  it("lets a Discord room with a shell watch its own worker and answer where it was asked", async () => {
    const deps = {
      embodiment: {
        submitIntent: () => Promise.reject(new Error("unused")),
        getSession: () => Promise.resolve(undefined),
        getLiveSession: () => Promise.resolve(undefined),
      },
    } as unknown as CaptainDeps;
    const herdrWatches = {
      watch: vi.fn((_conversationId: string, target: string) =>
        Promise.resolve({
          outcome: "watching" as const,
          watchId: "watch-1",
          target,
          paneId: target,
          terminalId: "term-1",
          alreadyWatching: false,
          createdAt: "2026-09-24T22:57:45.000Z",
        }),
      ),
    };
    const discordOrigin = {
      baseSessionKey: "discord:clankie:discord:guild:channel",
      targetId: "guild:channel",
      actorId: "actor",
      guildId: "guild",
      channelId: "channel",
      messageId: "message",
      transportKind: "bot" as const,
    };
    const room = (shell: boolean) =>
      captainTools(
        deps,
        {
          room: "discord_presence:guild:channel",
          shell,
          discordOrigin,
          conversationAuthority: {
            owner: { conversationId: "room-stable", discord: discordOrigin },
            current: () => true,
            authorize: async () => true,
          },
        },
        {} as LaneLog,
        "discord_presence",
        undefined,
        undefined,
        herdrWatches,
      ).find((tool) => tool.name === "herdr_watch");
    expect(room(false)).toBeUndefined();
    const watch = room(true);
    if (watch === undefined) throw new Error("herdr_watch is missing");
    await watch.execute(
      "call-watch",
      { agent: "w2H:pQ", reason: "Report the publish result" },
      undefined,
      undefined,
      {} as never,
    );
    expect(herdrWatches.watch).toHaveBeenCalledWith(
      "room-stable",
      "w2H:pQ",
      "Report the publish result",
      discordOrigin,
      expect.any(Function),
    );
  });

  it("wakes only while Auto is on, keeps the switch across restart, and fails closed when unreadable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    const root = await mkdtemp(join(tmpdir(), "clankie-autonomy-"));
    roots.push(root);
    const path = join(root, "autonomy.json");
    const runs: string[] = [];
    const store = new AutonomyStore(path);
    store.start(async (_conversationId, prompt) => {
      runs.push(prompt);
    });
    store.scheduleWake("global-default", "2026-08-24T12:00:01.000Z", "Check the build");
    store.command("global-default", { action: "set_enabled", enabled: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs).toHaveLength(0);

    store.command("global-default", { action: "set_enabled", enabled: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(runs[0]).toContain("Check the build");
    expect(store.status("global-default").wake).toBeUndefined();
    store.command("global-default", { action: "set_enabled", enabled: false });
    store.close();

    expect(new AutonomyStore(path).status("global-default")).toEqual({ enabled: false });

    await writeFile(path, "not json", "utf8");
    const failClosed = new AutonomyStore(path);
    expect(failClosed.status("global-default")).toEqual({
      enabled: false,
      error: "state_unreadable",
    });
    failClosed.close();
  });

  it("drops a retired goal from an older file while keeping its switch and pending wake", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-autonomy-legacy-"));
    roots.push(root);
    const path = join(root, "autonomy.json");
    const wake = {
      at: "2099-01-01T00:00:00.000Z",
      reason: "Check the build",
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        conversations: {
          "global-default": {
            goal: { objective: "Verify the release", status: "active", tokensUsed: 10, tokenBudget: 100 },
            wake,
          },
          "goal-only": { goal: { objective: "Old work", status: "complete", tokensUsed: 1 } },
        },
      }),
    );
    const store = new AutonomyStore(path);
    expect(store.status("global-default")).toEqual({ enabled: true, wake });
    store.command("global-default", { action: "clear_wake" });
    store.close();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      schemaVersion: 1,
      enabled: true,
      conversations: {},
    });
  });

  it("does not admit a replacement wake while the current wake is still running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    const root = await mkdtemp(join(tmpdir(), "clankie-wake-serialization-"));
    roots.push(root);
    const store = new AutonomyStore(join(root, "autonomy.json"));
    const runs: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.start(async (_conversationId, prompt) => {
      runs.push(prompt);
      if (runs.length === 1) {
        store.scheduleWake("global-default", "2026-08-24T12:00:01.100Z", "replacement");
        await gate;
      }
    });
    store.scheduleWake("global-default", "2026-08-24T12:00:01.000Z", "first");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(runs).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toContain("replacement");
    store.close();
  });
});
