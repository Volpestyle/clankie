import {
  GbaEmulatorObservationSchema,
  GbaEmulatorSessionSpecSchema,
  GbaEmulatorStartActionCommandSchema,
  type EnvironmentSessionSpecV2,
  type GbaButton,
  type GbaEmulatorAction,
  type GbaEmulatorActionLimits,
  type GbaEmulatorObservation,
  type GbaEmulatorObservationKind,
  type GbaEmulatorResourceBounds,
  type GbaEmulatorSessionSpec,
} from "@clankie/interactive-environment";
import {
  EnvironmentAdapterActionError,
  type EnvironmentAdapter,
  type EnvironmentAdapterActionCompletion,
  type EnvironmentAdapterSession,
  type EnvironmentStartActionCommand,
} from "@clankie/environment-runtime";
import {
  GbaEmulatorEvidenceEventSchema,
  GbaEmulatorTraceSchema,
  type FrozenGbaScenario,
  type GbaEmulatorEvidenceEvent,
  type GbaEmulatorTrace,
} from "./contracts.ts";
import { DeterministicGbaCoreDouble, canonicalJson, sha256 } from "./core-double.ts";
import type { GbaCoreState } from "./core-double.ts";
import type { GbaAdapterScenario, GbaCoreFactory, GbaCoreMapGrid, GbaCoreSeam } from "./core-seam.ts";
import { BUTTON_COLUMN, OK_ROW, findNamingKey, stepTowardNamingKey } from "./naming-keyboard.ts";

const GENESIS_HASH = "0".repeat(64);

export interface GbaEmulatorSnapshot {
  position: { mapId: string; x: number; y: number };
  battleId: string | null;
  battleResult: "not_started" | "active" | "won" | "lost";
  turn: number;
  activePartySlot: number;
  activePartyHp: number;
  opponentHp: number;
  frame: number;
  inputCount: number;
  inputReady: boolean;
  stateCertain: boolean;
  ramStateSha256: string;
}

/**
 * Governed emulator adapter. It owns no action loop: `EnvironmentRuntime`
 * dispatches every action into `startAction`, and this adapter's only job is
 * to validate the strict emulator contract, enforce leases' resource bounds,
 * drive the pinned deterministic core, and record hash-chained evidence.
 * The core behind the boundary is whatever `GbaCoreSeam` the factory yields:
 * the deterministic CI test double by default, or the real headless mGBA
 * core for ROM-gated runs (ADR 0039 / ADR 0040). The seam is the only thing
 * that swaps; the governed surface does not change.
 */
/**
 * How the session behaves when the bounded evidence window fills.
 *
 * `frozen` (default) is the receipt model: a run that exceeds its evidence
 * budget is invalid evidence, so the state goes uncertain and the body stops.
 * `rolling` is for open-ended play (free play, possession): the full window is
 * sealed and a fresh one starts, the trace counts what rolled, and the body
 * keeps playing — a marathon must never die at a receipt-sized cap.
 */
export type GbaEvidencePolicy = "frozen" | "rolling";

export interface GbaEmulatorAdapterOptions {
  evidencePolicy?: GbaEvidencePolicy;
}

export class GbaEmulatorAdapter implements EnvironmentAdapter {
  private readonly scenario: GbaAdapterScenario;
  private readonly fixtureSha256: string;
  private readonly coreFactory: GbaCoreFactory;
  private readonly evidencePolicy: GbaEvidencePolicy;
  private readonly sessions = new Map<string, GbaEmulatorSession>();

  public constructor(
    scenarioInput: FrozenGbaScenario,
    fixtureSha256: string,
    coreFactory?: undefined,
    options?: GbaEmulatorAdapterOptions,
  );
  public constructor(
    scenarioInput: GbaAdapterScenario,
    fixtureSha256: string,
    coreFactory: GbaCoreFactory,
    options?: GbaEmulatorAdapterOptions,
  );
  public constructor(
    scenarioInput: GbaAdapterScenario,
    fixtureSha256: string,
    coreFactory?: GbaCoreFactory,
    options?: GbaEmulatorAdapterOptions,
  ) {
    this.scenario = scenarioInput;
    if (!/^[a-f0-9]{64}$/u.test(fixtureSha256)) throw new Error("Fixture SHA-256 is invalid");
    this.fixtureSha256 = fixtureSha256;
    // The default factory is the CI test double; its constructor validates the
    // frozen-scenario savestate identity, so a scenario that is not a frozen
    // double scenario fails closed here instead of running with wrong state.
    this.coreFactory =
      coreFactory ?? ((scenario) => new DeterministicGbaCoreDouble(scenario as FrozenGbaScenario));
    this.evidencePolicy = options?.evidencePolicy ?? "frozen";
  }

  public start(
    specInput: EnvironmentSessionSpecV2,
    connection: Readonly<Record<string, string>>,
  ): Promise<EnvironmentAdapterSession> {
    if (Object.keys(connection).length > 0) {
      throw new Error("The emulator adapter accepts no credentials or connection material");
    }
    const spec = GbaEmulatorSessionSpecSchema.parse(specInput);
    validateScenarioBinding(spec, this.scenario);
    const adapterSessionId = `gba-emulator:${spec.sessionId}`;
    const session = new GbaEmulatorSession(
      adapterSessionId,
      spec,
      this.scenario,
      this.fixtureSha256,
      this.coreFactory(this.scenario),
      this.evidencePolicy,
    );
    this.sessions.set(adapterSessionId, session);
    return Promise.resolve(session);
  }

  public attach(
    specInput: EnvironmentSessionSpecV2,
    adapterSessionId: string,
  ): Promise<EnvironmentAdapterSession | undefined> {
    const spec = GbaEmulatorSessionSpecSchema.parse(specInput);
    const session = this.sessions.get(adapterSessionId);
    return Promise.resolve(session?.sessionId === spec.sessionId ? session : undefined);
  }

  public session(sessionId: string): GbaEmulatorSession {
    const session = this.sessions.get(`gba-emulator:${sessionId}`);
    if (!session) throw new Error(`Unknown GBA emulator session ${sessionId}`);
    return session;
  }
}

export class GbaEmulatorSession implements EnvironmentAdapterSession {
  public readonly adapterSessionId: string;
  public readonly sessionId: string;
  private readonly spec: GbaEmulatorSessionSpec;
  private readonly scenario: GbaAdapterScenario;
  private readonly fixtureSha256: string;
  private readonly core: GbaCoreSeam;
  private readonly completed = new Map<string, EnvironmentAdapterActionCompletion>();
  private readonly pendingWaits = new Set<string>();
  private readonly evidence: GbaEmulatorEvidenceEvent[] = [];
  private readonly evidencePolicy: GbaEvidencePolicy;
  /**
   * Tiles that stopped a route this session, keyed by the map they are on.
   *
   * Tile collision does not include NPCs, so the planner routes straight
   * through one and the walk dies on it. Without this the next plan picks the
   * same shortest route and dies on the same tile: on 2026-08-15 four
   * consecutive routes to Viridian's Pokémon Center were funnelled into the
   * old man at (29,17), and the fourth planned 44 steps for a 4-tile trip to
   * get back to him. He read four identical failures as a wrong destination
   * and spent 40 turns searching buildings.
   *
   * Remembered rather than timed out because an NPC that has moved costs one
   * unnecessary detour, while an NPC that has not costs the whole route again.
   * The forgetting is the fallback in `walk_to`: a target only reachable
   * through a remembered tile re-plans against the raw grid, so this can slow
   * a route down but can never make a reachable tile unreachable.
   */
  private readonly blockedTiles = new Map<string, Set<string>>();
  private rolledWindows = 0;
  private droppedEvidenceEvents = 0;
  private observationCount = 0;
  private certain = true;
  private uncertaintyReason: string | null = null;
  private paused = false;
  private stopped = false;

