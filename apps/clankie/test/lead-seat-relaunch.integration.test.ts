import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createLeadSeatRelaunch,
  readClaudeSessionUsage,
  type RelaunchLeadSeatInput,
} from "../src/captain/lead-seat-relaunch.ts";

// ADR 0271 (VUH-2274): the lead seat restarts fresh in its own pane. The old
// harness is a real process the relaunch must end with a real signal; Herdr's
// pane observations are reported from that process's actual state.
const golden = (state: string) =>
  readFile(new URL(`./fixtures/pane-draft/claude-${state}.ansi`, import.meta.url), "utf8");
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function fixture(options: { ignoresTerm?: boolean; ansi?: string; ownerAt?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "lead-seat-relaunch-"));
  const harness: ChildProcess = spawn(
    process.execPath,
    [
      "-e",
      `${options.ignoresTerm ? "process.on('SIGTERM', () => {});" : ""} setInterval(() => {}, 1000); process.stdout.write('ready');`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  // The stand-in is only a running harness once its signal handling is installed.
  await new Promise<void>((resolve) => harness.stdout!.once("data", () => resolve()));
  let alive = true;
  harness.on("exit", () => {
    alive = false;
  });
  cleanup.push(async () => {
    if (alive) harness.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });
  const launched: (readonly string[])[] = [];
  const briefs: string[] = [];
  const notices: string[] = [];
  let session = "old-session";
  const relaunch = createLeadSeatRelaunch({
    journalPath: join(root, "lead-seat-relaunches.json"),
    seat: async () => ({ paneId: "w1:p1", terminalId: "term_lead", harness: "claude", sessionId: session }),
    paneShell: async () => ({
      shellPid: 4242,
      foreground: alive
        ? [
            {
              pid: 4243,
              name: "node",
              argv: ["node", "/opt/clankie/bin/clankie", "claude2", "--resume", "old-session"],
            },
            { pid: harness.pid!, name: "2.1.296", argv: ["/opt/bin/claude", "--name", "Clankie"] },
          ]
        : [],
    }),
    readPane: async () => options.ansi ?? (await golden("empty")),
    runInPane: async (_pane, argv) => {
      launched.push(argv);
      session = "new-session";
    },
    idle: () => true,
    lastOwnerMessageAt: () => options.ownerAt,
    deliverBrief: async (_id, text) => {
      briefs.push(text);
      return true;
    },
    notice: (_id, text) => notices.push(text),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 50))),
    exitTimeoutMs: 1_500,
    bindTimeoutMs: 1_500,
  });
  return { root, relaunch, launched, briefs, notices, alive: () => alive };
}

const restart: RelaunchLeadSeatInput = {
  conversationId: "global-default",
  harness: "claude",
  account: "claude2",
  reason: "fresh_restart",
  guards: { requireNoDraft: true, quietOwnerMs: 15 * 60_000, requireIdle: true },
  handoffBrief: "In flight: VUH-2274 slice 3. Waiting on James: nothing.",
};

it("relaunches the same command in the same pane, delivers the brief and keeps the launch", async () => {
  const f = await fixture();
  expect(await f.relaunch.leadSeatLaunch("global-default")).toEqual({
    harness: "claude",
    account: "claude2",
  });
  const result = await f.relaunch.relaunchLeadSeat(restart);
  expect(result).toMatchObject({
    outcome: "relaunched",
    seatId: "term_lead",
    sessionId: "new-session",
    launch: { harness: "claude", account: "claude2" },
  });
  expect(f.alive()).toBe(false);
  expect(f.launched).toEqual([["/opt/clankie/bin/clankie", "claude2", "--conversation", "global-default"]]);
  expect(f.briefs).toEqual([restart.handoffBrief]);
  expect(f.notices).toHaveLength(1);
  expect(f.notices[0]).toContain("old-session → new-session");
  // Without an observable launcher, the last relaunch is still known for fail-back.
  expect(await f.relaunch.leadSeatLaunch("global-default")).toEqual({
    harness: "claude",
    account: "claude2",
  });
  expect(
    await f.relaunch.reconcileLeadSeatRelaunch((result as { receiptId: string }).receiptId),
  ).toMatchObject({
    outcome: "relaunched",
    sessionId: "new-session",
  });
});

