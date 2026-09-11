import { describe, expect, it, vi } from "vitest";
import type { CredentialStore, ProviderCredential, RedactedCredential } from "@clankie/credential-broker";
import type { McpServerSettings, SettingsStore } from "@clankie/settings";
import { createMcpHost, type McpConnection } from "../src/mcp-host.ts";

const silent = { info: () => undefined, warn: () => undefined };

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
    // Past the resolved-server memo, so the next catalog re-reads the store.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5_010);
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
});
