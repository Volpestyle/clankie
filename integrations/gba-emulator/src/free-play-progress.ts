import type { GbaEmulatorAction, GbaEmulatorObservation } from "@clankie/interactive-environment";

/**
 * What actually happened, and whether he is getting anywhere.
 *
 * The loop previously reported `accepted` for every dispatched action, which
 * means "the adapter took the button" and not "anything changed". A model that
 * walks into a desk was told `accepted` and had to re-derive from coordinates
 * that it was stuck — so it walked into the desk again. This module turns each
 * action into an observed effect, remembers which directed moves the emulator
 * refused, and measures whether the playthrough is progressing at all.
 *
 * It reads observations. It never suggests a move: the refused-transition set
 * is memory of what he tried, not a route.
 */

export interface GbaPosition {
  mapId: string;
  x: number;
  y: number;
}

export interface LearnedTransition {
  from: GbaPosition;
  facing: string | null;
  action: GbaEmulatorAction;
  to: GbaPosition;
}

/** Extract the overworld position, when the decoded state carries one. */
export function positionOf(observations: readonly GbaEmulatorObservation[]): GbaPosition | null {
  for (const observation of observations) {
    if (observation.kind !== "overworld") continue;
    const position = (observation as unknown as { data?: { position?: GbaPosition } }).data?.position;
    if (position === undefined) continue;
    return { mapId: position.mapId, x: position.x, y: position.y };
  }
  return null;
}

/** Extract which way he is facing, which distinguishes a turn from a wall. */
export function facingOf(observations: readonly GbaEmulatorObservation[]): string | null {
  for (const observation of observations) {
    if (observation.kind !== "overworld") continue;
    const facing = (observation as unknown as { data?: { facing?: string } }).data?.facing;
    if (facing !== undefined) return facing;
  }
  return null;
}

/** Compass name for a directional button, so facing and buttons compare. */
const FACING_FOR_BUTTON: Readonly<Record<string, string>> = {
  up: "north",
  down: "south",
  left: "west",
  right: "east",
};

function firstOfKind(
  observations: readonly GbaEmulatorObservation[],
  kind: GbaEmulatorObservation["kind"],
): GbaEmulatorObservation | null {
  return observations.find((observation) => observation.kind === kind) ?? null;
}

function heldScreenOf(observations: readonly GbaEmulatorObservation[]): "battle" | "transition" | null {
  const data = (
    firstOfKind(observations, "scene") as unknown as {
      data?: { mode?: string; inputReady?: boolean };
    } | null
  )?.data;
  if (data === undefined) return null;
  if (data.mode === "battle" || data.mode === "battle_won" || data.mode === "battle_lost") return "battle";
  if (data.inputReady === false) return "transition";
  return null;
}

const DIRECTIONS = new Set(["up", "down", "left", "right"]);

/** The direction a button press attempted, or null for a non-directional action. */
export function attemptedDirection(action: GbaEmulatorAction): string | null {
  if (action.kind !== "button_press") return null;
  return DIRECTIONS.has(action.button) ? action.button : null;
}

/** How much read-back text a single turn's effect line may carry. */
const DIALOG_TRANSCRIPT_LIMIT = 600;

/**
 * An effect line split by who it is for.
 *
 * `summary` is what happened. `advice` is the harness coaching his next
 * decision — second person, imperative, written for the player and nobody
 * else. Both reach the mind; only `summary` crosses the play voice seam to a
 * voice room, because a persona handed "hold the direction longer" relays it
 * at the people watching and ends up directing a game none of them is
 * playing. ADR 0074's seam carries the moment, not the tutor.
 */
export interface Described {
  readonly summary: string;
  readonly advice?: string;
}

/** Build a `Described` under `exactOptionalPropertyTypes`. */
export function described(summary: string, advice?: string | undefined): Described {
  return advice === undefined || advice.length === 0 ? { summary } : { summary, advice };
}

/** The one line the mind reads: what happened, then what to do about it. */
export function mindEffectLine(effect: Described): string {
  return effect.advice === undefined ? effect.summary : `${effect.summary}; ${effect.advice}`;
}