it("moves the seat to another account's config directory and reports that launch while it runs", async () => {
  const f = await fixture();
  expect(await f.relaunch.relaunchLeadSeat({ ...restart, home: "relative/home" })).toEqual({
    outcome: "refused",
    reason: "invalid_target",
  });
  const result = await f.relaunch.relaunchLeadSeat({
    ...restart,
    account: "jamescvolpe",
    home: "/Users/owner/.claude-jamescvolpe",
    reason: "usage_limit",
    guards: { requireNoDraft: true, quietOwnerMs: 0, requireIdle: false },
  });
  expect(result).toMatchObject({ outcome: "relaunched" });
  expect(f.launched).toEqual([
    [
      "env",
      "CLAUDE_CONFIG_DIR=/Users/owner/.claude-jamescvolpe",
      "/opt/clankie/bin/clankie",
      "claude",
      "--conversation",
      "global-default",
    ],
  ]);
  expect(await f.relaunch.leadSeatLaunch("global-default")).toEqual({
    harness: "claude",
    account: "jamescvolpe",
    home: "/Users/owner/.claude-jamescvolpe",
  });
});

it("refuses before any effect while the owner has a draft or wrote recently", async () => {
  const drafted = await fixture({ ansi: await golden("draft") });
  expect(await drafted.relaunch.relaunchLeadSeat(restart)).toEqual({ outcome: "refused", reason: "draft" });
  const active = await fixture({ ownerAt: Date.now() - 60_000 });
  expect(await active.relaunch.relaunchLeadSeat(restart)).toEqual({
    outcome: "refused",
    reason: "owner_active",
  });
  for (const f of [drafted, active]) {
    expect(f.alive()).toBe(true);
    expect(f.launched).toEqual([]);
  }
});

it("leaves an uncertain receipt, and launches nothing, when the old session will not exit", async () => {
  const f = await fixture({ ignoresTerm: true });
  const result = await f.relaunch.relaunchLeadSeat(restart);
  expect(result).toMatchObject({ outcome: "uncertain" });
  expect(f.launched).toEqual([]);
  expect(f.alive()).toBe(true);
  expect(
    await f.relaunch.reconcileLeadSeatRelaunch((result as { receiptId: string }).receiptId),
  ).toMatchObject({
    outcome: "uncertain",
    detail: "The old session was signalled; no new launch is recorded.",
  });
});

it("reads a Claude session's start and latest main-thread context, unknown after a compaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "lead-seat-usage-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const records = [
    { type: "custom-title", customTitle: "Clankie" },
    { type: "user", timestamp: "2026-10-14T00:05:32.699Z", message: { role: "user", content: "hi" } },
    {
      type: "assistant",
      timestamp: "2026-10-14T00:06:00.000Z",
      message: {
        usage: { input_tokens: 12, cache_read_input_tokens: 480_000, cache_creation_input_tokens: 21_000 },
      },
    },
    {
      type: "assistant",
      isSidechain: true,
      timestamp: "2026-10-14T00:07:00.000Z",
      message: { usage: { input_tokens: 5, cache_read_input_tokens: 9_000 } },
    },
  ];
  const path = join(root, "session.jsonl");
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  expect(await readClaudeSessionUsage(path)).toEqual({
    startedAt: Date.parse("2026-10-14T00:05:32.699Z"),
    contextTokens: 501_012,
  });
  await writeFile(
    path,
    `${[...records, { type: "system", subtype: "compact_boundary" }].map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  expect(await readClaudeSessionUsage(path)).toEqual({ startedAt: Date.parse("2026-10-14T00:05:32.699Z") });
});
