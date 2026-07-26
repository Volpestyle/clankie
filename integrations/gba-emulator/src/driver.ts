import { EnvironmentAdapterActionError } from "@clankie/environment-runtime";
import type {
  EnvironmentActionResult,
  GbaEmulatorAction,
  GbaEmulatorObservation,
  GbaEmulatorObservationKind,
} from "@clankie/interactive-environment";
import {
  GbaDecisionTraceSchema,
  type FrozenGbaScenario,
  type GbaDecisionTrace,
  type GbaDriverDecision,
  type GbaDriverReasonCode,
} from "./contracts.ts";

/**
 * State-derived scenario driver. Every decision below is a pure function of
 * the latest observations pulled from the governed session — there is no
 * phase script, no prerecorded input transcript, and no fabricated failure:
 * change the observed position, cursor, or battle phase and the decision
 * changes with it. All acting flows through the `act` handle, which the
 * scenario runner binds to `EnvironmentRuntime.startAction`, so idempotency,
 * leases, pause/cancel, and emergency stop are inherited, never reimplemented.
 */

export interface GbaDriverIo {
  observe(kind: GbaEmulatorObservationKind): GbaEmulatorObservation;
  act(action: GbaEmulatorAction): Promise<EnvironmentActionResult>;
  pause(reason: string): Promise<void>;
  /** Undo a pause. A safety pause must be reversible by the mind that judged the state safe again. */
  resume(): Promise<void>;
}

export interface GbaDriverView {
  danger: Extract<GbaEmulatorObservation, { kind: "danger" }>;
  overworld: Extract<GbaEmulatorObservation, { kind: "overworld" }>;
  battle: Extract<GbaEmulatorObservation, { kind: "battle" }> | null;
  dialog: Extract<GbaEmulatorObservation, { kind: "dialog" }> | null;
  menu?: Extract<GbaEmulatorObservation, { kind: "menu" }> | null;
}

export interface GbaDriverChoice {
  reasonCode: GbaDriverReasonCode;
  action?: GbaEmulatorAction;
}

const PRESS: Pick<Extract<GbaEmulatorAction, { kind: "button_press" }>, "kind" | "holdFrames"> = {
  kind: "button_press",
  holdFrames: 12,
};

/** Pure decision function: latest observed state in, one bounded input out. */
export function decideNextGbaAction(view: GbaDriverView, scenario: FrozenGbaScenario): GbaDriverChoice {
  if (!view.danger.data.stateCertain) return { reasonCode: "halt_uncertain_state" };
  if (view.battle) {
    if (view.battle.data.phase === "won") return { reasonCode: "halt_battle_won" };
    if (view.battle.data.phase === "lost") return { reasonCode: "halt_uncertain_state" };
    if (view.battle.data.phase === "resolving") {
      return {
        reasonCode: "wait_battle_resolution",
        action: { ...PRESS, button: "a" },
      };
    }
    if (view.menu?.data.menuId === "battle-action-menu") {
      const cursor = view.menu.data.cursor;
      if (cursor !== 0) {
        return {
          reasonCode: "move_action_cursor_to_fight",
          action: { ...PRESS, button: cursor & 2 ? "up" : "left" },
        };
      }
      return { reasonCode: "select_fight", action: { ...PRESS, button: "a" } };
    }
    const moves = view.battle.data.legalMoves;
    let bestIndex = 0;
    for (const [index, move] of moves.entries()) {
      if (move.power > moves[bestIndex]!.power) bestIndex = index;
    }
    const cursor = view.battle.data.moveCursor;
    if (cursor !== bestIndex) {
      const button =
        view.menu?.data.menuId === "battle-move-menu"
          ? gridDirection(cursor, bestIndex)
          : cursor < bestIndex
            ? "down"
            : "up";
      return { reasonCode: "move_cursor_to_best_move", action: { ...PRESS, button } };
    }
    return { reasonCode: "select_best_move", action: { ...PRESS, button: "a" } };
  }
  if (view.dialog) return { reasonCode: "advance_dialog", action: { ...PRESS, button: "a" } };
  if (view.menu) return { reasonCode: "close_incidental_menu", action: { ...PRESS, button: "b" } };
  const position = view.overworld.data.position;
  const target = scenario.targetLocation;
  if (position.x === target.x && position.y === target.y) {
    return { reasonCode: "engage_trainer", action: { ...PRESS, button: "a" } };
  }
  const step = nextRouteStep(scenario, position);
  return { reasonCode: "route_step_toward_target", action: { ...PRESS, button: step } };
}

export interface GbaDriveResult {
  halt: "battle_won" | "uncertain_state" | "action_failed" | "decision_budget_exhausted";
  decisionTrace: GbaDecisionTrace;
}

