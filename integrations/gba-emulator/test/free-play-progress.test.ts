import type { GbaEmulatorAction, GbaEmulatorObservation } from "@clankie/interactive-environment";
import { describe, expect, it } from "vitest";
import {
  FreePlayProgressTracker,
  attemptedDirection,
  observeEffect,
  positionOf,
} from "../src/free-play-progress.ts";

function at(mapId: string, x: number, y: number, facing = "south"): GbaEmulatorObservation[] {
  return [
    {
      schemaVersion: 1,
      kind: "overworld",
      observationId: `obs-${mapId}-${String(x)}-${String(y)}`,
      sessionId: "s",
      characterId: "clankie",
      worldId: "w",
      goalVersion: 0,
      capturedAt: "2026-07-25T18:00:00.000Z",
      frame: 1,
      data: { position: { mapId, x, y }, facing, ramStateSha256: "b".repeat(64) },
    } as unknown as GbaEmulatorObservation,
  ];
}

function withScene(
  observations: GbaEmulatorObservation[],
  mode: string,
  inputReady: boolean,
): GbaEmulatorObservation[] {
  return [
    ...observations,
    {
      schemaVersion: 1,
      kind: "scene",
      observationId: `obs-scene-${mode}`,
      sessionId: "s",
      characterId: "clankie",
      worldId: "w",
      goalVersion: 0,
      capturedAt: "2026-07-25T18:00:00.000Z",
      frame: 1,
      data: { mode, inputReady, waitingForDialogAdvance: false },
    } as unknown as GbaEmulatorObservation,
  ];
}

function withMenu(
  observations: GbaEmulatorObservation[],
  menuId: string,
  cursor: number,
  entries: { id: string; label: string }[],
): GbaEmulatorObservation[] {
  return [
    ...observations,
    {
      schemaVersion: 1,
      kind: "menu",
      observationId: `obs-${menuId}-${String(cursor)}`,
      sessionId: "s",
      characterId: "clankie",
      worldId: "w",
      goalVersion: 0,
      capturedAt: "2026-07-25T18:00:00.000Z",
      frame: 1,
      data: { menuId, cursor, entries, untrusted: true },
    } as unknown as GbaEmulatorObservation,
  ];
}

function withDanger(observations: GbaEmulatorObservation[], stateCertain: boolean): GbaEmulatorObservation[] {
  return [
    ...observations,
    {
      schemaVersion: 1,
      kind: "danger",
      observationId: `obs-danger-${String(stateCertain)}`,
      sessionId: "s",
      characterId: "clankie",
      worldId: "w",
      goalVersion: 0,
      capturedAt: "2026-07-25T18:00:00.000Z",
      frame: 1,
      data: { severity: "low", code: "input_bound", summary: "", stateCertain },
    } as unknown as GbaEmulatorObservation,
  ];
}

const certain = (observations: GbaEmulatorObservation[]): GbaEmulatorObservation[] =>
  withDanger(observations, true);
const uncertain = (observations: GbaEmulatorObservation[]): GbaEmulatorObservation[] =>
  withDanger(observations, false);

const pressLeft: GbaEmulatorAction = { kind: "button_press", button: "left", holdFrames: 4 };
const pressA: GbaEmulatorAction = { kind: "button_press", button: "a", holdFrames: 4 };

