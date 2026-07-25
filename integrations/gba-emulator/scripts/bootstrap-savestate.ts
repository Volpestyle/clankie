import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GbaButton } from "@clankie/interactive-environment";
import { sha256 } from "../src/core-double.ts";
import { MgbaLibretroCore } from "../src/mgba-core.ts";

/**
 * Deterministically regenerate the pinned "firered-a-bedroom" savestate from
 * the operator-supplied FireRed ROM: a frozen input schedule that boots the
 * ROM from power-on, starts a new game (player "A", rival "GREEN"), and stops
 * in the player's bedroom overworld. Frame-stepped and input-scheduled, so
 * the produced savestate bytes are byte-identical on every run against the
 * same ROM and pinned core.
 *
 * This schedule is savestate FIXTURE PREPARATION, not the scenario: the
 * governed scenario derives its decisions from observed state (see
 * real-scenario.ts). Savestate bytes stay operator-local; only their SHA-256
 * is pinned in the frozen fixture.
 *
 * Usage:
 *   CLANKIE_GBA_ROM_PATH=… CLANKIE_GBA_SAVESTATE_PATH=… \
 *     pnpm --filter @clankie/gba-emulator exec tsx scripts/bootstrap-savestate.ts
 */

interface Segment {
  keys?: GbaButton[];
  hold?: number;
  release?: number;
  repeat?: number;
  run?: number;
}

/** Frozen power-on → bedroom schedule (verified frame-by-frame on 2026-07-19). */
const SCHEDULE: Segment[] = [
  // boot logos and intro movie → title screen
  { run: 700 },
  { keys: ["start"], hold: 8, release: 120 },
  { keys: ["start"], hold: 8, release: 120 },
  { run: 120 },
  // title → main menu → NEW GAME
  { keys: ["start"], hold: 8, release: 90 },
  { keys: ["a"], hold: 8, release: 90 },
  { run: 60 },
  // controls/help pages
  { keys: ["a"], hold: 8, release: 60, repeat: 12 },
  { run: 120 },
  // Oak speech
  { keys: ["a"], hold: 8, release: 40, repeat: 14 },
  { run: 60 },
  { keys: ["a"], hold: 8, release: 40, repeat: 10 },
  { run: 60 },
  { keys: ["a"], hold: 8, release: 40, repeat: 5 },
  { run: 60 },
  // gender menu: BOY
  { keys: ["a"], hold: 8, release: 60 },
  { keys: ["a"], hold: 8, release: 40, repeat: 3 },
  { run: 60 },
  // open the player naming screen
  { keys: ["a"], hold: 8, release: 60 },
  { run: 90 },
  // name "A": type A, START jumps to OK, A confirms
  { keys: ["a"], hold: 6, release: 30 },
  { keys: ["start"], hold: 6, release: 30 },
  { keys: ["a"], hold: 6, release: 60 },
  { run: 90 },
  // Oak speech → rival intro
  { keys: ["a"], hold: 8, release: 40, repeat: 8 },
  { run: 60 },
  { keys: ["a"], hold: 8, release: 40, repeat: 3 },
  { run: 60 },
  // rival preset-name menu: DOWN to "GREEN", A to pick, mash to speech end
  { keys: ["down"], hold: 6, release: 30 },
  { keys: ["a"], hold: 6, release: 60 },
  { keys: ["a"], hold: 8, release: 40, repeat: 12 },
  { run: 120 },
  // final lines → shrink transition → bedroom overworld
  { keys: ["a"], hold: 8, release: 40, repeat: 4 },
  { run: 600 },
  { run: 180 },
];

const romPath = process.env["CLANKIE_GBA_ROM_PATH"];
const savestatePath = process.env["CLANKIE_GBA_SAVESTATE_PATH"];
if (!romPath || !savestatePath) {
  console.error("Set CLANKIE_GBA_ROM_PATH and CLANKIE_GBA_SAVESTATE_PATH");
  process.exit(2);
}

const romBytes = readFileSync(romPath);
const core = await MgbaLibretroCore.create();
core.loadRom(romBytes);
for (const segment of SCHEDULE) {
  if (segment.run !== undefined) {
    core.setHeldButtons([]);
    core.runFrames(segment.run);
    continue;
  }
  for (let i = 0; i < (segment.repeat ?? 1); i += 1) {
    core.setHeldButtons(segment.keys ?? []);
    core.runFrames(segment.hold ?? 4);
    core.setHeldButtons([]);
    core.runFrames(segment.release ?? 12);
  }
}
const savestate = core.saveState();
mkdirSync(path.dirname(savestatePath), { recursive: true });
writeFileSync(savestatePath, savestate);
console.log(
  JSON.stringify(
    {
      romSha256: sha256(romBytes),
      savestatePath,
      savestateSha256: sha256(savestate),
      framesRun: core.frameCount,
    },
    null,
    2,
  ),
);
