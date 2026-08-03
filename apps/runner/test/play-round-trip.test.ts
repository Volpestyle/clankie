import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  acquireBodyLock,
  FrozenGbaScenarioSchema,
  listGbaCheckpoints,
  parseFreePlayJournal,
  RealGbaRouteScenarioSchema,
  sha256,
  type BootedGbaGame,
  type GbaAdapterScenario,
} from "@clankie/gba-emulator";
import type { FreePlayMind } from "@clankie/gba-emulator";
import type {
  EmbodimentAssignment,
  EmbodimentClaim,
  EmbodimentLifecycleReport,
  EmbodimentSession,
} from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { createGbaPlayExecution } from "../src/play-execution.ts";
import { PlayHost } from "../src/play-host.ts";
import type { ActivityObservationSnapshot } from "@clankie/interactive-environment";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** A mind with no model: press A, forever. The loop, not the play, is under test. */
const buttonMasher = () =>
  Promise.resolve({
    decide: () =>
      Promise.resolve({
        monologue: "pressing on",
        intent: "press a",
        action: { kind: "button_press", button: "a", holdFrames: 2 },
      }),
  });

function fakeClient(assignment: EmbodimentAssignment) {
  const assignments = [assignment];
  const reports: EmbodimentLifecycleReport[] = [];
  return {
    reports,
    claimEmbodiment(_claim: EmbodimentClaim): Promise<EmbodimentAssignment | undefined> {
      return Promise.resolve(assignments.shift());
    },
    reportEmbodiment(report: EmbodimentLifecycleReport): Promise<unknown> {
      reports.push(report);
      return Promise.resolve({});
    },
    getLiveEmbodimentSession(): Promise<EmbodimentSession | undefined> {
      return Promise.resolve(undefined);
    },
  };
}

function session(maxTurns = 2): EmbodimentSession {
  return {
    schemaVersion: 1,
    sessionId: "round-trip-1",
    environmentId: "pokemon-firered",
    state: "claimed",
    intentId: "intent-1",
    originLane: "discord_presence",
    requestedBy: "user-1",
    budget: { maxTurns, maxDurationMs: 60_000 },
    requestedAt: "2026-07-26T12:00:00.000Z",
    updatedAt: "2026-07-26T12:00:01.000Z",
    runnerId: "runner-local",
  };
}

async function playEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "clankie-play-round-trip-"));
  return {
    CLANKIE_GBA_BODY_ROOT: join(root, "body"),
    CLANKIE_GBA_CHECKPOINT_DIR: join(root, "checkpoints"),
    CLANKIE_GBA_PLAY_JOURNAL_DIR: join(root, "gba-play"),
    CLANKIE_ACTIVITY_PRODUCER_URL: "ws://127.0.0.1:1/producer",
  };
}

