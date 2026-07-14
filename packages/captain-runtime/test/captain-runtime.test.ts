import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createOperatorConversationServiceClient } from "@clankie/protocol";
import {
  CaptainAdmissionController,
  CaptainAdmissionQueueFullError,
  CaptainAdmissionPreemptedError,
  CaptainContinuationOwnershipError,
  CaptainLaneExecutor,
  CaptainLaneSessionConflictError,
  CaptainProviderPressureError,
  LocalOperatorConversationService,
  OperatorConversationMigrationError,
  OperatorConversationOwnershipError,
  createAdmittedLanguageModel,
  createLocalOperatorConversationDispatch,
  openCaptainLaneRegistry,
  openOperatorConversationReader,
  openOperatorConversationRegistry,
  type CaptainIdentity,
  type CaptainLaneAddress,
  type CaptainRuntimeEvent,
} from "../src/index.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const roots: string[] = [];
const identity: CaptainIdentity = {
  agentDefinitionId: "captain-eve:v1",
  soulId: "clankie",
  providerId: "openai-codex",
  characterId: "clankie",
};
const TUI: CaptainLaneAddress = { characterId: "clankie", lane: "tui", targetId: "operator" };
const VOICE: CaptainLaneAddress = {
  characterId: "clankie",
  lane: "discord_voice",
  targetId: "guild-1:voice-1",
};
const GAMEPLAY: CaptainLaneAddress = {
  characterId: "clankie",
  lane: "gameplay",
  targetId: "world-1",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function registryHarness(events: CaptainRuntimeEvent[] = []) {
  const root = await mkdtemp(join(tmpdir(), "captain-lanes-"));
  roots.push(root);
  const path = join(root, "private", "lanes.sqlite");
  const registry = await openCaptainLaneRegistry(path, {
    identity,
    clock: () => new Date("2026-07-11T12:00:00.000Z"),
    events: (event) => {
      events.push(event);
    },
  });
  return { events, path, registry };
}

describe("conversation-scoped operator registry", () => {
  it("creates exactly one default global conversation under concurrent startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "operator-conversations-"));
    roots.push(root);
    const path = join(root, "captain.sqlite");
    const [left, right] = await Promise.all([
      openOperatorConversationRegistry(path, { identity }),
      openOperatorConversationRegistry(path, { identity }),
    ]);
    expect(left.list().filter((conversation) => conversation.isDefault)).toHaveLength(1);
    expect(right.list().filter((conversation) => conversation.isDefault)).toHaveLength(1);
    expect(left.list()[0]?.conversationId).toBe(right.list()[0]?.conversationId);
    left.close();
    right.close();
  });

  it("dual-reads one legacy v1 TUI row and single-writes an operator conversation", async () => {
    const root = await mkdtemp(join(tmpdir(), "operator-migration-"));
    roots.push(root);
    const path = join(root, "captain.sqlite");
    const legacy = await openCaptainLaneRegistry(path, { identity });
    await legacy.bindSession(TUI, { sessionId: "legacy-session", continuationToken: "legacy-token" });
    legacy.close();
    const registry = await openOperatorConversationRegistry(path, { identity });
    expect(registry.list()).toEqual([
      expect.objectContaining({ conversationId: "global-default", isDefault: true }),
    ]);
    expect(registry.privateSession("global-default")).toEqual({
      sessionId: "legacy-session",
      continuationToken: "legacy-token",
    });
    registry.close();

    const database = new DatabaseSync(path);
    expect(database.prepare("SELECT COUNT(*) AS count FROM captain_lanes WHERE lane = 'tui'").get()).toEqual({
      count: 1,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM operator_conversations").get()).toEqual({
      count: 1,
    });
    database.close();
  });

  it("refuses to guess when v1 contains multiple TUI lane owners", async () => {
    const root = await mkdtemp(join(tmpdir(), "operator-ambiguous-migration-"));
    roots.push(root);
    const path = join(root, "captain.sqlite");
    const legacy = await openCaptainLaneRegistry(path, { identity });
    await legacy.bindSession(TUI, { sessionId: "legacy-session-1", continuationToken: "legacy-token-1" });
    await legacy.bindSession(
      { characterId: "clankie", lane: "tui", targetId: "second-device" },
      { sessionId: "legacy-session-2", continuationToken: "legacy-token-2" },
    );
    legacy.close();
    await expect(openOperatorConversationRegistry(path, { identity })).rejects.toBeInstanceOf(
      OperatorConversationMigrationError,
    );
  });

  it("fails closed on duplicate legacy rows, captain identity drift, and bidirectional ownership reuse", async () => {
    const root = await mkdtemp(join(tmpdir(), "operator-fail-closed-"));
    roots.push(root);
    const path = join(root, "captain.sqlite");
    const registry = await openOperatorConversationRegistry(path, {
      identity,
      idFactory: (() => {
        let next = 0;
        return () => `conversation-${++next}`;
      })(),
    });
    const second = registry.create({
      scope: { kind: "workspace", workspaceId: "workspace-1" },
      title: "Second",
    });
    registry.bindSession({
      conversationId: "global-default",
      sessionId: "session-1",
      continuationToken: "token-1",
    });
    expect(() =>
      registry.bindSession({
        conversationId: second.conversationId,
        sessionId: "session-1",
        continuationToken: "token-2",
      }),
    ).toThrow(OperatorConversationOwnershipError);
    expect(() =>
      registry.bindSession({
        conversationId: second.conversationId,
        sessionId: "session-2",
        continuationToken: "token-1",
      }),
    ).toThrow(OperatorConversationOwnershipError);
    expect(() =>
      registry.bindSession({ conversationId: "global-default", sessionId: "replacement" }),
    ).toThrow(OperatorConversationOwnershipError);
    registry.close();
    await expect(
      openOperatorConversationRegistry(path, { identity: { ...identity, providerId: "changed" } }),
    ).rejects.toBeInstanceOf(OperatorConversationMigrationError);
  });

  it("keeps per-surface replay cursors independent and returns typed stale-revision conflicts", async () => {
    const root = await mkdtemp(join(tmpdir(), "operator-replay-"));
    roots.push(root);
    const registry = await openOperatorConversationRegistry(join(root, "captain.sqlite"), { identity });
    registry.appendEvent("global-default", {
      type: "message",
      role: "captain",
      text: "one",
      streaming: false,
    });
    const first = registry.replay({
      schemaVersion: 1,
      conversationId: "global-default",
      surfaceClientId: "rn",
    });
    if (first.status !== "page") throw new Error("expected page");
    registry.appendEvent("global-default", {
      type: "message",
      role: "captain",
      text: "two",
      streaming: false,
    });
    const rn = registry.replay({
      schemaVersion: 1,
      conversationId: "global-default",
      surfaceClientId: "rn",
      cursor: first.nextCursor,
    });
    const tui = registry.replay({
      schemaVersion: 1,
      conversationId: "global-default",
      surfaceClientId: "tui",
    });
    if (rn.status !== "page" || tui.status !== "page") throw new Error("expected page");
    expect(rn.events.map((event) => (event.type === "message" ? event.text : event.type))).toEqual(["two"]);
    expect(tui.events.map((event) => (event.type === "message" ? event.text : event.type))).toEqual([
      "one",
      "two",
    ]);
    const accepted = registry.acceptTurn({
      schemaVersion: 1,
      kind: "message",
      conversationId: "global-default",
      surfaceClientId: "rn",
      expectedRevision: 0,
      message: "first",
    });
    const conflict = registry.acceptTurn({
      schemaVersion: 1,
      kind: "message",
      conversationId: "global-default",
      surfaceClientId: "tui",
      expectedRevision: 0,
      message: "stale",
    });
    expect(accepted).toMatchObject({ status: "accepted", revision: 1 });
    if (accepted.status !== "accepted") throw new Error("expected accepted");
    expect(accepted.runId).toMatch(/^run:/u);
    expect(conflict).toMatchObject({ status: "revision_conflict", expectedRevision: 0, currentRevision: 1 });
    if (conflict.status !== "revision_conflict") throw new Error("expected conflict");
    expect(conflict.safeCursor).toMatch(/^event:/u);
    registry.close();
  });

  it("rejects an oversized event body while degrading a newer event to a bounded label", async () => {
    const root = await mkdtemp(join(tmpdir(), "operator-strict-event-"));
    roots.push(root);
    const registry = await openOperatorConversationRegistry(join(root, "captain.sqlite"), { identity });
    expect(() =>
      registry.appendEvent("global-default", {
        type: "message",
        role: "captain",
        text: "x".repeat(20_000),
        streaming: false,
      }),
    ).toThrow();
    const forward = registry.appendEvent("global-default", {
      type: "unsupported",
      kind: "provider.capability",
      summary: "a newer captain event",
    });
    expect(forward.type).toBe("unsupported");
    registry.close();
  });

  it("acknowledges before releasing execution and survives caller disconnect", async () => {
    const root = await mkdtemp(join(tmpdir(), "operator-ack-gate-"));
    roots.push(root);
    const registry = await openOperatorConversationRegistry(join(root, "captain.sqlite"), { identity });
    const gate = deferred();
    const started = deferred();
    const service = new LocalOperatorConversationService(
      registry,
      new CaptainAdmissionController({ capacity: 1 }),
      async (_turn, ctx) => {
        ctx.publish({ type: "message", role: "captain", text: "working", streaming: true });
        started.resolve();
        await gate.promise;
      },
    );
    const caller = new AbortController();
    const accepted = await service.send({
      schemaVersion: 1,
      kind: "message",
      conversationId: "global-default",
      surfaceClientId: "rn",
      expectedRevision: 0,
      message: "hi",
    });
    if (accepted.status !== "accepted") throw new Error("expected accepted");
    await started.promise;
    // The caller "disconnects/cancels"; it holds no cancellation power over accepted work.
    caller.abort();
    const beforeGate = registry.replay({
      schemaVersion: 1,
      conversationId: "global-default",
      surfaceClientId: "audit",
    });
    if (beforeGate.status !== "page") throw new Error("expected page");
    const beforeTypes = beforeGate.events.map((e) => (e.type === "turn" ? `turn:${e.phase}` : e.type));
    expect(beforeTypes).toContain("turn:accepted");
    expect(beforeTypes).not.toContain("turn:completed");
    gate.resolve();
    await service.awaitRun(accepted.runId);
    const afterGate = registry.replay({
      schemaVersion: 1,
      conversationId: "global-default",
      surfaceClientId: "audit",
    });
    if (afterGate.status !== "page") throw new Error("expected page");
    const afterTypes = afterGate.events.map((e) => (e.type === "turn" ? `turn:${e.phase}` : e.type));
    // The operator's own message is persisted in the acceptance revision, before
    // the acceptance marker, so replay reconstructs both sides of the transcript.
    expect(afterTypes).toEqual(["message", "turn:accepted", "message", "turn:completed"]);
    registry.close();
  });

  it("publishes a typed failed run event without rolling back the accepted revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "operator-fail-run-"));
    roots.push(root);
    const registry = await openOperatorConversationRegistry(join(root, "captain.sqlite"), { identity });
    const service = new LocalOperatorConversationService(
      registry,
      new CaptainAdmissionController({ capacity: 1 }),
      () => Promise.reject(new Error("execution failed")),
    );
    const accepted = await service.send({
      schemaVersion: 1,
      kind: "message",
      conversationId: "global-default",
      surfaceClientId: "rn",
      expectedRevision: 0,
      message: "hi",
    });
    if (accepted.status !== "accepted") throw new Error("expected accepted");
    await service.awaitRun(accepted.runId);
    const page = registry.replay({
      schemaVersion: 1,
      conversationId: "global-default",
      surfaceClientId: "audit",
    });
    if (page.status !== "page") throw new Error("expected page");
    expect(page.events.at(-1)).toMatchObject({
      type: "turn",
      phase: "failed",
      runId: accepted.runId,
      reasonCode: "execution_failed",
    });
    expect(registry.get("global-default")?.revision).toBe(1);
    registry.close();
  });

  it("serializes one conversation while admitting different conversations concurrently with operator priority", async () => {
    const root = await mkdtemp(join(tmpdir(), "operator-admission-"));
    roots.push(root);
    let id = 0;
    const registry = await openOperatorConversationRegistry(join(root, "captain.sqlite"), {
      identity,
      idFactory: () => `conversation-${++id}`,
    });
    const other = registry.create({ scope: { kind: "global" }, title: "Other" });
    const gates = new Map<string, () => void>();
    let active = 0;
    let maximum = 0;
    const service = new LocalOperatorConversationService(
      registry,
      new CaptainAdmissionController({ capacity: 2 }),
      async (_turn, ctx) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => gates.set(ctx.runId, resolve));
        active -= 1;
      },
    );
    const first = await service.send({
      schemaVersion: 1,
      kind: "message",
      conversationId: "global-default",
      surfaceClientId: "tui",
      expectedRevision: 0,
      message: "one",
    });
    const same = await service.send({
      schemaVersion: 1,
      kind: "message",
      conversationId: "global-default",
      surfaceClientId: "mac",
      expectedRevision: 1,
      message: "two",
    });
    const cross = await service.send({
      schemaVersion: 1,
      kind: "message",
      conversationId: other.conversationId,
      surfaceClientId: "rn",
      expectedRevision: 0,
      message: "other",
    });
    if (first.status !== "accepted" || same.status !== "accepted" || cross.status !== "accepted") {
      throw new Error("expected accepted acknowledgements");
    }
    // All three were acknowledged immediately; execution runs detached.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(maximum).toBe(2);
    expect(active).toBe(2);
    gates.get(first.runId)?.();
    gates.get(cross.runId)?.();
    await Promise.all([service.awaitRun(first.runId), service.awaitRun(cross.runId)]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(active).toBe(1);
    gates.get(same.runId)?.();
    await service.awaitRun(same.runId);
    registry.close();
  });

  it("returns typed unsupported results for input_response and worker_steer submits", async () => {
    const root = await mkdtemp(join(tmpdir(), "operator-unsupported-"));
    roots.push(root);
    const registry = await openOperatorConversationRegistry(join(root, "captain.sqlite"), { identity });
    expect(
      registry.acceptTurn({
        schemaVersion: 1,
        kind: "input_response",
        conversationId: "global-default",
        surfaceClientId: "rn",
        expectedRevision: 0,
        requestId: "req-1",
        response: { inputKind: "text", text: "answer" },
      }),
    ).toMatchObject({ status: "unsupported", submitKind: "input_response" });
    expect(
      registry.acceptTurn({
        schemaVersion: 1,
        kind: "worker_steer",
        conversationId: "global-default",
        surfaceClientId: "rn",
        expectedRevision: 0,
        workerRunId: "w-1",
        intent: { type: "focus", target: "failing_test" },
      }),
    ).toMatchObject({ status: "unsupported", submitKind: "worker_steer" });
    // No side effect: revision unchanged, no run events.
    expect(registry.get("global-default")?.revision).toBe(0);
    const page = registry.replay({
      schemaVersion: 1,
      conversationId: "global-default",
      surfaceClientId: "audit",
    });
    if (page.status !== "page") throw new Error("expected page");
    expect(page.events).toHaveLength(0);
    registry.close();
  });

  it("returns typed recovery envelopes and binds cursors to their conversation", async () => {
    const root = await mkdtemp(join(tmpdir(), "operator-recover-"));
    roots.push(root);
    let id = 0;
    const registry = await openOperatorConversationRegistry(join(root, "captain.sqlite"), {
      identity,
      idFactory: () => `conversation-${++id}`,
    });
    const other = registry.create({ scope: { kind: "global" }, title: "Other" });
    registry.appendEvent("global-default", {
      type: "message",
      role: "captain",
      text: "one",
      streaming: false,
    });
    registry.appendEvent(other.conversationId, {
      type: "message",
      role: "captain",
      text: "b",
      streaming: false,
    });
    // A conversation-bound cursor from a real page — its binding is opaque.
    const page = registry.replay({
      schemaVersion: 1,
      conversationId: "global-default",
      surfaceClientId: "rn",
    });
    if (page.status !== "page") throw new Error("expected page");
    const binding = page.safeCursor.split(":")[2];
    expect(binding).toMatch(/^[A-Za-z0-9_-]{12}$/u);

    // Malformed cursor -> cursor_invalid.
    expect(
      registry.replay({
        schemaVersion: 1,
        conversationId: "global-default",
        surfaceClientId: "rn",
        cursor: "not-a-cursor",
      }),
    ).toMatchObject({ status: "recover", code: "cursor_invalid", recoverable: true });
    // Ahead-of-log (future) bound cursor -> cursor_reset.
    expect(
      registry.replay({
        schemaVersion: 1,
        conversationId: "global-default",
        surfaceClientId: "rn",
        cursor: `event:9999:${binding}`,
      }),
    ).toMatchObject({ status: "recover", code: "cursor_reset", recoverable: true });
    // A conversation-A cursor used on conversation B fails closed as cursor_invalid
    // (binding mismatch) — it can never silently advance B.
    expect(
      registry.replay({
        schemaVersion: 1,
        conversationId: other.conversationId,
        surfaceClientId: "rn",
        cursor: page.safeCursor,
      }),
    ).toMatchObject({ status: "recover", code: "cursor_invalid", recoverable: true });
    // A cross-surface cursor within the SAME conversation is fine (independent caller cursors).
    expect(
      registry.replay({
        schemaVersion: 1,
        conversationId: "global-default",
        surfaceClientId: "mac",
        cursor: page.safeCursor,
      }).status,
    ).toBe("page");
    expect(
      registry.replay({ schemaVersion: 1, conversationId: "missing", surfaceClientId: "rn" }),
    ).toMatchObject({ status: "recover", code: "unknown_conversation", recoverable: false });
    for (let index = 0; index < 5; index += 1) {
      registry.appendEvent("global-default", {
        type: "message",
        role: "captain",
        text: `m${index}`,
        streaming: false,
      });
    }
    const limited = registry.replay({
      schemaVersion: 1,
      conversationId: "global-default",
      surfaceClientId: "rn",
      limit: 2,
    });
    if (limited.status !== "page") throw new Error("expected page");
    expect(limited.events).toHaveLength(2);
    expect(limited.hasMore).toBe(true);
    expect(limited.nextCursor).toMatch(/^event:\d+:[A-Za-z0-9_-]{12}$/u);
    expect(limited.retainedFromCursor).toMatch(/^event:0:[A-Za-z0-9_-]{12}$/u);
    registry.close();
  });

  it("serves the same registry through the callable service client contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "operator-service-"));
    roots.push(root);
    const registry = await openOperatorConversationRegistry(join(root, "captain.sqlite"), { identity });
    const service = new LocalOperatorConversationService(
      registry,
      new CaptainAdmissionController({ capacity: 1 }),
      async (_turn, ctx) => {
        ctx.publish({ type: "message", role: "captain", text: "ack", streaming: false });
      },
    );
    const client = createOperatorConversationServiceClient(createLocalOperatorConversationDispatch(service));
    expect((await client.list()).some((conversation) => conversation.isDefault)).toBe(true);
    expect((await client.get("global-default"))?.conversationId).toBe("global-default");
    const created = await client.create({ scope: { kind: "global" }, title: "Second" });
    expect(created.isDefault).toBe(false);
    const sent = await client.send({
      schemaVersion: 1,
      kind: "message",
      conversationId: "global-default",
      surfaceClientId: "rn",
      expectedRevision: 0,
      message: "go",
    });
    expect(sent.status).toBe("accepted");
    if (sent.status === "accepted") await service.awaitRun(sent.runId);
    const replay = await client.replay({
      schemaVersion: 1,
      conversationId: "global-default",
      surfaceClientId: "rn",
    });
    expect(replay.status).toBe("page");
    const steer = await client.send({
      schemaVersion: 1,
      kind: "worker_steer",
      conversationId: "global-default",
      surfaceClientId: "rn",
      expectedRevision: 1,
      workerRunId: "w1",
      intent: { type: "continue" },
    });
    expect(steer.status).toBe("unsupported");
    registry.close();
  });

  it("reads the server-owned registry read-only without becoming a second writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "operator-reader-"));
    roots.push(root);
    const path = join(root, "captain.sqlite");
    const registry = await openOperatorConversationRegistry(path, { identity });
    registry.create({ scope: { kind: "global" }, title: "Reader-visible" });
    const reader = await openOperatorConversationReader(path);
    expect(reader.list().some((conversation) => conversation.isDefault)).toBe(true);
    expect(reader.get("global-default")?.title).toBe("Clankie");
    reader.close();
    registry.close();
  });

  it("rotates a conversation's own Eve session self-consistently, resetting the stream index", async () => {
    const root = await mkdtemp(join(tmpdir(), "operator-rotate-"));
    roots.push(root);
    let id = 0;
    const registry = await openOperatorConversationRegistry(join(root, "captain.sqlite"), {
      identity,
      idFactory: () => `conversation-${++id}`,
    });
    registry.rebindSession({
      conversationId: "global-default",
      sessionId: "s1",
      continuationToken: "c1",
      state: "active",
    });
    registry.advanceEveStreamIndex("global-default", 5);
    expect(registry.eveStreamIndex("global-default")).toBe(5);
    // A legitimate self-rotation to a new session id succeeds and resets the index.
    registry.rebindSession({
      conversationId: "global-default",
      sessionId: "s2",
      continuationToken: "c2",
      state: "active",
    });
    expect(registry.privateSession("global-default").sessionId).toBe("s2");
    expect(registry.eveStreamIndex("global-default")).toBe(0);
    // A same-session rebind preserves the index.
    registry.advanceEveStreamIndex("global-default", 3);
    registry.rebindSession({
      conversationId: "global-default",
      sessionId: "s2",
      continuationToken: "c2",
      state: "waiting",
    });
    expect(registry.eveStreamIndex("global-default")).toBe(3);
    // Cross-conversation session reuse still fails closed.
    const other = registry.create({ scope: { kind: "global" }, title: "Other" });
    expect(() => registry.rebindSession({ conversationId: other.conversationId, sessionId: "s2" })).toThrow(
      OperatorConversationOwnershipError,
    );
    registry.close();
  });
});

