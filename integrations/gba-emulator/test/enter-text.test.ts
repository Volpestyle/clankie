import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  GbaEmulatorSessionSpecSchema,
  type EnvironmentEvent,
  type GbaButton,
  type GbaEmulatorAction,
  type GbaEmulatorActionLimits,
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
 * `enter_text` (ADR 0072): one action types a whole name.
 *
 * The scripted core below models the FireRed naming screen exactly as the
 * 2026-07-26 RAM probe verified it — column rings that wrap, direct rows,
 * SELECT page cycling that eats d-pad input for ~30 frames, auto-jump to OK
 * on the tenth character, START jumping to OK, and A on OK closing the
 * screen. Its key grids are transcribed here independently from the probe
 * report, so a typo in the production layout tables fails these tests
 * instead of being mirrored by them.
 */

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const fixtureRoot = resolve(
  import.meta.dirname,
  "../../../scenarios/emulator/verdant-path-trainer-battle/v1",
);

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

type Page = "upper-case" | "lower-case" | "symbols";
const PAGE_CYCLE: readonly Page[] = ["upper-case", "lower-case", "symbols"];

/** Grids per the probe report — independent of src/naming-keyboard.ts. */
const GRIDS: Readonly<Record<Page, readonly (readonly string[])[]>> = {
  "upper-case": [
    ["A", "B", "C", "D", "E", "F", " ", "."],
    ["G", "H", "I", "J", "K", "L", " ", ","],
    ["M", "N", "O", "P", "Q", "R", "S"],
    ["T", "U", "V", "W", "X", "Y", "Z"],
  ],
  "lower-case": [
    ["a", "b", "c", "d", "e", "f", " ", "."],
    ["g", "h", "i", "j", "k", "l", " ", ","],
    ["m", "n", "o", "p", "q", "r", "s"],
    ["t", "u", "v", "w", "x", "y", "z"],
  ],
  symbols: [
    ["0", "1", "2", "3", "4"],
    ["5", "6", "7", "8", "9"],
    ["!", "?", "♂", "♀", "/", "-"],
  ],
};

const BUTTON_COL: Readonly<Record<Page, number>> = { "upper-case": 8, "lower-case": 8, symbols: 6 };
const MAX_NAME = 10;
const PAGE_SWAP_INPUT_EATEN_FRAMES = 30;

/** A core whose only interesting state is the naming screen. */
class ScriptedNamingCore implements GbaCoreSeam {
  public readonly coreId = "scripted-naming-core";
  public readonly pressed: GbaButton[] = [];
  public committedName: string | null = null;
  public buffer: string;
  public open = true;
  private page: Page = "upper-case";
  private row = 0;
  private column = 0;
  private frame = 0;
  private inputCount = 0;
  private dpadBlockedUntil = 0;

  public constructor(prefilled = "") {
    this.buffer = prefilled;
  }

  public pressButton(button: GbaButton, holdFrames: number): void {
    this.pressed.push(button);
    this.inputCount += 1;
    this.frame += holdFrames;
    if (!this.open) return;
    const dpad = button === "up" || button === "down" || button === "left" || button === "right";
    if (dpad && this.frame < this.dpadBlockedUntil) return; // page swap eats it
    if (button === "select") {
      this.page = PAGE_CYCLE[(PAGE_CYCLE.indexOf(this.page) + 1) % PAGE_CYCLE.length] ?? this.page;
      this.dpadBlockedUntil = this.frame + PAGE_SWAP_INPUT_EATEN_FRAMES;
      return;
    }
    if (button === "start") {
      this.row = 2;
      this.column = BUTTON_COL[this.page];
      return;
    }
    const ring = BUTTON_COL[this.page] + 1;
    if (button === "left") this.column = (this.column - 1 + ring) % ring;
    if (button === "right") this.column = (this.column + 1) % ring;
    if (button === "up") this.row = Math.max(0, this.row - 1);
    if (button === "down") {
      // DOWN wraps 3→0 on the letter grid; the button strip has rows 0–2.
      const maxRow = this.column === BUTTON_COL[this.page] ? 2 : 3;
      this.row = this.row >= maxRow ? 0 : this.row + 1;
    }
    if (button === "b") {
      this.buffer = this.buffer.slice(0, -1);
      return;
    }
    if (button !== "a") return;
    if (this.column === BUTTON_COL[this.page]) {
      if (this.row === 2) {
        // OK: close and commit, even with an empty buffer.
        this.open = false;
        this.committedName = this.buffer;
      } else if (this.row === 1) {
        this.buffer = this.buffer.slice(0, -1);
      } else {
        this.page = PAGE_CYCLE[(PAGE_CYCLE.indexOf(this.page) + 1) % PAGE_CYCLE.length] ?? this.page;
        this.dpadBlockedUntil = this.frame + PAGE_SWAP_INPUT_EATEN_FRAMES;
      }
      return;
    }
    const key = GRIDS[this.page][this.row]?.[this.column];
    if (key === undefined || this.buffer.length >= MAX_NAME) return;
    this.buffer += key;
    if (this.buffer.length === MAX_NAME) {
      this.row = 2;
      this.column = BUTTON_COL[this.page];
    }
  }

