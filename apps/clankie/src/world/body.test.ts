import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileCredentialStore,
  WORLD_CREDENTIAL_FORBIDDEN_ENV,
  WORLD_CREDENTIAL_PROVIDER_ID,
  resolveWorldCredential,
  type CredentialStore,
} from "@clankie/credential-broker";
import { EnvironmentAdapterActionError } from "@clankie/environment-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { joinWorld } from "./body.ts";

const CREDENTIAL = "clankie-world-test-credential-0000000000000001";
const TOKEN = "session-token-0000000000000000000000000001";
const SESSION_ID = "session-clankie";
const PLAYER_ID = "player-clankie";
const WORLD_ID = "pallet";
const NOW = "2026-08-16T00:00:00.000Z";
const CAPABILITIES = ["world.observe", "world.act", "world.frames", "world.presence"];

interface WireRequest {
  readonly operation: string;
  readonly input?: unknown;
  readonly token?: string;
  readonly credential?: string;
}

interface FakeWorld {
  readonly stateDir: string;
  readonly requests: WireRequest[];
  readonly close: () => Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("hosted world body", () => {
  it("resolves only the broker-owned opaque credential", async () => {
    const store = memoryStore();
    await store.set(WORLD_CREDENTIAL_PROVIDER_ID, { type: "api", key: CREDENTIAL });
    await expect(resolveWorldCredential({ store, env: {} })).resolves.toBe(CREDENTIAL);
    await expect(
      resolveWorldCredential({
        store,
        env: { [WORLD_CREDENTIAL_FORBIDDEN_ENV]: CREDENTIAL },
      }),
    ).rejects.toThrow(/must not be set/u);
    expect(WORLD_CREDENTIAL_PROVIDER_ID).toBe("pokeagent_mmo_world");
  });

  it("joins by credential, maps every available view, drives actions, and leaves once", async () => {
    let current = observation({ frame: 10, x: 13, y: 13 });
    const world = await fakeWorld((request) => {
      switch (request.operation) {
        case "world.join":
          return joinResult();
        case "play.observe":
          return current;
        case "play.act": {
          const action = (request.input as { action: { kind: string } }).action;
          if (action.kind === "select_menu_entry") {
            return actRejected({ reason: "menu_entry_not_present", available: [] }, current.frame);
          }
          current = observation({ frame: 20, x: 14, y: 13 });
          return actRan(current);
        }
        case "play.frame":
          return frame({ frame: current.frame, data: "after-action" });
        case "world.session":
          return sessionStatus(current.frame);
        case "world.who":
          return whoResult();
        case "world.leave":
          return { ok: true, sessionId: SESSION_ID, endedAt: NOW };
        default:
          throw new Error(`unexpected operation ${request.operation}`);
      }
    });
    const env = await provisionedEnv(world.stateDir);
    const result = await joinWorld({ environmentId: "pokemon-firered", env });
    expect(result.outcome).toBe("joined");
    if (result.outcome !== "joined") return;
    const body = result.body;

    expect(body.io.observe("danger")).toMatchObject({ data: { stateCertain: true } });
    expect(body.io.observe("scene")).toMatchObject({ data: { mode: "overworld", inputReady: true } });
    expect(body.io.observe("overworld")).toMatchObject({
      frame: 10,
      data: {
        position: { mapId: "pallet-town/players-house-2f", x: 13, y: 13 },
        facing: "north",
        minimap: { topLeft: { x: 12, y: 12 } },
      },
    });
    expect(body.io.observe("party")).toMatchObject({
      data: {
        activeSlot: 0,
        members: [{ speciesId: "firered-species-1", status: "healthy" }],
      },
    });
    expectAdapterError(() => body.io.observe("dialog"), "dialog_not_open");
    expectAdapterError(() => body.io.observe("menu"), "menu_not_open");
    expectAdapterError(() => body.io.observe("battle"), "battle_not_active");
    expectAdapterError(() => body.io.observe("inventory"), "semantic_state_unavailable");

    await body.io.pause("thinking");
    await expect(body.io.act({ kind: "button_press", button: "a", holdFrames: 4 })).resolves.toMatchObject({
      status: "failed",
      errorCode: "session_paused",
    });
    await body.io.resume();
    await expect(body.io.act({ kind: "enter_text", text: "RED", submit: false })).resolves.toMatchObject({
      status: "completed",
      outcome: { screenChanged: true },
    });
    expect(body.io.observe("overworld")).toMatchObject({ frame: 20, data: { position: { x: 14, y: 13 } } });
    expect(body.framePng()).toEqual(Uint8Array.from(Buffer.from("after-action")));

    await expect(body.io.act({ kind: "select_menu_entry", entryId: "POKEMON" })).resolves.toMatchObject({
      status: "failed",
      errorCode: "menu_entry_not_present",
    });
    expect(body.io.observe("overworld")).toMatchObject({ frame: 20, data: { position: { x: 14, y: 13 } } });
    expect(body.io.observe("action")).toMatchObject({ data: { status: "failed" } });
    await expect(body.session()).resolves.toMatchObject({ sessionId: SESSION_ID, state: "playing" });
    await expect(body.who()).resolves.toMatchObject({ worldId: WORLD_ID, players: [] });
    await body.close();
    await body.close();

    const joinRequest = world.requests[0];
    expect(joinRequest).toMatchObject({
      operation: "world.join",
      credential: CREDENTIAL,
      input: { protocolVersion: 1, gameId: "firered", displayName: "Clankie", harness: "clankie" },
    });
    const acts = world.requests.filter((request) => request.operation === "play.act");
    expect(acts).toHaveLength(2);
    expect(acts[0]?.input).toMatchObject({ action: { kind: "enter_text", text: "RED", confirm: false } });
    expect(acts[1]?.input).toMatchObject({
      action: { kind: "select_menu_entry", entry: "POKEMON" },
    });
    expect(world.requests.filter((request) => request.operation === "world.leave")).toHaveLength(1);
    for (const request of world.requests.slice(1)) {
      expect(request.credential).toBeUndefined();
      expect(request.token).toBe(TOKEN);
    }
  });

  it("treats decoded:false as uncertainty while raw buttons remain usable", async () => {
    const undecoded = observation({ frame: 1, decoded: false });
    const world = await fakeWorld((request) => {
      switch (request.operation) {
        case "world.join":
          return joinResult();
        case "play.observe":
          return undecoded;
        case "play.act":
          return actRan({ ...undecoded, frame: 5 });
        case "play.frame":
          return frame({ frame: 5, data: "raw-button-screen" });
        case "world.leave":
          return { ok: true, sessionId: SESSION_ID, endedAt: NOW };
        default:
          throw new Error(`unexpected operation ${request.operation}`);
      }
    });
    const result = await joinWorld({
      environmentId: "pokemon-firered",
      env: await provisionedEnv(world.stateDir),
    });
    expect(result.outcome).toBe("joined");
    if (result.outcome !== "joined") return;

    expect(result.body.io.observe("danger")).toMatchObject({ data: { stateCertain: false } });
    expect(result.body.io.observe("scene")).toMatchObject({ data: { mode: "unknown", inputReady: false } });
    expectAdapterError(() => result.body.io.observe("overworld"), "semantic_state_unavailable");
    await expect(
      result.body.io.act({ kind: "button_press", button: "a", holdFrames: 4 }),
    ).resolves.toMatchObject({ status: "completed" });
    await result.body.close();
  });

  it("polls latest frames at the hardware tick and rejects stale generations", async () => {
    let currentGeneration = 1;
    let currentFrame = 0;
    let frameIndex = 0;
    const frames = [
      frame({ bodyGeneration: 1, frame: 1, data: "generation-1-frame-1" }),
      frame({ bodyGeneration: 1, frame: 3, data: "generation-1-frame-3" }),
      frame({ bodyGeneration: 1, frame: 2, data: "stale-frame" }),
      frame({ bodyGeneration: 2, frame: 1, data: "generation-2-frame-1" }),
      frame({ bodyGeneration: 1, frame: 99, data: "stale-generation" }),
    ];
    const world = await fakeWorld((request) => {
      switch (request.operation) {
        case "world.join":
          return joinResult();
        case "play.observe":
          return observation({ bodyGeneration: currentGeneration, frame: currentFrame });
        case "play.frame": {
          const next = frames[Math.min(frameIndex, frames.length - 1)]!;
          frameIndex += 1;
          if (next.bodyGeneration >= currentGeneration) {
            currentGeneration = next.bodyGeneration;
            currentFrame = next.frame;
          }
          return next;
        }
        case "world.leave":
          return { ok: true, sessionId: SESSION_ID, endedAt: NOW };
        default:
          throw new Error(`unexpected operation ${request.operation}`);
      }
    });
    const result = await joinWorld({
      environmentId: "pokemon-firered",
      env: await provisionedEnv(world.stateDir),
    });
    expect(result.outcome).toBe("joined");
    if (result.outcome !== "joined") return;
    const seen: Uint8Array[] = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("frame polling did not produce three frames")),
        1_000,
      );
      result.body.observeFrames(() => {
        const png = result.body.framePng();
        if (png !== null) seen.push(png);
        if (seen.length === 3) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    await delay(50);
    result.body.observeFrames(null);

    expect(seen.map((bytes) => Buffer.from(bytes).toString())).toEqual([
      "generation-1-frame-1",
      "generation-1-frame-3",
      "generation-2-frame-1",
    ]);
    expect(Buffer.from(result.body.framePng()!).toString()).toBe("generation-2-frame-1");
    expect(result.body.droppedFrameCount()).toBe(1);
    expect(result.body.io.observe("frame_reference")).toMatchObject({
      data: { summary: "Hosted world frame 1 in body generation 2" },
    });
    await result.body.close();
  });

  it("refuses absent credentials and maps an unhosted region honestly", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "clankie-world-empty-"));
    cleanups.push(() => rm(emptyDir, { recursive: true, force: true }));
    await expect(
      joinWorld({
        environmentId: "pokemon-firered",
        env: { WORLD_STATE_DIR: emptyDir, CLANKIE_CREDENTIALS_FILE: join(emptyDir, "missing.json") },
      }),
    ).resolves.toEqual({ outcome: "refused", reason: "no_credential" });

    const world = await fakeWorld((request) => {
      if (request.operation !== "world.join") throw new Error("join refusal should make no later calls");
      return { ok: false, code: "game_unavailable", message: "that game is not hosted here" };
    });
    await expect(
      joinWorld({
        environmentId: "pokemon-firered",
        regionId: "johto",
        env: await provisionedEnv(world.stateDir),
      }),
    ).resolves.toEqual({
      outcome: "refused",
      reason: "region_not_hosted",
      detail: "that game is not hosted here",
    });
    expect(world.requests[0]?.input).toMatchObject({ gameId: "johto" });
  });
});

