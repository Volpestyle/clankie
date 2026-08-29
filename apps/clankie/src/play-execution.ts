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
import path from "node:path";
import {
  bootGbaGame,
  createFreePlaySession,
  defaultGbaCheckpointDir,
  defaultGbaPlayJournalDir,
  defaultGbaRuntimeRootDir,
  InterjectionQueue,
  latestPlayJourneyContinuity,
  listGbaCheckpoints,
  localPlayJourneyId,
  readGbaCheckpoint,
  writeGbaCheckpoint,
  type BootedGbaGame,
  type ClankieVoice,
  type FreePlayCheckpointPort,
  type FreePlayMind,
  type FreePlayTurn,
} from "@clankie/gba-emulator";
import type { PlayVoiceClient } from "@clankie/play-voice";
import type { GameplaySettings } from "@clankie/settings";
import { embodimentVenue } from "@clankie/protocol";
import type { ActivityFrameSink } from "@clankie/rendered-surface-client";
import type { ActivityObservationWritePort } from "./activity-observation.ts";
import type { PlayExecution } from "./play-host.ts";
import type { PlaySightProjection } from "./play-sight.ts";
import {
  PLAY_STREAM_HEIGHT,
  PLAY_STREAM_WIDTH,
  resolvePlayMind,
  resolvePlayRuntimeRoots,
  runEmbodiedPlay,
  type PlayExecutionLogger,
} from "./play-execution-shared.ts";
import { createWorldPlayExecution } from "./play-execution-world.ts";
import type { WorldJoinOptions, WorldJoinResult } from "./world/body.ts";
import type { HostedWorldSession } from "./world/session.ts";

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

/** Autosave cadence in turns. Unset or unparseable falls back to 50; 0 disables. */
const DEFAULT_AUTOSAVE_TURNS = 50;
function parseAutosaveTurns(raw: string | undefined): number {
  if (raw === undefined || raw.length === 0) return DEFAULT_AUTOSAVE_TURNS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_AUTOSAVE_TURNS;
}

