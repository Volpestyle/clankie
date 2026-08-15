import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  GbaEmulatorActionSchema,
  GbaEmulatorObservationSchema,
  GbaEmulatorSessionSpecSchema,
  type GbaButton,
  type GbaEmulatorStartActionCommand,
} from "@clankie/interactive-environment";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  FrozenGbaScenarioSchema,
  GbaEmulatorAdapter,
  GbaEmulatorEvidenceEventSchema,
  MgbaFireRedCore,
  POST_INPUT_SETTLE_FRAMES,
  RealGbaRouteScenarioSchema,
  decodeFireRedOverworld,
  decodeFireRedState,
  mgbaCoreWasmSha256,
  type GbaAdapterScenario,
  type GbaCoreSeam,
  type GbaCoreState,
} from "../../src/index.ts";
import {
  TracedCore,
  assertCompositeParity,
  assertDecoderParity,
  canonicalJson,
  coreSnapshot,
  runFreshCompositePair,
  sha256,
  type DecoderVector,
} from "./harness.ts";

const oracleRoot = import.meta.dirname;
const repoRoot = resolve(oracleRoot, "../../../..");
interface ArtifactPin {
  path: string;
  sha256: string;
  size: number;
}
const baseline = JSON.parse(readFileSync(join(oracleRoot, "baseline.jsonl"), "utf8")) as {
  artifacts: { mgbaWasm: ArtifactPin; rom: ArtifactPin; savestate: ArtifactPin };
  baseline: { commit: string };
  boundary: { receiptSha256: string; sourceFiles: { path: string; sha256: string }[] };
  schemas: Record<string, { canonicalJsonSha256: string }>;
  toolchain: { node: string; pnpm: string; romdevPlatformGba: string; zod: string };
};

const fileSha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("Phase A pinned oracle", () => {
  it("keeps every committed receipt canonical and legal", () => {
    for (const name of readdirSync(oracleRoot).filter((entry) => entry.endsWith(".jsonl"))) {
      const text = readFileSync(join(oracleRoot, name), "utf8");
      expect(text).toBe(`${canonicalJson(JSON.parse(text))}\n`);
    }
    expect(readdirSync(oracleRoot).sort()).toEqual([
      "README.md",
      "baseline.jsonl",
      "boundary-receipt.jsonl",
      "harness.ts",
      "oracle.test.ts",
    ]);
  });

  it("pins the committed source, toolchain, emulator, and public schemas", () => {
    expect(
      execFileSync("git", ["merge-base", "--is-ancestor", baseline.baseline.commit, "HEAD"], {
        cwd: repoRoot,
      }).toString(),
    ).toBe("");
    expect(process.version).toBe(baseline.toolchain.node);
    expect(execFileSync("pnpm", ["--version"], { cwd: repoRoot, encoding: "utf8" }).trim()).toBe(
      baseline.toolchain.pnpm,
    );
    expect(
      JSON.parse(
        readFileSync(
          join(repoRoot, "integrations/gba-emulator/node_modules/romdev-platform-gba/package.json"),
          "utf8",
        ),
      ).version,
    ).toBe(baseline.toolchain.romdevPlatformGba);
    expect(
      JSON.parse(
        readFileSync(join(repoRoot, "integrations/gba-emulator/node_modules/zod/package.json"), "utf8"),
      ).version,
    ).toBe(baseline.toolchain.zod);
    expect(mgbaCoreWasmSha256()).toBe(baseline.artifacts.mgbaWasm.sha256);

    for (const source of baseline.boundary.sourceFiles) {
      expect(fileSha256(join(repoRoot, source.path)), source.path).toBe(source.sha256);
    }
    const receipt = readFileSync(join(oracleRoot, "boundary-receipt.jsonl"));
    expect(sha256(receipt)).toBe(baseline.boundary.receiptSha256);

    const schemas = {
      action: GbaEmulatorActionSchema,
      evidence: GbaEmulatorEvidenceEventSchema,
      observation: GbaEmulatorObservationSchema,
    };
    for (const [name, schema] of Object.entries(schemas)) {
      expect(sha256(canonicalJson(z.toJSONSchema(schema))), name).toBe(
        baseline.schemas[name]!.canonicalJsonSha256,
      );
    }
  });

  for (const name of ["rom", "savestate"] as const) {
    const artifact = baseline.artifacts[name];
    const path = artifact.path.replace("${HOME}", homedir());
    it.skipIf(!existsSync(path))(`verifies the operator-local ${name} receipt`, () => {
      expect(fileSha256(path)).toBe(artifact.sha256);
      expect(readFileSync(path).byteLength).toBe(artifact.size);
    });
  }
});