describe("observed effect", () => {
  it("reports a real move rather than only that the button was taken", () => {
    const effect = observeEffect({
      before: at("bedroom", 10, 5),
      after: at("bedroom", 9, 5),
      action: pressLeft,
    });
    expect(effect.summary).toBe("moved to (9,5)");
    expect(effect.refused).toBeNull();
  });

  it("does not mint a wall when a directional press started a battle", () => {
    const effect = observeEffect({
      before: at("route-1", 23, 24, "south"),
      after: withScene(at("route-1", 23, 24, "south"), "battle", false),
      action: { kind: "button_press", button: "down", holdFrames: 16 },
    });
    expect(effect.summary).toBe("a battle started");
    expect(effect.refused).toBeNull();
  });

  it("does not mint a wall when a directional press started a fade", () => {
    const effect = observeEffect({
      before: at("center", 14, 15, "south"),
      after: withScene(at("center", 14, 15, "south"), "overworld", false),
      action: { kind: "button_press", button: "down", holdFrames: 16 },
    });
    expect(effect.summary).toContain("transition is holding the screen");
    expect(effect.refused).toBeNull();
  });

  it("names a blocked direction only when he was already facing that way", () => {
    // Previously this turn reported "accepted" and he walked into the desk again.
    const effect = observeEffect({
      before: at("bedroom", 10, 5, "west"),
      after: at("bedroom", 10, 5, "west"),
      action: pressLeft,
    });
    expect(effect.summary).toContain("position unchanged");
    expect(effect.summary).toContain("left is blocked");
    expect(effect.refused).toEqual({ position: { mapId: "bedroom", x: 10, y: 5 }, direction: "left" });
  });

  it("reports entering a new map, which is what leaving the house looks like", () => {
    const effect = observeEffect({
      before: at("players-house-2f", 10, 5),
      after: at("players-house-1f", 4, 8),
      action: pressLeft,
    });
    expect(effect.summary).toContain("entered players-house-1f");
    expect(effect.enteredMap).toBe(true);
  });

  it("calls a turn a turn instead of inventing a wall", () => {
    // A short directional tap pivots without stepping. Reporting that as
    // "blocked" fabricates an obstacle and poisons the refusal memory — which
    // is exactly what made him believe he was boxed in on open floor.
    const effect = observeEffect({
      before: at("bedroom", 10, 5, "south"),
      after: at("bedroom", 10, 5, "west"),
      action: pressLeft,
    });
    expect(effect.summary).toContain("turned to face west");
    // The coaching rides in `advice`, never in the line an audience is handed.
    expect(effect.summary).not.toContain("hold the direction longer");
    expect(effect.advice).toContain("hold the direction longer");
    expect(effect.refused).toBeNull();
  });

  it("does not blame a non-directional press for not moving", () => {
    const effect = observeEffect({
      before: at("bedroom", 10, 5),
      after: at("bedroom", 10, 5),
      action: pressA,
    });
    // Pressing A rarely moves you; calling that "blocked" would be a lie.
    expect(effect.refused).toBeNull();
    expect(effect.summary).toBe("no visible change");
  });

  it("treats a d-pad press inside an open menu as navigation, not walking", () => {
    // On the naming screen the overworld decoder still reports the stale field
    // position underneath. Judging the press as movement minted fake walls and
    // poisoned the refusal memory with tiles he never actually walked at.
    const typing = [{ id: "typed-text", label: 'typed so far: "G"' }];
    const typed = [{ id: "typed-text", label: 'typed so far: "GA"' }];
    const changed = observeEffect({
      before: withMenu(at("bedroom", 10, 5, "west"), "naming-screen", 0, typing),
      after: withMenu(at("bedroom", 10, 5, "west"), "naming-screen", 0, typed),
      action: pressA,
    });
    expect(changed.summary).toBe('menu changed — naming-screen: typed so far: "GA"');
    expect(changed.refused).toBeNull();

    const cursorOnly = observeEffect({
      before: withMenu(at("bedroom", 10, 5, "west"), "naming-screen", 0, typed),
      after: withMenu(at("bedroom", 10, 5, "west"), "naming-screen", 0, typed),
      action: pressLeft,
      screenChanged: true,
    });
    // The decoded menu missed the cursor move, but the frame did not.
    expect(cursorOnly.summary).toContain("screen changed inside naming-screen");
    expect(cursorOnly.advice).toContain("trust the frame");
    expect(cursorOnly.refused).toBeNull();
  });

  it("does not claim the decoded state stood still when nothing decoded", () => {
    // The FRLG intro decodes to nothing for minutes. Saying "the screen
    // changed though the decoded state did not" there reports a disagreement
    // between a decode and a frame when only the frame exists — and this line
    // is also what a voice room is handed (ADR 0108). Heard live 2026-08-16.
    const undecoded = observeEffect({
      before: uncertain(withScene([], "unknown", false)),
      after: uncertain(withScene([], "unknown", false)),
      action: pressA,
      screenChanged: true,
    });
    expect(undecoded.summary).toBe("the screen changed");
    expect(undecoded.advice).toBeUndefined();

    // With a decode to compare against, the disagreement is real and stays.
    const decoded = observeEffect({
      before: certain(at("bedroom", 10, 5)),
      after: certain(at("bedroom", 10, 5)),
      action: pressA,
      screenChanged: true,
    });
    expect(decoded.summary).toBe("screen changed though the decoded state did not");
    expect(decoded.advice).toContain("trust the frame");
  });

  it("reports a menu opening and closing by name", () => {
    const entries = [{ id: "start-menu-1", label: "Pokémon" }];
    const opened = observeEffect({
      before: at("bedroom", 10, 5),
      after: withMenu(at("bedroom", 10, 5), "start-menu", 0, entries),
      action: pressA,
    });
    expect(opened.summary).toBe("menu opened — start-menu: Pokémon");
    const closed = observeEffect({
      before: withMenu(at("bedroom", 10, 5), "start-menu", 0, entries),
      after: at("bedroom", 10, 5),
      action: pressA,
    });
    expect(closed.summary).toBe("menu closed");
  });

  it("lets the frame digest veto a false 'no visible change'", () => {
    const moved = observeEffect({
      before: at("bedroom", 10, 5),
      after: at("bedroom", 10, 5),
      action: pressA,
      screenChanged: true,
    });
    expect(moved.summary).toContain("screen changed though the decoded state did not");
    expect(moved.refused).toBeNull();

    const still = observeEffect({
      before: at("bedroom", 10, 5),
      after: at("bedroom", 10, 5),
      action: pressA,
      screenChanged: false,
    });
    // An identical digest upgrades "no visible change" from a guess to a fact.
    expect(still.summary).toBe("no visible change — the frame is identical");
  });

  it("extracts position and direction, ignoring non-directional buttons", () => {
    expect(positionOf(at("bedroom", 3, 4))).toEqual({ mapId: "bedroom", x: 3, y: 4 });
    expect(positionOf([])).toBeNull();
    expect(attemptedDirection(pressLeft)).toBe("left");
    expect(attemptedDirection(pressA)).toBeNull();
    expect(attemptedDirection({ kind: "frame_advance", frames: 4 })).toBeNull();
  });
});

