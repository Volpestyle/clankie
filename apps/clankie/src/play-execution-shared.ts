/**
 * Shared play-execution composition used by local GBA play and hosted-world
 * play. Venue-specific boot, checkpoints, idle ticks, and PCM stay in the
 * callers; this owns the loop both already run.
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
  type FreePlayCheckpointPort,
  type FreePlayJournal,
  type FreePlayMind,
  type FreePlayProvenance,
  type FreePlayTurn,
  type GbaDriverIo,
  type PlayJourneyId,
} from "@clankie/gba-emulator";
import {
  GbaActivityObservationSnapshotSchema,
  RenderedSurfaceAudioSchema,
  RenderedSurfaceOverlaySchema,
} from "@clankie/interactive-environment";
import { resolveConfiguredLanguageModel } from "@clankie/model-provider";
import { createBrokeredPlayVoiceClient, type PlayVoiceClient } from "@clankie/play-voice";
import type { EmbodimentSession } from "@clankie/protocol";
import { createBrokeredActivityFrameSink, type ActivityFrameSink } from "@clankie/rendered-surface-client";
import { personaInstructions, SettingsStore } from "@clankie/settings";
import type { ActivityObservationWritePort } from "./activity-observation.ts";
import type { PlayExecution } from "./play-host.ts";
import type { PlaySightProjection } from "./play-sight.ts";

/**
 * How long one decision may take before the turn is abandoned.
 *
 * The deadline exists to stop a wedged request hanging the playthrough, not to
 * keep turns snappy. Too tight a bound converts a late answer into no answer,
 * and the journal records `mind_failed` instead of a move. 60s was that, once
 * his vision model slowed down: measured 2026-08-15, a trivial "describe this
 * screen in ten words" call to grok-4.6 took 20-25s, and a full decision ran
 * past the minute and lost three turns in a row.
 */
const PLAY_MODEL_REQUEST_TIMEOUT_MS = 180_000;

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

/**
 * The body the shared loop drives. Local play wraps the emulator session;
 * hosted play wraps the world seat. The loop never learns which.
 */
