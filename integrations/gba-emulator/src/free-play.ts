import {
  EnvironmentActionResultSchema,
  GbaEmulatorActionSchema,
  GbaEmulatorObservationSchema,
  type EnvironmentActionResult,
  type GbaEmulatorAction,
  type GbaEmulatorObservation,
  type GbaEmulatorObservationKind,
} from "@clankie/interactive-environment";
import { EnvironmentAdapterActionError } from "@clankie/environment-runtime";
import { z } from "zod";
import {
  FREE_PLAY_INTENT_MAX,
  FREE_PLAY_HARD_FAILURE_LIMIT,
  FREE_PLAY_INTERJECTION_MAX,
  FREE_PLAY_MONOLOGUE_MAX,
  FREE_PLAY_NOTES_MAX,
  FREE_PLAY_OBJECTIVE_MAX,
  FREE_PLAY_REPEAT_TURNS,
  FREE_PLAY_REPLY_MAX,
  FREE_PLAY_SPEAK_COOLDOWN_TURNS,
  FREE_PLAY_SPEAK_MAX,
} from "./free-play-bounds.ts";
import {
  VoiceDecisionSchema,
  voiceHasSomethingToConsider,
  type ClankieVoice,
  type VoiceView,
} from "./free-play-voice.ts";

export * from "./free-play-bounds.ts";
import { canonicalJson, sha256 } from "./core-double.ts";
import { GbaCheckpointLabelSchema } from "./checkpoint.ts";
import type { GbaDriverIo } from "./driver.ts";
import {
  described,
  FreePlayProgressTracker,
  mindEffectLine,
  type GbaPosition,
  observeEffect,
  positionOf,
  type Described,
  type FreePlayProgress,
  type LearnedTransition,
  type ObservedEffect,
} from "./free-play-progress.ts";

/**
 * Actions on the body's saved time, owned by the loop rather than the frozen
 * emulator catalog ([ADR 0075](../../../docs/adr/0075-rewinding-is-a-play-choice.md)).
 *
 * State loads have always lived outside the adapter — ADR 0060 shipped save
 * and load as possession hooks beside the action surface, not inside it — and
 * these follow that shape: the loop consults a checkpoint port the composer
 * injects, and the governed emulator catalog does not change. What changes is
 * *who may want one*: the owner ruled that restarting or loading a save is a
 * play choice, his to make. Rewinding is non-destructive by construction —
 * checkpoints are append-only sibling identities, and the port banks the
 * present before restoring the past.
 */
export const FreePlayBodyActionSchema = z.discriminatedUnion("kind", [
  /** Capture the current local body as a new immutable checkpoint. */
  z
    .object({
      kind: z.literal("save_checkpoint"),
      label: GbaCheckpointLabelSchema.optional(),
    })
    .strict(),
  /**
   * Restore a minted checkpoint, or list what exists.
   *
   * Absent `checkpointId` is a question, not a change: the action completes
   * with the listing as its effect, exactly like the MCP load tool with no id.
   */
  z
    .object({
      kind: z.literal("load_checkpoint"),
      checkpointId: z.string().min(1).max(200).optional(),
    })
    .strict(),
  /** Reboot the game to its configured starting savestate. */
  z.object({ kind: z.literal("restart_game") }).strict(),
]);
export type FreePlayBodyAction = z.infer<typeof FreePlayBodyActionSchema>;

/** Everything a free-play decision may do: play the game, or move through its saves. */
export const FreePlayActionSchema = z.union([GbaEmulatorActionSchema, FreePlayBodyActionSchema]);
export type FreePlayAction = z.infer<typeof FreePlayActionSchema>;

export const FreePlayDecisionSchema = z
  .object({
    /** Why this action, in Clankie's own voice. */
    monologue: z.string().min(1).max(FREE_PLAY_MONOLOGUE_MAX),
    /**
     * A standing goal that outlives the turn. A string sets it, null clears it,
     * and omission keeps it for custom/non-structured minds.
     */
    objective: z.string().max(FREE_PLAY_OBJECTIVE_MAX).nullish(),
    /**
     * What he will do on the NEXT turn — a concrete action, not the objective.
     * This is the field follow-through is scored against, which is only
     * meaningful now that the goal lives somewhere else.
     */
    intent: z.string().min(1).max(FREE_PLAY_INTENT_MAX),
    /**
     * What he says back to whoever spoke to him this turn.
     *
     * Separate from `monologue`: monologue is thinking and goes to the trace and
     * the overlay, this is speech and goes to a person. Null when nobody asked
     * anything, which is most turns.
     */
    reply: z.string().max(FREE_PLAY_REPLY_MAX).nullish(),
    /**
     * Something he says because he wants to, with nobody having asked.
     *
     * Null on most turns and that is correct — silence is the default. This is
     * the difference between a character and a narrator.
     */
    speak: z.string().max(FREE_PLAY_SPEAK_MAX).nullish(),
    /**
     * His notes, rewritten by him each turn. Nothing else writes this: it is
     * memory he chose to keep, not a summary the harness imposed.
     */
    // Nullish, not required: a model that omits the field means "leave my notes
    // alone", and losing an entire turn over a missing optional field would be a
    // harsh reading of a decision that is otherwise valid.
    notes: z.string().max(FREE_PLAY_NOTES_MAX).nullish(),
    action: FreePlayActionSchema,
  })
  .strict();
export type FreePlayDecision = z.infer<typeof FreePlayDecisionSchema>;

export const FreePlayProvenanceSchema = z
  .object({
    body: z.enum(["local", "world"]),
    sessionId: z.string().min(1).max(200).optional(),
    worldId: z.string().min(1).max(200).optional(),
    bodyGeneration: z.number().int().nonnegative().optional(),
    adapterVersion: z.number().int().nonnegative().optional(),
    coreId: z.string().min(1).max(200).optional(),
    fixtureSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    romSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    coreWasmSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    real: z.boolean().optional(),
  })
  .strict();
export type FreePlayProvenance = z.infer<typeof FreePlayProvenanceSchema>;

const FreePlayStateEvidenceSchema = z
  .object({
    observations: z.array(GbaEmulatorObservationSchema).max(6),
    provenance: FreePlayProvenanceSchema.nullable(),
  })
  .strict();

const FreePlayProgressEvidenceSchema = z
  .object({
    distinctTiles: z.number().int().nonnegative(),
    maps: z.array(z.string().max(200)).max(256),
    turnsSinceNewTile: z.number().int().nonnegative(),
    actionsPerNewTile: z.number().nonnegative().nullable(),
  })
  .strict();

const FreePlayActionResultEvidenceSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("environment"), result: EnvironmentActionResultSchema }).strict(),
  z
    .object({
      source: z.literal("body"),
      status: z.enum(["completed", "rejected"]),
      summary: z.string().max(4_096),
      advice: z.string().max(4_096).nullable(),
    })
    .strict(),
  z
    .object({
      source: z.literal("exception"),
      name: z.string().min(1).max(200),
      message: z.string().max(4_096).nullable(),
      errorCode: z.string().min(1).max(200).nullable(),
      retryable: z.boolean().nullable(),
    })
    .strict(),
]);

/** Bounded causal evidence stored beside one journal turn. Never contains frame bytes. */
export const FreePlayTurnEvidenceSchema = z
  .object({
    decision: FreePlayStateEvidenceSchema,
    immediatePreAction: FreePlayStateEvidenceSchema.nullable(),
    postAction: FreePlayStateEvidenceSchema.nullable(),
    actionResult: FreePlayActionResultEvidenceSchema.nullable(),
    progressBefore: FreePlayProgressEvidenceSchema,
    progressAfter: FreePlayProgressEvidenceSchema.nullable(),
    signals: z
      .object({
        refusedHere: z.array(z.string().max(64)).max(4),
        knownHardFailures: z
          .array(
            z
              .object({
                action: FreePlayActionSchema,
                errorCode: z.string().min(1).max(200),
                effect: z.string().min(1).max(500),
              })
              .strict(),
          )
          .max(FREE_PLAY_HARD_FAILURE_LIMIT)
          .optional(),
        stalledForTurns: z.number().int().nonnegative().nullable(),
        repeatingForTurns: z.number().int().nonnegative().nullable(),
        recurringForTurns: z.number().int().nonnegative().nullable(),
        objectiveForTurns: z.number().int().nonnegative().nullable(),
        localeForTurns: z.number().int().nonnegative().nullable(),
        previousObjective: z.string().max(FREE_PLAY_OBJECTIVE_MAX).nullable(),
        previousNotes: z.string().max(FREE_PLAY_NOTES_MAX).nullable(),
        retiredObjective: z.string().max(FREE_PLAY_OBJECTIVE_MAX).nullable(),
        objectiveRecovery: z.boolean().default(false),
        verifiedInteractions: z.array(z.string().max(700)).max(FREE_PLAY_HARD_FAILURE_LIMIT).default([]),
        decisionPreemptions: z.number().int().nonnegative().default(0),
      })
      .strict(),
    timing: z
      .object({
        decisionStartedAt: z.string().datetime(),
        decisionSettledAt: z.string().datetime(),
        actionStartedAt: z.string().datetime().nullable(),
        actionSettledAt: z.string().datetime().nullable(),
      })
      .strict(),
  })
  .strict();
