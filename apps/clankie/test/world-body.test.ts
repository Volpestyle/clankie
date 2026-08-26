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
import { WORLD_PROTOCOL_VERSION } from "@pokeagents/world-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { joinWorld } from "../src/world/body.ts";
import { HostedWorldSession } from "../src/world/session.ts";

const CREDENTIAL = "clankie-world-test-credential-0000000000000001";
const TOKEN = "session-token-0000000000000000000000000001";
const SESSION_ID = "session-clankie";
const PLAYER_ID = "player-clankie";
const WORLD_ID = "pallet";
const NOW = "2026-08-16T00:00:00.000Z";
const CAPABILITIES = ["world.observe", "world.act", "world.frames"];

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

  it("carries the people standing on the map", async () => {
    // An NPC blocks a tile exactly like a bookshelf does, so a mind reading
    // only passability finds people by pressing A at every wall. A live run
    // spent twenty-four turns doing that in Oak's lab.
    const world = await staticWorld(
      observation({ frame: 10, npcs: [{ localId: 4, graphicsId: 38, x: 11, y: 8, facing: "south" }] }),
    );
    const result = await joinWorld({
      environmentId: "pokemon-firered",
      env: await provisionedEnv(world.stateDir),
    });
    expect(result.outcome).toBe("joined");
    if (result.outcome !== "joined") return;
    expect(result.body.io.observe("overworld")).toMatchObject({
      data: { occupants: [{ localId: 4, graphicsId: 38, x: 11, y: 8, facing: "south" }] },
    });
    // No dialog on screen is still a refusal, never an empty transcript.
    expectAdapterError(() => result.body.io.observe("dialog"), "dialog_not_open");
  });

  it("carries the words in the dialog box", async () => {
    const world = await staticWorld(
      observation({
        frame: 10,
        mode: "dialog",
        dialogLines: ["It's like an encyclopedia, but the", "pages are blank."],
      }),
    );
    const result = await joinWorld({
      environmentId: "pokemon-firered",
      env: await provisionedEnv(world.stateDir),
    });
    expect(result.outcome).toBe("joined");
    if (result.outcome !== "joined") return;
    expect(result.body.io.observe("dialog")).toMatchObject({
      data: { lines: ["It's like an encyclopedia, but the", "pages are blank."], untrusted: true },
    });
  });

  it("carries map size and edge connections", async () => {
    const world = await staticWorld(
      observation({
        frame: 10,
        mapSize: { width: 24, height: 20 },
        connections: [{ direction: "north", destination: "route-1" }],
      }),
    );
    const result = await joinWorld({
      environmentId: "pokemon-firered",
      env: await provisionedEnv(world.stateDir),
    });
    expect(result.outcome).toBe("joined");
    if (result.outcome !== "joined") return;
    expect(result.body.io.observe("overworld")).toMatchObject({
      data: {
        mapSize: { width: 24, height: 20 },
        exits: {
          connections: [{ direction: "north", destination: "route-1" }],
        },
      },
    });
    await result.body.close();
  });

  it("reports nothing rather than emptiness when the world publishes neither", async () => {
    // A world too old to publish either field. Silence is the honest answer:
    // an empty `lines` reads as "he read it and it said nothing", and an empty
    // occupants list reads as "nobody here" about a screen never read.
    const stale = observation({ frame: 10, mode: "dialog" });
    const state = stale.state as Record<string, unknown>;
    delete state["dialogLines"];
    delete state["npcs"];
    const world = await staticWorld(stale);
    const result = await joinWorld({
      environmentId: "pokemon-firered",
      env: await provisionedEnv(world.stateDir),
    });
    expect(result.outcome).toBe("joined");
    if (result.outcome !== "joined") return;
    expectAdapterError(() => result.body.io.observe("dialog"), "semantic_state_unavailable");
    const overworld = result.body.io.observe("overworld") as {
      data: { mapSize: unknown; exits: { connections: unknown }; occupants?: unknown };
    };
    expect("occupants" in overworld.data).toBe(false);
    expect(overworld.data.mapSize).toBeNull();
    expect(overworld.data.exits.connections).toEqual([]);
  });

  it("joins by credential, maps every available view, drives actions, and leaves once", async () => {
    let current = observation({ frame: 10, x: 13, y: 13 });
    const audioUnavailable: string[] = [];
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
        case "world.leave":
          return { ok: true, sessionId: SESSION_ID, endedAt: NOW };
        default:
          throw new Error(`unexpected operation ${request.operation}`);
      }
    });
    const env = await provisionedEnv(world.stateDir);
    const result = await joinWorld({
      environmentId: "pokemon-firered",
      env,
      onAudioUnavailable: (reason) => audioUnavailable.push(reason),
    });
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
    expect(audioUnavailable).toEqual(["not_supported"]);
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
    await body.close();
    await body.close();

    const joinRequest = world.requests[0];
    expect(joinRequest).toMatchObject({
      operation: "world.join",
      credential: CREDENTIAL,
      input: {
        protocolVersion: WORLD_PROTOCOL_VERSION,
        gameId: "firered",
        displayName: "Clankie",
        harness: "clankie",
      },
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

  it("exposes FireRed's rival presets and reports Gary as one verified action", async () => {
    let current = observation({
      frame: 30,
      mode: "menu",
      menu: {
        menuId: "intro-rival-name-menu",
        cursor: 0,
        entries: [
          { id: "new-name", label: "New name" },
          { id: "green", label: "Green" },
          { id: "gary", label: "Gary" },
          { id: "kaz", label: "Kaz" },
          { id: "toru", label: "Toru" },
        ],
      },
    });
    const world = await fakeWorld((request) => {
      switch (request.operation) {
        case "world.join":
          return joinResult();
        case "play.observe":
          return current;
        case "play.act": {
          expect(request.input).toMatchObject({ action: { kind: "select_menu_entry", entry: "gary" } });
          current = observation({
            frame: 40,
            mode: "menu",
            menu: {
              menuId: "intro-name-confirmation",
              cursor: 0,
              entries: [
                { id: "yes", label: "Yes" },
                { id: "no", label: "No" },
              ],
            },
          });
          return actRan(current, {
            kind: "select_menu_entry",
            menuId: "intro-rival-name-menu",
            entryId: "gary",
            label: "Gary",
            confirmed: true,
            presses: 3,
            endedBecause: "selected",
          });
        }
        case "play.frame":
          return frame({ frame: current.frame, data: "gary-confirmation" });
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

    const menu = result.body.io.observe("menu");
    expect(menu).toMatchObject({ data: { menuId: "intro-rival-name-menu", cursor: 0 } });
    if (menu.kind !== "menu") throw new Error("expected menu observation");
    expect(menu.data.entries.map((entry) => entry.id)).toEqual(["new-name", "green", "gary", "kaz", "toru"]);
    await expect(result.body.io.act({ kind: "select_menu_entry", entryId: "gary" })).resolves.toMatchObject({
      status: "completed",
      outcome: {
        menuId: "intro-rival-name-menu",
        entryId: "gary",
        label: "Gary",
        confirmed: true,
        presses: 3,
        endedBecause: "selected",
      },
    });
    await result.body.close();
  });

  it("does not invent a successful menu selection when a ran result omits detail", async () => {
    const current = observation({
      frame: 30,
      mode: "menu",
      menu: { menuId: "test-menu", cursor: 0, entries: [{ id: "one", label: "One" }] },
    });
    const world = await fakeWorld((request) => {
      switch (request.operation) {
        case "world.join":
          return joinResult();
        case "play.observe":
          return current;
        case "play.act":
          return actRan(current);
        case "play.frame":
          return frame({ frame: current.frame, data: "menu-still-open" });
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
    if (result.outcome !== "joined") throw new Error("expected world join");

    const action = await result.body.io.act({ kind: "select_menu_entry", entryId: "one" });
    if (action.status !== "completed") throw new Error("expected completed action");
    expect(action.outcome).not.toHaveProperty("confirmed");
    expect(action.outcome).not.toHaveProperty("endedBecause");
    await result.body.close();
  });

  it("returns a stable unsupported-exit refusal without redispatch until capability changes", async () => {
    let current = observation({
      frame: 10,
      exits: [
        {
          at: { mapId: "pallet-town/players-house-1f", x: 12, y: 15 },
          to: "pallet-town",
          walkTo: "unsupported",
        },
      ],
    });
    const world = await fakeWorld((request) => {
      switch (request.operation) {
        case "world.join":
          return joinResult();
        case "play.observe":
          return current;
        case "play.act": {
          const action = (request.input as { action: { kind: string } }).action;
          if (action.kind === "walk_to" && current.minimap?.exits[0]?.walkTo === "unsupported") {
            return actRejected(
              {
                reason: "walk_exit_unsupported",
                at: { mapId: "pallet-town/players-house-1f", x: 12, y: 15 },
                to: "pallet-town",
              },
              current.frame,
            );
          }
          current = observation({
            frame: current.frame + 10,
            exits: [
              {
                at: { mapId: "pallet-town/players-house-1f", x: 12, y: 15 },
                to: "pallet-town",
                walkTo: "supported",
              },
            ],
          });
          return actRan(current);
        }
        case "play.frame":
          return frame({ frame: current.frame, data: "capability-changed" });
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
    if (result.outcome !== "joined") throw new Error("expected world join");

    const target = { kind: "walk_to" as const, x: 12, y: 15 };
    await expect(result.body.io.act(target)).resolves.toMatchObject({
      status: "failed",
      errorCode: "walk_exit_unsupported",
    });
    await expect(result.body.io.act(target)).resolves.toMatchObject({
      status: "failed",
      errorCode: "walk_exit_unsupported",
    });
    expect(world.requests.filter((request) => request.operation === "play.act")).toHaveLength(1);

    await expect(
      result.body.io.act({ kind: "button_press", button: "a", holdFrames: 4 }),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(result.body.io.act(target)).resolves.toMatchObject({ status: "completed" });
    expect(world.requests.filter((request) => request.operation === "play.act")).toHaveLength(3);
    await result.body.close();
  });

  it("does not cache a rejection returned by a newer body generation", async () => {
    const current = observation({
      frame: 10,
      exits: [
        {
          at: { mapId: "pallet-town/players-house-1f", x: 12, y: 15 },
          to: "pallet-town",
          walkTo: "unsupported",
        },
      ],
    });
    const world = await fakeWorld((request) => {
      switch (request.operation) {
        case "world.join":
          return joinResult();
        case "play.observe":
          return current;
        case "play.act":
          return actRejected(
            {
              reason: "walk_exit_unsupported",
              at: { mapId: "pallet-town/players-house-1f", x: 12, y: 15 },
              to: "pallet-town",
            },
            current.frame,
            2,
          );
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
    if (result.outcome !== "joined") throw new Error("expected world join");

    const target = { kind: "walk_to" as const, x: 12, y: 15 };
    await result.body.io.act(target);
    await result.body.io.act(target);
    expect(world.requests.filter((request) => request.operation === "play.act")).toHaveLength(2);
    await result.body.close();
  });

  it("carries a hosted walk refusal's nearest open tile to the player", async () => {
    const current = observation({ frame: 10 });
    const world = await fakeWorld((request) => {
      switch (request.operation) {
        case "world.join":
          return joinResult();
        case "play.observe":
          return current;
        case "play.act":
          return actRejected(
            {
              reason: "walk_target_impassable",
              nearestOpen: { mapId: "route-1", x: 17, y: 16 },
            },
            current.frame,
          );
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
    if (result.outcome !== "joined") throw new Error("expected world join");

    await expect(result.body.io.act({ kind: "walk_to", x: 16, y: 16 })).resolves.toMatchObject({
      status: "failed",
      errorCode: "walk_target_impassable",
      message: expect.stringContaining("nearest open tile is (17,16) on route-1"),
    });
    await result.body.close();
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

  it("does not reuse action keys when the world replays an existing join", async () => {
    const current = observation({ frame: 10 });
    const world = await fakeWorld((request) => {
      switch (request.operation) {
        case "world.join":
          return joinResult();
        case "play.observe":
          return current;
        case "play.act":
          return actRan(current);
        case "play.frame":
          return frame({ frame: current.frame, data: "rejoined" });
        case "world.leave":
          return { ok: true, sessionId: SESSION_ID, endedAt: NOW };
        default:
          throw new Error(`unexpected operation ${request.operation}`);
      }
    });
    const env = await provisionedEnv(world.stateDir);
    const first = await joinWorld({ environmentId: "pokemon-firered", env });
    const second = await joinWorld({ environmentId: "pokemon-firered", env });
    if (first.outcome !== "joined" || second.outcome !== "joined") {
      throw new Error("expected both world joins to succeed");
    }

    await first.body.io.act({ kind: "button_press", button: "a", holdFrames: 4 });
    await second.body.io.act({ kind: "button_press", button: "right", holdFrames: 4 });

    const keys = world.requests
      .filter((request) => request.operation === "play.act")
      .map((request) => (request.input as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    await first.body.close();
    await second.body.close();
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

  it("starts hosted audio at live time and drains bounded PCM for the activity", async () => {
    let currentFrame = 10;
    const world = await fakeWorld(
      (request) => {
        switch (request.operation) {
          case "world.join":
            return joinResult();
          case "play.observe":
            return observation({ frame: currentFrame });
          case "play.frame":
            currentFrame += 1;
            return frame({ frame: currentFrame, data: `frame-${String(currentFrame)}` });
          case "world.leave":
            return { ok: true, sessionId: SESSION_ID, endedAt: NOW };
          default:
            throw new Error(`unexpected operation ${request.operation}`);
        }
      },
      () => ({
        ok: true,
        visibility: "unlisted",
        url: `https://watch.example/watch#wtk.${"A".repeat(43)}`,
      }),
    );
    const fetches: Array<{ url: URL; authorization: string | null }> = [];
    const audioUnavailable: string[] = [];
    const pcm = Buffer.alloc(16, 7);
    const fetchImpl = (async (input, init) => {
      const url = new URL(String(input));
      const authorization = new Headers(init?.headers).get("authorization");
      fetches.push({ url, authorization });
      const after = url.searchParams.get("after");
      return Response.json(
        after === "10"
          ? {
              ok: true,
              bodyGeneration: 1,
              cursor: 11,
              dropped: 2,
              packets: [
                {
                  bodyGeneration: 1,
                  frame: 11,
                  encoding: "pcm_s16le",
                  sampleRate: 65_536,
                  channels: 2,
                  frames: 4,
                  byteLength: pcm.byteLength,
                  data: pcm.toString("base64"),
                  capturedAt: NOW,
                },
              ],
            }
          : { ok: true, bodyGeneration: 1, cursor: after === null ? 10 : 11, dropped: 0, packets: [] },
      );
    }) as typeof fetch;
    const result = await joinWorld({
      environmentId: "pokemon-firered",
      env: await provisionedEnv(world.stateDir),
      fetchImpl,
      onAudioUnavailable: (reason) => audioUnavailable.push(reason),
    });
    if (result.outcome !== "joined") throw new Error("expected the world join to succeed");

    const packets = await new Promise<ReturnType<typeof result.body.drainAudio>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("audio polling did not produce PCM")), 1_000);
      result.body.observeFrames(() => {
        const drained = result.body.drainAudio();
        if (drained.length === 0) return;
        clearTimeout(timeout);
        resolve(drained);
      });
    });
    result.body.observeFrames(null);

    expect(packets).toHaveLength(1);
    expect(packets[0]).toMatchObject({ frame: 11, sampleRate: 65_536, channels: 2, frames: 4 });
    expect(packets[0]?.data).toEqual(Uint8Array.from(pcm));
    expect(result.body.droppedAudioPacketCount()).toBe(2);
    expect(fetches[0]?.url.search).toBe("");
    expect(fetches.some(({ url }) => url.searchParams.get("after") === "10")).toBe(true);
    expect(fetches.every(({ authorization }) => authorization?.startsWith("Watch wtk.") === true)).toBe(true);
    expect(audioUnavailable).toEqual([]);
    await result.body.close();
  });

  it("refuses absent credentials, and an unhosted game honestly", async () => {
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
        env: await provisionedEnv(world.stateDir),
      }),
    ).resolves.toEqual({
      outcome: "refused",
      reason: "region_not_hosted",
      detail: "that game is not hosted here",
    });
    // The environment names the game, and nothing else may. `world.join` has no
    // region parameter at all — regions are reached afterwards through
    // `world.travel`, gated on badges.
    expect(world.requests[0]?.input).toMatchObject({ gameId: "firered" });
  });

  it("maps WorldPlayerConfigError onto existing join refusals", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "clankie-world-config-"));
    cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
    const env = await provisionedEnv(stateDir);
    await expect(
      joinWorld({
        environmentId: "pokemon-firered",
        env: { ...env, WORLD_ADDRESS: "ws://world.example:443" },
      }),
    ).resolves.toEqual({
      outcome: "refused",
      reason: "world_unreachable",
      detail: "WORLD_ADDRESS must use tcp://, tls://, or a Unix socket path.",
    });
    await expect(
      joinWorld({
        environmentId: "pokemon-firered",
        env,
        transport: () => Promise.reject(new Error("ECONNREFUSED")),
      }),
    ).resolves.toEqual({
      outcome: "refused",
      reason: "world_unreachable",
      detail: "The configured world is unreachable.",
    });
  });

  it("dials unix, tcp, and tls addresses through WorldPlayerClient", async () => {
    const targets: string[] = [];
    const transport = async (address: { kind: string }, request: { operation: string }) => {
      targets.push(`${address.kind}:${request.operation}`);
      if (request.operation === "world.join") return joinResult();
      if (request.operation === "play.observe") return observation({ frame: 1 });
      if (request.operation === "play.watch") {
        return { ok: false, code: "not_supported", message: "watching is disabled" };
      }
      if (request.operation === "world.leave") return { ok: true, sessionId: SESSION_ID, endedAt: NOW };
      throw new Error(`unexpected ${request.operation}`);
    };
    const env = await provisionedEnv(await mkdtemp(join(tmpdir(), "clankie-world-address-")));
    for (const [WORLD_ADDRESS, kind] of [
      [undefined, "unix"],
      ["tcp://100.64.0.1:7777", "tcp"],
      ["tls://world.example:443", "tls"],
    ] as const) {
      targets.length = 0;
      const result = await joinWorld({
        environmentId: "pokemon-firered",
        env: WORLD_ADDRESS === undefined ? env : { ...env, WORLD_ADDRESS },
        transport,
      });
      expect(result.outcome).toBe("joined");
      if (result.outcome !== "joined") return;
      expect(targets[0]).toBe(`${kind}:world.join`);
      await result.body.close();
    }
  });

  it("exposes granted session and presence operations and preserves a world refusal", async () => {
    const world = await fakeWorld((request) => {
      switch (request.operation) {
        case "world.join":
          return { ...joinResult(), capabilities: [...CAPABILITIES, "world.presence"] };
        case "play.observe":
          return observation({ frame: 10 });
        case "world.session":
          return {
            ok: true,
            worldId: WORLD_ID,
            playerId: PLAYER_ID,
            sessionId: SESSION_ID,
            gameId: "firered",
            displayName: "Clankie",
            state: "playing",
            bodyGeneration: 1,
            frame: 10,
            startedAt: NOW,
          };
        case "world.who":
          return { ok: false, code: "budget_exhausted", message: "who is rate limited" };
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
    expect(result.body.grantedOperationNames()).toEqual(
      expect.arrayContaining(["play.observe", "play.act", "play.frame", "world.who", "world.session"]),
    );
    expect(result.body.sessionSnapshot()).toMatchObject({
      worldId: WORLD_ID,
      playerId: PLAYER_ID,
      sessionId: SESSION_ID,
      gameId: "firered",
    });
    await expect(result.body.callWorld("world.session", {})).resolves.toMatchObject({
      ok: true,
      playerId: PLAYER_ID,
      state: "playing",
    });
    await expect(result.body.callWorld("world.who", {})).resolves.toMatchObject({
      ok: false,
      code: "budget_exhausted",
      message: "who is rate limited",
    });
    const gate = new HostedWorldSession();
    expect(gate.inspect()).toEqual({ outcome: "not_playing" });
    gate.attach(result.body);
    expect(gate.inspect()).toMatchObject({
      outcome: "playing",
      grantedOperations: expect.arrayContaining(["world.who", "world.session"]),
    });
    await expect(gate.invoke("world.who", {})).resolves.toMatchObject({
      outcome: "ok",
      result: { ok: false, code: "budget_exhausted" },
    });
    await expect(gate.invoke("world.travel", { destination: "emerald" })).resolves.toMatchObject({
      outcome: "refused",
      reason: "capability_unavailable",
    });
    gate.detach(result.body);
    expect(gate.inspect()).toEqual({ outcome: "not_playing" });
    await result.body.close();
  });
});

async function fakeWorld(
  respond: (request: WireRequest) => unknown | Promise<unknown>,
  watch?: (request: WireRequest) => unknown | Promise<unknown>,
): Promise<FakeWorld> {
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
      const outcome =
        request.operation === "play.watch"
          ? (watch?.(request) ?? { ok: false, code: "not_supported", message: "watching is disabled" })
          : respond(request);
      void Promise.resolve(outcome).then(
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
    // Read from the constant, not a literal: the pinned contract decides what a
    // real world answers with, and a fake that disagrees fails the join rather
    // than the thing under test.
    protocolVersion: WORLD_PROTOCOL_VERSION,
    worldId: WORLD_ID,
    playerId: PLAYER_ID,
    sessionId: SESSION_ID,
    gameId: "firered",
    token: TOKEN,
    capabilities: CAPABILITIES,
    limits: { maxInputsPerAction: 64, maxFramesPerAction: 1_800, stallTimeoutMs: 5_000 },
  };
}

describe("a decoded screen with no semantic state", () => {
  it("names the screen and does not report it as danger", async () => {
    // VUH-980. The world decodes FireRed's intro perfectly and says so; it just
    // has no position or party to report. Calling that `unknown` at high
    // severity told a mind the game was broken for the minutes the intro runs.
    const world = await fakeWorld((request) => {
      switch (request.operation) {
        case "world.join":
          return joinResult();
        case "play.observe":
          return {
            ...observation({ frame: 371, decoded: false }),
            scene: { mode: "cutscene", inputReady: false, waitingForAdvance: false, decoded: true },
          };
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

    const scene = result.body.io.observe("scene");
    expect(scene.kind === "scene" && scene.data.mode).toBe("cutscene");

    const danger = result.body.io.observe("danger");
    if (danger.kind !== "danger") throw new Error("expected a danger observation");
    expect(danger.data.severity).toBe("low");
    expect(danger.data.code).not.toBe("uncertain_state");
    // Still not certain: there genuinely is no position or party to read.
    expect(danger.data.stateCertain).toBe(false);

    await result.body.close();
  });

  // The boxes `advance_dialog` reads are gone from the observation by the time
  // it is taken, so while the world's account of the read was dropped here,
  // every dialog advance on a hosted world reported "read no new text — the
  // dialog stopped" however much it had actually read. He tried the helper
  // twice on 2026-08-16, believed it broken, and went back to pressing A.
  it("keeps what a composite action read, so the effect line can say it", async () => {
    let current = observation({ frame: 30, x: 5, y: 7 });
    const world = await fakeWorld((request) => {
      switch (request.operation) {
        case "world.join":
          return joinResult();
        case "play.observe":
          return current;
        case "play.act":
          current = observation({ frame: 40, x: 5, y: 7 });
          return actRan(current, {
            kind: "advance_dialog",
            transcript: ["Welcome to the world of POKéMON!"],
            presses: 3,
            endedBecause: "dialog_closed",
          });
        case "play.frame":
          return frame({ frame: current.frame, data: "after-dialog" });
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
    const acted = await result.body.io.act({ kind: "advance_dialog" });
    // Flat alongside the transport counters, named as the local adapter names
    // them, so the existing effect describers read it without a translation.
    expect(acted).toMatchObject({
      status: "completed",
      outcome: { transcript: ["Welcome to the world of POKéMON!"], endedBecause: "dialog_closed" },
    });
    await result.body.close();
  });

  it("names a screen it could not interpret without raising an alarm", async () => {
    const world = await fakeWorld((request) => {
      switch (request.operation) {
        case "world.join":
          return joinResult();
        case "play.observe":
          return observation({ frame: 12, decoded: false });
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
    const danger = result.body.io.observe("danger");
    if (danger.kind !== "danger") throw new Error("expected a danger observation");
    // `stateCertain` is the load-bearing field — a scripted driver halts on it
    // — but the severity is not an alarm. A boot sequence decodes to nothing
    // for minutes, and reporting that as high severity every turn is how a mind
    // learns to distrust the signal entirely. It did, on 2026-08-16.
    expect(danger.data.code).toBe("uncertain_state");
    expect(danger.data.stateCertain).toBe(false);
    expect(danger.data.severity).toBe("low");
    await result.body.close();
  });
});

function observation(options: {
  frame: number;
  bodyGeneration?: number;
  x?: number;
  y?: number;
  decoded?: boolean;
  mode?: "overworld" | "menu" | "dialog";
  npcs?: { localId: number; graphicsId: number; x: number; y: number; facing: string | null }[];
  dialogLines?: string[];
  menu?: {
    menuId: string;
    cursor: number;
    entries: { id: string; label: string }[];
  };
  exits?: Array<{
    at: { mapId: string; x: number; y: number };
    to: string;
    walkTo: "supported" | "unsupported";
  }>;
  mapSize?: { width: number; height: number } | null;
  connections?: { direction: "north" | "south" | "west" | "east"; destination: string }[] | null;
}) {
  const decoded = options.decoded ?? true;
  const mode = options.mode ?? "overworld";
  // A dialog box is drawn over a loaded map, so the world reports position and
  // party alongside it — the same shape a live run journals.
  const onMap = mode === "overworld" || mode === "dialog";
  return {
    sessionId: SESSION_ID,
    bodyGeneration: options.bodyGeneration ?? 1,
    gameId: "firered",
    adapterVersion: 2,
    frame: options.frame,
    observedAt: NOW,
    scene: {
      mode: decoded ? mode : "unknown",
      inputReady: decoded && mode === "overworld",
      waitingForAdvance: false,
      decoded,
    },
    minimap:
      decoded && onMap
        ? {
            topLeft: { mapId: "pallet-town/players-house-2f", x: 12, y: 12 },
            rows: ["...", ".@.", "..."],
            exits: options.exits ?? [],
          }
        : null,
    state: decoded
      ? {
          overworld: onMap
            ? {
                mapId: "pallet-town/players-house-2f",
                mapGroup: 4,
                mapNum: 1,
                x: options.x ?? 13,
                y: options.y ?? 13,
                facing: "north" as const,
              }
            : null,
          party: onMap ? [{ slot: 0, speciesId: 1, level: 5, currentHp: 20, maxHp: 20, moveIds: [33] }] : [],
          fieldInputReady: mode === "overworld",
          npcs: options.npcs ?? [],
          dialogLines: options.dialogLines ?? [],
          menu: options.menu ?? null,
          ...(options.mapSize === undefined ? {} : { mapSize: options.mapSize }),
          ...(options.connections === undefined ? {} : { connections: options.connections }),
        }
      : null,
  };
}

function actRan(current: ReturnType<typeof observation>, detail?: Record<string, unknown>) {
  return {
    ok: true,
    sessionId: SESSION_ID,
    bodyGeneration: current.bodyGeneration,
    frame: current.frame,
    replayed: false,
    outcome: {
      kind: "ran",
      inputsSpent: typeof detail?.["presses"] === "number" ? detail["presses"] : 1,
      framesSpent: 10,
      screenChanged: true,
      observation: current,
      ...(detail === undefined ? {} : { detail }),
    },
  };
}

function actRejected(refusal: Record<string, unknown>, frameNumber: number, bodyGeneration = 1) {
  return {
    ok: true,
    sessionId: SESSION_ID,
    bodyGeneration,
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

/** A world that answers every poll with one fixed observation. */
async function staticWorld(current: ReturnType<typeof observation>): Promise<FakeWorld> {
  return fakeWorld((request) => {
    switch (request.operation) {
      case "world.join":
        return joinResult();
      case "play.observe":
        return current;
      case "play.frame":
        return frame({ frame: current.frame, data: "still" });
      case "world.leave":
        return { ok: true, sessionId: SESSION_ID, endedAt: NOW };
      default:
        throw new Error(`unexpected operation ${request.operation}`);
    }
  });
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
