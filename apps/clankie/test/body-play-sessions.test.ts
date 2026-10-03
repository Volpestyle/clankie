import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbodimentIntent } from "@clankie/protocol";
import { WORLD_PROTOCOL_VERSION } from "@pokeagents/world-protocol";
import { WorldPlayerPersistedSessionSchema } from "@pokeagents/world-protocol/ipc";
import { describe, expect, it, vi } from "vitest";
import { BodyLeaseStore } from "../src/body-leases.ts";
import { BodyPlaySessions } from "../src/body-play-sessions.ts";
import { EmbodimentManager } from "../src/embodiment.ts";
import { PlayHost } from "../src/play-host.ts";
import { HostedWorldSession } from "../src/world/session.ts";
import { fakeWorldBody } from "./world-body-fake.ts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { BodyLeaseRouter } from "../src/body-lease-router.ts";

const logger = { info: () => {}, warn: () => {}, error: () => {} };
const intent = (id = "start-1"): EmbodimentIntent => ({
  kind: "start",
  schemaVersion: 1,
  intentId: id,
  originLane: "operator",
  requestedBy: "operator",
  requestedAt: new Date().toISOString(),
  environmentId: "pokemon-firered",
  budget: {},
});
const identity = (conversationId = "conversation-a") => ({
  conversationId,
  current: () => true,
  authorize: async () => true,
});
const state = WorldPlayerPersistedSessionSchema.parse({
  version: 1,
  token: "test-session-token-for-offline-fixture-only-000000000000",
  capabilities: ["world.observe", "world.act", "world.frames"],
  session: {
    ok: true,
    protocolVersion: WORLD_PROTOCOL_VERSION,
    worldId: "world-1",
    playerId: "player-1",
    sessionId: "native-world-session-1",
    gameId: "firered",
    limits: { maxInputsPerAction: 64, maxFramesPerAction: 1800, stallTimeoutMs: 5000 },
  },
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(startHost?: () => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "clankie-body-play-"));
  const store = new BodyLeaseStore(join(root, "body"));
  const path = join(root, "sessions.json");
  const sessions = new BodyPlaySessions(store, path);
  let next = 0;
  const manager = new EmbodimentManager({
    clock: () => new Date(),
    decide: () => "allow",
    idFactory: () => `play-${++next}`,
    emit: async () => {},
    ...(startHost === undefined ? {} : { startHost }),
  });
  return { root, path, store, sessions, manager };
}

