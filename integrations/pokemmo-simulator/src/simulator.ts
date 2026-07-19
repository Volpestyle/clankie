import { createHash } from "node:crypto";
import {
  PokeMMOObservationSchema,
  PokeMMOSimulatorSessionSpecSchema,
  PokeMMOStartActionCommandSchema,
  type EnvironmentSessionSpecV2,
  type PokeMMOObservation,
  type PokeMMOObservationKind,
  type PokeMMOSimulatorAction,
  type PokeMMOSimulatorCapability,
  type PokeMMOSimulatorResourceBounds,
  type PokeMMOSimulatorSessionSpec,
} from "@clankie/interactive-environment";
import {
  EnvironmentAdapterActionError,
  type EnvironmentAdapter,
  type EnvironmentAdapterActionCompletion,
  type EnvironmentAdapterSession,
  type EnvironmentStartActionCommand,
} from "@clankie/environment-runtime";
import {
  FrozenPokeMMOScenarioSchema,
  PokeMMOSimulatorEvidenceEventSchema,
  PokeMMOSimulatorTraceSchema,
  type FrozenPokeMMOScenario,
  type PokeMMOSimulatorEvidenceEvent,
  type PokeMMOSimulatorTrace,
} from "./contracts.ts";

const GENESIS_HASH = "0".repeat(64);

interface SimulatorPartyMember {
  slot: number;
  creatureId: string;
  speciesId: string;
  level: number;
  currentHp: number;
  maxHp: number;
  status: "healthy" | "fainted";
  moves: { moveId: string; power: number }[];
}

interface SimulatorInventoryItem {
  itemId: string;
  count: number;
  healAmount: number;
}

interface SimulatorBattle {
  battleId: string;
  result: "active" | "won" | "lost";
  turn: number;
  opponentHp: number;
  legalMoveSelections: number;
}

interface SimulatorState {
  position: { mapId: string; x: number; y: number };
  facing: "north" | "east" | "south" | "west";
  party: SimulatorPartyMember[];
  activePartySlot: number;
  inventory: SimulatorInventoryItem[];
  battle: SimulatorBattle | null;
  menuId: string;
  menuCursor: number;
  certain: boolean;
  uncertaintyReason: string | null;
}

export interface PokeMMOSimulatorSnapshot {
  position: { mapId: string; x: number; y: number };
  activePartySlot: number;
  activePartyHp: number;
  opponentHp: number;
  battleId: string | null;
  battleResult: "not_started" | "active" | "won" | "lost";
  turn: number;
  legalMoveSelections: number;
  stateCertain: boolean;
  stateSha256: string;
}

export class PokeMMOSimulatorAdapter implements EnvironmentAdapter {
  private readonly scenario: FrozenPokeMMOScenario;
  private readonly fixtureSha256: string;
  private readonly sessions = new Map<string, PokeMMOSimulatorSession>();

  public constructor(scenarioInput: unknown, fixtureSha256: string) {
    this.scenario = FrozenPokeMMOScenarioSchema.parse(scenarioInput);
    if (!/^[a-f0-9]{64}$/u.test(fixtureSha256)) throw new Error("Fixture SHA-256 is invalid");
    this.fixtureSha256 = fixtureSha256;
  }

  public start(
    specInput: EnvironmentSessionSpecV2,
    connection: Readonly<Record<string, string>>,
  ): Promise<EnvironmentAdapterSession> {
    if (Object.keys(connection).length > 0) {
      throw new Error("PokeMMO simulator accepts no credentials or connection material");
    }
    const spec = PokeMMOSimulatorSessionSpecSchema.parse(specInput);
    validateScenarioBinding(spec, this.scenario);
    const adapterSessionId = `pokemmo-simulator:${spec.sessionId}`;
    const session = new PokeMMOSimulatorSession(adapterSessionId, spec, this.scenario, this.fixtureSha256);
    this.sessions.set(adapterSessionId, session);
    return Promise.resolve(session);
  }

  public attach(
    specInput: EnvironmentSessionSpecV2,
    adapterSessionId: string,
  ): Promise<EnvironmentAdapterSession | undefined> {
    const spec = PokeMMOSimulatorSessionSpecSchema.parse(specInput);
    const session = this.sessions.get(adapterSessionId);
    return Promise.resolve(session?.sessionId === spec.sessionId ? session : undefined);
  }

