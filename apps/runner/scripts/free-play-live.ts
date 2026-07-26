/**
 * Watch Clankie play, on the activity surface — the development alias.
 *
 * `pnpm gba:free-play-live`
 *
 * The product path is the runner's play host serving asked-play intents
 * (ADR 0063); this script drives the exact same execution composition with a
 * locally fabricated session, so a developer can watch a playthrough without
 * a control plane or a Discord ask. One composition point, two entrances.
 *
 * Start `@clankie/discord-activity` first; without it the sink drops frames
 * and the receipt says so rather than failing the playthrough.
 */
import { InterjectionQueue } from "@clankie/gba-emulator";
import type { EmbodimentSession } from "@clankie/protocol";
import { createGbaPlayExecution } from "../src/play-execution.ts";

const turns = Number.parseInt(process.env["CLANKIE_FREE_PLAY_TURNS"] ?? "20", 10);
if (!Number.isSafeInteger(turns) || turns <= 0) {
  console.error("CLANKIE_FREE_PLAY_TURNS must be a positive integer");
  process.exit(2);
}

// Anything typed reaches the next turn, same as the headless CLI.
const interjections = new InterjectionQueue();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  for (const line of chunk.split("\n")) if (line.trim().length > 0) interjections.offer(line);
});
if (typeof process.stdin.unref === "function") process.stdin.unref();

let stopped = false;
process.once("SIGINT", () => {
  stopped = true;
  console.log("\nstopping at the next turn boundary…");
});

const execution = createGbaPlayExecution({
  logger: {
    info: (context, message) => console.log(message, context),
    warn: (context, message) => console.warn(message, context),
  },
  interjections,
  onTurn: (turn) => console.log(`turn ${String(turn.turn)}: ${turn.monologue ?? "(no decision)"}`),
});

const session: EmbodimentSession = {
  schemaVersion: 1,
  sessionId: `dev-${new Date().toISOString().replace(/[:.]/gu, "-")}`,
  environmentId: "pokemon-firered",
  state: "claimed",
  intentId: "dev-free-play-live",
  originLane: "operator",
  requestedBy: "owner",
  budget: { maxTurns: turns, maxDurationMs: 6 * 60 * 60 * 1_000 },
  requestedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  runnerId: "dev-script",
};

const outcome = await execution(session, { stopRequested: () => stopped }, (resumedFrom) => {
  console.log(
    resumedFrom === undefined
      ? "clankie is playing, live on the activity surface\n"
      : `clankie is playing, resumed from ${resumedFrom}, live on the activity surface\n`,
  );
  return Promise.resolve();
});

if (outcome.kind === "refused") {
  console.error(`refused: ${outcome.reason}`);
  process.exit(2);
}
const result = outcome.result;
console.log(
  `\n${result.outcome}: ${String(result.turnsTaken)} turns, ` +
    `${String(result.framesPublished)} frames published, ${String(result.framesDropped)} dropped` +
    (result.checkpointId === undefined ? "" : `, checkpoint ${result.checkpointId}`),
);
process.exit(0);
