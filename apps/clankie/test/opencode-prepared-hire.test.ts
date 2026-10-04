import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HarnessSeatAdapter,
  PreparedSeatLaunch,
  SeatControl,
  SeatProcessIdentity,
  SeatStartResult,
  SeatView,
} from "@clankie/agent-hosts";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { afterEach, expect, test, vi } from "vitest";
import {
  HerdrWatchStore,
  type HerdrAgentSnapshot,
  type HerdrWatchRunner,
} from "../src/captain/herdr-watch.ts";
import type { SavedAgentSession } from "../src/agent-sessions.ts";
import { HireLayoutUnconfirmed } from "../src/captain/hire-layout.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "opencode-hire-")));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const sessionId = "ses_nativeWorker123";
  const ref = { harness: "opencode" as const, paneId: "w1:p1", sessionId };
  const agent: HerdrAgentSnapshot = {
    paneId: ref.paneId,
    terminalId: "terminal1",
    agent: "opencode",
    title: "worker",
    status: "idle",
    workingDirectory: directory,
    session: { source: "herdr:opencode", kind: "id", value: sessionId },
  };
  const proof: SeatProcessIdentity = {
    nativeOccupantId: occupantIdForHerdrSession(agent.session!),
    fleet: "default",
    pane: ref.paneId,
    binding: { socketPath: "/tmp/owned-herdr.sock", session: "test" },
    processes: [{ pid: 44, startTime: "123.456789" }],
    shell: { pid: 44, startTime: "123.456789" },
  };
  const settings = ProjectsSettingsSchema.parse({
    projects: [
      {
        id: "game",
        name: "Game",
        workerCap: 1,
        roles: [
          {
            role: "Engineer",
            harness: "opencode",
            model: "fixture/native",
            effort: "high",
            concurrencyCap: 1,
          },
        ],
      },
    ],
  });
  const runner = {
    createTab: vi.fn(async () => ref.paneId),
    startAgent: vi.fn(async () => {}),
    runInPane: vi.fn(async () => {}),
    get: vi.fn(async () => structuredClone(agent)),
    resolveTerminal: vi.fn(async () => structuredClone(agent)),
    wait: vi.fn(async () => structuredClone(agent)),
    list: vi.fn(async () => [structuredClone(agent)]),
    closePane: vi.fn(async () => {}),
  } satisfies HerdrWatchRunner;
  const brief = vi.fn();
  const control = {
    ref,
    verify: vi.fn(async () => structuredClone(proof)),
    send: vi.fn(async () => ({
      outcome: "accepted" as const,
      messageId: "msg_fixture123",
      state: "queued" as const,
    })),
    status: vi.fn(async () => "idle" as const),
    settled: async () => new Promise<never>(() => {}),
    interrupt: async () => true,
    close: vi.fn(async () => {}),
  } satisfies SeatControl;
  let store: HerdrWatchStore;
  const prepared = {
    command: ["/native/opencode", directory],
    env: { OPENCODE_TUI_CONFIG: "/private/launch/tui.json" },
    verify: vi.fn(async (_ref: Parameters<PreparedSeatLaunch["verify"]>[0]) => structuredClone(proof)),
    dispose: vi.fn(async () => {}),
    start: vi.fn(async (view: SeatView): Promise<SeatStartResult> => {
      await view.bound?.(ref);
      expect(store.projectHireAssignment("default", ref.paneId, proof)).toMatchObject({
        state: "assigned",
        projectId: "game",
      });
      await view.guard?.();
      brief();
      return { outcome: "started" as const, control };
    }),
  } satisfies PreparedSeatLaunch;
  const adapter = {
    harness: "opencode",
    prepare: vi.fn(async () => prepared),
    start: vi.fn(async () => {
      throw new Error("fallback forbidden");
    }),
    attach: vi.fn(async () => control),
  } satisfies HarnessSeatAdapter;
  const policy = {
    settings: async () => settings,
    project: vi.fn(async () => "game"),
    tools: vi.fn(async () => [] as string[]),
    proof: vi.fn(async () => undefined),
  };
  const path = join(directory, "watches.json");
  store = new HerdrWatchStore(path, { runner, seatAdapters: [adapter], projectHirePolicy: policy });
  cleanups.push(async () => store.close());
  const request = {
    schemaVersion: 1 as const,
    harness: "opencode" as const,
    workingDirectory: directory,
    title: "worker",
    role: "Engineer",
    model: "fixture/native",
    effort: "high" as const,
  };
  return {
    directory,
    path,
    agent,
    ref,
    proof,
    settings,
    runner,
    prepared,
    adapter,
    policy,
    store,
    request,
    brief,
    control,
    hire: () => store.spawnSeat(request, undefined, "first brief"),
  };
}