  public constructor(
    adapterSessionId: string,
    spec: GbaEmulatorSessionSpec,
    scenario: GbaAdapterScenario,
    fixtureSha256: string,
    core: GbaCoreSeam,
    evidencePolicy: GbaEvidencePolicy = "frozen",
  ) {
    this.adapterSessionId = adapterSessionId;
    this.sessionId = spec.sessionId;
    this.spec = spec;
    this.scenario = scenario;
    this.fixtureSha256 = fixtureSha256;
    this.core = core;
    this.evidencePolicy = evidencePolicy;
  }

  public pause(): Promise<void> {
    this.paused = true;
    return Promise.resolve();
  }

  public resume(): Promise<void> {
    if (this.stopped) throw new Error("Emulator session is stopped");
    this.paused = false;
    return Promise.resolve();
  }

  public async startAction(
    commandInput: EnvironmentStartActionCommand,
  ): Promise<EnvironmentAdapterActionCompletion | void> {
    const parsed = GbaEmulatorStartActionCommandSchema.safeParse(commandInput);
    if (!parsed.success) return Promise.reject(closed("invalid_emulator_command"));
    const command = parsed.data;
    if (command.sessionId !== this.sessionId) return Promise.reject(closed("session_mismatch"));
    const prior = this.completed.get(command.actionId);
    if (prior) return Promise.resolve(structuredClone(prior));
    if (this.pendingWaits.has(command.actionId)) return Promise.resolve();
    if (this.stopped) return Promise.reject(closed("session_stopped"));
    if (this.paused) return Promise.reject(closed("session_paused"));
    if (!this.certain) return Promise.reject(closed("uncertain_state"));
    if (this.pendingWaits.size > 0) return Promise.reject(closed("action_already_pending"));

    try {
      enforceLimits(command.action.limits, this.spec.resourceBounds);
      enforceCapability(command.action.action, this.spec.resourceBounds);
      if (command.action.action.kind === "wait") {
        if (this.evidence.length > this.scenario.maxEvidenceEvents - 2 && !this.rollEvidenceWindow()) {
          this.markStateUncertain("Bounded evidence capacity cannot cover a cancellable wait");
          throw closed("evidence_bound_exceeded");
        }
        this.record(
          command.actionId,
          "wait",
          `Started bounded wait for ${String(command.action.action.durationMs)}ms`,
        );
        this.pendingWaits.add(command.actionId);
        return Promise.resolve();
      }
      const outcome = await this.apply(command.actionId, command.action.action, command.action.limits);
      const completion: EnvironmentAdapterActionCompletion = { status: "completed", outcome };
      this.completed.set(command.actionId, completion);
      return Promise.resolve(structuredClone(completion));
    } catch (error) {
      return Promise.reject(
        error instanceof EnvironmentAdapterActionError
          ? error
          : new EnvironmentAdapterActionError(
              "emulator_rejected",
              // The cause travels with the rejection: a swallowed message once
              // turned a decodable state bug into a blind "rejected" wall.
              `Emulator rejected the action: ${boundedSummary(error instanceof Error ? error.message : String(error))}`,
              false,
            ),
      );
    }
  }

  public cancelAction(actionId: string, reason: string): Promise<void> {
    if (this.pendingWaits.delete(actionId)) {
      this.record(actionId, "cancel_action", boundedSummary(`Wait cancelled: ${reason}`));
    }
    return Promise.resolve();
  }

  public stop(reason: string): Promise<void> {
    for (const actionId of this.pendingWaits) {
      this.record(actionId, "cancel_action", boundedSummary(`Session stopped: ${reason}`));
    }
    this.pendingWaits.clear();
    this.stopped = true;
    this.paused = false;
    return Promise.resolve();
  }

  public markStateUncertain(reason: string): void {
    this.certain = false;
    this.uncertaintyReason = boundedSummary(reason);
  }

  public observe(kind: GbaEmulatorObservationKind, actionId?: string): GbaEmulatorObservation {
    if (!this.spec.resourceBounds.capabilities.includes("emulator.gba.observe")) {
      throw closed("capability_not_granted");
    }
    const state = this.core.gameState();
    this.observationCount += 1;
    const base = {
      schemaVersion: 1 as const,
      observationId: `gba-observation-${String(this.observationCount)}`,
      sessionId: this.sessionId,
      characterId: this.spec.characterId,
      worldId: this.spec.worldId,
      goalVersion: this.spec.initialGoalVersion,
      capturedAt: logicalTimestamp(this.observationCount),
      frame: state.frame,
    };
    const requireActiveMember = () => {
      const activeMember = state.party.find((member) => member.slot === state.activePartySlot);
      if (!activeMember) throw closed("party_state_corrupt");
      return activeMember;
    };
    const observation = (() => {
      if (
        state.mode === "unknown" &&
        kind !== "scene" &&
        kind !== "frame_reference" &&
        kind !== "danger" &&
        kind !== "action"
      ) {
        throw closed("semantic_state_unavailable");
      }
      switch (kind) {
        case "overworld": {
          const grid = this.core.mapGrid?.() ?? null;
          const exits = state.exits ?? null;
          return {
            ...base,
            kind,
            data: {
              position: state.position,
              facing: state.facing,
              surroundings: state.surroundings ?? null,
              mapSize: state.mapSize ?? null,
              minimap:
                grid === null ? null : renderWalkabilityMinimap(grid, state.position, exits?.warps ?? []),
              exits:
                exits === null
                  ? null
                  : {
                      warps: exits.warps.map((warp) => ({
                        x: warp.x,
                        y: warp.y,
                        destination: warp.destinationMapId,
                        walkTo: "supported" as const,
                      })),
                      connections: exits.connections.map((connection) => ({
                        direction: connection.direction,
                        destination: connection.destinationMapId,
                      })),
                    },
              ramStateSha256: this.core.ramStateSha256(),
            },
          };
        }
        case "menu": {
          const menu = state.menu;
          if (!menu) throw closed("menu_not_open");
          return {
            ...base,
            kind,
            data: {
              menuId: menu.menuId,
              cursor: menu.cursor,
              entries: menu.entries,
              untrusted: true as const,
            },
          };
        }
        case "party":
          return {
            ...base,
            kind,
            data: {
              activeSlot: state.activePartySlot,
              members: state.party.map(({ moves: _moves, ...member }) => member),
            },
          };
        case "inventory":
          return {
            ...base,
            kind,
            data: { items: state.inventory ?? [] },
          };
        case "battle": {
          const battle = state.battle;
          const trainer = this.scenario.trainer;
          if (!battle) throw closed("battle_not_active");
          const opponent = battle.opponent ?? trainer?.opponent;
          if (!opponent) throw closed("battle_state_corrupt");
          const activeMember = requireActiveMember();
          return {
            ...base,
            kind,
            data: {
              battleId: battle.battleId,
              turn: battle.turn,
              phase:
                state.mode === "battle"
                  ? battle.inputMode === "resolving"
                    ? ("resolving" as const)
                    : ("awaiting_input" as const)
                  : state.mode === "battle_won"
                    ? ("won" as const)
                    : state.mode === "battle_lost"
                      ? ("lost" as const)
                      : (() => {
                          throw closed("battle_not_active");
                        })(),
              opponent: {
                speciesId: opponent.speciesId,
                level: opponent.level,
                currentHp: battle.opponentHp,
                maxHp: opponent.maxHp,
              },
              activePartySlot: state.activePartySlot,
              moveCursor: battle.moveCursor,
              legalMoves: activeMember.moves,
              untrusted: true as const,
            },
          };
        }
        case "dialog": {
          const trainer = this.scenario.trainer;
          if (state.mode !== "dialog") throw closed("dialog_not_open");
          const lines = state.dialogLines?.length ? state.dialogLines : trainer?.dialog;
          if (!lines?.length) throw closed("dialog_state_corrupt");
          return {
            ...base,
            kind,
            data: {
              speaker: trainer?.trainerId ?? "firered",
              lines: [...lines],
              lineIndex: Math.min(state.dialogLineIndex, lines.length - 1),
              untrusted: true as const,
            },
          };
        }
        case "scene":
          // A framebuffer-only cartridge reports `unknown`; callers can still
          // look and press raw buttons without receiving invented game state.
          return {
            ...base,
            kind,
            data: {
              mode: state.mode,
              inputReady: state.inputReady ?? true,
              waitingForDialogAdvance: state.waitingForDialogAdvance ?? false,
            },
          };
        case "frame_reference":
          return {
            ...base,
            kind,
            data: {
              artifactId: `${this.sessionId}:frame:${String(state.frame)}`,
              uri: `artifact://gba-emulator/${this.sessionId}/frames/${String(state.frame)}`,
              framebufferSha256: this.core.framebufferSha256(),
              ramStateSha256: this.core.ramStateSha256(),
              summary: `Bounded framebuffer/RAM reference at frame ${String(state.frame)}`,
            },
          };
        case "danger":
          return {
            ...base,
            kind,
            data: this.certain
              ? {
                  severity: "low" as const,
                  code: "policy_boundary" as const,
                  summary: "Local emulator session; no network or live-service capability exists",
                  stateCertain: true,
                }
              : {
                  severity: "high" as const,
                  code: "uncertain_state" as const,
                  summary: this.uncertaintyReason ?? "Emulator state is uncertain",
                  stateCertain: false,
                },
          };
        case "action": {
          if (!actionId) throw closed("action_id_required");
          const completed = this.completed.has(actionId);
          const pending = this.pendingWaits.has(actionId);
          if (!completed && !pending) throw closed("unknown_action");
          return {
            ...base,
            kind,
            data: {
              actionId,
              status: completed ? ("completed" as const) : ("running" as const),
              summary: completed ? "Emulator action completed" : "Emulator wait is pending",
            },
          };
        }
      }
    })();
    return GbaEmulatorObservationSchema.parse(observation);
  }

