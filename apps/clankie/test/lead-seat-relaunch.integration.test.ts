import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import {
  createLeadSeatRelaunch,
  readClaudeSessionUsage,
  type RelaunchLeadSeatInput,
} from "../src/captain/lead-seat-relaunch.ts";
import { ConversationStore } from "../src/captain/conversations/store.ts";
import { paneInputLine } from "../src/captain/pane-draft.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";
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
    workingDirectory?: string;
    watching?: () => Promise<boolean>;
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
    seat: async () => ({
      paneId: "w1:p1",
      terminalId: "term_lead",
      harness: "claude",
      sessionId: session,
      workingDirectory: options.workingDirectory ?? root,
      binding: `binding:${session}`,
    }),
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
    deliverBrief: async (_id, text, binding) => {
      // Pinned to the new session, never the one it replaced.
      expect(binding).toBe("binding:new-session");
      briefs.push(text);
      return true;
    },
    notice: options.notice ?? ((_id, text) => notices.push(text)),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 50))),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.watching === undefined ? {} : { watching: options.watching }),
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

it.each([false, true])(
  "refuses home-directory trust before ending the lead (persisted flag %s)",
  async (accepted) => {
    const config = process.env.CLAUDE_CONFIG_DIR!;
    mkdirSync(config, { recursive: true });
    await writeFile(
      join(config, ".claude.json"),
      JSON.stringify({ projects: { [homedir()]: { hasTrustDialogAccepted: accepted } } }),
    );
    let clock = Date.now();
    const f = await fixture({ workingDirectory: homedir(), now: () => clock });
    const refused = await f.relaunch.preflight(restart);
    expect(refused).toMatchObject({
      outcome: "refused",
      reason: "trust_required",
      detail: expect.stringContaining("clankie workdir set PATH"),
    });
    expect(await f.relaunch.relaunchLeadSeat(restart)).toEqual(refused);
    expect(f.alive()).toBe(true);
    expect(f.launched).toEqual([]);
    expect(f.briefs).toEqual([]);
    if (refused?.outcome !== "refused") throw new Error("Missing trust refusal");
    f.relaunch.restartRefused("global-default", refused.reason, refused.detail);
    clock += 2 * 3_600_000;
    f.relaunch.restartRefused("global-default", refused.reason, refused.detail);
    expect(f.notices).toEqual([expect.stringContaining("clankie workdir set PATH")]);
    expect(await readFile(join(config, ".claude.json"), "utf8")).toBe(
      JSON.stringify({ projects: { [homedir()]: { hasTrustDialogAccepted: accepted } } }),
    );
  },
);

