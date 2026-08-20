import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  DeterministicGbaCoreDouble,
  FrozenGbaScenarioSchema,
  listGbaCheckpoints,
  parseFreePlayJournal,
  RealGbaRouteScenarioSchema,
  sha256,
  writeGbaCheckpoint,
  type BootedGbaGame,
  type GbaAdapterScenario,
} from "@clankie/gba-emulator";
import type { FreePlayMind, GbaCoreSeam } from "@clankie/gba-emulator";
import type { EmbodimentSession } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { createGbaPlayExecution } from "../src/play-execution.ts";
import { PlayHost, type EmbodimentAssignment, type EmbodimentLifecycleUpdate } from "../src/play-host.ts";
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
  const reports: EmbodimentLifecycleUpdate[] = [];
  return {
    reports,
    claimEmbodiment(): Promise<EmbodimentAssignment | undefined> {
      return Promise.resolve(assignments.shift());
    },
    reportEmbodiment(report: EmbodimentLifecycleUpdate): Promise<unknown> {
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
  };
}

async function playEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "clankie-play-round-trip-"));
  return {
    XDG_STATE_HOME: join(root, "state"),
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
    const journalFiles = readdirSync(journalDir).filter((name) => name.endsWith(".jsonl"));
    expect(journalFiles).toHaveLength(1);
    const lines = parseFreePlayJournal(readFileSync(join(journalDir, journalFiles[0]!), "utf8"));
    expect(lines.map((line) => line.kind)).toEqual(["header", "turn", "turn", "summary"]);
    expect(lines[0]).toMatchObject({ runId: "round-trip-1" });
    expect(lines[1]).toMatchObject({
      schemaVersion: 2,
      screenshot: { reasons: expect.arrayContaining(["initial"]), width: 240, height: 160 },
      turn: { monologue: "pressing on", outcome: "accepted" },
      evidence: {
        decision: { provenance: { body: "local", real: expect.any(Boolean) } },
        immediatePreAction: { provenance: { body: "local", real: expect.any(Boolean) } },
        postAction: { provenance: { body: "local", real: expect.any(Boolean) } },
        actionResult: { source: "environment", result: { status: "completed" } },
      },
    });
    expect(JSON.stringify(lines[1])).not.toContain("framePng");
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

  it("neither resumes nor lists another game's checkpoints sharing the root", async () => {
    // FireRed running, an Emerald-style receipt in the same shared root: the
    // load gate refuses the foreign identity, so advertising it in a listing
    // or trying it on resume is a lie the model then acts on.
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
          saveState: () => new TextEncoder().encode("firered-bytes"),
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
    let tick = 0;
    const clock = (): Date => new Date(1_753_500_000_000 + (tick += 10));

    // The first run mints the one compatible checkpoint at its clean stop.
    const first = fakeClient({ kind: "start", session: session(1) });
    const firstHost = new PlayHost({
      client: first,
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
    await firstHost.poll();
    await firstHost.settled();
    const mintedId = first.reports[1]?.receipt?.checkpointId;
    expect(mintedId).toBeDefined();

    // An Emerald-style checkpoint lands in the same root, newer than anything
    // FireRed minted, through the real mint gate.
    writeGbaCheckpoint({
      rootDir: env["CLANKIE_GBA_CHECKPOINT_DIR"] as string,
      capability: {
        saveState: () => new TextEncoder().encode("emerald-bytes"),
        loadState: () => undefined,
        bootSavestate: () => new TextEncoder().encode("emerald-boot"),
        identity: {
          romSha256: "a".repeat(64),
          savestateSha256: "b".repeat(64),
          coreWasmSha256: "c".repeat(64),
        },
        scenario: routeScenario,
      },
      label: "emerald",
      position: null,
      clock: () => new Date(1_753_500_100_000),
    });

    // The second run lists his checkpoints on turn 0 and reads the effect back
    // through its own history on turn 1.
    const histories: string[] = [];
    const listingMind = (): Promise<FreePlayMind> =>
      Promise.resolve({
        decide: (view) => {
          histories.push(...view.history.map((entry) => entry.effect));
          return Promise.resolve({
            monologue: "checking my saves",
            intent: "list checkpoints",
            action:
              view.turn === 0
                ? { kind: "load_checkpoint" }
                : { kind: "button_press", button: "a", holdFrames: 2 },
          });
        },
      });
    const warns: string[] = [];
    const warningLogger = {
      info: () => undefined,
      warn: (_context: Record<string, unknown>, message: string) => {
        warns.push(message);
      },
      error: () => undefined,
    };
    const second = fakeClient({ kind: "start", session: session(2) });
    const secondHost = new PlayHost({
      client: second,
      environmentIds: ["pokemon-firered"],
      execute: createGbaPlayExecution({
        logger: warningLogger,
        env,
        clock,
        createMind: listingMind,
        boot: fakeBoot,
      }),
      logger: silentLogger,
    });
    await secondHost.poll();
    await secondHost.settled();

    // Resume went straight to the compatible checkpoint: the newer foreign one
    // was never advertised, never tried, never warned about as corruption.
    expect(second.reports[0]).toMatchObject({
      state: "running",
      resumedFromCheckpointId: mintedId,
    });
    expect(warns.filter((message) => message.includes("checkpoint skipped"))).toEqual([]);
    // And the listing effect names only his own game's checkpoints.
    const listing = histories.find((effect) => effect.includes("your checkpoints"));
    expect(listing).toBeDefined();
    expect(listing).toContain(mintedId as string);
    expect(listing).not.toContain("emerald");
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

  it("keeps the game running while he thinks, so the watched screen never freezes", async () => {
    // The core advances only when dispatch drives it, which left the activity
    // surface a still image for the whole thinking gap — two thirds of the wall
    // clock on the 2026-08-15 run. What is under test is that idle frames run
    // between turns, and that they never land inside a dispatch.
    const doubleBytes = readFileSync(
      join(
        resolve(
          dirname(createRequire(import.meta.url).resolve("@clankie/gba-emulator/package.json")),
          "../..",
        ),
        "scenarios/emulator/verdant-path-trainer-battle/v1/scenario.json",
      ),
    );
    const doubleScenario = FrozenGbaScenarioSchema.parse(JSON.parse(doubleBytes.toString("utf8")));

    // Only the wiring is under test here: that the local host installs a console
    // clock and ticks it while he thinks. Standing off during an action is the
    // core's own guard, covered against a real core in the emulator package.
    let idled = 0;
    const core = new DeterministicGbaCoreDouble(doubleScenario);
    const countingCore: GbaCoreSeam = {
      coreId: core.coreId,
      pressButton: (button, holdFrames) => core.pressButton(button, holdFrames),
      advanceFrames: (frames) => core.advanceFrames(frames),
      idleFrames: (frames) => {
        idled += frames;
      },
      gameState: () => core.gameState(),
      mapGrid: () => core.mapGrid(),
      ramStateSha256: () => core.ramStateSha256(),
      framebufferSha256: () => core.framebufferSha256(),
    };

    // A mind slow enough to be idled through: ~10 ticks per decision.
    const thinkingMind = (): Promise<FreePlayMind> =>
      Promise.resolve({
        decide: async () => {
          await new Promise((done) => setTimeout(done, 180));
          return {
            monologue: "thinking it over",
            intent: "press a",
            action: { kind: "button_press", button: "a", holdFrames: 2 },
          };
        },
      });

    const client = fakeClient({ kind: "start", session: session() });
    const host = new PlayHost({
      client,
      environmentIds: ["pokemon-firered"],
      execute: createGbaPlayExecution({
        logger: silentLogger,
        env: await playEnv(),
        createMind: thinkingMind,
        boot: () =>
          Promise.resolve({
            scenario: doubleScenario as GbaAdapterScenario,
            fixtureSha256: sha256(doubleBytes),
            coreFactory: () => countingCore,
            checkpoints: undefined,
            framePng: () => null,
            observeFrames: () => undefined,
            framebufferSha256: () => null,
            real: true,
          } satisfies BootedGbaGame),
      }),
      logger: silentLogger,
    });
    expect(await host.poll()).toBe(true);
    await host.settled();

    // Two turns at ~180ms of thinking each, ticked at hardware rate.
    expect(idled).toBeGreaterThan(10);
  });
});
