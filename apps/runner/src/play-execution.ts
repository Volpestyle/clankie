/**
 * The production PlayExecution: the same composition `free-play-live.ts`
 * proved out — boot, body lock, activity frame sink, model mind, free-play
 * loop — owned by the play host instead of a hand-launched terminal.
 *
 * Degradation rules (ADR 0063):
 * - another holder on the body lock refuses `body_held`, never crashes;
 * - a missing ROM, fixture, or model refuses `environment_unavailable`;
 * - a missing activity producer degrades to counted dropped frames — the
 *   playthrough continues, the receipt says nobody could watch.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import {
  acquireBodyLock,
  BodyBusyError,
  bootGbaGame,
  createFreePlaySession,
  createModelFreePlayMind,
  defaultGbaBodyRootDir,
  defaultGbaCheckpointDir,
  listGbaCheckpoints,
  readGbaCheckpoint,
  runFreePlay,
  writeGbaCheckpoint,
  type BodyLock,
  type BootedGbaGame,
  type FreePlayMind,
  type FreePlayTurn,
  type InterjectionQueue,
} from "@clankie/gba-emulator";
import { RenderedSurfaceOverlaySchema } from "@clankie/interactive-environment";
import { resolveConfiguredLanguageModel } from "@clankie/model-provider";
import { createBrokeredActivityFrameSink } from "@clankie/rendered-surface-client";
import type { PlayExecution } from "./play-host.ts";

const FRAME_WIDTH = 240 * 3;
const FRAME_HEIGHT = 160 * 3;

interface PlayExecutionLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export interface GbaPlayExecutionOptions {
  logger: PlayExecutionLogger;
  env?: NodeJS.ProcessEnv;
  clock?: () => Date;
  /** Where mid-play questions land; the dev script wires stdin, voice comes later. */
  interjections?: InterjectionQueue;
  /** Extra per-turn observer beside the overlay publish (dev script logging). */
  onTurn?: (turn: FreePlayTurn) => void;
  /** Test/dev injection; production resolves the configured model. */
  createMind?: () => Promise<FreePlayMind>;
  /** Test injection; production boots the ROM-gated game or the double. */
  boot?: () => Promise<BootedGbaGame>;
}