  public session(sessionId: string): PokeMMOSimulatorSession {
    const session = this.sessions.get(`pokemmo-simulator:${sessionId}`);
    if (!session) throw new Error(`Unknown PokeMMO simulator session ${sessionId}`);
    return session;
  }
}

export class PokeMMOSimulatorSession implements EnvironmentAdapterSession {
  public readonly adapterSessionId: string;
  public readonly sessionId: string;
  private readonly spec: PokeMMOSimulatorSessionSpec;
  private readonly scenario: FrozenPokeMMOScenario;
  private readonly fixtureSha256: string;
  private readonly completed = new Map<string, EnvironmentAdapterActionCompletion>();
  private readonly pendingWaits = new Set<string>();
  private readonly evidence: PokeMMOSimulatorEvidenceEvent[] = [];
  private state: SimulatorState;
  private paused = false;
  private stopped = false;

  public constructor(
    adapterSessionId: string,
    spec: PokeMMOSimulatorSessionSpec,
    scenario: FrozenPokeMMOScenario,
    fixtureSha256: string,
  ) {
    this.adapterSessionId = adapterSessionId;
    this.sessionId = spec.sessionId;
    this.spec = spec;
    this.scenario = scenario;
    this.fixtureSha256 = fixtureSha256;
    this.state = initialState(scenario);
  }

  public pause(): Promise<void> {
    this.paused = true;
    return Promise.resolve();
  }

  public resume(): Promise<void> {
    if (this.stopped) throw new Error("Simulator session is stopped");
    this.paused = false;
    return Promise.resolve();
  }

