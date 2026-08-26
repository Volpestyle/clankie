/**
 * The production PlayExecution: the same composition `free-play-live.ts`
 * proved out — boot, activity frame sink, model mind, free-play loop — owned
 * by the play host instead of a hand-launched terminal.
 *
 * Degradation rules (ADR 0063):
 * - a missing ROM, fixture, or model refuses `environment_unavailable`;
 * - a missing activity producer degrades to counted dropped frames — the
 *   playthrough continues, the receipt says nobody could watch;
 * - a missing voice seam degrades to a silent playthrough (ADR 0067): he is
 *   watchable but not audible, and the log says which;
 * - an unwritable play journal degrades to an unrecorded playthrough
 *   (ADR 0068): a full disk costs the record, never the play, and the log
 *   says so.
 */
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import {
  bootGbaGame,
  createFreePlaySession,
  createModelFreePlayMind,
  createModelVoice,
  defaultGbaCheckpointDir,
  defaultGbaPlayJournalDir,
  defaultGbaRuntimeRootDir,
  InterjectionQueue,
  latestPlayJourneyContinuity,
  listGbaCheckpoints,
  localPlayJourneyId,
  openFreePlayJournal,
  readGbaCheckpoint,
  runFreePlay,
  writeGbaCheckpoint,
  type BootedGbaGame,
  type ClankieVoice,
  type FreePlayJournal,
  type FreePlayCheckpointPort,
  type FreePlayMind,
  type FreePlaySettledTurn,
  type FreePlayTurn,
} from "@clankie/gba-emulator";
import {
  GbaActivityObservationSnapshotSchema,
  RenderedSurfaceOverlaySchema,
} from "@clankie/interactive-environment";
import { resolveConfiguredLanguageModel } from "@clankie/model-provider";
import { createBrokeredPlayVoiceClient, type PlayVoiceClient } from "@clankie/play-voice";
import { createBrokeredActivityFrameSink, type ActivityFrameSink } from "@clankie/rendered-surface-client";
import { personaInstructions, SettingsStore, type GameplaySettings } from "@clankie/settings";
import { embodimentVenue } from "@clankie/protocol";
import type { ActivityObservationWritePort } from "./activity-observation.ts";
import type { PlayExecution } from "./play-host.ts";
import type { PlaySightProjection } from "./play-sight.ts";
import { createWorldPlayExecution } from "./play-execution-world.ts";
import type { WorldJoinOptions, WorldJoinResult } from "./world/body.ts";

/**
 * The stream carries the native screen; the model's own view stays upscaled.
 *
 * The activity canvas is CSS-sized with `image-rendering: pixelated` and its
 * own default is 240x160, so a 3x nearest-neighbour upscale added ~9x the
 * pixels for a picture the viewer cannot tell apart — and spent the hub's
 * per-viewer backpressure budget (`RenderedSurfaceHub`, 512KB) doing it, which
 * is what turned a paced walk into a teleport.
 */
const STREAM_SCALE = 1;
const FRAME_WIDTH = 240 * STREAM_SCALE;
const FRAME_HEIGHT = 160 * STREAM_SCALE;

/**
 * Idle emulation between turns, in frames per tick and milliseconds per tick.
 *
 * The core advances only while an action is dispatching, so the screen freezes
 * for as long as he thinks — two thirds of the wall clock on the 2026-08-15
 * run. Ticking it with nothing held is what standing still in FireRed looks
 * like: NPCs walk their routes, water animates, his sprite bobs.
 */
const IDLE_CHUNK_FRAMES = 1;
const IDLE_TICK_MS = Math.round(1_000 / 59.7275);

