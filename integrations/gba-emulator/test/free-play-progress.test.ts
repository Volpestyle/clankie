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
    expect(effect.summary).toContain("hold the direction longer");
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