interface PlaySurface {
  readonly venue: "local" | "world";
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

export function resolvePlayRuntimeRoots(repoRoot: string | undefined): {
  emulatorPackage: string;
  repoRoot: string;
} {
  const require = createRequire(import.meta.url);
  const emulatorPackage =
    repoRoot === undefined
      ? path.dirname(require.resolve("@clankie/gba-emulator/package.json"))
      : path.join(repoRoot, "integrations", "gba-emulator");
  return { emulatorPackage, repoRoot: repoRoot ?? path.resolve(emulatorPackage, "../..") };
}

export async function resolvePlayMind(options: {
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  createMind?: () => Promise<FreePlayMind>;
  createVoiceAgent?: () => Promise<ClankieVoice | undefined>;
}): Promise<{ mind: FreePlayMind; voiceAgent: ClankieVoice | undefined }> {
  let voiceAgent: ClankieVoice | undefined;
  if (options.createVoiceAgent !== undefined) voiceAgent = await options.createVoiceAgent();
  if (options.createMind !== undefined) {
    return { mind: await options.createMind(), voiceAgent };
  }
  const configured = await resolveConfiguredLanguageModel({ cwd: options.repoRoot, env: options.env });
  // One character across every surface (ADR 0051): the Clankie an audience
  // watches play is the one they talk to, in his `gameplay` register — not a
  // second character defined by this file's prompt.
  const character = personaInstructions((await new SettingsStore().load()).persona, "gameplay");
  const providerOptions = configured.modelOptions?.providerOptions ?? {};
  const requestTimeoutMs = positiveIntegerOr(
    options.env["CLANKIE_PLAY_MODEL_REQUEST_TIMEOUT_MS"],
    PLAY_MODEL_REQUEST_TIMEOUT_MS,
  );
  return {
    mind: createModelFreePlayMind({
      model: configured.model,
      character,
      providerOptions,
      requestTimeoutMs,
    }),
    voiceAgent: createModelVoice({
      model: configured.model,
      character,
      providerOptions,
      requestTimeoutMs,
    }),
  };
}

export function overlayText(value: string | null): string | null {
  return value?.trim().slice(0, 256) || null;
}

/**
 * A bounded first-person continuity update for the room persona. It crosses
 * every settled turn; `speakWanted` separately decides whether that update may
 * ask for audio. The field slices keep the exact offered event inside the
 * journal's 512-character evidence bound.
 */
export function roomEvent(
  turn: Pick<FreePlayTurn, "turn" | "monologue" | "effect" | "objective" | "intent">,
): string | null {
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
  resumedFromCheckpointId?: string;
  resumedContinuity: { notes: string | null; objective: string | null } | null;
  checkpoints?: FreePlayCheckpointPort;
  captureSight: () => { png: Buffer; width: number; height: number } | undefined;
  /** After `onRunning`, before play-sight attach (hosted-world operations). */
  attach?: () => void;
  /** After frame observation is wired (local idle ticks). */
  afterObserve?: () => void;
  /** Per-turn venue work (local autosave). */
  onTurnExtra?: (turn: FreePlayTurn) => void;
  afterPlay?: (result: Awaited<ReturnType<typeof runFreePlay>>) => { checkpointId?: string };
  extraCleanup?: () => void;
  createVoice?: () => Promise<PlayVoiceClient | undefined>;
  createActivitySink?: () => Promise<ActivityFrameSink | undefined>;
  interjections?: InterjectionQueue;
  activityObservations?: ActivityObservationWritePort;
  playSight?: PlaySightProjection;
  onTurn?: (turn: FreePlayTurn) => void;
  silentVoiceLog: string;
  finishedLog: string;
}

export async function runEmbodiedPlay(input: EmbodiedPlayInput): ReturnType<PlayExecution> {
  const { session, control, onRunning, logger, env, clock, mind, surface, resumedContinuity } = input;
  const resumedFromCheckpointId = input.resumedFromCheckpointId;
  const sink =
    input.createActivitySink === undefined
      ? await createBrokeredActivityFrameSink({
          url: env["CLANKIE_ACTIVITY_PRODUCER_URL"] ?? "ws://127.0.0.1:4322/producer",
        })
      : await input.createActivitySink();
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
  const interjections = input.interjections ?? new InterjectionQueue();
  try {
    voice =
      input.createVoice === undefined ? await createBrokeredPlayVoiceClient() : await input.createVoice();
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
      ...(resumedFromCheckpointId === undefined ? {} : { resumedFromCheckpointId }),
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
    await onRunning(resumedFromCheckpointId);
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
    input.afterObserve?.();

    const result = await runFreePlay({
      io: surface.io,
      mind,
      turns: session.budget.maxTurns ?? Number.MAX_SAFE_INTEGER,
      audience:
        env["CLANKIE_FREE_PLAY_AUDIENCE"] ??
        (voice === undefined
          ? "people watching the activity surface"
          : "people in the voice channel, watching him play"),
      ...(input.voiceAgent === undefined ? {} : { voice: input.voiceAgent }),
      ...(voice === undefined ? {} : { roomAuthors: () => voice.roomListening }),
      ...(input.checkpoints === undefined ? {} : { checkpoints: input.checkpoints }),
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
        input.onTurnExtra?.(turn);
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
    const checkpointId = input.afterPlay?.(result)?.checkpointId;
    const outcome = control.stopRequested() || surface.ended() ? "stopped" : "budget_exhausted";
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
      ...(checkpointId === undefined ? {} : { checkpointId }),
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
        ...(surface.venue === "world"
          ? {
              venue: "world",
              framesPublished,
              framesDropped,
              audioPacketsPublished,
              audioPacketsDropped,
            }
          : {
              volitionTaken: result.volition.taken,
              volitionOffered: result.volition.offered,
            }),
        ...(checkpointId === undefined ? {} : { checkpointId }),
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
        ...(checkpointId === undefined ? {} : { checkpointId }),
        ...(resumedFromCheckpointId === undefined ? {} : { resumedFromCheckpointId }),
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

function positiveIntegerOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
