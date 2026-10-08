import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { GameExtensionRegistry } from "@clankie/game-extension";
import { SettingsStore } from "@clankie/settings";
import type { RivalsStatus } from "@clankie/protocol";
import { BodyLeaseStore } from "../src/body-leases.ts";
import { BodyLeaseRouter, type BodyConversationIdentity } from "../src/body-lease-router.ts";
import { RivalsService } from "../src/rivals-service.ts";
import type { GameExtensionProjection } from "../src/game-extension-projection.ts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { startFixtureServer } from "./owner-settings-surface-fixture.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const owner = (conversationId = "owner"): BodyConversationIdentity => ({
  conversationId,
  current: () => true,
  authorize: async () => true,
  route: { owner: { conversationId }, mode: "machine" },
});
const start = {
  action: "start" as const,
  requestId: "sitting",
  objective: { mode: "combat" as const, note: "retained prose" },
  maxSeconds: 60,
};

/** Isolated session-server contract fixture: real authenticated HTTP, controlled cleanup receipts, no game body. */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "rivals-extension-"));
  let status: RivalsStatus = {
    schemaVersion: 1,
    execution: "replay",
    modes: ["autonomous", "combat", "disengage"],
    noteApplied: false,
    session: null,
  };
  let denyStop = false;
  let unavailable = false;
  let lostStart = false;
  let heldStart = false;
  let cleanupOnStop = false;
  const calls: { path: string; input: Record<string, unknown> }[] = [];
  const bearer = randomUUID();
  const server: Server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${bearer}`) {
      response.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = chunks.length
      ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
      : {};
    calls.push({ path: request.url!, input });
    if (unavailable) {
      response.destroy();
      return;
    }
    if (request.url === "/v1/start") {
      status.session = {
        id: randomUUID().replaceAll("-", ""),
        requestId: String(input.requestId),
        phase: "starting",
        objective: input.objective as NonNullable<RivalsStatus["session"]>["objective"],
        startedAt: Date.now() / 1000,
        maxSeconds: Number(input.maxSeconds),
        observation: null,
        summary: null,
        error: null,
      };
      if (lostStart) {
        response.destroy();
        return;
      }
      if (heldStart) return; // Real client deadline; the original sitting still exists.
    }
    if (request.url === "/v1/stop") {
      if (denyStop || input.sessionId !== status.session?.id) {
        response
          .writeHead(409, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "session_mismatch" }));
        return;
      }
      status.session!.phase = "stopping";
      if (cleanupOnStop) stopped();
    }
    if (request.url === "/v1/objective")
      status.session!.objective = input.objective as NonNullable<RivalsStatus["session"]>["objective"];
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(status));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const settings = new SettingsStore(join(directory, "settings.json"));
  await settings.update((value) => ({
    ...value,
    gameplay: { ...value.gameplay, rivalsUrl: `http://127.0.0.1:${port}` },
  }));
  const credentials = new FileCredentialStore(join(directory, "credentials.json"));
  await credentials.set("rivals-agent", { type: "api", key: bearer });
  let store = new BodyLeaseStore(join(directory, "body"));
  let registry = new GameExtensionRegistry<GameExtensionProjection>();
  const create = () =>
    new RivalsService({ settings, credentials, store, registry, path: join(directory, "rivals.json") });
  let service = create();
  function stopped() {
    status.session!.phase = "stopped";
    status.session!.endedAt = Date.now() / 1000;
  }
  cleanups.push(async () => {
    // Own fixture only: settle its native receipt or let failed transport retain recovery.
    unavailable = true;
    await service.settled();
    store.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    bearer,
    settings,
    calls,
    status: () => status,
    stopped,
    service: () => service,
    store: () => store,
    registry: () => registry,
    denyStop: () => {
      denyStop = true;
    },
    loseStart: () => {
      lostStart = true;
    },
    holdStart: () => {
      heldStart = true;
    },
    fail: () => {
      unavailable = true;
    },
    available: () => {
      unavailable = false;
    },
    cleanupOnStop: () => {
      cleanupOnStop = true;
    },
    replace: () => {
      status.session = { ...status.session!, id: "b".repeat(32), requestId: "replacement" };
    },
    async restart() {
      await service.settled();
      store.close();
      store = new BodyLeaseStore(join(directory, "body"));
      registry = new GameExtensionRegistry<GameExtensionProjection>();
      service = create();
    },
  };
}

