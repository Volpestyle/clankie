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
import { processAncestry, processIdentity } from "../src/process.ts";
import { proveRestartResources } from "../src/restart-guard.ts";
import { ResourceStore } from "../src/store.ts";
import type { SimulatorOwner } from "../src/simulators.ts";

// Admission preconditions are explicit: unrelated host memory/load cannot
// decide the restart boundary. Native births, ancestry and journals stay real.
const probe = async () => ({ loadRatio: 0, cpuRatio: 0, availableMemoryMb: 65_536 });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "restart-guard-"));
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const {spawn} = require('node:child_process');
    const c = spawn(process.execPath, ['-e', \`
      const d = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
      console.log(d.pid);
      process.on('SIGTERM',()=>{d.kill(); process.exit(0)});
      setInterval(()=>{},1000);
    \`], {stdio:['ignore','pipe','inherit']});
    const u = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
    c.stdout.once('data', line => console.log(JSON.stringify([c.pid, Number(String(line).trim()), u.pid])));
    process.on('SIGTERM',()=>{c.kill(); u.kill(); process.exit(0)});
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
  const [ownerPid, descendantPid, unrelatedPid] = JSON.parse(String(line));
  const native = await processIdentity(ownerPid);
  const descendant = await processIdentity(descendantPid);
  const unrelated = await processIdentity(unrelatedPid);
  const commonAncestor = await processIdentity(child.pid!);
  if (!native || !descendant || !unrelated || !commonAncestor)
    throw new Error("Native fixture births unavailable");
  const owner: SimulatorOwner = {
    seatId: "hired-seat",
    pane: "pane",
    occupantId: "occupant",
    binding: { socketPath: join(root, "native.sock") },
    processes: [native],
  };
  const stores = [root, join(root, "light"), join(root, "server")].map((path) => new ResourceStore(path));
  const governor = createResourceGovernor({ directory: root, probe });
  return {
    root,
    owner,
    native,
    descendant,
    unrelated,
    commonAncestor,
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
      for (const linked of [
        { runner: f.descendant },
        { descendants: [{ pid: f.descendant.pid, startTime: f.descendant.startTime }] },
      ]) {
        await store.transaction((state) => {
          state.leases.push({ ...lease, claimOwner: f.unrelated, ...linked });
        });
        expect(await f.governor.restartGuard!(f.owner)).toMatchObject({
          clear: false,
          reason: "resource_held_or_queued",
          detail: lease.id,
        });
        await f.reset();
      }
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

it("refuses attribution for a real orphan holder after its parent exits", async () => {
  const f = await fixture();
  let orphan: Awaited<ReturnType<typeof processIdentity>>;
  try {
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `
      const child = require('node:child_process').spawn(process.execPath,
        ['-e', 'setTimeout(()=>process.exit(0),20000); setInterval(()=>{},1000)'],
        {stdio:'ignore', detached:true});
      console.log(child.pid);
      child.unref();
    `,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const parentExited = once(parent, "exit");
    const [line] = await once(parent.stdout!, "data");
    const pid = Number(String(line).trim());
    await parentExited;
    await expect
      .poll(async () => {
        orphan = await processIdentity(pid);
        return orphan?.ppid;
      })
      .toBe(1);
    if (!orphan) throw new Error("Native orphan birth unavailable");
    const lease: HeavyLease = {
      id: randomUUID(),
      token: randomUUID(),
      kind: "heavy",
      state: "running",
      executable: process.execPath,
      createdAtMs: Date.now(),
      lastUsedAtMs: Date.now(),
      claimOwner: orphan,
    };
    await f.stores[0]!.transaction((state) => {
      state.leases.push(lease);
    });
    expect(await f.governor.restartGuard!(f.owner)).toMatchObject({
      clear: false,
      reason: "resource_attribution_unknown",
      detail: lease.id,
    });
  } finally {
    try {
      if (orphan) {
        const current = await processIdentity(orphan.pid);
        if (current?.startTime === orphan.startTime) {
          process.kill(orphan.pid, "SIGTERM");
          await expect
            .poll(async () => (await processIdentity(current.pid))?.startTime)
            .not.toBe(current.startTime);
        }
      }
    } finally {
      await f.close();
    }
  }
}, 30_000);

it("proves sibling holders unrelated with an unobservable ancestor above their shared parent, without granting ancestry birth authority", async () => {
  const f = await fixture();
  try {
    const ticket: ResourceQueueEntry = {
      id: randomUUID(),
      token: randomUUID(),
      kind: "heavy",
      queuedAtMs: Date.now(),
      owner: f.unrelated,
    };
    await f.stores[0]!.transaction((state) => {
      state.queue.push(ticket);
    });
    // These private births deliberately omit the parent. The all-user census
    // supplies that link, but nothing above it, independent of runner parentage.
    const births = async () => [f.native, f.descendant, f.unrelated];
    const observedPids = new Set([f.native.pid, f.descendant.pid, f.unrelated.pid, f.commonAncestor.pid]);
    const ancestry = async () => (await processAncestry()).filter(({ pid }) => observedPids.has(pid));
    expect(f.native.ppid).toBe(f.commonAncestor.pid);
    expect(f.unrelated.ppid).toBe(f.commonAncestor.pid);
    expect((await ancestry()).some(({ pid }) => pid === f.commonAncestor.ppid)).toBe(false);
    expect(await proveRestartResources(f.owner, f.read, births, ancestry)).toEqual({ clear: true });
    // Model the root-owned login boundary with the real fixture's parent links;
    // ancestry may cross UIDs without acquiring birth authority for that parent.
    expect(
      await proveRestartResources(f.owner, f.read, births, async () =>
        (await ancestry()).map((row) => (row.pid === f.commonAncestor.pid ? { ...row, uid: 0 } : row)),
      ),
    ).toEqual({ clear: true });
    for (const [pid, reason] of [
      [f.native.pid, "resource_owner_birth_unknown"],
      [f.unrelated.pid, "resource_attribution_unknown"],
    ] as const) {
      let reads = 0;
      expect(
        await proveRestartResources(
          f.owner,
          f.read,
          async () => {
            reads++;
            return (await births()).map((row) =>
              row.pid === pid && reads > 1
                ? { ...row, startTime: "reused-pid", legacyStartTime: "reused-legacy-pid" }
                : row,
            );
          },
          ancestry,
        ),
      ).toMatchObject({ clear: false, reason });
    }
    expect(
      await proveRestartResources(f.owner, f.read, async () => [f.native, f.descendant], ancestry),
    ).toMatchObject({ clear: false, reason: "resource_attribution_unknown", detail: ticket.id });
    expect(
      await proveRestartResources(f.owner, f.read, births, async () =>
        (await ancestry()).filter(({ pid }) => pid !== f.commonAncestor.pid),
      ),
    ).toMatchObject({ clear: false, reason: "resource_attribution_unknown", detail: ticket.id });
    expect(
      await proveRestartResources(f.owner, f.read, births, async () => {
        throw new Error("all-user ancestry unavailable");
      }),
    ).toMatchObject({ clear: false, reason: "resource_inventory_unknown" });
    expect(
      await proveRestartResources(f.owner, f.read, births, async () =>
        (await ancestry()).map((row) => (row.pid === f.unrelated.pid ? { ...row, ppid: 1 } : row)),
      ),
    ).toMatchObject({ clear: false, reason: "resource_attribution_unknown", detail: ticket.id });
    expect(
      await proveRestartResources(f.owner, f.read, births, async () =>
        (await ancestry()).map((row) => (row.pid === f.native.pid ? { ...row, ppid: 1 } : row)),
      ),
    ).toMatchObject({ clear: false, reason: "resource_owner_birth_unknown" });
    for (const [pid, uid, reason] of [
      [f.unrelated.pid, f.unrelated.uid + 1, "resource_attribution_unknown"],
      [f.native.pid, f.native.uid + 1, "resource_owner_birth_unknown"],
    ] as const) {
      expect(
        await proveRestartResources(f.owner, f.read, births, async () =>
          (await ancestry()).map((row) => (row.pid === pid ? { ...row, uid } : row)),
        ),
      ).toMatchObject({ clear: false, reason });
    }
  } finally {
    await f.close();
  }
}, 30_000);

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
        const native = await processIdentity(f.native.pid);
        if (!native) throw new Error("Native fixture birth unavailable");
        await f.stores[2]!.transaction((state) => {
          state.policy.maxLoadRatio += 0.1;
        });
        return [native];
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