describe("durable captain lane registry", () => {
  it("restores one lane per target without exposing or duplicating continuation ownership", async () => {
    const test = await registryHarness();
    await test.registry.register(TUI);
    await test.registry.bindSession(TUI, { sessionId: "session-tui", continuationToken: "token-tui" });
    await test.registry.register(VOICE);
    await test.registry.bindSession(VOICE, {
      sessionId: "session-voice",
      continuationToken: "token-voice",
    });
    await test.registry.register(GAMEPLAY);
    await test.registry.bindSession(GAMEPLAY, {
      sessionId: "session-gameplay",
      continuationToken: "token-gameplay",
    });
    expect(test.registry.list()).toHaveLength(3);
    expect(JSON.stringify(test.registry.list())).not.toContain("token-");
    expect(JSON.stringify(test.events)).not.toContain("token-");
    expect(test.registry.identity).toEqual(identity);
    test.registry.close();

    const reopened = await openCaptainLaneRegistry(test.path, {
      identity,
      events: (event) => {
        test.events.push(event);
      },
    });
    await reopened.register(VOICE);
    await reopened.register(GAMEPLAY);
    expect(reopened.list()).toHaveLength(3);
    expect(reopened.resumeState(TUI)?.continuationToken).toBe("token-tui");
    expect(reopened.resumeState(VOICE)?.continuationToken).toBe("token-voice");
    expect(reopened.resumeState(GAMEPLAY)?.continuationToken).toBe("token-gameplay");
    expect(test.events.filter((event) => event.type === "lane.restored")).toHaveLength(2);
    reopened.close();
  });

  it("fails closed on cross-lane tokens, sessions, identities, and live replacement", async () => {
    const test = await registryHarness();
    await test.registry.bindSession(TUI, { sessionId: "session-tui", continuationToken: "token-tui" });
    await expect(
      test.registry.bindSession(VOICE, {
        sessionId: "session-voice",
        continuationToken: "token-tui",
      }),
    ).rejects.toBeInstanceOf(CaptainContinuationOwnershipError);
    await expect(
      test.registry.bindSession(VOICE, {
        sessionId: "session-tui",
        continuationToken: "token-voice",
      }),
    ).rejects.toBeInstanceOf(CaptainLaneSessionConflictError);
    await expect(
      test.registry.bindSession(TUI, {
        sessionId: "replacement",
        continuationToken: "replacement-token",
      }),
    ).rejects.toBeInstanceOf(CaptainLaneSessionConflictError);
    await test.registry.markSessionState(TUI, "session-tui", "completed");
    await expect(
      test.registry.bindSession(TUI, {
        sessionId: "replacement",
        continuationToken: "replacement-token",
      }),
    ).resolves.toMatchObject({ sessionId: "replacement", state: "active" });
    test.registry.close();

    await expect(
      openCaptainLaneRegistry(test.path, {
        identity: { ...identity, providerId: "anthropic" },
      }),
    ).rejects.toThrow(/identity does not match/);
  });
});