const DIALOG_ENDINGS: Readonly<Record<string, Described>> = {
  dialog_closed: { summary: "the text ended" },
  choice_open: { summary: "a choice is waiting", advice: "answer it" },
  battle_started: { summary: "a battle started" },
  battle_ended: { summary: "the battle ended" },
  script_released: {
    summary: "the script let go without more text",
    advice: "you have control again",
  },
  script_holding: {
    summary: "a script still holds the screen with no readable box",
    advice: "it may need more time",
  },
  input_bound_reached: { summary: "the input budget ran out", advice: "more text remains" },
  frame_bound_reached: { summary: "the frame budget ran out", advice: "more text remains" },
  choice_unlisted: {
    summary: "the box did not advance",
    advice:
      "a Yes/No or list the decoder does not list is probably waiting; look at the frame and press A, not select_menu_entry",
  },
};

function describeDialogAdvance(outcome: Record<string, unknown> | undefined): Described {
  const transcript = Array.isArray(outcome?.transcript)
    ? outcome.transcript.filter((line): line is string => typeof line === "string")
    : [];
  const ending = typeof outcome?.endedBecause === "string" ? outcome.endedBecause : null;
  const reason =
    ending === null ? { summary: "the dialog stopped" } : (DIALOG_ENDINGS[ending] ?? { summary: ending });
  if (transcript.length === 0) return described(`read no new text — ${reason.summary}`, reason.advice);
  // Oldest boxes drop first: the last thing said is the part still in play.
  let text = transcript.join(" / ");
  while (text.length > DIALOG_TRANSCRIPT_LIMIT && transcript.length > 1) {
    transcript.shift();
    text = `… / ${transcript.join(" / ")}`;
  }
  return described(`read: "${text.slice(0, DIALOG_TRANSCRIPT_LIMIT)}" — ${reason.summary}`, reason.advice);
}

function walkStopReason(outcome: Record<string, unknown>): "battle" | "transition" | "npc" | "unknown" {
  const named = outcome["blockedBecause"];
  if (named === "battle" || named === "transition" || named === "npc") return named;
  const mode = outcome["mode"];
  if (mode === "battle" || mode === "battle_won" || mode === "battle_lost") return "battle";
  if (outcome["inputReady"] === false) return "transition";
  return "unknown";
}

/** Bounded walk summary from the adapter's own account of the route. */
function describeWalk(
  action: { x: number; y: number },
  outcome: Record<string, unknown>,
  before: GbaPosition | null,
  after: GbaPosition | null,
): Described {
  const steps = typeof outcome["steps"] === "number" ? String(outcome["steps"]) : null;
  const planned = typeof outcome["plannedSteps"] === "number" ? String(outcome["plannedSteps"]) : null;
  const blocked = outcome["blockedAt"] as { x?: number; y?: number } | null | undefined;
  if (
    (outcome["warped"] === true || (before !== null && after !== null && before.mapId !== after.mapId)) &&
    after !== null
  ) {
    return described(
      `${steps === null ? "walked to the exit" : `walked onto an exit after ${steps} steps`} — ` +
        `entered ${after.mapId} at (${String(after.x)},${String(after.y)})`,
    );
  }
  if (outcome["arrived"] === true || (after?.x === action.x && after.y === action.y)) {
    if (before?.x === action.x && before.y === action.y && outcome["inputsSpent"] === 0) {
      return described(`already at (${String(action.x)},${String(action.y)})`);
    }
    return described(
      steps === null
        ? `arrived at (${String(action.x)},${String(action.y)})`
        : `walked ${steps} steps and arrived at (${String(action.x)},${String(action.y)})`,
    );
  }
  if (blocked != null && typeof blocked.x === "number" && typeof blocked.y === "number") {
    const at = `(${String(blocked.x)},${String(blocked.y)})`;
    const reason = walkStopReason(outcome);
    if (reason === "battle") {
      return described(
        `${routeProgress(steps, planned)}, then a battle started at ${at}`,
        "use advance_dialog to read the intro; it stops at the command menu",
      );
    }
    if (reason === "transition") {
      return described(
        `${routeProgress(steps, planned)}, then a transition held the screen at ${at}`,
        "wait it out rather than stepping again",
      );
    }
    if (reason === "npc") {
      return described(
        `${routeProgress(steps, planned)}, then the way was blocked at ${at} by an NPC`,
        "step around it or talk to it",
      );
    }
    return described(
      `${routeProgress(steps, planned)}, then the route stopped before ${at}; the adapter did not verify why`,
      "check occupants before calling it a person, then try another approach",
    );
  }
  if (after !== null) {
    return described(
      `walk toward (${String(action.x)},${String(action.y)}) stopped at (${String(after.x)},${String(after.y)})`,
    );
  }
  return described(`walk toward (${String(action.x)},${String(action.y)}) completed; position unavailable`);
}

