import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { SavedAgentSession } from "../src/agent-sessions.ts";
import type { ConversationAuthority } from "../src/captain/conversation-owner.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import {
  HerdrWatchStore,
  type HerdrAgentSnapshot,
  type HerdrWatchRunner,
} from "../src/captain/herdr-watch.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";

const roots: string[] = [];
const stores: HerdrWatchStore[] = [];
const thread = "0199ab12-0000-7000-8000-000000000001";
const owner = { conversationId: "global-default" };
const authority = (conversationId = owner.conversationId): ConversationAuthority => ({
  owner: { conversationId },
  current: () => true,
  authorize: async () => true,
});
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hire-owner-recovery-"));
  roots.push(root);
  const path = join(root, "herdr-watches.json");
  const accountHome = join(root, "codex");
  mkdirSync(join(accountHome, "sessions"), { recursive: true });
  const transcriptPath = join(accountHome, "sessions", `rollout-${thread}.jsonl`);
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: "session_meta", payload: { id: thread, cwd: root } })}\n`,
  );
  const original: HerdrAgentSnapshot = {
    paneId: "w3:p2",
    terminalId: "term_original",
    agent: "codex",
    status: "idle",
    title: "worker",
    session: { source: "herdr:codex", kind: "path", value: transcriptPath },
    workingDirectory: root,
  };
  let current = { ...original, session: { source: "herdr:codex", kind: "id" as const, value: thread } };
  const sessionKey = JSON.stringify(["local", "codex", thread]);
  new HireOwners(`${path}.owners.json`).bind(
    original.paneId,
    owner,
    original.terminalId,
    undefined,
    occupantIdForHerdrSession(original.session!),
    sessionKey,
  );
  const runner: HerdrWatchRunner = {
    list: async () => [current],
    get: async () => current,
    resolveTerminal: async (id) => (id === current.terminalId ? current : undefined),
    wait: async () => current,
  };
  const open = () => {
    const store = new HerdrWatchStore(path, {
      runner,
      codexAccounts: async () => [{ label: "codex", home: accountHome }],
      validateOwner: async (candidate) => candidate.conversationId === owner.conversationId,
    });
    stores.push(store);
    return store;
  };
  const saved: SavedAgentSession = {
    ref: `local:${thread}`,
    host: "local",
    sessionId: thread,
    workingDirectory: root,
    file: { harness: "codex", path: transcriptPath, size: 1, mtimeMs: 0 },
  };
  return {
    root,
    path,
    original,
    sessionKey,
    runner,
    saved,
    open,
    current: () => current,
    change: (next: typeof current) => {
      current = next;
    },
    journal: () => readFileSync(`${path}.owners.json`, "utf8"),
  };
}

it("keeps a rebound worker closed until its owner re-adopts the same thread, then restores steering and watch admission across restart", async () => {
  const f = fixture();
  const store = f.open();
  store.start(async () => {});
  const before = f.journal();
  expect(store.retainedReportOwner(f.current())).toEqual(owner);
  expect(f.journal()).toBe(before);
  await expect(store.adoptSeat(f.current().terminalId, authority())).rejects.toThrow("native occupant");
  await expect(store.watch(owner.conversationId, f.current().paneId, "completion")).rejects.toThrow(
    "native occupant",
  );
  await store.readoptSeat(f.current().terminalId, authority());
  expect(store.nativeOwner(f.current())).toEqual(owner);
  expect(JSON.parse(f.journal()).hires).toHaveLength(1);
  store.close();
  const restarted = f.open();
  restarted.start(async () => {});
  await restarted.adoptSeat(f.current().terminalId, authority());
  expect(await restarted.watch(owner.conversationId, f.current().paneId, "completion")).toMatchObject({
    outcome: "already_settled",
  });
  expect(() => restarted.nativeOwner(f.original)).toThrow("native occupant");
});

it("refuses a different conversation, unknown thread, conflicting pane claim, or revoked admission without changing durable ownership", async () => {
  const f = fixture();
  const store = f.open();
  const before = f.journal();
  await expect(store.readoptSeat(f.current().terminalId, authority("worker-conversation"))).rejects.toThrow(
    "matching persisted hiring conversation",
  );
  await expect(
    store.readoptSeat(f.current().terminalId, { ...authority(), current: () => false }),
  ).rejects.toThrow("authority is unavailable");
  const known = f.current();
  f.change({ ...known, session: { ...known.session, value: "0199ab12-0000-7000-8000-000000000002" } });
  expect(store.retainedReportOwner(f.current())).toBeUndefined();
  await expect(store.readoptSeat(f.current().terminalId, authority())).rejects.toThrow(
    "matching persisted hiring conversation",
  );
  expect(f.journal()).toBe(before);
  store.close();
  f.change({ ...known, paneId: "w4:p1", terminalId: "term_reused" });
  new HireOwners(`${f.path}.owners.json`).bind(
    "w4:p1",
    owner,
    "term_reused",
    undefined,
    "unrelated-occupant",
    JSON.stringify(["local", "codex", "another-thread"]),
  );
  const conflicting = f.journal();
  const resumed = f.open();
  expect(resumed.retainedReportOwner(f.current())).toBeUndefined();
  await expect(resumed.readoptSeat("term_reused", authority())).rejects.toThrow(
    "different persisted native thread",
  );
  expect(f.journal()).toBe(conflicting);
});

it("an owner-admitted same-thread re-hire replaces the old native owner before returning and survives service replacement", async () => {
  const f = fixture();
  f.change({ ...f.current(), paneId: "w4:p1", terminalId: "term_resumed" });
  const store = f.open();
  const result = await store.spawnSeat(
    { schemaVersion: 1, harness: "codex", title: "worker", workingDirectory: f.root, resume: f.saved.ref },
    undefined,
    undefined,
    f.saved,
    authority(),
  );
  expect(result).toMatchObject({ outcome: "spawned", seat: { paneId: "w4:p1", seatId: "term_resumed" } });
  expect(JSON.parse(f.journal()).hires).toEqual([
    expect.objectContaining({ paneId: "w4:p1", seatId: "term_resumed", sessionKey: f.sessionKey, owner }),
  ]);
  store.close();
  const persisted = new HireOwners(`${f.path}.owners.json`);
  expect(persisted.hasClaim(f.original.paneId, f.original.terminalId)).toBe(false);
  const restarted = f.open();
  expect(restarted.nativeOwner(f.current())).toEqual(owner);
  await restarted.adoptSeat("term_resumed", authority());
});

it("refuses a reattachment that changes its native thread during owner admission", async () => {
  const f = fixture();
  const before = f.journal();
  let resolutions = 0;
  f.runner.resolveTerminal = async () => {
    if (++resolutions === 2)
      f.change({
        ...f.current(),
        session: { ...f.current().session, value: "0199ab12-0000-7000-8000-000000000002" },
      });
    return f.current();
  };
  await expect(f.open().readoptSeat(f.current().terminalId, authority())).rejects.toThrow(
    "changed during admission",
  );
  expect(f.journal()).toBe(before);
});

it("retires a moved thread's old completion wake even when native delivery is already awaiting admission", async () => {
  const f = fixture();
  const store = f.open();
  let firstGuard: (() => Promise<void>) | undefined;
  let notifyArmed!: () => void;
  let release!: () => void;
  const armed = new Promise<void>((resolve) => {
    notifyArmed = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  store.start(async (_conversationId, _text, _discord, guard) => {
    if (firstGuard !== undefined) return;
    firstGuard = guard!;
    notifyArmed();
    await held;
    await guard!();
  });
  await store.readoptSeat(f.current().terminalId, authority());
  await armed;
  f.change({ ...f.current(), paneId: "w4:p1", terminalId: "term_reattached" });
  try {
    await store.readoptSeat("term_reattached", authority());
    await expect(firstGuard!()).rejects.toThrow("before acceptance");
  } finally {
    release();
  }
});