describe("foreground-aware provider admission", () => {
  it("runs TUI and voice independently when provider capacity exists", async () => {
    const controller = new CaptainAdmissionController({ capacity: 2 });
    const [tui, voice] = await Promise.all([
      controller.acquire({ requestId: "tui-1", laneKey: "tui", lane: "operator" }),
      controller.acquire({ requestId: "voice-1", laneKey: "voice", lane: "discord_voice" }),
    ]);
    expect(controller.snapshot().active).toEqual(["tui-1", "voice-1"]);
    tui.release();
    voice.release();
  });

  it("serializes each lane deterministically while prioritizing TUI then voice", async () => {
    const controller = new CaptainAdmissionController({ capacity: 1 });
    const blocker = await controller.acquire({
      requestId: "voice-blocker",
      laneKey: "voice-blocker",
      lane: "discord_voice",
    });
    const order: string[] = [];
    const gameplay = controller
      .acquire({ requestId: "gameplay", laneKey: "gameplay", lane: "gameplay" })
      .then((lease) => {
        order.push("gameplay");
        lease.release();
      });
    const voice = controller
      .acquire({ requestId: "voice", laneKey: "voice", lane: "discord_voice" })
      .then((lease) => {
        order.push("voice");
        lease.release();
      });
    const tuiFirst = controller
      .acquire({ requestId: "tui-1", laneKey: "tui", lane: "operator" })
      .then((lease) => {
        order.push("tui-1");
        lease.release();
      });
    const tuiSecond = controller
      .acquire({ requestId: "tui-2", laneKey: "tui", lane: "operator" })
      .then((lease) => {
        order.push("tui-2");
        lease.release();
      });
    blocker.release();
    await Promise.all([gameplay, voice, tuiFirst, tuiSecond]);
    expect(order).toEqual(["tui-1", "tui-2", "voice", "gameplay"]);
  });

  it("cancels borrowed gameplay so TUI admits next under a one-call limit", async () => {
    const fixture = JSON.parse(
      await readFile(new URL("./fixtures/provider-pressure.json", import.meta.url), "utf8"),
    ) as { capacity: number; timeline: string[] };
    const events: CaptainRuntimeEvent[] = [];
    const timeline: string[] = [];
    const controller = new CaptainAdmissionController({
      capacity: fixture.capacity,
      events: (event) => {
        events.push(event);
      },
    });
    let gameplayStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      gameplayStarted = resolve;
    });
    const gameplay = controller
      .execute(
        { requestId: "gameplay-1", laneKey: "gameplay", lane: "gameplay" },
        (signal) =>
          new Promise<void>((_resolve, reject) => {
            timeline.push("gameplay:start");
            gameplayStarted?.();
            signal.addEventListener(
              "abort",
              () => {
                timeline.push("gameplay:cancelled");
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      )
      .catch((error: unknown) => {
        expect(error).toBeInstanceOf(CaptainAdmissionPreemptedError);
      });
    await started;
    const tui = controller.execute({ requestId: "tui-1", laneKey: "tui", lane: "operator" }, () => {
      timeline.push("tui:start");
      timeline.push("tui:complete");
      return Promise.resolve();
    });
    await Promise.all([gameplay, tui]);
    const preemptIndex = events.findIndex((event) => event.type === "admission.preempt_requested");
    timeline.splice(1, 0, preemptIndex >= 0 ? "gameplay:preempt_requested" : "missing-preemption");
    expect(timeline).toEqual(fixture.timeline);
    expect(controller.snapshot()).toEqual({ active: [], queued: [] });
  });

  it("records provider-pressure parking without leaking or retrying globally", async () => {
    const events: CaptainRuntimeEvent[] = [];
    const controller = new CaptainAdmissionController({
      capacity: 1,
      events: (event) => {
        events.push(event);
      },
    });
    await expect(
      controller.execute({ requestId: "rate-limited", laneKey: "voice", lane: "discord_voice" }, () =>
        Promise.reject(new CaptainProviderPressureError("retry after 30 seconds")),
      ),
    ).rejects.toThrow("retry after 30 seconds");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "admission.parked", requestId: "rate-limited" }),
    );
    expect(controller.snapshot()).toEqual({ active: [], queued: [] });
  });

  it("bounds bursts per lane without blocking a different lane's queue", async () => {
    const controller = new CaptainAdmissionController({ capacity: 1, maxQueuedPerLane: 1 });
    const active = await controller.acquire({ requestId: "active", laneKey: "tui", lane: "operator" });
    const queuedTui = controller.acquire({ requestId: "tui-queued", laneKey: "tui", lane: "operator" });
    await expect(
      controller.acquire({ requestId: "tui-overflow", laneKey: "tui", lane: "operator" }),
    ).rejects.toBeInstanceOf(CaptainAdmissionQueueFullError);
    const queuedVoice = controller.acquire({
      requestId: "voice-queued",
      laneKey: "voice",
      lane: "discord_voice",
    });
    expect(controller.snapshot().queued).toEqual(["tui-queued", "voice-queued"]);
    active.release();
    const tui = await queuedTui;
    tui.release();
    const voice = await queuedVoice;
    voice.release();
  });
});