function routeProgress(steps: string | null, planned: string | null): string {
  return steps === null || planned === null ? "the walk stopped" : `walked ${steps} of ${planned} steps`;
}

const ENTER_TEXT_ENDINGS: Readonly<Record<string, Described>> = {
  confirmed: { summary: "confirmed — the screen closed" },
  typed: { summary: "typed and left open, as asked" },
  screen_closed: { summary: "the naming screen closed before typing finished" },
  input_not_registered: {
    summary: "a press stopped registering; the entry stopped rather than guess",
  },
  input_bound_reached: {
    summary: "the input budget ran out mid-entry",
    advice: "repeat the action to continue",
  },
  frame_bound_reached: {
    summary: "the frame budget ran out mid-entry",
    advice: "repeat the action to continue",
  },
};

/** Bounded entry summary from the adapter's own account of the typing. */
function describeEnterText(text: string, outcome: Record<string, unknown> | undefined): Described {
  const typed = typeof outcome?.["typed"] === "string" ? outcome["typed"] : "";
  const ending = typeof outcome?.["endedBecause"] === "string" ? outcome["endedBecause"] : null;
  const reason =
    ending === null ? { summary: "the entry ended" } : (ENTER_TEXT_ENDINGS[ending] ?? { summary: ending });
  if (outcome?.["confirmed"] === true) return described(`named "${text}" — ${reason.summary}`, reason.advice);
  return described(`typed "${typed}" of "${text}" — ${reason.summary}`, reason.advice);
}

const SELECT_MENU_ENDINGS: Readonly<Record<string, Described>> = {
  menu_closed: { summary: "the menu closed before the cursor arrived" },
  cursor_stalled: {
    summary: "the cursor refused to move",
    advice: "steer this menu with single presses",
  },
  input_bound_reached: { summary: "the input budget ran out before the cursor arrived" },
  frame_bound_reached: { summary: "the frame budget ran out before the cursor arrived" },
};

/** Bounded choice summary from the adapter's own account of the selection. */
function describeSelectMenuEntry(outcome: Record<string, unknown> | undefined): Described {
  const label = typeof outcome?.["label"] === "string" ? outcome["label"] : "an entry";
  const menuId = typeof outcome?.["menuId"] === "string" ? outcome["menuId"] : "the menu";
  if (outcome?.["confirmed"] === true) return described(`chose "${label.slice(0, 120)}" in ${menuId}`);
  const ending = typeof outcome?.["endedBecause"] === "string" ? outcome["endedBecause"] : null;
  const reason =
    ending === null
      ? { summary: "the selection stopped" }
      : (SELECT_MENU_ENDINGS[ending] ?? { summary: ending });
  return described(`did not choose "${label.slice(0, 120)}" — ${reason.summary}`, reason.advice);
}

export interface ObservedEffect extends Described {
  /** A directed move the emulator refused, for the blocked-transition memory. */
  refused: { position: GbaPosition; direction: string } | null;
  position: GbaPosition | null;
  enteredMap: boolean;
}

/**
 * Whether the body decoded any state this turn, or null when it did not say.
 *
 * `danger.stateCertain` is what both bodies publish for this, so an effect can
 * tell "the decoder saw nothing change" apart from "there was no decoder
 * output to change".
 */
function decoded(observations: readonly GbaEmulatorObservation[]): boolean | null {
  const danger = observations.find((observation) => observation.kind === "danger") as
    | { data?: { stateCertain?: boolean } }
    | undefined;
  return danger?.data?.stateCertain ?? null;
}

