import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileDoctrine, loadDoctrineFile, loadDoctrineLayerFile } from "@clankie/doctrine";
import { describe, expect, it } from "vitest";
import {
  loadMcpRegistryFile,
  mcpConnectorActionMetadata,
  mcpToolAction,
  McpRegistrySchema,
  projectMcpToolGrants,
  projectBrowserToolGrant,
  projectMcpWorkerServers,
  projectWebToolGrants,
  resolveCredentialEnvironment,
} from "../src/index.ts";

const profilesRoot = join(import.meta.dirname, "..", "..", "..", "doctrine", "profiles");
const doctrinePath = join(profilesRoot, "self-build-lab.yaml");

const registry = McpRegistrySchema.parse({
  schemaVersion: "1",
  servers: [
    {
      name: "ddg_search",
      description: "DuckDuckGo web search",
      transport: { type: "stdio", command: "uvx", args: ["duckduckgo-mcp-server"] },
      kinds: ["research"],
      tools: [
        { name: "search", riskClass: "read" },
        { name: "fetch_content", riskClass: "read" },
      ],
    },
    {
      name: "tracker",
      description: "Work tracker connector",
      transport: { type: "http", url: "https://mcp.example.com/sse" },
      tools: [
        { name: "get_issue", riskClass: "read" },
        { name: "delete_issue", riskClass: "destructive" },
      ],
    },
    {
      name: "designer",
      description: "Design tool with credentials",
      transport: { type: "stdio", command: "design-mcp", args: [] },
      credentialEnvironment: ["DESIGN_MCP_KEY"],
      tools: [{ name: "read_file", riskClass: "read" }],
    },
  ],
});

async function compiledDoctrine() {
  return compileDoctrine([await loadDoctrineFile(doctrinePath)]);
}

