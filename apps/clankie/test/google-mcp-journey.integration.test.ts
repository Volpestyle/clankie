import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  FileCredentialStore,
  GOOGLE_ACCOUNT_DEFINITIONS,
  GOOGLE_OAUTH_APP_PROVIDER_ID,
  GOOGLE_PROVIDER_IDS,
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
