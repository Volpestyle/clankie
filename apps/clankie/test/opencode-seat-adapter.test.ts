import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SeatLaunch, SeatProcessIdentity, SeatView } from "@clankie/agent-hosts";
import { afterEach, expect, test, vi } from "vitest";
import { createOpenCodeSeatAdapter } from "../src/captain/opencode-seat-adapter.ts";
import type { OpenCodeController } from "../src/captain/opencode-worker-controller.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const sessionId = "ses_nativeWorker123";

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "opencode-seat-")));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const ref = { harness: "opencode" as const, paneId: "w1:p1", sessionId };
  const proof: SeatProcessIdentity = {
    nativeOccupantId: occupantIdForHerdrSession({ source: "herdr:opencode", kind: "id", value: sessionId }),
    pane: ref.paneId,
    fleet: "default",
    binding: { socketPath: "/tmp/owned-herdr.sock", session: "fixture" },
    processes: [{ pid: 12, startTime: "123.456789" }],
    shell: { pid: 12, startTime: "123.456789" },
  };
  const root = {
    paneId: ref.paneId,
    terminalId: "terminal1",
    check: vi.fn(async () => true),
    proof: vi.fn(async () => structuredClone(proof)),
    report: vi.fn(async () => {}),
  };
  let pending: { messageId: string } | undefined;
  const controller = {
    endpoint: "ws://127.0.0.1:12345/worker",
    token: "a".repeat(64),
    bind: vi.fn(),
    select: vi.fn(),
    pending: () => pending,
    request: vi.fn(
      async (method: Parameters<OpenCodeController["request"]>[0], input?: unknown): Promise<unknown> => {
        if (method === "initialize") return { sessionId, version: "1.18.18" };
        if (method === "send")
          return {
            outcome: "accepted",
            messageId: (input as { messageId: string }).messageId,
            state: "queued",
          };
        if (method === "interrupt") return true;
        return "idle";
      },
    ),
    acknowledge: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  } satisfies OpenCodeController;
  const native = { capture: vi.fn(async () => root), createCommandTab: vi.fn(async () => ref.paneId) };
  const discovery = vi.fn(async () => ({ executable: "/native/opencode", version: "1.18.18" }));
  const adapter = createOpenCodeSeatAdapter({
    repoRoot: directory,
    stateDir: directory,
    native,
    discover: discovery,
    controller: async () => controller,
    timeoutMs: 20,
  });
  const launch: SeatLaunch = { harness: "opencode", cwd: directory, brief: "" };
  const view: SeatView = {
    paneId: ref.paneId,
    name: "worker",
    run: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    guard: vi.fn(async () => {}),
    bound: vi.fn(async () => {}),
  };
  return {
    directory,
    ref,
    proof,
    root,
    controller,
    native,
    discovery,
    adapter,
    launch,
    view,
    uncertain: () => {
      pending = { messageId: "msg_originalUncertain" };
    },
  };
}

test("prepared initial argv owns one controller, preserves native config, and transfers successful lifetime", async () => {
  const f = await fixture();
  const prepared = await f.adapter.prepare!({
    ...f.launch,
    model: "fixture/model",
    effort: "high",
    env: {
      FIXTURE_ACCOUNT: "preserved",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { bash: "ask" }, plugin: ["owner-plugin"] }),
    },
  });
  cleanups.push(() => prepared.dispose());
  expect(prepared.command).toEqual(["/native/opencode", f.directory, "--model", "fixture/model"]);
  expect(prepared.env).toMatchObject({ FIXTURE_ACCOUNT: "preserved" });
  expect(JSON.parse(prepared.env!.OPENCODE_CONFIG_CONTENT!)).toMatchObject({
    permission: { bash: "ask" },
    plugin: ["owner-plugin", expect.stringContaining("worker-server.mjs")],
  });
  const tui = JSON.parse(await readFile(prepared.env!.OPENCODE_TUI_CONFIG!, "utf8"));
  expect(tui.plugin[0][1]).toEqual({ endpoint: f.controller.endpoint, token: f.controller.token });
  const result = await prepared.start(f.view);
  expect(result.outcome).toBe("started");
  expect(f.native.capture).toHaveBeenCalledWith(f.ref.paneId, "/native/opencode", f.directory);
  expect(f.view.run).not.toHaveBeenCalled();
  expect(f.view.start).not.toHaveBeenCalled();
  expect(f.controller.close).not.toHaveBeenCalled();
  expect(await prepared.verify(f.ref)).toEqual(f.proof);
  expect((await prepared.start(f.view)).outcome).toBe("failed");
  expect(f.native.capture).toHaveBeenCalledTimes(1);
  if (result.outcome !== "started") throw new Error("fixture start");
  expect(await f.adapter.attach(f.ref)).toBe(result.control);
  await result.control.close();
  expect(f.controller.close).toHaveBeenCalledOnce();
  expect(await f.adapter.attach(f.ref)).toBeUndefined();
  expect(await readdir(join(f.directory, "opencode-workers"))).toEqual([]);
});