describe("conversation play lifetime", () => {
  it("authenticates API selected conversations and refuses bearer-only or competing starts", async () => {
    const f = fixture();
    const captain = createStubCaptain();
    captain.seatContext = (id) =>
      ["conversation-a", "conversation-b"].includes(id ?? "")
        ? { conversationId: id!, cwd: "/tmp" }
        : undefined;
    const { app, embodiment } = await createClankieApp({
      captain,
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === "Bearer operator" ? { operatorId: "owner" } : undefined,
      authenticateCaptain: async () => ({ captainId: "generic" }),
      bodyLeases: { store: f.store, router: new BodyLeaseRouter(f.store), confirmStopped: async () => false },
      bodyPlaySessions: f.sessions,
    });
    const post = (conversationId?: string, authorization = "Bearer operator") =>
      app.request("/v1/embodiment/intents", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ ...intent(), ...(conversationId === undefined ? {} : { conversationId }) }),
      });
    expect((await post("conversation-a", "Bearer captain")).status).toBe(401);
    expect(await (await post()).json()).toMatchObject({
      outcome: "refused",
      bodyLease: { reason: "identity_required" },
    });
    expect((await post("conversation-a")).status).toBe(200);
    expect(embodiment.liveSession()).toMatchObject({ originLane: "operator", requestedBy: "owner" });
    expect(await (await post("conversation-b")).json()).toMatchObject({
      outcome: "refused",
      bodyLease: { outcome: "busy", lease: { conversationId: "conversation-a" } },
    });
    f.sessions.settle(embodiment.liveSession()!.sessionId, true);
    f.store.close();
  });
  it("requires host identity and persists the pin before a start becomes claimable", async () => {
    const f = fixture();
    expect(await f.sessions.submit(intent(), undefined, f.manager)).toMatchObject({
      outcome: "refused",
      bodyLease: { reason: "identity_required" },
    });
    expect(f.manager.liveSession()).toBeUndefined();
    const accepted = await f.sessions.submit(intent(), identity(), f.manager);
    expect(accepted.outcome).toBe("accepted");
    expect(JSON.parse(readFileSync(f.path, "utf8")).sessions["play-1"].finished).toBe(false);
    expect((await f.manager.claim(["pokemon-firered"]))?.kind).toBe("start");
    expect(await f.sessions.submit(intent("other"), identity("conversation-b"), f.manager)).toMatchObject({
      outcome: "refused",
      bodyLease: { outcome: "busy", lease: { conversationId: "conversation-a" } },
    });
    f.sessions.settle("play-1", true);
    f.store.close();
  });

  it("does not release on a forced failure report or on proof before execution settles", async () => {
    const f = fixture();
    await f.sessions.submit(intent(), identity(), f.manager);
    const ready = deferred();
    const finish = deferred();
    const host = new PlayHost({
      client: {
        claimEmbodiment: (ids) => f.manager.claim(ids),
        reportEmbodiment: (update) => f.manager.report(update),
        getLiveEmbodimentSession: async () => f.manager.liveSession(),
      },
      environmentIds: ["pokemon-firered"],
      logger,
      forcedReportGraceMs: 10,
      lifecycle: {
        guard: (id) => f.sessions.guard(id),
        uncertain: (id) => f.sessions.uncertain(id),
        settled: (id, confirmed) => f.sessions.settle(id, confirmed),
      },
      execute: async (_session, control, running) => {
        await running();
        control.confirmStopped?.();
        ready.resolve();
        await finish.promise;
        return {
          kind: "ran",
          result: { outcome: "stopped", turnsTaken: 0, durationMs: 1, framesPublished: 0, framesDropped: 0 },
        };
      },
    });
    await host.poll();
    await ready.promise;
    expect(await host.stopAndWait({ deadlineMs: 1 })).toMatchObject({ status: "deadline_expired" });
    expect(f.manager.getSession("play-1")?.state).toBe("failed");
    expect(f.sessions.stopped()).toBe(false);
    expect(
      await f.sessions.submit(intent("after-timeout"), identity("conversation-b"), f.manager),
    ).toMatchObject({ outcome: "refused", bodyLease: { outcome: "busy" } });
    finish.resolve();
    await host.settled();
    expect(f.sessions.stopped()).toBe(true);
    expect(f.store.status("play")).toBeUndefined();
    f.store.close();
  });

  it("keeps original source authority through a later turn and refuses revoked effects", async () => {
    const f = fixture();
    let current = true;
    let allowed = true;
    await f.sessions.submit(
      intent(),
      { ...identity(), current: () => current, authorize: async () => allowed },
      f.manager,
    );
    current = false;
    await expect(f.sessions.guard("play-1")).resolves.toBeUndefined();
    allowed = false;
    await expect(f.sessions.guard("play-1")).rejects.toThrow();
    f.sessions.uncertain("play-1");
    expect(f.store.status("play")?.state).toBe("recovery_required");
    f.sessions.settle("play-1", true);
    f.store.close();
  });

  it("rechecks after lazy host startup before publishing a requested session", async () => {
    const gate = deferred();
    const f = fixture(() => gate.promise);
    let current = true;
    const submitted = f.sessions.submit(intent(), { ...identity(), current: () => current }, f.manager);
    await new Promise<void>((resolve) => setImmediate(resolve));
    current = false;
    gate.resolve();
    expect(await submitted).toMatchObject({ outcome: "refused", bodyLease: { reason: "identity_required" } });
    expect(f.manager.liveSession()).toBeUndefined();
    expect(f.store.status("play")).toBeUndefined();
    f.store.close();
  });

  it("retains unknown cleanup and reconciles restart only against the exact saved world session", async () => {
    const f = fixture();
    await f.sessions.submit(intent(), identity(), f.manager);
    f.sessions.rememberWorldSession("play-1", "/test/world.sock", state);
    f.sessions.settle("play-1", false);
    expect(f.sessions.stopped()).toBe(false);
    f.store.close();
    const store = new BodyLeaseStore(join(f.root, "body"));
    const restored = new BodyPlaySessions(store, f.path);
    await expect(restored.guard("play-1")).rejects.toThrow();
    const guard = vi.fn(async () => {});
    expect(
      await restored.recover(guard, async () => ({
        ok: false,
        code: "unauthenticated",
        message: "token lost",
      })),
    ).toBe(false);
    expect(store.status("play")?.state).toBe("recovery_required");
    expect(
      await restored.recover(guard, async (_target, request) => {
        expect(request).toMatchObject({ operation: "world.leave", token: state.token });
        return { ok: true, sessionId: "another-session", endedAt: new Date().toISOString() };
      }),
    ).toBe(false);
    expect(
      await restored.recover(guard, async () => ({
        ok: true,
        sessionId: state.session.sessionId,
        endedAt: new Date().toISOString(),
      })),
    ).toBe(true);
    expect(guard).toHaveBeenCalled();
    expect(store.status("play")).toBeUndefined();
    store.close();
  });

  it("keeps a lost join receipt blocked and guards direct world mutations", async () => {
    const f = fixture();
    await f.sessions.submit(intent(), identity(), f.manager);
    const call = vi.fn(async () => ({ ok: true }));
    const world = new HostedWorldSession();
    world.attach(fakeWorldBody({ grantedOperationNames: () => ["world.travel"], callWorld: call }));
    await world.invoke("world.travel", { destination: "emerald" }, () =>
      f.sessions.guardOwner(identity("conversation-b")),
    );
    expect(call).not.toHaveBeenCalled();
    f.sessions.settle("play-1", false);
    expect(await f.sessions.recover(async () => {})).toBe(false);
    expect(f.store.status("play")?.state).toBe("recovery_required");
    f.store.close();
  });
});
