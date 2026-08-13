import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  GbaEmulatorSessionSpecSchema,
  type GbaButton,
  type GbaEmulatorAction,
  type GbaEmulatorStartActionCommand,
} from "@clankie/interactive-environment";
import { describe, expect, it } from "vitest";
import {
  FrozenGbaScenarioSchema,
  GbaEmulatorAdapter,
  MgbaFireRedCore,
  RealGbaRouteScenarioSchema,
  decodeFireRedMapExits,
  fireRedMapIdFor,
  FIRERED_MAP_HEADER_OFFSET,
  GBA_EWRAM_SIZE,
  GBA_ROM_BASE,
  type FireRedMapGrid,
  type GbaCoreSeam,
  type GbaCoreState,
} from "../src/index.ts";

/** A grid whose only meaningful fields are the real-map dimensions. */
function gridOf(mapWidth: number, mapHeight: number): FireRedMapGrid {
  return { width: mapWidth + 15, height: mapHeight + 14, mapWidth, mapHeight, tiles: new Uint16Array(0) };
}

/**
 * Synthetic EWRAM+ROM carrying one decodable map header: two warps, a north
 * and a south connection, and one dive connection that is not an edge.
 */
function syntheticMemory(mutate?: (ewram: DataView, rom: DataView) => void): {
  ewram: Uint8Array;
  rom: Uint8Array;
} {
  const ewram = new Uint8Array(GBA_EWRAM_SIZE);
  const rom = new Uint8Array(0x1000);
  const ewramView = new DataView(ewram.buffer);
  const romView = new DataView(rom.buffer);
  // struct MapHeader: events at +4, connections at +12.
  ewramView.setUint32(FIRERED_MAP_HEADER_OFFSET + 4, GBA_ROM_BASE + 0x100, true);
  ewramView.setUint32(FIRERED_MAP_HEADER_OFFSET + 12, GBA_ROM_BASE + 0x200, true);
  // struct MapEvents: counts, then warps pointer at +8.
  romView.setUint8(0x100 + 1, 2);
  romView.setUint32(0x100 + 8, GBA_ROM_BASE + 0x120, true);
  // struct WarpEvent: s16 x, y; u8 elevation, warpId, mapNum, mapGroup.
  romView.setInt16(0x120, 9, true);
  romView.setInt16(0x122, 2, true);
  romView.setUint8(0x126, 0);
  romView.setUint8(0x127, 4);
  romView.setInt16(0x128, 0, true);
  romView.setInt16(0x12a, 7, true);
  romView.setUint8(0x12e, 19);
  romView.setUint8(0x12f, 3);
  // struct MapConnections: count, then list pointer.
  romView.setInt32(0x200, 3, true);
  romView.setUint32(0x204, GBA_ROM_BASE + 0x210, true);
  // struct MapConnection: u8 direction; s32 offset; u8 mapGroup, mapNum.
  romView.setUint8(0x210, 2);
  romView.setUint8(0x218, 3);
  romView.setUint8(0x219, 19);
  romView.setUint8(0x21c, 1);
  romView.setUint8(0x224, 3);
  romView.setUint8(0x225, 39);
  romView.setUint8(0x228, 5); // dive: not an edge, expected to be skipped
  romView.setUint8(0x230, 1);
  romView.setUint8(0x231, 1);
  mutate?.(ewramView, romView);
  return { ewram, rom };
}