async function fakeWorld(respond: (request: WireRequest) => unknown | Promise<unknown>): Promise<FakeWorld> {
  const stateDir = await mkdtemp(join(tmpdir(), "clankie-world-body-"));
  const socketPath = join(stateDir, "host.sock");
  const requests: WireRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as WireRequest;
      requests.push(request);
      void Promise.resolve(respond(request)).then(
        (outcome) => socket.end(`${JSON.stringify(outcome)}\n`),
        () => socket.destroy(),
      );
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await listen(server, socketPath);
  const close = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy();
    await closeServer(server);
    await rm(stateDir, { recursive: true, force: true });
  };
  cleanups.push(close);
  return { stateDir, requests, close };
}

async function provisionedEnv(stateDir: string): Promise<NodeJS.ProcessEnv> {
  const credentialFile = join(stateDir, "credentials.json");
  await new FileCredentialStore(credentialFile).set(WORLD_CREDENTIAL_PROVIDER_ID, {
    type: "api",
    key: CREDENTIAL,
  });
  return { WORLD_STATE_DIR: stateDir, CLANKIE_CREDENTIALS_FILE: credentialFile };
}

function memoryStore(): CredentialStore {
  const entries = new Map<string, Awaited<ReturnType<CredentialStore["get"]>>>();
  return {
    get: (id) => Promise.resolve(entries.get(id)),
    set: (id, credential) => {
      entries.set(id, credential);
      return Promise.resolve();
    },
    delete: (id) => Promise.resolve(entries.delete(id)),
    list: () => Promise.resolve({}),
  };
}

