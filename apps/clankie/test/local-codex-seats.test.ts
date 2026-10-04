import { expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCodexSeats } from "../src/local-codex-seats.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
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

it("waits for durable thread binding and sends no brief when retaining the launch fails", async () => {
  const release = vi.fn();
  const close = vi.fn(async () => {});
  const send = vi.fn();
  const report = vi.fn();
  const adapter = createCodexSeatAdapter({
    localProcess: () =>
      Object.assign(release, {
        bindSession: async () => {
          throw new Error("disk full");
        },
      }),
    trackerOverrides: async () => [],
    herdr: report,
    start: async (options) => {
      options.onServerStarted?.(42);
      return { threadId: "thread", viewArgs: [], send, close, interrupt: async () => true };
    },
  });
  expect(
    await adapter.start(
      { harness: "codex", cwd: "/test", brief: "work" },
      {
        paneId: "w1:p1",
        run: async () => {},
      },
    ),
  ).toMatchObject({ outcome: "failed", detail: expect.stringContaining("disk full") });
  expect(send).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalled();
});

function durableFixture() {
  const root = mkdtempSync(join(tmpdir(), "local-codex-durable-"));
  const path = join(root, "seats.json");
  const binding = { runtime: "external" as const, session: "default", socketPath: "/trusted/socket" };
  const occupant = occupantIdForHerdrSession({ source: "herdr:codex", kind: "id", value: "thread" });
  let current = binding;
  let start: string | undefined = "original";
  let native: string | undefined = occupant;
  const observeOccupant = vi.fn(async () => native);
  return {
    root,
    path,
    binding,
    occupant,
    observeOccupant,
    create: () =>
      new LocalCodexSeats(
        () => current,
        async () => start,
        { path, observeOccupant },
      ),
    setStart: (value: string | undefined) => {
      start = value;
    },
    setNative: (value: string | undefined) => {
      native = value;
    },
    setBinding: (value: typeof binding) => {
      current = value;
    },
  };
}

it("retains only completed launch bindings and durably revokes mismatched threads and released seats", async () => {
  const f = durableFixture();
  try {
    const registry = f.create();
    const release = registry.register(42, "w1:p1");
    expect(await f.create().allows([55, 42], "w1:p1", f.binding)).toBe(false);
    await release.bindSession?.("thread");
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    expect(await f.create().allows([55, 42], "w1:p1", f.binding, f.occupant)).toBe(true);
    await release.bindSession?.("replacement-thread");
    expect(await f.create().allows([55, 42], "w1:p1", f.binding)).toBe(false);
    const replacement = registry.register(42, "w1:p1");
    await replacement.bindSession?.("thread");
    release();
    expect(await f.create().allows([55, 42], "w1:p1", f.binding)).toBe(true);
    replacement();
    expect(await f.create().allows([55, 42], "w1:p1", f.binding)).toBe(false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

it.each(["pid", "lifetime", "pane", "socket", "session", "native", "missing-native", "native-error"])(
  "does not admit a restored seat with changed %s proof",
  async (changed) => {
    const f = durableFixture();
    try {
      const registration = f.create().register(42, "w1:p1");
      await registration.bindSession?.("thread");
      const restarted = f.create();
      expect(await restarted.allows([55, 42], "w1:p1", f.binding)).toBe(true);
      if (changed === "lifetime") f.setStart("reused");
      if (changed === "socket") f.setBinding({ ...f.binding, socketPath: "/other/socket" });
      if (changed === "session") f.setBinding({ ...f.binding, session: "other" });
      if (changed === "native") f.setNative("another-occupant");
      if (changed === "missing-native") f.setNative(undefined);
      if (changed === "native-error") f.observeOccupant.mockRejectedValue(new Error("pane disappeared"));
      expect(
        await restarted.allows(
          changed === "pid" ? [55, 43] : [55, 42],
          changed === "pane" ? "w1:p2" : "w1:p1",
          f.binding,
        ),
      ).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

it.each(["release", "replacement"])(
  "does not persist a registration after %s during lifetime capture",
  async (change) => {
    const f = durableFixture();
    let captured!: (start: string) => void;
    const registry = new LocalCodexSeats(
      () => f.binding,
      () =>
        new Promise<string>((resolve) => {
          captured = resolve;
        }),
      { path: f.path, observeOccupant: f.observeOccupant },
    );
    try {
      const registration = registry.register(42, "w1:p1");
      const pending = registration.bindSession?.("thread");
      // Keep the original capture handle when replacing the registration.
      const finishOriginal = captured;
      if (change === "release") registration();
      else registry.register(42, "w1:p2");
      finishOriginal("original");
      await pending;
      expect(JSON.parse(readFileSync(f.path, "utf8")).seats).toEqual([]);
      expect(await f.create().allows([55, 42], "w1:p1", f.binding)).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

it("fails closed on corrupt controller launch records", () => {
  const f = durableFixture();
  try {
    writeFileSync(f.path, "corrupt");
    expect(() => f.create()).toThrow("Private Codex launch records are unreadable");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
