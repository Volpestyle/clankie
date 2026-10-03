import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { Machines, sshConfigHosts } from "../src/machines.ts";
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
