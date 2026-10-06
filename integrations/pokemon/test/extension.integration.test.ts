import { createServer, type Socket } from "node:net";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore, WORLD_CREDENTIAL_PROVIDER_ID } from "@clankie/credential-broker";
import { GameExtensionBusyError, type GameRunControl } from "@clankie/game-extension";
import { parseFreePlayJournal, type FreePlayMind } from "@clankie/play";
import type { EmbodimentSession } from "@clankie/protocol";
import { WORLD_PROTOCOL_VERSION } from "@pokeagents/world-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { pokemonExtension } from "../src/index.ts";
import observationFixture from "./fixtures/firered-observation.json" with { type: "json" };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});
const logger = { info: () => {}, warn: () => {} };
const request = (): EmbodimentSession => ({
  schemaVersion: 1,
  sessionId: "extension-run",
  environmentId: "pokemon-firered",
  state: "claimed",
  intentId: "fixture-intent",
  originLane: "operator",
  requestedBy: "fixture-owner",
  budget: { maxTurns: 4, maxTokens: 30 },
  requestedAt: observationFixture.observedAt,
  updatedAt: observationFixture.observedAt,
});
const decision = {
  monologue: "Pressing on",
  intent: "press a",
  action: { kind: "button_press" as const, button: "a" as const, holdFrames: 2 },
};
function meteredMind(before?: () => Promise<void>): FreePlayMind {
  return {
    metered: true,
    decide: async (_view, _signal, report) => {
      await before?.();
      report?.({
        calls: 1,
        inputTokens: 10,
        outputTokens: 5,
        chargedTokens: 15,
        estimatedCostUsd: 0.01,
        unreportedCalls: 0,
      });
      return decision;
    },
  };
}
function controls() {
  let guards = 0,
    confirmed = 0;
  const control: GameRunControl = {
    stopRequested: () => false,
    guard: async () => {
      guards++;
    },
    confirmStopped: () => {
      confirmed++;
    },
  };
  return { control, guards: () => guards, confirmed: () => confirmed };
}

describe("Pokémon through the game-extension contract and native IPC", () => {
  it("uses the shipped settings schema, enforces Moss's budget and proves exact departure", async () => {
    const world = await fixtureWorld();
    let calls = 0;
    const notable: string[] = [];
    const runtime = pokemonExtension.create({
      env: world.env,
      logger,
      gameplay: pokemonExtension.settings.schema.parse({ pokeagentMmoEnabled: true }),
      resolveMind: async () => ({
        mind: meteredMind(async () => {
          calls++;
        }),
        voiceAgent: undefined,
      }),
      onNotable: async (event) => {
        notable.push(event.kind);
      },
    });
    const host = controls();
    expect(runtime.status()).toEqual({ state: "idle" });
    expect(runtime.health()).toEqual({ state: "ready" });
    expect(world.requests).toHaveLength(0); // health/status never open the connector
    let running = 0;
    const result = await runtime.start(request(), host.control, async () => {
      running++;
    });
    expect(result).toMatchObject({ kind: "ran", result: { outcome: "budget_exhausted" } });
    expect(calls).toBe(2);
    expect(running).toBe(1);
    expect(host.guards()).toBeGreaterThanOrEqual(4); // start, join, running, final action
    expect(host.confirmed()).toBe(1);
    expect(world.requests.filter((r) => r.operation === "play.act")).toHaveLength(1);
    expect(world.requests.filter((r) => r.operation === "world.leave")).toHaveLength(1);
    expect(runtime.status()).toEqual({ state: "idle" });
    expect(notable).toContain("budget_exhausted");
    const [file] = (await readdir(join(world.root, "journal"))).filter((name) => name.endsWith(".jsonl"));
    const journal = parseFreePlayJournal(await readFile(join(world.root, "journal", file!), "utf8"));
    expect(journal.find((entry) => entry.kind === "summary")?.usage?.chargedTokens).toBe(30);
  });

  it("stops only the exact active run and refuses a concurrent start without another join", async () => {
    const world = await fixtureWorld();
    const entered = deferred();
    const release = deferred();
    const runtime = pokemonExtension.create({
      env: world.env,
      logger,
      resolveMind: async () => ({
        mind: meteredMind(async () => {
          entered.resolve();
          await release.promise;
        }),
        voiceAgent: undefined,
      }),
    });
    const host = controls();
    const done = runtime.start(request(), host.control, async () => {});
    await entered.promise;
    expect(runtime.status()).toEqual({ state: "running", sessionId: "extension-run" });
    expect(runtime.stop("older-session")).toBe("not_active");
    await expect(
      runtime.start({ ...request(), sessionId: "second" }, host.control, async () => {}),
    ).rejects.toBeInstanceOf(GameExtensionBusyError);
    expect(runtime.stop("extension-run")).toBe("requested");
    expect(runtime.status()).toEqual({ state: "stopping", sessionId: "extension-run" });
    expect(host.confirmed()).toBe(0);
    release.resolve();
    expect(await done).toMatchObject({ kind: "ran", result: { outcome: "stopped" } });
    expect(world.requests.filter((r) => r.operation === "world.join")).toHaveLength(1);
    expect(world.requests.filter((r) => r.operation === "play.act")).toHaveLength(0);
    expect(host.confirmed()).toBe(1);
    expect(runtime.stop("extension-run")).toBe("not_active");
  });

  it("retains uncertainty and blocks reuse when the world denies departure", async () => {
    const world = await fixtureWorld(true);
    const runtime = pokemonExtension.create({
      env: world.env,
      logger,
      resolveMind: async () => ({ mind: meteredMind(), voiceAgent: undefined }),
    });
    const host = controls();
    await expect(runtime.start(request(), host.control, async () => {})).rejects.toThrow("internal");
    expect(host.confirmed()).toBe(0);
    expect(runtime.status()).toEqual({ state: "uncertain", sessionId: "extension-run" });
    expect(runtime.health()).toEqual({ state: "degraded", reason: "termination_unconfirmed" });
    expect(runtime.stop("extension-run")).toBe("uncertain");
    await expect(
      runtime.start({ ...request(), sessionId: "retry" }, host.control, async () => {}),
    ).rejects.toBeInstanceOf(GameExtensionBusyError);
    expect(world.requests.filter((r) => r.operation === "world.join")).toHaveLength(1);
  });

  it("checks host authority before connector access and confirms a disabled venue without joining", async () => {
    const world = await fixtureWorld();
    const runtime = pokemonExtension.create({
      env: world.env,
      logger,
      gameplay: pokemonExtension.settings.schema.parse({ pokeagentMmoEnabled: false }),
      resolveMind: async () => {
        throw new Error("disabled venue resolved a model");
      },
    });
    const host = controls();
    await expect(
      runtime.start(
        request(),
        {
          ...host.control,
          guard: async () => {
            throw new Error("revoked");
          },
        },
        async () => {},
      ),
    ).rejects.toThrow("revoked");
    expect(runtime.status()).toEqual({ state: "idle" });
    expect(host.confirmed()).toBe(0);
    expect(await runtime.start(request(), host.control, async () => {})).toEqual({
      kind: "refused",
      reason: "environment_unavailable",
    });
    expect(host.confirmed()).toBe(1);
    expect(world.requests).toHaveLength(0);
  });
});

