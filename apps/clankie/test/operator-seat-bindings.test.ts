import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import type { NativeBirth, NativeSocketProcess } from "../src/local-fleet-process.ts";
import { OperatorSeatBindings, seatNonceHash } from "../src/operator-seat-bindings.ts";

/**
 * Stand-in kernel: a table of processes with births and parents. A "socket" is
 * a token naming the process that owns it, so the observers answer exactly what
 * the native helper would, without launching anything.
 */
const NONCE = "launch-nonce";
type Fake = { pid: number; ppid: number; birth: [string, string] };

function world(initial: Fake[]) {
  const table = new Map(initial.map((entry) => [entry.pid, entry]));
  const owners = new Map<Socket, number>();
  const socketFor = (pid: number) => {
    const socket = { pid } as unknown as Socket;
    owners.set(socket, pid);
    return socket;
  };
  const birthOf = (pid: number): NativeBirth | undefined => {
    const entry = table.get(pid);
    return entry === undefined ? undefined : Object.assign([...entry.birth] as [string, string], {});
  };
  const bindings = new OperatorSeatBindings({
    birth: async (pid) => birthOf(pid),
    processes: async (controller, harness) => {
      const pair = [table.get(controller), table.get(harness)];
      if (pair.some((entry) => entry === undefined)) return undefined;
      return {
        schemaVersion: 1,
        processes: pair.map((entry) => ({ ...entry!, uid: 501, executable: "/fixture/node", argv: [] })),
      };
    },
    socket: async (socket): Promise<NativeSocketProcess | undefined> => {
      const owner = owners.get(socket);
      if (owner === undefined) return undefined;
      const ancestors: NativeSocketProcess["ancestors"][number][] = [];
      for (let pid = owner; table.has(pid); pid = table.get(pid)!.ppid) {
        const entry = table.get(pid)!;
        ancestors.push({ pid, ppid: entry.ppid, birth: entry.birth });
      }
      const first = table.get(owner)!;
      return {
        schemaVersion: 1,
        owner: { pid: owner, uid: 501, birth: first.birth, socket: "s" },
        ancestors,
      };
    },
  });
  return { bindings, table, socketFor };
}

// 10 launcher -> 20 harness -> 30 genuine bridge; 31 stray in the harness's shell (20 -> 25 shell -> 31).
const base = (): Fake[] => [
  { pid: 1, ppid: 0, birth: ["1", "0"] },
  { pid: 5, ppid: 1, birth: ["5", "0"] },
  { pid: 10, ppid: 5, birth: ["10", "0"] },
  { pid: 20, ppid: 10, birth: ["20", "0"] },
  { pid: 30, ppid: 20, birth: ["30", "0"] },
  { pid: 25, ppid: 20, birth: ["25", "0"] },
  { pid: 31, ppid: 25, birth: ["31", "0"] },
  { pid: 40, ppid: 5, birth: ["40", "0"] },
];

async function registered() {
  const fixture = world(base());
  const result = await fixture.bindings.register(fixture.socketFor(10), {
    conversationId: "seat-a",
    harnessPid: 20,
    nonceHash: seatNonceHash(NONCE),
  });
  expect(result.ok).toBe(true);
  return fixture;
}
const ask = (
  f: Awaited<ReturnType<typeof registered>>,
  pid: number,
  claim: string | null = NONCE,
  id = "seat-a",
) => f.bindings.admit(f.socketFor(pid), { conversationId: id, claim: claim ?? undefined });

