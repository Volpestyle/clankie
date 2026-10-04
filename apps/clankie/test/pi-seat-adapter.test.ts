import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SeatLaunch, SeatProcessIdentity, SeatView } from "@clankie/agent-hosts";
import { afterEach, expect, test, vi } from "vitest";
import { createPiSeatAdapter } from "../src/captain/pi-seat-adapter.ts";
import type { PiNativeCapability } from "../src/captain/pi-native-capability.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { connectPiWorker } from "../../../integrations/pi-plugin/worker-connection.mjs";
import { createPiWorkerRuntime } from "../../../integrations/pi-plugin/worker-runtime.mjs";
import { DeliveryFence } from "../src/captain/delivery-fence.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-seat-")));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const sessionId = randomUUID();
  const file = join(directory, `timestamp_${sessionId}.jsonl`);
  const session = { source: "herdr:pi" as const, kind: "path" as const, value: file };
  const proof: SeatProcessIdentity = {
    nativeOccupantId: occupantIdForHerdrSession(session),
    pane: "w1:p1",
    fleet: "default",
    binding: { socketPath: "/fixture/herdr.sock" },
    processes: [{ pid: 44, startTime: "123.123456" }],
    shell: { pid: 44, startTime: "123.123456" },
  };
  const root = {
    paneId: "w1:p1",
    terminalId: "terminal",
    check: vi.fn(async () => true),
    report: vi.fn(async () => {}),
    proof: vi.fn(async () => proof),
  };
  const native = { capture: vi.fn(async () => root), createCommandTab: vi.fn(async () => "w1:p1") };
  const capability: PiNativeCapability = {
    executable: process.execPath,
    cli: process.argv[1]!,
    sessionRoots: [directory],
    verify: vi.fn(async () => {}),
    verifySession: vi.fn(async () => {}),
  };
  const discover = vi.fn(async () => capability);
  const adapter = createPiSeatAdapter({
    repoRoot: directory,
    stateDir: directory,
    native,
    discover,
    timeoutMs: 100,
  });
  const view: SeatView = {
    paneId: "w1:p1",
    name: "worker",
    run: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    guard: vi.fn(async () => {}),
    bound: vi.fn(async () => {}),
  };
  const entries: any[] = [];
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let idle = true;
  const context = {
    mode: "tui",
    cwd: directory,
    model: { provider: "fixture", id: "native" },
    thinkingLevel: "high",
    isIdle: () => idle,
    isProjectTrusted: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => file,
      getSessionDir: () => directory,
      getHeader: () => ({ type: "session", version: 3, id: sessionId, cwd: directory }),
      getBranch: () => entries,
    },
  };
  const sendMessage = vi.fn((message: any) => {
    idle = false;
    handlers.get("message_start")?.({ message: { ...message, role: "custom" } }, context);
    entries.push({ type: "custom_message", ...message });
  });
  const pi = {
    on: (name: string, handler: (...args: any[]) => unknown) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    sendMessage,
  };
  const launch: SeatLaunch = {
    harness: "pi",
    cwd: directory,
    brief: "native brief",
    model: "fixture/native",
    effort: "high",
  };
  const prepare = async (input = launch) => {
    const prepared = await adapter.prepare!(input);
    cleanup.push(() => prepared.dispose());
    const connection = connectPiWorker(
      { port: Number(prepared.env?.CLANKIE_PI_WORKER_PORT), token: prepared.env!.CLANKIE_PI_WORKER_TOKEN! },
      (controller) => createPiWorkerRuntime(pi, controller),
    );
    cleanup.push(() => connection.close());
    handlers.get("session_start")?.({ reason: "startup" }, context);
    return { prepared, connection };
  };
  const finish = () => {
    entries.push({
      type: "message",
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "native final" }] },
    });
    idle = true;
    handlers.get("agent_settled")?.({}, context);
  };
  return {
    adapter,
    directory,
    sessionId,
    file,
    session,
    capability,
    discover,
    native,
    root,
    view,
    launch,
    prepare,
    sendMessage,
    context,
    finish,
  };
}

