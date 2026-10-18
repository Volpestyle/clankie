import { readFile, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { createOpenCodeController } from "../src/captain/opencode-worker-controller.ts";

// Exercise the actual loader/protocol against a mock native API, not a native
// OpenCode invocation. Only host-provided Solid is replaced; its real batching
// compatibility remains an explicit live-acceptance boundary.
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function workerTui() {
  const directory = await mkdtemp(join(tmpdir(), "opencode-tui-fixture-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const controller = await createOpenCodeController({
    receiptsPath: join(directory, "receipts.json"),
    timeoutMs: 1000,
  });
  cleanups.push(() => controller.close());
  controller.bind(
    async () => true,
    async () => {},
  );
  const moduleUrl = new URL("../../../integrations/opencode-plugin/worker-tui.mjs", import.meta.url);
  const runtimeUrl = new URL("./worker-runtime.mjs", moduleUrl).href;
  const source = (await readFile(fileURLToPath(moduleUrl), "utf8"))
    .replace(
      'import { createComputed, createRoot } from "solid-js";',
      "const createComputed = (fn) => fn(); const createRoot = (fn) => fn(() => {});",
    )
    .replace('from "./worker-runtime.mjs"', `from ${JSON.stringify(runtimeUrl)}`);
  // A temporary module keeps Node's normal relative runtime loading intact.
  const { writeFile } = await import("node:fs/promises");
  const loader = join(directory, "worker-tui.mjs");
  await writeFile(loader, source);
  // Match the pinned host's readV1Plugin contract, rather than bypassing its
  // loader with the module's named exports.
  const module = (await import(pathToFileURL(loader).href)) as {
    default: { id: string; tui(api: unknown, options: unknown): Promise<void> };
  };
  expect(module.default.id).toBe("clankie-native-worker");
  return { directory, controller, tui: module.default.tui };
}

test("awaited first TUI plugin initialization binds before prompt mounting, then sends via its native SDK", async () => {
  const { directory, controller, tui } = await workerTui();
  const sessionId = "ses_nativeWorker123";
  let mounted = false;
  let route: { name: string; params?: { sessionID: string } } = { name: "home" };
  let dispose = () => {};
  const events = new Map<string, Set<(event: unknown) => void>>();
  const api = {
    app: { version: "1.18.18" },
    event: {
      on: (type: string, handler: (event: unknown) => void) => {
        const listeners = events.get(type) ?? new Set();
        listeners.add(handler);
        events.set(type, listeners);
        return () => listeners.delete(handler);
      },
    },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose(fn: () => void) {
        dispose = fn;
      },
    },
    route: {
      get current() {
        return route;
      },
      navigate: vi.fn((name: string, params: { sessionID: string }) => {
        route = { name, params };
      }),
    },
    state: {
      get ready() {
        return mounted;
      },
      config: { mcp: { clankie: { type: "local", command: ["clankie", "mcp", "--fleet"], enabled: true } } },
      session: { permission: () => [], question: () => [], status: () => ({ type: "idle" }) },
    },
    client: {
      session: {
        create: vi.fn(async () => {
          expect(mounted).toBe(false);
          return { data: { id: sessionId } };
        }),
        get: vi.fn(async () => ({ data: { id: sessionId, directory } })),
        status: async () => ({ data: {} }),
        messages: vi.fn(async () => ({ data: [] })),
        promptAsync: vi.fn(async () => ({ response: { status: 204 } })),
        abort: vi.fn(async () => ({ data: true })),
      },
      permission: { list: async () => ({ data: [] }) },
      question: { list: async () => ({ data: [] }) },
      provider: { list: vi.fn(async () => ({ data: { all: [], connected: [] } })) },
      mcp: {
        connect: vi.fn(async () => ({ data: true })),
        status: vi.fn(async () => ({ data: { clankie: { status: "connected" } } })),
      },
    },
  };
  cleanups.push(async () => dispose());
  const initialization = tui(api, { endpoint: controller.endpoint, token: controller.token }).then(() => {
    mounted = true;
  });
  expect(mounted).toBe(false);
  expect(await controller.request("initialize", { cwd: directory }, 1000)).toEqual({
    sessionId,
    version: "1.18.18",
  });
  controller.select(sessionId);
  await initialization;
  expect(mounted).toBe(true);
  expect(api.client.session.create).toHaveBeenCalledOnce();
  const messageId = "msg_controllerRequest123";
  expect(await controller.request("send", { messageId, text: "Review" })).toMatchObject({
    outcome: "accepted",
    messageId,
  });
  expect(api.client.session.promptAsync).toHaveBeenCalledOnce();
  await controller.acknowledge(messageId);
  expect(await controller.request("refreshToolCatalog")).toEqual({
    outcome: "refreshed",
    reason: "original-native-clankie-connection-observed",
  });
  expect(api.client.mcp.connect).not.toHaveBeenCalled();
  expect(api.client.mcp.status).toHaveBeenCalledExactlyOnceWith(
    {},
    expect.objectContaining({ throwOnError: true }),
  );
  expect(api.client.session.create).toHaveBeenCalledOnce();
  expect(api.client.session.promptAsync).toHaveBeenCalledOnce();
  expect(api.route.navigate).toHaveBeenCalledOnce();
  expect(await controller.request("refreshToolCatalog", undefined, 1000, async () => false)).toEqual({
    outcome: "failed",
    reason: "original-native-control-unavailable",
  });
  expect(api.client.mcp.connect).not.toHaveBeenCalled();
  expect(api.client.mcp.status).toHaveBeenCalledOnce();
  expect(await controller.request("refreshToolCatalog", undefined, 1000, async () => true)).toMatchObject({
    outcome: "refreshed",
  });
  expect(api.client.mcp.connect).not.toHaveBeenCalled();
  expect(api.client.mcp.status).toHaveBeenCalledTimes(2);
  expect(api.client.session.promptAsync).toHaveBeenCalledOnce();
  const childStatus = (type: string) => {
    for (const handler of events.get("session.status") ?? [])
      handler({
        id: "native-child-status",
        type: "session.status",
        properties: { sessionID: "ses_nativeChild456", status: { type } },
      });
  };
  expect(
    await controller.request("refreshToolCatalog", undefined, 1000, async () => {
      childStatus("busy");
      return true;
    }),
  ).toEqual({ outcome: "skipped-busy", reason: "native-session-busy" });
  expect(api.client.mcp.connect).not.toHaveBeenCalled();
  expect(api.client.mcp.status).toHaveBeenCalledTimes(2);
  childStatus("idle");
  expect(await controller.request("refreshToolCatalog")).toMatchObject({ outcome: "refreshed" });
  expect(api.client.mcp.connect).not.toHaveBeenCalled();
  expect(api.client.mcp.status).toHaveBeenCalledTimes(3);
  expect(api.client.session.promptAsync).toHaveBeenCalledOnce();
  await expect(controller.request("initialize", { cwd: directory })).rejects.toThrow();
  expect(api.client.session.create).toHaveBeenCalledOnce();
  dispose();
  await expect(controller.request("status")).rejects.toThrow();
});

test("an OpenCode release lacking a worker surface is refused by name before any native effect", async () => {
  const { directory, controller, tui } = await workerTui();
  const create = vi.fn(async () => ({ data: { id: "ses_nativeWorker123" } }));
  const api = {
    app: { version: "1.20.0" },
    lifecycle: { signal: new AbortController().signal, onDispose() {} },
    route: { current: { name: "home" }, navigate: vi.fn() },
    state: {
      ready: false,
      config: {},
      session: { permission: () => [], question: () => [], status: () => undefined },
    },
    client: {
      session: { create, get: vi.fn(), status: vi.fn(), messages: vi.fn(), abort: vi.fn() },
      permission: { list: vi.fn() },
      question: { list: vi.fn() },
      provider: { list: vi.fn() },
    },
  };
  const loaded = tui(api, { endpoint: controller.endpoint, token: controller.token });
  void loaded.catch(() => {});
  await expect(controller.request("initialize", { cwd: directory }, 1000)).rejects.toThrow(
    "OpenCode 1.20.0 lacks the Clankie worker surface: client.session.promptAsync",
  );
  await expect(loaded).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
  expect(api.route.navigate).not.toHaveBeenCalled();
});
