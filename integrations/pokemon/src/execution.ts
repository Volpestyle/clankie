/**
 * The play-execution composition: journal, activity frames, voice, and the
 * free-play loop, over whatever body the caller joined. Joining and leaving
 * the world stay in the caller; this owns the playthrough itself.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  defaultGbaPlayJournalDir,
  InterjectionQueue,
  openFreePlayJournal,
  runFreePlay,
  type ClankieVoice,
  type FreePlayJournal,
  type FreePlayMind,
  type FreePlayNotable,
  type FreePlayProvenance,
  type FreePlayTurn,
  type GbaDriverIo,
  type PlayJourneyId,
} from "@clankie/play";
import {
  GbaActivityObservationSnapshotSchema,
  RenderedSurfaceAudioSchema,
  RenderedSurfaceOverlaySchema,
} from "@clankie/interactive-environment";
import type { PlayVoiceClient } from "@clankie/play-voice";
import { DEFAULT_POKEMON_PLAY_MAX_TOKENS, type EmbodimentSession } from "@clankie/protocol";
import type { ActivityFrameSink } from "@clankie/rendered-surface-client";
import { roomEvent } from "@clankie/game-extension";
import type {
  ActivityObservationWritePort,
  PokemonPlayExecution as PlayExecution,
  PokemonSightPort,
} from "./ports.ts";

/** Native GBA screen. The activity canvas is CSS-sized and pixelated. */
export const PLAY_STREAM_WIDTH = 240;
export const PLAY_STREAM_HEIGHT = 160;

export interface PlayExecutionLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

interface PlaySurfaceAudioPacket {
  readonly frame: number;
  readonly encoding: "pcm_s16le";
  readonly sampleRate: number;
  readonly channels: number;
  readonly frames: number;
  readonly data: Uint8Array;
  readonly capturedAt: string;
}

/** The body the loop drives: Clankie's seat in a hosted world. */
interface PlaySurface {
  readonly venue: "world";
  readonly journeyId: PlayJourneyId;
  readonly scenarioId: string;
  readonly environmentSessionId: string;
  readonly io: GbaDriverIo;
  streamPng(): Uint8Array | null;
  framePng(anchor?: { readonly playerX: number; readonly playerY: number }): Uint8Array | null;
  framebufferSha256(): string | null;
  /** Digest published on the activity observation card; may differ from framebufferSha256. */
  observationDigest(): string | null;
  observeFrames(observer: (() => void) | null): void;
  provenance(): FreePlayProvenance | null;
  ended(): boolean;
  extraDroppedFrames(): number;
  extraDroppedAudioPackets(): number;
  drainAudio(): readonly PlaySurfaceAudioPacket[];
  close(): Promise<void>;
}

export function overlayText(value: string | null): string | null {
  return value?.trim().slice(0, 256) || null;
}

export interface EmbodiedPlayInput {
  session: EmbodimentSession;
  control: Parameters<PlayExecution>[1];
  onRunning: Parameters<PlayExecution>[2];
  logger: PlayExecutionLogger;
  env: NodeJS.ProcessEnv;
  clock: () => Date;
  mind: FreePlayMind;
  voiceAgent?: ClankieVoice;
  surface: PlaySurface;
  resumedContinuity: { notes: string | null; objective: string | null } | null;
  captureSight: () => { png: Buffer; width: number; height: number } | undefined;
  /** After `onRunning`, before play-sight attach (hosted-world operations). */
  attach?: () => void;
  extraCleanup?: () => void;
  createVoice?: () => Promise<PlayVoiceClient | undefined>;
  createActivitySink?: () => Promise<ActivityFrameSink | undefined>;
  interjections?: InterjectionQueue;
  activityObservations?: ActivityObservationWritePort;
  playSight?: PokemonSightPort;
  onTurn?: (turn: FreePlayTurn) => void;
  onNotable?: (event: FreePlayNotable) => Promise<void>;
  silentVoiceLog: string;
  finishedLog: string;
}