  public startAction(
    commandInput: EnvironmentStartActionCommand,
  ): Promise<EnvironmentAdapterActionCompletion | void> {
    const command = PokeMMOStartActionCommandSchema.parse(commandInput);
    if (command.sessionId !== this.sessionId) return Promise.reject(closed("session_mismatch"));
    const prior = this.completed.get(command.actionId);
    if (prior) return Promise.resolve(structuredClone(prior));
    if (this.pendingWaits.has(command.actionId)) return Promise.resolve();
    if (this.stopped) return Promise.reject(closed("session_stopped"));
    if (this.paused) return Promise.reject(closed("session_paused"));
    if (!this.state.certain) return Promise.reject(closed("uncertain_state"));
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
      if (this.evidence.length >= this.scenario.maxEvidenceEvents) {
        this.markStateUncertain("Bounded evidence capacity was exceeded");
        throw closed("evidence_bound_exceeded");
      }
      const outcome = this.apply(command.actionId, command.action.action, command.action.limits);
      const completion: EnvironmentAdapterActionCompletion = { status: "completed", outcome };
      this.completed.set(command.actionId, completion);
      return Promise.resolve(structuredClone(completion));
    } catch (error) {
      return Promise.reject(
        error instanceof EnvironmentAdapterActionError
          ? error
          : new EnvironmentAdapterActionError("simulator_rejected", "Simulator rejected the action", false),
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
    this.state.certain = false;
    this.state.uncertaintyReason = boundedSummary(reason);
  }

  public observe(kind: PokeMMOObservationKind, actionId?: string): PokeMMOObservation {
    if (!this.spec.resourceBounds.capabilities.includes("pokemmo.simulator.observe")) {
      throw closed("capability_not_granted");
    }
    const base = {
      schemaVersion: 1 as const,
      observationId: `pokemmo-observation-${String(this.evidence.length + 1)}`,
      sessionId: this.sessionId,
      characterId: this.spec.characterId,
      worldId: this.spec.worldId,
      goalVersion: this.spec.initialGoalVersion,
      capturedAt: logicalTimestamp(this.evidence.length),
    };
    const active = this.activeParty();
    const observation = (() => {
      switch (kind) {
        case "overworld":
          return {
            ...base,
            kind,
            data: {
              position: this.state.position,
              facing: this.state.facing,
              nearbyInteractables: [
                {
                  id: this.scenario.trainer.trainerId,
                  kind: "trainer" as const,
                  distance: distance(this.state.position, this.scenario.trainer.position),
                },
              ],
            },
          };
        case "menu":
          return {
            ...base,
            kind,
            data: {
              menuId: this.state.menuId,
              title: "Simulator field menu",
              choices: [
                { id: "party", label: "Party", enabled: true },
                { id: "inventory", label: "Inventory", enabled: true },
                { id: "close", label: "Close", enabled: true },
              ],
              cursor: this.state.menuCursor,
              untrusted: true as const,
            },
          };
        case "party":
          return {
            ...base,
            kind,
            data: {
              activeSlot: this.state.activePartySlot,
              members: this.state.party.map(({ moves: _moves, ...member }) => member),
            },
          };
        case "inventory":
          return {
            ...base,
            kind,
            data: { items: this.state.inventory.map(({ healAmount: _healAmount, ...item }) => item) },
          };
        case "battle": {
          const battle = this.state.battle;
          if (!battle) throw closed("battle_not_active");
          return {
            ...base,
            kind,
            data: {
              battleId: battle.battleId,
              turn: battle.turn,
              phase:
                battle.result === "active"
                  ? ("awaiting_action" as const)
                  : battle.result === "won"
                    ? ("won" as const)
                    : ("lost" as const),
              opponent: {
                trainerId: this.scenario.trainer.trainerId,
                creatureId: this.scenario.trainer.opponent.creatureId,
                speciesId: this.scenario.trainer.opponent.speciesId,
                currentHp: battle.opponentHp,
                maxHp: this.scenario.trainer.opponent.maxHp,
              },
              activePartySlot: this.state.activePartySlot,
              legalMoveIds: active.moves.map((move) => move.moveId),
              canSwitch: this.state.party.some(
                (member) => member.status !== "fainted" && member.slot !== active.slot,
              ),
              canUseItems: this.state.inventory.some((item) => item.count > 0),
              untrusted: true as const,
            },
          };
        }
        case "dialog":
          return {
            ...base,
            kind,
            data: {
              speaker: this.scenario.trainer.trainerId,
              lines: this.scenario.trainer.dialog,
              choiceIds: [],
              untrusted: true as const,
            },
          };
        case "danger":
          return {
            ...base,
            kind,
            data: this.state.certain
              ? {
                  severity: "low" as const,
                  code: "policy_boundary" as const,
                  summary: "Simulator-only session; live client actions are unavailable",
                  stateCertain: true,
                }
              : {
                  severity: "high" as const,
                  code: "uncertain_state" as const,
                  summary: this.state.uncertaintyReason ?? "Simulator state is uncertain",
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
              summary: completed ? "Simulator action completed" : "Simulator wait is pending",
            },
          };
        }
      }
    })();
    return PokeMMOObservationSchema.parse(observation);
  }

  public snapshot(): PokeMMOSimulatorSnapshot {
    const battle = this.state.battle;
    const active = this.activeParty();
    return {
      position: structuredClone(this.state.position),
      activePartySlot: this.state.activePartySlot,
      activePartyHp: active.currentHp,
      opponentHp: battle?.opponentHp ?? this.scenario.trainer.opponent.maxHp,
      battleId: battle?.battleId ?? null,
      battleResult: battle?.result ?? "not_started",
      turn: battle?.turn ?? 0,
      legalMoveSelections: battle?.legalMoveSelections ?? 0,
      stateCertain: this.state.certain,
      stateSha256: this.stateSha256(),
    };
  }

  public trace(): PokeMMOSimulatorTrace {
    return validatePokeMMOSimulatorTrace({
      schemaVersion: 1,
      scenarioId: this.scenario.scenarioId,
      scenarioVersion: this.scenario.scenarioVersion,
      fixtureSha256: this.fixtureSha256,
      eventChainHeadSha256: this.evidence.at(-1)?.eventSha256 ?? GENESIS_HASH,
      events: structuredClone(this.evidence),
    });
  }

