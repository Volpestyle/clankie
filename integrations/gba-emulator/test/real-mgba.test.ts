import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GbaButton } from "@clankie/interactive-environment";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeterministicGbaCoreDouble,
  FrozenGbaScenarioSchema,
  MgbaFireRedCore,
  RealGbaRouteScenarioSchema,
  decodeLibretroMemoryMap,
  decodeFireRedOverworld,
  mgbaCoreWasmSha256,
  nextRealRouteStep,
  runRealGbaScenario,
  sha256,
  validateGbaEmulatorTrace,
  type GbaCoreSeam,
  type GbaCoreState,
  type RealGbaRouteScenario,
} from "../src/index.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const fixturePath = resolve(import.meta.dirname, "../fixtures/firered-bedroom-route/v1/scenario.json");
const fixtureBytes = readFileSync(fixturePath);
const fixtureSha256 = sha256(fixtureBytes);
const scenario = RealGbaRouteScenarioSchema.parse(JSON.parse(fixtureBytes.toString("utf8")));
const rivalFixturePath = resolve(import.meta.dirname, "../fixtures/firered-oaks-lab-rival/v1/scenario.json");
const rivalScenario = RealGbaRouteScenarioSchema.parse(JSON.parse(readFileSync(rivalFixturePath, "utf8")));
const frozenBattleFixturePath = resolve(
  import.meta.dirname,
  "../../../scenarios/emulator/verdant-path-trainer-battle/v1/scenario.json",
);
const frozenBattleFixture = FrozenGbaScenarioSchema.parse(
  JSON.parse(readFileSync(frozenBattleFixturePath, "utf8")),
);
const gameplayScenario = RealGbaRouteScenarioSchema.parse({
  schemaVersion: 1,
  scenarioId: "firered-gameplay-ci",
  scenarioVersion: 1,
  coreId: frozenBattleFixture.coreId,
  savestateId: frozenBattleFixture.savestateId,
  savestateSha256: frozenBattleFixture.savestateSha256,
  romSha256: sha256("ci-only-fire-red-rom-identity"),
  coreWasmSha256: sha256("ci-only-mgba-core-identity"),
  rngSeed: frozenBattleFixture.rngSeed,
  worldId: frozenBattleFixture.worldId,
  player: { characterId: frozenBattleFixture.player.characterId },
  maxEvidenceEvents: frozenBattleFixture.maxEvidenceEvents,
  maxDecisions: frozenBattleFixture.maxDecisions,
  holdFramesPerStep: 12,
  map: {
    mapId: frozenBattleFixture.map.mapId,
    bounds: {
      minX: 0,
      maxX: frozenBattleFixture.map.width - 1,
      minY: 0,
      maxY: frozenBattleFixture.map.height - 1,
    },
    blocked: frozenBattleFixture.map.blocked,
  },
  start: frozenBattleFixture.player.start,
  target: frozenBattleFixture.targetLocation,
  goal: {
    kind: "trainer_battle_won",
    interactionFacing: "east",
    provePartyMenu: true,
    proveInventoryMenu: true,
  },
  expected: { minimumDecisions: 12 },
});
const gameplayFixtureSha256 = sha256(JSON.stringify(gameplayScenario));
const gameplayIdentity = {
  romSha256: gameplayScenario.romSha256,
  savestateSha256: gameplayScenario.savestateSha256,
  coreWasmSha256: gameplayScenario.coreWasmSha256,
};

/**
 * Test-local stub of the core seam: replays the frozen fixture's verified
 * tile map so the governed runner, adapter, and evidence chain are provable
 * in CI without a ROM. Not a product simulator.
 */
interface RouteStubQuirks {
  /** Directed transitions ("x,y>x,y") the stub refuses, like real collision. */
  blockedEdges?: Set<string>;
  /** Input ordinal that jumps the player to an unexpected tile (desync). */
  teleportAt?: number;
  /** Input ordinal that consumes no frames (frozen observation stream). */
  freezeAt?: number;
}