describe("decodeFireRedMapExits", () => {
  it("decodes warps into player coordinate space and connections into edges", () => {
    const { ewram, rom } = syntheticMemory();
    const exits = decodeFireRedMapExits(ewram, rom, gridOf(10, 8));
    expect(exits).toEqual({
      warps: [
        { x: 16, y: 9, destinationMapGroup: 4, destinationMapNum: 0 },
        { x: 7, y: 14, destinationMapGroup: 3, destinationMapNum: 19 },
      ],
      connections: [
        { direction: "north", destinationMapGroup: 3, destinationMapNum: 19 },
        { direction: "south", destinationMapGroup: 3, destinationMapNum: 39 },
      ],
    });
  });

  it("fails closed on an events pointer outside the ROM", () => {
    const { ewram, rom } = syntheticMemory((ewramView) => {
      ewramView.setUint32(FIRERED_MAP_HEADER_OFFSET + 4, 0x02000000, true);
    });
    expect(decodeFireRedMapExits(ewram, rom, gridOf(10, 8))).toBeNull();
  });

  it("fails closed on an implausible warp count", () => {
    const { ewram, rom } = syntheticMemory((_ewramView, romView) => {
      romView.setUint8(0x100 + 1, 200);
    });
    expect(decodeFireRedMapExits(ewram, rom, gridOf(10, 8))).toBeNull();
  });

  it("fails closed on a warp outside the loaded map", () => {
    const { ewram, rom } = syntheticMemory((_ewramView, romView) => {
      romView.setInt16(0x120, 50, true);
    });
    expect(decodeFireRedMapExits(ewram, rom, gridOf(10, 8))).toBeNull();
  });

  it("fails closed on an implausible connection count", () => {
    const { ewram, rom } = syntheticMemory((_ewramView, romView) => {
      romView.setInt32(0x200, 99, true);
    });
    expect(decodeFireRedMapExits(ewram, rom, gridOf(10, 8))).toBeNull();
  });

  it("names known maps and falls back to group-number ids", () => {
    expect(fireRedMapIdFor(4, 1)).toBe("pallet-town/players-house-2f");
    expect(fireRedMapIdFor(3, 19)).toBe("route-1");
    expect(fireRedMapIdFor(3, 39)).toBe("firered-map-3-39");
  });
});

/**
 * A scripted two-map core: a corridor on `map-a` whose far tile is a blocked
 * warp into `map-b` — the shape of every outdoor door. Pressing toward that
 * tile from beside it crosses maps; every other press moves or bumps.
 */
class DoorwayCoreStub implements GbaCoreSeam {
  public readonly coreId: string;
  private position = { mapId: "map-a", x: 0, y: 0 };
  private frame = 0;
  private inputCount = 0;
  /** Whether the door works; a locked door swallows the press. */
  private readonly doorOpens: boolean;

  public constructor(coreId: string, doorOpens: boolean) {
    this.coreId = coreId;
    this.doorOpens = doorOpens;
  }

  public pressButton(button: GbaButton, holdFrames: number): void {
    this.frame += holdFrames;
    this.inputCount += 1;
    if (this.position.mapId !== "map-a") return;
    const step =
      button === "up"
        ? { dx: 0, dy: -1 }
        : button === "down"
          ? { dx: 0, dy: 1 }
          : button === "left"
            ? { dx: -1, dy: 0 }
            : button === "right"
              ? { dx: 1, dy: 0 }
              : null;
    if (step === null) return;
    const next = { x: this.position.x + step.dx, y: this.position.y + step.dy };
    if (next.x === 5 && next.y === 0) {
      if (this.doorOpens) this.position = { mapId: "map-b", x: 0, y: 0 };
      return;
    }
    if (next.x < 0 || next.x > 4 || next.y !== 0) return;
    this.position = { ...this.position, ...next };
  }

  public advanceFrames(frames: number): void {
    this.frame += frames;
  }

  public gameState(): GbaCoreState {
    return {
      mode: "overworld",
      position: { ...this.position },
      facing: "east",
      dialogLineIndex: 0,
      party: [
        {
          slot: 0,
          speciesId: "stub",
          level: 5,
          currentHp: 10,
          maxHp: 10,
          status: "healthy",
          moves: [{ moveId: "stub-move", power: 10 }],
        },
      ],
      activePartySlot: 0,
      battle: null,
      frame: this.frame,
      inputCount: this.inputCount,
      exits: {
        warps: [{ x: 5, y: 0, destinationMapId: "map-b" }],
        connections: [],
      },
    };
  }

  public mapGrid() {
    return {
      minX: 0,
      minY: 0,
      maxX: 6,
      maxY: 1,
      isPassable: (x: number, y: number) => y === 0 && x >= 0 && x <= 4,
    };
  }

  public ramStateSha256(): string {
    return createHash("sha256")
      .update(`doorway-stub:${JSON.stringify(this.position)}`)
      .digest("hex");
  }

  public framebufferSha256(): string {
    return createHash("sha256")
      .update(`doorway-stub-frame:${String(this.frame)}`)
      .digest("hex");
  }
}

