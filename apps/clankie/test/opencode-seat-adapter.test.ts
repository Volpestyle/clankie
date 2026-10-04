import { writeOpenCodeNativeSession } from "./helpers/opencode-native-db.ts";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SeatLaunch, SeatProcessIdentity, SeatView } from "@clankie/agent-hosts";
import { afterEach, expect, test, vi } from "vitest";
import { createOpenCodeSeatAdapter, probeOpenCodeVersion } from "../src/captain/opencode-seat-adapter.ts";
import { WebSocket } from "ws";
import { DeliveryFence } from "../src/captain/delivery-fence.ts";
import { createOpenCodeController } from "../src/captain/opencode-worker-controller.ts";
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
        if (method === "initialize") {
          const profiles = await readdir(join(directory, "opencode-workers", "profiles"));
          await writeOpenCodeNativeSession(
            join(directory, "opencode-workers", "profiles", profiles[0]!, "opencode.db"),
            directory,
            sessionId,
          );
          return { sessionId, version: "1.18.18" };
        }
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
  expect(await result.control.verify?.()).toEqual(f.proof);
  expect(await f.adapter.attach(f.ref)).toBe(result.control);
  await result.control.close();
  expect(f.controller.close).toHaveBeenCalledOnce();
  expect(await f.adapter.attach(f.ref)).toBeUndefined();
  expect(await readdir(join(f.directory, "opencode-workers"))).toEqual(["profiles"]);
  expect(
    JSON.parse(await readFile(join(prepared.env!.OPENCODE_DB!, "..", "source.json"), "utf8")),
  ).toMatchObject({ sessionId });
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

test("saved identity without original exit proof cannot create a duplicate native process", async () => {
  const f = await fixture();
  await expect(f.adapter.prepare!({ ...f.launch, resumeSessionId: "ses_savedOriginal123" })).rejects.toThrow(
    "exit is unproven",
  );
  expect(f.discovery).not.toHaveBeenCalled();
  expect(f.native.capture).not.toHaveBeenCalled();
  expect(f.controller.request).not.toHaveBeenCalled();
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
  expect(await started.control.send("cannot recover retired identity")).toMatchObject({ outcome: "offline" });
  expect(await f.adapter.attach(f.ref)).toBeUndefined();
  const next = await fixture();
  const live = await next.adapter.prepare!(next.launch);
  cleanups.push(() => live.dispose());
  const ready = await live.start(next.view);
  if (ready.outcome !== "started") throw new Error("fixture start");
  expect(await ready.control.send("accepted")).toMatchObject({
    outcome: "accepted",
    deliveryStage: "consumed",
  });
  expect(next.controller.acknowledge).toHaveBeenCalledOnce();
  next.uncertain();
  expect(await ready.control.send("never resent")).toMatchObject({
    outcome: "unconfirmed",
    messageId: "msg_originalUncertain",
  });
  expect(next.controller.request.mock.calls.filter(([method]) => method === "send")).toHaveLength(1);
});

test("passes the late peer guard to native dispatch and retains a known refusal", async () => {
  const f = await fixture();
  const prepared = await f.adapter.prepare!(f.launch);
  cleanups.push(() => prepared.dispose());
  const started = await prepared.start(f.view);
  if (started.outcome !== "started") throw new Error("fixture start");
  const beforeDispatch = vi.fn(async () => false);
  const originalRequest = f.controller.request.getMockImplementation()!;
  f.controller.request.mockImplementation(async (method, input) =>
    method === "send"
      ? { outcome: "unavailable", detail: "Peer authority revoked before dispatch" }
      : originalRequest(method, input),
  );
  expect(await started.control.send("peer work", { beforeDispatch, timeoutMs: 500 })).toMatchObject({
    outcome: "offline",
    deliveryStage: "unavailable",
  });
  expect(f.controller.request).toHaveBeenLastCalledWith(
    "send",
    expect.objectContaining({ text: "peer work" }),
    500,
    beforeDispatch,
  );
  expect(f.controller.acknowledge).not.toHaveBeenCalled();
  expect(f.controller.pending()).toBeUndefined();
});

