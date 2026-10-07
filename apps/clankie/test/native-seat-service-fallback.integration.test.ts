import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OperatorSeatEventSchema, type OperatorSeatEvent } from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { AutonomyStore } from "../src/captain/autonomy.ts";
import { createConversationRunner } from "../src/captain/captain-conversation-runner.ts";
import { seatEventKindFor } from "../src/captain/captain-session.ts";
import type { LaneSession } from "../src/captain/captain-types.ts";
import { createWorkerReports } from "../src/captain/captain-worker-reports.ts";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { CONVERSATION_PROJECTION_BUDGET } from "../src/captain/conversations/service-handoff.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import { InboundSeatReceipts } from "../src/captain/inbound-seat-receipts.ts";
import { LaneLog } from "../src/captain/lane-log.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";
import { createServiceHandoffDelivery } from "../src/captain/service-handoff-delivery.ts";
import { TurnSettledLog } from "../src/captain/turn-metrics.ts";

// ADR 0218 (2026-10-06 amendment): real conversation admission, driver fence,
// journals, inbound receipts, seat outbox and handoff state. Only the model is
// replaced: a scripted Pi session that answers without a provider.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

type PiEvent = { type: string; [key: string]: unknown };

class ScriptedPiSession {
  public isStreaming = false;
  public readonly state: { messages: { role: string; stopReason?: string; content?: unknown }[] } = {
    messages: [],
  };
  public readonly prompts: string[] = [];
  public readonly resourceLoader = { getSkills: () => ({ skills: [] }) };
  private readonly listeners = new Set<(event: PiEvent) => void>();

  private readonly script: Script;

  public constructor(script: Script) {
    this.script = script;
  }

