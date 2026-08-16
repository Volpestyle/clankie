import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DeterministicGbaCoreDouble,
  FrozenGbaScenarioSchema,
  MgbaFireRedCore,
  RealGbaRouteScenarioSchema,
  nearestReachableDetail,
  planWalk,
  planWalkBeside,
  renderWalkabilityMinimap,
  FIRERED_MAP_BORDER_OFFSET,
} from "../src/index.ts";
import type { GbaCoreMapGrid } from "../src/core-seam.ts";

/** A hand-built grid, so route planning is tested without a core at all. */
function gridFrom(rows: readonly string[]): GbaCoreMapGrid {
  return {
    minX: 0,
    minY: 0,
    maxX: (rows[0] ?? "").length,
    maxY: rows.length,
    isPassable: (x, y) => (rows[y]?.[x] ?? "#") === ".",
  };
}

describe("planWalk", () => {
  it("routes around a wall rather than through it", () => {
    //   0123
    // 0 .#..
    // 1 .#..
    // 2 ....
    const grid = gridFrom([".#..", ".#..", "...."]);
    const path = planWalk(grid, { x: 0, y: 0 }, { x: 3, y: 0 });
    expect(path).not.toBeNull();
    // Straight line is 3; the wall forces a detour down and back up. Several
    // 7-step detours are equally short, so only the length and the destination
    // are asserted — pinning the exact buttons would test tie-breaking order.
    expect(path?.length).toBe(7);
    expect(path?.at(-1)?.x).toBe(3);
    expect(path?.at(-1)?.y).toBe(0);
    // A route must never pass through the wall column.
    for (const step of path ?? []) expect(grid.isPassable(step.x, step.y)).toBe(true);
  });

  it("returns the shortest route when one is unobstructed", () => {
    const grid = gridFrom(["....", "....", "...."]);
    expect(planWalk(grid, { x: 0, y: 0 }, { x: 3, y: 0 })?.length).toBe(3);
  });

  it("returns an empty route when already standing on the target", () => {
    const grid = gridFrom(["...."]);
    expect(planWalk(grid, { x: 2, y: 0 }, { x: 2, y: 0 })).toEqual([]);
  });

  it("refuses an impassable target instead of walking as close as it can", () => {
    const grid = gridFrom(["..#."]);
    expect(planWalk(grid, { x: 0, y: 0 }, { x: 2, y: 0 })).toBeNull();
  });

  it("refuses a target outside the map bounds", () => {
    const grid = gridFrom(["...."]);
    expect(planWalk(grid, { x: 0, y: 0 }, { x: 9, y: 0 })).toBeNull();
  });

  it("refuses a target walled off from the start", () => {
    const grid = gridFrom([".#."]);
    expect(planWalk(grid, { x: 0, y: 0 }, { x: 2, y: 0 })).toBeNull();
  });
});

describe("planWalkBeside", () => {
  it("routes to the nearest open neighbour and presses into the target", () => {
    //   0123
    // 0 ...#   target (3,0) is blocked; its only open neighbour is (2,0).
    // 1 ....
    const grid = gridFrom(["...#", "...."]);
    const approach = planWalkBeside(grid, { x: 0, y: 0 }, { x: 3, y: 0 });
    expect(approach).not.toBeNull();
    expect(approach?.path.at(-1)).toMatchObject({ x: 2, y: 0 });
    expect(approach?.press).toBe("right");
  });

  it("returns an empty route when already beside the target", () => {
    const grid = gridFrom(["..#"]);
    const approach = planWalkBeside(grid, { x: 1, y: 0 }, { x: 2, y: 0 });
    expect(approach).toEqual({ path: [], press: "right" });
  });

  it("returns null when no neighbour of the target is reachable", () => {
    //   012345
    // 0 ..#.#.   the target (4,0)'s neighbours sit beyond the wall at (2,0).
    const grid = gridFrom(["..#.#."]);
    expect(planWalkBeside(gridFrom(["..#.#."]), { x: 0, y: 0 }, { x: 4, y: 0 })).toBeNull();
    expect(grid.isPassable(3, 0)).toBe(true);
  });
});

