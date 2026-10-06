import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OperatorPresenceResultSchema, OperatorPresenceSnapshotSchema } from "@clankie/protocol/presence";
import { ConversationStore, OPERATOR_CONVERSATION_RETAINED_MAX } from "../src/captain/conversations.ts";
import { createWorkerReports, type WorkerReportsContext } from "../src/captain/captain-worker-reports.ts";
import { deliveryFingerprint } from "../src/captain/delivery-fence.ts";
import { InboundAcceptanceSchema } from "../src/captain/conversations/constants.ts";
import {
  createOperatorService,
  type CreateOperatorServiceContext,
} from "../src/captain/captain-operator-service.ts";
import type { QuestionAuthority } from "../src/captain/conversation-questions.ts";
import { FleetChangeClock } from "../src/captain/herdr-fleet-changes.ts";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { readHerdrSeatTranscript } from "../src/captain/herdr-transcript.ts";
import type { HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";
import { DesktopExpressions } from "../src/captain/desktop.ts";
import type { DeliveryStage } from "@clankie/protocol";

const roots: string[] = [];
const stores: ConversationStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const owner: QuestionAuthority = {
  principal: { kind: "operator", id: "fixture-owner" },
  authorize: async () => true,
  current: () => true,
};

async function fixture() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-05T10:00:00.000Z"));
  const root = await mkdtemp(join(tmpdir(), "clankie-presence-events-"));
  roots.push(root);
  let mode: "reply" | "failed" | "quiet" | "ask" = "reply";
  const live = { thinking: false, voice: false };
  const settings = new SettingsStore(join(root, "settings.json"));
  const desktop = new DesktopExpressions(async () => (await settings.load()).desktop);
  const clock = new FleetChangeClock();
  const runner: ConstructorParameters<typeof ConversationStore>[1] = async (
    id,
    _message,
    publish,
    context,
  ) => {
    if (mode === "ask") {
      await store.requestQuestion(
        id,
        {
          kind: "choice",
          prompt: "Choose a color",
          options: [{ label: "Blue" }, { label: "Red" }],
          allowFreeform: false,
        },
        context,
      );
    } else if (mode !== "quiet") {
      publish({ type: "message", role: "captain", text: "Owner-only reply", streaming: false });
      if (mode === "failed") throw new Error("Private turn diagnostic");
    }
  };
  let store = new ConversationStore(join(root, "conversations"), runner);
  stores.push(store);
  const reportHelpers = () =>
    createWorkerReports({
      conversations: store,
      onChange: () => clock.touch(),
      inboundBinding: () => undefined,
    } as unknown as WorkerReportsContext);
  let reports = reportHelpers();
  const reportSummaries = vi.fn((...args: Parameters<typeof reports.reportSummaries>) =>
    reports.reportSummaries(...args),
  );
  const context = {
    personas: { ready: async () => undefined },
    conversations: store,
    deps: {
      presence: {
        listSessions: async () => [{ gatewayConnected: true, voiceGuildIds: live.voice ? ["guild"] : [] }],
      },
      embodiment: { getLiveSession: async () => undefined },
    },
    fleetChanges: clock,
    refreshFleet: async () => [],
    observeFleet: async () => ({}),
    sessions: new Map([
      [
        "captain",
        Promise.resolve({
          session: {
            get isStreaming() {
              return live.thinking;
            },
          },
        }),
      ],
    ]),
    desktop,
    reportSummaries,
    shutdown: new AbortController(),
  } as unknown as CreateOperatorServiceContext;
  let serve = createOperatorService(context);
  return {
    get store() {
      return store;
    },
    root,
    live,
    desktop,
    settings,
    reportSummaries,
    clock,
    report: async (deliveryId: string, stage: DeliveryStage, conversationId = "global-default") => {
      const text = "Private worker report";
      const accepted = store.submitInbound(
        text,
        {
          deliveryId,
          binding: "a".repeat(64),
          fingerprint: deliveryFingerprint(text),
          paneId: "private-worker-pane",
          text,
        },
        conversationId,
        async (_id, _message, _publish, context) => {
          context.deliveryReceipt?.(stage);
        },
      );
      if (accepted.status !== "accepted") throw new Error("Report refused");
      await store.awaitRun(accepted.runId);
      return store
        .inboundReports(conversationId, { includeRead: true })
        .find((report) => report.deliveryId === deliveryId)!;
    },
    read: async (conversationId = "global-default") => {
      const authority = { owner: { conversationId }, current: () => true, authorize: async () => true };
      const page = await reports.workerReportActions.read(authority);
      expect(await reports.workerReportActions.acknowledge(authority, page.ackDeliveryIds)).toBe(true);
    },
    reload: async () => {
      await store.close();
      store = new ConversationStore(join(root, "conversations"), runner);
      stores.push(store);
      reports = reportHelpers();
      serve = createOperatorService({ ...context, conversations: store });
    },
    mode: (value: typeof mode) => {
      mode = value;
    },
    presence: async (includeFace = true, includeBeats = false) =>
      OperatorPresenceResultSchema.parse(
        JSON.parse(
          JSON.stringify(
            await serve({
              op: "presence",
              schemaVersion: 1,
              ...(includeFace ? { includeFace: true } : {}),
              ...(includeBeats ? { includeBeats: true } : {}),
            }),
          ),
        ),
      ).snapshot,
    turn: async (conversationId = "global-default") => {
      const got = await store.serve({ op: "get", schemaVersion: 1, conversationId });
      if (got.op !== "get" || !got.conversation) throw new Error("conversation missing");
      const sent = await store.serve(
        {
          op: "send",
          schemaVersion: 1,
          turn: {
            schemaVersion: 1,
            kind: "message",
            conversationId,
            surfaceClientId: "presence-fixture",
            expectedRevision: got.conversation.revision,
            message: "Owner input",
          },
        },
        owner,
      );
      if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("turn refused");
      await store.awaitRun(sent.result.runId);
    },
  };
}