  public subscribe(listener: (event: PiEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public getContextUsage(): undefined {
    return undefined;
  }

  public async abort(): Promise<void> {}

  public dispose(): void {}

  public prompt(text: string): Promise<void> {
    if (this.script.fail) throw new Error("scripted provider outage");
    this.prompts.push(text);
    this.isStreaming = true;
    this.emit({ type: "agent_start" });
    return (async () => {
      await this.script.gate();
      const reply = `Service handled: ${/(?:Wake|Report) [A-Z]\b/u.exec(text)?.[0] ?? "input"}`;
      const message = { role: "assistant", content: [{ type: "text", text: reply }], stopReason: "stop" };
      this.state.messages.push(message);
      this.emit({ type: "message_end", message });
      this.isStreaming = false;
    })();
  }

  private emit(event: PiEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

interface Script {
  fail: boolean;
  gate: () => Promise<void>;
}

function fixture(root = mkdtempSync(join(tmpdir(), "native-seat-fallback-"))) {
  const autonomy = new AutonomyStore(join(root, "autonomy.json"));
  const settings = new SettingsStore(join(root, "settings.json"));
  const outboxes = new Map<string, SeatOutbox>();
  const outbox = (id: string) => {
    let box = outboxes.get(id);
    if (!box) {
      box = new SeatOutbox({ uncertaintyPath: join(root, `${id}-outbox.json`) });
      outboxes.set(id, box);
    }
    return box;
  };
  const script: Script = { fail: false, gate: async () => {} };
  const sessions: ScriptedPiSession[] = [];
  const lanes = new Map<string, LaneSession>();
  let freshSessions = 0;
  const durableSession = async (
    key: string,
    _lane: unknown,
    _dir: string,
    _systemTools: boolean,
    _cwd: string,
    _side?: boolean,
    _run?: unknown,
    fresh = false,
  ): Promise<LaneSession> => {
    if (fresh) {
      lanes.delete(key);
      freshSessions += 1;
    }
    let lane = lanes.get(key);
    if (lane === undefined) {
      const session = new ScriptedPiSession(script);
      sessions.push(session);
      lane = {
        session,
        capture: {},
        quietSkills: new Set<string>(),
        lastAssistantText: "",
        turnCounter: 0,
      } as unknown as LaneSession;
      lanes.set(key, lane);
    }
    return lane;
  };
  const shutdown = new AbortController();
  const runner = createConversationRunner({
    shutdown,
    get conversations() {
      return conversations;
    },
    settings: () => settings.load(),
    options: { repoRoot: root, stateDir: root },
    workingDirectory: root,
    seatEventKind: (id, context) =>
      outbox(id).bound() || outbox(id).uncertain() ? seatEventKindFor(context, true) : undefined,
    seatOutbox: outbox,
    durableSession,
    buildSession: async () => {
      throw new Error("Operator turns use the durable session");
    },
    captureEvaluationStart: () => {},
    autonomy,
    syncModel: async () => {},
    laneLog: new LaneLog(join(root, "lanes")),
    censusFleets: async () => [],
    deps: { herdrAvailable: () => false } as unknown as CaptainDeps,
    turnSettled: new TurnSettledLog(join(root, "turn-settled.jsonl")),
    goalExecutionReason: () => undefined,
    refuseNativeGoal: () => false,
  });
  const conversations = new ConversationStore(join(root, "conversations"), runner);
  const unusedNativeProbe = async (): Promise<never> => {
    throw new Error("Conversation-owned report recovery must not probe another native seat");
  };
  const reports = createWorkerReports({
    conversations,
    seatOutboxes: outboxes,
    shutdown,
    onChange: () => {},
    validateConversationOwner: async (owner) => conversations.runsCaptainTurns(owner.conversationId),
    herdrRunner: { get: unusedNativeProbe, wait: unusedNativeProbe, resolveTerminal: unusedNativeProbe },
    herdrWatches: new HerdrWatchStore(join(root, "watches.json")),
    inboundBinding: () => undefined,
    nativeRecipientCurrent: async () => false,
    deliverToSeat: async () => {
      throw new Error("Conversation reports use their own mailbox");
    },
  });
  const handoff = createServiceHandoffDelivery({
    conversations,
    seatOutbox: outbox,
    shutdown: shutdown.signal,
  });
  const receipts = new InboundSeatReceipts(join(root, "inbound.json"), conversations);
  const wakeRuns: number[] = [];
  const wakeSettlements: number[] = [];
  autonomy.start(async (id, prompt, origin) => {
    wakeRuns.push(Date.now());
    try {
      const result = conversations.submitInternal(id, prompt, origin);
      if (result.status !== "accepted" || !(await conversations.awaitRunResult(result.runId)))
        throw new Error("Internal autonomy turn failed");
    } finally {
      wakeSettlements.push(Date.now());
    }
  });
  const close = async () => {
    autonomy.close();
    shutdown.abort();
    for (const box of outboxes.values()) box.close();
    await conversations.close();
  };
  cleanups.push(async () => {
    await close();
    rmSync(root, { recursive: true, force: true });
  });
  /** The captain's poll composition: the driver fence, then bind, then the handoff. */
  const pollSeat = (id: string, waitMs: number) =>
    conversations.pollConversationDriver(id, () => {
      const pending = outbox(id).poll(waitMs);
      handoff(id);
      return pending;
    });
  const report = (id: string, text: string) => {
    const delivery = { id: randomUUID(), binding: "a".repeat(64) };
    const accept = () =>
      receipts.accept(
        "w1:p1",
        delivery,
        text,
        `Worker output: ${text}`,
        id,
        // The production host selects this runner whenever a head seat exists.
        reports.conversationReportRunner({ conversationId: id }, delivery.id),
        { source: "adoption", conversationId: id },
        { kind: "conversation", owner: { conversationId: id } },
      );
    return { delivery, accept };
  };
  return {
    root,
    autonomy,
    conversations,
    reports,
    outbox,
    script,
    sessions,
    wakeRuns,
    wakeSettlements,
    close,
    pollSeat,
    report,
    freshSessions: () => freshSessions,
    events: (id: string) => new ConversationJournal(join(root, "conversations")).read(id),
  };
}

const ID = "global-default";

function harnessTurns(count: number, size: number) {
  return Array.from({ length: count }, (_, index) => ({
    type: "message" as const,
    id: `native-${String(index)}`,
    role: index % 2 === 0 ? ("operator" as const) : ("agent" as const),
    text: `harness turn ${String(index)} ${"x".repeat(size)}`,
    occurredAt: new Date(Date.UTC(2026, 9, 6, 12, 0, index)).toISOString(),
  }));
}

async function settled(f: ReturnType<typeof fixture>, runId: string) {
  expect(await f.conversations.awaitRunResult(runId)).toBe(true);
}

it("runs a worker report on the service lane exactly once when no seat is live, seeded from a bounded log", async () => {
  const f = fixture();
  f.conversations.rememberNativeHead(ID, "claude-lead");
  f.conversations.syncNativeSeatTranscript(ID, "claude-session", [
    ...harnessTurns(60, 1_000),
    { type: "message", id: "native-last", role: "agent", text: "NEWEST harness turn" },
  ]);
  const { delivery, accept } = f.report(ID, "Report A finished");
  expect(accept()).toMatchObject({ received: true });
  await vi.waitFor(() =>
    expect(f.conversations.inboundReports(ID, { includeRead: true })).toMatchObject([
      { deliveryId: delivery.id, reportDelivery: { state: "delivered", stage: "responded" } },
    ]),
  );
  expect(f.freshSessions()).toBe(1);
  expect(f.sessions[0]!.prompts).toHaveLength(1);
  const prompt = f.sessions[0]!.prompts[0]!;
  expect(prompt).toContain("[Shared conversation context.");
  expect(prompt).toContain("NEWEST harness turn");
  expect(prompt).toContain(`Worker report ${delivery.id}`);
  // Bounded: the oldest harness turns are left to the log.
  expect(prompt).not.toContain("harness turn 0 ");
  expect(prompt).toContain("earlier events omitted");
  expect(prompt.length).toBeLessThan(CONVERSATION_PROJECTION_BUDGET + 2_000);

  // Recovery and a duplicate acceptance never run it again.
  await f.reports.recoverWorkerReports(ID);
  expect(accept()).toMatchObject({ received: true });
  const wake = f.conversations.submitInternal(ID, "Wake B check in", "wake");
  if (wake.status !== "accepted") throw new Error("Expected wake");
  await settled(f, wake.runId);
  expect(f.sessions[0]!.prompts).toHaveLength(2);
  // Nothing new from a harness: the current service session continues unseeded.
  expect(f.freshSessions()).toBe(1);
  expect(f.sessions[0]!.prompts[1]).not.toContain("[Shared conversation context.");
});

it("never moves a taken but unacknowledged native report onto the service lane, including after restart", async () => {
  const f = fixture();
  f.conversations.rememberNativeHead(ID, "claude-lead");
  const poll = f.outbox(ID).poll(60_000);
  const first = f.report(ID, "Report A finished");
  expect(first.accept()).toMatchObject({ received: true });
  const taken = OperatorSeatEventSchema.parse((await poll)[0]);
  expect(taken.content).toContain(first.delivery.id);
  // The seat vanishes without acknowledging; the process stops.
  await f.close();
  const restarted = fixture(f.root);
  expect(restarted.conversations.inboundReports(ID)).toMatchObject([
    { deliveryId: first.delivery.id, reportDelivery: { state: "uncertain" } },
  ]);
  await restarted.reports.recoverWorkerReports(ID);
  restarted.reports.recoverAllWorkerReports();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(restarted.sessions).toHaveLength(0);
  expect(restarted.conversations.inboundReports(ID)).toMatchObject([
    { deliveryId: first.delivery.id, reportDelivery: { state: "uncertain" } },
  ]);
});

it("hands a reconnecting seat one turn with the service's actual turns, after an in-flight run and before queued input", async () => {
  const f = fixture();
  f.conversations.rememberNativeHead(ID, "codex-lead");
  f.conversations.syncNativeSeatTranscript(ID, "codex-session", [
    { type: "message", id: "native-1", role: "operator", text: "harness said hi" },
  ]);
  let release!: () => void;
  // Holds only Wake A; anything that wrongly reaches the service lane later runs at once.
  f.script.gate = () => {
    f.script.gate = async () => {};
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  const wakeA = f.conversations.submitInternal(ID, "Wake A review the queue", "wake");
  if (wakeA.status !== "accepted") throw new Error("Expected wake");
  await vi.waitFor(() => expect(f.sessions[0]?.prompts).toHaveLength(1));

  // The harness returns while the service run is reserved.
  const firstPoll = f.pollSeat(ID, 60_000);
  const wakeB = f.conversations.submitInternal(ID, "Wake B queued while switching", "wake");
  if (wakeB.status !== "accepted") throw new Error("Expected wake");
  release();
  await settled(f, wakeA.runId);

  const [handoff] = (await firstPoll).map((event) => OperatorSeatEventSchema.parse(event));
  expect(handoff!.source).toBe("service-handoff");
  expect(handoff!.content).toContain("Service handoff");
  expect(handoff!.content).toContain("external: Wake A review the queue");
  expect(handoff!.content).toContain("captain: Service handled: Wake A");
  // Earlier than the harness's own last synced turn is not repeated.
  expect(handoff!.content).not.toContain("harness said hi");
  expect(handoff!.content).not.toContain("Wake B");
  f.outbox(ID).acknowledge(handoff!.id);

  const queued = (await f.pollSeat(ID, 60_000)).map((event) => OperatorSeatEventSchema.parse(event));
  expect(queued.map((event: OperatorSeatEvent) => event.content)).toEqual([
    expect.stringContaining("Wake B queued while switching"),
  ]);
  f.outbox(ID).acknowledge(queued[0]!.id);
  await settled(f, wakeB.runId);
  // Wake B went to the seat, never to the service lane.
  expect(f.sessions.flatMap((session) => session.prompts)).toHaveLength(1);

  // A second rebind with nothing new carries no handoff.
  expect(await f.pollSeat(ID, 0)).toEqual([]);
  expect(f.conversations.inboundReports(ID)).toEqual([]);
});

it("does not duplicate a handoff across a restart between take and settlement", async () => {
  const f = fixture();
  f.conversations.rememberNativeHead(ID, "claude-lead");
  const wake = f.conversations.submitInternal(ID, "Wake A review the queue", "wake");
  if (wake.status !== "accepted") throw new Error("Expected wake");
  await settled(f, wake.runId);
  const [taken] = await f.pollSeat(ID, 60_000);
  expect(OperatorSeatEventSchema.parse(taken).source).toBe("service-handoff");
  await f.close();

  const restarted = fixture(f.root);
  expect(await restarted.pollSeat(ID, 0)).toEqual([]);
  expect(await restarted.pollSeat(ID, 0)).toEqual([]);
  expect(restarted.events(ID)).toContainEqual(
    expect.objectContaining({
      type: "message",
      role: "external",
      text: expect.stringContaining("may not have reached the seat"),
    }),
  );
});

it("lets a fresh seat's SessionStart projection cover pending service turns instead of a second handoff", async () => {
  const f = fixture();
  f.conversations.rememberNativeHead(ID, "claude-lead");
  const wake = f.conversations.submitInternal(ID, "Wake A review the queue", "wake");
  if (wake.status !== "accepted") throw new Error("Expected wake");
  await settled(f, wake.runId);
  const seed = f.conversations.seatStartProjection(ID);
  expect(seed).toContain("# Recent conversation");
  expect(seed).toContain("external: Wake A review the queue");
  expect(seed).toContain("captain: Service handled: Wake A");
  expect(await f.pollSeat(ID, 0)).toEqual([]);

  // Service turns after the seed still reach the seat once.
  const later = f.conversations.submitInternal(ID, "Wake C after the seed", "wake");
  if (later.status !== "accepted") throw new Error("Expected wake");
  await settled(f, later.runId);
  const [handoff] = await f.pollSeat(ID, 60_000);
  const parsed = OperatorSeatEventSchema.parse(handoff);
  expect(parsed.content).toContain("Wake C after the seed");
  expect(parsed.content).not.toContain("Wake A review the queue");
});

it("keeps a long service handoff inside the seat channel's wire contract", async () => {
  const f = fixture();
  f.conversations.rememberNativeHead(ID, "claude-lead");
  for (const letter of "ABCDEFGH") {
    const wake = f.conversations.submitInternal(ID, `Wake ${letter} ${"y".repeat(3_500)}`, "wake");
    if (wake.status !== "accepted") throw new Error("Expected wake");
    await settled(f, wake.runId);
  }
  const [handoff] = await f.pollSeat(ID, 60_000);
  // The bridge parses every page with this schema; a page it cannot parse is
  // taken but never shown (2026-10-06).
  const parsed = OperatorSeatEventSchema.parse(handoff);
  expect(parsed.source).toBe("service-handoff");
  expect(parsed.content).toContain("captain: Service handled: Wake H");
  expect(parsed.content).toContain("earlier events omitted");
  expect(parsed.content).not.toContain("were not delivered");
});

it("keeps failed service wakes on exponential backoff instead of a retry storm", async () => {
  // Timers are simulated; service I/O stays real. Freeze the clock until each
  // failure settles, because backoff starts then rather than at admission.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-10-05T16:59:59Z"));
  const f = fixture();
  f.conversations.rememberNativeHead(ID, "claude-lead");
  f.script.fail = true;
  f.autonomy.scheduleWake(ID, "2026-10-05T17:00:00Z", "Review the pending work");
  const settleWake = async (count: number) => {
    const deadline = performance.now() + 5_000;
    while (f.wakeSettlements.length < count) {
      if (performance.now() > deadline) throw new Error("Service wake did not settle");
      await new Promise((resolve) => setImmediate(resolve));
    }
    // Let AutonomyStore observe the rejection and arm its retry without
    // advancing Date while the real service turn is still being persisted.
    await new Promise((resolve) => setImmediate(resolve));
  };
  await vi.advanceTimersByTimeAsync(1_000);
  await settleWake(1);
  for (const [index, delay] of [5_000, 10_000, 20_000].entries()) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(f.wakeRuns).toHaveLength(index + 1);
    await vi.advanceTimersByTimeAsync(1);
    await settleWake(index + 2);
  }
  await vi.advanceTimersByTimeAsync(24_000);
  expect(f.wakeRuns).toHaveLength(4);
  const gaps = f.wakeRuns.slice(1).map((at, index) => at - f.wakeSettlements[index]!);
  expect(gaps).toEqual([5_000, 10_000, 20_000]);
  expect(f.sessions.flatMap((session) => session.prompts)).toEqual([]);
  expect(f.autonomy.status(ID).wake?.at).toBe("2026-10-05T17:00:00.000Z");
});