async function doorwaySession(doorOpens: boolean) {
  const fixturePath = resolve(
    import.meta.dirname,
    "../../../scenarios/emulator/verdant-path-trainer-battle/v1/scenario.json",
  );
  const bytes = readFileSync(fixturePath);
  const scenario = FrozenGbaScenarioSchema.parse(JSON.parse(bytes.toString("utf8")));
  const adapter = new GbaEmulatorAdapter(
    scenario,
    createHash("sha256").update(bytes).digest("hex"),
    () => new DoorwayCoreStub(scenario.coreId, doorOpens),
  );
  const spec = GbaEmulatorSessionSpecSchema.parse({
    schemaVersion: 2,
    sessionId: "gba-doorway-session",
    environmentKind: "gba_emulator",
    characterId: scenario.player.characterId,
    worldId: scenario.worldId,
    requestedBy: { principal: { kind: "captain", id: "clankie" }, tier: "autonomous" },
    initialGoalVersion: 1,
    resourceBounds: {
      profile: "gba_emulator",
      coreId: scenario.coreId,
      savestateId: scenario.savestateId,
      savestateSha256: scenario.savestateSha256,
      rngSeed: scenario.rngSeed,
      worldId: scenario.worldId,
      characterId: scenario.player.characterId,
      maxInputsPerAction: 8,
      maxFramesPerAction: 600,
      maxActionDurationMs: 5_000,
      capabilities: ["emulator.gba.observe", "emulator.gba.input"],
    },
  });
  const session = await adapter.start(spec, {});
  const command = (actionId: string, action: GbaEmulatorAction): GbaEmulatorStartActionCommand => ({
    schemaVersion: 1,
    commandId: `command-${actionId}`,
    type: "start_action",
    requestedAt: "2026-08-11T00:00:00.000Z",
    context: {
      sourceLane: "gameplay",
      authority: { principal: { kind: "captain", id: "clankie" }, tier: "autonomous" },
      correlationId: `correlation-${actionId}`,
      expectedGoalVersion: 1,
    },
    sessionId: spec.sessionId,
    actionId,
    action: {
      kind: "gba_emulator_action",
      action,
      limits: { maxInputs: 8, maxFrames: 600, timeoutMs: 5_000 },
    },
  });
  return { command, session };
}

describe("walk_to through a doorway", () => {
  it("walks beside a blocked warp tile, presses in, and arrives across maps", async () => {
    const { command, session } = await doorwaySession(true);
    const result = await session.startAction(command("through-door", { kind: "walk_to", x: 5, y: 0 }));
    expect(result).toMatchObject({
      status: "completed",
      outcome: {
        target: { x: 5, y: 0 },
        plannedSteps: 5,
        steps: 5,
        arrived: true,
        warped: true,
        blockedAt: null,
        position: { mapId: "map-b", x: 0, y: 0 },
      },
    });
  });

  it("reports a door that did not open as the blocked tile it behaved as", async () => {
    const { command, session } = await doorwaySession(false);
    const result = await session.startAction(command("locked-door", { kind: "walk_to", x: 5, y: 0 }));
    expect(result).toMatchObject({
      status: "completed",
      outcome: {
        arrived: false,
        warped: false,
        blockedAt: { x: 5, y: 0 },
        position: { mapId: "map-a", x: 4, y: 0 },
      },
    });
  });

  it("still refuses a tile no warp event redeems", async () => {
    const { command, session } = await doorwaySession(true);
    await expect(
      session.startAction(command("off-map", { kind: "walk_to", x: 0, y: 5 })),
    ).rejects.toMatchObject({ errorCode: "walk_target_outside_map" });
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

describe.skipIf(!romAvailable)("FireRed map exits (ROM-gated)", () => {
  it(
    "decodes the bedroom's one exit: the stairs down to the ground floor",
    { timeout: 240_000 },
    async () => {
      const core = await MgbaFireRedCore.create({
        coreId: routeScenario.coreId,
        romBytes: readFileSync(romPath ?? ""),
        savestateBytes: readFileSync(savestatePath ?? ""),
        romSha256: routeScenario.romSha256,
        savestateSha256: routeScenario.savestateSha256,
        coreWasmSha256: routeScenario.coreWasmSha256,
        mapId: routeScenario.map.mapId,
      });
      const state = core.gameState();
      // Ground truth from ADR 0058's stair investigation: the warp event sits on
      // the walkable tile beside the banister, and it leads downstairs.
      expect(state.exits).toEqual({
        warps: [{ x: 17, y: 9, destinationMapId: "pallet-town/players-house-1f" }],
        connections: [],
      });
    },
  );
});
