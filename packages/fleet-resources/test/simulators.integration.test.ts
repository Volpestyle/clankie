import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createResourceGovernor } from "../src/governor.ts";
import { defaultResourcePolicy } from "../src/model.ts";
import { processIdentity } from "../src/process.ts";
import { createSimctlAdapter } from "../src/simctl.ts";
import { createSimulatorManager, type SimulatorOwner, type SimulatorResult } from "../src/simulators.ts";

const execute = promisify(execFile);
const runtime = "com.apple.CoreSimulator.SimRuntime.iOS-27-0";
const deviceType = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
interface NativeState {
  devices: Record<
    string,
    { udid: string; name: string; state: string; isAvailable: boolean; deviceTypeIdentifier: string }[]
  >;
  fault?: { operation: string; before?: boolean; after?: boolean; state?: string };
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "clankie-simulator-fixture-"));
  const statePath = join(directory, "native.json");
  const logPath = join(directory, "commands.jsonl");
  await writeFile(statePath, JSON.stringify({ devices: {} }));
  await writeFile(logPath, "");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  const observedProcess = await processIdentity(child.pid!);
  if (!observedProcess) throw new Error("Fixture owner process was not observed");
  const owner: SimulatorOwner = {
    seatId: "seat-fixture",
    occupantId: "native-fixture",
    pane: "w1:p1",
    processes: [{ pid: observedProcess.pid, startTime: observedProcess.startTime }],
  };
  const governorOptions = {
    directory: join(directory, "governor"),
    probe: async () => ({ loadRatio: 0, availableMemoryMb: 32768 }),
  };
  let governor = createResourceGovernor(governorOptions);
  await governor.configure({ ...defaultResourcePolicy(), heavySlots: 1, minAvailableMemoryMb: 0 });
  let nativeReplyBarrier: ((args: readonly string[]) => Promise<void>) | undefined;
  const adapter = createSimctlAdapter({
    run: async (args, timeout) => {
      const result = await execute(
        process.execPath,
        [new URL("./fixtures/simctl.mjs", import.meta.url).pathname, statePath, logPath, ...args],
        { timeout, encoding: "utf8" },
      );
      await nativeReplyBarrier?.(args);
      return result.stdout;
    },
  });
  let clock = Date.now();
  const options = () => ({
    governor,
    adapter,
    clock: () => clock,
    observeSeat: async (identity: Pick<SimulatorOwner, "seatId" | "occupantId" | "fleet">) => ({
      identity: { ...owner, ...identity },
      status: "working",
    }),
  });
  let manager = createSimulatorManager(options());
  const read = async () => JSON.parse(await readFile(statePath, "utf8")) as NativeState;
  const mutate = async (change: (value: NativeState) => void) => {
    const state = await read();
    change(state);
    await writeFile(statePath, JSON.stringify(state));
  };
  const commands = async () =>
    (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((row) => JSON.parse(row) as string[]);
  const request = { seatId: owner.seatId, occupantId: owner.occupantId, deviceType, runtime };
  let ownerAuthorized = true;
  const authorize = async () => ownerAuthorized;
  const server = createServer(async (req, res) => {
    try {
      let source = "";
      for await (const part of req) source += String(part);
      const body = source ? JSON.parse(source) : {};
      let result: unknown;
      if (req.url === "/acquire") result = await manager.acquire({ ...body, authorize });
      else if (req.url === "/release") result = await manager.release(body.id, body.owner, { authorize });
      else if (req.url === "/touch") result = await manager.touch(body.id, body.owner, { authorize });
      else if (req.url === "/snapshot") result = await manager.snapshot();
      else throw new Error("Unknown fixture API");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture HTTP socket missing");
  const http = async (path: string, body: unknown = {}) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
    if (!response.ok) throw new Error("Fixture HTTP boundary failed");
    return (await response.json()) as SimulatorResult;
  };
  cleanup.push(async () => {
    manager.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await stop(child);
    await governor.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    child,
    owner,
    adapter,
    request,
    read,
    mutate,
    commands,
    http,
    revoke: () => {
      ownerAuthorized = false;
    },
    pauseInventory: (afterCreate = false) => {
      let entered!: () => void, resume!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      nativeReplyBarrier = async (args) => {
        if (
          args[0] !== "list" ||
          (afterCreate && !(await commands()).some((command) => command[0] === "create"))
        )
          return;
        nativeReplyBarrier = undefined;
        entered();
        await gate;
      };
      return { waiting, resume };
    },
    get manager() {
      return manager;
    },
    get governor() {
      return governor;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    restart: async () => {
      manager.close();
      await governor.close();
      governor = createResourceGovernor(governorOptions);
      manager = createSimulatorManager(options());
    },
  };
}
function lease(result: SimulatorResult) {
  if (!("lease" in result)) throw new Error(`Expected a simulator lease, got ${result.outcome}`);
  return result.lease;
}

it("crosses real HTTP, durable admission and child-process simctl boundaries; heavy work waits for simulator shutdown", async () => {
  const f = await fixture();
  const acquired = await f.http("/acquire", f.request);
  expect(acquired.outcome).toBe("acquired");
  const created = lease(acquired);
  expect(JSON.stringify(acquired)).not.toContain("token");
  const marker = join(f.directory, "heavy-started");
  const heavy = f.governor.runHeavy(process.execPath, [
    "-e",
    "require('node:fs').writeFileSync(process.argv[1], 'started')",
    marker,
  ]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(await readFile(marker).catch(() => undefined)).toBeUndefined();
  expect((await f.http("/release", { id: created.id, owner: f.owner })).outcome).toBe("released");
  expect(await heavy).toBe(0);
  const commands = await f.commands();
  expect(commands.filter((args) => args[0] === "create")).toHaveLength(1);
  expect(commands.filter((args) => args[0] === "bootstatus")).toEqual([
    ["bootstatus", created.deviceId!, "-b"],
  ]);
  expect(commands.filter((args) => args[0] === "shutdown")).toEqual([["shutdown", created.deviceId!]]);
  expect(commands.filter((args) => args[0] === "delete")).toEqual([["delete", created.deviceId!]]);
});

it("concurrent named seats reserve one global simulator slot", async () => {
  const f = await fixture();
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = f.manager.acquire({ ...f.request, signal: firstController.signal });
  const second = f.manager.acquire({
    ...f.request,
    seatId: "seat-other",
    occupantId: "native-other",
    signal: secondController.signal,
  });
  const winner = await Promise.race([first, second]);
  expect(winner.outcome).toBe("acquired");
  firstController.abort();
  secondController.abort();
  expect((await Promise.all([first, second])).map((result) => result.outcome).sort()).toEqual([
    "acquired",
    "rejected",
  ]);
  expect((await f.commands()).filter((args) => args[0] === "create")).toHaveLength(1);
  expect(await f.governor.simulatorReservations()).toHaveLength(1);
});

it("counts unmanaged booted and booting devices without shutting down or deleting them", async () => {
  const f = await fixture();
  const external = randomUUID().toUpperCase();
  await f.mutate((state) => {
    state.devices[runtime] = [
      {
        udid: external,
        name: "Owner Phone",
        state: "Booting",
        isAvailable: true,
        deviceTypeIdentifier: deviceType,
      },
    ];
  });
  const result = await f.manager.acquire({ ...f.request, signal: AbortSignal.timeout(250) });
  expect(result.outcome).toBe("rejected");
  expect((await f.manager.snapshot()).externalActive).toBe(1);
  await f.manager.tick();
  expect((await f.commands()).every((args) => args[0] === "list")).toBe(true);
  expect((await f.read()).devices[runtime]![0]!.udid).toBe(external);
});

it("unknown native inventory refuses admission and cannot free existing capacity", async () => {
  const f = await fixture();
  const acquired = lease(await f.manager.acquire(f.request));
  await f.mutate((state) => {
    state.devices[runtime]![0]!.state = "Unknown";
  });
  f.advance(700_000);
  await f.manager.tick();
  expect((await f.manager.snapshot()).inventory).toBe("unavailable");
  expect((await f.governor.simulatorReservations())[0]!.id).toBe(acquired.id);
  expect((await f.commands()).filter((args) => ["shutdown", "delete"].includes(args[0]!))).toHaveLength(0);
});

it("only simulator heartbeats renew idle use; unrelated working turns do not", async () => {
  const f = await fixture();
  const acquired = lease(await f.manager.acquire(f.request));
  f.advance(500_000);
  await f.manager.touch(acquired.id, f.owner);
  f.advance(500_000);
  await f.manager.observeSeatState(f.owner, "working");
  expect(await f.governor.simulatorReservations()).toHaveLength(1);
  f.advance(100_001);
  await f.manager.observeSeatState(f.owner, "working");
  expect(await f.governor.simulatorReservations()).toHaveLength(0);
  expect((await f.commands()).filter((args) => args[0] === "shutdown")).toHaveLength(1);
});

it("observer close and missing-seat hints preserve leases; independently proven native exit cleans its exact created device", async () => {
  const f = await fixture();
  const acquired = lease(await f.manager.acquire(f.request));
  f.manager.start();
  f.manager.close();
  await f.manager.observeSeatState(f.owner, "offline");
  await f.manager.observeSeatExited(f.owner);
  expect(await f.governor.simulatorReservations()).toHaveLength(1);
  await stop(f.child);
  await f.manager.observeSeatExited(f.owner);
  expect(await f.governor.simulatorReservations()).toHaveLength(0);
  expect((await f.commands()).filter((args) => args[0] === "delete")).toEqual([
    ["delete", acquired.deviceId!],
  ]);
});

it("a lost create receipt retains its reservation across restart and never adopts or deletes a device by name", async () => {
  const f = await fixture();
  await f.mutate((state) => {
    state.fault = { operation: "create", after: true };
  });
  const acquired = lease(await f.manager.acquire(f.request));
  expect(acquired.phase).toBe("create-uncertain");
  expect(acquired.deviceId).toBeUndefined();
  await f.restart();
  f.advance(700_000);
  await f.manager.tick();
  expect(await f.governor.simulatorReservations()).toHaveLength(1);
  expect((await f.read()).devices[runtime]).toHaveLength(1);
  expect((await f.commands()).filter((args) => args[0] !== "list")).toHaveLength(1);
});

it("a lost boot receipt holds capacity and reconciles only a later booted observation without boot resubmission", async () => {
  const f = await fixture();
  await f.mutate((state) => {
    state.fault = { operation: "boot", after: true, state: "Booting" };
  });
  const acquired = lease(await f.manager.acquire(f.request));
  expect(acquired.phase).toBe("boot-uncertain");
  await f.restart();
  await f.manager.tick();
  expect((await f.governor.simulatorReservations())[0]!.phase).toBe("boot-uncertain");
  await f.mutate((state) => {
    state.devices[runtime]![0]!.state = "Booted";
  });
  await f.manager.tick();
  expect((await f.governor.simulatorReservations())[0]!.phase).toBe("booted");
  expect((await f.commands()).filter((args) => args[0] === "bootstatus")).toHaveLength(1);
  expect((await f.manager.release(acquired.id, f.owner)).outcome).toBe("released");
});

it("failed shutdown holds capacity until native stop is observed; cleanup never deletes an unrelated device", async () => {
  const f = await fixture();
  const acquired = lease(await f.manager.acquire(f.request));
  const unrelated = randomUUID().toUpperCase();
  await f.mutate((state) => {
    state.devices[runtime]!.push({
      udid: unrelated,
      name: acquired.deviceName!,
      state: "Shutdown",
      isAvailable: true,
      deviceTypeIdentifier: deviceType,
    });
    state.fault = { operation: "shutdown", before: true };
  });
  expect((await f.manager.release(acquired.id, f.owner)).outcome).toBe("held");
  await f.restart();
  await f.manager.tick();
  expect(await f.governor.simulatorReservations()).toHaveLength(1);
  expect((await f.commands()).filter((args) => args[0] === "shutdown")).toHaveLength(1);
  await f.mutate((state) => {
    state.devices[runtime]!.find((device) => device.udid === acquired.deviceId)!.state = "Shutdown";
  });
  await f.manager.tick();
  expect(await f.governor.simulatorReservations()).toHaveLength(0);
  expect((await f.read()).devices[runtime]!.map((device) => device.udid)).toEqual([unrelated]);
  expect((await f.commands()).filter((args) => args[0] === "delete")).toEqual([
    ["delete", acquired.deviceId!],
  ]);
});

it("mismatched native occupants and process births cannot touch or release another lease", async () => {
  const f = await fixture();
  const acquired = lease(await f.manager.acquire(f.request));
  expect((await f.manager.touch(acquired.id, { ...f.owner, occupantId: "replacement" })).outcome).toBe(
    "rejected",
  );
  expect(
    (
      await f.manager.release(acquired.id, {
        ...f.owner,
        processes: [{ ...f.owner.processes[0]!, startTime: "different birth" }],
      })
    ).outcome,
  ).toBe("rejected");
  await f.manager.observeSeatExited({
    ...f.owner,
    processes: [{ ...f.owner.processes[0]!, startTime: "different birth" }],
  });
  expect(await f.governor.simulatorReservations()).toHaveLength(1);
  expect((await f.commands()).filter((args) => ["shutdown", "delete"].includes(args[0]!))).toHaveLength(0);
});

it("revoking HTTP authorization while native preflight is awaiting cannot create a simulator or retain an unsubmitted reservation", async () => {
  const f = await fixture();
  const barrier = f.pauseInventory();
  const acquiring = f.http("/acquire", f.request);
  await barrier.waiting;
  f.revoke();
  barrier.resume();
  expect(await acquiring).toEqual({ outcome: "rejected", reason: "owner_unavailable" });
  expect(await f.governor.simulatorReservations()).toHaveLength(0);
  expect((await f.commands()).filter((args) => args[0] !== "list")).toHaveLength(0);
});

it("revoking HTTP authorization after the exact Create receipt prevents boot and retains the owned shutdown device", async () => {
  const f = await fixture();
  const barrier = f.pauseInventory(true);
  const acquiring = f.http("/acquire", f.request);
  await barrier.waiting;
  f.revoke();
  barrier.resume();
  const acquired = lease(await acquiring);
  expect(acquired.phase).toBe("created");
  expect(acquired.deviceId).toBeDefined();
  await f.restart();
  await f.manager.tick();
  expect(await f.governor.simulatorReservations()).toHaveLength(1);
  expect((await f.read()).devices[runtime]![0]!.state).toBe("Shutdown");
  expect((await f.commands()).filter((args) => args[0] !== "list").map((args) => args[0])).toEqual([
    "create",
  ]);
});

it("revoked HTTP authority cannot renew activity or shut down an existing simulator", async () => {
  const f = await fixture();
  const acquired = lease(await f.http("/acquire", f.request));
  const before = (await f.governor.simulatorReservations())[0]!;
  f.advance(100_000);
  f.revoke();
  expect((await f.http("/touch", { id: acquired.id, owner: f.owner })).outcome).toBe("rejected");
  expect((await f.http("/release", { id: acquired.id, owner: f.owner })).outcome).toBe("rejected");
  expect((await f.governor.simulatorReservations())[0]!.lastUsedAtMs).toBe(before.lastUsedAtMs);
  expect((await f.commands()).filter((args) => ["shutdown", "delete"].includes(args[0]!))).toHaveLength(0);
});