/** Bounded "menuId: selected entry" line, so a menu effect names the menu. */
function describeMenu(observation: GbaEmulatorObservation | null): string {
  const data = (
    observation as unknown as {
      data?: { menuId?: string; cursor?: number; entries?: { label?: string }[] };
    } | null
  )?.data;
  if (data?.menuId === undefined) return "a menu";
  const selected = data.entries?.[data.cursor ?? 0]?.label;
  return selected === undefined ? data.menuId : `${data.menuId}: ${selected.slice(0, 120)}`;
}

/**
 * Diff the state before and after an action.
 *
 * Reporting "position unchanged" is the whole point: a refusal is information,
 * and the model can only route around furniture it knows it hit.
 */
export function observeEffect(input: {
  before: readonly GbaEmulatorObservation[];
  after: readonly GbaEmulatorObservation[];
  action: GbaEmulatorAction;
  /** The adapter's action result, when it carries more than the diff can see. */
  outcome?: Record<string, unknown> | undefined;
  /**
   * Whether the rendered frame's digest changed across this action, or null
   * when the core exposes no framebuffer. The decoded RAM surface is
   * deliberately narrow, so the frame gets the last word: "no visible change"
   * is only claimed when the screen itself stood still.
   */
  screenChanged?: boolean | null;
}): ObservedEffect {
  const before = positionOf(input.before);
  const after = positionOf(input.after);
  const direction = attemptedDirection(input.action);
  const menuBefore = firstOfKind(input.before, "menu");
  const menuAfter = firstOfKind(input.after, "menu");
  // An open menu owns the d-pad: presses move its cursor, not the character.
  // Judging them as walking is how the naming screen minted fake walls.
  const menuOpen = menuBefore !== null || menuAfter !== null;

  // A dialog advance is the one action whose result is not visible in the
  // after-state: the boxes it read are gone by the time the diff runs, so the
  // text has to come from the outcome or it is lost to him entirely.
  if (input.action.kind === "advance_dialog") {
    return {
      ...describeDialogAdvance(input.outcome),
      refused: null,
      position: after,
      enteredMap: before !== null && after !== null && before.mapId !== after.mapId,
    };
  }

  // A typed name's outcome carries what landed and whether it was confirmed —
  // none of which the decoded overworld diff can see.
  if (input.action.kind === "enter_text") {
    return {
      ...describeEnterText(input.action.text, input.outcome),
      refused: null,
      position: after,
      enteredMap: false,
    };
  }

  // A menu choice's outcome knows which entry was confirmed and why the
  // cursor stopped when it was not — the diff alone reads as "menu changed".
  if (input.action.kind === "select_menu_entry") {
    return {
      ...describeSelectMenuEntry(input.outcome),
      refused: null,
      position: after,
      enteredMap: false,
    };
  }

  // A walk's outcome knows more than the position diff: whether the route
  // finished, and where it stopped if the world got in the way. "moved to
  // (x,y)" after a 3-of-9-step walk would hide exactly the part he needs.
  if (input.action.kind === "walk_to" && input.outcome !== undefined) {
    return {
      ...describeWalk(input.action, input.outcome, before, after),
      refused: null,
      position: after,
      enteredMap: before !== null && after !== null && before.mapId !== after.mapId,
    };
  }

  if (before !== null && after !== null) {
    if (before.mapId !== after.mapId) {
      return {
        summary: `entered ${after.mapId} at (${String(after.x)},${String(after.y)})`,
        refused: null,
        position: after,
        enteredMap: true,
      };
    }
    if (before.x !== after.x || before.y !== after.y) {
      return {
        summary: `moved to (${String(after.x)},${String(after.y)})`,
        refused: null,
        position: after,
        enteredMap: false,
      };
    }
    if (direction !== null && !menuOpen) {
      // A short directional tap turns the character to face that way without
      // stepping. Calling that "blocked" invents a wall and poisons the refusal
      // memory, so a turn is reported as a turn — the tile stays unjudged.
      const facingBefore = facingOf(input.before);
      const facingAfter = facingOf(input.after);
      if (facingAfter !== null && facingAfter !== facingBefore) {
        return {
          summary: `turned to face ${facingAfter} without stepping`,
          advice: "hold the direction longer to move",
          refused: null,
          position: after,
          enteredMap: false,
        };
      }
      // Already facing that way and still did not move: a real obstacle —
      // unless the scene says the screen left the overworld.
      if (facingAfter === null || facingAfter === FACING_FOR_BUTTON[direction]) {
        const held = heldScreenOf(input.after);
        if (held === "battle") {
          return { summary: "a battle started", refused: null, position: after, enteredMap: false };
        }
        if (held === "transition") {
          return {
            summary: "a transition is holding the screen",
            advice: "wait it out rather than pressing into it",
            refused: null,
            position: after,
            enteredMap: false,
          };
        }
        return {
          summary: `position unchanged — ${direction} is blocked from (${String(before.x)},${String(before.y)})`,
          refused: { position: before, direction },
          position: after,
          enteredMap: false,
        };
      }
      return {
        summary: `position unchanged after ${direction}`,
        refused: null,
        position: after,
        enteredMap: false,
      };
    }
  }

  // Non-movement effects worth naming, so a dialog or menu step does not read
  // as "nothing happened".
  const dialogBefore = firstOfKind(input.before, "dialog");
  const dialogAfter = firstOfKind(input.after, "dialog");
  if (JSON.stringify(dialogBefore) !== JSON.stringify(dialogAfter)) {
    return { summary: "dialog changed", refused: null, position: after, enteredMap: false };
  }
  if (JSON.stringify(menuBefore) !== JSON.stringify(menuAfter)) {
    const summary =
      menuAfter === null
        ? "menu closed"
        : `${menuBefore === null ? "menu opened" : "menu changed"} — ${describeMenu(menuAfter)}`;
    return { summary, refused: null, position: after, enteredMap: false };
  }
  const battleBefore = firstOfKind(input.before, "battle");
  const battleAfter = firstOfKind(input.after, "battle");
  if (JSON.stringify(battleBefore) !== JSON.stringify(battleAfter)) {
    return { summary: "battle state changed", refused: null, position: after, enteredMap: false };
  }

  if (
    input.action.kind === "button_press" &&
    input.action.button === "a" &&
    before !== null &&
    after !== null &&
    dialogBefore === null &&
    dialogAfter === null &&
    menuBefore === null &&
    menuAfter === null &&
    battleBefore === null &&
    battleAfter === null &&
    heldScreenOf(input.after) === null
  ) {
    return {
      summary: "A opened no dialog or menu",
      advice:
        input.screenChanged === true
          ? "the frame changed, but this did not reach a readable interaction"
          : "this did not reach a readable interaction",
      refused: null,
      position: after,
      enteredMap: false,
    };
  }

  // The frame digest catches what the decoded surface misses — a naming-screen
  // cursor, a page-swap animation. Without it, this branch told him "no
  // visible change" while the screen visibly moved, and he had to learn to
  // distrust his own effect line.
  if (input.screenChanged === true) {
    // "though the decoded state did not" is a comparison, and a comparison
    // needs two sides. On a screen that decodes to nothing — a boot sequence,
    // an intro, a help page — there is no decoded state to have stood still,
    // so the sentence reports a disagreement that never happened. Said every
    // turn for the minutes an intro runs, it reads as a broken decoder, and
    // this line is also the one an audience hears (ADR 0108).
    if (decoded(input.after) === false) {
      return { summary: "the screen changed", refused: null, position: after, enteredMap: false };
    }
    return {
      summary: menuOpen
        ? `screen changed inside ${describeMenu(menuAfter ?? menuBefore)}`
        : "screen changed though the decoded state did not",
      advice: menuOpen
        ? "a detail the decoder does not model; trust the frame"
        : "possibly ambient animation; trust the frame",
      refused: null,
      position: after,
      enteredMap: false,
    };
  }
  if (input.screenChanged === false) {
    return {
      summary: "no visible change — the frame is identical",
      refused: null,
      position: after,
      enteredMap: false,
    };
  }
  return { summary: "no visible change", refused: null, position: after, enteredMap: false };
}