  public snapshot(): GbaEmulatorSnapshot {
    const state = this.core.gameState();
    const active = state.party.find((member) => member.slot === state.activePartySlot);
    return {
      position: structuredClone(state.position),
      battleId: state.battle?.battleId ?? null,
      battleResult:
        state.mode === "battle_won"
          ? "won"
          : state.mode === "battle_lost"
            ? "lost"
            : state.battle
              ? "active"
              : "not_started",
      turn: state.battle?.turn ?? 0,
      activePartySlot: state.activePartySlot,
      activePartyHp: active?.currentHp ?? 0,
      opponentHp: state.battle?.opponentHp ?? this.scenario.trainer?.opponent.maxHp ?? 0,
      frame: state.frame,
      inputCount: state.inputCount,
      inputReady: state.inputReady ?? true,
      stateCertain: this.certain,
      ramStateSha256: this.core.ramStateSha256(),
    };
  }

  public trace(): GbaEmulatorTrace {
    return validateGbaEmulatorTrace({
      schemaVersion: 1,
      scenarioId: this.scenario.scenarioId,
      scenarioVersion: this.scenario.scenarioVersion,
      fixtureSha256: this.fixtureSha256,
      coreId: this.scenario.coreId,
      savestateSha256: this.scenario.savestateSha256,
      rngSeed: this.scenario.rngSeed,
      eventChainHeadSha256: this.evidence.at(-1)?.eventSha256 ?? GENESIS_HASH,
      events: structuredClone(this.evidence),
      // Frozen runs never roll, so their receipts stay byte-identical.
      ...(this.rolledWindows === 0
        ? {}
        : { rolledWindows: this.rolledWindows, droppedEvidenceEvents: this.droppedEvidenceEvents }),
    });
  }

  /**
   * Note that something the collision grid cannot see stopped a route here.
   *
   * Bounded per map because these are guesses about a world that moves: a long
   * session in one town would otherwise accumulate an avoid-list that routes
   * around NPCs who wandered off an hour ago. Insertion order is the eviction
   * order, so the set holds the most recent obstructions.
   */
  private rememberBlocked(mapId: string, tile: { x: number; y: number }): void {
    let tiles = this.blockedTiles.get(mapId);
    if (tiles === undefined) {
      tiles = new Set<string>();
      this.blockedTiles.set(mapId, tiles);
    }
    const id = `${String(tile.x)},${String(tile.y)}`;
    // Re-inserted rather than kept in place, so a tile that keeps blocking
    // stays the freshest entry instead of aging out under quieter ones.
    tiles.delete(id);
    tiles.add(id);
    while (tiles.size > MAX_REMEMBERED_BLOCKED_TILES) {
      const oldest = tiles.values().next();
      if (oldest.done === true) break;
      tiles.delete(oldest.value);
    }
  }

