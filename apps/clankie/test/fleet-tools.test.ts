import { assertMcpToolsList } from "../src/mcp-tool-schema.ts";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpBindings } from "@hono/node-server";
import { expect, it, vi } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import type { SettingsStore } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { LocalFleetLink, type LocalFleetIdentity } from "../src/local-fleet-link.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";

type Admission = "local" | "stream" | "bearer";
async function fixture(admission: Admission = "bearer") {
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
  const state = { live: true, tools: "connected" as "connected" | "off", serversEnabled: true };
  const calls = vi.fn(async () => ({ content: "result", isError: false }));
  const observed: unknown[] = [];
  const host = createMcpHost({
    credentials,
    settings: {
      load: async () => ({
        mcp: {
          servers: ["linear", "docs"].map((id) => ({
            id,
            credential: id,
            transport: "http",
            url: `https://${id}.example.test/mcp`,
            lane: "operator",
            enabled: state.serversEnabled,
            args: [],
            initialTools: [],
          })),
        },
      }),
    } as unknown as SettingsStore,
    curated: [],
    logger: { info() {}, warn() {} },
    connect: async (server) => ({
      listTools: async () =>
        server.id === "docs"
          ? [{ name: "read", description: "Read documentation", inputSchema: { type: "object" } }]
          : [
              ...Array.from({ length: 30 }, (_, i) => ({
                name: `read_${i}`,
                description: `Read item ${i}\nwith details`,
                inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
              })),
              { name: "create_worker_comment", inputSchema: { type: "object" } },
              { name: "create_worker_issue", inputSchema: { type: "object" } },
            ],
      callTool: calls,
      close: async () => {},
    }),
    observeCall: (call) => {
      observed.push(call);
    },
  });
  const worker = new WorkerMcp({
    directory: join(root, "grants"),
    credentials,
    host,
    fleetTools: async () => state.tools,
    fleetToolsSnapshot: async () => ({
      tools: state.tools,
      assertCurrent: () => {
        if (state.tools !== "connected") throw new Error("Fleet tools are off");
      },
    }),
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
    validate: async () => state.live,
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
    if (admission === "local") return localFetch(request, { incoming: { socket: {} } } as HttpBindings);
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
      await local.close();
      await worker.close();
      await host.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("searches bounded names and schemas across verified servers, excluding worker publishing and unverified accounts", async () => {
  const f = await fixture();
  try {
    const listed = (await (await f.rpc("tools/list")).json()).result.tools;
    expect(listed[0].description).toMatch(/Connected now: .*linear/u);
    const search = await f.call("clankie_tools", {});
    const lines = search.content[0].text.split("\n");
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe("linear_read_0 — Read item 0 with details");
    expect(search.content[0].text).not.toContain("inputSchema");
    const names = await f.call("clankie_tools", {
      names: ["linear_read_2", "linear_create_worker_comment", "linear_create_worker_issue", "docs_read"],
    });
    expect(JSON.parse(names.content[0].text)).toEqual([
      {
        name: "linear_read_2",
        description: "Read item 2\nwith details",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
    ]);
    expect((await f.call("clankie_tools", { query: "read item 29" })).content[0].text).toContain(
      "linear_read_29",
    );
    const loose = (await f.call("clankie_tools", { query: "linear issue read 7 create" })).content[0].text;
    expect(loose.split("\n")[0]).toBe("linear_read_7 — Read item 7 with details");
    expect((await f.call("clankie_tools", { query: "nothing matches this" })).content[0].text).toContain(
      "No connected tool matches",
    );
    expect((await f.call("clankie_tools", { names: Array(11).fill("linear_read_1") })).isError).toBe(true);
    for (const name of [
      "linear_create_worker_comment",
      "linear_create_worker_issue",
      "docs_read",
      "invented_read",
    ])
      expect((await f.call("clankie_call", { name, arguments: {} })).isError).toBe(true);
    expect(f.calls).not.toHaveBeenCalled();
    await f.credentials.set("docs", { type: "api", key: "SECRET-other", account: f.account });
    expect((await f.call("clankie_tools", { query: "documentation" })).content[0].text).toBe(
      "docs_read — Read documentation",
    );
    expect((await f.call("clankie_call", { name: "docs_read", arguments: {} })).isError).toBe(false);
    expect(f.observed).toMatchObject([
      { worker: { principalId: "fleet:pc:pane:unverified", workId: "fleet:pc" } },
    ]);
    expect(JSON.stringify(names)).not.toContain("SECRET");
    expect(await f.worker.list()).toEqual([]);
    f.state.serversEnabled = false;
    expect((await f.call("clankie_call", { name: "docs_read", arguments: {} })).isError).toBe(true);
    expect((await f.call("clankie_tools", {})).content[0].text).toBe("");
    expect(f.calls).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it("keeps the two-tool catalog when no account verifies, with no callable upstream tools", async () => {
  const f = await fixture();
  try {
    await f.credentials.set("linear", { type: "api", key: "SECRET-fixture" });
    const listed = (await (await f.rpc("tools/list")).json()).result.tools;
    expect(listed.map((tool: { name: string }) => tool.name)).toEqual(["clankie_tools", "clankie_call"]);
    expect(listed[0].description).not.toContain("Connected now");
    expect((await f.call("clankie_tools", { query: "read" })).content[0].text).toBe("");
    expect((await f.call("clankie_call", { name: "linear_read_0", arguments: {} })).isError).toBe(true);
    expect(f.calls).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

const admissionRaces = (["local", "stream", "bearer"] as const).flatMap((admission) =>
  (["catalog", "authorization-account", "dispatch-account"] as const).map((phase) => ({ admission, phase })),
);
it.each(admissionRaces)(
  "refuses $admission admission invalidated during the $phase await",
  async ({ admission, phase }) => {
    const f = await fixture(admission);
    try {
      // Control establishes that the same admitted pane and arguments can dispatch.
      expect(
        (await f.call("clankie_call", { name: "linear_read_0", arguments: { id: "A-1" } })).isError,
      ).toBe(false);
      let entered!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const catalog = f.host.catalog.bind(f.host);
      const account = f.host.account.bind(f.host);
      let reads = 0;
      const catalogSpy = vi.spyOn(f.host, "catalog").mockImplementation(async (...args) => {
        const result = await catalog(...args);
        if (phase === "catalog" && ++reads === 1) {
          entered();
          await barrier;
        }
        return result;
      });
      const accountSpy = vi.spyOn(f.host, "account").mockImplementation(async (...args) => {
        const result = await account(...args);
        if (
          args[0] === "linear" &&
          phase !== "catalog" &&
          ++reads === (phase === "authorization-account" ? 2 : 3)
        ) {
          entered();
          await barrier;
        }
        return result;
      });
      const pending = f.call("clankie_call", { name: "linear_read_0", arguments: { id: "A-1" } });
      await waiting;
      f.state.live = false;
      release();
      expect((await pending).isError).toBe(true);
      expect(f.calls).toHaveBeenCalledOnce();
      catalogSpy.mockRestore();
      accountSpy.mockRestore();
    } finally {
      await f.close();
    }
  },
);

it.each(["local", "stream", "bearer"] as const)(
  "rechecks tools off at %s dispatch after an account await",
  async (admission) => {
    const f = await fixture(admission);
    try {
      const account = f.host.account.bind(f.host);
      let reads = 0;
      const spy = vi.spyOn(f.host, "account").mockImplementation(async (...args) => {
        const result = await account(...args);
        if (args[0] === "linear" && ++reads === 3) f.state.tools = "off";
        return result;
      });
      expect((await f.call("clankie_call", { name: "linear_read_0", arguments: {} })).isError).toBe(true);
      expect(f.calls).not.toHaveBeenCalled();
      spy.mockRestore();
      expect((await (await f.rpc("tools/list")).json()).result.tools).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

it("retains the host account-binding fence after the standing account snapshot", async () => {
  const f = await fixture();
  try {
    const account = f.host.account.bind(f.host);
    let reads = 0;
    const spy = vi.spyOn(f.host, "account").mockImplementation(async (...args) => {
      const result = await account(...args);
      if (args[0] === "linear" && ++reads === 3)
        await f.credentials.set("linear", {
          type: "api",
          key: "replacement",
          account: { ...f.account, connectionId: randomUUID() },
        });
      return result;
    });
    expect((await f.call("clankie_call", { name: "linear_read_0", arguments: {} })).isError).toBe(true);
    expect(f.calls).not.toHaveBeenCalled();
    spy.mockRestore();
  } finally {
    await f.close();
  }
});

it("strict client contract: connected fleet HTTP tools/list", async () => {
  const f = await fixture();
  try {
    const listed = await (await f.rpc("tools/list")).json();
    assertMcpToolsList(listed.result, "fleet HTTP endpoint");
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "clankie_tools",
      "clankie_call",
    ]);
  } finally {
    await f.close();
  }
});