/** Offline wire fixture from the established world-body FireRed specimen, not a live world. */
async function fixtureWorld(denyLeave = false) {
  const root = await mkdtemp(join(tmpdir(), "clankie-extension-"));
  const credentialFile = join(root, "credentials.json");
  await new FileCredentialStore(credentialFile).set(WORLD_CREDENTIAL_PROVIDER_ID, {
    type: "api",
    key: "fixture-world-credential-0000000000000000001",
  });
  const requests: Array<{ operation: string }> = [];
  const sockets = new Set<Socket>();
  let frame = 10;
  const observation = () => ({ ...observationFixture, frame });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const input = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as { operation: string };
      requests.push(input);
      let response: unknown;
      switch (input.operation) {
        case "world.join":
          response = {
            ok: true,
            protocolVersion: WORLD_PROTOCOL_VERSION,
            worldId: "pallet",
            playerId: "fixture-player",
            sessionId: observationFixture.sessionId,
            gameId: "firered",
            token: "fixture-session-token-0000000000000000001",
            capabilities: ["world.observe", "world.act", "world.frames"],
            limits: { maxInputsPerAction: 64, maxFramesPerAction: 1800, stallTimeoutMs: 5000 },
          };
          break;
        case "play.observe":
          response = observation();
          break;
        case "play.act":
          frame += 10;
          response = {
            ok: true,
            sessionId: observationFixture.sessionId,
            bodyGeneration: 1,
            frame,
            replayed: false,
            outcome: {
              kind: "ran",
              inputsSpent: 1,
              framesSpent: 10,
              screenChanged: true,
              observation: observation(),
            },
          };
          break;
        case "world.leave":
          response = denyLeave
            ? { ok: false, code: "internal", message: "fixture denied departure" }
            : { ok: true, sessionId: observationFixture.sessionId, endedAt: observationFixture.observedAt };
          break;
        default:
          response = { ok: false, code: "not_supported", message: "fixture has no media" };
      }
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  const socketPath = join(root, "host.sock");
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    requests,
    env: {
      WORLD_ADDRESS: socketPath,
      CLANKIE_CREDENTIALS_FILE: credentialFile,
      CLANKIE_GBA_PLAY_JOURNAL_DIR: join(root, "journal"),
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
