import { expect, it, vi } from "vitest";
import { LocalCodexSeats } from "../src/local-codex-seats.ts";
import { createCodexSeatAdapter } from "../src/captain/codex-seat-adapter.ts";
it("binds a private server to its allocated pane and revokes on release without deleting a replacement", () => {
  const binding = { runtime: "external" as const, session: "default", socketPath: "/trusted/socket" };
  const registry = new LocalCodexSeats(() => binding);
  const release = registry.register(42, "w1:p1");
  expect(registry.allows([55, 42], "w1:p1", binding)).toBe(true);
  expect(registry.allows([55, 42], "w1:p2", binding)).toBe(false);
  expect(registry.allows([55, 42], "w1:p1", { ...binding, socketPath: "/other/socket" })).toBe(false);
  const replacement = registry.register(42, "w1:p2");
  release();
  expect(registry.allows([55, 42], "w1:p2", binding)).toBe(true);
  replacement();
  expect(registry.allows([55, 42], "w1:p2", binding)).toBe(false);
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
