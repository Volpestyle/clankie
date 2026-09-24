import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import type {
  CredentialStore,
  ProviderAccount,
  ProviderCredential,
  RedactedCredential,
} from "@clankie/credential-broker";
import type { McpServerSettings, SettingsStore } from "@clankie/settings";
import { createMcpHost, type McpConnection } from "../src/mcp-host.ts";

const silent = { info: () => undefined, warn: () => undefined };
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function credentialStore(stored: Record<string, ProviderCredential> = {}): CredentialStore {
  return {
    get: async (id) => stored[id],
    set: async (id, credential) => void (stored[id] = credential),
    delete: async (id) => delete stored[id],
    list: async () => ({}) as Record<string, RedactedCredential>,
  };
}

function settingsStore(servers: readonly McpServerSettings[]): SettingsStore {
  return { load: async () => ({ mcp: { servers } }) } as unknown as SettingsStore;
}

function server(overrides: Partial<McpServerSettings> & { id: string }): McpServerSettings {
  return {
    transport: "stdio",
    command: "fake-mcp",
    args: [],
    lane: "operator",
    initialTools: [],
    enabled: true,
    ...overrides,
  };
}

/** A connection whose tool list and call log the test can inspect. */
function fakeConnection(tools: readonly string[]): McpConnection & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listTools: async () => tools.map((name) => ({ name, description: `does ${name}`, inputSchema: {} })),
    callTool: async (name) => {
      calls.push(name);
      return { content: `ran ${name}`, isError: false };
    },
    close: async () => undefined,
  };
}

