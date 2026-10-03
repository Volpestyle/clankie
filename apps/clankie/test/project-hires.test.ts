import type { SavedAgentSession } from "../src/agent-sessions.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import type { SpawnOperatorSeat } from "@clankie/protocol";
import { ProjectHires, type ProjectHireProcessProof } from "../src/captain/project-hires.ts";
import {
  HerdrWatchStore,
  type HerdrAgentSnapshot,
  type HerdrWatchRunner,
} from "../src/captain/herdr-watch.ts";
import { selectHireProject, nativeHireProject } from "../src/captain/project-hire-context.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const settings = () =>
  ProjectsSettingsSchema.parse({
    projects: [
      {
        id: "game",
        name: "Game",
        workerCap: 2,
        roles: [
          { role: "Engineer", harness: "claude", model: "owner-model", effort: "high", concurrencyCap: 1 },
        ],
      },
    ],
  });
const request = (dir: string): SpawnOperatorSeat => ({
  schemaVersion: 1,
  harness: "pi",
  workingDirectory: dir,
  title: "Implement",
  role: "Engineer",
  model: "wrong-model",
  effort: "low",
});
const proof: ProjectHireProcessProof = {
  nativeOccupantId: occupantIdForHerdrSession({ source: "claude", kind: "id", value: "s1" }),
  fleet: "default",
  pane: "p1",
  binding: { socketPath: "/tmp/test.sock", session: "desktop" },
  processes: [{ pid: 22, startTime: "today" }],
  shell: { pid: 11, startTime: "earlier" },
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "project-hires-"));
  roots.push(root);
  const projectSettings = settings();
  const agent: HerdrAgentSnapshot = {
    paneId: "p1",
    terminalId: "t1",
    title: "Implement",
    agent: "claude",
    status: "working",
    session: { source: "claude", kind: "id", value: "s1" },
  };
  const runner: HerdrWatchRunner = {
    get: vi.fn(async () => agent),
    resolveTerminal: vi.fn(async () => agent),
    wait: vi.fn(async () => agent),
    list: vi.fn(async () => [agent]),
    createTab: vi.fn(async () => "p1"),
    startAgent: vi.fn(async () => {}),
    closePane: vi.fn(async () => {}),
  };
  const path = join(root, "watches.json");
  const options = {
    runner,
    projectHirePolicy: {
      settings: async () => projectSettings,
      project: async () => "game",
      proof: vi.fn(async (fleet: string, pane: string) =>
        fleet === "default" && pane === "p1" ? proof : undefined,
      ),
    },
  };
  const store = new HerdrWatchStore(path, options);
  return { root, path, runner, projectSettings, store, options, agent };
}

