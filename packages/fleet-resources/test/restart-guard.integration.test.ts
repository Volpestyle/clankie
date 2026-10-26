// Private persisted journals plus native process births/ancestry prove the restart boundary.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createResourceGovernor } from "../src/governor.ts";
import type { HeavyLease, ResourceQueueEntry, SimulatorReservation } from "../src/model.ts";
import { processIdentity, processSnapshot } from "../src/process.ts";
import { proveRestartResources } from "../src/restart-guard.ts";
import { ResourceStore } from "../src/store.ts";
import type { SimulatorOwner } from "../src/simulators.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "restart-guard-"));
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
    console.log(c.pid);
    process.on('SIGTERM',()=>{c.kill(); process.exit(0)});
    setInterval(()=>{},1000);
  `,
    ],
    {
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_RUNTIME_DIR: join(root, "run"),
      },
    },
  );
  const [line] = await once(child.stdout!, "data");
  const native = await processIdentity(child.pid!);
  const descendant = await processIdentity(Number(String(line).trim()));
  const unrelated = await processIdentity();
  if (!native || !descendant || !unrelated) throw new Error("Native fixture births unavailable");
  const owner: SimulatorOwner = {
    seatId: "hired-seat",
    pane: "pane",
    occupantId: "occupant",
    binding: { socketPath: join(root, "native.sock") },
    processes: [native],
  };
  const stores = [root, join(root, "light"), join(root, "server")].map((path) => new ResourceStore(path));
  const governor = createResourceGovernor({ directory: root });
  return {
    root,
    owner,
    native,
    descendant,
    unrelated,
    stores,
    governor,
    read: () => Promise.all(stores.map((store) => store.read())),
    async reset() {
      for (const store of stores)
        await store.transaction((state) => {
          state.leases = [];
          state.queue = [];
        });
    },
    async close() {
      const exited = once(child, "exit");
      child.kill();
      await exited;
      await governor.close();
      for (const store of stores) store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("checks held and queued work in every private lane using native child ancestry, without blocking an unrelated proven holder", async () => {
  const f = await fixture();
  try {
    expect(await f.governor.restartGuard!(f.owner)).toEqual({ clear: true });
    for (const store of f.stores) {
      const lease: HeavyLease = {
        id: randomUUID(),
        token: randomUUID(),
        kind: "heavy",
        state: "running",
        holderId: "different-child-label",
        executable: process.execPath,
        createdAtMs: Date.now(),
        lastUsedAtMs: Date.now(),
        claimOwner: f.descendant,
      };
      await store.transaction((state) => {
        state.leases.push(lease);
      });
      expect(await f.governor.restartGuard!(f.owner)).toMatchObject({
        clear: false,
        reason: "resource_held_or_queued",
        detail: lease.id,
      });
      await f.reset();
      const ticket: ResourceQueueEntry = {
        id: randomUUID(),
        token: randomUUID(),
        kind: "heavy",
        queuedAtMs: Date.now(),
        owner: f.descendant,
      };
      await store.transaction((state) => {
        state.queue.push(ticket);
      });
      expect(await f.governor.restartGuard!(f.owner)).toMatchObject({
        clear: false,
        reason: "resource_held_or_queued",
        detail: ticket.id,
      });
      await f.reset();
      await store.transaction((state) => {
        state.leases.push({ ...lease, claimOwner: f.unrelated });
      });
      expect(await f.governor.restartGuard!(f.owner)).toEqual({ clear: true });
      await f.reset();
    }
    for (const phase of ["reserved", "booting", "cancelling"]) {
      const lease: SimulatorReservation = {
        id: randomUUID(),
        token: randomUUID(),
        kind: "simulator",
        phase,
        seatId: "another-label",
        occupantId: "another-occupant",
        holderId: "native-child",
        ownerProcesses: [{ pid: f.descendant.pid, startTime: f.descendant.startTime }],
        createdAtMs: Date.now(),
        lastUsedAtMs: Date.now(),
      };
      await f.stores[0]!.transaction((state) => {
        state.leases.push(lease);
      });
      expect(await f.governor.restartGuard!(f.owner)).toMatchObject({
        clear: false,
        reason: "resource_held_or_queued",
        detail: lease.id,
      });
      await f.reset();
    }
    const ticket: ResourceQueueEntry = {
      id: randomUUID(),
      token: randomUUID(),
      kind: "simulator",
      seatId: "other",
      holderId: "child",
      queuedAtMs: Date.now(),
      owner: f.descendant,
      simulator: { occupantId: "other", exact: true, expiresAtMs: Date.now() + 60_000 },
    };
    await f.stores[0]!.transaction((state) => {
      state.queue.push(ticket);
    });
    expect(await f.governor.restartGuard!(f.owner)).toMatchObject({
      clear: false,
      reason: "resource_held_or_queued",
    });
  } finally {
    await f.close();
  }
}, 60_000);

it("refuses unknown births, failed journal/census reads and a journal mutation during the census", async () => {
  const f = await fixture();
  try {
    const wrongOwner = { ...f.owner, processes: [{ ...f.native, startTime: "unproven-birth" }] };
    expect(await f.governor.restartGuard!(wrongOwner)).toMatchObject({
      clear: false,
      reason: "resource_owner_birth_unknown",
    });
    await f.stores[1]!.transaction((state) => {
      state.queue.push({
        id: randomUUID(),
        token: randomUUID(),
        kind: "heavy",
        queuedAtMs: Date.now(),
        owner: { ...f.descendant, startTime: "unknown" },
      });
    });
    expect(await f.governor.restartGuard!(f.owner)).toMatchObject({
      clear: false,
      reason: "resource_attribution_unknown",
    });
    await f.reset();
    expect(
      await proveRestartResources(f.owner, f.read, async () => {
        throw new Error("native observer unavailable");
      }),
    ).toMatchObject({ clear: false, reason: "resource_inventory_unknown" });
    expect(
      await proveRestartResources(f.owner, f.read, async () => {
        const census = await processSnapshot(true);
        await f.stores[2]!.transaction((state) => {
          state.policy.maxLoadRatio += 0.1;
        });
        return census;
      }),
    ).toMatchObject({ clear: false, reason: "resource_inventory_changed" });
    await writeFile(join(f.root, "state.json"), "broken journal");
    expect(await f.governor.restartGuard!(f.owner)).toMatchObject({
      clear: false,
      reason: "resource_inventory_unknown",
    });
  } finally {
    await f.close();
  }
}, 30_000);
