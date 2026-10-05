import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutonomyStore, DEFAULT_GOAL_TOKEN_BUDGET } from "../src/captain/autonomy.ts";
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
      expect.arrayContaining(["create_goal", "get_goal", "update_goal", "schedule_wake", "herdr_watch"]),
    );
    expect(captainTools(deps, {}, {} as LaneLog, "discord_presence", undefined, autonomy)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "create_goal" })]),
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

    const create = operator.find((tool) => tool.name === "create_goal");
    if (create === undefined) throw new Error("create_goal is missing");
    await create.execute(
      "call-1",
      { objective: "Verify the release", token_budget: 200 },
      undefined,
      undefined,
      {} as never,
    );
    expect(autonomy.getGoal("global-default")).toMatchObject({
      objective: "Verify the release",
      tokenBudget: 200,
      status: "proposed",
    });
    const autonomousCreate = captainTools(
      deps,
      { targetId: "another-conversation", autonomous: true },
      {} as LaneLog,
      "operator",
      undefined,
      autonomy,
    ).find((tool) => tool.name === "create_goal");
    if (autonomousCreate === undefined) throw new Error("autonomous create_goal is missing");
    await autonomousCreate.execute(
      "call-2",
      { objective: "Self-proposed work" },
      undefined,
      undefined,
      {} as never,
    );
    expect(autonomy.getGoal("another-conversation")).toMatchObject({
      objective: "Self-proposed work",
      status: "proposed",
      tokenBudget: DEFAULT_GOAL_TOKEN_BUDGET,
    });
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

  it("persists goals, enforces their budget, and wakes only while autonomy is enabled", async () => {
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

    store.command("global-default", {
      action: "set_goal",
      objective: "Verify the release",
      tokenBudget: 100,
    });
    expect(runs[0]).toContain("Verify the release");
    expect(() => store.createGoal("global-default", "Replace it")).toThrow(/unfinished goal/u);

    store.finishTurn("global-default", 100);
    expect(store.status("global-default").goal).toMatchObject({
      status: "budget_limited",
      tokensUsed: 100,
    });
    store.scheduleWake("global-default", "2026-08-24T12:00:01.000Z", "Check the build");
    store.command("global-default", { action: "set_enabled", enabled: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs).toHaveLength(1);

    store.command("global-default", { action: "set_enabled", enabled: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(runs[1]).toContain("Check the build");
    expect(store.status("global-default").wake).toBeUndefined();
    store.close();

    const restarted = new AutonomyStore(path);
    expect(restarted.status("global-default")).toMatchObject({
      enabled: true,
      goal: { objective: "Verify the release", status: "budget_limited", tokensUsed: 100 },
    });
    restarted.close();

    await writeFile(path, "not json", "utf8");
    const failClosed = new AutonomyStore(path);
    expect(failClosed.status("global-default")).toEqual({
      enabled: false,
      error: "state_unreadable",
    });
    failClosed.close();
  });

  it("keeps a proposal inert across restart, then admits only owner-accepted work within its durable budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-goal-proposal-"));
    roots.push(root);
    const path = join(root, "autonomy.json");
    const proposed = new AutonomyStore(path);
    proposed.proposeGoal("global-default", "Verify the release", 100);
    proposed.finishTurn("global-default", 40);
    proposed.close();

    const store = new AutonomyStore(path);
    const runs: string[] = [];
    let release!: () => void;
    const running = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.start(async (_conversationId, prompt) => {
      runs.push(prompt);
      await running;
    });
    try {
      expect(store.getGoal("global-default")).toMatchObject({ status: "proposed", tokensUsed: 0 });
      expect(runs).toEqual([]);
      expect(() => store.command("global-default", { action: "set_goal_status", status: "active" })).toThrow(
        /Accept the proposed goal/u,
      );
      expect(() => store.command("global-default", { action: "set_goal_status", status: "paused" })).toThrow(
        /Accept the proposed goal/u,
      );
      expect(store.getGoal("global-default")?.status).toBe("proposed");

      store.command("global-default", { action: "accept_goal" });
      expect(runs).toHaveLength(1);
      expect(runs[0]).toContain("Verify the release");
      const goal = store.getGoal("global-default")!;
      expect(store.recordUsage("global-default", 60, goal)?.status).toBe("active");
      expect(runs).toHaveLength(1);
      const duringTurn = new AutonomyStore(path);
      expect(duringTurn.getGoal("global-default")).toMatchObject({ status: "active", tokensUsed: 60 });
      duringTurn.close();

      expect(store.recordUsage("global-default", 40, goal)?.status).toBe("budget_limited");
      store.finishTurn("global-default", 0, goal);
      release();
      await running;
      await Promise.resolve();
      expect(runs).toHaveLength(1);
      expect(() => store.command("global-default", { action: "set_goal_status", status: "active" })).toThrow(
        /exhausted its token budget/u,
      );
      const persisted = JSON.parse(await readFile(path, "utf8"));
      expect(persisted.conversations["global-default"].goal).toMatchObject({
        status: "budget_limited",
        tokensUsed: 100,
        tokenBudget: 100,
      });
    } finally {
      release();
      store.close();
    }
  });

  it("bounds omitted and legacy budgets before restart can admit another goal turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-goal-budget-migration-"));
    roots.push(root);
    const path = join(root, "autonomy.json");
    const now = new Date().toISOString();
    const legacyGoal = (tokensUsed: number, tokenBudget?: number) => ({
      objective: "Continue legacy work",
      status: "active",
      tokensUsed,
      ...(tokenBudget === undefined ? {} : { tokenBudget }),
      createdAt: now,
      updatedAt: now,
    });
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        conversations: {
          remaining: { goal: legacyGoal(DEFAULT_GOAL_TOKEN_BUDGET - 50) },
          runaway: { goal: legacyGoal(107_000_000) },
          explicit: { goal: legacyGoal(200, 200) },
        },
      }),
    );
    const store = new AutonomyStore(path);
    const runs: string[] = [];
    store.start(async (conversationId) => {
      runs.push(conversationId);
      const goal = store.getGoal(conversationId)!;
      store.recordUsage(conversationId, 50, goal);
      store.finishTurn(conversationId, 0, goal);
    });
    try {
      await Promise.resolve();
      expect(runs).toEqual(["remaining"]);
      expect(store.getGoal("remaining")).toMatchObject({
        tokenBudget: DEFAULT_GOAL_TOKEN_BUDGET,
        tokensUsed: DEFAULT_GOAL_TOKEN_BUDGET,
        status: "budget_limited",
      });
      expect(store.getGoal("runaway")).toMatchObject({
        tokenBudget: DEFAULT_GOAL_TOKEN_BUDGET,
        tokensUsed: 107_000_000,
        status: "budget_limited",
      });
      expect(store.getGoal("explicit")).toMatchObject({ tokenBudget: 200, status: "budget_limited" });
      const proposed = store.proposeGoal("new-proposal", "Inspect a release");
      const created = store.createGoal("new-owner-goal", "Ship the verified release");
      expect(proposed.tokenBudget).toBe(DEFAULT_GOAL_TOKEN_BUDGET);
      expect(created.tokenBudget).toBe(DEFAULT_GOAL_TOKEN_BUDGET);
      expect(() => store.createGoal("invalid", "Unlimited work", Infinity)).toThrow();
      expect(() => store.createGoal("invalid", "Fractional budget", 1.5)).toThrow();
      expect(store.getGoal("invalid")).toBeUndefined();
    } finally {
      store.close();
    }
    const restarted = new AutonomyStore(path);
    const admissions: string[] = [];
    restarted.start(async (conversationId) => {
      admissions.push(conversationId);
      restarted.pauseGoal(conversationId);
    });
    expect(admissions).toEqual(["new-owner-goal"]);
    expect(restarted.getGoal("runaway")?.status).toBe("budget_limited");
    restarted.close();
  });

  it("never bills a replacement goal for the previous turn or loses unsafe usage on restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-goal-usage-"));
    roots.push(root);
    const path = join(root, "autonomy.json");
    const store = new AutonomyStore(path);
    const previous = store.createGoal("global-default", "Verify the previous release", 200);
    store.recordUsage("global-default", 50, previous);
    store.updateGoal("global-default", "complete");
    expect(store.recordUsage("global-default", 200, previous)?.status).toBe("complete");
    const blocked = store.createGoal("blocked", "Recover a missing dependency", 100);
    store.updateGoal("blocked", "blocked");
    expect(store.recordUsage("blocked", 200, blocked)?.status).toBe("blocked");
    const replacement = store.createGoal("global-default", "Verify the next release", 200);
    expect(store.recordUsage("global-default", 100, previous)).toBeUndefined();
    store.finishTurn("global-default", 100, previous);
    expect(replacement.tokensUsed).toBe(0);
    expect(store.recordUsage("global-default", NaN, replacement)?.status).toBe("usage_limited");
    store.close();

    const restarted = new AutonomyStore(path);
    expect(restarted.getGoal("global-default")).toMatchObject({
      objective: "Verify the next release",
      tokensUsed: 0,
      tokenBudget: 200,
      status: "usage_limited",
    });
    const admissions: string[] = [];
    restarted.start(async (conversationId) => {
      admissions.push(conversationId);
    });
    expect(admissions).toEqual([]);
    expect(restarted.getGoal("blocked")).toMatchObject({ status: "blocked", tokensUsed: 200 });
    restarted.close();
  });

  it("pins a waiting continuation to its original goal and admits a replacement after stale work is refused", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-goal-queued-identity-"));
    roots.push(root);
    const path = join(root, "autonomy.json");
    const store = new AutonomyStore(path);
    let release!: () => void;
    const admission = new Promise<void>((resolve) => {
      release = resolve;
    });
    let replacementSettled!: () => void;
    const replacementRun = new Promise<void>((resolve) => {
      replacementSettled = resolve;
    });
    const attempted: string[] = [];
    const executed: string[] = [];
    store.start(async (conversationId, prompt, origin, expectedGoal) => {
      expect(origin).toBe("goal");
      if (expectedGoal === undefined) throw new Error("Goal identity missing");
      attempted.push(expectedGoal.objective);
      await admission;
      if (store.getGoal(conversationId) !== expectedGoal) {
        expect(store.recordUsage(conversationId, 100, expectedGoal)).toBeUndefined();
        expect(store.pauseGoal(conversationId, expectedGoal)).toBeUndefined();
        throw new Error("Stale goal continuation refused");
      }
      executed.push(prompt);
      store.recordUsage(conversationId, 50, expectedGoal);
      store.updateGoal(conversationId, "complete");
      store.finishTurn(conversationId, 0, expectedGoal);
      replacementSettled();
    });
    try {
      store.command("global-default", {
        action: "set_goal",
        objective: "Original goal",
        tokenBudget: 100,
      });
      store.command("global-default", { action: "clear_goal" });
      store.command("global-default", {
        action: "set_goal",
        objective: "Replacement goal",
        tokenBudget: 200,
      });
      expect(attempted).toEqual(["Original goal"]);
      release();
      await replacementRun;
      expect(attempted).toEqual(["Original goal", "Replacement goal"]);
      expect(executed).toHaveLength(1);
      expect(executed[0]).toContain("Replacement goal");
      const restarted = new AutonomyStore(path);
      expect(restarted.getGoal("global-default")).toMatchObject({
        objective: "Replacement goal",
        status: "complete",
        tokenBudget: 200,
        tokensUsed: 50,
      });
      restarted.close();
    } finally {
      release();
      store.close();
    }
  });

  it("keeps a per-goal decision journal that survives restarts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00.000Z"));
    const root = await mkdtemp(join(tmpdir(), "clankie-goal-journal-"));
    roots.push(root);
    const path = join(root, "autonomy.json");
    const store = new AutonomyStore(path);
    expect(() => store.noteDecision("global-default", { decision: "pick A", why: "because" })).toThrow(
      /no goal/u,
    );

    store.createGoal("global-default", "Verify the release");
    store.noteDecision("global-default", {
      decision: "Verify via the public socket path",
      why: "An in-process call proves the wrong boundary",
      evidence: "verify-clankie proof ladder rung 3",
      autonomous: true,
    });
    store.noteDecision("global-default", { decision: "Skip the flaky mirror", why: "It 404s" });
    expect(store.recentDecisions("global-default")).toMatchObject([
      { decision: "Verify via the public socket path", autonomous: true },
      { decision: "Skip the flaky mirror" },
    ]);
    store.close();

    const restarted = new AutonomyStore(path);
    expect(restarted.recentDecisions("global-default")).toHaveLength(2);
    restarted.updateGoal("global-default", "complete");
    vi.setSystemTime(new Date("2026-08-26T12:01:00.000Z"));
    restarted.createGoal("global-default", "Next goal");
    expect(restarted.recentDecisions("global-default")).toEqual([]);
    restarted.close();
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
