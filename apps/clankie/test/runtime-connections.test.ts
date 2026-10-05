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

async function prepareFixture() {
  const root = await mkdtemp("/tmp/clankie-runtime-prepare-");
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    machines: [{ id: "pc", ssh: "fixture.invalid", shell: "posix", aliases: [] }],
    execution: {
      connections: [
        {
          id: "pc",
          machine: "pc",
          kind: "herdr",
          session: "default",
          ssh: { host: "fixture.invalid", shell: "posix" },
          enabled: true,
          capabilities: ["code"],
        },
      ],
    },
  }));
  const runtimes = new ExecutionConnections({
    settings,
    primary: { binding: () => undefined, status: () => "disabled" },
    fleetRun: () => async () => JSON.stringify({ result: { snapshot: { workspaces: [] } } }),
  });
  return { root, settings, runtimes };
}

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
  const app = await createClankieApp({
    captain: createStubCaptain(),
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
  const app = await createClankieApp({
    captain: createStubCaptain(),
    runtimes,
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer operator"
        ? { captainId: "owner", steerSourceLane: "api" }
        : request.headers.get("authorization") === "Bearer social"
          ? { captainId: "social", steerSourceLane: "discord_text" }
          : undefined,
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
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|must-not-leak|pinned.sock/u);
    for (const command of [
      { action: "discover" },
      { action: "add_machine", id: "pc", ssh: "pc", shell: "posix" },
      { action: "remove_machine", id: "pc" },
    ]) {
      expect((await call({ op: "connections", schemaVersion: 1, command }, "social")).status).toBe(403);
    }
    expect((await settings.load()).machines).toEqual([]);
    expect((await app.app.request("/v1/machines")).status).toBe(503);
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
  const app = await createClankieApp({
    captain: createStubCaptain(),
    runtimes,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
    authenticateCaptain: async () => ({ captainId: "machine-grant", steerSourceLane: "discord_text" }),
  });
  const cli = {
    host: "http://localhost",
    env: { CLANKIE_OPERATOR_TOKEN: "owner" },
    fetchImpl: (async (url, init) => app.app.request(new Request(String(url), init))) as typeof fetch,
  };
  try {
    expect((await runtimes.list())[0]).toMatchObject({
      capacity: 16,
      capacitySource: "default",
    });
    for (const args of [["capacity", "default", "25"]]) {
      await expect(
        runRuntimeCommand(args, { ...cli, env: { CLANKIE_OPERATOR_TOKEN: "discord" } }),
      ).rejects.toThrow();
      await runRuntimeCommand(args, cli);
    }
    expect((await runtimes.list())[0]).toMatchObject({
      capacity: 25,
      capacitySource: "owner",
    });
    await runRuntimeCommand(["capacity", "default", "--clear"], cli);
    expect((await runtimes.list())[0]).toMatchObject({
      capacity: null,
      capacitySource: "unlimited",
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
    await runRuntimeCommand(["workspaces", "default", "--clear"], cli);
    expect((await settings.load()).execution.workspaces).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reports remote harness diagnostics only to the owner through the registered fleet inspection port", async () => {
  const seen: string[] = [];
  const app = await createClankieApp({
    captain: createStubCaptain(),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
    inspectFleetHarnesses: async (id) => {
      seen.push(id);
      return { claude: [{ profile: "remote", versionMatches: false }], codex: { registered: false } };
    },
  });
  try {
    expect((await app.app.request("/v1/runtime-connections/pc/harnesses")).status).toBe(401);
    expect(seen).toEqual([]);
    const result = await runRuntimeCommand(["harnesses", "pc"], {
      host: "http://localhost",
      env: { CLANKIE_OPERATOR_TOKEN: "owner" },
      fetchImpl: (async (url, init) => app.app.request(new Request(String(url), init))) as typeof fetch,
    });
    expect(result).toMatchObject({ machine: "pc", harnesses: { claude: [{ versionMatches: false }] } });
    expect(seen).toEqual(["pc"]);
  } finally {
    await app.close();
  }
});

it("prepares registered fleets only for the owner and passes remote source setup through the CLI/API", async () => {
  const f = await prepareFixture();
  const seen: Array<{ id: string; options: { codexSourceSetup?: string } }> = [];
  const app = await createClankieApp({
    settings: f.settings,
    runtimes: f.runtimes,
    captain: createStubCaptain(),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
    authenticateCaptain: async () => ({ captainId: "captain", steerSourceLane: "api" }),
    fleetLinks: { authenticate: (token) => (token === "fleet" ? "pc" : undefined) },
    prepareFleet: async (id, options) => {
      seen.push({ id, options });
      return { machine: id, codex: { plugin: true, bridge: true, forwarding: true } };
    },
  });
  const cli = {
    cwd: f.root,
    host: "http://localhost",
    env: { CLANKIE_OPERATOR_TOKEN: "owner" },
    fetchImpl: (async (url, init) => app.app.request(new Request(String(url), init))) as typeof fetch,
  };
  try {
    for (const authorization of [undefined, "Bearer captain", "Bearer fleet"]) {
      const denied = await app.app.request("/v1/runtime-connections/pc/prepare", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization === undefined ? {} : { authorization }),
        },
        body: JSON.stringify({ codexSourceSetup: "C:\\Owner Source\\setup.py" }),
      });
      expect(denied.status).toBe(401);
    }
    expect(seen).toEqual([]);
    expect(await runRuntimeCommand(["prepare", "pc"], cli)).toMatchObject({ ok: true });
    for (const codexSourceSetup of [
      "/owner/source/setup.py",
      "C:\\Owner Source\\setup.py",
      "\\\\pc\\source\\setup.py",
    ]) {
      const before = seen.length;
      await expect(
        runRuntimeCommand(["prepare", "pc", "--codex-source-setup", codexSourceSetup], cli),
      ).rejects.toThrow();
      expect(seen).toHaveLength(before);
      const claimed = await app.app.request("/v1/runtime-connections/pc/prepare", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer owner" },
        body: JSON.stringify({ workingDirectory: f.root, ownerApproved: true, codexSourceSetup }),
      });
      expect(claimed.status).toBe(200);
      expect(await claimed.json()).toMatchObject({ ok: true, ownerApproval: "claimed" });
    }
    expect(seen).toEqual([
      { id: "pc", options: {} },
      { id: "pc", options: { codexSourceSetup: "/owner/source/setup.py" } },
      { id: "pc", options: { codexSourceSetup: "C:\\Owner Source\\setup.py" } },
      { id: "pc", options: { codexSourceSetup: "\\\\pc\\source\\setup.py" } },
    ]);
  } finally {
    await app.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

it("refuses malformed prepare bodies and unknown fields before fleet preparation", async () => {
  const seen: string[] = [];
  const app = await createClankieApp({
    captain: createStubCaptain(),
    authenticateOperator: async () => ({ operatorId: "owner" }),
    prepareFleet: async (id) => {
      seen.push(id);
      return {};
    },
  });
  try {
    const bodies = [
      "{",
      "null",
      "[]",
      JSON.stringify("/setup.py"),
      JSON.stringify({ codexSourceSetup: null }),
      JSON.stringify({ codexSourceSetup: 123 }),
      JSON.stringify({ codexSourceSetup: { command: "/setup.py", args: [] } }),
      JSON.stringify({ codexSourceSetup: "" }),
      JSON.stringify({ codexSourceSetup: "relative/setup.py" }),
      JSON.stringify({ codexSourceSetup: "~/setup.py" }),
      JSON.stringify({ codexSourceSetup: "C:setup.py" }),
      JSON.stringify({ codexSourceSetup: "/setup.py\nother" }),
      JSON.stringify({ codexSourceSetup: "/setup.py\u0000" }),
      JSON.stringify({ host: "unregistered" }),
      JSON.stringify({ codexSourceSetup: "/setup.py", args: ["--login"] }),
    ];
    for (const body of bodies) {
      const result = await app.app.request("/v1/runtime-connections/pc/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(result.status, body).toBe(400);
      expect(await result.json()).toEqual({ error: "invalid_fleet_prepare" });
    }
    expect(seen).toEqual([]);
  } finally {
    await app.close();
  }
});

it("returns incomplete native Codex preparation as a conflict and preserves the repair detail for the CLI", async () => {
  const f = await prepareFixture();
  const detail =
    "Codex preparation incomplete on pc: missing native plugin, Clankie bridge, forwarding. Inspect clankie doctor; managed configuration requires --codex-source-setup.";
  const app = await createClankieApp({
    settings: f.settings,
    runtimes: f.runtimes,
    captain: createStubCaptain(),
    authenticateOperator: async () => ({ operatorId: "owner" }),
    prepareFleet: async () => {
      throw new Error(detail);
    },
  });
  try {
    const result = await app.app.request("/v1/runtime-connections/pc/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workingDirectory: f.root }),
    });
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ error: "fleet_prepare_failed", detail });
    await expect(
      runRuntimeCommand(["prepare", "pc"], {
        cwd: f.root,
        host: "http://localhost",
        env: { CLANKIE_OPERATOR_TOKEN: "owner" },
        fetchImpl: (async (url, init) => app.app.request(new Request(String(url), init))) as typeof fetch,
      }),
    ).rejects.toThrow(detail);
  } finally {
    await app.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