function joinResult() {
  return {
    ok: true,
    protocolVersion: 1,
    worldId: WORLD_ID,
    playerId: PLAYER_ID,
    sessionId: SESSION_ID,
    gameId: "firered",
    token: TOKEN,
    capabilities: CAPABILITIES,
    limits: { maxInputsPerAction: 64, maxFramesPerAction: 1_800, stallTimeoutMs: 5_000 },
  };
}

function observation(options: {
  frame: number;
  bodyGeneration?: number;
  x?: number;
  y?: number;
  decoded?: boolean;
}) {
  const decoded = options.decoded ?? true;
  return {
    sessionId: SESSION_ID,
    bodyGeneration: options.bodyGeneration ?? 1,
    gameId: "firered",
    adapterVersion: 1,
    frame: options.frame,
    observedAt: NOW,
    scene: {
      mode: decoded ? "overworld" : "unknown",
      inputReady: decoded,
      waitingForAdvance: false,
      decoded,
    },
    minimap: decoded
      ? {
          topLeft: { mapId: "pallet-town/players-house-2f", x: 12, y: 12 },
          rows: ["...", ".@.", "..."],
          exits: [],
        }
      : null,
    state: decoded
      ? {
          overworld: {
            mapId: "pallet-town/players-house-2f",
            mapGroup: 4,
            mapNum: 1,
            x: options.x ?? 13,
            y: options.y ?? 13,
            facing: "north",
          },
          party: [{ slot: 0, speciesId: 1, level: 5, currentHp: 20, maxHp: 20, moveIds: [33] }],
          fieldInputReady: true,
        }
      : null,
  };
}