test("actual prepared hire preserves the first process proof without old tool resolver or terminal launch", async () => {
  const f = await fixture();
  expect(await f.hire()).toMatchObject({ outcome: "spawned", control: { mode: "adapter" } });
  expect(f.runner.createTab).toHaveBeenCalledWith(
    expect.objectContaining({ command: f.prepared.command, env: expect.objectContaining(f.prepared.env) }),
  );
  expect(f.prepared.verify).toHaveBeenCalled();
  expect(f.brief).toHaveBeenCalledOnce();
  expect(f.policy.proof).not.toHaveBeenCalled();
  expect(f.runner.startAgent).not.toHaveBeenCalled();
  expect(f.runner.runInPane).not.toHaveBeenCalled();
  expect(f.adapter.start).not.toHaveBeenCalled();
  expect(f.prepared.dispose).not.toHaveBeenCalled();
  expect(f.store.projectHireAssignment("default", f.ref.paneId, f.proof)).toMatchObject({
    state: "assigned",
  });
  const changed = { ...f.proof, processes: [{ pid: 44, startTime: "123.456790" }] };
  expect(f.store.projectHireAssignment("default", f.ref.paneId, changed).state).not.toBe("assigned");
  // A cold store has the persisted process, not a later metadata-only adoption.
  f.store.close();
  const restored = new HerdrWatchStore(f.path, { runner: f.runner, projectHirePolicy: f.policy });
  try {
    expect(restored.projectHireAssignment("default", f.ref.paneId, f.proof)).toMatchObject({
      state: "assigned",
    });
    expect(restored.projectHireAssignment("default", f.ref.paneId, changed).state).not.toBe("assigned");
  } finally {
    restored.close();
  }
});

test("local prepared hires carry the service's absolute discovery state through adapter and pane creation", async () => {
  const f = await fixture();
  vi.stubEnv("CLANKIE_STATE", " .local/private-service ");
  const expected = join(process.cwd(), ".local/private-service");
  expect(await f.hire()).toMatchObject({ outcome: "spawned" });
  expect(f.adapter.prepare).toHaveBeenCalledWith(
    expect.objectContaining({ env: expect.objectContaining({ CLANKIE_STATE: expected }) }),
  );
  expect(f.runner.createTab).toHaveBeenCalledWith(
    expect.objectContaining({ env: expect.objectContaining({ CLANKIE_STATE: expected }) }),
  );
});

test.each([
  "wrong-pane",
  "wrong-session",
  "wrong-harness",
  "foreign-proof",
  "changed-root",
  "changed-terminal",
  "project-retarget",
  "role-change",
])("%s during binding refuses first brief and retains uncertain allocation", async (mode) => {
  const f = await fixture();
  if (mode.startsWith("wrong-"))
    f.prepared.start.mockImplementation(async (view) => {
      await view.bound?.({
        ...f.ref,
        ...(mode === "wrong-pane" ? { paneId: "victim" } : {}),
        ...(mode === "wrong-session" ? { sessionId: "ses_otherSession123" } : {}),
        ...(mode === "wrong-harness" ? { harness: "claude" as const } : {}),
      });
      f.brief();
      return { outcome: "started", control: {} as SeatControl };
    });
  if (mode === "foreign-proof") f.prepared.verify.mockResolvedValue({ ...f.proof, pane: "victim" });
  if (mode === "changed-root")
    f.prepared.verify
      .mockResolvedValueOnce(f.proof)
      .mockResolvedValue({ ...f.proof, processes: [{ pid: 44, startTime: "123.456790" }] });
  if (mode === "changed-terminal")
    f.prepared.verify.mockImplementation(async () => {
      f.runner.get.mockResolvedValue({ ...f.agent, terminalId: "replacement" });
      return f.proof;
    });
  if (mode === "project-retarget")
    f.prepared.verify.mockImplementation(async () => {
      f.policy.project.mockResolvedValue("other");
      return f.proof;
    });
  if (mode === "role-change")
    f.prepared.verify.mockImplementation(async () => {
      f.settings.projects[0]!.roles[0]!.model = "fixture/replaced";
      return f.proof;
    });
  expect((await f.hire()).outcome).toBe("failed");
  expect(f.brief).not.toHaveBeenCalled();
  expect(f.prepared.dispose).toHaveBeenCalledOnce();
  expect(f.runner.closePane).not.toHaveBeenCalled();
  expect(f.runner.startAgent).not.toHaveBeenCalled();
  expect(f.runner.createTab).toHaveBeenCalledOnce();
  expect((await f.hire()).outcome).toBe("failed");
  expect(f.runner.createTab).toHaveBeenCalledOnce();
});

test("unknown argv allocation is not retried, nor treated as a safe prelaunch capacity release", async () => {
  const f = await fixture();
  f.runner.createTab.mockRejectedValue(new HireLayoutUnconfirmed("layout reply lost"));
  expect(await f.hire()).toMatchObject({ outcome: "failed", reason: "start_unconfirmed" });
  expect(f.prepared.start).not.toHaveBeenCalled();
  expect(f.prepared.dispose).toHaveBeenCalledOnce();
  expect(f.runner.closePane).not.toHaveBeenCalled();
  expect((await f.hire()).outcome).toBe("failed");
  expect(f.runner.createTab).toHaveBeenCalledOnce();
});

