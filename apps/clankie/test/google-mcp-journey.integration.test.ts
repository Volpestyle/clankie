import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  FileCredentialStore,
  KeychainCredentialStore,
  GOOGLE_ACCOUNT_DEFINITIONS,
  GOOGLE_OAUTH_APP_PROVIDER_ID,
  GOOGLE_PROVIDER_IDS,
  normalizeProviderId,
  type CredentialGroup,
  type CredentialStore,
  type ProviderCredential,
} from "@clankie/credential-broker";
import type { GoogleAccountProvider } from "@clankie/protocol/accounts";
import { SettingsStore, type McpServerSettings } from "@clankie/settings";
import { createAccounts } from "../src/accounts.ts";
import { createAccountRoutes } from "../src/account-routes.ts";
import { createMcpHost, type McpHost } from "../src/mcp-host.ts";
import { createGoogleProviderFixture } from "./fixtures/google-provider.ts";

it("reads consented fixture mail, events and selected files through isolated brokers and real HTTP MCP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clankie-google-mcp-"));
  const provider = await createGoogleProviderFixture();
  const hosts: McpHost[] = [];
  const app = {
    clientId: "fixture-client",
    redirectUri: "http://127.0.0.1:4333/account/connections/google/callback",
  };
  provider.addClient(app.clientId, "fixture-developer-secret");
  async function tenant(name: string) {
    const credentials = new FileCredentialStore(join(directory, name, "credentials.json"));
    const settings = new SettingsStore(join(directory, name, "settings.json"));
    await credentials.set(GOOGLE_OAUTH_APP_PROVIDER_ID, {
      type: "api",
      key: "fixture-developer-secret",
      metadata: { clientId: app.clientId },
    });
    await settings.update((current) => ({ ...current, oauthApps: { ...current.oauthApps, google: app } }));
    const accounts = createAccounts({
      store: credentials,
      apps: async () => ({ github: {}, linear: {}, google: app }),
      googleEndpoints: provider.endpoints,
    });
    const curated: McpServerSettings[] = GOOGLE_PROVIDER_IDS.map((id) => ({
      id,
      transport: "http",
      url: provider.mcpEndpoints[id],
      args: [],
      lane: "operator",
      credential: id,
      initialTools: [...GOOGLE_ACCOUNT_DEFINITIONS[id].tools],
      enabled: true,
    }));
    const host = createMcpHost({
      credentials,
      settings,
      curated,
      googleApps: async () => app,
      googleEndpoints: provider.endpoints,
      logger: { info: () => undefined, warn: () => undefined },
    });
    hosts.push(host);
    const routes = createAccountRoutes(accounts, async () => true, settings);
    return { accounts, host, credentials, routes };
  }
  try {
    const a = await tenant("A");
    const b = await tenant("B");
    const pickedFiles = [
      "chosen-file",
      ...Array.from({ length: 99 }, (_, index) => `${index}`.padEnd(256, "a")),
    ];
    for (const capability of GOOGLE_PROVIDER_IDS) {
      const start = await a.accounts.startGoogle(capability);
      if (!start.ok) throw new Error("Fixture consent could not start");
      const code = provider.issueCode(start, { subject: "tenant-A-user", email: "tenant-a@example.test" });
      expect(
        await b.accounts.completeGoogle(
          capability,
          start.flowId,
          code,
          undefined,
          capability === "google-drive" ? ["chosen-file"] : undefined,
        ),
      ).toMatchObject({ ok: false, error: "unknown_flow" });
      const response = await a.routes.request("/v1/accounts/google/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: capability,
          state: start.flowId,
          code,
          ...(capability === "google-drive" ? { pickedFileIds: pickedFiles } : {}),
        }),
      });
      expect(response.status).toBe(200);
      const complete = await response.json();
      expect(complete).toMatchObject({ ok: true, connection: { provider: capability, status: "connected" } });
      expect(
        await a.accounts.completeGoogle(
          capability,
          start.flowId,
          code,
          undefined,
          capability === "google-drive" ? ["chosen-file"] : undefined,
        ),
      ).toMatchObject({ ok: false, error: "unknown_flow" });
    }
    provider.controls.toolResults = {
      "google-gmail:get_message": {
        value: {
          messageId: "known-mail",
          subject: "Review itinerary",
          body: "Meet at 09:00 on October 7.",
          sourceUrl: "https://mail.google.com/mail/u/0/#inbox/known-mail",
        },
      },
      "google-calendar:list_events": {
        value: {
          events: [
            {
              summary: "Morning meeting",
              start: { dateTime: "2026-10-07T14:00:00Z" },
              htmlLink: "https://calendar.google.com/calendar/event?eid=meeting",
            },
            { summary: "Travel day", start: { date: "2026-10-07" } },
          ],
          timeZone: "America/Chicago",
        },
      },
      "google-drive:read_file_content": {
        value: {
          fileContent: "Known reference itinerary",
          sourceUrl: "https://drive.google.com/file/d/chosen-file/view",
        },
      },
    };
    const call = (server: GoogleAccountProvider, tool: string, args: Record<string, unknown> = {}) =>
      a.host.call({ lane: "operator", server, tool, arguments: args });
    const catalog = await a.host.catalog("operator");
    expect(catalog.map((tool) => tool.name)).not.toContain("delete_everything");
    const fileSchema = catalog.find(
      (tool) => tool.server === "google-drive" && tool.name === "read_file_content",
    )!.inputSchema;
    expect(fileSchema).toMatchObject({ properties: { fileId: { enum: pickedFiles } } });
    const mail = await call("google-gmail", "get_message", { messageId: "known-mail" });
    expect(mail).toMatchObject({ outcome: "ok", isError: false });
    if (mail.outcome === "ok")
      expect(JSON.parse(mail.content)).toMatchObject({ body: "Meet at 09:00 on October 7." });
    const calendarArgs = {
      startTime: "2026-10-07T00:00:00-05:00",
      endTime: "2026-10-08T00:00:00-05:00",
      timeZone: "America/Chicago",
      orderBy: "startTime",
    };
    const events = await call("google-calendar", "list_events", calendarArgs);
    expect(events).toMatchObject({ outcome: "ok", isError: false });
    if (events.outcome === "ok") {
      const data = JSON.parse(events.content) as {
        events: Array<{ start: { dateTime?: string; date?: string } }>;
      };
      expect(
        new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Chicago",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(new Date(data.events[0]!.start.dateTime!)),
      ).toBe("09:00");
      expect(data.events[1]!.start.date).toBe("2026-10-07");
    }
    const read = await call("google-drive", "read_file_content", { fileId: "chosen-file" });
    expect(read).toMatchObject({ outcome: "ok", isError: false });
    if (read.outcome === "ok")
      expect(JSON.parse(read.content)).toMatchObject({
        fileContent: "Known reference itinerary",
        sourceUrl: "https://drive.google.com/file/d/chosen-file/view",
      });
    const count = provider.seen.filter(
      (entry) => entry.path.endsWith("/mcp") && entry.body.includes('"tools/call"'),
    ).length;
    expect(await call("google-drive", "read_file_content", { fileId: "other-file" })).toMatchObject({
      outcome: "refused",
      possiblyDispatched: false,
    });
    expect(await call("google-drive", "search_files", { query: "everything" })).toMatchObject({
      outcome: "refused",
      possiblyDispatched: false,
    });
    expect(await call("google-gmail", "delete_everything")).toMatchObject({
      outcome: "refused",
      possiblyDispatched: false,
    });
    expect(
      await a.host.call({
        lane: "discord_presence",
        server: "google-gmail",
        tool: "get_message",
        arguments: {},
      }),
    ).toMatchObject({ outcome: "refused", reason: "lane_denied" });
    expect(
      await a.host.call({
        lane: "operator",
        server: "google-gmail",
        tool: "get_message",
        arguments: {},
        delegation: { binding: "other", grantId: "other", principalId: "other", workId: "other" },
      }),
    ).toMatchObject({ outcome: "refused", possiblyDispatched: false });
    expect(
      await b.host.call({
        lane: "operator",
        server: "google-gmail",
        tool: "get_message",
        arguments: { messageId: "known-mail" },
      }),
    ).toMatchObject({ outcome: "refused" });
    expect(
      provider.seen.filter((entry) => entry.path.endsWith("/mcp") && entry.body.includes('"tools/call"')),
    ).toHaveLength(count);
    provider.controls.toolResults["google-calendar:list_events"] = {
      value: { error: "temporarily_unavailable" },
      isError: true,
    };
    expect(await call("google-calendar", "list_events", calendarArgs)).toMatchObject({
      outcome: "ok",
      isError: true,
    });
    expect(await call("google-gmail", "get_message", { messageId: "known-mail" })).toMatchObject({
      outcome: "ok",
      isError: false,
    });
    provider.controls.toolResults["google-drive:read_file_content"] = {
      value: { error: "file_inaccessible" },
      isError: true,
    };
    const inaccessible = await call("google-drive", "read_file_content", { fileId: "chosen-file" });
    expect(inaccessible).toMatchObject({ outcome: "ok", isError: true });
    if (inaccessible.outcome === "ok")
      expect(JSON.parse(inaccessible.content)).toEqual({ error: "file_inaccessible" });
    await a.accounts.disconnect("google-gmail");
    expect(await a.host.catalog("operator")).toEqual([]);
    for (const capability of GOOGLE_PROVIDER_IDS)
      expect(
        await call(capability, GOOGLE_ACCOUNT_DEFINITIONS[capability].tools[0], { fileId: "chosen-file" }),
      ).toMatchObject({ outcome: "refused" });
    expect((await b.accounts.list()).connections.filter((row) => row.provider.startsWith("google-"))).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "not_connected" })]),
    );
  } finally {
    await Promise.all(hosts.map((host) => host.close()));
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

async function googleAliasFixture(storeFactory?: (root: string) => CredentialStore, canonicalGmail = false) {
  const directory = await mkdtemp(join(tmpdir(), "clankie-google-alias-"));
  const provider = await createGoogleProviderFixture();
  const credentials =
    storeFactory?.(directory) ?? new FileCredentialStore(join(directory, "credentials.json"));
  const settings = new SettingsStore(join(directory, "settings.json"));
  const app = {
    clientId: "fixture-alias-client",
    redirectUri: "http://127.0.0.1:4333/account/connections/google/callback",
  };
  provider.addClient(app.clientId, "fixture-alias-secret");
  await credentials.set(GOOGLE_OAUTH_APP_PROVIDER_ID, {
    type: "api",
    key: "fixture-alias-secret",
    metadata: { clientId: app.clientId },
  });
  const aliases = GOOGLE_PROVIDER_IDS.map(
    (id): McpServerSettings => ({
      id: "alias_" + id.replaceAll("-", "_"),
      transport: "http",
      url: provider.mcpEndpoints[id],
      args: [],
      lane: "everywhere",
      // Broker normalization must not allow a differently spelled alias to escape policy.
      credential: " " + id.toUpperCase() + "/// ",
      initialTools: [],
      enabled: true,
    }),
  );
  await settings.update((current) => ({
    ...current,
    oauthApps: { ...current.oauthApps, google: app },
    mcp: { ...current.mcp, servers: aliases },
  }));
  const accounts = createAccounts({
    store: credentials,
    apps: async () => ({ github: {}, linear: {}, google: app }),
    googleEndpoints: provider.endpoints,
  });
  const host = createMcpHost({
    credentials,
    settings,
    curated: canonicalGmail
      ? [{ ...aliases[0]!, id: "google-gmail", lane: "operator", credential: "google-gmail" }]
      : [],
    googleApps: async () => app,
    googleEndpoints: provider.endpoints,
    logger: { info: () => undefined, warn: () => undefined },
  });
  const connect = async (capability: GoogleAccountProvider, subject = "alice") => {
    const start = await accounts.startGoogle(capability);
    if (!start.ok) throw new Error("Fixture alias consent could not start");
    const code = provider.issueCode(start, { subject, email: subject + "@example.test" });
    expect(
      await accounts.completeGoogle(
        capability,
        start.flowId,
        code,
        undefined,
        capability === "google-drive" ? ["chosen-file"] : undefined,
      ),
    ).toMatchObject({ ok: true, connection: { status: "connected" } });
  };
  const calls = () => provider.seen.filter((entry) => entry.body.includes('"method":"tools/call"'));
  return {
    directory,
    provider,
    credentials,
    settings,
    accounts,
    host,
    connect,
    calls,
    close: async () => {
      await host.close();
      await provider.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it("keeps Google broker aliases private and read-only without rewriting authored configuration", async () => {
  const fixture = await googleAliasFixture();
  try {
    for (const provider of GOOGLE_PROVIDER_IDS) await fixture.connect(provider);
    const authored = (await fixture.settings.load()).mcp.servers;
    expect(await fixture.host.catalog("discord_presence")).toEqual([]);
    const catalog = await fixture.host.catalog("operator");
    expect(catalog).toHaveLength(11);
    expect(catalog.some((tool) => tool.name === "delete_everything")).toBe(false);
    const before = fixture.calls().length;
    for (const provider of GOOGLE_PROVIDER_IDS) {
      const server = "alias_" + provider.replaceAll("-", "_");
      expect(
        await fixture.host.call({
          lane: "discord_presence",
          server,
          tool: GOOGLE_ACCOUNT_DEFINITIONS[provider].tools[0],
          arguments: { fileId: "chosen-file" },
        }),
      ).toMatchObject({ outcome: "refused", reason: "lane_denied" });
      expect(
        await fixture.host.call({
          lane: "operator",
          server,
          tool: "delete_everything",
          arguments: {},
        }),
      ).toMatchObject({ outcome: "refused", possiblyDispatched: false });
    }
    expect(fixture.calls()).toHaveLength(before);
    expect((await fixture.settings.load()).mcp.servers).toEqual(authored);
    expect(
      await fixture.host.call({
        lane: "operator",
        server: "alias_google_gmail",
        tool: "get_message",
        arguments: { messageId: "known-mail" },
      }),
    ).toMatchObject({ outcome: "ok", isError: false });
    const google = await fixture.credentials.get("google-gmail");
    if (!google) throw new Error("Missing managed Google grant in fixture");
    await fixture.credentials.set("google_copy", google);
    await fixture.settings.update((current) => ({
      ...current,
      mcp: {
        ...current.mcp,
        servers: [
          ...current.mcp.servers,
          {
            id: "google_copy",
            transport: "http",
            url: fixture.provider.mcpEndpoints["google-gmail"],
            credential: "google_copy",
            args: [],
            initialTools: [],
            lane: "everywhere",
            enabled: true,
          },
        ],
      },
    }));
    const copiedBefore = fixture.calls().length;
    expect(await fixture.host.catalog("discord_presence")).toEqual([]);
    expect(await fixture.host.catalog("operator")).toHaveLength(11);
    expect(
      await fixture.host.call({
        lane: "operator",
        server: "google_copy",
        tool: "get_message",
        arguments: {},
      }),
    ).toMatchObject({ outcome: "refused", possiblyDispatched: false });
    expect(fixture.calls()).toHaveLength(copiedBefore);
  } finally {
    await fixture.close();
  }
});

it("keeps selected Drive file fences on a broker alias before any provider dispatch", async () => {
  const fixture = await googleAliasFixture();
  try {
    await fixture.connect("google-drive");
    const catalog = await fixture.host.catalog("operator");
    expect(catalog.find((tool) => tool.name === "read_file_content")?.inputSchema).toMatchObject({
      properties: { fileId: { enum: ["chosen-file"] } },
      required: ["fileId"],
    });
    const before = fixture.calls().length;
    for (const args of [{ fileId: "unselected-file" }, {}]) {
      expect(
        await fixture.host.call({
          lane: "operator",
          server: "alias_google_drive",
          tool: "read_file_content",
          arguments: args,
        }),
      ).toMatchObject({ outcome: "refused", possiblyDispatched: false });
    }
    expect(
      await fixture.host.call({
        lane: "operator",
        server: "alias_google_drive",
        tool: "delete_everything",
        arguments: { fileId: "chosen-file" },
      }),
    ).toMatchObject({ outcome: "refused", possiblyDispatched: false });
    expect(fixture.calls()).toHaveLength(before);
    expect(
      await fixture.host.call({
        lane: "operator",
        server: "alias_google_drive",
        tool: "read_file_content",
        arguments: { fileId: "chosen-file" },
      }),
    ).toMatchObject({ outcome: "ok", isError: false });
  } finally {
    await fixture.close();
  }
});

it.each(["http", "stdio"] as const)(
  "keeps partial Google disconnect epochs on a %s broker alias with a surviving Keychain token",
  async (transport) => {
    let failDisable = false;
    const items = new Map<string, string>();
    const fixture = await googleAliasFixture(
      (root) =>
        new KeychainCredentialStore({
          service: "google-alias-fixture-" + root,
          execFile: async (_file, args) => {
            const account = args[args.indexOf("-a") + 1]!;
            if (args[0] === "find-generic-password") {
              const value = items.get(account);
              if (value === undefined) throw new Error("item could not be found");
              return { stdout: value + "\n", stderr: "" };
            }
            if (args[0] === "add-generic-password") {
              const value = args[args.indexOf("-w") + 1]!;
              if (account === "google-calendar" && failDisable && value.includes('"status":"disconnected"'))
                throw new Error("Fixture simulates failed Keychain disable");
              items.set(account, value);
            } else if (args[0] === "delete-generic-password") items.delete(account);
            else throw new Error("Unexpected Keychain fixture command");
            return { stdout: "", stderr: "" };
          },
        }),
    );
    try {
      if (transport === "stdio") {
        const require = createRequire(import.meta.url);
        const source = `
        import { Server } from ${JSON.stringify(require.resolve("@modelcontextprotocol/sdk/server/index.js"))};
        import { StdioServerTransport } from ${JSON.stringify(require.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
        import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(require.resolve("@modelcontextprotocol/sdk/types.js"))};
        const server = new Server({ name: "google-boundary-fixture", version: "1" }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: "get_event", inputSchema: { type: "object" } }] }));
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          const response = await fetch(${JSON.stringify(fixture.provider.mcpEndpoints["google-calendar"])}, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer " + process.env.TEST_GOOGLE_TOKEN },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: request.params }),
          });
          return (await response.json()).result;
        });
        await server.connect(new StdioServerTransport());
      `;
        const script = join(fixture.directory, "google-stdio.mjs");
        await writeFile(script, source);
        await fixture.settings.update((current) => ({
          ...current,
          mcp: {
            ...current.mcp,
            servers: current.mcp.servers.map((server) =>
              server.id === "alias_google_calendar"
                ? {
                    id: server.id,
                    transport: "stdio",
                    command: process.execPath,
                    args: [script],
                    credential: server.credential!,
                    credentialEnv: "TEST_GOOGLE_TOKEN",
                    lane: server.lane,
                    initialTools: server.initialTools,
                    enabled: true,
                  }
                : server,
            ),
          },
        }));
      }
      await fixture.connect("google-calendar");
      expect(
        (await fixture.host.catalog("operator")).some((tool) => tool.server === "alias_google_calendar"),
      ).toBe(true);
      const before = fixture.calls().length;
      expect(
        await fixture.host.call({
          lane: "operator",
          server: "alias_google_calendar",
          tool: "get_event",
          arguments: { eventId: "known-event" },
          fence: async () => {
            failDisable = true;
            await expect(fixture.accounts.disconnect("google-calendar")).rejects.toThrow(
              "failed Keychain disable",
            );
            return () => {};
          },
        }),
      ).toMatchObject({ outcome: "refused", possiblyDispatched: false });
      const survivor = await fixture.credentials.get("google-calendar");
      expect(survivor).toMatchObject({ type: "oauth", metadata: { status: "connected" } });
      expect(survivor?.type === "oauth" && survivor.access.length > 0).toBe(true);
      expect(await fixture.host.catalog("operator")).toEqual([]);
      expect(fixture.calls()).toHaveLength(before);
    } finally {
      await fixture.close();
    }
  },
);

it("refuses an account replacement at Google broker selection without replaying the original MCP call", async () => {
  class ChangingStore extends FileCredentialStore {
    change?: () => Promise<void>;
    private async changeOnce() {
      const change = this.change;
      delete this.change;
      await change?.();
    }
    override async get(provider: string): Promise<ProviderCredential | undefined> {
      const snapshot = await super.get(provider);
      if (normalizeProviderId(provider) === GOOGLE_OAUTH_APP_PROVIDER_ID) await this.changeOnce();
      return snapshot;
    }
    override async updateMany(
      ids: readonly string[],
      transform: (group: CredentialGroup) => Promise<CredentialGroup>,
    ): Promise<CredentialGroup> {
      // Replace before acquiring the real lock; the fixture never nests broker mutations.
      await this.changeOnce();
      return super.updateMany(ids, transform);
    }
  }
  const fixture = await googleAliasFixture((root) => new ChangingStore(join(root, "credentials.json")), true);
  const store = fixture.credentials as ChangingStore;
  try {
    await fixture.connect("google-gmail");
    await fixture.host.catalog("operator");
    const before = fixture.calls().length;
    let replaced = 0;
    expect(
      await fixture.host.call({
        lane: "operator",
        server: "google-gmail",
        tool: "get_message",
        arguments: { messageId: "original-alice-message" },
        fence: async () => {
          store.change = async () => {
            replaced++;
            await fixture.connect("google-gmail", "bob");
          };
          return () => {};
        },
      }),
    ).toMatchObject({ outcome: "refused", possiblyDispatched: false });
    expect(replaced).toBe(1);
    expect(fixture.calls()).toHaveLength(before);
    const next = await fixture.host.call({
      lane: "operator",
      server: "google-gmail",
      tool: "get_message",
      arguments: { messageId: "bob-message" },
    });
    expect(next).toMatchObject({ outcome: "ok", isError: false });
    if (next.outcome === "ok") expect(JSON.parse(next.content).subject).toBe("bob");
    expect(fixture.calls()).toHaveLength(before + 1);
  } finally {
    await fixture.close();
  }
});