class RouteStubCore implements GbaCoreSeam {
  public readonly coreId: string;
  private x: number;
  private y: number;
  private facing: GbaCoreState["facing"] = "north";
  private frame = 0;
  private inputCount = 0;
  private readonly blocked: Set<string>;
  private readonly fixture: RealGbaRouteScenario;
  private readonly quirks: RouteStubQuirks;

  public constructor(fixture: RealGbaRouteScenario, quirks: RouteStubQuirks = {}) {
    this.fixture = fixture;
    this.quirks = quirks;
    this.coreId = fixture.coreId;
    this.x = fixture.start.x;
    this.y = fixture.start.y;
    this.blocked = new Set(fixture.map.blocked.map((tile) => `${String(tile.x)},${String(tile.y)}`));
  }

  public pressButton(button: GbaButton, holdFrames: number): void {
    this.inputCount += 1;
    if (this.quirks.freezeAt !== this.inputCount) this.frame += holdFrames + 32;
    const deltas: Partial<Record<GbaButton, { dx: number; dy: number; facing: GbaCoreState["facing"] }>> = {
      up: { dx: 0, dy: -1, facing: "north" },
      down: { dx: 0, dy: 1, facing: "south" },
      left: { dx: -1, dy: 0, facing: "west" },
      right: { dx: 1, dy: 0, facing: "east" },
    };
    const delta = deltas[button];
    if (!delta) return;
    const priorFacing = this.facing;
    this.facing = delta.facing;
    // FireRed consumes a newly faced direction as a turn before a later
    // press walks. The real runner must not misclassify that turn as a
    // collision and permanently remove a valid graph edge.
    if (priorFacing !== delta.facing) return;
    if (this.quirks.teleportAt === this.inputCount) {
      this.x = this.fixture.start.x;
      this.y = this.fixture.start.y;
      return;
    }
    const nx = this.x + delta.dx;
    const ny = this.y + delta.dy;
    const { bounds } = this.fixture.map;
    if (
      nx < bounds.minX ||
      nx > bounds.maxX ||
      ny < bounds.minY ||
      ny > bounds.maxY ||
      this.blocked.has(`${String(nx)},${String(ny)}`) ||
      this.quirks.blockedEdges?.has(`${String(this.x)},${String(this.y)}>${String(nx)},${String(ny)}`)
    ) {
      return;
    }
    this.x = nx;
    this.y = ny;
  }

  public advanceFrames(frames: number): void {
    this.frame += frames;
  }

  public gameState(): GbaCoreState {
    return {
      mode: "overworld",
      position: { mapId: this.fixture.map.mapId, x: this.x, y: this.y },
      facing: this.facing,
      dialogLineIndex: 0,
      party: [],
      activePartySlot: 0,
      battle: null,
      frame: this.frame,
      inputCount: this.inputCount,
    };
  }

  public ramStateSha256(): string {
    return sha256(`stub-ram:${String(this.x)},${String(this.y)},${this.facing},${String(this.frame)}`);
  }

  public framebufferSha256(): string {
    return sha256(`stub-frame:${String(this.frame)}:${String(this.x)},${String(this.y)}`);
  }
}

const identity = {
  romSha256: scenario.romSha256,
  savestateSha256: scenario.savestateSha256,
  coreWasmSha256: scenario.coreWasmSha256,
};

