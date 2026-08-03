import {
  GbaEmulatorActionSchema,
  type EnvironmentActionResult,
  type GbaEmulatorAction,
  type GbaEmulatorObservation,
  type GbaEmulatorObservationKind,
} from "@clankie/interactive-environment";
import { EnvironmentAdapterActionError } from "@clankie/environment-runtime";
import { z } from "zod";
import {
  FREE_PLAY_INTENT_MAX,
  FREE_PLAY_INTERJECTION_MAX,
  FREE_PLAY_MONOLOGUE_MAX,
  FREE_PLAY_NOTES_MAX,
  FREE_PLAY_OBJECTIVE_MAX,
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
import type { GbaDriverIo } from "./driver.ts";
import {
  FreePlayProgressTracker,
  observeEffect,
  positionOf,
  type FreePlayProgress,
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
     * A standing goal that outlives the turn. Carried forward until he changes
     * it, so plans stop churning every turn.
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
  /**
   * Turns since he last stood on a tile he had never stood on before, surfaced
   * only once it is long enough to mean something. The loop always computed
   * this; a measured run sat at 85 while the number stayed in the summary
   * nobody reads mid-game. Information, never advice: a long conversation
   * stalls it legitimately, and what to do about it stays his call.
   */
  stalledForTurns: number | null;
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

/**
 * The decision-maker. Returns an unvalidated value on purpose: a model can
 * emit anything, and rejecting it is part of what this loop must survive.
 */
export interface FreePlayMind {
  decide(view: FreePlayView): Promise<unknown>;
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
     */
    effect: z.string().max(200).nullable(),
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
 * Somewhere for a person's message to wait until the next turn reads it.
 *
 * Injection is asynchronous — a question arrives while he is mid-decision — but
 * it is consumed at a turn boundary so it cannot interrupt an action already in
 * flight. Only the most recent message survives: a backlog of stale questions
 * answered several turns late reads worse than the newest one answered now.
 */
export class InterjectionQueue {
  private pending: string | null = null;

  /** Called from outside the loop, whenever someone says something. */
  public offer(message: string): void {
    const trimmed = message.trim().slice(0, FREE_PLAY_INTERJECTION_MAX);
    if (trimmed.length > 0) this.pending = trimmed;
  }

  /** Taken once, at a turn boundary. */
  public take(): string | null {
    const message = this.pending;
    this.pending = null;
    return message;
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
  /** Restore one by id. Throws with a self-describing reason on refusal. */
  load(checkpointId: string): FreePlayCheckpointSummary;
  /** Reboot to the configured starting savestate. */
  restart(): void;
}

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
  onTurn?: (turn: FreePlayTurn) => void;
  /**
   * Called after an action has settled and progress has consumed its observed
   * effect. Benchmarks use this boundary so they measure what the adapter
   * actually accepted and what state resulted, never the mind's proposal.
   */
  onSettledTurn?: (event: FreePlaySettledTurn) => void;
  /** Latest framebuffer digest, when a core exposes one. */
  framebufferSha256?: () => string | null;
  /** Latest rendered screen as PNG bytes, when a core exposes one. */
  framePng?: () => Uint8Array | null;
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
  const historyLimit = input.historyLimit ?? 8;
  const turns: FreePlayTurn[] = [];
  const history: { intent: string; action: FreePlayAction; outcome: string; effect: string }[] = [];
  // Bounded on entry: seeds come from validated receipts today, but the bound
  // is the loop's own invariant, not the caller's promise.
  let notes: string | null = input.initialNotes?.slice(0, FREE_PLAY_NOTES_MAX) ?? null;
  let objective: string | null = input.initialObjective?.slice(0, FREE_PLAY_OBJECTIVE_MAX) ?? null;
  let lastSpokeTurn: number | null = null;
  const volition: FreePlayVolition = { offered: 0, taken: 0, suppressed: 0, skipped: 0 };
  const cooldown = input.speakCooldownTurns ?? FREE_PLAY_SPEAK_COOLDOWN_TURNS;
  const recentlySaid: string[] = [];
  const progress = new FreePlayProgressTracker();
  progress.seed(positionOf(observe(input.io)));

  for (let turn = 0; turn < input.turns; turn += 1) {
    if (input.shouldStop?.() === true) break;
    const observations = observe(input.io);
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
      notes,
      objective,
      interjection: null,
      reply: null,
      speak: null,
      speakSuppressed: false,
      speakWanted: false,
    };

    // Taken at the boundary, before he decides, so a question reaches the turn
    // it was asked during rather than interrupting one already dispatched.
    const interjection = input.interjections?.take() ?? null;
    record.interjection = interjection;

    let raw: unknown;
    try {
      const sinceNewTile = progress.snapshot().turnsSinceNewTile;
      raw = await input.mind.decide({
        turn,
        observations,
        framePng: input.framePng?.() ?? null,
        refusedHere: progress.refusedFrom(positionOf(observations)),
        // Only when he has a position to be stuck at: mid-battle and mid-warp
        // the tile counter stalls for reasons that need no telling.
        stalledForTurns:
          sinceNewTile >= FREE_PLAY_STALL_TURNS && positionOf(observations) !== null ? sinceNewTile : null,
        notes,
        objective,
        interjection,
        turnsSinceSpoke: lastSpokeTurn === null ? null : turn - lastSpokeTurn,
        audience: input.audience ?? null,
        history: [...history],
      });
    } catch (error) {
      // A model that errors must not end the playthrough; the turn is lost and
      // the loop continues so a long run survives a transient failure.
      record.detail = bounded(error);
      turns.push(finalize(record, input.onTurn));
      continue;
    }

    const parsed = FreePlayDecisionSchema.safeParse(raw);
    if (!parsed.success) {
      record.outcome = "invalid_decision";
      record.detail = bounded(parsed.error.issues.map((issue) => issue.path.join(".")).join(","));
      turns.push(finalize(record, input.onTurn));
      continue;
    }

    record.monologue = parsed.data.monologue;
    record.intent = parsed.data.intent;
    // He keeps his notes unless he rewrites them, so silence is not amnesia.
    if (parsed.data.notes !== null && parsed.data.notes !== undefined) notes = parsed.data.notes;
    record.notes = notes;
    // Same rule as notes: an omitted objective is "unchanged", not "abandoned".
    if (parsed.data.objective !== null && parsed.data.objective !== undefined) {
      objective = parsed.data.objective;
    }
    record.objective = objective;
    record.reply = parsed.data.reply ?? null;

    record.action = parsed.data.action;
    const chosen = parsed.data.action;

    let accepted = false;
    let actionOutcome: Record<string, unknown> | undefined;
    let rejection: string | null = null;
    /** Set only by an accepted body action, whose effect no diff can read. */
    let bodySummary: string | null = null;
    if (chosen.kind === "load_checkpoint" || chosen.kind === "restart_game") {
      // The body's saved time, not the emulator (ADR 0075): dispatched to the
      // injected checkpoint port, never to io.act — the frozen catalog does
      // not change, and a body without the port refuses truthfully.
      if (input.checkpoints === undefined) {
        record.outcome = "rejected_by_adapter";
        record.detail = "checkpoints_unavailable";
        rejection = "rejected, nothing ran — this body has no saved time to move through";
      } else {
        try {
          bodySummary = applyBodyAction(chosen, input.checkpoints);
          record.outcome = "accepted";
          accepted = true;
          record.detail = bounded(bodySummary);
        } catch (error) {
          // The port's gates speak for themselves: checkpoint_not_found, a
          // digest mismatch, a foreign ROM. The reason is the effect.
          record.outcome = "rejected_by_adapter";
          record.detail = bounded(error);
          rejection = `rejected, nothing ran — ${bounded(error)}`;
        }
      }
    } else {
      try {
        const result = await input.io.act(chosen);
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
        }
      } catch (error) {
        record.outcome = "rejected_by_adapter";
        record.detail = bounded(error);
        rejection = describeRejectionForPlayer(
          error instanceof EnvironmentAdapterActionError ? error.errorCode : null,
          bounded(error),
        );
      }
    }

    // Re-observe and diff, so the turn records what changed rather than only
    // that the adapter took the button. The frame digest is sampled digest-to-
    // digest around the action — the core only runs frames the action asked
    // for, so the comparison spans exactly what this turn did to the screen.
    //
    // A rejected action never ran, so diffing around it would invent an effect
    // — the worst case was a refused advance_dialog reading as "read no new
    // text", a success-shaped sentence about an action that did not happen.
    // The rejection reason IS the effect of that turn, and it is the one line
    // the model actually sees (detail stays journal-only).
    const frameAfter = input.framebufferSha256?.() ?? null;
    const afterObservations = accepted ? observe(input.io) : observations;
    const effect =
      rejection !== null
        ? { summary: rejection, refused: null, position: positionOf(observations), enteredMap: false }
        : bodySummary !== null
          ? // A rewind's effect is what the port reports plus where he now
            // stands — a state diff around a restored world would only restate
            // it, and the restored position must still reach the progress
            // tracker so the tile memory follows him back.
            rewindEffect(bodySummary, observations, afterObservations)
          : observeEffect({
              before: observations,
              // Body actions never reach here, so this narrows to the emulator kinds.
              after: afterObservations,
              action: chosen as GbaEmulatorAction,
              outcome: actionOutcome,
              screenChanged:
                record.framebufferSha256 !== null && frameAfter !== null
                  ? frameAfter !== record.framebufferSha256
                  : null,
            });
    progress.record(effect, accepted);
    record.effect = effect.summary.slice(0, 200);

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
      effect: effect.summary,
    });
    if (history.length > historyLimit) history.shift();
    const settledTurn = finalize(record, input.onTurn);
    turns.push(settledTurn);
    input.onSettledTurn?.({
      turn: settledTurn,
      before: observations,
      after: afterObservations,
      progress: progress.snapshot(),
    });
  }

  return {
    turns,
    accepted: turns.filter((t) => t.outcome === "accepted").length,
    progress: progress.snapshot(),
    volition,
    ...coherence(turns),
  };
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

