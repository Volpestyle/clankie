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
  type FreePlayTurn,
} from "@clankie/gba-emulator";
import type { PlayVoiceClient } from "@clankie/play-voice";
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
import { joinWorld, type WorldJoinOptions, type WorldJoinResult } from "./world/body.ts";
import type { HostedWorldSession } from "./world/session.ts";

export interface WorldPlayExecutionOptions {
  logger: PlayExecutionLogger;
  /** Runtime root: the source checkout in development, the release directory when installed. */
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  clock?: () => Date;
  interjections?: InterjectionQueue;
  onTurn?: (turn: FreePlayTurn) => void;
  activityObservations?: ActivityObservationWritePort;
  playSight?: PlaySightProjection;
  /** Live hosted-world operations for the captain while this body is playing. */
  hostedWorld?: HostedWorldSession;
  createMind?: () => Promise<FreePlayMind>;
  createVoiceAgent?: () => Promise<ClankieVoice | undefined>;
  createVoice?: () => Promise<PlayVoiceClient | undefined>;
  createActivitySink?: () => Promise<ActivityFrameSink | undefined>;
  joinWorld?: (options: WorldJoinOptions) => Promise<WorldJoinResult>;
}

export function createWorldPlayExecution(options: WorldPlayExecutionOptions): PlayExecution {
  const env = options.env ?? process.env;
  const clock = options.clock ?? (() => new Date());
  const join = options.joinWorld ?? joinWorld;

  return async (session, control, onRunning) => {
    let joined: WorldJoinResult;
    try {
      joined = await join({
        environmentId: session.environmentId,
        env,
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
    const journalDir = defaultGbaPlayJournalDir(env);
    const resumedContinuity = latestPlayJourneyContinuity(journalDir, body.journeyId);
    const { repoRoot } = resolvePlayRuntimeRoots(options.repoRoot);

    let mind: FreePlayMind;
    let voiceAgent: ClankieVoice | undefined;
    try {
      ({ mind, voiceAgent } = await resolvePlayMind({
        env,
        repoRoot,
        ...(options.createMind === undefined ? {} : { createMind: options.createMind }),
        ...(options.createVoiceAgent === undefined ? {} : { createVoiceAgent: options.createVoiceAgent }),
      }));
    } catch (error) {
      await body.close().catch(() => undefined);
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
        venue: "world",
        journeyId: body.journeyId,
        scenarioId,
        environmentSessionId: session.sessionId,
        io: body.io,
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
        close: () => body.close().catch(() => undefined),
      },
      resumedContinuity,
      captureSight: () => {
        const png = body.framePng();
        if (png === null) return undefined;
        return { png: Buffer.from(png), width: PLAY_STREAM_WIDTH, height: PLAY_STREAM_HEIGHT };
      },
      attach: () => options.hostedWorld?.attach(body),
      extraCleanup: () => options.hostedWorld?.detach(body),
      ...(options.createVoice === undefined ? {} : { createVoice: options.createVoice }),
      ...(options.createActivitySink === undefined ? {} : { createActivitySink: options.createActivitySink }),
      ...(options.interjections === undefined ? {} : { interjections: options.interjections }),
      ...(options.activityObservations === undefined
        ? {}
        : { activityObservations: options.activityObservations }),
      ...(options.playSight === undefined ? {} : { playSight: options.playSight }),
      ...(options.onTurn === undefined ? {} : { onTurn: options.onTurn }),
      silentVoiceLog: "no play voice seam; this playthrough has no spoken narration",
      finishedLog: "world playthrough finished",
    });
  };
}
