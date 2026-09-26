import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { CredentialStore } from "@clankie/credential-broker";
import type { SettingsStore } from "@clankie/settings";
import { createMcpHost, type McpHost } from "../src/mcp-host.ts";
import { createWorkItemsService } from "../src/work-items.ts";

const roots: string[] = [];
const hosts: McpHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(content: string) {
  const root = await mkdtemp(join(tmpdir(), "linear-data-"));
  roots.push(root);
  const host = createMcpHost({
    credentials: { get: async () => undefined } as unknown as CredentialStore,
    settings: { load: async () => ({ mcp: { servers: [] } }) } as unknown as SettingsStore,
    curated: [
      {
        id: "linear",
        transport: "stdio",
        command: "fake",
        args: [],
        lane: "operator",
        initialTools: [],
        enabled: true,
      },
    ],
    logger: { info: () => undefined, warn: () => undefined },
    connect: async () => ({
      listTools: async () => [],
      callTool: async () => ({ content, isError: false }),
      close: async () => undefined,
    }),
  });
  hosts.push(host);
  const service = createWorkItemsService({
    stateDirectory: join(root, "state"),
    workspace: () => root,
    mcpHost: host,
  });
  await service.handle({ action: "init", repo: "workspace", backend: "linear", linearTeam: "VUH" }, true);
  return { service, host };
}

it("parses a Linear page larger than 50k through the real MCP host while retaining the model cap", async () => {
  const content = JSON.stringify({
    issues: Array.from({ length: 10 }, (_, i) => ({
      id: `VUH-${i}`,
      title: `Item ${i}`,
      description: "x".repeat(6000),
    })),
    hasNextPage: false,
  });
  expect(content.length).toBeGreaterThan(50_000);
  const { service, host } = await fixture(content);
  const model = await host.call({ lane: "operator", server: "linear", tool: "list_issues", arguments: {} });
  expect(model).toMatchObject({ outcome: "ok", content: content.slice(0, 50_000) });
  const result = await service.handle({ action: "list", repo: "workspace" }, false);
  expect(result).toHaveProperty("items.length", 10);
  if ("items" in result) expect(result.items[9]?.summary).toBe("x".repeat(6000));
});

it("refuses oversized UTF-8 data with a typed result and service error, never truncated JSON", async () => {
  // Under 8 Mi characters but over 8 MiB: the data ceiling is bytes, not JS length.
  const content = JSON.stringify({ issues: [], padding: "界".repeat(3_000_000) });
  const { service, host } = await fixture(content);
  const result = await host.call({
    lane: "operator",
    server: "linear",
    tool: "list_issues",
    arguments: {},
    resultMode: "data",
  });
  expect(result).toMatchObject({
    outcome: "refused",
    reason: "result_too_large",
    detail: expect.stringContaining("8388608 bytes"),
  });
  expect(result).not.toHaveProperty("content");
  await expect(service.handle({ action: "list", repo: "workspace" }, false)).rejects.toMatchObject({
    name: "WorkRequestError",
    code: "result_too_large",
  });
});