export type FreePlayTurnEvidence = z.infer<typeof FreePlayTurnEvidenceSchema>;

/**
 * What the model sees.
 *
 * Decoded state alone is a privileged, partial view: it carries position and
 * facing but not what is *in* the room, so a model reading only RAM discovers
 * furniture by walking into it. The rendered frame is what a human would look
 * at, so both are supplied — the frame for what is on screen, the decoded state
 * for the exact values a screenshot reads badly (HP, PP, legal moves).
 */
export interface FreePlayView {
  turn: number;
  observations: GbaEmulatorObservation[];
  /** The current screen as PNG bytes, when a core renders one. */
  framePng: Uint8Array | null;
  /**
   * Directions already refused from exactly this tile. Memory of what he tried,
   * never a suggested route — the model still chooses.
   */
  refusedHere: readonly string[];
  /** Stable capability failures in this exact body state. Memory, never a replacement action. */
  knownHardFailures: readonly FreePlayHardFailure[];
  /**
   * Turns since he last stood on a tile he had never stood on before, surfaced
   * only once it is long enough to mean something. The loop always computed
   * this; a measured run sat at 85 while the number stayed in the summary
   * nobody reads mid-game. Information, never advice: a long conversation
   * stalls it legitimately, and what to do about it stays his call.
   */
  stalledForTurns: number | null;
  /**
   * How many turns in a row he has now taken the same action and got back the
   * same effect, surfaced only once it is long enough to mean something.
   *
   * The counterpart to `stalledForTurns` for everywhere he has no position: a
   * battle menu, a naming screen, a script that will not release. Information
   * on the same terms as the rest of this view — a repeat can be persistence
   * (a script that needs more time) or a wedge (an action refused identically
   * forever), and which one it is stays his read, not the loop's.
   */
  repeatingForTurns: number | null;
  /** Recent semantic states are revisiting one another despite varied actions. */
  recurringForTurns: number | null;
  /** Settled turns spent pursuing the current objective. */
  objectiveForTurns: number | null;
  /** Settled turns spent in the current map visit. */
  localeForTurns: number | null;
  /** A stale objective the loop retired after warning him, shown once. */
  retiredObjective: string | null;
  /** True until play reaches a semantic state outside the loop that retired the objective. */
  objectiveRecovery: boolean;
  /** Direct occupant interactions observed by the harness in this body generation. */
  verifiedInteractions: readonly string[];
  /** Successful map transitions learned from this session's own actions. */
  learnedTransitions: readonly LearnedTransition[];
  /** The notes he wrote on the previous turn, verbatim. */
  notes: string | null;
  /** His standing objective, carried until he changes it. */
  objective: string | null;
  /** Turns since he last said something unprompted; null if he never has. */
  turnsSinceSpoke: number | null;
  /**
   * Who, if anyone, is around to hear him.
   *
   * Volition needs an audience. Told nothing, he correctly says nothing — a
   * character does not make asides to an empty room, and the first measured run
   * spoke on 0 of 12 turns for exactly that reason.
   */
  audience: string | null;
  /**
   * What someone said to him since the last turn, if anything.
   *
   * Deliberately *not* privileged: an interjection is something a person said,
   * not an instruction that outranks his own judgement. Treating it as a command
   * would rebuild the scripted driver ADR 0049 removed — the difference between
   * "how's it going?" and being steered.
   */
  interjection: string | null;
  /** Prior turns, most recent last, so the model has continuity. */
  history: readonly { intent: string; action: FreePlayAction; outcome: string; effect: string }[];
}

export interface FreePlayHardFailure {
  action: FreePlayAction;
  errorCode: string;
  effect: string;
}

interface VerifiedInteraction {
  readonly key: string;
  readonly mapId: string;
  readonly localId: number;
  readonly graphicsId: number;
  readonly x: number;
  readonly y: number;
  readonly dialog: string;
  readonly count: number;
}

/**
 * The decision-maker. Returns an unvalidated value on purpose: a model can
 * emit anything, and rejecting it is part of what this loop must survive.
 */
export interface FreePlayMind {
  decide(view: FreePlayView, signal?: AbortSignal): Promise<unknown>;
}

export const FreePlayTurnSchema = z
  .object({
    turn: z.number().int().nonnegative(),
    /** Digest of the decoded observations the decision was made from. */
    observationSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    /** Frame the decision was made at, when the core rendered one. */
    framebufferSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .nullable(),
    monologue: z.string().max(FREE_PLAY_MONOLOGUE_MAX).nullable(),
    intent: z.string().max(FREE_PLAY_INTENT_MAX).nullable(),
    notes: z.string().max(FREE_PLAY_NOTES_MAX).nullable(),
    objective: z.string().max(FREE_PLAY_OBJECTIVE_MAX).nullable(),
    /** A stale standing objective retired after a warning turn. */
    objectiveRetired: z.string().max(FREE_PLAY_OBJECTIVE_MAX).nullable().default(null),
    /** Recorded so an interjection's influence on the run stays auditable. */
    interjection: z.string().max(FREE_PLAY_INTERJECTION_MAX).nullable(),
    reply: z.string().max(FREE_PLAY_REPLY_MAX).nullable(),
    /** What he chose to say unprompted, after the rate gate. */
    speak: z.string().max(FREE_PLAY_SPEAK_MAX).nullable(),
    /** He wanted to speak but the gate held him. Measures whether it binds. */
    speakSuppressed: z.boolean(),
    /**
     * His volition fired this turn — he judged the moment worth a word —
     * regardless of who ended up authoring it or whether the gate let it out.
     * True on room-authored turns where `speak` is deliberately null, which is
     * what the possessor seam reports on.
     */
    speakWanted: z.boolean().default(false),
    action: FreePlayActionSchema.nullable(),
    outcome: z.enum(["accepted", "rejected_by_adapter", "invalid_decision", "mind_failed"]),
    /** Bounded reason when the turn did not produce an accepted action. */
    detail: z.string().max(400).nullable(),
    /**
     * What actually changed. `accepted` only means the adapter took the button;
     * this says whether he moved, was blocked, or changed nothing.
     *
     * Observation only. Everything that reads this field is an audience — the
     * activity overlay, the story card, and the possessor seam that hands a
     * voice room what just happened — so the coaching half lives next door.
     */
    effect: z.string().max(200).nullable(),
    /**
     * The harness's advice for his next press, which rides with the effect in
     * the history he reads: "hold the direction longer to move", "use
     * advance_dialog to read the intro". It is written to him, in the
     * imperative, and a room handed it hears him telling *them* what to press.
     * Split out rather than dropped, because the trail must still show what he
     * was told. Defaulted so journals written before the split keep parsing.
     */
    effectAdvice: z.string().max(300).nullable().default(null),
  })
  .strict();
export type FreePlayTurn = z.infer<typeof FreePlayTurnSchema>;

export interface FreePlayVolition {
  /** Turns where he could have spoken — every turn. */
  offered: number;
  /** Turns he chose to. */
  taken: number;
  /** Turns he chose to but the gate held him. */
  suppressed: number;
  /**
   * Turns where Voice was not consulted at all: nobody spoke and the rate
   * gate could not open, so any aside it produced would have been dropped.
   * Counted so the saved calls stay measurable rather than invisible.
   */
  skipped: number;
}

export interface FreePlayResult {
  turns: FreePlayTurn[];
  progress: FreePlayProgress;
  volition: FreePlayVolition;
  /** Turns whose action the adapter accepted. */
  accepted: number;
  /**
   * The longest run of consecutive turns whose action and effect were both
   * identical. Measured so a wedge is a number in the summary rather than a
   * shape someone has to notice by reading the whole journal.
   *
   * Not the benchmark's `longestRepeatedInputRun`, which counts identical
   * *accepted* actions whatever they did — that one scores whether a run was
   * button-mashing, and legitimately fires while walking a corridor. This one
   * requires the result to be identical too, and counts refusals, because the
   * failure it exists for is an action refused the same way forever.
   */
  longestUnchangedRun: number;
  /** Longest recent window dominated by recurring semantic states. */
  longestRecurringRun: number;
  /** Standing objectives retired after remaining stale through a warning turn. */
  objectivesRetired: number;
  /**
   * Fraction of scoreable turns where the previous turn's intent referenced the
   * action actually taken. A heuristic and a lower bound — see
   * {@link intentMatchesAction}. Reported, never gated.
   */
  coherence: number | null;
}

