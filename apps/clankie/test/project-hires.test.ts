import type { HarnessSeatAdapter, SeatControl } from "@clankie/agent-hosts";
import type { SavedAgentSession } from "../src/agent-sessions.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectSchema, ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { OPERATOR_AGENT_ROLES, type SpawnOperatorSeat } from "@clankie/protocol";
import {
  ProjectHires,
  projectHireRequest,
  type ProjectHireProcessProof,
} from "../src/captain/project-hires.ts";
import {
  HerdrWatchStore,
  type HerdrAgentSnapshot,
  type HerdrWatchRunner,
} from "../src/captain/herdr-watch.ts";
import {
  localWorkspaceProject,
  selectHireProject,
  nativeHireProject,
} from "../src/captain/project-hire-context.ts";

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
  workingDirectory: dir,
  title: "Implement",
  role: "Engineer",
});
const proof: ProjectHireProcessProof = {
  nativeOccupantId: occupantIdForHerdrSession({ source: "claude", kind: "id", value: "s1" }),
  fleet: "default",
  pane: "p1",
  binding: { socketPath: "/tmp/test.sock", session: "desktop" },
  processes: [{ pid: 22, startTime: "today" }],
  shell: { pid: 11, startTime: "earlier" },
};
async function fixture(harness: "claude" | "codex" = "claude") {
  const root = await mkdtemp(join(tmpdir(), "project-hires-"));
  roots.push(root);
  const projectSettings = settings();
  projectSettings.projects[0]!.roles[0]!.harness = harness;
  if (harness === "codex") await writeFile(join(root, "auth.json"), "fixture presence only");
  const agent: HerdrAgentSnapshot = {
    paneId: "p1",
    terminalId: "t1",
    title: "Implement",
    agent: harness,
    status: "working",
    session: { source: harness, kind: "id", value: "s1" },
  };
  const processProof = { ...proof, nativeOccupantId: occupantIdForHerdrSession(agent.session!) };
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
    codexAccounts: async () => [{ label: "fixture", home: root }],
    projectHirePolicy: {
      settings: async () => projectSettings,
      tools: async () => ["linear_get_issue"],
      project: async (): Promise<string | undefined> => "game",
      proof: vi.fn(async (fleet: string, pane: string) =>
        fleet === "default" && pane === "p1" ? processProof : undefined,
      ),
    },
  };
  const store = new HerdrWatchStore(path, options);
  return { root, path, runner, projectSettings, store, options, agent, processProof };
}