const vectors = (): DecoderVector[] => {
  const valid = {
    id: "valid-overworld-with-empty-party",
    ewram: new Uint8Array(0x40000),
    iwram: new Uint8Array(0x8000),
    rom: new Uint8Array(0x400000),
  };
  valid.ewram[0x36e48] = 13;
  valid.ewram[0x36e4a] = 13;
  valid.ewram[0x36e58] = 2;
  const invalid = {
    id: "invalid-facing-byte",
    ewram: valid.ewram.slice(),
    iwram: valid.iwram.slice(),
    rom: valid.rom.slice(),
  };
  invalid.ewram[0x36e58] = 9;
  return [valid, invalid];
};

const decoderFailure = (error: unknown): string => {
  if (error instanceof Error && /facing/u.test(error.message)) return "invalid_facing";
  return error instanceof Error ? error.name : "non_error_throw";
};

describe("Phase B pure decoder comparison", () => {
  it("deep-compares values and fail-closed categories from the same synthetic byte vectors", () => {
    const state = ({ ewram, iwram, rom }: Omit<DecoderVector, "id">) =>
      decodeFireRedState({ ewram, iwram }, rom);
    const overworld = ({ ewram }: Omit<DecoderVector, "id">) => decodeFireRedOverworld(ewram);
    assertDecoderParity(vectors(), state, state, decoderFailure);
    assertDecoderParity(vectors(), overworld, overworld, decoderFailure);
  });
});

interface DialogBeat {
  lines?: string[];
  menu?: GbaCoreState["menu"];
  printFrames?: number;
}

class ScriptedDialogCore implements GbaCoreSeam {
  public readonly coreId = "oracle-dialog-core";
  private readonly beats: readonly DialogBeat[];
  private frame = 0;
  private index = 0;
  private inputCount = 0;
  private printedAt = 0;

  public constructor(beats: readonly DialogBeat[]) {
    this.beats = beats;
  }

  public async pressButton(button: GbaButton, holdFrames: number): Promise<void> {
    this.frame += holdFrames + POST_INPUT_SETTLE_FRAMES;
    this.inputCount += 1;
    if (button === "a") {
      this.index += 1;
      this.printedAt = this.frame;
    }
  }

  public async advanceFrames(frames: number): Promise<void> {
    this.frame += frames;
  }

  public async advanceFramesHolding(_button: GbaButton, frames: number): Promise<void> {
    this.frame += frames;
    this.printedAt -= Math.max(0, frames - 1) * 3;
  }

  public gameState(): GbaCoreState {
    const beat = this.beats[this.index];
    return {
      activePartySlot: 0,
      battle: null,
      dialogLineIndex: 0,
      dialogLines: beat?.lines ?? [],
      facing: "north",
      frame: this.frame,
      inputCount: this.inputCount,
      menu: beat?.menu ?? null,
      mode: beat === undefined ? "overworld" : "dialog",
      party: [],
      position: { mapId: "oracle", x: 1, y: 1 },
      waitingForDialogAdvance: beat !== undefined && this.frame >= this.printedAt + (beat.printFrames ?? 0),
    };
  }

  public ramStateSha256(): string {
    return sha256(`oracle-dialog:${String(this.index)}:${String(this.frame)}`);
  }

  public framebufferSha256(): string {
    return sha256(`oracle-frame:${String(this.frame)}`);
  }
}

const scenarioPath = resolve(repoRoot, "scenarios/emulator/verdant-path-trainer-battle/v1/scenario.json");
const scenarioBytes = readFileSync(scenarioPath);
const scenario = FrozenGbaScenarioSchema.parse(JSON.parse(scenarioBytes.toString("utf8")));

const sessionSpec = (sessionId: string, fixture: GbaAdapterScenario) =>
  GbaEmulatorSessionSpecSchema.parse({
    schemaVersion: 2,
    sessionId,
    environmentKind: "gba_emulator",
    characterId: fixture.player.characterId,
    worldId: fixture.worldId,
    requestedBy: { principal: { kind: "captain", id: "clankie" }, tier: "autonomous" },
    initialGoalVersion: 1,
    resourceBounds: {
      profile: "gba_emulator",
      coreId: fixture.coreId,
      savestateId: fixture.savestateId,
      savestateSha256: fixture.savestateSha256,
      rngSeed: fixture.rngSeed,
      worldId: fixture.worldId,
      characterId: fixture.player.characterId,
      maxInputsPerAction: 8,
      maxFramesPerAction: 600,
      maxActionDurationMs: 5_000,
      capabilities: ["emulator.gba.observe", "emulator.gba.input", "emulator.gba.frame_advance"],
    },
  });

const actionCommand = (
  sessionId: string,
  action: { kind: "advance_dialog" } | { kind: "button_press"; button: GbaButton; holdFrames: number },
): GbaEmulatorStartActionCommand => ({
  schemaVersion: 1,
  commandId: "oracle-command",
  type: "start_action",
  requestedAt: "2026-08-15T23:00:29.000Z",
  context: {
    sourceLane: "gameplay",
    authority: { principal: { kind: "captain", id: "clankie" }, tier: "autonomous" },
    correlationId: "oracle-correlation",
    expectedGoalVersion: 1,
  },
  sessionId,
  actionId: "oracle-action",
  action: {
    kind: "gba_emulator_action",
    action,
    limits: { maxInputs: 8, maxFrames: 600, timeoutMs: 5_000 },
  },
});

