import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { OPERATOR_CONVERSATION_DISPATCH_PATH } from "@clankie/protocol";
import { startHerdrConnection } from "../src/herdr-session.ts";
import { createClankieApp } from "../src/app.ts";
import { Evaluator } from "../src/captain/evaluator.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { captainTools } from "../src/captain/tools.ts";
import type { LaneLog } from "../src/captain/lane-log.ts";
import { createHerdrWatchRunner, type HerdrWatchPort } from "../src/captain/herdr-watch.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function input() {
  const root = await mkdtemp(join(tmpdir(), "clankie-optional-herdr-"));
  roots.push(root);
  return {
    settings: { runtime: "auto" as const, session: "default" },
    repoRoot: root,
    stateRoot: root,
    env: { HERDR_SOCKET_PATH: "/tmp/unrelated.sock", HERDR_PANE_ID: "w1:p1" } as NodeJS.ProcessEnv,
    warn: vi.fn(),
  };
}

test("disabled execution does not probe or start Herdr and excludes ambient routing", async () => {
  const options = await input();
  const start = vi.fn();
  const connection = await startHerdrConnection(
    { ...options, settings: { ...options.settings, runtime: "disabled" } },
    { start },
  );
  expect(start).not.toHaveBeenCalled();
  expect(connection.status()).toBe("disabled");
  expect(connection.binding()).toBeUndefined();
  expect(options.env.HERDR_PANE_ID).toBeUndefined();
  expect(options.env.HERDR_SOCKET_PATH).toBe(join(options.stateRoot, "herdr/unavailable.sock"));
  await connection.close();
});

test("missing Herdr is a capability failure, not a boot failure", async () => {
  const options = await input();
  const connection = await startHerdrConnection(options, {
    start: async () => {
      throw new Error("Herdr is not installed");
    },
  });
  expect(connection.status()).toBe("unavailable");
  expect(connection.available()).toBe(false);
  expect(options.warn).toHaveBeenCalledWith(expect.stringContaining("not installed"));
  expect(options.env.HERDR_SOCKET_PATH).not.toBe("/tmp/unrelated.sock");
  await connection.close();
});

test("losing an external runtime preserves its identity without spawning a replacement", async () => {
  const options = await input();
  const start = vi.fn();
  let lost!: () => void;
  const close = vi.fn();
  const connection = await startHerdrConnection(options, {
    resolve: async (_settings, env) => {
      env!.HERDR_SOCKET_PATH = "/tmp/selected.sock";
      return { runtime: "external", session: "selected", socketPath: "/tmp/selected.sock" };
    },
    start,
    watch: ({ onLost }) => {
      lost = onLost;
      return { close };
    },
  });
  expect(connection.binding()?.session).toBe("selected");
  lost();
  expect(connection.available()).toBe(false);
  expect(options.env.HERDR_SOCKET_PATH).toBe("/tmp/selected.sock");
  expect(start).not.toHaveBeenCalled();
  await connection.close();
  expect(close).toHaveBeenCalledOnce();
});

test("an owned runtime keeps its configured plugin environment and reports recovery separately", async () => {
  const options = await input();
  let state: "healthy" | "recovering" = "healthy";
  const close = vi.fn(async () => {});
  const connection = await startHerdrConnection(options, {
    start: async ({ env }) => {
      env.HERDR_SOCKET_PATH = "/tmp/owned.sock";
      env.HERDR_PLUGIN_STATE_DIR = "/tmp/owned-plugin";
      return { status: () => state, close };
    },
  });
  expect(options.env.HERDR_PLUGIN_STATE_DIR).toBe("/tmp/owned-plugin");
  expect(connection.available()).toBe(true);
  state = "recovering";
  expect(connection.status()).toBe("recovering");
  expect(connection.binding()).toBeUndefined();
  await connection.close();
  expect(close).toHaveBeenCalledOnce();
});

test("a real captain serves conversations without Herdr and refuses terminal operations", async () => {
  const options = await input();
  const captain = createCaptain({ herdrAvailable: () => false } as CaptainDeps, {
    repoRoot: options.repoRoot,
    stateDir: options.stateRoot,
    settings: new SettingsStore(join(options.stateRoot, "settings.json")),
  });
  const app = await createClankieApp({
    captain,
    herdrRuntime: () => "disabled",
    herdrBinding: () => undefined,
    authenticateCaptain: async () => ({ captainId: "operator", steerSourceLane: "api" }),
  });
  try {
    expect((await app.app.request("/health")).status).toBe(200);
    const dispatch = (op: object) =>
      app.app.request(OPERATOR_CONVERSATION_DISPATCH_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, ...op }),
      });
    expect((await dispatch({ op: "list" })).status).toBe(200);
    const refused = await dispatch({ op: "close_seat", seatId: "unrelated-seat" });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: "herdr_unavailable" });
    const catalog = await dispatch({ op: "terminal_catalog" });
    expect(await catalog.json()).toMatchObject({ sessions: [] });
  } finally {
    app.close();
    await captain.close();
  }
});

test("an already registered Herdr watch tool checks current capability before calling", async () => {
  let available = true;
  const watch = vi.fn();
  const tools = captainTools(
    { herdrAvailable: () => available, embodiment: {} } as CaptainDeps,
    { targetId: "conversation" },
    {} as LaneLog,
    "operator",
    undefined,
    undefined,
    { watch } as unknown as HerdrWatchPort,
  );
  const tool = tools.find((tool) => tool.name === "herdr_watch")!;
  available = false;
  const result = await tool.execute(
    "test",
    { agent: "w1:p1", reason: "result" },
    undefined,
    undefined,
    {} as never,
  );
  expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("herdr_unavailable") }]);
  expect(watch).not.toHaveBeenCalled();
});

test("existing watches refuse process operations after execution becomes unavailable", async () => {
  let available = true;
  const runner = createHerdrWatchRunner(() => available);
  available = false;
  await expect(runner.get("w1:p1")).rejects.toThrow("Herdr execution is unavailable");
  await expect(runner.sendText!("w1:p1", "do work")).rejects.toThrow("Herdr execution is unavailable");
  await expect(runner.closePane!("w1:p1")).rejects.toThrow("Herdr execution is unavailable");
});

test("optional evaluator preserves queued work without starting an unavailable runtime", async () => {
  const options = await input();
  const evaluator = new Evaluator(join(options.stateRoot, "evaluator"), { available: () => false });
  try {
    await evaluator.command({ action: "enable" });
    evaluator.capture({ conversationId: "work", runId: "one", context: { request: "review result" } });
    await evaluator.tick(true);
    expect(evaluator.status()).toMatchObject({
      enabled: true,
      queued: 1,
      error: expect.stringContaining("unavailable"),
    });
    expect(evaluator.status().paneId).toBeUndefined();
  } finally {
    evaluator.close();
  }
});