  public advanceFrames(frames: number): void {
    this.frame += frames;
  }

  public gameState(): GbaCoreState {
    return {
      mode: "overworld",
      inputReady: false,
      position: { mapId: "scripted", x: 1, y: 1 },
      facing: "north",
      dialogLineIndex: 0,
      dialogLines: [],
      naming: this.open ? { text: this.buffer, page: this.page, row: this.row, column: this.column } : null,
      menu: this.open ? { menuId: "naming-screen", cursor: 0, entries: [] } : null,
      party: [],
      activePartySlot: 0,
      battle: null,
      frame: this.frame,
      inputCount: this.inputCount,
    };
  }

  public ramStateSha256(): string {
    return sha256(`naming-ram:${this.buffer}:${String(this.frame)}`);
  }

  public framebufferSha256(): string {
    return sha256(`naming-frame:${String(this.frame)}`);
  }
}

const LIMITS: GbaEmulatorActionLimits = { maxInputs: 64, maxFrames: 1_800, timeoutMs: 5_000 };

async function harness(core?: ScriptedNamingCore) {
  const bytes = await readFile(resolve(fixtureRoot, "scenario.json"));
  const scenario = FrozenGbaScenarioSchema.parse(JSON.parse(bytes.toString("utf8")));
  const fixtureSha256 = createHash("sha256").update(bytes).digest("hex");
  const rootDir = await mkdtemp(join(tmpdir(), "gba-enter-text-"));
  roots.push(rootDir);
  const adapter =
    core === undefined
      ? new GbaEmulatorAdapter(scenario, fixtureSha256)
      : new GbaEmulatorAdapter(scenario, fixtureSha256, () => core, { evidencePolicy: "rolling" });
  const events: EnvironmentEvent[] = [];
  const runtime = new EnvironmentRuntime({
    rootDir,
    adapter,
    events: { append: (event) => (events.push(event), Promise.resolve()) },
    clock: () => new Date("2026-07-27T00:00:00.000Z"),
    randomToken: () => "private-grant-marker",
  });
  const spec = GbaEmulatorSessionSpecSchema.parse({
    schemaVersion: 2,
    sessionId: "gba-enter-text-session",
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
      maxInputsPerAction: LIMITS.maxInputs,
      maxFramesPerAction: LIMITS.maxFrames,
      maxActionDurationMs: LIMITS.timeoutMs,
      capabilities: [
        "emulator.gba.observe",
        "emulator.gba.input",
        "emulator.gba.frame_advance",
        "emulator.gba.wait",
      ],
    },
  });
  const grant = await runtime.start({
    spec,
    holderId: "runner",
    correlationId: "enter-text",
    leaseDurationMs: 10_000,
  });
  let sequence = 0;
  const act = (action: GbaEmulatorAction, limits: GbaEmulatorActionLimits = LIMITS) => {
    sequence += 1;
    const command: GbaEmulatorStartActionCommand = {
      schemaVersion: 1,
      commandId: `command-${String(sequence)}`,
      type: "start_action",
      requestedAt: "2026-07-27T00:00:00.000Z",
      context: {
        sourceLane: "gameplay",
        authority: { principal: { kind: "captain", id: "clankie" }, tier: "autonomous" },
        correlationId: `correlation-${String(sequence)}`,
        expectedGoalVersion: 1,
      },
      sessionId: spec.sessionId,
      actionId: `action-${String(sequence)}`,
      action: { kind: "gba_emulator_action", action, limits },
    };
    return runtime.startAction(grant.token, command);
  };
  return { act, core };
}

