import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import { McpRegistrySchema } from "@clankie/mcp-registry";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrowserHost, type BrowserHost } from "../src/browser-host.ts";

const doctrinePath = join(import.meta.dirname, "..", "..", "..", "doctrine", "profiles", "self-build-lab.yaml");

const registry = McpRegistrySchema.parse({
  schemaVersion: "1",
  servers: [
    {
      name: "agent_browser",
      description: "Clankie's headless browser",
      transport: { type: "stdio", command: "agent-browser", args: ["mcp", "--tools", "all"] },
      tools: [
        { name: "navigate", riskClass: "read" },
        { name: "click", riskClass: "reversible-write" },
        { name: "eval", riskClass: "destructive" },
      ],
    },
  ],
});

const logger = { info: () => undefined, warn: () => undefined };

/**
 * A fake `agent-browser mcp` speaking newline-delimited JSON-RPC on stdio, so
 * the suite exercises the real framing without launching a browser.
 */
function fakeServer(options: {
  tools?: { name: string; description?: string; inputSchema?: unknown }[];
  onCall?: (name: string, args: unknown) => { content: { type: string; text: string }[]; isError?: boolean };
}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill(): void;
  };
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = () => undefined;

  let buffer = "";
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      const message = JSON.parse(line) as { id?: number; method: string; params?: { name?: string; arguments?: unknown } };
      if (message.id === undefined) continue;
      const reply = (result: unknown) =>
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
      if (message.method === "initialize") reply({ protocolVersion: "2025-11-25", capabilities: {} });
      else if (message.method === "tools/list") reply({ tools: options.tools ?? [] });
      else if (message.method === "tools/call") {
        reply(
          options.onCall?.(message.params?.name ?? "", message.params?.arguments) ?? {
            content: [{ type: "text", text: "ok" }],
          },
        );
      }
    }
  });
  return child;
}

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

  async function build(server: ReturnType<typeof fakeServer>): Promise<BrowserHost> {
    host = await createBrowserHost({
      registry,
      doctrine: compileDoctrine([await loadDoctrineFile(doctrinePath)]),
      runnerStateRoot: stateRoot,
      logger,
      environment: {},
      spawnImpl: (() => server) as never,
    });
    return host;
  }

  it("projects only registry-declared tools and carries the approval decision", async () => {
    const created = await build(
      fakeServer({
        tools: [
          { name: "navigate", description: "Go to a URL", inputSchema: { type: "object" } },
          { name: "eval", description: "Run JavaScript", inputSchema: { type: "object" } },
          // Present on the server, absent from the registry: never projected,
          // so a new agent-browser release cannot widen Clankie's reach.
          { name: "undeclared_superpower", description: "nope", inputSchema: { type: "object" } },
        ],
      }),
    );
    const catalog = await created.catalog();
    expect(catalog.available).toBe(true);
    expect(catalog.tools.map((tool) => tool.name).sort()).toEqual(["eval", "navigate"]);
    expect(catalog.tools.find((tool) => tool.name === "navigate")).toMatchObject({
      riskClass: "read",
      requiresApproval: false,
    });
    expect(catalog.tools.find((tool) => tool.name === "eval")).toMatchObject({
      riskClass: "destructive",
      requiresApproval: true,
    });
  });

  it("calls a granted tool and returns its bounded text", async () => {
    const created = await build(
      fakeServer({
        tools: [{ name: "navigate", inputSchema: { type: "object" } }],
        onCall: (name) => ({ content: [{ type: "text", text: `visited via ${name}` }] }),
      }),
    );
    const result = await created.call({
      schemaVersion: 1,
      tool: "navigate",
      arguments: { url: "https://example.com" },
    });
    expect(result).toMatchObject({ outcome: "ok", tool: "navigate", content: "visited via navigate" });
  });

  it("refuses a tool the registry never declared instead of forwarding it", async () => {
    const created = await build(fakeServer({ tools: [{ name: "navigate", inputSchema: { type: "object" } }] }));
    const result = await created.call({ schemaVersion: 1, tool: "undeclared_superpower", arguments: {} });
    expect(result).toMatchObject({ outcome: "refused", reason: "doctrine_denied" });
  });
});
