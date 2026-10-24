/**
 * VUH-2779: messages to a PC Codex seat whose authority checks read the PC.
 * Each such read is an SSH round trip (about 250 ms, measured), so a final
 * authority gate that reran them could never meet its 250 ms bound: every peer
 * message to a PC Codex seat was refused. Real peer messages, watch store,
 * fleet seat control and remote Codex control, against a loopback Codex
 * app-server standing in for the PC's private backend.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { FleetPeerMessage } from "@clankie/protocol";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import {
  HerdrWatchStore,
  type HerdrAgentSnapshot,
  type HerdrWatchRunner,
} from "../src/captain/herdr-watch.ts";
import { PeerSeatMessages, type PeerSeatAuthority } from "../src/captain/peer-seat-messages.ts";
import { remoteCodexControl } from "../src/captain/remote-codex-app-server.ts";

const fleet = { id: "pc", session: "default", ssh: { host: "pc", shell: "powershell" as const } };
const raw = readFileSync(new URL("./fixtures/windows-codex-private-control.json", import.meta.url), "utf8");
const sessionId = "01a10928-d878-7db2-82d0-643dce239a3f";
/**
 * One read through the PC's busy relay (100–200 ms per read on 2026-10-24; a
 * bare SSH round trip measured 230–490 ms). A peer check makes several.
 */
const SSH_MS = 120;
/** A machine access read on a loaded service, past the final gate's 250 ms bound. */
const ACCESS_MS = 300;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const quill: HerdrAgentSnapshot = {
  paneId: "pc/w8:pB",
  terminalId: "pc/term_quill",
  agent: "codex",
  status: "working",
  title: "Quill",
  session: { source: "herdr:codex", kind: "id", value: sessionId },
};
const linden: HerdrAgentSnapshot = {
  paneId: "pc/w18:pW",
  terminalId: "pc/term_linden",
  agent: "claude",
  status: "working",
  title: "Linden",
  session: { source: "herdr:claude", kind: "id", value: "f6dae106-28ee-4de8-9f0f-43bfa9c640ac" },
};

interface Latency {
  /** One native observation of the recipient's pane. */
  readonly observeMs?: number;
  /** Each fresh process proof of the sender, in turn; the last repeats. */
  readonly proofMs?: readonly number[];
}