describe("real-core route scenario (CI-safe)", () => {
  it("copies wasm32 libretro memory descriptors with the aligned ABI stride", () => {
    const heap = new Uint8Array(0x90000);
    const view = new DataView(heap.buffer);
    const mapPointer = 0x100;
    const descriptorsPointer = 0x200;
    view.setUint32(mapPointer, descriptorsPointer, true);
    view.setUint32(mapPointer + 4, 2, true);

    const writeDescriptor = (index: number, heapPointer: number, busAddress: number, byteLength: number) => {
      const base = descriptorsPointer + index * 40;
      view.setBigUint64(base, index === 0 ? 1n : 0n, true);
      view.setUint32(base + 8, heapPointer, true);
      view.setUint32(base + 12, 0, true);
      view.setUint32(base + 16, busAddress, true);
      view.setUint32(base + 20, 0xff000000, true);
      view.setUint32(base + 24, 0, true);
      view.setUint32(base + 28, byteLength, true);
    };
    writeDescriptor(0, 0x10000, 0x03000000, 0x8000);
    writeDescriptor(1, 0x20000, 0x02000000, 0x40000);

    expect(decodeLibretroMemoryMap(heap, mapPointer)).toEqual([
      {
        flags: 1n,
        heapPointer: 0x10000,
        offset: 0,
        busAddress: 0x03000000,
        select: 0xff000000,
        disconnect: 0,
        byteLength: 0x8000,
      },
      {
        flags: 0n,
        heapPointer: 0x20000,
        offset: 0,
        busAddress: 0x02000000,
        select: 0xff000000,
        disconnect: 0,
        byteLength: 0x40000,
      },
    ]);
    view.setUint32(mapPointer + 4, 65, true);
    expect(() => decodeLibretroMemoryMap(heap, mapPointer)).toThrow(/descriptor count/);
  });

  it("freezes a schema-valid fixture whose route exists over verified tiles only", () => {
    expect(scenario.scenarioId).toBe("firered-bedroom-route");
    // Walk the fixture's BFS from start to target; every visited tile must be
    // inside bounds and unblocked, and the route must terminate.
    const blocked = new Set(scenario.map.blocked.map((tile) => `${String(tile.x)},${String(tile.y)}`));
    let position = { ...scenario.start };
    const steps: string[] = [];
    while (!(position.x === scenario.target.x && position.y === scenario.target.y)) {
      const button = nextRealRouteStep(scenario, position);
      expect(button).not.toBeNull();
      if (button === null) return;
      steps.push(button);
      const delta = {
        up: { dx: 0, dy: -1 },
        down: { dx: 0, dy: 1 },
        left: { dx: -1, dy: 0 },
        right: { dx: 1, dy: 0 },
      }[button];
      position = { ...position, x: position.x + delta.dx, y: position.y + delta.dy };
      expect(blocked.has(`${String(position.x)},${String(position.y)}`)).toBe(false);
      expect(steps.length).toBeLessThanOrEqual(scenario.maxDecisions);
    }
    expect(steps.length).toBeGreaterThanOrEqual(scenario.expected.minimumDecisions - 1);
    expect(new Set(steps).size).toBeGreaterThanOrEqual(2);
  });

  it("freezes the ROM-gated rival scenario without copyrighted bytes", () => {
    expect(rivalScenario).toMatchObject({
      scenarioId: "firered-oaks-lab-rival",
      romSha256: "3d0c79f1627022e18765766f6cb5ea067f6b5bf7dca115552189ad65a5c3a8ac",
      start: { mapId: "pallet-town/professor-oaks-lab", x: 17, y: 12 },
      target: { mapId: "pallet-town/professor-oaks-lab", x: 14, y: 15 },
      goal: {
        kind: "trainer_battle_won",
        provePartyMenu: true,
        proveInventoryMenu: true,
      },
    });
    expect(rivalScenario.savestateSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("runs the governed route scenario deterministically over the core seam", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "gba-real-stub-first-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "gba-real-stub-second-"));
    roots.push(firstRoot, secondRoot);
    const first = await runRealGbaScenario({
      rootDir: firstRoot,
      scenario,
      fixtureSha256,
      core: new RouteStubCore(scenario),
      coreIdentity: identity,
    });
    const second = await runRealGbaScenario({
      rootDir: secondRoot,
      scenario,
      fixtureSha256,
      core: new RouteStubCore(scenario),
      coreIdentity: identity,
    });
    expect(JSON.stringify(first.report)).toEqual(JSON.stringify(second.report));
    expect(JSON.stringify(first.decisionTrace)).toEqual(JSON.stringify(second.decisionTrace));
    expect(JSON.stringify(first.trace)).toEqual(JSON.stringify(second.trace));
    expect(first.report).toMatchObject({
      result: "passed",
      halt: "target_reached",
      finalState: { position: { x: scenario.target.x, y: scenario.target.y } },
    });
    expect(first.goalEvent).toMatchObject({ type: "environment.goal.verified" });
    expect(() => validateGbaEmulatorTrace(first.trace)).not.toThrow();
    expect(first.decisionTrace.decisions.at(-1)).toMatchObject({ reasonCode: "halt_target_reached" });
  });

  it("proves menus, inventory, dialog, navigation, and a won trainer battle in one state-derived run", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "gba-real-gameplay-ci-"));
    roots.push(rootDir);
    const result = await runRealGbaScenario({
      rootDir,
      scenario: gameplayScenario,
      fixtureSha256: gameplayFixtureSha256,
      core: new DeterministicGbaCoreDouble(frozenBattleFixture),
      coreIdentity: gameplayIdentity,
    });

    expect(result.report).toMatchObject({
      result: "passed",
      halt: "battle_won",
      checks: {
        partyMenuObserved: true,
        inventoryMenuObserved: true,
        trainerBattleWon: true,
      },
      finalState: {
        position: frozenBattleFixture.targetLocation,
        battleResult: "won",
      },
    });
    expect(result.decisionTrace.decisions.map(({ reasonCode }) => reasonCode)).toEqual(
      expect.arrayContaining([
        "open_start_menu",
        "observe_and_close_party_menu",
        "observe_and_close_inventory_menu",
        "route_step_toward_target",
        "engage_trainer",
        "advance_dialog",
        "move_cursor_to_best_move",
        "select_best_move",
        "halt_battle_won",
      ]),
    );
  });

  it("replans around an emulator-refused transition and still reaches the target", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "gba-real-stub-edge-"));
    roots.push(rootDir);
    // The same directed collision the real FireRed bedroom exhibits.
    const result = await runRealGbaScenario({
      rootDir,
      scenario,
      fixtureSha256,
      core: new RouteStubCore(scenario, { blockedEdges: new Set(["9,12>9,11"]) }),
      coreIdentity: identity,
    });
    expect(result.report).toMatchObject({ result: "passed", halt: "target_reached" });
    // The refused step shows up in the trace, followed by a rerouted path.
    const buttons = result.decisionTrace.decisions.map((decision) =>
      decision.action?.kind === "button_press" ? decision.action.button : undefined,
    );
    expect(buttons.filter((button) => button !== undefined).length).toBeGreaterThan(6);
  });

  it("fails closed when the player lands on an unexpected tile (desync)", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "gba-real-stub-teleport-"));
    roots.push(rootDir);
    const result = await runRealGbaScenario({
      rootDir,
      scenario,
      fixtureSha256,
      core: new RouteStubCore(scenario, { teleportAt: 3 }),
      coreIdentity: identity,
    });
    expect(result.report).toMatchObject({ result: "failed", halt: "uncertain_state" });
    expect(result.goalEvent).toMatchObject({ type: "environment.goal.failed" });
  });

  it("fails closed when the frame counter does not advance after an input", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "gba-real-stub-freeze-"));
    roots.push(rootDir);
    const result = await runRealGbaScenario({
      rootDir,
      scenario,
      fixtureSha256,
      core: new RouteStubCore(scenario, { freezeAt: 2 }),
      coreIdentity: identity,
    });
    expect(result.report).toMatchObject({ result: "failed", halt: "uncertain_state" });
  });

  it("fails the identity check when the core identity is absent or mismatched", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "gba-real-stub-identity-"));
    roots.push(rootDir);
    const result = await runRealGbaScenario({
      rootDir,
      scenario,
      fixtureSha256,
      core: new RouteStubCore(scenario),
    });
    expect(result.report.checks.identityVerified).toBe(false);
    expect(result.report.result).toBe("failed");
  });

  it("decodes verified EWRAM fields and rejects implausible snapshots", () => {
    const ewram = new Uint8Array(0x40000);
    ewram[0x36e48] = 13;
    ewram[0x36e4a] = 13;
    ewram[0x36e58] = 2;
    expect(decodeFireRedOverworld(ewram)).toEqual({ x: 13, y: 13, facing: "north" });
    ewram[0x36e58] = 9;
    expect(() => decodeFireRedOverworld(ewram)).toThrow(/facing/);
    expect(() => decodeFireRedOverworld(new Uint8Array(16))).toThrow(/EWRAM/);
  });
});

