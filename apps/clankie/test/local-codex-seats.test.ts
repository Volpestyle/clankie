import { expect, it, vi } from "vitest";
import { LocalCodexSeats } from "../src/local-codex-seats.ts";
import { createCodexSeatAdapter } from "../src/captain/codex-seat-adapter.ts";
it("binds a private server to its allocated pane and revokes on release without deleting a replacement", async () => {
  const binding = { runtime: "external" as const, session: "default", socketPath: "/trusted/socket" };
  const registry = new LocalCodexSeats(
    () => binding,
    async () => "original-start",
  );
  const release = registry.register(42, "w1:p1");
  expect(await registry.allows([55, 42], "w1:p1", binding)).toBe(true);
  expect(await registry.allows([55, 42], "w1:p2", binding)).toBe(false);
  expect(await registry.allows([55, 42], "w1:p1", { ...binding, socketPath: "/other/socket" })).toBe(false);
  const replacement = registry.register(42, "w1:p2");
  release();
  expect(await registry.allows([55, 42], "w1:p2", binding)).toBe(true);
  replacement();
  expect(await registry.allows([55, 42], "w1:p2", binding)).toBe(false);
});
it("registers a private hire before startup discovery, injects the worker bridge for another account, and releases on failure", async () => {
  const release = vi.fn();
  const localProcess = vi.fn(() => release);
  const adapter = createCodexSeatAdapter({
    localProcess,
    trackerOverrides: async () => [],
    viewEnv: async (view) => ({ HERDR_PANE_ID: view.paneId, HERDR_SOCKET_PATH: "/trusted/socket" }),
    start: async (options) => {
      options.onServerStarted?.(42);
      expect(localProcess).toHaveBeenCalledWith(42, "w1:p1");
      expect(options.config).toContain("mcp_servers.clankie.enabled=true");
      expect(options.config).toContain('mcp_servers.clankie.args=["mcp","--fleet"]');
      expect(options.env).toEqual({
        CODEX_HOME: "/another-account",
        HERDR_PANE_ID: "w1:p1",
        HERDR_SOCKET_PATH: "/trusted/socket",
      });
      throw new Error("Startup failed");
    },
  });
  const result = await adapter.start(
    { harness: "codex", cwd: "/test", brief: "", env: { CODEX_HOME: "/another-account" } },
    { paneId: "w1:p1", run: async () => {} },
  );
  expect(result.outcome).toBe("failed");
  expect(release).toHaveBeenCalled();
});

it("rejects private server PID reuse, missing lifetime, binding changes and released entries", async () => {
  const binding = { runtime: "external" as const, session: "default", socketPath: "/trusted/socket" };
  let current = binding;
  let start: string | undefined = "original";
  const registry = new LocalCodexSeats(
    () => current,
    async () => start,
  );
  const release = registry.register(42, "w1:p1");
  expect(await registry.allows([55, 42], "w1:p1", binding)).toBe(true);
  start = "reused";
  expect(await registry.allows([55, 42], "w1:p1", binding)).toBe(false);
  start = "original";
  current = { ...binding, session: "another" };
  expect(await registry.allows([55, 42], "w1:p1", binding)).toBe(false);
  current = binding;
  release();
  expect(await registry.allows([55, 42], "w1:p1", binding)).toBe(false);
  start = undefined;
  registry.register(42, "w1:p1");
  expect(await registry.allows([55, 42], "w1:p1", binding)).toBe(false);
});

it.each(["release", "replacement"])(
  "cannot resurrect a registration after %s while lifetime capture is pending",
  async (change) => {
    const binding = { runtime: "external" as const, session: "default", socketPath: "/trusted/socket" };
    let releaseCapture!: (start: string) => void;
    let count = 0;
    const registry = new LocalCodexSeats(
      () => binding,
      async () =>
        ++count === 1
          ? new Promise<string>((resolve) => {
              releaseCapture = resolve;
            })
          : "original",
    );
    const release = registry.register(42, "w1:p1");
    const pending = registry.allows([55, 42], "w1:p1", binding);
    if (change === "release") release();
    else registry.register(42, "w1:p2");
    releaseCapture("original");
    expect(await pending).toBe(false);
  },
);

it("binds the authoritative private thread before reporting or sending the first brief", async () => {
  const events: string[] = [];
  const registration = Object.assign(
    () => {
      events.push("release");
    },
    {
      bindSession: (threadId: string) => {
        events.push(`bind:${threadId}`);
      },
    },
  );
  const adapter = createCodexSeatAdapter({
    localProcess: () => registration,
    trackerOverrides: async () => [],
    herdr: async () => {
      events.push("report");
    },
    start: async (options) => {
      options.onServerStarted?.(42);
      return {
        threadId: "private-thread",
        viewArgs: [],
        send: async () => {
          events.push("brief");
          return { turnId: "turn", state: "started" };
        },
        close: async () => {},
        interrupt: async () => true,
      };
    },
  });
  const result = await adapter.start(
    { harness: "codex", cwd: "/test", brief: "work" },
    { paneId: "w1:p1", run: async () => {} },
  );
  expect(result.outcome).toBe("started");
  expect(events.slice(0, 3)).toEqual(["bind:private-thread", "report", "brief"]);
  if (result.outcome === "started") await result.control.close();
});