describe("progress tracker", () => {
  const blocked = (mapId: string, x: number, y: number, direction: string) => ({
    summary: "blocked",
    refused: { position: { mapId, x, y }, direction },
    position: { mapId, x, y },
    enteredMap: false,
  });
  const moved = (mapId: string, x: number, y: number) => ({
    summary: "moved",
    refused: null,
    position: { mapId, x, y },
    enteredMap: false,
  });

  it("counts distinct tiles and how long he has been stuck", () => {
    const tracker = new FreePlayProgressTracker();
    tracker.seed({ mapId: "bedroom", x: 10, y: 5 });

    tracker.record(moved("bedroom", 9, 5), true);
    expect(tracker.snapshot().distinctTiles).toBe(2);
    expect(tracker.snapshot().turnsSinceNewTile).toBe(0);

    // Walking back over a known tile is not progress.
    tracker.record(moved("bedroom", 10, 5), true);
    tracker.record(moved("bedroom", 9, 5), true);
    const snapshot = tracker.snapshot();
    expect(snapshot.distinctTiles).toBe(2);
    expect(snapshot.turnsSinceNewTile).toBe(2);
  });

  it("records map changes, which is what getting out of the house looks like", () => {
    const tracker = new FreePlayProgressTracker();
    tracker.seed({ mapId: "players-house-2f", x: 10, y: 5 });
    tracker.record(moved("players-house-1f", 4, 8), true);
    expect(tracker.snapshot().maps).toEqual(["players-house-2f", "players-house-1f"]);
  });

  it("remembers refusals per tile without ever proposing a direction", () => {
    const tracker = new FreePlayProgressTracker();
    tracker.seed({ mapId: "bedroom", x: 10, y: 5 });
    tracker.record(blocked("bedroom", 10, 5, "left"), true);
    tracker.record(blocked("bedroom", 10, 5, "up"), true);

    // Memory of what he tried, from exactly where he tried it.
    expect(tracker.refusedFrom({ mapId: "bedroom", x: 10, y: 5 })).toEqual(["left", "up"]);
    // A different tile carries no assumptions.
    expect(tracker.refusedFrom({ mapId: "bedroom", x: 9, y: 5 })).toEqual([]);
    expect(tracker.refusedFrom(null)).toEqual([]);
  });

  it("measures actions spent per newly discovered tile", () => {
    const tracker = new FreePlayProgressTracker();
    tracker.seed({ mapId: "bedroom", x: 10, y: 5 });
    tracker.record(blocked("bedroom", 10, 5, "left"), true);
    tracker.record(blocked("bedroom", 10, 5, "up"), true);
    tracker.record(moved("bedroom", 11, 5), true);
    // Three accepted actions bought one new tile.
    expect(tracker.snapshot().actionsPerNewTile).toBeCloseTo(3, 5);
  });

  it("reports no efficiency figure before a second tile exists", () => {
    const tracker = new FreePlayProgressTracker();
    tracker.seed({ mapId: "bedroom", x: 10, y: 5 });
    expect(tracker.snapshot().actionsPerNewTile).toBeNull();
  });
});