const romPath = process.env["CLANKIE_GBA_ROM_PATH"];
const savestatePath = process.env["CLANKIE_GBA_SAVESTATE_PATH"];
const romAvailable =
  romPath !== undefined && existsSync(romPath) && savestatePath !== undefined && existsSync(savestatePath);

describe.skipIf(!romAvailable)("real mGBA core (ROM-gated)", () => {
  const load = () => ({
    romBytes: readFileSync(romPath ?? ""),
    savestateBytes: readFileSync(savestatePath ?? ""),
  });

  it(
    "boots the pinned core from the pinned savestate and decodes the verified start state",
    { timeout: 240_000 },
    async () => {
      const { romBytes, savestateBytes } = load();
      const core = await MgbaFireRedCore.create({
        coreId: scenario.coreId,
        romBytes,
        savestateBytes,
        romSha256: scenario.romSha256,
        savestateSha256: scenario.savestateSha256,
        coreWasmSha256: scenario.coreWasmSha256,
        mapId: scenario.map.mapId,
      });
      expect(core.gameState()).toMatchObject({
        mode: "overworld",
        position: { mapId: scenario.map.mapId, x: scenario.start.x, y: scenario.start.y },
        facing: "north",
      });
      // Real input drives real state: one step right moves one tile east.
      core.pressButton("right", scenario.holdFramesPerStep);
      expect(core.gameState()).toMatchObject({
        position: { x: scenario.start.x + 1, y: scenario.start.y },
        facing: "east",
        inputCount: 1,
      });
    },
  );

  it("is byte-deterministic across two freshly instantiated cores", { timeout: 240_000 }, async () => {
    const { romBytes, savestateBytes } = load();
    const init = {
      coreId: scenario.coreId,
      romBytes,
      savestateBytes,
      romSha256: scenario.romSha256,
      savestateSha256: scenario.savestateSha256,
      coreWasmSha256: scenario.coreWasmSha256,
      mapId: scenario.map.mapId,
    };
    const first = await MgbaFireRedCore.create(init);
    const second = await MgbaFireRedCore.create(init);
    for (const core of [first, second]) {
      core.pressButton("left", scenario.holdFramesPerStep);
      core.pressButton("up", scenario.holdFramesPerStep);
    }
    expect(first.ramStateSha256()).toEqual(second.ramStateSha256());
    expect(first.framebufferSha256()).toEqual(second.framebufferSha256());
    expect(first.gameState()).toEqual(second.gameState());
  });

  it("fails closed on any pinned-identity mismatch", { timeout: 240_000 }, async () => {
    const { romBytes, savestateBytes } = load();
    await expect(
      MgbaFireRedCore.create({
        coreId: scenario.coreId,
        romBytes,
        savestateBytes,
        romSha256: "0".repeat(64),
        savestateSha256: scenario.savestateSha256,
        coreWasmSha256: scenario.coreWasmSha256,
        mapId: scenario.map.mapId,
      }),
    ).rejects.toThrow(/ROM bytes/);
    expect(mgbaCoreWasmSha256()).toEqual(scenario.coreWasmSha256);
  });
});