function finalize(record: FreePlayTurn, onTurn: RunFreePlayInput["onTurn"]): FreePlayTurn {
  const validated = FreePlayTurnSchema.parse(record);
  onTurn?.(validated);
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
function applyBodyAction(action: FreePlayBodyAction, checkpoints: FreePlayCheckpointPort): string {
  if (action.kind === "restart_game") {
    checkpoints.restart();
    return "the game restarted from its configured beginning — the world rewound, your notes are still yours";
  }
  if (action.checkpointId === undefined) {
    const listed = checkpoints.list();
    if (listed.length === 0) return "no checkpoints exist yet — the beginning is still restart_game away";
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
    return `your checkpoints, newest first: ${shown}${more} — load one by its id, or restart_game for the beginning`;
  }
  const restored = checkpoints.load(action.checkpointId);
  const label = restored.label === null ? "" : ` (${restored.label})`;
  return `restored checkpoint ${restored.checkpointId}${label}, captured ${restored.capturedAt} — the world is as it was then; your notes are still yours`;
}

/** An accepted rewind's effect: the port's account, plus where he now stands. */
function rewindEffect(
  summary: string,
  before: readonly GbaEmulatorObservation[],
  after: readonly GbaEmulatorObservation[],
): { summary: string; refused: null; position: ReturnType<typeof positionOf>; enteredMap: boolean } {
  const from = positionOf(before);
  const to = positionOf(after);
  return {
    summary,
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
  input_bound_exceeded: "it asked for more button presses than one action may spend",
  frame_bound_exceeded: "it asked for more frames than one action may spend",
  dialog_not_open:
    "the game is not treating any dialog as open — if text is visibly on screen, a script or " +
    "fanfare is holding it; advance a few frames and look again",
  walk_requires_overworld: "walking needs overworld control — close whatever is open first",
  no_path_to_target: "no walkable route to that tile exists from here",
  map_grid_unavailable: "no map is loaded to route over — walking waits for the overworld",
  naming_screen_not_open: "no naming screen is open to type on",
  menu_not_open: "no menu is open to select from",
  menu_entry_not_found: "no open menu entry has that id — use an id the menu view lists",
  menu_not_navigable: "that screen is typed on with enter_text, not selected from",
  menu_window_scrolled: "this list is scrolled; move through it with single presses",
  capability_not_granted: "this session does not allow that action",
};

function describeRejectionForPlayer(errorCode: string | null, raw: string): string {
  const hint = errorCode === null ? undefined : REJECTION_HINTS[errorCode];
  return `rejected, nothing ran — ${hint ?? raw}`;
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
      ["load", "checkpoint", "restore", "rewind", "go back", "save"].some((n) => text.includes(n)) ||
      (action.checkpointId !== undefined && text.includes(action.checkpointId.toLowerCase()))
    );
  }
  if (action.kind === "restart_game") {
    return ["restart", "start over", "start again", "reset", "begin", "new game"].some((n) =>
      text.includes(n),
    );
  }
  return ["wait", "pause", "hold"].some((n) => text.includes(n));
}