const runAtPublicBoundary = async (
  core: TracedCore,
  action: Parameters<typeof actionCommand>[1],
  fixture: GbaAdapterScenario = scenario,
  fixtureSha256 = sha256(scenarioBytes),
): Promise<unknown> => {
  const sessionId = "gba-oracle-session";
  const adapter = new GbaEmulatorAdapter(fixture, fixtureSha256, () => core);
  await adapter.start(sessionSpec(sessionId, fixture), {});
  const session = adapter.session(sessionId);
  const before = session.observe("scene");
  const completion = await session.startAction(actionCommand(sessionId, action));
  const after = session.observe("scene");
  return { after, before, completion, evidence: session.trace() };
};

describe("Phase B composite comparison", () => {
  it("uses two fresh scripted ports and compares per-frame masks plus every state read", async () => {
    const create = () =>
      new TracedCore(
        new ScriptedDialogCore([
          { lines: ["PROF. OAK: This is a printing box."], printFrames: 48 },
          {
            lines: ["Choose carefully."],
            menu: {
              menuId: "yes-no",
              cursor: 0,
              entries: [
                { id: "yes", label: "YES" },
                { id: "no", label: "NO" },
              ],
            },
          },
        ]),
        POST_INPUT_SETTLE_FRAMES,
      );
    const pair = await runFreshCompositePair(
      create,
      (core) => runAtPublicBoundary(core, { kind: "advance_dialog" }),
      (core) => runAtPublicBoundary(core, { kind: "advance_dialog" }),
    );
    assertCompositeParity(pair.legacy, pair.candidate);
    expect(pair.legacy.core.inputMasks).toContain(1 << 8);
    expect(pair.legacy.core.reads.length).toBeGreaterThan(0);
  });
});

const realScenarioPath = resolve(
  repoRoot,
  "integrations/gba-emulator/fixtures/firered-bedroom-route/v1/scenario.json",
);
const realScenario = RealGbaRouteScenarioSchema.parse(JSON.parse(readFileSync(realScenarioPath, "utf8")));
const romPath = baseline.artifacts.rom.path.replace("${HOME}", homedir());
const savestatePath = baseline.artifacts.savestate.path.replace("${HOME}", homedir());
const realArtifactsAvailable = existsSync(romPath) && existsSync(savestatePath);

describe.skipIf(!realArtifactsAvailable)("Phase B real mGBA comparison", () => {
  it(
    "compares two fresh cores from one pinned savestate without persisting cartridge state",
    { timeout: 240_000 },
    async () => {
      const romBytes = readFileSync(romPath);
      const savestateBytes = readFileSync(savestatePath);
      const create = async () => {
        const core = await MgbaFireRedCore.create({
          coreId: realScenario.coreId,
          romBytes: romBytes.slice(),
          savestateBytes: savestateBytes.slice(),
          romSha256: baseline.artifacts.rom.sha256,
          savestateSha256: baseline.artifacts.savestate.sha256,
          coreWasmSha256: baseline.artifacts.mgbaWasm.sha256,
          mapId: realScenario.map.mapId,
        });
        return { core, traced: new TracedCore(core, POST_INPUT_SETTLE_FRAMES) };
      };
      const legacy = await create();
      const candidate = await create();
      assert.notStrictEqual(legacy.core, candidate.core);

      const legacyResult = await runAtPublicBoundary(
        legacy.traced,
        {
          kind: "button_press",
          button: "right",
          holdFrames: realScenario.holdFramesPerStep,
        },
        realScenario,
        sha256(readFileSync(realScenarioPath)),
      );
      const candidateResult = await runAtPublicBoundary(
        candidate.traced,
        {
          kind: "button_press",
          button: "right",
          holdFrames: realScenario.holdFramesPerStep,
        },
        realScenario,
        sha256(readFileSync(realScenarioPath)),
      );
      const legacyFinal = {
        ...((coreSnapshot(legacy.traced) as object) ?? {}),
        finalSavestateSha256: sha256(legacy.core.saveState()),
      };
      const candidateFinal = {
        ...((coreSnapshot(candidate.traced) as object) ?? {}),
        finalSavestateSha256: sha256(candidate.core.saveState()),
      };

      assertCompositeParity(
        { core: legacy.traced, result: { boundary: legacyResult, final: legacyFinal } },
        { core: candidate.traced, result: { boundary: candidateResult, final: candidateFinal } },
      );
      expect(legacy.traced.inputMasks).toHaveLength(
        realScenario.holdFramesPerStep + POST_INPUT_SETTLE_FRAMES,
      );
    },
  );
});