describe("lane-scoped execution and model calls", () => {
  it("routes responses to their origin and never supplies another lane's continuation", async () => {
    const test = await registryHarness();
    await test.registry.bindSession(TUI, { sessionId: "tui-session", continuationToken: "tui-token" });
    await test.registry.bindSession(VOICE, {
      sessionId: "voice-session",
      continuationToken: "voice-token",
    });
    const executor = new CaptainLaneExecutor(test.registry, new CaptainAdmissionController({ capacity: 2 }));
    const seen: string[] = [];
    const routed: string[] = [];
    await Promise.all([
      executor.dispatch({
        address: TUI,
        requestId: "tui-turn",
        sessionId: "tui-session",
        continuationToken: "tui-token",
        execute: ({ continuationToken }) => {
          seen.push(`tui:${continuationToken}`);
          return Promise.resolve({
            output: "tui response",
            sessionId: "tui-session",
            continuationToken: "tui-token-next",
          });
        },
        route: ({ address, output }) => {
          routed.push(`${address.targetId}:${output}`);
        },
      }),
      executor.dispatch({
        address: VOICE,
        requestId: "voice-turn",
        sessionId: "voice-session",
        continuationToken: "voice-token",
        execute: ({ continuationToken }) => {
          seen.push(`voice:${continuationToken}`);
          return Promise.resolve({
            output: "voice response",
            sessionId: "voice-session",
            continuationToken: "voice-token-next",
          });
        },
        route: ({ address, output }) => {
          routed.push(`${address.targetId}:${output}`);
        },
      }),
    ]);
    expect(seen.sort()).toEqual(["tui:tui-token", "voice:voice-token"]);
    expect(routed.sort()).toEqual(["guild-1:voice-1:voice response", "operator:tui response"]);
    expect(test.registry.resumeState(TUI)?.continuationToken).toBe("tui-token-next");
    expect(test.registry.resumeState(VOICE)?.continuationToken).toBe("voice-token-next");
    test.registry.close();
  });

  it("holds a model permit until a streamed response reaches its boundary", async () => {
    const admission = new CaptainAdmissionController({ capacity: 1 });
    let closeStream: (() => void) | undefined;
    const raw = {
      modelId: "fixture",
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<string>({
            start(controller) {
              controller.enqueue("first");
              closeStream = () => controller.close();
            },
          }),
        }),
    };
    const admitted = createAdmittedLanguageModel(raw, {
      admission,
      laneKey: "tui",
      lane: "operator",
      requestId: "stream",
    });
    const response = await admitted.doStream();
    const reader = response.stream.getReader();
    expect(await reader.read()).toEqual({ done: false, value: "first" });
    expect(admission.snapshot().active).toEqual(["stream:0"]);
    closeStream?.();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(admission.snapshot().active).toEqual([]);
  });
});