/**
 * How long one decision may take before the turn is abandoned.
 *
 * The deadline exists to stop a wedged request hanging the playthrough, not to
 * keep turns snappy — the loop has nothing else to do while it waits, and since
 * the console keeps idling the screen stays alive through a slow one. Too tight
 * a bound is therefore strictly worse than a slow turn: it converts a late
 * answer into no answer, and the journal records `mind_failed` instead of a
 * move. 60s was that, once his vision model slowed down: measured 2026-08-15,
 * a *trivial* "describe this screen in ten words" call to grok-4.6 took 20-25s,
 * and a full decision — system prompt, rendered view, screenshot, structured
 * action out — ran past the minute and lost three turns in a row.
 */
const PLAY_MODEL_REQUEST_TIMEOUT_MS = 180_000;

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
  /** Owner-enabled play venues; omitted by tests and dev callers to enable both. */
  gameplay?: GameplaySettings;
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
  /** Latest-only self-observation for captain and authenticated operator reads. */
  activityObservations?: ActivityObservationWritePort;
  /** Pull-when-he-wants still and journal story (ADR 0099). */
  playSight?: PlaySightProjection;
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
  /** Test injection; production resolves the brokered play voice seam. */
  createVoice?: () => Promise<PlayVoiceClient | undefined>;
  /** Test injection; production resolves the brokered activity sink. */
  createActivitySink?: () => Promise<ActivityFrameSink | undefined>;
  /**
   * Test injection for a hosted-world join. Production calls `joinWorld`.
   * Lane A fills the real body; tests supply a fake.
   */
  joinWorld?: (options: WorldJoinOptions) => Promise<WorldJoinResult>;
}

