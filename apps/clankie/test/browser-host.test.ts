import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { browserEnabled, createBrowserHost, type BrowserHost } from "../src/browser-host.ts";

const logger = { info: () => undefined, warn: () => undefined };

/**
 * A fake `agent-browser mcp` speaking newline-delimited JSON-RPC on stdio, so
 * the suite exercises the real framing without launching a browser.
 */
function fakeServer(options: {
  tools?: { name: string; description?: string; inputSchema?: unknown }[];
  toolPages?: { name: string; description?: string; inputSchema?: unknown }[][];
  onCall?: (
    name: string,
    args: unknown,
  ) =>
    | {
        content: { type: string; text?: string; data?: string; mimeType?: string }[];
        isError?: boolean;
      }
    | Promise<{
        content: { type: string; text?: string; data?: string; mimeType?: string }[];
        isError?: boolean;
      }>;
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
      const message = JSON.parse(line) as {
        id?: number;
        method: string;
        params?: { name?: string; arguments?: unknown; cursor?: string };
      };
      if (message.id === undefined) continue;
      const reply = (result: unknown) =>
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
      if (message.method === "initialize") reply({ protocolVersion: "2025-11-25", capabilities: {} });
      else if (message.method === "tools/list") {
        const page = Number(message.params?.cursor ?? "0");
        const pages = options.toolPages ?? [options.tools ?? []];
        reply({
          tools: pages[page] ?? [],
          ...(page + 1 < pages.length ? { nextCursor: String(page + 1) } : {}),
        });
      } else if (message.method === "tools/call") {
        void Promise.resolve(
          options.onCall?.(message.params?.name ?? "", message.params?.arguments) ?? {
            content: [{ type: "text", text: "ok" }],
          },
        ).then(reply);
      }
    }
  });
  return child;
}

describe("browserEnabled", () => {
  it("defaults on so an unconfigured runner still has a browser", () => {
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
    server: ReturnType<typeof fakeServer>,
    blockedTools: readonly string[] = [],
  ): Promise<BrowserHost> {
    host = await createBrowserHost({
      runnerStateRoot: stateRoot,
      logger,
      environment: {},
      spawnImpl: (() => server) as never,
      blockedTools,
    });
    return host;
  }

  it("projects the full server catalog minus the blocklist", async () => {
    const created = await build(
      fakeServer({
        tools: [
          { name: "navigate", description: "Go to a URL", inputSchema: { type: "object" } },
          { name: "eval", description: "Run JavaScript", inputSchema: { type: "object" } },
          { name: "new_superpower", description: "shipped last week", inputSchema: { type: "object" } },
        ],
      }),
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
    const created = await build(
      fakeServer({
        toolPages: [
          [{ name: "first", inputSchema: { type: "object" } }],
          [{ name: "second", inputSchema: { type: "object" } }],
        ],
      }),
    );

    expect((await created.catalog()).tools.map((tool) => tool.name)).toEqual(["first", "second"]);
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

  it("parks an image block as a hash-bound artifact instead of dropping it", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const created = await build(
      fakeServer({
        tools: [{ name: "navigate", inputSchema: { type: "object" } }],
        onCall: () => ({
          content: [
            { type: "text", text: "/tmp/shot.png" },
            { type: "image", data: png.toString("base64"), mimeType: "image/png" },
          ],
        }),
      }),
    );
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
    const created = await build(
      fakeServer({ tools: [{ name: "navigate", inputSchema: { type: "object" } }] }),
      ["eval"],
    );
    const result = await created.call({ schemaVersion: 1, tool: "eval", arguments: {} });
    expect(result).toMatchObject({ outcome: "refused", reason: "unknown_tool" });
  });

  it("serializes calls across sessions and rejects raw CLI arguments", async () => {
    let active = 0;
    let maxActive = 0;
    const created = await build(
      fakeServer({
        tools: [{ name: "navigate", inputSchema: { type: "object" } }],
        async onCall() {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return { content: [{ type: "text", text: "ok" }] };
        },
      }),
    );

    await Promise.all([
      created.call({ schemaVersion: 1, tool: "navigate", arguments: {} }),
      created.call({ schemaVersion: 1, tool: "navigate", arguments: {} }),
    ]);
    expect(maxActive).toBe(1);
    await expect(
      created.call({ schemaVersion: 1, tool: "navigate", arguments: { extraArgs: ["--profile", "/tmp/x"] } }),
    ).resolves.toMatchObject({ outcome: "refused" });
  });
});
