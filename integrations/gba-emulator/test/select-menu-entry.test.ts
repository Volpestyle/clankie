import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  GbaEmulatorSessionSpecSchema,
  type EnvironmentEvent,
  type GbaButton,
  type GbaEmulatorAction,
  type GbaEmulatorStartActionCommand,
} from "@clankie/interactive-environment";
import { EnvironmentRuntime } from "@clankie/environment-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  FrozenGbaScenarioSchema,
  GbaEmulatorAdapter,
  type GbaCoreSeam,
  type GbaCoreState,
} from "../src/index.ts";
import { observeEffect } from "../src/free-play-progress.ts";

/**
 * `select_menu_entry`: one action walks the cursor to a named entry and
 * confirms it. The scripted core exists because the interesting cases are the
 * stops — a vanished menu, a cursor that will not move, an exhausted budget —
 * and each needs a menu whose geometry the test controls.
 */

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const fixtureRoot = resolve(
  import.meta.dirname,
  "../../../scenarios/emulator/verdant-path-trainer-battle/v1",
);

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

interface ScriptedMenu {
  menuId: string;
  cursor: number;
  entries: { id: string; label: string }[];
  /** 2 for the battle grids, 1 for vertical lists. */
  columns: 1 | 2;
}

/**
 * A core whose only interesting state is an open menu. Directional presses
 * move the cursor by the menu's real geometry — XOR for the 2×2 battle grids,
 * linear for lists — A closes the menu as a selection, and every button is
 * recorded so a test can assert none landed after a stop.
 */
class ScriptedMenuCore implements GbaCoreSeam {
  public readonly coreId = "scripted-menu-core";
  public readonly pressed: GbaButton[] = [];
  public menu: ScriptedMenu | null;
  public selected: string | null = null;
  /** Set true to make the cursor ignore every directional press. */
  public stuck = false;
  /** Close the menu after this many directional presses, mid-navigation. */
  public closeAfterPresses: number | null = null;
  private frame = 0;
  private inputCount = 0;

  public constructor(menu: ScriptedMenu | null) {
    this.menu = menu;
  }

  public async pressButton(button: GbaButton, holdFrames: number): Promise<void> {
    this.pressed.push(button);
    this.frame += holdFrames;
    this.inputCount += 1;
    const menu = this.menu;
    if (menu === null) return;
    if (button === "a") {
      this.selected = menu.entries[menu.cursor]?.id ?? null;
      this.menu = null;
      return;
    }
    if (this.stuck) return;
    if (this.closeAfterPresses !== null) {
      this.closeAfterPresses -= 1;
      if (this.closeAfterPresses < 0) {
        this.menu = null;
        return;
      }
    }
    const size = menu.entries.length;
    if (menu.columns === 2) {
      // The battle grids: left/right flip bit 0, up/down flip bit 1.
      const next = button === "left" || button === "right" ? menu.cursor ^ 1 : menu.cursor ^ 2;
      if (next < size) menu.cursor = next;
      return;
    }
    if (button === "down" && menu.cursor < size - 1) menu.cursor += 1;
    if (button === "up" && menu.cursor > 0) menu.cursor -= 1;
  }

  public async advanceFrames(frames: number): Promise<void> {
    this.frame += frames;
  }

  public gameState(): GbaCoreState {
    return {
      mode: "overworld",
      position: { mapId: "scripted", x: 1, y: 1 },
      facing: "north",
      dialogLineIndex: 0,
      dialogLines: [],
      waitingForDialogAdvance: false,
      menu:
        this.menu === null
          ? null
          : {
              menuId: this.menu.menuId,
              cursor: this.menu.cursor,
              entries: this.menu.entries.map((entry) => ({ ...entry })),
            },
      party: [],
      activePartySlot: 0,
      battle: null,
      frame: this.frame,
      inputCount: this.inputCount,
    };
  }

  public ramStateSha256(): string {
    return sha256(`scripted-ram:${String(this.frame)}`);
  }

  public framebufferSha256(): string {
    return sha256(`scripted-frame:${String(this.frame)}`);
  }
}

