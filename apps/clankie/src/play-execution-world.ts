/**
 * Asked play in a hosted world. Same composition as local play above the
 * body: mind, voice, journal, activity frames. What drops out is
 * `bootGbaGame`; what drops in is `joinWorld`.
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
  latestPlayJourneyContinuity,
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
  RenderedSurfaceAudioSchema,
  RenderedSurfaceOverlaySchema,
} from "@clankie/interactive-environment";
import { resolveConfiguredLanguageModel } from "@clankie/model-provider";
import { createBrokeredPlayVoiceClient, type PlayVoiceClient } from "@clankie/play-voice";
import { createBrokeredActivityFrameSink, type ActivityFrameSink } from "@clankie/rendered-surface-client";
import { personaInstructions, SettingsStore } from "@clankie/settings";
import type { ActivityObservationWritePort } from "./activity-observation.ts";
import type { PlayExecution } from "./play-host.ts";
import type { PlaySightProjection } from "./play-sight.ts";
import { joinWorld, type WorldJoinOptions, type WorldJoinResult } from "./world/body.ts";
import type { HostedWorldSession } from "./world/session.ts";

/** Native screen. Same constant, same reason, as local play-execution. */
const STREAM_SCALE = 1;
const FRAME_WIDTH = 240 * STREAM_SCALE;
const FRAME_HEIGHT = 160 * STREAM_SCALE;
const PLAY_MODEL_REQUEST_TIMEOUT_MS = 180_000;

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
    let audioSequence = 0;
    let audioPacketsPublished = 0;
    let audioPacketsDroppedWithoutSink = 0;
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
    const publishAudio = (): void => {
      for (const packet of body.drainAudio()) {
        if (sink === undefined) {
          audioPacketsDroppedWithoutSink += 1;
          continue;
        }
        audioSequence += 1;
        audioPacketsPublished += 1;
        sink.publishAudio(
          RenderedSurfaceAudioSchema.parse({
            schemaVersion: 1,
            surface: "gba_emulator",
            sequence: audioSequence,
            frame: packet.frame,
            encoding: packet.encoding,
            sampleRate: packet.sampleRate,
            channels: packet.channels,
            frames: packet.frames,
            data: Buffer.from(packet.data).toString("base64"),
            byteLength: packet.data.byteLength,
            capturedAt: packet.capturedAt,
          }),
        );
      }
    };

    // The joined seat and activity sink already exist here. Keep their cleanup
    // in scope before broker/client creation can fail.
    let voice: PlayVoiceClient | undefined;
    const interjections = options.interjections ?? new InterjectionQueue();
    let unsubscribe: (() => void) | undefined;
    try {
      voice =
        options.createVoice === undefined
          ? await createBrokeredPlayVoiceClient()
          : await options.createVoice();
      if (voice === undefined) {
        options.logger.info(
          { sessionId: session.sessionId },
          "no play voice seam; this playthrough has no spoken narration",
        );
      }
      unsubscribe = voice?.subscribe((utterance) => interjections.offer(utterance));
    } catch (error) {
      unsubscribe?.();
      voice?.close();
      body.observeFrames(null);
      sink?.close();
      await body.close().catch(() => undefined);
      throw error;
    }

    let speechFailureLogged = false;
    const reportToRoom = (
      event: string,
      narration: { readonly deliveryId?: string; readonly respond: boolean },
    ): void => {
      if (event.length === 0 || voice === undefined) return;
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

    let journal: FreePlayJournal | undefined;
    let journalFailureLogged = false;
    const scenarioId = `world:${session.environmentId}`;
    try {
      journal = openFreePlayJournal({
        rootDir: journalDir,
        runId: session.sessionId,
        journeyId: body.journeyId,
        environmentId: session.environmentId,
        venue: "world",
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
      options.hostedWorld?.attach(body);
      options.playSight?.attach({
        sessionId: session.sessionId,
        journeyId: body.journeyId,
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
      const observer = (): void => {
        publishAudio();
        publishFrame(frameSequence);
      };
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
        ...(resumedContinuity === null
          ? {}
          : {
              initialNotes: resumedContinuity.notes,
              initialObjective: resumedContinuity.objective,
            }),
        framebufferSha256: () => {
          const png = body.framePng();
          return png === null ? null : createHash("sha256").update(png).digest("hex");
        },
        framePng: () => body.framePng(),
        provenance: () => body.traceProvenance(),
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
            framePng: () => body.framePng(),
            ...(speechDeliveryId === undefined || event === null
              ? {}
              : { speechDeliveryId, narrationEvent: event }),
          });
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
      const audioPacketsDropped =
        (sink?.droppedAudioPacketCount ?? 0) +
        audioPacketsDroppedWithoutSink +
        body.droppedAudioPacketCount();
      journal?.summary({
        outcome,
        result,
        durationMs,
        framesPublished,
        framesDropped,
        framePng: () => body.framePng(),
      });
      options.logger.info(
        {
          sessionId: session.sessionId,
          venue: "world",
          outcome,
          turnsTaken: result.turns.length,
          durationMs,
          framesPublished,
          framesDropped,
          audioPacketsPublished,
          audioPacketsDropped,
          accepted: result.accepted,
          distinctTiles: result.progress.distinctTiles,
          maps: result.progress.maps,
          turnsSinceNewTile: result.progress.turnsSinceNewTile,
          coherence: result.coherence,
          longestUnchangedRun: result.longestUnchangedRun,
          longestRecurringRun: result.longestRecurringRun,
          objectivesRetired: result.objectivesRetired,
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
      options.hostedWorld?.detach(body);
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

/** Continuous experience; `speakWanted` separately decides whether the room answers aloud. */
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