  private async apply(
    actionId: string,
    action: Exclude<GbaEmulatorAction, { kind: "wait" }>,
    limits: GbaEmulatorActionLimits,
  ): Promise<Record<string, unknown>> {
    if (this.evidence.length >= this.scenario.maxEvidenceEvents && !this.rollEvidenceWindow()) {
      this.markStateUncertain("Bounded evidence capacity was exceeded");
      throw closed("evidence_bound_exceeded");
    }
    if (
      this.core.gameState().mode === "unknown" &&
      action.kind !== "button_press" &&
      action.kind !== "frame_advance"
    ) {
      throw closed("semantic_state_unavailable");
    }
    switch (action.kind) {
      case "button_press": {
        // Every repeat is an input and every hold is frames, so a burst is
        // bounded by the same budget a single press draws from.
        const repeat = action.repeat ?? 1;
        if (action.holdFrames * repeat > limits.maxFrames) throw closed("frame_bound_exceeded");
        if (repeat > limits.maxInputs) throw closed("input_bound_exceeded");
        if (limits.maxInputs < 1) throw closed("input_bound_exceeded");
        // Captured before the press so the outcome can say whether the press
        // actually went anywhere. A bump and a step are otherwise identical to
        // a caller: both complete, and both change the RAM digest, because the
        // bump animation is itself a state change.
        const before = this.core.gameState();
        for (let press = 0; press < repeat; press += 1) {
          await this.core.pressButton(action.button, action.holdFrames);
        }
        const state = this.core.gameState();
        this.record(
          actionId,
          "button_press",
          repeat === 1
            ? `Pressed ${action.button} for ${String(action.holdFrames)} frames`
            : `Pressed ${action.button} ${String(repeat)}x for ${String(action.holdFrames)} frames`,
        );
        if (state.mode === "unknown") {
          return {
            button: action.button,
            holdFrames: action.holdFrames,
            repeat,
            frame: state.frame,
            mode: state.mode,
            ramStateSha256: this.core.ramStateSha256(),
          };
        }
        return {
          button: action.button,
          holdFrames: action.holdFrames,
          repeat,
          frame: state.frame,
          mode: state.mode,
          // The resulting state, so reading it back does not cost a second
          // round trip per move.
          position: state.position,
          facing: state.facing,
          /** False when the press changed no tile: a wall, or a turn in place. */
          moved:
            before.position.mapId !== state.position.mapId ||
            before.position.x !== state.position.x ||
            before.position.y !== state.position.y,
          /** True when the press only changed which way the player looks. */
          turned: before.facing !== state.facing,
          surroundings: state.surroundings ?? null,
          // The text or menu the press produced, so reading it back does not
          // cost an observe round trip — the same reason position rides along.
          ...(state.dialogLines?.length ? { dialogLines: state.dialogLines } : {}),
          ...(state.menu ? { menu: state.menu } : {}),
          ramStateSha256: this.core.ramStateSha256(),
        };
      }
      case "walk_to": {
        const grid = this.core.mapGrid?.() ?? null;
        if (grid === null) throw closed("map_grid_unavailable");
        const start = this.core.gameState();
        if (start.mode !== "overworld") throw closed("walk_requires_overworld");
        const target = { x: action.x, y: action.y };
        // Each refusal says what would have to be different, because the tile
        // was chosen by a model reading a screenshot: a bare "no" turns into
        // another guess, a named bound or nearest tile turns into a route.
        if (target.x < grid.minX || target.y < grid.minY || target.x >= grid.maxX || target.y >= grid.maxY) {
          throw closed(
            "walk_target_outside_map",
            `the loaded map spans x ${String(grid.minX)}..${String(grid.maxX - 1)}, ` +
              `y ${String(grid.minY)}..${String(grid.maxY - 1)}`,
          );
        }
        const warp =
          start.exits?.warps.find((candidate) => candidate.x === target.x && candidate.y === target.y) ??
          null;
        // Planned against a grid that also treats tiles which already stopped a
        // route here as closed, so a second attempt goes around the NPC rather
        // than back into it. Refusals below keep reading the raw grid: an
        // avoided tile is occupied, not a wall, and reporting it as one would
        // teach him a wrong fact about the map.
        const avoiding = avoidingGrid(grid, this.blockedTiles.get(start.position.mapId));
        /** The press that steps into a blocked warp tile once beside it. */
        let throughWarp: GbaButton | null = null;
        let path: PlannedWalkStep[];
        if (warp !== null && !grid.isPassable(target.x, target.y)) {
          // A door pressed into rather than stepped onto: route to a tile
          // beside it, then press toward it. The warp event is what makes this
          // an entrance rather than a wall, so plain walls keep refusing.
          const approach =
            planWalkBeside(avoiding, start.position, target) ?? planWalkBeside(grid, start.position, target);
          if (approach === null) {
            throw closed("no_path_to_target", nearestReachableDetail(grid, start.position, target));
          }
          path = approach.path;
          throughWarp = approach.press;
        } else if (!grid.isPassable(target.x, target.y)) {
          throw closed("walk_target_impassable", nearestReachableDetail(grid, start.position, target));
        } else {
          // The raw-grid retry is what keeps the memory from walling him off:
          // when the only route runs through a tile that blocked him before,
          // he walks it again and finds out whether whoever stood there moved.
          const planned =
            planWalk(avoiding, start.position, target) ?? planWalk(grid, start.position, target);
          if (planned === null) {
            throw closed("no_path_to_target", nearestReachableDetail(grid, start.position, target));
          }
          path = planned;
        }
        const plannedSteps = path.length + (throughWarp === null ? 0 : 1);
        // A route is a burst of presses, so it draws on the same budget one.
        if (plannedSteps > limits.maxInputs) throw closed("input_bound_exceeded");
        if (plannedSteps * WALK_HOLD_FRAMES > limits.maxFrames) throw closed("frame_bound_exceeded");

        let taken = 0;
        let blockedAt: { x: number; y: number } | null = null;
        let blockedBecause: WalkBlockReason | null = null;
        let warped = false;
        for (const step of path) {
          const before = this.core.gameState();
          await this.core.pressButton(step.button, WALK_HOLD_FRAMES);
          const after = this.core.gameState();
          if (after.position.mapId !== before.position.mapId) {
            // A warp tile ends the route: the plan was made against a map that
            // is no longer loaded, so continuing would walk a stale path.
            warped = true;
            taken += 1;
            break;
          }
          if (after.position.x === before.position.x && after.position.y === before.position.y) {
            // Tile collision does not include NPCs, so a planned tile can be
            // occupied. Stop and say where, rather than mashing a dead route.
            // A wild encounter and a warp fade look the same from coordinates
            // — do not remember those as furniture.
            blockedAt = { x: step.x, y: step.y };
            blockedBecause = walkBlockReason(after);
            if (blockedBecause === "npc") this.rememberBlocked(before.position.mapId, blockedAt);
            break;
          }
          taken += 1;
        }
        if (throughWarp !== null && !warped && blockedAt === null) {
          const before = this.core.gameState();
          await this.core.pressButton(throughWarp, WALK_HOLD_FRAMES);
          const after = this.core.gameState();
          taken += 1;
          if (after.position.mapId !== before.position.mapId) {
            warped = true;
          } else {
            // The door did not open — a locked entrance, a fade, or a fight.
            blockedAt = { x: target.x, y: target.y };
            blockedBecause = walkBlockReason(after);
            if (blockedBecause === "npc") this.rememberBlocked(before.position.mapId, blockedAt);
          }
        }

        const state = this.core.gameState();
        this.record(
          actionId,
          "walk_to",
          `Walked ${String(taken)}/${String(plannedSteps)} steps toward (${String(action.x)}, ${String(action.y)})`,
        );
        return {
          target,
          plannedSteps,
          steps: taken,
          // Stepping through the targeted warp is arrival: the walk ends where
          // the door leads. A warp taken mid-route is still an interrupted plan.
          arrived:
            blockedAt === null &&
            (warped
              ? taken === plannedSteps
              : state.position.x === action.x && state.position.y === action.y),
          blockedAt,
          ...(blockedBecause === null ? {} : { blockedBecause }),
          warped,
          frame: state.frame,
          mode: state.mode,
          inputReady: state.inputReady ?? true,
          position: state.position,
          facing: state.facing,
          surroundings: state.surroundings ?? null,
          ramStateSha256: this.core.ramStateSha256(),
        };
      }
      case "select_menu_entry": {
        const opening = this.core.gameState();
        const menu = opening.menu;
        if (menu === null || menu === undefined) throw closed("menu_not_open");
        // The naming screen is a keyboard, not a list; enter_text owns it.
        if (menu.menuId === "naming-screen") throw closed("menu_not_navigable");
        // Bag windows scroll: entries are a slice while the cursor stays
        // absolute, so a full window cannot be navigated by entry index.
        if (menu.menuId.startsWith("bag-") && menu.entries.length >= 16) {
          throw closed("menu_window_scrolled");
        }
        const targetIndex = menu.entries.findIndex((entry) => entry.id === action.entryId);
        if (targetIndex === -1) throw closed("menu_entry_not_found");
        // The battle menus are 2×2 grids whose cursor moves by XOR — left and
        // right flip bit 0, up and down flip bit 1 — every other decoded menu
        // is a vertical list. Either way each press is verified against the
        // live cursor, so a geometry this model does not fit stops the action
        // instead of wandering the menu.
        const grid = menu.menuId === "battle-action-menu" || menu.menuId === "battle-move-menu";

        let presses = 0;
        let framesSpent = 0;
        let endedBecause:
          | "selected"
          | "menu_closed"
          | "cursor_stalled"
          | "input_bound_reached"
          | "frame_bound_reached" = "selected";
        for (;;) {
          const during = this.core.gameState();
          const current = during.menu;
          if (current === null || current === undefined || current.menuId !== menu.menuId) {
            endedBecause = "menu_closed";
            break;
          }
          if (current.cursor === targetIndex) break;
          // The confirming A below needs an input too, hence the -1.
          if (presses >= limits.maxInputs - 1) {
            endedBecause = "input_bound_reached";
            break;
          }
          if (framesSpent + MENU_HOLD_FRAMES > limits.maxFrames) {
            endedBecause = "frame_bound_reached";
            break;
          }
          const button: GbaButton = grid
            ? ((current.cursor ^ targetIndex) & 1) !== 0
              ? (targetIndex & 1) !== 0
                ? "right"
                : "left"
              : (targetIndex & 2) !== 0
                ? "down"
                : "up"
            : current.cursor < targetIndex
              ? "down"
              : "up";
          await this.core.pressButton(button, MENU_HOLD_FRAMES);
          presses += 1;
          framesSpent += MENU_HOLD_FRAMES;
          const after = this.core.gameState().menu;
          if (
            after !== null &&
            after !== undefined &&
            after.menuId === current.menuId &&
            after.cursor === current.cursor
          ) {
            endedBecause = "cursor_stalled";
            break;
          }
        }
        let confirmed = false;
        if (endedBecause === "selected") {
          await this.core.pressButton("a", MENU_HOLD_FRAMES);
          presses += 1;
          framesSpent += MENU_HOLD_FRAMES;
          confirmed = true;
        }
        const state = this.core.gameState();
        const label = menu.entries[targetIndex]?.label ?? action.entryId;
        this.record(
          actionId,
          "select_menu_entry",
          confirmed
            ? `Selected "${label}" in ${menu.menuId}`
            : `Stopped selecting "${label}" in ${menu.menuId}: ${endedBecause}`,
        );
        return {
          menuId: menu.menuId,
          entryId: action.entryId,
          label,
          confirmed,
          presses,
          framesSpent,
          endedBecause,
          frame: state.frame,
          mode: state.mode,
          position: state.position,
          facing: state.facing,
          ...(state.dialogLines?.length ? { dialogLines: state.dialogLines } : {}),
          ...(state.menu ? { menu: state.menu } : {}),
          ramStateSha256: this.core.ramStateSha256(),
        };
      }
      case "advance_dialog": {
        // A visible box is not always a decoded dialog. A scripted sequence
        // (the starter fanfare) holds the box while the script runs a wait the
        // dialog decoder does not model — mode reads "overworld" with field
        // controls locked — and battle text lives under the battle modes. All
        // are exactly when a driver reaches for this action, so all are
        // entered rather than refused; only a screen with nothing readable
        // and nothing held fails closed.
        {
          const opening = this.core.gameState();
          const held = opening.mode === "overworld" && !(opening.inputReady ?? true);
          if (!isReadableText(opening) && !held) throw closed("dialog_not_open");
        }
        const startedInBattle = this.core.gameState().mode === "battle";
        // Every distinct box read along the way, oldest first. A capture that
        // extends the previous one replaces it, so a box caught mid-print by
        // the stall-break never leaves its prefix behind as a phantom entry.
        const transcript: string[] = [];
        const capture = (lines: readonly string[] | undefined): void => {
          const text = (lines ?? []).join("\n");
          if (text.length === 0) return;
          const last = transcript.at(-1);
          if (last === text) return;
          if (last !== undefined && text.startsWith(last)) {
            transcript[transcript.length - 1] = text;
            return;
          }
          transcript.push(text);
        };
        let presses = 0;
        let framesSpent = 0;
        let idleFrames = 0;
        let heldFrames = 0;
        let sawText = false;
        let endedBecause:
          | "dialog_closed"
          | "choice_open"
          | "battle_started"
          | "battle_ended"
          | "script_released"
          | "script_holding"
          | "input_bound_reached"
          | "frame_bound_reached"
          | "choice_unlisted";
        for (;;) {
          const during = this.core.gameState();
          if (
            during.menu !== null &&
            during.menu !== undefined &&
            during.mode !== "battle" &&
            during.mode !== "battle_won" &&
            during.mode !== "battle_lost"
          ) {
            // A choice is a decision, not a formality — never answer it here.
            capture(during.dialogLines);
            endedBecause = "choice_open";
            break;
          }
          if (!isReadableText(during)) {
            const scriptHeld = during.mode === "overworld" && !(during.inputReady ?? true);
            if (scriptHeld) {
              // The script owns the screen with no readable box — a fanfare, a
              // cutscene beat between boxes. Waiting here, bounded, is what
              // stops a visibly held box from reading as "no dialog is open".
              if (
                framesSpent + DIALOG_PRINT_WAIT_FRAMES > limits.maxFrames ||
                (!sawText && heldFrames >= SCRIPT_HOLD_MAX_FRAMES)
              ) {
                endedBecause = sawText ? "frame_bound_reached" : "script_holding";
                break;
              }
              await this.core.advanceFrames(DIALOG_PRINT_WAIT_FRAMES);
              framesSpent += DIALOG_PRINT_WAIT_FRAMES;
              heldFrames += DIALOG_PRINT_WAIT_FRAMES;
              continue;
            }
            // The screen is free; say what ended the reading. The next A press
            // would re-engage whatever is ahead, so ending here is the point.
            endedBecause =
              during.mode === "battle"
                ? startedInBattle
                  ? "choice_open"
                  : "battle_started"
                : startedInBattle
                  ? "battle_ended"
                  : sawText
                    ? "dialog_closed"
                    : "script_released";
            break;
          }
          sawText = true;
          heldFrames = 0;
          const ready = during.waitingForDialogAdvance ?? during.mode === "dialog";
          if (ready || idleFrames >= DIALOG_STALL_FRAMES) {
            if (presses >= limits.maxInputs) {
              capture(during.dialogLines);
              endedBecause = "input_bound_reached";
              break;
            }
            if (framesSpent + DIALOG_HOLD_FRAMES > limits.maxFrames) {
              capture(during.dialogLines);
              endedBecause = "frame_bound_reached";
              break;
            }
            const beforeLines = (during.dialogLines ?? []).join("\n");
            const beforeProgress = during.dialogProgress;
            capture(during.dialogLines);
            await this.core.pressButton("a", DIALOG_HOLD_FRAMES);
            presses += 1;
            framesSpent += DIALOG_HOLD_FRAMES;
            idleFrames = 0;
            const afterPress = this.core.gameState();
            // FireRed Yes/No and some lists keep the same box string while a
            // choice the decoder does not list is waiting. Another A answers it.
            // A battle the conversation just started is a different ending —
            // leave that to the next loop's mode check.
            if (
              (afterPress.dialogLines ?? []).join("\n") === beforeLines &&
              (beforeProgress === undefined ||
                afterPress.dialogProgress === undefined ||
                afterPress.dialogProgress === beforeProgress) &&
              afterPress.menu == null &&
              isReadableText(afterPress) &&
              (afterPress.waitingForDialogAdvance ?? afterPress.mode === "dialog") &&
              afterPress.mode !== "battle" &&
              afterPress.mode !== "battle_won" &&
              afterPress.mode !== "battle_lost"
            ) {
              endedBecause = "choice_unlisted";
              break;
            }
            continue;
          }
          // Text is still printing (or battle text is flowing on its own
          // clock): wait for the box instead of wasting an input on a press
          // the game will not accept.
          if (framesSpent + DIALOG_PRINT_WAIT_FRAMES > limits.maxFrames) {
            capture(during.dialogLines);
            endedBecause = "frame_bound_reached";
            break;
          }
          // Captured before the wait: if the box turns ready inside this very
          // window, the hold's initial edge can advance it, and the lines
          // would otherwise be gone before the next capture.
          capture(during.dialogLines);
          if (this.core.advanceFramesHolding === undefined) {
            await this.core.advanceFrames(DIALOG_PRINT_WAIT_FRAMES);
          } else {
            // Waiting with A held: FireRed reads a held A/B as "zero the
            // per-character delay" — the fast-read every human does — and a
            // held button can never register as the fresh press a waiting box
            // requires, so this cannot answer a prompt or skip a box.
            await this.core.advanceFramesHolding("a", DIALOG_PRINT_WAIT_FRAMES);
          }
          framesSpent += DIALOG_PRINT_WAIT_FRAMES;
          idleFrames += DIALOG_PRINT_WAIT_FRAMES;
        }
        const state = this.core.gameState();
        this.record(
          actionId,
          "advance_dialog",
          `Advanced dialog through ${String(presses)} presses (${endedBecause})`,
        );
        return {
          transcript,
          presses,
          framesSpent,
          endedBecause,
          frame: state.frame,
          mode: state.mode,
          position: state.position,
          facing: state.facing,
          ...(state.dialogLines?.length ? { dialogLines: state.dialogLines } : {}),
          ...(state.menu ? { menu: state.menu } : {}),
          ramStateSha256: this.core.ramStateSha256(),
        };
      }
      case "enter_text": {
        // Spelling a six-letter nickname by hand cost nineteen model turns on
        // the 2026-07-27 run. This is the composite that makes it one: verify
        // the cursor against live state, press, verify what actually landed.
        // Every claimed key that matters is empirically verified; the typed-
        // byte check after each A catches the few transcribed-only cells, so
        // a wrong mapping surfaces as an honest stop rather than a wrong name.
        if (this.core.gameState().naming == null) throw closed("naming_screen_not_open");
        const desired = action.text;
        const submit = action.submit ?? true;
        let presses = 0;
        let framesSpent = 0;
        let typedSoFar = "";
        let endedBecause:
          | "confirmed"
          | "typed"
          | "screen_closed"
          | "input_not_registered"
          | "input_bound_reached"
          | "frame_bound_reached" = submit ? "confirmed" : "typed";
        const naming = () => this.core.gameState().naming ?? null;
        const budgetLeft = (frames: number): boolean => {
          if (presses >= limits.maxInputs) {
            endedBecause = "input_bound_reached";
            return false;
          }
          if (framesSpent + frames > limits.maxFrames) {
            endedBecause = "frame_bound_reached";
            return false;
          }
          return true;
        };
        const press = async (button: GbaButton, settleFrames: number): Promise<boolean> => {
          if (!budgetLeft(NAMING_HOLD_FRAMES + settleFrames)) return false;
          await this.core.pressButton(button, NAMING_HOLD_FRAMES);
          await this.core.advanceFrames(settleFrames);
          presses += 1;
          framesSpent += NAMING_HOLD_FRAMES + settleFrames;
          return true;
        };
        // A press the page-swap animation ate is retried once; a press that
        // still changes nothing means the decoded state and the screen have
        // parted ways, and honesty beats persistence.
        const pressVerified = async (
          button: GbaButton,
          settleFrames: number,
          changed: () => boolean,
        ): Promise<"changed" | "unchanged" | "budget"> => {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            if (!(await press(button, settleFrames))) return "budget";
            if (changed()) return "changed";
          }
          endedBecause = "input_not_registered";
          return "unchanged";
        };

        for (;;) {
          let state = naming();
          if (state === null) {
            endedBecause = "screen_closed";
            break;
          }
          typedSoFar = state.text;
          // Idempotent by prefix: keep a matching start, erase a wrong one, so
          // a budget-interrupted entry resumes with the same action repeated.
          if (!desired.startsWith(state.text)) {
            const before = state.text;
            if (
              (await pressVerified("b", NAMING_SETTLE_FRAMES, () => naming()?.text !== before)) !== "changed"
            ) {
              break;
            }
            continue;
          }
          const nextCharacter = desired.slice(state.text.length).charAt(0);
          if (nextCharacter === "") break; // everything is typed
          const key = findNamingKey(nextCharacter, state.page);
          if (key === null) throw closed("enter_text_unsupported_character");
          if (key.page !== state.page) {
            const before = state.page;
            if (
              (await pressVerified("select", NAMING_PAGE_SETTLE_FRAMES, () => naming()?.page !== before)) !==
              "changed"
            ) {
              break;
            }
            continue;
          }
          const step = stepTowardNamingKey(state.page, state, key);
          if (step !== null) {
            const before = { row: state.row, column: state.column };
            const moved = () => {
              const now = naming();
              return now !== null && (now.row !== before.row || now.column !== before.column);
            };
            if ((await pressVerified(step, NAMING_SETTLE_FRAMES, moved)) !== "changed") break;
            continue;
          }
          // On the key: type it, then check the byte that actually landed.
          const lengthBefore = state.text.length;
          if (
            (await pressVerified(
              "a",
              NAMING_SETTLE_FRAMES,
              () => (naming()?.text.length ?? 0) !== lengthBefore,
            )) !== "changed"
          ) {
            break;
          }
          state = naming();
          if (state !== null && state.text !== desired.slice(0, state.text.length)) {
            // The cell typed something else (a transcribed-only key that was
            // wrong): erase it and stop honestly rather than confirm a typo.
            await press("b", NAMING_SETTLE_FRAMES);
            endedBecause = "input_not_registered";
            break;
          }
        }

        const fullyTyped = naming()?.text === desired;
        if (submit && fullyTyped && (endedBecause === "confirmed" || endedBecause === "typed")) {
          endedBecause = "confirmed";
          // START jumps to OK from anywhere — verified on the letter pages
          // only, so a symbols-page entry cycles back to the upper page first.
          if (naming()?.page === "symbols") {
            const before = naming()?.page;
            await pressVerified("select", NAMING_PAGE_SETTLE_FRAMES, () => naming()?.page !== before);
          }
          const onOk = () => {
            const now = naming();
            return now !== null && now.row === OK_ROW && now.column === BUTTON_COLUMN[now.page];
          };
          if (!onOk()) await pressVerified("start", NAMING_SETTLE_FRAMES, onOk);
          if (onOk() && (await press("a", NAMING_SETTLE_FRAMES))) {
            // The close runs a callback chain about 37 frames long.
            for (let waited = 0; naming() !== null && waited < NAMING_CLOSE_WAIT_FRAMES;) {
              await this.core.advanceFrames(NAMING_SETTLE_FRAMES);
              framesSpent += NAMING_SETTLE_FRAMES;
              waited += NAMING_SETTLE_FRAMES;
            }
          }
          if (naming() !== null) endedBecause = "input_not_registered";
        }

        const state = this.core.gameState();
        this.record(
          actionId,
          "enter_text",
          `Typed "${desired}" through ${String(presses)} presses (${endedBecause})`,
        );
        return {
          text: desired,
          typed: state.naming?.text ?? (endedBecause === "confirmed" ? desired : typedSoFar),
          submitted: submit,
          confirmed: endedBecause === "confirmed" && state.naming == null,
          presses,
          framesSpent,
          endedBecause,
          frame: state.frame,
          mode: state.mode,
          position: state.position,
          facing: state.facing,
          ...(state.menu ? { menu: state.menu } : {}),
          ramStateSha256: this.core.ramStateSha256(),
        };
      }
      case "frame_advance": {
        if (action.frames > limits.maxFrames) throw closed("frame_bound_exceeded");
        await this.core.advanceFrames(action.frames);
        const state = this.core.gameState();
        this.record(actionId, "frame_advance", `Advanced ${String(action.frames)} frames`);
        if (state.mode === "unknown") {
          return {
            frames: action.frames,
            frame: state.frame,
            mode: state.mode,
            ramStateSha256: this.core.ramStateSha256(),
          };
        }
        return {
          frames: action.frames,
          frame: state.frame,
          mode: state.mode,
          position: state.position,
          facing: state.facing,
          ramStateSha256: this.core.ramStateSha256(),
        };
      }
    }
  }

  /**
   * Under the rolling policy, seal the full window and start the next: the
   * within-window hash chain restarts from genesis (the event schema itself
   * caps `sequence` at the window size), and the trace carries how many
   * windows and events rolled, so the cap is never silent. Frozen policy
   * returns false — a receipt-bound run out of evidence is uncertain,
   * exactly as before.
   */
  private rollEvidenceWindow(): boolean {
    if (this.evidencePolicy === "frozen") return false;
    this.rolledWindows += 1;
    this.droppedEvidenceEvents += this.evidence.length;
    this.evidence.length = 0;
    return true;
  }

  private record(
    actionId: string,
    actionKind: GbaEmulatorEvidenceEvent["actionKind"],
    summary: string,
  ): void {
    if (this.evidence.length >= this.scenario.maxEvidenceEvents && !this.rollEvidenceWindow()) {
      this.markStateUncertain("Bounded evidence capacity was exceeded");
      throw closed("evidence_bound_exceeded");
    }
    const state = this.core.gameState();
    const base = {
      schemaVersion: 1 as const,
      sequence: this.evidence.length + 1,
      actionId,
      actionKind,
      summary: boundedSummary(summary),
      frame: state.frame,
      ramStateSha256: this.core.ramStateSha256(),
      previousEventSha256: this.evidence.at(-1)?.eventSha256 ?? GENESIS_HASH,
    };
    const event = GbaEmulatorEvidenceEventSchema.parse({
      ...base,
      eventSha256: sha256(canonicalJson(base)),
    });
    this.evidence.push(event);
  }
}