export interface FreePlayProgress {
  /** Distinct overworld tiles stood on. The closest thing to "getting somewhere". */
  distinctTiles: number;
  /** Maps entered, in order. Leaving the bedroom shows up here. */
  maps: string[];
  /** Turns since a tile was visited for the first time. High means stuck. */
  turnsSinceNewTile: number;
  /** Accepted actions spent per newly discovered tile. Lower is more efficient. */
  actionsPerNewTile: number | null;
}

/**
 * Progress, and refusal memory.
 *
 * Coherence answers "did he do what he said". It does not answer "is he getting
 * anywhere", and with vision it actually *drops* when he correctly re-plans
 * around furniture. These are the numbers that say whether he is playing well.
 */
export class FreePlayProgressTracker {
  private static readonly transitionLimit = 32;
  private readonly tiles = new Set<string>();
  private readonly mapOrder: string[] = [];
  private readonly refusals = new Map<string, Set<string>>();
  private readonly learnedTransitions: LearnedTransition[] = [];
  private acceptedActions = 0;
  private sinceNewTile = 0;

  public record(effect: ObservedEffect, accepted: boolean): void {
    if (accepted) this.acceptedActions += 1;
    if (effect.refused !== null) {
      const key = `${effect.refused.position.mapId}:${String(effect.refused.position.x)},${String(effect.refused.position.y)}`;
      const set = this.refusals.get(key) ?? new Set<string>();
      set.add(effect.refused.direction);
      this.refusals.set(key, set);
    }
    if (effect.position === null) {
      this.sinceNewTile += 1;
      return;
    }
    if (this.mapOrder.at(-1) !== effect.position.mapId) this.mapOrder.push(effect.position.mapId);
    const tile = `${effect.position.mapId}:${String(effect.position.x)},${String(effect.position.y)}`;
    if (this.tiles.has(tile)) {
      this.sinceNewTile += 1;
      return;
    }
    this.tiles.add(tile);
    this.sinceNewTile = 0;
  }