describe("frame upscale", () => {
  it("scales the picture without inventing information", async () => {
    const { encodeFramebufferPng } = await import("../src/framebuffer-png.ts");
    const frame = { width: 4, height: 2, bytes: new Uint8Array(4 * 2 * 2) };
    const one = encodeFramebufferPng(frame, 1);
    const three = encodeFramebufferPng(frame, 3);
    // Same PNG signature, larger canvas — nearest-neighbour adds no detail.
    expect(three.subarray(0, 8)).toEqual(one.subarray(0, 8));
    expect(three.readUInt32BE(16)).toBe(12);
    expect(three.readUInt32BE(20)).toBe(6);
    expect(one.readUInt32BE(16)).toBe(4);
    expect(() => encodeFramebufferPng(frame, 0)).toThrow(/scale_invalid/);
    expect(() => encodeFramebufferPng(frame, 99)).toThrow(/scale_invalid/);
  });
});

describe("walk effects", () => {
  const walk = (outcome: Record<string, unknown>) =>
    observeEffect({
      before: [],
      after: [],
      action: { kind: "walk_to", x: 8, y: 14 },
      outcome,
    });

  it("reports an arrival as the route's own account, not a bare position", () => {
    const effect = walk({ steps: 9, plannedSteps: 9, arrived: true, blockedAt: null, warped: false });
    expect(effect.summary).toBe("walked 9 steps and arrived at (8,14)");
  });

  it("says where a route stopped and why, so the obstacle is actionable", () => {
    const effect = walk({
      steps: 3,
      plannedSteps: 9,
      arrived: false,
      blockedAt: { x: 6, y: 14 },
      warped: false,
    });
    expect(effect.summary).toContain("blocked at (6,14)");
    expect(effect.summary).toContain("NPC");
  });

  it("names a battle instead of inventing an NPC on the grass", () => {
    const effect = walk({
      steps: 2,
      plannedSteps: 37,
      arrived: false,
      blockedAt: { x: 23, y: 25 },
      blockedBecause: "battle",
      mode: "battle",
      warped: false,
    });
    expect(effect.summary).toContain("a battle started at (23,25)");
    expect(effect.advice).toContain("advance_dialog");
    expect(effect.summary).not.toContain("NPC");
  });

  it("names a fade instead of inventing an NPC on a door", () => {
    const effect = walk({
      steps: 4,
      plannedSteps: 4,
      arrived: false,
      blockedAt: { x: 14, y: 15 },
      blockedBecause: "transition",
      inputReady: false,
      warped: false,
    });
    expect(effect.summary).toContain("a transition held the screen at (14,15)");
    expect(effect.summary).not.toContain("NPC");
  });
});