describe("nearestReachableDetail", () => {
  it("names the reachable open tile closest to the refused target", () => {
    //   0123
    // 0 ..#.   (3,0) is open but walled off; nearest reachable is (1,0).
    const grid = gridFrom(["..#."]);
    expect(nearestReachableDetail(grid, { x: 0, y: 0 }, { x: 3, y: 0 })).toBe(
      "nearest reachable open tile is (1,0)",
    );
  });

  it("says so when nowhere reachable is nearer than where you stand", () => {
    const grid = gridFrom([".#."]);
    expect(nearestReachableDetail(grid, { x: 0, y: 0 }, { x: 2, y: 0 })).toBe(
      "no open tile nearer (2,0) than where you stand is reachable",
    );
  });
});

describe("renderWalkabilityMinimap", () => {
  it("renders the player, walls, floor, and warp tiles in place", () => {
    const grid = gridFrom(["....", ".#..", "...."]);
    const minimap = renderWalkabilityMinimap(grid, { x: 0, y: 1 }, [{ x: 3, y: 0 }]);
    expect(minimap).toEqual({
      topLeft: { x: 0, y: 0 },
      rows: ["...D", "@#..", "...."],
    });
  });

  it("crops around the player and reports the crop's origin", () => {
    // A 40-wide corridor: the crop is bounded by the radius, not the map.
    const grid = gridFrom([".".repeat(40)]);
    const minimap = renderWalkabilityMinimap(grid, { x: 20, y: 0 }, []);
    expect(minimap?.topLeft).toEqual({ x: 8, y: 0 });
    expect(minimap?.rows[0]?.length).toBe(25);
    expect(minimap?.rows[0]?.[20 - 8]).toBe("@");
  });

  it("reports absence for a player standing outside the loaded map", () => {
    const grid = gridFrom(["...."]);
    expect(renderWalkabilityMinimap(grid, { x: 99, y: 99 }, [])).toBeNull();
  });
});

const frozenScenario = FrozenGbaScenarioSchema.parse(
  JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        "../../../scenarios/emulator/verdant-path-trainer-battle/v1/scenario.json",
      ),
      "utf8",
    ),
  ),
);

describe("deterministic core double", () => {
  it("reports the collision it already enforces, before it is walked into", () => {
    const core = new DeterministicGbaCoreDouble(frozenScenario);
    const grid = core.mapGrid();
    const state = core.gameState();
    expect(state.surroundings).not.toBeNull();

    // Whatever the double reports as adjacent must agree with its own grid.
    const { x, y } = state.position;
    expect(state.surroundings?.north.passable).toBe(grid.isPassable(x, y - 1));
    expect(state.surroundings?.south.passable).toBe(grid.isPassable(x, y + 1));
    expect(state.surroundings?.east.passable).toBe(grid.isPassable(x + 1, y));
    expect(state.surroundings?.west.passable).toBe(grid.isPassable(x - 1, y));
  });

  it("reports blocked scenario tiles as impassable", () => {
    const core = new DeterministicGbaCoreDouble(frozenScenario);
    const grid = core.mapGrid();
    for (const point of frozenScenario.map.blocked) {
      expect(grid.isPassable(point.x, point.y)).toBe(false);
    }
    // Off-map is never walkable.
    expect(grid.isPassable(-1, 0)).toBe(false);
    expect(grid.isPassable(frozenScenario.map.width, 0)).toBe(false);
  });

  it("keeps the RAM digest independent of the derived surroundings", () => {
    // The digest hashes the held state; surroundings are derived in the
    // accessor precisely so every frozen scenario digest stays stable.
    const core = new DeterministicGbaCoreDouble(frozenScenario);
    const before = core.ramStateSha256();
    core.gameState();
    expect(core.ramStateSha256()).toBe(before);
  });
});

const romPath = process.env["CLANKIE_GBA_ROM_PATH"];
const savestatePath = process.env["CLANKIE_GBA_SAVESTATE_PATH"];
const romAvailable =
  romPath !== undefined && existsSync(romPath) && savestatePath !== undefined && existsSync(savestatePath);

const routeScenario = RealGbaRouteScenarioSchema.parse(
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../fixtures/firered-bedroom-route/v1/scenario.json"), "utf8"),
  ),
);