// Watch (ADR 0308): a failback or fresh restart ends no lead session while Clankie only
// watches, even when Watch is chosen after the first checks passed.
it("leaves the lead running when Watch is chosen before its session would end", async () => {
  let reads = 0;
  // The first read passes; the read right before the signal sees Watch.
  const f = await fixture({ watching: async () => ++reads > 1 });
  expect(await f.relaunch.relaunchLeadSeat({ ...restart, reason: "usage_limit_reset" })).toMatchObject({
    outcome: "refused",
    reason: "watching",
  });
  expect(reads).toBe(2);
  expect(f.alive()).toBe(true);
  expect(f.launched).toEqual([]);
  // Nothing is left uncertain, so a relaunch once Watch ends starts clean.
  reads = -100;
  expect(await f.relaunch.relaunchLeadSeat(restart)).toMatchObject({ outcome: "relaunched" });
});

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
// failed and the receipt stayed `launching`. These drive that lookup itself.
async function relaunchedLead() {
  const f = await leadChatFixture(false, cleanup, { nativeSourceProof: true });
  const work = f.leads[1]!;
  const file = async (path: string) => JSON.parse(await readFile(join(f.root, path), "utf8")) as unknown;
  return {
    ...f,
    work,
    poll: () => f.captain.pollSeatEvents(50, undefined, work, capabilities),
    source: async () =>
      (
        (await file(join("conversations", work, "meta.json"))) as {
          nativeSource?: { terminalId: string; session?: { value: string } };
        }
      ).nativeSource,
    receipt: async () =>
      ((await file("lead-seat-relaunches.json")) as { receipts: unknown[] }).receipts.at(-1),
    handoffs: () => file("lead-seat-relaunches.json.handoffs.json"),
    notices: async () =>
      (await readFile(join(f.root, "conversations", work, "events.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; role?: string; text?: string })
        .filter((event) => event.type === "message" && event.role === "external")
        .map((event) => event.text!),
  };
}

it("attaches a relaunch's new session in the same terminal by its open receipt, and refuses it without one", async () => {
  const { poll, source, receipt, handoffs, notices, work, ...f } = await relaunchedLead();
  await poll();
  const ended = f.head.session!.value;
  expect(await source()).toMatchObject({ terminalId: "term_work", session: { value: ended } });

  // The relaunched session runs in the pane. With no receipt it is refused, as before.
  const next = randomUUID();
  f.occupy({ sessionId: next });
  await poll();
  expect((await source())?.session?.value).toBe(ended);

  // The receipt the live relaunch left when its wait for the new session timed out.
  // Its service kept no brief beside it.
  const receiptId = randomUUID();
  await writeFile(
    join(f.root, "lead-seat-relaunches.json"),
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
  // Hiring recovers, and the conversation is told the brief was never kept, not that it arrived.
  expect(await handoffs()).toEqual({ [receiptId]: { state: "unavailable" } });
  expect(await notices()).toEqual([
    expect.stringContaining(
      `session ${ended} → ${next} on claude. The previous session stays resumable. Its handoff brief was not kept`,
    ),
  ]);

  // A settled receipt proves nothing further: a later session there is refused again.
  f.occupy({ sessionId: randomUUID() });
  await poll();
  expect((await source())?.session?.value).toBe(next);
  expect(await notices()).toHaveLength(1);
});

it("hands a relaunch's kept brief to its new session when it binds after the relaunch stopped waiting", async () => {
  const { poll, source, receipt, handoffs, notices, work, ...f } = await relaunchedLead();
  await poll();
  const ended = f.head.session!.value;
  // The relaunch itself: it ends the old session and launches once, but the new
  // session has not bound when its wait runs out (a logical clock spends it).
  let alive = true;
  let clock = Date.parse("2026-10-26T04:34:28.525Z");
  const launched: (readonly string[])[] = [];
  const delivered: string[] = [];
  const relaunch = createLeadSeatRelaunch({
    journalPath: join(f.root, "lead-seat-relaunches.json"),
    seat: async () => ({
      paneId: "w4:p2",
      terminalId: "term_work",
      harness: "claude",
      sessionId: ended,
      workingDirectory: f.root,
    }),
    paneShell: async () => ({
      shellPid: 4242,
      foreground: alive
        ? [
            { pid: 4243, name: "node", argv: ["node", "/opt/clankie/bin/clankie", "claude"] },
            { pid: 4244, name: "2.1.296", argv: ["/opt/bin/claude", "--name", "Clankie"] },
          ]
        : [],
    }),
    signal: () => {
      alive = false;
    },
    readPane: async () => "",
    runInPane: async (_pane, argv) => {
      launched.push(argv);
    },
    idle: () => true,
    lastOwnerMessageAt: () => undefined,
    deliverBrief: async (_id, text) => {
      delivered.push(text);
      return true;
    },
    notice: () => {},
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  const brief = "In flight: VUH-2860 review. Waiting on James: nothing.";
  const result = await relaunch.relaunchLeadSeat({
    conversationId: work,
    harness: "claude",
    reason: "fresh_restart",
    guards: { requireNoDraft: false, quietOwnerMs: 0, requireIdle: false },
    handoffBrief: brief,
  });
  expect(result).toMatchObject({ outcome: "uncertain" });
  expect(launched).toEqual([["/opt/clankie/bin/clankie", "claude", "--conversation", work]]);
  expect(delivered).toEqual([]);

  // Later the new session runs in the pane, and its real seat bridge polls and acknowledges.
  const next = randomUUID();
  f.occupy({ sessionId: next });
  const channel = await f.bridge(work);
  const briefs = () =>
    channel.mock.calls
      .map(([event]) => (event as { params: { content: string } }).params.content)
      .filter((content) => content.includes(brief));
  await expect.poll(briefs, { timeout: 5_000 }).toHaveLength(1);
  await expect.poll(handoffs).toEqual({
    [(result as { receiptId: string }).receiptId]: { state: "delivered" },
  });
  expect(await source()).toMatchObject({ session: { value: next } });
  expect(await receipt()).toMatchObject({ stage: "relaunched", sessionId: next, seatId: "term_work" });
  expect(await notices()).toEqual([
    expect.stringContaining(
      `session ${ended} → ${next} on claude. The previous session stays resumable. The handoff brief was delivered to it.`,
    ),
  ]);
  // Later polls never send it again.
  await poll();
  await poll();
  expect(briefs()).toHaveLength(1);
});

// The new session's first poll can be taken by other work, leaving its brief
// queued. If another relaunch replaces it before its next poll, the brief stays
// its own: the replacement can neither take nor acknowledge it.
it.each([false, true])(
  "keeps a queued brief for the session its receipt names (replaced before taking it: %s)",
  async (replaced) => {
    const { poll, receipt, handoffs, notices, work, ...f } = await relaunchedLead();
    const global = f.leads[0]!;
    await poll();
    const ended = f.head.session!.value;
    const [first, second] = [randomUUID(), randomUUID()];
    const relaunched = (receiptId: string, previousSessionId: string) => ({
      receiptId,
      conversationId: work,
      paneId: "w4:p2",
      reason: "fresh_restart",
      from: { harness: "claude" },
      to: { harness: "claude" },
      previousSessionId,
      startedAt: "2026-10-26T04:34:28.525Z",
      stage: "launching",
    });
    const journal = join(f.root, "lead-seat-relaunches.json");
    const receiptId = randomUUID();
    const brief = "This brief belongs to the first new session only.";
    await writeFile(
      journal,
      JSON.stringify({ schemaVersion: 1, receipts: [relaunched(receiptId, ended)], launches: {} }),
    );
    await writeFile(`${journal}.handoffs.json`, JSON.stringify({ [receiptId]: { state: "pending", brief } }));
    f.occupy({ sessionId: first });

    // Another lead's message is queued before the new session's first poll.
    const lead = "Deploy at 18:00?";
    const deliver = SeatOutbox.prototype.deliver;
    let queued!: () => void;
    const waiting = new Promise<void>((resolve) => (queued = resolve));
    vi.spyOn(SeatOutbox.prototype, "deliver").mockImplementation(function (this: SeatOutbox, input) {
      const result = deliver.call(this, input);
      if (input.content.includes(lead)) queued();
      return result;
    });
    const sending = f.messageSeat(global, "term_work", lead);
    await waiting;
    const contents = (events: readonly { id: string; content?: string }[]) =>
      events.map((event) => event.content ?? "");
    const taken = await poll();
    expect(contents(taken).some((content) => content.includes(lead))).toBe(true);
    expect(contents(taken).some((content) => content.includes(brief))).toBe(false);
    for (const event of taken) await f.captain.acknowledgeSeatEvent(event.id, work);
    await sending;
    expect(await receipt()).toMatchObject({ receiptId, stage: "relaunched", sessionId: first });
    expect(await handoffs()).toEqual({ [receiptId]: { state: "attempting" } });

    if (replaced) {
      const journaled = JSON.parse(await readFile(journal, "utf8")) as { receipts: unknown[] };
      journaled.receipts.push(relaunched(randomUUID(), first));
      await writeFile(journal, JSON.stringify(journaled));
      f.occupy({ sessionId: second });
    }
    const next = await poll();
    for (const event of next) await f.captain.acknowledgeSeatEvent(event.id, work);
    expect(contents(next).some((content) => content.includes(brief))).toBe(!replaced);
    await expect
      .poll(async () => ((await handoffs()) as Record<string, unknown>)[receiptId])
      .toEqual({ state: replaced ? "undelivered" : "delivered" });
    expect(await notices()).toContainEqual(
      expect.stringContaining(
        `session ${ended} → ${first} on claude. The previous session stays resumable. ${
          replaced
            ? "The handoff brief did not reach it; it starts from the shared log."
            : "The handoff brief was delivered to it."
        }`,
      ),
    );
  },
);

// VUH-2868: the second live relaunch (receipt 9965d2ff) launched Claude in the
// lead's pane, where it waited at the home-folder trust prompt with no session.
// The stored source still named the ended session, so the service body's hire
// for its routed project was refused as a changed agent. These drive hire_agent.
it("hires into the routed project while an open relaunch's successor has no session, and refuses anything less", async () => {
  let proofUnavailable = false;
  let paneReadFails = false;
  const f = await leadChatFixture(false, cleanup, {
    nativeSourceProof: true,
    defaultLead: true,
    paneReadFails: () => paneReadFails,
    // As the service's own observer reports the pane: a session's occupant, or a
    // proven startup process that has not reported a session yet.
    projectHireIdentity: async (fleet, pane) => {
      if (proofUnavailable) return undefined;
      const occupant = f.current();
      return {
        fleet,
        pane,
        ...(occupant.session === undefined
          ? { nativeOccupantId: `process-${occupant.terminalId}`, nativeSessionPending: true as const }
          : { nativeOccupantId: occupantIdForHerdrSession(occupant.session) }),
        binding: { socketPath: join(f.root, "herdr.sock") },
        processes: [{ pid: process.pid, startTime: "fixture" }],
        shell: { pid: process.pid, startTime: "fixture" },
      };
    },
  });
  const conversation = "global-default";
  await f.captain.pollSeatEvents(50, undefined, conversation, capabilities);
  const ended = f.head.session!.value;
  const source = async () =>
    (
      JSON.parse(await readFile(join(f.root, "conversations", conversation, "meta.json"), "utf8")) as {
        nativeSource?: { terminalId: string; session?: { value: string } };
      }
    ).nativeSource;
  expect(await source()).toMatchObject({ terminalId: "term_work", session: { value: ended } });

  // global-default leads `clankie` by Auto routing; `unrouted` is no project it leads.
  const folder = async (name: string) => {
    await mkdir(join(f.root, name));
    return realpath(join(f.root, name));
  };
  const clankie = await folder("clankie");
  const unrouted = await folder("unrouted");
  await f.settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "clankie",
          name: "Clankie",
          auto: true,
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: clankie }],
        },
        {
          id: "unrouted",
          name: "Unrouted",
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: unrouted }],
        },
      ],
    }),
  }));
  const bank = await f.captain.laneToolBank("operator", conversation);
  const spawn = vi.spyOn(HerdrWatchStore.prototype, "spawnSeat");
  const hire = async (workingDirectory = clankie, projectId: string | null = "clankie") => {
    const result = await bank.tools
      .find((tool) => tool.name === "hire_agent")!
      .call({
        harness: "codex",
        effort: "medium",
        effortReason: "One bounded runtime fix and its proof.",
        title: "Iris",
        role: "builder",
        workingDirectory,
        ...(projectId === null ? {} : { projectId }),
        brief: "Own VUH-2825.",
      });
    const text = result.content.find((part) => part.type === "text");
    return JSON.parse(text?.type === "text" ? text.text : "null") as Record<string, unknown>;
  };
  const refused = (detail: string) => ({
    outcome: "failed",
    reason: "not_ready",
    detail: expect.stringContaining(detail),
  });
  const changed = refused("original agent has changed");
  const journal = (receipt: Record<string, unknown> = {}) =>
    writeFile(
      join(f.root, "lead-seat-relaunches.json"),
      JSON.stringify({
        schemaVersion: 1,
        receipts: [
          {
            receiptId: randomUUID(),
            conversationId: conversation,
            paneId: "w4:p2",
            reason: "fresh_restart",
            from: { harness: "claude" },
            to: { harness: "claude" },
            previousSessionId: ended,
            startedAt: "2026-10-26T15:13:04.825Z",
            stage: "launching",
            ...receipt,
          },
        ],
        launches: {},
      }),
    );

  // The relaunch's Claude waits at the trust prompt: same terminal, no session.
  f.occupy({ sessionId: undefined });
  // With no receipt, or one that ended another session, the change is unexplained.
  expect(await hire()).toMatchObject(changed);
  await journal({ previousSessionId: randomUUID() });
  expect(await hire()).toMatchObject(changed);

  await journal();
  // A missing proof or pane read is no proof that the successor has no session.
  proofUnavailable = true;
  expect(await hire()).toMatchObject(changed);
  proofUnavailable = false;
  paneReadFails = true;
  expect(await hire()).toMatchObject(changed);
  paneReadFails = false;
  // Another terminal, another harness, or a proven session is a changed agent.
  for (const occupant of [
    { sessionId: undefined, terminalId: "term_other" },
    { sessionId: undefined, agent: "codex" },
    { sessionId: randomUUID() },
  ]) {
    f.occupy(occupant);
    expect(await hire(), JSON.stringify(occupant)).toMatchObject(changed);
  }
  f.occupy({ sessionId: undefined });
  // Only the project this conversation's routing assigns it, in that project's folder.
  expect(await hire(unrouted, "unrouted")).toMatchObject(changed);
  expect(await hire(clankie, null)).toMatchObject(changed);
  expect(await hire(unrouted, "clankie")).toMatchObject(refused("different projects"));
  expect(spawn).not.toHaveBeenCalled();

  // The exact open receipt: the hire passes both project admissions and stops only
  // because this fixture has no harness adapter.
  expect(await hire()).toMatchObject({
    outcome: "failed",
    reason: "harness_unavailable",
    control: { reason: "pane_run_unavailable" },
  });
  expect(spawn).toHaveBeenCalledOnce();
  expect(await source()).toMatchObject({ terminalId: "term_work", session: { value: ended } });

  // A settled receipt proves nothing more about a pane without a session.
  await journal({ stage: "relaunched", sessionId: randomUUID(), seatId: "term_work" });
  expect(await hire()).toMatchObject(changed);
  expect(spawn).toHaveBeenCalledOnce();
});

