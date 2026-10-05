import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OperatorSeatEventSchema, WorkerReportPageSchema } from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { AutonomyStore } from "../src/captain/autonomy.ts";
import { createConversationRunner } from "../src/captain/captain-conversation-runner.ts";
import { createWorkerReports } from "../src/captain/captain-worker-reports.ts";
import { seatEventKindFor } from "../src/captain/captain-session.ts";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import { InboundSeatReceipts } from "../src/captain/inbound-seat-receipts.ts";
import { LaneLog } from "../src/captain/lane-log.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";
import { TurnSettledLog } from "../src/captain/turn-metrics.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

// Real wake persistence, conversation admission, inbox receipts and native
// mailbox protocol. A service session is forbidden, so no provider is invoked.
function fixture(root = mkdtempSync(join(tmpdir(), "native-wake-report-"))) {
  const autonomy = new AutonomyStore(join(root, "autonomy.json"));
  const settings = new SettingsStore(join(root, "settings.json"));
  const outboxes = new Map<string, SeatOutbox>();
  const outbox = (id: string) => {
    let box = outboxes.get(id);
    if (!box) {
      box = new SeatOutbox({ uncertaintyPath: join(root, `${id}-outbox.json`), boundGraceMs: 0 });
      outboxes.set(id, box);
    }
    return box;
  };
  let serviceStarts = 0;
  const forbiddenSession = async (): Promise<never> => {
    serviceStarts += 1;
    throw new Error("An internal native delivery must not prepare a service model");
  };
  const shutdown = new AbortController();
  const metrics = new TurnSettledLog(join(root, "turn-settled.jsonl"));
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
    durableSession: forbiddenSession,
    buildSession: forbiddenSession,
    captureEvaluationStart: () => {},
    autonomy,
    syncModel: async () => {},
    laneLog: new LaneLog(join(root, "lanes")),
    censusFleets: async () => [],
    deps: {} as CaptainDeps,
    turnSettled: metrics,
    goalExecutionReason: () => undefined,
    refuseNativeGoal: () => false,
  });
  const conversations = new ConversationStore(join(root, "conversations"), runner);
  const unusedNativeProbe = async (): Promise<never> => {
    throw new Error("Conversation-owned report recovery must not probe another native seat");
  };
  const herdrRunner = { get: unusedNativeProbe, wait: unusedNativeProbe, resolveTerminal: unusedNativeProbe };
  const reports = createWorkerReports({
    conversations,
    seatOutboxes: outboxes,
    shutdown,
    onChange: () => {},
    validateConversationOwner: async (owner) => conversations.runsCaptainTurns(owner.conversationId),
    herdrRunner,
    herdrWatches: new HerdrWatchStore(join(root, "watches.json")),
    inboundBinding: () => undefined,
    nativeRecipientCurrent: async () => false,
    deliverToSeat: async () => {
      throw new Error("Conversation reports use their own mailbox");
    },
  });
  const receipts = new InboundSeatReceipts(join(root, "inbound.json"), conversations);
  const wakeRuns: { id: string; at: number }[] = [];
  autonomy.start(async (id, prompt, origin) => {
    wakeRuns.push({ id, at: Date.now() });
    const result = conversations.submitInternal(id, prompt, origin);
    if (result.status !== "accepted" || !(await conversations.awaitRunResult(result.runId)))
      throw new Error("Internal autonomy turn failed");
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
  return {
    root,
    autonomy,
    conversations,
    reports,
    receipts,
    outbox,
    metrics,
    wakeRuns,
    close,
    serviceStarts: () => serviceStarts,
    journal: new ConversationJournal(join(root, "conversations")),
  };
}

it("retains an overdue native-owned wake through idle polling and restart without preparing Pi", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T16:59:59Z"));
  const f = fixture();
  f.conversations.rememberNativeHead("global-default", "claude-lead");
  f.autonomy.scheduleWake("global-default", "2026-10-05T17:00:00Z", "Review the pending work");
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(f.wakeRuns.length).toBeLessThan(20);
  expect(f.wakeRuns.slice(0, 4).map((run) => run.at - f.wakeRuns[0]!.at)).toEqual([0, 5_000, 15_000, 35_000]);
  expect(f.serviceStarts()).toBe(0);
  expect(await f.metrics.read()).toEqual([]);
  expect(f.autonomy.status("global-default").wake?.at).toBe("2026-10-05T17:00:00.000Z");
  await f.close();
  const restarted = fixture(f.root);
  await vi.advanceTimersByTimeAsync(0);
  expect(restarted.conversations.hasNativeSeat("global-default")).toBe(true);
  expect(restarted.serviceStarts()).toBe(0);
  expect(restarted.autonomy.status("global-default").wake).toBeDefined();
});

