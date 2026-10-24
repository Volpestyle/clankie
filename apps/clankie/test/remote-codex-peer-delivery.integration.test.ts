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

async function fixture() {
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
  // Every read of the PC takes an SSH round trip; the final observation can be held.
  let observations = 0;
  let onFinalObservation: (() => void) | undefined;
  const shell = async () => {
    await sleep(SSH_MS);
    // Each send observes the pane twice; the second is the final observation.
    if (++observations % 2 === 0 && onFinalObservation) {
      const act = onFinalObservation;
      onFinalObservation = undefined;
      act();
    }
    return JSON.stringify(snapshots);
  };
  const seats = new Map([quill, linden].map((seat) => [seat.terminalId, seat]));
  const runner: HerdrWatchRunner = {
    get: async (pane) => {
      await sleep(SSH_MS);
      const seat = [...seats.values()].find((candidate) => candidate.paneId === pane);
      if (seat === undefined) throw new Error(`No pane ${pane}`);
      return seat;
    },
    resolveTerminal: async (seat) => {
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
      const read = accessGeneration;
      await sleep(ACCESS_MS);
      // The owner changes settings just after this read took them.
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
      await sleep(SSH_MS);
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
    closeLink: () => (linkAlive = false),
    replaceSenderProcess: () => (senderProcessStart = "replacement-start"),
    /** Change settings after the next access read, the last one before the write. */
    changeAccessAfterNextRead: () => (duringAccessRead = () => accessGeneration++),
    duringFinalObservation: (act: () => void) => (onFinalObservation = act),
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
  f.duringFinalObservation(f.closeLink);
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
  f.duringFinalObservation(f.replaceSenderProcess);
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
  // The full access check after the final observation reads the old settings;
  // only the synchronous fence can see the change that follows it.
  f.duringFinalObservation(f.changeAccessAfterNextRead);
  expect(await f.store.deliverToSeat(quill.terminalId, "must not cross changed access")).toMatchObject({
    outcome: "undelivered",
    detail: expect.stringContaining("nothing was sent"),
  });
  expect(f.steers).toEqual(["VUH-2779 lead probe"]);
});
