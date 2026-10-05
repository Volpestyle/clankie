import { mkdtemp, rm } from "node:fs/promises";
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
  type PiSeatModel,
} from "../src/captain/herdr-watch.ts";
import { createPiSeatAdapter } from "../src/captain/pi-seat-adapter.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { HireLayoutUnconfirmed } from "../src/captain/hire-layout.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(piSeatModel?: () => Promise<PiSeatModel | undefined>) {
  const directory = await mkdtemp(join(tmpdir(), "pi-hire-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const sessionId = "10000000-0000-4000-8000-000000000001";
  const ref = { harness: "pi" as const, paneId: "w1:p1", sessionId };
  const agent: HerdrAgentSnapshot = {
    paneId: ref.paneId,
    terminalId: "terminal1",
    agent: "pi",
    title: "worker",
    status: "idle",
    session: { source: "herdr:pi", kind: "path", value: `/fixture/timestamp_${sessionId}.jsonl` },
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
            harness: "pi",
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
    installPiIntegration: vi.fn(async () => {}),
    configurePiProvider: vi.fn(async () => {}),
  } satisfies HerdrWatchRunner;
  const brief = vi.fn();
  const control = {
    ref,
    send: vi.fn(async () => ({
      outcome: "accepted" as const,
      messageId: "msg_fixture123",
      state: "queued" as const,
    })),
    status: vi.fn(async (): Promise<"idle" | "working"> => "idle"),
    settled: vi.fn(async () => new Promise<import("@clankie/agent-hosts").SeatEvent>(() => {})),
    interrupt: async () => true,
    close: vi.fn(async () => {}),
  } satisfies SeatControl;
  let store: HerdrWatchStore;
  const prepared = {
    command: ["/native/pi", directory],
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
    harness: "pi",
    prepare: vi.fn(async () => prepared),
    start: vi.fn(async () => {
      throw new Error("fallback forbidden");
    }),
    attach: vi.fn(async (expected) =>
      expected.sessionId === sessionId && expected.paneId === ref.paneId ? control : undefined,
    ),
  } satisfies HarnessSeatAdapter;
  const policy = {
    settings: async () => settings,
    project: vi.fn(async () => "game"),
    tools: vi.fn(async () => [] as string[]),
    proof: vi.fn(async () => undefined),
  };
  const path = join(directory, "watches.json");
  store = new HerdrWatchStore(path, {
    runner,
    seatAdapters: [adapter],
    projectHirePolicy: policy,
    ...(piSeatModel === undefined ? {} : { piSeatModel }),
  });
  cleanups.push(async () => store.close());
  const request = {
    schemaVersion: 1 as const,
    harness: "pi" as const,
    workingDirectory: directory,
    title: "worker",
    role: "Engineer",
    model: "fixture/native",
    effort: "high" as const,
  };
  return {
    directory,
    control,
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
    hire: () => store.spawnSeat(request, undefined, "first brief"),
  };
}

test("prepared Pi uses one initial argv and preserves first native process proof without owner installation", async () => {
  const f = await fixture();
  expect(await f.hire()).toMatchObject({ outcome: "spawned", control: { mode: "adapter" } });
  expect(f.runner.createTab).toHaveBeenCalledWith(expect.objectContaining({ command: f.prepared.command }));
  expect(f.runner.installPiIntegration).not.toHaveBeenCalled();
  expect(f.runner.configurePiProvider).not.toHaveBeenCalled();
  expect(f.runner.runInPane).not.toHaveBeenCalled();
  expect(f.runner.startAgent).not.toHaveBeenCalled();
  expect(f.policy.proof).not.toHaveBeenCalled();
  expect(f.brief).toHaveBeenCalledOnce();
  expect(f.store.projectHireAssignment("default", f.ref.paneId, f.proof)).toMatchObject({
    state: "assigned",
  });
  expect(
    f.store.projectHireAssignment("default", f.ref.paneId, {
      ...f.proof,
      processes: [{ pid: 44, startTime: "changed" }],
    }).state,
  ).not.toBe("assigned");
});

test("native Pi file path reattaches exact UUID for messaging and harvests into the same Discord origin", async () => {
  const f = await fixture();
  await f.hire();
  expect(await f.store.sendToSeat(f.agent.terminalId, "follow-up")).toBe(true);
  expect(f.control.send).toHaveBeenCalledOnce();
  const working = { ...f.agent, status: "working" };
  f.runner.get.mockResolvedValue(working);
  f.runner.resolveTerminal.mockResolvedValue(working);
  f.control.status.mockResolvedValue("working");
  const wake = vi.fn(async (_conversation: string, _prompt: string) => undefined);
  f.store.start(wake);
  let complete!: (event: import("@clankie/agent-hosts").SeatEvent) => void;
  f.control.settled.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  expect(
    await f.store.watch("discord:fixture-room", f.agent.terminalId, "harvest this native worker"),
  ).toMatchObject({ outcome: "watching" });
  complete({
    type: "turn_completed",
    at: "2026-10-04T00:00:00Z",
    ok: true,
    text: "Native Pi final report",
    stopReason: "stop",
  });
  await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce());
  expect(wake.mock.calls[0]![0]).toBe("discord:fixture-room");
  expect(wake.mock.calls[0]![1]).toContain(
    "<seat-final-message>\nNative Pi final report\n</seat-final-message>",
  );
  expect(f.adapter.attach).toHaveBeenCalledWith({
    harness: "pi",
    sessionId: f.ref.sessionId,
    paneId: f.ref.paneId,
  });
  expect(f.runner.wait).not.toHaveBeenCalled();
});

test("unconfirmed initial Pi allocation never falls back or creates a replacement worker", async () => {
  const f = await fixture();
  f.runner.createTab.mockRejectedValue(new HireLayoutUnconfirmed("allocation reply lost"));
  expect(await f.hire()).toMatchObject({ outcome: "failed", reason: "start_unconfirmed" });
  expect(f.runner.createTab).toHaveBeenCalledOnce();
  expect(f.prepared.dispose).toHaveBeenCalledOnce();
  expect(f.runner.startAgent).not.toHaveBeenCalled();
  expect(f.runner.runInPane).not.toHaveBeenCalled();
});

test("prepared Pi refuses physical close because Herdr cannot compare the original occupant atomically", async () => {
  const f = await fixture();
  await f.hire();
  expect(await f.store.closeSeat(f.agent.terminalId)).toBe(false);
  expect(f.runner.closePane).not.toHaveBeenCalled();
  expect(f.control.close).not.toHaveBeenCalled();
});

test.each(["controller-lost", "unknown", "ambiguous", "inventory-lost"])(
  "saved Pi resume after %s never creates a second native writer",
  async (mode) => {
    const f = await fixture();
    const saved = {
      ref: `local:${f.ref.sessionId}`,
      host: "local" as const,
      sessionId: f.ref.sessionId,
      workingDirectory: f.directory,
      file: { harness: "pi" as const, path: f.agent.session!.value, size: 1, mtimeMs: 1 },
    };
    if (mode === "controller-lost") f.adapter.attach.mockResolvedValue(undefined);
    if (mode === "unknown") f.runner.list.mockResolvedValue([{ ...f.agent, status: "unknown" }]);
    if (mode === "ambiguous")
      f.runner.list.mockResolvedValue([f.agent, { ...f.agent, paneId: "w1:p2", terminalId: "other" }]);
    if (mode === "inventory-lost") f.runner.list.mockRejectedValue(new Error("native inventory unavailable"));
    const cold = new HerdrWatchStore(join(f.directory, "cold.json"), {
      runner: f.runner,
      seatAdapters: [f.adapter],
    });
    try {
      expect(
        await cold.spawnSeat(
          { schemaVersion: 1, harness: "pi", title: "resume", workingDirectory: f.directory },
          undefined,
          "continue",
          saved,
        ),
      ).toMatchObject({ outcome: "failed" });
      expect(f.runner.createTab).not.toHaveBeenCalled();
      expect(f.prepared.start).not.toHaveBeenCalled();
      expect(f.runner.startAgent).not.toHaveBeenCalled();
      expect(f.runner.runInPane).not.toHaveBeenCalled();
    } finally {
      cold.close();
    }
  },
);

test("uncertain initial Pi brief cannot be recovered by an equal owner transcript after service loss", async () => {
  const f = await fixture();
  f.prepared.start.mockImplementation(async (view) => {
    await view.bound?.(f.ref);
    return { outcome: "failed", reason: "not_ready", detail: "brief_delivery_unverified" };
  });
  expect(await f.hire()).toMatchObject({ outcome: "failed" });
  f.store.close();
  const cold = new HerdrWatchStore(f.path, {
    runner: {
      ...f.runner,
      transcript: async () => ({
        sessionKey: f.ref.sessionId,
        entries: [{ type: "message", id: "late-owner", role: "operator", text: "first brief" }],
      }),
    },
    seatAdapters: [f.adapter],
    projectHirePolicy: f.policy,
  });
  try {
    expect(await cold.spawnSeat(f.request, undefined, "first brief")).toMatchObject({ outcome: "failed" });
    expect(f.runner.createTab).toHaveBeenCalledOnce();
    expect(f.prepared.start).toHaveBeenCalledOnce();
  } finally {
    cold.close();
  }
});

test.each([undefined, "automated brief"])(
  "unmanaged Pi launch preserves the no-brief boundary (%s)",
  async (brief) => {
    const f = await fixture();
    const store = new HerdrWatchStore(join(f.directory, "unmanaged.json"), { runner: f.runner });
    cleanups.push(async () => store.close());
    const result = await store.spawnSeat(
      { schemaVersion: 1, harness: "pi", title: "owner seat", workingDirectory: f.directory },
      undefined,
      brief,
    );
    if (brief === undefined) {
      expect(result).toMatchObject({ outcome: "spawned" });
      expect(f.runner.createTab).toHaveBeenCalledOnce();
      expect(f.runner.startAgent).toHaveBeenCalledOnce();
      expect(f.runner.installPiIntegration).toHaveBeenCalledOnce();
    } else {
      expect(result).toMatchObject({ outcome: "failed", reason: "harness_unavailable" });
      expect(f.runner.createTab).not.toHaveBeenCalled();
      expect(f.runner.startAgent).not.toHaveBeenCalled();
      expect(f.runner.installPiIntegration).not.toHaveBeenCalled();
    }
    expect(f.runner.runInPane).not.toHaveBeenCalled();
  },
);

test("registered prepared Pi without a brief refuses failed native discovery before allocation or legacy fallback", async () => {
  const f = await fixture();
  const discover = vi.fn(async () => {
    throw new Error("selected native binary unavailable");
  });
  const capture = vi.fn(async () => {
    throw new Error("capture forbidden");
  });
  const adapter = createPiSeatAdapter({
    repoRoot: f.directory,
    stateDir: f.directory,
    native: { createCommandTab: async () => "forbidden", capture },
    discover,
  });
  const store = new HerdrWatchStore(join(f.directory, "missing-native.json"), {
    runner: f.runner,
    seatAdapters: [adapter],
  });
  cleanups.push(async () => store.close());
  expect(
    await store.spawnSeat({
      schemaVersion: 1,
      harness: "pi",
      title: "prepared seat",
      workingDirectory: f.directory,
    }),
  ).toMatchObject({ outcome: "failed", reason: "harness_unavailable" });
  expect(discover).toHaveBeenCalledOnce();
  expect(capture).not.toHaveBeenCalled();
  expect(f.runner.createTab).not.toHaveBeenCalled();
  expect(f.runner.startAgent).not.toHaveBeenCalled();
  expect(f.runner.runInPane).not.toHaveBeenCalled();
  expect(f.runner.installPiIntegration).not.toHaveBeenCalled();
  expect(f.runner.configurePiProvider).not.toHaveBeenCalled();
});

test("prepared Pi keeps the hosted model selection through role validation without a second lookup", async () => {
  const lookup = vi.fn(async () => ({ model: "fixture/native" }));
  const f = await fixture(lookup);
  expect(await f.hire()).toMatchObject({ outcome: "spawned" });
  expect(lookup).toHaveBeenCalledOnce();
  expect(f.adapter.prepare).toHaveBeenCalledWith(expect.objectContaining({ model: "fixture/native" }));
});

test("prepared Pi refuses a hosted model that conflicts with the project's required model before allocation", async () => {
  const f = await fixture(async () => ({
    model: "clankie/default",
    provider: { id: "clankie", config: { apiKey: "synthetic-placeholder" } },
  }));
  expect(await f.hire()).toMatchObject({
    outcome: "failed",
    reason: "harness_unavailable",
    detail: "This role's required model is unavailable",
  });
  expect(f.adapter.prepare).not.toHaveBeenCalled();
  expect(f.runner.createTab).not.toHaveBeenCalled();
  expect(f.runner.startAgent).not.toHaveBeenCalled();
  expect(f.runner.runInPane).not.toHaveBeenCalled();
  expect(f.brief).not.toHaveBeenCalled();
});
