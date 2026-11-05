// @ts-expect-error Native OpenCode plugins are standalone ESM.
import { createOpenCode2WorkerRuntime } from "../../../../integrations/opencode-plugin/v2/worker-runtime.mjs";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach } from "vitest";
import { createOpenCodeSeatAdapter } from "../../src/captain/opencode-seat-adapter.ts";
import { occupantIdForHerdrSession } from "../../src/captain/herdr-census.ts";
import { writeOpenCodeNativeSession } from "../helpers/opencode-native-db.ts";
import type { OpenCodeController } from "../../src/captain/opencode-worker-controller.ts";
import { createOpenCodeController } from "../../src/captain/opencode-worker-controller.ts";
// @ts-expect-error Native OpenCode plugins are standalone ESM.
import { createOpenCodeWorkerRuntime } from "../../../../integrations/opencode-plugin/worker-runtime.mjs";

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Real controller, WebSocket protocol and production native runtime; SDK effects are fixture counters. */
export async function openCodeReceiptFixture(version: 1 | 2 = 1) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "receipt-opencode-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  let controller!: OpenCodeController;
  const sessionId = "ses_receiptNative123";
  let admitted = 0;
  let phase = "stable",
    before = async () => {};
  let proofHook: (() => Promise<void>) | undefined;
  const positive: string[] = [];
  const proof = {
    nativeOccupantId: occupantIdForHerdrSession({ source: "herdr:opencode", kind: "id", value: sessionId }),
    pane: "fixture-pane",
    fleet: "default",
    binding: { socketPath: join(root, "herdr.sock") },
    processes: [{ pid: process.pid, startTime: "1" }],
    shell: { pid: process.pid, startTime: "1" },
  };
  const adapter = createOpenCodeSeatAdapter({
    repoRoot: process.cwd(),
    stateDir: root,
    native: {
      capture: async () => ({
        paneId: "fixture-pane",
        terminalId: "fixture-seat",
        process: proof.shell,
        verifyAllocation: async () => {},
        check: async () => {
          await proofHook?.();
          return true;
        },
        proof: async () => proof,
        report: async () => {},
      }),
      createCommandTab: async () => "fixture-pane",
    },
    discover: async () => ({ executable: process.execPath, version: version === 1 ? "1.18.18" : "2.2.5" }),
    controller: async (input) => {
      controller = await createOpenCodeController(input);
      return controller;
    },
    timeoutMs: 2000,
  });
  const prepared = await adapter.prepare!({
    harness: "opencode",
    cwd: root,
    brief: "",
    env: { OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_CLI_CONFIG_CONTENT: "{}", OPENCODE_TUI_CONFIG: "" },
  });
  cleanup.push(() => prepared.dispose());
  const starting = prepared.start({ paneId: "fixture-pane", name: "fixture", run: async () => {} });

  const peer = new WebSocket(controller.endpoint, ["clankie-native-worker", controller.token]);
  const queued: import("ws").RawData[] = [];
  let onMessage = (raw: import("ws").RawData) => {
    queued.push(raw);
  };
  peer.on("message", (raw) => onMessage(raw));
  cleanup.push(() => peer.terminate());
  await once(peer, "open");
  let nativeError = "";
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const callback = async (method: string, input: unknown) => {
    if ((method === "authorize" && (input as { action: string }).action === "send") || method === "claim") {
      if (method === phase) await before();
      if (phase === method + "-proof") {
        // The first current() brackets parsing. Revoke in the final current(),
        // after the host has selected this send's retained admission witness.
        let reads = 0;
        proofHook = async () => {
          if (++reads === 3) {
            proofHook = undefined;
            await before();
          }
        };
      }
    }
    const id = randomUUID();
    const result = await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      peer.send(JSON.stringify({ id, method, input }));
    });
    if ((method === "authorize" && (input as { action: string }).action === "send") || method === "claim")
      positive.push(method);
    return result;
  };
  const bridge = {
    connected: () => peer.readyState === WebSocket.OPEN,
    watchRoute: (observe: () => void) => {
      observe();
      return () => {};
    },
    authorize: (action: string) => callback("authorize", { action }),
    claim: (claim: unknown) => callback("claim", claim),
    receipt: (receipt: unknown) => callback("receipt", receipt),
  };
  let route: { type: string; sessionID?: string } = { type: "home" };
  let routeV1: { name: string; params?: { sessionID: string } } = { name: "home" };
  const runtime =
    version === 2
      ? createOpenCode2WorkerRuntime(
          {
            app: { version: "2.2.5" },
            ui: {
              router: {
                current: () => route,
                navigate: (next: typeof route) => {
                  route = next;
                },
              },
            },
            client: {
              mcp: { list: async () => [{ name: "clankie" }] },
              session: {
                create: async () => ({ id: sessionId }),
                get: async () => ({ id: sessionId, location: { directory: root } }),
                active: async () => ({}),
                form: { list: async () => [] },
                prompt: async (input: { id: string; sessionID: string; delivery: string }) => {
                  admitted++;
                  return input;
                },
              },
              permission: { list: async () => [] },
            },
          },
          bridge,
        )
      : createOpenCodeWorkerRuntime(
          {
            app: { version: "1.18.18" },
            lifecycle: { signal: new AbortController().signal },
            route: {
              get current() {
                return routeV1;
              },
              navigate: (name: string, params: { sessionID: string }) => {
                routeV1 = { name, params };
              },
            },
            state: {
              ready: true,
              config: {
                mcp: { clankie: { type: "local", command: ["clankie", "mcp", "--fleet"], enabled: true } },
              },
              session: { status: () => ({ type: "idle" }), permission: () => [], question: () => [] },
            },
            client: {
              session: {
                create: async () => ({ data: { id: sessionId } }),
                get: async () => ({ data: { id: sessionId, directory: root } }),
                status: async () => ({ data: {} }),
                promptAsync: async () => {
                  admitted++;
                  return { response: { status: 204 } };
                },
              },
              permission: { list: async () => ({ data: [] }) },
              question: { list: async () => ({ data: [] }) },
            },
          },
          bridge,
        );
  cleanup.push(() => runtime.close());
  onMessage = (raw) => {
    void (async () => {
      const frame = JSON.parse(raw.toString());
      if (!frame.method) {
        const waiter = pending.get(frame.id);
        pending.delete(frame.id);
        if (frame.error) waiter?.reject(new Error(frame.error));
        else waiter?.resolve(frame.result);
        return;
      }
      try {
        const method = frame.method as "initialize" | "status" | "send";
        const result = await runtime[method](frame.input);
        if (method === "initialize" && version === 1)
          await writeOpenCodeNativeSession(prepared.env!.OPENCODE_DB!, root, sessionId);
        if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ id: frame.id, result }));
      } catch (error) {
        nativeError = String(error);
        if (peer.readyState === WebSocket.OPEN)
          peer.send(JSON.stringify({ id: frame.id, error: "Native fixture refusal" }));
      }
    })();
  };
  for (const raw of queued.splice(0)) onMessage(raw);
  const started = await starting;
  if (started.outcome !== "started") throw new Error(JSON.stringify({ started, nativeError }));
  const control = started.control;

  return {
    control,
    admitted: () => admitted,
    positiveReplies: () => positive,
    pauseAt: (at: string, hook: () => Promise<void>) => {
      phase = at;
      before = hook;
    },
  };
}