export function createGbaPlayExecution(options: GbaPlayExecutionOptions): PlayExecution {
  const env = options.env ?? process.env;
  const clock = options.clock ?? (() => new Date());

  return async (session, control, onRunning) => {
    // The body lock comes first: a held body must refuse fast and typed, not
    // after paying a real-core boot whose latency could push the answer past
    // the captain tool's bounded wait.
    let bodyLock: BodyLock;
    try {
      bodyLock = acquireBodyLock({
        rootDir: defaultGbaBodyRootDir(env),
        holderId: `captain-play:${session.sessionId}`,
      });
    } catch (error) {
      if (error instanceof BodyBusyError) {
        options.logger.info(
          { sessionId: session.sessionId, holderId: error.holder.holderId },
          "embodiment start refused: body held",
        );
        return { kind: "refused", reason: "body_held" };
      }
      return { kind: "refused", reason: "environment_unavailable" };
    }

    try {
      return await runLockedPlay(session, control, onRunning);
    } finally {
      bodyLock.release();
    }
  };

  async function runLockedPlay(
    session: Parameters<PlayExecution>[0],
    control: Parameters<PlayExecution>[1],
    onRunning: Parameters<PlayExecution>[2],
  ): ReturnType<PlayExecution> {
    const require = createRequire(import.meta.url);
    const emulatorPackage = path.dirname(require.resolve("@clankie/gba-emulator/package.json"));
    const repoRoot = path.resolve(emulatorPackage, "../..");

    let game: BootedGbaGame;
    let mind: FreePlayMind;
    try {
      game =
        options.boot !== undefined
          ? await options.boot()
          : await bootGbaGame({
              env,
              fixturesDir: path.join(emulatorPackage, "fixtures"),
              doubleScenarioPath: path.join(
                repoRoot,
                "scenarios/emulator/verdant-path-trainer-battle/v1/scenario.json",
              ),
            });
      if (options.createMind !== undefined) {
        mind = await options.createMind();
      } else {
        const configured = await resolveConfiguredLanguageModel({ cwd: repoRoot, env });
        mind = createModelFreePlayMind({
          model: configured.model,
          providerOptions: configured.modelOptions?.providerOptions ?? {},
        });
      }
    } catch (error) {
      options.logger.warn(
        { sessionId: session.sessionId, errorName: error instanceof Error ? error.name : "Error" },
        "embodiment boot refused",
      );
      return { kind: "refused", reason: "environment_unavailable" };
    }

    // Resume from the newest compatible checkpoint (ADR 0060). A checkpoint
    // that fails its identity or digest gate is skipped, never trusted.
    const checkpointDir = defaultGbaCheckpointDir(env);
    let resumedFromCheckpointId: string | undefined;
    if (game.checkpoints !== undefined) {
      for (const candidate of listGbaCheckpoints(checkpointDir)) {
        try {
          const checkpoint = readGbaCheckpoint({
            rootDir: checkpointDir,
            checkpointId: candidate.checkpointId,
            identity: game.checkpoints.identity,
          });
          game.checkpoints.loadState(checkpoint.savestateBytes);
          resumedFromCheckpointId = candidate.checkpointId;
          break;
        } catch {
          continue;
        }
      }
    }

    const sink = await createBrokeredActivityFrameSink({
      url: env["CLANKIE_ACTIVITY_PRODUCER_URL"] ?? "ws://127.0.0.1:4322/producer",
    });
    let framesPublished = 0;
    let framesDroppedWithoutSink = 0;
    let sequence = 0;
    const publishFrame = (frame: number): void => {
      const png = game.framePng();
      if (png === null) return;
      if (sink === undefined) {
        framesDroppedWithoutSink += 1;
        return;
      }
      const bytes = Buffer.from(png);
      sequence += 1;
      framesPublished += 1;
      sink.publishFrame({
        schemaVersion: 1,
        surface: "gba_emulator",
        sequence,
        frame,
        width: FRAME_WIDTH,
        height: FRAME_HEIGHT,
        encoding: "png",
        data: bytes.toString("base64"),
        byteLength: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        capturedAt: clock().toISOString(),
      });
    };

    let freePlay;
    try {
      freePlay = await createFreePlaySession({
        rootDir: defaultGbaBodyRootDir(env),
        holderId: `captain-play:${session.sessionId}`,
        scenario: game.scenario,
        fixtureSha256: game.fixtureSha256,
        // The caller already holds the cross-process body lock; taking it
        // twice would refuse against ourselves.
        acquireBody: false,
        ...(game.coreFactory === undefined ? {} : { coreFactory: game.coreFactory }),
      });
    } catch (error) {
      sink?.close();
      options.logger.warn(
        { sessionId: session.sessionId, errorName: error instanceof Error ? error.name : "Error" },
        "embodiment session start refused",
      );
      return { kind: "refused", reason: "environment_unavailable" };
    }

    const startedAt = clock().getTime();
    try {
      await onRunning(resumedFromCheckpointId);
      // One publish per action shows a teleport, not a step; paced so the
      // motion reads as gameplay (same rule as the MCP and live paths).
      game.observeFrames(() => publishFrame(sequence), { pace: true });

      const result = await runFreePlay({
        io: freePlay.io,
        mind,
        // No cap means play until asked to stop (the owner's default).
        turns: session.budget.maxTurns ?? Number.MAX_SAFE_INTEGER,
        audience: env["CLANKIE_FREE_PLAY_AUDIENCE"] ?? "people watching the activity surface",
        framebufferSha256: () => game.framebufferSha256(),
        framePng: () => game.framePng(),
        ...(options.interjections === undefined ? {} : { interjections: options.interjections }),
        shouldStop: () =>
          control.stopRequested() ||
          (session.budget.maxDurationMs !== undefined &&
            clock().getTime() - startedAt >= session.budget.maxDurationMs),
        onTurn: (turn) => {
          sequence += 1;
          if (sink !== undefined) {
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
                updatedAt: clock().toISOString(),
              }),
            );
          }
          publishFrame(turn.turn);
          options.onTurn?.(turn);
        },
      });

      game.observeFrames(null);
      let checkpointId: string | undefined;
      if (game.checkpoints !== undefined) {
        try {
          checkpointId = writeGbaCheckpoint({
            rootDir: checkpointDir,
            capability: game.checkpoints,
            label: "asked-play",
            position: null,
            clock,
          }).receipt.checkpointId;
        } catch (error) {
          options.logger.warn(
            { sessionId: session.sessionId, errorName: error instanceof Error ? error.name : "Error" },
            "embodiment checkpoint mint failed",
          );
        }
      }

      return {
        kind: "ran",
        result: {
          outcome: control.stopRequested() ? "stopped" : "budget_exhausted",
          turnsTaken: result.turns.length,
          durationMs: clock().getTime() - startedAt,
          framesPublished,
          framesDropped: (sink?.droppedFrameCount ?? 0) + framesDroppedWithoutSink,
          ...(checkpointId === undefined ? {} : { checkpointId }),
          ...(resumedFromCheckpointId === undefined ? {} : { resumedFromCheckpointId }),
        },
      };
    } finally {
      sink?.close();
      freePlay.close();
    }
  }
}