test.each([false, true])(
  "version imports are isolated from all owner data/config and cleaned (failure=%s)",
  async (fails) => {
    let scratch = "";
    const run = vi.fn(
      async (_file: string, _args: readonly string[], options: { env: NodeJS.ProcessEnv; cwd: string }) => {
        scratch = options.cwd;
        expect(options.env.HOME).toBe(scratch);
        expect(options.env.OPENCODE_DB).toBe(join(scratch, "version.db"));
        expect(options.env.OPENCODE_CONFIG_CONTENT).toBe("{}");
        expect(options.env.OPENCODE_PURE).toBe("1");
        expect(Object.keys(options.env).sort()).toEqual(
          [
            "HOME",
            "OPENCODE_CONFIG_CONTENT",
            "OPENCODE_CONFIG_DIR",
            "OPENCODE_DB",
            "OPENCODE_PURE",
            "PATH",
            "TMPDIR",
            "XDG_CACHE_HOME",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "XDG_STATE_HOME",
          ].sort(),
        );
        if (fails) throw new Error("native import failed");
        return { stdout: "1.18.18\n" };
      },
    );
    if (fails)
      await expect(probeOpenCodeVersion("/selected/opencode", run)).rejects.toThrow(
        "isolated version check unavailable",
      );
    else expect(await probeOpenCodeVersion("/selected/opencode", run)).toBe("1.18.18");
    expect(run).toHaveBeenCalledOnce();
    await expect(readdir(scratch)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.each(["peer-loss", "proof-revoked"])(
  "successful adapter retirement on %s evicts exact control/config, closes listener and preserves native data/receipt",
  async (mode) => {
    const f = await fixture();
    let controller!: OpenCodeController;
    const adapter = createOpenCodeSeatAdapter({
      repoRoot: f.directory,
      stateDir: f.directory,
      native: f.native,
      discover: f.discovery,
      controller: async (options) => {
        controller = await createOpenCodeController(options);
        return controller;
      },
      timeoutMs: 1000,
    });
    const prepared = await adapter.prepare!(f.launch);
    cleanups.push(() => prepared.dispose());
    const peer = new WebSocket(controller.endpoint, ["clankie-native-worker", controller.token]);
    cleanups.push(async () => peer.terminate());
    const pending = new Map<string, () => void>();
    peer.on("message", (raw) => {
      void (async () => {
        const frame = JSON.parse(raw.toString());
        if (!frame.method) {
          pending.get(frame.id)?.();
          return;
        }
        let result: unknown = "idle";
        if (frame.method === "initialize") {
          await writeOpenCodeNativeSession(prepared.env!.OPENCODE_DB!, f.directory, sessionId);
          result = { sessionId, version: "1.18.18" };
        }
        if (frame.method === "send") {
          const id = "claim-callback";
          await new Promise<void>((resolve) => {
            pending.set(id, resolve);
            peer.send(JSON.stringify({ id, method: "claim", input: { sessionId, ...frame.input } }));
          });
          if (mode === "peer-loss") {
            peer.close();
            return;
          }
          f.root.check.mockResolvedValue(false);
          result = { outcome: "unconfirmed", messageId: frame.input.messageId, detail: "fixture revocation" };
        }
        peer.send(JSON.stringify({ id: frame.id, result }));
      })();
    });
    const started = await prepared.start(f.view);
    expect(started.outcome).toBe("started");
    if (started.outcome !== "started") throw new Error("fixture start");
    expect(await adapter.attach(f.ref)).toBe(started.control);
    const result = await started.control.send("original uncertain delivery");
    expect(result.outcome).toBe("unconfirmed");
    await vi.waitFor(async () => {
      await expect(readFile(prepared.env!.OPENCODE_TUI_CONFIG!)).rejects.toMatchObject({ code: "ENOENT" });
    });
    expect(await adapter.attach(f.ref)).toBeUndefined();
    await expect(fetch(controller.endpoint.replace("ws:", "http:"))).rejects.toThrow();
    const cold = new DeliveryFence(join(f.directory, "opencode-workers", "receipts.json"));
    expect(cold.pending(sessionId)).toMatchObject({ messageId: (result as { messageId: string }).messageId });
    expect(f.native.capture).toHaveBeenCalledOnce();
    expect(f.view.run).not.toHaveBeenCalled();
    expect(f.view.start).not.toHaveBeenCalled();
    await prepared.dispose();
    await prepared.dispose();
  },
);