it("registers inertly, reads replay status without starting, and excludes another game's play lease", async () => {
  const f = await fixture();
  expect((await f.registry().catalog()).extensions[0]).toMatchObject({
    id: "rivals",
    connector: { kind: "skill", sessionServer: "rivals-agent" },
    status: { state: "idle" },
  });
  expect(f.calls).toEqual([]);
  expect(await f.service().call({ action: "status" })).toMatchObject({ execution: "replay", session: null });
  expect(await f.service().call(start)).toMatchObject({ outcome: "refused" });
  expect(f.store().status("play")).toBeUndefined();
  const pokemon = f.store().acquire("play", "pokemon", 30_000);
  expect(await f.service().call(start, owner())).toMatchObject({ reason: "play_session_active" });
  expect(f.calls.filter((call) => call.path === "/v1/start")).toHaveLength(0);
  if (pokemon.outcome !== "acquired") throw new Error("fixture admission failed");
  f.store().release(pokemon.lease);
  expect(await f.service().call(start, owner())).toMatchObject({
    outcome: "ok",
    execution: "replay",
    session: { phase: "starting", objective: start.objective },
  });
  expect(f.store().acquire("play", "minecraft", 30_000).outcome).toBe("busy");
  await expect(f.registry().unregister("rivals")).rejects.toThrow("game_extension_busy");
  f.stopped();
  await f.service().settled();
  expect(f.store().status("play")).toBeUndefined();
  await f.registry().unregister("rivals");
  expect(f.registry().projections()).toEqual([]);
});

it("scopes stop and steering to the authenticated original owner and waits for endedAt cleanup", async () => {
  const f = await fixture();
  await f.service().call(start, owner());
  const id = f.status().session!.id;
  f.status().session!.phase = "running";
  await expect
    .poll(async () => (await f.registry().catalog()).extensions[0]?.status.state, { timeout: 5000 })
    .toBe("running");
  expect(await f.service().call({ action: "stop", sessionId: id }, owner("other"))).toMatchObject({
    reason: "not_authorized",
  });
  expect(await f.service().call({ action: "stop", sessionId: "b".repeat(32) }, owner())).toMatchObject({
    reason: "not_authorized",
  });
  expect(
    await f
      .service()
      .call(
        { action: "objective", sessionId: id, objective: { mode: "disengage", note: "context" } },
        owner(),
      ),
  ).toMatchObject({ noteApplied: false });
  expect(await f.service().call({ action: "stop", sessionId: id }, owner())).toMatchObject({
    stop: "requested",
  });
  await expect
    .poll(() => f.calls.filter((call) => call.path === "/v1/stop").length, { timeout: 5000 })
    .toBe(1);
  // Native terminal phase alone precedes release; the lease must still exclude others.
  f.status().session!.phase = "stopped";
  expect(f.store().acquire("play", "pokemon", 30_000).outcome).toBe("busy");
  f.stopped();
  await f.service().settled();
  expect(
    f.calls.filter((call) => call.path === "/v1/stop").every((call) => call.input.sessionId === id),
  ).toBe(true);
  expect(f.store().status("play")).toBeUndefined();
  expect(await readFile(join(f.directory, "rivals.json"), "utf8")).not.toContain(f.bearer);
});

it("denied stop retains uncertainty; exact original receipt recovers after a real ledger restart", async () => {
  const f = await fixture();
  await f.service().call(start, owner());
  const id = f.status().session!.id;
  f.denyStop();
  await f.service().call({ action: "stop", sessionId: id }, owner());
  await f.service().settled();
  expect(f.store().status("play")?.state).toBe("recovery_required");
  await f.restart();
  expect((await f.registry().catalog()).extensions[0]?.status.state).toBe("uncertain");
  const recover = () =>
    new BodyLeaseRouter(f.store()).recover(owner(), "play", (guard) => f.service().recover(guard));
  expect(await recover()).toMatchObject({ reason: "recovery_required" });
  expect(f.store().acquire("play", "minecraft", 30_000).outcome).toBe("busy");
  f.stopped();
  expect(await recover()).toMatchObject({ outcome: "released" });
  expect((await f.registry().catalog()).extensions[0]?.status.state).toBe("idle");
});

it("lost HTTP reply persists original nonce; recovery never starts again or stops a replacement", async () => {
  const f = await fixture();
  f.loseStart();
  expect(await f.service().call(start, owner())).toMatchObject({ reason: "rivals_start_unconfirmed" });
  await f.service().settled();
  await f.restart();
  f.replace();
  const recover = () =>
    new BodyLeaseRouter(f.store()).recover(owner(), "play", (guard) => f.service().recover(guard));
  expect(await recover()).toMatchObject({ reason: "recovery_required" });
  expect(f.calls.filter((call) => call.path === "/v1/stop")).toHaveLength(0);
  expect(f.calls.filter((call) => call.path === "/v1/start")).toHaveLength(1);
  expect(f.store().status("play")?.state).toBe("recovery_required");
});

it("lost start reply can recover only its persisted original request and real cleanup receipt", async () => {
  const f = await fixture();
  f.loseStart();
  await f.service().call(start, owner());
  await f.service().settled();
  await f.restart();
  f.cleanupOnStop();
  expect(
    await new BodyLeaseRouter(f.store()).recover(owner(), "play", (guard) => f.service().recover(guard)),
  ).toMatchObject({ outcome: "released" });
  expect(f.calls.filter((call) => call.path === "/v1/start")).toHaveLength(1);
});

