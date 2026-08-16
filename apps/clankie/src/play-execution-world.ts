/**
 * Asked play in a hosted world. Same composition as local play above the
 * body: mind, voice, journal, activity frames. What drops out is
 * `bootGbaGame` and `acquireBodyLock`; what drops in is `joinWorld`.
 *
 * The world owns the body and its own single-holder rule. A missing
 * activity producer, voice seam, or journal degrades exactly as local
 * play does (ADR 0063 / 0067 / 0068).
 */
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import {
  createModelFreePlayMind,
  createModelVoice,
  defaultGbaPlayJournalDir,
  InterjectionQueue,
  openFreePlayJournal,
  runFreePlay,
  type ClankieVoice,
  type FreePlayJournal,
  type FreePlayMind,
  type FreePlaySettledTurn,
  type FreePlayTurn,
} from "@clankie/gba-emulator";
import {
  GbaActivityObservationSnapshotSchema,
  RenderedSurfaceOverlaySchema,
} from "@clankie/interactive-environment";
import { resolveConfiguredLanguageModel } from "@clankie/model-provider";
import { createBrokeredPossessorVoiceClient, type PossessorVoiceClient } from "@clankie/possessor-voice";
import { createBrokeredActivityFrameSink } from "@clankie/rendered-surface-client";
import { personaInstructions, SettingsStore } from "@clankie/settings";
import type { ActivityObservationWritePort } from "./activity-observation.ts";
import type { PlayExecution } from "./play-host.ts";
import type { PlaySightProjection } from "./play-sight.ts";
import { joinWorld, type WorldJoinOptions, type WorldJoinResult } from "./world/body.ts";

/** Native screen. Same constant, same reason, as local play-execution. */
const STREAM_SCALE = 1;
const FRAME_WIDTH = 240 * STREAM_SCALE;
const FRAME_HEIGHT = 160 * STREAM_SCALE;
const PLAY_MODEL_REQUEST_TIMEOUT_MS = 180_000;
const ROOM_EVENT_OBJECTIVE_MAX = 120;

interface PlayExecutionLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export interface WorldPlayExecutionOptions {
  logger: PlayExecutionLogger;
  env?: NodeJS.ProcessEnv;
  clock?: () => Date;
  interjections?: InterjectionQueue;
  onTurn?: (turn: FreePlayTurn) => void;
  activityObservations?: ActivityObservationWritePort;
  playSight?: PlaySightProjection;
  createMind?: () => Promise<FreePlayMind>;
  createVoiceAgent?: () => Promise<ClankieVoice | undefined>;
  createVoice?: () => Promise<PossessorVoiceClient | undefined>;
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

    const require = createRequire(import.meta.url);
    const emulatorPackage = path.dirname(require.resolve("@clankie/gba-emulator/package.json"));
    const repoRoot = path.resolve(emulatorPackage, "../..");