test("production adapter/control/extension bind exact native path before the one brief; no terminal fallback", async () => {
  const f = await fixture();
  const { prepared } = await f.prepare();
  expect(prepared.command).toEqual([
    process.execPath,
    process.argv[1],
    "--extension",
    join(f.directory, "integrations/pi-plugin/worker.mjs"),
    "--provider",
    "fixture",
    "--model",
    "native",
    "--thinking",
    "high",
  ]);
  const started = await prepared.start(f.view);
  expect(started.outcome).toBe("started");
  if (started.outcome !== "started") throw new Error("fixture failed");
  expect(f.view.bound).toHaveBeenCalledWith(started.control.ref);
  expect(f.root.report).toHaveBeenCalledWith(f.session, "idle");
  expect(f.root.proof).toHaveBeenCalledWith(f.session);
  expect(f.sendMessage).toHaveBeenCalledOnce();
  expect(f.view.run).not.toHaveBeenCalled();
  expect(f.view.start).not.toHaveBeenCalled();
  expect(await f.adapter.attach(started.control.ref)).toBe(started.control);
  f.finish();
  expect(await started.control.settled()).toEqual(
    expect.objectContaining({ type: "turn_completed", ok: true, text: "native final" }),
  );
  await started.control.close();
  expect(await f.adapter.attach(started.control.ref)).toBeUndefined();
  expect((await prepared.start(f.view)).outcome).toBe("failed");
});

test("lost native event retains durable uncertainty and never launches or resends twice", async () => {
  const f = await fixture();
  f.sendMessage.mockImplementation(() => {});
  const { prepared } = await f.prepare();
  const started = await prepared.start(f.view);
  expect(started.outcome).toBe("failed");
  expect(new DeliveryFence(join(f.directory, "pi-workers/receipts.json")).pending(f.sessionId)).toBeDefined();
  expect(f.sendMessage).toHaveBeenCalledOnce();
  expect((await prepared.start(f.view)).outcome).toBe("failed");
  await expect(f.adapter.prepare!({ ...f.launch, resumeSessionId: f.sessionId })).rejects.toThrow(
    "uncertain",
  );
  expect(f.native.capture).toHaveBeenCalledOnce();
});

test("held host admission then changed selected CLI refuses brief without replacing the pane", async () => {
  const f = await fixture();
  const { prepared } = await f.prepare();
  vi.mocked(f.view.bound!).mockImplementation(async () => {
    vi.mocked(f.capability.verify).mockRejectedValue(new Error("changed script"));
  });
  expect((await prepared.start(f.view)).outcome).toBe("failed");
  expect(f.sendMessage).not.toHaveBeenCalled();
  expect(f.view.run).not.toHaveBeenCalled();
  expect(f.native.capture).toHaveBeenCalledOnce();
});

test("exact saved resume selects the previously resolved path and retains UUID agreement", async () => {
  const f = await fixture();
  f.discover.mockResolvedValue({ ...f.capability, saved: { sessionId: f.sessionId, path: f.file } });
  const { prepared } = await f.prepare({ ...f.launch, resumeSessionId: f.sessionId });
  expect(prepared.command).toContain("--session");
  expect(prepared.command[prepared.command.indexOf("--session") + 1]).toBe(f.file);
  expect(prepared.command).not.toContain("--session-id");
  expect((await prepared.start(f.view)).outcome).toBe("started");
});

test("mismatched native model, mode, or exact session fails before brief", async () => {
  for (const mismatch of ["model", "mode", "session"]) {
    const f = await fixture();
    if (mismatch === "model") f.context.model.id = "different";
    if (mismatch === "mode") f.context.mode = "rpc";
    if (mismatch === "session") f.context.sessionManager.getSessionId = () => randomUUID();
    const { prepared } = await f.prepare();
    expect((await prepared.start(f.view)).outcome).toBe("failed");
    expect(f.sendMessage).not.toHaveBeenCalled();
  }
});

test("unsupported options fail before allocating a controller and old start entry never types", async () => {
  const f = await fixture();
  for (const options of [{ harnessArgs: ["--print"] }, { model: "guessed-alias" }, { effort: "unknown" }])
    await expect(f.adapter.prepare!({ ...f.launch, ...options })).rejects.toThrow();
  expect(f.discover).not.toHaveBeenCalled();
  expect((await f.adapter.start(f.launch, f.view)).outcome).toBe("failed");
  expect(f.view.run).not.toHaveBeenCalled();
});
