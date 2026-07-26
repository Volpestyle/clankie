/**
 * `pnpm gba:free-play` — watch Clankie play FireRed by his own choices.
 *
 * Headless and Discord-free on purpose: this is the controlled test of whether
 * he can actually play, with none of Discord's variables in the way.
 *
 * Runs against the clearly-labeled deterministic core double unless a ROM is
 * configured, so the harness is exercisable without copyrighted bytes. The
 * decisions come from a real model either way — the core double changes what he
 * is looking at, not who is choosing.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveConfiguredLanguageModel } from "@clankie/model-provider";
import { FrozenGbaScenarioSchema } from "../src/contracts.ts";
import { RealGbaRouteScenarioSchema } from "../src/real-scenario.ts";
import { MgbaFireRedCore } from "../src/firered-core.ts";
import { encodeFramebufferPng } from "../src/framebuffer-png.ts";
import type { GbaCoreFactory } from "../src/core-seam.ts";
import { sha256 } from "../src/core-double.ts";
import { createModelFreePlayMind } from "../src/free-play-mind.ts";
import { SettingsStore, personaInstructions } from "@clankie/settings";
import { InterjectionQueue, runFreePlay, type FreePlayTurn } from "../src/free-play.ts";
import { createFreePlaySession } from "../src/free-play-session.ts";

const turns = Number.parseInt(process.env["CLANKIE_FREE_PLAY_TURNS"] ?? "20", 10);
if (!Number.isSafeInteger(turns) || turns <= 0) {
  console.error("CLANKIE_FREE_PLAY_TURNS must be a positive integer");
  process.exit(2);
}
// O5 experiment: nearest-neighbour upscale before the frame reaches him.
const frameScale = Number.parseInt(process.env["CLANKIE_FREE_PLAY_FRAME_SCALE"] ?? "3", 10);
if (!Number.isSafeInteger(frameScale) || frameScale < 1 || frameScale > 8) {
  console.error("CLANKIE_FREE_PLAY_FRAME_SCALE must be 1-8");
  process.exit(2);
}

const tracePath =
  process.env["CLANKIE_FREE_PLAY_TRACE"] ??
  path.resolve(process.cwd(), "artifacts/gba-free-play/trace.jsonl");

// ROM-gated: with a ROM and savestate configured Clankie plays the real game
// behind the pinned core; without them he plays the clearly-labeled
// deterministic double. Either way the decisions are his.
const romPath = process.env["CLANKIE_GBA_ROM_PATH"];
const savestatePath = process.env["CLANKIE_GBA_SAVESTATE_PATH"];
const real = romPath !== undefined && savestatePath !== undefined;

const scenarioPath =
  process.env["CLANKIE_GBA_SCENARIO_PATH"] ??
  path.resolve(
    import.meta.dirname,
    real
      ? "../fixtures/firered-bedroom-route/v1/scenario.json"
      : "../../../scenarios/emulator/verdant-path-trainer-battle/v1/scenario.json",
  );
const fixtureBytes = readFileSync(scenarioPath);
const parsedScenario: unknown = JSON.parse(fixtureBytes.toString("utf8"));
const scenario = real
  ? RealGbaRouteScenarioSchema.parse(parsedScenario)
  : FrozenGbaScenarioSchema.parse(parsedScenario);

let coreFactory: GbaCoreFactory | undefined;
let liveCore: MgbaFireRedCore | undefined;
if (real) {
  const routeScenario = RealGbaRouteScenarioSchema.parse(parsedScenario);
  // Fails closed unless the ROM, savestate, and core wasm match the pinned
  // digests, so a wrong dump cannot silently produce a plausible playthrough.
  const core = await MgbaFireRedCore.create({
    coreId: routeScenario.coreId,
    romBytes: readFileSync(romPath),
    savestateBytes: readFileSync(savestatePath),
    romSha256: routeScenario.romSha256,
    savestateSha256: routeScenario.savestateSha256,
    coreWasmSha256: routeScenario.coreWasmSha256,
    mapId: routeScenario.map.mapId,
  });
  coreFactory = () => core;
  liveCore = core;
}

const { io } = await createFreePlaySession({
  rootDir: mkdtempSync(path.join(tmpdir(), "gba-free-play-")),
  scenario,
  fixtureSha256: sha256(fixtureBytes),
  ...(coreFactory === undefined ? {} : { coreFactory }),
});
console.log(real ? `playing the real ROM: ${scenario.scenarioId}` : "playing the core double");

const configured = await resolveConfiguredLanguageModel({ cwd: process.cwd(), env: process.env });
console.log(`clankie is playing with ${configured.ref}\n`);

mkdirSync(path.dirname(tracePath), { recursive: true });
// Start a fresh trace. Appending would silently interleave this playthrough
// with a previous one, and the coherence number would be read off a file that
// spans two different runs.
writeFileSync(tracePath, "", { encoding: "utf8", mode: 0o600 });

// One character across every surface (ADR 0051). Free play reads the same
// owner-authored persona the Discord and operator lanes do, in its `gameplay`
// register — so the Clankie an audience watches play is the Clankie they talk
// to, not a second one defined by this script's prompt.
const freePlayCharacter = personaInstructions((await new SettingsStore().load()).persona, "gameplay");

// Talk to him while he plays: anything typed on stdin reaches the next turn.
// stdin is deliberately not a command channel — it is a person speaking.
const interjections = new InterjectionQueue();
// Listen on stdin whether or not it is a terminal. Gating on isTTY meant piped
// input was silently ignored — which is exactly how a script, a harness, or the
// Discord bridge would ever speak to him.
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  for (const line of chunk.split("\n")) {
    if (line.trim().length > 0) interjections.offer(line);
  }
});
// unref only exists on some stdin kinds; without the guard the CLI crashes
// outright when stdin is a file or already closed.
if (typeof process.stdin.unref === "function") process.stdin.unref();
if (process.stdin.isTTY === true) {
  console.log("(type anything and press enter to say it to him)\n");
}

const result = await runFreePlay({
  io,
  mind: createModelFreePlayMind({
    model: configured.model,
    character: freePlayCharacter,
    providerOptions: configured.modelOptions?.providerOptions ?? {},
  }),
  turns,
  interjections,
  // Honest by default: someone is running this and reading the output.
  audience: process.env["CLANKIE_FREE_PLAY_AUDIENCE"] ?? "one person, watching this run in a terminal",
  // The real core renders; the double does not. Both the digest and the image
  // come from the same snapshot so the trace and the model agree on the frame.
  framebufferSha256: () => {
    try {
      return liveCore?.framebufferSha256() ?? null;
    } catch {
      return null;
    }
  },
  framePng: () => {
    try {
      const snapshot = liveCore?.framebufferSnapshot();
      return snapshot === undefined ? null : encodeFramebufferPng(snapshot, frameScale);
    } catch {
      // Before the first rendered frame there is nothing to show.
      return null;
    }
  },
  onTurn: (turn) => {
    appendFileSync(tracePath, `${JSON.stringify(turn)}\n`, { encoding: "utf8", mode: 0o600 });
    print(turn);
  },
});

console.log(`\n${result.accepted}/${result.turns.length} actions accepted`);
const p = result.progress;
console.log(
  `progress: ${String(p.distinctTiles)} distinct tiles · maps ${p.maps.join(" → ")} · ` +
    `${String(p.turnsSinceNewTile)} turns since a new tile` +
    (p.actionsPerNewTile === null ? "" : ` · ${p.actionsPerNewTile.toFixed(1)} actions per new tile`),
);
const v = result.volition;
console.log(
  `volition: spoke ${String(v.taken)} of ${String(v.offered)} turns` +
    (v.suppressed === 0 ? "" : ` · ${String(v.suppressed)} held by the cooldown`),
);
console.log(
  result.coherence === null
    ? "follow-through: not scoreable"
    : // Reads low because intent is objective-shaped and this compares it to one
      // button press. Noise until objective and next-action are separate fields
      // (ADR 0049); progress above is the metric that means something.
      `follow-through: ${(result.coherence * 100).toFixed(0)}% (floor — see ADR 0049)`,
);
console.log(`trace: ${tracePath}`);

function print(turn: FreePlayTurn): void {
  const header = `turn ${String(turn.turn).padStart(3, " ")}`;
  if (turn.monologue !== null) console.log(`${header}  ${turn.monologue}`);
  if (turn.objective !== null) console.log(`          goal: ${turn.objective}`);
  const action =
    turn.action === null
      ? "(no action)"
      : turn.action.kind === "button_press"
        ? `press ${turn.action.button}${turn.action.repeat === undefined || turn.action.repeat === 1 ? "" : ` x${String(turn.action.repeat)}`}`
        : turn.action.kind === "frame_advance"
          ? `advance ${String(turn.action.frames)}`
          : `wait ${String(turn.action.durationMs)}ms`;
  const marker = turn.outcome === "accepted" ? "→" : "✗";
  const detail = turn.outcome === "accepted" ? "" : `  [${turn.outcome}: ${turn.detail ?? ""}]`;
  console.log(`          ${marker} ${action}${detail}`);
  if (turn.interjection !== null) console.log(`   you: ${turn.interjection}`);
  if (turn.reply !== null) console.log(`   clankie: ${turn.reply}`);
  if (turn.speak !== null) console.log(`   clankie (unprompted): ${turn.speak}`);
  if (turn.effect !== null) console.log(`          ${turn.effect}`);
  if (turn.intent !== null) console.log(`          next: ${turn.intent}\n`);
}
