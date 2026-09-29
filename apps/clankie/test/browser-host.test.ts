import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserEnabled,
  createBrowserHost,
  type BrowserHost,
  type BrowserHostOptions,
} from "../src/browser-host.ts";

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
  eventsPath?: string;
  failClose?: boolean;
  failRecording?: boolean;
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
    options: Partial<BrowserHostOptions> = {},
  ): Promise<BrowserHost> {
    const executable = join(stateRoot, "agent-browser.mjs");
    await writeFile(
      executable,
      `#!${process.execPath}\nprocess.argv.splice(2, 0, ${JSON.stringify(JSON.stringify(server))});\nawait import(${JSON.stringify(pathToFileURL(fakeServerPath).href)});\n`,
    );
    await chmod(executable, 0o755);
    host = await createBrowserHost({
      stateRoot,
      attachmentRoot: stateRoot,
      logger,
      environment: {},
      command: executable,
      args: [],
      blockedTools,
      ...options,
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

  function events(): Record<string, unknown>[] {
    return readFileSync(join(stateRoot, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  async function lifecycle(options: Partial<BrowserHostOptions> = {}, server: FakeServerOptions = {}) {
    return build({ eventsPath: join(stateRoot, "events.jsonl"), ...server }, [], {
      idleMs: 100,
      environment: { AGENT_BROWSER_HEADED: "1" },
      ...options,
    });
  }

  const open = (headed?: boolean) => ({
    schemaVersion: 1 as const,
    tool: "agent_browser_open",
    arguments: headed === undefined ? { url: "https://example.com" } : { url: "https://example.com", headed },
  });

  it("retires stale daemons before connecting and pins headless despite inherited headed defaults", async () => {
    const created = await lifecycle();
    expect(events()).toEqual([
      { cli: ["close"], headed: "0" },
      { server: true, headed: "0", idle: "300000", restore: "clankie", restoreSave: "always" },
    ]);
    await created.call(open());
    expect(events().find((event) => event.call)).toMatchObject({
      call: { arguments: { extraArgs: ["--headed", "false"] } },
    });
  });

  it("waits for the retiring daemon to remove its PID file before connecting", async () => {
    const run = join(stateRoot, "browser", "run", "namespaces", "clankie", "run");
    await mkdir(run, { recursive: true });
    const pid = join(run, "clankie.pid");
    await writeFile(pid, "fake retiring daemon");
    const cleanup = new Promise<void>((resolve) => setTimeout(() => void rm(pid).then(resolve), 250));
    await lifecycle();
    expect(existsSync(pid)).toBe(false);
    await cleanup;
  });

  it("refuses browsing if retiring the stale daemon fails", async () => {
    const created = await lifecycle({}, { failClose: true });
    expect((await created.catalog()).available).toBe(false);
    expect(await created.call(open())).toMatchObject({ outcome: "refused" });
    expect(events()).toHaveLength(1);
  });

  it("closes idle bursts even with recordings off, preserves the profile, and reopens headless", async () => {
    const created = await lifecycle();
    const marker = join(stateRoot, "browser", "profile", "login-marker");
    await writeFile(marker, "keep me");
    await created.call(open(true));
    await created.call({ schemaVersion: 1, tool: "agent_browser_snapshot", arguments: {} });
    expect(events().filter((event) => event.call)).toMatchObject([
      { call: { arguments: { extraArgs: ["--headed", "true"] } } },
      { call: { arguments: { extraArgs: ["--headed", "true"] } } },
    ]);
    await vi.waitFor(() => expect(events().filter((event) => event.cli)).toHaveLength(2));
    expect(readFileSync(marker, "utf8")).toBe("keep me");
    await created.call(open());
    expect(
      events()
        .filter((event) => event.call)
        .at(-1),
    ).toMatchObject({
      call: { arguments: { extraArgs: ["--headed", "false"] } },
    });
  });

  it("saves recordings before mode changes and idle close using the burst's mode", async () => {
    const created = await lifecycle({ recordSessions: async () => true });
    await created.call(open());
    await created.call(open(true));
    await created.call({ schemaVersion: 1, tool: "agent_browser_snapshot", arguments: {} });
    await vi.waitFor(() =>
      expect(events().filter((event) => (event.cli as string[] | undefined)?.[0] === "close")).toHaveLength(
        2,
      ),
    );
    const commands = events()
      .filter((event) => event.cli)
      .map((event) => event.cli as string[]);
    expect(commands).toEqual([
      ["close"],
      ["state", "save", expect.any(String), "--headed", "false"],
      ["record", "start", expect.any(String), "--headed", "false"],
      ["state", "load", expect.any(String), "--headed", "false"],
      ["record", "stop", "--headed", "false"],
      ["state", "save", expect.any(String), "--headed", "true"],
      ["record", "start", expect.any(String), "--headed", "true"],
      ["state", "load", expect.any(String), "--headed", "true"],
      ["record", "stop", "--headed", "true"],
      ["close"],
    ]);
    expect(await readdir(join(stateRoot, "browser", "recordings"))).toHaveLength(2);
  });

  it("keeps in-flight and queued calls ahead of idle cleanup and drains on shutdown", async () => {
    const created = await lifecycle({ idleMs: 20 }, { callDelayMs: 80 });
    const first = created.call(open());
    const second = created.call(open());
    const shutdown = created.close();
    await expect(created.call(open())).resolves.toMatchObject({ outcome: "refused" });
    await Promise.all([first, second, shutdown]);
    expect(
      events()
        .filter((event) => event.cli || event.finished)
        .map((event) => event.cli ?? event.finished),
    ).toEqual([["close"], "agent_browser_open", "agent_browser_open", ["close"]]);
  });

  it("does not let a refused call cancel idle cleanup", async () => {
    const created = await lifecycle();
    await created.call(open());
    await expect(
      created.call({ schemaVersion: 1, tool: "agent_browser_open", arguments: { extraArgs: [] } }),
    ).resolves.toMatchObject({ outcome: "refused" });
    await vi.waitFor(() => expect(events().filter((event) => event.cli)).toHaveLength(2));
  });

  it("allows explicit early return to headless and saves before explicit close", async () => {
    const created = await lifecycle({ recordSessions: async () => true, idleMs: 1000 });
    await created.call(open(true));
    await created.call(open(false));
    await created.call({ schemaVersion: 1, tool: "agent_browser_close", arguments: {} });
    const calls = events().filter((event) => event.call);
    expect(calls.map((event) => event.call)).toMatchObject([
      { arguments: { extraArgs: ["--headed", "true"] } },
      { arguments: { extraArgs: ["--headed", "false"] } },
      { name: "agent_browser_close", arguments: { extraArgs: ["--headed", "false"] } },
    ]);
    const lastStop = events().findLastIndex((event) => (event.cli as string[] | undefined)?.[1] === "stop");
    const closeCall = events().findIndex(
      (event) => (event.call as { name?: string } | undefined)?.name === "agent_browser_close",
    );
    expect(lastStop).toBeLessThan(closeCall);
    await created.close();
    expect(events().filter((event) => (event.cli as string[] | undefined)?.[0] === "close")).toHaveLength(1);
  });

  it("still closes the browser when recording fails", async () => {
    const created = await lifecycle({ recordSessions: async () => true }, { failRecording: true });
    await expect(created.call(open())).resolves.toMatchObject({ outcome: "ok" });
    await created.close();
    expect(events().at(-1)).toMatchObject({ cli: ["close"] });
  });
});
