import { createAgentSessions } from "../src/agent-sessions.ts";
import { createAgentSessionRoutes } from "../src/agent-session-routes.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { Machines, sshConfigHosts, readSshConfig } from "../src/machines.ts";
import { ExecutionConnections } from "../src/herdr-session.ts";
import { MachineInventorySchema, OperatorConnectionCommandSchema } from "@clankie/protocol";
import { routeHerdrFleets } from "../src/captain/herdr-fleet-runner.ts";
import { type HerdrWatchRunner } from "../src/captain/herdr-watch.ts";

test("discovery reads literal owner aliases without prompts, retains unreachable candidates and caches", async () => {
  const dir = await mkdtemp("/tmp/clankie-machine-discovery-");
  try {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const machines = new Machines({
      settings: new SettingsStore(join(dir, "settings.json")),
      primary: () => undefined,
      changed: () => {},
      sshConfig: async () => "Host pc offline *.internal !skip\nHost pc",
      run: async (cmd, args, env) => {
        calls.push({ cmd, args });
        expect(env.HERDR_PANE_ID).toBeUndefined();
        if (cmd === "ssh") {
          expect(args).toContain("BatchMode=yes");
          expect(args).toContain("StrictHostKeyChecking=yes");
          if (args.includes("offline")) throw new Error("offline");
        }
        return { stdout: JSON.stringify({ sessions: [] }) };
      },
    });
    expect(sshConfigHosts("Host pc *.foo !deny\nHost pc laptop")).toEqual(["pc", "laptop"]);
    const result = MachineInventorySchema.parse(await machines.list());
    expect(result.machines).toMatchObject([
      { id: "local", configured: true, state: "available" },
      { id: "pc", configured: false, state: "available" },
      { id: "offline", state: "unreachable" },
    ]);
    const count = calls.length;
    await machines.list();
    expect(calls).toHaveLength(count);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("slow discovery has a global deadline and at most four probes", async () => {
  const dir = await mkdtemp("/tmp/clankie-machine-deadline-");
  vi.useFakeTimers();
  try {
    let calls = 0;
    const machines = new Machines({
      settings: new SettingsStore(join(dir, "settings.json")),
      primary: () => undefined,
      changed: () => {},
      sshConfig: async () => Array.from({ length: 30 }, (_, i) => `Host host${i}`).join("\n"),
      run: async () => {
        calls++;
        return new Promise(() => {});
      },
    });
    const pending = machines.list();
    await vi.waitFor(() => expect(calls).toBe(4));
    await vi.advanceTimersByTimeAsync(6500);
    const result = await pending;
    expect(result.machines).toHaveLength(31);
    expect(result.machines.every((entry) => entry.state !== "available")).toBe(true);
  } finally {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  }
});

test("add registers transcripts immediately; remove detaches connections and never runs a stop command", async () => {
  const dir = await mkdtemp("/tmp/clankie-machine-lifecycle-");
  try {
    const settings = new SettingsStore(join(dir, "settings.json"));
    const calls: string[][] = [];
    const runtimes = new ExecutionConnections({
      settings,
      primary: { binding: () => undefined, status: () => "disabled" },
      fleetRun: () => async (args) => {
        calls.push([...args]);
        return JSON.stringify({ result: { snapshot: {} } });
      },
    });
    const changes: string[] = [];
    runtimes.onChange(async (id) => {
      await Promise.resolve();
      changes.push(id);
    });
    await runtimes.machines.add({ id: "pc", ssh: "pc", shell: "posix" });
    expect((await settings.load()).agentHosts.connections).toEqual([{ id: "pc", ssh: "pc", shell: "posix" }]);
    await runtimes.connect({ id: "work", machine: "pc", session: "work" });
    expect(await runtimes.fleets()).toMatchObject([{ id: "work", session: "work" }]);
    expect(await runtimes.remoteWorkspace("work", "/ungranted")).toBe(false);
    await runtimes.machines.remove("pc");
    expect(await runtimes.fleets()).toEqual([]);
    expect((await settings.load()).agentHosts.connections).toEqual([]);
    expect(changes).toContain("work");
    expect(calls).toEqual([["api", "snapshot"]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime routing observes add and removal live without redirecting qualified IDs", async () => {
  const get = vi.fn(async () => ({ paneId: "w2:p1J", terminalId: "term" }));
  const local = { get } as unknown as HerdrWatchRunner;
  const current = new Map<string, HerdrWatchRunner>();
  const routed = routeHerdrFleets(local, async () => current);
  await expect(routed.get("pc/w2:p1J")).rejects.toThrow("Unknown");
  current.set("pc", local);
  expect(await routed.get("pc/w2:p1J")).toMatchObject({ paneId: "pc/w2:p1J" });
  current.delete("pc");
  await expect(routed.get("pc/w2:p1J")).rejects.toThrow("Unknown");
  expect(get).toHaveBeenCalledTimes(1);
  expect(
    OperatorConnectionCommandSchema.parse({
      action: "connect_runtime",
      id: "pc",
      machine: "desktop",
      session: "work",
    }),
  ).toMatchObject({ machine: "desktop" });
});

test("discovery never counts a replacement local session as the pinned connection", async () => {
  const dir = await mkdtemp("/tmp/clankie-machine-pinned-");
  try {
    const settings = new SettingsStore(join(dir, "settings.json"));
    await settings.update((current) => ({
      ...current,
      execution: {
        connections: [
          {
            id: "work",
            kind: "herdr",
            session: "work",
            socketPath: "/tmp/old.sock",
            enabled: true,
            capabilities: [],
          },
        ],
      },
    }));
    const machines = new Machines({
      settings,
      primary: () => undefined,
      changed: () => {},
      sshConfig: async () => "",
      run: async (_cmd, args, env) => {
        if (args[0] === "session")
          return { stdout: JSON.stringify({ sessions: [{ name: "work", socket_path: "/tmp/new.sock" }] }) };
        if (env.HERDR_SOCKET_PATH === "/tmp/old.sock") throw new Error("old session unavailable");
        expect(env.HERDR_SOCKET_PATH).toBe("/tmp/new.sock");
        return { stdout: JSON.stringify({ agents: [] }) };
      },
    });
    expect((await machines.list()).machines[0]!.sessions).toMatchObject([
      { connectionId: "work", socketPath: "/tmp/old.sock", state: "unreachable" },
      { socketPath: "/tmp/new.sock", state: "available" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SSH discovery expands owner Includes without duplicating recursive files", async () => {
  const dir = await mkdtemp("/tmp/clankie-machine-ssh-config-");
  try {
    await writeFile(join(dir, "config"), "Host desktop\nInclude more-*.conf\n");
    await writeFile(
      join(dir, "more-hosts.conf"),
      "Host pc laptop\nInclude config\nHost *.private !excluded\n",
    );
    expect(sshConfigHosts(await readSshConfig(join(dir, "config")))).toEqual(["desktop", "pc", "laptop"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed count probe preserves an explicitly disabled connection", async () => {
  const dir = await mkdtemp("/tmp/clankie-machine-disabled-");
  try {
    const settings = new SettingsStore(join(dir, "settings.json"));
    await settings.update((current) => ({
      ...current,
      execution: {
        connections: [
          {
            id: "work",
            kind: "herdr",
            session: "work",
            socketPath: "/tmp/offline.sock",
            enabled: false,
            capabilities: [],
          },
        ],
      },
    }));
    const machines = new Machines({
      settings,
      primary: () => undefined,
      changed: () => {},
      sshConfig: async () => "",
      run: async (_cmd, args) => {
        if (args[0] === "session") return { stdout: JSON.stringify({ sessions: [] }) };
        throw new Error("offline");
      },
    });
    expect((await machines.list()).machines[0]!.sessions).toMatchObject([
      { connectionId: "work", state: "disabled", workerCount: null },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy host aliases refuse retargeting and ambiguous removal, preserving distinct fleet grants", async () => {
  const dir = await mkdtemp("/tmp/clankie-machine-alias-boundary-");
  try {
    const settings = new SettingsStore(join(dir, "settings.json"));
    await settings.update((current) => ({
      ...current,
      agentHosts: { connections: [{ id: "pc", ssh: "transcripts", shell: "posix" }] },
      execution: {
        connections: [
          {
            id: "pc",
            kind: "herdr",
            session: "work",
            ssh: { host: "workers", shell: "posix" },
            workspaces: [{ kind: "directory", path: "/granted" }],
            enabled: true,
            capabilities: ["review"],
          },
        ],
      },
    }));
    const machines = new Machines({ settings, primary: () => undefined, changed: () => {} });
    const routes = createAgentSessionRoutes(
      createAgentSessions(settings),
      async () => true,
      undefined,
      machines,
    );
    const before = await settings.load();
    const added = await routes.request("/v1/agent-hosts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "pc", ssh: "workers", shell: "posix" }),
    });
    expect(added.status).toBe(409);
    const removed = await routes.request("/v1/agent-hosts/pc", { method: "DELETE" });
    expect(removed.status).toBe(409);
    expect(await removed.json()).toMatchObject({ detail: expect.stringContaining("Ambiguous") });
    expect(await settings.load()).toEqual(before);
    // An explicit alias for the transcript machine can remove only that machine.
    expect(
      (
        await routes.request("/v1/agent-hosts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "desktop", ssh: "transcripts", shell: "posix" }),
        })
      ).status,
    ).toBe(200);
    expect((await routes.request("/v1/agent-hosts/desktop", { method: "DELETE" })).status).toBe(200);
    expect((await settings.load()).execution).toEqual(before.execution);
    expect((await settings.load()).machines).toEqual([
      { id: "pc-2", ssh: "workers", shell: "posix", aliases: [] },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discovery IDs remain unique across case-folded aliases and configured candidate names", async () => {
  const dir = await mkdtemp("/tmp/clankie-machine-ids-");
  try {
    const machines = new Machines({
      settings: new SettingsStore(join(dir, "settings.json")),
      primary: () => undefined,
      changed: () => {},
      sshConfig: async () => "Host box BOX candidate-1",
      run: async () => ({ stdout: JSON.stringify({ sessions: [] }) }),
    });
    await machines.add({ id: "candidate-1", ssh: "other", shell: "posix" });
    const rows = MachineInventorySchema.parse(await machines.list()).machines;
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(rows.find((row) => row.ssh === "BOX")?.id).toBe("box-1");
    expect(rows.find((row) => row.ssh === "other")?.id).toBe("candidate-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("named execution refuses a replacement socket installed after its caller's revision guard", async () => {
  const dir = await mkdtemp("/tmp/clankie-machine-binding-race-");
  try {
    const settings = new SettingsStore(join(dir, "settings.json"));
    const replace = (socketPath: string) =>
      settings.update((current) => ({
        ...current,
        execution: {
          ...current.execution,
          connections: [
            { id: "work", kind: "herdr", session: "work", socketPath, enabled: true, capabilities: [] },
          ],
        },
      }));
    await replace("/tmp/original.sock");
    const run = vi.fn(async () => ({ stdout: "{}" }));
    const runtimes = new ExecutionConnections({
      settings,
      run,
      primary: { binding: () => undefined, status: () => "disabled" },
    });
    const expected = (await runtimes.configuredBinding("work"))!;
    const originalLookup = runtimes.configuredBinding.bind(runtimes);
    let release!: () => void;
    const pendingLookup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lookup = vi.spyOn(runtimes, "configuredBinding").mockImplementation(async (id) => {
      await pendingLookup;
      return originalLookup(id);
    });
    // The caller has accepted the old generation. Rebind while runNamed awaits
    // its own final lookup; that lookup must compare the captured socket.
    const pending = runtimes.runNamed("work", ["agent", "list"], undefined, undefined, expected);
    const rejected = expect(pending).rejects.toThrow("changed or disconnected");
    await replace("/tmp/replacement.sock");
    release();
    await rejected;
    expect(run).not.toHaveBeenCalled();
    lookup.mockRestore();
    await runtimes.runNamed(
      "work",
      ["agent", "list"],
      undefined,
      undefined,
      (await runtimes.configuredBinding("work"))!,
    );
    expect(run).toHaveBeenCalledWith(
      "herdr",
      ["agent", "list"],
      expect.objectContaining({ HERDR_SOCKET_PATH: "/tmp/replacement.sock" }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