  private apply(
    actionId: string,
    action: PokeMMOSimulatorAction,
    limits: { maxSteps: number; maxMenuChoices: number; maxBattleTurns: number; timeoutMs: number },
  ): Record<string, unknown> {
    switch (action.kind) {
      case "navigate": {
        if (!this.spec.resourceBounds.allowedMapIds.includes(action.target.mapId)) {
          throw closed("map_not_allowed");
        }
        const path = findPath(this.scenario, this.state.position, action.target);
        if (path.length > limits.maxSteps) throw closed("navigation_bound_exceeded");
        this.state.position = structuredClone(action.target);
        this.state.facing = facingForPath(path, this.state.facing);
        this.record(actionId, action.kind, `Navigated ${String(path.length)} bounded steps`);
        return { position: this.state.position, steps: path.length, stateSha256: this.stateSha256() };
      }
      case "interact": {
        if (action.targetId !== this.scenario.trainer.trainerId) throw closed("unknown_interaction_target");
        if (
          distance(this.state.position, this.scenario.trainer.position) >
          this.scenario.trainer.interactionDistance
        ) {
          throw closed("interaction_out_of_range");
        }
        if (this.state.battle?.result === "active") throw closed("battle_already_active");
        this.state.battle = {
          battleId: `${this.scenario.scenarioId}:${this.scenario.trainer.trainerId}`,
          result: "active",
          turn: 1,
          opponentHp: this.scenario.trainer.opponent.maxHp,
          legalMoveSelections: 0,
        };
        this.record(actionId, action.kind, `Entered trainer battle with ${action.targetId}`);
        return { battleId: this.state.battle.battleId, turn: 1, stateSha256: this.stateSha256() };
      }
      case "menu_choice": {
        if (limits.maxMenuChoices < 1) throw closed("menu_bound_exceeded");
        if (action.menuId !== this.state.menuId) throw closed("stale_menu");
        const choices = ["party", "inventory", "close"];
        const cursor = choices.indexOf(action.choiceId);
        if (cursor < 0) throw closed("illegal_menu_choice");
        this.state.menuCursor = cursor;
        this.record(actionId, action.kind, `Selected bounded menu choice ${action.choiceId}`);
        return { menuId: action.menuId, choiceId: action.choiceId, stateSha256: this.stateSha256() };
      }
      case "battle_move": {
        const battle = this.requireBattle(action.battleId, action.expectedTurn, limits.maxBattleTurns);
        const active = this.activeParty();
        const move = active.moves.find((candidate) => candidate.moveId === action.moveId);
        if (!move) throw closed("illegal_battle_move");
        battle.opponentHp = Math.max(0, battle.opponentHp - move.power);
        battle.legalMoveSelections += 1;
        if (battle.opponentHp === 0) battle.result = "won";
        else this.resolveOpponentTurn(battle);
        this.record(
          actionId,
          action.kind,
          `Selected legal move ${action.moveId} on turn ${String(action.expectedTurn)}`,
        );
        return {
          battleId: battle.battleId,
          result: battle.result,
          turn: battle.turn,
          opponentHp: battle.opponentHp,
          stateSha256: this.stateSha256(),
        };
      }
      case "party_switch": {
        const battle = this.requireBattle(action.battleId, action.expectedTurn, limits.maxBattleTurns);
        const selected = this.state.party.find((member) => member.slot === action.partySlot);
        if (!selected || selected.status === "fainted" || selected.slot === this.state.activePartySlot) {
          throw closed("illegal_party_switch");
        }
        this.state.activePartySlot = selected.slot;
        this.resolveOpponentTurn(battle);
        this.record(actionId, action.kind, `Switched to bounded party slot ${String(action.partySlot)}`);
        return { activePartySlot: selected.slot, turn: battle.turn, stateSha256: this.stateSha256() };
      }
      case "item_use": {
        const item = this.state.inventory.find((candidate) => candidate.itemId === action.itemId);
        const target = this.state.party.find((member) => member.slot === action.targetPartySlot);
        if (!item || item.count < 1 || !target || target.status === "fainted")
          throw closed("illegal_item_use");
        let battle: SimulatorBattle | undefined;
        if (action.battleId !== undefined && action.expectedTurn !== undefined) {
          battle = this.requireBattle(action.battleId, action.expectedTurn, limits.maxBattleTurns);
        } else if (this.state.battle?.result === "active") {
          throw closed("battle_context_required");
        }
        item.count -= 1;
        target.currentHp = Math.min(target.maxHp, target.currentHp + item.healAmount);
        if (battle) this.resolveOpponentTurn(battle);
        this.record(actionId, action.kind, `Used bounded item ${action.itemId}`);
        return {
          itemId: action.itemId,
          remaining: item.count,
          targetPartySlot: target.slot,
          targetHp: target.currentHp,
          stateSha256: this.stateSha256(),
        };
      }
      case "wait":
        throw new Error("Wait actions are handled as pending dispatches");
    }
  }

