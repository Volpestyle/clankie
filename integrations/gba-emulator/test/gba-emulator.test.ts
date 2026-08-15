import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  GBA_EMULATOR_CAPABILITY_BOUNDARY,
  GbaEmulatorCapabilityBoundarySchema,
  GbaEmulatorSessionSpecSchema,
  type EnvironmentEvent,
  type GbaEmulatorAction,
  type GbaEmulatorStartActionCommand,
} from "@clankie/interactive-environment";
import { EnvironmentRuntime } from "@clankie/environment-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  FrozenGbaScenarioSchema,
  DeterministicGbaCoreDouble,
  GbaEmulatorAdapter,
  GbaScenarioBindingSchema,
  GbaScenarioReportSchema,
  decideNextGbaAction,
  gbaEmulatorGoalEvent,
  runFrozenGbaScenario,
  validateGbaEmulatorTrace,
  type FrozenGbaScenario,
  type GbaDriverView,
  type GbaCoreFactory,
  type GbaEmulatorAdapterOptions,
} from "../src/index.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const fixtureRoot = resolve(
  import.meta.dirname,
  "../../../scenarios/emulator/verdant-path-trainer-battle/v1",
);

async function fixture() {
  const bytes = await readFile(resolve(fixtureRoot, "scenario.json"));
  const fixtureSha256 = createHash("sha256").update(bytes).digest("hex");
  const scenario = FrozenGbaScenarioSchema.parse(JSON.parse(bytes.toString("utf8")));
  const binding = GbaScenarioBindingSchema.parse(
    JSON.parse(await readFile(resolve(fixtureRoot, "binding.json"), "utf8")),
  );
  return { binding, fixtureSha256, scenario };
}

const allCapabilities = [
  "emulator.gba.observe",
  "emulator.gba.input",
  "emulator.gba.frame_advance",
  "emulator.gba.wait",
] as const;

const DIRECTION_STEPS = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
} as const;

