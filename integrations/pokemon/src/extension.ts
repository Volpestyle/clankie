/**
 * Asked play in a hosted world. Same composition as local play above the
 * body: mind, voice, journal, activity frames. What drops out is
 * `bootGbaGame`; what drops in is `joinWorld`.
 *
 * The world owns the body and its own single-holder rule. A missing
 * activity producer, voice seam, or journal degrades exactly as local
 * play does (ADR 0063 / 0067 / 0068).
 */
import { createHash } from "node:crypto";
import {
  defaultGbaPlayJournalDir,
  InterjectionQueue,
  latestPlayJourneyContinuity,
  type ClankieVoice,
  type FreePlayMind,
  type FreePlayNotable,
  type FreePlayTurn,
} from "@clankie/play";
import type { PlayVoiceClient } from "@clankie/play-voice";
import { GameplaySettingsSchema, type GameplaySettings } from "@clankie/settings";
import { createGameExtensionRuntime, type GameExtension } from "@clankie/game-extension";
import type { EmbodimentSession } from "@clankie/protocol";
import type { ActivityFrameSink } from "@clankie/rendered-surface-client";
import type {
  ActivityObservationWritePort,
  PokemonPlayExecution as PlayExecution,
  PokemonPlayResult,
  PokemonSightPort,
} from "./ports.ts";
import {
  PLAY_STREAM_HEIGHT,
  PLAY_STREAM_WIDTH,
  runEmbodiedPlay,
  type PlayExecutionLogger,
} from "./execution.ts";
import { joinWorld, type WorldJoinOptions, type WorldJoinResult } from "./world/body.ts";
import type { HostedWorldSession } from "./world/session.ts";
import type { WorldPlayerPersistedSession } from "@pokeagents/world-protocol/ipc";

export interface PokemonExtensionHost {
  logger: PlayExecutionLogger;
  /** Owner-enabled play venue; omitted by tests and dev callers to enable it. */
  gameplay?: GameplaySettings;
  env?: NodeJS.ProcessEnv;
  clock?: () => Date;
  interjections?: InterjectionQueue;
  onTurn?: (turn: FreePlayTurn) => void;
  onNotable?: (event: FreePlayNotable, sessionId: string) => Promise<void>;
  activityObservations?: ActivityObservationWritePort;
  playSight?: PokemonSightPort;
  /** Live hosted-world operations for the captain while this body is playing. */
  hostedWorld?: HostedWorldSession;
  resolveMind: () => Promise<{ mind: FreePlayMind; voiceAgent: ClankieVoice | undefined }>;
  createVoice?: () => Promise<PlayVoiceClient | undefined>;
  createActivitySink?: () => Promise<ActivityFrameSink | undefined>;
  joinWorld?: (options: WorldJoinOptions) => Promise<WorldJoinResult>;
  rememberWorldSession?: (
    sessionId: string,
    target: string,
    state: WorldPlayerPersistedSession | undefined,
  ) => void;
}