it("offers brief hire and confirmed report IDs only to opted-in clients, expires them, and honors quiet hours", async () => {
  const f = await fixture();
  const legacy = await f.presence(false);
  f.desktop.recordHire();
  const hired = await f.presence(true, true);
  expect(hired.beats).toEqual([f.desktop.recentHire()]);
  expect(hired.cursor).not.toBe(legacy.cursor);
  const oldClient = await f.presence(false);
  expect(oldClient.cursor).toBe(legacy.cursor);
  expect(OperatorPresenceSnapshotSchema.omit({ face: true, beats: true }).parse(oldClient)).toEqual(legacy);
  await f.report("10000000-0000-4000-8000-000000000001", "unavailable");
  await f.report("10000000-0000-4000-8000-000000000002", "uncertain");
  expect((await f.presence(true, true)).beats).toEqual(hired.beats);
  const delivered = await f.report("10000000-0000-4000-8000-000000000003", "delivered");
  const snapshot = await f.presence(true, true);
  expect(snapshot.beats).toEqual([
    ...hired.beats!,
    { id: delivered.deliveryId, kind: "worker_report", at: delivered.acceptedAt },
  ]);
  expect(JSON.stringify(snapshot)).not.toMatch(/private-thread|private-worker-pane/);
  f.store.readInboundReports("global-default");
  expect(f.store.acknowledgeInboundReports("global-default", [delivered.deliveryId])).toBe(true);
  expect((await f.presence(true, true)).cursor).toBe(snapshot.cursor);
  vi.setSystemTime(Date.now() + 10000);
  expect((await f.presence(true, true)).beats).toBeUndefined();
  f.desktop.recordHire();
  await f.report("10000000-0000-4000-8000-000000000004", "delivered");
  await f.settings.update((current) => ({
    ...current,
    desktop: { quietHours: { start: "10:00", end: "11:00", timeZone: "UTC" } },
  }));
  expect((await f.presence(true, true)).beats).toBeUndefined();
  expect((await f.presence(true, true)).mood).toBe("idle");
});

