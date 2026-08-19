/**
 * The world as a body (VUH-970).
 *
 * `runFreePlay` drives exactly one seam — `GbaDriverIo` — and everything above
 * it (the model mind, the voice, interjections, the journal, progress) never
 * learns where the body is. So playing in a hosted pokeagent-mmo world is not a
 * second play loop: it is a second implementation of that seam, plus a frame
 * source, composed by the same execution the local body already uses.
 *
 * The shape here deliberately mirrors `BootedGbaGame` — `framePng()` plus
 * `observeFrames(observer)` — because the activity publish path in
 * `play-execution.ts` is proven (digest dedupe so an idle screen costs no
 * bandwidth, dropped frames counted rather than swallowed) and porting it
 * verbatim is worth more than a tidier signature.
 *
 * What is genuinely different, and must not be papered over:
 *
 * - **There is no pause.** One player cannot stop a shared world. `pause()`
 *   stops *him* acting; the world keeps running and other players keep moving.
 * - **The screen can change with no action of his.** Another player walks past,
 *   an NPC moves. A local body only advances when driven.
 * - **A body can be replaced under him** (a region crossing, an operator
 *   takeover). `bodyGeneration` is how that is detected; everything cached
 *   about the screen is stale when it moves.
 */
import { createHash, randomUUID } from "node:crypto";
import { resolveWorldCredential, WorldCredentialError } from "@clankie/credential-broker";
import { EnvironmentAdapterActionError } from "@clankie/environment-runtime";
import {
  FREE_PLAY_HARD_FAILURE_LIMIT,
  worldPlayJourneyId,
  type FreePlayProvenance,
  type GbaDriverIo,
  type PlayJourneyId,
} from "@clankie/gba-emulator";
import {
  GbaEmulatorObservationSchema,
  INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION,
  type EnvironmentActionResult,
  type GbaEmulatorAction,
  type GbaEmulatorObservation,
  type GbaEmulatorObservationKind,
} from "@clankie/interactive-environment";
import type { EmbodimentEnvironmentId } from "@clankie/protocol";
import {
  ActionSchema,
  ActResultSchema,
  FrameSchema,
  JoinResultSchema,
  LeaveResultSchema,
  ObservationSchema,
  RefusalSchema,
  SessionStatusSchema,
  WatchResultSchema,
  WhoResultSchema,
  WORLD_PROTOCOL_VERSION,
  type Action,
  type ActionRefusal,
  type Frame,
  type JoinResult,
  type Observation,
  type SessionStatus,
  type WhoResult,
} from "@pokeagents/world-protocol";
import { callHost, defaultWorldStateDir, worldSocketPath } from "@pokeagents/world-protocol/ipc";
import { z } from "zod";

export interface WorldBody {
  /** Stable authenticated player journey; never supplied by the model. */
  readonly journeyId: PlayJourneyId;
  /** The only seam `runFreePlay` touches. */
  readonly io: GbaDriverIo;
  /** Latest world frame as PNG bytes; null until the first frame arrives. */
  readonly framePng: () => Uint8Array | null;
  /**
   * Watch the screen as the world paints it. Null detaches.
   *
   * Unlike the local body this needs no `pace` option — the world advances its
   * own cores at hardware speed and publishes as it goes, so frames arrive
   * paced already.
   */
  readonly observeFrames: (observer: (() => void) | null) => void;
  /**
   * Frames the world reported this subscriber missed, cumulative. The world
   * drops rather than queues so a slow reader cannot stall the stream, and it
   * reports the count so a consumer knows not to assume smooth motion.
   */
  readonly droppedFrameCount: () => number;
  /** Native stereo PCM received since the last drain. */
  readonly drainAudio: () => readonly WorldAudioPacket[];
  /** Audio packets lost before they reached the activity sink. */
  readonly droppedAudioPacketCount: () => number;
  /** Causal identity sampled beside decision/pre-action/post-action state. */
  readonly traceProvenance: () => FreePlayProvenance;
  readonly session: () => Promise<SessionStatus>;
  /** Who else is here — the answer he voices, and the reason this exists. */
  readonly who: () => Promise<WhoResult>;
  /** Leaves the world and releases the body. Always call it. */
  readonly close: () => Promise<void>;
}

/**
 * Why a join did not happen, in the vocabulary he says out loud. Distinct from
 * `pokeagent_start_solo`'s refusals on purpose: `body_held` is about his own machine,
 * these are all about a world somewhere else.
 */
export type WorldJoinRefusal =
  | "no_credential"
  | "world_unreachable"
  | "world_refused"
  | "region_not_hosted"
  | "world_full";

export type WorldJoinResult =
  | { outcome: "joined"; body: WorldBody }
  | { outcome: "refused"; reason: WorldJoinRefusal; detail?: string };

export interface WorldJoinOptions {
  environmentId: EmbodimentEnvironmentId;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  onAudioUnavailable?: (reason: string) => void;
}

export interface WorldAudioPacket {
  readonly bodyGeneration: number;
  readonly frame: number;
  readonly encoding: "pcm_s16le";
  readonly sampleRate: number;
  readonly channels: 2;
  readonly frames: number;
  readonly data: Uint8Array;
  readonly capturedAt: string;
}