// 2026-10-31: after the owner's Mac restart, Clankie's own thread came back on a new
// session, and a connected app's start_agent was refused as "The conversation's
// original agent has changed". That thread only leads a connector's hire; the owner's
// granted place decides its project (ADR 0301), so its own agent's change can't block it.
it("starts a connected app's agent in a granted place after Clankie's own agent changed", async () => {
  const f = await leadChatFixture(false, cleanup, {
    nativeSourceProof: true,
    defaultLead: true,
    projectHireIdentity: async (fleet, pane) => {
      const occupant = f.current();
      return {
        fleet,
        pane,
        nativeOccupantId:
          occupant.session === undefined
            ? `process-${occupant.terminalId}`
            : occupantIdForHerdrSession(occupant.session),
        binding: { socketPath: join(f.root, "herdr.sock") },
        processes: [{ pid: process.pid, startTime: "fixture" }],
        shell: { pid: process.pid, startTime: "fixture" },
      };
    },
  });
  const conversation = "global-default";
  await f.captain.pollSeatEvents(50, undefined, conversation, capabilities);
  await mkdir(join(f.root, "elsewhere"));
  const elsewhere = await realpath(join(f.root, "elsewhere"));
  await f.settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "elsewhere",
          name: "Elsewhere",
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: elsewhere }],
        },
      ],
    }),
  }));
  const spawn = vi.spyOn(HerdrWatchStore.prototype, "spawnSeat");
  const start = () =>
    f.captain.serveOperatorConversation({
      op: "start_agent",
      schemaVersion: 1,
      machine: "local",
      workingDirectory: elsewhere,
      harness: "codex",
    });
  // Clankie's own thread now runs another session than the one it stored.
  f.occupy({ sessionId: randomUUID() });
  const bank = await f.captain.laneToolBank("operator", conversation);
  const own = await bank.tools
    .find((tool) => tool.name === "hire_agent")!
    .call({
      harness: "codex",
      effort: "medium",
      effortReason: "A bounded check.",
      title: "Iris",
      role: "builder",
      workingDirectory: elsewhere,
      projectId: "elsewhere",
      brief: "Check one thing.",
    });
  // His own hire from that thread is still checked against its changed agent.
  expect(JSON.stringify(own.content)).toContain("original agent has changed");
  expect(spawn).not.toHaveBeenCalled();

  // The connected app's start passes project admission and stops only because this
  // fixture has no harness adapter.
  const started = await start();
  expect(started).toMatchObject({ op: "start_agent", status: "refused" });
  expect(JSON.stringify(started)).not.toContain("original agent has changed");
  expect(started).toMatchObject({ detail: expect.stringContaining("isn't installed or signed in") });
  expect(spawn).toHaveBeenCalledOnce();
});