async function fixture(latency: Latency = {}) {
  const observeMs = [latency.observeMs ?? SSH_MS];
  const proofMs = [...(latency.proofMs ?? [SSH_MS])];
  const root = mkdtempSync(join(tmpdir(), "remote-codex-peer-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Test socket unavailable");
  cleanups.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  // The real Windows producer golden, pointed at the loopback backend.
  type Snapshot = {
    owners: number[];
    processes: Array<{ pid: number; startTime: string }>;
    nativeProcesses: Array<{ pid: number; role: string; endpoint: string; listeners?: { port: number }[] }>;
  };
  const snapshots = JSON.parse(raw) as { first: Snapshot; last: Snapshot };
  for (const snapshot of [snapshots.first, snapshots.last]) {
    const backend = snapshot.nativeProcesses.find((native) => native.role === "server")!;
    backend.listeners![0]!.port = address.port;
    snapshot.nativeProcesses.find((native) => native.role === "tui")!.endpoint =
      `ws://127.0.0.1:${address.port}`;
    snapshot.owners = [backend.pid];
  }
  const steers: string[] = [];
  let clientPort: number | undefined;
  server.on("connection", (socket, request) => {
    clientPort = request.socket.remotePort;
    socket.on("message", (bytes) => {
      const message = JSON.parse(bytes.toString()) as {
        id?: number;
        method: string;
        params?: { input?: { text: string }[] };
      };
      if (message.method === "initialized") return;
      let result: unknown = {};
      if (message.method === "thread/read")
        result = { thread: { id: sessionId, status: { type: "active" } } };
      if (message.method === "thread/turns/list")
        result = { data: [{ id: "kh2-turn", status: "inProgress" }] };
      if (message.method === "turn/steer") {
        steers.push(message.params?.input?.[0]?.text ?? "");
        reads.push({ event: "steer", at: performance.now() });
        result = { turnId: "kh2-turn" };
      }
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(socket, "open");
    if (clientPort === undefined) throw new Error("Test TCP client unavailable");
    return {
      socket,
      connection: { clientPort, serverPort: address.port },
      alive: () => socket.readyState === WebSocket.OPEN,
      close: () => socket.terminate(),
    };
  };
  // Every read of the PC takes an SSH round trip, logged in order with the write.
  // Each remote read's start and completion, and the write, in time order.
  const reads: { readonly event: string; readonly at: number }[] = [];
  const log = (event: string) => reads.push({ event, at: performance.now() });
  let observations = 0;
  const before = new Map<number, () => void>();
  const after = new Map<number, () => void>();
  const hook = (hooks: Map<number, () => void>, observation: number) => {
    const act = hooks.get(observation);
    hooks.delete(observation);
    act?.();
  };
  const shell = async () => {
    const observation = ++observations;
    hook(before, observation);
    log("observe");
    await sleep(observeMs.length > 1 ? observeMs.shift()! : observeMs[0]!);
    const observed = JSON.stringify(snapshots);
    log("observed");
    hook(after, observation);
    return observed;
  };
  const seats = new Map([quill, linden].map((seat) => [seat.terminalId, seat]));
  const runner: HerdrWatchRunner = {
    get: async (pane) => {
      log("pane");
      await sleep(SSH_MS);
      const seat = [...seats.values()].find((candidate) => candidate.paneId === pane);
      if (seat === undefined) throw new Error(`No pane ${pane}`);
      return seat;
    },
    resolveTerminal: async (seat) => {
      log("pane");
      await sleep(SSH_MS);
      return seats.get(seat);
    },
    wait: async () => quill,
  };
  // The owner's machine access, read from settings; its fence rechecks without I/O.
  let accessGeneration = 0;
  let duringAccessRead: (() => void) | undefined;
  const store = new HerdrWatchStore(join(root, "watches.json"), {
    runner,
    remoteCodexControl: (_fleet, paneId) =>
      remoteCodexControl(fleet, shell, async () => "", paneId, { connect, mode: "steer" }),
    remoteCodexQueue: async () => {
      throw new Error("A proven private backend never falls through to the CLI queue");
    },
    requireWorkerAccess: async () => {
      log("access");
      const read = accessGeneration;
      await sleep(ACCESS_MS);
      // Something changes just after this read took the settings.
      const act = duringAccessRead;
      duringAccessRead = undefined;
      act?.();
      return {
        assertCurrent: () => {
          if (accessGeneration !== read) throw new Error("settings_changed");
        },
      };
    },
  });
  cleanups.push(() => store.close());
  // Linden's link to this service, as the fleet link proves it, and its native process.
  let linkAlive = true;
  let senderProcessStart = "agent-start";
  const authority: PeerSeatAuthority = {
    proof: {
      fleet: "pc",
      pane: "w18:pW",
      nativeOccupantId: occupantIdForHerdrSession(linden.session!),
      binding: { socketPath: "C:\\herdr.sock", session: "default" },
      processes: [{ pid: 102, startTime: "agent-start" }],
      shell: { pid: 101, startTime: "shell-start" },
    },
    // A fresh project proof of the sender's process, read on the PC.
    validate: async () => {
      log("proof");
      await sleep(proofMs.length > 1 ? proofMs.shift()! : proofMs[0]!);
      log("proven");
      return linkAlive && senderProcessStart === "agent-start";
    },
    current: () => linkAlive,
  };
  const peers = new PeerSeatMessages({
    path: join(root, "peer-messages.json"),
    enabled: async () => true,
    sender: (pane) => runner.get(pane).catch(() => undefined),
    recipient: (seat) => runner.resolveTerminal(seat),
    seats: async () => [...seats.values()],
    deliver: (seat, text, options) => store.deliverToSeat(seat, text, undefined, options),
    record: () => undefined,
  });
  const message = async (from: PeerSeatAuthority, text: string): Promise<FleetPeerMessage> => {
    const roster = await peers.list(from);
    const target = roster?.seats.find((seat) => seat.seatId === quill.terminalId);
    if (!roster || !target) throw new Error("Quill is not discoverable");
    return {
      schemaVersion: 1,
      seatId: quill.terminalId,
      recipientBinding: target.binding,
      text,
      delivery: { id: randomUUID(), binding: roster.sender.binding },
    };
  };
  return {
    store,
    peers,
    authority,
    message,
    steers,
    reads,
    closeLink: () => (linkAlive = false),
    replaceSenderProcess: () => (senderProcessStart = "replacement-start"),
    changeAccess: () => accessGeneration++,
    /**
     * Replace the recipient's TUI process during the caller's access read that
     * follows the original native observation, just before the final one.
     */
    replaceRecipient: () => {
      for (const snapshot of [snapshots.first, snapshots.last]) {
        const tui = snapshot.nativeProcesses.find((native) => native.role === "tui")!;
        snapshot.processes.find((candidate) => candidate.pid === tui.pid)!.startTime =
          "2026-10-24T15:40:00.0000000Z";
      }
    },
    /** Act as the nth native observation from now starts (1 is a send's original, 2 its first final one). */
    beforeObservation: (nth: number, act: () => void) => before.set(observations + nth, act),
    /** Act as the nth native observation from now completes. */
    afterObservation: (nth: number, act: () => void) => after.set(observations + nth, act),
    /** Act just after the next machine access read. */
    afterAccessRead: (act: () => void) => (duringAccessRead = act),
    /** The next native observations take these times, in turn; the last repeats. */
    setObserveMs: (ms: readonly number[]) => observeMs.splice(0, observeMs.length, ...ms),
  };
}

it("delivers a peer message to a PC Codex seat whose authority reads take SSH round trips", async () => {
  const f = await fixture();
  const receipt = await f.peers.send(
    f.authority,
    await f.message(f.authority, "VUH-2779 delivery probe, no action needed"),
  );
  expect(receipt).toMatchObject({ outcome: "delivered", state: "steered" });
  expect(f.steers).toHaveLength(1);
  expect(f.steers[0]).toContain("VUH-2779 delivery probe, no action needed");
});

it("refuses a peer message whose sender's link closes during the final observation", async () => {
  const f = await fixture();
  const input = await f.message(f.authority, "must not cross a closed link");
  f.beforeObservation(2, f.closeLink);
  expect(await f.peers.send(f.authority, input)).toMatchObject({
    outcome: "undelivered",
    detail: expect.stringContaining("nothing was sent"),
  });
  expect(f.steers).toEqual([]);
});

it("refuses a peer message whose sender's native process changes during the final observation", async () => {
  const f = await fixture();
  const input = await f.message(f.authority, "must not cross a changed sender");
  // The link stays open, so its synchronous recheck alone would pass.
  f.beforeObservation(2, f.replaceSenderProcess);
  expect(await f.peers.send(f.authority, input)).toMatchObject({
    outcome: "undelivered",
    detail: expect.stringContaining("nothing was sent"),
  });
  expect(f.steers).toEqual([]);
});

it("still gates the write on the full check when a peer authority has no synchronous recheck", async () => {
  const f = await fixture();
  const { current: _current, ...full } = f.authority;
  // Its full check reads the PC, so it can't answer within the final bound.
  expect(await f.peers.send(full, await f.message(full, "full check only"))).toMatchObject({
    outcome: "undelivered",
    detail: expect.stringContaining("Final Codex authority check timed out"),
  });
  expect(f.steers).toEqual([]);
});

it("delivers a lead message whose machine access read is slow, and refuses one whose access changed", async () => {
  const f = await fixture();
  expect(await f.store.deliverToSeat(quill.terminalId, "VUH-2779 lead probe")).toMatchObject({
    outcome: "delivered",
    state: "steered",
  });
  // Only the synchronous settings fence can see a change after the last access read.
  f.beforeObservation(2, f.changeAccess);
  expect(await f.store.deliverToSeat(quill.terminalId, "must not cross changed access")).toMatchObject({
    outcome: "undelivered",
    detail: expect.stringContaining("nothing was sent"),
  });
  expect(f.steers).toEqual(["VUH-2779 lead probe"]);
});

it("refuses when the recipient's native process changes during the caller's slow checks", async () => {
  const f = await fixture();
  // The owner's slow machine access read is followed by the final native observation.
  f.afterObservation(1, () => f.afterAccessRead(f.replaceRecipient));
  expect(await f.store.deliverToSeat(quill.terminalId, "must not cross a replaced recipient")).toMatchObject({
    outcome: "undelivered",
    detail: expect.stringContaining("nothing was sent"),
  });
  expect(f.steers).toEqual([]);
});

/** Each write's age of its last completed native observation and sender proof. */
function proofAges(reads: readonly { readonly event: string; readonly at: number }[]) {
  return reads.flatMap((read, index) => {
    if (read.event !== "steer") return [];
    // Only this send's reads: those since the previous write.
    const since = reads.slice(0, index).findLastIndex((entry) => entry.event === "steer") + 1;
    const last = (event: string) => reads.slice(since, index).findLast((entry) => entry.event === event)?.at;
    return [{ observed: read.at - last("observed")!, proven: read.at - (last("proven") ?? read.at) }];
  });
}

it("writes within the bound of both final proofs' completion, however unequal their reads", async () => {
  // The sender's proof takes four times as long as the recipient's observation.
  const f = await fixture({ observeMs: 120, proofMs: [480] });
  expect(
    await f.peers.send(f.authority, await f.message(f.authority, "VUH-2779 unequal-latency probe")),
  ).toMatchObject({ outcome: "delivered", state: "steered" });
  expect(
    await f.store.deliverToSeat(quill.terminalId, "VUH-2779 lead probe after a slow peer proof"),
  ).toMatchObject({ outcome: "delivered" });
  const ages = proofAges(f.reads);
  expect(ages).toHaveLength(2);
  for (const age of ages) {
    expect(age.observed).toBeLessThan(250);
    expect(age.proven).toBeLessThan(250);
  }
});

it("refuses when the recipient changes after a faster observation completes, while the sender's proof is in flight", async () => {
  const f = await fixture({ observeMs: 120, proofMs: [480] });
  const input = await f.message(f.authority, "must not cross a stale observation");
  // The first final observation completes long before the proof; the recipient then changes.
  f.afterObservation(2, f.replaceRecipient);
  expect(await f.peers.send(f.authority, input)).toMatchObject({
    outcome: "undelivered",
    detail: expect.stringContaining("nothing was sent"),
  });
  expect(f.steers).toEqual([]);
});

it("refuses when the final proofs can't complete within the bound of each other", async () => {
  const f = await fixture({ observeMs: 120, proofMs: [120] });
  const input = await f.message(f.authority, "must not cross unaligned proofs");
  // The three final observations alternate slow and fast, so no stagger lines them up.
  f.afterObservation(1, () => f.setObserveMs([480, 120, 480]));
  const receipt = await f.peers.send(f.authority, input);
  expect(receipt).toMatchObject({
    outcome: "undelivered",
    detail: expect.stringContaining("within 250 ms of each other"),
  });
  expect(f.steers).toEqual([]);
});