const type = (text: string, submit?: boolean): GbaEmulatorAction =>
  submit === undefined ? { kind: "enter_text", text } : { kind: "enter_text", text, submit };

describe("enter_text", () => {
  it("types a name and confirms it in one action", async () => {
    const core = new ScriptedNamingCore();
    const { act } = await harness(core);
    const result = await act(type("GASKET"));

    expect(result).toMatchObject({
      status: "completed",
      outcome: { confirmed: true, endedBecause: "confirmed", typed: "GASKET" },
    });
    expect(core.committedName).toBe("GASKET");
    expect(core.open).toBe(false);
  });

  it("switches pages for mixed character sets, surviving the input-eating swap", async () => {
    const core = new ScriptedNamingCore();
    const { act } = await harness(core);
    const result = await act(type("Gg3"));

    expect(result).toMatchObject({
      status: "completed",
      outcome: { confirmed: true, endedBecause: "confirmed" },
    });
    // The confirm must come from the letter pages — the symbols-page button
    // strip is unverified territory the navigator must never use.
    expect(core.committedName).toBe("Gg3");
  });

  it("leaves the screen open when asked not to submit", async () => {
    const core = new ScriptedNamingCore();
    const { act } = await harness(core);
    const result = await act(type("AB", false));

    expect(result).toMatchObject({
      status: "completed",
      outcome: { confirmed: false, endedBecause: "typed", typed: "AB" },
    });
    expect(core.open).toBe(true);
    expect(core.buffer).toBe("AB");
  });

  it("keeps a matching prefix and erases a wrong one", async () => {
    const matching = new ScriptedNamingCore("GAS");
    const { act } = await harness(matching);
    await act(type("GASKET", false));
    expect(matching.buffer).toBe("GASKET");
    // Nothing was erased on the way: no B press appears in the input record.
    expect(matching.pressed).not.toContain("b");

    const mismatched = new ScriptedNamingCore("GAX");
    const second = await harness(mismatched);
    await second.act(type("GASKET", false));
    expect(mismatched.buffer).toBe("GASKET");
    expect(mismatched.pressed).toContain("b");
  });

  it("stops honestly on the input budget and resumes with the same action", async () => {
    const core = new ScriptedNamingCore();
    const { act } = await harness(core);
    const first = await act(type("GASKET"), { ...LIMITS, maxInputs: 8 });

    expect(first).toMatchObject({
      status: "completed",
      outcome: { confirmed: false, endedBecause: "input_bound_reached" },
    });
    const typedSoFar = (first as unknown as { outcome: { typed: string } }).outcome.typed;
    expect("GASKET".startsWith(typedSoFar)).toBe(true);
    expect(typedSoFar.length).toBeGreaterThan(0);

    // Same action again with the full budget finishes from where it stopped.
    const second = await act(type("GASKET"));
    expect(second).toMatchObject({ status: "completed", outcome: { confirmed: true } });
    expect(core.committedName).toBe("GASKET");
  });

  it("refuses when no naming screen is open", async () => {
    const { act } = await harness();
    const result = await act(type("GASKET"));
    expect(result).toMatchObject({ status: "failed", errorCode: "naming_screen_not_open" });
  });

  it("tells him what landed, in the effect line he reads", () => {
    const confirmed = observeEffect({
      before: [],
      after: [],
      action: { kind: "enter_text", text: "GASKET" },
      outcome: { typed: "GASKET", confirmed: true, endedBecause: "confirmed" },
    });
    expect(confirmed.summary).toBe('named "GASKET" — confirmed — the screen closed');

    const interrupted = observeEffect({
      before: [],
      after: [],
      action: { kind: "enter_text", text: "GASKET" },
      outcome: { typed: "GA", confirmed: false, endedBecause: "input_bound_reached" },
    });
    expect(interrupted.summary).toBe(
      'typed "GA" of "GASKET" — the input budget ran out mid-entry; repeat the action to continue',
    );
  });
});
