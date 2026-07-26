import {
  GbaEmulatorActionSchema,
  type EnvironmentActionResult,
  type GbaEmulatorAction,
  type GbaEmulatorObservation,
  type GbaEmulatorObservationKind,
} from "@clankie/interactive-environment";
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
    action: GbaEmulatorActionSchema,
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
  history: readonly { intent: string; action: GbaEmulatorAction; outcome: string; effect: string }[];
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
    action: GbaEmulatorActionSchema.nullable(),
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

const OBSERVED_KINDS: GbaEmulatorObservationKind[] = ["danger", "overworld", "battle", "dialog", "menu"];

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

export interface RunFreePlayInput {
  io: GbaDriverIo;
  mind: FreePlayMind;
  turns: number;
  /** Called after every turn so a CLI can stream the playthrough. */
  onTurn?: (turn: FreePlayTurn) => void;
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
  /** Who is listening. Absent means he is alone and will reasonably stay quiet. */
  audience?: string;
  /**
   * Checked at each turn boundary; true ends the playthrough cleanly there.
   * This is how an asked stop (ADR 0063) or an exhausted duration budget lands
   * without tearing down a turn mid-dispatch.
   */
  shouldStop?: () => boolean;
}

export async function runFreePlay(input: RunFreePlayInput): Promise<FreePlayResult> {
  const historyLimit = input.historyLimit ?? 8;
  const turns: FreePlayTurn[] = [];
  const history: { intent: string; action: GbaEmulatorAction; outcome: string; effect: string }[] = [];
  let notes: string | null = null;
  let objective: string | null = null;
  let lastSpokeTurn: number | null = null;
  const volition: FreePlayVolition = { offered: 0, taken: 0, suppressed: 0 };
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
    };

    // Taken at the boundary, before he decides, so a question reaches the turn
    // it was asked during rather than interrupting one already dispatched.
    const interjection = input.interjections?.take() ?? null;
    record.interjection = interjection;

    let raw: unknown;
    try {
      raw = await input.mind.decide({
        turn,
        observations,
        framePng: input.framePng?.() ?? null,
        refusedHere: progress.refusedFrom(positionOf(observations)),
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

    // Voice decides speech when one is wired; the player's own speak/reply are
    // the single-agent fallback (ADR 0056). Voice cannot act, which is what
    // makes "an interjection is not a route" structural rather than a prompt.
    let wants = parsed.data.speak ?? null;
    if (input.voice !== undefined) {
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
      const ready = lastSpokeTurn === null || turn - lastSpokeTurn >= cooldown;
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
    record.action = parsed.data.action;

    let accepted = false;
    try {
      const result = await input.io.act(parsed.data.action);
      // A rejection arrives as a status, not only as a throw: the adapter fails
      // closed on an illegal button, an exceeded frame bound, a missing
      // capability, or a stale goal version. Both shapes are legitimate answers
      // rather than crashes, so both keep the playthrough running.
      if (result.status === "completed") {
        record.outcome = "accepted";
        accepted = true;
        record.detail = bounded(JSON.stringify(result.outcome));
      } else {
        record.outcome = "rejected_by_adapter";
        record.detail = bounded(`${result.status}:${describeRejection(result)}`);
      }
    } catch (error) {
      record.outcome = "rejected_by_adapter";
      record.detail = bounded(error);
    }

    // Re-observe and diff, so the turn records what changed rather than only
    // that the adapter took the button.
    const effect = observeEffect({
      before: observations,
      after: observe(input.io),
      action: parsed.data.action,
    });
    progress.record(effect, accepted);
    record.effect = effect.summary.slice(0, 200);

    history.push({
      intent: parsed.data.intent,
      action: parsed.data.action,
      outcome: record.outcome,
      effect: effect.summary,
    });
    if (history.length > historyLimit) history.shift();
    turns.push(finalize(record, input.onTurn));
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

function describeRejection(result: EnvironmentActionResult): string {
  if (result.status === "failed") return `${result.errorCode}:${result.message}`;
  if (result.status === "denied" || result.status === "cancelled") return result.reason;
  return "";
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
    effect.includes("position unchanged")
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
export function intentMatchesAction(intent: string, action: GbaEmulatorAction): boolean {
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
  if (action.kind === "frame_advance") {
    return ["wait", "advance", "let", "watch", "frame", "continue"].some((n) => text.includes(n));
  }
  return ["wait", "pause", "hold"].some((n) => text.includes(n));
}
