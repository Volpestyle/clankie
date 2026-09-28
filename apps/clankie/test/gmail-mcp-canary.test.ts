import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore, type McpServerSettings } from "@clankie/settings";
import { createMcpHost, type McpHost } from "../src/mcp-host.ts";

// Opt-in development configuration, deliberately absent from the shipping catalog.
const gmail: McpServerSettings = {
  id: "gmail-canary",
  transport: "http",
  url: "https://gmailmcp.googleapis.com/mcp/v1",
  args: [],
  credential: "google-gmail-canary",
  lane: "operator",
  initialTools: ["list_labels"],
  enabled: true,
};
const silent = { info: () => undefined, warn: () => undefined };
const directories: string[] = [];
const hosts: McpHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function setup(credentialPath?: string) {
  const directory = await mkdtemp(join(tmpdir(), "clankie-gmail-canary-"));
  directories.push(directory);
  const credentials = new FileCredentialStore(credentialPath ?? join(directory, "credentials.json"));
  const host = createMcpHost({
    credentials,
    settings: new SettingsStore(join(directory, "settings.json")),
    curated: [gmail],
    logger: silent,
  });
  hosts.push(host);
  return { credentials, host };
}

it("keeps an unconnected Gmail canary unavailable without touching the network", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network request"));
  const { host } = await setup();
  expect(await host.catalog("operator")).toEqual([]);
  const result = await host.call({ lane: "operator", server: gmail.id, tool: "list_labels", arguments: {} });
  expect(result.outcome).toBe("refused");
  expect(network).not.toHaveBeenCalled();
});

it.runIf(process.env.CLANKIE_GMAIL_CANARY === "1")(
  "reads test-account labels through the real broker and Google MCP transport",
  async () => {
    const path = process.env.CLANKIE_GMAIL_CANARY_CREDENTIALS_FILE;
    if (!path || !path.startsWith("/")) {
      throw new Error(
        "consent_required: provide an absolute isolated test broker path; see the essentials evidence README",
      );
    }
    const { host, credentials } = await setup(resolve(path));
    const credential = await credentials.get("google-gmail-canary");
    // Never print credential values or provider content in assertion failures.
    if (credential?.type !== "oauth" || !credential.access || credential.expires <= Date.now()) {
      throw new Error("consent_required: a fresh test-account Google OAuth grant is missing or expired");
    }
    const catalog = await host.catalog("operator");
    expect(catalog.some((tool) => tool.name === "list_labels")).toBe(true);
    const result = await host.call({
      lane: "operator",
      server: gmail.id,
      tool: "list_labels",
      arguments: { pageSize: 1 },
    });
    expect(result.outcome).toBe("ok");
    if (result.outcome === "ok") {
      expect(result.isError).toBe(false);
      expect(result.content.length > 0).toBe(true);
    }
  },
  30_000,
);
