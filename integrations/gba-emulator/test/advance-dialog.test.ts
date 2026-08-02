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
 * `advance_dialog` (ADR 0066): one action reads a whole conversation.
 *
 * The scripted core below exists because the interesting cases are the *stops*
 * — a choice, a closed box, an exhausted budget — and each needs a dialog whose
 * shape the test controls. The frozen double covers the end-to-end path.
 */

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const fixtureRoot = resolve(
  import.meta.dirname,
  "../../../scenarios/emulator/verdant-path-trainer-battle/v1",
);

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** One step of a scripted conversation, in the order the core will report it. */
interface ScriptedBeat {
  lines?: string[];
  /** Frames this box prints before it accepts an advance. */
  printFrames?: number;
  menu?: GbaCoreState["menu"];
  mode?: GbaCoreState["mode"];
  /** Field-control readiness, for script-held overworld beats. */
  inputReady?: boolean;
  battle?: GbaCoreState["battle"];
  /** The beat ends on its own after this many frames — a fanfare, a jingle. */
  releaseAfterFrames?: number;
}

/**
 * A core whose only interesting state is the dialog. Each A press consumes one
 * beat; frames advance the print clock. It records every button it receives, so
 * a test can assert that no press landed after the stop.
 */
class ScriptedDialogCore implements GbaCoreSeam {
  public readonly coreId = "scripted-dialog-core";
  public readonly pressed: GbaButton[] = [];
  /** Buttons held through print-waits, so a test can see the fast-read. */
  public readonly held: GbaButton[] = [];
  private index = 0;
  private frame = 0;
  private inputCount = 0;
  private printedAt = 0;
  private readonly beats: readonly ScriptedBeat[];

  public constructor(beats: readonly ScriptedBeat[]) {
    this.beats = beats;
  }

  private beatEnteredAt = 0;

  public pressButton(button: GbaButton, holdFrames: number): void {
    this.pressed.push(button);
    this.frame += holdFrames;
    this.inputCount += 1;
    if (button !== "a") return;
    this.index += 1;
    this.printedAt = this.frame;
    this.beatEnteredAt = this.frame;
  }

  public advanceFrames(frames: number): void {
    this.frame += frames;
    this.settleTimedBeats();
  }

  public advanceFramesHolding(button: GbaButton, frames: number): void {
    this.held.push(button);
    this.frame += frames;
    // A held A/B fast-reads the printer, mirroring the real core: each held
    // frame counts 4× toward the box becoming ready.
    if (button === "a" || button === "b") this.printedAt -= frames * 3;
    this.settleTimedBeats();
  }

  /** A timed beat (a fanfare hold) ends by itself once its frames elapse. */
  private settleTimedBeats(): void {
    for (;;) {
      const beat = this.beats[this.index];
      if (beat?.releaseAfterFrames === undefined) return;
      if (this.frame - this.beatEnteredAt < beat.releaseAfterFrames) return;
      this.index += 1;
      this.printedAt = this.frame;
      this.beatEnteredAt = this.frame;
    }
  }

  public gameState(): GbaCoreState {
    const beat = this.beats[this.index];
    const printFrames = beat?.printFrames ?? 0;
    return {
      mode: beat?.mode ?? (beat === undefined ? "overworld" : "dialog"),
      ...(beat?.inputReady === undefined ? {} : { inputReady: beat.inputReady }),
      position: { mapId: "scripted", x: 1, y: 1 },
      facing: "north",
      dialogLineIndex: 0,
      dialogLines: beat?.lines ?? [],
      // Only field dialog parks on the wait-for-press native; battle text and
      // held overworld scripts never report ready, exactly like the decoder.
      waitingForDialogAdvance:
        beat !== undefined &&
        (beat.mode ?? "dialog") === "dialog" &&
        this.frame >= this.printedAt + printFrames,
      menu: beat?.menu ?? null,
      party: [],
      activePartySlot: 0,
      battle: beat?.battle ?? null,
      frame: this.frame,
      inputCount: this.inputCount,
    };
  }

  public ramStateSha256(): string {
    return sha256(`scripted-ram:${String(this.index)}:${String(this.frame)}`);
  }

  public framebufferSha256(): string {
    return sha256(`scripted-frame:${String(this.frame)}`);
  }
}