    let mind: FreePlayMind;
    let voiceAgent: ClankieVoice | undefined;
    try {
      if (options.createVoiceAgent !== undefined) voiceAgent = await options.createVoiceAgent();
      if (options.createMind !== undefined) {
        mind = await options.createMind();
      } else {
        const configured = await resolveConfiguredLanguageModel({ cwd: repoRoot, env });
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
      await body.close().catch(() => undefined);
      options.logger.warn(
        { sessionId: session.sessionId, errorName: error instanceof Error ? error.name : "Error" },
        "world play mind refused",
      );
      return { kind: "refused", reason: "environment_unavailable" };
    }

    const sink = await createBrokeredActivityFrameSink({
      url: env["CLANKIE_ACTIVITY_PRODUCER_URL"] ?? "ws://127.0.0.1:4322/producer",
    });
    let framesPublished = 0;
    let framesDroppedWithoutSink = 0;
    let sequence = 0;
    let lastFrameDigest: string | null = null;
    const publishFrame = (frame: number): void => {
      const png = body.framePng();
      if (png === null) return;
      if (sink === undefined) {
        framesDroppedWithoutSink += 1;
        return;
      }
      const bytes = Buffer.from(png);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest === lastFrameDigest) return;
      lastFrameDigest = digest;
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
        sha256: digest,
        capturedAt: clock().toISOString(),
      });
    };

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
    const interjections = options.interjections ?? new InterjectionQueue();
    const unsubscribe = voice?.subscribe((utterance) => interjections.offer(utterance));

    let speechFailureLogged = false;
    const reportToRoom = (event: string, deliveryId: string): void => {
      if (event.length === 0 || voice === undefined) return;
      if (!voice.roomListening) return;
      void voice.narrate(event, { deliveryId }).catch((error: unknown) => {
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

    let journal: FreePlayJournal | undefined;
    let journalFailureLogged = false;
    const scenarioId = `world:${session.environmentId}`;
    try {
      journal = openFreePlayJournal({
        rootDir: defaultGbaPlayJournalDir(env),
        runId: session.sessionId,
        environmentSessionId: session.sessionId,
        scenarioId,
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

    const startedAt = clock().getTime();
    try {
      await onRunning();
      options.playSight?.attach({
        sessionId: session.sessionId,
        environmentId: session.environmentId,
        scenarioId,
        startedAt: clock().toISOString(),
        ...(journal === undefined ? {} : { journalPath: journal.path }),
        capture: () => {
          const png = body.framePng();
          if (png === null) return undefined;
          return { png: Buffer.from(png), width: FRAME_WIDTH, height: FRAME_HEIGHT };
        },
      });
      const observer = (): void => publishFrame(sequence);
      body.observeFrames(observer);

      const result = await runFreePlay({
        io: body.io,
        mind,
        turns: session.budget.maxTurns ?? Number.MAX_SAFE_INTEGER,
        audience:
          env["CLANKIE_FREE_PLAY_AUDIENCE"] ??
          (voice === undefined
            ? "people watching the activity surface"
            : "people in the voice channel, watching him play"),
        ...(voiceAgent === undefined ? {} : { voice: voiceAgent }),
        ...(voice === undefined ? {} : { roomAuthors: () => voice.roomListening }),
        framebufferSha256: () => {
          const png = body.framePng();
          return png === null ? null : createHash("sha256").update(png).digest("hex");
        },
        framePng: () => body.framePng(),
        interjections,
        shouldStop: () =>
          control.stopRequested() ||
          (session.budget.maxDurationMs !== undefined &&
            clock().getTime() - startedAt >= session.budget.maxDurationMs),
        onTurn: (turn) => {
          sequence += 1;
          if (sink !== undefined) {
            sink.publishOverlay(
              RenderedSurfaceOverlaySchema.parse({
                schemaVersion: 1,
                surface: "gba_emulator",
                sequence,
                objective: overlayText(turn.objective),
                intent: overlayText(turn.intent),
                monologue: overlayText(turn.monologue),
                effect: overlayText(turn.effect),
                updatedAt: clock().toISOString(),
              }),
            );
          }
          publishFrame(turn.turn);
          const event = roomEvent(turn);
          const speechDeliveryId = event === null ? undefined : randomUUID();
          if (event !== null && speechDeliveryId !== undefined) reportToRoom(event, speechDeliveryId);
          journal?.turn(turn, speechDeliveryId === undefined ? {} : { speechDeliveryId });
          options.onTurn?.(turn);
        },
        onSettledTurn: (event: FreePlaySettledTurn) => {
          const digest = (() => {
            const png = body.framePng();
            return png === null ? "0".repeat(64) : createHash("sha256").update(png).digest("hex");
          })();
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
                  maps: event.progress.maps.slice(-64).map((mapId) => mapId.slice(0, 200)),
                },
                framebufferSha256: digest,
              },
            }),
          );
          options.playSight?.noteProgress({
            maps: event.progress.maps.slice(-16),
            objective: event.turn.objective,
          });
        },
      });

      body.observeFrames(null);
      const outcome = control.stopRequested() ? "stopped" : "budget_exhausted";
      const durationMs = clock().getTime() - startedAt;
      const framesDropped =
        (sink?.droppedFrameCount ?? 0) + framesDroppedWithoutSink + body.droppedFrameCount();
      journal?.summary({ outcome, result, durationMs, framesPublished, framesDropped });
      options.logger.info(
        {
          sessionId: session.sessionId,
          venue: "world",
          outcome,
          turnsTaken: result.turns.length,
          durationMs,
          framesPublished,
          framesDropped,
          ...(journal === undefined ? {} : { journalPath: journal.path }),
        },
        "world playthrough finished",
      );
      return {
        kind: "ran",
        result: { outcome, turnsTaken: result.turns.length, durationMs, framesPublished, framesDropped },
      };
    } finally {
      options.activityObservations?.clear(session.sessionId);
      options.playSight?.detach(session.sessionId);
      sink?.close();
      unsubscribe?.();
      voice?.close();
      await body.close();
    }
  };
}

function overlayText(value: string | null): string | null {
  return value?.trim().slice(0, 256) || null;
}

function roomEvent(turn: FreePlayTurn): string | null {
  if (!turn.speakWanted) return null;
  const effect = turn.effect?.trim();
  if (effect === undefined || effect.length === 0) return null;
  const objective = turn.objective?.trim();
  if (objective === undefined || objective.length === 0) return effect;
  return `${effect} (working toward: ${objective.slice(0, ROOM_EVENT_OBJECTIVE_MAX)})`;
}

function positiveIntegerOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
