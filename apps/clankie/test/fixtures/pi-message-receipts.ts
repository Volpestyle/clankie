import { createPiWorkerController } from "../../src/captain/pi-worker-controller.ts";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SeatLaunch, SeatProcessIdentity, SeatView } from "@clankie/agent-hosts";
import { afterEach, vi } from "vitest";
import { createPiSeatAdapter } from "../../src/captain/pi-seat-adapter.ts";
import type { PiNativeCapability } from "../../src/captain/pi-native-capability.ts";
import { occupantIdForHerdrSession } from "../../src/captain/herdr-census.ts";
import { connectPiWorker } from "../../../../integrations/pi-plugin/worker-connection.mjs";
import { createPiWorkerRuntime } from "../../../../integrations/pi-plugin/worker-runtime.mjs";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
export async function piFixture(enabled?: () => Promise<boolean>) {
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
  let beforeSendPreparation: (() => Promise<void>) | undefined;
  let preparingSend = false;
  let beforeNativeClaim: (() => Promise<void>) | undefined;
  let beforeNativeClaimReply: (() => Promise<void>) | undefined;
  const root = {
    paneId: "w1:p1",
    terminalId: "terminal",
    process: proof.shell!,
    verifyAllocation: vi.fn(async () => {}),
    check: vi.fn(async () => {
      if (preparingSend && beforeSendPreparation) {
        const hook = beforeSendPreparation;
        beforeSendPreparation = undefined;
        await hook();
      }
      return true;
    }),
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
    controller: async (input) => {
      const controller = await createPiWorkerController(input);
      const request = controller.request.bind(controller);
      controller.request = async (...args) => {
        if (args[0] === "send") preparingSend = true;
        try {
          return await request(...args);
        } finally {
          if (args[0] === "send") preparingSend = false;
        }
      };
      return controller;
    },
    ...(enabled ? { enabled } : {}),
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
  let sendCommands = 0;
  const positiveReplies: string[] = [];
  const connect = (prepared: Pick<import("@clankie/agent-hosts").PreparedSeatLaunch, "env">) => {
    const connection = connectPiWorker(
      { port: Number(prepared.env?.CLANKIE_PI_WORKER_PORT), token: prepared.env!.CLANKIE_PI_WORKER_TOKEN! },
      (controller) => {
        const bridge = controller as {
          authorize(action: string): Promise<unknown>;
          claim(input: unknown): Promise<unknown>;
        };
        const authorize = bridge.authorize.bind(bridge);
        bridge.authorize = async (action: string) => {
          const result = await authorize(action);
          if (action === "send") positiveReplies.push("authorize");
          return result;
        };
        const claim = bridge.claim.bind(bridge);
        bridge.claim = async (input: unknown) => {
          if (beforeNativeClaimReply) {
            const hook = beforeNativeClaimReply;
            beforeNativeClaimReply = undefined;
            await hook();
          }
          const result = await claim(input);
          positiveReplies.push("claim");
          return result;
        };
        const runtime = createPiWorkerRuntime(pi, controller);
        const send = runtime.send.bind(runtime);
        runtime.send = (...args) => {
          sendCommands += 1;
          if (beforeNativeClaim) {
            beforeSendPreparation = beforeNativeClaim;
            beforeNativeClaim = undefined;
          }
          return send(...args);
        };
        return runtime;
      },
    );
    cleanup.push(() => connection.close());
    handlers.get("session_start")?.({ reason: "startup" }, context);
    return connection;
  };
  const prepare = async (input = launch) => {
    const prepared = await adapter.prepare!(input);
    cleanup.push(() => prepared.dispose());
    return { prepared, connection: connect(prepared) };
  };
  const finish = (text = "native final") => {
    entries.push({
      type: "message",
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
    });
    idle = true;
    handlers.get("agent_settled")?.({}, context);
  };
  return {
    sendCommands: () => sendCommands,
    positiveReplies: () => [...positiveReplies],
    beforeNativeClaimReply: (hook: () => Promise<void>) => {
      beforeNativeClaimReply = hook;
    },
    beforeNativeClaim: (hook: () => Promise<void>) => {
      beforeNativeClaim = hook;
    },
    beforeSendPreparation: (hook: () => Promise<void>) => {
      beforeSendPreparation = hook;
    },
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
    connect,
    sendMessage,
    context,
    finish,
  };
}
