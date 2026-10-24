/**
 * VUH-2779: Claude writes a channel event that arrives mid-turn to its
 * transcript only when it absorbs it at its next tool boundary, often a minute
 * later. Real seat adapter, mailbox, hook log, fleet seat control and remote
 * transcript reader, over a Claude JSONL in the shapes a PC seat wrote.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createLocalAgentHost } from "@clankie/agent-hosts";
import { SeatHookLog, createClaudeWorkerSeatAdapter } from "../src/captain/claude-worker-seat.ts";
import { createFleetSeatControl } from "../src/captain/fleet-seat-control.ts";
import { remoteHerdrTranscriptReader } from "../src/captain/remote-herdr-transcript.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { HerdrFleetError } from "../src/herdr-fleet.ts";

const SESSION = "f6dae106-28ee-4de8-9f0f-43bfa9c64000";
const SERVER = "plugin:clankie-worker:worker";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** A channel event's prompt as Claude records it. */
function channelPrompt(id: string, text: string): string {
  return `<channel source="${SERVER}" kind="message" conversation="pc/term_1" source="captain" event_id="${id}" created_at="${new Date().toISOString()}">\n${text}\n</channel>`;
}

function fixture(options: { earlierChannel: boolean; absorbAfterMs: number }) {
  const home = mkdtempSync(join(tmpdir(), "claude-mid-turn-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const projects = join(home, ".claude", "projects", "-w");
  mkdirSync(projects, { recursive: true });
  const path = join(projects, `${SESSION}.jsonl`);
  let parent: string | null = null;
  const line = (record: Record<string, unknown>) => {
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  };
  const user = (content: string) => {
    const uuid = randomUUID();
    line({
      type: "user",
      uuid,
      parentUuid: parent,
      sessionId: SESSION,
      timestamp: new Date().toISOString(),
      message: { role: "user", content },
    });
    parent = uuid;
  };
  // What a PC seat wrote at absorption: the queue removal, then the attachment
  // stamped with its arrival time, both only once its tool call finished.
  const absorb = (prompt: string, arrivedAt: string) => {
    const commandUuid = randomUUID();
    line({
      type: "queue-operation",
      operation: "remove",
      timestamp: new Date().toISOString(),
      sessionId: SESSION,
      content: prompt,
      reason: "absorbed_mid_turn",
      commandUuid,
    });
    const uuid = randomUUID();
    line({
      parentUuid: parent,
      isSidechain: false,
      attachment: {
        type: "queued_command",
        prompt,
        source_uuid: commandUuid,
        commandMode: "prompt",
        origin: { kind: "channel", server: SERVER },
        timestamp: arrivedAt,
        isMeta: true,
      },
      type: "attachment",
      uuid,
      timestamp: arrivedAt,
      sessionId: SESSION,
    });
    parent = uuid;
  };
  writeFileSync(path, "");
  user("Execute the assignment in the clankieBrief JSON field of @brief.json");
  if (options.earlierChannel)
    absorb(channelPrompt("seat-earlier", "earlier lead message"), new Date().toISOString());

  let status = "working";
  const agent = (): HerdrAgentSnapshot => ({
    paneId: "w1:p1",
    terminalId: "term_1",
    agent: "claude",
    status,
    title: "worker",
    session: { source: "herdr:claude", kind: "id", value: SESSION },
  });
  const mailbox = new SeatOutbox({
    explicitAcknowledgments: true,
    boundGraceMs: 30_000,
    ackTimeoutMs: 5_000,
  });
  cleanups.push(() => mailbox.close());
  // The worker bridge: write each event to Claude, then acknowledge it exactly.
  // Claude takes it at once but records it only when it next pauses between steps.
  let bridging = true;
  cleanups.push(() => (bridging = false));
  const absorbed: string[] = [];
  void (async () => {
    while (bridging) {
      const events = await mailbox.poll(200);
      for (const event of events) {
        const arrivedAt = new Date().toISOString();
        mailbox.acknowledge(event.id);
        const prompt = channelPrompt(event.id, event.content);
        const timer = setTimeout(() => {
          absorb(prompt, arrivedAt);
          absorbed.push(event.id);
        }, options.absorbAfterMs);
        cleanups.push(() => clearTimeout(timer));
      }
    }
  })();
  // Each read probes the host's file size, as a poll after the reader's own
  // freshness window does; these windows are shorter than that cache.
  let clock = Date.now();
  const read = remoteHerdrTranscriptReader(createLocalAgentHost({ home }), () => (clock += 3_000));
  let reads = 0;
  const failing = new Set<number>();
  const transcript = async (snapshot: HerdrAgentSnapshot) => {
    if (failing.has(++reads)) throw new Error("ssh: connection reset");
    return read(snapshot);
  };
  const hooks = new SeatHookLog(join(home, "hooks.json"));
  const adapter = createClaudeWorkerSeatAdapter({
    consent: async () => ({ approved: true }),
    hooks,
    agent: async () => agent(),
    transcript: async (snapshot) => transcript(snapshot as HerdrAgentSnapshot),
    mailbox: {
      bound: () => mailbox.bound() || mailbox.uncertain(),
      // As the service maps its fleet mailbox for Claude seats.
      deliver: async (_seatId, text) => {
        const delivery = await mailbox.deliver({
          kind: "message",
          conversationId: "pc/term_1",
          source: "captain",
          content: text,
          wantsReply: false,
        });
        return delivery.outcome === "unconfirmed"
          ? delivery
          : delivery.outcome === "delivered" && delivery.messageId
            ? {
                outcome: "accepted",
                deliveryStage: "delivered",
                messageId: delivery.messageId,
                state: "queued",
              }
            : delivery.outcome === "delivered";
      },
    },
    timing: { readyMs: 2_000, receiptMs: 600, pollMs: 25 },
    trackerDeny: () => [],
  });
  const runner: HerdrWatchRunner = {
    get: async () => agent(),
    resolveTerminal: async () => agent(),
    wait: async () => agent(),
    transcript,
  };
  const control = createFleetSeatControl(
    runner,
    new Map([["claude", adapter]]),
    undefined,
    undefined,
    undefined,
    join(home, "watches.json.delivery-receipts.json"),
  );
  return {
    adapter,
    control,
    absorbed,
    hooks,
    setStatus: (next: string) => (status = next),
    /** Fail the read this many reads from now (1 = the next one). */
    failRead: (after: number) => failing.add(reads + after),
    resume: () =>
      adapter.start(
        { harness: "claude", cwd: "/w", brief: "", resumeSessionId: SESSION },
        { paneId: "w1:p1", name: "worker", run: async () => undefined, start: async () => undefined },
      ),
  };
}

const until = async (check: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

it("reports a mid-turn message to a proven channel receiver as queued, not uncertain", async () => {
  const f = fixture({ earlierChannel: true, absorbAfterMs: 1_500 });
  expect((await f.resume()).outcome).toBe("started");
  const delivery = await f.control.deliverToSeat("term_1", "VUH-2779 delivery probe, no action needed");
  expect(delivery).toMatchObject({
    outcome: "delivered",
    deliveryStage: "delivered",
    state: "queued",
    messageId: expect.stringMatching(/^seat-/u),
    detail: expect.stringContaining("active turn"),
  });
  // Nothing is held for reconciliation, and Claude records it at its next pause.
  expect(f.absorbed).toEqual([]);
  await until(() => f.absorbed.length === 1);
  expect(f.absorbed[0]).toBe((delivery as { messageId: string }).messageId);
  expect(await f.control.deliverToSeat("term_1", "VUH-2779 second probe")).toMatchObject({
    outcome: "delivered",
    state: "queued",
  });
});

it("keeps a mid-turn message uncertain until the session has proven its channel receiver", async () => {
  const f = fixture({ earlierChannel: false, absorbAfterMs: 1_000 });
  expect((await f.resume()).outcome).toBe("started");
  const control = await f.adapter.attach({ harness: "claude", sessionId: SESSION, paneId: "w1:p1" });
  expect(await control!.send("first message to a new session")).toMatchObject({
    outcome: "unconfirmed",
    deliveryStage: "uncertain",
  });
  // Its late arrival proves the receiver for the next message.
  await until(() => f.absorbed.length === 1);
  expect(await control!.send("second message")).toMatchObject({
    outcome: "accepted",
    deliveryStage: "delivered",
    state: "queued",
  });
});

it("keeps an idle seat's missing receipt uncertain: idle Claude records a channel event at once", async () => {
  const f = fixture({ earlierChannel: true, absorbAfterMs: 1_000 });
  expect((await f.resume()).outcome).toBe("started");
  f.setStatus("idle");
  const control = await f.adapter.attach({ harness: "claude", sessionId: SESSION, paneId: "w1:p1" });
  expect(await control!.send("idle probe")).toMatchObject({
    outcome: "unconfirmed",
    detail: "The worker channel took the message, but it has not appeared in the session transcript",
  });
});

it("confirms an arrival despite a failed transcript read over the fleet link", async () => {
  const f = fixture({ earlierChannel: true, absorbAfterMs: 50 });
  expect((await f.resume()).outcome).toBe("started");
  const control = await f.adapter.attach({ harness: "claude", sessionId: SESSION, paneId: "w1:p1" });
  // The pre-dispatch read succeeds; the first poll after dispatch fails.
  f.failRead(2);
  expect(await control!.send("read gap probe")).toMatchObject({
    outcome: "accepted",
    deliveryStage: "consumed",
  });
});

it("refuses definitively when the session can't be read before dispatch", async () => {
  const f = fixture({ earlierChannel: true, absorbAfterMs: 50 });
  expect((await f.resume()).outcome).toBe("started");
  const control = await f.adapter.attach({ harness: "claude", sessionId: SESSION, paneId: "w1:p1" });
  f.failRead(1);
  const refused = await control!.send("unread probe").catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(HerdrFleetError);
  expect(refused).toMatchObject({ definitive: "not_sent", code: "transcript_unavailable" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(f.absorbed).toEqual([]);
});
