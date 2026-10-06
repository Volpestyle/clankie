import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OperatorPresenceResultSchema, OperatorPresenceSnapshotSchema } from "@clankie/protocol/presence";
import { ConversationStore } from "../src/captain/conversations.ts";
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
import {
  WorkerReportSummarySchema,
  type WorkerReportSummary,
} from "../../../packages/protocol/src/worker-reports.ts";

const roots: string[] = [];
const stores: ConversationStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
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
  const reports: WorkerReportSummary[] = [];
  const store = new ConversationStore(join(root, "conversations"), async (id, _message, publish, context) => {
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
  });
  stores.push(store);
  const context = {
    personas: { ready: async () => undefined },
    conversations: store,
    deps: {
      presence: {
        listSessions: async () => [{ gatewayConnected: true, voiceGuildIds: live.voice ? ["guild"] : [] }],
      },
      embodiment: { getLiveSession: async () => undefined },
    },
    fleetChanges: new FleetChangeClock(),
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
    reportSummaries: () => reports,
    shutdown: new AbortController(),
  } as unknown as CreateOperatorServiceContext;
  const serve = createOperatorService(context);
  return {
    store,
    root,
    live,
    desktop,
    settings,
    reports,
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
  const report = (id: string, state: WorkerReportSummary["state"], acceptedAt = new Date().toISOString()) =>
    WorkerReportSummarySchema.parse({
      deliveryId: id,
      conversationId: "private-thread",
      paneId: "private-worker-pane",
      acceptedAt,
      state,
    });
  f.reports.push(report("10000000-0000-4000-8000-000000000001", "pending"));
  f.reports.push(report("10000000-0000-4000-8000-000000000002", "uncertain"));
  expect((await f.presence(true, true)).beats).toEqual(hired.beats);
  const delivered = report("10000000-0000-4000-8000-000000000003", "delivered");
  f.reports.push(delivered);
  const snapshot = await f.presence(true, true);
  expect(snapshot.beats).toEqual([
    ...hired.beats!,
    { id: delivered.deliveryId, kind: "worker_report", at: delivered.acceptedAt },
  ]);
  expect(JSON.stringify(snapshot)).not.toMatch(/private-thread|private-worker-pane/);
  delivered.state = "read";
  expect((await f.presence(true, true)).cursor).toBe(snapshot.cursor);
  vi.setSystemTime(Date.now() + 10000);
  expect((await f.presence(true, true)).beats).toBeUndefined();
  f.desktop.recordHire();
  f.reports.push(report("10000000-0000-4000-8000-000000000004", "delivered"));
  await f.settings.update((current) => ({
    ...current,
    desktop: { quietHours: { start: "10:00", end: "11:00", timeZone: "UTC" } },
  }));
  expect((await f.presence(true, true)).beats).toBeUndefined();
  expect((await f.presence(true, true)).mood).toBe("idle");
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