  /** Seed the starting tile so the first move is measured against it. */
  public seed(position: GbaPosition | null): void {
    if (position === null) return;
    this.mapOrder.push(position.mapId);
    this.tiles.add(`${position.mapId}:${String(position.x)},${String(position.y)}`);
  }

  /** Directions already refused from this exact tile. Memory, never a route. */
  public refusedFrom(position: GbaPosition | null): string[] {
    if (position === null) return [];
    const key = `${position.mapId}:${String(position.x)},${String(position.y)}`;
    return [...(this.refusals.get(key) ?? [])].sort();
  }

  /** Remember only map changes this exact action demonstrably caused. */
  public recordTransition(
    before: readonly GbaEmulatorObservation[],
    action: GbaEmulatorAction,
    after: readonly GbaEmulatorObservation[],
  ): void {
    const from = positionOf(before);
    const to = positionOf(after);
    if (from === null || to === null || from.mapId === to.mapId) return;
    const learned: LearnedTransition = { from, facing: facingOf(before), action, to };
    const key = transitionFactKey(learned);
    const existing = this.learnedTransitions.findIndex((transition) => transitionFactKey(transition) === key);
    if (existing !== -1) this.learnedTransitions.splice(existing, 1);
    this.learnedTransitions.push(learned);
    if (this.learnedTransitions.length > FreePlayProgressTracker.transitionLimit) {
      this.learnedTransitions.shift();
    }
  }

  /** Relevant experience only: exact tile first, then the rest of this map. */
  public transitionsFrom(position: GbaPosition | null): readonly LearnedTransition[] {
    if (position === null) return [];
    return this.learnedTransitions
      .filter((transition) => transition.from.mapId === position.mapId)
      .sort((left, right) => {
        const leftExact = left.from.x === position.x && left.from.y === position.y;
        const rightExact = right.from.x === position.x && right.from.y === position.y;
        return Number(rightExact) - Number(leftExact);
      });
  }

  public snapshot(): FreePlayProgress {
    return {
      distinctTiles: this.tiles.size,
      maps: [...this.mapOrder],
      turnsSinceNewTile: this.sinceNewTile,
      actionsPerNewTile:
        this.tiles.size <= 1 ? null : this.acceptedActions / Math.max(1, this.tiles.size - 1),
    };
  }
}

function transitionFactKey(transition: LearnedTransition): string {
  return JSON.stringify(transition);
}