it("rebinds a cleared or restarted lead session in the same pane when Herdr detection is on", async () => {
  const f = await leadChatFixture(false, cleanup, {
    nativeSourceProof: true,
    defaultLead: true,
    connectorSessionDetection: () => true,
    projectHireIdentity: async (fleet, pane) => {
      const occupant = f.current();
      return {
        fleet,
        pane,
        ...(occupant.session === undefined
          ? { nativeOccupantId: `process-${occupant.terminalId}`, nativeSessionPending: true as const }
          : { nativeOccupantId: occupantIdForHerdrSession(occupant.session) }),
        binding: { socketPath: join(f.root, "herdr.sock") },
        processes: [{ pid: process.pid, startTime: "fixture" }],
        shell: { pid: process.pid, startTime: "fixture" },
      };
    },
  });
  const conversation = "global-default";
  await f.captain.pollSeatEvents(50, undefined, conversation, capabilities);
  const ended = f.head.session!.value;
  const source = async () =>
    (
      JSON.parse(await readFile(join(f.root, "conversations", conversation, "meta.json"), "utf8")) as {
        nativeSource?: { terminalId: string; session?: { value: string } };
      }
    ).nativeSource;
  const folder = async (name: string) => {
    await mkdir(join(f.root, name));
    return realpath(join(f.root, name));
  };
  const clankie = await folder("clankie");
  await f.settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "clankie",
          name: "Clankie",
          auto: true,
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: clankie }],
        },
      ],
    }),
  }));
  const bank = await f.captain.laneToolBank("operator", conversation);
  const spawn = vi.spyOn(HerdrWatchStore.prototype, "spawnSeat");
  const hire = async () => {
    const result = await bank.tools
      .find((tool) => tool.name === "hire_agent")!
      .call({
        harness: "codex",
        effort: "medium",
        effortReason: "One bounded runtime fix and its proof.",
        title: "Iris",
        role: "builder",
        workingDirectory: clankie,
        projectId: "clankie",
        brief: "Own the cleared session.",
      });
    const text = result.content.find((part) => part.type === "text");
    return JSON.parse(text?.type === "text" ? text.text : "null") as Record<string, unknown>;
  };
  const changed = {
    outcome: "failed",
    reason: "not_ready",
    detail: expect.stringContaining("original agent has changed"),
  };

  const restarted = randomUUID();
  f.occupy({ sessionId: restarted });
  expect(await hire()).toMatchObject({
    outcome: "failed",
    reason: "harness_unavailable",
    control: { reason: "pane_run_unavailable" },
  });
  expect(spawn).toHaveBeenCalledOnce();
  expect(await source()).toMatchObject({ terminalId: "term_work", session: { value: restarted } });

  f.occupy({ sessionId: randomUUID(), agent: "codex" });
  expect(await hire()).toMatchObject(changed);
  f.occupy({ sessionId: randomUUID(), terminalId: "term_other" });
  expect(await hire()).toMatchObject(changed);
  expect(spawn).toHaveBeenCalledOnce();
  expect(ended).not.toBe(restarted);
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
