import {
  GbaEmulatorActionSchema,
  type EnvironmentActionResult,
  type GbaEmulatorAction,
  type GbaEmulatorObservation,
  type GbaEmulatorObservationKind,
} from "@clankie/interactive-environment";
import { z } from "zod";
import { canonicalJson, sha256 } from "./core-double.ts";
import type { GbaDriverIo } from "./driver.ts";

/**
 * Free play: the model chooses, not an algorithm.
 *
 * The existing scenario drivers compute every action (`nextRealRouteStep` is
 * BFS, move selection is an argmax). They are deterministic and their receipts
 * are byte-identical across two fresh cores. This driver is the opposite: the
 * decision comes from a model, so no run reproduces another.
 *
 * That trade is deliberate and it does not weaken the deterministic scenarios,
 * which still run unchanged. What a free-play run asserts instead is recorded
 * per turn: that every action was legal, that observation → monologue → action
 * → outcome is causally linked, that bounds held, and how often stated intent
 * matched the next action.
 */

/** Model text is untrusted and reaches operator surfaces, so it stays bounded. */
export const FREE_PLAY_MONOLOGUE_MAX = 600;
export const FREE_PLAY_INTENT_MAX = 200;

export const FreePlayDecisionSchema = z
  .object({
    /** Why this action, in Clankie's own voice. */
    monologue: z.string().min(1).max(FREE_PLAY_MONOLOGUE_MAX),
    /** What he plans to do next — scored against the action he then takes. */
    intent: z.string().min(1).max(FREE_PLAY_INTENT_MAX),
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
  /** Prior turns, most recent last, so the model has continuity. */
  history: readonly { intent: string; action: GbaEmulatorAction; outcome: string }[];
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
    action: GbaEmulatorActionSchema.nullable(),
    outcome: z.enum(["accepted", "rejected_by_adapter", "invalid_decision", "mind_failed"]),
    /** Bounded reason when the turn did not produce an accepted action. */
    detail: z.string().max(400).nullable(),
  })
  .strict();
export type FreePlayTurn = z.infer<typeof FreePlayTurnSchema>;

export interface FreePlayResult {
  turns: FreePlayTurn[];
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
}

export async function runFreePlay(input: RunFreePlayInput): Promise<FreePlayResult> {
  const historyLimit = input.historyLimit ?? 8;
  const turns: FreePlayTurn[] = [];
  const history: { intent: string; action: GbaEmulatorAction; outcome: string }[] = [];

  for (let turn = 0; turn < input.turns; turn += 1) {
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
    };

    let raw: unknown;
    try {
      raw = await input.mind.decide({
        turn,
        observations,
        framePng: input.framePng?.() ?? null,
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
    record.action = parsed.data.action;

    try {
      const result = await input.io.act(parsed.data.action);
      // A rejection arrives as a status, not only as a throw: the adapter fails
      // closed on an illegal button, an exceeded frame bound, a missing
      // capability, or a stale goal version. Both shapes are legitimate answers
      // rather than crashes, so both keep the playthrough running.
      if (result.status === "completed") {
        record.outcome = "accepted";
        record.detail = bounded(JSON.stringify(result.outcome));
      } else {
        record.outcome = "rejected_by_adapter";
        record.detail = bounded(`${result.status}:${describeRejection(result)}`);
      }
    } catch (error) {
      record.outcome = "rejected_by_adapter";
      record.detail = bounded(error);
    }

    history.push({
      intent: parsed.data.intent,
      action: parsed.data.action,
      outcome: record.outcome,
    });
    if (history.length > historyLimit) history.shift();
    turns.push(finalize(record, input.onTurn));
  }

  return { turns, accepted: turns.filter((t) => t.outcome === "accepted").length, ...coherence(turns) };
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

function coherence(turns: readonly FreePlayTurn[]): { coherence: number | null } {
  let scoreable = 0;
  let matched = 0;
  for (let index = 1; index < turns.length; index += 1) {
    const previous = turns[index - 1];
    const current = turns[index];
    if (previous?.intent == null || current?.action == null) continue;
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
