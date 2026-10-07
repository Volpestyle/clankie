import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OperatorSeatEventSchema, type OperatorSeatEvent } from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { AutonomyStore } from "../src/captain/autonomy.ts";
import { createConversationRunner, runAutonomyTurn } from "../src/captain/captain-conversation-runner.ts";
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
import {
  createOperatorService,
  type CreateOperatorServiceContext,
} from "../src/captain/captain-operator-service.ts";
import { SeatOutbox, type UnresolvedSeatReceipt } from "../src/captain/seat-outbox.ts";
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
  public readonly model = { provider: "scripted", id: "scripted-model" };
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
      if (this.script.providerError !== undefined) {
        // What Pi records when the provider refuses the request.
        this.state.messages.push({
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: this.script.providerError,
        } as never);
        this.isStreaming = false;
        return;
      }
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
  /** Pi's recorded error when the provider refuses the turn. */
  providerError?: string;
  /** What the captain's credential recovery reports for a rejected credential. */
  credentialRecovery?: "refreshed" | "reconnect_required" | "operator_required";
  gate: () => Promise<void>;
}

function fixture(root = mkdtempSync(join(tmpdir(), "native-seat-fallback-"))) {
  const autonomy = new AutonomyStore(join(root, "autonomy.json"));
  const settings = new SettingsStore(join(root, "settings.json"));
  const outboxes = new Map<string, SeatOutbox>();
  const alerts: UnresolvedSeatReceipt[] = [];
  const outbox = (id: string) => {
    let box = outboxes.get(id);
    if (!box) {
      box = new SeatOutbox({
        uncertaintyPath: join(root, `${id}-outbox.json`),
        onUnresolved: (receipt) => alerts.push(receipt),
      });
      outboxes.set(id, box);
    }
    return box;
  };
  const script: Script = { fail: false, gate: async () => {} };
  const credentialRejections: string[] = [];
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
    seatEventKind: (id, context, content) =>
      outbox(id).routesToSeat(content) ? seatEventKindFor(context, true) : undefined,
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
    credentialRejected: async (providerId) => {
      credentialRejections.push(providerId);
      // A refreshed credential is accepted by the provider again.
      if (script.credentialRecovery === "refreshed") delete script.providerError;
      return script.credentialRecovery;
    },
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
  autonomy.start(async (id, prompt, origin, expectedGoal) => {
    wakeRuns.push(Date.now());
    try {
      await runAutonomyTurn(conversations, id, prompt, origin, expectedGoal);
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
    outboxes,
    alerts,
    script,
    sessions,
    wakeRuns,
    wakeSettlements,
    close,
    pollSeat,
    report,
    freshSessions: () => freshSessions,
    credentialRejections,
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

it("keeps failed service wakes on exponential backoff, then holds them instead of a retry storm", async () => {
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
  for (const [index, delay] of [5_000, 10_000].entries()) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(f.wakeRuns).toHaveLength(index + 1);
    await vi.advanceTimersByTimeAsync(1);
    await settleWake(index + 2);
  }
  // Three attempts, then the wake waits for something to change.
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(f.wakeRuns).toHaveLength(3);
  const gaps = f.wakeRuns.slice(1).map((at, index) => at - f.wakeSettlements[index]!);
  expect(gaps).toEqual([5_000, 10_000]);
  expect(f.sessions.flatMap((session) => session.prompts)).toEqual([]);
  expect(f.autonomy.status(ID).wake?.at).toBe("2026-10-05T17:00:00.000Z");
  expect(f.autonomy.wakeHeld(ID)).toBe(true);
  // Retries are the same input: the log shows the wake once.
  expect(
    f
      .events(ID)
      .filter(
        (event) =>
          event.type === "message" &&
          event.role === "external" &&
          event.text.includes("Review the pending work"),
      ),
  ).toHaveLength(1);
});

// 2026-10-07: an expired openai-codex token failed a self-wake 15+ times, each
// attempt a full Pi turn that re-seeded ~49k tokens and appended the wake
// prompt to the conversation log again.
it("holds a wake whose provider rejected the credentials after one turn, then gives it to the seat once it binds", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-10-07T15:59:59Z"));
  const f = fixture();
  f.conversations.rememberNativeHead(ID, "claude-lead");
  f.script.providerError = "Your authentication token has expired. Please try refreshing it.";
  f.autonomy.scheduleWake(ID, "2026-10-07T16:00:00Z", "VUH-1779 live check");
  const settleWake = async (count: number) => {
    const deadline = performance.now() + 5_000;
    while (f.wakeSettlements.length < count) {
      if (performance.now() > deadline) throw new Error("Service wake did not settle");
      await new Promise((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => setImmediate(resolve));
  };
  await vi.advanceTimersByTimeAsync(1_000);
  await settleWake(1);
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(f.wakeRuns).toHaveLength(1);
  expect(f.autonomy.wakeHeld(ID)).toBe(true);
  const wakeEntries = () =>
    f
      .events(ID)
      .filter(
        (event) =>
          event.type === "message" && event.role === "external" && event.text.includes("VUH-1779 live check"),
      );
  expect(wakeEntries()).toHaveLength(1);
  expect(f.events(ID).filter((event) => event.type === "turn" && event.phase === "failed")).toHaveLength(1);

  // The seat binds: the held wake gets one more try, which goes to the seat.
  const poll = f.pollSeat(ID, 60_000);
  f.autonomy.releaseHeldWake(ID);
  await vi.advanceTimersByTimeAsync(1);
  const [event] = await poll;
  expect(OperatorSeatEventSchema.parse(event).content).toContain("VUH-1779 live check");
  expect(f.wakeRuns).toHaveLength(2);
  expect(wakeEntries()).toHaveLength(1);
});

it("VUH-1779: an unresolved head delivery refuses only its own resend; later wakes and reports still reach the seat", async () => {
  const f = fixture();
  f.conversations.rememberNativeHead(ID, "claude-lead");
  // 2026-10-06 21:21Z: around a seat reset the seat takes a wake and never acknowledges it.
  const poll = f.pollSeat(ID, 60_000);
  const wakeA = f.conversations.submitInternal(ID, "Wake A before the seat reset", "wake");
  if (wakeA.status !== "accepted") throw new Error("Expected wake");
  const [lost] = (await poll).map((event) => OperatorSeatEventSchema.parse(event));
  expect(lost!.content).toContain("Wake A before the seat reset");
  await f.close();

  const restarted = fixture(f.root);
  const head = restarted.outbox(ID);
  expect(head.uncertain()).toBe(true);
  expect(head.unresolvedDeliveries()).toEqual([{ receiptId: lost!.id, beganAt: expect.any(Number) }]);

  // The lead's next self-wake reaches the seat instead of settling `uncertain`.
  const seatPoll = restarted.pollSeat(ID, 60_000);
  const wakeB = restarted.conversations.submitInternal(ID, "Wake B the lead's self-wake", "wake");
  if (wakeB.status !== "accepted") throw new Error("Expected wake");
  const [delivered] = (await seatPoll).map((event) => OperatorSeatEventSchema.parse(event));
  expect(delivered!.content).toContain("Wake B the lead's self-wake");
  // The lead is told about the unresolved original once, instead of failing silently.
  await vi.waitFor(() =>
    expect(restarted.alerts).toEqual([{ receiptId: lost!.id, beganAt: expect.any(Number) }]),
  );
  expect(head.acknowledge(delivered!.id)).toBe(true);
  await settled(restarted, wakeB.runId);

  // A worker report also reaches the live seat.
  const reportPoll = restarted.pollSeat(ID, 60_000);
  const report = restarted.report(ID, "Report C finished");
  expect(report.accept()).toMatchObject({ received: true });
  const [reportEvent] = (await reportPoll).map((event) => OperatorSeatEventSchema.parse(event));
  expect(reportEvent!.content).toContain(`Worker report ${report.delivery.id}`);
  head.acknowledge(reportEvent!.id);
  await vi.waitFor(() =>
    expect(restarted.conversations.inboundReports(ID, { includeRead: true })).toContainEqual(
      expect.objectContaining({
        deliveryId: report.delivery.id,
        reportDelivery: expect.objectContaining({ state: "delivered" }),
      }),
    ),
  );
  expect(restarted.sessions.flatMap((session) => session.prompts)).toEqual([]);

  // ADR 0207: the unresolved original itself is never sent again, by content or by ID.
  const parked = head.poll(60_000);
  expect(
    await head.deliver({
      kind: "message",
      conversationId: ID,
      source: "service",
      content: lost!.content,
      wantsReply: false,
    }),
  ).toMatchObject({ outcome: "unconfirmed", deliveryStage: "uncertain", messageId: lost!.id });
  expect(
    await head.deliver({
      kind: "message",
      conversationId: ID,
      source: "service",
      content: "A different text under the original ID",
      wantsReply: false,
      original: { messageId: lost!.id, prepare: () => {} },
    }),
  ).toMatchObject({ outcome: "unconfirmed", messageId: lost!.id });
  // Nothing reached the parked poll.
  const stillParked = await Promise.race([
    parked,
    new Promise((resolve) => setTimeout(() => resolve("parked"), 50)),
  ]);
  expect(stillParked).toBe("parked");
  expect(restarted.alerts).toHaveLength(1);
  await restarted.close();

  // With no live seat, an unrelated report runs on the service lane despite the unresolved receipt.
  const unbound = fixture(f.root);
  expect(unbound.outbox(ID).uncertain()).toBe(true);
  expect(unbound.outbox(ID).bound()).toBe(false);
  const later = unbound.report(ID, "Report D finished");
  expect(later.accept()).toMatchObject({ received: true });
  await vi.waitFor(() =>
    expect(unbound.conversations.inboundReports(ID, { includeRead: true })).toContainEqual(
      expect.objectContaining({
        deliveryId: later.delivery.id,
        reportDelivery: expect.objectContaining({ state: "delivered" }),
      }),
    ),
  );
  expect(unbound.sessions.flatMap((session) => session.prompts).join("\n")).toContain(
    `Worker report ${later.delivery.id}`,
  );

  // The owner settles it through the operator API: abandoned-unknown, never a receipt.
  let current = true;
  const authority = {
    principal: { kind: "operator" as const, id: "owner" },
    current: () => current,
    authorize: async () => current,
  };
  const serve = createOperatorService({
    personas: { ready: async () => {} },
    settingsStore: {},
    deps: { herdrAvailable: () => true },
    shutdown: new AbortController(),
    seatOutboxes: unbound.outboxes,
    seatOutbox: unbound.outbox,
    headSeatConversations: () => [ID],
  } as unknown as CreateOperatorServiceContext);
  expect(await serve({ op: "seat_deliveries", schemaVersion: 1 })).toMatchObject({
    op: "seat_deliveries",
    unresolved: [{ conversationId: ID, receiptId: lost!.id, ageMs: expect.any(Number) }],
  });
  current = false;
  await expect(
    serve(
      {
        op: "settle_seat_delivery",
        schemaVersion: 1,
        conversationId: ID,
        receiptId: lost!.id,
        disposition: "abandoned-unknown",
      },
      authority,
    ),
  ).rejects.toThrow("question_owner_unavailable");
  current = true;
  expect(
    await serve(
      {
        op: "settle_seat_delivery",
        schemaVersion: 1,
        conversationId: ID,
        receiptId: "seat-invented",
        disposition: "abandoned-unknown",
      },
      authority,
    ),
  ).toMatchObject({ result: { state: "refused" } });
  expect(
    await serve(
      {
        op: "settle_seat_delivery",
        schemaVersion: 1,
        conversationId: ID,
        receiptId: lost!.id,
        disposition: "abandoned-unknown",
      },
      authority,
    ),
  ).toMatchObject({
    result: {
      state: "abandoned-unknown",
      receiptId: lost!.id,
      evidence: { disposition: "abandoned-unknown", journal: "owner-settled-unknown", receiptId: lost!.id },
    },
  });
  expect(unbound.outbox(ID).uncertain()).toBe(false);
  await unbound.close();

  // Durable: after restart nothing is unresolved, nothing claims receipt, and the original ID stays closed.
  const settledBox = fixture(f.root).outbox(ID);
  expect(settledBox.uncertain()).toBe(false);
  expect(settledBox.receipt(lost!.content)).toBeUndefined();
  expect(
    await settledBox.deliver({
      kind: "message",
      conversationId: ID,
      source: "service",
      content: "Retry under the settled original ID",
      wantsReply: false,
      original: { messageId: lost!.id, prepare: () => {} },
    }),
  ).toMatchObject({ outcome: "unconfirmed", messageId: lost!.id });
});

it("runs a wake once more after Clankie refreshes the credential the provider rejected", async () => {
  const f = fixture();
  f.conversations.rememberNativeHead(ID, "claude-lead");
  f.script.providerError = "Your authentication token has expired. Please try refreshing it.";
  f.script.credentialRecovery = "refreshed";
  f.autonomy.scheduleWake(ID, new Date(Date.now() + 50).toISOString(), "Refresh then answer");
  await vi.waitFor(() => expect(f.autonomy.status(ID).wake).toBeUndefined());
  expect(f.credentialRejections).toEqual(["scripted"]);
  expect(f.wakeRuns).toHaveLength(1);
  const events = f.events(ID);
  const failed = events.filter((event) => event.type === "turn" && event.phase === "failed");
  expect(failed).toHaveLength(1);
  expect(failed[0]).toMatchObject({ summary: expect.stringContaining("Clankie refreshed it") });
  expect(failed[0]).toMatchObject({
    summary: expect.stringContaining("the interrupted turn did not complete"),
  });
  expect(JSON.stringify(failed)).not.toContain("send the message again");
  expect(events.filter((event) => event.type === "turn" && event.phase === "completed")).toHaveLength(1);
  expect(
    events.filter(
      (event) =>
        event.type === "message" && event.role === "external" && event.text.includes("Refresh then answer"),
    ),
  ).toHaveLength(1);
});

it("tells the owner to reconnect when the rejected credential cannot be refreshed", async () => {
  const f = fixture();
  f.script.providerError = "Your authentication token has expired. Please try refreshing it.";
  f.script.credentialRecovery = "reconnect_required";
  const turn = f.conversations.submitInternal(ID, "Wake R check in", "wake");
  if (turn.status !== "accepted") throw new Error("Expected wake");
  expect(await f.conversations.awaitRunResult(turn.runId)).toBe(false);
  const failed = f.events(ID).filter((event) => event.type === "turn" && event.phase === "failed");
  expect(failed).toMatchObject([
    { summary: expect.stringContaining("Reconnect scripted with `/auth scripted` in the console") },
  ]);
});

it("reports hosted credential repair as service operator work without console auth instructions", async () => {
  const f = fixture();
  f.script.providerError = "401 unauthorized; run /auth to replace the rejected key";
  f.script.credentialRecovery = "operator_required";
  const turn = f.conversations.submitInternal(ID, "Wake H check in", "wake");
  if (turn.status !== "accepted") throw new Error("Expected wake");
  expect(await f.conversations.awaitRunResult(turn.runId)).toBe(false);
  const failed = f.events(ID).filter((event) => event.type === "turn" && event.phase === "failed");
  expect(failed).toMatchObject([
    { summary: expect.stringContaining("The service operator needs to repair the model connection") },
  ]);
  expect(JSON.stringify(failed)).not.toContain("/auth");
  expect(JSON.stringify(failed)).not.toContain("notified");
});