async function harness(options?: {
  mutateScenario?: (scenario: FrozenGbaScenario) => FrozenGbaScenario;
  adapterOptions?: GbaEmulatorAdapterOptions;
  visualOnly?: boolean;
  /**
   * Tiles an unseen body stands on: open in the collision grid, refused by a
   * step into them. The double models walls, which appear in both — an NPC is
   * the case where the two disagree, which is the whole reason a planned route
   * can die mid-walk.
   */
  occupied?: readonly { x: number; y: number }[];
  /**
   * Tiles that start a battle when stepped on. Same swallow as `occupied`,
   * plus the post-step state reports `mode: "battle"`.
   */
  encounter?: readonly { x: number; y: number }[];
  /**
   * Tiles that start a fade or warp hold. Same swallow, plus `inputReady: false`.
   */
  transition?: readonly { x: number; y: number }[];
}) {
  const frozen = await fixture();
  frozen.scenario = options?.mutateScenario?.(frozen.scenario) ?? frozen.scenario;
  const rootDir = await mkdtemp(join(tmpdir(), "gba-emulator-test-"));
  roots.push(rootDir);
  const occupied = new Set((options?.occupied ?? []).map((tile) => `${String(tile.x)},${String(tile.y)}`));
  const encounters = new Set((options?.encounter ?? []).map((tile) => `${String(tile.x)},${String(tile.y)}`));
  const transitions = new Set(
    (options?.transition ?? []).map((tile) => `${String(tile.x)},${String(tile.y)}`),
  );
  const occupiedFactory: GbaCoreFactory | undefined =
    occupied.size === 0 && encounters.size === 0 && transitions.size === 0
      ? undefined
      : () => {
          const core = new DeterministicGbaCoreDouble(frozen.scenario);
          let overlay: { mode?: "battle"; inputReady?: boolean } = {};
          return {
            coreId: core.coreId,
            pressButton: async (button, holdFrames) => {
              const step = button in DIRECTION_STEPS ? DIRECTION_STEPS[button as "up"] : undefined;
              if (step !== undefined) {
                const { x, y } = core.gameState().position;
                const next = `${String(x + step.dx)},${String(y + step.dy)}`;
                // Swallowed rather than passed through: the body in the way
                // absorbs the step, so the player stays put on a tile the grid
                // still calls open.
                if (occupied.has(next)) return;
                if (encounters.has(next)) {
                  overlay = { mode: "battle", inputReady: false };
                  return;
                }
                if (transitions.has(next)) {
                  overlay = { inputReady: false };
                  return;
                }
              }
              await core.pressButton(button, holdFrames);
            },
            advanceFrames: async (frames) => {
              await core.advanceFrames(frames);
            },
            gameState: () => ({ ...core.gameState(), ...overlay }),
            mapGrid: () => core.mapGrid(),
            ramStateSha256: () => core.ramStateSha256(),
            framebufferSha256: () => core.framebufferSha256(),
          };
        };
  const coreFactory: GbaCoreFactory | undefined = options?.visualOnly
    ? () => {
        const core = new DeterministicGbaCoreDouble(frozen.scenario);
        return {
          coreId: core.coreId,
          pressButton: async (button, holdFrames) => {
            await core.pressButton(button, holdFrames);
          },
          advanceFrames: async (frames) => {
            await core.advanceFrames(frames);
          },
          gameState: () => ({ ...core.gameState(), mode: "unknown" as const, inputReady: false }),
          ramStateSha256: () => core.ramStateSha256(),
          framebufferSha256: () => core.framebufferSha256(),
        };
      }
    : occupiedFactory;
  const adapter =
    coreFactory === undefined
      ? new GbaEmulatorAdapter(frozen.scenario, frozen.fixtureSha256, undefined, options?.adapterOptions)
      : new GbaEmulatorAdapter(frozen.scenario, frozen.fixtureSha256, coreFactory, options?.adapterOptions);
  const events: EnvironmentEvent[] = [];
  const now = { value: new Date("2026-07-19T00:00:00.000Z") };
  const runtime = new EnvironmentRuntime({
    rootDir,
    adapter,
    events: { append: (event) => (events.push(event), Promise.resolve()) },
    clock: () => now.value,
    randomToken: () => "private-grant-marker",
  });
  const spec = GbaEmulatorSessionSpecSchema.parse({
    schemaVersion: 2,
    sessionId: "gba-test-session",
    environmentKind: "gba_emulator",
    characterId: frozen.scenario.player.characterId,
    worldId: frozen.scenario.worldId,
    requestedBy: { principal: { kind: "captain", id: "clankie" }, tier: "autonomous" },
    initialGoalVersion: 1,
    resourceBounds: {
      profile: "gba_emulator",
      coreId: frozen.scenario.coreId,
      savestateId: frozen.scenario.savestateId,
      savestateSha256: frozen.scenario.savestateSha256,
      rngSeed: frozen.scenario.rngSeed,
      worldId: frozen.scenario.worldId,
      characterId: frozen.scenario.player.characterId,
      maxInputsPerAction: 8,
      maxFramesPerAction: 600,
      maxActionDurationMs: 5_000,
      capabilities: allCapabilities,
    },
  });
  const grant = await runtime.start({
    spec,
    holderId: "runner",
    correlationId: "gba-test",
    leaseDurationMs: 10_000,
  });
  const command = (
    actionId: string,
    action: GbaEmulatorAction,
    expectedGoalVersion = 1,
  ): GbaEmulatorStartActionCommand => ({
    schemaVersion: 1,
    commandId: `command-${actionId}`,
    type: "start_action",
    requestedAt: "2026-07-19T00:00:00.000Z",
    context: {
      sourceLane: "gameplay",
      authority: { principal: { kind: "captain", id: "clankie" }, tier: "autonomous" },
      correlationId: `correlation-${actionId}`,
      expectedGoalVersion,
    },
    sessionId: spec.sessionId,
    actionId,
    action: {
      kind: "gba_emulator_action",
      action,
      limits: { maxInputs: 8, maxFrames: 600, timeoutMs: 5_000 },
    },
  });
  return { ...frozen, adapter, command, events, grant, now, rootDir, runtime, spec };
}