export function validateGbaEmulatorTrace(input: unknown): GbaEmulatorTrace {
  const trace = GbaEmulatorTraceSchema.parse(input);
  let previousEventSha256 = GENESIS_HASH;
  for (const [index, event] of trace.events.entries()) {
    const { eventSha256, ...base } = event;
    if (event.sequence !== index + 1) throw new Error("Emulator evidence sequence is not contiguous");
    if (event.previousEventSha256 !== previousEventSha256) {
      throw new Error("Emulator evidence hash chain is broken");
    }
    if (eventSha256 !== sha256(canonicalJson(base))) {
      throw new Error("Emulator evidence event hash is invalid");
    }
    previousEventSha256 = eventSha256;
  }
  if (trace.eventChainHeadSha256 !== previousEventSha256) {
    throw new Error("Emulator evidence chain head is invalid");
  }
  return trace;
}

function validateScenarioBinding(spec: GbaEmulatorSessionSpec, scenario: GbaAdapterScenario): void {
  if (spec.worldId !== scenario.worldId) throw new Error("Emulator world does not match the frozen scenario");
  if (spec.characterId !== scenario.player.characterId) {
    throw new Error("Emulator character does not match the frozen scenario");
  }
  const bounds = spec.resourceBounds;
  if (
    bounds.coreId !== scenario.coreId ||
    bounds.savestateId !== scenario.savestateId ||
    bounds.savestateSha256 !== scenario.savestateSha256 ||
    bounds.rngSeed !== scenario.rngSeed
  ) {
    throw new Error("Emulator determinism anchors do not match the frozen scenario");
  }
}