it("retains a confirmed report cue when the lead reads it before the first presence sample, including after restart", async () => {
  const f = await fixture();
  const report = await f.report("10000000-0000-4000-8000-000000000011", "consumed");
  await f.read();
  expect(f.reportSummaries()).toEqual([]);
  const expected = [{ id: report.deliveryId, kind: "worker_report", at: report.acceptedAt }];
  expect((await f.presence(true, true)).beats).toEqual(expected);
  await f.reload();
  expect(f.reportSummaries()).toEqual([]);
  expect((await f.presence(true, true)).beats).toEqual(expected);
  vi.setSystemTime(Date.now() + 10_000);
  expect((await f.presence(true, true)).beats).toBeUndefined();
});

it("samples only recent report payloads once per fleet revision and invalidates on durable progress and reads", async () => {
  const f = await fixture();
  const old = await f.report("10000000-0000-4000-8000-000000000021", "delivered");
  vi.setSystemTime(Date.now() + 10_001);
  const recent = await f.report("10000000-0000-4000-8000-000000000022", "unavailable");
  const parse = vi.spyOn(InboundAcceptanceSchema, "parse");
  f.reportSummaries.mockClear();
  expect((await f.presence(true, true)).beats).toBeUndefined();
  expect(f.reportSummaries).toHaveBeenCalledTimes(1);
  expect(parse).toHaveBeenCalledTimes(1);
  expect(parse.mock.calls[0]![0]).toMatchObject({ deliveryId: recent.deliveryId });
  for (let sample = 0; sample < 20; sample += 1) await f.presence(true, true);
  expect(f.reportSummaries).toHaveBeenCalledTimes(1);
  expect(parse).toHaveBeenCalledTimes(1);
  const beforeProgress = f.clock.current();
  expect(f.store.recordInboundReportDelivery(recent.deliveryId, "delivered")).toBe(true);
  expect(f.clock.current()).not.toBe(beforeProgress);
  const delivered = await f.presence(true, true);
  expect(delivered.beats).toEqual([{ id: recent.deliveryId, kind: "worker_report", at: recent.acceptedAt }]);
  const beforeOffer = f.clock.current();
  f.store.readInboundReports("global-default");
  expect(f.clock.current()).not.toBe(beforeOffer);
  expect((await f.presence(true, true)).beats).toEqual(delivered.beats);
  const beforeRead = f.clock.current();
  expect(f.store.acknowledgeInboundReports("global-default", [old.deliveryId, recent.deliveryId])).toBe(true);
  expect(f.clock.current()).not.toBe(beforeRead);
  parse.mockClear();
  expect((await f.presence(true, true)).cursor).toBe(delivered.cursor);
  expect(parse).toHaveBeenCalledTimes(1);
  f.reportSummaries.mockClear();
  vi.setSystemTime(Date.now() + 10_000);
  expect((await f.presence(true, true)).beats).toBeUndefined();
  expect(f.reportSummaries).not.toHaveBeenCalled();
  expect(parse).toHaveBeenCalledTimes(1);
});

it("invalidates a cached read report when its conversation is closed or pruned", async () => {
  const f = await fixture();
  const create = async () => {
    const result = await f.store.serve({
      op: "create",
      schemaVersion: 1,
      scope: { kind: "global" },
      title: "Report thread",
    });
    if (result.op !== "create") throw new Error("Conversation missing");
    return result.conversation.conversationId;
  };
  const closedId = await create();
  const closedReport = await f.report("10000000-0000-4000-8000-000000000031", "delivered", closedId);
  await f.read(closedId);
  expect((await f.presence(true, true)).beats?.[0]?.id).toBe(closedReport.deliveryId);
  const beforeClose = f.clock.current();
  expect(await f.store.serve({ op: "close", schemaVersion: 1, conversationId: closedId })).toMatchObject({
    closed: true,
  });
  expect(f.clock.current()).not.toBe(beforeClose);
  expect((await f.presence(true, true)).beats).toBeUndefined();
  const prunedId = await create();
  const prunedReport = await f.report("10000000-0000-4000-8000-000000000032", "delivered", prunedId);
  await f.read(prunedId);
  expect((await f.presence(true, true)).beats?.[0]?.id).toBe(prunedReport.deliveryId);
  const beforePrune = f.clock.current();
  for (let index = 0; index < OPERATOR_CONVERSATION_RETAINED_MAX; index += 1) {
    vi.setSystemTime(Date.now() + 1);
    await create();
  }
  expect(await f.store.serve({ op: "get", schemaVersion: 1, conversationId: prunedId })).toEqual({
    op: "get",
    schemaVersion: 1,
  });
  expect(f.clock.current()).not.toBe(beforePrune);
  expect((await f.presence(true, true)).beats).toBeUndefined();
});