export function createGbaPlayExecution(options: GbaPlayExecutionOptions): PlayExecution {
  const env = options.env ?? process.env;
  const clock = options.clock ?? (() => new Date());
  const runWorld = createWorldPlayExecution(options);

  return async (session, control, onRunning) => {
    const venue = embodimentVenue(session);
    if (
      venue === "world"
        ? options.gameplay?.pokeagentMmoEnabled === false
        : options.gameplay?.pokemonEmulatorEnabled === false
    ) {
      return { kind: "refused", reason: "environment_unavailable" };
    }
    if (venue === "world") {
      return runWorld(session, control, onRunning);
    }
    return runLocalPlay(session, control, onRunning);
  };

  async function runLocalPlay(
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
              environmentId: session.environmentId,
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
        const requestTimeoutMs = positiveIntegerOr(
          env["CLANKIE_PLAY_MODEL_REQUEST_TIMEOUT_MS"],
          PLAY_MODEL_REQUEST_TIMEOUT_MS,
        );
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
    const journalDir = defaultGbaPlayJournalDir(env);
    const journeyId = localPlayJourneyId({
      environmentId: session.environmentId,
    });
    // The checkpoint root is shared across games, and the load gate refuses a
    // foreign ROM or core build — so another game's receipts (routine once
    // Emerald joined FireRed) are never listed or resumed here, only ones this
    // running core could actually load.
    const listCompatibleCheckpoints = () => {
      const identity = game.checkpoints?.identity;
      if (identity === undefined) return [];
      return listGbaCheckpoints(checkpointDir).filter(
        (receipt) =>
          receipt.romSha256 === identity.romSha256 && receipt.coreWasmSha256 === identity.coreWasmSha256,
      );
    };
    let resumedFromCheckpointId: string | undefined;
    // What he was thinking when the resumed checkpoint was minted. Restoring
    // the RAM without it resumes a world whose player has forgotten why he is
    // standing where he stands.
    let resumedContinuity: { notes: string | null; objective: string | null } | null = null;
    if (game.checkpoints !== undefined) {
      for (const candidate of listCompatibleCheckpoints()) {
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
    // A body without checkpoints (or a cold start with none yet) still has a
    // durable mind in the journal. A loaded checkpoint wins because its notes
    // describe that exact saved world rather than a potentially newer branch.
    if (resumedFromCheckpointId === undefined) {
      resumedContinuity = latestPlayJourneyContinuity(journalDir, journeyId);
    }

    const sink =
      options.createActivitySink === undefined
        ? await createBrokeredActivityFrameSink({
            url: env["CLANKIE_ACTIVITY_PRODUCER_URL"] ?? "ws://127.0.0.1:4322/producer",
          })
        : await options.createActivitySink();
    let framesPublished = 0;
    let framesDroppedWithoutSink = 0;
    let frameSequence = 0;
    let overlaySequence = 0;
    let lastFrameDigest: string | null = null;
    const publishFrame = (frame: number): void => {
      const png = game.framePng(STREAM_SCALE);
      if (png === null) return;
      if (sink === undefined) {
        framesDroppedWithoutSink += 1;
        return;
      }
      const bytes = Buffer.from(png);
      const digest = createHash("sha256").update(bytes).digest("hex");
      // An unchanged screen — an open menu, a dialog box nobody is advancing —
      // otherwise costs a moving frame's bandwidth, and the frames that get
      // dropped downstream for it are the ones carrying the motion. The hub
      // replays its latest frame to every joiner, so nothing goes blank.
      if (digest === lastFrameDigest) return;
      lastFrameDigest = digest;
      frameSequence += 1;
      framesPublished += 1;
      sink.publishFrame({
        schemaVersion: 1,
        surface: "gba_emulator",
        sequence: frameSequence,
        frame,
        width: FRAME_WIDTH,
        height: FRAME_HEIGHT,
        encoding: "png",
        data: bytes.toString("base64"),
        byteLength: bytes.byteLength,
        sha256: digest,
        capturedAt: clock().toISOString(),
      });
    };

    let freePlay;
    try {
      freePlay = await createFreePlaySession({
        rootDir: defaultGbaRuntimeRootDir(env),
        scenario: game.scenario,
        fixtureSha256: game.fixtureSha256,
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

    // Establish every cleanup handle before voice credential/client creation:
    // broker failures must not strand the activity socket or emulator runtime.
    let voice: PlayVoiceClient | undefined;
    let unsubscribe: (() => void) | undefined;
    const interjections = options.interjections ?? new InterjectionQueue();
    try {
      voice =
        options.createVoice === undefined
          ? await createBrokeredPlayVoiceClient()
          : await options.createVoice();
      if (voice === undefined) {
        options.logger.info(
          { sessionId: session.sessionId },
          "no play voice seam; this playthrough is silent",
        );
      }
      // Voice feeds the same queue the dev script's stdin does, so hearing the
      // room needs no second path into the loop.
      unsubscribe = voice?.subscribe((utterance) => interjections.offer(utterance));
    } catch (error) {
      unsubscribe?.();
      voice?.close();
      game.observeFrames(null);
      sink?.close();
      await freePlay.close().catch(() => undefined);
      throw error;
    }

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
    const reportToRoom = (
      event: string,
      narration: { readonly deliveryId?: string; readonly respond: boolean },
    ): void => {
      if (event.length === 0 || voice === undefined) return;
      // No room, nothing to report to. Without this the bridge rejects every
      // event with "not in a channel" and the one-shot failure log below would
      // report a broken seam when the truth is an empty room.
      if (!voice.roomListening) return;
      void voice.narrate(event, narration).catch((error: unknown) => {
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

    // The durable trail (ADR 0068): header now, every turn as it settles, the
    // summary at the end. Best-effort in both directions — an unwritable
    // journal is an unrecorded playthrough, never a refused one.
    let journal: FreePlayJournal | undefined;
    let journalFailureLogged = false;
    try {
      journal = openFreePlayJournal({
        rootDir: journalDir,
        runId: session.sessionId,
        journeyId,
        environmentId: session.environmentId,
        venue: "local",
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
        journeyId,
        environmentId: session.environmentId,
        continuity:
          latestTurn === undefined ? null : { notes: latestTurn.notes, objective: latestTurn.objective },
        clock,
      });
      options.logger.info(
        { sessionId: session.sessionId, checkpointId: banked.receipt.checkpointId },
        "banked the present before a rewind",
      );
    };
    const checkpointPort: FreePlayCheckpointPort | undefined =
      game.checkpoints === undefined
        ? undefined
        : {
            list: () =>
              listCompatibleCheckpoints().map((receipt) => ({
                checkpointId: receipt.checkpointId,
                label: receipt.label,
                capturedAt: receipt.capturedAt,
                position: receipt.position,
              })),
            save: ({ label, position, continuity }) => {
              const checkpoints = game.checkpoints;
              if (checkpoints === undefined) throw new Error("checkpoints_unavailable");
              const saved = writeGbaCheckpoint({
                rootDir: checkpointDir,
                capability: checkpoints,
                ...(label === undefined ? {} : { label }),
                position,
                continuity,
                journeyId,
                environmentId: session.environmentId,
                clock,
              }).receipt;
              options.logger.info(
                { sessionId: session.sessionId, checkpointId: saved.checkpointId },
                "he saved a checkpoint",
              );
              return {
                checkpointId: saved.checkpointId,
                label: saved.label,
                capturedAt: saved.capturedAt,
                position: saved.position,
              };
            },
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
    let idleTick: NodeJS.Timeout | undefined;
    try {
      await onRunning(resumedFromCheckpointId);
      const glanceScale = 3;
      options.playSight?.attach({
        sessionId: session.sessionId,
        journeyId,
        environmentId: session.environmentId,
        scenarioId: game.scenario.scenarioId,
        startedAt: clock().toISOString(),
        ...(journal === undefined ? {} : { journalPath: journal.path }),
        capture: () => {
          const png = game.framePng(glanceScale);
          if (png === null) return undefined;
          return { png: Buffer.from(png), width: 240 * glanceScale, height: 160 * glanceScale };
        },
      });
      // One publish per action shows a teleport, not a step; paced so the
      // motion reads as gameplay (same rule as the MCP and live paths).
      const observer = (): void => publishFrame(frameSequence);
      game.observeFrames(observer, { pace: true });

      // Dispatch drives the core, so between turns the game is stopped, not
      // idle, and the watcher gets a still image for the whole thinking gap.
      // This interval is the console's clock while he thinks; `idleFrames`
      // stands off on its own whenever an action holds the core.
      const idleCore = game.coreFactory?.(game.scenario);
      if (idleCore?.idleFrames !== undefined) {
        idleTick = setInterval(() => {
          idleCore.idleFrames?.(IDLE_CHUNK_FRAMES);
        }, IDLE_TICK_MS);
        idleTick.unref();
      }

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
        framePng: (anchor) => game.framePng(undefined, anchor),
        provenance: () => ({
          body: "local",
          coreId: game.scenario.coreId,
          fixtureSha256: game.fixtureSha256,
          real: game.real,
          ...(game.checkpoints === undefined
            ? {}
            : {
                romSha256: game.checkpoints.identity.romSha256,
                coreWasmSha256: game.checkpoints.identity.coreWasmSha256,
              }),
        }),
        clock,
        onPhase: (phase) =>
          sink?.publishStatus({
            schemaVersion: 1,
            surface: "gba_emulator",
            phase,
            updatedAt: clock().toISOString(),
          }),
        interjections,
        shouldStop: () =>
          control.stopRequested() ||
          (session.budget.maxDurationMs !== undefined &&
            clock().getTime() - startedAt >= session.budget.maxDurationMs),
        onTurn: (turn, evidence) => {
          latestTurn = turn;
          overlaySequence += 1;
          if (sink !== undefined) {
            sink.publishOverlay(
              RenderedSurfaceOverlaySchema.parse({
                schemaVersion: 1,
                surface: "gba_emulator",
                sequence: overlaySequence,
                objective: overlayText(turn.objective),
                intent: overlayText(turn.intent),
                monologue: overlayText(turn.monologue),
                effect: overlayText(turn.effect),
                updatedAt: clock().toISOString(),
              }),
            );
          }
          publishFrame(turn.turn);
          // What happened, not what to say (ADR 0074) — but only on the turns
          // his own volition judged worth remarking on. Reporting every turn
          // fed the room a running commentary of turn diagnostics ("no visible
          // change — the frame is identical"), and the 12s narration throttle
          // then picked whichever fragment happened to land on the boundary.
          // `speak` is the gate that already reads the whole moment; reusing it
          // keeps one judgement of "is this worth saying" rather than a second
          // list of notable-looking effects that would drift from the first.
          const event = roomEvent(turn);
          const speechDeliveryId =
            event !== null && turn.speakWanted && voice !== undefined && voice.roomListening
              ? randomUUID()
              : undefined;
          if (event !== null) {
            reportToRoom(event, {
              ...(speechDeliveryId === undefined ? {} : { deliveryId: speechDeliveryId }),
              respond: speechDeliveryId !== undefined,
            });
          }
          journal?.turn(turn, evidence, {
            framePng: () => game.framePng(STREAM_SCALE),
            ...(speechDeliveryId === undefined || event === null
              ? {}
              : { speechDeliveryId, narrationEvent: event }),
          });
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
                journeyId,
                environmentId: session.environmentId,
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
        onSettledTurn: (event: FreePlaySettledTurn) => {
          options.activityObservations?.publish(
            GbaActivityObservationSnapshotSchema.parse({
              schemaVersion: 1,
              surface: "gba_emulator",
              sessionId: session.sessionId,
              environmentId: session.environmentId,
              sequence: event.turn.turn,
              observedAt: clock().toISOString(),
              selfAuthored: {
                objective: event.turn.objective,
                intent: event.turn.intent,
                commentary: event.turn.monologue,
              },
              runnerObserved: {
                outcome: event.turn.outcome,
                effect: event.turn.effect,
                progress: {
                  ...event.progress,
                  // A long route can revisit maps indefinitely. Keep the
                  // newest bounded path tail without making observation able
                  // to fail or stop gameplay.
                  maps: event.progress.maps.slice(-64).map((mapId) => mapId.slice(0, 200)),
                },
                framebufferSha256: game.framebufferSha256(),
              },
            }),
          );
          options.playSight?.noteProgress({
            maps: event.progress.maps.slice(-16),
            objective: event.turn.objective,
          });
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
            journeyId,
            environmentId: session.environmentId,
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
      journal?.summary({
        outcome,
        result,
        durationMs,
        framesPublished,
        framesDropped,
        checkpointId,
        framePng: () => game.framePng(STREAM_SCALE),
      });
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
          longestUnchangedRun: result.longestUnchangedRun,
          longestRecurringRun: result.longestRecurringRun,
          objectivesRetired: result.objectivesRetired,
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
      if (idleTick !== undefined) clearInterval(idleTick);
      options.activityObservations?.clear(session.sessionId);
      options.playSight?.detach(session.sessionId);
      sink?.close();
      unsubscribe?.();
      voice?.close();
      await freePlay.close();
    }
  }
}

function overlayText(value: string | null): string | null {
  return value?.trim().slice(0, 256) || null;
}

/**
 * A bounded first-person continuity update for the room persona. It crosses
 * every settled turn; `speakWanted` separately decides whether that update may
 * ask for audio. The field slices keep the exact offered event inside the
 * journal's 512-character evidence bound.
 */
function roomEvent(turn: FreePlayTurn): string | null {
  const lines = [`turn=${String(turn.turn)}`];
  const thought = turn.monologue?.trim();
  const observed = turn.effect?.trim();
  const objective = turn.objective?.trim();
  const intent = turn.intent?.trim();
  if (thought) lines.push(`thought=${thought.slice(0, 160)}`);
  if (observed) lines.push(`observed=${observed.slice(0, 120)}`);
  if (objective) lines.push(`goal=${objective.slice(0, 80)}`);
  if (intent) lines.push(`next=${intent.slice(0, 80)}`);
  return lines.length === 1 ? null : lines.join("\n");
}

function positiveIntegerOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