describe.skipIf(!romAvailable)("FireRed map grid (ROM-gated)", () => {
  const createCore = async () =>
    MgbaFireRedCore.create({
      coreId: routeScenario.coreId,
      romBytes: readFileSync(romPath ?? ""),
      savestateBytes: readFileSync(savestatePath ?? ""),
      romSha256: routeScenario.romSha256,
      savestateSha256: routeScenario.savestateSha256,
      coreWasmSha256: routeScenario.coreWasmSha256,
      mapId: routeScenario.map.mapId,
    });

  it(
    "decodes collision matching tiles proved blocked or open by walking them",
    { timeout: 240_000 },
    async () => {
      const core = await createCore();
      const grid = core.mapGrid();
      expect(grid).not.toBeNull();

      // The bedroom is 12x9 behind a 7-tile border.
      expect(grid?.minX).toBe(FIRERED_MAP_BORDER_OFFSET);
      expect(grid?.maxX).toBe(FIRERED_MAP_BORDER_OFFSET + 12);
      expect(grid?.maxY).toBe(FIRERED_MAP_BORDER_OFFSET + 9);

      // Ground truth gathered by walking the room and recording refusals.
      expect(grid?.isPassable(15, 10)).toBe(false); // stair banister
      expect(grid?.isPassable(16, 10)).toBe(false); // stair banister
      expect(grid?.isPassable(13, 12)).toBe(false); // PC table
      expect(grid?.isPassable(9, 13)).toBe(false); // bed
      expect(grid?.isPassable(15, 11)).toBe(true);
      expect(grid?.isPassable(17, 10)).toBe(true);
      expect(grid?.isPassable(17, 9)).toBe(true);
    },
  );

  it("treats the border filler as impassable rather than open floor", { timeout: 240_000 }, async () => {
    const core = await createCore();
    const grid = core.mapGrid();
    // Border tiles decode to collision 0, so a naive reader would call the void
    // beyond the room's walls walkable. The bounds are what stop that.
    expect(grid?.isPassable(0, 0)).toBe(false);
    expect(grid?.isPassable(19, 13)).toBe(false);
    expect(grid?.isPassable(FIRERED_MAP_BORDER_OFFSET - 1, 13)).toBe(false);
  });

  it("reports what the player is facing", { timeout: 240_000 }, async () => {
    const core = await createCore();
    const state = core.gameState();
    // The player spawns at (13,13) facing north, into the PC table.
    expect(state.facing).toBe("north");
    expect(state.surroundings).not.toBeNull();
    expect(state.surroundings?.ahead).toEqual(state.surroundings?.north);
    expect(state.surroundings?.ahead.passable).toBe(false);
    expect(state.surroundings?.south.passable).toBe(true);
    expect(state.mapSize).toEqual({ width: 12, height: 9 });
  });

  it(
    "reports a warp tile as blocking, which is what stops walk_to taking stairs",
    { timeout: 240_000 },
    async () => {
      const core = await createCore();
      const grid = core.mapGrid();
      // (16,9) is the stairs down. Its collision bits block, yet pressing left
      // into it from (17,9) warps to players-house-1f — verified by hand and in
      // the live end-to-end check. So a route planned purely from collision can
      // never step onto a warp, and crossing maps stays a directional press.
      expect(grid?.isPassable(16, 9)).toBe(false);
      expect(planWalk(grid as GbaCoreMapGrid, { x: 17, y: 9 }, { x: 16, y: 9 })).toBeNull();
    },
  );

  it("plans a route to the stairs that avoids the banister", { timeout: 240_000 }, async () => {
    const core = await createCore();
    const grid = core.mapGrid();
    if (grid === null) throw new Error("expected a map grid");
    const player = core.gameState().position;
    const path = planWalk(grid, { x: player.x, y: player.y }, { x: 17, y: 9 });
    expect(path).not.toBeNull();
    // Every planned tile must be one the map itself calls open.
    for (const step of path ?? []) expect(grid.isPassable(step.x, step.y)).toBe(true);
    // And the route may never route through the banister tiles.
    expect((path ?? []).some((step) => step.y === 10 && (step.x === 15 || step.x === 16))).toBe(false);
  });
});
