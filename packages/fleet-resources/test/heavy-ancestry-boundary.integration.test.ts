import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createResourceGovernor } from "../src/governor.ts";
import { defaultResourcePolicy, type SimulatorReservation } from "../src/model.ts";
import type * as Process from "../src/process.ts";

// #389: the native observer cannot read another user's process; on macOS its
// identity read rejects for a root-owned process (pid 1 alone reads as absent).
// A holder whose ancestry crosses such a parent below launchd, as a shell under
// Terminal's root-owned `login` does, made the whole heavy-work proof throw, so
// its simulator lease lost heavy retention. Every read here is the real native
// observer except one: the worker's real parent is made unreadable exactly as a
// root-owned ancestor is, because a test cannot start one without privileges.
const { unreadable } = vi.hoisted(() => ({ unreadable: new Set<number>() }));
vi.mock("../src/process.ts", async (importOriginal) => {
  const real = await importOriginal<typeof Process>();
  return {
    ...real,
    processIdentity: async (pid?: number) => {
      if (pid !== undefined && unreadable.has(pid))
        throw new Error("Fleet resource native observation failed");
      return real.processIdentity(pid);
    },
  };
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  unreadable.clear();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it.skipIf(process.platform !== "darwin")(
  "the native identity read rejects for a root-owned process other than launchd",
  async () => {
    const real = await vi.importActual<typeof Process>("../src/process.ts");
    const listing = await promisify(execFile)("ps", ["-A", "-o", "pid=,uid="]);
    const rootOwned = listing.stdout
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/u).map(Number))
      .find(([pid, uid]) => uid === 0 && pid! > 1)?.[0];
    expect(rootOwned).toBeDefined();
    await expect(real.processIdentity(rootOwned)).rejects.toThrow("Fleet resource native observation failed");
    expect(await real.processIdentity(1)).toBeUndefined();
  },
);

it.each([true, false])(
  "an unreadable ancestor ends the heavy holder's ancestry walk instead of failing its proof (native owner %s)",
  async (nativeOwner) => {
    const root = await mkdtemp(join(tmpdir(), "clankie-ancestry-boundary-"));
    const real = await vi.importActual<typeof Process>("../src/process.ts");
    const governor = createResourceGovernor({
      directory: join(root, "governor"),
      // A detached Codex app-server is not below its foreground holder; only the
      // host's native registration can join the observed chain to the seat.
      nativeSimulatorOwner: async (_owner, chain) =>
        nativeOwner && chain.some((row) => row.pid === process.pid),
    });
    await governor.configure({ ...defaultResourcePolicy(), heavySlots: 1, minAvailableMemoryMb: 0 });
    const frontend = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await once(frontend, "spawn");
    const holder = (await real.processIdentity(frontend.pid!))!;
    const heavy = governor.runHeavy(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], {
      seatId: "w48:p5F",
      holderId: "codex:detached-session",
    });
    cleanups.push(async () => {
      await governor.close();
      await heavy.catch(() => undefined);
      frontend.kill();
      await rm(root, { recursive: true, force: true });
    });
    await vi.waitFor(async () =>
      expect((await governor.snapshot()).leases).toContainEqual(
        expect.objectContaining({ kind: "heavy", holderId: "codex:detached-session" }),
      ),
    );
    const lease: SimulatorReservation = {
      id: "simulator-lease",
      token: "token",
      kind: "simulator",
      seatId: "w48:p5F",
      holderId: "codex:detached-session",
      occupantId: "native-codex",
      ownerProcesses: [{ pid: holder.pid, startTime: holder.startTime }],
      createdAtMs: 0,
      lastUsedAtMs: 0,
      phase: "booted",
    };
    // The heavy claim owner is this worker; its real parent stands for a
    // root-owned ancestor such as Terminal's `login`.
    unreadable.add(process.ppid);
    expect(await governor.simulatorHolderHasHeavyWork(lease)).toBe(nativeOwner);
  },
  20_000,
);