function enforceLimits(limits: GbaEmulatorActionLimits, bounds: GbaEmulatorResourceBounds): void {
  if (
    limits.maxInputs > bounds.maxInputsPerAction ||
    limits.maxFrames > bounds.maxFramesPerAction ||
    limits.timeoutMs > bounds.maxActionDurationMs
  ) {
    throw closed("action_limits_exceed_lease");
  }
}

function enforceCapability(action: GbaEmulatorAction, bounds: GbaEmulatorResourceBounds): void {
  const capability = (
    {
      button_press: "emulator.gba.input",
      // A route is input, so it needs the input capability and no new grant:
      // walking is a burst of the presses the session was already allowed.
      walk_to: "emulator.gba.input",
      // A conversation is a burst of A presses, by the same reasoning.
      advance_dialog: "emulator.gba.input",
      // A name is a burst of cursor moves and A presses, by the same reasoning.
      enter_text: "emulator.gba.input",
      // A menu choice is cursor presses and an A, by the same reasoning.
      select_menu_entry: "emulator.gba.input",
      frame_advance: "emulator.gba.frame_advance",
      wait: "emulator.gba.wait",
    } as const
  )[action.kind];
  if (!bounds.capabilities.includes(capability)) throw closed("capability_not_granted");
}

function logicalTimestamp(sequence: number): string {
  return new Date(Date.UTC(2026, 6, 19, 0, 0, 0, 0) + sequence * 1_000).toISOString();
}