test("post-prepare project refusal disposes private state before any native pane", async () => {
  const f = await fixture();
  f.adapter.prepare.mockImplementation(async () => {
    f.policy.project.mockResolvedValue("other");
    return f.prepared;
  });
  expect((await f.hire()).outcome).toBe("failed");
  expect(f.prepared.dispose).toHaveBeenCalledOnce();
  expect(f.runner.createTab).not.toHaveBeenCalled();
  expect(f.prepared.start).not.toHaveBeenCalled();
});

test("physical close is unavailable without native conditional ownership; original pane/control stay intact", async () => {
  const f = await fixture();
  await f.hire();
  expect(await f.store.closeSeat(f.agent.terminalId)).toBe(false);
  expect(f.runner.closePane).not.toHaveBeenCalled();
  expect(f.prepared.dispose).not.toHaveBeenCalled();
});

test.each(["same", "replacement", "no-control", "moved"])(
  "prepared close denial survives restart and %s without owning the new occupant",
  async (mode) => {
    const f = await fixture();
    await f.hire();
    f.store.close();
    const current = {
      ...f.agent,
      ...(mode === "replacement" ? { agent: "claude", terminalId: "new-terminal" } : {}),
      ...(mode === "moved" ? { paneId: "w2:p4" } : {}),
    };
    f.runner.resolveTerminal.mockResolvedValue(current);
    const restored = new HerdrWatchStore(f.path, {
      runner: f.runner,
      ...(mode === "no-control" ? {} : { seatAdapters: [f.adapter] }),
    });
    try {
      expect(await restored.closeSeat(f.agent.terminalId)).toBe(false);
      expect(f.runner.closePane).not.toHaveBeenCalled();
      expect(f.prepared.dispose).not.toHaveBeenCalled();
    } finally {
      restored.close();
    }
  },
);

test("legacy unmanaged OpenCode retains existing explicit close behavior", async () => {
  const f = await fixture(); // No prepared allocation was made.
  expect(await f.store.closeSeat(f.agent.terminalId)).toBe(true);
  expect(f.runner.closePane).toHaveBeenCalledWith(f.agent.paneId);
});

function savedNative(f: Awaited<ReturnType<typeof fixture>>): SavedAgentSession {
  return {
    ref: `local:${f.ref.sessionId}`,
    host: "local",
    sessionId: f.ref.sessionId,
    workingDirectory: f.directory,
    source: {
      kind: "opencode-sqlite",
      machineId: "local",
      profileId: "owned-native",
      database: `${f.directory}/opencode.db`,
      databaseIdentity: "1:2",
      sessionId: f.ref.sessionId,
      version: "1.18.18",
      workingDirectory: f.directory,
    },
  };
}

test.each([undefined, "follow-up"])(
  "prepared resume preserves original project proof, brief %s",
  async (brief) => {
    const f = await fixture();
    expect(await f.hire()).toMatchObject({ outcome: "spawned" });
    expect(
      await f.store.spawnSeat({ ...f.request, resume: savedNative(f).ref }, undefined, brief, savedNative(f)),
    ).toMatchObject({ outcome: "spawned" });
    expect(f.runner.createTab).toHaveBeenCalledOnce();
    expect(f.prepared.start).toHaveBeenCalledOnce();
    expect(f.control.verify).toHaveBeenCalled();
    expect(f.policy.proof).not.toHaveBeenCalled();
    expect(f.store.projectHireAssignment("default", f.ref.paneId, f.proof)).toMatchObject({
      state: "assigned",
    });
  },
);

test.each([undefined, "follow-up"])(
  "held resume project await cannot adopt a replacement root, brief %s",
  async (brief) => {
    const f = await fixture();
    expect(await f.hire()).toMatchObject({ outcome: "spawned" });
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = {
      promise: new Promise<void>((resolve) => {
        enteredResolve = resolve;
      }),
      resolve: () => enteredResolve(),
    };
    const release = {
      promise: new Promise<void>((resolve) => {
        releaseResolve = resolve;
      }),
      resolve: () => releaseResolve(),
    };
    let calls = 0;
    f.policy.project.mockImplementation(async () => {
      if (++calls === 2) {
        entered.resolve();
        await release.promise;
      }
      return "game";
    });
    const pending = f.store.spawnSeat(
      { ...f.request, resume: savedNative(f).ref },
      undefined,
      brief,
      savedNative(f),
    );
    await entered.promise;
    expect(f.control.verify).toHaveBeenCalled();
    const original = structuredClone(f.proof);
    Object.assign(f.proof, {
      shell: { pid: 44, startTime: "123.456790" },
      processes: [{ pid: 44, startTime: "123.456790" }],
    });
    release.resolve();
    expect(await pending).toMatchObject({ outcome: "failed", reason: "not_ready" });
    expect(f.control.send).not.toHaveBeenCalled();
    expect(f.runner.createTab).toHaveBeenCalledOnce();
    expect(f.store.projectHireAssignment("default", f.ref.paneId, original)).toMatchObject({
      state: "assigned",
    });
    expect(f.store.projectHireAssignment("default", f.ref.paneId, f.proof).state).not.toBe("assigned");
  },
);
