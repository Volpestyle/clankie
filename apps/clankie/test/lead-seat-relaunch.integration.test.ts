import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createLeadSeatRelaunch,
  readClaudeSessionUsage,
  type RelaunchLeadSeatInput,
} from "../src/captain/lead-seat-relaunch.ts";
import { ConversationStore } from "../src/captain/conversations/store.ts";
import { paneInputLine } from "../src/captain/pane-draft.ts";
import { capabilities, leadChatFixture } from "./fixtures/lead-chats.ts";

// ADR 0271 (VUH-2274): the lead seat restarts fresh in its own pane. The old
// harness is a real process the relaunch must end with a real signal; Herdr's
// pane observations are reported from that process's actual state.
const golden = (state: string) =>
  readFile(new URL(`./fixtures/pane-draft/claude-${state}.ansi`, import.meta.url), "utf8");
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  vi.restoreAllMocks();
});

async function fixture(
  options: {
    ignoresTerm?: boolean;
    ansi?: string;
    ownerAt?: number;
    now?: () => number;
    root?: string;
    notice?: (conversationId: string, text: string) => void;
  } = {},
) {
  // A shared root is the same service state seen by a restarted service.
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "lead-seat-relaunch-")));
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
    notice: options.notice ?? ((_id, text) => notices.push(text)),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 50))),
    ...(options.now === undefined ? {} : { now: options.now }),
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

// VUH-2821: `clankie claude` launches the lead with `--name Clankie`, and Claude
// Code 2.1.310 draws that name into the composer's top rule. Live captures from a
// throwaway `claude --name Clankie` pane (one settings-warning line removed).
it("restarts a named seat whose composer rule carries its label, and still refuses its draft", async () => {
  const drafted = await fixture({ ansi: await golden("labeled-draft") });
  expect(await drafted.relaunch.relaunchLeadSeat(restart)).toEqual({ outcome: "refused", reason: "draft" });
  expect(drafted.alive()).toBe(true);
  expect(drafted.launched).toEqual([]);
  const named = await fixture({ ansi: await golden("labeled-empty") });
  expect(await named.relaunch.relaunchLeadSeat(restart)).toMatchObject({ outcome: "relaunched" });
  expect(named.alive()).toBe(false);
  expect(named.briefs).toEqual([restart.handoffBrief]);
});

it("keeps a typed labeled rule below the prompt inside the draft", async () => {
  // The label tolerance is the top border's only: an owner can type `─── x ─`.
  const ansi = (await golden("labeled-draft")).replace(
    "❯ unsent owner draft\n",
    "❯ \n──────── Draft notes ─\nmore unsent text\n",
  );
  expect(paneInputLine("claude", ansi)).toMatchObject({ state: "draft", typed: true });
  const f = await fixture({ ansi });
  expect(await f.relaunch.relaunchLeadSeat(restart)).toEqual({ outcome: "refused", reason: "draft" });
  expect(f.alive()).toBe(true);
  expect(f.launched).toEqual([]);
});

// VUH-2821: a due restart's refusals were dropped silently, so a seat could stay
// past its budget for a week with nobody told. The service now keeps the wait.
it("keeps a due restart's refused wait across a service restart, tells the owner once at two hours, and ends it on relaunch", async () => {
  let clock = Date.parse("2026-10-25T12:00:00.000Z");
  const now = () => clock;
  const budget = { contextTokens: 500_000, ageMs: 24 * 3_600_000 };
  const refuse = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const refused = await f.relaunch.preflight(restart);
    expect(refused).toEqual({ outcome: "refused", reason: "draft" });
    if (refused?.outcome === "refused") f.relaunch.restartRefused("global-default", refused.reason);
  };
  const drafted = await fixture({ ansi: await golden("labeled-draft"), now });
  await refuse(drafted);
  clock += 119 * 60_000;
  await refuse(drafted);
  expect(drafted.notices).toEqual([]);
  clock += 60_000;
  await refuse(drafted);
  expect(drafted.notices).toHaveLength(1);
  expect(drafted.notices[0]).toContain("since 2026-10-25T12:00:00.000Z, 120 minutes");
  expect(drafted.notices[0]).toContain(
    "The latest: draft (the pane held an unsent draft). All refusals: draft ×3.",
  );

  const restarted = await fixture({ root: drafted.root, ansi: await golden("labeled-draft"), now });
  clock += 30 * 60_000;
  await refuse(restarted);
  expect(restarted.notices).toEqual([]);
  expect(
    restarted.relaunch.restartStatus({ conversationId: "global-default", setting: "on", budget }),
  ).toEqual({
    schemaVersion: 1,
    conversationId: "global-default",
    setting: "on",
    budget: { contextTokens: 500_000, ageHours: 24 },
    noticeAfterMinutes: 120,
    waiting: {
      since: "2026-10-25T12:00:00.000Z",
      lastAt: "2026-10-25T14:30:00.000Z",
      lastReason: "draft",
      counts: { draft: 4 },
      noticedAt: "2026-10-25T14:00:00.000Z",
    },
  });

  const cleared = await fixture({ root: drafted.root, now });
  expect(await cleared.relaunch.relaunchLeadSeat(restart)).toMatchObject({ outcome: "relaunched" });
  cleared.relaunch.restartSettled("global-default");
  expect(
    cleared.relaunch.restartStatus({ conversationId: "global-default", setting: "on", budget }).waiting,
  ).toBeUndefined();
});