export async function driveGbaScenario(
  io: GbaDriverIo,
  scenario: FrozenGbaScenario,
  fixtureSha256: string,
): Promise<GbaDriveResult> {
  const decisions: GbaDriverDecision[] = [];
  let halt: GbaDriveResult["halt"] = "decision_budget_exhausted";
  for (let sequence = 1; sequence <= scenario.maxDecisions; sequence += 1) {
    const view = observeView(io);
    const anchor = view.overworld;
    const choice = decideNextGbaAction(view, scenario);
    decisions.push({
      schemaVersion: 1,
      sequence,
      observedKind: view.battle ? "battle" : view.dialog ? "dialog" : "overworld",
      observedFrame: anchor.frame,
      observedRamStateSha256: anchor.data.ramStateSha256,
      reasonCode: choice.reasonCode,
      ...(choice.action === undefined ? {} : { action: choice.action }),
    });
    if (choice.reasonCode === "halt_battle_won") {
      halt = "battle_won";
      break;
    }
    if (choice.reasonCode === "halt_uncertain_state" || choice.action === undefined) {
      await io.pause("uncertain emulator state: failing closed instead of replaying input");
      halt = "uncertain_state";
      break;
    }
    const result = await io.act(choice.action);
    if (result.status !== "completed") {
      await io.pause(`emulator action ${result.actionId} ended ${result.status}: failing closed`);
      halt = "action_failed";
      break;
    }
    // Verify the act was applied before deciding again: the emulator frame
    // counter must have advanced past the observed anchor. A stale frame means
    // the observation stream cannot be trusted, so fail closed instead of
    // pressing again blind.
    const verify = io.observe("overworld");
    if (verify.kind !== "overworld" || verify.frame <= anchor.frame) {
      await io.pause("emulator frame did not advance after input: failing closed");
      halt = "uncertain_state";
      break;
    }
  }
  return {
    halt,
    decisionTrace: GbaDecisionTraceSchema.parse({
      schemaVersion: 1,
      scenarioId: scenario.scenarioId,
      scenarioVersion: scenario.scenarioVersion,
      fixtureSha256,
      decisions,
    }),
  };
}

function observeView(io: GbaDriverIo): GbaDriverView {
  const danger = narrow(io.observe("danger"), "danger");
  const overworld = narrow(io.observe("overworld"), "overworld");
  const battle = tryObserve(io, "battle");
  const dialog = battle ? null : tryObserve(io, "dialog");
  const menu = tryObserveMenu(io);
  return {
    danger,
    overworld,
    battle: battle ? narrow(battle, "battle") : null,
    dialog: dialog ? narrow(dialog, "dialog") : null,
    menu: menu ? narrow(menu, "menu") : null,
  };
}

function tryObserve(io: GbaDriverIo, kind: "battle" | "dialog"): GbaEmulatorObservation | null {
  try {
    return io.observe(kind);
  } catch (error) {
    if (
      error instanceof EnvironmentAdapterActionError &&
      (error.errorCode === "battle_not_active" || error.errorCode === "dialog_not_open")
    ) {
      return null;
    }
    throw error;
  }
}

function tryObserveMenu(io: GbaDriverIo): GbaEmulatorObservation | null {
  try {
    return io.observe("menu");
  } catch (error) {
    if (error instanceof EnvironmentAdapterActionError && error.errorCode === "menu_not_open") {
      return null;
    }
    throw error;
  }
}

function gridDirection(cursor: number, target: number): "up" | "down" | "left" | "right" {
  if ((cursor & 2) !== (target & 2)) return target & 2 ? "down" : "up";
  return target & 1 ? "right" : "left";
}

function narrow<Kind extends GbaEmulatorObservationKind>(
  observation: GbaEmulatorObservation,
  kind: Kind,
): Extract<GbaEmulatorObservation, { kind: Kind }> {
  if (observation.kind !== kind) throw new Error(`Expected a ${kind} observation`);
  return observation as Extract<GbaEmulatorObservation, { kind: Kind }>;
}

/** One BFS step over the frozen map from the currently observed position. */
function nextRouteStep(
  scenario: FrozenGbaScenario,
  position: { mapId: string; x: number; y: number },
): "up" | "down" | "left" | "right" {
  if (position.mapId !== scenario.map.mapId) throw new Error("Observed position left the frozen map");
  const target = scenario.targetLocation;
  const blocked = new Set(scenario.map.blocked.map((point) => `${String(point.x)},${String(point.y)}`));
  blocked.add(`${String(scenario.trainer.position.x)},${String(scenario.trainer.position.y)}`);
  const directions = [
    { button: "right" as const, dx: 1, dy: 0 },
    { button: "down" as const, dx: 0, dy: 1 },
    { button: "left" as const, dx: -1, dy: 0 },
    { button: "up" as const, dx: 0, dy: -1 },
  ];
  const queue: { x: number; y: number; first: "up" | "down" | "left" | "right" | null }[] = [
    { x: position.x, y: position.y, first: null },
  ];
  const seen = new Set([`${String(position.x)},${String(position.y)}`]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.x === target.x && current.y === target.y && current.first) return current.first;
    for (const direction of directions) {
      const next = { x: current.x + direction.dx, y: current.y + direction.dy };
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
      queue.push({ ...next, first: current.first ?? direction.button });
    }
  }
  throw new Error("No route to the frozen scenario target exists from the observed position");
}
