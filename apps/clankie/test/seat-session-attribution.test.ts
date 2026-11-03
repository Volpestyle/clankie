import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ConversationAuthority } from "../src/captain/conversation-owner.ts";
import {
  HerdrWatchStore,
  type HerdrAgentSnapshot,
  type HerdrWatchRunner,
} from "../src/captain/herdr-watch.ts";

// #338: a lead's message to a working Claude worker was refused with "Exact native session
// attribution is unavailable" while the same worker kept reporting. A snapshot that misses a
// live agent's session is read again before refusing, and a refusal says what is missing.
const roots: string[] = [];
const stores: HerdrWatchStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const authority: ConversationAuthority = {
  owner: { conversationId: "lead" },
  current: () => true,
  authorize: async () => true,
};
const worker: HerdrAgentSnapshot = {
  paneId: "w1:p1",
  terminalId: "term_1a2b",
  agent: "claude",
  status: "working",
  title: "worker",
  session: { source: "herdr:claude", kind: "id", value: "0b3c8f2e-6f1d-4c59-9a7e-2f1d8c3b5a61" },
};

/** A store whose runner answers each resolve with the next snapshot, repeating the last. */
function store(snapshots: (HerdrAgentSnapshot | undefined)[]) {
  const root = mkdtempSync(join(tmpdir(), "seat-session-"));
  roots.push(root);
  let reads = 0;
  const next = async () => snapshots[Math.min(reads++, snapshots.length - 1)];
  const runner: HerdrWatchRunner = {
    list: async () => [],
    get: async () => (await next())!,
    resolveTerminal: next,
    wait: async () => worker,
  };
  const opened = new HerdrWatchStore(join(root, "herdr-watches.json"), { runner });
  stores.push(opened);
  return { store: opened, reads: () => reads };
}

it("adopts a working worker whose session one snapshot missed", async () => {
  const { session: _session, ...unattributed } = worker;
  const f = store([unattributed, unattributed, worker]);
  expect(await f.store.adoptSeat(worker.terminalId, authority)).toEqual({ adopted: true });
  expect(f.store.nativeOwner(worker)).toEqual({ conversationId: "lead" });
});

it("refuses a worker Herdr never names a session for, saying what is missing and how to recover", async () => {
  const { session: _session, ...unattributed } = worker;
  const f = store([unattributed]);
  const refused = f.store.adoptSeat(worker.terminalId, authority);
  await expect(refused).rejects.toThrow(
    "Herdr names no native session for the claude agent in seat term_1a2b, so nothing was sent",
  );
  await expect(refused).rejects.toThrow("claude --resume");
  // The first read and every retry, then the refusal: nothing else was attempted.
  expect(f.reads()).toBe(4);
});

it("names an empty seat or a shell instead of a missing session", async () => {
  await expect(store([undefined]).store.adoptSeat(worker.terminalId, authority)).rejects.toThrow(
    "No agent holds seat term_1a2b now",
  );
  const shell = store([{ ...worker, agent: "shell" }]);
  await expect(shell.store.adoptSeat(worker.terminalId, authority)).rejects.toThrow(
    "Seat term_1a2b holds no coding agent now (Herdr reports shell)",
  );
  // A shell isn't an agent waiting for its session: it is refused on the first read.
  expect(shell.reads()).toBe(1);
});