describe("asked play round trip on the deterministic double", () => {
  it("claims, runs the budgeted turns for real, and reports the receipt", async () => {
    const env = await playEnv();
    const client = fakeClient({ kind: "start", session: session() });
    const activitySnapshots: ActivityObservationSnapshot[] = [];
    const clearedSessions: string[] = [];
    const host = new PlayHost({
      client,
      runnerId: "runner-local",
      environmentIds: ["pokemon-firered"],
      execute: createGbaPlayExecution({
        logger: silentLogger,
        env,
        createMind: buttonMasher,
        activityObservations: {
          publish(snapshot) {
            activitySnapshots.push(snapshot);
            return snapshot;
          },
          clear(sessionId) {
            clearedSessions.push(sessionId);
          },
        },
      }),
      logger: silentLogger,
    });
    expect(await host.poll()).toBe(true);
    await host.settled();
    expect(client.reports.map((report) => report.state)).toEqual(["running", "stopped"]);
    const receipt = client.reports[1]?.receipt;
    expect(receipt).toMatchObject({ outcome: "budget_exhausted", turnsTaken: 2 });

    // The durable trail (ADR 0068): the run left a journal with the header,
    // both turns, and a summary carrying the metrics the receipt cannot.
    const journalDir = env["CLANKIE_GBA_PLAY_JOURNAL_DIR"] as string;
    const journalFiles = readdirSync(journalDir);
    expect(journalFiles).toHaveLength(1);
    const lines = parseFreePlayJournal(readFileSync(join(journalDir, journalFiles[0]!), "utf8"));
    expect(lines.map((line) => line.kind)).toEqual(["header", "turn", "turn", "summary"]);
    expect(lines[0]).toMatchObject({ runId: "round-trip-1" });
    expect(lines[1]).toMatchObject({ turn: { monologue: "pressing on", outcome: "accepted" } });
    expect(lines.at(-1)).toMatchObject({ outcome: "budget_exhausted", turnsTaken: 2 });
    expect(activitySnapshots).toHaveLength(2);
    expect(activitySnapshots.at(-1)).toMatchObject({
      sessionId: "round-trip-1",
      sequence: 1,
      selfAuthored: { commentary: "pressing on", intent: "press a" },
      runnerObserved: { outcome: "accepted" },
    });
    expect(clearedSessions).toEqual(["round-trip-1"]);
  });

  it("mints a checkpoint on stop and resumes from it on the next ask", async () => {
    // The double has no checkpoint capability by design, so the capability is
    // faked around the REAL mint/read gates: writeGbaCheckpoint and
    // readGbaCheckpoint run unchanged, including their identity and digest
    // fail-closed checks. Only the core's saveState/loadState are stand-ins.
    const require = createRequire(import.meta.url);
    const emulatorPackage = dirname(require.resolve("@clankie/gba-emulator/package.json"));
    const repoRoot = resolve(emulatorPackage, "../..");
    const doubleBytes = readFileSync(
      join(repoRoot, "scenarios/emulator/verdant-path-trainer-battle/v1/scenario.json"),
    );
    const doubleScenario = FrozenGbaScenarioSchema.parse(
      JSON.parse(doubleBytes.toString("utf8")),
    ) as GbaAdapterScenario;
    const routeScenario = RealGbaRouteScenarioSchema.parse(
      JSON.parse(
        readFileSync(join(emulatorPackage, "fixtures/firered-bedroom-route/v1/scenario.json"), "utf8"),
      ),
    );
    const savedBytes = new TextEncoder().encode("fake-savestate-run-one");
    const loaded: Uint8Array[] = [];
    const fakeBoot = (): Promise<BootedGbaGame> =>
      Promise.resolve({
        scenario: doubleScenario,
        fixtureSha256: sha256(doubleBytes),
        coreFactory: undefined,
        checkpoints: {
          saveState: () => savedBytes,
          loadState: (bytes: Uint8Array) => {
            loaded.push(bytes);
          },
          bootSavestate: () => new TextEncoder().encode("boot-savestate"),
          identity: {
            romSha256: routeScenario.romSha256,
            savestateSha256: routeScenario.savestateSha256,
            coreWasmSha256: routeScenario.coreWasmSha256,
          },
          scenario: routeScenario,
        },
        framePng: () => null,
        observeFrames: () => undefined,
        framebufferSha256: () => null,
        real: false,
      });
    const env = await playEnv();

    // The first run writes notes and an objective, so the mint has a mind to carry.
    const notingMind = (): Promise<FreePlayMind> =>
      Promise.resolve({
        decide: () =>
          Promise.resolve({
            monologue: "pressing on",
            intent: "press a",
            notes: "the grass is tall here",
            objective: "win the trainer battle",
            action: { kind: "button_press", button: "a", holdFrames: 2 },
          }),
      });
    const first = fakeClient({ kind: "start", session: session() });
    const firstHost = new PlayHost({
      client: first,
      runnerId: "runner-local",
      environmentIds: ["pokemon-firered"],
      execute: createGbaPlayExecution({
        logger: silentLogger,
        env,
        createMind: notingMind,
        boot: fakeBoot,
      }),
      logger: silentLogger,
    });
    await firstHost.poll();
    await firstHost.settled();
    expect(first.reports[0]).toMatchObject({ state: "running" });
    expect(first.reports[0]?.resumedFromCheckpointId).toBeUndefined();
    const mintedId = first.reports[1]?.receipt?.checkpointId;
    expect(mintedId).toBeDefined();

    // The second run records what its first view carries: the previous run's
    // mind must arrive with the world, before he has written anything himself.
    const seenNotes: (string | null)[] = [];
    const seenObjectives: (string | null)[] = [];
    const recallingMind = (): Promise<FreePlayMind> =>
      Promise.resolve({
        decide: (view) => {
          seenNotes.push(view.notes);
          seenObjectives.push(view.objective);
          return Promise.resolve({
            monologue: "pressing on",
            intent: "press a",
            action: { kind: "button_press", button: "a", holdFrames: 2 },
          });
        },
      });
    const second = fakeClient({ kind: "start", session: session() });
    const secondHost = new PlayHost({
      client: second,
      runnerId: "runner-local",
      environmentIds: ["pokemon-firered"],
      execute: createGbaPlayExecution({
        logger: silentLogger,
        env,
        createMind: recallingMind,
        boot: fakeBoot,
      }),
      logger: silentLogger,
    });
    await secondHost.poll();
    await secondHost.settled();
    expect(second.reports[0]).toMatchObject({
      state: "running",
      resumedFromCheckpointId: mintedId,
    });
    expect(second.reports[1]?.receipt).toMatchObject({ resumedFromCheckpointId: mintedId });
    // The exact minted savestate bytes reached the core, digest-verified.
    expect(loaded).toHaveLength(1);
    expect(Buffer.from(loaded[0] as Uint8Array).equals(Buffer.from(savedBytes))).toBe(true);
    // And the mind resumed with the world: seeded from the checkpoint, turn one.
    expect(seenNotes[0]).toBe("the grass is tall here");
    expect(seenObjectives[0]).toBe("win the trainer battle");
  });

  it("banks progress with autosave checkpoints on the configured cadence", async () => {
    // A marathon with no cap only minted at a clean stop, so a crash lost the
    // whole session. Autosaves run through the same real mint gate.
    const require = createRequire(import.meta.url);
    const emulatorPackage = dirname(require.resolve("@clankie/gba-emulator/package.json"));
    const repoRoot = resolve(emulatorPackage, "../..");
    const doubleBytes = readFileSync(
      join(repoRoot, "scenarios/emulator/verdant-path-trainer-battle/v1/scenario.json"),
    );
    const routeScenario = RealGbaRouteScenarioSchema.parse(
      JSON.parse(
        readFileSync(join(emulatorPackage, "fixtures/firered-bedroom-route/v1/scenario.json"), "utf8"),
      ),
    );
    const fakeBoot = (): Promise<BootedGbaGame> =>
      Promise.resolve({
        scenario: FrozenGbaScenarioSchema.parse(
          JSON.parse(doubleBytes.toString("utf8")),
        ) as GbaAdapterScenario,
        fixtureSha256: sha256(doubleBytes),
        coreFactory: undefined,
        checkpoints: {
          saveState: () => new TextEncoder().encode("autosave-bytes"),
          loadState: () => undefined,
          bootSavestate: () => new TextEncoder().encode("boot-savestate"),
          identity: {
            romSha256: routeScenario.romSha256,
            savestateSha256: routeScenario.savestateSha256,
            coreWasmSha256: routeScenario.coreWasmSha256,
          },
          scenario: routeScenario,
        },
        framePng: () => null,
        observeFrames: () => undefined,
        framebufferSha256: () => null,
        real: false,
      });
    const env = await playEnv();
    env["CLANKIE_PLAY_AUTOSAVE_TURNS"] = "2";

    // Checkpoint ids are timestamp-stamped; a wall clock could mint two
    // same-millisecond autosaves whose directories collide. Ticking per call
    // keeps every stamp distinct without racing the real clock.
    let tick = 0;
    const clock = (): Date => new Date(1_753_500_000_000 + (tick += 10));
    const client = fakeClient({ kind: "start", session: session(5) });
    const host = new PlayHost({
      client,
      runnerId: "runner-local",
      environmentIds: ["pokemon-firered"],
      execute: createGbaPlayExecution({
        logger: silentLogger,
        env,
        clock,
        createMind: buttonMasher,
        boot: fakeBoot,
      }),
      logger: silentLogger,
    });
    await host.poll();
    await host.settled();

    // Turns 2 and 4 autosaved; the clean stop minted its own on top.
    const receipts = listGbaCheckpoints(env["CLANKIE_GBA_CHECKPOINT_DIR"] as string);
    expect(receipts.filter((receipt) => receipt.label === "autosave")).toHaveLength(2);
    expect(receipts.filter((receipt) => receipt.label === "asked-play")).toHaveLength(1);
  });

  it("restarts to the boot savestate when he asks, banking the present first", async () => {
    // ADR 0075: the rewind is his choice; the port banks a before-rewind
    // checkpoint through the real mint gate so the choice destroys nothing.
    const require = createRequire(import.meta.url);
    const emulatorPackage = dirname(require.resolve("@clankie/gba-emulator/package.json"));
    const repoRoot = resolve(emulatorPackage, "../..");
    const doubleBytes = readFileSync(
      join(repoRoot, "scenarios/emulator/verdant-path-trainer-battle/v1/scenario.json"),
    );
    const routeScenario = RealGbaRouteScenarioSchema.parse(
      JSON.parse(
        readFileSync(join(emulatorPackage, "fixtures/firered-bedroom-route/v1/scenario.json"), "utf8"),
      ),
    );
    const bootBytes = new TextEncoder().encode("the-pinned-beginning");
    const loaded: Uint8Array[] = [];
    const fakeBoot = (): Promise<BootedGbaGame> =>
      Promise.resolve({
        scenario: FrozenGbaScenarioSchema.parse(
          JSON.parse(doubleBytes.toString("utf8")),
        ) as GbaAdapterScenario,
        fixtureSha256: sha256(doubleBytes),
        coreFactory: undefined,
        checkpoints: {
          saveState: () => new TextEncoder().encode("the-present"),
          loadState: (bytes: Uint8Array) => {
            loaded.push(bytes);
          },
          bootSavestate: () => bootBytes,
          identity: {
            romSha256: routeScenario.romSha256,
            savestateSha256: routeScenario.savestateSha256,
            coreWasmSha256: routeScenario.coreWasmSha256,
          },
          scenario: routeScenario,
        },
        framePng: () => null,
        observeFrames: () => undefined,
        framebufferSha256: () => null,
        real: false,
      });
    const env = await playEnv();
    let tick = 0;
    const clock = (): Date => new Date(1_753_500_000_000 + (tick += 10));

    const restartingMind = (): Promise<FreePlayMind> =>
      Promise.resolve({
        decide: (view) =>
          Promise.resolve(
            view.turn === 0
              ? {
                  monologue: "pressing on",
                  intent: "press a",
                  notes: "about to start over",
                  action: { kind: "button_press", button: "a", holdFrames: 2 },
                }
              : {
                  monologue: "clean run",
                  intent: "restart the game",
                  action: { kind: "restart_game" },
                },
          ),
      });
    const client = fakeClient({ kind: "start", session: session(2) });
    const host = new PlayHost({
      client,
      runnerId: "runner-local",
      environmentIds: ["pokemon-firered"],
      execute: createGbaPlayExecution({
        logger: silentLogger,
        env,
        clock,
        createMind: restartingMind,
        boot: fakeBoot,
      }),
      logger: silentLogger,
    });
    await host.poll();
    await host.settled();

    // The boot savestate reached the core, and only after the bank.
    expect(loaded).toHaveLength(1);
    expect(Buffer.from(loaded[0] as Uint8Array).equals(Buffer.from(bootBytes))).toBe(true);
    const receipts = listGbaCheckpoints(env["CLANKIE_GBA_CHECKPOINT_DIR"] as string);
    const banked = receipts.find((receipt) => receipt.label === "before-rewind");
    expect(banked).toBeDefined();
    // The bank carries what he knew at the moment he chose to rewind.
    expect(banked?.continuity).toEqual({ notes: "about to start over", objective: null });
  });

  it("refuses body_held when another process holds the body lock", async () => {
    const env = await playEnv();
    await mkdir(env["CLANKIE_GBA_BODY_ROOT"] as string, { recursive: true });
    const lock = acquireBodyLock({
      rootDir: env["CLANKIE_GBA_BODY_ROOT"] as string,
      holderId: "claude-code-possession",
    });
    try {
      const client = fakeClient({ kind: "start", session: session() });
      const host = new PlayHost({
        client,
        runnerId: "runner-local",
        environmentIds: ["pokemon-firered"],
        execute: createGbaPlayExecution({ logger: silentLogger, env, createMind: buttonMasher }),
        logger: silentLogger,
      });
      await host.poll();
      await host.settled();
      expect(client.reports).toEqual([
        expect.objectContaining({ state: "refused", refusalReason: "body_held" }),
      ]);
    } finally {
      lock.release();
    }
  });
});
