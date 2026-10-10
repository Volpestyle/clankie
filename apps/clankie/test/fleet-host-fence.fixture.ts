import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpBindings } from "@hono/node-server";
import { expect, vi } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { LocalFleetLink, type LocalFleetIdentity } from "../src/local-fleet-link.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";

type Admission = "local" | "stream" | "bearer";
export async function fixture(
  admission: Admission = "bearer",
  wire = false,
  snapshot = true,
  options: { linearWrite?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "clankie-fleet-bridge-"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const account = {
    provider: "linear" as const,
    actor: "app" as const,
    connectionId: randomUUID(),
    userId: "bot",
    workspaceId: "workspace",
    email: "bot@example.test",
    name: "Bot",
    workspaceName: "Test",
    verifiedAt: new Date().toISOString(),
  };
  await credentials.set("linear", { type: "api", key: "SECRET-fixture", account });
  await credentials.set("docs", { type: "api", key: "SECRET-other" });
  const state = {
    live: true,
    onValidate: undefined as undefined | (() => Promise<void>),
    onToolsRead: undefined as undefined | (() => Promise<void>),
  };
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    mcp: {
      servers: ["linear", "docs"].map((id) => ({
        id,
        credential: id,
        transport: "http",
        url: `https://${id}.example.test/mcp`,
        lane: "operator",
        enabled: true,
        args: [],
        initialTools: [],
      })),
    },
  }));
  const calls = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
    content: "result",
    isError: false,
  }));
  const observed: unknown[] = [];
  const fetchSpy = wire
    ? vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        if (init?.method !== "POST") return new Response(null, { status: 405 });
        const request = JSON.parse(String(init.body));
        if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
        const result =
          request.method === "initialize"
            ? {
                protocolVersion: request.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "mock-provider", version: "1" },
              }
            : request.method === "tools/list"
              ? {
                  tools: [
                    { name: "read_0", inputSchema: { type: "object" } },
                    ...(options.linearWrite ? [{ name: "save_issue", inputSchema: { type: "object" } }] : []),
                  ],
                }
              : await (async () => {
                  const called = await calls(request.params.name, request.params.arguments);
                  return { content: [{ type: "text", text: called.content }], isError: called.isError };
                })();
        return Response.json({ jsonrpc: "2.0", id: request.id, result });
      })
    : undefined;
  const host = createMcpHost({
    credentials,
    settings,
    curated: [],
    logger: { info() {}, warn() {} },
    ...(wire
      ? {}
      : {
          connect: async (server: { id: string }) => ({
            listTools: async () =>
              server.id === "docs"
                ? [{ name: "read", description: "Read documentation", inputSchema: { type: "object" } }]
                : [
                    ...Array.from({ length: 30 }, (_, i) => ({
                      name: `read_${i}`,
                      description: `Read item ${i}\nwith details`,
                      inputSchema: {
                        type: "object",
                        properties: { id: { type: "string" } },
                        required: ["id"],
                      },
                    })),
                    { name: "create_worker_comment", inputSchema: { type: "object" } },
                    { name: "create_worker_issue", inputSchema: { type: "object" } },
                  ],
            callTool: calls,
            close: async () => {},
          }),
        }),
    observeCall: (call) => {
      observed.push(call);
    },
  });
  const worker = new WorkerMcp({
    directory: join(root, "grants"),
    credentials,
    host,
    fleetTools: async () => (await settings.load()).fleet.tools,
    ...(snapshot
      ? {
          fleetToolsSnapshot: async () => {
            const snapshot = await settings.loadFenced();
            await state.onToolsRead?.();
            return { tools: snapshot.settings.fleet.tools, assertCurrent: snapshot.assertCurrent };
          },
        }
      : {}),
  });
  const local = new LocalFleetLink({
    directory: join(root, "links"),
    binding: async () => undefined,
    prove: async (_socket, pane) => state.live && pane === "w1:p1",
  });
  const identities = new WeakMap<Request, LocalFleetIdentity>();
  const identity = {
    fleet: "pc",
    pane: "w1:p1",
    current: () => state.live,
    validate: async () => {
      await state.onValidate?.();
      return state.live;
    },
  };
  const app = await createClankieApp({
    captain: createStubCaptain(),
    workerMcp: worker,
    localFleet: local,
    fleetLinks: {
      identity: (request) => identities.get(request),
      authenticate: (token) => (state.live && token === "fleet-token" ? "pc" : undefined),
    },
    authenticateOperator: async () => undefined,
  });
  const socket = new Socket();
  const localFetch = local.fetch(app.app.fetch);
  async function rpc(method: string, params: unknown = {}, session?: string) {
    const request = new Request("http://localhost/v1/fleet/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer fleet-token",
        "x-clankie-pane": "w1:p1",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (admission === "local") return localFetch(request, { incoming: { socket } } as HttpBindings);
    if (admission === "stream") identities.set(request, identity);
    try {
      return await app.app.fetch(request);
    } finally {
      identities.delete(request);
    }
  }
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "fixture", version: "1" },
  });
  expect(init.status).toBe(200);
  const session = init.headers.get("mcp-session-id")!;
  const call = async (name: string, args: unknown) =>
    (await (await rpc("tools/call", { name, arguments: args }, session)).json()).result;
  return {
    credentials,
    settings,
    socket,
    local,
    identity,
    setTools: (tools: "connected" | "off") =>
      settings.update((current) => ({
        ...current,
        fleet: { ...current.fleet, tools },
      })),
    disableServers: () =>
      settings.update((current) => ({
        ...current,
        mcp: { servers: current.mcp.servers.map((server) => ({ ...server, enabled: false })) },
      })),
    account,
    state,
    calls,
    host,
    worker,
    observed,
    rpc: (method: string, params?: unknown) => rpc(method, params, session),
    call,
    close: async () => {
      app.close();
      socket.destroy();
      await local.close();
      await worker.close();
      await host.close();
      fetchSpy?.mockRestore();
      await rm(root, { recursive: true, force: true });
    },
  };
}
