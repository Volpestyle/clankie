import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { ExecutionConnections } from "../src/herdr-session.ts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { runRuntimeCommand } from "../../tui/src/command/runtime.ts";
import { readHerdrBinding, herdrConnection } from "../../tui/src/session/herdr-connection.ts";

it("connects two pinned runtimes through API/CLI, survives restart, and never adopts the calling terminal", async () => {
  const root = await mkdtemp("/tmp/clankie-runtime-connections-");
  const settings = new SettingsStore(join(root, "settings.json"));
  const sockets = new Set(["/tmp/one.sock", "/tmp/two.sock", "/tmp/other.sock"]);
  const commands: string[][] = [];
  const options = {
    settings,
    primary: { binding: () => undefined, status: () => "disabled" },
    env: { HERDR_SOCKET_PATH: "/tmp/ambient.sock", HERDR_PANE_ID: "someone-else" },
    run: async (_command: string, args: readonly string[], env: NodeJS.ProcessEnv) => {
      commands.push([...args]);
      expect(env.HERDR_PANE_ID).toBeUndefined();
      if (args[0] === "session")
        return { stdout: JSON.stringify({ sessions: [{ name: "one", socket_path: "/tmp/one.sock" }] }) };
      expect(args).toEqual(["api", "snapshot"]);
      if (!sockets.has(env.HERDR_SOCKET_PATH!)) throw new Error("offline");
      return { stdout: JSON.stringify({ result: { snapshot: { workspaces: [] } } }) };
    },
  };
  let runtimes = new ExecutionConnections(options);
  let reloadSupported = true;
  const app = await createClankieApp({
    captain: createStubCaptain(),
    swarm: {
      status: async () => ({ mode: "unavailable" }),
      syncRuntimeConnections: async () => {
        if (!reloadSupported) throw new Error("Coordinator upgrade required");
      },
    },
    get runtimes() {
      return runtimes;
    },
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });
  const cli = {
    host: "http://localhost",
    env: { CLANKIE_OPERATOR_TOKEN: "owner" },
    fetchImpl: (async (url, init) => app.app.request(new Request(String(url), init))) as typeof fetch,
  };
  try {
    expect((await app.app.request("/v1/runtime-connections")).status).toBe(401);
    expect((await app.app.request("/v1/connections")).status).toBe(401);
    expect(await runRuntimeCommand(["connect", "one", "--session", "one"], cli)).toMatchObject({
      id: "one",
      socketPath: "/tmp/one.sock",
    });
    expect(await runRuntimeCommand(["connect", "two", "--socket", "/tmp/two.sock"], cli)).toMatchObject({
      id: "two",
      socketPath: "/tmp/two.sock",
    });
    runtimes = new ExecutionConnections(options);
    const listed = await runRuntimeCommand(["list"], cli);
    expect(listed.connections).toMatchObject([
      { id: "default", state: "disabled" },
      { id: "one", state: "healthy" },
      { id: "two", state: "healthy" },
    ]);
    expect(await runRuntimeCommand(["inventory"], cli)).toMatchObject({
      runtimes: listed.connections,
      swarms: { mode: "unavailable" },
      accounts: { linear: { status: "unavailable" } },
    });
    const binding = await readHerdrBinding({ ...cli, repoRoot: root, connectionId: "two" });
    expect(binding.socketPath).toBe("/tmp/two.sock");
    expect(herdrConnection(binding, { repoRoot: root, env: options.env }).env).toMatchObject({
      HERDR_SOCKET_PATH: "/tmp/two.sock",
    });
    expect(herdrConnection(binding, { repoRoot: root, env: options.env }).env.HERDR_PANE_ID).toBeUndefined();
    await expect(runRuntimeCommand(["connect", "one", "--socket", "/tmp/other.sock"], cli)).rejects.toThrow(
      /pinned/u,
    );
    await expect(
      runRuntimeCommand(["connect", "duplicate", "--socket", "/tmp/two.sock"], cli),
    ).rejects.toThrow(/already/u);
    reloadSupported = false;
    await expect(runRuntimeCommand(["disconnect", "one"], cli)).rejects.toThrow(/upgrade required/u);
    await expect(runRuntimeCommand(["connect", "three", "--socket", "/tmp/other.sock"], cli)).rejects.toThrow(
      /upgrade required/u,
    );
    expect((await settings.load()).execution.connections).toMatchObject([
      { id: "one", enabled: true },
      { id: "two", enabled: true },
    ]);
    reloadSupported = true;
    await runRuntimeCommand(["disconnect", "one"], cli);
    expect(await runtimes.binding("one")).toBeUndefined();
    sockets.delete("/tmp/two.sock");
    expect(await runtimes.binding("two")).toBeUndefined();
    expect(await runtimes.list()).toMatchObject([
      { id: "default" },
      { id: "one", state: "disabled" },
      { id: "two", state: "unavailable" },
    ]);
    expect(commands.every((args) => args[0] === "api" || args[0] === "session")).toBe(true);
    await expect(
      runRuntimeCommand(["connect", "default", "--socket", "/tmp/other.sock"], cli),
    ).rejects.toThrow(/400/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("serves bounded connection metadata through the operator client and refuses social callers", async () => {
  const { createOperatorConversationServiceClient, OperatorConversationServiceResultSchema } =
    await import("@clankie/protocol");
  const root = await mkdtemp("/tmp/clankie-connections-relay-");
  const settings = new SettingsStore(join(root, "settings.json"));
  const runtimes = new ExecutionConnections({
    settings,
    primary: { binding: () => undefined, status: () => "disabled" },
    run: async () => ({ stdout: JSON.stringify({ result: { snapshot: { workspaces: [] } } }) }),
  });
  await runtimes.connect({
    id: "named",
    socketPath: "/tmp/pinned.sock",
    capacity: 2,
    capabilities: ["review"],
  });
  let disconnected = "";
  const app = await createClankieApp({
    captain: createStubCaptain(),
    runtimes,
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer operator"
        ? { captainId: "owner", steerSourceLane: "api" }
        : request.headers.get("authorization") === "Bearer social"
          ? { captainId: "social", steerSourceLane: "discord_text" }
          : undefined,
    swarm: {
      status: async () => ({
        connections: [
          {
            id: "remote",
            conversationId: "project",
            enabled: true,
            scope: "scope",
            actor: "lead",
            credential: "secret-reference",
          },
        ],
        conversations: [
          {
            connection: "remote",
            conversationId: "project",
            actor: "lead",
            state: {
              scope: "scope",
              sessions: {
                items: [
                  {
                    actor: "worker",
                    generation: 1,
                    state: "active",
                    runtime: "available",
                    capability: "secret",
                  },
                ],
                truncated: true,
              },
              arbitrary: "must-not-leak",
            },
          },
        ],
      }),
      disconnect: async (id) => {
        disconnected = id;
      },
    },
  });
  const call = (body: unknown, bearer = "operator") =>
    app.app.request("/operator/v1/dispatch", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const client = createOperatorConversationServiceClient(async (request) =>
    OperatorConversationServiceResultSchema.parse(await (await call(request)).json()),
  );
  try {
    const result = await client.connections!();
    expect(result).toMatchObject({
      outcome: "ready",
      inventory: {
        runtimes: [{ id: "default" }, { id: "named", capacity: 2 }],
        swarms: [
          {
            id: "remote",
            state: "connected",
            agents: [{ id: "worker", generation: 1 }],
            agentsTruncated: true,
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|must-not-leak|pinned.sock/u);
    expect(
      (await call({ op: "connections", schemaVersion: 1, command: { action: "list" } }, "social")).status,
    ).toBe(403);
    expect(
      (
        await call({
          op: "connections",
          schemaVersion: 1,
          command: { action: "connect_runtime", id: "bad", session: "../../other" },
        })
      ).status,
    ).toBe(400);
    expect(await client.connections!({ action: "disconnect_runtime", id: "named" })).toMatchObject({
      outcome: "ready",
    });
    expect(await client.connections!({ action: "reconnect_runtime", id: "named" })).toMatchObject({
      outcome: "ready",
    });
    expect((await settings.load()).execution.connections).toMatchObject([
      { id: "named", socketPath: "/tmp/pinned.sock", capacity: 2, capabilities: ["review"], enabled: true },
    ]);
    await client.connections!({ action: "disconnect_swarm", id: "remote" });
    expect(disconnected).toBe("remote");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("only the operator can approve repositories and exact directories through runtime CLI/API", async () => {
  const root = realpathSync(await mkdtemp("/tmp/clankie-execution-policy-"));
  const repo = join(root, "repo"),
    plain = join(root, "plain"),
    alias = join(root, "alias");
  await mkdir(repo);
  await mkdir(plain);
  await symlink(repo, alias);
  execFileSync("git", ["-C", repo, "init"], { stdio: "pipe" });
  const settings = new SettingsStore(join(root, "settings.json"));
  const options = {
    settings,
    primary: { binding: () => undefined, status: () => "disabled" },
    run: async () => ({ stdout: JSON.stringify({ result: { snapshot: { workspaces: [] } } }) }),
  };
  const runtimes = new ExecutionConnections(options);
  let reloadSupported = true;
  const app = await createClankieApp({
    captain: createStubCaptain(),
    runtimes,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
    authenticateCaptain: async () => ({ captainId: "machine-grant", steerSourceLane: "discord_text" }),
    swarm: {
      status: async () => ({}),
      syncRuntimeConnections: async () => {
        if (!reloadSupported) throw new Error("Coordinator upgrade required");
      },
    },
  });
  const cli = {
    host: "http://localhost",
    env: { CLANKIE_OPERATOR_TOKEN: "owner" },
    fetchImpl: (async (url, init) => app.app.request(new Request(String(url), init))) as typeof fetch,
  };
  try {
    expect((await runtimes.list())[0]).toMatchObject({
      capacity: 16,
      budget: 16,
      capacitySource: "default",
      budgetSource: "default",
    });
    for (const args of [
      ["capacity", "default", "25"],
      ["budget", "25"],
    ]) {
      await expect(
        runRuntimeCommand(args, { ...cli, env: { CLANKIE_OPERATOR_TOKEN: "discord" } }),
      ).rejects.toThrow();
      await runRuntimeCommand(args, cli);
    }
    expect((await runtimes.list())[0]).toMatchObject({
      capacity: 25,
      budget: 25,
      capacitySource: "owner",
      budgetSource: "owner",
    });
    expect(await new ExecutionConnections(options).dispatchBudget()).toBe(25);
    await runRuntimeCommand(["capacity", "default", "--clear"], cli);
    await runRuntimeCommand(["budget", "--clear"], cli);
    expect((await runtimes.list())[0]).toMatchObject({
      capacity: null,
      budget: null,
      capacitySource: "unlimited",
      budgetSource: "unlimited",
    });
    await expect(runRuntimeCommand(["capacity", "default", "-1"], cli)).rejects.toThrow();
    const request = { action: "workspaces", id: "default", workspaces: [{ kind: "repository", path: repo }] };
    expect(
      (
        await app.app.request("/v1/runtime-connections", {
          method: "POST",
          headers: { authorization: "Bearer discord", "content-type": "application/json" },
          body: JSON.stringify(request),
        })
      ).status,
    ).toBe(401);
    expect((await settings.load()).execution.workspaces).toBeUndefined();
    const result = await runRuntimeCommand(["workspaces", "default", "--repo", alias, "--dir", plain], cli);
    const workspaces = [
      { kind: "repository", path: join(repo, ".git") },
      { kind: "directory", path: plain },
    ];
    expect(result).toEqual({ id: "default", workspaces });
    expect((await new ExecutionConnections(options).list())[0]).toMatchObject({ workspaces });
    await runRuntimeCommand(["connect", "named", "--socket", "/tmp/policy.sock"], cli);
    await runRuntimeCommand(["capacity", "named", "100"], cli);
    expect((await runtimes.list())[1]).toMatchObject({ capacity: 100 });
    await runRuntimeCommand(["capacity", "named", "--clear"], cli);
    expect((await runtimes.list())[1]).toMatchObject({ capacity: null });
    await runRuntimeCommand(["workspaces", "named", "--repo", repo], cli);
    await runRuntimeCommand(["disconnect", "named"], cli);
    expect((await settings.load()).execution).toMatchObject({
      workspaces,
      connections: [{ id: "named", enabled: false, workspaces: workspaces.slice(0, 1) }],
    });
    await expect(runRuntimeCommand(["workspaces", "default", "--repo", plain], cli)).rejects.toThrow();
    await writeFile(join(root, "file"), "not a directory");
    await expect(
      runRuntimeCommand(["workspaces", "default", "--dir", join(root, "file")], cli),
    ).rejects.toThrow(/directory/);
    reloadSupported = false;
    await expect(runRuntimeCommand(["workspaces", "default", "--clear"], cli)).rejects.toThrow(/upgrade/);
    expect((await settings.load()).execution.workspaces).toEqual(workspaces);
    reloadSupported = true;
    await runRuntimeCommand(["workspaces", "default", "--clear"], cli);
    expect((await settings.load()).execution.workspaces).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("selects each runtime's worker mode through CLI/API, keeps stream unwritten, and never selects interactive without Swarm support", async () => {
  const { manageConnections } = await import("../src/connections.ts");
  const root = await mkdtemp("/tmp/clankie-worker-mode-");
  const settings = new SettingsStore(join(root, "settings.json"));
  let supported = false;
  const runtimes = new ExecutionConnections({
    settings,
    primary: { binding: () => undefined, status: () => "disabled" },
    run: async () => ({ stdout: JSON.stringify({ result: { snapshot: { workspaces: [] } } }) }),
    interactiveWorkers: async () => supported,
  });
  const swarm = { status: async () => ({ mode: "unavailable" }), syncRuntimeConnections: async () => {} };
  const app = await createClankieApp({
    captain: createStubCaptain(),
    swarm,
    runtimes,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });
  const cli = {
    host: "http://localhost",
    env: { CLANKIE_OPERATOR_TOKEN: "owner" },
    fetchImpl: (async (url, init) => app.app.request(new Request(String(url), init))) as typeof fetch,
  };
  const named = async () =>
    (await settings.load()).execution.connections.find((entry) => entry.id === "named");
  try {
    await runRuntimeCommand(["connect", "named", "--socket", "/tmp/named.sock"], cli);
    expect((await runRuntimeCommand(["list"], cli)).connections).toMatchObject([
      { id: "default", workerMode: "stream" },
      { id: "named", workerMode: "stream" },
    ]);
    expect(await named()).not.toHaveProperty("workerMode");
    await expect(runRuntimeCommand(["mode", "named", "sideways"], cli)).rejects.toThrow(/mode ID/u);
    // The vendored owner would reject the route, and with it every route.
    await expect(runRuntimeCommand(["mode", "named", "interactive"], cli)).rejects.toThrow(
      /upgraded Swarm runtime/u,
    );
    await expect(
      runtimes.connect({ id: "named", socketPath: "/tmp/named.sock", workerMode: "interactive" }),
    ).rejects.toThrow(/upgraded Swarm runtime/u);
    expect(await named()).not.toHaveProperty("workerMode");
    supported = true;
    expect(await runRuntimeCommand(["mode", "named", "interactive"], cli)).toEqual({
      id: "named",
      workerMode: "interactive",
    });
    await expect(runRuntimeCommand(["mode", "missing", "interactive"], cli)).rejects.toThrow(/Unknown/u);
    expect(await named()).toMatchObject({ workerMode: "interactive" });
    // A paired-device reconnect carries the owner's choice through.
    await manageConnections({ runtimes, swarm }, { action: "disconnect_runtime", id: "named" });
    const inventory = await manageConnections(
      { runtimes, swarm },
      { action: "reconnect_runtime", id: "named" },
    );
    expect(inventory.runtimes).toMatchObject([
      { id: "default", workerMode: "stream" },
      { id: "named", enabled: true, workerMode: "interactive" },
    ]);
    await runRuntimeCommand(["mode", "named", "stream"], cli);
    expect(await named()).not.toHaveProperty("workerMode");
    await runRuntimeCommand(["mode", "default", "interactive"], cli);
    expect((await settings.load()).execution.workerMode).toBe("interactive");
    await runRuntimeCommand(["mode", "default", "stream"], cli);
    expect((await settings.load()).execution).not.toHaveProperty("workerMode");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("selects managed harnesses through API/CLI and rejects unsupported harness-mode pairs without changing settings", async () => {
  const root = await mkdtemp("/tmp/clankie-worker-harness-");
  const settings = new SettingsStore(join(root, "settings.json"));
  let supported = false;
  const runtimes = new ExecutionConnections({
    settings,
    primary: { binding: () => undefined, status: () => "disabled" },
    managedWorkers: async () => supported,
    interactiveWorkers: async () => true,
  });
  const app = await createClankieApp({
    captain: createStubCaptain(),
    runtimes,
    authenticateOperator: async () => ({ operatorId: "owner" }),
  });
  const cli = {
    host: "http://localhost",
    env: { CLANKIE_OPERATOR_TOKEN: "owner" },
    fetchImpl: (async (url, init) => app.app.request(new Request(String(url), init))) as typeof fetch,
  };
  try {
    const refused = await app.app.request("/v1/runtime-connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "harness", id: "default", harness: "codex" }),
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "harness_unsupported" });
    expect((await settings.load()).execution.workerHarness).toBeUndefined();
    supported = true;
    for (const harness of ["codex", "pi", "claude"]) {
      expect(await runRuntimeCommand(["harness", "default", harness], cli)).toEqual({
        id: "default",
        workerHarness: harness,
      });
      expect((await settings.load()).execution.workerHarness).toBe(harness);
    }
    await runRuntimeCommand(["harness", "default", "codex"], cli);
    await expect(runRuntimeCommand(["mode", "default", "interactive"], cli)).rejects.toThrow(
      /require stream/u,
    );
    expect((await settings.load()).execution).toMatchObject({ workerHarness: "codex" });
    await expect(runRuntimeCommand(["harness", "default", "unknown"], cli)).rejects.toThrow(/harness ID/u);
    expect((await runRuntimeCommand(["list"], cli)).connections).toMatchObject([
      { id: "default", workerHarness: "codex", workerMode: "stream" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