  private requireBattle(battleId: string, expectedTurn: number, maxBattleTurns: number): SimulatorBattle {
    const battle = this.state.battle;
    if (!battle || battle.result !== "active" || battle.battleId !== battleId)
      throw closed("battle_not_active");
    if (battle.turn !== expectedTurn) throw closed("stale_battle_turn");
    if (battle.turn > maxBattleTurns || battle.turn > this.spec.resourceBounds.maxBattleTurnsPerAction) {
      throw closed("battle_turn_bound_exceeded");
    }
    return battle;
  }

  private resolveOpponentTurn(battle: SimulatorBattle): void {
    const active = this.activeParty();
    active.currentHp = Math.max(0, active.currentHp - this.scenario.trainer.opponent.retaliationDamage);
    if (active.currentHp === 0) active.status = "fainted";
    if (this.state.party.every((member) => member.status === "fainted")) battle.result = "lost";
    else battle.turn += 1;
  }

  private activeParty(): SimulatorPartyMember {
    const member = this.state.party.find((candidate) => candidate.slot === this.state.activePartySlot);
    if (!member) throw new Error("Simulator active party slot is corrupt");
    return member;
  }

  private stateSha256(): string {
    return sha256(canonicalJson(this.state));
  }

  private record(
    actionId: string,
    actionKind: PokeMMOSimulatorEvidenceEvent["actionKind"],
    summary: string,
  ): void {
    if (this.evidence.length >= this.scenario.maxEvidenceEvents) {
      this.markStateUncertain("Bounded evidence capacity was exceeded");
      throw closed("evidence_bound_exceeded");
    }
    const base = {
      schemaVersion: 1 as const,
      sequence: this.evidence.length + 1,
      actionId,
      actionKind,
      summary: boundedSummary(summary),
      stateSha256: this.stateSha256(),
      previousEventSha256: this.evidence.at(-1)?.eventSha256 ?? GENESIS_HASH,
    };
    const event = PokeMMOSimulatorEvidenceEventSchema.parse({
      ...base,
      eventSha256: sha256(canonicalJson(base)),
    });
    this.evidence.push(event);
  }
}

export function validatePokeMMOSimulatorTrace(input: unknown): PokeMMOSimulatorTrace {
  const trace = PokeMMOSimulatorTraceSchema.parse(input);
  let previousEventSha256 = GENESIS_HASH;
  for (const [index, event] of trace.events.entries()) {
    const { eventSha256, ...base } = event;
    if (event.sequence !== index + 1) throw new Error("Simulator evidence sequence is not contiguous");
    if (event.previousEventSha256 !== previousEventSha256) {
      throw new Error("Simulator evidence hash chain is broken");
    }
    if (eventSha256 !== sha256(canonicalJson(base))) {
      throw new Error("Simulator evidence event hash is invalid");
    }
    previousEventSha256 = eventSha256;
  }
  if (trace.eventChainHeadSha256 !== previousEventSha256) {
    throw new Error("Simulator evidence chain head is invalid");
  }
  return trace;
}

function initialState(scenario: FrozenPokeMMOScenario): SimulatorState {
  return {
    position: structuredClone(scenario.player.start),
    facing: "east",
    party: scenario.player.party.map((member) => ({
      ...structuredClone(member),
      currentHp: member.maxHp,
      status: "healthy",
    })),
    activePartySlot: scenario.player.party[0]!.slot,
    inventory: structuredClone(scenario.player.inventory),
    battle: null,
    menuId: "field-menu",
    menuCursor: 0,
    certain: true,
    uncertaintyReason: null,
  };
}

