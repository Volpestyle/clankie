import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SeatHookLog, createClaudeWorkerSeatAdapter } from "../src/captain/claude-worker-seat.ts";
import { fleetSeatMailbox } from "../src/captain/fleet-seat.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";

it("keeps watching Claude native subagent work when its real channel poll grace expires", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-watch-takeover-"));
  const mailboxes = new Map<string, SeatOutbox>();
  const mailbox = fleetSeatMailbox(mailboxes, "term-working");
  const hooks = new SeatHookLog(join(root, "hooks.json"));
  const ref = { harness: "claude" as const, sessionId: "working-session", paneId: "w1:p1" };
  const cancellation = new AbortController();
  let store: HerdrWatchStore | undefined;
  try {
    hooks.record(ref.paneId, { schemaVersion: 1, event: "SessionStart", sessionId: ref.sessionId });
    hooks.beginDispatch(ref, "term-working");
    await mailbox.poll(1);
    const agent = {
      paneId: ref.paneId,
      terminalId: "term-working",
      agent: "claude",
      status: "working",
      title: "Native subagent work",
      session: { source: "herdr:claude", kind: "id" as const, value: ref.sessionId },
    };
    const adapter = createClaudeWorkerSeatAdapter({
      hooks,
      consent: async () => ({ approved: true }),
      agent: async () => agent,
      transcript: async () => undefined,
      mailbox: { bound: () => mailbox.bound(), deliver: async () => false },
      timing: { pollMs: 10 },
    });
    const control = await adapter.attach(ref);
    expect(control).toBeDefined();
    const prompts: string[] = [];
    let wake!: () => void;
    const woken = new Promise<void>((resolve) => {
      wake = resolve;
    });
    store = new HerdrWatchStore(join(root, "watches.json"), {
      runner: {
        get: async () => agent,
        resolveTerminal: async () => agent,
        wait: async () => {
          throw new Error("Native controller must retain the watch");
        },
      },
      seatAdapters: [adapter],
    });
    store.start(async (_conversation, prompt) => {
      prompts.push(prompt);
      wake();
    });
    expect(await store.watch("global-default", ref.paneId, "Harvest native subagent work")).toMatchObject({
      outcome: "watching",
    });
    // Native background subagents report to their parent through UserPromptSubmit,
    // too (Claude's hook contract). This is not proof of pane input.
    hooks.record(ref.paneId, { schemaVersion: 1, event: "UserPromptSubmit", sessionId: ref.sessionId });
    // Production worker grace is 15s. No pane input is submitted.
    await new Promise((resolve) => setTimeout(resolve, 15_100));
    expect(mailbox.bound()).toBe(false);
    let settled = false;
    const watching = control!.settled(cancellation.signal).then((event) => {
      settled = true;
      return event;
    });
    void watching.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(settled).toBe(false);
    expect(prompts).toEqual([]);
    hooks.record(ref.paneId, {
      schemaVersion: 1,
      event: "Stop",
      sessionId: ref.sessionId,
      lastMessage: "Finished the work",
    });
    expect(await watching).toMatchObject({ type: "settlement_unconfirmed" });
    await woken;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Finished the work");
    expect(prompts[0]).not.toContain("owner took the seat over");
  } finally {
    cancellation.abort();
    store?.close();
    mailbox.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