export async function runEmbodiedPlay(input: EmbodiedPlayInput): ReturnType<PlayExecution> {
  const { session, control, onRunning, logger, env, clock, mind, surface, resumedContinuity } = input;
  const sink = await input.createActivitySink?.();
  let framesPublished = 0;
  let framesDroppedWithoutSink = 0;
  let frameSequence = 0;
  let overlaySequence = 0;
  let audioSequence = 0;
  let audioPacketsPublished = 0;
  let audioPacketsDroppedWithoutSink = 0;
  let lastFrameDigest: string | null = null;
  const publishFrame = (frame: number): void => {
    const png = surface.streamPng();
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
      width: PLAY_STREAM_WIDTH,
      height: PLAY_STREAM_HEIGHT,
      encoding: "png",
      data: bytes.toString("base64"),
      byteLength: bytes.byteLength,
      sha256: digest,
      capturedAt: clock().toISOString(),
    });
  };
  const publishAudio = (): void => {
    for (const packet of surface.drainAudio()) {
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

  let voice: PlayVoiceClient | undefined;
  let unsubscribe: (() => void) | undefined;
  const interjections = input.interjections ?? new InterjectionQueue(32);
  try {
    voice = await input.createVoice?.();
    if (voice === undefined) {
      logger.info({ sessionId: session.sessionId }, input.silentVoiceLog);
    }
    unsubscribe = voice?.subscribe((utterance) => interjections.offer(utterance));
  } catch (error) {
    unsubscribe?.();
    voice?.close();
    surface.observeFrames(null);
    sink?.close();
    await surface.close().catch(() => undefined);
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
      logger.info(
        {
          sessionId: session.sessionId,
          errorMessage: error instanceof Error ? error.message : "unknown",
        },
        "embodiment speech unavailable; play continues in silence",
      );
    });
  };

  // Notifications are information only. Once admitted, delivery never blocks the motor.
  // The loop emits each kind once per session; this chain preserves terminal ordering.
  let notifications = Promise.resolve();
  const notify = (event: FreePlayNotable): void => {
    notifications = notifications
      .then(() => input.onNotable?.(event))
      .catch(() => {
        logger.warn(
          { sessionId: session.sessionId, kind: event.kind },
          "Pokémon play information delivery unavailable",
        );
      });
  };
  let journal: FreePlayJournal | undefined;
  let journalFailureLogged = false;
  try {
    journal = openFreePlayJournal({
      rootDir: defaultGbaPlayJournalDir(env),
      runId: session.sessionId,
      journeyId: surface.journeyId,
      environmentId: session.environmentId,
      venue: surface.venue,
      environmentSessionId: surface.environmentSessionId,
      scenarioId: surface.scenarioId,
      clock,
      onError: (error) => {
        if (journalFailureLogged) return;
        journalFailureLogged = true;
        logger.warn(
          {
            sessionId: session.sessionId,
            errorName: error instanceof Error ? error.name : "Error",
          },
          "play journal append failed; playthrough continues unrecorded",
        );
      },
    });
  } catch (error) {
    logger.warn(
      { sessionId: session.sessionId, errorName: error instanceof Error ? error.name : "Error" },
      "play journal unavailable; this playthrough is unrecorded",
    );
  }

  const startedAt = clock().getTime();
  try {
    await onRunning();
    input.attach?.();
    input.playSight?.attach({
      sessionId: session.sessionId,
      journeyId: surface.journeyId,
      environmentId: session.environmentId,
      scenarioId: surface.scenarioId,
      startedAt: clock().toISOString(),
      ...(journal === undefined ? {} : { journalPath: journal.path }),
      capture: input.captureSight,
    });
    const observer = (): void => {
      publishAudio();
      publishFrame(frameSequence);
    };
    surface.observeFrames(observer);

    const result = await runFreePlay({
      io: surface.io,
      budget: { maxTokens: DEFAULT_POKEMON_PLAY_MAX_TOKENS, ...session.budget },
      onNotable: notify,
      mind,
      turns: session.budget.maxTurns ?? Number.MAX_SAFE_INTEGER,
      audience:
        env["CLANKIE_FREE_PLAY_AUDIENCE"] ??
        (voice === undefined
          ? "people watching the activity surface"
          : "people in the voice channel, watching him play"),
      ...(input.voiceAgent === undefined ? {} : { voice: input.voiceAgent }),
      ...(voice === undefined ? {} : { roomAuthors: () => voice.roomListening }),
      ...(resumedContinuity === null
        ? {}
        : {
            initialNotes: resumedContinuity.notes,
            initialObjective: resumedContinuity.objective,
          }),
      framebufferSha256: () => surface.framebufferSha256(),
      framePng: (anchor) => surface.framePng(anchor),
      provenance: () => surface.provenance(),
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
        surface.ended() ||
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
          framePng: () => surface.streamPng(),
          ...(speechDeliveryId === undefined || event === null
            ? {}
            : { speechDeliveryId, narrationEvent: event }),
        });
        input.onTurn?.(turn);
      },
      onSettledTurn: (event) => {
        input.activityObservations?.publish(
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
              framebufferSha256: surface.observationDigest(),
            },
          }),
        );
        input.playSight?.noteProgress({
          maps: event.progress.maps.slice(-16),
          objective: event.turn.objective,
        });
      },
    });

    surface.observeFrames(null);
    const outcome = control.stopRequested()
      ? "stopped"
      : surface.ended()
        ? "world_ended"
        : (result.outcome ?? "budget_exhausted");
    if (surface.ended()) notify({ kind: "world_ended", turn: result.turns.length, count: 1 });
    // Give the existing conversation queue bounded time to admit the last information.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      notifications.finally(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    const durationMs = clock().getTime() - startedAt;
    const framesDropped =
      (sink?.droppedFrameCount ?? 0) + framesDroppedWithoutSink + surface.extraDroppedFrames();
    const audioPacketsDropped =
      (sink?.droppedAudioPacketCount ?? 0) +
      audioPacketsDroppedWithoutSink +
      surface.extraDroppedAudioPackets();
    journal?.summary({
      outcome,
      result,
      durationMs,
      framesPublished,
      framesDropped,
      framePng: () => surface.streamPng(),
    });
    logger.info(
      {
        sessionId: session.sessionId,
        outcome,
        turnsTaken: result.turns.length,
        accepted: result.accepted,
        durationMs,
        distinctTiles: result.progress.distinctTiles,
        maps: result.progress.maps,
        turnsSinceNewTile: result.progress.turnsSinceNewTile,
        coherence: result.coherence,
        longestUnchangedRun: result.longestUnchangedRun,
        longestRecurringRun: result.longestRecurringRun,
        objectivesRetired: result.objectivesRetired,
        venue: surface.venue,
        framesPublished,
        framesDropped,
        audioPacketsPublished,
        audioPacketsDropped,
        volitionTaken: result.volition.taken,
        volitionOffered: result.volition.offered,
        ...(journal === undefined ? {} : { journalPath: journal.path }),
      },
      input.finishedLog,
    );
    return {
      kind: "ran",
      result: {
        outcome,
        turnsTaken: result.turns.length,
        durationMs,
        framesPublished,
        framesDropped,
      },
    };
  } finally {
    input.extraCleanup?.();
    input.activityObservations?.clear(session.sessionId);
    input.playSight?.detach(session.sessionId);
    sink?.close();
    unsubscribe?.();
    voice?.close();
    await surface.close();
  }
}