describe("operator seat bindings", () => {
  it("admits the genuine bridge: the registered harness's direct child with the nonce", async () => {
    const f = await registered();
    expect(await ask(f, 30)).toEqual({ ok: true, role: "bridge" });
    expect(await ask(f, 30)).toEqual({ ok: true, role: "bridge" });
  });

  it("admits the registered launcher itself for its pumps", async () => {
    const f = await registered();
    expect(await ask(f, 10, null)).toEqual({ ok: true, role: "controller" });
  });

  it("refuses a nested stray that inherits the nonce and shares the genuine ancestors", async () => {
    const f = await registered();
    expect(await ask(f, 31)).toMatchObject({ ok: false, error: "seat_bridge_not_registered" });
  });

  it("refuses the harness's direct child that lacks or has the wrong nonce", async () => {
    const f = await registered();
    expect(await ask(f, 30, null)).toMatchObject({ ok: false, error: "seat_bridge_claim_invalid" });
    expect(await ask(f, 30, "guess")).toMatchObject({ ok: false, error: "seat_bridge_claim_invalid" });
  });

  it("refuses an unrelated process with the right nonce", async () => {
    const f = await registered();
    expect(await ask(f, 40)).toMatchObject({ ok: false, error: "seat_bridge_not_registered" });
  });

  it("refuses a missing or unregistered conversation, never defaulting to global-default", async () => {
    const f = await registered();
    expect(
      await f.bindings.admit(f.socketFor(30), { conversationId: undefined, claim: NONCE }),
    ).toMatchObject({
      ok: false,
      error: "seat_binding_conversation_required",
    });
    expect(await ask(f, 30, NONCE, "global-default")).toMatchObject({
      ok: false,
      error: "seat_binding_required",
    });
    expect(await ask(f, 30, NONCE, "seat-b")).toMatchObject({ ok: false, error: "seat_binding_required" });
  });

  it("refuses a request with no provable socket", async () => {
    const f = await registered();
    expect(await f.bindings.admit(undefined, { conversationId: "seat-a", claim: NONCE })).toMatchObject({
      ok: false,
      error: "seat_process_unproven",
    });
  });

  it.each([10, 20])("refuses a reused launcher/harness pid %s with a new birth", async (pid) => {
    const f = await registered();
    f.table.set(pid, { ...f.table.get(pid)!, birth: ["99", "0"] });
    expect(await ask(f, 30)).toMatchObject({ ok: false, error: "seat_binding_stale" });
    // The stale registration is dropped, so even the genuine bridge needs a fresh one.
    expect(await ask(f, 30)).toMatchObject({ ok: false, error: "seat_binding_required" });
  });

  it("drops the binding when the launcher exits", async () => {
    const f = await registered();
    f.table.delete(10);
    expect(await ask(f, 30)).toMatchObject({ ok: false, error: "seat_binding_stale" });
  });

  it("lets one bridge hold the claim and refuses a second live claimant", async () => {
    const f = await registered();
    f.table.set(32, { pid: 32, ppid: 20, birth: ["32", "0"] });
    expect(await ask(f, 30)).toMatchObject({ ok: true });
    expect(await ask(f, 32)).toMatchObject({ ok: false, error: "seat_bridge_claimed" });
    // A reconnect after the first bridge exits takes the claim.
    f.table.delete(30);
    expect(await ask(f, 32)).toMatchObject({ ok: true, role: "bridge" });
  });

  it("refuses a second controller while the first lives, and takes over when it is gone", async () => {
    const f = await registered();
    f.table.set(41, { pid: 41, ppid: 40, birth: ["41", "0"] });
    const take = () =>
      f.bindings.register(f.socketFor(40), {
        conversationId: "seat-a",
        harnessPid: 41,
        nonceHash: seatNonceHash("stray"),
      });
    expect(await take()).toMatchObject({ ok: false, error: "seat_binding_conflict" });
    f.table.delete(10);
    expect(await take()).toMatchObject({ ok: true });
  });

  it("registers only a hash and a live harness, never the controller itself", async () => {
    const f = world(base());
    const socket = f.socketFor(10);
    for (const request of [
      { conversationId: "seat-a", harnessPid: 10, nonceHash: seatNonceHash(NONCE) },
      { conversationId: "seat-a", harnessPid: 9999, nonceHash: seatNonceHash(NONCE) },
      { conversationId: "seat-a", harnessPid: 20, nonceHash: NONCE },
    ])
      expect(await f.bindings.register(socket, request)).toMatchObject({
        ok: false,
        error: "seat_binding_invalid",
      });
  });

  it("allows the launcher's wrapper hop only when registered with depth 2", async () => {
    const f = world(base());
    f.table.set(21, { pid: 21, ppid: 20, birth: ["21", "0"] });
    f.table.set(22, { pid: 22, ppid: 21, birth: ["22", "0"] });
    await f.bindings.register(f.socketFor(10), {
      conversationId: "seat-w",
      harnessPid: 20,
      nonceHash: seatNonceHash(NONCE),
      depth: 2,
    });
    expect(await ask(f, 22, NONCE, "seat-w")).toMatchObject({ ok: true });
    // The wrapper hop is the only extra allowance: the wrapper itself is not the harness's child.
    expect(await ask(f, 21, NONCE, "seat-w")).toMatchObject({
      ok: false,
      error: "seat_bridge_not_registered",
    });
  });

  it("withdraws only for the registered controller", async () => {
    const f = await registered();
    expect(await f.bindings.deregister(f.socketFor(40), "seat-a")).toMatchObject({ ok: false });
    expect(await f.bindings.deregister(f.socketFor(10), "seat-a")).toMatchObject({ ok: true });
    expect(await ask(f, 30)).toMatchObject({ ok: false, error: "seat_binding_required" });
  });
});