async function fixture() {
  const bytes = await readFile(resolve(fixtureRoot, "scenario.json"));
  return {
    fixtureSha256: createHash("sha256").update(bytes).digest("hex"),
    scenario: FrozenGbaScenarioSchema.parse(JSON.parse(bytes.toString("utf8"))),
  };
}

/** A live session over `core`, or the frozen double when none is supplied. */
async function harness(core?: ScriptedDialogCore) {
  const frozen = await fixture();
  const rootDir = await mkdtemp(join(tmpdir(), "gba-advance-dialog-"));
  roots.push(rootDir);
  const adapter =
    core === undefined
      ? new GbaEmulatorAdapter(frozen.scenario, frozen.fixtureSha256)
      : new GbaEmulatorAdapter(frozen.scenario, frozen.fixtureSha256, () => core);
  const events: EnvironmentEvent[] = [];
  const runtime = new EnvironmentRuntime({
    rootDir,
    adapter,
    events: { append: (event) => (events.push(event), Promise.resolve()) },
    clock: () => new Date("2026-07-26T00:00:00.000Z"),
    randomToken: () => "private-grant-marker",
  });
  const spec = GbaEmulatorSessionSpecSchema.parse({
    schemaVersion: 2,
    sessionId: "gba-advance-dialog-session",
    environmentKind: "gba_emulator",
    characterId: frozen.scenario.player.characterId,
    worldId: frozen.scenario.worldId,
    requestedBy: { principal: { kind: "captain", id: "clankie" }, tier: "autonomous" },
    initialGoalVersion: 1,
    resourceBounds: {
      profile: "gba_emulator",
      coreId: frozen.scenario.coreId,
      savestateId: frozen.scenario.savestateId,
      savestateSha256: frozen.scenario.savestateSha256,
      rngSeed: frozen.scenario.rngSeed,
      worldId: frozen.scenario.worldId,
      characterId: frozen.scenario.player.characterId,
      maxInputsPerAction: 8,
      maxFramesPerAction: 600,
      maxActionDurationMs: 5_000,
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
    correlationId: "advance-dialog",
    leaseDurationMs: 10_000,
  });
  const command = (actionId: string, action: GbaEmulatorAction): GbaEmulatorStartActionCommand => ({
    schemaVersion: 1,
    commandId: `command-${actionId}`,
    type: "start_action",
    requestedAt: "2026-07-26T00:00:00.000Z",
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
  return { adapter, command, grant, runtime, spec };
}

const advance = (): GbaEmulatorAction => ({ kind: "advance_dialog" });

describe("advance_dialog", () => {
  it("reads a whole conversation in one action and stops when the text ends", async () => {
    const core = new ScriptedDialogCore([
      { lines: ["PROF. OAK: Hello there!"] },
      { lines: ["PROF. OAK: Welcome to the world of POKéMON!"] },
      { lines: ["PROF. OAK: My name is OAK."] },
      { mode: "overworld" },
    ]);
    const { adapter, command, grant, runtime, spec } = await harness(core);
    const result = await runtime.startAction(grant.token, command("read", advance()));

    expect(result).toMatchObject({
      status: "completed",
      outcome: {
        transcript: [
          "PROF. OAK: Hello there!",
          "PROF. OAK: Welcome to the world of POKéMON!",
          "PROF. OAK: My name is OAK.",
        ],
        presses: 3,
        endedBecause: "dialog_closed",
        mode: "overworld",
      },
    });
    // The stop is the whole point: a fourth A would have re-engaged the NPC.
    expect(core.pressed).toEqual(["a", "a", "a"]);
    // Three boxes, one decision, one evidence event.
    expect(adapter.session(spec.sessionId).trace().events).toHaveLength(1);
  });

  it("stops at a choice instead of answering it", async () => {
    // The first box prints slowly so the wait runs with A held — proving the
    // held fast-read still stops dead when the choice appears.
    const core = new ScriptedDialogCore([
      { lines: ["Would you like to save?"], printFrames: 24 },
      {
        lines: ["Would you like to save?"],
        menu: {
          menuId: "yes-no",
          cursor: 0,
          entries: [
            { id: "yes", label: "YES" },
            { id: "no", label: "NO" },
          ],
        },
      },
    ]);
    const { command, grant, runtime } = await harness(core);
    const result = await runtime.startAction(grant.token, command("choice", advance()));

    expect(result).toMatchObject({
      status: "completed",
      outcome: {
        endedBecause: "choice_open",
        presses: 1,
        menu: { menuId: "yes-no" },
      },
    });
    // Exactly one press: the one that revealed the choice, and none after it.
    // The held wait fast-read the box but never answered anything.
    expect(core.pressed).toEqual(["a"]);
    expect(core.held).toContain("a");
  });

  it("fast-reads a printing box with A held rather than spending inputs", async () => {
    const core = new ScriptedDialogCore([
      { lines: ["A slow line prints…"], printFrames: 30 },
      { mode: "overworld" },
    ]);
    const { command, grant, runtime } = await harness(core);
    const result = await runtime.startAction(grant.token, command("slow", advance()));

    expect(result).toMatchObject({
      status: "completed",
      outcome: { transcript: ["A slow line prints…"], presses: 1, endedBecause: "dialog_closed" },
    });
    // One press for one box; the printing frames cost frames, never inputs.
    expect(core.pressed).toEqual(["a"]);
    // The wait ran with A held, so 30 nominal print frames finished in fewer
    // wall frames than the box's own print time — the whole point.
    expect(core.held).toContain("a");
    expect((result as unknown as { outcome: { framesSpent: number } }).outcome.framesSpent).toBeLessThan(30);
  });

  it("presses anyway when a box never reports itself ready", async () => {
    // Signs and some scripted text never park on the wait-for-press native.
    const core = new ScriptedDialogCore([
      { lines: ["It's a bookshelf full of books."], printFrames: 100_000 },
      { mode: "overworld" },
    ]);
    const { command, grant, runtime } = await harness(core);
    const result = await runtime.startAction(grant.token, command("stalled", advance()));

    expect(result).toMatchObject({
      status: "completed",
      outcome: { transcript: ["It's a bookshelf full of books."], endedBecause: "dialog_closed" },
    });
    expect(core.pressed).toEqual(["a"]);
  });

  it("stops on the input budget and says the text is unfinished", async () => {
    // Nine boxes against an eight-input bound: one action cannot finish it.
    const core = new ScriptedDialogCore(
      Array.from({ length: 9 }, (_, index) => ({ lines: [`Box ${String(index + 1)}`] })),
    );
    const { command, grant, runtime } = await harness(core);
    const result = await runtime.startAction(grant.token, command("long", advance()));

    expect(result).toMatchObject({
      status: "completed",
      outcome: { presses: 8, endedBecause: "input_bound_reached", mode: "dialog" },
    });
    expect(core.pressed).toHaveLength(8);
    // The unread box is still reported, so the next action resumes knowing it.
    expect((result as unknown as { outcome: { transcript: string[] } }).outcome.transcript).toContain(
      "Box 9",
    );
  });

  it("refuses when no dialog is open, rather than pressing A at the world", async () => {
    const { command, grant, runtime } = await harness();
    const result = await runtime.startAction(grant.token, command("no-dialog", advance()));
    expect(result).toMatchObject({ status: "failed", errorCode: "dialog_not_open" });
  });

  it("ends at a battle the conversation started", async () => {
    const { command, grant, runtime } = await harness();
    // Walk beside the scripted rival and talk to her; her line starts a battle.
    await runtime.startAction(grant.token, command("walk", { kind: "walk_to", x: 3, y: 1 }));
    await runtime.startAction(
      grant.token,
      command("talk", { kind: "button_press", button: "a", holdFrames: 4 }),
    );
    const result = await runtime.startAction(grant.token, command("read", advance()));

    expect(result).toMatchObject({
      status: "completed",
      outcome: {
        transcript: ["Rival Mira wants to battle!"],
        endedBecause: "battle_started",
        mode: "battle",
      },
    });
  });

  it("waits out a script-held screen instead of refusing at a visible box", async () => {
    // The starter fanfare: the box is visibly on screen, but the decoder sees
    // mode "overworld" with field controls locked while the jingle plays.
    // Refusing here taught him "the dialog stopped" about a box he could see.
    const core = new ScriptedDialogCore([
      { mode: "overworld", inputReady: false, releaseAfterFrames: 60 },
      { lines: ["A received the SQUIRTLE from PROF. OAK!"] },
      { mode: "overworld" },
    ]);
    const { command, grant, runtime } = await harness(core);
    const result = await runtime.startAction(grant.token, command("fanfare", advance()));

    expect(result).toMatchObject({
      status: "completed",
      outcome: {
        transcript: ["A received the SQUIRTLE from PROF. OAK!"],
        endedBecause: "dialog_closed",
      },
    });
    expect(core.pressed).toEqual(["a"]);
  });

  it("says the script released when the hold ends with nothing to read", async () => {
    const core = new ScriptedDialogCore([
      { mode: "overworld", inputReady: false, releaseAfterFrames: 24 },
      { mode: "overworld" },
    ]);
    const { command, grant, runtime } = await harness(core);
    const result = await runtime.startAction(grant.token, command("released", advance()));

    expect(result).toMatchObject({
      status: "completed",
      outcome: { transcript: [], presses: 0, endedBecause: "script_released" },
    });
    expect(core.pressed).toEqual([]);
  });

  it("gives up on a hold that never opens a box, and says so", async () => {
    const core = new ScriptedDialogCore([{ mode: "overworld", inputReady: false }]);
    const { command, grant, runtime } = await harness(core);
    const result = await runtime.startAction(grant.token, command("held", advance()));

    expect(result).toMatchObject({
      status: "completed",
      outcome: { transcript: [], presses: 0, endedBecause: "script_holding" },
    });
  });

  it("reads battle text and stops at the action menu instead of refusing mid-battle", async () => {
    // T55/T57 of the 2026-07-27 run: the battle intro was printing on screen
    // and advance_dialog answered "dialog_not_open" because battle text lives
    // under mode "battle", not "dialog".
    const resolving: GbaCoreState["battle"] = {
      battleId: "scripted-battle",
      turn: 1,
      opponentHp: 20,
      moveCursor: 0,
      inputMode: "resolving",
      opponent: { speciesId: "bulbasaur", level: 5, maxHp: 20 },
    };
    const core = new ScriptedDialogCore([
      { mode: "battle", battle: resolving, lines: ["GREEN sent out BULBASAUR!"] },
      { mode: "battle", battle: resolving, lines: ["Go! GASKET!"] },
      { mode: "battle", battle: { ...resolving, inputMode: "action" } },
    ]);
    const { command, grant, runtime } = await harness(core);
    const result = await runtime.startAction(grant.token, command("battle-intro", advance()));

    expect(result).toMatchObject({
      status: "completed",
      outcome: {
        transcript: ["GREEN sent out BULBASAUR!", "Go! GASKET!"],
        endedBecause: "choice_open",
        mode: "battle",
      },
    });
    expect(core.pressed).toEqual(["a", "a"]);
  });

  it("still refuses when the screen is free and nothing is readable", async () => {
    const core = new ScriptedDialogCore([{ mode: "overworld", inputReady: true }]);
    const { command, grant, runtime } = await harness(core);
    const result = await runtime.startAction(grant.token, command("free", advance()));
    expect(result).toMatchObject({ status: "failed", errorCode: "dialog_not_open" });
  });

  it("exposes the scene honestly while a script holds the screen", async () => {
    const core = new ScriptedDialogCore([{ mode: "overworld", inputReady: false }]);
    const { adapter, spec } = await harness(core);
    const scene = adapter.session(spec.sessionId).observe("scene");
    expect(scene).toMatchObject({
      kind: "scene",
      data: { mode: "overworld", inputReady: false, waitingForDialogAdvance: false },
    });
  });

  it("tells him what he read, because the boxes are gone by the time he looks", () => {
    const effect = observeEffect({
      before: [],
      after: [],
      action: { kind: "advance_dialog" },
      outcome: {
        transcript: ["PROF. OAK: Hello there!", "PROF. OAK: My name is OAK."],
        endedBecause: "choice_open",
      },
    });
    expect(effect.summary).toBe(
      'read: "PROF. OAK: Hello there! / PROF. OAK: My name is OAK." — a choice is waiting — answer it',
    );
  });
});