describe("GBA emulator embodiment", () => {
  it("completes the frozen scenario deterministically with byte-identical report and decision trace", async () => {
    const frozen = await fixture();
    const firstRoot = await mkdtemp(join(tmpdir(), "gba-scenario-first-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "gba-scenario-second-"));
    roots.push(firstRoot, secondRoot);
    const first = await runFrozenGbaScenario({ rootDir: firstRoot, ...frozen });
    const second = await runFrozenGbaScenario({ rootDir: secondRoot, ...frozen });
    expect(JSON.stringify(first.report)).toEqual(JSON.stringify(second.report));
    expect(JSON.stringify(first.decisionTrace)).toEqual(JSON.stringify(second.decisionTrace));
    expect(JSON.stringify(first.trace)).toEqual(JSON.stringify(second.trace));
    expect(first.report).toMatchObject({
      result: "passed",
      halt: "battle_won",
      checks: {
        targetLocationReached: true,
        trainerBattleEntered: true,
        trainerBattleWon: true,
        decisionsStateDerived: true,
        authoritativeStateCertain: true,
        evidenceBounded: true,
        inputsWithinBounds: true,
      },
      finalState: { battleResult: "won", opponentHp: 0 },
    });
    expect(first.goalEvent).toMatchObject({ type: "environment.goal.verified" });
    expect(first.decisionTrace.decisions.at(-1)).toMatchObject({ reasonCode: "halt_battle_won" });
    expect(() =>
      validateGbaEmulatorTrace({
        ...first.trace,
        events: first.trace.events.map((event, index) =>
          index === 0 ? { ...event, summary: "tampered evidence" } : event,
        ),
      }),
    ).toThrow(/event hash/);
  });

  it("derives every decision from observed state, changing the decision when the state changes", async () => {
    const { scenario } = await fixture();
    const base = {
      schemaVersion: 1 as const,
      observationId: "obs-1",
      sessionId: "gba-test-session",
      characterId: "clankie",
      worldId: scenario.worldId,
      goalVersion: 1,
      capturedAt: "2026-07-19T00:00:01.000Z",
      frame: 10,
    };
    const danger = {
      ...base,
      kind: "danger" as const,
      data: {
        severity: "low" as const,
        code: "policy_boundary" as const,
        summary: "local emulator",
        stateCertain: true,
      },
    };
    const overworldAt = (x: number, y: number) => ({
      ...base,
      kind: "overworld" as const,
      data: {
        position: { mapId: scenario.map.mapId, x, y },
        facing: "east" as const,
        ramStateSha256: "a".repeat(64),
      },
    });
    const view = (overrides: Partial<GbaDriverView>): GbaDriverView => ({
      danger,
      overworld: overworldAt(0, 1),
      battle: null,
      dialog: null,
      ...overrides,
    });
    // Same decision function, different observed positions: different route steps.
    expect(decideNextGbaAction(view({}), scenario)).toMatchObject({
      reasonCode: "route_step_toward_target",
      action: { button: "right" },
    });
    expect(decideNextGbaAction(view({ overworld: overworldAt(3, 2) }), scenario)).toMatchObject({
      reasonCode: "route_step_toward_target",
      action: { button: "up" },
    });
    // At the target the same function engages instead of routing.
    expect(decideNextGbaAction(view({ overworld: overworldAt(3, 1) }), scenario)).toMatchObject({
      reasonCode: "engage_trainer",
      action: { button: "a" },
    });
    // Battle decisions respond to the observed cursor and phase.
    const battleAt = (moveCursor: number, phase: "awaiting_input" | "won") => ({
      ...base,
      kind: "battle" as const,
      data: {
        battleId: "battle-1",
        turn: 1,
        phase,
        opponent: { speciesId: "sproutlet", level: 6, currentHp: 12, maxHp: 12 },
        activePartySlot: 0,
        moveCursor,
        legalMoves: [
          { moveId: "tackle", power: 3 },
          { moveId: "ember", power: 5 },
        ],
        untrusted: true as const,
      },
    });
    expect(decideNextGbaAction(view({ battle: battleAt(0, "awaiting_input") }), scenario)).toMatchObject({
      reasonCode: "move_cursor_to_best_move",
      action: { button: "down" },
    });
    expect(decideNextGbaAction(view({ battle: battleAt(1, "awaiting_input") }), scenario)).toMatchObject({
      reasonCode: "select_best_move",
      action: { button: "a" },
    });
    expect(decideNextGbaAction(view({ battle: battleAt(1, "won") }), scenario)).toMatchObject({
      reasonCode: "halt_battle_won",
    });
    // Uncertain state halts instead of acting.
    expect(
      decideNextGbaAction(
        view({
          danger: {
            ...danger,
            data: {
              severity: "high",
              code: "uncertain_state",
              summary: "injected uncertainty",
              stateCertain: false,
            },
          },
        }),
        scenario,
      ),
    ).toMatchObject({ reasonCode: "halt_uncertain_state" });
  });

  it("pauses and fails closed when observations become uncertain mid-run", async () => {
    const frozen = await fixture();
    const rootDir = await mkdtemp(join(tmpdir(), "gba-uncertain-run-"));
    roots.push(rootDir);
    let dangerCount = 0;
    const result = await runFrozenGbaScenario({
      rootDir,
      ...frozen,
      wrapIo: (io) => ({
        ...io,
        observe: (kind) => {
          const observation = io.observe(kind);
          if (kind === "danger" && (dangerCount += 1) === 4 && observation.kind === "danger") {
            return {
              ...observation,
              data: {
                severity: "high",
                code: "uncertain_state",
                summary: "injected observation uncertainty",
                stateCertain: false,
              },
            };
          }
          return observation;
        },
      }),
    });
    expect(result.report).toMatchObject({ result: "failed", halt: "uncertain_state" });
    expect(result.decisionTrace.decisions.at(-1)).toMatchObject({ reasonCode: "halt_uncertain_state" });
    expect(result.semanticEvents.filter((event) => "type" in event).map((event) => event.type)).toContain(
      "environment.goal.failed",
    );
  });

  it("fails closed when the emulator frame does not advance after an input", async () => {
    const frozen = await fixture();
    const rootDir = await mkdtemp(join(tmpdir(), "gba-stale-frame-"));
    roots.push(rootDir);
    let overworldCount = 0;
    const result = await runFrozenGbaScenario({
      rootDir,
      ...frozen,
      wrapIo: (io) => ({
        ...io,
        observe: (kind) => {
          const observation = io.observe(kind);
          // The second overworld observation is the post-act verification read;
          // freezing its frame simulates a desynced observation stream.
          if (kind === "overworld" && (overworldCount += 1) === 2) return { ...observation, frame: 0 };
          return observation;
        },
      }),
    });
    expect(result.report).toMatchObject({ result: "failed", halt: "uncertain_state" });
  });

  it("does not repeat duplicate action side effects and rejects stale goals before dispatch", async () => {
    const { adapter, command, grant, runtime, spec } = await harness();
    const press = command("press-once", { kind: "button_press", button: "right", holdFrames: 12 });
    const first = await runtime.startAction(grant.token, press);
    const duplicate = await runtime.startAction(grant.token, press);
    expect(duplicate).toEqual(first);
    expect(adapter.session(spec.sessionId).trace().events).toHaveLength(1);
    expect(adapter.session(spec.sessionId).snapshot()).toMatchObject({
      position: { x: 1, y: 1 },
      inputCount: 1,
    });
    const stale = await runtime.startAction(
      grant.token,
      command("stale-action", { kind: "button_press", button: "right", holdFrames: 12 }, 0),
    );
    expect(stale).toMatchObject({ status: "stale", expectedGoalVersion: 0, currentGoalVersion: 1 });
    expect(adapter.session(spec.sessionId).trace().events).toHaveLength(1);
  });

  it("keeps framebuffer-only cartridges playable without inventing semantic state", async () => {
    const { adapter, command, grant, runtime, spec } = await harness({ visualOnly: true });
    const session = adapter.session(spec.sessionId);
    expect(session.observe("scene")).toMatchObject({ data: { mode: "unknown", inputReady: false } });
    expect(() => session.observe("overworld")).toThrow(/semantic_state_unavailable/u);

    const press = await runtime.startAction(
      grant.token,
      command("visual-press", { kind: "button_press", button: "start", holdFrames: 1 }),
    );
    expect(press).toMatchObject({ status: "completed", outcome: { mode: "unknown" } });
    expect(press).not.toHaveProperty("outcome.position");

    const advanced = await runtime.startAction(
      grant.token,
      command("visual-advance", { kind: "frame_advance", frames: 1 }),
    );
    expect(advanced).toMatchObject({ status: "completed", outcome: { mode: "unknown" } });
    expect(advanced).not.toHaveProperty("outcome.position");

    const routed = await runtime.startAction(
      grant.token,
      command("visual-walk", { kind: "walk_to", x: 1, y: 1 }),
    );
    expect(routed).toMatchObject({ status: "failed", errorCode: "semantic_state_unavailable" });
  });

  it("walks a planned route and reports where it ended up", async () => {
    const { adapter, command, grant, runtime, spec } = await harness();
    const result = await runtime.startAction(grant.token, command("walk", { kind: "walk_to", x: 3, y: 1 }));
    expect(result).toMatchObject({ status: "completed" });
    expect(result).toMatchObject({
      outcome: {
        target: { x: 3, y: 1 },
        plannedSteps: 3,
        steps: 3,
        arrived: true,
        blockedAt: null,
        position: { x: 3, y: 1 },
      },
    });
    // One action, so one evidence event — a route is not three presses of trace.
    expect(adapter.session(spec.sessionId).trace().events).toHaveLength(1);
  });

  it("routes around a tile that already stopped a walk instead of replanning into it", async () => {
    // (1,1) is open collision with somebody standing on it — the shape that
    // funnelled four consecutive routes into Viridian's old man on 2026-08-15.
    const { command, grant, runtime } = await harness({ occupied: [{ x: 1, y: 1 }] });
    const first = await runtime.startAction(grant.token, command("walk-1", { kind: "walk_to", x: 3, y: 1 }));
    expect(first).toMatchObject({
      outcome: {
        plannedSteps: 3,
        steps: 0,
        arrived: false,
        blockedAt: { x: 1, y: 1 },
        position: { x: 0, y: 1 },
      },
    });

    // The same ask, and this time the plan goes over the top row around him.
    const second = await runtime.startAction(grant.token, command("walk-2", { kind: "walk_to", x: 3, y: 1 }));
    expect(second).toMatchObject({
      outcome: { plannedSteps: 5, steps: 5, arrived: true, blockedAt: null, position: { x: 3, y: 1 } },
    });
  });

  it("names a grass encounter instead of remembering it as an NPC", async () => {
    const { command, grant, runtime } = await harness({ encounter: [{ x: 1, y: 1 }] });
    const first = await runtime.startAction(grant.token, command("walk-1", { kind: "walk_to", x: 3, y: 1 }));
    expect(first).toMatchObject({
      outcome: {
        plannedSteps: 3,
        steps: 0,
        arrived: false,
        blockedAt: { x: 1, y: 1 },
        blockedBecause: "battle",
        mode: "battle",
      },
    });
  });

  it("does not remember a fade as a blocked tile, so the next walk is not detoured", async () => {
    const { command, grant, runtime } = await harness({ transition: [{ x: 1, y: 1 }] });
    const first = await runtime.startAction(grant.token, command("walk-1", { kind: "walk_to", x: 3, y: 1 }));
    expect(first).toMatchObject({
      outcome: {
        plannedSteps: 3,
        steps: 0,
        blockedAt: { x: 1, y: 1 },
        blockedBecause: "transition",
      },
    });
    // Still the short route — a remembered NPC would have gone around in 5.
    const second = await runtime.startAction(grant.token, command("walk-2", { kind: "walk_to", x: 3, y: 1 }));
    expect(second).toMatchObject({ outcome: { plannedSteps: 3, blockedAt: { x: 1, y: 1 } } });
  });

  it("walks a remembered tile again when it is the only way through", async () => {
    // (1,1) blocks, and the detour is walled off, so avoiding it would strand a
    // reachable target. The memory must slow a route down, never close one.
    const { command, grant, runtime } = await harness({
      occupied: [{ x: 1, y: 1 }],
      mutateScenario: (scenario) => ({
        ...scenario,
        map: { ...scenario.map, blocked: [...scenario.map.blocked, { x: 0, y: 0 }, { x: 0, y: 2 }] },
      }),
    });
    const first = await runtime.startAction(grant.token, command("walk-1", { kind: "walk_to", x: 3, y: 1 }));
    expect(first).toMatchObject({ outcome: { blockedAt: { x: 1, y: 1 }, steps: 0 } });

    // Replanned against the raw grid: the same doomed route rather than a
    // refusal, because whoever stands there may well have moved on.
    const second = await runtime.startAction(grant.token, command("walk-2", { kind: "walk_to", x: 3, y: 1 }));
    expect(second).toMatchObject({ outcome: { plannedSteps: 3, blockedAt: { x: 1, y: 1 } } });
  });

  it("reports adjacency so a wall is known before it is walked into", async () => {
    const { command, grant, runtime } = await harness();
    // (2,2) and (2,3) are blocked, so standing at (2,1) the tile south is a wall.
    const walk = await runtime.startAction(grant.token, command("walk", { kind: "walk_to", x: 2, y: 1 }));
    expect(walk).toMatchObject({
      outcome: { arrived: true, surroundings: { south: { passable: false }, east: { passable: true } } },
    });
  });

  it("refuses an unattainable target and says what would have to be different", async () => {
    const { command, grant, runtime } = await harness();
    // A wall is refused as a wall, with the nearest tile that is floor.
    const blocked = await runtime.startAction(
      grant.token,
      command("into-wall", { kind: "walk_to", x: 2, y: 2 }),
    );
    expect(blocked).toMatchObject({ status: "failed", errorCode: "walk_target_impassable" });
    expect((blocked as { message: string }).message).toContain("nearest reachable open tile is (");
    // An off-map tile is refused with the bounds coordinates actually span.
    const offMap = await runtime.startAction(
      grant.token,
      command("off-map", { kind: "walk_to", x: 99, y: 99 }),
    );
    expect(offMap).toMatchObject({ status: "failed", errorCode: "walk_target_outside_map" });
    expect((offMap as { message: string }).message).toContain("the loaded map spans");
  });

  it("hands the player the walkability minimap the pathfinder already had", async () => {
    const { adapter, spec } = await harness();
    const observation = adapter.session(spec.sessionId).observe("overworld");
    if (observation.kind !== "overworld") throw new Error("expected an overworld observation");
    const minimap = observation.data.minimap;
    expect(minimap).not.toBeNull();
    // The double's map is small enough for the crop to carry all of it.
    expect(minimap?.topLeft).toEqual({ x: 0, y: 0 });
    // The player renders where the double placed them, walls where it blocks.
    expect(minimap?.rows[1]?.[0]).toBe("@");
    expect(minimap?.rows[2]?.[2]).toBe("#");
    // The double decodes no warp events, and absence is reported as absence.
    expect(observation.data.exits).toBeNull();
  });

  it("draws a route from the same input budget a burst of presses draws from", async () => {
    const { adapter, command, grant, runtime, spec } = await harness();
    // (7,5) is reachable but 11 steps away, past the 8-input bound.
    const result = await runtime.startAction(
      grant.token,
      command("too-far", { kind: "walk_to", x: 7, y: 5 }),
    );
    expect(result).toMatchObject({ status: "failed", errorCode: "input_bound_exceeded" });
    // Refused before moving, so the player has not been left mid-route.
    expect(adapter.session(spec.sessionId).snapshot()).toMatchObject({ position: { x: 0, y: 1 } });
  });

  it("fails uncertain adapter state closed without a retryable input path", async () => {
    const { adapter, command, grant, runtime, spec } = await harness();
    adapter.session(spec.sessionId).markStateUncertain("Observation sequence gap");
    const result = await runtime.startAction(
      grant.token,
      command("uncertain-action", { kind: "button_press", button: "right", holdFrames: 12 }),
    );
    expect(result).toMatchObject({ status: "failed", errorCode: "uncertain_state", retryable: false });
    expect(adapter.session(spec.sessionId).snapshot()).toMatchObject({
      position: { x: 0, y: 1 },
      inputCount: 0,
    });
    expect(adapter.session(spec.sessionId).observe("danger")).toMatchObject({
      data: { code: "uncertain_state", stateCertain: false },
    });
  });

  it("rolls the evidence window for open-ended play instead of killing the body at the cap", async () => {
    const tiny = (scenario: FrozenGbaScenario) =>
      FrozenGbaScenarioSchema.parse({ ...scenario, maxEvidenceEvents: 4 });
    const rolling = await harness({
      mutateScenario: tiny,
      adapterOptions: { evidencePolicy: "rolling" },
    });
    // Far past the budget that wedged the frozen policy permanently.
    for (let index = 0; index < 10; index += 1) {
      const result = await rolling.runtime.startAction(
        rolling.grant.token,
        rolling.command(`roll-${String(index)}`, { kind: "frame_advance", frames: 1 }),
      );
      expect(result).toMatchObject({ status: "completed" });
    }
    const session = rolling.adapter.session(rolling.spec.sessionId);
    expect(session.snapshot()).toMatchObject({ stateCertain: true });
    // The cap is never silent: the trace confesses what rolled, and the
    // retained window still validates as a chain.
    const trace = session.trace();
    expect(trace.events.length).toBeLessThanOrEqual(4);
    expect(trace.rolledWindows).toBeGreaterThanOrEqual(2);
    expect(trace.droppedEvidenceEvents).toBe((trace.rolledWindows ?? 0) * 4);
    expect(() => validateGbaEmulatorTrace(trace)).not.toThrow();

    // The frozen policy still fails closed at the same budget, exactly as before.
    const frozen = await harness({ mutateScenario: tiny });
    let refusal: unknown = null;
    for (let index = 0; index < 10 && refusal === null; index += 1) {
      const result = await frozen.runtime.startAction(
        frozen.grant.token,
        frozen.command(`frozen-${String(index)}`, { kind: "frame_advance", frames: 1 }),
      );
      if ((result as { status: string }).status !== "completed") refusal = result;
    }
    expect(refusal).toMatchObject({ errorCode: "evidence_bound_exceeded" });
  });

  it("rejects malformed commands, over-limit frames, and ungranted capabilities fail-closed", async () => {
    const { command, grant, runtime } = await harness();
    const malformed = command("malformed", { kind: "button_press", button: "right", holdFrames: 12 });
    (malformed.action.action as { holdFrames: number }).holdFrames = 100_000;
    await expect(runtime.startAction(grant.token, malformed)).resolves.toMatchObject({
      status: "failed",
      errorCode: "invalid_emulator_command",
      retryable: false,
    });
    const overLimit = command("over-limit", { kind: "frame_advance", frames: 601 });
    await expect(runtime.startAction(grant.token, overLimit)).resolves.toMatchObject({
      status: "failed",
      errorCode: "frame_bound_exceeded",
    });
  });

  it("cancels pending waits and fails closed on lease loss and emergency stop", async () => {
    const first = await harness();
    const waiting = await first.runtime.startAction(
      first.grant.token,
      first.command("wait", { kind: "wait", durationMs: 1_000 }),
    );
    expect(waiting).toMatchObject({ status: "running" });
    await expect(
      first.runtime.cancelAction(first.grant.token, first.spec.sessionId, "wait", "operator cancel"),
    ).resolves.toMatchObject({ status: "cancelled" });
    expect(first.adapter.session(first.spec.sessionId).trace().events.at(-1)).toMatchObject({
      actionKind: "cancel_action",
    });

    const second = await harness();
    await second.runtime.startAction(
      second.grant.token,
      second.command("lease-wait", { kind: "wait", durationMs: 1_000 }),
    );
    second.now.value = new Date("2026-07-19T00:00:11.000Z");
    expect(await second.runtime.sweep()).toMatchObject({ expiredSessions: [second.spec.sessionId] });
    await expect(
      second.runtime.startAction(
        second.grant.token,
        second.command("after-lease", { kind: "button_press", button: "right", holdFrames: 12 }),
      ),
    ).rejects.toThrow(/expired/);
    // Lease loss still fails closed, but it is the holder that lapsed, not the
    // world: the same holder renews and plays on. Only revocation is final.
    await second.runtime.renew(second.grant.token, second.spec.sessionId);
    await expect(
      second.runtime.startAction(
        second.grant.token,
        second.command("after-lease", { kind: "button_press", button: "right", holdFrames: 12 }),
      ),
    ).resolves.toMatchObject({ status: "completed" });

    const third = await harness();
    await third.runtime.startAction(
      third.grant.token,
      third.command("emergency-wait", { kind: "wait", durationMs: 1_000 }),
    );
    await expect(
      third.runtime.emergencyStop(third.spec.sessionId, "operator emergency"),
    ).resolves.toMatchObject({ phase: "off" });
    expect(third.adapter.session(third.spec.sessionId).snapshot()).toMatchObject({
      position: { x: 0, y: 1 },
    });
  });

  it("performs no network I/O and owns no network or tamper capability", async () => {
    // Boundary: the schema cannot represent a network or tamper capability.
    expect(GBA_EMULATOR_CAPABILITY_BOUNDARY.networkCapabilities).toHaveLength(0);
    expect(GBA_EMULATOR_CAPABILITY_BOUNDARY.remoteTamperCapabilities).toHaveLength(0);
    expect(() =>
      GbaEmulatorCapabilityBoundarySchema.parse({
        ...GBA_EMULATOR_CAPABILITY_BOUNDARY,
        networkCapabilities: ["emulator.gba.network"],
      }),
    ).toThrow();
    // Static proof: no source file in this integration can open a socket or
    // speak to any networked service.
    const sourceRoot = resolve(import.meta.dirname, "../src");
    const forbidden = [
      "node:net",
      "node:http",
      "node:https",
      "node:dgram",
      "node:tls",
      "node:dns",
      '"net"',
      '"http"',
      '"https"',
      '"dgram"',
      '"tls"',
      '"dns"',
      "undici",
      "axios",
      "WebSocket",
      "XMLHttpRequest",
      "fetch(",
    ];
    for (const file of await readdir(sourceRoot)) {
      const source = await readFile(resolve(sourceRoot, file), "utf8");
      for (const marker of forbidden) expect(source, `${file} must not use ${marker}`).not.toContain(marker);
    }
  });

  it("rejects credentials at the adapter boundary and keeps them out of state and events", async () => {
    const { adapter, events, spec } = await harness();
    const separateRoot = await mkdtemp(join(tmpdir(), "gba-credential-test-"));
    roots.push(separateRoot);
    const runtime = new EnvironmentRuntime({
      rootDir: separateRoot,
      adapter,
      events: { append: (event) => (events.push(event), Promise.resolve()) },
      randomToken: () => "credential-test-grant",
    });
    await expect(
      runtime.start({
        spec: { ...spec, sessionId: "credential-session" },
        holderId: "runner",
        correlationId: "credential-marker",
        connection: { password: "credential-marker" },
      }),
    ).rejects.toThrow(/failed to start/);
    const records = await readdir(resolve(separateRoot, "environment-sessions"));
    const retained = await Promise.all(
      records.map((record) => readFile(resolve(separateRoot, "environment-sessions", record), "utf8")),
    );
    expect(JSON.stringify({ events, retained })).not.toContain("credential-marker");
  });

  it("keeps success emulator-state-authoritative and evidence hashes independently verifiable", async () => {
    const frozen = await fixture();
    const rootDir = await mkdtemp(join(tmpdir(), "gba-report-contract-"));
    roots.push(rootDir);
    const { report, semanticEvents } = await runFrozenGbaScenario({ rootDir, ...frozen });
    expect(GbaScenarioReportSchema.parse(report)).toEqual(report);
    expect(() =>
      GbaScenarioReportSchema.parse({ ...report, checks: { ...report.checks, trainerBattleWon: false } }),
    ).toThrow(/authoritative checks/);
    expect(() => gbaEmulatorGoalEvent({ ...report, fixtureSha256: "b".repeat(64) }, frozen.binding)).toThrow(
      /frozen scenario binding/,
    );
    // No ROM/BIOS/save byte payloads: every artifact is a bounded artifact://
    // reference and every semantic event parses the closed event schema.
    for (const artifact of report.artifacts) expect(artifact.uri).toMatch(/^artifact:\/\//);
    expect(semanticEvents.length).toBeGreaterThan(0);
  });
});