it("an actual HTTP start deadline retains ownership until the original post-cleanup receipt", async () => {
  const f = await fixture();
  f.holdStart();
  expect(await f.service().call(start, owner())).toMatchObject({ reason: "rivals_start_unconfirmed" });
  await f.service().settled();
  expect(f.store().status("play")?.state).toBe("recovery_required");
  expect(f.store().acquire("play", "pokemon", 30_000).outcome).toBe("busy");
  await f.restart();
  f.stopped();
  expect(
    await new BodyLeaseRouter(f.store()).recover(owner(), "play", (guard) => f.service().recover(guard)),
  ).toMatchObject({ outcome: "released" });
  expect(f.calls.filter((call) => call.path === "/v1/start")).toHaveLength(1);
});

it("failed cleanup and replay replacing the original live execution cannot release its claim", async () => {
  const f = await fixture();
  f.status().execution = "live";
  await f.service().call(start, owner());
  f.status().session!.phase = "failed";
  f.status().session!.error = "release_failed";
  f.status().session!.endedAt = Date.now() / 1000;
  await f.service().settled();
  await f.restart();
  const recover = () =>
    new BodyLeaseRouter(f.store()).recover(owner(), "play", (guard) => f.service().recover(guard));
  expect(await recover()).toMatchObject({ reason: "recovery_required" });
  f.stopped();
  f.status().session!.error = null;
  f.status().execution = "replay";
  expect(await recover()).toMatchObject({ reason: "recovery_required" });
  expect(f.store().status("play")?.state).toBe("recovery_required");
});

it("changed configuration never redirects recovery; a revoked final dispatch sends no start", async () => {
  const f = await fixture();
  let current = true;
  const identity = {
    ...owner(),
    current: () => current,
    authorize: async () => {
      current = false;
      return true;
    },
  };
  expect(await f.service().call(start, identity)).toMatchObject({ outcome: "refused" });
  expect(f.calls).toEqual([]);
  await f.service().call(start, owner());
  f.fail();
  await f.service().settled();
  f.available();
  await f.restart();
  await f.settings.update((s) => ({ ...s, gameplay: { ...s.gameplay, rivalsUrl: "http://127.0.0.1:1" } }));
  f.stopped();
  expect(
    await new BodyLeaseRouter(f.store()).recover(owner(), "play", (guard) => f.service().recover(guard)),
  ).toMatchObject({ outcome: "released" });
});

it("registered operator HTTP and captain tools bind the owner; removal removes both projections", async () => {
  const f = await fixture();
  const app = await createClankieApp({
    captain: createStubCaptain({
      seatContext: (id) => ({ conversationId: id ?? "owner", cwd: f.directory }),
      validateConversationOwner: async (identity) => identity.conversationId === "owner",
    }),
    settings: f.settings,
    rivals: f.service(),
    gameExtensions: f.registry(),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-owner" ? { operatorId: "owner" } : undefined,
  });
  const server = await startFixtureServer(app.app.fetch);
  try {
    const post = (input: unknown, authenticated = true) =>
      fetch(server.host + "/v1/rivals", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authenticated ? { authorization: "Bearer fixture-owner" } : {}),
        },
        body: JSON.stringify(input),
      });
    expect((await post(start, false)).status).toBe(401);
    expect(f.calls).toEqual([]);
    expect((await post({ action: "stop", sessionId: "wrong" })).status).toBe(400);
    const result = (await (await post(start)).json()) as { session: { id: string } };
    const tools = f
      .registry()
      .projections()
      .flatMap((projection) => projection.tools({ bodyIdentity: owner("other") }));
    const stopped = await tools[0]!.execute(
      "stop",
      { action: "stop", sessionId: result.session.id },
      undefined,
      undefined,
      {} as never,
    );
    expect(stopped.details).toMatchObject({ outcome: "refused", reason: "not_authorized" });
    const catalog = await fetch(server.host + "/v1/games/extensions", {
      headers: { authorization: "Bearer fixture-owner" },
    });
    expect(await catalog.json()).toMatchObject({
      extensions: [{ id: "rivals", settings: { key: "gameplay" } }],
    });
    f.stopped();
    await f.service().settled();
    await f.registry().unregister("rivals");
    expect((await post({ action: "status" })).status).toBe(404);
    expect(f.registry().projections()).toEqual([]);
    expect(await f.service().call(start, owner())).toMatchObject({ outcome: "refused" });
    expect(f.store().status("play")).toBeUndefined();
  } finally {
    app.close();
    await server.close();
  }
});

it("the original captured grant survives its admitting turn but revoked authority retains ownership", async () => {
  const f = await fixture();
  let current = true;
  let allowed = true;
  const identity = { ...owner(), current: () => current, authorize: async () => allowed };
  await f.service().call(start, identity);
  current = false; // Admission turn is finished; the captured sitting remains owned.
  f.status().session!.phase = "running";
  await expect
    .poll(async () => (await f.registry().catalog()).extensions[0]?.status.state, { timeout: 5000 })
    .toBe("running");
  expect(f.store().acquire("play", "minecraft", 30_000).outcome).toBe("busy");
  allowed = false;
  await f.service().settled();
  expect(f.store().status("play")?.state).toBe("recovery_required");
  expect((await f.registry().catalog()).extensions[0]?.status.state).toBe("uncertain");
});