/**
 * Join the world and return a drivable body.
 *
 * The credential is resolved here from operator configuration and is **not** a
 * parameter, so no caller — and in particular no model — can name the principal
 * it joins as. Identity is provisioned, never asserted; a mind that could spell
 * another player's credential is the hole VUH-976 closed on the world side, and
 * a client that accepted one as an argument would reopen it from this side.
 *
 * Deny-by-default: with nothing provisioned this refuses `no_credential`.
 */
export async function joinWorld(options: WorldJoinOptions): Promise<WorldJoinResult> {
  const env = options.env ?? process.env;
  let credential: string | undefined;
  try {
    credential = await resolveWorldCredential({ env });
  } catch (error) {
    return {
      outcome: "refused",
      reason: "no_credential",
      detail:
        error instanceof WorldCredentialError
          ? error.message
          : "The hosted-world credential could not be read",
    };
  }
  if (credential === undefined) return { outcome: "refused", reason: "no_credential" };

  const socketPath = worldSocketPath(defaultWorldStateDir(env));
  // `world.join` takes a game, not a region. Regions are reached afterwards
  // through `world.travel`, gated on badges — so there is nothing to choose here.
  const gameId = gameIdFor(options.environmentId);
  let rawJoin: Awaited<ReturnType<typeof callHost>>;
  try {
    rawJoin = await callHost(socketPath, {
      operation: "world.join",
      credential,
      input: {
        protocolVersion: WORLD_PROTOCOL_VERSION,
        gameId,
        displayName: "Clankie",
        harness: "clankie",
      },
    });
  } catch (error) {
    return {
      outcome: "refused",
      reason: "world_unreachable",
      detail: boundedError(error),
    };
  }

  const joined = JoinResultSchema.safeParse(rawJoin);
  if (!joined.success) return joinRefusal(rawJoin);
  const missing = REQUIRED_CAPABILITIES.filter(
    (capability) => !joined.data.capabilities.includes(capability),
  );
  if (missing.length > 0) {
    await bestEffortLeave(socketPath, joined.data.token);
    return {
      outcome: "refused",
      reason: "world_refused",
      detail: `The world did not grant ${missing.join(", ")}`,
    };
  }

  let rawObservation: Awaited<ReturnType<typeof callHost>>;
  try {
    rawObservation = await callHost(socketPath, {
      operation: "play.observe",
      token: joined.data.token,
    });
  } catch (error) {
    await bestEffortLeave(socketPath, joined.data.token);
    return {
      outcome: "refused",
      reason: "world_unreachable",
      detail: boundedError(error),
    };
  }
  const observation = ObservationSchema.safeParse(rawObservation);
  if (
    !observation.success ||
    observation.data.sessionId !== joined.data.sessionId ||
    observation.data.gameId !== joined.data.gameId
  ) {
    await bestEffortLeave(socketPath, joined.data.token);
    return {
      outcome: "refused",
      reason: "world_refused",
      detail: refusalDetail(rawObservation, "The world returned an invalid initial observation"),
    };
  }

  const watchAudio = await openWatchAudio(
    socketPath,
    joined.data.token,
    options.fetchImpl ?? fetch,
    options.onAudioUnavailable,
  );
  return {
    outcome: "joined",
    body: new HostedWorldBody(socketPath, joined.data, observation.data, watchAudio),
  };
}

const REQUIRED_CAPABILITIES = ["world.observe", "world.act", "world.frames", "world.presence"] as const;
const HARDWARE_TICK_MS = Math.round(1_000 / 59.7275);
const AUDIO_POLL_MS = 80;
const AUDIO_QUEUE_MAX = 64;
const GOAL_VERSION = 1;
const CHARACTER_ID = "clankie";

const FireRedStateSchema = z
  .object({
    overworld: z
      .object({
        mapId: z.string().min(1),
        mapGroup: z.number().int().nonnegative(),
        mapNum: z.number().int().nonnegative(),
        x: z.number().int().nonnegative(),
        y: z.number().int().nonnegative(),
        facing: z.enum(["north", "east", "south", "west"]),
      })
      .strict()
      .nullable(),
    party: z.array(
      z
        .object({
          slot: z.number().int().min(0).max(5),
          speciesId: z.number().int().positive(),
          level: z.number().int().min(1).max(100),
          currentHp: z.number().int().nonnegative(),
          maxHp: z.number().int().positive(),
          moveIds: z.array(z.number().int().positive()).min(1).max(4),
        })
        .strict(),
    ),
    fieldInputReady: z.boolean(),
    /**
     * Absent on a world older than this field; null when that world decoded no
     * map to stand on. Both mean "unknown", which is not the same answer as
     * "nobody is standing here" and must not be rendered as one.
     */
    npcs: z
      .array(
        z
          .object({
            localId: z.number().int().min(0).max(255),
            graphicsId: z.number().int().min(0).max(255),
            x: z.number().int().min(0).max(1_023),
            y: z.number().int().min(0).max(1_023),
            facing: z.enum(["north", "east", "south", "west"]).nullable(),
          })
          .strict(),
      )
      .max(31)
      .nullish(),
    /** Absent on a world older than this field; empty outside dialog. */
    dialogLines: z.array(z.string().max(512)).max(8).nullish(),
    menu: z
      .object({
        menuId: z.string().min(1).max(128),
        cursor: z.number().int().nonnegative().max(63),
        entries: z
          .array(z.object({ id: z.string().min(1).max(128), label: z.string().min(1).max(256) }).strict())
          .min(1)
          .max(16),
      })
      .strict()
      .nullable(),
  })
  .strict();