describe("project hiring", () => {
  it("passes role harness, model and effort to the actual native launch, overriding requests", async () => {
    const f = await fixture();
    expect((await f.store.spawnSeat(request(f.root))).outcome).toBe("spawned");
    expect(f.runner.startAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "claude",
        args: expect.arrayContaining(["--model", "owner-model", "--effort", "high"]),
      }),
    );
    expect(f.options.projectHirePolicy.proof).toHaveBeenCalledWith("default", "p1");
    expect(f.store.projectHireAssignment("default", "p1", proof)).toMatchObject({
      state: "assigned",
      projectId: "game",
      role: "Engineer",
    });
    f.store.close();
  });
  it("reserves atomically while native startup is awaiting, and zero caps block before a pane", async () => {
    const f = await fixture();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.runner.createTab = vi.fn(async () => {
      await barrier;
      return "p1";
    });
    const first = f.store.spawnSeat(request(f.root));
    await vi.waitFor(() => expect(f.runner.createTab).toHaveBeenCalledOnce());
    const second = await f.store.spawnSeat({ ...request(f.root), workingDirectory: tmpdir() });
    expect(second).toMatchObject({ outcome: "failed", detail: expect.stringContaining("allows 1") });
    expect(f.runner.createTab).toHaveBeenCalledOnce();
    release();
    await first;
    f.store.close();
    const zero = await fixture();
    zero.projectSettings.projects[0]!.workerCap = 0;
    expect(await zero.store.spawnSeat(request(zero.root))).toMatchObject({
      outcome: "failed",
      detail: expect.stringContaining("allows 0"),
    });
    expect(zero.runner.createTab).not.toHaveBeenCalled();
    zero.store.close();
  });
  it("refuses a zero project cap before native effects", async () => {
    const f = await fixture();
    f.projectSettings.projects[0]!.workerCap = 0;
    expect(await f.store.spawnSeat(request(f.root))).toMatchObject({
      outcome: "failed",
      detail: expect.stringContaining("allows 0"),
    });
    expect(f.runner.createTab).not.toHaveBeenCalled();
    expect(f.runner.startAgent).not.toHaveBeenCalled();
    f.store.close();
  });
  it("refuses a reduced role cap at the last native launch boundary", async () => {
    const f = await fixture();
    f.runner.createTab = vi.fn(async () => {
      f.projectSettings.projects[0]!.roles[0]!.concurrencyCap = 0;
      return "p1";
    });
    expect(await f.store.spawnSeat(request(f.root))).toMatchObject({
      outcome: "failed",
      detail: expect.stringContaining("allows 0"),
    });
    expect(f.runner.startAgent).not.toHaveBeenCalled();
    f.store.close();
  });
  it("retains uncertain startup across restart and changed harness settings without starting a duplicate", async () => {
    const f = await fixture();
    f.runner.startAgent = vi.fn(async () => {
      throw new Error("lost start response");
    });
    f.runner.get = vi.fn(async () => {
      const { session: _session, ...agent } = f.agent;
      return agent;
    });
    expect(await f.store.spawnSeat(request(f.root))).toMatchObject({
      outcome: "failed",
      reason: "start_unconfirmed",
    });
    f.store.close();
    f.projectSettings.projects[0]!.roles[0]!.harness = "pi";
    f.projectSettings.projects[0]!.roles[0]!.model = "new-model";
    const restarted = new HerdrWatchStore(f.path, f.options);
    expect(await restarted.spawnSeat(request(f.root))).toMatchObject({ outcome: "failed" });
    expect(f.runner.startAgent).toHaveBeenCalledOnce();
    expect(await restarted.spawnSeat({ ...request(f.root), workingDirectory: tmpdir() })).toMatchObject({
      outcome: "failed",
      detail: expect.stringContaining("allows 1"),
    });
    restarted.close();
  });
  it("rechecks caps and launch settings after asynchronous preparation", async () => {
    const f = await fixture();
    const store = new HerdrWatchStore(join(f.root, "second.json"), {
      ...f.options,
      nativeLaunchPolicy: {
        admit: async ({ phase }) => {
          if (phase === "launch") f.projectSettings.projects[0]!.roles[0]!.model = "replacement";
        },
      },
    });
    expect(await store.spawnSeat(request(f.root))).toMatchObject({
      outcome: "failed",
      detail: expect.stringContaining("settings changed"),
    });
    expect(f.runner.createTab).not.toHaveBeenCalled();
    expect(f.runner.startAgent).not.toHaveBeenCalled();
    store.close();
    f.store.close();
  });
  it("never derives live capacity from persona done state and releases only a confirmed absent pane", async () => {
    const f = await fixture();
    await f.store.spawnSeat(request(f.root));
    f.runner.list = vi.fn(async () => [{ ...f.agent, status: "done" }]);
    expect(await f.store.spawnSeat(request(f.root))).toMatchObject({
      outcome: "failed",
      detail: expect.stringContaining("allows 1"),
    });
    f.runner.list = vi.fn(async () => []);
    expect((await f.store.spawnSeat(request(f.root))).outcome).toBe("spawned");
    expect(f.runner.startAgent).toHaveBeenCalledTimes(2);
    f.store.close();
  });
  it("denies stale PID, shell, socket and absent process proof, including after reload", async () => {
    const f = await fixture();
    await f.store.spawnSeat(request(f.root));
    f.store.close();
    const store = new HerdrWatchStore(f.path, f.options);
    for (const stale of [
      undefined,
      { ...proof, nativeOccupantId: "replacement-session" },
      { ...proof, processes: [{ pid: 22, startTime: "reused-pid" }] },
      { ...proof, shell: { pid: 11, startTime: "new-shell" } },
      { ...proof, binding: { socketPath: "/tmp/replacement.sock", session: "desktop" } },
    ])
      expect(store.projectHireAssignment("default", "p1", stale)).toEqual({ state: "invalid" });
    expect(store.projectHireAssignment("default", "p2", proof)).toEqual({ state: "none" });
    store.close();
  });
  it("separate ledger instances cannot reserve past a cap; prelaunch failure releases without erasing history", async () => {
    const f = await fixture();
    const path = join(f.root, "ledger.json");
    const first = new ProjectHires(path);
    const second = new ProjectHires(path);
    const held = first.reserve(f.projectSettings, "game", request(f.root));
    expect(() => second.reserve(f.projectSettings, "game", request(tmpdir()))).toThrow("allows 1");
    first.failed(held.id);
    expect(second.reserve(f.projectSettings, "game", request(tmpdir())).id).not.toBe(held.id);
    f.store.close();
  });
  it("reuses an exact running hire at capacity but never replaces it when it vanishes during resume", async () => {
    const f = await fixture();
    await f.store.spawnSeat(request(f.root));
    f.projectSettings.projects[0]!.workerCap = 0;
    const saved: SavedAgentSession = {
      ref: "local:s1",
      host: "local",
      sessionId: "s1",
      workingDirectory: f.root,
      file: { harness: "claude", path: join(f.root, "s1.jsonl"), size: 1, mtimeMs: 0 },
    };
    const resumed = { ...request(f.root), harness: "claude" as const, resume: "local:s1" };
    expect((await f.store.spawnSeat(resumed, undefined, undefined, saved)).outcome).toBe("spawned");
    expect(f.runner.startAgent).toHaveBeenCalledOnce();
    f.runner.list = vi.fn().mockResolvedValueOnce([f.agent]).mockResolvedValue([]);
    expect(await f.store.spawnSeat(resumed, undefined, undefined, saved)).toMatchObject({
      outcome: "failed",
      detail: expect.stringContaining("No replacement"),
    });
    expect(f.runner.startAgent).toHaveBeenCalledOnce();
    f.store.close();
  });
  it("refuses resumed sessions whose project role has changed without adopting new launch settings", async () => {
    const f = await fixture();
    await f.store.spawnSeat(request(f.root));
    f.projectSettings.projects[0]!.roles[0]!.model = "changed";
    const saved: SavedAgentSession = {
      ref: "local:s1",
      host: "local",
      sessionId: "s1",
      workingDirectory: f.root,
      file: { harness: "claude", path: join(f.root, "s1.jsonl"), size: 1, mtimeMs: 0 },
    };
    expect(
      await f.store.spawnSeat(
        { ...request(f.root), harness: "claude", resume: "local:s1" },
        undefined,
        undefined,
        saved,
      ),
    ).toMatchObject({ outcome: "failed", detail: expect.stringContaining("earlier role settings") });
    expect(f.runner.startAgent).toHaveBeenCalledOnce();
    f.store.close();
  });
  it("cannot replace an assignment's original process proof during uncertain recovery", async () => {
    const f = await fixture();
    const ledger = new ProjectHires(join(f.root, "ledger.json"));
    const held = ledger.reserve(f.projectSettings, "game", request(f.root));
    ledger.launch(held.id, f.projectSettings);
    ledger.pane(held.id, "p1");
    ledger.observe(held.id, "t1", proof.nativeOccupantId, proof);
    const replacement = { ...proof, processes: [{ pid: 23, startTime: "later" }] };
    expect(() => ledger.observe(held.id, "t1", proof.nativeOccupantId, replacement)).toThrow(
      "process has changed",
    );
    expect(ledger.assignment("default", "p1", replacement)).toEqual({ state: "invalid" });
    f.store.close();
  });
  it("uses the verified native workspace fallback only when the current source has no hire assignment", async () => {
    const workspace = vi.fn(async (current: ProjectHireProcessProof) =>
      current === proof ? "game" : undefined,
    );
    expect(await nativeHireProject(proof.nativeOccupantId, proof, () => ({ state: "none" }), workspace)).toBe(
      "game",
    );
    expect(workspace).toHaveBeenCalledWith(proof);
    workspace.mockClear();
    await expect(
      nativeHireProject(proof.nativeOccupantId, proof, () => ({ state: "invalid" }), workspace),
    ).rejects.toThrow("agent has changed");
    await expect(
      nativeHireProject("old-session", proof, () => ({ state: "none" }), workspace),
    ).rejects.toThrow("agent has changed");
    expect(workspace).not.toHaveBeenCalled();
  });
  it("cannot select another project bucket from a project conversation", () => {
    expect(() => selectHireProject("game", "other", "other")).toThrow("different projects");
    expect(() => selectHireProject("game", undefined, "other")).toThrow("does not match");
    expect(selectHireProject("game", undefined)).toBe("game");
  });
});