/**
 * How many tile-stalled turns pass before the view says so. Below this the
 * signal is noise — reading a sign stalls it for a turn or two; above it he is
 * either deep in a conversation (and knows it) or going in circles (and may
 * not). The measured failure was 85.
 */
export const FREE_PLAY_STALL_TURNS = 12;

const OBSERVED_KINDS: GbaEmulatorObservationKind[] = [
  "danger",
  "scene",
  "overworld",
  "battle",
  "dialog",
  "menu",
];

/**
 * Somewhere for a person's latest message to wait until the player reads it.
 *
 * Injection is asynchronous. A message offered while the mind is deciding
 * aborts that proposal so the same turn can be decided again with the new words.
 * Only the most recent message survives: a backlog of stale questions answered
 * several turns late reads worse than the newest one answered now.
 */
export class InterjectionQueue {
  private pending: string | null = null;
  private readonly listeners = new Set<() => void>();

  /** Called from outside the loop, whenever someone says something. */
  public offer(message: string): void {
    const trimmed = message.trim().slice(0, FREE_PLAY_INTERJECTION_MAX);
    if (trimmed.length === 0) return;
    this.pending = trimmed;
    for (const listener of this.listeners) listener();
  }

  /** Taken by the next proposal; a later offer preempts it with newer words. */
  public take(): string | null {
    const message = this.pending;
    this.pending = null;
    return message;
  }

  public hasPending(): boolean {
    return this.pending !== null;
  }

