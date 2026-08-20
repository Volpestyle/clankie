import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { browserEnabled, createBrowserHost, type BrowserHost } from "../src/browser-host.ts";

const logger = { info: () => undefined, warn: () => undefined };

interface FakeServerOptions {
  tools?: { name: string; description?: string; inputSchema?: unknown }[];
  toolPages?: { name: string; description?: string; inputSchema?: unknown }[][];
  callResult?: {
    content: { type: string; text?: string; data?: string; mimeType?: string }[];
    isError?: boolean;
  };
  callDelayMs?: number;
  statsPath?: string;
}

const fakeServerPath = join(import.meta.dirname, "fixtures", "browser-mcp-server.mjs");

describe("browserEnabled", () => {
  it("defaults on so an unconfigured service still has a browser", () => {
    expect(browserEnabled(undefined)).toBe(true);
    expect(browserEnabled("")).toBe(true);
    expect(browserEnabled("   ")).toBe(true);
  });

  it("stays off only when the operator says so", () => {
    for (const value of ["0", "false", "no", "off", "FALSE", " Off "]) {
      expect(browserEnabled(value), value).toBe(false);
    }
    for (const value of ["1", "true", "yes", "on", "TRUE"]) {
      expect(browserEnabled(value), value).toBe(true);
    }
  });
});

describe("browser host", () => {
  let stateRoot: string;
  let host: BrowserHost | undefined;

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "clankie-browser-"));
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    await rm(stateRoot, { recursive: true, force: true });
  });

  async function build(
    server: FakeServerOptions,
    blockedTools: readonly string[] = [],
  ): Promise<BrowserHost> {
    host = await createBrowserHost({
      stateRoot,
      attachmentRoot: stateRoot,
      logger,
      environment: {},
      command: process.execPath,
      args: [fakeServerPath, JSON.stringify(server)],
      blockedTools,
    });
    return host;
  }

  it("projects the full server catalog minus the blocklist", async () => {
    const created = await build(
      {
        tools: [
          { name: "navigate", description: "Go to a URL", inputSchema: { type: "object" } },
          { name: "eval", description: "Run JavaScript", inputSchema: { type: "object" } },
          { name: "new_superpower", description: "shipped last week", inputSchema: { type: "object" } },
        ],
      },
      ["eval"],
    );
    const catalog = await created.catalog();
    expect(catalog.available).toBe(true);
    // Doctrine projection left with the governance machinery: everything the
    // server advertises is his, except what the blocklist names.
    expect(catalog.tools.map((tool) => tool.name).sort()).toEqual(["navigate", "new_superpower"]);
    expect(catalog.tools.find((tool) => tool.name === "navigate")).toMatchObject({
      requiresApproval: false,
    });
  });

  it("loads every paginated catalog page", async () => {
    const created = await build({
      toolPages: [
        [{ name: "first", inputSchema: { type: "object" } }],
        [{ name: "second", inputSchema: { type: "object" } }],
      ],
    });

    expect((await created.catalog()).tools.map((tool) => tool.name)).toEqual(["first", "second"]);
  });

  it("calls a granted tool and returns its bounded text", async () => {
    const created = await build({
      tools: [{ name: "navigate", inputSchema: { type: "object" } }],
      callResult: { content: [{ type: "text", text: "visited via navigate" }] },
    });
    const result = await created.call({
      schemaVersion: 1,
      tool: "navigate",
      arguments: { url: "https://example.com" },
    });
    expect(result).toMatchObject({ outcome: "ok", tool: "navigate", content: "visited via navigate" });
  });

  it("parks an image block as a hash-bound artifact instead of dropping it", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const created = await build({
      tools: [{ name: "navigate", inputSchema: { type: "object" } }],
      callResult: {
        content: [
          { type: "text", text: "/tmp/shot.png" },
          { type: "image", data: png.toString("base64"), mimeType: "image/png" },
        ],
      },
    });
    const result = await created.call({ schemaVersion: 1, tool: "navigate", arguments: {} });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    // The path still reaches him as text, but the pixels now exist somewhere
    // he can point at — that gap is what made a screenshot look successful
    // while nothing attachable had been produced.
    expect(result.content).toContain("/tmp/shot.png");
    expect(result.artifacts).toHaveLength(1);
    const artifact = result.artifacts[0]!;
    const digest = createHash("sha256").update(png).digest("hex");
    expect(artifact.artifactRef).toBe(`sha256:${digest}:${join("browser", `${digest}.png`)}`);
    expect(artifact).toMatchObject({ mimeType: "image/png", byteLength: png.byteLength });
    // Written where the Discord attachment resolver already looks.
    expect(readFileSync(join(stateRoot, "browser", `${digest}.png`)).equals(png)).toBe(true);
  });

  it("refuses a blocklisted tool instead of forwarding it", async () => {
    const created = await build({ tools: [{ name: "navigate", inputSchema: { type: "object" } }] }, ["eval"]);
    const result = await created.call({ schemaVersion: 1, tool: "eval", arguments: {} });
    expect(result).toMatchObject({ outcome: "refused", reason: "unknown_tool" });
  });

  it("degrades a startup failure instead of failing service boot", async () => {
    host = await createBrowserHost({
      stateRoot,
      attachmentRoot: stateRoot,
      logger,
      environment: {},
      command: join(stateRoot, "missing-agent-browser"),
      args: [],
    });
    await expect(host.catalog()).resolves.toMatchObject({ available: false, tools: [] });
    await expect(host.call({ schemaVersion: 1, tool: "navigate", arguments: {} })).resolves.toMatchObject({
      outcome: "refused",
      reason: "browser_unavailable",
    });
  });

  it("shuts down the SDK transport and refuses later calls", async () => {
    const created = await build({ tools: [{ name: "navigate", inputSchema: { type: "object" } }] });
    await created.close();
    await expect(created.call({ schemaVersion: 1, tool: "navigate", arguments: {} })).resolves.toMatchObject({
      outcome: "refused",
      reason: "browser_unavailable",
      detail: "browser_host_closed",
    });
  });

  it("serializes calls across sessions and rejects raw CLI arguments", async () => {
    const statsPath = join(stateRoot, "call-stats.json");
    const created = await build({
      tools: [{ name: "navigate", inputSchema: { type: "object" } }],
      callDelayMs: 5,
      statsPath,
    });

    await Promise.all([
      created.call({ schemaVersion: 1, tool: "navigate", arguments: {} }),
      created.call({ schemaVersion: 1, tool: "navigate", arguments: {} }),
    ]);
    expect(JSON.parse(readFileSync(statsPath, "utf8"))).toEqual({ maxActiveCalls: 1 });
    await expect(
      created.call({ schemaVersion: 1, tool: "navigate", arguments: { extraArgs: ["--profile", "/tmp/x"] } }),
    ).resolves.toMatchObject({ outcome: "refused" });
  });
});