function validateScenarioBinding(spec: PokeMMOSimulatorSessionSpec, scenario: FrozenPokeMMOScenario): void {
  if (spec.worldId !== scenario.worldId)
    throw new Error("Simulator world does not match the frozen scenario");
  if (spec.characterId !== scenario.player.characterId) {
    throw new Error("Simulator character does not match the frozen scenario");
  }
  if (spec.resourceBounds.simulatorId !== scenario.simulatorId) {
    throw new Error("Simulator id does not match the frozen scenario");
  }
  if (!spec.resourceBounds.allowedMapIds.includes(scenario.map.mapId)) {
    throw new Error("Frozen scenario map is outside the simulator bounds");
  }
}

function enforceLimits(
  limits: { maxSteps: number; maxMenuChoices: number; maxBattleTurns: number; timeoutMs: number },
  bounds: PokeMMOSimulatorResourceBounds,
): void {
  if (
    limits.maxSteps > bounds.maxNavigationStepsPerAction ||
    limits.maxMenuChoices > bounds.maxMenuChoicesPerAction ||
    limits.maxBattleTurns > bounds.maxBattleTurnsPerAction ||
    limits.timeoutMs > bounds.maxActionDurationMs
  ) {
    throw closed("action_limits_exceed_lease");
  }
}

function enforceCapability(action: PokeMMOSimulatorAction, bounds: PokeMMOSimulatorResourceBounds): void {
  const capability: PokeMMOSimulatorCapability = (
    {
      navigate: "pokemmo.simulator.navigate",
      interact: "pokemmo.simulator.interact",
      menu_choice: "pokemmo.simulator.menu",
      battle_move: "pokemmo.simulator.battle",
      party_switch: "pokemmo.simulator.party",
      item_use: "pokemmo.simulator.inventory",
      wait: "pokemmo.simulator.wait",
    } as const
  )[action.kind];
  if (!bounds.capabilities.includes(capability)) throw closed("capability_not_granted");
}

function findPath(
  scenario: FrozenPokeMMOScenario,
  start: { mapId: string; x: number; y: number },
  target: { mapId: string; x: number; y: number },
): { x: number; y: number }[] {
  if (start.mapId !== target.mapId || target.mapId !== scenario.map.mapId)
    throw closed("cross_map_navigation_denied");
  if (target.x >= scenario.map.width || target.y >= scenario.map.height) throw closed("target_out_of_bounds");
  const blocked = new Set(scenario.map.blocked.map((point) => `${String(point.x)},${String(point.y)}`));
  if (blocked.has(`${String(target.x)},${String(target.y)}`)) throw closed("target_blocked");
  const queue: { x: number; y: number; path: { x: number; y: number }[] }[] = [
    { x: start.x, y: start.y, path: [] },
  ];
  const seen = new Set([`${String(start.x)},${String(start.y)}`]);
  const directions = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
    { x: 0, y: -1 },
  ];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.x === target.x && current.y === target.y) return current.path;
    for (const direction of directions) {
      const next = { x: current.x + direction.x, y: current.y + direction.y };
      const key = `${String(next.x)},${String(next.y)}`;
      if (
        next.x < 0 ||
        next.y < 0 ||
        next.x >= scenario.map.width ||
        next.y >= scenario.map.height ||
        blocked.has(key) ||
        seen.has(key)
      ) {
        continue;
      }
      seen.add(key);
      queue.push({ ...next, path: [...current.path, next] });
    }
  }
  throw closed("path_not_found");
}

function facingForPath(
  path: { x: number; y: number }[],
  fallback: "north" | "east" | "south" | "west",
): "north" | "east" | "south" | "west" {
  if (path.length < 2) return fallback;
  const previous = path.at(-2)!;
  const last = path.at(-1)!;
  if (last.x > previous.x) return "east";
  if (last.x < previous.x) return "west";
  if (last.y > previous.y) return "south";
  return "north";
}

function distance(
  left: { mapId: string; x: number; y: number },
  right: { mapId: string; x: number; y: number },
): number {
  return left.mapId === right.mapId ? Math.abs(left.x - right.x) + Math.abs(left.y - right.y) : 1_024;
}

function logicalTimestamp(sequence: number): string {
  return new Date(Date.UTC(2026, 6, 19, 0, 0, sequence)).toISOString();
}

function closed(code: string): EnvironmentAdapterActionError {
  return new EnvironmentAdapterActionError(code, `PokeMMO simulator failed closed: ${code}`, false);
}

function boundedSummary(value: string): string {
  return value.trim().slice(0, 512) || "unspecified";
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
