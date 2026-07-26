import {
  GbaEmulatorObservationSchema,
  GbaEmulatorSessionSpecSchema,
  GbaEmulatorStartActionCommandSchema,
  type EnvironmentSessionSpecV2,
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
import type { GbaAdapterScenario, GbaCoreFactory, GbaCoreMapGrid, GbaCoreSeam } from "./core-seam.ts";

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
export class GbaEmulatorAdapter implements EnvironmentAdapter {
  private readonly scenario: GbaAdapterScenario;
  private readonly fixtureSha256: string;
  private readonly coreFactory: GbaCoreFactory;
  private readonly sessions = new Map<string, GbaEmulatorSession>();

  public constructor(scenarioInput: FrozenGbaScenario, fixtureSha256: string);
  public constructor(scenarioInput: GbaAdapterScenario, fixtureSha256: string, coreFactory: GbaCoreFactory);
  public constructor(scenarioInput: GbaAdapterScenario, fixtureSha256: string, coreFactory?: GbaCoreFactory) {
    this.scenario = scenarioInput;
    if (!/^[a-f0-9]{64}$/u.test(fixtureSha256)) throw new Error("Fixture SHA-256 is invalid");
    this.fixtureSha256 = fixtureSha256;
    // The default factory is the CI test double; its constructor validates the
    // frozen-scenario savestate identity, so a scenario that is not a frozen
    // double scenario fails closed here instead of running with wrong state.
    this.coreFactory =
      coreFactory ?? ((scenario) => new DeterministicGbaCoreDouble(scenario as FrozenGbaScenario));
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
  ) {
    this.adapterSessionId = adapterSessionId;
    this.sessionId = spec.sessionId;
    this.spec = spec;
    this.scenario = scenario;
    this.fixtureSha256 = fixtureSha256;
    this.core = core;
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

  public startAction(
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
        if (this.evidence.length > this.scenario.maxEvidenceEvents - 2) {
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
      const outcome = this.apply(command.actionId, command.action.action, command.action.limits);
      const completion: EnvironmentAdapterActionCompletion = { status: "completed", outcome };
      this.completed.set(command.actionId, completion);
      return Promise.resolve(structuredClone(completion));
    } catch (error) {
      return Promise.reject(
        error instanceof EnvironmentAdapterActionError
          ? error
          : new EnvironmentAdapterActionError("emulator_rejected", "Emulator rejected the action", false),
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
      switch (kind) {
        case "overworld":
          return {
            ...base,
            kind,
            data: {
              position: state.position,
              facing: state.facing,
              surroundings: state.surroundings ?? null,
              mapSize: state.mapSize ?? null,
              ramStateSha256: this.core.ramStateSha256(),
            },
          };
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
    });
  }

  private apply(
    actionId: string,
    action: Exclude<GbaEmulatorAction, { kind: "wait" }>,
    limits: GbaEmulatorActionLimits,
  ): Record<string, unknown> {
    if (this.evidence.length >= this.scenario.maxEvidenceEvents) {
      this.markStateUncertain("Bounded evidence capacity was exceeded");
      throw closed("evidence_bound_exceeded");
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
          this.core.pressButton(action.button, action.holdFrames);
        }
        const state = this.core.gameState();
        this.record(
          actionId,
          "button_press",
          repeat === 1
            ? `Pressed ${action.button} for ${String(action.holdFrames)} frames`
            : `Pressed ${action.button} ${String(repeat)}x for ${String(action.holdFrames)} frames`,
        );
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
          ramStateSha256: this.core.ramStateSha256(),
        };
      }
      case "walk_to": {
        const grid = this.core.mapGrid?.() ?? null;
        if (grid === null) throw closed("map_grid_unavailable");
        const start = this.core.gameState();
        if (start.mode !== "overworld") throw closed("walk_requires_overworld");
        const path = planWalk(grid, start.position, { x: action.x, y: action.y });
        if (path === null) throw closed("no_path_to_target");
        // A route is a burst of presses, so it draws on the same budget one.
        if (path.length > limits.maxInputs) throw closed("input_bound_exceeded");
        if (path.length * WALK_HOLD_FRAMES > limits.maxFrames) throw closed("frame_bound_exceeded");

        let taken = 0;
        let blockedAt: { x: number; y: number } | null = null;
        let warped = false;
        for (const step of path) {
          const before = this.core.gameState();
          this.core.pressButton(step.button, WALK_HOLD_FRAMES);
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
            blockedAt = { x: step.x, y: step.y };
            break;
          }
          taken += 1;
        }

        const state = this.core.gameState();
        this.record(
          actionId,
          "walk_to",
          `Walked ${String(taken)}/${String(path.length)} steps toward (${String(action.x)}, ${String(action.y)})`,
        );
        return {
          target: { x: action.x, y: action.y },
          plannedSteps: path.length,
          steps: taken,
          arrived: !warped && blockedAt === null && state.position.x === action.x && state.position.y === action.y,
          blockedAt,
          warped,
          frame: state.frame,
          mode: state.mode,
          position: state.position,
          facing: state.facing,
          surroundings: state.surroundings ?? null,
          ramStateSha256: this.core.ramStateSha256(),
        };
      }
      case "frame_advance": {
        if (action.frames > limits.maxFrames) throw closed("frame_bound_exceeded");
        this.core.advanceFrames(action.frames);
        const state = this.core.gameState();
        this.record(actionId, "frame_advance", `Advanced ${String(action.frames)} frames`);
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

  private record(
    actionId: string,
    actionKind: GbaEmulatorEvidenceEvent["actionKind"],
    summary: string,
  ): void {
    if (this.evidence.length >= this.scenario.maxEvidenceEvents) {
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
      frame_advance: "emulator.gba.frame_advance",
      wait: "emulator.gba.wait",
    } as const
  )[action.kind];
  if (!bounds.capabilities.includes(capability)) throw closed("capability_not_granted");
}

function logicalTimestamp(sequence: number): string {
  return new Date(Date.UTC(2026, 6, 19, 0, 0, 0, 0) + sequence * 1_000).toISOString();
}

function closed(code: string): EnvironmentAdapterActionError {
  return new EnvironmentAdapterActionError(code, `GBA emulator failed closed: ${code}`, false);
}

function boundedSummary(value: string): string {
  return value.trim().slice(0, 512) || "unspecified";
}

/** Frames per step. 16 is the documented hold that commits a move rather than a turn. */
const WALK_HOLD_FRAMES = 16;

/** Ceiling on tiles explored while planning, so a large map cannot stall a turn. */
const MAX_WALK_SEARCH_TILES = 4_096;

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
          for (let at = id; at !== key(from.x, from.y); ) {
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