test.each(["wrong-version", "model", "variant", "resume", "extra-args", "bad-config"])(
  "unsupported %s fails before any native allocation",
  async (mode) => {
    const f = await fixture();
    if (mode === "wrong-version")
      f.discovery.mockResolvedValue({ executable: "/native/opencode", version: "1.19.0" });
    const launch = {
      ...f.launch,
      ...(mode === "model" ? { model: "no-provider" } : {}),
      ...(mode === "variant" ? { effort: "high" } : {}),
      ...(mode === "resume" ? { resumeSessionId: "bad-id" } : {}),
      ...(mode === "extra-args" ? { harnessArgs: ["--continue"] } : {}),
      ...(mode === "bad-config" ? { env: { OPENCODE_CONFIG_CONTENT: "[invalid" } } : {}),
    };
    await expect(f.adapter.prepare!(launch)).rejects.toThrow();
    expect(f.native.capture).not.toHaveBeenCalled();
    if (mode === "bad-config") expect(f.controller.close).toHaveBeenCalledOnce();
  },
);

test("aborted preparation and refused allocation guard dispose only this private controller/config", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const prepared = await f.adapter.prepare!(f.launch, abort.signal);
  abort.abort();
  await vi.waitFor(() => expect(f.controller.close).toHaveBeenCalledOnce());
  await prepared.dispose();
  expect((await prepared.start(f.view)).outcome).toBe("failed");
  expect(f.native.capture).not.toHaveBeenCalled();
  const other = await fixture();
  const refused = await other.adapter.prepare!(other.launch);
  vi.mocked(other.view.guard!).mockRejectedValue(new Error("role changed"));
  expect((await refused.start(other.view)).outcome).toBe("failed");
  expect(other.native.capture).not.toHaveBeenCalled();
  expect(other.controller.close).toHaveBeenCalledOnce();
});

test("exact resume argv and returned native identity must agree, without starting any fallback", async () => {
  const f = await fixture();
  const prepared = await f.adapter.prepare!({ ...f.launch, resumeSessionId: "ses_savedOriginal123" });
  expect(prepared.command).toEqual(["/native/opencode", f.directory, "--session", "ses_savedOriginal123"]);
  expect((await prepared.start(f.view)).outcome).toBe("failed");
  expect(f.view.bound).not.toHaveBeenCalled();
  expect(f.root.report).not.toHaveBeenCalled();
  expect(f.controller.close).toHaveBeenCalledOnce();
});

test("bound callback precedes first brief; substituted ref and changed held process cannot submit", async () => {
  const f = await fixture();
  const prepared = await f.adapter.prepare!({ ...f.launch, brief: "first brief" });
  cleanups.push(() => prepared.dispose());
  vi.mocked(f.view.bound!).mockImplementation(async (ref) => {
    expect(await prepared.verify(ref)).toEqual(f.proof);
    await expect(prepared.verify({ ...ref, paneId: "victim" })).rejects.toThrow();
    expect(f.controller.request.mock.calls.some(([method]) => method === "send")).toBe(false);
    f.root.proof.mockRejectedValue(new Error("birth changed"));
  });
  expect((await prepared.start(f.view)).outcome).toBe("failed");
  expect(f.controller.request.mock.calls.some(([method]) => method === "send")).toBe(false);
  expect(f.controller.close).toHaveBeenCalledOnce();
});

test("unavailable before dispatch is not falsely uncertain; accepted delivery requires final proof and ack", async () => {
  const f = await fixture();
  const prepared = await f.adapter.prepare!(f.launch);
  cleanups.push(() => prepared.dispose());
  const started = await prepared.start(f.view);
  if (started.outcome !== "started") throw new Error("fixture start");
  f.root.proof.mockRejectedValueOnce(new Error("root exited"));
  expect(await started.control.send("no dispatch")).toMatchObject({
    outcome: "offline",
    deliveryStage: "unavailable",
  });
  expect(f.controller.request.mock.calls.some(([method]) => method === "send")).toBe(false);
  expect(await started.control.send("accepted")).toMatchObject({
    outcome: "accepted",
    deliveryStage: "consumed",
  });
  expect(f.controller.acknowledge).toHaveBeenCalledOnce();
  f.uncertain();
  expect(await started.control.send("never resent")).toMatchObject({
    outcome: "unconfirmed",
    messageId: "msg_originalUncertain",
  });
  expect(f.controller.request.mock.calls.filter(([method]) => method === "send")).toHaveLength(1);
});
