/**
 * Watch Clankie play, on the activity surface.
 *
 * `pnpm gba:free-play-live`
 *
 * The free-play loop, the frame stream, the loopback producer, and the activity
 * hub all existed already — nothing called `publishFrame` in a real run, which
 * is the only gap this closes. The runner is the composition point because it is
 * the process that already owns the emulator body and holds the producer
 * credential.
 *
 * Start `@clankie/discord-activity` first; without it the sink drops frames and
 * says so rather than failing the playthrough.
 */
import { resolveConfiguredLanguageModel } from "@clankie/model-provider";
import {
  bootGbaGame,
  defaultGbaBodyRootDir,
  createFreePlaySession,
  createModelFreePlayMind,
  InterjectionQueue,
  runFreePlay,
} from "@clankie/gba-emulator";
import { RenderedSurfaceOverlaySchema } from "@clankie/interactive-environment";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { createBrokeredActivityFrameSink } from "@clankie/rendered-surface-client";

const require = createRequire(import.meta.url);
const emulatorPackage = path.dirname(require.resolve("@clankie/gba-emulator/package.json"));
const repoRoot = path.resolve(emulatorPackage, "../..");

const turns = Number.parseInt(process.env["CLANKIE_FREE_PLAY_TURNS"] ?? "20", 10);
if (!Number.isSafeInteger(turns) || turns <= 0) {
  console.error("CLANKIE_FREE_PLAY_TURNS must be a positive integer");
  process.exit(2);
}

const game = await bootGbaGame({
  fixturesDir: path.join(emulatorPackage, "fixtures"),
  doubleScenarioPath: path.join(repoRoot, "scenarios/emulator/verdant-path-trainer-battle/v1/scenario.json"),
});

const sink = await createBrokeredActivityFrameSink({
  url: process.env["CLANKIE_ACTIVITY_PRODUCER_URL"] ?? "ws://127.0.0.1:4322/producer",
});
if (sink === undefined) {
  console.error("No activity producer credential. Start @clankie/discord-activity once so it mints one.");
  process.exit(2);
}

const session = await createFreePlaySession({
  rootDir: defaultGbaBodyRootDir(),
  holderId: "free-play-live",
  scenario: game.scenario,
  fixtureSha256: game.fixtureSha256,
  ...(game.coreFactory === undefined ? {} : { coreFactory: game.coreFactory }),
});

const configured = await resolveConfiguredLanguageModel({ cwd: repoRoot, env: process.env });
console.log(`clankie is playing with ${configured.ref}, live on the activity surface\n`);

// Anything typed reaches the next turn, same as the headless CLI.
const interjections = new InterjectionQueue();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  for (const line of chunk.split("\n")) if (line.trim().length > 0) interjections.offer(line);
});
if (typeof process.stdin.unref === "function") process.stdin.unref();

let sequence = 0;
// Same reason as the MCP path: one publish per action shows a teleport, not a
// step. Paced so the motion reads as gameplay.
game.observeFrames(() => {
  const png = game.framePng();
  if (png === null) return;
  const bytes = Buffer.from(png);
  sink.publishFrame({
    schemaVersion: 1,
    surface: "gba_emulator",
    sequence: (sequence += 1),
    frame: sequence,
    width: 240 * 3,
    height: 160 * 3,
    encoding: "png",
    data: bytes.toString("base64"),
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    capturedAt: new Date().toISOString(),
  });
}, { pace: true });
const result = await runFreePlay({
  io: session.io,
  mind: createModelFreePlayMind({
    model: configured.model,
    providerOptions: configured.modelOptions?.providerOptions ?? {},
  }),
  turns,
  interjections,
  audience: process.env["CLANKIE_FREE_PLAY_AUDIENCE"] ?? "people watching the activity surface",
  framebufferSha256: () => game.framebufferSha256(),
  framePng: () => game.framePng(),
  onTurn: (turn) => {
    sequence += 1;
    // What a viewer sees beside the canvas: what he is going for, what he just
    // thought, and what actually happened. This is the point of the overlay —
    // a flat video stream cannot show any of it.
    const lines = [
      turn.objective === null ? null : `goal: ${turn.objective}`,
      turn.monologue,
      turn.effect,
      turn.speak === null ? null : `“${turn.speak}”`,
      turn.reply === null ? null : `“${turn.reply}”`,
    ].filter((line): line is string => line !== null && line.length > 0);

    sink.publishOverlay(
      RenderedSurfaceOverlaySchema.parse({
        schemaVersion: 1,
        surface: "gba_emulator",
        sequence,
        lines: lines.map((line) => line.slice(0, 256)).slice(0, 16),
        updatedAt: new Date().toISOString(),
      }),
    );

    const png = game.framePng();
    if (png !== null) {
      const bytes = Buffer.from(png);
      sink.publishFrame({
        schemaVersion: 1,
        surface: "gba_emulator",
        sequence,
        frame: turn.turn,
        width: 240 * 3,
        height: 160 * 3,
        encoding: "png",
        data: bytes.toString("base64"),
        byteLength: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        capturedAt: new Date().toISOString(),
      });
    }
    console.log(`turn ${String(turn.turn)}: ${turn.monologue ?? "(no decision)"}`);
  },
});

console.log(`\n${result.accepted}/${result.turns.length} accepted`);
console.log(`published ${String(sequence)} overlays; ${String(sink.droppedFrameCount)} dropped`);
sink.close();
session.close();
