import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GbaButtonSchema, type GbaButton } from "@clankie/interactive-environment";
import { z } from "zod";
import { canonicalJson, sha256 } from "../src/core-double.ts";
import {
  FIRERED_US_V10_ROM_SHA256,
  decodeFireRedState,
  type FireRedDecodedState,
} from "../src/firered-state.ts";
import { MgbaLibretroCore } from "../src/mgba-core.ts";
import { writeFramebufferPng } from "./png-writer.ts";

/**
 * Operator-local FireRed RAM/frame probe.
 *
 * This is fixture-development instrumentation, not an autonomous scenario:
 * it applies a bounded caller-supplied input list, then writes a screenshot,
 * decoded state, and optional next savestate outside the repository. ROM,
 * savestate, and RAM bytes never enter the JSON report.
 *
 * CLANKIE_GBA_PROBE_INPUTS is JSON:
 *   [{"button":"right","holdFrames":8,"settleFrames":32}]
 */

const ProbeInputSchema = z
  .object({
    button: GbaButtonSchema,
    holdFrames: z.number().int().positive().max(240).default(8),
    settleFrames: z.number().int().nonnegative().max(3_600).default(32),
  })
  .strict();
const ProbeInputsSchema = z.array(ProbeInputSchema).max(256);

const romPath = process.env["CLANKIE_GBA_ROM_PATH"];
const savestatePath = process.env["CLANKIE_GBA_SAVESTATE_PATH"];
const outputDir = process.env["CLANKIE_GBA_PROBE_OUTPUT_DIR"];
const savestateOut = process.env["CLANKIE_GBA_PROBE_SAVESTATE_OUT"];
if (!romPath || !savestatePath || !outputDir) {
  console.error("Set CLANKIE_GBA_ROM_PATH, CLANKIE_GBA_SAVESTATE_PATH, and CLANKIE_GBA_PROBE_OUTPUT_DIR");
  process.exit(2);
}

const inputs = ProbeInputsSchema.parse(
  JSON.parse(process.env["CLANKIE_GBA_PROBE_INPUTS"] ?? "[]") as unknown,
);
const romBytes = readFileSync(romPath);
const inputState = readFileSync(savestatePath);
if (sha256(romBytes) !== FIRERED_US_V10_ROM_SHA256) {
  throw new Error("Probe ROM has no supported FireRed RAM profile");
}

const core = await MgbaLibretroCore.create();
core.loadRom(romBytes);
core.setHeldButtons([]);
core.runFrames(1);
core.loadState(inputState);
core.runFrames(2);

const observations: {
  sequence: number;
  input: { button: GbaButton; holdFrames: number; settleFrames: number } | null;
  state: FireRedDecodedState;
}[] = [
  {
    sequence: 0,
    input: null,
    state: decodeFireRedState({ ewram: core.readEwram(), iwram: core.readIwram() }, romBytes),
  },
];

for (const [index, input] of inputs.entries()) {
  core.setHeldButtons([input.button]);
  core.runFrames(input.holdFrames);
  core.setHeldButtons([]);
  core.runFrames(input.settleFrames);
  observations.push({
    sequence: index + 1,
    input,
    state: decodeFireRedState({ ewram: core.readEwram(), iwram: core.readIwram() }, romBytes),
  });
}

mkdirSync(outputDir, { recursive: true });
const framebuffer = core.framebuffer();
if (!framebuffer) throw new Error("Probe produced no framebuffer");
const screenshotPath = path.join(outputDir, "frame.png");
writeFramebufferPng(framebuffer, screenshotPath);
const outputState = core.saveState();
if (savestateOut) {
  mkdirSync(path.dirname(savestateOut), { recursive: true });
  writeFileSync(savestateOut, outputState);
}
const report = {
  schemaVersion: 1,
  romSha256: sha256(romBytes),
  inputSavestateSha256: sha256(inputState),
  outputSavestateSha256: sha256(outputState),
  inputCount: inputs.length,
  frameCount: core.frameCount,
  framebufferSha256: sha256(framebuffer.bytes),
  screenshotPath,
  savestateOut: savestateOut ?? null,
  observations,
};
writeFileSync(path.join(outputDir, "probe.json"), `${canonicalJson(report)}\n`);
console.log(JSON.stringify(report, null, 2));