it("projects durable owner replies and source priority, then changes the cursor on expiry", async () => {
  const f = await fixture();
  const idle = await f.presence();
  expect(idle.face).toBeUndefined();
  f.live.voice = true;
  expect(await f.presence()).toMatchObject({ mood: "in_voice", face: "voice" });
  f.live.thinking = true;
  expect(await f.presence()).toMatchObject({ mood: "thinking", face: "working" });
  const legacy = await f.presence(false);
  expect(legacy.face).toBeUndefined();
  expect(OperatorPresenceSnapshotSchema.omit({ face: true }).parse(legacy).mood).toBe("thinking");
  await f.turn();
  const reply = await f.presence();
  expect(reply).toMatchObject({ mood: "thinking", face: "new_message" });
  expect(JSON.stringify(reply)).not.toContain("Owner-only reply");
  expect((await f.presence(false)).cursor).toBe(legacy.cursor);
  vi.setSystemTime(Date.now() + 9_999);
  expect((await f.presence()).cursor).toBe(reply.cursor);
  vi.setSystemTime(Date.now() + 1);
  const expired = await f.presence();
  expect(expired.face).toBe("working");
  expect(expired.cursor).not.toBe(reply.cursor);
});

it("uses failed-turn evidence over its diagnostic reply, clears on same-thread success, and bounds errors", async () => {
  const f = await fixture();
  f.mode("failed");
  await f.turn();
  const failed = await f.presence();
  expect(failed.face).toBe("error");
  expect(JSON.stringify(failed)).not.toContain("Private turn diagnostic");
  const workspace = join(f.root, "workspace");
  await mkdir(workspace);
  const created = await f.store.serve({
    op: "create",
    schemaVersion: 1,
    scope: { kind: "workspace", workspaceId: workspace },
    title: "Other thread",
  });
  if (created.op !== "create") throw new Error("conversation missing");
  f.mode("quiet");
  await f.turn(created.conversation.conversationId);
  expect((await f.presence()).face).toBe("error");
  await f.turn();
  expect((await f.presence()).face).toBe("new_message");
  f.mode("failed");
  await f.turn();
  vi.setSystemTime(Date.now() + 29_999);
  const recent = await f.presence();
  expect(recent.face).toBe("error");
  vi.setSystemTime(Date.now() + 1);
  const expired = await f.presence();
  expect(expired.face).toBeUndefined();
  expect(expired.cursor).not.toBe(recent.cursor);
  f.mode("ask");
  await f.turn(created.conversation.conversationId);
  f.mode("failed");
  await f.turn();
  expect(await f.presence()).toMatchObject({
    face: "needs_you",
    pendingOwnerItem: { title: "Choose a color" },
  });
});