export interface GbaPlayExecutionOptions {
  logger: PlayExecutionLogger;
  /** Runtime root: the source checkout in development, the release directory when installed. */
  repoRoot?: string;
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
  /** Live hosted-world operations for the captain while a world body is playing. */
  hostedWorld?: HostedWorldSession;
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
    const { emulatorPackage, repoRoot } = resolvePlayRuntimeRoots(options.repoRoot);

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
      ({ mind, voiceAgent } = await resolvePlayMind({
        env,
        repoRoot,
        ...(options.createMind === undefined ? {} : { createMind: options.createMind }),
        ...(options.createVoiceAgent === undefined ? {} : { createVoiceAgent: options.createVoiceAgent }),
      }));
    } catch (error) {
      options.logger.warn(
        { sessionId: session.sessionId, errorName: error instanceof Error ? error.name : "Error" },
        "embodiment boot refused",
      );
      return { kind: "refused", reason: "environment_unavailable" };
    }

    const checkpointDir = defaultGbaCheckpointDir(env);
    const journalDir = defaultGbaPlayJournalDir(env);
    const journeyId = localPlayJourneyId({
      environmentId: session.environmentId,
    });
    const listCompatibleCheckpoints = () => {
      const identity = game.checkpoints?.identity;
      if (identity === undefined) return [];
      return listGbaCheckpoints(checkpointDir).filter(
        (receipt) =>
          receipt.romSha256 === identity.romSha256 && receipt.coreWasmSha256 === identity.coreWasmSha256,
      );
    };
    let resumedFromCheckpointId: string | undefined;
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
    if (resumedFromCheckpointId === undefined) {
      resumedContinuity = latestPlayJourneyContinuity(journalDir, journeyId);
    }

    let freePlay;
    try {
      freePlay = await createFreePlaySession({
        rootDir: defaultGbaRuntimeRootDir(env),
        scenario: game.scenario,
        fixtureSha256: game.fixtureSha256,
        ...(game.coreFactory === undefined ? {} : { coreFactory: game.coreFactory }),
      });
    } catch (error) {
      options.logger.warn(
        { sessionId: session.sessionId, errorName: error instanceof Error ? error.name : "Error" },
        "embodiment session start refused",
      );
      return { kind: "refused", reason: "environment_unavailable" };
    }

    const autosaveEvery = parseAutosaveTurns(env["CLANKIE_PLAY_AUTOSAVE_TURNS"]);
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

    let idleTick: NodeJS.Timeout | undefined;
    const glanceScale = 3;
    return runEmbodiedPlay({
      session,
      control,
      onRunning,
      logger: options.logger,
      env,
      clock,
      mind,
      ...(voiceAgent === undefined ? {} : { voiceAgent }),
      surface: {
        venue: "local",
        journeyId,
        scenarioId: game.scenario.scenarioId,
        environmentSessionId: freePlay.sessionId,
        io: freePlay.io,
        streamPng: () => game.framePng(1),
        framePng: (anchor) => game.framePng(undefined, anchor),
        framebufferSha256: () => game.framebufferSha256(),
        observationDigest: () => game.framebufferSha256(),
        observeFrames: (observer) => {
          if (observer === null) game.observeFrames(null);
          else game.observeFrames(observer, { pace: true });
        },
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
        ended: () => false,
        extraDroppedFrames: () => 0,
        extraDroppedAudioPackets: () => 0,
        drainAudio: () => [],
        close: () => freePlay.close(),
      },
      ...(resumedFromCheckpointId === undefined ? {} : { resumedFromCheckpointId }),
      resumedContinuity,
      ...(checkpointPort === undefined ? {} : { checkpoints: checkpointPort }),
      captureSight: () => {
        const png = game.framePng(glanceScale);
        if (png === null) return undefined;
        return {
          png: Buffer.from(png),
          width: PLAY_STREAM_WIDTH * glanceScale,
          height: PLAY_STREAM_HEIGHT * glanceScale,
        };
      },
      afterObserve: () => {
        const idleCore = game.coreFactory?.(game.scenario);
        if (idleCore?.idleFrames === undefined) return;
        idleTick = setInterval(() => {
          idleCore.idleFrames?.(IDLE_CHUNK_FRAMES);
        }, IDLE_TICK_MS);
        idleTick.unref();
      },
      onTurnExtra: (turn) => {
        latestTurn = turn;
        if (
          autosaveEvery <= 0 ||
          game.checkpoints === undefined ||
          turn.turn <= 0 ||
          turn.turn % autosaveEvery !== 0
        ) {
          return;
        }
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
      },
      afterPlay: (result) => {
        if (game.checkpoints === undefined) return {};
        try {
          const lastTurn = result.turns.at(-1);
          return {
            checkpointId: writeGbaCheckpoint({
              rootDir: checkpointDir,
              capability: game.checkpoints,
              label: "asked-play",
              position: null,
              continuity:
                lastTurn === undefined ? null : { notes: lastTurn.notes, objective: lastTurn.objective },
              journeyId,
              environmentId: session.environmentId,
              clock,
            }).receipt.checkpointId,
          };
        } catch (error) {
          options.logger.warn(
            { sessionId: session.sessionId, errorName: error instanceof Error ? error.name : "Error" },
            "embodiment checkpoint mint failed",
          );
          return {};
        }
      },
      extraCleanup: () => {
        if (idleTick !== undefined) clearInterval(idleTick);
      },
      ...(options.createVoice === undefined ? {} : { createVoice: options.createVoice }),
      ...(options.createActivitySink === undefined ? {} : { createActivitySink: options.createActivitySink }),
      ...(options.interjections === undefined ? {} : { interjections: options.interjections }),
      ...(options.activityObservations === undefined
        ? {}
        : { activityObservations: options.activityObservations }),
      ...(options.playSight === undefined ? {} : { playSight: options.playSight }),
      ...(options.onTurn === undefined ? {} : { onTurn: options.onTurn }),
      silentVoiceLog: "no play voice seam; this playthrough is silent",
      finishedLog: "embodiment playthrough finished",
    });
  }
}
