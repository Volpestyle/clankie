import type { LanguageModel } from "ai";
import { streamObject } from "ai";

/** Derived from the SDK signature so it tracks their type, not a guessed name. */
type StreamProviderOptions = NonNullable<Parameters<typeof streamObject>[0]["providerOptions"]>;
import { z } from "zod";
import { type FreePlayMind, type FreePlayView } from "./free-play.ts";

/**
 * The wire schema the model fills in — deliberately **flat**.
 *
 * `FreePlayDecisionSchema` nests a discriminated union for the action, which
 * compiles to `oneOf` in JSON Schema, and OpenAI's structured output rejects
 * that outright: "In context=('properties','action'), 'oneOf' is not
 * permitted." So the model answers a flat shape and this module reassembles the
 * real action. The strict union still guards the boundary — the driver
 * re-validates every decision — this only changes what a provider is asked for.
 */
const FreePlayWireDecisionSchema = z
  .object({
    monologue: z.string(),
    intent: z.string(),
    notes: z.string().nullable(),
    actionKind: z.enum(["button_press", "frame_advance", "wait"]),
    button: z.enum(["up", "down", "left", "right", "a", "b", "start", "select", "l", "r"]).nullable(),
    holdFrames: z.number().int().nullable(),
    repeat: z.number().int().nullable(),
    frames: z.number().int().nullable(),
    durationMs: z.number().int().nullable(),
  })
  .strict();

/**
 * A press long enough to commit a step rather than only turn.
 *
 * Supplied when the model leaves `holdFrames` null. This is not choosing his
 * move — the button and the direction are entirely his — it is interpreting an
 * underspecified press, and the alternative is discarding an otherwise valid
 * decision. Left unhandled it cost 15 of 20 turns once the flat wire schema
 * grew enough fields for the model to start omitting this one.
 */
const DEFAULT_HOLD_FRAMES = 16;

/** Reassemble the catalogued action. Returns the raw shape; the driver validates. */
function toDecision(wire: z.infer<typeof FreePlayWireDecisionSchema>): unknown {
  const action =
    wire.actionKind === "button_press"
      ? {
          kind: "button_press",
          button: wire.button,
          holdFrames: wire.holdFrames ?? DEFAULT_HOLD_FRAMES,
          ...(wire.repeat === null || wire.repeat === 1 ? {} : { repeat: wire.repeat }),
        }
      : wire.actionKind === "frame_advance"
        ? { kind: "frame_advance", frames: wire.frames }
        : { kind: "wait", durationMs: wire.durationMs };
  return { monologue: wire.monologue, intent: wire.intent, notes: wire.notes, action };
}

/**
 * A model-backed decision-maker.
 *
 * The prompt deliberately does not tell Clankie *what* to do. It gives him the
 * decoded state and the action vocabulary and asks him to choose — the whole
 * point of free play is that the route is not supplied. Anything that reads
 * like "go to the lab" belongs in an operator message, not here.
 */
export const FREE_PLAY_SYSTEM_PROMPT = [
  "You are Clankie, playing Pokémon FireRed yourself.",
  "Each turn you see the actual game screen and the decoded state, and you",
  "choose one action. Look at the screen: it shows walls, furniture, doors,",
  "stairs, NPCs, and text that the decoded state does not describe. The decoded",
  "state is for exact values — position, HP, PP, legal moves.",
  "",
  "Play the way you actually want to play. You are not following a script and",
  "nobody has given you a route. Form your own goals, change your mind, be",
  "curious. If you are unsure what is on screen, advancing frames to look is a",
  "legitimate choice.",
  "",
  "Each turn return three things:",
  "- monologue: your honest thinking about this moment, in your own voice.",
  "- intent: what you plan to do next, in a few words.",
  "- notes: your own running notes, carried to every later turn. Keep what will",
  "  still matter — the room layout you have worked out, what you already tried,",
  "  where you are heading. Rewrite them freely; return null to leave them as",
  "  they are. Nothing else writes this, and nothing else remembers for you.",
  "- action: exactly one of",
  '    {"kind":"button_press","button":"up|down|left|right|a|b|start|select|l|r","holdFrames":N,"repeat":N}',
  '    {"kind":"frame_advance","frames":N}',
  '    {"kind":"wait","durationMs":N}',
  "",
  "Always give holdFrames on a button press — 16 is a reliable step; a short",
  "hold only turns you. repeat presses the same button that many times in ONE",
  "action (max 16), which",
  "is how you cross a corridor without spending a decision per tile. A short tap",
  "only turns you; a step needs a longer hold or a repeat.",
  "",
  "After each action you are told what actually changed — whether you moved,",
  "or the direction was blocked. Directions already refused from your current",
  "tile are listed too. Use that instead of pressing into the same wall.",
  "",
  "The emulator has no clock and waits for you, so think before you press.",
  "Say what you actually intend — your stated intent is compared against what",
  "you do next, so narrating something you are not going to do is worse than",
  "admitting uncertainty.",
].join("\n");

