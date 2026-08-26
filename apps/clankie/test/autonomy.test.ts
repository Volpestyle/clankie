import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  it("exposes goal and wake controls only in the operator lane", async () => {
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
    const operator = captainTools(
      deps,
      { targetId: "global-default" },
      {} as LaneLog,
      "operator",
      undefined,
      autonomy,
    );
    const names = operator.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(["create_goal", "get_goal", "update_goal", "schedule_wake"]),
    );
    expect(captainTools(deps, {}, {} as LaneLog, "discord_presence", undefined, autonomy)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "create_goal" })]),
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
      status: "active",
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
    await expect(
      autonomousCreate.execute("call-2", { objective: "Self-activate" }, undefined, undefined, {} as never),
    ).rejects.toThrow(/may propose goals, not create them/u);
    autonomy.close();
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
