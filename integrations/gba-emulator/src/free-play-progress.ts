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

const DIRECTIONS = new Set(["up", "down", "left", "right"]);

/** The direction a button press attempted, or null for a non-directional action. */
export function attemptedDirection(action: GbaEmulatorAction): string | null {
  if (action.kind !== "button_press") return null;
  return DIRECTIONS.has(action.button) ? action.button : null;
}

/** Stable key for "this move, from this tile" — the unit of refusal memory. */
export function transitionKey(position: GbaPosition, direction: string): string {
  return `${position.mapId}:${String(position.x)},${String(position.y)}:${direction}`;
}

/** How much read-back text a single turn's effect line may carry. */
const DIALOG_TRANSCRIPT_LIMIT = 600;

const DIALOG_ENDINGS: Readonly<Record<string, string>> = {
  dialog_closed: "the text ended",
  choice_open: "a choice is waiting — answer it",
  battle_started: "a battle started",
  battle_ended: "the battle ended",
  script_released: "the script let go without more text — you have control again",
  script_holding: "a script still holds the screen with no readable box — it may need more time",
  input_bound_reached: "the input budget ran out; more text remains",
  frame_bound_reached: "the frame budget ran out; more text remains",
};

function describeDialogAdvance(outcome: Record<string, unknown> | undefined): string {
  const transcript = Array.isArray(outcome?.transcript)
    ? outcome.transcript.filter((line): line is string => typeof line === "string")
    : [];
  const ending = typeof outcome?.endedBecause === "string" ? outcome.endedBecause : null;
  const reason = ending === null ? "the dialog stopped" : (DIALOG_ENDINGS[ending] ?? ending);
  if (transcript.length === 0) return `read no new text — ${reason}`;
  // Oldest boxes drop first: the last thing said is the part still in play.
  let text = transcript.join(" / ");
  while (text.length > DIALOG_TRANSCRIPT_LIMIT && transcript.length > 1) {
    transcript.shift();
    text = `… / ${transcript.join(" / ")}`;
  }
  return `read: "${text.slice(0, DIALOG_TRANSCRIPT_LIMIT)}" — ${reason}`;
}

/** Bounded walk summary from the adapter's own account of the route. */
function describeWalk(
  action: { x: number; y: number },
  outcome: Record<string, unknown>,
  after: GbaPosition | null,
): string {
  const steps = typeof outcome["steps"] === "number" ? String(outcome["steps"]) : "?";
  const planned = typeof outcome["plannedSteps"] === "number" ? String(outcome["plannedSteps"]) : "?";
  const blocked = outcome["blockedAt"] as { x?: number; y?: number } | null | undefined;
  if (outcome["warped"] === true && after !== null) {
    return `walked onto a warp after ${steps} steps — entered ${after.mapId} at (${String(after.x)},${String(after.y)})`;
  }
  if (outcome["arrived"] === true) {
    return `walked ${steps} steps and arrived at (${String(action.x)},${String(action.y)})`;
  }
  if (blocked != null && typeof blocked.x === "number" && typeof blocked.y === "number") {
    return (
      `walked ${steps} of ${planned} steps, then the way was blocked at ` +
      `(${String(blocked.x)},${String(blocked.y)}) by something the map does not show — an NPC, ` +
      "probably; step around it or talk to it"
    );
  }
  return `walked ${steps} of ${planned} planned steps toward (${String(action.x)},${String(action.y)})`;
}

const ENTER_TEXT_ENDINGS: Readonly<Record<string, string>> = {
  confirmed: "confirmed — the screen closed",
  typed: "typed and left open, as asked",
  screen_closed: "the naming screen closed before typing finished",
  input_not_registered: "a press stopped registering; the entry stopped rather than guess",
  input_bound_reached: "the input budget ran out mid-entry; repeat the action to continue",
  frame_bound_reached: "the frame budget ran out mid-entry; repeat the action to continue",
};

/** Bounded entry summary from the adapter's own account of the typing. */
function describeEnterText(text: string, outcome: Record<string, unknown> | undefined): string {
  const typed = typeof outcome?.["typed"] === "string" ? outcome["typed"] : "";
  const ending = typeof outcome?.["endedBecause"] === "string" ? outcome["endedBecause"] : null;
  const reason = ending === null ? "the entry ended" : (ENTER_TEXT_ENDINGS[ending] ?? ending);
  if (outcome?.["confirmed"] === true) return `named "${text}" — ${reason}`;
  return `typed "${typed}" of "${text}" — ${reason}`;
}

export interface ObservedEffect {
  /** Bounded, human-readable — this is what the model is told. */
  summary: string;
  /** A directed move the emulator refused, for the blocked-transition memory. */
  refused: { position: GbaPosition; direction: string } | null;
  position: GbaPosition | null;
  enteredMap: boolean;
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
      summary: describeDialogAdvance(input.outcome),
      refused: null,
      position: after,
      enteredMap: before !== null && after !== null && before.mapId !== after.mapId,
    };
  }

  // A typed name's outcome carries what landed and whether it was confirmed —
  // none of which the decoded overworld diff can see.
  if (input.action.kind === "enter_text") {
    return {
      summary: describeEnterText(input.action.text, input.outcome),
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
      summary: describeWalk(input.action, input.outcome, after),
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
          summary: `turned to face ${facingAfter} without stepping — hold the direction longer to move`,
          refused: null,
          position: after,
          enteredMap: false,
        };
      }
      // Already facing that way and still did not move: a real obstacle.
      if (facingAfter === null || facingAfter === FACING_FOR_BUTTON[direction]) {
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

  // The frame digest catches what the decoded surface misses — a naming-screen
  // cursor, a page-swap animation. Without it, this branch told him "no
  // visible change" while the screen visibly moved, and he had to learn to
  // distrust his own effect line.
  if (input.screenChanged === true) {
    return {
      summary: menuOpen
        ? `screen changed inside ${describeMenu(menuAfter ?? menuBefore)} — a detail the decoder does not model; trust the frame`
        : "screen changed though the decoded state did not — possibly ambient animation; trust the frame",
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
  private readonly tiles = new Set<string>();
  private readonly mapOrder: string[] = [];
  private readonly refusals = new Map<string, Set<string>>();
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