function createPokemonExecution(options: PokemonExtensionHost): PlayExecution {
  const env = options.env ?? process.env;
  const clock = options.clock ?? (() => new Date());
  const join = options.joinWorld ?? joinWorld;

  return async (session, control, onRunning) => {
    if (options.gameplay?.pokeagentMmoEnabled === false) {
      control.confirmStopped?.();
      return { kind: "refused", reason: "environment_unavailable" };
    }
    let joined: WorldJoinResult;
    try {
      joined = await join({
        environmentId: session.environmentId,
        env,
        ...(control.guard === undefined ? {} : { guard: control.guard }),
        ...(control.confirmStopped === undefined ? {} : { onStopped: control.confirmStopped }),
        ...(options.rememberWorldSession === undefined
          ? {}
          : {
              rememberSession: (target, state) =>
                options.rememberWorldSession!(session.sessionId, target, state),
            }),
        onAudioUnavailable: (reason) =>
          options.logger.info(
            { sessionId: session.sessionId, reason },
            "world audio unavailable; configure the host watch listener for activity sound",
          ),
      });
    } catch (error) {
      options.logger.warn(
        {
          sessionId: session.sessionId,
          errorName: error instanceof Error ? error.name : "Error",
          errorMessage: error instanceof Error ? error.message : "unknown",
        },
        "world join failed",
      );
      return { kind: "refused", reason: "world_unreachable" };
    }
    if (joined.outcome === "refused") {
      options.logger.info({ sessionId: session.sessionId, reason: joined.reason }, "world join refused");
      return { kind: "refused", reason: joined.reason };
    }
    const body = joined.body;
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> =>
      (closePromise ??= body.close().then(() => {
        control.confirmStopped?.();
      }));
    const journalDir = defaultGbaPlayJournalDir(env);
    const resumedContinuity = latestPlayJourneyContinuity(journalDir, body.journeyId);

    let mind: FreePlayMind;
    let voiceAgent: ClankieVoice | undefined;
    try {
      ({ mind, voiceAgent } = await options.resolveMind());
    } catch (error) {
      try {
        await close();
      } catch {
        /* Failed departure retains the body lease. */
      }
      options.logger.warn(
        { sessionId: session.sessionId, errorName: error instanceof Error ? error.name : "Error" },
        "world play mind refused",
      );
      return { kind: "refused", reason: "environment_unavailable" };
    }

    const scenarioId = `world:${session.environmentId}`;
    const frameDigest = (): string | null => {
      const png = body.framePng();
      return png === null ? null : createHash("sha256").update(png).digest("hex");
    };

    try {
      const interjections = options.interjections ?? new InterjectionQueue(32);
      return await runEmbodiedPlay({
        session: { ...session, budget: { ...options.gameplay?.pokemonBudget, ...session.budget } },
        control,
        onRunning,
        logger: options.logger,
        env,
        clock,
        mind,
        ...(voiceAgent === undefined ? {} : { voiceAgent }),
        surface: {
          venue: "world",
          journeyId: body.journeyId,
          scenarioId,
          environmentSessionId: session.sessionId,
          io: {
            ...body.io,
            act: async (action) => {
              await control.guard?.();
              return body.io.act(action);
            },
          },
          streamPng: () => body.framePng(),
          framePng: () => body.framePng(),
          framebufferSha256: frameDigest,
          observationDigest: () => frameDigest() ?? "0".repeat(64),
          observeFrames: (observer) => body.observeFrames(observer),
          provenance: () => body.traceProvenance(),
          ended: () => body.ended(),
          extraDroppedFrames: () => body.droppedFrameCount(),
          extraDroppedAudioPackets: () => body.droppedAudioPacketCount(),
          drainAudio: () => body.drainAudio(),
          close,
        },
        resumedContinuity,
        captureSight: () => {
          const png = body.framePng();
          if (png === null) return undefined;
          return { png: Buffer.from(png), width: PLAY_STREAM_WIDTH, height: PLAY_STREAM_HEIGHT };
        },
        attach: () => options.hostedWorld?.attach(body, interjections),
        extraCleanup: () => options.hostedWorld?.detach(body),
        ...(options.createVoice === undefined ? {} : { createVoice: options.createVoice }),
        ...(options.createActivitySink === undefined
          ? {}
          : { createActivitySink: options.createActivitySink }),
        interjections,
        ...(options.activityObservations === undefined
          ? {}
          : { activityObservations: options.activityObservations }),
        ...(options.playSight === undefined ? {} : { playSight: options.playSight }),
        ...(options.onTurn === undefined ? {} : { onTurn: options.onTurn }),
        ...(options.onNotable === undefined
          ? {}
          : { onNotable: (event) => options.onNotable!(event, session.sessionId) }),
        silentVoiceLog: "no play voice seam; this playthrough has no spoken narration",
        finishedLog: "world playthrough finished",
      });
    } finally {
      await close();
    }
  };
}

/** The native PokeAgents connector supplies a lifecycle, not a new lease authority. */
export const pokemonExtension: GameExtension<
  EmbodimentSession,
  PokemonPlayResult,
  GameplaySettings,
  PokemonExtensionHost
> = {
  contractVersion: 1,
  id: "pokemon",
  connector: { kind: "native", package: "@pokeagents/world-protocol" },
  skill: { name: "pokeagents", path: ".agents/skills/pokeagents/SKILL.md" },
  settings: { key: "gameplay", schema: GameplaySettingsSchema },
  activity: { surface: "gba_emulator" },
  create(host) {
    const gameplay = host.gameplay === undefined ? undefined : GameplaySettingsSchema.parse(host.gameplay);
    return createGameExtensionRuntime(
      createPokemonExecution({ ...host, ...(gameplay === undefined ? {} : { gameplay }) }),
    );
  },
};
