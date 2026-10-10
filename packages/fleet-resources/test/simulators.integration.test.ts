import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { FleetResourceSnapshotSchema } from "../../protocol/src/fleet-resources.ts";
import { ResourceStore } from "../src/store.ts";
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
    {
      udid: string;
      name: string;
      state: string;
      isAvailable: boolean;
      deviceTypeIdentifier: string;
      lastUsedAt?: string;
    }[]
  >;
  fault?: { operation: string; before?: boolean; after?: boolean; state?: string };
  bootDelayMs?: number;
  bootReleasePath?: string;
  deviceTypes?: string[];
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}
async function fixture(settings: { respondWithinMs?: number; bootSettleMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "clankie-simulator-fixture-"));
  const statePath = join(directory, "native.json");
  const logPath = join(directory, "commands.jsonl");
  await writeFile(statePath, JSON.stringify({ devices: {} }));
  await writeFile(logPath, "");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  const observedProcess = await processIdentity(child.pid!);
  if (!observedProcess) throw new Error("Fixture owner process was not observed");
  const owner = {
    seatId: "seat-fixture",
    holderId: "root-task",
    occupantId: "native-fixture",
    pane: "w1:p1",
    processes: [{ pid: observedProcess.pid, startTime: observedProcess.startTime }],
  } satisfies SimulatorOwner;
  let loadRatio = 0;
  const governorOptions = {
    directory: join(directory, "governor"),
    probe: async () => ({ loadRatio, availableMemoryMb: 32768 }),
    simulatorBootSettleMs: settings.bootSettleMs ?? 0,
  };
  let governor = createResourceGovernor(governorOptions);
  await governor.configure({
    ...defaultResourcePolicy(),
    heavySlots: 1,
    simulatorSlots: 1,
    minAvailableMemoryMb: 0,
  });
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
    ...settings,
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
  const request = {
    seatId: owner.seatId,
    holderId: owner.holderId,
    occupantId: owner.occupantId,
    deviceType,
    runtime,
  };
  let ownerAuthorized = true;
  const authorize = async () => ownerAuthorized;
  const server = createServer(async (req, res) => {
    try {
      let source = "";
      for await (const part of req) source += String(part);
      const body = source ? JSON.parse(source) : {};
      let result: unknown;
      if (req.url === "/plan") result = await manager.plan({ ...body, authorize });
      else if (req.url === "/acquire") result = await manager.acquire({ ...body, authorize });
      else if (req.url === "/release") result = await manager.release(body.id, body.owner, { authorize });
      else if (req.url === "/verify")
        result = await manager.verify(body.id, body.deviceId, body.owner, { authorize });
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
  const http = (path: string, body: unknown = {}) => {
    const pending = (async () => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });
      if (!response.ok) throw new Error("Fixture HTTP boundary failed");
      return (await response.json()) as SimulatorResult;
    })();
    // A caller may be awaiting a native barrier when its HTTP connection
    // closes. Observe rejection now; return the original promise so its
    // later assertion still fails with that same error.
    void pending.catch(() => {});
    return pending;
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
    setLoad: (value: number) => {
      loadRatio = value;
    },
    port: address.port,
    disconnectHttp: () => server.closeAllConnections(),
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
    /** `afterReservation` passes admission's own inventory read and wedges the preparation's. */
    pauseInventory: (afterCreate = false, afterReservation = false) => {
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
          (afterCreate && !(await commands()).some((command) => command[0] === "create")) ||
          (afterReservation &&
            !(await new ResourceStore(join(directory, "governor")).read()).leases.some(
              (entry) => entry.kind === "simulator",
            ))
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

it("crosses real HTTP, durable admission and child-process simctl boundaries; heavy work proceeds while the simulator is held", async () => {
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
  expect(await heavy).toBe(0);
  expect(await readFile(marker, "utf8")).toBe("started");
  expect((await f.governor.snapshot()).capacity).toMatchObject({ used: 0, simulatorUsed: 1 });
  expect((await f.http("/release", { id: created.id, owner: f.owner })).outcome).toBe("released");
  const commands = await f.commands();
  expect(commands.filter((args) => args[0] === "create")).toHaveLength(1);
  expect(commands.filter((args) => args[0] === "bootstatus")).toEqual([
    ["bootstatus", created.deviceId!, "-b"],
  ]);
  expect(commands.filter((args) => args[0] === "shutdown")).toEqual([["shutdown", created.deviceId!]]);
  expect(commands.filter((args) => args[0] === "delete")).toEqual([]);
});

it("with two slots, a second simulator waits on pressure until the first boot settles", async () => {
  const f = await fixture({ bootSettleMs: 60_000 });
  await f.governor.configure({ ...defaultResourcePolicy(), simulatorSlots: 2, minAvailableMemoryMb: 0 });
  const first = lease(await f.manager.acquire(f.request));
  const second = await f.manager.acquire({
    ...f.request,
    seatId: "seat-other",
    occupantId: "native-other",
    deviceType: "com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M4",
  });
  expect(second).toMatchObject({ outcome: "waiting", reason: "pressure" });
  expect((await f.commands()).filter((args) => args[0] === "bootstatus")).toEqual([
    ["bootstatus", first.deviceId!, "-b"],
  ]);
});

it("concurrent named seats reserve one global simulator slot; the other is told who holds it", async () => {
  const f = await fixture();
  const first = f.manager.acquire(f.request);
  const second = f.manager.acquire({ ...f.request, seatId: "seat-other", occupantId: "native-other" });
  const results = await Promise.all([first, second]);
  expect(results.map((result) => result.outcome).sort()).toEqual(["acquired", "waiting"]);
  const waiting = results.find((result) => result.outcome === "waiting");
  if (waiting?.outcome !== "waiting") throw new Error("expected a waiting answer");
  expect(waiting.reason).toBe("simulator_capacity");
  const holder = results.find((result) => result.outcome === "acquired");
  expect(waiting.blockers.leases).toEqual([
    expect.objectContaining({ seatId: holder && "lease" in holder ? holder.lease.seatId : "missing" }),
  ]);
  expect(waiting.hint).toContain("leased to seat");
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
  const result = await f.manager.acquire(f.request);
  if (result.outcome !== "waiting") throw new Error(`expected waiting, got ${result.outcome}`);
  expect(result.blockers.external).toEqual([
    expect.objectContaining({ udid: external, name: "Owner Phone", state: "Booting", holders: [] }),
  ]);
  expect(result.hint).toContain('"Owner Phone"');
  const status = await f.manager.snapshot();
  expect(status.externalActive).toBe(1);
  expect(status.external?.[0]?.udid).toBe(external);
  expect(status.hint).toContain("booted outside leases");
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

it("observer close and missing-seat hints preserve leases; independently proven native exit stops and retains its exact created device", async () => {
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
  expect((await f.read()).devices[runtime]).toEqual([
    expect.objectContaining({ udid: acquired.deviceId, state: "Shutdown" }),
  ]);
  expect((await f.commands()).filter((args) => args[0] === "delete")).toEqual([]);
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
  expect((await f.read()).devices[runtime]!.map((device) => device.udid)).toEqual([
    acquired.deviceId,
    unrelated,
  ]);
  expect((await f.commands()).filter((args) => args[0] === "delete")).toEqual([]);
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
  try {
    await barrier.waiting;
    f.revoke();
    barrier.resume();
    expect(await acquiring).toMatchObject({ outcome: "rejected", reason: "authorization_revoked" });
  } finally {
    barrier.resume();
    await acquiring.catch(() => undefined);
    await f.manager.settled();
  }
  expect(await f.governor.simulatorReservations()).toHaveLength(0);
  expect((await f.commands()).filter((args) => args[0] !== "list")).toHaveLength(0);
});

it("revoking HTTP authorization after the exact Create receipt prevents boot and retains the owned shutdown device", async () => {
  const f = await fixture();
  const barrier = f.pauseInventory(true);
  const acquiring = f.http("/acquire", f.request);
  try {
    await barrier.waiting;
    f.revoke();
    barrier.resume();
    expect(await acquiring).toMatchObject({ outcome: "rejected", reason: "authorization_revoked" });
  } finally {
    barrier.resume();
    await acquiring.catch(() => undefined);
    await f.manager.settled();
  }
  const [acquired] = await f.governor.simulatorReservations();
  expect(acquired!.phase).toBe("created");
  expect(acquired!.deviceId).toBeDefined();
  await f.restart();
  await f.manager.tick();
  expect(await f.governor.simulatorReservations()).toHaveLength(1);
  expect((await f.read()).devices[runtime]![0]!.state).toBe("Shutdown");
  expect((await f.commands()).filter((args) => args[0] !== "list").map((args) => args[0])).toEqual([
    "create",
  ]);
});

it("a held HTTP acquisition retains its rejection until awaited after the connection closes", async () => {
  const f = await fixture();
  const barrier = f.pauseInventory(true);
  const acquiring = f.http("/acquire", f.request);
  try {
    await barrier.waiting;
    f.disconnectHttp();
    // Leave the caller at its native barrier through an event-loop turn after
    // transport loss. The original rejection must remain awaitable, observed
    // from creation rather than becoming an unhandled rejection in this gap.
    await new Promise((resolve) => setTimeout(resolve, 100));
    f.revoke();
    barrier.resume();
    await expect(acquiring).rejects.toThrow("fetch failed");
    await f.manager.settled();
    expect((await f.commands()).filter((args) => args[0] === "bootstatus")).toHaveLength(0);
  } finally {
    barrier.resume();
    await acquiring.catch(() => undefined);
    await f.manager.settled();
  }
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

it("a slow boot outlives a caller that hung up: the lease stays the seat's and its next acquire returns it booted", async () => {
  const f = await fixture({ respondWithinMs: 30_000 });
  const releasePath = join(f.directory, "boot-release");
  await f.mutate((state) => {
    state.bootReleasePath = releasePath;
  });
  const controller = new AbortController();
  const response = fetch(`http://127.0.0.1:${f.port}/acquire`, {
    method: "POST",
    body: JSON.stringify(f.request),
    signal: controller.signal,
  });
  const disconnected = expect(response).rejects.toThrow();
  try {
    // Disconnect only after the executable native boundary receives bootstatus.
    // Its file gate keeps boot in flight even when the shared machine is slow.
    const deadline = Date.now() + 8_000;
    while (!(await f.commands()).some((args) => args[0] === "bootstatus")) {
      if (Date.now() > deadline) throw new Error("Fixture boot command was not submitted");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    await disconnected;
    const pending = await f.governor.simulatorReservations();
    expect(pending).toHaveLength(1);
    await writeFile(releasePath, "release");
    await f.manager.settled();
    const again = await f.manager.acquire(f.request);
    expect(again.outcome).toBe("acquired");
    expect(lease(again).id).toBe(pending[0]!.id);
    expect(lease(again).phase).toBe("booted");
    const commands = await f.commands();
    expect(commands.filter((args) => args[0] === "create")).toHaveLength(1);
    expect(commands.filter((args) => args[0] === "bootstatus")).toHaveLength(1);
  } finally {
    controller.abort();
    await disconnected.catch(() => undefined);
    await writeFile(releasePath, "release");
    await f.manager.settled();
  }
});

it("answers booting within its bound and keeps booting server-side", async () => {
  const f = await fixture({ respondWithinMs: 100 });
  await f.mutate((state) => {
    state.bootDelayMs = 1_000;
  });
  const first = await f.manager.acquire(f.request);
  expect(first).toMatchObject({ outcome: "booting", retryAfterMs: 5_000 });
  // Polling while it boots returns the same lease, never a second device.
  expect(lease(await f.manager.acquire(f.request)).id).toBe(lease(first).id);
  await f.manager.settled();
  expect(await f.manager.acquire(f.request)).toMatchObject({
    outcome: "acquired",
    lease: { id: lease(first).id },
  });
  expect((await f.commands()).filter((args) => args[0] === "create")).toHaveLength(1);
});

it("prefers an idle existing device of the exact type, and returns it stopped rather than deleted", async () => {
  const f = await fixture();
  const existing = randomUUID().toUpperCase();
  await f.mutate((state) => {
    state.devices[runtime] = [
      {
        udid: existing,
        name: "iPhone 17 Pro",
        state: "Shutdown",
        isAvailable: true,
        deviceTypeIdentifier: deviceType,
      },
    ];
  });
  const acquired = lease(await f.manager.acquire(f.request));
  expect(acquired).toMatchObject({ deviceId: existing, origin: "existing", phase: "booted" });
  expect((await f.manager.release(acquired.id, f.owner)).outcome).toBe("released");
  const commands = (await f.commands()).filter((args) => args[0] !== "list");
  expect(commands).toEqual([
    ["bootstatus", existing, "-b"],
    ["shutdown", existing],
  ]);
  expect((await f.read()).devices[runtime]).toEqual([
    expect.objectContaining({ udid: existing, state: "Shutdown" }),
  ]);
});

it("substitutes a close existing model for a missing one, and refuses with alternatives when exact", async () => {
  const f = await fixture();
  const m4 = randomUUID().toUpperCase();
  const requested = "com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M3";
  await f.mutate((state) => {
    state.devices[runtime] = [
      {
        udid: m4,
        name: "iPad Air 11-inch (M4)",
        state: "Shutdown",
        isAvailable: true,
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M4",
      },
    ];
    state.deviceTypes = ["com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M4"];
  });
  const exact = await f.manager.acquire({ ...f.request, deviceType: requested, exact: true });
  expect(exact).toMatchObject({ outcome: "rejected", reason: "device_unavailable" });
  if (exact.outcome !== "rejected") throw new Error("expected refusal");
  expect(exact.alternatives).toContainEqual(expect.objectContaining({ udid: m4 }));
  expect(await f.governor.simulatorReservations()).toEqual([]);
  const close = lease(await f.manager.acquire({ ...f.request, deviceType: requested }));
  expect(close).toMatchObject({ deviceId: m4, requestedDeviceType: requested, origin: "existing" });
  expect((await f.commands()).some((args) => args[0] === "create")).toBe(false);
});

it("a seat leases a device it booted by hand by its UDID without booting or deleting it", async () => {
  const f = await fixture();
  const handBooted = randomUUID().toUpperCase();
  await f.mutate((state) => {
    state.devices[runtime] = [
      {
        udid: handBooted,
        name: "large-screen",
        state: "Booted",
        isAvailable: true,
        deviceTypeIdentifier: deviceType,
      },
    ];
  });
  expect((await f.manager.acquire(f.request)).outcome).toBe("waiting");
  const original = (await f.governor.snapshot()).queue.find((entry) => entry.holderId === f.owner.holderId)!;
  expect(await f.manager.cancel(original.id, f.owner)).toEqual({ outcome: "cancelled" });
  const adopted = lease(
    await f.manager.acquire({
      seatId: f.owner.seatId,
      holderId: f.owner.holderId,
      occupantId: f.owner.occupantId,
      deviceId: handBooted,
    }),
  );
  expect(adopted).toMatchObject({ deviceId: handBooted, phase: "booted", origin: "existing" });
  expect((await f.manager.snapshot()).externalActive).toBe(0);
  expect((await f.manager.release(adopted.id, f.owner)).outcome).toBe("released");
  expect((await f.commands()).filter((args) => args[0] !== "list")).toEqual([["shutdown", handBooted]]);
});

it("a boot that failed is resubmitted by the seat's next acquire instead of stranding the slot", async () => {
  const f = await fixture();
  await f.mutate((state) => {
    state.fault = { operation: "boot", before: true };
  });
  const first = lease(await f.manager.acquire(f.request));
  expect(first.phase).toBe("boot-uncertain");
  expect((await f.read()).devices[runtime]![0]!.state).toBe("Shutdown");
  const again = await f.manager.acquire(f.request);
  expect(again).toMatchObject({ outcome: "acquired", lease: { id: first.id, phase: "booted" } });
  expect((await f.commands()).filter((args) => args[0] === "bootstatus")).toHaveLength(2);
});

it.each([
  [
    "com.apple.CoreSimulator.SimDeviceType.iPhone-13-mini",
    deviceType,
    "com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M4",
  ],
  [
    "com.apple.CoreSimulator.SimDeviceType.iPad-mini-A17-Pro",
    "com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M4",
    deviceType,
  ],
])(
  "reuses the installed runtime's idle family before creating requested %s",
  async (requested, available, otherFamily) => {
    const f = await fixture();
    const matching = randomUUID().toUpperCase();
    await f.mutate((state) => {
      state.devices[runtime] = [
        {
          udid: randomUUID().toUpperCase(),
          name: "A wrong family",
          state: "Shutdown",
          isAvailable: true,
          deviceTypeIdentifier: otherFamily,
        },
        {
          udid: matching,
          name: "B correct family",
          state: "Shutdown",
          isAvailable: true,
          deviceTypeIdentifier: available,
        },
        {
          udid: randomUUID().toUpperCase(),
          name: "A unavailable exact",
          state: "Shutdown",
          isAvailable: false,
          deviceTypeIdentifier: requested,
        },
      ];
      state.devices["com.apple.CoreSimulator.SimRuntime.iOS-26-0"] = [
        {
          udid: randomUUID().toUpperCase(),
          name: "A wrong runtime exact",
          state: "Shutdown",
          isAvailable: true,
          deviceTypeIdentifier: requested,
        },
      ];
    });
    const acquired = lease(await f.http("/acquire", { ...f.request, deviceType: requested }));
    expect(acquired).toMatchObject({ deviceId: matching, requestedDeviceType: requested });
    expect((await f.commands()).filter((args) => args[0] === "create")).toEqual([]);
    expect((await f.http("/release", { id: acquired.id, owner: f.owner })).outcome).toBe("released");
  },
);

it("two consecutive family leases across a manager restart boot the same retained created device", async () => {
  const f = await fixture();
  const first = lease(await f.http("/acquire", f.request));
  expect((await f.http("/release", { id: first.id, owner: f.owner })).outcome).toBe("released");
  expect((await f.read()).devices[runtime]).toEqual([
    expect.objectContaining({ udid: first.deviceId, state: "Shutdown" }),
  ]);
  await f.restart();
  const second = lease(
    await f.http("/acquire", {
      ...f.request,
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-13-mini",
    }),
  );
  expect(second.deviceId).toBe(first.deviceId);
  expect(second.id).not.toBe(first.id);
  expect((await f.http("/release", { id: second.id, owner: f.owner })).outcome).toBe("released");
  const commands = await f.commands();
  expect(commands.filter((args) => args[0] === "create")).toHaveLength(1);
  expect(commands.filter((args) => args[0] === "bootstatus")).toEqual([
    ["bootstatus", first.deviceId!, "-b"],
    ["bootstatus", first.deviceId!, "-b"],
  ]);
  expect(commands.filter((args) => args[0] === "delete")).toEqual([]);
});

it("planning is read-only and a missing create receipt still excludes its named device from reuse", async () => {
  const f = await fixture();
  expect(await f.http("/plan", f.request)).toMatchObject({
    outcome: "planned",
    choice: "create",
    simulatorIdleMs: 600000,
  });
  expect(await f.governor.simulatorReservations()).toEqual([]);
  expect((await f.commands()).filter((args) => args[0] !== "list")).toEqual([]);
  await f.mutate((state) => {
    state.fault = { operation: "create", after: true };
  });
  expect(lease(await f.http("/acquire", f.request)).phase).toBe("create-uncertain");
  expect(
    await f.http("/plan", { ...f.request, seatId: "another", occupantId: "another-occupant" }),
  ).toMatchObject({ outcome: "waiting", reason: "simulator_capacity" });
  expect((await f.commands()).filter((args) => args[0] === "create")).toHaveLength(1);
});

it.each([
  [deviceType, "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro"],
  [
    "com.apple.CoreSimulator.SimDeviceType.iPad-mini-A17-Pro",
    "com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M4",
  ],
])(
  "prefers boot history within %s before a cold exact model, respecting explicit constraints",
  async (requested, warmType) => {
    const f = await fixture();
    const cold = randomUUID().toUpperCase(),
      warm = randomUUID().toUpperCase();
    await f.mutate((state) => {
      state.devices[runtime] = [
        {
          udid: cold,
          name: "A cold exact",
          state: "Shutdown",
          isAvailable: true,
          deviceTypeIdentifier: requested,
          lastUsedAt: "invalid-date",
        },
        {
          udid: warm,
          name: "Z warm family",
          state: "Shutdown",
          isAvailable: true,
          deviceTypeIdentifier: warmType,
          lastUsedAt: "2026-10-08T00:39:44Z",
        },
      ];
    });
    const chosen = lease(await f.http("/acquire", { ...f.request, deviceType: requested }));
    expect(chosen.deviceId).toBe(warm);
    expect((await f.http("/release", { owner: f.owner, id: chosen.id })).outcome).toBe("released");
    const strict = lease(await f.http("/acquire", { ...f.request, deviceType: requested, exact: true }));
    expect(strict.deviceId).toBe(cold);
    expect((await f.http("/release", { owner: f.owner, id: strict.id })).outcome).toBe("released");
    const explicit = lease(await f.http("/acquire", { ...f.request, deviceId: cold }));
    expect(explicit.deviceId).toBe(cold);
    expect((await f.commands()).some((args) => args[0] === "create")).toBe(false);
  },
);

it("boot history prefers a warm exact device even when a cold one sorts first", async () => {
  const f = await fixture();
  const warm = randomUUID().toUpperCase();
  await f.mutate((state) => {
    state.devices[runtime] = [
      {
        udid: randomUUID().toUpperCase(),
        name: "A cold",
        state: "Shutdown",
        isAvailable: true,
        deviceTypeIdentifier: deviceType,
      },
      {
        udid: warm,
        name: "Z warm",
        state: "Shutdown",
        isAvailable: true,
        deviceTypeIdentifier: deviceType,
        lastUsedAt: "2026-10-08T00:39:44Z",
      },
    ];
  });
  expect(lease(await f.http("/acquire", { ...f.request, exact: true })).deviceId).toBe(warm);
});

it("two native children in one seat have separate idempotency and release identities across restart", async () => {
  const f = await fixture();
  const a = { ...f.request, holderId: "claude:parent:agent:dock" };
  const b = { ...f.request, holderId: "claude:parent:agent:cards" };
  const results = await Promise.all([f.http("/acquire", a), f.http("/acquire", b)]);
  expect(results.map((result) => result.outcome).sort()).toEqual(["acquired", "waiting"]);
  const acquired = results.find((result) => result.outcome === "acquired")!;
  const held = lease(acquired);
  const waiting = results.find((result) => result.outcome === "waiting")!;
  if (waiting.outcome !== "waiting") throw new Error("expected waiter");
  expect(waiting.blockers.leases[0]).toMatchObject({ seatId: a.seatId, holderId: held.holderId });
  expect(waiting.hint).toContain(held.holderId);
  const winner = held.holderId === a.holderId ? a : b;
  const loser = held.holderId === a.holderId ? b : a;
  await f.restart();
  expect(lease(await f.http("/acquire", winner)).id).toBe(held.id);
  expect(
    (await f.http("/release", { id: held.id, owner: { ...f.owner, holderId: loser.holderId } })).outcome,
  ).toBe("rejected");
  expect(
    (await f.http("/touch", { id: held.id, owner: { ...f.owner, holderId: loser.holderId } })).outcome,
  ).toBe("rejected");
  expect((await f.governor.snapshot()).leases[0]).toMatchObject({
    seatId: a.seatId,
    holderId: winner.holderId,
  });
  expect(
    (await f.http("/release", { id: held.id, owner: { ...f.owner, holderId: winner.holderId } })).outcome,
  ).toBe("released");
  expect((await f.http("/acquire", loser)).outcome).toBe("acquired");
  await stop(f.child);
  await f.manager.observeSeatExited(f.owner);
  expect(await f.governor.simulatorReservations()).toEqual([]);
});

it("two real heavy runners and a simulator use independent budgets in either admission order", async () => {
  const f = await fixture();
  await f.governor.configure({ ...defaultResourcePolicy(), heavySlots: 2 });
  const release = join(f.directory, "build-release");
  const jobs: Promise<number>[] = [];
  const cancel = new AbortController();
  try {
    for (const holderId of ["dock", "cards"])
      jobs.push(
        f.governor.runHeavy(
          process.execPath,
          [
            "-e",
            "const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync(process.argv[1]))clearInterval(t)},20)",
            release,
          ],
          { seatId: f.owner.seatId, holderId, signal: cancel.signal },
        ),
      );
    const deadline = Date.now() + 8000;
    while (
      (await f.governor.snapshot()).leases.filter(
        (lease) => lease.kind === "heavy" && lease.state === "running",
      ).length < 2
    ) {
      if (Date.now() > deadline) throw new Error("heavy runners did not register");
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const held = lease(await f.http("/acquire", f.request));
    expect((await f.governor.snapshot()).capacity).toEqual({
      heavySlots: 2,
      simulatorSlots: 1,
      used: 2,
      simulatorUsed: 1,
      lightSlots: 2,
      lightUsed: 0,
    });
    expect(
      (await f.governor.snapshot()).leases
        .filter((lease) => lease.kind === "heavy")
        .map((lease) => lease.holderId)
        .sort(),
    ).toEqual(["cards", "dock"]);
    expect((await f.http("/acquire", { ...f.request, holderId: "third" })).outcome).toBe("waiting");
    await writeFile(release, "done");
    expect(await Promise.all(jobs)).toEqual([0, 0]);
    expect((await f.governor.snapshot()).capacity).toMatchObject({ used: 0, simulatorUsed: 1 });
    expect((await f.http("/release", { id: held.id, owner: f.owner })).outcome).toBe("released");
  } finally {
    cancel.abort();
    await Promise.allSettled(jobs);
  }
});

it("the load guard gates both independent budgets with concurrent requests", async () => {
  const f = await fixture();
  f.setLoad(2);
  const marker = join(f.directory, "pressure-build");
  const cancel = new AbortController();
  const heavy = f.governor.runHeavy(
    process.execPath,
    ["-e", "require('node:fs').writeFileSync(process.argv[1],'ok')", marker],
    { signal: cancel.signal },
  );
  try {
    const refused = await f.http("/acquire", f.request);
    expect(refused).toMatchObject({
      outcome: "waiting",
      reason: "pressure",
      blockers: { pressure: { reason: "load" } },
    });
    expect(await readFile(marker).catch(() => undefined)).toBeUndefined();
    expect((await f.governor.snapshot()).capacity).toMatchObject({ used: 0, simulatorUsed: 0 });
    f.setLoad(0);
    expect(await heavy).toBe(0);
    expect((await f.http("/acquire", f.request)).outcome).toBe("acquired");
  } finally {
    cancel.abort();
    await heavy;
  }
});

it("exact busy UDIDs wait for their holder with idle alternatives present, then grant only that device", async () => {
  const f = await fixture();
  await f.governor.configure({ ...defaultResourcePolicy(), simulatorSlots: 2 });
  const busy = randomUUID().toUpperCase(),
    idle = randomUUID().toUpperCase();
  await f.mutate((state) => {
    state.devices[runtime] = [busy, idle].map((udid) => ({
      udid,
      name: udid,
      state: "Shutdown",
      isAvailable: true,
      deviceTypeIdentifier: deviceType,
    }));
  });
  const a = { ...f.request, deviceId: busy, exact: true, holderId: "child-a" };
  const b = { ...a, holderId: "child-b" };
  const first = lease(await f.http("/acquire", a));
  expect(first.deviceId).toBe(busy);
  expect(
    await f.http("/verify", { id: first.id, deviceId: busy, owner: { ...f.owner, holderId: b.holderId } }),
  ).toMatchObject({ outcome: "rejected", reason: "stale_owner" });
  expect(
    await f.http("/verify", { id: first.id, deviceId: idle, owner: { ...f.owner, holderId: a.holderId } }),
  ).toMatchObject({ outcome: "rejected", reason: "lease_unavailable" });
  expect(
    lease(
      await f.http("/verify", { id: first.id, deviceId: busy, owner: { ...f.owner, holderId: a.holderId } }),
    ).deviceId,
  ).toBe(busy);
  expect(await f.http("/plan", b)).toMatchObject({ outcome: "waiting" });
  const second = await f.http("/acquire", b);
  expect(second).toMatchObject({ outcome: "waiting", reason: "simulator_capacity" });
  if (second.outcome !== "waiting") throw new Error("Expected exact-device waiter");
  expect(second.hint).toContain("Requested device");
  expect(second.hint).toContain(a.holderId);
  expect(second.hint).not.toContain("All 2 simulator");
  expect((await f.read()).devices[runtime]!.find((row) => row.udid === idle)!.state).toBe("Shutdown");
  expect(
    (await f.http("/release", { id: first.id, owner: { ...f.owner, holderId: a.holderId } })).outcome,
  ).toBe("released");
  expect(lease(await f.http("/acquire", b))).toMatchObject({ deviceId: busy, holderId: b.holderId });
});

it("concurrent requests from one holder validate each exact device instead of sharing the first grant", async () => {
  const f = await fixture();
  const ipadType = "com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M4";
  const ipad = randomUUID().toUpperCase(),
    iphone = randomUUID().toUpperCase();
  await f.mutate((state) => {
    state.devices[runtime] = [
      { udid: ipad, name: "iPad", state: "Shutdown", isAvailable: true, deviceTypeIdentifier: ipadType },
      {
        udid: iphone,
        name: "iPhone",
        state: "Shutdown",
        isAvailable: true,
        deviceTypeIdentifier: deviceType,
      },
    ];
  });
  const barrier = f.pauseInventory();
  const first = f.http("/acquire", {
    ...f.request,
    deviceType: ipadType,
    deviceId: ipad,
    exact: true,
    holderId: "same-child",
  });
  await barrier.waiting;
  const second = f.http("/acquire", { ...f.request, deviceId: iphone, exact: true, holderId: "same-child" });
  barrier.resume();
  expect(lease(await first).deviceId).toBe(ipad);
  expect(await second).toMatchObject({ outcome: "rejected", reason: "lease_unavailable" });
  expect(await f.http("/acquire", { ...f.request, exact: true, holderId: "same-child" })).toMatchObject({
    outcome: "rejected",
    reason: "lease_unavailable",
  });
  expect(await f.governor.simulatorReservations()).toHaveLength(1);
});

it("a missing native task holder cannot acquire the seat's existing lease", async () => {
  const f = await fixture();
  const held = lease(await f.http("/acquire", f.request));
  const { holderId: _holder, ...unidentified } = f.request;
  expect(await f.http("/acquire", unidentified)).toMatchObject({
    outcome: "rejected",
    reason: "owner_unavailable",
  });
  expect(await f.http("/plan", unidentified)).toMatchObject({
    outcome: "rejected",
    reason: "owner_unavailable",
  });
  expect(lease(await f.http("/acquire", f.request)).id).toBe(held.id);
});

async function queued(f: Awaited<ReturnType<typeof fixture>>, holder: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const snapshot = FleetResourceSnapshotSchema.parse(await f.governor.snapshot());
    const ticket = snapshot.queue.find((entry) => entry.holderId === holder);
    if (ticket) return ticket;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Ticket for ${holder} was not persisted`);
}

it("grants three holders of one device in persisted FIFO order with one blocking HTTP acquire each", async () => {
  const f = await fixture();
  const a = lease(await f.http("/acquire", f.request));
  const bRequest = { ...f.request, holderId: "fifo-b", deviceId: a.deviceId, exact: true, waitMs: 30_000 };
  const cRequest = { ...bRequest, holderId: "fifo-c" };
  const b = f.http("/acquire", bRequest);
  const bTicket = await queued(f, "fifo-b");
  const c = f.http("/acquire", cRequest);
  const cTicket = await queued(f, "fifo-c");
  expect(bTicket).toMatchObject({ kind: "simulator", deviceId: a.deviceId, exact: true, position: 1 });
  expect(cTicket.position).toBe(2);
  expect(bTicket.estimatedWaitMs).toBeGreaterThan(0);
  expect(cTicket.queuedAtMs).toBeGreaterThanOrEqual(bTicket.queuedAtMs);
  await f.http("/release", { id: a.id, owner: f.owner });
  const bLease = lease(await b);
  expect(bLease).toMatchObject({ holderId: "fifo-b", deviceId: a.deviceId });
  expect((await f.governor.snapshot()).queue.map((entry) => entry.holderId)).toContain("fifo-c");
  await f.http("/release", { id: bLease.id, owner: { ...f.owner, holderId: "fifo-b" } });
  const cLease = lease(await c);
  expect(cLease).toMatchObject({ holderId: "fifo-c", deviceId: a.deviceId });
  await f.http("/release", { id: cLease.id, owner: { ...f.owner, holderId: "fifo-c" } });
  expect((await f.governor.snapshot()).queue).toEqual([]);
}, 30_000);

it("a holder moving to another device queues behind the oldest ticket waiting for the freed slot", async () => {
  const f = await fixture();
  const a = lease(await f.http("/acquire", f.request));
  const [ipad, waited] = [randomUUID().toUpperCase(), randomUUID().toUpperCase()];
  await f.mutate((state) => {
    state.devices[runtime]!.push(
      ...[ipad, waited].map((udid) => ({
        udid,
        name: udid,
        state: "Shutdown",
        isAvailable: true,
        deviceTypeIdentifier: deviceType,
      })),
    );
  });
  // B's ticket is first in line between polls (a bounded wait ended), so no
  // live waiter can win the race for it.
  const bRequest = { ...f.request, holderId: "first-in-line", deviceId: waited, exact: true };
  expect((await f.http("/acquire", { ...bRequest, waitMs: 0 })).outcome).toBe("waiting");
  const ticket = await queued(f, "first-in-line");
  expect(ticket).toMatchObject({ deviceId: waited, position: 1 });
  // Holder A releases device 1 and at once asks for device 2 (VUH-2008).
  expect((await f.http("/release", { id: a.id, owner: f.owner })).outcome).toBe("released");
  const moved = { ...f.request, deviceId: ipad, exact: true };
  expect((await f.http("/acquire", moved)).outcome).toBe("waiting");
  const bLease = lease(await f.http("/acquire", { ...bRequest, ticketId: ticket.id }));
  expect(bLease).toMatchObject({ holderId: "first-in-line", deviceId: waited });
  expect((await f.http("/acquire", moved)).outcome).toBe("waiting");
  await f.http("/release", { id: bLease.id, owner: { ...f.owner, holderId: "first-in-line" } });
  const aLease = lease(await f.http("/acquire", moved));
  expect(aLease).toMatchObject({ holderId: f.owner.holderId, deviceId: ipad });
  await f.http("/release", { id: aLease.id, owner: f.owner });
}, 30_000);

it("keeps exact-device FIFO across a restart while another device and heavy work proceed independently", async () => {
  const f = await fixture();
  await f.governor.configure({
    ...defaultResourcePolicy(),
    heavySlots: 1,
    simulatorSlots: 2,
    minAvailableMemoryMb: 0,
  });
  const a = lease(await f.manager.acquire(f.request));
  const otherId = randomUUID().toUpperCase();
  await f.mutate((state) => {
    state.devices[runtime]!.push({
      udid: otherId,
      name: "Other Phone",
      state: "Shutdown",
      isAvailable: true,
      deviceTypeIdentifier: deviceType,
    });
  });
  const bRequest = { ...f.request, holderId: "restart-b", deviceId: a.deviceId!, exact: true };
  const b = await f.manager.acquire(bRequest);
  expect(b.outcome).toBe("waiting");
  const original = await queued(f, "restart-b");
  await f.restart();
  const other = lease(
    await f.manager.acquire({ ...f.request, holderId: "other-device", deviceId: otherId, exact: true }),
  );
  expect(other.deviceId).toBe(otherId);
  expect(await f.governor.runHeavy(process.execPath, ["-e", "process.exit(0)"])).toBe(0);
  expect((await queued(f, "restart-b")).id).toBe(original.id);
  const lateRequest = { ...bRequest, holderId: "restart-c" };
  expect((await f.manager.acquire(lateRequest)).outcome).toBe("waiting");
  await f.manager.release(a.id, f.owner);
  // A later holder cannot jump an older ticket by asking again first.
  expect((await f.manager.acquire(lateRequest)).outcome).toBe("waiting");
  const bLease = lease(await f.manager.acquire({ ...bRequest, ticketId: original.id }));
  expect(bLease.deviceId).toBe(a.deviceId);
  await f.manager.release(bLease.id, { ...f.owner, holderId: "restart-b" });
  const cLease = lease(await f.manager.acquire(lateRequest));
  await f.manager.release(cLease.id, { ...f.owner, holderId: "restart-c" });
  await f.manager.release(other.id, { ...f.owner, holderId: "other-device" });
}, 30_000);

it("allows only the ticket holder to cancel, refuses changed selections, and expires stale persisted tickets", async () => {
  const f = await fixture();
  const a = lease(await f.manager.acquire(f.request));
  const bRequest = { ...f.request, holderId: "cancel-b", deviceId: a.deviceId!, exact: true };
  expect((await f.manager.acquire(bRequest)).outcome).toBe("waiting");
  const ticket = await queued(f, "cancel-b");
  expect(await f.manager.cancel(ticket.id, { ...f.owner, holderId: "sibling" })).toMatchObject({
    outcome: "rejected",
  });
  expect(await f.manager.acquire({ ...bRequest, exact: false })).toMatchObject({
    outcome: "rejected",
    reason: "ticket_unavailable",
  });
  expect((await queued(f, "cancel-b")).id).toBe(ticket.id);
  expect(await f.manager.cancel(ticket.id, { ...f.owner, holderId: "cancel-b" })).toEqual({
    outcome: "cancelled",
  });
  expect((await f.governor.snapshot()).queue).toEqual([]);
  expect((await f.manager.acquire(bRequest)).outcome).toBe("waiting");
  const stale = await queued(f, "cancel-b");
  const store = new ResourceStore(join(f.directory, "governor"));
  await store.transaction((state) => {
    state.queue.find((entry) => entry.id === stale.id)!.simulator!.expiresAtMs = Date.now() - 1;
  });
  expect((await f.governor.snapshot()).queue).toEqual([]);
  expect(await f.manager.acquire({ ...bRequest, ticketId: stale.id })).toMatchObject({
    outcome: "rejected",
    reason: "ticket_unavailable",
  });
  await f.manager.release(a.id, f.owner);
}, 30_000);

it("release answers within its bound for a reservation stuck behind busy native work, and nothing boots after", async () => {
  const f = await fixture({ respondWithinMs: 100 });
  // Wedge the serial section inside the reservation's own preparation.
  const paused = f.pauseInventory(false, true);
  const first = await f.manager.acquire(f.request);
  await paused.waiting;
  expect(first).toMatchObject({ outcome: "booting", lease: { phase: "reserved" } });
  const released = await f.http("/release", { id: lease(first).id, owner: f.owner });
  expect(released).toEqual({ outcome: "released" });
  expect(await f.governor.simulatorReservations()).toEqual([]);
  paused.resume();
  await f.manager.settled();
  expect(await f.governor.simulatorReservations()).toEqual([]);
  expect((await f.commands()).filter((args) => args[0] === "create" || args[0] === "boot")).toEqual([]);
});

it("a reservation stalled past its limit frees the slot even while the serial section is busy", async () => {
  const f = await fixture({ respondWithinMs: 100 });
  const paused = f.pauseInventory(false, true);
  const first = await f.manager.acquire(f.request);
  await paused.waiting;
  expect(lease(first).phase).toBe("reserved");
  // The fixture clock started before admission; pass the limit with margin.
  f.advance(310_000);
  const ticking = f.manager.tick();
  await expect.poll(() => f.governor.simulatorReservations(), { timeout: 10_000 }).toEqual([]);
  paused.resume();
  await ticking;
  await f.manager.settled();
  expect((await f.commands()).filter((args) => args[0] === "create" || args[0] === "boot")).toEqual([]);
});
