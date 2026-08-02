/**
 * The production PlayExecution: the same composition `free-play-live.ts`
 * proved out — boot, body lock, activity frame sink, model mind, free-play
 * loop — owned by the play host instead of a hand-launched terminal.
 *
 * Degradation rules (ADR 0063):
 * - another holder on the body lock refuses `body_held`, never crashes;
 * - a missing ROM, fixture, or model refuses `environment_unavailable`;
 * - a missing activity producer degrades to counted dropped frames — the
 *   playthrough continues, the receipt says nobody could watch;
 * - a missing voice seam degrades to a silent playthrough (ADR 0067): he is
 *   watchable but not audible, and the log says which;
 * - an unwritable play journal degrades to an unrecorded playthrough
 *   (ADR 0068): a full disk costs the record, never the play, and the log
 *   says so.
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
  createModelVoice,
  defaultGbaBodyRootDir,
  defaultGbaCheckpointDir,
  defaultGbaPlayJournalDir,
  InterjectionQueue,
  listGbaCheckpoints,
  openFreePlayJournal,
  readGbaCheckpoint,
  runFreePlay,
  writeGbaCheckpoint,
  type BodyLock,
  type BootedGbaGame,
  type ClankieVoice,
  type FreePlayJournal,
  type FreePlayMind,
  type FreePlayTurn,
} from "@clankie/gba-emulator";
import { RenderedSurfaceOverlaySchema } from "@clankie/interactive-environment";
import { resolveConfiguredLanguageModel } from "@clankie/model-provider";
import { createBrokeredPossessorVoiceClient, type PossessorVoiceClient } from "@clankie/possessor-voice";
import { createBrokeredActivityFrameSink } from "@clankie/rendered-surface-client";
import { personaInstructions, SettingsStore } from "@clankie/settings";
import type { PlayExecution } from "./play-host.ts";

const FRAME_WIDTH = 240 * 3;
const FRAME_HEIGHT = 160 * 3;

/** Autosave cadence in turns. Unset or unparseable falls back to 50; 0 disables. */
const DEFAULT_AUTOSAVE_TURNS = 50;
function parseAutosaveTurns(raw: string | undefined): number {
  if (raw === undefined || raw.length === 0) return DEFAULT_AUTOSAVE_TURNS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_AUTOSAVE_TURNS;
}