type FireRedState = z.infer<typeof FireRedStateSchema>;

const WatchAudioPacketSchema = z
  .object({
    bodyGeneration: z.number().int().positive(),
    frame: z.number().int().nonnegative(),
    encoding: z.literal("pcm_s16le"),
    sampleRate: z.number().int().min(8_000).max(192_000),
    channels: z.literal(2),
    frames: z.number().int().positive().max(16_384),
    byteLength: z
      .number()
      .int()
      .positive()
      .max(64 * 1024),
    data: z.string().min(1),
    capturedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((packet, context) => {
    const bytes = Buffer.from(packet.data, "base64").byteLength;
    if (bytes !== packet.byteLength || bytes !== packet.frames * packet.channels * 2) {
      context.addIssue({ code: "custom", path: ["byteLength"], message: "invalid PCM length" });
    }
  });

const WatchAudioBatchSchema = z
  .object({
    ok: z.literal(true),
    bodyGeneration: z.number().int().nonnegative(),
    cursor: z.number().int().nonnegative(),
    dropped: z.number().int().nonnegative(),
    packets: z.array(WatchAudioPacketSchema).max(256),
  })
  .strict();

interface WatchAudioSource {
  readonly endpoint: URL;
  readonly token: string;
  readonly fetch: typeof fetch;
}

class HostedWorldBody implements WorldBody {
  public readonly journeyId: PlayJourneyId;
  public readonly io: GbaDriverIo;

  private readonly socketPath: string;
  private readonly joined: JoinResult;
  private observation: Observation | undefined;
  private observationSequence = 0;
  private actionSequence = 0;
  private readonly actionKeyPrefix = `clankie-action-${randomUUID()}`;
  private bodyGeneration: number;
  private frame: Frame | undefined;
  private png: Uint8Array | null = null;
  private droppedFrames = 0;
  private readonly watchAudio: WatchAudioSource | undefined;
  private readonly audioPackets: WorldAudioPacket[] = [];
  private audioGeneration = 0;
  private audioCursor = 0;
  private droppedAudioPackets = 0;
  private audioTimer: NodeJS.Timeout | undefined;
  private audioPollInFlight = false;
  private frameObserver: (() => void) | null = null;
  private frameTimer: NodeJS.Timeout | undefined;
  private framePollInFlight = false;
  private observationPollInFlight = false;
  private paused = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private lastAction: EnvironmentActionResult | undefined;
  private readonly stableActionFailures = new Map<string, { errorCode: string; message: string }>();

  public constructor(
    socketPath: string,
    joined: JoinResult,
    observation: Observation,
    watchAudio?: WatchAudioSource,
  ) {
    this.socketPath = socketPath;
    this.joined = joined;
    this.journeyId = worldPlayJourneyId({ worldId: joined.worldId, playerId: joined.playerId });
    this.observation = observation;
    this.bodyGeneration = observation.bodyGeneration;
    this.watchAudio = watchAudio;
    this.io = {
      observe: (kind) => this.observe(kind),
      act: (action) => this.act(action),
      pause: () => {
        this.paused = true;
        return Promise.resolve();
      },
      resume: () => {
        if (this.closed) throw new Error("World body is closed");
        this.paused = false;
        return Promise.resolve();
      },
    };
  }

  public readonly framePng = (): Uint8Array | null => this.png?.slice() ?? null;

  public readonly observeFrames = (observer: (() => void) | null): void => {
    this.frameObserver = observer;
    if (observer === null || this.closed) {
      this.stopFramePolling();
      return;
    }
    if (this.frameTimer !== undefined) return;
    // ponytail: hardware-tick polling is the transport ceiling; replace it with a streaming
    // frames operation when the host exposes one.
    void this.pollFrame();
    this.frameTimer = setInterval(() => void this.pollFrame(), HARDWARE_TICK_MS);
    this.frameTimer.unref();
    this.startAudioPolling();
  };

  public readonly droppedFrameCount = (): number => this.droppedFrames;

  public readonly drainAudio = (): readonly WorldAudioPacket[] => this.audioPackets.splice(0);

  public readonly droppedAudioPacketCount = (): number => this.droppedAudioPackets;

  public readonly traceProvenance = (): FreePlayProvenance => ({
    body: "world",
    sessionId: this.joined.sessionId,
    worldId: this.joined.worldId,
    bodyGeneration: this.bodyGeneration,
    ...(this.observation === undefined ? {} : { adapterVersion: this.observation.adapterVersion }),
  });

  public readonly session = async (): Promise<SessionStatus> => {
    const outcome = await callHost(this.socketPath, {
      operation: "world.session",
      token: this.joined.token,
    });
    const parsed = SessionStatusSchema.safeParse(outcome);
    if (!parsed.success || parsed.data.sessionId !== this.joined.sessionId) {
      throw new Error(refusalDetail(outcome, "The world returned an invalid session status"));
    }
    if (parsed.data.bodyGeneration > this.bodyGeneration) {
      this.resetGeneration(parsed.data.bodyGeneration);
    }
    return parsed.data;
  };

  public readonly who = async (): Promise<WhoResult> => {
    const outcome = await callHost(this.socketPath, {
      operation: "world.who",
      token: this.joined.token,
    });
    const parsed = WhoResultSchema.safeParse(outcome);
    if (!parsed.success || parsed.data.worldId !== this.joined.worldId) {
      throw new Error(refusalDetail(outcome, "The world returned invalid presence"));
    }
    return parsed.data;
  };

  public readonly close = (): Promise<void> => {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.frameObserver = null;
    this.stopFramePolling();
    this.closePromise = (async () => {
      const request = { operation: "world.leave", token: this.joined.token } as const;
      let outcome;
      try {
        outcome = await callHost(this.socketPath, request);
      } catch {
        outcome = await callHost(this.socketPath, request);
      }
      if (RefusalSchema.safeParse(outcome).data?.code === "session_ended") return;
      const parsed = LeaveResultSchema.safeParse(outcome);
      if (!parsed.success || parsed.data.sessionId !== this.joined.sessionId) {
        throw new Error(refusalDetail(outcome, "The world returned an invalid leave result"));
      }
    })();
    return this.closePromise;
  };

  private observe(kind: GbaEmulatorObservationKind): GbaEmulatorObservation {
    if (this.closed) throw adapterError("session_ended", "The hosted world body is closed");
    const observation = this.observation;
    const base = this.observationBase();
    const state =
      observation?.gameId === "firered" && observation.adapterVersion === 2
        ? FireRedStateSchema.safeParse(observation.state).data
        : undefined;
    const certain = observation?.scene.decoded === true && state !== undefined;

    const mapped = (() => {
      switch (kind) {
        case "danger": {
          if (certain) {
            return {
              ...base,
              kind,
              data: {
                severity: "low" as const,
                code: "policy_boundary" as const,
                summary: "Hosted world state is decoded; the shared world may advance independently",
                stateCertain: true,
              },
            };
          }
          // A screen that carries no semantic state — a cutscene or the naming
          // keyboard — is not a danger, and neither is one the
          // adapter does not recognise at all. Reporting a boot sequence as
          // high-severity uncertainty for the minutes it runs is how a mind
          // learns to distrust this signal entirely; it did, and then narrated
          // the distrust to a voice room. `stateCertain` is the load-bearing
          // field either way — a scripted driver still halts on it — so the
          // severity here only decides whether a normal intro reads as alarm.
          const knownScreen = observation !== undefined && observation.scene.decoded;
          return {
            ...base,
            kind,
            data: knownScreen
              ? {
                  severity: "low" as const,
                  code: "input_bound" as const,
                  summary: `Hosted world is on a ${observation.scene.mode} screen; no position or party to read, raw buttons still work`,
                  stateCertain: false,
                }
              : {
                  severity: "low" as const,
                  code: "uncertain_state" as const,
                  summary:
                    "Hosted world is on a screen the adapter does not decode — common during boot " +
                    "and intros; raw buttons and frames remain usable",
                  stateCertain: false,
                },
          };
        }
        case "scene":
          return {
            ...base,
            kind,
            data: {
              mode: localSceneMode(observation?.scene.mode),
              inputReady: observation?.scene.inputReady ?? false,
              waitingForDialogAdvance: observation?.scene.waitingForAdvance ?? false,
            },
          };
        case "frame_reference": {
          if (this.frame === undefined || this.png === null) {
            throw adapterError("frame_unavailable", "The hosted world has not returned a frame yet");
          }
          const encodedSession = encodeURIComponent(this.joined.sessionId);
          return {
            ...base,
            kind,
            data: {
              artifactId: `world:${this.joined.sessionId}:g${String(this.frame.bodyGeneration)}:${String(this.frame.frame)}`,
              uri: `artifact://pokeagent-mmo/${encodedSession}/generations/${String(this.frame.bodyGeneration)}/frames/${String(this.frame.frame)}`,
              framebufferSha256: sha256(this.png),
              ramStateSha256: stateDigest(observation),
              summary: `Hosted world frame ${String(this.frame.frame)} in body generation ${String(this.frame.bodyGeneration)}`,
            },
          };
        }
        case "action": {
          if (this.lastAction === undefined) {
            throw adapterError("unknown_action", "No hosted-world action has settled yet");
          }
          return {
            ...base,
            kind,
            data: {
              actionId: this.lastAction.actionId,
              status: this.lastAction.status,
              summary:
                this.lastAction.status === "completed"
                  ? "Hosted-world action completed"
                  : "Hosted-world action did not run",
            },
          };
        }
        case "overworld": {
          const overworld = requireSemanticState(state).overworld;
          if (overworld === null) {
            throw adapterError("semantic_state_unavailable", "The world has no decoded overworld position");
          }
          const view = mapOverworld(observation?.minimap ?? null, overworld);
          const npcs = requireSemanticState(state).npcs;
          return {
            ...base,
            kind,
            data: {
              position: { mapId: overworld.mapId, x: overworld.x, y: overworld.y },
              facing: overworld.facing,
              surroundings: view.surroundings,
              mapSize: null,
              minimap: view.minimap,
              // A world that does not publish them leaves this absent rather
              // than empty: "not read" and "nobody here" are different facts.
              ...(npcs === undefined || npcs === null ? {} : { occupants: npcs }),
              exits: view.exits,
              ramStateSha256: stateDigest(observation),
            },
          };
        }
        case "party": {
          const party = requireSemanticState(state).party;
          return {
            ...base,
            kind,
            data: {
              activeSlot: party.find((member) => member.currentHp > 0)?.slot ?? party[0]?.slot ?? 0,
              members: party.map((member) => ({
                slot: member.slot,
                speciesId: `firered-species-${String(member.speciesId)}`,
                level: member.level,
                currentHp: member.currentHp,
                maxHp: member.maxHp,
                status: member.currentHp === 0 ? ("fainted" as const) : ("healthy" as const),
              })),
            },
          };
        }
        case "dialog":
          if (observation?.scene.mode !== "dialog") {
            throw adapterError("dialog_not_open", "No dialog is open in the hosted world");
          }
          {
            const lines = requireSemanticState(state).dialogLines ?? [];
            if (lines.length === 0) {
              // A world that does not publish the text, or a box that decoded
              // to nothing. Refusing is what keeps `advance_dialog` honest —
              // an empty `lines` array reads as "he read it and it said
              // nothing", and he then acts on a line he never saw.
              throw adapterError(
                "semantic_state_unavailable",
                "The hosted world does not expose the text of this dialog",
              );
            }
            return {
              ...base,
              kind,
              data: {
                speaker: "firered",
                lines: [...lines],
                lineIndex: 0,
                untrusted: true as const,
              },
            };
          }
        case "menu":
          if (observation?.scene.mode !== "menu" && observation?.scene.mode !== "naming") {
            throw adapterError("menu_not_open", "No menu is open in the hosted world");
          }
          const menu = requireSemanticState(state).menu;
          if (menu === null) {
            throw adapterError(
              "semantic_state_unavailable",
              "The hosted world does not expose decoded entries for this menu",
            );
          }
          return { ...base, kind, data: { ...menu, untrusted: true as const } };
        case "battle":
          if (observation?.scene.mode !== "battle") {
            throw adapterError("battle_not_active", "No battle is active in the hosted world");
          }
          throw adapterError(
            "semantic_state_unavailable",
            "The hosted world does not expose decoded battle state",
          );
        case "inventory":
          requireSemanticState(state);
          throw adapterError(
            "semantic_state_unavailable",
            "The hosted world does not expose decoded inventory",
          );
      }
    })();
    return GbaEmulatorObservationSchema.parse(mapped);
  }

  private async act(action: GbaEmulatorAction): Promise<EnvironmentActionResult> {
    this.actionSequence += 1;
    const actionId = `world-action-${String(this.actionSequence)}`;
    if (this.closed) return this.failedAction(actionId, "session_ended", "The hosted world body is closed");
    if (this.paused) return this.failedAction(actionId, "session_paused", "Clankie paused his world actions");
    const stableFailureKey = unsupportedWalkKey(this.observation, action);
    const remembered =
      stableFailureKey === null ? undefined : this.stableActionFailures.get(stableFailureKey);
    if (remembered !== undefined && stableFailureKey !== null) {
      this.stableActionFailures.delete(stableFailureKey);
      this.stableActionFailures.set(stableFailureKey, remembered);
      return this.failedAction(actionId, remembered.errorCode, remembered.message);
    }
    const requestGeneration = this.bodyGeneration;
    const worldAction = mapAction(action);
    const request = {
      operation: "play.act",
      token: this.joined.token,
      input: {
        action: worldAction,
        idempotencyKey: `${this.actionKeyPrefix}-${String(this.actionSequence)}`,
      },
    } as const;

    let outcome: Awaited<ReturnType<typeof callHost>>;
    try {
      outcome = await callHost(this.socketPath, request);
    } catch {
      try {
        outcome = await callHost(this.socketPath, request);
      } catch (error) {
        return this.failedAction(actionId, "world_unreachable", boundedError(error), true);
      }
    }

    const result = ActResultSchema.safeParse(outcome);
    if (!result.success || result.data.sessionId !== this.joined.sessionId) {
      const refusal = RefusalSchema.safeParse(outcome);
      return this.failedAction(
        actionId,
        refusal.success ? refusal.data.code : "world_protocol_error",
        refusal.success ? refusal.data.message : "The world returned an invalid action result",
        refusal.success && refusal.data.retryAfterMs !== undefined,
      );
    }
    const sameRequestGeneration = result.data.bodyGeneration === requestGeneration;
    if (result.data.bodyGeneration > this.bodyGeneration) {
      this.resetGeneration(result.data.bodyGeneration);
    }
    if (result.data.outcome.kind === "rejected") {
      const refusal = result.data.outcome.refusal;
      const detail = actionRefusalDetail(refusal);
      const message =
        `The world refused the action: ${JSON.stringify(refusal)}` + (detail === null ? "" : ` — ${detail}`);
      const failed = this.failedAction(actionId, result.data.outcome.refusal.reason, message);
      if (
        result.data.outcome.refusal.reason === "walk_exit_unsupported" &&
        stableFailureKey !== null &&
        sameRequestGeneration
      ) {
        this.stableActionFailures.delete(stableFailureKey);
        this.stableActionFailures.set(stableFailureKey, {
          errorCode: result.data.outcome.refusal.reason,
          message,
        });
        if (this.stableActionFailures.size > FREE_PLAY_HARD_FAILURE_LIMIT) {
          const oldest = this.stableActionFailures.keys().next().value;
          if (oldest !== undefined) this.stableActionFailures.delete(oldest);
        }
      }
      this.lastAction = failed;
      return failed;
    }

    this.acceptObservation(result.data.outcome.observation);
    try {
      await this.refreshFrame();
    } catch {
      // The action is authoritative even if its follow-up screen poll transiently fails.
    }
    const completed: EnvironmentActionResult = {
      schemaVersion: INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION,
      actionId,
      sessionId: this.joined.sessionId,
      updatedAt: result.data.outcome.observation.observedAt,
      status: "completed",
      acceptedGoalVersion: GOAL_VERSION,
      outcome: {
        inputsSpent: result.data.outcome.inputsSpent,
        framesSpent: result.data.outcome.framesSpent,
        screenChanged: result.data.outcome.screenChanged,
        replayed: result.data.replayed,
        bodyGeneration: result.data.bodyGeneration,
        frame: result.data.frame,
        // A composite action's own account of itself, spread flat because the
        // world names these fields the way the local adapter does — so every
        // effect line `free-play-progress` already writes works here unchanged.
        // Dropping it is what made every `advance_dialog` on a hosted world
        // read as "read no new text — the dialog stopped", however much it read.
        ...result.data.outcome.detail,
      },
    };
    this.lastAction = completed;
    return completed;
  }

  private failedAction(
    actionId: string,
    errorCode: string,
    message: string,
    retryable = false,
  ): EnvironmentActionResult {
    const failed: EnvironmentActionResult = {
      schemaVersion: INTERACTIVE_ENVIRONMENT_SCHEMA_VERSION,
      actionId,
      sessionId: this.joined.sessionId,
      updatedAt: new Date().toISOString(),
      status: "failed",
      acceptedGoalVersion: GOAL_VERSION,
      errorCode,
      message,
      retryable,
    };
    this.lastAction = failed;
    return failed;
  }

  private observationBase(): Omit<GbaEmulatorObservation, "kind" | "data"> {
    this.observationSequence += 1;
    const observation = this.observation;
    return {
      schemaVersion: 1,
      observationId: `world-observation-${String(this.observationSequence)}`,
      sessionId: this.joined.sessionId,
      characterId: CHARACTER_ID,
      worldId: this.joined.worldId,
      goalVersion: GOAL_VERSION,
      capturedAt: observation?.observedAt ?? this.frame?.capturedAt ?? new Date().toISOString(),
      frame: observation?.frame ?? this.frame?.frame ?? 0,
    };
  }

  private async pollFrame(): Promise<void> {
    if (this.closed || this.frameObserver === null || this.framePollInFlight) return;
    this.framePollInFlight = true;
    try {
      await this.refreshFrame();
    } catch {
      // A transient failed poll leaves the last good frame visible; the next hardware tick retries.
    } finally {
      this.framePollInFlight = false;
    }
  }

  private async refreshFrame(): Promise<void> {
    const outcome = await callHost(this.socketPath, {
      operation: "play.frame",
      token: this.joined.token,
    });
    const frame = FrameSchema.safeParse(outcome);
    if (!frame.success || frame.data.sessionId !== this.joined.sessionId) {
      this.stopIfEnded(outcome);
      return;
    }
    if (this.acceptFrame(frame.data)) {
      void this.pollObservation();
      this.frameObserver?.();
    }
  }

  private async pollObservation(): Promise<void> {
    if (this.closed || this.observationPollInFlight) return;
    this.observationPollInFlight = true;
    try {
      const outcome = await callHost(this.socketPath, {
        operation: "play.observe",
        token: this.joined.token,
      });
      const observation = ObservationSchema.safeParse(outcome);
      if (!observation.success || observation.data.sessionId !== this.joined.sessionId) {
        this.stopIfEnded(outcome);
        return;
      }
      this.acceptObservation(observation.data);
    } catch {
      // Frame polling remains useful when a semantic refresh transiently fails.
    } finally {
      this.observationPollInFlight = false;
    }
  }

  private startAudioPolling(): void {
    if (this.watchAudio === undefined || this.audioTimer !== undefined) return;
    void this.pollAudio();
    this.audioTimer = setInterval(() => void this.pollAudio(), AUDIO_POLL_MS);
    this.audioTimer.unref();
  }

  private async pollAudio(): Promise<void> {
    if (
      this.closed ||
      this.frameObserver === null ||
      this.audioPollInFlight ||
      this.watchAudio === undefined
    ) {
      return;
    }
    this.audioPollInFlight = true;
    try {
      const endpoint = new URL(this.watchAudio.endpoint);
      if (this.audioGeneration > 0) {
        endpoint.searchParams.set("generation", String(this.audioGeneration));
        endpoint.searchParams.set("after", String(this.audioCursor));
      }
      const response = await this.watchAudio.fetch(endpoint, {
        headers: { Authorization: `Watch ${this.watchAudio.token}` },
        cache: "no-store",
      });
      if (!response.ok) return;
      const parsed = WatchAudioBatchSchema.safeParse(await response.json());
      if (!parsed.success) return;
      const batch = parsed.data;
      if (this.audioGeneration !== 0 && batch.bodyGeneration !== this.audioGeneration) {
        this.audioPackets.length = 0;
      }
      this.audioGeneration = batch.bodyGeneration;
      this.audioCursor = batch.cursor;
      this.droppedAudioPackets += batch.dropped;
      for (const packet of batch.packets) {
        this.audioPackets.push({
          bodyGeneration: packet.bodyGeneration,
          frame: packet.frame,
          encoding: packet.encoding,
          sampleRate: packet.sampleRate,
          channels: packet.channels,
          frames: packet.frames,
          data: Uint8Array.from(Buffer.from(packet.data, "base64")),
          capturedAt: packet.capturedAt,
        });
      }
      while (this.audioPackets.length > AUDIO_QUEUE_MAX) {
        this.audioPackets.shift();
        this.droppedAudioPackets += 1;
      }
    } catch {
      // Audio is best-effort live media. Frame and action polling continue.
    } finally {
      this.audioPollInFlight = false;
    }
  }

  private acceptFrame(incoming: Frame): boolean {
    if (incoming.bodyGeneration < this.bodyGeneration) return false;
    if (incoming.bodyGeneration > this.bodyGeneration) this.resetGeneration(incoming.bodyGeneration);
    if (
      this.observation !== undefined &&
      incoming.bodyGeneration === this.observation.bodyGeneration &&
      incoming.frame < this.observation.frame
    ) {
      return false;
    }
    if (this.frame !== undefined && incoming.frame <= this.frame.frame) return false;
    if (this.frame !== undefined) {
      this.droppedFrames += Math.max(0, incoming.frame - this.frame.frame - 1);
    }
    this.droppedFrames += incoming.dropped;
    this.frame = incoming;
    this.png = Uint8Array.from(Buffer.from(incoming.data, "base64"));
    return true;
  }

  private acceptObservation(incoming: Observation): void {
    if (incoming.bodyGeneration < this.bodyGeneration) return;
    if (incoming.bodyGeneration > this.bodyGeneration) this.resetGeneration(incoming.bodyGeneration);
    if (
      this.observation !== undefined &&
      incoming.bodyGeneration === this.observation.bodyGeneration &&
      incoming.frame < this.observation.frame
    ) {
      return;
    }
    this.observation = incoming;
  }

  private resetGeneration(generation: number): void {
    this.bodyGeneration = generation;
    this.observation = undefined;
    this.frame = undefined;
    this.png = null;
    this.audioGeneration = 0;
    this.audioCursor = 0;
    this.audioPackets.length = 0;
    this.stableActionFailures.clear();
  }

  private stopIfEnded(outcome: unknown): void {
    const refusal = RefusalSchema.safeParse(outcome);
    if (
      !refusal.success ||
      (refusal.data.code !== "session_ended" && refusal.data.code !== "not_your_session")
    ) {
      return;
    }
    this.stopFramePolling();
  }

  private stopFramePolling(): void {
    if (this.frameTimer !== undefined) clearInterval(this.frameTimer);
    this.frameTimer = undefined;
    if (this.audioTimer !== undefined) clearInterval(this.audioTimer);
    this.audioTimer = undefined;
    this.audioGeneration = 0;
    this.audioCursor = 0;
    this.audioPackets.length = 0;
  }
}

/** Preserve the protocol's answerable refusal detail in the line the player reads. */
function actionRefusalDetail(refusal: ActionRefusal): string | null {
  switch (refusal.reason) {
    case "budget":
      return `the action asked for ${String(refusal.asked)}; this session allows ${String(refusal.allowed)}`;
    case "walk_target_outside_map":
      return (
        `map bounds are x >= ${String(refusal.bounds.minX)} and x < ${String(refusal.bounds.maxX)}, ` +
        `y >= ${String(refusal.bounds.minY)} and y < ${String(refusal.bounds.maxY)}`
      );
    case "walk_target_impassable":
      return refusal.nearestOpen === null
        ? "the world found no open tile near that target"
        : `nearest open tile is (${String(refusal.nearestOpen.x)},${String(refusal.nearestOpen.y)}) on ${refusal.nearestOpen.mapId}`;
    case "no_path_to_target":
      return refusal.nearestReachable === null
        ? "the world found no reachable tile near that target"
        : `nearest reachable tile is (${String(refusal.nearestReachable.x)},${String(refusal.nearestReachable.y)}) on ${refusal.nearestReachable.mapId}`;
    case "walk_exit_unsupported":
      return `the exit at (${String(refusal.at.x)},${String(refusal.at.y)}) leads to ${refusal.to}`;
    case "menu_entry_not_present":
      return `available entries: ${refusal.available.join(", ") || "none"}`;
    case "script_holding":
    case "dialog_not_open":
    case "menu_not_open":
    case "semantic_state_unavailable":
      return null;
  }
}

async function openWatchAudio(
  socketPath: string,
  token: string,
  fetchImpl: typeof fetch,
  onUnavailable?: (reason: string) => void,
): Promise<WatchAudioSource | undefined> {
  try {
    const outcome = await callHost(socketPath, {
      operation: "play.watch",
      token,
      input: { visibility: "unlisted" },
    });
    const parsed = WatchResultSchema.safeParse(outcome);
    if (!parsed.success) {
      const refusal = RefusalSchema.safeParse(outcome);
      onUnavailable?.(refusal.success ? refusal.data.code : "invalid_watch_response");
      return undefined;
    }
    if (parsed.data.visibility === "off") {
      onUnavailable?.("watch_disabled");
      return undefined;
    }
    const watch = new URL(parsed.data.url);
    const watchToken = decodeURIComponent(watch.hash.slice(1));
    if (watchToken.length === 0) {
      onUnavailable?.("invalid_watch_token");
      return undefined;
    }
    return { endpoint: new URL("/api/watch/audio", watch), token: watchToken, fetch: fetchImpl };
  } catch {
    onUnavailable?.("watch_unreachable");
    return undefined;
  }
}

function gameIdFor(environmentId: EmbodimentEnvironmentId): string {
  switch (environmentId) {
    case "pokemon-firered":
      return "firered";
    case "pokemon-emerald":
      return "emerald";
  }
}

function mapAction(action: GbaEmulatorAction): Action {
  switch (action.kind) {
    case "enter_text":
      return ActionSchema.parse({
        kind: action.kind,
        text: action.text,
        ...(action.submit === undefined ? {} : { confirm: action.submit }),
      });
    case "select_menu_entry":
      return ActionSchema.parse({ kind: action.kind, entry: action.entryId });
    default:
      return ActionSchema.parse(action);
  }
}

function requireSemanticState(state: FireRedState | undefined): FireRedState {
  if (state === undefined) {
    throw adapterError(
      "semantic_state_unavailable",
      "The hosted world has no decoded FireRed state for this screen",
    );
  }
  return state;
}

/**
 * The world and clankie now name the same screens the same way, so this is a
 * pass-through rather than a translation. `unknown` stays reserved for a screen
 * the adapter could not interpret — never for one it understood and that simply
 * carries no position or party.
 */
function localSceneMode(mode: Observation["scene"]["mode"] | undefined) {
  switch (mode) {
    case "overworld":
    case "dialog":
    case "menu":
    case "naming":
    case "cutscene":
    case "battle":
      return mode;
    default:
      return "unknown" as const;
  }
}

function mapOverworld(minimap: Observation["minimap"], position: NonNullable<FireRedState["overworld"]>) {
  if (minimap === null || minimap.topLeft.mapId !== position.mapId) {
    return { minimap: null, surroundings: null, exits: null };
  }
  const tile = (x: number, y: number) => {
    const row = minimap.rows[y - minimap.topLeft.y];
    const cell = row?.[x - minimap.topLeft.x];
    if (cell === undefined) return undefined;
    return {
      x,
      y,
      passable: cell === "." || cell === "@" || cell === "D",
      elevation: null,
      metatileId: null,
    };
  };
  const north = tile(position.x, position.y - 1);
  const east = tile(position.x + 1, position.y);
  const south = tile(position.x, position.y + 1);
  const west = tile(position.x - 1, position.y);
  const surroundings =
    north === undefined || east === undefined || south === undefined || west === undefined
      ? null
      : {
          north,
          east,
          south,
          west,
          ahead: { north, east, south, west }[position.facing],
        };
  return {
    minimap: { topLeft: { x: minimap.topLeft.x, y: minimap.topLeft.y }, rows: minimap.rows },
    surroundings,
    exits: {
      warps: minimap.exits.map((exit) => ({
        x: exit.at.x,
        y: exit.at.y,
        destination: exit.to,
        walkTo: exit.walkTo,
      })),
      connections: [],
    },
  };
}

function unsupportedWalkKey(observation: Observation | undefined, action: GbaEmulatorAction): string | null {
  if (observation === undefined || action.kind !== "walk_to" || observation.minimap === null) return null;
  const exit = observation.minimap.exits.find(
    (candidate) => candidate.at.x === action.x && candidate.at.y === action.y,
  );
  if (exit?.walkTo !== "unsupported") return null;
  return JSON.stringify({
    bodyGeneration: observation.bodyGeneration,
    adapterVersion: observation.adapterVersion,
    gameId: observation.gameId,
    mapId: exit.at.mapId,
    x: exit.at.x,
    y: exit.at.y,
    to: exit.to,
    walkTo: exit.walkTo,
  });
}

function stateDigest(observation: Observation | undefined): string {
  return sha256(
    Buffer.from(
      JSON.stringify({
        bodyGeneration: observation?.bodyGeneration ?? null,
        adapterVersion: observation?.adapterVersion ?? null,
        scene: observation?.scene ?? null,
        state: observation?.state ?? null,
      }),
    ),
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function adapterError(code: string, message: string): EnvironmentAdapterActionError {
  return new EnvironmentAdapterActionError(code, message, false);
}

function joinRefusal(outcome: unknown): WorldJoinResult {
  const refusal = RefusalSchema.safeParse(outcome);
  if (!refusal.success) {
    return {
      outcome: "refused",
      reason: "world_refused",
      detail: "The world returned an invalid join result",
    };
  }
  if (refusal.data.code === "world_full") {
    return { outcome: "refused", reason: "world_full", detail: refusal.data.message };
  }
  if (refusal.data.code === "game_unavailable") {
    return { outcome: "refused", reason: "region_not_hosted", detail: refusal.data.message };
  }
  return { outcome: "refused", reason: "world_refused", detail: refusal.data.message };
}

function refusalDetail(outcome: unknown, fallback: string): string {
  const refusal = RefusalSchema.safeParse(outcome);
  return refusal.success ? `${refusal.data.code}: ${refusal.data.message}` : fallback;
}

async function bestEffortLeave(socketPath: string, token: string): Promise<void> {
  try {
    await callHost(socketPath, { operation: "world.leave", token });
  } catch {
    // The join is already being refused; cleanup cannot make that result less true.
  }
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300) || "Hosted world request failed";
}