/** Why a planned walk step did not change the tile. */
type WalkBlockReason = "npc" | "battle" | "transition";

function walkBlockReason(state: GbaCoreState): WalkBlockReason {
  if (state.mode === "battle" || state.mode === "battle_won" || state.mode === "battle_lost") {
    return "battle";
  }
  if (!(state.inputReady ?? true)) return "transition";
  return "npc";
}

function closed(code: string, detail?: string): EnvironmentAdapterActionError {
  return new EnvironmentAdapterActionError(
    code,
    // The em-dash separator is load-bearing: the free-play effect line splits
    // on it to carry this detail to the model alongside the static hint.
    `GBA emulator failed closed: ${code}${detail === undefined ? "" : ` — ${detail}`}`,
    false,
  );
}

function boundedSummary(value: string): string {
  return value.trim().slice(0, 512) || "unspecified";
}

/**
 * Whether the screen has text `advance_dialog` should read on through.
 *
 * The question is about the screen, not the mode label. A won or lost battle is
 * not a finished conversation: FireRed prints the entire aftermath — the faint,
 * the EXP, the level-up, the rival's parting line, the prize money — while the
 * mode still decodes as terminal, and that is the longest unbroken run of text
 * in the early game. Reading it as "no dialog is open" is what left a whole
 * post-battle sequence to one A press per box, at one model decision each.
 *
 * `inputReady` is what separates a live battle still printing (the field
 * callback is not running, so field input is locked) from a terminal mode
 * merely *retained* after the engine handed control back — the core keeps that
 * bookkeeping until the next press. So a stale terminal mode standing in the
 * overworld still fails closed, and never spends a stray A on whatever the
 * player happens to be facing.
 */
function isReadableText(state: GbaCoreState): boolean {
  if (state.mode === "dialog") return true;
  if (state.mode === "battle") return state.battle?.inputMode === "resolving";
  if (state.mode === "battle_won" || state.mode === "battle_lost") {
    return !(state.inputReady ?? true);
  }
  return false;
}

/** Frames per step. 16 is the documented hold that commits a move rather than a turn. */
const WALK_HOLD_FRAMES = 16;

/** Menu cursor presses are edges, not holds: short, like the naming keyboard's. */
const MENU_HOLD_FRAMES = 8;

/** A dialog advance registers on a short tap; the full step hold would waste frames. */
const DIALOG_HOLD_FRAMES = 4;

/** How long to let text print between state checks while a box is not ready. */
const DIALOG_PRINT_WAIT_FRAMES = 12;

/**
 * Frames of "open but not ready" to tolerate before pressing A anyway. Some
 * boxes never park on the wait-for-press native (signs, scripted text), and in
 * FireRed a press during printing accelerates it, so the stall-break is both
 * an escape hatch and a speed-up rather than a wasted input.
 */
const DIALOG_STALL_FRAMES = 60;

/**
 * How long a script may hold a boxless screen before advance_dialog gives up
 * on it. Ten seconds of game time covers every scripted beat the playthrough
 * has met (the starter fanfare runs about four); a hold longer than this is a
 * cutscene the driver should watch deliberately with frame_advance instead.
 */
const SCRIPT_HOLD_MAX_FRAMES = 600;

/** An 8-frame hold plus release lands exactly one naming-screen cursor step. */
const NAMING_HOLD_FRAMES = 8;

/** Frames for a press to settle before its effect is read back. */
const NAMING_SETTLE_FRAMES = 12;

/**
 * Frames after SELECT before the keyboard takes d-pad input again — the
 * page-swap animation eats presses for about thirty frames (observed twice in
 * the naming probe), so the settle stays comfortably past it.
 */
const NAMING_PAGE_SETTLE_FRAMES = 64;

/** The confirm's close callback chain runs ~37 frames; wait a little past it. */
const NAMING_CLOSE_WAIT_FRAMES = 120;

/** Ceiling on tiles explored while planning, so a large map cannot stall a turn. */
const MAX_WALK_SEARCH_TILES = 4_096;

/**
 * How many obstructions one map remembers. Roughly the number of NPCs a
 * FireRed town holds, so a route can learn a whole street without the list
 * outliving the people on it.
 */
const MAX_REMEMBERED_BLOCKED_TILES = 16;

/**
 * The same grid with `avoid`'s tiles closed, for planning only.
 *
 * A wrapper rather than a parameter on every planner: `planWalk`,
 * `planWalkBeside`, and `nearestReachableDetail` all read passability through
 * this one method, so closing a tile here reaches each of them without a
 * signature any caller has to thread through.
 */