it("records the two-hour notice once when saving it as sent fails, and still sends one never sent", async () => {
  let clock = Date.parse("2026-10-25T12:00:00.000Z");
  const now = () => clock;
  const budget = { contextTokens: 500_000, ageMs: 24 * 3_600_000 };
  const root = await mkdtemp(join(tmpdir(), "lead-seat-restart-notice-"));
  const store = new ConversationStore(join(root, "conversations"), async () => {});
  // Each notice the conversation records bumps its revision; a repeat of the same words does not.
  const base = store.conversation("global-default")!.revision;
  const recorded = () => store.conversation("global-default")!.revision - base;
  // The wait file's temporary path; a directory there makes the next save fail with EISDIR.
  const temporary = `${join(root, "lead-seat-relaunches.json")}.restart-waits.json.${String(process.pid)}.tmp`;
  let afterNotice: (() => void) | undefined;
  const notice = (conversationId: string, text: string) => {
    store.recordServiceNotice(conversationId, text);
    afterNotice?.();
  };
  const first = await fixture({ root, now, notice });
  first.relaunch.restartRefused("global-default", "draft");
  clock += 120 * 60_000;
  afterNotice = () => mkdirSync(temporary);
  expect(() => first.relaunch.restartRefused("global-default", "draft")).toThrow(/EISDIR/u);
  expect(recorded()).toBe(1);
  afterNotice = undefined;
  rmSync(temporary, { recursive: true });

  // A restarted service retries with the stored words, which the conversation already holds.
  clock += 5 * 60_000;
  const restarted = await fixture({ root, now, notice });
  restarted.relaunch.restartRefused("global-default", "busy");
  expect(recorded()).toBe(1);
  expect(
    restarted.relaunch.restartStatus({ conversationId: "global-default", setting: "on", budget }).waiting,
  ).toMatchObject({ noticedAt: "2026-10-25T14:05:00.000Z", counts: { draft: 2, busy: 1 } });
  restarted.relaunch.restartRefused("global-default", "busy");
  expect(recorded()).toBe(1);

  // A notice whose words could not be stored was never sent; the next refusal sends it.
  restarted.relaunch.restartSettled("global-default");
  restarted.relaunch.restartRefused("global-default", "draft");
  clock += 120 * 60_000;
  mkdirSync(temporary);
  expect(() => restarted.relaunch.restartRefused("global-default", "draft")).toThrow(/EISDIR/u);
  expect(recorded()).toBe(1);
  rmSync(temporary, { recursive: true });
  clock += 60_000;
  restarted.relaunch.restartRefused("global-default", "draft");
  expect(recorded()).toBe(2);
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

// VUH-2860: the first live relaunch (receipt 3f20b480) started a new session in
// the lead's pane, but the conversation's stored source still named the session
// it ended. The service's own seat lookup refused the new session, so every hire
// failed and the receipt stayed `launching`. This drives that lookup itself.
it("attaches a relaunch's new session in the same terminal by its open receipt, and refuses it without one", async () => {
  const f = await leadChatFixture(false, cleanup, { nativeSourceProof: true });
  const work = f.leads[1]!;
  const poll = () => f.captain.pollSeatEvents(50, undefined, work, capabilities);
  const source = async () =>
    (
      JSON.parse(await readFile(join(f.root, "conversations", work, "meta.json"), "utf8")) as {
        nativeSource?: { terminalId: string; session?: { value: string } };
      }
    ).nativeSource;
  await poll();
  const ended = f.head.session!.value;
  expect(await source()).toMatchObject({ terminalId: "term_work", session: { value: ended } });

  // The relaunched session runs in the pane. With no receipt it is refused, as before.
  const next = randomUUID();
  f.occupy({ sessionId: next });
  await poll();
  expect((await source())?.session?.value).toBe(ended);

  // The receipt a relaunch leaves when its wait for the new session times out, in the live shape.
  const journal = join(f.root, "lead-seat-relaunches.json");
  const receiptId = randomUUID();
  await writeFile(
    journal,
    JSON.stringify({
      schemaVersion: 1,
      receipts: [
        {
          receiptId,
          conversationId: work,
          paneId: "w4:p2",
          reason: "fresh_restart",
          from: { harness: "claude" },
          to: { harness: "claude" },
          previousSessionId: ended,
          startedAt: "2026-10-26T04:34:28.525Z",
          stage: "launching",
        },
      ],
      launches: {},
    }),
  );
  const receipt = async () =>
    (JSON.parse(await readFile(journal, "utf8")) as { receipts: unknown[] }).receipts.at(-1);

  // The receipt proves only the stored source's own terminal.
  f.occupy({ sessionId: next, terminalId: "term_other" });
  await poll();
  expect((await source())?.session?.value).toBe(ended);
  expect(await receipt()).toMatchObject({ receiptId, stage: "launching" });

  f.occupy({ sessionId: next });
  await poll();
  expect(await source()).toMatchObject({ terminalId: "term_work", session: { value: next } });
  expect(await receipt()).toMatchObject({
    receiptId,
    stage: "relaunched",
    sessionId: next,
    seatId: "term_work",
  });

  // A settled receipt proves nothing further: a later session there is refused again.
  f.occupy({ sessionId: randomUUID() });
  await poll();
  expect((await source())?.session?.value).toBe(next);
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