  /** Wake an in-flight decision. The queued words remain available to {@link take}. */
  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** One checkpoint, as the listing and the load report it to the player. */
export interface FreePlayCheckpointSummary {
  checkpointId: string;
  label: string | null;
  capturedAt: string;
  position: { mapId: string; x: number; y: number } | null;
}

/**
 * The body's saved time, as the loop may touch it (ADR 0075).
 *
 * Injected by the composer, exactly as the MCP surface injects its checkpoint
 * hooks — the loop holds no filesystem and no digest policy. Implementations
 * must bank the present before restoring the past, so a rewind can never
 * destroy the state it left; `readGbaCheckpoint`'s identity and digest gates
 * do the refusing on a bad load.
 */
export interface FreePlayCheckpointPort {
  /** Every loadable checkpoint, newest first. */
  list(): FreePlayCheckpointSummary[];
  /** Mint the current body and mind as a new immutable checkpoint. */
  save(input: {
    label?: string | undefined;
    position: GbaPosition | null;
    continuity: { notes: string | null; objective: string | null };
  }): FreePlayCheckpointSummary;
  /** Restore one by id. Throws with a self-describing reason on refusal. */
  load(checkpointId: string): FreePlayCheckpointSummary;
  /** Reboot to the configured starting savestate. */
  restart(): void;
}

/** Present-tense state for spectators; completed turn detail still arrives through `onTurn`. */
export type FreePlayPhase = "thinking" | "acting";

export interface RunFreePlayInput {
  io: GbaDriverIo;
  mind: FreePlayMind;
  turns: number;
  /**
   * His reach into the body's saved time. Absent — the deterministic double,
   * a test that exercises play only — a rewind decision is refused truthfully
   * rather than pretended at.
   */
  checkpoints?: FreePlayCheckpointPort;
  /** Called after every turn so a CLI can stream the playthrough. */
  onTurn?: (turn: FreePlayTurn, evidence: FreePlayTurnEvidence) => void;
  /** Called at the real model/action boundary so live viewers never infer it from frame timing. */
  onPhase?: (phase: FreePlayPhase) => void;
  /**
   * Called after an action has settled and progress has consumed its observed
   * effect. Benchmarks use this boundary so they measure what the adapter
   * actually accepted and what state resulted, never the mind's proposal.
   */
  onSettledTurn?: (event: FreePlaySettledTurn) => void;
  /** Latest framebuffer digest, when a core exposes one. */
  framebufferSha256?: () => string | null;
  /** Latest rendered screen as PNG bytes, when a core exposes one. */
  /**
   * The screen, optionally anchored to the tile he stands on so the picture
   * carries labelled tile axes. Seeing the furniture was never the problem —
   * addressing it was, because `walk_to` wants a coordinate and a screenshot
   * has none (ADR 0120).
   */
  framePng?: (anchor?: { readonly playerX: number; readonly playerY: number }) => Uint8Array | null;
  /** Body identity sampled with each causal stage, when the composer exposes it. */
  provenance?: () => FreePlayProvenance | null;
  /** Wall clock for causal timing. */
  clock?: () => Date;
  historyLimit?: number;
  /** Where mid-play questions land. Absent means nobody can talk to him. */
  interjections?: InterjectionQueue;
  /** Minimum turns between unprompted remarks. */
  speakCooldownTurns?: number;
  /**
   * The half of him that talks. Omitted, speech falls back to the player's own
   * decision — measurably near-silent, see ADR 0056.
   */
  voice?: ClankieVoice;
  /**
   * Whether a live room is composing his speech itself (ADR 0074).
   *
   * While this is true neither author here runs: the realtime session in the
   * voice channel is the sole voice that room hears, it already heard anything
   * said to him, and a line promoted here would be a second author for the same
   * character in the same moment. Read per turn rather than once, because
   * people join and leave mid-playthrough. Absent means nobody is listening and
   * the loop authors as it always has.
   */
  roomAuthors?: () => boolean;
  /** Who is listening. Absent means he is alone and will reasonably stay quiet. */
  audience?: string;
  /**
   * Notes carried over from a previous run, typically the ones stamped into
   * the checkpoint this session resumed from. Seeded, then entirely his: he
   * rewrites or discards them exactly like notes he wrote this session. A
   * resume without them restores the world but not the mind that was in it.
   */
  initialNotes?: string | null;
  /** The standing objective from a previous run, same contract as the notes. */
  initialObjective?: string | null;
  /**
   * Checked at each turn boundary; true ends the playthrough cleanly there.
   * This is how an asked stop (ADR 0063) or an exhausted duration budget lands
   * without tearing down a turn mid-dispatch.
   */
  shouldStop?: () => boolean;
}

export interface FreePlaySettledTurn {
  turn: FreePlayTurn;
  before: readonly GbaEmulatorObservation[];
  after: readonly GbaEmulatorObservation[];
  progress: FreePlayProgress;
}

export async function runFreePlay(input: RunFreePlayInput): Promise<FreePlayResult> {
  const clock = input.clock ?? (() => new Date());
  const historyLimit = input.historyLimit ?? 8;
  const turns: FreePlayTurn[] = [];
  const history: { intent: string; action: FreePlayAction; outcome: string; effect: string }[] = [];
  // Bounded on entry: seeds come from validated receipts today, but the bound
  // is the loop's own invariant, not the caller's promise.
  let notes: string | null = input.initialNotes?.slice(0, FREE_PLAY_NOTES_MAX) ?? null;
  let objective: string | null = input.initialObjective?.slice(0, FREE_PLAY_OBJECTIVE_MAX) ?? null;
  let objectiveForTurns = 0;
  let staleObjectiveWarned = false;
  let retiredObjective: string | null = null;
  let retiredLoopStates: Set<string> | null = null;
  let objectivesRetired = 0;
  let lastSpokeTurn: number | null = null;
  const volition: FreePlayVolition = { offered: 0, taken: 0, suppressed: 0, skipped: 0 };
  const cooldown = input.speakCooldownTurns ?? FREE_PLAY_SPEAK_COOLDOWN_TURNS;
  const recentlySaid: string[] = [];
  const progress = new FreePlayProgressTracker();
  const hardFailures = new Map<string, FreePlayHardFailure>();
  const verifiedInteractionMemory = new Map<string, VerifiedInteraction>();
  const initialObservations = observe(input.io);
  const initialPosition = positionOf(initialObservations);
  progress.seed(initialPosition);
  const semanticStates = [semanticStateFingerprint(initialObservations, input.framebufferSha256?.() ?? null)];
  let currentMap = initialPosition?.mapId ?? null;
  let localeForTurns = 0;
  // Consecutive turns whose action and effect were both identical. A turn that
  // never reached an action — the model errored, or its decision did not parse
  // — leaves this untouched rather than resetting it: a transient failure in
  // the middle of a wedge is not evidence the wedge broke.
  let repeat: { signature: string; turns: number } | null = null;
  let longestUnchangedRun = 0;
  let longestRecurringRun = 0;

  for (let turn = 0; turn < input.turns; turn += 1) {
    if (input.shouldStop?.() === true) break;
    let observations = observe(input.io);
    const decisionFingerprint = semanticStateFingerprint(observations, input.framebufferSha256?.() ?? null);
    if (retiredLoopStates !== null && !retiredLoopStates.has(decisionFingerprint)) {
      retiredLoopStates = null;
    }
    const objectiveRecovery = retiredLoopStates !== null;
    const progressBefore = evidenceProgress(progress.snapshot());
    const sinceNewTile = progressBefore.turnsSinceNewTile;
    const recurringForTurns = recurringStateTurns(semanticStates);
    longestRecurringRun = Math.max(longestRecurringRun, recurringForTurns ?? 0);
    const stalledForTurns =
      sinceNewTile >= FREE_PLAY_STALL_TURNS && positionOf(observations) !== null ? sinceNewTile : null;
    const repeatingForTurns = repeat !== null && repeat.turns >= FREE_PLAY_REPEAT_TURNS ? repeat.turns : null;
    const shownObjectiveForTurns =
      objective !== null && objectiveForTurns >= FREE_PLAY_STALL_TURNS ? objectiveForTurns : null;
    const shownLocaleForTurns =
      currentMap !== null && localeForTurns >= FREE_PLAY_STALL_TURNS ? localeForTurns : null;
    let refusedHere = progress.refusedFrom(positionOf(observations));
    let provenance = input.provenance?.() ?? null;
    let knownHardFailures = hardFailuresFor(hardFailures, observations, provenance);
    let verifiedInteractions = verifiedInteractionsFor(verifiedInteractionMemory, observations, provenance);
    const decisionStartedAt = clock().toISOString();
    const evidence: FreePlayTurnEvidence = {
      decision: stateEvidence(observations, input.provenance),
      immediatePreAction: null,
      postAction: null,
      actionResult: null,
      progressBefore,
      progressAfter: null,
      signals: {
        refusedHere,
        knownHardFailures,
        stalledForTurns,
        repeatingForTurns,
        recurringForTurns,
        objectiveForTurns: shownObjectiveForTurns,
        localeForTurns: shownLocaleForTurns,
        previousObjective: objective,
        previousNotes: notes,
        retiredObjective,
        objectiveRecovery,
        verifiedInteractions,
        decisionPreemptions: 0,
      },
      timing: {
        decisionStartedAt,
        decisionSettledAt: decisionStartedAt,
        actionStartedAt: null,
        actionSettledAt: null,
      },
    };
    const record: FreePlayTurn = {
      turn,
      observationSha256: sha256(canonicalJson(observations)),
      framebufferSha256: input.framebufferSha256?.() ?? null,
      monologue: null,
      intent: null,
      action: null,
      outcome: "mind_failed",
      detail: null,
      effect: null,
      effectAdvice: null,
      notes,
      objective,
      objectiveRetired: null,
      interjection: null,
      reply: null,
      speak: null,
      speakSuppressed: false,
      speakWanted: false,
    };

    // Taken before the first proposal. A later offer aborts that proposal and
    // replaces this with the newest words without consuming a numbered turn.
    let interjection = input.interjections?.take() ?? null;
    record.interjection = interjection;

    let raw: unknown;
    let mindFailed = false;
    let mindFailure: unknown;
    let objectiveWasStale = false;
    const retiredForView = retiredObjective;
    while (true) {
      const interrupted = new AbortController();
      const unsubscribe = input.interjections?.subscribe(() => interrupted.abort("room_interjection"));
      try {
        input.onPhase?.("thinking");
        objectiveWasStale =
          objective !== null &&
          objectiveForTurns >= FREE_PLAY_STALL_TURNS &&
          recurringForTurns !== null &&
          positionOf(observations) !== null;
        const decision = input.mind.decide(
          {
            turn,
            observations,
            framePng: framePngAt(input.framePng, positionOf(observations)),
            refusedHere,
            knownHardFailures,
            verifiedInteractions,
            // Only when he has a position to be stuck at: mid-battle and mid-warp
            // the tile counter stalls for reasons that need no telling.
            stalledForTurns,
            repeatingForTurns,
            recurringForTurns,
            objectiveForTurns: shownObjectiveForTurns,
            localeForTurns: shownLocaleForTurns,
            retiredObjective: retiredForView,
            objectiveRecovery,
            learnedTransitions: progress.transitionsFrom(positionOf(observations)),
            notes,
            objective,
            interjection,
            turnsSinceSpoke: lastSpokeTurn === null ? null : turn - lastSpokeTurn,
            audience: input.audience ?? null,
            history: [...history],
          },
          interrupted.signal,
        );
        raw =
          input.interjections === undefined
            ? await decision
            : await Promise.race([decision, rejectOnAbort(interrupted.signal)]);
      } catch (error) {
        mindFailed = !interrupted.signal.aborted;
        mindFailure = error;
      } finally {
        unsubscribe?.();
      }
      if (interrupted.signal.aborted || input.interjections?.hasPending() === true) {
        evidence.signals.decisionPreemptions += 1;
        interjection = input.interjections?.take() ?? interjection;
        record.interjection = interjection;
        observations = observe(input.io);
        provenance = input.provenance?.() ?? null;
        refusedHere = progress.refusedFrom(positionOf(observations));
        knownHardFailures = hardFailuresFor(hardFailures, observations, provenance);
        verifiedInteractions = verifiedInteractionsFor(verifiedInteractionMemory, observations, provenance);
        const framebufferSha256 = input.framebufferSha256?.() ?? null;
        record.observationSha256 = sha256(canonicalJson(observations));
        record.framebufferSha256 = framebufferSha256;
        evidence.decision = stateEvidence(observations, input.provenance);
        evidence.signals.refusedHere = refusedHere;
        evidence.signals.knownHardFailures = knownHardFailures;
        evidence.signals.verifiedInteractions = verifiedInteractions;
        mindFailed = false;
        continue;
      }
      break;
    }
    evidence.timing.decisionSettledAt = clock().toISOString();
    if (mindFailed) {
      // A model that errors must not end the playthrough; the turn is lost and
      // the loop continues so a long run survives a transient failure.
      record.detail = bounded(mindFailure);
      turns.push(finalize(record, evidence, input.onTurn));
      continue;
    }
    retiredObjective = null;

    const parsed = FreePlayDecisionSchema.safeParse(raw);
    if (!parsed.success) {
      record.outcome = "invalid_decision";
      record.detail = bounded(parsed.error.issues.map((issue) => issue.path.join(".")).join(","));
      turns.push(finalize(record, evidence, input.onTurn));
      continue;
    }

    record.monologue = parsed.data.monologue;
    record.intent = parsed.data.intent;
    // He keeps his notes unless he rewrites them, so silence is not amnesia.
    if (parsed.data.notes !== null && parsed.data.notes !== undefined) notes = parsed.data.notes;
    record.notes = notes;
    const priorObjective = objective;
    // Omission keeps an objective for custom minds; structured minds use null
    // to clear it and restate the string to keep it.
    if (parsed.data.objective !== undefined) {
      const proposed = parsed.data.objective?.trim() || null;
      // Retirement is about the loop, not the exact wording of the goal. Keep
      // the slot empty until play reaches a semantic state outside that loop,
      // so paraphrasing the stale objective cannot resurrect it one turn later.
      objective = objectiveRecovery && proposed !== null ? null : proposed;
    }
    const objectiveChanged = objective !== priorObjective;
    objectiveForTurns = objective === null ? 0 : objectiveChanged ? 1 : objectiveForTurns + 1;
    if (objectiveWasStale && !objectiveChanged && priorObjective !== null) {
      if (staleObjectiveWarned) {
        objective = null;
        objectiveForTurns = 0;
        staleObjectiveWarned = false;
        retiredObjective = priorObjective;
        retiredLoopStates = new Set(semanticStates);
        record.objectiveRetired = priorObjective;
        objectivesRetired += 1;
      } else {
        staleObjectiveWarned = true;
      }
    } else {
      staleObjectiveWarned = false;
    }
    record.objective = objective;
    record.reply = parsed.data.reply ?? null;

    record.action = parsed.data.action;
    const chosen = parsed.data.action;
    input.onPhase?.("acting");
    const preActionObservations = observe(input.io);
    evidence.immediatePreAction = stateEvidence(preActionObservations, input.provenance);
    evidence.timing.actionStartedAt = clock().toISOString();

    let accepted = false;
    let actionOutcome: Record<string, unknown> | undefined;
    let rejection: Described | null = null;
    let failure: { errorCode: string; retryable: boolean } | null = null;
    /** Set only by an accepted body action, whose effect no diff can read. */
    let bodySummary: Described | null = null;
    /**
     * The screen as it stands the instant before the action, which is not the
     * screen he was shown when he decided.
     *
     * `record.framebufferSha256` is sampled at observation, and the console now
     * keeps running while he thinks (ADR 0047) — so diffing from it attributes
     * every drop of ambient animation across a ten-second decision to whatever
     * he did at the end of it. On 2026-08-15 that told him a fruitless A press
     * had changed the screen, and cost him the next turn to work out it had
     * not. Sampling here narrows the window back to the action itself.
     */
    const frameBefore = input.framebufferSha256?.() ?? null;
    if (
      chosen.kind === "save_checkpoint" ||
      chosen.kind === "load_checkpoint" ||
      chosen.kind === "restart_game"
    ) {
      // The body's saved time, not the emulator (ADR 0075): dispatched to the
      // injected checkpoint port, never to io.act — the frozen catalog does
      // not change, and a body without the port refuses truthfully.
      if (input.checkpoints === undefined) {
        record.outcome = "rejected_by_adapter";
        record.detail = "checkpoints_unavailable";
        rejection = described("rejected, nothing ran", "this body has no saved time to move through");
        evidence.actionResult = {
          source: "body",
          status: "rejected",
          summary: "checkpoints_unavailable",
          advice: "this body has no saved time to move through",
        };
      } else {
        try {
          bodySummary = applyBodyAction(chosen, input.checkpoints, {
            notes,
            objective,
            position: positionOf(preActionObservations),
          });
          record.outcome = "accepted";
          accepted = true;
          record.detail = bounded(mindEffectLine(bodySummary));
          evidence.actionResult = {
            source: "body",
            status: "completed",
            summary: bodySummary.summary,
            advice: bodySummary.advice ?? null,
          };
        } catch (error) {
          // The port's gates speak for themselves: checkpoint_not_found, a
          // digest mismatch, a foreign ROM. The reason is the effect.
          record.outcome = "rejected_by_adapter";
          record.detail = bounded(error);
          rejection = described("rejected, nothing ran", bounded(error));
          evidence.actionResult = exceptionEvidence(error);
        }
      }
    } else {
      try {
        const remembered = hardFailuresFor(
          hardFailures,
          preActionObservations,
          input.provenance?.() ?? null,
        ).find((failure) => canonicalJson(failure.action) === canonicalJson(chosen));
        if (remembered !== undefined) {
          record.outcome = "rejected_by_adapter";
          record.detail = `known_non_retryable:${remembered.errorCode}`;
          rejection = described(
            "rejected, nothing ran",
            `unchanged capability evidence already produced ${remembered.errorCode}`,
          );
          evidence.actionResult = {
            source: "body",
            status: "rejected",
            summary: `known_non_retryable:${remembered.errorCode}`,
            advice: "the body was not called again because its capability evidence has not changed",
          };
        } else {
          const result = await input.io.act(chosen);
          evidence.actionResult = { source: "environment", result };
          // A rejection arrives as a status, not only as a throw: the adapter fails
          // closed on an illegal button, an exceeded frame bound, a missing
          // capability, or a stale goal version. Both shapes are legitimate answers
          // rather than crashes, so both keep the playthrough running.
          if (result.status === "completed") {
            record.outcome = "accepted";
            accepted = true;
            actionOutcome = result.outcome as Record<string, unknown>;
            record.detail = bounded(JSON.stringify(result.outcome));
          } else {
            record.outcome = "rejected_by_adapter";
            record.detail = bounded(`${result.status}:${describeRejection(result)}`);
            rejection = describeRejectionForPlayer(
              result.status === "failed" ? result.errorCode : null,
              describeRejection(result),
            );
            if (result.status === "failed") {
              failure = { errorCode: result.errorCode, retryable: result.retryable };
            }
          }
        }
      } catch (error) {
        record.outcome = "rejected_by_adapter";
        record.detail = bounded(error);
        rejection = describeRejectionForPlayer(
          error instanceof EnvironmentAdapterActionError ? error.errorCode : null,
          bounded(error),
        );
        evidence.actionResult = exceptionEvidence(error);
        if (error instanceof EnvironmentAdapterActionError) {
          failure = { errorCode: error.errorCode, retryable: error.retryable };
        }
      }
    }

    // Re-observe and diff, so the turn records what changed rather than only
    // that the adapter took the button. The frame digest is sampled from just
    // before the action to just after it, so the comparison spans what this
    // turn did to the screen and not the idling the console did meanwhile.
    //
    // A rejected action never ran, so diffing around it would invent an effect
    // — the worst case was a refused advance_dialog reading as "read no new
    // text", a success-shaped sentence about an action that did not happen.
    // The rejection reason IS the effect of that turn, and it is the one line
    // the model actually sees (detail stays journal-only).
    const frameAfter = input.framebufferSha256?.() ?? null;
    const afterObservations = observe(input.io);
    evidence.postAction = stateEvidence(afterObservations, input.provenance);
    evidence.timing.actionSettledAt = clock().toISOString();
    const effect =
      rejection !== null
        ? { ...rejection, refused: null, position: positionOf(preActionObservations), enteredMap: false }
        : bodySummary !== null
          ? // A rewind's effect is what the port reports plus where he now
            // stands — a state diff around a restored world would only restate
            // it, and the restored position must still reach the progress
            // tracker so the tile memory follows him back.
            rewindEffect(bodySummary, preActionObservations, afterObservations)
          : observeEffect({
              before: preActionObservations,
              // Body actions never reach here, so this narrows to the emulator kinds.
              after: afterObservations,
              action: chosen as GbaEmulatorAction,
              outcome: actionOutcome,
              screenChanged: frameBefore !== null && frameAfter !== null ? frameAfter !== frameBefore : null,
            });
    progress.record(effect, accepted);
    evidence.progressAfter = evidenceProgress(progress.snapshot());
    if (
      accepted &&
      chosen.kind !== "save_checkpoint" &&
      chosen.kind !== "load_checkpoint" &&
      chosen.kind !== "restart_game"
    ) {
      progress.recordTransition(preActionObservations, chosen, afterObservations);
      rememberVerifiedInteraction(
        verifiedInteractionMemory,
        preActionObservations,
        afterObservations,
        input.provenance?.() ?? null,
        chosen,
      );
    }
    semanticStates.push(semanticStateFingerprint(afterObservations, frameAfter));
    if (semanticStates.length > FREE_PLAY_STALL_TURNS) semanticStates.shift();
    longestRecurringRun = Math.max(longestRecurringRun, recurringStateTurns(semanticStates) ?? 0);
    const afterPosition = positionOf(afterObservations);
    if (afterPosition === null) {
      localeForTurns += 1;
    } else if (afterPosition.mapId === currentMap) {
      localeForTurns += 1;
    } else {
      currentMap = afterPosition.mapId;
      localeForTurns = 0;
    }
    // Only the observation is stored. `effect.advice` is the harness coaching
    // his next press, and everything downstream of this record is an audience:
    // the overlay, the story card, and the possessor seam that hands a voice
    // room what just happened. A room told "hold the direction longer to move"
    // hears him directing *them*, which is how he ended up sounding like the
    // spectators were the ones playing. The advice goes to the mind alone.
    record.effect = effect.summary.slice(0, 200);
    record.effectAdvice = effect.advice === undefined ? null : effect.advice.slice(0, 300);
    const mindEffect = mindEffectLine(effect);
    if (failure !== null && !failure.retryable) {
      const key = stableHardFailureKey(
        preActionObservations,
        input.provenance?.() ?? null,
        chosen,
        failure.errorCode,
      );
      if (key !== null) {
        hardFailures.delete(key);
        hardFailures.set(key, {
          action: chosen,
          errorCode: failure.errorCode,
          effect: mindEffect.slice(0, 500),
        });
        if (hardFailures.size > FREE_PLAY_HARD_FAILURE_LIMIT) {
          const oldest = hardFailures.keys().next().value;
          if (oldest !== undefined) hardFailures.delete(oldest);
        }
      }
    }

    // Same result, whatever he tried: the state-independent stuck signal. Keyed
    // on the observed effect alone, not on the action that produced it — an
    // alternating loop is still a loop. On 2026-08-18 he read "Press START to
    // open the MENU!" four times across nine turns by alternating `a` and
    // `advance_dialog`; keying on the pair meant the counter reset every turn
    // and he was never told (ADR 0092). Effect-only subsumes the old pair
    // signature: identical action *and* effect is identical effect.
    //
    // Keyed on the observation rather than the fuller line he reads, which
    // discriminates identically — advice never varies except with the branch
    // that set it.
    const signature = canonicalJson({ effect: record.effect });
    // Annotated: without it the loop-carried assignment below makes this
    // variable's type depend on itself.
    const priorRepeats: number = repeat !== null && repeat.signature === signature ? repeat.turns : 0;
    repeat = { signature, turns: priorRepeats + 1 };
    longestUnchangedRun = Math.max(longestUnchangedRun, repeat.turns);

    // Whether the rate gate could let an unprompted remark through this turn.
    // Computed before Voice is consulted, because a consultation whose only
    // possible aside would be dropped by this same gate is a model call bought
    // for nothing.
    const ready = lastSpokeTurn === null || turn - lastSpokeTurn >= cooldown;

    // Voice decides speech when one is wired; the player's own speak/reply are
    // the single-agent fallback (ADR 0056). Voice cannot act, which is what
    // makes "an interjection is not a route" structural rather than a prompt.
    // It runs after the action settles so "what just happened" is the turn's
    // real effect — commentary about a move belongs after the move lands.
    // While a room composes for itself (ADR 0074), neither author here runs —
    // not Voice, and not the player's own fallback quip. Both would be a second
    // author for one character in one moment: in the channel if the seam
    // carried them, on the overlay if it did not.
    const roomAuthors = input.roomAuthors?.() === true;
    // His own volition, read before anyone decides who authors the words.
    // ADR 0074 moves *authorship* to the room; it does not move the judgement
    // of whether this moment was worth remarking on at all. Keeping that
    // judgement is what lets the possessor seam report the turns he thought
    // were worth a word, instead of narrating every turn's diagnostics.
    const ownWish = parsed.data.speak ?? null;
    let wants = roomAuthors ? null : ownWish;
    if (input.voice !== undefined && roomAuthors) {
      // Not consulted at all: the room is already speaking in his voice.
      volition.skipped += 1;
    } else if (input.voice !== undefined && interjection === null && !ready) {
      // Not consulted at all: nobody spoke, and the gate could not open.
      volition.skipped += 1;
    } else if (input.voice !== undefined) {
      const voiceView: VoiceView = {
        turn,
        framePng: input.framePng?.() ?? null,
        monologue: record.monologue,
        effect: record.effect,
        intent: record.intent,
        objective,
        heard: interjection,
        turnsSinceSpoke: lastSpokeTurn === null ? null : turn - lastSpokeTurn,
        audience: input.audience ?? null,
        recentlySaid: [...recentlySaid],
      };
      if (voiceHasSomethingToConsider(voiceView)) {
        try {
          input.onPhase?.("thinking");
          const spoken = VoiceDecisionSchema.safeParse(await input.voice.decide(voiceView));
          if (spoken.success) {
            wants = spoken.data.speak ?? null;
            if (spoken.data.reply !== null && spoken.data.reply !== undefined) {
              record.reply = spoken.data.reply;
            }
          }
        } catch {
          // A voice failure must not cost the turn. He plays on in silence.
        }
      }
    }

    // Every turn is an opportunity; the gate only limits how often he takes it.
    volition.offered += 1;
    if (wants !== null && wants.trim().length > 0) {
      if (ready) {
        record.speak = wants;
        lastSpokeTurn = turn;
        volition.taken += 1;
        recentlySaid.push(wants);
        if (recentlySaid.length > 3) recentlySaid.shift();
      } else {
        // Held, not dropped silently: a gate that never binds is a gate nobody
        // needs, and one that always binds is a muzzle. Both show up here.
        record.speakSuppressed = true;
        volition.suppressed += 1;
      }
    }
    // Recorded whoever ends up holding the pen: when the room authors, `wants`
    // is deliberately null and this is the only surviving trace that he judged
    // the moment worth a word.
    const wished = roomAuthors ? ownWish : wants;
    record.speakWanted = wished !== null && wished.trim().length > 0;

    history.push({
      intent: parsed.data.intent,
      action: parsed.data.action,
      outcome: record.outcome,
      effect: mindEffect,
    });
    if (history.length > historyLimit) history.shift();
    const settledTurn = finalize(record, evidence, input.onTurn);
    turns.push(settledTurn);
    input.onSettledTurn?.({
      turn: settledTurn,
      before: preActionObservations,
      after: afterObservations,
      progress: progress.snapshot(),
    });
  }

  return {
    turns,
    accepted: turns.filter((t) => t.outcome === "accepted").length,
    progress: progress.snapshot(),
    volition,
    longestUnchangedRun,
    longestRecurringRun,
    objectivesRetired,
    ...coherence(turns),
  };
}

function hardFailuresFor(
  failures: ReadonlyMap<string, FreePlayHardFailure>,
  observations: readonly GbaEmulatorObservation[],
  provenance: FreePlayProvenance | null,
): FreePlayHardFailure[] {
  return [...failures.values()].filter((failure) => {
    const key = stableHardFailureKey(observations, provenance, failure.action, failure.errorCode);
    return key !== null && failures.get(key) === failure;
  });
}

function verifiedInteractionsFor(
  memory: ReadonlyMap<string, VerifiedInteraction>,
  observations: readonly GbaEmulatorObservation[],
  provenance: FreePlayProvenance | null,
): string[] {
  const overworld = overworldInteractionState(observations);
  if (overworld === null) return [];
  const current = new Set(
    overworld.occupants.map((occupant) =>
      interactionKey(provenance, overworld.mapId, occupant.localId, occupant.graphicsId),
    ),
  );
  return [...memory.values()]
    .filter((fact) => current.has(fact.key))
    .map(
      (fact) =>
        `On ${fact.mapId}, pressing A while facing occupant localId ${String(fact.localId)}, ` +
        `graphicsId ${String(fact.graphicsId)}, at (${String(fact.x)},${String(fact.y)}) opened dialog: ` +
        `"${fact.dialog}"${fact.count === 1 ? "" : ` (${String(fact.count)} observed interactions)`}`,
    );
}

function rememberVerifiedInteraction(
  memory: Map<string, VerifiedInteraction>,
  before: readonly GbaEmulatorObservation[],
  after: readonly GbaEmulatorObservation[],
  provenance: FreePlayProvenance | null,
  action: FreePlayAction,
): void {
  if (action.kind !== "button_press" || action.button !== "a" || (action.repeat ?? 1) !== 1) {
    return;
  }
  const overworld = overworldInteractionState(before);
  if (overworld === null) return;
  const ahead = aheadOf(overworld.x, overworld.y, overworld.facing);
  const occupant = overworld.occupants.find(
    (candidate) => candidate.x === ahead.x && candidate.y === ahead.y,
  );
  if (occupant === undefined) return;
  const dialog = after.find((observation) => observation.kind === "dialog") as
    | { data?: { lines?: readonly string[] } }
    | undefined;
  const text = dialog?.data?.lines?.join(" / ").trim().slice(0, 500);
  if (text === undefined || text.length === 0) return;
  const key = interactionKey(provenance, overworld.mapId, occupant.localId, occupant.graphicsId);
  const prior = memory.get(key);
  memory.delete(key);
  memory.set(key, {
    key,
    mapId: overworld.mapId,
    localId: occupant.localId,
    graphicsId: occupant.graphicsId,
    x: occupant.x,
    y: occupant.y,
    dialog: text,
    count: (prior?.count ?? 0) + 1,
  });
  if (memory.size > FREE_PLAY_HARD_FAILURE_LIMIT) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
}

function overworldInteractionState(observations: readonly GbaEmulatorObservation[]): {
  mapId: string;
  x: number;
  y: number;
  facing: "north" | "east" | "south" | "west";
  occupants: readonly { localId: number; graphicsId: number; x: number; y: number }[];
} | null {
  const overworld = observations.find((observation) => observation.kind === "overworld") as
    | {
        data?: {
          position?: { mapId?: string; x?: number; y?: number };
          facing?: "north" | "east" | "south" | "west";
          occupants?: readonly { localId: number; graphicsId: number; x: number; y: number }[] | null;
        };
      }
    | undefined;
  const position = overworld?.data?.position;
  const facing = overworld?.data?.facing;
  const occupants = overworld?.data?.occupants;
  if (
    typeof position?.mapId !== "string" ||
    typeof position.x !== "number" ||
    typeof position.y !== "number" ||
    facing === undefined ||
    !Array.isArray(occupants)
  ) {
    return null;
  }
  return {
    mapId: position.mapId,
    x: position.x,
    y: position.y,
    facing,
    occupants,
  };
}

function aheadOf(
  x: number,
  y: number,
  facing: "north" | "east" | "south" | "west",
): { x: number; y: number } {
  if (facing === "north") return { x, y: y - 1 };
  if (facing === "east") return { x: x + 1, y };
  if (facing === "south") return { x, y: y + 1 };
  return { x: x - 1, y };
}

function interactionKey(
  provenance: FreePlayProvenance | null,
  mapId: string,
  localId: number,
  graphicsId: number,
): string {
  return canonicalJson({
    body: provenance?.body ?? null,
    sessionId: provenance?.sessionId ?? null,
    bodyGeneration: provenance?.bodyGeneration ?? null,
    mapId,
    localId,
    graphicsId,
  });
}

/** Key only failures the body explicitly says are stable under unchanged capability evidence. */
function stableHardFailureKey(
  observations: readonly GbaEmulatorObservation[],
  provenance: FreePlayProvenance | null,
  action: FreePlayAction,
  errorCode: string,
): string | null {
  if (errorCode === "semantic_state_unavailable" && semanticHelper(action)) {
    return canonicalJson({
      body: provenance?.body ?? null,
      sessionId: provenance?.sessionId ?? null,
      bodyGeneration: provenance?.bodyGeneration ?? null,
      adapterVersion: provenance?.adapterVersion ?? null,
      coreId: provenance?.coreId ?? null,
      action,
      semanticState: semanticStateFingerprint(observations, null),
    });
  }
  if (errorCode !== "walk_exit_unsupported" || action.kind !== "walk_to") return null;
  const overworld = observations.find((observation) => observation.kind === "overworld") as
    | {
        data?: {
          position?: { mapId?: string };
          exits?: {
            warps?: Array<{
              x?: number;
              y?: number;
              destination?: string;
              walkTo?: string;
            }>;
          };
        };
      }
    | undefined;
  const exit = overworld?.data?.exits?.warps?.find(
    (candidate) => candidate.x === action.x && candidate.y === action.y,
  );
  if (exit?.walkTo !== "unsupported") return null;
  return canonicalJson({
    body: provenance?.body ?? null,
    sessionId: provenance?.sessionId ?? null,
    bodyGeneration: provenance?.bodyGeneration ?? null,
    adapterVersion: provenance?.adapterVersion ?? null,
    coreId: provenance?.coreId ?? null,
    mapId: overworld?.data?.position?.mapId ?? null,
    action,
    exit,
  });
}

function semanticHelper(action: FreePlayAction): boolean {
  return (
    action.kind === "walk_to" ||
    action.kind === "advance_dialog" ||
    action.kind === "enter_text" ||
    action.kind === "select_menu_entry"
  );
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** A bounded semantic state key: volatile envelope ids and RAM digests stay out. */
function semanticStateFingerprint(
  observations: readonly GbaEmulatorObservation[],
  framebufferSha256: string | null,
): string {
  const data = (kind: GbaEmulatorObservationKind): unknown =>
    (observations.find((observation) => observation.kind === kind) as { data?: unknown } | undefined)?.data ??
    null;
  const position = positionOf(observations);
  const state = {
    position,
    facing: observations.some((observation) => observation.kind === "overworld")
      ? ((data("overworld") as { facing?: string }).facing ?? null)
      : null,
    scene: data("scene"),
    menu: data("menu"),
    battle: data("battle"),
    dialog: data("dialog"),
  };
  return Object.values(state).some((value) => value !== null)
    ? canonicalJson(state)
    : (framebufferSha256 ?? "unobserved");
}

/** Detect varied loops by repeated semantic states, not identical actions. */
function recurringStateTurns(states: readonly string[]): number | null {
  const window = states.slice(-FREE_PLAY_STALL_TURNS);
  if (window.length < FREE_PLAY_REPEAT_TURNS * 2) return null;
  const revisits = window.length - new Set(window).size;
  return revisits >= Math.ceil(window.length / 2) ? window.length : null;
}

function observe(io: GbaDriverIo): GbaEmulatorObservation[] {
  const observations: GbaEmulatorObservation[] = [];
  for (const kind of OBSERVED_KINDS) {
    try {
      observations.push(io.observe(kind));
    } catch {
      // Not every kind is meaningful in every state (no battle in the
      // overworld). A missing view is context the model simply does not get.
    }
  }
  return observations;
}

function stateEvidence(
  observations: readonly GbaEmulatorObservation[],
  provenance: RunFreePlayInput["provenance"],
): FreePlayTurnEvidence["decision"] {
  return FreePlayTurnEvidenceSchema.shape.decision.parse({
    observations,
    provenance: provenance?.() ?? null,
  });
}

function evidenceProgress(progress: FreePlayProgress): FreePlayTurnEvidence["progressBefore"] {
  return {
    ...progress,
    maps: progress.maps.slice(-256).map((mapId) => mapId.slice(0, 200)),
  };
}

function exceptionEvidence(error: unknown): FreePlayTurnEvidence["actionResult"] {
  const message = error instanceof Error ? error.message : String(error);
  const adapter = error instanceof EnvironmentAdapterActionError ? error : null;
  return {
    source: "exception",
    name: error instanceof Error ? error.name || "Error" : "Error",
    // Never truncate a result into a plausible-looking partial. Oversized
    // exception text is unavailable; the typed fields still name the refusal.
    message: message.length <= 4_096 ? message : null,
    errorCode: adapter?.errorCode ?? null,
    retryable: adapter?.retryable ?? null,
  };
}

function finalize(
  record: FreePlayTurn,
  evidence: FreePlayTurnEvidence,
  onTurn: RunFreePlayInput["onTurn"],
): FreePlayTurn {
  const validated = FreePlayTurnSchema.parse(record);
  onTurn?.(validated, FreePlayTurnEvidenceSchema.parse(evidence));
  return validated;
}

/** How many checkpoints a listing effect names before it counts the rest. */
const CHECKPOINT_LISTING_LIMIT = 6;

/**
 * Dispatch a body action to the checkpoint port and say what happened.
 *
 * The returned line is the whole effect: a rewind's result is not readable
 * from a state diff, exactly as a dialog's transcript is not, so the port's
 * own account is what he gets. Throws propagate — the caller renders them as
 * the rejection they are.
 */
function applyBodyAction(
  action: FreePlayBodyAction,
  checkpoints: FreePlayCheckpointPort,
  continuity: {
    notes: string | null;
    objective: string | null;
    position: GbaPosition | null;
  },
): Described {
  if (action.kind === "save_checkpoint") {
    const saved = checkpoints.save({
      ...(action.label === undefined ? {} : { label: action.label }),
      position: continuity.position,
      continuity: { notes: continuity.notes, objective: continuity.objective },
    });
    const label = saved.label === null ? "" : ` (${saved.label})`;
    return described(
      `saved checkpoint ${saved.checkpointId}${label}, captured ${saved.capturedAt}`,
      "you can restore it later by its id",
    );
  }
  if (action.kind === "restart_game") {
    checkpoints.restart();
    return described(
      "the game restarted from its configured beginning — the world rewound",
      "your notes are still yours",
    );
  }
  if (action.checkpointId === undefined) {
    const listed = checkpoints.list();
    if (listed.length === 0) {
      return described("no checkpoints exist yet", "the beginning is still restart_game away");
    }
    const shown = listed
      .slice(0, CHECKPOINT_LISTING_LIMIT)
      .map((checkpoint) => {
        const label = checkpoint.label === null ? "" : ` (${checkpoint.label})`;
        const where =
          checkpoint.position === null
            ? ""
            : ` at ${checkpoint.position.mapId} (${String(checkpoint.position.x)},${String(checkpoint.position.y)})`;
        return `${checkpoint.checkpointId}${label}${where}`;
      })
      .join("; ");
    const more =
      listed.length > CHECKPOINT_LISTING_LIMIT
        ? `; and ${String(listed.length - CHECKPOINT_LISTING_LIMIT)} older`
        : "";
    return described(
      `your checkpoints, newest first: ${shown}${more}`,
      "load one by its id, or restart_game for the beginning",
    );
  }
  const restored = checkpoints.load(action.checkpointId);
  const label = restored.label === null ? "" : ` (${restored.label})`;
  return described(
    `restored checkpoint ${restored.checkpointId}${label}, captured ${restored.capturedAt} — the world is as it was then`,
    "your notes are still yours",
  );
}

/** An accepted rewind's effect: the port's account, plus where he now stands. */
function rewindEffect(
  body: Described,
  before: readonly GbaEmulatorObservation[],
  after: readonly GbaEmulatorObservation[],
): ObservedEffect {
  const from = positionOf(before);
  const to = positionOf(after);
  return {
    ...body,
    refused: null,
    position: to,
    enteredMap: from !== null && to !== null && from.mapId !== to.mapId,
  };
}

function describeRejection(result: EnvironmentActionResult): string {
  if (result.status === "failed") return `${result.errorCode}:${result.message}`;
  if (result.status === "denied" || result.status === "cancelled") return result.reason;
  return "";
}

/**
 * What a refusal means in play terms, for the effect line the model reads.
 *
 * The raw code already lands in `detail`, but detail stays in the journal —
 * the history the model sees carries only the effect. Telling him "position
 * unchanged" about an action the adapter never ran taught him wrong lessons
 * ("the long repeat behaved oddly"); the codes below are the refusals a
 * playthrough actually meets, translated into what to do about them.
 */
const REJECTION_HINTS: Readonly<Record<string, string>> = {
  // Deliberately about *this screen*, not the cartridge. The older wording
  // ("this cartridge has no decoded state profile yet") described a permanent
  // defect, so a boot sequence — where nothing decodes for minutes and then
  // everything does — read as a dead decoder, and he stopped reaching for the
  // helpers long after they started working again.
  semantic_state_unavailable:
    "this screen carries no decoded state — normal on intros, help screens and boot; " +
    "read the frame and press buttons, and the helpers return when a screen decodes",
  walk_exit_unsupported:
    "this exit exists, but this body cannot safely activate it with walk_to; " +
    "retrying under unchanged capability evidence returns the same refusal without dispatch",
  input_bound_exceeded: "it asked for more button presses than one action may spend",
  frame_bound_exceeded: "it asked for more frames than one action may spend",
  dialog_not_open:
    "the game is not treating any dialog as open — if text is visibly on screen, a script or " +
    "fanfare is holding it; advance a few frames and look again",
  walk_requires_overworld: "walking needs overworld control — close whatever is open first",
  no_path_to_target: "no walkable route to that tile exists from here",
  walk_target_outside_map: "that tile is off the loaded map",
  walk_target_impassable: "that tile is a wall or obstacle, not floor",
  map_grid_unavailable: "no map is loaded to route over — walking waits for the overworld",
  naming_screen_not_open: "no naming screen is open to type on",
  menu_not_open: "no menu is open to select from",
  menu_entry_not_found: "no open menu entry has that id — use an id the menu view lists",
  menu_not_navigable: "that screen is typed on with enter_text, not selected from",
  menu_window_scrolled: "this list is scrolled; move through it with single presses",
  capability_not_granted: "this session does not allow that action",
};

function describeRejectionForPlayer(errorCode: string | null, raw: string): Described {
  const hint = errorCode === null ? undefined : REJECTION_HINTS[errorCode];
  if (hint === undefined) return described("rejected, nothing ran", raw);
  // The adapter appends per-refusal information after an em-dash — the map's
  // bounds, the nearest reachable tile. The static hint says what went wrong;
  // that detail is what to do instead, so it rides along.
  const detailAt = raw.lastIndexOf(" — ");
  const detail = detailAt === -1 ? "" : `;${raw.slice(detailAt + 2)}`;
  return described("rejected, nothing ran", `${hint}${detail}`);
}

function bounded(value: unknown): string {
  if (value instanceof Error) {
    // Some provider SDKs throw with an empty message and put the useful part in
    // `name` or `cause`. A blank detail makes a recorded failure worthless, so
    // gather all three.
    const cause = value.cause;
    const causeText = cause instanceof Error ? cause.message : cause === undefined ? "" : String(cause);
    // Provider SDK errors carry the useful part on non-standard fields.
    const extra = value as unknown as { statusCode?: number; responseBody?: string };
    const status = extra.statusCode === undefined ? "" : `HTTP ${String(extra.statusCode)}`;
    const body = typeof extra.responseBody === "string" ? extra.responseBody : "";
    const text = [value.name, value.message, status, causeText, body]
      .filter((part) => part.length > 0)
      .join(": ");
    return (text.length > 0 ? text : "unknown error").slice(0, 400);
  }
  return String(value).slice(0, 400);
}

/**
 * Did the world let the previous plan stand?
 *
 * A turn that was blocked, or that only turned the character, is a turn where
 * revising the plan is the *correct* response. Scoring those as incoherence
 * punishes exactly the adaptation good feedback is meant to produce.
 */
/**
 * The screen, labelled with tile coordinates when the world decodes a position.
 *
 * Undecoded screens — titles, cutscenes, battles — have no overworld tile to
 * anchor to and get the plain picture, which is correct: there is no grid to
 * draw and inventing one would be a coordinate frame that means nothing.
 */
function framePngAt(
  framePng:
    | ((anchor?: { readonly playerX: number; readonly playerY: number }) => Uint8Array | null)
    | undefined,
  position: GbaPosition | null,
): Uint8Array | null {
  if (framePng === undefined) return null;
  return (position === null ? framePng() : framePng({ playerX: position.x, playerY: position.y })) ?? null;
}

function planSurvived(effect: string | null): boolean {
  if (effect === null) return false;
  return !(
    effect.includes("blocked") ||
    effect.includes("turned to face") ||
    effect.includes("no visible change") ||
    effect.includes("position unchanged") ||
    // The frame moved but nothing decodable did — whether the plan landed is
    // unknowable from here, so the turn stays unscored rather than guessed.
    effect.startsWith("screen changed") ||
    // A refused action never ran; re-planning after one is correctness.
    effect.startsWith("rejected")
  );
}

function coherence(turns: readonly FreePlayTurn[]): { coherence: number | null } {
  let scoreable = 0;
  let matched = 0;
  for (let index = 1; index < turns.length; index += 1) {
    const previous = turns[index - 1];
    const current = turns[index];
    if (previous?.intent == null || current?.action == null) continue;
    // Only score turns where nothing stopped him. Otherwise this measures plan
    // stability — which correctly drops when he routes around furniture — rather
    // than whether he does what he says.
    if (!planSurvived(previous.effect)) continue;
    scoreable += 1;
    if (intentMatchesAction(previous.intent, current.action)) matched += 1;
  }
  return { coherence: scoreable === 0 ? null : matched / scoreable };
}

/**
 * Did a stated intent reference the action that followed?
 *
 * Intent is free text, so this is a keyword heuristic and a deliberate **lower
 * bound**: a coherent turn phrased unusually scores as a miss. It exists to
 * separate reasoning from post-hoc narration at the population level, which is
 * why the result is reported and never gated.
 */
export function intentMatchesAction(intent: string, action: FreePlayAction): boolean {
  const text = intent.toLowerCase();
  if (action.kind === "button_press") {
    const synonyms: Record<string, string[]> = {
      up: ["up", "north", "forward"],
      down: ["down", "south", "back"],
      left: ["left", "west"],
      right: ["right", "east"],
      a: [" a ", "confirm", "interact", "talk", "select", "advance"],
      b: [" b ", "cancel", "back out", "exit"],
      start: ["start", "menu", "pause"],
      select: ["select"],
      l: [" l "],
      r: [" r "],
    };
    const needles = synonyms[action.button] ?? [action.button];
    const padded = ` ${text} `;
    return needles.some((needle) => padded.includes(needle));
  }
  if (action.kind === "walk_to") {
    return ["walk", "go", "head", "toward", "cross", "route", "move", "reach", "exit"].some((n) =>
      text.includes(n),
    );
  }
  if (action.kind === "enter_text") {
    return (
      ["name", "type", "spell", "enter", "call"].some((n) => text.includes(n)) ||
      text.includes(action.text.toLowerCase())
    );
  }
  if (action.kind === "frame_advance") {
    return ["wait", "advance", "let", "watch", "frame", "continue"].some((n) => text.includes(n));
  }
  if (action.kind === "select_menu_entry") {
    return (
      ["choose", "select", "pick", "use", "menu", "option"].some((n) => text.includes(n)) ||
      text.includes(action.entryId.toLowerCase())
    );
  }
  if (action.kind === "load_checkpoint") {
    return (
      ["load", "checkpoint", "restore", "rewind", "go back"].some((n) => text.includes(n)) ||
      (action.checkpointId !== undefined && text.includes(action.checkpointId.toLowerCase()))
    );
  }
  if (action.kind === "save_checkpoint") {
    return (
      ["save", "checkpoint", "remember this", "bank"].some((n) => text.includes(n)) ||
      (action.label !== undefined && text.includes(action.label.toLowerCase()))
    );
  }
  if (action.kind === "restart_game") {
    return ["restart", "start over", "start again", "reset", "begin", "new game"].some((n) =>
      text.includes(n),
    );
  }
  return ["wait", "pause", "hold"].some((n) => text.includes(n));
}
