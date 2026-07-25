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
import { sha256 } from "../src/core-double.ts";
import { createModelFreePlayMind } from "../src/free-play-mind.ts";
import { runFreePlay, type FreePlayTurn } from "../src/free-play.ts";
import { createFreePlaySession } from "../src/free-play-session.ts";

const turns = Number.parseInt(process.env["CLANKIE_FREE_PLAY_TURNS"] ?? "20", 10);
if (!Number.isSafeInteger(turns) || turns <= 0) {
  console.error("CLANKIE_FREE_PLAY_TURNS must be a positive integer");
  process.exit(2);
}
const tracePath =
  process.env["CLANKIE_FREE_PLAY_TRACE"] ??
  path.resolve(process.cwd(), "artifacts/gba-free-play/trace.jsonl");

const scenarioPath =
  process.env["CLANKIE_GBA_SCENARIO_PATH"] ??
  path.resolve(
    import.meta.dirname,
    "../../../scenarios/emulator/verdant-path-trainer-battle/v1/scenario.json",
  );
const fixtureBytes = readFileSync(scenarioPath);
const scenario = FrozenGbaScenarioSchema.parse(JSON.parse(fixtureBytes.toString("utf8")));

const { io } = await createFreePlaySession({
  rootDir: mkdtempSync(path.join(tmpdir(), "gba-free-play-")),
  scenario,
  fixtureSha256: sha256(fixtureBytes),
});

const configured = await resolveConfiguredLanguageModel({ cwd: process.cwd(), env: process.env });
console.log(`clankie is playing with ${configured.ref}\n`);

mkdirSync(path.dirname(tracePath), { recursive: true });
// Start a fresh trace. Appending would silently interleave this playthrough
// with a previous one, and the coherence number would be read off a file that
// spans two different runs.
writeFileSync(tracePath, "", { encoding: "utf8", mode: 0o600 });

const result = await runFreePlay({
  io,
  mind: createModelFreePlayMind({
    model: configured.model,
    providerOptions: configured.modelOptions?.providerOptions ?? {},
  }),
  turns,
  framebufferSha256: () => null,
  onTurn: (turn) => {
    appendFileSync(tracePath, `${JSON.stringify(turn)}\n`, { encoding: "utf8", mode: 0o600 });
    print(turn);
  },
});

console.log(`\n${result.accepted}/${result.turns.length} actions accepted`);
console.log(
  result.coherence === null
    ? "coherence: not scoreable"
    : `coherence: ${(result.coherence * 100).toFixed(0)}% of stated intents were followed through`,
);
console.log(`trace: ${tracePath}`);

function print(turn: FreePlayTurn): void {
  const header = `turn ${String(turn.turn).padStart(3, " ")}`;
  if (turn.monologue !== null) console.log(`${header}  ${turn.monologue}`);
  const action =
    turn.action === null
      ? "(no action)"
      : turn.action.kind === "button_press"
        ? `press ${turn.action.button}`
        : turn.action.kind === "frame_advance"
          ? `advance ${String(turn.action.frames)}`
          : `wait ${String(turn.action.durationMs)}ms`;
  const marker = turn.outcome === "accepted" ? "→" : "✗";
  const detail = turn.outcome === "accepted" ? "" : `  [${turn.outcome}: ${turn.detail ?? ""}]`;
  console.log(`          ${marker} ${action}${detail}`);
  if (turn.intent !== null) console.log(`          next: ${turn.intent}\n`);
}