describe("project hiring", () => {
  it("applies every role field, with explicit fields above role above fleet and nested inheritance", () => {
    const s = settings();
    Object.assign(s.projects[0]!.roles[0]!, {
      harness: "codex",
      model: "sol 6.1",
      effort: "xhigh",
      subagents: { model: "sol 6.1", effort: "medium" },
      delegation: "native-first",
      account: "second",
      placement: "new-tab",
    });
    const input = request("/repo");
    expect(
      projectHireRequest(s, "game", input, { model: "fleet-model", account: "default", placement: "split" }),
    ).toMatchObject({
      harness: "codex",
      model: "sol 6.1",
      effort: "xhigh",
      subagents: { model: "sol 6.1", effort: "medium" },
      delegation: "native-first",
      account: "second",
      placement: "new-tab",
    });
    expect(
      projectHireRequest(s, "game", {
        ...input,
        harness: "claude",
        model: "Opus",
        effort: "high",
        subagents: { effort: "low" },
        account: "default",
        placement: "split",
        delegation: "panes",
      }),
    ).toMatchObject({
      harness: "claude",
      model: "Opus",
      effort: "high",
      subagents: { model: "sol 6.1", effort: "low" },
      account: "default",
      placement: "split",
      delegation: "panes",
    });
    expect(
      projectHireRequest(s, "game", { ...input, harness: "claude", model: "Opus", subagents: null })
        .subagents,
    ).toBeUndefined();
  });
  it("requires a deliverable key and blocks another native-first pane across fleet/workspace and ledger instances", async () => {
    const f = await fixture();
    f.projectSettings.projects[0]!.workerCap = 10;
    Object.assign(f.projectSettings.projects[0]!.roles[0]!, {
      delegation: "native-first",
      concurrencyCap: 10,
    });
    const path = join(f.root, "native-first.json");
    const ledger = new ProjectHires(path);
    try {
      expect(() => ledger.reserve(f.projectSettings, "game", request(f.root))).toThrow(
        "stable deliverable key",
      );
      const input = { ...request(f.root), deliverable: "VUH-1596" };
      const first = ledger.reserve(f.projectSettings, "game", input);
      expect(ledger.reserve(f.projectSettings, "game", input)).toMatchObject({ id: first.id, reused: true });
      const other = new ProjectHires(path);
      expect(() =>
        other.reserve(f.projectSettings, "game", { ...input, workingDirectory: tmpdir(), fleet: "pc" }),
      ).toThrow("already has a pane under native-first");
      ledger.launch(first.id, f.projectSettings);
      ledger.pane(first.id, "p1");
      ledger.confirmed(first.id);
      expect(() => other.reserve(f.projectSettings, "game", input)).toThrow("native subagents");
      expect(other.reserve(f.projectSettings, "game", { ...input, deliverable: "VUH-other" }).id).not.toBe(
        first.id,
      );
    } finally {
      f.store.close();
    }
  });
  it("passes the complete inherited Codex profile to a new tab and its first native brief", async () => {
    const f = await fixture("codex");
    f.store.close();
    Object.assign(f.projectSettings.projects[0]!.roles[0]!, {
      model: "sol 6.1",
      effort: "xhigh",
      subagents: { model: "sol 6.1", effort: "medium" },
      delegation: "native-first",
      placement: "new-tab",
      account: "fixture",
    });
    f.runner.runInPane = vi.fn(async () => {});
    const start = vi.fn<HarnessSeatAdapter["start"]>(async (_launch, view) => {
      await view.start?.("codex", []);
      const ref = { harness: "codex" as const, paneId: "p1", sessionId: "s1" };
      await view.bound?.(ref);
      await view.guard?.();
      return { outcome: "started" as const, control: { ref } as SeatControl };
    });
    const store = new HerdrWatchStore(f.path, {
      ...f.options,
      resolveHireModel: async (_h, m) => (m === "sol 6.1" ? "gpt-6.1-sol" : m),
      seatAdapters: [{ harness: "codex", attach: async () => undefined, start }],
    });
    try {
      const result = await store.spawnSeat(
        { ...request(f.root), deliverable: "VUH-1596" },
        undefined,
        "Implement X",
      );
      expect(result).toMatchObject({
        outcome: "spawned",
        profile: {
          harness: "codex",
          model: "sol 6.1",
          subagents: { model: "sol 6.1", effort: "medium" },
          account: "fixture",
          placement: "new-tab",
          delegation: "native-first",
        },
      });
      expect(f.runner.createTab).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: await realpath(f.root),
          env: expect.objectContaining({ CODEX_HOME: f.root }),
        }),
      );
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gpt-6.1-sol",
          effort: "xhigh",
          brief: expect.stringContaining("model gpt-6.1-sol; effort medium"),
        }),
        expect.anything(),
      );
      expect(start.mock.calls[0]![0].brief).toContain("native-first");
    } finally {
      store.close();
    }
  });
  it("refuses unknown models and unsupported split placement before native effects", async () => {
    const f = await fixture();
    f.store.close();
    const store = new HerdrWatchStore(f.path, {
      ...f.options,
      resolveHireModel: async () => {
        throw new Error("unavailable or retired");
      },
    });
    try {
      expect(await store.spawnSeat(request(f.root))).toMatchObject({
        outcome: "failed",
        detail: expect.stringContaining("unavailable or retired"),
      });
      expect(f.runner.createTab).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
    const split = new HerdrWatchStore(f.path, f.options);
    try {
      expect(await split.spawnSeat({ ...request(f.root), placement: "split" })).toMatchObject({
        outcome: "failed",
        detail: expect.stringContaining("verified lead pane"),
      });
      expect(f.runner.createTab).not.toHaveBeenCalled();
    } finally {
      split.close();
    }
  });
  it("launches an explicit Opus override above a Codex role and fleet profile", async () => {
    const f = await fixture();
    f.store.close();
    Object.assign(f.projectSettings.projects[0]!.roles[0]!, {
      harness: "codex",
      model: "sol 6.1",
      effort: "xhigh",
      subagents: { model: "sol 6.1", effort: "medium" },
    });
    f.runner.runInPane = vi.fn(async () => {});
    const start = vi.fn<HarnessSeatAdapter["start"]>(async (_launch, view) => {
      await view.start?.("claude", []);
      const ref = { harness: "claude" as const, paneId: "p1", sessionId: "s1" };
      await view.bound?.(ref);
      await view.guard?.();
      return { outcome: "started" as const, control: { ref } as SeatControl };
    });
    const store = new HerdrWatchStore(f.path, {
      ...f.options,
      hireDefaults: async () => ({ model: "fleet-model", effort: "low" }),
      resolveHireModel: async (h, m) => {
        if (h !== "claude" || m !== "Opus") throw new Error("wrong override");
        return "claude-opus-5-5";
      },
      seatAdapters: [{ harness: "claude", attach: async () => undefined, start }],
    });
    try {
      expect(
        await store.spawnSeat(
          { ...request(f.root), harness: "claude", model: "Opus", effort: "high", subagents: null },
          undefined,
          "Use Opus for this one",
        ),
      ).toMatchObject({ outcome: "spawned", profile: { harness: "claude", model: "Opus", effort: "high" } });
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({ model: "claude-opus-5-5", effort: "high", brief: "Use Opus for this one" }),
        expect.anything(),
      );
    } finally {
      store.close();
    }
  });
  it("uses an explicitly verified lead for split placement and the registered Claude account home", async () => {
    const f = await fixture();
    f.store.close();
    const store = new HerdrWatchStore(f.path, {
      ...f.options,
      claudeAccounts: async () => [{ label: "second", home: f.root }],
      leadPane: async () => "pLead",
    });
    try {
      expect(
        await store.spawnSeat({ ...request(f.root), account: "second", placement: "split" }),
      ).toMatchObject({ outcome: "spawned", profile: { account: "second", placement: "split" } });
      expect(f.runner.createTab).toHaveBeenCalledWith(
        expect.objectContaining({
          besidePane: "pLead",
          env: expect.objectContaining({ CLAUDE_CONFIG_DIR: await realpath(f.root) }),
        }),
      );
    } finally {
      store.close();
    }
  });
  it("refuses a registered Claude profile whose directory disappeared without an account fallback", async () => {
    const f = await fixture();
    f.store.close();
    const store = new HerdrWatchStore(f.path, {
      ...f.options,
      claudeAccounts: async () => [{ label: "second", home: join(f.root, "gone") }],
    });
    try {
      expect(await store.spawnSeat({ ...request(f.root), account: "second" })).toMatchObject({
        outcome: "failed",
        reason: "harness_unavailable",
        detail: expect.stringContaining("profile home is unavailable"),
      });
      expect(f.runner.createTab).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });
  it.each(["same", "other"])(
    "hires into an existing workspace despite a missing %s project approval",
    async (scope) => {
      const f = await fixture();
      const path = await realpath(f.root);
      const stale = {
        id: "removed",
        machineId: "local",
        platform: "posix" as const,
        path: join(path, "removed"),
      };
      f.projectSettings.projects[0]!.workspaces = [
        { id: "repo", machineId: "local", platform: "posix", path },
      ];
      if (scope === "same") f.projectSettings.projects[0]!.workspaces.push(stale);
      else
        f.projectSettings.projects.push(
          ProjectSchema.parse({ id: "other", name: "Other", workspaces: [stale] }),
        );
      const original = structuredClone(f.projectSettings);
      f.options.projectHirePolicy.project = () => localWorkspaceProject(f.projectSettings, f.root);
      try {
        expect((await f.store.spawnSeat(request(f.root))).outcome).toBe("spawned");
        expect(f.runner.startAgent).toHaveBeenCalledOnce();
        expect(f.projectSettings).toEqual(original);
      } finally {
        f.store.close();
      }
    },
  );

  it("still refuses a missing hire destination and a changed approved path", async () => {
    const f = await fixture();
    try {
      const path = await realpath(f.root);
      const alias = join(path, "alias");
      await symlink(path, alias);
      f.projectSettings.projects[0]!.workspaces = [
        { id: "alias", machineId: "local", platform: "posix", path: alias },
      ];
      await expect(localWorkspaceProject(f.projectSettings, join(path, "missing"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(localWorkspaceProject(f.projectSettings, path)).rejects.toThrow(
        "workspace path has changed",
      );
    } finally {
      f.store.close();
    }
  });

  it.each(OPERATOR_AGENT_ROLES)(
    "inherits host launch choices for the built-in %s role when project roles are unset",
    async (role) => {
      const f = await fixture();
      f.projectSettings.projects[0]!.roles = [];
      const input = {
        ...request(f.root),
        harness: "claude" as const,
        role,
        model: "host-model",
        effort: "medium" as const,
      };
      try {
        expect((await f.store.spawnSeat(input)).outcome).toBe("spawned");
        expect(f.runner.startAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: "claude",
            args: expect.arrayContaining(["--model", "host-model", "--effort", "medium"]),
          }),
        );
        await expect(
          nativeHireProject(
            f.projectSettings,
            proof.nativeOccupantId,
            proof,
            () => f.store.projectHireAssignment("default", "p1", proof),
            undefined,
          ),
        ).resolves.toBe("game");
        expect(f.projectSettings.projects[0]!.roles).toEqual([]);
      } finally {
        f.store.close();
      }
    },
  );

  it("does not inherit custom roles or bypass an explicitly configured role list", async () => {
    const f = await fixture();
    const ledger = new ProjectHires(join(f.root, "ledger.json"));
    try {
      expect(() =>
        ledger.reserve(f.projectSettings, "game", { ...request(f.root), role: "builder" }),
      ).toThrow("has no builder role");
      f.projectSettings.projects[0]!.roles = [];
      expect(() => ledger.reserve(f.projectSettings, "game", request(f.root))).toThrow(
        "has no Engineer role",
      );
    } finally {
      f.store.close();
    }
  });

  it.each([
    "bound",
    "wrong-pane",
    "wrong-harness",
    "wrong-session",
    "replacement",
    "retarget",
    "missing-proof",
    "readiness-retarget",
    "readiness-role",
    "binding-grants",
    "readiness-grants",
    "readiness-account",
  ])(
    "records project assignment before the first brief only for a current bound native seat: %s",
    async (mode) => {
      const f = await fixture("codex");
      const proof = f.processProof;
      f.store.close();
      f.runner.runInPane = async () => {};
      const brief = vi.fn();
      let store: HerdrWatchStore;
      const ref = { harness: "codex" as const, paneId: "p1", sessionId: "s1" };
      const adapter: HarnessSeatAdapter = {
        harness: "codex",
        attach: async () => undefined,
        start: async (_launch, view) => {
          expect(view.expectedToolNames).toEqual(["linear_get_issue"]);
          await view.start?.("codex", []);
          const claimed = {
            ...ref,
            ...(mode === "wrong-pane" ? { paneId: "victim" } : {}),
            ...(mode === "wrong-harness" ? { harness: "claude" as const } : {}),
            ...(mode === "wrong-session" ? { sessionId: "victim" } : {}),
          };
          try {
            if (mode === "binding-grants")
              f.options.projectHirePolicy.tools = async () => ["linear_get_team"];
            const bound = await view.bound?.(claimed);
            expect(bound).toEqual({ expectedToolNames: ["linear_get_issue"] });
            expect(store.projectHireAssignment("default", "p1", proof)).toMatchObject({
              state: "assigned",
              projectId: "game",
            });
            if (mode === "readiness-retarget") f.options.projectHirePolicy.project = async () => "foreign";
            if (mode === "readiness-role") f.projectSettings.projects[0]!.roles[0]!.model = "changed";
            if (mode === "readiness-grants")
              f.options.projectHirePolicy.tools = async () => ["linear_get_team"];
            if (mode === "readiness-account")
              f.options.projectHirePolicy.tools = async () => {
                throw new Error("account changed");
              };
            await view.guard?.();
            brief();
            return { outcome: "started", control: { ref } as SeatControl };
          } catch (error) {
            return { outcome: "failed", reason: "not_ready", detail: String(error) };
          }
        },
      };
      if (mode === "missing-proof") f.options.projectHirePolicy.proof.mockResolvedValue(undefined);
      if (mode === "replacement")
        f.options.projectHirePolicy.proof.mockImplementation(async () => {
          vi.mocked(f.runner.get).mockResolvedValue({
            ...f.agent,
            session: { source: "codex", kind: "id", value: "replacement" },
          });
          return proof;
        });
      if (mode === "retarget")
        f.options.projectHirePolicy.proof.mockImplementation(async () => {
          f.options.projectHirePolicy.project = async () => "foreign";
          return proof;
        });
      store = new HerdrWatchStore(f.path, { ...f.options, seatAdapters: [adapter] });
      try {
        const result = await store.spawnSeat(request(f.root), undefined, "first brief");
        expect(result.outcome).toBe(mode === "bound" ? "spawned" : "failed");
        expect(brief).toHaveBeenCalledTimes(mode === "bound" ? 1 : 0);
      } finally {
        store.close();
      }
    },
  );

  it("inherits role harness, model and effort at the actual native launch", async () => {
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
    let secondSettled = false;
    const second = f.store.spawnSeat({ ...request(f.root), workingDirectory: tmpdir() }).then((result) => {
      secondSettled = true;
      return result;
    });
    try {
      await vi.waitFor(() =>
        expect(secondSettled || vi.mocked(f.runner.createTab!).mock.calls.length > 1).toBe(true),
      );
      expect(f.runner.createTab).toHaveBeenCalledOnce();
      expect(await second).toMatchObject({ outcome: "failed", detail: expect.stringContaining("allows 1") });
    } finally {
      release();
      await Promise.all([first, second]);
    }
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
    expect(await restarted.spawnSeat({ ...request(f.root), harness: "claude" })).toMatchObject({
      outcome: "failed",
    });
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
    expect(
      await nativeHireProject(
        settings(),
        proof.nativeOccupantId,
        proof,
        () => ({ state: "none" }),
        workspace,
      ),
    ).toBe("game");
    expect(workspace).toHaveBeenCalledWith(proof);
    workspace.mockClear();
    await expect(
      nativeHireProject(settings(), proof.nativeOccupantId, proof, () => ({ state: "invalid" }), workspace),
    ).rejects.toThrow("agent has changed");
    await expect(
      nativeHireProject(settings(), "old-session", proof, () => ({ state: "none" }), workspace),
    ).rejects.toThrow("agent has changed");
    expect(workspace).not.toHaveBeenCalled();
  });
  it("cannot repair an invalid native source role by requesting a different hire role", async () => {
    const workspace = vi.fn(async () => "game");
    await expect(
      nativeHireProject(
        settings(),
        proof.nativeOccupantId,
        proof,
        () => ({ state: "assigned", projectId: "game", role: "Removed", occupantId: "verified" }),
        workspace,
      ),
    ).rejects.toThrow("project or role has changed");
    expect(workspace).not.toHaveBeenCalled();
  });
  it("keeps deleted native projects invalid even after all projects are removed", async () => {
    const empty = ProjectsSettingsSchema.parse({});
    const workspace = vi.fn(async () => "game");
    await expect(
      nativeHireProject(
        empty,
        proof.nativeOccupantId,
        proof,
        () => ({ state: "assigned", projectId: "game", role: "Engineer", occupantId: "verified" }),
        workspace,
      ),
    ).rejects.toThrow("project or role has changed");
    await expect(
      nativeHireProject(empty, undefined, undefined, () => ({ state: "invalid" }), workspace),
    ).rejects.toThrow("agent has changed");
    expect(
      await nativeHireProject(empty, undefined, undefined, () => ({ state: "none" }), workspace),
    ).toBeUndefined();
    expect(workspace).not.toHaveBeenCalled();
  });
  it("does not release an allocation created after an empty inventory began", async () => {
    const f = await fixture();
    const ledger = new ProjectHires(join(f.root, "ledger.json"));
    const before = ledger.inventoryCandidates("default");
    const held = ledger.reserve(f.projectSettings, "game", request(f.root));
    ledger.launch(held.id, f.projectSettings);
    ledger.pane(held.id, "p1");
    ledger.reconcile("default", new Set(), new Set(), before);
    expect(() => ledger.reserve(f.projectSettings, "game", request(tmpdir()))).toThrow("allows 1");
    const next = ledger.inventoryCandidates("default");
    ledger.observe(held.id, "t1", proof.nativeOccupantId, proof);
    ledger.reconcile("default", new Set(), new Set(), next);
    expect(() => ledger.reserve(f.projectSettings, "game", request(tmpdir()))).toThrow("allows 1");
    ledger.reconcile("default", new Set(), new Set(), ledger.inventoryCandidates("default"));
    expect(ledger.reserve(f.projectSettings, "game", request(tmpdir())).id).not.toBe(held.id);
    f.store.close();
  });
  it("cannot select another project bucket from a project conversation", () => {
    expect(() => selectHireProject("game", "other", "other")).toThrow("different projects");
    expect(() => selectHireProject("game", undefined, "other")).toThrow("does not match");
    expect(selectHireProject("game", undefined)).toBe("game");
  });
});