it("ignores first native transcript folds, session changes, historical entries and non-owner activity", async () => {
  const f = await fixture();
  const entry = (id: string, occurredAt = new Date().toISOString()) => ({
    type: "message" as const,
    id,
    role: "agent" as const,
    text: "Native owner reply",
    occurredAt,
  });
  const first = entry("first");
  f.store.syncHeadTranscript("captain-seat", { sessionKey: "codex:first", entries: [first] });
  expect((await f.presence()).face).toBeUndefined();
  f.store.syncHeadTranscript("captain-seat", { sessionKey: "codex:first", entries: [first, entry("fresh")] });
  expect((await f.presence()).face).toBe("new_message");
  vi.setSystemTime(Date.now() + 10_000);
  f.store.syncHeadTranscript("captain-seat", {
    sessionKey: "codex:first",
    entries: [first, entry("old", "2026-10-04T10:00:00.000Z")],
  });
  expect((await f.presence()).face).toBeUndefined();
  f.store.syncHeadTranscript("captain-seat", {
    sessionKey: "codex:replacement",
    entries: [entry("replacement")],
  });
  expect((await f.presence()).face).toBeUndefined();
  const room = f.store.roomConversation("discord_presence", "guild:room");
  f.store.publishRoomEvent(room, { type: "message", role: "captain", text: "Room reply", streaming: false });
  f.store.publishRoomEvent(room, { type: "turn", runId: "room-run", phase: "failed" });
  const worker = await f.store.serve({
    op: "create",
    schemaVersion: 1,
    scope: { kind: "seat", seatId: "worker-seat" },
    title: "Worker",
  });
  if (worker.op !== "create") throw new Error("worker missing");
  f.store.publishSeatEvent("worker-seat", {
    type: "message",
    role: "agent",
    text: "Worker reply",
    streaming: false,
  });
  f.store.publishSeatEvent("worker-seat", { type: "turn", runId: "worker-run", phase: "failed" });
  expect((await f.presence()).face).toBeUndefined();
});

it("observes a native captain's live reply while only presence is open", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-native-presence-"));
  roots.push(root);
  const path = join(root, "native-codex.jsonl");
  const record = (id: string, text: string) =>
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "response_item",
      payload: { type: "message", id, role: "assistant", content: [{ type: "output_text", text }] },
    })}\n`;
  await writeFile(path, record("history", "Already said before the pet opened"));
  const native: HerdrAgentSnapshot = {
    paneId: "fixture:p1",
    terminalId: "fixture-captain",
    agent: "codex",
    status: "working",
    title: "Clankie",
    session: { source: "herdr:codex", kind: "path", value: path },
  };
  const wire = {
    pane_id: native.paneId,
    terminal_id: native.terminalId,
    agent: native.agent,
    agent_status: native.status,
    name: "clankie",
    agent_session: native.session,
  };
  let reads = 0;
  const wait = async (_target: string, signal: AbortSignal): Promise<HerdrAgentSnapshot> =>
    new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  const captain = createCaptain(
    {
      presence: { listSessions: async () => [] },
      embodiment: { getLiveSession: async () => undefined },
      herdrAvailable: () => true,
    } as unknown as CaptainDeps,
    {
      repoRoot: root,
      stateDir: root,
      settings: new SettingsStore(join(root, "settings.json")),
      nativeSummariesPath: join(root, "summaries.json"),
      nativeCensusRunner: async (_command, args) => ({
        stdout: JSON.stringify({
          result:
            args[0] === "agent"
              ? { agents: [wire] }
              : { snapshot: { workspaces: [], tabs: [], panes: [wire] } },
        }),
        stderr: "",
      }),
      nativeHerdrRunner: {
        get: async () => native,
        resolveTerminal: async () => native,
        wait,
        waitForChange: async (target, _status, signal) => wait(target, signal),
        transcript: async () => {
          reads++;
          return readHerdrSeatTranscript(native.agent, native.session);
        },
      },
      seatAdapters: [],
    },
  );
  const presence = async () =>
    OperatorPresenceResultSchema.parse(
      await captain.serveOperatorConversation({ op: "presence", schemaVersion: 1, includeFace: true }),
    ).snapshot;
  try {
    // A presence poll itself binds and follows the head; no directory/tail/read request.
    expect((await presence()).face).toBe("working");
    await vi.waitFor(
      async () => {
        expect(reads).toBeGreaterThanOrEqual(2);
        expect((await presence()).face).toBe("working");
      },
      { timeout: 3_000 },
    );
    await appendFile(path, record("fresh", "A new native reply"));
    await vi.waitFor(
      async () => {
        expect((await presence()).face).toBe("new_message");
      },
      { timeout: 3_000 },
    );
  } finally {
    await captain.close();
  }
});