export function avoidingGrid(grid: GbaCoreMapGrid, avoid: ReadonlySet<string> | undefined): GbaCoreMapGrid {
  if (avoid === undefined || avoid.size === 0) return grid;
  return {
    minX: grid.minX,
    minY: grid.minY,
    maxX: grid.maxX,
    maxY: grid.maxY,
    isPassable: (x, y) => !avoid.has(`${String(x)},${String(y)}`) && grid.isPassable(x, y),
  };
}

const WALK_STEPS = [
  { button: "up", dx: 0, dy: -1 },
  { button: "down", dx: 0, dy: 1 },
  { button: "left", dx: -1, dy: 0 },
  { button: "right", dx: 1, dy: 0 },
] as const;

export interface PlannedWalkStep {
  button: "up" | "down" | "left" | "right";
  x: number;
  y: number;
}

/**
 * Shortest route over passable tiles, or null when none exists.
 *
 * Breadth-first because the step cost is uniform, so the first route found is
 * the shortest and a caller never walks further than it has to. The target
 * itself must be passable: routing "as close as possible" to an unreachable
 * tile would silently answer a different question than the one asked.
 */
export function planWalk(
  grid: GbaCoreMapGrid,
  from: { x: number; y: number },
  to: { x: number; y: number },
): PlannedWalkStep[] | null {
  const inside = (x: number, y: number): boolean =>
    x >= grid.minX && y >= grid.minY && x < grid.maxX && y < grid.maxY;
  if (!inside(to.x, to.y) || !grid.isPassable(to.x, to.y)) return null;
  if (from.x === to.x && from.y === to.y) return [];

  const key = (x: number, y: number): string => `${String(x)},${String(y)}`;
  const cameFrom = new Map<string, { prev: string; step: PlannedWalkStep }>();
  const seen = new Set<string>([key(from.x, from.y)]);
  let frontier = [{ x: from.x, y: from.y }];
  let explored = 0;

  while (frontier.length > 0) {
    const next: { x: number; y: number }[] = [];
    for (const tile of frontier) {
      for (const step of WALK_STEPS) {
        const x = tile.x + step.dx;
        const y = tile.y + step.dy;
        const id = key(x, y);
        if (seen.has(id) || !inside(x, y) || !grid.isPassable(x, y)) continue;
        seen.add(id);
        cameFrom.set(id, { prev: key(tile.x, tile.y), step: { button: step.button, x, y } });
        if (x === to.x && y === to.y) {
          const path: PlannedWalkStep[] = [];
          for (let at = id; at !== key(from.x, from.y);) {
            const entry = cameFrom.get(at);
            if (entry === undefined) return null;
            path.push(entry.step);
            at = entry.prev;
          }
          return path.reverse();
        }
        next.push({ x, y });
        explored += 1;
        if (explored > MAX_WALK_SEARCH_TILES) return null;
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * A route to a passable tile beside `target`, plus the press from there into
 * it. For a warp on blocking collision — an outdoor door — this is how the
 * tile is entered: FireRed's own players-house-2f stairs behave the same way,
 * stood beside and pressed toward. Null when no adjacent tile is reachable.
 */
export function planWalkBeside(
  grid: GbaCoreMapGrid,
  from: { x: number; y: number },
  target: { x: number; y: number },
): { path: PlannedWalkStep[]; press: "up" | "down" | "left" | "right" } | null {
  let best: { path: PlannedWalkStep[]; press: "up" | "down" | "left" | "right" } | null = null;
  for (const step of WALK_STEPS) {
    const beside = { x: target.x + step.dx, y: target.y + step.dy };
    if (!grid.isPassable(beside.x, beside.y)) continue;
    const path = planWalk(grid, from, beside);
    if (path === null) continue;
    // The press walks the opposite of the offset that produced this neighbour.
    const press =
      step.button === "up"
        ? "down"
        : step.button === "down"
          ? "up"
          : step.button === "left"
            ? "right"
            : "left";
    if (best === null || path.length < best.path.length) best = { path, press };
  }
  return best;
}

/**
 * The reachable passable tile closest to an unattainable target, phrased for
 * the refusal that names it. The walk was refused because the exact question
 * had no answer; this is the nearest answerable one, offered as information
 * rather than walked to — the caller still chooses.
 */
export function nearestReachableDetail(
  grid: GbaCoreMapGrid,
  from: { x: number; y: number },
  target: { x: number; y: number },
): string {
  const inside = (x: number, y: number): boolean =>
    x >= grid.minX && y >= grid.minY && x < grid.maxX && y < grid.maxY;
  const key = (x: number, y: number): string => `${String(x)},${String(y)}`;
  const distance = (x: number, y: number): number => Math.abs(x - target.x) + Math.abs(y - target.y);
  const seen = new Set<string>([key(from.x, from.y)]);
  let frontier = [{ x: from.x, y: from.y }];
  let best = { x: from.x, y: from.y, distance: distance(from.x, from.y) };
  let explored = 0;
  while (frontier.length > 0 && explored <= MAX_WALK_SEARCH_TILES) {
    const next: { x: number; y: number }[] = [];
    for (const tile of frontier) {
      if (distance(tile.x, tile.y) < best.distance) {
        best = { x: tile.x, y: tile.y, distance: distance(tile.x, tile.y) };
      }
      for (const step of WALK_STEPS) {
        const x = tile.x + step.dx;
        const y = tile.y + step.dy;
        const id = key(x, y);
        if (seen.has(id) || !inside(x, y) || !grid.isPassable(x, y)) continue;
        seen.add(id);
        next.push({ x, y });
        explored += 1;
      }
    }
    frontier = next;
  }
  return best.x === from.x && best.y === from.y
    ? `no open tile nearer (${String(target.x)},${String(target.y)}) than where you stand is reachable`
    : `nearest reachable open tile is (${String(best.x)},${String(best.y)})`;
}

/**
 * Tiles the minimap crop extends from the player in each direction. 12 keeps
 * the whole of any indoor map and most of a town in one view while staying a
 * few hundred prompt tokens.
 */
const MINIMAP_RADIUS = 12;

export interface WalkabilityMinimap {
  topLeft: { x: number; y: number };
  rows: string[];
}

/**
 * The collision grid around the player as one character per tile: `@` the
 * player, `.` open, `#` blocked, `D` a warp tile (door, stairway, mat).
 *
 * This is the map handed to the player rather than kept for the pathfinder.
 * Without it, targets are chosen by reading a screenshot — measured on
 * 2026-08-10 at a quarter of walk actions aimed at tiles the grid already knew
 * were unreachable, each refusal answered with another guess.
 */
export function renderWalkabilityMinimap(
  grid: GbaCoreMapGrid,
  player: { x: number; y: number },
  warps: readonly { x: number; y: number }[],
): WalkabilityMinimap | null {
  const left = Math.max(grid.minX, player.x - MINIMAP_RADIUS);
  const right = Math.min(grid.maxX - 1, player.x + MINIMAP_RADIUS);
  const top = Math.max(grid.minY, player.y - MINIMAP_RADIUS);
  const bottom = Math.min(grid.maxY - 1, player.y + MINIMAP_RADIUS);
  // A player outside the loaded map (mid-transition) has no meaningful crop.
  if (left > right || top > bottom) return null;
  const warpKeys = new Set(warps.map((warp) => `${String(warp.x)},${String(warp.y)}`));
  const rows: string[] = [];
  for (let y = top; y <= bottom; y += 1) {
    let row = "";
    for (let x = left; x <= right; x += 1) {
      row +=
        x === player.x && y === player.y
          ? "@"
          : warpKeys.has(`${String(x)},${String(y)}`)
            ? "D"
            : grid.isPassable(x, y)
              ? "."
              : "#";
    }
    rows.push(row);
  }
  return { topLeft: { x: left, y: top }, rows };
}