function actRan(current: ReturnType<typeof observation>) {
  return {
    ok: true,
    sessionId: SESSION_ID,
    bodyGeneration: current.bodyGeneration,
    frame: current.frame,
    replayed: false,
    outcome: {
      kind: "ran",
      inputsSpent: 1,
      framesSpent: 10,
      screenChanged: true,
      observation: current,
    },
  };
}

function actRejected(refusal: Record<string, unknown>, frameNumber: number) {
  return {
    ok: true,
    sessionId: SESSION_ID,
    bodyGeneration: 1,
    frame: frameNumber,
    replayed: false,
    outcome: { kind: "rejected", refusal },
  };
}

function frame(options: { frame: number; data: string; bodyGeneration?: number }) {
  return {
    sessionId: SESSION_ID,
    bodyGeneration: options.bodyGeneration ?? 1,
    frame: options.frame,
    width: 240,
    height: 160,
    dropped: 0,
    encoding: "png",
    data: Buffer.from(options.data).toString("base64"),
    capturedAt: NOW,
  };
}

function sessionStatus(frameNumber: number) {
  return {
    ok: true,
    worldId: WORLD_ID,
    playerId: PLAYER_ID,
    sessionId: SESSION_ID,
    gameId: "firered",
    displayName: "Clankie",
    state: "playing",
    bodyGeneration: 1,
    frame: frameNumber,
    startedAt: NOW,
  };
}

function whoResult() {
  return { ok: true, worldId: WORLD_ID, players: [] };
}

function expectAdapterError(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(EnvironmentAdapterActionError);
    expect((error as EnvironmentAdapterActionError).errorCode).toBe(code);
    return;
  }
  throw new Error(`expected EnvironmentAdapterActionError ${code}`);
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