describe("mcp host", () => {
  it("says once when a curated server goes missing for want of a credential, and again when it returns", async () => {
    const warnings: Record<string, unknown>[] = [];
    const notices: Record<string, unknown>[] = [];
    const stored: Record<string, ProviderCredential> = {};
    const credentials = credentialStore(stored);
    const curated = [
      server({ id: "linear", credential: "linear", transport: "http", url: "https://example" }),
    ];
    const host = createMcpHost({
      credentials,
      settings: settingsStore([]),
      logger: {
        info: (context) => void notices.push(context),
        warn: (context) => void warnings.push(context),
      },
      curated,
      connect: async () => fakeConnection(["search"]),
    });

    expect(await host.catalog("operator")).toEqual([]);
    expect(warnings.filter((entry) => entry.event === "mcp.host.credential_missing")).toHaveLength(1);

    stored["linear"] = { type: "api", key: "k" };
    // No timer or restart: connecting takes effect on the next catalog read.
    expect(await host.catalog("operator")).toHaveLength(1);
    expect(notices.filter((entry) => entry.event === "mcp.host.credential_restored")).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("keeps an operator-lane server out of a Discord room, by catalog and by name", async () => {
    const connection = fakeConnection(["read_note"]);
    const host = createMcpHost({
      credentials: credentialStore(),
      settings: settingsStore([server({ id: "notes" })]),
      logger: silent,
      curated: [],
      connect: async () => connection,
    });

    expect(await host.catalog("operator")).toHaveLength(1);
    expect(await host.catalog("discord_presence")).toEqual([]);

    // Absent from the catalog is not enough: a session that learned the name
    // elsewhere must still be refused at the call.
    const refused = await host.call({
      lane: "discord_presence",
      server: "notes",
      tool: "read_note",
      arguments: {},
    });
    expect(refused).toMatchObject({ outcome: "refused", reason: "lane_denied" });
    expect(connection.calls).toEqual([]);
  });

  it("lets an everywhere-lane server through from Discord", async () => {
    const connection = fakeConnection(["list_issues"]);
    const host = createMcpHost({
      credentials: credentialStore(),
      settings: settingsStore([server({ id: "tracker", lane: "everywhere" })]),
      logger: silent,
      curated: [],
      connect: async () => connection,
    });

    const result = await host.call({
      lane: "discord_presence",
      server: "tracker",
      tool: "list_issues",
      arguments: {},
    });
    expect(result).toEqual({ outcome: "ok", content: "ran list_issues", isError: false });
  });

  it("shows every settled call to the observer", async () => {
    const seen: unknown[] = [];
    const host = createMcpHost({
      credentials: credentialStore(),
      settings: settingsStore([server({ id: "tracker", lane: "everywhere" })]),
      logger: silent,
      curated: [],
      connect: async () => fakeConnection(["create_comment"]),
      observeCall: (call) => seen.push(call),
    });
    await host.call({ lane: "operator", server: "tracker", tool: "create_comment", arguments: {} });
    expect(seen).toEqual([
      { server: "tracker", tool: "create_comment", content: "ran create_comment", isError: false },
    ]);
  });

  it("observes the account used for the write and preserves success when receipt storage fails", async () => {
    const original: ProviderAccount = {
      provider: "linear",
      connectionId: "connection-1",
      userId: "bot",
      workspaceId: "org",
      name: "Bot",
      email: "bot@example.test",
      workspaceName: "Test",
      verifiedAt: new Date().toISOString(),
    };
    const credentials = credentialStore({ linear: { type: "api", key: "private-key", account: original } });
    const seen: unknown[] = [],
      warnings: unknown[] = [];
    let writes = 0;
    const host = createMcpHost({
      credentials,
      settings: settingsStore([server({ id: "linear", credential: "linear" })]),
      logger: { info: () => undefined, warn: (context) => void warnings.push(context) },
      curated: [],
      connect: async () => ({
        ...fakeConnection(["save_comment"]),
        callTool: async () => {
          writes++;
          await credentials.set("linear", {
            type: "api",
            key: "replacement",
            account: { ...original, userId: "another" },
          });
          return { content: "saved", isError: false };
        },
      }),
      observeCall: (call) => {
        seen.push(call);
        throw new Error("disk full");
      },
    });
    try {
      expect(
        await host.call({ lane: "operator", server: "linear", tool: "save_comment", arguments: {} }),
      ).toEqual({ outcome: "ok", content: "saved", isError: false });
      expect(writes).toBe(1);
      expect(seen).toMatchObject([{ account: original }]);
      expect(JSON.stringify(seen)).not.toContain("private-key");
      expect(warnings).toMatchObject([{ event: "mcp.host.observer_failed" }]);
    } finally {
      await host.close();
    }
  });

  it("offers a curated connector only once its credential is stored", async () => {
    const curated = [server({ id: "linear", lane: "everywhere", credential: "linear" })];
    const connect = async (): Promise<McpConnection> => fakeConnection(["list_issues"]);

    const disconnected = createMcpHost({
      credentials: credentialStore(),
      settings: settingsStore([]),
      logger: silent,
      curated,
      connect,
    });
    expect(await disconnected.catalog("operator")).toEqual([]);

    const connected = createMcpHost({
      credentials: credentialStore({ linear: { type: "api", key: "lin_api_x" } }),
      settings: settingsStore([]),
      logger: silent,
      curated,
      connect,
    });
    expect((await connected.catalog("operator")).map((tool) => tool.qualifiedName)).toEqual([
      "linear_list_issues",
    ]);
  });

  it("starts every tool active until initialTools narrows it", async () => {
    const connect = async (): Promise<McpConnection> => fakeConnection(["a", "b", "c"]);
    const all = createMcpHost({
      credentials: credentialStore(),
      settings: settingsStore([server({ id: "wide" })]),
      logger: silent,
      curated: [],
      connect,
    });
    expect((await all.catalog("operator")).filter((tool) => tool.initial)).toHaveLength(3);

    const narrowed = createMcpHost({
      credentials: credentialStore(),
      settings: settingsStore([server({ id: "wide", initialTools: ["a"] })]),
      logger: silent,
      curated: [],
      connect,
    });
    const catalog = await narrowed.catalog("operator");
    expect(catalog.filter((tool) => tool.initial).map((tool) => tool.name)).toEqual(["a"]);
    // The rest stay registered so mcp_tool_search can reveal them.
    expect(catalog).toHaveLength(3);
  });

  it("lets an owner entry replace a curated connector of the same id", async () => {
    const host = createMcpHost({
      credentials: credentialStore({ linear: { type: "api", key: "lin_api_x" } }),
      settings: settingsStore([server({ id: "linear", command: "my-linear-mcp" })]),
      logger: silent,
      curated: [server({ id: "linear", lane: "everywhere", credential: "linear" })],
      connect: async (entry) => fakeConnection([entry.command ?? "?"]),
    });

    const catalog = await host.catalog("operator");
    expect(catalog.map((tool) => tool.name)).toEqual(["my-linear-mcp"]);
    // The owner's entry is operator-lane, so the curated "everywhere" is gone too.
    expect(await host.catalog("discord_presence")).toEqual([]);
  });

  it("survives one server being unreachable", async () => {
    const host = createMcpHost({
      credentials: credentialStore(),
      settings: settingsStore([server({ id: "good" }), server({ id: "broken" })]),
      logger: silent,
      curated: [],
      connect: async (entry) => {
        if (entry.id === "broken") throw new Error("spawn ENOENT");
        return fakeConnection(["works"]);
      },
    });

    expect((await host.catalog("operator")).map((tool) => tool.qualifiedName)).toEqual(["good_works"]);
    const refused = await host.call({
      lane: "operator",
      server: "broken",
      tool: "anything",
      arguments: {},
    });
    expect(refused).toMatchObject({ outcome: "refused", reason: "server_unavailable" });
  });

  it("refuses a server that is not configured at all", async () => {
    const host = createMcpHost({
      credentials: credentialStore(),
      settings: settingsStore([]),
      logger: silent,
      curated: [],
      connect: async () => fakeConnection([]),
    });
    expect(await host.call({ lane: "operator", server: "ghost", tool: "x", arguments: {} })).toMatchObject({
      outcome: "refused",
      reason: "unknown_server",
    });
  });

  it("immediately enforces a lane change and closes the old connection", async () => {
    const configured = [server({ id: "tracker", lane: "everywhere" })];
    const connection = fakeConnection(["write"]);
    const close = vi.spyOn(connection, "close");
    const host = createMcpHost({
      credentials: credentialStore(),
      settings: settingsStore(configured),
      logger: silent,
      curated: [],
      connect: async () => connection,
    });
    await host.catalog("discord_presence");
    configured[0] = server({ id: "tracker", lane: "operator" });
    expect(
      await host.call({ lane: "discord_presence", server: "tracker", tool: "write", arguments: {} }),
    ).toMatchObject({ outcome: "refused", reason: "lane_denied" });
    expect(connection.calls).toEqual([]);
    expect(close).toHaveBeenCalledOnce();
    expect(await host.catalog("discord_presence")).toEqual([]);
  });

  it("keeps a disabled owner override from falling back to the curated account", async () => {
    const configured = [server({ id: "linear", enabled: true })];
    const connection = fakeConnection(["write"]);
    const close = vi.spyOn(connection, "close");
    const host = createMcpHost({
      credentials: credentialStore({ linear: { type: "api", key: "curated" } }),
      settings: settingsStore(configured),
      logger: silent,
      curated: [server({ id: "linear", credential: "linear", lane: "everywhere" })],
      connect: async () => connection,
    });
    await host.catalog("operator");
    configured[0] = server({ id: "linear", enabled: false });
    expect(
      await host.call({ lane: "operator", server: "linear", tool: "write", arguments: {} }),
    ).toMatchObject({ outcome: "refused", reason: "unknown_server" });
    expect(await host.catalog("operator")).toEqual([]);
    expect(close).toHaveBeenCalledOnce();
    expect(connection.calls).toEqual([]);
  });

  it.each(["http", "stdio"] as const)(
    "disconnect invalidates a cached %s catalog and transport",
    async (transport) => {
      const credentials = credentialStore({ tracker: { type: "api", key: "connected" } });
      const connection = fakeConnection(["write"]);
      const close = vi.spyOn(connection, "close");
      const host = createMcpHost({
        credentials,
        settings: settingsStore([
          server({ id: "tracker", transport, credential: "tracker", url: "https://example" }),
        ]),
        logger: silent,
        curated: [],
        connect: async () => connection,
      });
      await host.catalog("operator");
      await credentials.delete("tracker");
      expect(
        await host.call({ lane: "operator", server: "tracker", tool: "write", arguments: {} }),
      ).toMatchObject({ outcome: "refused", reason: "server_unavailable" });
      expect(await host.catalog("operator")).toEqual([]);
      expect(close).toHaveBeenCalledOnce();
      expect(connection.calls).toEqual([]);
    },
  );

  it("closes a cached transport when the broker cannot establish current credentials", async () => {
    const credentials = credentialStore({ tracker: { type: "api", key: "connected" } });
    const connection = fakeConnection(["write"]);
    const close = vi.spyOn(connection, "close");
    const host = createMcpHost({
      credentials,
      settings: settingsStore([server({ id: "tracker", credential: "tracker" })]),
      logger: silent,
      curated: [],
      connect: async () => connection,
    });
    await host.catalog("operator");
    vi.spyOn(credentials, "get").mockRejectedValue(new Error("broker unavailable"));
    expect(
      await host.call({ lane: "operator", server: "tracker", tool: "write", arguments: {} }),
    ).toMatchObject({ outcome: "refused", reason: "server_unavailable" });
    expect(close).toHaveBeenCalledOnce();
    expect(connection.calls).toEqual([]);
  });

  it("discards a late initialize without replacing the new connection", async () => {
    const configured = [server({ id: "tracker", command: "old" })];
    const old = fakeConnection(["old_tool"]),
      current = fakeConnection(["new_tool"]);
    const close = vi.spyOn(old, "close");
    let ready!: () => void;
    let finish!: (value: McpConnection) => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const delayed = new Promise<McpConnection>((resolve) => {
      finish = resolve;
    });
    const host = createMcpHost({
      credentials: credentialStore(),
      settings: settingsStore(configured),
      logger: silent,
      curated: [],
      connect: async (entry) => {
        if (entry.command === "old") {
          ready();
          return delayed;
        }
        return current;
      },
    });
    const staleCall = host.call({ lane: "operator", server: "tracker", tool: "old_tool", arguments: {} });
    await started;
    configured[0] = server({ id: "tracker", command: "new" });
    expect((await host.catalog("operator"))[0]?.name).toBe("new_tool");
    finish(old);
    expect(await staleCall).toMatchObject({ outcome: "refused" });
    expect(close).toHaveBeenCalledOnce();
    expect(old.calls).toEqual([]);
    expect(
      await host.call({ lane: "operator", server: "tracker", tool: "new_tool", arguments: {} }),
    ).toMatchObject({ outcome: "ok" });
    expect(current.calls).toEqual(["new_tool"]);
    await host.close();
  });

  it("closes a connection that finishes initializing during shutdown", async () => {
    const connection = fakeConnection(["write"]);
    const close = vi.spyOn(connection, "close");
    let ready!: () => void;
    let finish!: (value: McpConnection) => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const delayed = new Promise<McpConnection>((resolve) => {
      finish = resolve;
    });
    const host = createMcpHost({
      credentials: credentialStore(),
      settings: settingsStore([server({ id: "tracker" })]),
      logger: silent,
      curated: [],
      connect: async () => {
        ready();
        return delayed;
      },
    });
    const catalog = host.catalog("operator");
    await started;
    const closing = host.close();
    finish(connection);
    await closing;
    expect(await catalog).toEqual([]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("replaces a real stdio process when its credential changes", async () => {
    const require = createRequire(import.meta.url);
    const source = `
      import { Server } from ${JSON.stringify(require.resolve("@modelcontextprotocol/sdk/server/index.js"))};
      import { StdioServerTransport } from ${JSON.stringify(require.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
      import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(require.resolve("@modelcontextprotocol/sdk/types.js"))};
      const server = new Server({ name: "test", version: "1" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: "identity", inputSchema: { type: "object" } }] }));
      server.setRequestHandler(CallToolRequestSchema, () => ({ content: [{ type: "text", text: process.env.TEST_MCP_TOKEN }] }));
      await server.connect(new StdioServerTransport());
    `;
    const credentials = credentialStore({ tracker: { type: "api", key: "first-test-account" } });
    const host = createMcpHost({
      credentials,
      logger: silent,
      curated: [],
      settings: settingsStore([
        server({
          id: "tracker",
          command: process.execPath,
          args: ["--input-type=module", "-e", source],
          credential: "tracker",
          credentialEnv: "TEST_MCP_TOKEN",
        }),
      ]),
    });
    const call = () => host.call({ lane: "operator", server: "tracker", tool: "identity", arguments: {} });
    try {
      expect(await call()).toMatchObject({ outcome: "ok", content: "first-test-account" });
      await credentials.set("tracker", { type: "api", key: "second-test-account" });
      expect(await call()).toMatchObject({ outcome: "ok", content: "second-test-account" });
      await credentials.delete("tracker");
      expect(await call()).toMatchObject({ outcome: "refused" });
    } finally {
      await host.close();
    }
  });

  it("uses a fresh HTTP MCP session after an account change", async () => {
    const credentials = credentialStore({ tracker: { type: "api", key: "first-test-account" } });
    const initialized: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        if (init?.method !== "POST") return new Response(null, { status: 405 });
        const request = JSON.parse(String(init.body));
        const authorization = new Headers(init.headers).get("authorization")!;
        if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (request.method === "initialize") {
          initialized.push(authorization);
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion: request.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "test", version: "1" },
            },
          });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            content: [{ type: "text", text: authorization }],
          },
        });
      }),
    );
    const host = createMcpHost({
      credentials,
      logger: silent,
      curated: [],
      settings: settingsStore([
        server({
          id: "tracker",
          transport: "http",
          url: "https://example.test/mcp",
          credential: "tracker",
        }),
      ]),
    });
    const call = () => host.call({ lane: "operator", server: "tracker", tool: "identity", arguments: {} });
    try {
      expect(await call()).toMatchObject({ outcome: "ok", content: "Bearer first-test-account" });
      await credentials.set("tracker", { type: "api", key: "second-test-account" });
      expect(await call()).toMatchObject({ outcome: "ok", content: "Bearer second-test-account" });
      expect(initialized).toEqual(["Bearer first-test-account", "Bearer second-test-account"]);
    } finally {
      await host.close();
    }
  });
});