async function harness(core: ScriptedMenuCore) {
  const bytes = await readFile(resolve(fixtureRoot, "scenario.json"));
  const scenario = FrozenGbaScenarioSchema.parse(JSON.parse(bytes.toString("utf8")));
  const fixtureSha256 = createHash("sha256").update(bytes).digest("hex");
  const rootDir = await mkdtemp(join(tmpdir(), "gba-select-menu-"));
  roots.push(rootDir);
  const adapter = new GbaEmulatorAdapter(scenario, fixtureSha256, () => core);
  const events: EnvironmentEvent[] = [];
  const runtime = new EnvironmentRuntime({
    rootDir,
    adapter,
    events: { append: (event) => (events.push(event), Promise.resolve()) },
    clock: () => new Date("2026-08-01T00:00:00.000Z"),
    randomToken: () => "private-grant-marker",
  });
  const spec = GbaEmulatorSessionSpecSchema.parse({
    schemaVersion: 2,
    sessionId: "gba-select-menu-session",
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
      capabilities: ["emulator.gba.observe", "emulator.gba.input", "emulator.gba.frame_advance"],
    },
  });
  const grant = await runtime.start({
    spec,
    holderId: "runner",
    correlationId: "select-menu",
    leaseDurationMs: 10_000,
  });
  const command = (actionId: string, action: GbaEmulatorAction): GbaEmulatorStartActionCommand => ({
    schemaVersion: 1,
    commandId: `command-${actionId}`,
    type: "start_action",
    requestedAt: "2026-08-01T00:00:00.000Z",
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
  return { command, grant, runtime };
}

const select = (entryId: string): GbaEmulatorAction => ({ kind: "select_menu_entry", entryId });

const battleMoveMenu = (): ScriptedMenu => ({
  menuId: "battle-move-menu",
  cursor: 0,
  entries: [
    { id: "firered-move-33", label: "firered-move-33" },
    { id: "firered-move-45", label: "firered-move-45" },
    { id: "firered-move-39", label: "firered-move-39" },
    { id: "firered-move-52", label: "firered-move-52" },
  ],
  columns: 2,
});

const startMenu = (): ScriptedMenu => ({
  menuId: "start-menu",
  cursor: 4,
  entries: [
    { id: "start-menu-0", label: "POKéDEX" },
    { id: "start-menu-1", label: "POKéMON" },
    { id: "start-menu-2", label: "BAG" },
    { id: "start-menu-3", label: "PLAYER" },
    { id: "start-menu-4", label: "SAVE" },
    { id: "start-menu-5", label: "OPTION" },
  ],
  columns: 1,
});

async function dispatch(core: ScriptedMenuCore, action: GbaEmulatorAction) {
  const { command, grant, runtime } = await harness(core);
  return runtime.startAction(grant.token, command("select-1", action));
}

describe("select_menu_entry", () => {
  it("crosses the 2×2 battle grid by XOR and confirms the named move", async () => {
    const core = new ScriptedMenuCore(battleMoveMenu());
    const result = await dispatch(core, select("firered-move-52"));

    expect(result.status).toBe("completed");
    const outcome = (result as { outcome: Record<string, unknown> }).outcome;
    expect(outcome).toMatchObject({
      confirmed: true,
      endedBecause: "selected",
      entryId: "firered-move-52",
      menuId: "battle-move-menu",
      // Index 0 → 3 is one horizontal flip, one vertical flip, then A.
      presses: 3,
    });
    expect(core.selected).toBe("firered-move-52");
    expect(core.pressed).toEqual(["right", "down", "a"]);
  });

  it("walks a vertical list upward and confirms", async () => {
    const core = new ScriptedMenuCore(startMenu());
    const result = await dispatch(core, select("start-menu-1"));

    expect(result.status).toBe("completed");
    expect((result as { outcome: Record<string, unknown> }).outcome).toMatchObject({
      confirmed: true,
      presses: 4,
    });
    expect(core.pressed).toEqual(["up", "up", "up", "a"]);
  });

  it("already on the entry, spends only the confirming A", async () => {
    const menu = startMenu();
    menu.cursor = 2;
    const core = new ScriptedMenuCore(menu);
    const result = await dispatch(core, select("start-menu-2"));
    expect((result as { outcome: Record<string, unknown> }).outcome).toMatchObject({
      confirmed: true,
      presses: 1,
    });
  });

  it("fails closed when no menu is open", async () => {
    const core = new ScriptedMenuCore(null);
    const result = await dispatch(core, select("start-menu-1"));
    expect(result.status).toBe("failed");
    expect((result as { errorCode: string }).errorCode).toBe("menu_not_open");
    expect(core.pressed).toEqual([]);
  });

  it("fails closed when the entry is not in the open menu", async () => {
    const core = new ScriptedMenuCore(startMenu());
    const result = await dispatch(core, select("not-an-entry"));
    expect(result.status).toBe("failed");
    expect((result as { errorCode: string }).errorCode).toBe("menu_entry_not_found");
    expect(core.pressed).toEqual([]);
  });

  it("stops without confirming when the cursor refuses to move", async () => {
    const core = new ScriptedMenuCore(startMenu());
    core.stuck = true;
    const result = await dispatch(core, select("start-menu-1"));

    expect(result.status).toBe("completed");
    const outcome = (result as { outcome: Record<string, unknown> }).outcome;
    expect(outcome).toMatchObject({ confirmed: false, endedBecause: "cursor_stalled" });
    // The stop is the point: no A landed on an entry he did not name.
    expect(core.pressed).not.toContain("a");
    expect(core.selected).toBeNull();
  });

  it("stops without confirming when the menu closes mid-navigation", async () => {
    const core = new ScriptedMenuCore(startMenu());
    core.closeAfterPresses = 1;
    const result = await dispatch(core, select("start-menu-1"));

    expect(result.status).toBe("completed");
    expect((result as { outcome: Record<string, unknown> }).outcome).toMatchObject({
      confirmed: false,
      endedBecause: "menu_closed",
    });
    expect(core.pressed).not.toContain("a");
  });

  it("renders the choice as the effect line, not 'menu changed'", async () => {
    const core = new ScriptedMenuCore(battleMoveMenu());
    const before = core.gameState();
    const result = await dispatch(core, select("firered-move-45"));
    const effect = observeEffect({
      before: [
        {
          schemaVersion: 1,
          kind: "menu",
          observationId: "obs-1",
          sessionId: "gba-select-menu-session",
          characterId: "clankie",
          worldId: "w",
          goalVersion: 1,
          capturedAt: "2026-08-01T00:00:00.000Z",
          frame: before.frame,
          data: {},
        } as never,
      ],
      after: [],
      action: select("firered-move-45"),
      outcome: (result as { outcome: Record<string, unknown> }).outcome,
    });
    expect(effect.summary).toContain('chose "firered-move-45" in battle-move-menu');
  });
});