describe("McpRegistrySchema", () => {
  it("rejects duplicate server names and dashed names", () => {
    expect(() =>
      McpRegistrySchema.parse({
        schemaVersion: "1",
        servers: [registry.servers[0], registry.servers[0]],
      }),
    ).toThrow(/unique/u);
    expect(() =>
      McpRegistrySchema.parse({
        schemaVersion: "1",
        servers: [{ ...registry.servers[0], name: "ddg-search" }],
      }),
    ).toThrow(/lowercase alphanumerics/u);
  });

  it("rejects narrative-write tool classifications", () => {
    expect(() =>
      McpRegistrySchema.parse({
        schemaVersion: "1",
        servers: [
          {
            ...registry.servers[0],
            tools: [{ name: "comment", riskClass: "narrative-write" }],
          },
        ],
      }),
    ).toThrow();
  });

  it("loads a registry from yaml", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clankie-mcp-registry-"));
    const path = join(directory, "registry.yaml");
    await writeFile(
      path,
      [
        'schemaVersion: "1"',
        "servers:",
        "  - name: ddg_search",
        "    description: DuckDuckGo web search",
        "    transport: { type: stdio, command: uvx, args: [duckduckgo-mcp-server] }",
        "    tools:",
        "      - { name: search, riskClass: read }",
      ].join("\n"),
    );
    try {
      const loaded = await loadMcpRegistryFile(path);
      expect(loaded.servers[0]?.name).toBe("ddg_search");
      expect(loaded.servers[0]?.tools[0]?.riskClass).toBe("read");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("projectMcpToolGrants", () => {
  it("allows read-class tools and withholds approval-gated classes under self-build-lab", async () => {
    const grants = projectMcpToolGrants(registry, await compiledDoctrine(), { principalId: "test-worker" });
    const allowedActions = grants.allowed.map((grant) => grant.action).sort();
    expect(allowedActions).toEqual([
      "mcp.ddg_search.fetch_content",
      "mcp.ddg_search.search",
      "mcp.designer.read_file",
      "mcp.tracker.get_issue",
    ]);
    const destructive = grants.withheld.find((grant) => grant.action === "mcp.tracker.delete_issue");
    expect(destructive?.effect).toBe("require_approval");
  });

  it("registers every declared tool with the doctrine classifier", () => {
    const metadata = mcpConnectorActionMetadata(registry);
    expect(metadata).toHaveLength(5);
    expect(metadata.map((entry) => entry.action)).toContain(mcpToolAction("tracker", "delete_issue"));
  });
});

describe("projectWebToolGrants", () => {
  it("allows both web actions through the read risk class under self-build-lab", async () => {
    const grants = projectWebToolGrants(await compiledDoctrine(), { principalId: "test-worker" });
    expect(grants).toEqual({ webSearch: true, webFetch: true });
  });

  it("is denied by the high-assurance overlay's exact action policies", async () => {
    const doctrine = compileDoctrine([
      await loadDoctrineFile(doctrinePath),
      await loadDoctrineLayerFile(join(profilesRoot, "high-assurance-overlay.yaml")),
    ]);
    const grants = projectWebToolGrants(doctrine, { principalId: "test-worker" });
    expect(grants).toEqual({ webSearch: false, webFetch: false });
  });
});

describe("projectBrowserToolGrant", () => {
  it("allows the read-class browser action under self-build-lab", async () => {
    expect(projectBrowserToolGrant(await compiledDoctrine(), { principalId: "test-worker" })).toBe(true);
  });

  it("withholds browser control when an overlay denies the exact action", async () => {
    const doctrine = compileDoctrine([
      await loadDoctrineFile(doctrinePath),
      {
        schemaVersion: "1",
        id: "deny-browser-overlay",
        description: "Denies browser control.",
        kind: "overlay",
        actions: { "web.browse": { default: "deny", rules: [] } },
      },
    ]);
    expect(projectBrowserToolGrant(doctrine, { principalId: "test-worker" })).toBe(false);
  });
});

describe("projectMcpWorkerServers", () => {
  it("keeps partially-allowed servers at tool granularity and drops them at server granularity", async () => {
    const grants = projectMcpToolGrants(registry, await compiledDoctrine(), { principalId: "test-worker" });
    const environment = { DESIGN_MCP_KEY: "secret" };

    const toolLevel = projectMcpWorkerServers(registry, grants, {
      hostEnvironment: environment,
      toolGranularity: "tool",
    });
    const tracker = toolLevel.servers.find((server) => server.name === "tracker");
    expect(tracker?.allowedTools).toEqual(["get_issue"]);

    const serverLevel = projectMcpWorkerServers(registry, grants, {
      hostEnvironment: environment,
      toolGranularity: "server",
    });
    expect(serverLevel.servers.map((server) => server.name)).toEqual(["ddg_search", "designer"]);
    expect(serverLevel.withheldServers.map((entry) => entry.name)).toContain("tracker");
  });

  it("withholds a stdio server whose credential environment is unavailable", async () => {
    const grants = projectMcpToolGrants(registry, await compiledDoctrine(), { principalId: "test-worker" });
    const projection = projectMcpWorkerServers(registry, grants, {
      hostEnvironment: {},
      toolGranularity: "tool",
    });
    const withheld = projection.withheldServers.find((entry) => entry.name === "designer");
    expect(withheld?.reason).toContain("DESIGN_MCP_KEY");
    expect(projection.servers.map((server) => server.name)).not.toContain("designer");
  });

  it("never leaks the runner environment beyond the credential allowlist", () => {
    const resolved = resolveCredentialEnvironment(["DESIGN_MCP_KEY"], {
      DESIGN_MCP_KEY: "secret",
      HOME: "/Users/nobody",
      OPENAI_API_KEY: "should-not-leak",
    });
    expect(resolved.environment).toEqual({ DESIGN_MCP_KEY: "secret" });
    expect(resolved.missing).toEqual([]);
  });

  it("carries task-kind scoping through to the worker projection", async () => {
    const grants = projectMcpToolGrants(registry, await compiledDoctrine(), { principalId: "test-worker" });
    const projection = projectMcpWorkerServers(registry, grants, {
      hostEnvironment: { DESIGN_MCP_KEY: "secret" },
      toolGranularity: "tool",
    });
    expect(projection.servers.find((server) => server.name === "ddg_search")?.kinds).toEqual(["research"]);
    expect(projection.servers.find((server) => server.name === "tracker")?.kinds).toBeUndefined();
  });
});