export interface ModelFreePlayMindOptions {
  model: LanguageModel;
  /** Extra context an operator can inject, e.g. a question asked mid-play. */
  systemSuffix?: string;
  maxRetries?: number;
  /**
   * Provider options from the resolved configuration. Some providers (the Codex
   * OAuth path in particular) reject a call that omits them, so a caller
   * holding a `ConfiguredLanguageModel` should pass `modelOptions.providerOptions`.
   */
  providerOptions?: StreamProviderOptions;
}

export function createModelFreePlayMind(options: ModelFreePlayMindOptions): FreePlayMind {
  const system =
    options.systemSuffix === undefined
      ? FREE_PLAY_SYSTEM_PROMPT
      : `${FREE_PLAY_SYSTEM_PROMPT}\n\n${options.systemSuffix}`;

  return {
    async decide(view: FreePlayView): Promise<unknown> {
      // Streamed on purpose. The Codex OAuth endpoint rejects a non-streaming
      // request outright with `{"detail":"Stream must be set to true"}`, and
      // streaming is accepted by every other configured provider, so this is
      // the portable call. The final object is still awaited whole — nothing
      // downstream consumes partial decisions.
      const stream = streamObject({
        model: options.model,
        schema: FreePlayWireDecisionSchema,
        system,
        // The screen goes in as an image alongside the decoded state. Looking at
        // the room is how he learns where the furniture is; the decoded state is
        // for the values a screenshot reads badly.
        messages: [
          {
            role: "user",
            content:
              view.framePng === null
                ? [{ type: "text" as const, text: renderView(view) }]
                : [
                    { type: "text" as const, text: renderView(view) },
                    // A `file` part, not the deprecated `image` part.
                    {
                      type: "file" as const,
                      mediaType: "image/png",
                      data: view.framePng,
                    },
                  ],
          },
        ],
        maxRetries: options.maxRetries ?? 1,
        providerOptions: options.providerOptions ?? {},
      });

      const settled = stream.object;
      // Claim the rejection now. Without a handler attached before the drain
      // throws, a failed call surfaces as an unsettled top-level await instead
      // of an error the loop can record.
      settled.catch(() => undefined);
      try {
        // The SDK does not issue the request until the stream is consumed, so
        // awaiting the object alone deadlocks. Drain it, discarding partials.
        for await (const _partial of stream.partialObjectStream) {
          // nothing downstream consumes a partial decision
        }
      } catch {
        // The same failure is reported by awaiting the settled object below.
      }
      return toDecision(await settled);
    },
  };
}

/** Render the decoded state as compact text. Never includes frame bytes. */
export function renderView(view: FreePlayView): string {
  const lines: string[] = [`Turn ${String(view.turn)}.`, "", "What you can see:"];
  if (view.observations.length === 0) {
    lines.push("  (no readable state this turn)");
  }
  for (const observation of view.observations) {
    lines.push(`  ${observation.kind}: ${JSON.stringify(stripEnvelope(observation))}`);
  }
  if (view.notes !== null && view.notes.length > 0) {
    lines.push("", "Your notes:", `  ${view.notes}`);
  }
  if (view.refusedHere.length > 0) {
    // What he already learned the hard way from this exact tile.
    lines.push("", `Already blocked from this tile: ${view.refusedHere.join(", ")}.`);
  }
  if (view.history.length > 0) {
    lines.push("", "Recently:");
    for (const entry of view.history) {
      // The effect, not just "accepted" — accepted only meant the button was taken.
      lines.push(`  intended "${entry.intent}" → ${describeAction(entry.action)} → ${entry.effect}`);
    }
  }
  lines.push("", "Choose your next action.");
  return lines.join("\n");
}

/** Drop transport fields the model has no use for and would only pay tokens on. */
function stripEnvelope(observation: FreePlayView["observations"][number]): unknown {
  const {
    schemaVersion: _schemaVersion,
    observationId: _observationId,
    ...rest
  } = observation as Record<string, unknown> & { schemaVersion?: unknown; observationId?: unknown };
  return rest;
}

function describeAction(action: FreePlayView["history"][number]["action"]): string {
  if (action.kind === "button_press") {
    const repeat = action.repeat ?? 1;
    return repeat === 1 ? `pressed ${action.button}` : `pressed ${action.button} x${String(repeat)}`;
  }
  if (action.kind === "frame_advance") return `advanced ${String(action.frames)} frames`;
  return `waited ${String(action.durationMs)}ms`;
}