it("delivers the original wake and report once when the native receiver returns, without starving another chat", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T16:59:59Z"));
  const f = fixture();
  f.conversations.rememberNativeHead("global-default", "claude-lead");
  const delivery = { id: randomUUID(), binding: "a".repeat(64) };
  const accept = () =>
    f.receipts.accept(
      "w1:p1",
      delivery,
      "Finished",
      "Worker output: Finished",
      "global-default",
      // A native head is persisted, but its mailbox has not returned yet.
      undefined,
      { source: "adoption", conversationId: "global-default" },
      { kind: "conversation", owner: { conversationId: "global-default" } },
    );
  expect(accept()).toMatchObject({ received: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.conversations.inboundReports()).toMatchObject([
    { deliveryId: delivery.id, reportDelivery: { state: "pending", stage: "unavailable" } },
  ]);
  f.autonomy.scheduleWake("global-default", "2026-10-05T17:00:00Z", "Review the pending work");
  await vi.advanceTimersByTimeAsync(16_000);
  const other = await f.conversations.serve({
    schemaVersion: 1,
    op: "create",
    scope: { kind: "workspace", workspaceId: f.root },
    title: "Other native chat",
  });
  if (other.op !== "create") throw new Error("Expected conversation");
  const otherId = other.conversation.conversationId;
  f.conversations.rememberNativeHead(otherId, "other-lead");
  let poll = f.outbox(otherId).poll(60_000);
  f.autonomy.scheduleWake(otherId, new Date(Date.now() + 1_000).toISOString(), "Independent wake");
  await vi.advanceTimersByTimeAsync(1_000);
  const independent = OperatorSeatEventSchema.parse((await poll)[0]);
  expect(independent.conversationId).toBe(otherId);
  f.outbox(otherId).acknowledge(independent.id);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.autonomy.status(otherId).wake).toBeUndefined();
  poll = f.outbox("global-default").poll(60_000);
  await f.reports.recoverWorkerReports("global-default");
  await f.reports.recoverWorkerReports("global-default");
  const report = OperatorSeatEventSchema.parse((await poll)[0]);
  expect(report.content).toContain(delivery.id);
  f.outbox("global-default").acknowledge(report.id);
  await vi.advanceTimersByTimeAsync(0);
  expect(accept()).toMatchObject({ received: true });
  poll = f.outbox("global-default").poll(60_000);
  await vi.advanceTimersByTimeAsync(20_000);
  const wake = OperatorSeatEventSchema.parse((await poll)[0]);
  expect(wake.content).toContain("Review the pending work");
  f.outbox("global-default").acknowledge(wake.id);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.autonomy.status("global-default").wake).toBeUndefined();
  const page = WorkerReportPageSchema.parse(f.conversations.readInboundReports("global-default"));
  expect(page.items).toMatchObject([{ deliveryId: delivery.id, state: "delivered" }]);
  expect(f.conversations.acknowledgeInboundReports("global-default", page.ackDeliveryIds)).toBe(true);
  expect(f.serviceStarts()).toBe(0);
  expect(await f.metrics.read()).toEqual([]);
  expect(
    f.journal.read("global-default").filter((e) => e.type === "turn" && e.phase === "completed"),
  ).toHaveLength(2);
});