interface PlayExecutionLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export interface GbaPlayExecutionOptions {
  logger: PlayExecutionLogger;
  env?: NodeJS.ProcessEnv;
  clock?: () => Date;
  /**
   * Where mid-play questions land. The dev script wires stdin; in production
   * the voice seam feeds it, so a person in the channel can talk to him
   * mid-playthrough. Supplying one adds a source rather than replacing voice.
   */
  interjections?: InterjectionQueue;
  /** Extra per-turn observer beside the overlay publish (dev script logging). */
  onTurn?: (turn: FreePlayTurn) => void;
  /** Test/dev injection; production resolves the configured model. */
  createMind?: () => Promise<FreePlayMind>;
  /**
   * Test/dev injection for the half of him that talks (ADR 0056). Production
   * builds it from the same model and persona the mind gets, so the two halves
   * are one character.
   */
  createVoiceAgent?: () => Promise<ClankieVoice | undefined>;
  /** Test injection; production boots the ROM-gated game or the double. */
  boot?: () => Promise<BootedGbaGame>;
  /** Test injection; production resolves the brokered possessor voice seam. */
  createVoice?: () => Promise<PossessorVoiceClient | undefined>;
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
    // The half of him that talks, as its own agent (ADR 0056). Undefined only
    // when a test supplies its own mind: speech is not what those exercise.
    let voiceAgent: ClankieVoice | undefined;
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
      if (options.createVoiceAgent !== undefined) voiceAgent = await options.createVoiceAgent();
      if (options.createMind !== undefined) {
        mind = await options.createMind();
      } else {
        const configured = await resolveConfiguredLanguageModel({ cwd: repoRoot, env });
        // One character across every surface (ADR 0051): the Clankie an
        // audience watches play is the one they talk to, in his `gameplay`
        // register — not a second character defined by this file's prompt.
        const character = personaInstructions((await new SettingsStore().load()).persona, "gameplay");
        const providerOptions = configured.modelOptions?.providerOptions ?? {};
        const requestTimeoutMs = positiveIntegerOr(env["CLANKIE_PLAY_MODEL_REQUEST_TIMEOUT_MS"], 60_000);
        mind = createModelFreePlayMind({
          model: configured.model,
          character,
          providerOptions,
          requestTimeoutMs,
        });
        voiceAgent = createModelVoice({
          model: configured.model,
          character,
          providerOptions,
          requestTimeoutMs,
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
    // What he was thinking when the resumed checkpoint was minted. Restoring
    // the RAM without it resumes a world whose player has forgotten why he is
    // standing where he stands.
    let resumedContinuity: { notes: string | null; objective: string | null } | null = null;
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
          resumedContinuity = checkpoint.receipt.continuity;
          break;
        } catch (error) {
          // Skipped, not silent: a corrupt newest checkpoint that quietly falls
          // through to an older one reads exactly like lost progress.
          options.logger.warn(
            {
              sessionId: session.sessionId,
              checkpointId: candidate.checkpointId,
              errorName: error instanceof Error ? error.name : "Error",
            },
            "checkpoint skipped: failed its identity or digest gate",
          );
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

    // The room, both directions (ADR 0067 over ADR 0064's seam). Best-effort
    // exactly like the frame sink: the runner holds no gateway, so with no
    // credential or no bridge listening he plays watchable but silent rather
    // than not playing at all.
    const voice =
      options.createVoice === undefined
        ? await createBrokeredPossessorVoiceClient()
        : await options.createVoice();
    if (voice === undefined) {
      options.logger.info(
        { sessionId: session.sessionId },
        "no possessor voice seam; this playthrough is silent",
      );
    }
    // Voice feeds the same queue the dev script's stdin does, so hearing the
    // room needs no second path into the loop.
    const interjections = options.interjections ?? new InterjectionQueue();
    const unsubscribe = voice?.subscribe((utterance) => interjections.offer(utterance));

    // One log line per session, not per turn: a bridge that is down stays down,
    // and a line per turn would bury the playthrough in its own failure.
    let speechFailureLogged = false;
    /**
     * Report an event to the room — never a sentence to say (ADR 0074).
     *
     * The seam has always carried "what just happened" and let the persona on
     * the far side compose the words. Handing it `turn.speak` instead handed a
     * finished quip to a conversational model as something to react to, which
     * is how six words became seventeen seconds of speech in the 2026-08-01
     * run. What crosses here is the turn's own effect line.
     */
    const reportToRoom = (event: string | null): void => {
      if (event === null || event.length === 0 || voice === undefined) return;
      // No room, nothing to report to. Without this the bridge rejects every
      // event with "not in a channel" and the one-shot failure log below would
      // report a broken seam when the truth is an empty room.
      if (!voice.roomListening) return;
      void voice.narrate(event).catch((error: unknown) => {
        if (speechFailureLogged) return;
        speechFailureLogged = true;
        options.logger.info(
          {
            sessionId: session.sessionId,
            errorMessage: error instanceof Error ? error.message : "unknown",
          },
          "embodiment speech unavailable; play continues in silence",
        );
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
      unsubscribe?.();
      voice?.close();
      options.logger.warn(
        { sessionId: session.sessionId, errorName: error instanceof Error ? error.name : "Error" },
        "embodiment session start refused",
      );
      return { kind: "refused", reason: "environment_unavailable" };
    }

    // The durable trail (ADR 0068): header now, every turn as it settles, the
    // summary at the end. Best-effort in both directions — an unwritable
    // journal is an unrecorded playthrough, never a refused one.
    let journal: FreePlayJournal | undefined;
    let journalFailureLogged = false;
    try {
      journal = openFreePlayJournal({
        rootDir: defaultGbaPlayJournalDir(env),
        runId: session.sessionId,
        environmentSessionId: freePlay.sessionId,
        scenarioId: game.scenario.scenarioId,
        resumedFromCheckpointId,
        clock,
        onError: (error) => {
          if (journalFailureLogged) return;
          journalFailureLogged = true;
          options.logger.warn(
            {
              sessionId: session.sessionId,
              errorName: error instanceof Error ? error.name : "Error",
            },
            "play journal append failed; playthrough continues unrecorded",
          );
        },
      });
    } catch (error) {
      options.logger.warn(
        { sessionId: session.sessionId, errorName: error instanceof Error ? error.name : "Error" },
        "play journal unavailable; this playthrough is unrecorded",
      );
    }

    // How often a marathon banks its progress. The stop mint only covers a
    // clean stop; with no default cap on session length (ADR 0063), a crash
    // otherwise loses everything since the session began. 0 disables.
    const autosaveEvery = parseAutosaveTurns(env["CLANKIE_PLAY_AUTOSAVE_TURNS"]);

    // His reach into the body's saved time (ADR 0074). Every rewind banks the
    // present first — checkpoints are append-only, so his own choice can never
    // destroy the progress it leaves behind.
    let latestTurn: FreePlayTurn | undefined;
    const bankBeforeRewind = (): void => {
      if (game.checkpoints === undefined) return;
      const banked = writeGbaCheckpoint({
        rootDir: checkpointDir,
        capability: game.checkpoints,
        label: "before-rewind",
        position: null,
        continuity:
          latestTurn === undefined ? null : { notes: latestTurn.notes, objective: latestTurn.objective },
        clock,
      });
      options.logger.info(
        { sessionId: session.sessionId, checkpointId: banked.receipt.checkpointId },
        "banked the present before a rewind",
      );
    };
    const checkpointPort =
      game.checkpoints === undefined
        ? undefined
        : {
            list: () =>
              listGbaCheckpoints(checkpointDir).map((receipt) => ({
                checkpointId: receipt.checkpointId,
                label: receipt.label,
                capturedAt: receipt.capturedAt,
                position: receipt.position,
              })),
            load: (checkpointId: string) => {
              const checkpoints = game.checkpoints;
              if (checkpoints === undefined) throw new Error("checkpoints_unavailable");
              // Verify before banking, so a refused load mints nothing.
              const checkpoint = readGbaCheckpoint({
                rootDir: checkpointDir,
                checkpointId,
                identity: checkpoints.identity,
              });
              bankBeforeRewind();
              checkpoints.loadState(checkpoint.savestateBytes);
              options.logger.info({ sessionId: session.sessionId, checkpointId }, "he loaded a checkpoint");
              return {
                checkpointId: checkpoint.receipt.checkpointId,
                label: checkpoint.receipt.label,
                capturedAt: checkpoint.receipt.capturedAt,
                position: checkpoint.receipt.position,
              };
            },
            restart: () => {
              const checkpoints = game.checkpoints;
              if (checkpoints === undefined) throw new Error("checkpoints_unavailable");
              bankBeforeRewind();
              checkpoints.loadState(checkpoints.bootSavestate());
              options.logger.info(
                { sessionId: session.sessionId },
                "he restarted the game from its beginning",
              );
            },
          };

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
        audience:
          env["CLANKIE_FREE_PLAY_AUDIENCE"] ??
          (voice === undefined
            ? "people watching the activity surface"
            : "people in the voice channel, watching him play"),
        ...(voiceAgent === undefined ? {} : { voice: voiceAgent }),
        // Read per turn: someone joining the channel mid-playthrough hands
        // authorship to the room from that turn on, and leaving hands it back.
        ...(voice === undefined ? {} : { roomAuthors: () => voice.roomListening }),
        ...(checkpointPort === undefined ? {} : { checkpoints: checkpointPort }),
        ...(resumedContinuity === null
          ? {}
          : {
              initialNotes: resumedContinuity.notes,
              initialObjective: resumedContinuity.objective,
            }),
        framebufferSha256: () => game.framebufferSha256(),
        framePng: () => game.framePng(),
        interjections,
        shouldStop: () =>
          control.stopRequested() ||
          (session.budget.maxDurationMs !== undefined &&
            clock().getTime() - startedAt >= session.budget.maxDurationMs),
        onTurn: (turn) => {
          latestTurn = turn;
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
          // What happened, not what to say (ADR 0074). The room's own persona
          // decides whether this is worth a remark and what the remark is; it
          // already heard anything that was said to him, so a reply composed
          // here would be a second answer in a different voice.
          reportToRoom(turn.effect);
          journal?.turn(turn);
          if (
            autosaveEvery > 0 &&
            game.checkpoints !== undefined &&
            turn.turn > 0 &&
            turn.turn % autosaveEvery === 0
          ) {
            try {
              const autosave = writeGbaCheckpoint({
                rootDir: checkpointDir,
                capability: game.checkpoints,
                label: "autosave",
                position: null,
                continuity: { notes: turn.notes, objective: turn.objective },
                clock,
              });
              options.logger.info(
                {
                  sessionId: session.sessionId,
                  checkpointId: autosave.receipt.checkpointId,
                  turn: turn.turn,
                },
                "autosave checkpoint minted",
              );
            } catch (error) {
              options.logger.warn(
                {
                  sessionId: session.sessionId,
                  turn: turn.turn,
                  errorName: error instanceof Error ? error.name : "Error",
                },
                "autosave checkpoint mint failed; play continues",
              );
            }
          }
          options.onTurn?.(turn);
        },
      });

      game.observeFrames(null);
      let checkpointId: string | undefined;
      if (game.checkpoints !== undefined) {
        try {
          // The final turn's notes and objective ride along, so the next
          // session resumes his mind with the world.
          const lastTurn = result.turns.at(-1);
          checkpointId = writeGbaCheckpoint({
            rootDir: checkpointDir,
            capability: game.checkpoints,
            label: "asked-play",
            position: null,
            continuity:
              lastTurn === undefined ? null : { notes: lastTurn.notes, objective: lastTurn.objective },
            clock,
          }).receipt.checkpointId;
        } catch (error) {
          options.logger.warn(
            { sessionId: session.sessionId, errorName: error instanceof Error ? error.name : "Error" },
            "embodiment checkpoint mint failed",
          );
        }
      }

      const outcome = control.stopRequested() ? "stopped" : "budget_exhausted";
      const durationMs = clock().getTime() - startedAt;
      const framesDropped = (sink?.droppedFrameCount ?? 0) + framesDroppedWithoutSink;
      journal?.summary({ outcome, result, durationMs, framesPublished, framesDropped, checkpointId });
      // The receipt is content-free by construction; the metrics the loop
      // computed (progress, volition, coherence) land here and in the journal
      // summary instead of being dropped on conversion.
      options.logger.info(
        {
          sessionId: session.sessionId,
          outcome,
          turnsTaken: result.turns.length,
          accepted: result.accepted,
          durationMs,
          distinctTiles: result.progress.distinctTiles,
          maps: result.progress.maps,
          turnsSinceNewTile: result.progress.turnsSinceNewTile,
          volitionTaken: result.volition.taken,
          volitionOffered: result.volition.offered,
          coherence: result.coherence,
          ...(checkpointId === undefined ? {} : { checkpointId }),
          ...(journal === undefined ? {} : { journalPath: journal.path }),
        },
        "embodiment playthrough finished",
      );

      return {
        kind: "ran",
        result: {
          outcome,
          turnsTaken: result.turns.length,
          durationMs,
          framesPublished,
          framesDropped,
          ...(checkpointId === undefined ? {} : { checkpointId }),
          ...(resumedFromCheckpointId === undefined ? {} : { resumedFromCheckpointId }),
        },
      };
    } finally {
      sink?.close();
      unsubscribe?.();
      voice?.close();
      freePlay.close();
    }
  }
}

function positiveIntegerOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
